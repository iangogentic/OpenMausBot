// The stdio bridge for the BYO-VPS entry point and trusted in-process MCP
// transports. Local VM providers use container-mcp.ts's authority-free
// WebSocket relay instead; the trusted server-owned broker gates that lane.
// With no gate this module defines no tools and remains a byte-for-byte pipe.
//
// The opt-in who-is-driving gate parses only enough JSON-RPC to enforce two
// ownership behaviors Cua Driver cannot know about: every tools/call gets an
// action ticket before forwarding, and tools/list gains one bridge-owned
// computer_request_help tool for human handoff. While a person holds control,
// calls are answered with a refusal HERE and never reach the driver. Batches
// and duplicate request ids are rejected atomically; other singular frames
// pass through unchanged.
//
// Two transport behaviors live here for every caller that uses this bridge:
//   1. Exit without truncation. `process.exit()` in a close/error handler
//      discards whatever is still buffered on stdout — a final MCP result
//      would be cut mid-frame. The bridge sets exitCode and unpipes instead,
//      letting stdio drain before the process ends on its own.
//   2. A dead-transport watchdog (opt-in via `liveness`). docker's ssh
//      connection helper accepts no ConnectTimeout/ServerAlive options, so a
//      VPS dropping mid-turn leaves the exec silently wedged until the OS
//      gives up — the harness sees a hung tool call, not an error.
import { spawn } from "node:child_process";

import {
  CONTROL_ACTION_BUSY_PLAIN,
  CONTROL_LIFECYCLE_PLAIN,
  CONTROL_REFUSAL_PLAIN,
  CONTROL_UNAVAILABLE_PLAIN,
  createControlClient,
  type ActionPermit,
  type ControlClient,
} from "./control-client.ts";
import { augmentedPath } from "./env-path.ts";
import {
  assertBoundedJsonShape,
  BoundedUtf8LineDecoder,
  PROVIDER_NDJSON_LIMITS,
} from "./drivers/bounded-json-lines.ts";

// 45s of TOTAL silence before the bridge even probes. An MCP session is
// legitimately quiet between tool calls and a slow screenshot can take tens
// of seconds, so silence alone never kills anything — it only triggers a
// liveness probe, and only a probe that FAILS ends the bridge. Any byte on
// stdin/stdout/stderr resets the window.
export const BRIDGE_INACTIVITY_MS = 45_000;
const PROBE_TIMEOUT_MS = 10_000;

export interface BridgeLiveness {
  command: string;
  args: string[];
}

/** Run the liveness command; alive means "exited 0 within the timeout". The
 * probe is its own short-lived process, so it cannot inherit the wedged
 * connection it is diagnosing. */
