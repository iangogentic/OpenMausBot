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
    captureFinalScreenshot: async ({ childId }) => { screenshots.push(childId); events.push("screenshot"); },
    onComplete: (completion) => {
      events.push("complete");
      completions.push({
        status: completion.status,
        finalScreenshotCaptured: completion.finalScreenshotCaptured,
        childId: completion.childId,
      });
    },
  });
  return { manager, launched, children, completions, screenshots, events, runtime };
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
    expect(h.launched[0]).toMatchObject({
      childId: "child-qwen",
      parent,
      model: { instanceId: "desktop2-qwen", model: "qwen-vision-27b" },
      prompt: "Click the save button",
      target,
    });
    expect(h.launched[0]).not.toHaveProperty("apiKey");
    await settle(h.children[0]!, { status: "completed", output: "saved" });
    await handle.done;
    expect(h.screenshots).toEqual(["child-qwen"]);
    expect(h.events).toEqual(["screenshot", "complete"]);
    expect(h.completions).toEqual([{ status: "completed", finalScreenshotCaptured: true, childId: "child-qwen" }]);
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
    const onActions = h.launched[0]!.onActions;
    expect(onActions(9)).toBe(9);
    expect(() => onActions()).toThrow("action budget exceeded");
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
    h.runtime.releaseAfterCleanup(handle);
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
    expect(h.completions.map((completion) => completion.childId)).toEqual(["child-first", successor.childId]);
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
