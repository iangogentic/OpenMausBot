import { describe, expect, it, vi } from "vitest";

import type { ProviderAdapter, RuntimeEvent } from "./contracts.ts";
import { COMPUTER_OPERATOR_OUTPUT_MAX_BYTES, createComputerOperatorProviderRuntime } from "./computer-operator-provider.ts";

type RuntimeEventInput = RuntimeEvent extends infer Event
  ? Event extends RuntimeEvent ? Omit<Event, "eventId" | "createdAt"> : never
  : never;

function fakeAdapter(onSend?: (input: Parameters<ProviderAdapter["sendTurn"]>[0], emit: (event: RuntimeEventInput) => void) => void) {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const emit = (event: RuntimeEvent) => { for (const listener of [...listeners]) listener(event); };
  let eventSequence = 0;
  const runtimeEvent = (event: RuntimeEventInput): RuntimeEvent => ({
    ...event,
    eventId: `event-${++eventSequence}`,
    createdAt: new Date().toISOString(),
  } as RuntimeEvent);
  const adapter: ProviderAdapter = {
    provider: "hermesAgent",
    capabilities: { sessionModelSwitch: "unsupported", computerMcp: true, localComputerMcp: true, images: true },
    sendTurn: vi.fn(async (input) => {
      onSend?.(input, (event) => emit(runtimeEvent(event)));
      return { turnId: input.turnId! };
    }),
    interruptTurn: vi.fn(async (threadId, turnId) => {
      emit(runtimeEvent({ provider: "hermesAgent", threadId, turnId: turnId!, type: "turn.completed", ok: true, stopReason: "cancelled", cost: null }));
    }),
    respondToRequest: vi.fn(async () => "unavailable" as const),
    hasSession: vi.fn(() => false),
    stopAll: vi.fn(async () => {}),
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { adapter, emit: (event: RuntimeEventInput) => emit(runtimeEvent(event)) };
}

const launchInput = {
  childId: "child-1",
  parent: { botId: "bot", threadId: "parent-thread", turnId: "parent-turn", generation: "parent-generation" },
  model: { instanceId: "hermes", model: "desktop2_qwen::qwen" },
  prompt: "open a terminal",
  target: { targetKey: "vm:bot", targetGeneration: "vm-generation", opaqueCapability: {} },
  signal: new AbortController().signal,
};

describe("computer operator hidden provider child", () => {
  it("subscribes before sendTurn and resolves only exact child terminal events", async () => {
    const fake = fakeAdapter((input, emit) => {
      emit({ provider: "hermesAgent", threadId: input.threadId, turnId: input.turnId!, type: "item.completed", itemType: "assistant_text", text: "visible success" });
      emit({ provider: "hermesAgent", threadId: "someone-else", turnId: input.turnId!, type: "turn.completed", ok: true, stopReason: null, cost: null });
      emit({ provider: "hermesAgent", threadId: input.threadId, turnId: input.turnId!, type: "turn.completed", ok: true, stopReason: null, cost: null });
    });
    const runtime = createComputerOperatorProviderRuntime({ prepare: async () => ({ adapter: fake.adapter }) });
    const child = await runtime.launch(launchInput);
    await expect(child.completion).resolves.toEqual({ status: "completed", output: "visible success" });
    await expect(child.waitForTerminal()).resolves.toBeUndefined();
    expect(fake.adapter.sendTurn).toHaveBeenCalledWith(expect.objectContaining({
      turnId: "child-1",
      text: "open a terminal",
      model: "desktop2_qwen::qwen",
      resumeCursor: undefined,
      transcript: undefined,
      dispatchSignal: launchInput.signal,
    }));
  });

  it("does not dispatch after cancellation during preparation", async () => {
    const fake = fakeAdapter();
    const controller = new AbortController();
    const runtime = createComputerOperatorProviderRuntime({
      prepare: async () => {
        controller.abort(new DOMException("parent stopped", "AbortError"));
        return { adapter: fake.adapter };
      },
    });
    await expect(runtime.launch({ ...launchInput, signal: controller.signal })).rejects.toThrow();
    expect(fake.adapter.sendTurn).not.toHaveBeenCalled();
  });

  it("bounds arbitrarily large assistant output", async () => {
    const fake = fakeAdapter((input, emit) => {
      emit({ provider: "hermesAgent", threadId: input.threadId, turnId: input.turnId!, type: "item.completed", itemType: "assistant_text", text: "x".repeat(COMPUTER_OPERATOR_OUTPUT_MAX_BYTES * 2) });
      emit({ provider: "hermesAgent", threadId: input.threadId, turnId: input.turnId!, type: "turn.completed", ok: true, stopReason: null, cost: null });
    });
    const child = await createComputerOperatorProviderRuntime({ prepare: async () => ({ adapter: fake.adapter }) }).launch(launchInput);
    const outcome = await child.completion;
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(Buffer.byteLength(outcome.output ?? "", "utf8")).toBeLessThanOrEqual(COMPUTER_OPERATOR_OUTPUT_MAX_BYTES);
      expect(outcome.output).toContain("truncated");
    }
  });

  it("interrupts the exact hidden child and waits for its terminal event", async () => {
    const fake = fakeAdapter();
    const child = await createComputerOperatorProviderRuntime({ prepare: async () => ({ adapter: fake.adapter }) }).launch(launchInput);
    const interrupted = child.interrupt();
    await expect(interrupted).resolves.toBeUndefined();
    await expect(child.completion).resolves.toMatchObject({ status: "aborted" });
    await expect(child.waitForTerminal()).resolves.toBeUndefined();
    expect(fake.adapter.interruptTurn).toHaveBeenCalledWith(expect.stringMatching(/^computer-operator-/), "child-1");
  });

  it("settles a session-scoped exit that omits turnId on the unique hidden thread", async () => {
    let childThread = "";
    const fake = fakeAdapter((input, emit) => {
      childThread = input.threadId;
      emit({ provider: "hermesAgent", threadId: input.threadId, type: "session.exited", reason: "process exited" });
    });
    const child = await createComputerOperatorProviderRuntime({ prepare: async () => ({ adapter: fake.adapter }) }).launch(launchInput);
    await expect(child.completion).resolves.toEqual({
      status: "failed",
      error: "computer operator provider session exited before terminal completion",
    });
    expect(childThread).toMatch(/^computer-operator-/);
  });

  it("denies any provider permission request that escapes the trusted operator policy", async () => {
    const fake = fakeAdapter((input, emit) => {
      emit({
        provider: "hermesAgent",
        threadId: input.threadId,
        turnId: input.turnId!,
        type: "request.opened",
        requestId: "hidden-request",
        requestType: "permission",
        tool: "shell",
        summary: "run command",
      });
      emit({ provider: "hermesAgent", threadId: input.threadId, turnId: input.turnId!, type: "turn.completed", ok: true, stopReason: null, cost: null });
    });
    const child = await createComputerOperatorProviderRuntime({ prepare: async () => ({ adapter: fake.adapter }) }).launch(launchInput);
    await expect(child.completion).resolves.toMatchObject({ status: "completed" });
    expect(fake.adapter.respondToRequest).toHaveBeenCalledWith(
      expect.stringMatching(/^computer-operator-/),
      "hidden-request",
      { behavior: "deny" },
    );
  });
});
