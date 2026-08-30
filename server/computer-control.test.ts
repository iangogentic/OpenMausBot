import { describe, expect, it, vi } from "vitest";

import { ComputerControl, type ControlSnapshot, type LeaseBinding } from "./computer-control.ts";

const BRIDGE_A = "bridge-a";
const BRIDGE_B = "bridge-b";

const empty = (): ControlSnapshot => ({
  held: false,
  helpReason: null,
  heldSinceMs: null,
  leaseExpiresAtMs: null,
});

function deterministic(options: { now?: () => number; leaseTtlMs?: number; drainTimeoutMs?: number } = {}) {
  let sequence = 0;
  const changes: Array<{ botId: string; snapshot: ControlSnapshot }> = [];
  const control = new ComputerControl(
    (botId, snapshot) => changes.push({ botId, snapshot }),
    options.now ?? Date.now,
    {
      leaseTtlMs: options.leaseTtlMs,
      drainTimeoutMs: options.drainTimeoutMs,
      tokenFactory: () => String(++sequence),
    },
  );
  return { control, changes };
}

async function take(control: ComputerControl, botId = "b1", targetKey = "vm:b1", ownerId = "renderer-a") {
  const result = await control.takeLease({ botId, targetKey, ownerId });
  if (!result.ok) throw new Error(`take failed: ${result.reason}`);
  return {
    result,
    binding: { botId, targetKey, ownerId, leaseToken: result.leaseToken } satisfies LeaseBinding,
  };
}