export function runLivenessProbe(probe: BridgeLiveness, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(probe.command, probe.args, {
      shell: false,
      env: { ...process.env, PATH: augmentedPath() },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export interface WatchdogHandle {
  /** Any traffic in either direction — resets the inactivity window. */
  touch: () => void;
  stop: () => void;
}

/** Inactivity → probe → (only then) declare dead. Traffic arriving while a
 * probe is in flight vetoes even a failed probe: bytes are better evidence
 * of life than a health command racing a congested link. */
export function createInactivityWatchdog(options: {
  inactivityMs: number;
  probe: () => Promise<boolean>;
  onDead: () => void;
}): WatchdogHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let probing = false;
  let touchedWhileProbing = false;

  const arm = () => {
    if (stopped) return;
    timer = setTimeout(fire, options.inactivityMs);
    timer.unref?.();
  };
  const settleProbe = (alive: boolean) => {
    probing = false;
    if (stopped) return;
    if (alive || touchedWhileProbing) {
      arm();
      return;
    }
    options.onDead();
  };
  const fire = () => {
    probing = true;
    touchedWhileProbing = false;
    void options.probe().then(settleProbe, () => settleProbe(false));
  };

  arm();
  return {
    touch() {
      if (stopped) return;
      if (probing) {
        touchedWhileProbing = true;
        return;
      }
      if (timer) clearTimeout(timer);
      arm();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export interface BridgeOptions {
  command: string;
  args: string[];
  /** Optional sanitized environment for the far-end driver. */
  env?: NodeJS.ProcessEnv;
  /** Names the far end in stderr messages, e.g. "Cua Driver". */
  label: string;
  /** Enables the dead-transport watchdog. Omitted for the Local VM, whose
   * runtime CLI talks to a local daemon and fails fast on its own. */
  liveness?: BridgeLiveness;
  /** Enables the who-is-driving gate: the harness's loopback control
   * endpoint plus its per-boot token. Absent → fully transparent bridge. */
  gate?: { url: string; token: string };
}

export const COMPUTER_REQUEST_HELP_TOOL = {
  name: "computer_request_help",
  description:
    "Ask the person to take over this computer and wait until they hand it back. " +
    "Use only when blocked by login, CAPTCHA, consent, or another step that truly needs a person. " +
    "After it returns, take a fresh screenshot because the screen changed while they drove.",
  inputSchema: {
    type: "object",
    properties: { reason: { type: "string", description: "Short explanation of what needs human help." } },
    additionalProperties: false,
  },
} as const;

export const COMPUTER_BATCH_MAX_ACTIONS = 9;

export type ComputerBatchAction =
  | { name: "click"; arguments: { x: number; y: number; button?: "left" | "right"; count?: number } }
  | { name: "type_text"; arguments: { text: string } }
  | { name: "press_key"; arguments: { key: string } }
  | { name: "hotkey"; arguments: { keys: string[] } }
  | { name: "scroll"; arguments: { x: number; y: number; direction: "up" | "down"; amount?: number; by?: "line" | "pixel" } };

export const COMPUTER_BATCH_TOOL = {
  name: "computer_batch",
  description:
    "Run up to nine predictable mechanical computer actions sequentially under one control ticket, then return one final screenshot. Stop before any step whose result must be inspected.",
  inputSchema: {
    type: "object",
    properties: {
      actions: {
        type: "array",
        minItems: 1,
        maxItems: COMPUTER_BATCH_MAX_ACTIONS,
        items: {
          oneOf: [
            { type: "object", properties: { name: { const: "click" }, arguments: { type: "object", properties: { x: { type: "number", minimum: 0, maximum: 16384 }, y: { type: "number", minimum: 0, maximum: 16384 }, button: { type: "string", enum: ["left", "right"] }, count: { type: "integer", minimum: 1, maximum: 2 } }, required: ["x", "y"], additionalProperties: false } }, required: ["name", "arguments"], additionalProperties: false },
            { type: "object", properties: { name: { const: "type_text" }, arguments: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 4096 } }, required: ["text"], additionalProperties: false } }, required: ["name", "arguments"], additionalProperties: false },
            { type: "object", properties: { name: { const: "press_key" }, arguments: { type: "object", properties: { key: { type: "string", minLength: 1, maxLength: 64 } }, required: ["key"], additionalProperties: false } }, required: ["name", "arguments"], additionalProperties: false },
            { type: "object", properties: { name: { const: "hotkey" }, arguments: { type: "object", properties: { keys: { type: "array", minItems: 2, maxItems: 4, items: { type: "string", minLength: 1, maxLength: 32 } } }, required: ["keys"], additionalProperties: false } }, required: ["name", "arguments"], additionalProperties: false },
            { type: "object", properties: { name: { const: "scroll" }, arguments: { type: "object", properties: { x: { type: "number", minimum: 0, maximum: 16384 }, y: { type: "number", minimum: 0, maximum: 16384 }, direction: { type: "string", enum: ["up", "down"] }, amount: { type: "integer", minimum: 1, maximum: 20 }, by: { type: "string", enum: ["line", "pixel"] } }, required: ["x", "y", "direction"], additionalProperties: false } }, required: ["name", "arguments"], additionalProperties: false },
          ],
        },
      },
    },
    required: ["actions"],
    additionalProperties: false,
  },
} as const;

type BatchValidation = { ok: true; actions: ComputerBatchAction[] } | { ok: false; message: string };

function plainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** Runtime validation mirrors COMPUTER_BATCH_TOOL and returns fresh objects so
 * no unreviewed provider fields can reach the driver. */
export function validateComputerBatchArguments(value: unknown): BatchValidation {
  const root = plainObject(value);
  if (!root || !exactKeys(root, ["actions"]) || !Array.isArray(root.actions)) {
    return { ok: false, message: "computer_batch requires only an actions array" };
  }
  if (root.actions.length < 1 || root.actions.length > COMPUTER_BATCH_MAX_ACTIONS) {
    return { ok: false, message: `computer_batch requires 1-${COMPUTER_BATCH_MAX_ACTIONS} actions; the batch was not run` };
  }
  const actions: ComputerBatchAction[] = [];
  for (const candidate of root.actions) {
    const action = plainObject(candidate);
    const args = plainObject(action?.arguments);
    if (!action || !args || !exactKeys(action, ["name", "arguments"])) {
      return { ok: false, message: "computer_batch contains an invalid action object" };
    }
    if (action.name === "click" && exactKeys(args, ["x", "y", "button", "count"]) &&
      typeof args.x === "number" && Number.isFinite(args.x) && args.x >= 0 && args.x <= 16384 &&
      typeof args.y === "number" && Number.isFinite(args.y) && args.y >= 0 && args.y <= 16384 &&
      (args.button === undefined || args.button === "left" || args.button === "right") &&
      (args.count === undefined || (Number.isInteger(args.count) && Number(args.count) >= 1 && Number(args.count) <= 2))) {
      actions.push({ name: "click", arguments: { x: args.x, y: args.y, ...(args.button ? { button: args.button } : {}), ...(args.count !== undefined ? { count: Number(args.count) } : {}) } });
      continue;
    }
    if (action.name === "type_text" && exactKeys(args, ["text"]) && typeof args.text === "string" && args.text.length >= 1 && args.text.length <= 4096) {
      actions.push({ name: "type_text", arguments: { text: args.text } });
      continue;
    }
    if (action.name === "press_key" && exactKeys(args, ["key"]) && typeof args.key === "string" && args.key.length >= 1 && args.key.length <= 64) {
      actions.push({ name: "press_key", arguments: { key: args.key } });
      continue;
    }
    if (action.name === "hotkey" && exactKeys(args, ["keys"]) && Array.isArray(args.keys) && args.keys.length >= 2 && args.keys.length <= 4 && args.keys.every((key) => typeof key === "string" && key.length >= 1 && key.length <= 32)) {
      actions.push({ name: "hotkey", arguments: { keys: [...args.keys] as string[] } });
      continue;
    }
    if (action.name === "scroll" && exactKeys(args, ["x", "y", "direction", "amount", "by"]) &&
      typeof args.x === "number" && Number.isFinite(args.x) && args.x >= 0 && args.x <= 16384 &&
      typeof args.y === "number" && Number.isFinite(args.y) && args.y >= 0 && args.y <= 16384 &&
      (args.direction === "up" || args.direction === "down") &&
      (args.amount === undefined || (Number.isInteger(args.amount) && Number(args.amount) >= 1 && Number(args.amount) <= 20)) &&
      (args.by === undefined || args.by === "line" || args.by === "pixel")) {
      actions.push({ name: "scroll", arguments: { x: args.x, y: args.y, direction: args.direction, ...(args.amount !== undefined ? { amount: Number(args.amount) } : {}), ...(args.by ? { by: args.by } : {}) } });
      continue;
    }
    return { ok: false, message: "computer_batch contains an unsupported action or invalid arguments" };
  }
  return { ok: true, actions };
}

/** Collect a byte stream into complete newline-terminated lines. MCP's
 * stdio transport is one JSON-RPC frame per line, so line boundaries are
 * the only safe place to inspect — or inject — anything. */
// A 1280x900 high-entropy CUA screenshot can exceed 1 MiB once base64 and
// JSON framing are included. Keep the bridge bounded, but large enough for
// one legitimate uncompressed observation from the driver.
export const MCP_MAX_LINE_BYTES = 4 * 1024 * 1024;
export const MCP_MAX_PENDING_FRAMES = 64;
export const MCP_MAX_PENDING_BYTES = 16 * 1024 * 1024;
export const MCP_BATCH_UNSUPPORTED_PLAIN =
  "JSON-RPC batches are not supported for computer control. Send one request at a time.";

export function createLineSplitter(
  onLine: (line: string) => void | boolean,
  options: {
    maxLineBytes?: number;
    maxTotalBytes?: number;
    maxFrames?: number;
    maxFramesPerWindow?: number;
    frameWindowMs?: number;
    onOverflow?: () => void;
  } = {},
): {
  push: (chunk: Buffer | string) => boolean;
  flush: () => boolean;
} {
  const maxLineBytes = options.maxLineBytes ?? MCP_MAX_LINE_BYTES;
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
    throw new TypeError("maxLineBytes must be a positive safe integer");
  }
  const decoder = new BoundedUtf8LineDecoder({
    maxLineBytes,
    maxBufferedBytes: maxLineBytes,
    maxTotalBytes: options.maxTotalBytes ?? PROVIDER_NDJSON_LIMITS.maxTotalBytes,
    maxFrames: options.maxFrames ?? PROVIDER_NDJSON_LIMITS.maxFrames,
    maxFramesPerWindow: options.maxFramesPerWindow ?? PROVIDER_NDJSON_LIMITS.maxFramesPerWindow,
    frameWindowMs: options.frameWindowMs ?? PROVIDER_NDJSON_LIMITS.frameWindowMs,
  });
  let failed = false;

  const overflow = () => {
    if (!failed) options.onOverflow?.();
    failed = true;
    return false;
  };

  const deliver = (lines: Array<{ line: string }>) => {
    for (const { line } of lines) {
      const accepted = onLine(line);
      if (accepted === false) {
        // The consumer owns the error report (for example its serialized
        // queue overflowed). Do not fire the splitter callback twice.
        failed = true;
        return false;
      }
      if (failed) return false;
    }
    return true;
  };

  return {
    push(chunk) {
      if (failed) return false;
      try {
        return deliver(decoder.push(chunk));
      } catch {
        return overflow();
      }
    },
    flush() {
      if (failed) return false;
      try {
        return deliver(decoder.flush());
      } catch {
        return overflow();
      }
    },
  };
}

/** The gate itself, factored free of process wiring so a test can drive it
 * with plain strings. Frames are handled on a serialized queue: the
 * held-check is async, and answering frame N+1 before frame N would
 * reorder the agent's protocol stream. Only a `tools/call` is ever
 * refused; every other frame — handshakes, tools/list, notifications,
 * lines that are not JSON — passes through untouched. */
export type GateInterceptor = ((line: string) => boolean) & { drain: () => Promise<void> };

export function createGateInterceptor(options: {
  beginAction: (toolName: string) => Promise<ActionPermit>;
  forward: (line: string) => void;
  refuse: (line: string) => void;
  actionForwarded?: (requestId: string, actionId: string, toolName: string) => void;
  toolsListRequested?: (requestId: string) => void;
  /** Track any other request forwarded to the driver (for example
   * initialize), so its id cannot be reused by a tools/call before the first
   * response and falsely settle that action. */
  requestForwarded?: (requestId: string) => void;
  requestHelp?: (reason: string) => Promise<{ text: string; isError?: boolean }>;
  requestComputerBatch?: (actions: ComputerBatchAction[]) => Promise<{
    content: Array<Record<string, unknown>>;
    isError?: boolean;
  }>;
  /** Reject a request id that is already live at the far-end driver. This is
   * evaluated on the same serialized queue as beginAction, so a duplicate
   * cannot race the first request's actionForwarded callback. */
  requestIdAvailable?: (requestId: string) => boolean | Promise<boolean>;
  /** Release a ticket acquired after this bounded queue was already closed. */
  actionAbandoned?: (actionId: string) => void | Promise<void>;
  onOverflow?: () => void;
  maxPendingFrames?: number;
  maxPendingBytes?: number;
  refusalText?: string;
  unavailableText?: string;
  lifecycleText?: string;
  actionBusyText?: string;
}): GateInterceptor {
  const refusalText = options.refusalText ?? CONTROL_REFUSAL_PLAIN;
  const unavailableText = options.unavailableText ?? CONTROL_UNAVAILABLE_PLAIN;
  const lifecycleText = options.lifecycleText ?? CONTROL_LIFECYCLE_PLAIN;
  const actionBusyText = options.actionBusyText ?? CONTROL_ACTION_BUSY_PLAIN;
  const maxPendingFrames = options.maxPendingFrames ?? MCP_MAX_PENDING_FRAMES;
  const maxPendingBytes = options.maxPendingBytes ?? MCP_MAX_PENDING_BYTES;
  if (!Number.isSafeInteger(maxPendingFrames) || maxPendingFrames < 1) {
    throw new TypeError("maxPendingFrames must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < 1) {
    throw new TypeError("maxPendingBytes must be a positive safe integer");
  }
  let queue: Promise<void> = Promise.resolve();
  let pendingFrames = 0;
  let pendingBytes = 0;
  let failed = false;
  const intercept = ((line: string) => {
    if (failed) return false;
    const lineBytes = Buffer.byteLength(line) + 1;
    if (
      lineBytes > maxPendingBytes ||
      pendingFrames + 1 > maxPendingFrames ||
      pendingBytes + lineBytes > maxPendingBytes
    ) {
      failed = true;
      options.onOverflow?.();
      return false;
    }
    pendingFrames += 1;
    pendingBytes += lineBytes;
    const task = queue.then(async () => {
      if (failed) return;
      let frame: any = null;
      try {
        frame = JSON.parse(line);
      } catch {
        // not a frame this gate understands — never stand between the
        // agent and its driver on anything but a recognized tool call
      }
      if (!frame) {
        options.forward(line);
        return;
      }
      assertBoundedJsonShape(frame, PROVIDER_NDJSON_LIMITS);
      // A batch must be treated atomically. Passing an array through this
      // object-shaped gate would let every embedded tools/call bypass its
      // control ticket. Reject the whole batch before inspecting or
      // forwarding any member; callers that need concurrency can send
      // separately framed requests, which remain ordered by this queue.
      if (Array.isArray(frame)) {
        options.refuse(jsonRpcErrorFrame(null, -32600, MCP_BATCH_UNSUPPORTED_PLAIN));
        return;
      }
      const requestFrame = typeof frame.method === "string";
      const gatedRequestId = requestFrame ? requestKey(frame.id) : null;
      if (
        gatedRequestId !== null &&
        options.requestIdAvailable &&
        !(await Promise.resolve(options.requestIdAvailable(gatedRequestId)).catch(() => false))
      ) {
        options.refuse(jsonRpcErrorFrame(frame.id, -32600, "This JSON-RPC request id is already in flight"));
        return;
      }
      if (frame.method === "tools/list") {
        const id = gatedRequestId;
        if (id) options.toolsListRequested?.(id);
        options.forward(line);
        return;
      }
      if (frame.method !== "tools/call") {
        if (gatedRequestId) options.requestForwarded?.(gatedRequestId);
        options.forward(line);
        return;
      }
      const requestId = requestKey(frame.id);
      if (requestId === null) {
        options.refuse(refusalFrame(frame.id, unavailableText));
        return;
      }
      if (frame.params?.name === COMPUTER_REQUEST_HELP_TOOL.name && options.requestHelp) {
        const reason = typeof frame.params?.arguments?.reason === "string" ? frame.params.arguments.reason : "";
        const result = await options.requestHelp(reason).catch(() => ({
          text: "Computer control authority became unavailable while asking for help. Pause and tell the person in chat.",
          isError: true,
        }));
        if (failed) return;
        options.refuse(toolResultFrame(frame.id, result.text, result.isError === true));
        return;
      }
      if (frame.params?.name === COMPUTER_BATCH_TOOL.name && options.requestComputerBatch) {
        const validated = validateComputerBatchArguments(frame.params?.arguments);
        if (!validated.ok) {
          options.refuse(toolResultFrame(frame.id, validated.message, true));
          return;
        }
        const result = await options.requestComputerBatch(validated.actions).catch(() => ({
          content: [{ type: "text", text: "The computer batch could not complete safely." }],
          isError: true,
        }));
        if (failed) return;
        options.refuse(JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id ?? null,
          result: { content: result.content, ...(result.isError ? { isError: true } : {}) },
        }));
        return;
      }
      const permit = await options.beginAction(
        typeof frame.params?.name === "string" ? frame.params.name : "",
      ).catch(
        (): ActionPermit => ({ allowed: false, reason: "unavailable" }),
      );
      if (failed) {
        if (permit.allowed) await options.actionAbandoned?.(permit.actionId);
        return;
      }
      if (permit.allowed) {
        options.actionForwarded?.(
          requestId,
          permit.actionId,
          typeof frame.params?.name === "string" ? frame.params.name : "",
        );
        options.forward(line);
        return;
      }
      options.refuse(refusalFrame(
        frame.id,
        permit.reason === "unavailable"
          ? unavailableText
          : permit.reason === "lifecycle-active"
            ? lifecycleText
            : permit.reason === "action-active"
              ? actionBusyText
            : refusalText,
      ));
    });
    queue = task.catch(() => {
      if (!failed) {
        failed = true;
        options.onOverflow?.();
      }
    }).finally(() => {
      pendingFrames -= 1;
      pendingBytes -= lineBytes;
    });
    return true;
  }) as GateInterceptor;
  // stdin EOF is ordered after every preceding frame. Because the authority
  // check is async, callers must await this queue before ending child stdin or
  // a permitted action can be ticketed after the driver has already seen EOF.
  intercept.drain = () => queue;
  return intercept;
}

