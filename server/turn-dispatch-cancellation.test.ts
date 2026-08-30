import { describe, expect, it } from "vitest";

import {
  TurnDispatchCancelled,
  TurnDispatchCancellations,
} from "./turn-dispatch-cancellation.ts";

describe("turn dispatch cancellation", () => {
  const turn = { botId: "bot-a", threadId: "thread-a", generation: "generation-a" };

  it("rejects a pending setup await immediately when the exact bot is stopped", async () => {
    const pending = new TurnDispatchCancellations();
    pending.begin(turn);
    let resolveSetup!: (value: string) => void;
    const setup = new Promise<string>((resolve) => { resolveSetup = resolve; });
    const raced = pending.race(turn, setup);
    expect(pending.cancelBot(turn.botId)).toEqual(turn);
    await expect(raced).rejects.toBeInstanceOf(TurnDispatchCancelled);
    resolveSetup("late");
  });

  it("does not admit a successor until the cancelled provider registration settles", () => {
    const pending = new TurnDispatchCancellations();
    pending.begin(turn);
    expect(pending.cancelTurn(turn)).toBe(true);
    expect(pending.isInFlight(turn)).toBe(true);
    const successor = { ...turn, generation: "generation-b" };
    expect(() => pending.begin(successor)).toThrow(/still settling/);
    expect(pending.complete(turn)).toBe(false);
    pending.begin(successor);
    expect(pending.cancelTurn(turn)).toBe(false);
    expect(pending.isPending(successor)).toBe(true);
  });

  it("removes a launched dispatch without aborting its provider turn", async () => {
    const pending = new TurnDispatchCancellations();
    pending.begin(turn);
    await expect(pending.race(turn, Promise.resolve("ready"))).resolves.toBe("ready");
    expect(pending.complete(turn)).toBe(true);
    expect(pending.cancelBot(turn.botId)).toBeNull();
  });

  it("cancels every pending generation during a provider reload", () => {
    const pending = new TurnDispatchCancellations();
    pending.begin(turn);
    pending.begin({ botId: "bot-b", threadId: "thread-b", generation: "generation-b" });
    expect(pending.cancelAll()).toHaveLength(2);
    expect(pending.isPending(turn)).toBe(false);
    expect(pending.isInFlight(turn)).toBe(true);
    expect(pending.complete(turn)).toBe(false);
    expect(pending.isInFlight(turn)).toBe(false);
  });

  it("keeps provider reload waiting until every cancelled registration settles", async () => {
    const pending = new TurnDispatchCancellations();
    pending.begin(turn);
    const cancelled = pending.cancelAll();
    let drained = false;
    const waiting = pending.waitFor(cancelled).then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(pending.complete(turn)).toBe(false);
    await waiting;
    expect(drained).toBe(true);
  });

  it("does not call a cancelled setup drained until its underlying operation settles", async () => {
    const pending = new TurnDispatchCancellations();
    pending.begin(turn);
    let resolveSetup!: () => void;
    const setup = new Promise<void>((resolve) => { resolveSetup = resolve; });
    const raced = pending.race(turn, setup);
    const cancelled = pending.cancelAll();
    await expect(raced).rejects.toBeInstanceOf(TurnDispatchCancelled);

    // This mirrors the detached turn catch: its wrapper is done, but the
    // external setup request is still capable of creating a resource.
    expect(pending.complete(turn)).toBe(false);
    let drained = false;
    const waiting = pending.waitFor(cancelled).then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    resolveSetup();
    await waiting;
    expect(drained).toBe(true);
    expect(pending.isInFlight(turn)).toBe(false);
  });

  it("propagates a late-child cleanup failure to the Stop waiter", async () => {
    const pending = new TurnDispatchCancellations();
    pending.begin(turn);
    const cancelled = pending.cancelAll();
    const cleanupFailure = new Error("late child still running");

    expect(pending.complete(turn, cleanupFailure)).toBe(false);

    await expect(pending.waitFor(cancelled)).rejects.toThrow("late child still running");
    expect(pending.isInFlight(turn)).toBe(false);
  });
});
