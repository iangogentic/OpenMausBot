import type { ComputerSubagentHandle, ComputerSubagentManager, ComputerSubagentParent, ComputerSubagentRecord } from "./computer-subagent-manager.ts";
import { COMPUTER_SUBAGENT_TERMINAL_STATUSES, ComputerSubagentOwnershipError, ComputerSubagentStateError } from "./computer-subagent-manager.ts";
import type { ModelSelection } from "./contracts.ts";

export const MAX_COMPUTER_SUBAGENT_SCREENSHOT_BYTES = 512_000;

export interface ComputerSubagentTargetSelection { targetKey: string; targetGeneration: string; boxId?: string }
export interface ComputerSubagentCapabilityDescriptor extends ComputerSubagentTargetSelection { readonly opaqueCapability: unknown }
export interface ComputerSubagentFinalScreenshot {
  mimeType: "image/jpeg" | "image/png";
  dataBase64: string;
  byteLength: number;
  width: number;
  height: number;
  sha256?: string;
}
export type ComputerSubagentProviderOutcome =
  | { status: "completed"; output?: string }
  | { status: "failed"; error: string }
  | { status: "aborted"; reason?: string };
type FinishOutcome = ComputerSubagentProviderOutcome | { status: "unknown"; error: string };

/** No counter is exposed to the provider. The broker must call
 * runtime.accountActions with the owner handle before dispatch. */
export interface ComputerSubagentProviderLaunchInput {
  childId: string; parent: ComputerSubagentParent; model: ModelSelection; prompt: string; target: ComputerSubagentCapabilityDescriptor;
}
export interface ComputerSubagentProviderChild {
  completion: Promise<ComputerSubagentProviderOutcome>;
  waitForTerminal: () => Promise<void>;
  interrupt: () => Promise<void>;
}
export interface ComputerSubagentProviderRuntime { launch: (input: ComputerSubagentProviderLaunchInput) => Promise<ComputerSubagentProviderChild> }
export interface ComputerSubagentCompletion {
  childId: string;
  parent: ComputerSubagentParent;
  status: "completed" | "failed" | "aborted" | "unknown";
  record: ComputerSubagentRecord;
  finalScreenshotCaptured: boolean;
  finalScreenshot?: ComputerSubagentFinalScreenshot;
  output?: string;
  error?: string;
}
export interface ComputerSubagentRuntimeOptions {
  manager: ComputerSubagentManager;
  provider: ComputerSubagentProviderRuntime;
  acquireTarget: (childId: string, parent: ComputerSubagentParent) => Promise<ComputerSubagentCapabilityDescriptor>;
  releaseTarget: (childId: string, parent: ComputerSubagentParent, target: ComputerSubagentCapabilityDescriptor) => Promise<void>;
  captureFinalScreenshot: (input: { childId: string; parent: ComputerSubagentParent; target: ComputerSubagentCapabilityDescriptor }) => Promise<ComputerSubagentFinalScreenshot>;
  onComplete: (completion: ComputerSubagentCompletion) => void | Promise<void>;
}
export interface ComputerSubagentRuntimeStartInput {
  parent: ComputerSubagentParent; target: ComputerSubagentTargetSelection; operatorModel: ModelSelection; prompt: string; childId?: string;
}
export interface ComputerSubagentRuntimeHandle extends ComputerSubagentHandle { done: Promise<ComputerSubagentCompletion | null> }
interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void }
interface Chain { done: Deferred<ComputerSubagentCompletion | null>; callbackDelivered: boolean; resolved: boolean }
interface Execution {
  handle: ComputerSubagentHandle;
  input: ComputerSubagentRuntimeStartInput;
  chain: Chain;
  child: ComputerSubagentProviderChild | null;
  target: ComputerSubagentCapabilityDescriptor | null;
  settled: Promise<ComputerSubagentCompletion | null>;
  interruptPromise: Promise<void> | null;
  interruptRequested: boolean;
  abortRequested: boolean;
  steering: boolean;
  acceptingActions: boolean;
  terminalized: boolean;
  released: boolean;
  steerPromise: Promise<ComputerSubagentRuntimeHandle> | null;
}
function deferred<T>(): Deferred<T> { let resolve!: (value: T) => void; const promise = new Promise<T>((res) => { resolve = res; }); return { promise, resolve }; }
function cloneParent(parent: ComputerSubagentParent): ComputerSubagentParent { return { ...parent }; }
function cloneModel(model: ModelSelection): ModelSelection { return { ...model }; }
function cloneSelection(target: ComputerSubagentTargetSelection): ComputerSubagentTargetSelection { return { ...target }; }
function validateScreenshot(value: ComputerSubagentFinalScreenshot): ComputerSubagentFinalScreenshot {
  if (value.mimeType !== "image/jpeg" && value.mimeType !== "image/png") throw new TypeError("final screenshot mimeType is unsupported");
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength <= 0 || value.byteLength > MAX_COMPUTER_SUBAGENT_SCREENSHOT_BYTES) throw new RangeError(`final screenshot must be 1-${MAX_COMPUTER_SUBAGENT_SCREENSHOT_BYTES} bytes`);
  if (!Number.isSafeInteger(value.width) || value.width <= 0 || !Number.isSafeInteger(value.height) || value.height <= 0) throw new TypeError("final screenshot dimensions must be positive integers");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.dataBase64)) throw new TypeError("final screenshot content must be base64");
  if (Buffer.from(value.dataBase64, "base64").byteLength !== value.byteLength) throw new RangeError("final screenshot byteLength does not match bounded content");
  return { ...value };
}