function requestKey(id: unknown): string | null {
  return typeof id === "string" || (typeof id === "number" && Number.isFinite(id))
    ? `${typeof id}:${String(id)}`
    : null;
}

function refusalFrame(id: unknown, text: string): string {
  return toolResultFrame(id, text, true);
}

function jsonRpcErrorFrame(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function toolResultFrame(id: unknown, text: string, isError: boolean): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) },
  });
}

/** Add the bridge-owned handoff tool without hiding or rewriting any driver
 * tools. Only the response to a tools/list request observed on this bridge is
 * eligible, and an upstream tool of the same name wins to avoid duplication. */
export function augmentToolsListResponse(
  line: string,
  pendingRequestIds: Set<string>,
  syntheticTools: readonly Record<string, unknown>[] = [COMPUTER_REQUEST_HELP_TOOL],
): string {
  let frame: any = null;
  try {
    frame = JSON.parse(line);
  } catch {
    return line;
  }
  assertBoundedJsonShape(frame, PROVIDER_NDJSON_LIMITS);
  const id = requestKey(frame?.id);
  if (!id || !pendingRequestIds.delete(id) || !Array.isArray(frame?.result?.tools)) return line;
  const existing = new Set(frame.result.tools.map((tool: any) => tool?.name).filter((name: unknown) => typeof name === "string"));
  const additions = syntheticTools.filter((tool) => typeof tool.name === "string" && !existing.has(tool.name));
  if (!additions.length) return line;
  return JSON.stringify({
    ...frame,
    result: { ...frame.result, tools: [...frame.result.tools, ...additions] },
  });
}

