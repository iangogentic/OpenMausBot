import { describe, expect, it, vi } from "vitest";

import {
  ActiveComputerTargets,
  ControlBridgeRegistry,
  activeTurnOwnsTarget,
  controlLeaseConflictsWithSelection,
  preferActiveControlTarget,
  recoverableRetiredBridgeIds,
  selectIdleControlSurface,
} from "./computer-control-targets.ts";

describe("computer bridge authority", () => {
  it("keeps an old bridge bound to its original target after the bot switches", () => {
    let id = 0;
    const bridges = new ControlBridgeRegistry(() => `bridge-${++id}`, () => `token-${id}`);
    const physical = bridges.register({
      botId: "b1",
      targetKey: "physical:host",
      threadId: "stable-thread",
      dispatchGeneration: "turn-a",
    });
    const vm = bridges.register({
      botId: "b1",
      targetKey: "vm:b1",
      threadId: "stable-thread",
      dispatchGeneration: "turn-b",
    });

    physical.retired = true;
    expect(bridges.get(physical.bridgeId)).toMatchObject({
      targetKey: "physical:host",
      dispatchGeneration: "turn-a",
      retired: true,
    });
    expect(bridges.get(vm.bridgeId)).toMatchObject({
      targetKey: "vm:b1",
      dispatchGeneration: "turn-b",
      retired: false,
    });
  });

  it("does not treat a new MCP child as physical cancellation proof", () => {
    let id = 0;
    const bridges = new ControlBridgeRegistry(() => `bridge-${++id}`, () => `token-${id}`);
    const old = bridges.register({
      botId: "b1",
      targetKey: "physical:host",
      threadId: "thread",
      dispatchGeneration: "turn-a",
      executorGeneration: "executor-a",
    });
    old.retired = true;
    old.closed = true;
    const sameExecutor = bridges.register({
      botId: "b1",
      targetKey: "physical:host",
      threadId: "thread",
      dispatchGeneration: "turn-b",
      executorGeneration: "executor-a",
    });
    sameExecutor.observed = true;
    expect(recoverableRetiredBridgeIds(bridges.values(), "physical:host")).toEqual([]);

    sameExecutor.retired = true;
    const restartedExecutor = bridges.register({
      botId: "b1",
      targetKey: "physical:host",
      threadId: "thread",
      dispatchGeneration: "turn-c",
      executorGeneration: "executor-b",
    });
    restartedExecutor.observed = true;
    expect(recoverableRetiredBridgeIds(bridges.values(), "physical:host")).toContain(old.bridgeId);
  });

  it("drops retired no-action bearer entries instead of leaking each completed turn", () => {
    let id = 0;
    const bridges = new ControlBridgeRegistry(() => `bridge-${++id}`, () => `token-${id}`);
    for (let turn = 0; turn < 100; turn += 1) {
      const binding = bridges.register({
        botId: "b1",
        targetKey: "vm:b1",
        threadId: "stable-thread",
        dispatchGeneration: `turn-${turn}`,
      });
      binding.retired = true;
      bridges.pruneRetiredWithoutTickets(() => false);
    }
    expect(bridges.size).toBe(0);
  });

  it("prunes clean reload bindings but preserves ticketed recovery metadata", () => {
    let id = 0;
    const bridges = new ControlBridgeRegistry(() => `bridge-${++id}`, () => `token-${id}`);
    const clean = bridges.register({
      botId: "b1",
      targetKey: "physical:host",
      threadId: "thread-a",
      dispatchGeneration: "turn-a",
    });
    const ambiguous = bridges.register({
      botId: "b1",
      targetKey: "physical:host",
      threadId: "thread-b",
      dispatchGeneration: "turn-b",
    });
    clean.retired = clean.closed = true;
    ambiguous.retired = ambiguous.closed = true;

    bridges.pruneRetiredWithoutTickets((binding) => binding.bridgeId === ambiguous.bridgeId);

    expect(bridges.get(clean.bridgeId)).toBeUndefined();
    expect(bridges.get(ambiguous.bridgeId)).toMatchObject({ retired: true, closed: true });
  });
});