export class ComputerSubagentRuntime {
  private readonly manager: ComputerSubagentManager;
  private readonly provider: ComputerSubagentProviderRuntime;
  private readonly acquireTarget: ComputerSubagentRuntimeOptions["acquireTarget"];
  private readonly releaseTarget: ComputerSubagentRuntimeOptions["releaseTarget"];
  private readonly captureFinalScreenshot: ComputerSubagentRuntimeOptions["captureFinalScreenshot"];
  private readonly onComplete: ComputerSubagentRuntimeOptions["onComplete"];
  private readonly executions = new Map<string, Execution>();

  constructor(options: ComputerSubagentRuntimeOptions) {
    this.manager = options.manager; this.provider = options.provider; this.acquireTarget = options.acquireTarget;
    this.releaseTarget = options.releaseTarget; this.captureFinalScreenshot = options.captureFinalScreenshot; this.onComplete = options.onComplete;
  }
  start(input: ComputerSubagentRuntimeStartInput): ComputerSubagentRuntimeHandle {
    return this.startInChain(input, { done: deferred(), callbackDelivered: false, resolved: false });
  }
  accountActions(handle: ComputerSubagentHandle, amount = 1): number {
    const execution = this.execution(handle);
    if (!execution.acceptingActions) throw new ComputerSubagentStateError(handle.childId, "is not accepting computer actions");
    return this.manager.consumeActions(handle, amount);
  }
  async abort(handle: ComputerSubagentHandle): Promise<ComputerSubagentCompletion | null> {
    const execution = this.execution(handle);
    if (execution.terminalized) return execution.chain.done.promise;
    execution.abortRequested = true; execution.interruptRequested = true;
    await this.interruptIfAvailable(execution);
    return execution.chain.done.promise;
  }
  steer(handle: ComputerSubagentHandle, prompt: string): Promise<ComputerSubagentRuntimeHandle> {
    const execution = this.execution(handle);
    if (execution.steerPromise) return execution.steerPromise;
    this.manager.queueSteer(handle, prompt);
    execution.steering = true; execution.interruptRequested = true;
    execution.steerPromise = this.runSteer(execution);
    return execution.steerPromise;
  }
  async cancelParent(parent: ComputerSubagentParent): Promise<string[]> {
    const executions = [...this.executions.values()].filter((execution) => {
      const record = this.manager.get(execution.handle.childId);
      return record?.parent.botId === parent.botId && record.parent.threadId === parent.threadId
        && record.parent.turnId === parent.turnId && record.parent.generation === parent.generation
        && !COMPUTER_SUBAGENT_TERMINAL_STATUSES.has(record.status);
    });
    await Promise.all(executions.map((execution) => this.abort(execution.handle)));
    return executions.map((execution) => execution.handle.childId);
  }
  private startInChain(input: ComputerSubagentRuntimeStartInput, chain: Chain): ComputerSubagentRuntimeHandle {
    if (!input.target.targetKey.trim()) throw new TypeError("target.targetKey must be non-empty");
    if (!input.target.targetGeneration.trim()) throw new TypeError("target.targetGeneration must be non-empty");
    const created = this.manager.start({ parent: input.parent, targetKey: input.target.targetKey, targetGeneration: input.target.targetGeneration, operatorModel: input.operatorModel, childId: input.childId });
    const execution: Execution = {
      handle: created.handle,
      input: { parent: cloneParent(input.parent), target: cloneSelection(input.target), operatorModel: cloneModel(input.operatorModel), prompt: input.prompt },
      chain, child: null, target: null, settled: Promise.resolve(null), interruptPromise: null, interruptRequested: false,
      abortRequested: false, steering: false, acceptingActions: false, terminalized: false, released: false, steerPromise: null,
    };
    execution.settled = this.run(execution);
    this.executions.set(execution.handle.childId, execution);
    return { ...execution.handle, done: chain.done.promise };
  }
  private async run(execution: Execution): Promise<ComputerSubagentCompletion | null> {
    let outcome: ComputerSubagentProviderOutcome | null = null;
    let errorText: string | null = null;
    let cleanupProven = true;
    try {
      this.manager.markRunning(execution.handle);
      const target = await this.acquireTarget(execution.handle.childId, cloneParent(execution.input.parent));
      execution.target = target;
      if (target.targetKey !== execution.input.target.targetKey || target.targetGeneration !== execution.input.target.targetGeneration) throw new Error("acquired target identity does not match the leased target");
      if (execution.abortRequested && !execution.steering) {
        outcome = { status: "aborted", reason: "aborted before provider launch" };
      } else {
        const child = await this.provider.launch({ childId: execution.handle.childId, parent: cloneParent(execution.input.parent), model: cloneModel(execution.input.operatorModel), prompt: execution.input.prompt, target });
        execution.child = child;
        await this.interruptIfAvailable(execution);
        execution.acceptingActions = !execution.interruptRequested;
        try { outcome = await child.completion; } catch (error) { errorText = error instanceof Error ? error.message : String(error); }
        finally { execution.acceptingActions = false; }
        try { await child.waitForTerminal(); } catch (error) { cleanupProven = false; errorText = `provider cleanup did not settle: ${error instanceof Error ? error.message : String(error)}`; }
      }
    } catch (error) { errorText = error instanceof Error ? error.message : String(error); }
    if (!cleanupProven) return this.finish(execution, { status: "unknown", error: errorText ?? "provider cleanup was not proven" }, false);
    if (errorText) return this.finish(execution, execution.abortRequested ? { status: "aborted", reason: errorText } : { status: "failed", error: errorText }, true);
    if (!outcome) return this.finish(execution, { status: "unknown", error: "provider ended without a terminal result" }, false);
    if (execution.abortRequested && !execution.steering && outcome.status !== "failed") outcome = { status: "aborted", reason: "aborted by caller" };
    return this.finish(execution, outcome, true);
  }
  private async runSteer(execution: Execution): Promise<ComputerSubagentRuntimeHandle> {
    await this.interruptIfAvailable(execution);
    const predecessor = await execution.settled;
    if (execution.abortRequested) { await this.deliverFinal(execution.chain, predecessor); throw new ComputerSubagentStateError(execution.handle.childId, "was aborted before steer successor launch"); }
    if (!predecessor || predecessor.status === "unknown" || !execution.released) {
      await this.deliverFinal(execution.chain, predecessor);
      throw new ComputerSubagentStateError(execution.handle.childId, "cleanup was not proven; steer successor is fenced");
    }
    const prompt = this.manager.takeQueuedSteer(execution.handle);
    if (!prompt) { await this.deliverFinal(execution.chain, predecessor); throw new ComputerSubagentStateError(execution.handle.childId, "has no queued steer"); }
    const record = this.manager.get(execution.handle.childId);
    if (!record) throw new ComputerSubagentOwnershipError(execution.handle.childId);
    try {
      return this.startInChain({ parent: record.parent, target: execution.input.target, operatorModel: record.operatorModel ?? execution.input.operatorModel, prompt }, execution.chain);
    } catch (error) { await this.deliverFinal(execution.chain, predecessor); throw error; }
  }
  private async interruptIfAvailable(execution: Execution): Promise<void> {
    if (!execution.interruptRequested || !execution.child) return;
    if (!execution.interruptPromise) execution.interruptPromise = execution.child.interrupt().catch(() => undefined);
    await execution.interruptPromise;
  }
  private async finish(execution: Execution, outcome: FinishOutcome, cleanupProven: boolean): Promise<ComputerSubagentCompletion | null> {
    if (execution.terminalized) return null;
    const current = this.manager.get(execution.handle.childId);
    if (!current || !current.leaseHeld || COMPUTER_SUBAGENT_TERMINAL_STATUSES.has(current.status)) {
      execution.terminalized = true; this.executions.delete(execution.handle.childId);
      if (!execution.steering) await this.deliverFinal(execution.chain, null);
      return null;
    }
    let status: ComputerSubagentCompletion["status"] = outcome.status;
    let output = outcome.status === "completed" ? outcome.output : undefined;
    let error = outcome.status === "failed" ? outcome.error : outcome.status === "aborted" ? outcome.reason : outcome.status === "unknown" ? outcome.error : undefined;
    let finalScreenshot: ComputerSubagentFinalScreenshot | undefined;
    if (outcome.status === "completed") {
      if (!execution.target) { status = "failed"; error = "completed provider had no acquired target"; }
      else try {
        finalScreenshot = validateScreenshot(await this.captureFinalScreenshot({ childId: execution.handle.childId, parent: cloneParent(execution.input.parent), target: execution.target }));
      } catch (captureError) { status = "failed"; error = `final screenshot failed: ${captureError instanceof Error ? captureError.message : String(captureError)}`; output = undefined; }
    }
    let capabilityReleased = !execution.target;
    if (cleanupProven && execution.target) {
      try {
        await this.releaseTarget(execution.handle.childId, cloneParent(execution.input.parent), execution.target);
        capabilityReleased = true;
      } catch (releaseError) { status = "unknown"; error = `target capability release failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`; }
    }
    execution.terminalized = true;
    let record = status === "completed" ? this.manager.complete(execution.handle)
      : status === "failed" ? this.manager.fail(execution.handle, error ?? "provider failed")
        : status === "aborted" ? this.manager.abort(execution.handle, error ?? "aborted")
          : this.manager.markUnknown(execution.handle, error ?? "unknown provider result");
    if (cleanupProven && capabilityReleased) {
      this.manager.release(execution.handle); execution.released = true;
      record = this.manager.get(execution.handle.childId) ?? record;
      this.executions.delete(execution.handle.childId);
    }
    const completion: ComputerSubagentCompletion = { childId: execution.handle.childId, parent: cloneParent(execution.input.parent), status, record, finalScreenshotCaptured: finalScreenshot !== undefined };
    if (finalScreenshot) completion.finalScreenshot = finalScreenshot;
    if (output !== undefined) completion.output = output;
    if (error !== undefined) completion.error = error;
    if (!execution.steering) await this.deliverFinal(execution.chain, completion);
    return completion;
  }
  private async deliverFinal(chain: Chain, completion: ComputerSubagentCompletion | null): Promise<void> {
    if (chain.resolved) return;
    if (completion && !chain.callbackDelivered) { chain.callbackDelivered = true; try { await this.onComplete(completion); } catch { /* cleanup remains authoritative */ } }
    chain.resolved = true; chain.done.resolve(completion);
  }
  async releaseAfterCleanup(handle: ComputerSubagentHandle): Promise<void> {
    const execution = this.execution(handle);
    if (!execution.terminalized) throw new ComputerSubagentStateError(handle.childId, "is not terminal");
    if (execution.target) await this.releaseTarget(execution.handle.childId, cloneParent(execution.input.parent), execution.target);
    this.manager.release(handle); execution.released = true; this.executions.delete(handle.childId);
  }
  private execution(handle: ComputerSubagentHandle): Execution {
    const execution = this.executions.get(handle.childId);
    if (!execution || execution.handle.ownerToken !== handle.ownerToken) throw new ComputerSubagentOwnershipError(handle.childId);
    return execution;
  }
}
