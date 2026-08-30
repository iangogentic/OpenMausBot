import { describe, expect, it } from "vitest";

import { TurnExternalOperations } from "./turn-external-operations.ts";

describe("turn external operations", () => {
  const turn = { botId: "bot-a", threadId: "thread-a", generation: "generation-a" };

  it("aborts an exact generation and does not report drained until its upstream settles", async () => {
    const operations = new TurnExternalOperations();
    let release!: () => void;
    let signal!: AbortSignal;
    const upstream = operations.run(turn, async (ownedSignal) => {
      signal = ownedSignal;
      await new Promise<void>((resolve) => { release = resolve; });
      return "late";
    });
    let drained = false;
    const draining = operations.cancelTurn(turn).then(() => { drained = true; });
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await expect(upstream).resolves.toBe("late");
    await draining;
    expect(drained).toBe(true);
  });

  it("does not cancel a successor when an older generation drains", async () => {
    const operations = new TurnExternalOperations();
    const successor = { ...turn, generation: "generation-b" };
    let oldSignal!: AbortSignal;
    let nextSignal!: AbortSignal;
    const old = operations.run(turn, async (signal) => { oldSignal = signal; });
    const next = operations.run(successor, async (signal) => { nextSignal = signal; });
    await operations.cancelTurn(turn);
    await Promise.all([old, next]);
    expect(oldSignal.aborted).toBe(true);
    expect(nextSignal.aborted).toBe(false);
  });

  it("cancels every bot generation without touching another bot", async () => {
    const operations = new TurnExternalOperations();
    const other = { botId: "bot-b", threadId: "thread-b", generation: "generation-b" };
    let first!: AbortSignal;
    let second!: AbortSignal;
    await Promise.all([
      operations.run(turn, async (signal) => { first = signal; }),
      operations.run(other, async (signal) => { second = signal; }),
    ]);
    await operations.cancelBot(turn.botId);
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);
    await operations.cancelAll();
    expect(second.aborted).toBe(true);
  });
});
