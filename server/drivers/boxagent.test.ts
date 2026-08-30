// Box agent contract tests against a scripted fake of ascii.dev's box HTTP
// API. The driver polls events + prompt status; the fake advances one poll
// per GET so we can assert message → tool → message order without sleeping.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { BoxAgentDriver } from "./boxagent.ts";

const BOX = "box-1";
const PROMPT = "p1";

/** JSON Response helper for the in-process Box HTTP fake. */
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Poll = { events: unknown[]; status?: { promptRun: { status: string; result?: string } } };

let modelCapabilityRevoked = false;
let lifecycleInterruptError: Error | null = null;
let lifecycleInterrupted = false;
let lifecycleCalls: string[] = [];
let brokerOperations: string[] = [];

/** Stub fetch so each GET /events + /prompts pair advances one poll in `script`. */
function installFakeBox(script: Poll[]) {
  let i = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url !== "http://127.0.0.1:8799/api/internal/box") return json({ error: "unexpected broker URL" }, 404);
    brokerOperations.push(String(body.op ?? ""));
    if (modelCapabilityRevoked) return json({ error: "turn capability revoked" }, 401);
    if (body.op === "prompt") return json({ ok: true, body: { promptRun: { id: PROMPT } } });
    if (body.op === "interrupt") return json({ ok: true, body: { ok: true } });
    if (body.op === "events") {
      const step = script[Math.min(i, script.length - 1)]!;
      i += 1;
      return json({ ok: true, body: { events: step.events } });
    }
    if (body.op === "prompt-status" && body.promptId === PROMPT) {
      const step = script[Math.min(Math.max(i - 1, 0), script.length - 1)]!;
      return json({ ok: true, body: step.status ?? { promptRun: { status: "running" } } });
    }
    return json({ error: `unexpected ${body.op}` }, 404);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

const computer = {
  boxId: BOX,
  broker: { url: "http://127.0.0.1:8799/api/internal/box", token: "turn-capability" },
  lifecycle: {
    interrupt: async () => {
      lifecycleCalls.push("interrupt");
      if (lifecycleInterruptError) throw lifecycleInterruptError;
      lifecycleInterrupted = true;
    },
    promptStatus: async (promptId: string) => {
      lifecycleCalls.push(`prompt-status:${promptId}`);
      return { promptRun: { status: lifecycleInterrupted ? "interrupted" : "running" } };
    },
  },
};

