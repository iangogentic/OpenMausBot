import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";

import { augmentedPath } from "./env-path.ts";
import {
  COMPUTER_BATCH_TOOL,
  COMPUTER_BATCH_MAX_ACTIONS,
  COMPUTER_REQUEST_HELP_TOOL,
  MCP_MAX_LINE_BYTES,
  MCP_MAX_PENDING_BYTES,
  MCP_MAX_PENDING_FRAMES,
  augmentToolsListResponse,
  createGateInterceptor,
  createLineSplitter,
  type GateInterceptor,
  type ComputerBatchAction,
} from "./mcp-bridge.ts";
import { cuaExecArgs, CUA_SOCKET, type Runtime } from "./container-computer.ts";
import type { ActionPermit } from "./control-client.ts";
import {
  LOCAL_VM_BROKER_ORIGIN,
  LOCAL_VM_MCP_PATH,
  LOCAL_VM_PROXY_MAX_BUFFERED_BYTES,
} from "./local-vm-broker-protocol.ts";
import type { RawWebSocket } from "./raw-websocket.ts";
import { terminateCliTree } from "./procs.ts";

export { LOCAL_VM_BROKER_ORIGIN, LOCAL_VM_MCP_PATH, LOCAL_VM_PROXY_MAX_BUFFERED_BYTES };

export const LOCAL_VM_MAX_MCP_FRAMES = 4_096;
export const LOCAL_VM_MAX_TOOL_CALLS = 2_048;
export const LOCAL_VM_GENERATION_POLL_MS = 2_000;
export const LOCAL_VM_MCP_RESPONSE_TIMEOUT_MS = 180_000;
/** Base64 screenshot ceiling below the 4 MiB MCP frame limit, leaving room
 * for JSON framing and the textual batch result. Production optimized frames
 * are normally below 400 KiB. */
export const LOCAL_VM_BATCH_SCREENSHOT_MAX_BASE64_BYTES = 3 * 1024 * 1024;

/** Cua Driver's low-level action tools report only metadata. Attach the
 * resulting pixels in the broker so a vision model receives one atomic
 * act-and-observe result instead of spending another inference on a separate
 * get_desktop_state call. Read-only inspection tools already return their own
 * state and must not trigger redundant captures. */
export const LOCAL_VM_ACT_AND_OBSERVE_TOOLS = new Set([
  "bring_to_front",
  "browser_click",
  "browser_dialog",
  "browser_navigate",
  "browser_pointer",
  "browser_set_input_files",
  "browser_type",
  "click",
  "double_click",
  "drag",
  "hotkey",
  "invoke_menu",
  "kill_app",
  "launch_app",
  "mouse_button_down",
  "mouse_button_up",
  "mouse_drag",
  "page",
  "parallel_mouse_drag",
  "press_key",
  "right_click",
  "scroll",
  "set_value",
  "set_window_frame",
  "type_text",
]);

export function localVmPostActionSettleMs(toolName: string): number {
  if (toolName === "launch_app" || toolName === "kill_app") return 800;
  if (toolName === "browser_navigate" || toolName === "page") return 600;
  if (toolName.startsWith("browser_") || toolName === "invoke_menu") return 400;
  return 250;
}

export interface LocalVmActionScreenshot {
  readonly data: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
}

export interface LocalVmMcpAuthority {
  readonly capabilityToken: string;
  readonly botId: string;
  readonly threadId: string;
  readonly generation: string;
  readonly targetKey: string;
  readonly runtime: Runtime;
  readonly containerName: string;
  readonly vmGeneration: string;
  readonly bridgeId: string;
}

type DriverChild = ChildProcessWithoutNullStreams;

export interface LocalVmMcpBrokerHandle {
  /** Resolves only after the complete runtime-CLI process group is gone. */
  readonly closed: Promise<void>;
  close(reason?: string): void;
}

/** One capability may open exactly one provider relay. Disconnecting does
 * not make a stolen/replayed bearer useful again; only exact turn teardown
 * forgets it. */
