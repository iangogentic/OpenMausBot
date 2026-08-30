import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";

import { augmentedPath } from "./env-path.ts";
import {
  COMPUTER_REQUEST_HELP_TOOL,
  MCP_MAX_LINE_BYTES,
  MCP_MAX_PENDING_BYTES,
  MCP_MAX_PENDING_FRAMES,
  augmentToolsListResponse,
  createGateInterceptor,
  createLineSplitter,
  type GateInterceptor,
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

/** Cua Driver's low-level action tools report only metadata. Attach the
 * resulting pixels in the broker so a vision model receives one atomic
 * act-and-observe result instead of spending another inference on a separate
 * get_desktop_state call. Read-only inspection tools already return their own
 * state and must not trigger redundant captures. */
export const LOCAL_VM_ACT_AND_OBSERVE_TOOLS = new Set([
  "bring_to_front",
  "browser_click",
  "browser_fill",
  "browser_navigate",
  "click",
  "double_click",
  "drag",
  "hotkey",
  "launch_app",
  "press_key",
  "right_click",
  "scroll",
  "type_text",
]);

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
  let inputFrames = 0;
  let outputFrames = 0;
  let pendingDriverBytes = 0;
  const pendingDriver: Buffer[] = [];
  const pendingActions = new Map<string, string>();
  const pendingActionTools = new Map<string, string>();
  const pendingToolsList = new Set<string>();
  const pendingPassthrough = new Set<string>();
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
    options.signal?.removeEventListener("abort", onAbort);
    offBrokerDrain();
    options.broker.resumeInput();
    child?.stdout.pause();
    child?.stdin.destroy();
    if (quarantine && pendingActions.size) void quarantineSafely();
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

  const forwardDriver = (line: string) => {
    if (closed) return;
    const bytes = Buffer.from(line + "\n");
    if (!driverReady || pendingDriver.length) {
      pendingDriverBytes += bytes.length;
      if (pendingDriverBytes > MCP_MAX_PENDING_BYTES || pendingDriver.length >= MCP_MAX_PENDING_FRAMES) {
        finish("Local VM MCP driver queue exceeded its limit", pendingActions.size > 0);
        return;
      }
      pendingDriver.push(bytes);
      flushDriver();
      return;
    }
    if (!child || !child.stdin.write(bytes)) options.broker.pauseInput();
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

  const gate: GateInterceptor = createGateInterceptor({
    beginAction: async () => {
      if (!(await claimToolCall())) return { allowed: false, reason: "unavailable" };
      return options.beginAction();
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
      let responseLine = line;
      if (id && ("result" in (frame ?? {}) || "error" in (frame ?? {}))) {
        clearResponseDeadline(id);
        pendingPassthrough.delete(id);
        const actionId = pendingActions.get(id);
        if (actionId) {
          const toolName = pendingActionTools.get(id) ?? "";
          if (
            !("error" in (frame ?? {})) &&
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
                  content.push({
                    type: "text",
                    text: `Fresh post-action screen attached for ${toolName}. Inspect this image before requesting another desktop capture.`,
                  });
                  content.push({ type: "image", data: screenshot.data, mimeType: screenshot.mimeType });
                  responseLine = JSON.stringify({
                    ...frame,
                    result: { ...(result as Record<string, unknown>), content },
                  });
                }
              }
            } catch {
              // The action already completed. Preserve its authoritative
              // result and let the model request a fresh screenshot if the
              // best-effort observation failed.
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
      const response = augmentToolsListResponse(responseLine, pendingToolsList);
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
