import { describe, expect, it } from "vitest";

import {
  ComputerSubagentActionBudgetError,
  ComputerSubagentManager,
  ComputerSubagentOwnershipError,
  ComputerSubagentStateError,
  ComputerSubagentTargetBusyError,
  MAX_COMPUTER_SUBAGENT_ACTIONS,
  MAX_COMPUTER_SUBAGENT_HISTORY,
  type ComputerSubagentHandle,
  type ComputerSubagentParent,
} from "./computer-subagent-manager.ts";

const parent: ComputerSubagentParent = {
  botId: "bot-a",
  threadId: "thread-a",
  turnId: "turn-a",
  generation: 4,
};

function start(manager: ComputerSubagentManager, overrides: Partial<ComputerSubagentParent> = {}) {
  return manager.start({
    parent: { ...parent, ...overrides },
    targetKey: "box:one",
    targetGeneration: "vm-generation-a",
    childId: "child-a",
  });
}

function stale(handle: ComputerSubagentHandle): ComputerSubagentHandle {
  return { childId: handle.childId, ownerToken: `${handle.ownerToken}-stale` };
}

describe("ComputerSubagentManager", () => {
  it("accepts the harness UUID generation and fences it exactly", () => {
    const manager = new ComputerSubagentManager();
    const uuidParent = { ...parent, generation: "019c-turn-generation" };
    const created = manager.start({
      parent: uuidParent,
      targetKey: "box:string-generation",
      targetGeneration: "vm-generation-a",
      childId: "child-string-generation",
    });
    manager.markRunning(created.handle);
    expect(manager.cancelParent({ ...uuidParent, generation: "019c-other-generation" })).toEqual([]);
    expect(manager.cancelParent(uuidParent)).toEqual(["child-string-generation"]);
  });

  it("atomically leases one target and binds the full parent identity", () => {
    const manager = new ComputerSubagentManager({ now: () => 100 });
    const first = start(manager);
    expect(first.record).toMatchObject({
      childId: "child-a",
      parent,
      targetKey: "box:one",
      targetGeneration: "vm-generation-a",
      status: "queued",
      actionCount: 0,
      pendingSteerCount: 0,
      leaseHeld: true,
      createdAt: 100,
    });
    expect(() => manager.start({
      parent: { ...parent, turnId: "turn-b" },
      targetKey: "box:one",
      targetGeneration: "vm-generation-b",
      childId: "child-b",
    })).toThrow(ComputerSubagentTargetBusyError);
  });

  it("enforces exactly nine actions and rejects action ten without mutation", () => {
    const manager = new ComputerSubagentManager();
    const { handle } = start(manager);
    manager.markRunning(handle);
    expect(manager.consumeActions(handle, MAX_COMPUTER_SUBAGENT_ACTIONS)).toBe(9);
    expect(() => manager.consumeActions(handle)).toThrow(ComputerSubagentActionBudgetError);
    expect(manager.get(handle.childId)?.actionCount).toBe(9);
    expect(() => manager.consumeActions(handle, 2)).toThrow(ComputerSubagentActionBudgetError);
    expect(manager.get(handle.childId)?.actionCount).toBe(9);
  });

  it("queues steer text but refuses to hand it to a successor while active", () => {
    const manager = new ComputerSubagentManager();
    const { handle } = start(manager);
    manager.markRunning(handle);
    expect(manager.queueSteer(handle, "use the other button")).toBe(1);
    expect(manager.get(handle.childId)?.pendingSteerCount).toBe(1);
    expect(() => manager.takeQueuedSteer(handle)).toThrow(ComputerSubagentStateError);
    expect(manager.get(handle.childId)?.status).toBe("running");
  });

  it("supports human pause/resume without creating an overlapping runtime", () => {
    const manager = new ComputerSubagentManager();
    const { handle } = start(manager);
    manager.markRunning(handle);
    expect(manager.markWaitingOnHuman(handle).status).toBe("waiting-on-human");
    expect(() => manager.consumeActions(handle)).toThrow(ComputerSubagentStateError);
    expect(manager.markRunningAfterHuman(handle).status).toBe("running");
    expect(manager.consumeActions(handle)).toBe(1);
  });

  it("rejects stale completion and stale release from a prior owner", () => {
    const manager = new ComputerSubagentManager();
    const { handle } = start(manager);
    manager.markRunning(handle);
    expect(() => manager.complete(stale(handle))).toThrow(ComputerSubagentOwnershipError);
    expect(() => manager.release(stale(handle))).toThrow(ComputerSubagentOwnershipError);
    expect(manager.get(handle.childId)?.status).toBe("running");
  });

  it("keeps terminal history but releases only the exact active owner", () => {
    const manager = new ComputerSubagentManager();
    const first = start(manager);
    manager.markRunning(first.handle);
    manager.complete(first.handle);
    expect(() => manager.release(stale(first.handle))).toThrow(ComputerSubagentOwnershipError);
    manager.release(first.handle);
    expect(manager.get(first.handle.childId)).toMatchObject({ status: "completed", leaseHeld: false });

    const successor = manager.start({
      parent,
      targetKey: "box:one",
      targetGeneration: "vm-generation-b",
      childId: "child-b",
    });
    expect(successor.record.childId).toBe("child-b");
    expect(() => manager.release(first.handle)).toThrow(ComputerSubagentOwnershipError);
  });

  it("cancels only active children of the exact parent generation", () => {
    const manager = new ComputerSubagentManager();
    const first = start(manager);
    manager.markRunning(first.handle);
    expect(manager.cancelParent({ ...parent, generation: 3 })).toEqual([]);
    expect(manager.get(first.handle.childId)?.status).toBe("running");
    expect(manager.cancelParent(parent)).toEqual(["child-a"]);
    expect(manager.get(first.handle.childId)).toMatchObject({ status: "aborted", leaseHeld: true });
    expect(manager.cancelParent(parent)).toEqual([]);
  });

  it("permits a queued steer only after terminal cleanup, then requires release", () => {
    const manager = new ComputerSubagentManager();
    const { handle } = start(manager);
    manager.markRunning(handle);
    manager.queueSteer(handle, "retry with keyboard navigation");
    manager.complete(handle);
    expect(manager.takeQueuedSteer(handle)).toBe("retry with keyboard navigation");
    manager.release(handle);
  });

  it("bounds released terminal history without pruning active or held records", () => {
    const manager = new ComputerSubagentManager();
    for (let index = 0; index < MAX_COMPUTER_SUBAGENT_HISTORY + 40; index += 1) {
      const started = manager.start({
        parent,
        targetKey: `vm:${index}`,
        targetGeneration: `generation-${index}`,
        childId: `history-${index}`,
      });
      manager.markRunning(started.handle);
      manager.complete(started.handle);
      manager.release(started.handle);
    }
    const active = manager.start({
      parent,
      targetKey: "vm:active",
      targetGeneration: "generation-active",
      childId: "active-record",
    });
    expect(manager.list()).toHaveLength(MAX_COMPUTER_SUBAGENT_HISTORY + 1);
    expect(manager.get("history-0")).toBeNull();
    expect(manager.get(`history-${MAX_COMPUTER_SUBAGENT_HISTORY + 39}`)).not.toBeNull();
    expect(manager.get(active.handle.childId)).toMatchObject({ status: "queued", leaseHeld: true });
  });
});
