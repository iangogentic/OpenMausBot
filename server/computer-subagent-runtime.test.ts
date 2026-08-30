import { describe, expect, it, vi } from "vitest";

import type { ComputerChildMonitor } from "../shared/computer-child-monitor.ts";
import { ComputerSubagentManager, type ComputerSubagentParent } from "./computer-subagent-manager.ts";
import {
  ComputerSubagentRuntime,
  type ComputerSubagentCapabilityDescriptor,
  type ComputerSubagentFinalScreenshot,
  type ComputerSubagentProviderChild,
  type ComputerSubagentProviderLaunchInput,
  type ComputerSubagentProviderOutcome,
} from "./computer-subagent-runtime.ts";

const parent: ComputerSubagentParent = {
  botId: "bot-a",
  threadId: "thread-a",
  turnId: "turn-a",
  generation: 1,
};

const target: ComputerSubagentCapabilityDescriptor = {
  targetKey: "box:one",
  targetGeneration: "vm-generation-a",
  boxId: "box-one",
  opaqueCapability: { kind: "scoped-box", token: "opaque-capability" },
};

const screenshot = {
  mimeType: "image/jpeg" as const,
  dataBase64: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]).toString("base64"),
  byteLength: 8,
  width: 2,
  height: 2,
  sha256: "pixel-sha",
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error | string) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error | string) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeChild extends ComputerSubagentProviderChild {
  completionControl: ReturnType<typeof deferred<ComputerSubagentProviderOutcome>>;
  cleanupControl: ReturnType<typeof deferred<void>>;
  interrupted: boolean;
}

function fakeChild(): FakeChild {
  const completionControl = deferred<ComputerSubagentProviderOutcome>();
  const cleanupControl = deferred<void>();
  const child: FakeChild = {
    completion: completionControl.promise,
    waitForTerminal: () => cleanupControl.promise,
    interrupt: async () => { child.interrupted = true; },
    completionControl,
    cleanupControl,
    interrupted: false,
  };
  return child;
}

function harness(overrides: {
  isParentCurrent?: (parent: ComputerSubagentParent) => boolean | Promise<boolean>;
  quarantineChild?: () => void | Promise<void>;
  captureFinalScreenshot?: (signal: AbortSignal) => Promise<ComputerSubagentFinalScreenshot>;
  acquireTarget?: (childId: string) => Promise<ComputerSubagentCapabilityDescriptor>;
} = {}) {
  const manager = new ComputerSubagentManager();
  const launched: ComputerSubagentProviderLaunchInput[] = [];
  const children: FakeChild[] = [];
  const completions: Array<{ status: string; finalScreenshotCaptured: boolean; childId: string }> = [];
  const screenshots: string[] = [];
  const acquired: string[] = [];
  const released: string[] = [];
  const events: string[] = [];
  const monitors: ComputerChildMonitor[] = [];
  const runtime = new ComputerSubagentRuntime({
    manager,
    provider: {
      launch: async (input) => {
        launched.push(input);
        const child = fakeChild();
        children.push(child);
        return child;
      },
    },
    acquireTarget: async (handle) => {
      acquired.push(handle.childId);
      if (overrides.acquireTarget) return overrides.acquireTarget(handle.childId);
      return { ...target, opaqueCapability: { childId: handle.childId, nonce: acquired.length } };
    },
    releaseTarget: async (childId) => { released.push(childId); },
    captureFinalScreenshot: async ({ childId, signal }) => { screenshots.push(childId); events.push("screenshot"); return overrides.captureFinalScreenshot ? overrides.captureFinalScreenshot(signal) : screenshot; },
    isParentCurrent: overrides.isParentCurrent ?? (() => true),
    quarantineChild: overrides.quarantineChild ?? (async () => undefined),
    operationTimeoutMs: 500,
    abortGraceMs: 5,
    cleanupTimeoutMs: 50,
    onComplete: (completion) => {
      events.push("complete");
      completions.push({
        status: completion.status,
        finalScreenshotCaptured: completion.finalScreenshotCaptured,
        childId: completion.childId,
      });
    },
    onFinalScreenshot: ({ childId, screenshot: final }) => {
      events.push("final-frame");
      expect(childId).toBeTruthy();
      expect(final).toEqual(screenshot);
    },
    onMonitorChange: (monitor) => { monitors.push(monitor); },
  });
  return { manager, launched, children, completions, screenshots, acquired, released, events, monitors, runtime };
}