describe("active computer target registry", () => {
  it("records the computer Auto actually selected, not the failed preference", () => {
    const targets = new ActiveComputerTargets(() => "generation-1");
    // A configured cloud preference failed before mounting anything; only the
    // physical fallback is selected and therefore authoritative.
    const generation = targets.select("b1", "turn-1", "physical:host");
    expect(targets.forBot("b1")).toBe("physical:host");
    targets.clearThread("turn-1", generation);
    expect(targets.forBot("b1")).toBeNull();
  });

  it("preserves the exact shared target across distinct bots", () => {
    const targets = new ActiveComputerTargets();
    targets.select("b1", "turn-1", "local-vm:shared");
    targets.select("b2", "turn-2", "local-vm:shared");
    expect(targets.forBot("b1")).toBe("local-vm:shared");
    expect(targets.forBot("b2")).toBe("local-vm:shared");
  });

  it("a stale turn completion cannot clear a newer turn's target", () => {
    let sequence = 0;
    const targets = new ActiveComputerTargets(() => `generation-${++sequence}`);
    const oldGeneration = targets.select("b1", "turn-old", "box:b1");
    targets.select("b1", "turn-new", "physical:host");
    targets.clearThread("turn-old", oldGeneration);
    expect(targets.forBot("b1")).toBe("physical:host");
    targets.clearBot("b1");
    expect(targets.forBot("b1")).toBeNull();
  });

  it("rejects a delayed clear when two turns reuse the same thread id", () => {
    let sequence = 0;
    const targets = new ActiveComputerTargets(() => `generation-${++sequence}`);
    const generationA = targets.select("b1", "stable-thread", "box:b1");
    const generationB = targets.select("b1", "stable-thread", "physical:host");

    expect(targets.clearThread("stable-thread", generationA)).toBe(false);
    expect(targets.forBot("b1")).toBe("physical:host");
    expect(targets.clearThread("stable-thread", generationB)).toBe(true);
    expect(targets.forBot("b1")).toBeNull();
  });

  it("keeps the new target when an old stall grace timer fires on the same thread", async () => {
    vi.useFakeTimers();
    try {
      let sequence = 0;
      const targets = new ActiveComputerTargets(() => `generation-${++sequence}`);
      const stalledGeneration = targets.select("b1", "stable-thread", "box:b1");
      setTimeout(() => targets.clearThread("stable-thread", stalledGeneration), 6_000);

      targets.select("b1", "stable-thread", "physical:host");
      await vi.advanceTimersByTimeAsync(6_000);
      expect(targets.forBot("b1")).toBe("physical:host");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("idle Auto control surface", () => {
  it("does not mistake a configured-but-unready cloud for the physical fallback on screen", () => {
    expect(selectIdleControlSurface({
      assignment: undefined,
      physicalReady: true,
      cloudReady: false,
    })).toBe("physical");
    expect(selectIdleControlSurface({
      assignment: undefined,
      requested: "cloud",
      physicalReady: true,
      cloudReady: false,
    })).toBeNull();
  });

  it("honors a ready cloud surface only when the panel explicitly resolves it", () => {
    expect(selectIdleControlSurface({
      assignment: undefined,
      requested: "cloud",
      physicalReady: true,
      cloudReady: true,
    })).toBe("cloud");
  });
});

describe("active target lifecycle fence", () => {
  it("blocks only the exact computer a turn actually mounted", () => {
    expect(activeTurnOwnsTarget("box:b1", "box:b1")).toBe(true);
    expect(activeTurnOwnsTarget("physical:host", "box:b1")).toBe(false);
    expect(activeTurnOwnsTarget(null, "box:b1")).toBe(false);
  });

  it("rejects selecting a different target while the bot owns a lease", () => {
    expect(controlLeaseConflictsWithSelection("physical:host", "vps:razer:b1")).toBe(true);
    expect(controlLeaseConflictsWithSelection("physical:host", "physical:host")).toBe(false);
    expect(controlLeaseConflictsWithSelection(null, "vps:razer:b1")).toBe(false);
  });

  it("prefers the active target over a stale different lease", () => {
    expect(preferActiveControlTarget("vps:razer:b1", "physical:host")).toBe("vps:razer:b1");
    expect(preferActiveControlTarget(null, "physical:host")).toBe("physical:host");
  });
});