describe("BoxAgentDriver turns (fake API)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let restoreFetch: (() => void) | undefined;

  const create = async () => {
    instance = await BoxAgentDriver.create({
      instanceId: "box-test",
      displayName: "Box Test",
      environment: { OMB_BOX_CONFIGURED: "1", BOX_TOKEN: "must-be-ignored" },
      enabled: true,
      config: { pollMs: 0 },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    modelCapabilityRevoked = false;
    lifecycleInterruptError = null;
    lifecycleInterrupted = false;
    lifecycleCalls = [];
    brokerOperations = [];
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    restoreFetch?.();
    restoreFetch = undefined;
  });

  it("flushes prefix-grown text before a tool, then the tail at settle", async () => {
    restoreFetch = installFakeBox([
      {
        events: [{ id: "e1", type: "response", text: "hel" }],
        status: { promptRun: { status: "running" } },
      },
      {
        events: [
          { id: "e1", type: "response", text: "hel" },
          { id: "e2", type: "tool", title: "run" },
        ],
        status: { promptRun: { status: "running" } },
      },
      {
        events: [
          { id: "e1", type: "response", text: "hel" },
          { id: "e2", type: "tool", title: "run" },
          { id: "e3", type: "response", text: "hello there" },
        ],
        status: { promptRun: { status: "finished", result: "hello there" } },
      },
    ]);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-prefix", text: "go", integrations: { computer } });
    await recorder.until((e) => e.type === "turn.completed");

    const texts = recorder.events
      .filter((e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["hel", "lo there"]);
  });

  it("keeps a non-prefix response after a flush instead of slicing it away", async () => {
    restoreFetch = installFakeBox([
      {
        events: [{ id: "e1", type: "response", text: "before" }],
        status: { promptRun: { status: "running" } },
      },
      {
        events: [
          { id: "e1", type: "response", text: "before" },
          { id: "e2", type: "tool", title: "run" },
        ],
        status: { promptRun: { status: "running" } },
      },
      {
        events: [
          { id: "e1", type: "response", text: "before" },
          { id: "e2", type: "tool", title: "run" },
          { id: "e3", type: "response", text: "after" },
        ],
        status: { promptRun: { status: "finished", result: "after" } },
      },
    ]);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-nonprefix", text: "go", integrations: { computer } });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.completed", // before
      "item.started",
      "content.delta",
      "item.completed", // after — must not be sliced to ""
      "turn.completed",
    ]);
    const texts = recorder.events
      .filter((e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["before", "after"]);
  });

  it("ingests a non-prefix prompt result when events already set lastText", async () => {
    restoreFetch = installFakeBox([
      {
        events: [{ id: "e1", type: "response", text: "before" }],
        status: { promptRun: { status: "running" } },
      },
      {
        events: [
          { id: "e1", type: "response", text: "before" },
          { id: "e2", type: "tool", title: "run" },
        ],
        status: { promptRun: { status: "running" } },
      },
      {
        events: [
          { id: "e1", type: "response", text: "before" },
          { id: "e2", type: "tool", title: "run" },
        ],
        status: { promptRun: { status: "finished", result: "done" } },
      },
    ]);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-status", text: "go", integrations: { computer } });
    await recorder.until((e) => e.type === "turn.completed");

    const texts = recorder.events
      .filter((e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["before", "done"]);
  });

  it("flushes pending assistant text when the turn is interrupted", async () => {
    restoreFetch = installFakeBox([
      {
        events: [{ id: "e1", type: "response", text: "half" }],
        status: { promptRun: { status: "running" } },
      },
    ]);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cancel", text: "go", integrations: { computer } });
    await recorder.until((e) => e.type === "content.delta");
    // Simulate stop revoking the model-visible turn capability before the
    // adapter interrupt begins. Cancellation must use the harness-only
    // lifecycle channel, not the now-unauthorized broker bearer.
    modelCapabilityRevoked = true;
    await instance.adapter.interruptTurn("t-cancel");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "interrupted" });
    expect(lifecycleCalls).toEqual(["interrupt", `prompt-status:${PROMPT}`]);
    expect(brokerOperations).not.toContain("interrupt");
    const assistantIndex = recorder.events.findIndex(
      (event) => event.type === "item.completed" && (event as { itemType: string }).itemType === "assistant_text",
    );
    expect(assistantIndex).toBeLessThan(recorder.events.indexOf(done));
    const texts = recorder.events
      .filter((e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["half"]);
  });

  it("keeps the turn active when harness cancellation cannot be proved and allows a safe retry", async () => {
    restoreFetch = installFakeBox([
      {
        events: [{ id: "e1", type: "response", text: "working" }],
        status: { promptRun: { status: "running" } },
      },
    ]);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cancel-failure", text: "go", integrations: { computer } });
    await recorder.until((event) => event.type === "content.delta");

    lifecycleInterruptError = new Error("remote interrupt failed");
    await expect(instance.adapter.interruptTurn("t-cancel-failure")).rejects.toThrow("remote interrupt failed");
    expect(instance.adapter.hasSession?.("t-cancel-failure")).toBe(true);
    expect(recorder.events.some((event) => event.type === "turn.completed")).toBe(false);

    lifecycleInterruptError = null;
    await instance.adapter.interruptTurn("t-cancel-failure");
    const done = await recorder.until((event) => event.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "interrupted" });
    expect(instance.adapter.hasSession?.("t-cancel-failure")).toBe(false);
    // The polling task may observe the cancellation flag and make its own
    // failed retry before this test clears the simulated outage. Every such
    // attempt remains fail-closed; at least one later attempt must prove the
    // terminal status before the session disappears.
    expect(lifecycleCalls.filter((call) => call === "interrupt").length).toBeGreaterThanOrEqual(2);
    expect(lifecycleCalls).toContain(`prompt-status:${PROMPT}`);
  });

  it("registers cancellation before prompt submission and compensates an unknown accepted outcome", async () => {
    const previous = globalThis.fetch;
    let acceptPrompt!: (response: Response) => void;
    let markPromptStarted!: () => void;
    const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve; });
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (url !== "http://127.0.0.1:8799/api/internal/box" || body.op !== "prompt") {
        return json({ error: "unexpected request" }, 404);
      }
      brokerOperations.push("prompt");
      markPromptStarted();
      // Deliberately ignore AbortSignal: this models a broker/upstream that
      // accepted the billable prompt but has not returned its prompt id yet.
      return new Promise<Response>((resolve) => { acceptPrompt = resolve; });
    }) as typeof fetch;
    restoreFetch = () => { globalThis.fetch = previous; };
    await create();
    const dispatch = new AbortController();
    const sending = instance.adapter.sendTurn({
      threadId: "t-submit-race",
      text: "go",
      dispatchSignal: dispatch.signal,
      integrations: { computer },
    });
    await promptStarted;

    dispatch.abort();
    const stopping = instance.adapter.interruptTurn("t-submit-race");
    for (let i = 0; i < 20 && lifecycleCalls.length === 0; i += 1) await Promise.resolve();
    expect(lifecycleCalls).toEqual(["interrupt"]);

    acceptPrompt(json({ ok: true, body: { promptRun: { id: PROMPT } } }));
    await stopping;
    await expect(sending).rejects.toThrow(/cancel|abort/i);

    expect(lifecycleCalls.filter((call) => call === "interrupt")).toHaveLength(2);
    expect(instance.adapter.hasSession?.("t-submit-race")).toBe(false);
    expect(recorder.events.some((event) => event.type === "turn.started")).toBe(false);
  });
});