export async function waitForHumanHelp(
  client: ControlClient,
  reason: string,
  options: { pollMs?: number; waitMs?: number } = {},
): Promise<{ text: string; isError?: boolean }> {
  if (!client.configured) {
    return { text: "Computer control authority is unavailable, so nobody can be paged safely right now.", isError: true };
  }
  const initial = await client.state(true);
  if (!initial.available) {
    return { text: "Computer control authority is unavailable, so nobody can be paged safely right now.", isError: true };
  }
  const requestId = initial.held ? null : await client.requestHelp(reason);
  if (!initial.held && requestId === null) {
    return { text: "The person could not be paged for this computer right now. Tell them in chat.", isError: true };
  }
  let sawHold = initial.held;
  const pollMs = Math.max(25, options.pollMs ?? (Number(process.env.OMB_CONTROL_POLL_MS) || 1_500));
  const waitMs = Math.max(100, options.waitMs ?? (Number(process.env.OMB_CONTROL_WAIT_MS) || 600_000));
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const state = await client.state(true);
    if (!state.available) {
      if (requestId) await client.expireHelp(requestId);
      return { text: "Computer control authority became unavailable while waiting. Pause and tell the person in chat.", isError: true };
    }
    if (state.held) sawHold = true;
    if (!state.held && !state.helpOpen) {
      return {
        text: sawHold
          ? "The person has finished driving and handed control back. Take a fresh screenshot before your next action."
          : "The person saw your request and dismissed it without taking control. Carry on yourself.",
      };
    }
  }
  if (requestId) await client.expireHelp(requestId);
  return { text: "Nobody took control within the wait window. Pause or ask again if you are still blocked.", isError: true };
}

