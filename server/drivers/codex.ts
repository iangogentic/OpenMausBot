// Codex driver — upstream CodexDriver skeleton over agentcal's
// drivers/codex.js runtime: the official `codex` CLI headless over its
// app-server JSON-RPC protocol (newline-delimited JSON on stdio).
// Completion is a real `turn/completed` notification; approval requests
// arrive as in-process server→client JSON-RPC requests and surface as
// canonical request.opened events (answered via respondToRequest — no MCP
// proxy or unix socket needed, unlike claude). Verified against
// codex-cli 0.144.4 by agentcal.
//
// resumeCursor is the codex thread id; a later turn tries thread/resume
// and falls back to a fresh thread/start.
import { homedir } from "node:os";

import { computerProxyEnv } from "../container-computer.ts";
import { describeSpawnFailure, execCli, spawnCli, terminateCliTree } from "../procs.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { providerChildEnvironment } from "../provider-child-env.ts";

import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { decodeCodexSelection, readCodexModelCatalog, STATIC_CODEX_MODELS } from "./codex-catalog.ts";
import {
  applyModelRelayEnvironment,
  codexLocalProviderArgs,
  codexLocalProviderSelection,
} from "./local-inject.ts";
import { augmentedPath } from "../env-path.ts";
import { classifyError, computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "./retry.ts";
import { appendNative } from "./native.ts";
import { BoundedJsonLineDecoder } from "./bounded-json-lines.ts";

export { decodeCodexSelection, readCodexModelCatalog, STATIC_CODEX_MODELS } from "./codex-catalog.ts";

const DRIVER_KIND = "codex";

export interface CodexConfig {
  cli: string;
  fullAuto: boolean;
}

function decodeConfig(raw: unknown): CodexConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    cli: typeof o.cli === "string" ? o.cli : "codex",
    fullAuto: o.fullAuto === true,
  };
}

const QUESTION_TIMEOUT_NOTE = "No answer was given — use your best judgment.";
const DENY_TIMEOUT_NOTE =
  "OpenMausBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";

type StdioMcpServer = { command: string; args: string[]; env: Record<string, string> };

function mountMcpServer(
  appServerArgs: string[],
  env: Record<string, string | undefined>,
  name: string,
  server: StdioMcpServer,
): void {
  Object.assign(env, server.env);
  const prefix = `mcp_servers.${name}`;
  appServerArgs.push(
    "-c", `${prefix}.command=${JSON.stringify(server.command)}`,
    "-c", `${prefix}.args=${JSON.stringify(server.args)}`,
    // Values stay in the child environment; argv contains names only so
    // credentials never appear in process listings or diagnostics.
    "-c", `${prefix}.env_vars=${JSON.stringify(Object.keys(server.env))}`,
    "-c", `${prefix}.default_tools_approval_mode="auto"`,
  );
}