describe("computer control lease", () => {
  it("starts disengaged for an unknown bot", () => {
    const { control } = deterministic();
    expect(control.snapshot("b1", "vm:b1")).toEqual(empty());
    control.dispose();
  });

  it("mints an owner-scoped secret and only that owner may heartbeat or release", async () => {
    let clock = 1_000;
    const { control, changes } = deterministic({ now: () => clock, leaseTtlMs: 500 });
    const { result, binding } = await take(control);
    expect(result.snapshot).toEqual({
      held: true,
      helpReason: null,
      heldSinceMs: 1_000,
      leaseExpiresAtMs: 1_500,
    });
    expect(result.leaseToken).not.toContain("renderer-a");

    clock = 1_200;
    expect(control.heartbeatLease({ ...binding, ownerId: "renderer-b" }).ok).toBe(false);
    expect(control.releaseLease({ ...binding, leaseToken: "lease_wrong" }).ok).toBe(false);
    expect(control.snapshot("b1", "vm:b1").held).toBe(true);

    const heartbeat = control.heartbeatLease(binding);
    expect(heartbeat.ok && heartbeat.snapshot.leaseExpiresAtMs).toBe(1_700);
    expect(control.releaseLease(binding).ok).toBe(true);
    expect(control.snapshot("b1", "vm:b1")).toEqual(empty());
    expect(changes.map((change) => change.snapshot.held)).toEqual([true, false]);
    control.dispose();
  });

  it("expires a lease when its renderer stops heartbeating and revokes viewers", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const { control } = deterministic({ leaseTtlMs: 1_000 });
      const revoked = vi.fn();
      control.onRevoked(revoked);
      const { binding } = await take(control);
      expect(control.authorizeLease(binding)).toBe(true);

      await vi.advanceTimersByTimeAsync(1_001);
      expect(control.snapshot("b1", "vm:b1").held).toBe(false);
      expect(control.authorizeLease(binding)).toBe(false);
      expect(revoked).toHaveBeenCalledWith(expect.objectContaining({ ...binding, reason: "expired" }));
      control.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("revokes only the exact paired-device owner across its targets", async () => {
    const { control } = deterministic();
    const first = await take(control, "b1", "box:b1", "companion:phone-1");
    const second = await take(control, "b2", "box:b2", "companion:phone-2");
    const revoked = vi.fn();
    control.onRevoked(revoked);

    expect(control.revokeLeasesForOwner("companion:phone-1")).toBe(1);
    expect(control.authorizeLease(first.binding)).toBe(false);
    expect(control.authorizeLease(second.binding)).toBe(true);
    expect(revoked).toHaveBeenCalledWith(expect.objectContaining({
      botId: "b1",
      ownerId: "companion:phone-1",
      reason: "forgotten",
    }));
    control.releaseLease(second.binding);
    control.dispose();
  });

  it("enforces one human driver per physical target even across bots", async () => {
    const { control, changes } = deterministic();
    // Register both bots as viewers of the shared target so both receive the
    // target-scoped state change.
    control.snapshot("b1", "vm:shared");
    control.snapshot("b2", "vm:shared");
    const first = await take(control, "b1", "vm:shared", "renderer-a");
    const conflict = await control.takeLease({ botId: "b2", targetKey: "vm:shared", ownerId: "renderer-b" });
    expect(conflict).toMatchObject({ ok: false, reason: "held", snapshot: { held: true } });
    expect(control.snapshot("b2", "vm:shared").held).toBe(true);
    expect(changes.slice(-2).map((change) => change.botId).sort()).toEqual(["b1", "b2"]);
    control.releaseLease(first.binding);
    control.dispose();
  });

  it("reports both a draining takeover and a live lease as reserved for human control", async () => {
    const { control } = deterministic({ drainTimeoutMs: 1_000 });
    const action = control.beginAction("b1", "vm:shared", BRIDGE_A);
    expect(action.allowed).toBe(true);
    if (!action.allowed) throw new Error("action unexpectedly refused");
    const takeover = control.takeLease({ botId: "b2", targetKey: "vm:shared", ownerId: "renderer-b" });
    await Promise.resolve();
    expect(control.targetReservedForHuman("vm:shared")).toBe(true);
    control.endAction("b1", "vm:shared", BRIDGE_A, action.actionId);
    const result = await takeover;
    expect(result.ok).toBe(true);
    expect(control.targetReservedForHuman("vm:shared")).toBe(true);
    if (result.ok) {
      control.releaseLease({ botId: "b2", targetKey: "vm:shared", ownerId: "renderer-b", leaseToken: result.leaseToken });
    }
    expect(control.targetReservedForHuman("vm:shared")).toBe(false);
    control.dispose();
  });

  it("fences new actions, drains an in-flight action, and only then reports control", async () => {
    const { control } = deterministic({ drainTimeoutMs: 1_000 });
    const action = control.beginAction("b1", "vm:shared", BRIDGE_A);
    expect(action.allowed).toBe(true);
    if (!action.allowed) throw new Error("action unexpectedly refused");

    let settled = false;
    const takeover = control
      .takeLease({ botId: "b1", targetKey: "vm:shared", ownerId: "renderer-a" })
      .then((result) => {
        settled = true;
        return result;
      });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(control.beginAction("b2", "vm:shared", BRIDGE_B)).toEqual({
      allowed: false,
      reason: "takeover-pending",
    });

    expect(control.endAction("b1", "vm:shared", BRIDGE_A, action.actionId)).toBe(true);
    const result = await takeover;
    expect(result).toMatchObject({ ok: true, snapshot: { held: true } });
    control.dispose();
  });

  it("authorizes only the exact live, non-quarantined action proof", () => {
    const { control } = deterministic();
    const action = control.beginAction("b1", "box:b1", BRIDGE_A);
    if (!action.allowed) throw new Error("action unexpectedly refused");
    expect(control.authorizeAction("b1", "box:b1", BRIDGE_A, action.actionId)).toBe(true);
    expect(control.authorizeAction("b1", "box:b1", BRIDGE_B, action.actionId)).toBe(false);
    expect(control.authorizeAction("b2", "box:b1", BRIDGE_A, action.actionId)).toBe(false);
    expect(control.authorizeAction("b1", "box:b1", BRIDGE_A, "action_stale")).toBe(false);
    expect(control.quarantineActionsForBridge("b1", "box:b1", BRIDGE_A)).toBe(1);
    expect(control.authorizeAction("b1", "box:b1", BRIDGE_A, action.actionId)).toBe(false);
    control.dispose();
  });

  it("does not falsely grant control when a forwarded action will not drain", async () => {
    vi.useFakeTimers();
    try {
      const { control } = deterministic({ drainTimeoutMs: 500 });
      const active = control.beginAction("b1", "vm:b1", BRIDGE_A);
      expect(active.allowed).toBe(true);
      if (!active.allowed) throw new Error("action unexpectedly refused");
      const takeover = control.takeLease({ botId: "b1", targetKey: "vm:b1", ownerId: "renderer-a" });
      await vi.advanceTimersByTimeAsync(501);
      await expect(takeover).resolves.toMatchObject({
        ok: false,
        reason: "actions-busy",
        snapshot: { held: false },
      });
      // The takeover fence is gone, but the still-live input remains the one
      // action allowed on this desktop until its exact result settles.
      expect(control.beginAction("b1", "vm:b1", BRIDGE_A)).toEqual({
        allowed: false,
        reason: "action-active",
      });
      expect(control.endAction("b1", "vm:b1", BRIDGE_A, active.actionId)).toBe(true);
      expect(control.beginAction("b1", "vm:b1", BRIDGE_A).allowed).toBe(true);
      control.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("revalidates target authority after draining before minting a lease", async () => {
    const { control } = deterministic();
    const action = control.beginAction("b1", "box:b1", BRIDGE_A);
    if (!action.allowed) throw new Error("action unexpectedly refused");
    let authoritative = true;
    const takeover = control.takeLease({
      botId: "b1",
      targetKey: "box:b1",
      ownerId: "renderer-a",
      stillAuthoritative: () => authoritative,
    });
    authoritative = false;
    expect(control.endAction("b1", "box:b1", BRIDGE_A, action.actionId)).toBe(true);

    await expect(takeover).resolves.toMatchObject({
      ok: false,
      reason: "target-changed",
      snapshot: { held: false },
    });
    expect(control.snapshot("b1", "box:b1").held).toBe(false);
    expect(control.targetBusy("box:b1")).toEqual({ busy: false, reason: null });
    control.dispose();
  });

  it("fails closed when the initial target authority check throws", async () => {
    const { control } = deterministic();
    await expect(control.takeLease({
      botId: "b1",
      targetKey: "physical:host",
      ownerId: "renderer-a",
      stillAuthoritative: () => {
        throw new Error("routing state unavailable");
      },
    })).resolves.toMatchObject({ ok: false, reason: "target-changed", snapshot: { held: false } });
    expect(control.targetBusy("physical:host")).toEqual({ busy: false, reason: null });
    control.dispose();
  });

  it("blocks lifecycle teardown for holds, pending takeovers, and active actions", async () => {
    const { control } = deterministic();
    const action = control.beginAction("b1", "vm:b1", BRIDGE_A);
    expect(control.targetBusy("vm:b1")).toEqual({ busy: true, reason: "actions-active" });
    if (!action.allowed) throw new Error("action unexpectedly refused");
    const takeover = control.takeLease({ botId: "b1", targetKey: "vm:b1", ownerId: "renderer-a" });
    expect(control.targetBusy("vm:b1")).toEqual({ busy: true, reason: "takeover-pending" });
    control.endAction("b1", "vm:b1", BRIDGE_A, action.actionId);
    const result = await takeover;
    expect(result.ok).toBe(true);
    expect(control.targetBusy("vm:b1")).toEqual({ busy: true, reason: "held" });
    if (result.ok) {
      control.releaseLease({
        botId: "b1",
        targetKey: "vm:b1",
        ownerId: "renderer-a",
        leaseToken: result.leaseToken,
      });
    }
    expect(control.targetBusy("vm:b1")).toEqual({ busy: false, reason: null });
    control.dispose();
  });

  it("serializes a shared target across bots and bridges, then honors exact completion", () => {
    const { control } = deterministic();
    const actionA = control.beginAction("b1", "vm:shared", BRIDGE_A);
    if (!actionA.allowed) throw new Error("action unexpectedly refused");
    expect(control.beginAction("b1", "vm:shared", BRIDGE_B)).toEqual({
      allowed: false,
      reason: "action-active",
    });
    expect(control.beginAction("b2", "vm:shared", "bridge-c")).toEqual({
      allowed: false,
      reason: "action-active",
    });
    expect(control.endAction("b1", "vm:shared", BRIDGE_B, actionA.actionId)).toBe(false);
    expect(control.endAction("b1", "vm:shared", BRIDGE_A, actionA.actionId)).toBe(true);
    expect(control.endAction("b1", "vm:shared", BRIDGE_A, actionA.actionId)).toBe(false);
    const actionB = control.beginAction("b1", "vm:shared", BRIDGE_B);
    if (!actionB.allowed) throw new Error("sequential action unexpectedly refused");
    expect(control.beginAction("b2", "vm:shared", "bridge-c")).toEqual({
      allowed: false,
      reason: "action-active",
    });
    expect(control.endAction("b1", "vm:shared", BRIDGE_B, actionB.actionId)).toBe(true);
    const actionC = control.beginAction("b2", "vm:shared", "bridge-c");
    if (!actionC.allowed) throw new Error("next bot action unexpectedly refused");
    expect(control.endAction("b2", "vm:shared", "bridge-c", actionC.actionId)).toBe(true);
    expect(control.targetBusy("vm:shared")).toEqual({ busy: false, reason: null });
    control.dispose();
  });

  it("fences both lifecycle interleavings on the exact target", async () => {
    const { control } = deterministic();
    const held = await take(control);
    expect(control.beginLifecycleMutation("vm:b1")).toEqual({ allowed: false, reason: "held" });
    control.releaseLease(held.binding);

    const lifecycle = control.beginLifecycleMutation("vm:b1");
    expect(lifecycle.allowed).toBe(true);
    if (!lifecycle.allowed) throw new Error("lifecycle unexpectedly refused");
    expect(control.targetBusy("vm:b1")).toEqual({ busy: true, reason: "lifecycle-active" });
    expect(control.beginAction("b1", "vm:b1", BRIDGE_A)).toEqual({
      allowed: false,
      reason: "lifecycle-active",
    });
    await expect(control.takeLease({ botId: "b1", targetKey: "vm:b1", ownerId: "renderer-b" })).resolves.toMatchObject({
      ok: false,
      reason: "lifecycle-active",
      snapshot: { held: false },
    });
    expect(control.endLifecycleMutation("vm:b1", "lifecycle_stale")).toBe(false);
    expect(control.endLifecycleMutation("vm:b1", lifecycle.lifecycleId)).toBe(true);
    expect((await take(control, "b1", "vm:b1", "renderer-b")).result.ok).toBe(true);
    control.dispose();
  });

  it("fences every bot while physical approval waits for an older action to drain", async () => {
    let token = 0;
    const control = new ComputerControl(() => {}, Date.now, { tokenFactory: () => `token-${++token}` });
    const action = control.beginAction("bot-a", "physical:host", "bridge-a");
    if (!action.allowed) throw new Error("action unexpectedly refused");

    const approval = control.beginLifecycleMutationAfterDrain("physical:host", 1_000);
    expect(control.beginAction("bot-b", "physical:host", "bridge-b")).toEqual({
      allowed: false,
      reason: "lifecycle-active",
    });
    expect(control.endAction("bot-a", "physical:host", "bridge-a", action.actionId)).toBe(true);

    const fence = await approval;
    if (!fence.allowed) throw new Error("approval fence unexpectedly refused");
    expect(control.beginAction("bot-b", "physical:host", "bridge-b")).toEqual({
      allowed: false,
      reason: "lifecycle-active",
    });
    expect(control.endLifecycleMutation("physical:host", fence.lifecycleId)).toBe(true);
    expect(control.beginAction("bot-b", "physical:host", "bridge-b").allowed).toBe(true);
    control.dispose();
  });

  it("keeps transport-death actions fenced until a verified target reset", async () => {
    const { control } = deterministic();
    const action = control.beginAction("b1", "box:b1", BRIDGE_A);
    if (!action.allowed) throw new Error("action unexpectedly refused");
    expect(control.quarantineActionsForBridge("b1", "box:b1", "wrong-bridge")).toBe(0);
    expect(control.quarantineActionsForBridge("b1", "box:b1", BRIDGE_A)).toBe(1);
    expect(control.targetBusy("box:b1")).toEqual({ busy: true, reason: "actions-active" });
    expect(control.beginLifecycleMutation("box:b1")).toEqual({ allowed: false, reason: "actions-active" });

    const reset = control.beginTargetReset("box:b1");
    expect(reset.allowed).toBe(true);
    if (!reset.allowed) throw new Error("verified reset unexpectedly refused");
    expect(control.beginAction("b1", "box:b1", BRIDGE_B)).toEqual({
      allowed: false,
      reason: "lifecycle-active",
    });
    expect(control.completeTargetReset("box:b1", reset.lifecycleId)).toBe(true);
    expect(control.targetBusy("box:b1")).toEqual({ busy: false, reason: null });
    expect((await control.takeLease({ botId: "b1", targetKey: "box:b1", ownerId: "renderer-a" })).ok).toBe(true);
    control.dispose();
  });

  it("never lets a reset clear a still-live action", () => {
    const { control } = deterministic();
    const live = control.beginAction("b1", "vm:b1", BRIDGE_A);
    if (!live.allowed) throw new Error("action unexpectedly refused");
    expect(control.beginTargetReset("vm:b1")).toEqual({ allowed: false, reason: "actions-active" });
    expect(control.targetBusy("vm:b1")).toEqual({ busy: true, reason: "actions-active" });
    expect(control.endAction("b1", "vm:b1", BRIDGE_A, live.actionId)).toBe(true);
    expect(control.targetBusy("vm:b1")).toEqual({ busy: false, reason: null });
    control.dispose();
  });

  it("physical bridge recovery clears only a confirmed retired bridge generation", async () => {
    const { control } = deterministic({ drainTimeoutMs: 1 });
    const retired = control.beginAction("b1", "physical:host", BRIDGE_A);
    if (!retired.allowed) throw new Error("action unexpectedly refused");
    expect(control.beginAction("b2", "physical:host", BRIDGE_B)).toEqual({
      allowed: false,
      reason: "action-active",
    });
    control.quarantineActionsForBridge("b1", "physical:host", BRIDGE_A);

    expect(control.recoverQuarantinedActionsForBridges("physical:host", ["unproved-bridge"])).toBe(0);
    expect(control.targetBusy("physical:host")).toEqual({ busy: true, reason: "actions-active" });
    expect(control.recoverQuarantinedActionsForBridges("physical:host", [BRIDGE_A])).toBe(1);
    const live = control.beginAction("b2", "physical:host", BRIDGE_B);
    if (!live.allowed) throw new Error("post-recovery action unexpectedly refused");
    // A repeated/stale recovery is not authority to erase the new live call.
    expect(control.recoverQuarantinedActionsForBridges("physical:host", [BRIDGE_A])).toBe(0);
    expect(control.targetBusy("physical:host")).toEqual({ busy: true, reason: "actions-active" });
    expect(control.endAction("b2", "physical:host", BRIDGE_B, live.actionId)).toBe(true);
    expect((await control.takeLease({
      botId: "b1",
      targetKey: "physical:host",
      ownerId: "renderer-a",
    })).ok).toBe(true);
    control.dispose();
  });

  it("keeps quarantine fenced when reset verification fails", async () => {
    const { control } = deterministic();
    const action = control.beginAction("b1", "box:b1", BRIDGE_A);
    if (!action.allowed) throw new Error("action unexpectedly refused");
    control.quarantineActionsForBridge("b1", "box:b1", BRIDGE_A);
    const reset = control.beginTargetReset("box:b1");
    if (!reset.allowed) throw new Error("reset unexpectedly refused");
    // The provider returned 500/timed out: unwind only the lifecycle claim,
    // never call completeTargetReset.
    expect(control.endLifecycleMutation("box:b1", reset.lifecycleId)).toBe(true);
    expect(control.targetBusy("box:b1")).toEqual({ busy: true, reason: "actions-active" });
    await expect(control.takeLease({
      botId: "b1",
      targetKey: "box:b1",
      ownerId: "renderer-a",
      drainTimeoutMs: 1,
    })).resolves.toMatchObject({ ok: false, reason: "actions-busy" });
    control.dispose();
  });
});

describe("computer control help", () => {
  it("emits exactly one change for a newly opened help request", () => {
    const { control, changes } = deterministic();
    control.requestHelpLease("b1", "please take over", "vm:b1");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      botId: "b1",
      snapshot: { held: false, helpReason: "please take over" },
    });
    control.dispose();
  });

  it("surfaces, truncates, preserves, dismisses, and expires only the owning plea", () => {
    const { control } = deterministic();
    const first = control.requestHelpLease("b1", `  ${"x".repeat(400)}  `, "vm:b1");
    expect(first.snapshot.held).toBe(false);
    expect(first.snapshot.helpReason).toHaveLength(280);
    expect(control.requestHelp("b1", "second", "vm:b1").helpReason).toBe(first.snapshot.helpReason);
    expect(control.expireHelp("b1", "older", "vm:b1").helpReason).not.toBeNull();
    expect(control.expireHelp("b1", first.requestId, "vm:b1").helpReason).toBeNull();
    expect(control.requestHelp("b1", undefined, "vm:b1").helpReason).toBe("the bot asked you to take over");
    expect(control.dismissHelp("b1", "vm:b1").helpReason).toBeNull();
    control.dispose();
  });

  it("release settles the help request in the same state change", async () => {
    const { control } = deterministic();
    control.requestHelp("b1", "stuck", "vm:b1");
    const { binding } = await take(control);
    expect(control.releaseLease(binding)).toEqual({ ok: true, snapshot: empty() });
    control.dispose();
  });

  it("a hand-back through another bot settles every waiter on the shared target", async () => {
    const { control } = deterministic();
    const shared = "vm:shared";
    const request = control.requestHelpLease("b1", "please sign in", shared);
    // B's panel is the one the person opened, but it is the same computer.
    const taken = await control.takeLease({ botId: "b2", targetKey: shared, ownerId: "renderer-b" });
    expect(taken.ok).toBe(true);
    if (!taken.ok) throw new Error("take unexpectedly failed");
    expect(control.snapshot("b1", shared).helpReason).toBe(request.snapshot.helpReason);

    control.releaseLease({
      botId: "b2",
      targetKey: shared,
      ownerId: "renderer-b",
      leaseToken: taken.leaseToken,
    });
    expect(control.snapshot("b1", shared)).toEqual(empty());
    expect(control.snapshot("b2", shared)).toEqual(empty());
    control.dispose();
  });

  it("forget revokes the deleted bot's lease and emits an empty state", async () => {
    const { control, changes } = deterministic();
    await take(control);
    control.forget("b1");
    expect(control.snapshot("b1", "vm:b1")).toEqual(empty());
    expect(changes.at(-1)?.snapshot).toEqual(empty());
    control.dispose();
  });
});
