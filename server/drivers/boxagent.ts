// Box agent driver — the purest form of the idea: the turn runs ON the
// bot's own cloud computer (box.ascii.dev), not on this machine. Uses the
// Box substrate's native agent facility:
//   POST /boxes/{id}/prompt   {provider: codex|claude-code, model, prompt}
//   GET  /boxes/{id}/prompts/{promptId}    run status
//   GET  /boxes/{id}/events                work events (polled)
//   POST /boxes/{id}/interrupt             stop running work
// The agent has the box's full desktop (Chrome, shell, disk) — the server
// separately polls screenshots so the chat shows the bot's screen live.
//
// The event payload shapes are tolerated liberally and teed verbatim to
// the native log — the same protocol-drift armor as every other driver.
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
import { appendNative } from "./native.ts";
import { callBoxBroker, type BoxBrokerConnection, type BoxBrokerOperation } from "../box-broker-client.ts";

const DRIVER_KIND = "boxAgent";

const MODELS = {
  default: "claude-fable-5",
  options: [
    { id: "claude-fable-5", label: "Claude Fable 5 · on the box" },
    { id: "sonnet", label: "Claude Sonnet · on the box" },
    { id: "gpt-5.4", label: "GPT-5.4 (Codex) · on the box" },
  ],
};

const providerFor = (model: string) => (model.startsWith("gpt") ? "codex" : "claude-code");

export interface BoxAgentConfig {
  pollMs: number;
}

function decodeConfig(raw: unknown): BoxAgentConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return { pollMs: typeof o.pollMs === "number" ? o.pollMs : 2500 };
}

