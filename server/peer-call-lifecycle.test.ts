import { describe, expect, it, vi } from "vitest";

import { PeerCallLifecycle } from "./peer-call-lifecycle.ts";

describe("peer call lifecycle", () => {
  const source = { botId: "source", threadId: "source-thread", generation: "source-generation" };
  const target = { botId: "target", threadId: "target-thread", generation: "target-generation" };

  it("cancels the exact target when its source turn ends", async () => {
    const lifecycle = new PeerCallLifecycle();
    const cancelTarget = vi.fn(async () => {});
    const onCancelled = vi.fn();
    lifecycle.register({ source, target, cancelTarget, onCancelled });

    await lifecycle.cancelSource(source);
    expect(cancelTarget).toHaveBeenCalledWith(target);
    expect(onCancelled).toHaveBeenCalledOnce();
    await expect(lifecycle.cancelSource(source)).resolves.toBeUndefined();
  });

  it("does not cancel a finished target or a source successor", async () => {
    const lifecycle = new PeerCallLifecycle();
    const firstCancel = vi.fn(async () => {});
    const finished = lifecycle.register({ source, target, cancelTarget: firstCancel, onCancelled: vi.fn() });
    expect(finished.finish()).toBe(true);

    const successorCancel = vi.fn(async () => {});
    lifecycle.register({
      source: { ...source, generation: "source-successor" },
      target: { ...target, generation: "target-successor" },
      cancelTarget: successorCancel,
      onCancelled: vi.fn(),
    });
    await expect(lifecycle.cancelSource(source)).resolves.toBeUndefined();
    expect(firstCancel).not.toHaveBeenCalled();
    expect(successorCancel).not.toHaveBeenCalled();
  });

  it("timeout cancellation runs once", async () => {
    const lifecycle = new PeerCallLifecycle();
    const cancelTarget = vi.fn(async () => {});
    const onCancelled = vi.fn();
    const handle = lifecycle.register({ source, target, cancelTarget, onCancelled });
    await expect(handle.cancel()).resolves.toBe(true);
    await expect(handle.cancel()).resolves.toBe(false);
    expect(cancelTarget).toHaveBeenCalledOnce();
    expect(onCancelled).toHaveBeenCalledOnce();
  });

  it("keeps source Stop waiting for exact target shutdown and propagates failure", async () => {
    const lifecycle = new PeerCallLifecycle();
    let rejectTarget!: (error: Error) => void;
    const targetStop = new Promise<void>((_resolve, reject) => { rejectTarget = reject; });
    const onCancelled = vi.fn();
    lifecycle.register({ source, target, cancelTarget: () => targetStop, onCancelled });

    const drain = lifecycle.cancelSource(source);
    let settled = false;
    void drain.finally(() => { settled = true; }).catch(() => {});
    await Promise.resolve();
    expect(settled).toBe(false);
    rejectTarget(new Error("target still running"));
    await expect(drain).rejects.toThrow(/peer turns could not be stopped/);
    await Promise.resolve();
    expect(lifecycle.activeDrainCount()).toBe(0);
    expect(onCancelled).toHaveBeenCalledOnce();
  });

  it("releases settled drain generations", async () => {
    const lifecycle = new PeerCallLifecycle();
    for (let i = 0; i < 100; i += 1) {
      const generation = `source-generation-${i}`;
      const exactSource = { ...source, generation };
      lifecycle.register({
        source: exactSource,
        target: { ...target, generation: `target-generation-${i}` },
        cancelTarget: async () => {},
        onCancelled: vi.fn(),
      });
      await lifecycle.cancelSource(exactSource);
    }
    await Promise.resolve();
    expect(lifecycle.activeDrainCount()).toBe(0);
  });
});