export class LocalVmMcpAdmissions {
  private readonly consumed = new Set<string>();

  claim(token: string): boolean {
    if (!token || this.consumed.has(token)) return false;
    this.consumed.add(token);
    return true;
  }

  has(token: string): boolean {
    return this.consumed.has(token);
  }

  revoke(token: string): boolean {
    return this.consumed.delete(token);
  }

  clear(): void {
    this.consumed.clear();
  }
}

function runtimeEnvironment(): NodeJS.ProcessEnv {
  const source = process.env;
  const env: NodeJS.ProcessEnv = { PATH: augmentedPath() };
  // These values select the trusted server's container daemon. They are not
  // forwarded through `docker exec`, and never cross back to the provider.
  for (const name of [
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "XDG_RUNTIME_DIR",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "CONTAINER_HOST",
  ]) {
    if (source[name]) env[name] = source[name];
  }
  return env;
}

function defaultSpawnDriver(authority: LocalVmMcpAuthority): DriverChild {
  return spawn(
    authority.runtime,
    cuaExecArgs(["mcp", "--socket", CUA_SOCKET], {
      container: authority.containerName,
      interactive: true,
    }),
    {
      shell: false,
      env: runtimeEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      ...(process.platform === "win32" ? { windowsHide: true } : { detached: true }),
    },
  );
}