export function runMcpBridge(options: BridgeOptions): void {
  const child = spawn(options.command, options.args, {
    shell: false,
    env: { ...(options.env ?? process.env), PATH: augmentedPath() },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // docker may exit before it drains stdin; pipe() leaves this error unhandled.
  child.stdin.on("error", () => {});
  child.stderr.pipe(process.stderr);

  let detach: () => void = () => {};
  let bridgeFailed = false;
  let bridgeFailureFailsafe: ReturnType<typeof setTimeout> | null = null;
  const failBridge = (reason: string) => {
    if (bridgeFailed) return;
    bridgeFailed = true;
    process.stderr.write(`${reason}\n`);
    process.exitCode = 1;
    detach();
    child.stdin.destroy();
    child.kill("SIGKILL");
    bridgeFailureFailsafe = setTimeout(() => process.exit(1), 2_000);
    bridgeFailureFailsafe.unref?.();
  };
  if (options.gate) {
    const client = createControlClient({ url: options.gate.url, token: options.gate.token });
    const pendingActions = new Map<string, string>();
    const pendingToolsList = new Set<string>();
    let detached = false;
    let childInputBackpressured = false;
    let harnessOutputBackpressured = false;
    const updateInputFlow = () => {
      if (detached || childInputBackpressured || harnessOutputBackpressured) process.stdin.pause();
      else process.stdin.resume();
    };
    const onChildInputDrain = () => {
      childInputBackpressured = false;
      updateInputFlow();
    };
    const onHarnessOutputDrain = () => {
      harnessOutputBackpressured = false;
      if (!detached && !bridgeFailed) child.stdout.resume();
      updateInputFlow();
    };
    child.stdin.on("drain", onChildInputDrain);
    process.stdout.on("drain", onHarnessOutputDrain);
    const forwardToChild = (line: string) => {
      if (detached || bridgeFailed) return;
      if (!child.stdin.write(line + "\n")) {
        childInputBackpressured = true;
        updateInputFlow();
      }
    };
    const emitHarness = (line: string) => {
      if (bridgeFailed) return;
      if (!process.stdout.write(line + "\n")) {
        harnessOutputBackpressured = true;
        child.stdout.pause();
        updateInputFlow();
      }
    };
    const interceptor = createGateInterceptor({
      beginAction: () => client.beginAction(),
      actionForwarded: (requestId, actionId) => pendingActions.set(requestId, actionId),
      actionAbandoned: async (actionId) => {
        if (!(await client.endAction(actionId))) await client.quarantineActions();
      },
      toolsListRequested: (requestId) => {
        if (pendingToolsList.size >= MCP_MAX_PENDING_FRAMES) {
          failBridge("too many unanswered computer MCP tool-list requests");
          return;
        }
        pendingToolsList.add(requestId);
      },
      requestHelp: (reason) => waitForHumanHelp(client, reason),
      forward: forwardToChild,
      refuse: emitHarness,
      onOverflow: () => failBridge("computer MCP request queue exceeded its limit"),
    });
    const inbound = createLineSplitter(interceptor, {
      maxLineBytes: MCP_MAX_LINE_BYTES,
      onOverflow: () => failBridge("computer MCP request frame exceeded its limit"),
    });
    const onStdin = (chunk: Buffer) => inbound.push(chunk);
    process.stdin.on("data", onStdin);
    process.stdin.on("end", () => {
      inbound.flush();
      void interceptor.drain().finally(() => {
        if (!bridgeFailed) child.stdin.end();
      });
    });
    // Injected refusals must never land inside one of the child's
    // half-written frames, so the child's stdout is re-emitted at line
    // granularity as well.
    let outboundQueue: Promise<void> = Promise.resolve();
    let outboundPendingFrames = 0;
    let outboundPendingBytes = 0;
    let outboundFailed = false;
    const outbound = createLineSplitter((line) => {
      if (bridgeFailed || outboundFailed) return false;
      const lineBytes = Buffer.byteLength(line) + 1;
      if (
        lineBytes > MCP_MAX_PENDING_BYTES ||
        outboundPendingFrames + 1 > MCP_MAX_PENDING_FRAMES ||
        outboundPendingBytes + lineBytes > MCP_MAX_PENDING_BYTES
      ) {
        outboundFailed = true;
        failBridge("computer MCP response queue exceeded its limit");
        return false;
      }
      outboundPendingFrames += 1;
      outboundPendingBytes += lineBytes;
      // Do not deliver a tool result to the provider until the harness has
      // observed its action ticket ending. Otherwise the provider can emit
      // turn.completed, clear the exact Auto target, and let a takeover race
      // the still-registered action.
      const task = outboundQueue.then(async () => {
        if (bridgeFailed) return;
        let frame: any = null;
        try {
          frame = JSON.parse(line);
        } catch {}
        if (frame !== null) assertBoundedJsonShape(frame, PROVIDER_NDJSON_LIMITS);
        const id = requestKey(frame?.id);
        if (id !== null && ("result" in (frame ?? {}) || "error" in (frame ?? {}))) {
          const actionId = pendingActions.get(id);
          if (actionId) {
            const ended = await client.endAction(actionId);
            if (!ended) {
              failBridge("computer control authority did not acknowledge the completed action");
              return;
            }
            pendingActions.delete(id);
          }
        }
        emitHarness(augmentToolsListResponse(line, pendingToolsList));
      });
      outboundQueue = task.catch(() => {
        failBridge("computer MCP response processing failed");
      }).finally(() => {
        outboundPendingFrames -= 1;
        outboundPendingBytes -= lineBytes;
      });
      return true;
    }, {
      maxLineBytes: MCP_MAX_LINE_BYTES,
      onOverflow: () => failBridge("computer MCP response frame exceeded its limit"),
    });
    child.stdout.on("data", (chunk) => outbound.push(chunk));
    child.stdout.on("end", () => outbound.flush());
    detach = () => {
      if (detached) return;
      detached = true;
      process.stdin.off("data", onStdin);
      process.stdin.pause();
      child.stdin.off("drain", onChildInputDrain);
      process.stdout.off("drain", onHarnessOutputDrain);
      child.stdout.pause();
      // Never clear pending tickets merely because stdio disappeared. A
      // remote click can keep running after SSH/docker/the child dies; the
      // orphaned ticket is the conservative fence until a confirmed result
      // ends it or a server-owned target reset proves the computer stopped.
      void client.quarantineActions();
    };
  } else {
    process.stdin.pipe(child.stdin);
    child.stdout.pipe(process.stdout);
    detach = () => {
      process.stdin.unpipe(child.stdin);
      process.stdin.pause();
    };
  }

  let watchdog: WatchdogHandle | null = null;
  let signalEscalation: ReturnType<typeof setTimeout> | null = null;
  let signalExitFailsafe: ReturnType<typeof setTimeout> | null = null;
  if (options.liveness) {
    const liveness = options.liveness;
    watchdog = createInactivityWatchdog({
      inactivityMs: BRIDGE_INACTIVITY_MS,
      probe: () => runLivenessProbe(liveness),
      onDead: () => {
        process.stderr.write(
          `${options.label} transport went silent and stopped answering liveness probes; ending the bridge\n`,
        );
        process.exitCode = 1;
        detach();
        child.kill("SIGKILL");
        // A docker wedged on a dead ssh connection may never deliver close.
        // Nothing can be buffered on stdout after 45 quiet seconds, so this
        // hard exit — unlike the close-handler one this file exists to avoid —
        // cannot truncate anything.
        const failsafe = setTimeout(() => process.exit(1), 2_000);
        failsafe.unref?.();
      },
    });
    const touch = () => watchdog?.touch();
    process.stdin.on("data", touch);
    child.stdout.on("data", touch);
    child.stderr.on("data", touch);
  }

  child.on("error", (error) => {
    process.stderr.write(`could not connect to ${options.label}: ${error.message}\n`);
    process.exitCode = 1;
    watchdog?.stop();
    detach();
  });
  child.on("close", (code, signal) => {
    if (bridgeFailureFailsafe) clearTimeout(bridgeFailureFailsafe);
    if (signalEscalation) clearTimeout(signalEscalation);
    if (signalExitFailsafe) clearTimeout(signalExitFailsafe);
    if (signal) process.stderr.write(`${options.label} connection ended with ${signal}\n`);
    // Let stdout and stderr drain before the bridge exits.
    process.exitCode = process.exitCode ?? code ?? 1;
    watchdog?.stop();
    detach();
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (signalEscalation) return;
      process.exitCode = signal === "SIGTERM" ? 143 : 130;
      child.kill(signal);
      signalEscalation = setTimeout(() => {
        child.kill("SIGKILL");
        signalExitFailsafe = setTimeout(() => process.exit(process.exitCode ?? 1), 2_000);
        signalExitFailsafe.unref?.();
      }, 2_000);
      signalEscalation.unref?.();
    });
  }
}
