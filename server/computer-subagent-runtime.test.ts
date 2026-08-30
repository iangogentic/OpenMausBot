import { describe, expect, it } from "vitest";

import { ComputerSubagentManager, type ComputerSubagentParent } from "./computer-subagent-manager.ts";
import {
  ComputerSubagentRuntime,
  type ComputerSubagentCapabilityDescriptor,
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
  dataBase64: Buffer.from("pixels").toString("base64"),
  byteLength: Buffer.byteLength("pixels"),
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

function harness() {
  const manager = new ComputerSubagentManager();
  const launched: ComputerSubagentProviderLaunchInput[] = [];
  const children: FakeChild[] = [];
  const completions: Array<{ status: string; finalScreenshotCaptured: boolean; childId: string }> = [];
  const screenshots: string[] = [];
  const acquired: string[] = [];
  const released: string[] = [];
  const events: string[] = [];
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
    acquireTarget: async (childId) => {
      acquired.push(childId);
      return { ...target, opaqueCapability: { childId, nonce: acquired.length } };
    },
    releaseTarget: async (childId) => { released.push(childId); },
    captureFinalScreenshot: async ({ childId }) => { screenshots.push(childId); events.push("screenshot"); return screenshot; },
    onComplete: (completion) => {
      events.push("complete");
      completions.push({
        status: completion.status,
        finalScreenshotCaptured: completion.finalScreenshotCaptured,
        childId: completion.childId,
      });
    },
  });
  return { manager, launched, children, completions, screenshots, acquired, released, events, runtime };
}

async function settle(child: FakeChild, outcome: ComputerSubagentProviderOutcome): Promise<void> {
  child.completionControl.resolve(outcome);
  child.cleanupControl.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("ComputerSubagentRuntime", () => {
  it("launches the exact Qwen operator model with the opaque selected target", async () => {
    const h = harness();
    const handle = h.runtime.start({
      parent,
      target,
      operatorModel: { instanceId: "desktop2-qwen", model: "qwen-vision-27b" },
      prompt: "Click the save button",
      childId: "child-qwen",
    });
    await Promise.resolve();
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
    expect(h.events).toEqual(["screenshot", "complete"]);
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
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.launched[0]).not.toHaveProperty("onActions");
    expect(h.runtime.accountActions(handle, 9)).toBe(9);
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
    await Promise.resolve();
    const abort = h.runtime.abort(handle);
    await Promise.resolve();
    expect(h.children[0]!.interrupted).toBe(true);
    expect(h.manager.get(handle.childId)?.leaseHeld).toBe(true);
    let finished = false;
    void abort.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    h.children[0]!.completionControl.resolve({ status: "aborted", reason: "stop" });
    await Promise.resolve();
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
    const child = fakeChild();
    const releases: string[] = [];
    const callbacks: string[] = [];
    const runtime = new ComputerSubagentRuntime({
      manager,
      provider: { launch: async () => launchControl.promise },
      acquireTarget: async (childId) => ({ ...target, opaqueCapability: { childId } }),
      releaseTarget: async (childId) => { releases.push(childId); },
      captureFinalScreenshot: async () => screenshot,
      onComplete: ({ childId }) => { callbacks.push(childId); },
    });
    const handle = runtime.start({ parent, target, operatorModel: { instanceId: "qwen", model: "vision" }, prompt: "work", childId: "child-pending-launch" });
    await Promise.resolve();
    const abortPromise = runtime.abort(handle);
    let abortSettled = false;
    void abortPromise.then(() => { abortSettled = true; });
    await Promise.resolve();
    expect(abortSettled).toBe(false);
    launchControl.resolve(child);
    await Promise.resolve();
    await Promise.resolve();
    expect(child.interrupted).toBe(true);
    expect(manager.get(handle.childId)?.leaseHeld).toBe(true);
    child.completionControl.resolve({ status: "aborted", reason: "interrupted" });
    await Promise.resolve();
    expect(abortSettled).toBe(false);
    child.cleanupControl.resolve();
    expect((await abortPromise)?.status).toBe("aborted");
    expect(releases).toEqual(["child-pending-launch"]);
    expect(callbacks).toEqual(["child-pending-launch"]);
    expect(manager.get(handle.childId)?.leaseHeld).toBe(false);
  });

  it("keeps an unknown lease when cleanup cannot be proven, until explicitly recovered", async () => {
    const h = harness();
    const handle = h.runtime.start({
      parent,
      target,
      operatorModel: { instanceId: "qwen", model: "vision" },
      prompt: "work",
      childId: "child-unknown",
    });
    await Promise.resolve();
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
    await Promise.resolve();
    const successorPromise = h.runtime.steer(first, "retry with keyboard");
    await Promise.resolve();
    expect(h.launched).toHaveLength(1);
    expect(h.children[0]!.interrupted).toBe(true);
    h.children[0]!.completionControl.resolve({ status: "aborted", reason: "steer" });
    await Promise.resolve();
    expect(h.launched).toHaveLength(1);
    h.children[0]!.cleanupControl.resolve();
    const successor = await successorPromise;
    await Promise.resolve();
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

  it("keeps one logical steer done and one final callback across an adversarial predecessor race", async () => {
    const h = harness();
    const first = h.runtime.start({ parent, target, operatorModel: { instanceId: "qwen", model: "vision" }, prompt: "first", childId: "chain-first" });
    await Promise.resolve();
    const successorPromise = h.runtime.steer(first, "second");
    // Completion wins the race with interrupt, but remains an internal
    // predecessor result and cannot revive the parent.
    h.children[0]!.completionControl.resolve({ status: "completed", output: "predecessor" });
    h.children[0]!.cleanupControl.resolve();
    const successor = await successorPromise;
    await Promise.resolve();
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
    const h = harness();
    const first = h.runtime.start({ parent, target, operatorModel: { instanceId: "qwen", model: "vision" }, prompt: "first", childId: "unknown-first" });
    await Promise.resolve();
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
      onComplete: ({ status }) => { callbacks.push(status); },
    });
    const handle = runtime.start({ parent, target, operatorModel: { instanceId: "qwen", model: "vision" }, prompt: "work", childId: "release-unknown" });
    await Promise.resolve();
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
    await Promise.resolve();
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
    await Promise.resolve();
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
    await Promise.resolve();
    await settle(h.children[0]!, { status: "completed" });
    await handle.done;
    expect(h.completions).toHaveLength(1);
  });
});