export const CodexDriver: ProviderDriver<CodexConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Codex", supportsMultipleInstances: true },
  install: {
    command: {
      darwin: "npm install -g @openai/codex",
      linux: "npm install -g @openai/codex",
      win32: "npm install -g @openai/codex",
    },
    needsNode: true,
    docsUrl: "https://github.com/openai/codex",
    signInCommand: "codex login",
  },
  models: STATIC_CODEX_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<CodexConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const childEnv = (): Record<string, string | undefined> => {
      const env = providerChildEnvironment(input.environment, {
        internal: { PATH: augmentedPath(), NPM_CONFIG_LOGLEVEL: "error" },
      });
      // The CLI owns its own ChatGPT login; a leaked API key silently flips
      // billing to pay-as-you-go (agentcal).
      delete env.OPENAI_API_KEY;
      return env;
    };
    const catalogEnv = childEnv();
    let models = STATIC_CODEX_MODELS;
    const refreshModels = async () => {
      try {
        const resolved = await readCodexModelCatalog(catalogEnv, fetch, config.cli);
        if (resolved.options.length) models = resolved;
      } catch {
        // Keep the last usable catalog when a local provider is down.
      }
    };
    await refreshModels();
    const listeners = new Set<RuntimeEventListener>();
    interface Turn {
      stop: () => Promise<void>;
      turnId: string;
      asks: Map<string, (behavior: "allow" | "deny" | "answer", message?: string, source?: "user" | "timeout" | "system") => void>;
    }
    const active = new Map<string, Turn>();

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const sendTurn = async (turn: SendTurnInput) => {
      // One driver instance serves many threads. Interrupt state belongs to
      // this turn so activity elsewhere cannot cancel or revive its retry.
      let stopRequested = false;
      const retryAbort = new AbortController();
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = turn.turnId ?? newId();
      // a retry relaunches the whole app-server; the backoff is scaled down in
      // tests so a fake's transient failures don't stall real seconds
      const retryScale = Number(process.env.FAKE_CODEX_RETRY_SCALE ?? "1");

      const launchAttempt = async (attempt: number): Promise<void> => {
        const env = childEnv();
        applyModelRelayEnvironment(env, turn.model, turn.integrations?.modelRelay);
        const appServerArgs = ["app-server", ...codexLocalProviderArgs(env, turn.model)];
        const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
        const effectiveFullAuto = config.fullAuto && !controlsHost;
        if (turn.integrations?.composio) {
          mountMcpServer(appServerArgs, env, "openmausbot_connectors", turn.integrations.composio);
        }
        if (turn.integrations?.agents) {
          mountMcpServer(appServerArgs, env, "agents", turn.integrations.agents);
        }
        if (turn.integrations?.computerOperator) {
          mountMcpServer(appServerArgs, env, "computer_operator", turn.integrations.computerOperator);
        }
        if (turn.integrations?.ianBrain) {
          mountMcpServer(appServerArgs, env, "ian_brain", {
            command: process.execPath,
            args: [SPAWNED_PROXIES.ianBrain],
            env: {
              ELECTRON_RUN_AS_NODE: "1",
              OMB_IAN_BRAIN_URL: turn.integrations.ianBrain.url,
              OMB_IAN_BRAIN_CAPABILITY_TOKEN: turn.integrations.ianBrain.token,
            },
          });
        }
        if (!turn.integrations?.computerOperator && turn.integrations?.computer) {
          const proxyEnv = computerProxyEnv(turn.integrations.computer);
          mountMcpServer(appServerArgs, env, "computer", {
            command: process.execPath,
            args: [SPAWNED_PROXIES.computer],
            env: {
              ELECTRON_RUN_AS_NODE: "1",
              OGB_BOX_ID: proxyEnv.OGB_BOX_ID ?? "",
              OMB_BOX_BROKER_URL: proxyEnv.OMB_BOX_BROKER_URL ?? "",
              OMB_BOX_CAPABILITY_TOKEN: proxyEnv.OMB_BOX_CAPABILITY_TOKEN ?? "",
              // who-is-driving endpoint, so a person taking the wheel in the
              // panel pauses this bot's hands mid-turn
              OMB_CONTROL_URL: proxyEnv.OMB_CONTROL_URL ?? "",
              OMB_CONTROL_TOKEN: proxyEnv.OMB_CONTROL_TOKEN ?? "",
            },
          });
        } else if (!turn.integrations?.computerOperator && turn.integrations?.localComputer) {
          // The host daemon and isolated Local VM both arrive as a direct Cua
          // Driver stdio MCP server. Codex sees the same computer tool surface.
          mountMcpServer(appServerArgs, env, "computer", turn.integrations.localComputer);
        }
        if (turn.integrations?.phone) {
          const bridge = turn.integrations.phone;
          Object.assign(env, bridge.env);
          const prefix = "mcp_servers.openmausbot_phone";
          appServerArgs.push(
            "-c", `${prefix}.command=${JSON.stringify(bridge.command)}`,
            "-c", `${prefix}.args=${JSON.stringify(bridge.args)}`,
            "-c", `${prefix}.env_vars=${JSON.stringify(Object.keys(bridge.env))}`,
            "-c", `${prefix}.default_tools_approval_mode="auto"`,
          );
        }

        const child = spawnCli(config.cli, appServerArgs, {
          cwd: turn.cwd ?? homedir(),
          env,
          stdio: ["pipe", "pipe", "pipe"],
          providerRuntimePaths: turn.providerRuntimePaths,
          providerPersistentHome: {
            ownerKey: turn.isolationKey ?? threadId,
          },
        });

      let abandoned = false;
      const state = {
        settled: false,
        settling: false,
        lastText: "",
        sawStreamDelta: false,
        // codex reports token usage as a running THREAD total; the harness
        // wants this turn's figure, so the last report is banked on settle
        usage: undefined as { input: number; output: number } | undefined,
      };

      const asks = new Map<string, (behavior: "allow" | "deny" | "answer", message?: string, source?: "user" | "timeout" | "system") => void>();
      let nextId = 1;
      const rpcPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

      const send = (obj: unknown) => {
        try {
          child.stdin.write(JSON.stringify(obj) + "\n");
        } catch {}
        appendNative(threadId, { dir: "out", source: "codex.app-server", msg: obj });
      };
      const request = (method: string, params: unknown, timeoutMs = 60_000) =>
        new Promise<any>((resolve, reject) => {
          const id = nextId++;
          // a wedged app-server can accept stdin and never reply; without this
          // the handshake await hangs forever and the bot stays busy for good
          const timer = setTimeout(() => {
            if (rpcPending.delete(id)) reject(new Error(`codex ${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          if (typeof timer.unref === "function") timer.unref();
          rpcPending.set(id, {
            resolve: (v) => {
              clearTimeout(timer);
              resolve(v);
            },
            reject: (e) => {
              clearTimeout(timer);
              reject(e);
            },
          });
          send({ jsonrpc: "2.0", id, method, params });
        });

      let activeTurn: Turn;
      let settlePromise: Promise<void> | null = null;

      const settle = (ok: boolean, stopReason: string | null): Promise<void> => {
        if (state.settled) return settlePromise ?? Promise.resolve();
        if (settlePromise) return settlePromise;
        state.settling = true;
        for (const finish of [...asks.values()]) finish("deny", "OpenMausBot: the turn ended", "system");
        for (const p of rpcPending.values()) p.reject(new Error("turn settled"));
        rpcPending.clear();
        const pending = (async () => {
          try {
            await terminateCliTree(child); // the app-server never exits on its own
          } catch (error) {
            state.settling = false;
            settlePromise = null;
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: `could not prove codex exited: ${error instanceof Error ? error.message : String(error)}`,
            });
            throw error;
          }
          state.settled = true;
          // A retired retry attempt can finish after its replacement has
          // registered on the same stable thread and with the same logical
          // turn id. Only its exact active handle may remove itself or publish
          // the logical terminal event; otherwise the replacement would be
          // orphaned from the harness even if its map entry survived.
          if (active.get(threadId) !== activeTurn) return;
          active.delete(threadId);
          emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null, ...(state.usage ? { usage: state.usage } : {}) });
        })();
        settlePromise = pending;
        // Notification/exit handlers intentionally do not await settlement;
        // retain a rejection handler while still returning the original
        // promise to explicit Stop/delete callers.
        void pending.catch(() => {});
        return pending;
      };

      const stop = async () => {
        stopRequested = true;
        retryAbort.abort();
        await settle(false, "interrupted");
      };

      // server→client approval request → canonical request.opened
      // Host-scope tagging mirrors claude.ts: when this turn mounts the real
      // Mac (not a VM), every card carries approvalScope so the harness's
      // local-computer-block backstop applies to remembered always-allows.
      const handleServerRequest = (msg: any) => {
        if (abandoned) return;
        const method = msg.method as string;
        const params = msg.params ?? {};
        const legacy = method === "execCommandApproval" || method === "applyPatchApproval";
        const isMcpElicitation =
          method === "mcpServer/elicitation/request" &&
          params?._meta?.codex_approval_kind === "mcp_tool_call";
        const isQuestion = method === "item/tool/requestUserInput";
        const mcpTool = isMcpElicitation
          ? String(params.message ?? "").match(/tool \"([^\"]+)\"/)?.[1]
          : undefined;
        const tool =
          isMcpElicitation
            ? (mcpTool ?? "mcp")
            : method === "item/fileChange/requestApproval" || method === "applyPatchApproval"
            ? "edit"
            : isQuestion
              ? "ask_user"
              : "shell";
        // Full-auto belongs to the harness workspace/VM boundary. It must
        // never silently widen into the user's physical computer merely
        // because a local-computer MCP mount is present.
        if (effectiveFullAuto && !isQuestion) {
          return send({
            jsonrpc: "2.0",
            id: msg.id,
            result: isMcpElicitation
              ? { action: "accept", content: {} }
              : { decision: legacy ? "approved" : "accept" },
          });
        }
        const requestId = newId();
        const summary =
          isMcpElicitation && typeof params.message === "string"
            ? params.message
            : typeof params.command === "string"
            ? params.command
            : Array.isArray(params.questions)
              ? params.questions.map((q: any) => q.question ?? q.header).filter(Boolean).join(" · ")
              : typeof params.reason === "string"
                ? params.reason
                : tool;
        const choices = isQuestion
          ? (params.questions?.[0]?.options ?? []).map((o: any) => o.label).slice(0, 5)
          : undefined;
        const finish = (behavior: "allow" | "deny" | "answer", message?: string, source: "user" | "timeout" | "system" = "user") => {
          if (!asks.delete(requestId)) return;
          clearTimeout(timer);
          if (isQuestion) {
            const answers: Record<string, { answers: string[] }> = {};
            for (const q of Array.isArray(params.questions) ? params.questions : []) {
              answers[q.id] = { answers: [message || QUESTION_TIMEOUT_NOTE] };
            }
            send({ jsonrpc: "2.0", id: msg.id, result: { answers } });
          } else {
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: isMcpElicitation
                ? behavior === "allow"
                  ? { action: "accept", content: {} }
                  : { action: "decline" }
                : { decision: behavior === "allow" ? (legacy ? "approved" : "accept") : legacy ? "denied" : "decline" },
            });
          }
          emit({ ...base(threadId, turnId), type: "request.resolved", requestId, behavior, source });
        };
        const timer = setTimeout(
          () => (isQuestion ? finish("answer", QUESTION_TIMEOUT_NOTE, "timeout") : finish("deny", DENY_TIMEOUT_NOTE, "timeout")),
          15 * 60_000,
        );
        timer.unref?.();
        asks.set(requestId, finish);
        emit({
          ...base(threadId, turnId),
          type: "request.opened",
          requestId,
          requestType: isQuestion ? "question" : "permission",
          tool,
          summary,
          choices,
          approvalScope: controlsHost ? "local-computer" : undefined,
        });
      };

      const handleNotification = (msg: any) => {
        if (abandoned) return;
        const p = msg.params ?? {};
        switch (msg.method) {
          // token-level chat text; the item/completed frame follows with the
          // whole message, so its delta is only a fallback when none streamed
          case "item/agentMessage/delta": {
            const delta = typeof p.delta === "string" ? p.delta : "";
            if (delta) {
              state.sawStreamDelta = true;
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
            }
            break;
          }
          case "item/reasoning/textDelta":
          case "item/reasoning/summaryTextDelta": {
            const delta = typeof p.delta === "string" ? p.delta : "";
            if (delta) emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta });
            break;
          }
          case "item/started": {
            const item = p.item ?? {};
            const title =
              item.type === "commandExecution"
                ? String(item.command ?? "shell")
                : item.type === "fileChange"
                  ? "edit"
                  : item.type === "mcpToolCall"
                    ? (item.tool ?? item.name ?? "mcp")
                    : item.type === "webSearch"
                      ? "web_search"
                      : null;
            if (title) emit({ ...base(threadId, turnId), type: "item.started", itemType: "tool", itemId: item.id, title });
            break;
          }
          case "item/completed": {
            const item = p.item ?? {};
            if (item.type === "agentMessage") {
              if (item.text?.trim()) {
                state.lastText = item.text;
                if (!state.sawStreamDelta) {
                  emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: item.text });
                }
                state.sawStreamDelta = false;
                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: item.text });
              }
            } else if (["commandExecution", "fileChange", "mcpToolCall", "webSearch"].includes(item.type)) {
              emit({
                ...base(threadId, turnId),
                type: "item.completed",
                itemType: "tool",
                itemId: item.id,
                ok: item.status !== "failed" && item.status !== "declined",
              });
            } else if (item.type === "reasoning") {
              emit({ ...base(threadId, turnId), type: "item.updated", itemType: "reasoning", tokens: null });
            }
            break;
          }
          case "thread/tokenUsage/updated": {
            // `last` is the most recent turn when the server sends it;
            // `total` is the thread so far — a fresh app-server per turn
            // makes that this turn's figure too
            const turnUsage = p.tokenUsage?.last ?? p.tokenUsage?.total;
            if (turnUsage) state.usage = { input: turnUsage.inputTokens ?? 0, output: turnUsage.outputTokens ?? 0 };
            const t = p.tokenUsage?.total;
            if (t) {
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: t.inputTokens ?? 0,
                output: t.outputTokens ?? 0,
              });
            }
            break;
          }
          case "turn/completed": {
            const t = p.turn ?? {};
            void settle(t.status === "completed", t.status === "completed" ? null : (t.error?.message ?? t.status ?? "failed"));
            break;
          }
          case "error":
            // shape drift: 0.144 sends {message}, 0.139 nests it under
            // {error:{message}} — surface either (agentcal armor)
            {
              const message = p.message ?? p.error?.message;
              if (message) emit({ ...base(threadId, turnId), type: "runtime.error", message: String(message).slice(0, 400) });
            }
            break;
        }
      };

      const stdout = new BoundedJsonLineDecoder();
      let outputRejected = false;
      child.stdout.on("data", (chunk) => {
        if (outputRejected) return;
        try {
          for (const { value } of stdout.push(chunk)) {
            const msg: any = value;
            appendNative(threadId, { dir: "in", source: "codex.app-server", msg });
            if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
              const pend = rpcPending.get(msg.id);
              if (pend) {
                rpcPending.delete(msg.id);
                msg.error ? pend.reject(new Error(msg.error.message ?? JSON.stringify(msg.error))) : pend.resolve(msg.result);
              }
            } else if (msg.id !== undefined && msg.method) {
              handleServerRequest(msg);
            } else if (msg.method) {
              handleNotification(msg);
            }
          }
        } catch (error) {
          outputRejected = true;
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: error instanceof Error ? error.message : String(error),
          });
          void settle(false, "provider_output_limit");
        }
      });

      let stderr = "";
      child.stderr.on("data", (c) => {
        stderr += c;
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });
      child.on("error", (e) => {
        if (abandoned) return;
        emit({ ...base(threadId, turnId), type: "runtime.error", ...describeSpawnFailure(e, config.cli) });
        void settle(false, "spawn_error");
      });
      child.on("close", (code) => {
        if (abandoned) return;
        if (!state.settled && !state.settling) {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: `codex exited ${code} before turn/completed${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`,
          });
          void settle(false, "exit_before_result");
        }
      });

      activeTurn = { stop, turnId, asks };
      active.set(threadId, activeTurn);
      // Relaunching the app-server is still the same logical turn. Keep the
      // active process current on every attempt, but announce the turn once.
      if (attempt === 0) emit({ ...base(threadId, turnId), type: "turn.started" });

      // handshake + kickoff; a transient failure (5xx/overloaded/reset) gets
      // one relaunch of the whole app-server after backoff — but only when
      // nothing streamed yet, and never for auth/shape errors or interrupts
      try {
        await request("initialize", { clientInfo: { name: "openmausbot", version: "1" } });
        send({ jsonrpc: "2.0", method: "initialized", params: {} });
        const cursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
        let codexThreadId: string | null = null;
        let startedModel: string | null = null;
        if (cursor) {
          try {
            const resumed = await request("thread/resume", { threadId: cursor });
            codexThreadId = resumed?.thread?.id ?? cursor;
          } catch {
            /* resume unsupported or thread gone — start fresh below */
          }
        }
        if (!codexThreadId) {
          const selection = codexLocalProviderSelection(env, turn.model) ?? decodeCodexSelection(turn.model);
          const started = await request("thread/start", {
            cwd: turn.cwd ?? homedir(),
            model: selection.model,
            ...(selection.modelProvider ? { modelProvider: selection.modelProvider } : {}),
            sandbox: effectiveFullAuto ? "danger-full-access" : "workspace-write",
            approvalPolicy: effectiveFullAuto ? "never" : "on-request",
            ephemeral: false,
          });
          codexThreadId = started?.thread?.id ?? null;
          startedModel = started?.model ?? null;
        }
        emit({ ...base(threadId, turnId), type: "session.started", sessionId: codexThreadId, model: startedModel ?? turn.model ?? null });
        await request("turn/start", {
          threadId: codexThreadId,
          input: [{ type: "text", text: turn.system ? `${turn.system}\n\n${turn.text}` : turn.text }],
          // Spread, not `effort: turn.effort ?? null`. Probed against
          // codex-cli 0.146.0: null is indistinguishable from an absent key
          // — both leave the thread's current effort alone, emitting no
          // thread/settings/updated, and thread/resume reads the old value
          // back. The app-server offers no way to clear a level either:
          // "" is rejected outright and thread/start takes no effort at
          // all. So a thread keeps the last level it was sent until it is
          // sent another, and choosing Default lands on the bot's next new
          // thread rather than the current one.
          ...(turn.effort ? { effort: turn.effort } : {}),
        });
      } catch (e) {
        const failure = e instanceof Error ? e : { text: String(e) };
        const message = e instanceof Error ? e.message : String(e);
        const needsAuth = /(?:\b401\b|unauthorized|missing bearer|authentication required)/i.test(message);
        const verdict = classifyError(failure);
        if (!state.settled && !state.settling && !needsAuth && verdict.transient && attempt < RETRY_MAX_ATTEMPTS - 1 && state.sawStreamDelta === false) {
          const delayMs = computeBackoff(attempt);
          attempt++;
          emit({
            ...base(threadId, turnId),
            type: "turn.retrying",
            attempt,
            delayMs,
            reason: verdict.reason,
          });
          // This app-server never exits by itself. Retire the failed attempt
          // and silence its late handlers before the replacement launches.
          abandoned = true;
          try {
            await terminateCliTree(child);
          } catch (terminationError) {
            abandoned = false;
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: `could not stop the failed codex attempt: ${terminationError instanceof Error ? terminationError.message : String(terminationError)}`,
            });
            void settle(false, "termination_failed");
            return;
          }
          if (stopRequested || state.settled || state.settling) return;
          const wait = interruptibleDelay(
            Math.max(1, Math.round(delayMs * retryScale)),
            retryAbort.signal,
          );
          const waitResult = await wait.promise;
          if (waitResult === "elapsed" && !stopRequested && !state.settled && !state.settling) {
            void launchAttempt(attempt).catch(() => {});
          } else {
            void settle(false, "interrupted");
          }
          return;
        }
        if (!state.settled && !state.settling) {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message,
            ...(needsAuth ? { setup: true } : {}),
          });
          void settle(false, needsAuth ? "auth_required" : "rpc_error");
        }
      }
    };

    void launchAttempt(0).catch(() => {});
    return { turnId };
  };

  const snapshot = async (): Promise<ProviderSnapshot> => {
    const env = childEnv();
    const version = await new Promise<string | null>((resolve) => {
      execCli(config.cli, ["--version"], { timeout: 8000, env }, (err, stdout) =>
        resolve(err ? null : stdout.trim()),
      );
    });
    if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
    const authenticated = await new Promise<boolean>((resolve) => {
      execCli(config.cli, ["login", "status"], { timeout: 8000, env }, (err, stdout, stderr) =>
        resolve(!err && /^logged in\b/im.test(`${stdout}\n${stderr ?? ""}`)),
      );
    });
    // childEnv drops OPENAI_API_KEY on purpose — turns run on the ChatGPT login
    return { state: "available", version, authenticated, billing: "subscription" };
  };

  return {
    instanceId,
    driverKind: DRIVER_KIND,
    displayName: input.displayName,
    enabled: input.enabled,
    get models() {
      return models;
    },
    refreshModels,
    snapshot,
    adapter: {
      provider: DRIVER_KIND,
      capabilities: {
        sessionModelSwitch: "unsupported",
        computerMcp: true,
        computerOperatorMcp: true,
        localComputerMcp: true,
        composioMcp: true,
        agentsMcp: true,
        phoneMcp: true,
        images: true,
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      sendTurn,
      interruptTurn: async (threadId) => {
        const turn = active.get(threadId);
        if (turn) await turn.stop();
      },
      respondToRequest: async (threadId, requestId, decision) => {
        const turn = active.get(threadId);
        const finish = turn?.asks.get(requestId);
        if (!finish) return "unavailable"; // settled, timed out, or turn gone
        finish(decision.behavior, decision.message, "user");
        return decision.behavior === "allow" ? "allowed-once" : decision.behavior === "answer" ? "answered" : "rejected";
      },
      hasSession: (threadId) => active.has(threadId),
      stopAll: async () => {
        await Promise.all([...active.values()].map(({ stop }) => stop()));
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    dispose: async () => {
      await Promise.all([...active.values()].map(({ stop }) => stop()));
      listeners.clear();
    },
  };
},
};