export const BoxAgentDriver: ProviderDriver<BoxAgentConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Computer", supportsMultipleInstances: false },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<BoxAgentConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const configured = input.environment.OMB_BOX_CONFIGURED === "1";
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { cancel: () => Promise<void>; turnId: string; boxId: string }>();

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

    const api = async (
      connection: BoxBrokerConnection,
      op: BoxBrokerOperation,
      body: Record<string, unknown> = {},
      options: { signal?: AbortSignal } = {},
    ) => {
      const response = await callBoxBroker(connection, op, body, { timeoutMs: 35_000, signal: options.signal });
      if (response.ok === false) {
        const upstream = response.body as { code?: unknown; error?: unknown } | null;
        throw new Error(String(upstream?.code ?? upstream?.error ?? `box HTTP ${response.status ?? "error"}`));
      }
      return response.body ?? response;
    };

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      const computer = turn.integrations?.computer;
      const boxId = computer && (!computer.kind || computer.kind === "box") ? computer.boxId : undefined;
      const broker = computer?.broker;
      const lifecycle = computer?.lifecycle;
      if (!configured) throw new Error('box not configured — add {"box":{"token":"…"}} to ~/.openmausbot/config.json');
      if (!boxId) {
        throw new Error("this bot has no computer yet — open the Computer panel and provision one");
      }
      if (!broker) throw new Error("the scoped Box broker is unavailable for this turn");
      if (!lifecycle) throw new Error("the harness-owned Box cancellation channel is unavailable for this turn");
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = turn.turnId ?? newId();
      const model = turn.model || MODELS.default;

      const prompt = [
        turn.system,
        "You are working on your own cloud computer — its desktop, Chrome, and shell are yours.",
        "",
        turn.text,
      ]
        .filter((s) => s !== undefined)
        .join("\n");

      let cancellationRequested = false;
      let cancelAttempt: Promise<void> | null = null;
      let finalized = false;
      let announced = false;
      let promptId: string | null = null;
      let submissionStarted = false;
      let submissionFinished = false;
      let submissionSucceeded = false;
      let submissionSettled: Promise<void> = Promise.resolve();
      // Installed synchronously by the polling task before its first await.
      // Keeping the hook here lets a direct Stop flush already-streamed text
      // before the harness reports the verified remote interruption.
      let flushPendingAssistantText: () => void = () => {};
      const detachDispatchAbort = () => turn.dispatchSignal?.removeEventListener("abort", requestDispatchCancellation);
      const finalizeInterrupted = () => {
        if (finalized) return;
        finalized = true;
        detachDispatchAbort();
        active.delete(threadId);
        if (announced) {
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "interrupted", cost: null });
        }
      };
      const cancel = async (): Promise<void> => {
        cancellationRequested = true;
        if (finalized) return;
        if (cancelAttempt) return cancelAttempt;
        const attempt = (async () => {
          if (!submissionStarted) {
            finalizeInterrupted();
            return;
          }
          // A local flag is not remote cancellation. Require the broker to
          // acknowledge interrupt, then (when a run id exists) observe a
          // terminal status before the harness may release/delete/reload.
          // If submission is still in flight, interrupt once now and once
          // after its outcome settles. That second compensation closes the
          // accepted-upstream/held-response race where the first interrupt
          // could arrive just before the remote prompt becomes visible.
          const needsCompensatingInterrupt = !submissionFinished;
          await lifecycle.interrupt();
          if (needsCompensatingInterrupt) {
            await submissionSettled;
            await lifecycle.interrupt();
          }
          if (!submissionSucceeded) {
            throw new Error(
              "Box prompt submission outcome is unknown; remote shutdown cannot be verified without a prompt acknowledgement",
            );
          }
          if (promptId) {
            const deadline = Date.now() + 45_000;
            for (;;) {
              const status: any = await lifecycle.promptStatus(promptId);
              const run: any = status?.promptRun ?? status?.prompt ?? status ?? {};
              const state = String(run?.status ?? "");
              if (/completed|succeeded|done|finished|failed|error|cancelled|interrupted/i.test(state)) break;
              if (Date.now() >= deadline) throw new Error("Box did not confirm that the remote agent stopped");
              await new Promise((resolve) => setTimeout(resolve, Math.min(500, config.pollMs)));
            }
          }
          flushPendingAssistantText();
          finalizeInterrupted();
        })();
        cancelAttempt = attempt;
        try {
          await attempt;
        } catch (error) {
          // Keep the active record and allow an explicit retry. Without a
          // terminal acknowledgement, emitting turn.completed would falsely
          // tell deletion/reload that the remote computer is safe.
          if (cancelAttempt === attempt) cancelAttempt = null;
          throw error;
        }
      };
      active.set(threadId, {
        turnId,
        boxId,
        cancel,
      });
      function requestDispatchCancellation() {
        void cancel().catch(() => {});
      }
      if (turn.dispatchSignal?.aborted) {
        await cancel();
        throw new Error("Box turn dispatch was cancelled before submission");
      }
      turn.dispatchSignal?.addEventListener("abort", requestDispatchCancellation, { once: true });

      submissionStarted = true;
      const submission = api(
        broker,
        "prompt",
        { provider: providerFor(model), model, prompt },
      );
      submissionSettled = submission.then(
        () => {
          submissionSucceeded = true;
          submissionFinished = true;
        },
        () => { submissionFinished = true; },
      );
      let started: any;
      try {
        started = await submission;
      } catch (error) {
        // Once the POST has begun, a client-side timeout/disconnect cannot
        // prove the provider did not accept it. Keep the active cancellation
        // record and fail closed unless the normal prompt acknowledgement
        // lets cancel() verify the remote terminal state.
        cancellationRequested = true;
        try {
          await cancel();
        } catch (cancelError) {
          throw new AggregateError([error, cancelError], "Box prompt submission and compensating shutdown were not verified");
        }
        throw error;
      }
      appendNative(threadId, { dir: "out", source: "box.prompt", msg: { model, prompt, response: started } });
      // real shape (2026-08): {type:"prompt.queued", promptId, promptRun:{id,…},
      // id:<box id>} — never fall back to the bare id, it's the box's
      promptId = started?.promptRun?.id ?? started?.prompt?.id ?? started?.promptId ?? null;
      if (cancellationRequested || turn.dispatchSignal?.aborted) {
        await cancel();
        throw new Error("Box turn dispatch was cancelled during submission");
      }
      announced = true;
      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({ ...base(threadId, turnId), type: "session.started", sessionId: promptId, model });

      // poll events + run status until the prompt settles
      (async () => {
        const seen = new Set<string>();
        const startedAt = Date.now();
        let lastText = "";
        let pendingText = "";
        /** Emit unflushed deltas as assistant_text and reset pendingText. */
        const flushAssistantText = () => {
          const text = pendingText;
          pendingText = "";
          if (!text.trim()) return;
          emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
        };
        flushPendingAssistantText = flushAssistantText;
        /** Stream a full-text snapshot as a delta and accumulate it for flush. */
        const ingest = (text: string) => {
          const delta = text.startsWith(lastText) ? text.slice(lastText.length) : text;
          lastText = text;
          if (!delta) return;
          pendingText += delta;
          emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
        };
        try {
          for (;;) {
            if (cancellationRequested) {
              await cancel();
              return;
            }
            await new Promise((r) => setTimeout(r, config.pollMs));
            const events: any = await api(broker, "events").catch(() => null);
            const list: any[] = events?.events ?? events?.items ?? [];
            for (const ev of list) {
              const id = String(ev.id ?? ev.eventId ?? JSON.stringify(ev).slice(0, 120));
              if (seen.has(id)) continue;
              seen.add(id);
              appendNative(threadId, { dir: "in", source: "box.events", msg: ev });
              const kind = String(ev.type ?? ev.kind ?? "");
              // "response" events carry the agent's text at data.content —
              // the FULL text so far, not a chunk. Clients accumulate
              // deltas, so forward only the growth; a drifted (non-prefix)
              // event re-sends whole and the settled message replaces the
              // stream anyway.
              const text = ev.text ?? ev.message ?? ev.data?.text ?? ev.data?.content ?? null;
              if (/assistant|message|output|response/i.test(kind) && typeof text === "string" && text.trim()) {
                ingest(text);
              } else if (/tool|command|exec|browse/i.test(kind)) {
                flushAssistantText();
                emit({
                  ...base(threadId, turnId),
                  type: "item.started",
                  itemType: "tool",
                  itemId: id,
                  title: String(ev.title ?? ev.command ?? kind).slice(0, 80),
                });
              }
              // shape-drift backstop: without a promptId the status poll
              // below can never see a terminal state, so settle off the
              // events themselves instead of hanging to the 30-min ceiling
              if (!promptId && /complete|finish|done|success|fail|error/i.test(kind)) {
                finalized = true;
                detachDispatchAbort();
                active.delete(threadId);
                flushAssistantText();
                const failed = /fail|error/i.test(kind);
                emit({ ...base(threadId, turnId), type: "turn.completed", ok: !failed, stopReason: failed ? kind : null, cost: null });
                return;
              }
            }
            if (promptId) {
              const status: any = await api(broker, "prompt-status", { promptId }).catch(() => null);
              appendNative(threadId, { dir: "in", source: "box.prompt.status", msg: status });
              // real shape (2026-08): {promptRun:{status:"finished",…}} —
              // flat fallbacks kept for drift
              const run: any = status?.promptRun ?? status?.prompt ?? status ?? {};
              const state = String(run?.status ?? "");
              if (/completed|succeeded|done|finished/i.test(state)) {
                const result = run?.result ?? run?.output ?? lastText;
                if (typeof result === "string" && result.trim() && result !== lastText) {
                  ingest(result);
                }
                if (!pendingText.trim() && !lastText.trim()) pendingText = "(finished)";
                flushAssistantText();
                finalized = true;
                detachDispatchAbort();
                active.delete(threadId);
                emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null });
                return;
              }
              if (/failed|error|cancelled|interrupted/i.test(state)) {
                flushAssistantText();
                finalized = true;
                detachDispatchAbort();
                active.delete(threadId);
                emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: state, cost: null });
                return;
              }
            }
            if (Date.now() - startedAt > 30 * 60_000) {
              throw new Error("box run exceeded 30 minutes — interrupted");
            }
          }
        } catch (e) {
          flushAssistantText();
          emit({ ...base(threadId, turnId), type: "runtime.error", message: (e as Error).message });
          if (!cancellationRequested) {
            // A local poll/timeout is not a remote terminal state. Convert it
            // into the same verified cancellation path as an explicit Stop;
            // if the provider cannot prove interruption, retain the active
            // record so later Stop/reload/delete remain fail-closed.
            try {
              await cancel();
            } catch (cancelError) {
              emit({
                ...base(threadId, turnId),
                type: "runtime.error",
                message: `Box remote shutdown could not be verified: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`,
              });
            }
          }
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      if (!configured) {
        return { state: "unavailable", reason: 'no Box token — add {"box":{"token":"…"}} to ~/.openmausbot/config.json' };
      }
      // Provider reachability is verified while the harness resolves the
      // bot's exact Box and mints a scoped turn capability. A global /me
      // probe would require handing this long-lived instance the account key.
      return { state: "available", authenticated: true, version: null };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models: MODELS,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "in-session" },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.cancel(),
        respondToRequest: async () => "unavailable" as const, // this engine has no asks to answer
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          await Promise.all([...active.values()].map(({ cancel }) => cancel()));
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose: async () => {
        await Promise.all([...active.values()].map(({ cancel }) => cancel()));
        listeners.clear();
      },
    };
  },
};