async function boundedCurrent(check: () => boolean | Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      Promise.resolve().then(check).then((value) => value === true, () => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 10_000);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Trusted server-owned Local VM MCP endpoint.
 *
 * The untrusted provider speaks only WebSocket bytes. This broker alone owns
 * the runtime CLI and exact container/socket selection. Every tool call is
 * correlated with a ComputerControl ticket and a fresh VM-generation check;
 * Stop/reload/disconnect close the whole detached CLI process group before
 * `closed` resolves.
 */
export function attachLocalVmMcpBroker(options: {
  broker: RawWebSocket;
  authority: LocalVmMcpAuthority;
  stillAuthorized: () => boolean;
  verifyCurrentGeneration: () => boolean | Promise<boolean>;
  beginAction: () => ActionPermit | Promise<ActionPermit>;
  /** Authoritative child-runtime budget hook. It is invoked only after a
   * control ticket is acquired and before any mechanical action is reserved
   * or forwarded. A configured hook that throws always denies the action. */
  onActions?: (amount: number) => number;
  /** Dedicated hidden computer children set this true. Direct parent turns
   * omit it for backwards-compatible broker-local action enforcement. */
  requireActionAccounting?: boolean;
  endAction: (actionId: string) => boolean | Promise<boolean>;
  quarantine: () => void | Promise<void>;
  requestHelp: (reason: string) => Promise<{ text: string; isError?: boolean }>;
  /** Trusted server-side capture performed while the action ticket remains
   * held. Failures leave the original action result intact. */
  captureAfterAction?: (toolName: string) => Promise<LocalVmActionScreenshot | null>;
  signal?: AbortSignal;
  spawnDriver?: (authority: LocalVmMcpAuthority) => DriverChild;
  terminateDriver?: (child: ChildProcess) => Promise<void>;
  generationPollMs?: number;
  /** Narrow test seam; production uses the exported whole-turn ceiling. */
  maxToolCalls?: number;
  /** Narrow test seam; production uses the exported response deadline. */
  responseTimeoutMs?: number;
}): LocalVmMcpBrokerHandle {
  let child: DriverChild | null = null;
  let closed = false;
  let cleanupStarted = false;
  let driverReady = false;
  let driverInputEnded = false;
  let generationChecking = false;
  let toolCalls = 0;
  // One child/turn mechanical-action budget shared by ordinary calls and all
  // synthetic batches. A batch reserves its full size before action one, so a
  // failed prefix cannot be retried to exceed the nine-action contract.
  let computerActionsConsumed = 0;
  let lastDeliveredFrameHash: string | null = null;
  let inputFrames = 0;
  let outputFrames = 0;
  let pendingDriverBytes = 0;
  const pendingDriver: Buffer[] = [];
  const pendingActions = new Map<string, string>();
  const pendingActionTools = new Map<string, string>();
  const pendingToolsList = new Set<string>();
  const pendingPassthrough = new Set<string>();
  const pendingBatchDriverCalls = new Map<string, {
    resolve: (frame: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();
  let activeBatchActionId: string | null = null;
  let batchDriverSequence = 0;
  const responseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let offBrokerDrain: () => void = () => {};
  let generationTimer: ReturnType<typeof setInterval> | null = null;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const terminateDriver = options.terminateDriver ?? ((target) => terminateCliTree(target));
  const maxToolCalls = options.maxToolCalls ?? LOCAL_VM_MAX_TOOL_CALLS;
  const responseTimeoutMs = options.responseTimeoutMs ?? LOCAL_VM_MCP_RESPONSE_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > LOCAL_VM_MAX_TOOL_CALLS) {
    throw new Error("invalid Local VM MCP tool-call ceiling");
  }
  if (
    !Number.isSafeInteger(responseTimeoutMs) ||
    responseTimeoutMs < 100 ||
    responseTimeoutMs > LOCAL_VM_MCP_RESPONSE_TIMEOUT_MS
  ) {
    throw new Error("invalid Local VM MCP response timeout");
  }

  const authorizedAndCurrent = async () => {
    if (closed) return false;
    try {
      if (!options.stillAuthorized()) return false;
    } catch {
      return false;
    }
    return boundedCurrent(options.verifyCurrentGeneration);
  };

  const quarantineSafely = (): Promise<void> => {
    try {
      return Promise.resolve(options.quarantine()).catch((error) => {
        console.error(`Local VM control quarantine failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    } catch (error) {
      console.error(`Local VM control quarantine failed: ${error instanceof Error ? error.message : String(error)}`);
      return Promise.resolve();
    }
  };

  const completeCleanup = (target: DriverChild | null) => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    if (!target) {
      resolveClosed();
      return;
    }
    // A failed tree proof intentionally leaves `closed` pending. Existing
    // Stop/reload/shutdown drains then fail closed instead of admitting a
    // successor while an unobserved docker-exec descendant may still click.
    void Promise.resolve().then(() => terminateDriver(target)).then(resolveClosed, (error) => {
      console.error(`Local VM MCP process-tree cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const finish = (reason: string, quarantine: boolean) => {
    if (closed) return;
    closed = true;
    if (generationTimer) clearInterval(generationTimer);
    generationTimer = null;
    for (const timer of responseTimers.values()) clearTimeout(timer);
    responseTimers.clear();
    for (const pending of pendingBatchDriverCalls.values()) pending.reject(new Error(reason));
    pendingBatchDriverCalls.clear();
    options.signal?.removeEventListener("abort", onAbort);
    offBrokerDrain();
    options.broker.resumeInput();
    child?.stdout.pause();
    child?.stdin.destroy();
    if ((quarantine || activeBatchActionId !== null) && (pendingActions.size || activeBatchActionId)) {
      void quarantineSafely();
    }
    if (options.broker.open) options.broker.close(1008, reason);
    completeCleanup(child);
  };

  const armResponseDeadline = (requestId: string) => {
    const timer = setTimeout(() => {
      responseTimers.delete(requestId);
      finish("Local VM Cua Driver response timed out", pendingActions.size > 0);
    }, responseTimeoutMs);
    timer.unref?.();
    responseTimers.set(requestId, timer);
  };

  const clearResponseDeadline = (requestId: string) => {
    const timer = responseTimers.get(requestId);
    if (timer) clearTimeout(timer);
    responseTimers.delete(requestId);
  };

  const accountPermittedActions = async (
    permit: Extract<ActionPermit, { allowed: true }>,
    amount: number,
  ): Promise<ActionPermit> => {
    try {
      if (!options.onActions) {
        if (options.requireActionAccounting === true) {
          throw new Error("computer child action authority is unavailable");
        }
        return permit;
      }
      options.onActions(amount);
      return permit;
    } catch {
      const ended = await Promise.resolve(options.endAction(permit.actionId)).catch(() => false);
      if (!ended) {
        await quarantineSafely();
        finish("Local VM action accounting failed and its control ticket could not be released", true);
      }
      return { allowed: false, reason: "unavailable" };
    }
  };

  const onAbort = () => finish("provider turn ended", pendingActions.size > 0);
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  const emitBroker = (line: string) => {
    if (closed || !options.broker.open) return;
    if (!options.broker.sendBinary(Buffer.from(line + "\n"))) {
      finish("Local VM broker output queue exceeded its limit", pendingActions.size > 0);
      return;
    }
    if (options.broker.backpressured) child?.stdout.pause();
  };

  const flushDriver = () => {
    if (closed || !driverReady || !child) return;
    while (pendingDriver.length) {
      const bytes = pendingDriver[0]!;
      // Writable.write(false) means this exact chunk WAS accepted; it only
      // asks the producer to wait for drain. Remove it before pausing or the
      // drain callback would replay the same MCP request a second time.
      const writable = child.stdin.write(bytes);
      pendingDriver.shift();
      pendingDriverBytes -= bytes.length;
      if (!writable) {
        options.broker.pauseInput();
        return;
      }
    }
    if (driverInputEnded && !child.stdin.destroyed) child.stdin.end();
    options.broker.resumeInput();
  };

  const forwardDriver = (line: string): boolean => {
    if (closed) return false;
    const bytes = Buffer.from(line + "\n");
    if (!driverReady || pendingDriver.length) {
      pendingDriverBytes += bytes.length;
      if (pendingDriverBytes > MCP_MAX_PENDING_BYTES || pendingDriver.length >= MCP_MAX_PENDING_FRAMES) {
        finish("Local VM MCP driver queue exceeded its limit", pendingActions.size > 0);
        return false;
      }
      pendingDriver.push(bytes);
      flushDriver();
      return true;
    }
    if (!child || !child.stdin.write(bytes)) options.broker.pauseInput();
    return !closed;
  };

  const claimToolCall = async (): Promise<boolean> => {
    toolCalls += 1;
    if (toolCalls > maxToolCalls || !(await authorizedAndCurrent())) {
      if (toolCalls > maxToolCalls) {
        finish("Local VM MCP tool-call quota exceeded", pendingActions.size > 0);
      } else {
        finish("Local VM generation or turn authority expired", pendingActions.size > 0);
      }
      return false;
    }
    return true;
  };

  const callBatchDriver = (action: ComputerBatchAction): Promise<Record<string, unknown>> => {
    const internalId = `__openmaus_computer_batch_${++batchDriverSequence}`;
    const requestKey = `string:${internalId}`;
    return new Promise((resolve, reject) => {
      pendingBatchDriverCalls.set(requestKey, { resolve, reject });
      armResponseDeadline(requestKey);
      const forwarded = forwardDriver(JSON.stringify({
        jsonrpc: "2.0",
        id: internalId,
        method: "tools/call",
        params: { name: action.name, arguments: action.arguments },
      }));
      if (!forwarded && pendingBatchDriverCalls.delete(requestKey)) {
        clearResponseDeadline(requestKey);
        reject(new Error("Local VM driver was unavailable"));
      }
    });
  };

  const gate: GateInterceptor = createGateInterceptor({
    beginAction: async (toolName) => {
      if (!(await claimToolCall())) return { allowed: false, reason: "unavailable" };
      if (LOCAL_VM_ACT_AND_OBSERVE_TOOLS.has(toolName) && computerActionsConsumed >= COMPUTER_BATCH_MAX_ACTIONS) {
        return { allowed: false, reason: "unavailable" };
      }
      const permit = await options.beginAction();
      if (!permit.allowed || !LOCAL_VM_ACT_AND_OBSERVE_TOOLS.has(toolName)) return permit;
      const accounted = await accountPermittedActions(permit, 1);
      if (accounted.allowed) computerActionsConsumed += 1;
      return accounted;
    },
    actionForwarded: (requestId, actionId, toolName) => {
      if (closed) {
        void Promise.resolve(options.endAction(actionId)).then((ended) => {
          if (!ended) return quarantineSafely();
        }, () => quarantineSafely());
        return;
      }
      pendingActions.set(requestId, actionId);
      pendingActionTools.set(requestId, toolName);
      armResponseDeadline(requestId);
    },
    actionAbandoned: async (actionId) => {
      try {
        if (!(await options.endAction(actionId))) await quarantineSafely();
      } catch {
        await quarantineSafely();
      }
    },
    requestIdAvailable: (requestId) =>
      !pendingActions.has(requestId) &&
      !pendingToolsList.has(requestId) &&
      !pendingPassthrough.has(requestId),
    toolsListRequested: (requestId) => {
      if (pendingToolsList.size >= MCP_MAX_PENDING_FRAMES) {
        finish("too many unanswered Local VM MCP tool-list requests", pendingActions.size > 0);
        return;
      }
      pendingToolsList.add(requestId);
      armResponseDeadline(requestId);
    },
    requestForwarded: (requestId) => {
      if (pendingPassthrough.size >= MCP_MAX_PENDING_FRAMES) {
        finish("too many unanswered Local VM MCP requests", pendingActions.size > 0);
        return;
      }
      pendingPassthrough.add(requestId);
      armResponseDeadline(requestId);
    },
    requestHelp: async (reason) => await claimToolCall()
      ? options.requestHelp(reason)
      : { text: "Local VM authority became unavailable while asking for help.", isError: true },
    requestComputerBatch: async (actions) => {
      if (closed || !(await authorizedAndCurrent())) {
        return { content: [{ type: "text", text: "Local VM authority is unavailable; no batch actions were run." }], isError: true };
      }
      if (computerActionsConsumed + actions.length > COMPUTER_BATCH_MAX_ACTIONS) {
        return { content: [{ type: "text", text: `The Local VM allows at most ${COMPUTER_BATCH_MAX_ACTIONS} mechanical actions per turn; this entire batch was rejected and none ran.` }], isError: true };
      }
      const permit = await Promise.resolve(options.beginAction()).catch(
        (): ActionPermit => ({ allowed: false, reason: "unavailable" }),
      );
      if (!permit.allowed) {
        return { content: [{ type: "text", text: "Computer control is currently unavailable or held; no batch actions were run." }], isError: true };
      }
      const accounted = await accountPermittedActions(permit, actions.length);
      if (!accounted.allowed) {
        return { content: [{ type: "text", text: "Computer action accounting is unavailable; no batch actions were run." }], isError: true };
      }
      computerActionsConsumed += actions.length;
      activeBatchActionId = accounted.actionId;
      let completed = 0;
      let result: { content: Array<Record<string, unknown>>; isError?: boolean } = {
        content: [{ type: "text", text: "The computer batch could not complete safely." }],
        isError: true,
      };
      try {
        for (const action of actions) {
          if (!(await claimToolCall())) {
            return { content: [{ type: "text", text: `The computer batch stopped safely after ${completed} actions because its authority expired.` }], isError: true };
          }
          const response = await callBatchDriver(action);
          const nestedResult = response.result;
          const nestedRecord = nestedResult !== null && typeof nestedResult === "object" && !Array.isArray(nestedResult)
            ? nestedResult as Record<string, unknown>
            : null;
          if (
            "error" in response ||
            !nestedRecord ||
            "error" in nestedRecord ||
            ("isError" in nestedRecord && nestedRecord.isError !== false && nestedRecord.isError !== undefined)
          ) {
            return { content: [{ type: "text", text: `The computer batch stopped after ${completed} completed actions because action ${completed + 1} failed.` }], isError: true };
          }
          completed += 1;
        }
        const finalTool = actions.at(-1)?.name ?? "computer_batch";
        let screenshot: LocalVmActionScreenshot | null | undefined;
        // Cua's screenshot RPC can transiently collide with the just-finished
        // input RPC on the same guest socket. The mechanical actions must
        // never be replayed, but observation itself is safe to retry once.
        for (let attempt = 0; attempt < 2 && !screenshot; attempt += 1) {
          try {
            screenshot = await options.captureAfterAction?.(finalTool);
          } catch {
            screenshot = null;
          }
          if (!screenshot && attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
        if (!screenshot || screenshot.data.length > LOCAL_VM_BATCH_SCREENSHOT_MAX_BASE64_BYTES) {
          result = { content: [{ type: "text", text: `FAILED: visual postcondition unproven after ${completed} computer batch actions because the bounded final screenshot was unavailable. Do not claim success.` }], isError: true };
        } else {
          const frameHash = createHash("sha256")
            .update(screenshot.mimeType)
            .update("\0")
            .update(screenshot.data)
            .digest("hex");
          lastDeliveredFrameHash = frameHash;
          result = {
            content: [
              { type: "text", text: `Completed ${completed} computer batch actions. Final screen attached (sha256=${frameHash}).` },
              { type: "image", data: screenshot.data, mimeType: screenshot.mimeType },
            ],
          };
        }
      } catch {
        result = { content: [{ type: "text", text: `FAILED: visual postcondition unproven; the computer batch stopped after ${completed} completed actions. Do not claim success.` }], isError: true };
      } finally {
        if (!closed) {
          const actionId = activeBatchActionId;
          if (!actionId || !(await Promise.resolve(options.endAction(actionId)).catch(() => false))) {
            finish("Local VM control did not acknowledge the completed computer batch", true);
          } else {
            activeBatchActionId = null;
          }
        }
      }
      return result;
    },
    forward: forwardDriver,
    refuse: emitBroker,
    onOverflow: () => finish("Local VM MCP request queue exceeded its limit", pendingActions.size > 0),
  });

  const inbound = createLineSplitter((line) => {
    inputFrames += 1;
    if (inputFrames > LOCAL_VM_MAX_MCP_FRAMES) {
      finish("Local VM MCP frame quota exceeded", pendingActions.size > 0);
      return false;
    }
    return gate(line);
  }, {
    maxLineBytes: MCP_MAX_LINE_BYTES,
    onOverflow: () => finish("Local VM MCP request frame exceeded its limit", pendingActions.size > 0),
  });

  let outboundQueue: Promise<void> = Promise.resolve();
  let outboundPendingFrames = 0;
  let outboundPendingBytes = 0;
  let outboundFailed = false;
  const outbound = createLineSplitter((line) => {
    if (closed || outboundFailed) return false;
    outputFrames += 1;
    if (outputFrames > LOCAL_VM_MAX_MCP_FRAMES) {
      outboundFailed = true;
      finish("Local VM MCP response frame quota exceeded", pendingActions.size > 0);
      return false;
    }
    const lineBytes = Buffer.byteLength(line) + 1;
    if (
      lineBytes > MCP_MAX_PENDING_BYTES ||
      outboundPendingFrames + 1 > MCP_MAX_PENDING_FRAMES ||
      outboundPendingBytes + lineBytes > MCP_MAX_PENDING_BYTES
    ) {
      outboundFailed = true;
      finish("Local VM MCP response queue exceeded its limit", pendingActions.size > 0);
      return false;
    }
    outboundPendingFrames += 1;
    outboundPendingBytes += lineBytes;
    const task = outboundQueue.then(async () => {
      if (closed || !(await authorizedAndCurrent())) {
        finish("Local VM generation or turn authority expired", pendingActions.size > 0);
        return;
      }
      let frame: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(line);
        // The provider-facing gate never admits batches. A driver-originated
        // batch is therefore either protocol corruption or an attempt to
        // confuse action/result correlation; never relay it unchanged.
        if (Array.isArray(parsed)) {
          finish("Local VM Cua Driver returned an unsupported JSON-RPC batch", pendingActions.size > 0);
          return;
        }
        frame = parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : null;
      } catch {}
      const id = typeof frame?.id === "string" || typeof frame?.id === "number"
        ? `${typeof frame.id}:${String(frame.id)}`
        : null;
      // Driver notifications emitted while the synthetic batch is active may
      // contain its private correlation id. The provider receives exactly one
      // final synthetic result, never intermediate driver chatter.
      if (activeBatchActionId !== null && id === null) return;
      let responseLine = line;
      if (id && ("result" in (frame ?? {}) || "error" in (frame ?? {}))) {
        clearResponseDeadline(id);
        const batchCall = pendingBatchDriverCalls.get(id);
        if (batchCall && frame) {
          pendingBatchDriverCalls.delete(id);
          batchCall.resolve(frame);
          return;
        }
        pendingPassthrough.delete(id);
        const actionId = pendingActions.get(id);
        if (actionId) {
          const toolName = pendingActionTools.get(id) ?? "";
          const ordinaryResult = frame?.result;
          const ordinaryDriverError = "error" in (frame ?? {});
          const ordinaryResultValid = !ordinaryDriverError && (
            ordinaryResult !== null && typeof ordinaryResult === "object" && !Array.isArray(ordinaryResult)
          );
          if (ordinaryDriverError || !ordinaryResultValid) {
            responseLine = JSON.stringify({
              jsonrpc: "2.0",
              id: frame?.id,
              result: {
                content: [{
                  type: "text",
                  text: ordinaryDriverError
                    ? `FAILED: ${toolName || "computer action"} reported a driver error; its postcondition is unproven.`
                    : `FAILED: ${toolName || "computer action"} returned a malformed driver result; its postcondition is unproven.`,
                }],
                isError: true,
              },
            });
          }
          if (
            ordinaryResultValid &&
            LOCAL_VM_ACT_AND_OBSERVE_TOOLS.has(toolName) &&
            options.captureAfterAction
          ) {
            try {
              const screenshot = await options.captureAfterAction(toolName);
              const result = frame?.result;
              if (screenshot && result && typeof result === "object" && !Array.isArray(result)) {
                const content = Array.isArray((result as Record<string, unknown>).content)
                  ? [...((result as Record<string, unknown>).content as unknown[])]
                  : [];
                if (!content.some((item) => (
                  item && typeof item === "object" && (item as Record<string, unknown>).type === "image"
                ))) {
                  const frameHash = createHash("sha256")
                    .update(screenshot.mimeType)
                    .update("\0")
                    .update(screenshot.data)
                    .digest("hex");
                  if (frameHash === lastDeliveredFrameHash) {
                    content.push({
                      type: "text",
                      text: `Post-action screen for ${toolName} is unchanged (sha256=${frameHash}). Do not repeat the action; use the current screen or finish.`,
                    });
                  } else {
                    content.push({
                      type: "text",
                      text: `Fresh post-action screen attached for ${toolName} (sha256=${frameHash}). Inspect this image before requesting another desktop capture.`,
                    });
                    content.push({ type: "image", data: screenshot.data, mimeType: screenshot.mimeType });
                    lastDeliveredFrameHash = frameHash;
                  }
                  responseLine = JSON.stringify({
                    ...frame,
                    result: { ...(result as Record<string, unknown>), content },
                  });
                }
              }
            } catch {
              const result = frame?.result;
              if (result && typeof result === "object" && !Array.isArray(result)) {
                const content = Array.isArray((result as Record<string, unknown>).content)
                  ? [...((result as Record<string, unknown>).content as unknown[])]
                  : [];
                content.push({
                  type: "text",
                  text: `FAILED: visual postcondition unproven for ${toolName} because the post-action screen could not be captured. Take a fresh screenshot before claiming success.`,
                });
                responseLine = JSON.stringify({
                  ...frame,
                  result: { ...(result as Record<string, unknown>), content, isError: true },
                });
              }
            }
          }
          if (!(await options.endAction(actionId))) {
            finish("Local VM control did not acknowledge the completed action", true);
            return;
          }
          pendingActions.delete(id);
          pendingActionTools.delete(id);
        }
      }
      const response = augmentToolsListResponse(
        responseLine,
        pendingToolsList,
        [COMPUTER_REQUEST_HELP_TOOL, COMPUTER_BATCH_TOOL],
      );
      try {
        const delivered = JSON.parse(response) as { result?: { content?: unknown[] } };
        for (const item of delivered.result?.content ?? []) {
          if (!item || typeof item !== "object") continue;
          const image = item as { type?: unknown; data?: unknown; mimeType?: unknown };
          if (image.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string") continue;
          lastDeliveredFrameHash = createHash("sha256")
            .update(image.mimeType)
            .update("\0")
            .update(image.data)
            .digest("hex");
        }
      } catch {}
      if (id && ("result" in (frame ?? {}) || "error" in (frame ?? {}))) pendingToolsList.delete(id);
      emitBroker(response);
    });
    outboundQueue = task.catch(() => {
      finish("Local VM MCP response processing failed", pendingActions.size > 0);
    }).finally(() => {
      outboundPendingFrames -= 1;
      outboundPendingBytes -= lineBytes;
    });
    return true;
  }, {
    maxLineBytes: MCP_MAX_LINE_BYTES,
    onOverflow: () => finish("Local VM MCP response frame exceeded its limit", pendingActions.size > 0),
  });

  options.broker.onMessage((message) => {
    if (closed || !message.binary || message.data.length > MCP_MAX_LINE_BYTES) {
      finish("invalid Local VM MCP provider frame", pendingActions.size > 0);
      return;
    }
    if (message.data.length === 0) {
      if (driverInputEnded) {
        finish("duplicate Local VM MCP provider EOF", pendingActions.size > 0);
        return;
      }
      inbound.flush();
      void gate.drain().then(() => {
        driverInputEnded = true;
        flushDriver();
      });
      return;
    }
    if (driverInputEnded) {
      finish("Local VM MCP data followed provider EOF", pendingActions.size > 0);
      return;
    }
    inbound.push(message.data);
  });
  options.broker.onClose(() => {
    inbound.flush();
    void gate.drain().finally(() => {
      outbound.flush();
      void outboundQueue.finally(() => finish("provider Local VM MCP disconnected", pendingActions.size > 0));
    });
  });
  offBrokerDrain = options.broker.onDrain(() => child?.stdout.resume());

  const startDriver = async () => {
    if (!(await authorizedAndCurrent())) {
      finish("Local VM generation or turn authority expired", false);
      return;
    }
    if (closed) return;
    try {
      child = (options.spawnDriver ?? defaultSpawnDriver)(options.authority);
    } catch {
      finish("Local VM Cua Driver could not start", false);
      return;
    }
    child.stdin.on("error", () => finish("Local VM Cua Driver input failed", pendingActions.size > 0));
    child.stdin.on("drain", flushDriver);
    // Do not reveal runtime/container diagnostics to the provider. Keep a
    // bounded drain so the trusted CLI can never block on stderr either.
    child.stderr.on("data", () => {});
    child.stdout.on("data", (chunk: Buffer) => outbound.push(chunk));
    child.stdout.on("end", () => outbound.flush());
    child.once("error", () => finish("Local VM Cua Driver could not start", pendingActions.size > 0));
    child.once("close", () => {
      void outboundQueue.finally(() => finish("Local VM Cua Driver exited", pendingActions.size > 0));
    });
    driverReady = true;
    flushDriver();
    const pollMs = Math.max(250, options.generationPollMs ?? LOCAL_VM_GENERATION_POLL_MS);
    generationTimer = setInterval(() => {
      if (closed || generationChecking) return;
      generationChecking = true;
      void authorizedAndCurrent().then((current) => {
        if (!current) finish("Local VM was replaced or the turn ended", pendingActions.size > 0);
      }).finally(() => {
        generationChecking = false;
      });
    }, pollMs);
    generationTimer.unref?.();
  };
  if (!closed) void startDriver();

  return Object.freeze({
    closed: closedPromise,
    close: (reason = "Local VM MCP authority revoked") => finish(reason, pendingActions.size > 0),
  });
}

export { COMPUTER_REQUEST_HELP_TOOL };