async function waitForChild(children: FakeChild[], index = 0): Promise<FakeChild> {
  await vi.waitFor(() => expect(children.length).toBeGreaterThan(index));
  return children[index]!;
}

async function settle(child: FakeChild, outcome: ComputerSubagentProviderOutcome): Promise<void> {
  child.completionControl.resolve(outcome);
  child.cleanupControl.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("ComputerSubagentRuntime", () => {
  it("publishes authority-free snapshots for queued, running, human handoff, terminal, and release", async () => {
    const h = harness();
    const monitorParent = { ...parent, generation: "secret-parent-fence" };
    const handle = h.runtime.start({
      parent: monitorParent,
      target,
      operatorModel: { instanceId: "secret-provider-instance", model: "secret-provider-model" },
      prompt: "secret tool argument",
      childId: "child-monitor",
    });
    await waitForChild(h.children);
    expect(h.monitors.map((monitor) => [monitor.status, monitor.leaseHeld])).toEqual([
      ["queued", true],
      ["running", true],
    ]);

    const waiting = await h.runtime.markWaitingOnHuman(handle, monitorParent);
    expect(waiting).toMatchObject({ status: "waiting-on-human", leaseHeld: true });
    expect(() => h.runtime.accountActions(handle)).toThrow("not accepting computer actions");
    const resumed = await h.runtime.resumeAfterHuman(handle, monitorParent);
    expect(resumed).toMatchObject({ status: "running", leaseHeld: true });
    expect(h.runtime.accountActions(handle)).toBe(1);

    await settle(h.children[0]!, { status: "completed", output: "private provider output" });
    await handle.done;
    expect(h.monitors.map((monitor) => [monitor.status, monitor.leaseHeld])).toEqual([
      ["queued", true],
      ["running", true],
      ["waiting-on-human", true],
      ["running", true],
      ["running", true],
      ["completed", true],
      ["completed", false],
    ]);
    const projection = JSON.stringify(h.monitors);
    expect(projection).not.toContain("secret-provider-instance");
    expect(projection).not.toContain("secret-provider-model");
    expect(projection).not.toContain("secret tool argument");
    expect(projection).not.toContain("private provider output");
    expect(projection).not.toContain("opaque-capability");
    expect(projection).not.toContain("secret-parent-fence");
    expect(projection).not.toContain(target.targetKey);
    expect(projection).not.toContain(target.targetGeneration);
    expect(Object.keys(h.monitors.at(-1)!).sort()).toEqual([
      "actionCount",
      "actionLimit",
      "childId",
      "createdAt",
      "finishedAt",
      "leaseHeld",
      "parent",
      "status",
    ]);
  });

  it("fences human handoff wrappers by owner token and exact current parent", async () => {
    let parentIsCurrent = true;
    const h = harness({ isParentCurrent: () => parentIsCurrent });
    const handle = h.runtime.start({
      parent,
      target,
      operatorModel: { instanceId: "qwen", model: "vision" },
      prompt: "work",
      childId: "child-human-fence",
    });
    await waitForChild(h.children);
    const before = h.monitors.length;
    await expect(h.runtime.markWaitingOnHuman(
      { ...handle, ownerToken: "wrong-owner" },
      parent,
    )).rejects.toThrow("owner is stale or invalid");
    await expect(h.runtime.markWaitingOnHuman(handle, { ...parent, turnId: "wrong-turn" }))
      .rejects.toThrow("owner is stale or invalid");
    parentIsCurrent = false;
    await expect(h.runtime.markWaitingOnHuman(handle, parent)).rejects.toThrow("owner is stale or invalid");
    expect(h.monitors).toHaveLength(before);
    expect(h.manager.get(handle.childId)?.status).toBe("running");
    parentIsCurrent = true;
    await h.runtime.markWaitingOnHuman(handle, parent);
    await expect(h.runtime.resumeAfterHuman(handle, parent, () => false))
      .rejects.toThrow("cannot resume while human control is reserved");
    expect(h.manager.get(handle.childId)?.status).toBe("waiting-on-human");
    await expect(h.runtime.resumeAfterHuman(handle, { ...parent, generation: 2 }))
      .rejects.toThrow("owner is stale or invalid");
    expect(h.manager.get(handle.childId)?.status).toBe("waiting-on-human");
    await h.runtime.resumeAfterHuman(handle, parent);
    await settle(h.children[0]!, { status: "completed" });
    await handle.done;
  });

  it("keeps actions paused when human control begins during target acquisition", async () => {
    const acquisition = deferred<ComputerSubagentCapabilityDescriptor>();
    const h = harness({ acquireTarget: () => acquisition.promise });
    const handle = h.runtime.start({
      parent,
      target,
      operatorModel: { instanceId: "qwen", model: "vision" },
      prompt: "work",
      childId: "child-pause-during-acquire",
    });
    await h.runtime.markWaitingOnHuman(handle, parent);
    acquisition.resolve(target);
    await waitForChild(h.children);
    expect(() => h.runtime.accountActions(handle)).toThrow("not accepting computer actions");
    await h.runtime.resumeAfterHuman(handle, parent);
    expect(h.runtime.accountActions(handle)).toBe(1);
    await settle(h.children[0]!, { status: "completed" });
    await handle.done;
  });

  it("launches the exact Qwen operator model with the opaque selected target", async () => {
    const h = harness();
    const handle = h.runtime.start({
      parent,
      target,
      operatorModel: { instanceId: "desktop2-qwen", model: "qwen-vision-27b" },
      prompt: "Click the save button",
      childId: "child-qwen",
    });
    await waitForChild(h.children);
    expect(h.launched[0]).toMatchObject({
      childId: "child-qwen",
      parent,
      model: { instanceId: "desktop2-qwen", model: "qwen-vision-27b" },
      prompt: "Click the save button",
      target: expect.objectContaining({ targetKey: target.targetKey, targetGeneration: target.targetGeneration }),
    });
    expect(h.launched[0]).not.toHaveProperty("apiKey");
    await settle(h.children[0]!, { status: "completed", output: "saved" });
    await handle.done;
    expect(h.screenshots).toEqual(["child-qwen"]);
    expect(h.events).toEqual(["screenshot", "final-frame", "complete"]);
    expect(h.completions).toEqual([{ status: "completed", finalScreenshotCaptured: true, childId: "child-qwen" }]);
    expect((await handle.done)?.finalScreenshot).toEqual(screenshot);
    expect(h.acquired).toEqual(["child-qwen"]);
    expect(h.released).toEqual(["child-qwen"]);
  });

  it("routes action accounting to the manager and rejects action ten", async () => {
    const h = harness();
    const handle = h.runtime.start({
      parent,
      target,
      operatorModel: { instanceId: "qwen", model: "vision" },
      prompt: "work",
      childId: "child-budget",
    });
    await waitForChild(h.children);
    expect(h.launched[0]).not.toHaveProperty("onActions");
    expect(h.runtime.accountActions(handle, 9)).toBe(9);
    expect(h.monitors.at(-1)).toMatchObject({ status: "running", actionCount: 9, actionLimit: 9 });
    expect(() => h.runtime.accountActions(handle)).toThrow("action budget exceeded");
    expect(h.manager.get(handle.childId)?.actionCount).toBe(9);
    await settle(h.children[0]!, { status: "completed" });
    await handle.done;
  });

  it("waits for terminal cleanup before releasing the lease on abort", async () => {
    const h = harness();
    const handle = h.runtime.start({
      parent,
      target,
      operatorModel: { instanceId: "qwen", model: "vision" },
      prompt: "work",
      childId: "child-abort",
    });
    await waitForChild(h.children);
    const abort = h.runtime.abort(handle);
    await vi.waitFor(() => expect(h.children[0]!.interrupted).toBe(true));
    expect(h.manager.get(handle.childId)?.leaseHeld).toBe(true);
    let finished = false;
    void abort.then(() => { finished = true; });
    await waitForChild(h.children);
    expect(finished).toBe(false);
    h.children[0]!.completionControl.resolve({ status: "aborted", reason: "stop" });
    await waitForChild(h.children);
    expect(h.manager.get(handle.childId)?.leaseHeld).toBe(true);
    h.children[0]!.cleanupControl.resolve();
    const completion = await abort;
    expect(completion?.status).toBe("aborted");
    expect(h.manager.get(handle.childId)?.leaseHeld).toBe(false);
    expect(h.completions).toHaveLength(1);
  });

  it("interrupts a child that arrives after abort during pending provider launch", async () => {
    const manager = new ComputerSubagentManager();
    const launchControl = deferred<ComputerSubagentProviderChild>();
    const launchStarted = deferred<void>();
    const child = fakeChild();
    const releases: string[] = [];
    const callbacks: string[] = [];
    const runtime = new ComputerSubagentRuntime({
      manager,
      provider: { launch: async () => { launchStarted.resolve(); return launchControl.promise; } },
      acquireTarget: async (handle) => ({ ...target, opaqueCapability: { childId: handle.childId } }),
      releaseTarget: async (childId) => { releases.push(childId); },
      captureFinalScreenshot: async () => screenshot,
      isParentCurrent: () => true,
      quarantineChild: async () => undefined,
      onComplete: ({ childId }) => { callbacks.push(childId); },
      operationTimeoutMs: 500,
      abortGraceMs: 5,
      cleanupTimeoutMs: 50,
    });
    const handle = runtime.start({ parent, target, operatorModel: { instanceId: "qwen", model: "vision" }, prompt: "work", childId: "child-pending-launch" });
    await launchStarted.promise;
    const abortPromise = runtime.abort(handle);
    const boundedAbort = await abortPromise;
    expect(boundedAbort?.status).toBe("aborted");
    expect(releases).toEqual(["child-pending-launch"]);
    expect(callbacks).toEqual(["child-pending-launch"]);
    launchControl.resolve(child);
    await vi.waitFor(() => expect(child.interrupted).toBe(true));
    child.completionControl.resolve({ status: "aborted", reason: "interrupted" });
    child.cleanupControl.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(callbacks).toEqual(["child-pending-launch"]);
    expect(manager.get(handle.childId)?.leaseHeld).toBe(false);
  });

  it("keeps an unknown lease when cleanup cannot be proven, until explicitly recovered", async () => {
    const h = harness({ quarantineChild: async () => { throw new Error("quarantine unavailable"); } });
    const handle = h.runtime.start({
      parent,
      target,
      operatorModel: { instanceId: "qwen", model: "vision" },
      prompt: "work",
      childId: "child-unknown",
    });
    await waitForChild(h.children);
    h.children[0]!.completionControl.resolve({ status: "aborted", reason: "stop" });
    h.children[0]!.cleanupControl.reject("transport lost");
    const completion = await handle.done;
    expect(completion?.status).toBe("unknown");
    expect(h.manager.get(handle.childId)).toMatchObject({ status: "unknown", leaseHeld: true });
    await h.runtime.releaseAfterCleanup(handle);
    expect(h.manager.get(handle.childId)?.leaseHeld).toBe(false);
  });

  it("steers by cancelling and starting one successor only after cleanup", async () => {
    const h = harness();
    const first = h.runtime.start({
      parent,
      target,
      operatorModel: { instanceId: "qwen", model: "vision" },
      prompt: "first",
      childId: "child-first",
    });
    await waitForChild(h.children);
    const successorPromise = h.runtime.steer(first, "retry with keyboard");
    await vi.waitFor(() => expect(h.children[0]!.interrupted).toBe(true));
    expect(h.launched).toHaveLength(1);
    expect(h.children[0]!.interrupted).toBe(true);
    h.children[0]!.completionControl.resolve({ status: "aborted", reason: "steer" });
    await Promise.resolve();
    expect(h.launched).toHaveLength(1);
    h.children[0]!.cleanupControl.resolve();
    const successor = await successorPromise;
    await waitForChild(h.children, 1);
    expect(h.launched).toHaveLength(2);
    expect(h.launched[1]!.prompt).toBe("retry with keyboard");
    expect(h.launched[1]!.childId).not.toBe(first.childId);
    await settle(h.children[1]!, { status: "completed" });
    await successor.done;
    expect(h.completions.map((completion) => completion.childId)).toEqual([successor.childId]);
    expect(await first.done).toMatchObject({ childId: successor.childId, status: "completed" });
    expect(h.acquired).toEqual(["child-first", successor.childId]);
    expect(h.released).toEqual(["child-first", successor.childId]);
  });

  it("rejects a concurrent steer instead of acknowledging and dropping its prompt", async () => {
    const h = harness();
    const first = h.runtime.start({
      parent,
      target,
      operatorModel: { instanceId: "qwen", model: "vision" },
      prompt: "first",
      childId: "child-concurrent-steer",
    });
    await waitForChild(h.children);
    const accepted = h.runtime.steer(first, "accepted correction");
    expect(() => h.runtime.steer(first, "must not be dropped")).toThrow(/already steering/);
    expect(h.manager.get(first.childId)?.pendingSteerCount).toBe(1);
    h.children[0]!.completionControl.resolve({ status: "aborted", reason: "steer" });
    h.children[0]!.cleanupControl.resolve();
    const successor = await accepted;
    await waitForChild(h.children, 1);
    expect(h.launched.map((launch) => launch.prompt)).toEqual(["first", "accepted correction"]);
    await settle(h.children[1]!, { status: "completed" });
    await successor.done;
  });

  it("keeps one logical steer done and one final callback across an adversarial predecessor race", async () => {
    const h = harness();
    const first = h.runtime.start({ parent, target, operatorModel: { instanceId: "qwen", model: "vision" }, prompt: "first", childId: "chain-first" });
    await waitForChild(h.children);
    const successorPromise = h.runtime.steer(first, "second");
    // Completion wins the race with interrupt, but remains an internal
    // predecessor result and cannot revive the parent.
    h.children[0]!.completionControl.resolve({ status: "completed", output: "predecessor" });
    h.children[0]!.cleanupControl.resolve();
    const successor = await successorPromise;
    await waitForChild(h.children, 1);
    expect(h.completions).toEqual([]);
    let logicalDone = false;
    void first.done.then(() => { logicalDone = true; });
    await Promise.resolve();
    expect(logicalDone).toBe(false);
    await settle(h.children[1]!, { status: "completed", output: "successor" });
    const completion = await first.done;
    expect(completion).toMatchObject({ childId: successor.childId, status: "completed", output: "successor" });
    expect(await successor.done).toEqual(completion);
    expect(h.completions.map(({ childId }) => childId)).toEqual([successor.childId]);
    expect(h.acquired).toEqual(["chain-first", successor.childId]);
    expect(h.launched[0]!.target.opaqueCapability).not.toEqual(h.launched[1]!.target.opaqueCapability);
  });

  it("fails closed and does not launch a steer successor when predecessor cleanup is unknown", async () => {
    const h = harness({ quarantineChild: async () => { throw new Error("quarantine unavailable"); } });
    const first = h.runtime.start({ parent, target, operatorModel: { instanceId: "qwen", model: "vision" }, prompt: "first", childId: "unknown-first" });
    await waitForChild(h.children);
    const successorPromise = h.runtime.steer(first, "must not launch");
    h.children[0]!.completionControl.resolve({ status: "aborted", reason: "steer" });
    h.children[0]!.cleanupControl.reject("cleanup transport lost");
    await expect(successorPromise).rejects.toThrow("cleanup was not proven");
    expect(h.launched).toHaveLength(1);
    expect(h.released).toEqual([]);
    expect(h.manager.get(first.childId)).toMatchObject({ status: "unknown", leaseHeld: true });
    expect((await first.done)?.status).toBe("unknown");
    expect(h.completions.map(({ childId }) => childId)).toEqual([first.childId]);
  });

  it("turns capability-release uncertainty into an unknown held lease", async () => {
    const manager = new ComputerSubagentManager();
    const child = fakeChild();
    const callbacks: string[] = [];
    const runtime = new ComputerSubagentRuntime({
      manager,
      provider: { launch: async () => child },
      acquireTarget: async () => ({ ...target, opaqueCapability: "fresh" }),
      releaseTarget: async () => { throw new Error("revocation unavailable"); },
      captureFinalScreenshot: async () => screenshot,
      isParentCurrent: () => true,
      quarantineChild: async () => undefined,
      onComplete: ({ status }) => { callbacks.push(status); },
    });
    const handle = runtime.start({ parent, target, operatorModel: { instanceId: "qwen", model: "vision" }, prompt: "work", childId: "release-unknown" });
    child.completionControl.resolve({ status: "completed" });
    child.cleanupControl.resolve();
    const completion = await handle.done;
    expect(completion).toMatchObject({ status: "unknown", finalScreenshotCaptured: true });
    expect(manager.get(handle.childId)).toMatchObject({ status: "unknown", leaseHeld: true });
    expect(callbacks).toEqual(["unknown"]);
  });

  it("ignores a stale child completion after its parent generation was superseded", async () => {
    const h = harness();
    const old = h.runtime.start({
      parent,
      target,
      operatorModel: { instanceId: "qwen", model: "vision" },
      prompt: "old",
      childId: "child-old",
    });
    await waitForChild(h.children);
    // Simulate parent cancellation/fencing performed by the owner before a
    // late provider event arrives. The runtime must not revive this child.
    h.manager.abort(old, "parent generation cancelled");
    h.manager.release(old);
    const newer = h.runtime.start({
      parent: { ...parent, generation: 2, turnId: "turn-new" },
      target,
      operatorModel: { instanceId: "qwen", model: "vision" },
      prompt: "new",
      childId: "child-new",
    });
    await waitForChild(h.children, 1);
    h.children[0]!.completionControl.resolve({ status: "completed", output: "stale" });
    h.children[0]!.cleanupControl.resolve();
    await old.done;
    expect(h.completions).toEqual([]);
    await settle(h.children[1]!, { status: "completed", output: "current" });
    await newer.done;
    expect(h.completions.map((completion) => completion.childId)).toEqual(["child-new"]);
  });

  it("delivers completion exactly once even when the provider resolves twice", async () => {
    const h = harness();
    const handle = h.runtime.start({
      parent,
      target,
      operatorModel: { instanceId: "qwen", model: "vision" },
      prompt: "once",
      childId: "child-once",
    });
    await waitForChild(h.children);
    await settle(h.children[0]!, { status: "completed" });
    await handle.done;
    expect(h.completions).toHaveLength(1);
  });

  it("bounds abort during target acquisition and releases a capability that arrives late", async () => {
    const manager = new ComputerSubagentManager();
    const acquireControl = deferred<ComputerSubagentCapabilityDescriptor>();
    const acquireStarted = deferred<AbortSignal>();
    const providerLaunch = vi.fn();
    const released: string[] = [];
    const callbacks: string[] = [];
    const quarantined: string[] = [];
    const runtime = new ComputerSubagentRuntime({
      manager,
      provider: { launch: providerLaunch },
      acquireTarget: async (_handle, _parent, signal) => {
        acquireStarted.resolve(signal);
        return acquireControl.promise;
      },
      releaseTarget: async (childId) => { released.push(childId); },
      captureFinalScreenshot: async () => screenshot,
      isParentCurrent: () => true,
      quarantineChild: async (childId) => { quarantined.push(childId); },
      onComplete: ({ childId }) => { callbacks.push(childId); },
      operationTimeoutMs: 500,
      abortGraceMs: 5,
      cleanupTimeoutMs: 25,
    });
    const handle = runtime.start({ parent, target, operatorModel: { instanceId: "qwen", model: "vision" }, prompt: "work", childId: "late-acquire" });
    const signal = await acquireStarted.promise;
    const completion = await runtime.abort(handle);
    expect(signal.aborted).toBe(true);
    expect(completion?.status).toBe("aborted");
    expect(quarantined).toEqual(["late-acquire"]);
    expect(providerLaunch).not.toHaveBeenCalled();
    expect(manager.get(handle.childId)?.leaseHeld).toBe(false);

    acquireControl.resolve({ ...target, opaqueCapability: "late" });
    await vi.waitFor(() => expect(released).toEqual(["late-acquire"]));
    expect(providerLaunch).not.toHaveBeenCalled();
    expect(callbacks).toEqual(["late-acquire"]);
  });

  it("returns bounded unknown when launch and quarantine wedge, then cleans a late child without publishing it", async () => {
    const manager = new ComputerSubagentManager();
    const launchControl = deferred<ComputerSubagentProviderChild>();
    const launchStarted = deferred<AbortSignal>();
    const child = fakeChild();
    child.interrupt = async () => { child.interrupted = true; child.cleanupControl.resolve(); };
    const releaseTarget = vi.fn(async () => undefined);
    const callbacks: string[] = [];
    const runtime = new ComputerSubagentRuntime({
      manager,
      provider: { launch: async (input) => { launchStarted.resolve(input.signal); return launchControl.promise; } },
      acquireTarget: async () => ({ ...target, opaqueCapability: "launch-cap" }),
      releaseTarget,
      captureFinalScreenshot: async () => screenshot,
      isParentCurrent: () => true,
      quarantineChild: async () => new Promise<void>(() => {}),
      onComplete: ({ childId }) => { callbacks.push(childId); },
      operationTimeoutMs: 500,
      abortGraceMs: 5,
      cleanupTimeoutMs: 20,
    });
    const handle = runtime.start({ parent, target, operatorModel: { instanceId: "qwen", model: "vision" }, prompt: "work", childId: "late-launch" });
    const signal = await launchStarted.promise;
    const completion = await runtime.abort(handle);
    expect(signal.aborted).toBe(true);
    expect(completion?.status).toBe("unknown");
    expect(manager.get(handle.childId)).toMatchObject({ status: "unknown", leaseHeld: true });
    expect(callbacks).toEqual(["late-launch"]);

    launchControl.resolve(child);
    await vi.waitFor(() => expect(child.interrupted).toBe(true));
    await vi.waitFor(() => expect(manager.get(handle.childId)?.leaseHeld).toBe(false));
    expect(releaseTarget).toHaveBeenCalledOnce();
    expect(callbacks).toEqual(["late-launch"]);
  });

  it("fences a stale parent before provider launch", async () => {
    const current = vi.fn(() => false);
    const h = harness({ isParentCurrent: current });
    const handle = h.runtime.start({ parent, target, operatorModel: { instanceId: "qwen", model: "vision" }, prompt: "work", childId: "stale-before-launch" });
    const completion = await handle.done;
    expect(completion?.status).toBe("aborted");
    expect(h.launched).toEqual([]);
    expect(h.screenshots).toEqual([]);
    expect(h.completions).toEqual([]);
    expect(h.released).toEqual(["stale-before-launch"]);
  });

  it("rechecks the parent before final screenshot and suppresses stale publication", async () => {
    const current = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const h = harness({ isParentCurrent: current });
    const handle = h.runtime.start({ parent, target, operatorModel: { instanceId: "qwen", model: "vision" }, prompt: "work", childId: "stale-before-screen" });
    await waitForChild(h.children);
    await settle(h.children[0]!, { status: "completed", output: "must-not-publish" });
    const completion = await handle.done;
    expect(completion).toMatchObject({ status: "aborted", finalScreenshotCaptured: false });
    expect(h.screenshots).toEqual([]);
    expect(h.completions).toEqual([]);
  });

  it("aborts a final capture immediately instead of waiting for its timeout", async () => {
    const captureStarted = deferred<AbortSignal>();
    const h = harness({
      captureFinalScreenshot: async (signal) => {
        captureStarted.resolve(signal);
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
    });
    const handle = h.runtime.start({ parent, target, operatorModel: { instanceId: "qwen", model: "vision" }, prompt: "work", childId: "abort-capture" });
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    h.children[0]!.completionControl.resolve({ status: "completed", output: "done" });
    h.children[0]!.cleanupControl.resolve();
    const signal = await captureStarted.promise;
    const completion = await h.runtime.abort(handle);
    expect(signal.aborted).toBe(true);
    expect(completion).toMatchObject({ status: "aborted", finalScreenshotCaptured: false });
  });

  it("rechecks the parent immediately before callback publication", async () => {
    const current = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const h = harness({ isParentCurrent: current });
    const handle = h.runtime.start({ parent, target, operatorModel: { instanceId: "qwen", model: "vision" }, prompt: "work", childId: "stale-before-callback" });
    await waitForChild(h.children);
    await settle(h.children[0]!, { status: "completed", output: "internal-only" });
    const completion = await handle.done;
    expect(completion).toMatchObject({ status: "completed", finalScreenshotCaptured: true });
    expect(h.screenshots).toEqual(["stale-before-callback"]);
    expect(h.completions).toEqual([]);
  });

  it("fences a steer successor when its parent becomes stale", async () => {
    const current = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const h = harness({ isParentCurrent: current });
    const first = h.runtime.start({ parent, target, operatorModel: { instanceId: "qwen", model: "vision" }, prompt: "first", childId: "stale-steer" });
    await waitForChild(h.children);
    const successor = h.runtime.steer(first, "second");
    await vi.waitFor(() => expect(h.children[0]!.interrupted).toBe(true));
    h.children[0]!.cleanupControl.resolve();
    await expect(successor).rejects.toThrow("parent generation is stale");
    expect(h.launched).toHaveLength(1);
    expect(h.completions).toEqual([]);
  });

  it("rejects spoofed screenshot bytes even when MIME and declared length look valid", async () => {
    const spoof = {
      ...screenshot,
      dataBase64: Buffer.from("not-a-jpeg").toString("base64"),
      byteLength: Buffer.byteLength("not-a-jpeg"),
    };
    const h = harness({ captureFinalScreenshot: async () => spoof });
    const handle = h.runtime.start({ parent, target, operatorModel: { instanceId: "qwen", model: "vision" }, prompt: "work", childId: "spoofed-screen" });
    await waitForChild(h.children);
    await settle(h.children[0]!, { status: "completed" });
    const completion = await handle.done;
    expect(completion).toMatchObject({ status: "failed", finalScreenshotCaptured: false });
    expect(completion?.error).toContain("magic bytes");
  });
});
