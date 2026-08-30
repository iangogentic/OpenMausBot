import type { ComputerSubagentHandle, ComputerSubagentManager, ComputerSubagentParent, ComputerSubagentRecord } from "./computer-subagent-manager.ts";
import { COMPUTER_SUBAGENT_TERMINAL_STATUSES, MAX_COMPUTER_SUBAGENT_ACTIONS, ComputerSubagentOwnershipError, ComputerSubagentStateError } from "./computer-subagent-manager.ts";
import type { ModelSelection } from "./contracts.ts";
import type { ComputerChildMonitor, ComputerChildMonitorListener } from "../shared/computer-child-monitor.ts";

export const MAX_COMPUTER_SUBAGENT_SCREENSHOT_BYTES = 512_000;
export const DEFAULT_COMPUTER_SUBAGENT_OPERATION_TIMEOUT_MS = 30_000;
export const DEFAULT_COMPUTER_SUBAGENT_ABORT_GRACE_MS = 2_000;
export const DEFAULT_COMPUTER_SUBAGENT_CLEANUP_TIMEOUT_MS = 10_000;

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
  /** Aborted on Stop, stale-parent fencing, or a bounded launch timeout. */
  signal: AbortSignal;
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
  acquireTarget: (handle: ComputerSubagentHandle, parent: ComputerSubagentParent, signal: AbortSignal) => Promise<ComputerSubagentCapabilityDescriptor>;
  releaseTarget: (childId: string, parent: ComputerSubagentParent, target: ComputerSubagentCapabilityDescriptor) => Promise<void>;
  captureFinalScreenshot: (input: { childId: string; parent: ComputerSubagentParent; target: ComputerSubagentCapabilityDescriptor; signal: AbortSignal }) => Promise<ComputerSubagentFinalScreenshot>;
  /** Exact parent turn/generation fence. Uncertainty must return false. */
  isParentCurrent: (parent: ComputerSubagentParent) => boolean | Promise<boolean>;
  /** Must contain/revoke every child-owned action lane even when an acquire,
   * launch, interrupt, or cleanup promise is wedged. */
  quarantineChild: (childId: string, parent: ComputerSubagentParent) => void | Promise<void>;
  onComplete: (completion: ComputerSubagentCompletion) => void | Promise<void>;
  /** Receives authority-free snapshots after each runtime lifecycle change.
   * Listener failures are isolated from the child runtime. */
  onMonitorChange?: ComputerChildMonitorListener;
  operationTimeoutMs?: number;
  abortGraceMs?: number;
  cleanupTimeoutMs?: number;
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
  abortController: AbortController;
  targetReleased: boolean;
  targetReleasePromise: Promise<void> | null;
}
type PhaseResult<T> = { ok: true; value: T } | { ok: false; reason: "aborted" | "timeout" | "error"; error?: string };
function deferred<T>(): Deferred<T> { let resolve!: (value: T) => void; const promise = new Promise<T>((res) => { resolve = res; }); return { promise, resolve }; }
function cloneParent(parent: ComputerSubagentParent): ComputerSubagentParent { return { ...parent }; }
function cloneModel(model: ModelSelection): ModelSelection { return { ...model }; }
function cloneSelection(target: ComputerSubagentTargetSelection): ComputerSubagentTargetSelection { return { ...target }; }
function validateScreenshot(value: ComputerSubagentFinalScreenshot): ComputerSubagentFinalScreenshot {
  if (value.mimeType !== "image/jpeg" && value.mimeType !== "image/png") throw new TypeError("final screenshot mimeType is unsupported");
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength <= 0 || value.byteLength > MAX_COMPUTER_SUBAGENT_SCREENSHOT_BYTES) throw new RangeError(`final screenshot must be 1-${MAX_COMPUTER_SUBAGENT_SCREENSHOT_BYTES} bytes`);
  if (!Number.isSafeInteger(value.width) || value.width <= 0 || !Number.isSafeInteger(value.height) || value.height <= 0) throw new TypeError("final screenshot dimensions must be positive integers");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.dataBase64)) throw new TypeError("final screenshot content must be base64");
  const bytes = Buffer.from(value.dataBase64, "base64");
  if (bytes.byteLength !== value.byteLength) throw new RangeError("final screenshot byteLength does not match bounded content");
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes.length >= 5 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  if ((value.mimeType === "image/png" && !png) || (value.mimeType === "image/jpeg" && !jpeg)) {
    throw new TypeError("final screenshot content does not match its image magic bytes");
  }
  return { ...value };
}

export class ComputerSubagentRuntime {
  private readonly manager: ComputerSubagentManager;
  private readonly provider: ComputerSubagentProviderRuntime;
  private readonly acquireTarget: ComputerSubagentRuntimeOptions["acquireTarget"];
  private readonly releaseTarget: ComputerSubagentRuntimeOptions["releaseTarget"];
  private readonly captureFinalScreenshot: ComputerSubagentRuntimeOptions["captureFinalScreenshot"];
  private readonly isParentCurrent: ComputerSubagentRuntimeOptions["isParentCurrent"];
  private readonly quarantineChild: ComputerSubagentRuntimeOptions["quarantineChild"];
  private readonly onComplete: ComputerSubagentRuntimeOptions["onComplete"];
  private readonly onMonitorChange?: ComputerChildMonitorListener;
  private readonly operationTimeoutMs: number;
  private readonly abortGraceMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly executions = new Map<string, Execution>();

  constructor(options: ComputerSubagentRuntimeOptions) {
    this.manager = options.manager; this.provider = options.provider; this.acquireTarget = options.acquireTarget;
    this.releaseTarget = options.releaseTarget; this.captureFinalScreenshot = options.captureFinalScreenshot;
    this.isParentCurrent = options.isParentCurrent; this.quarantineChild = options.quarantineChild; this.onComplete = options.onComplete;
    this.onMonitorChange = options.onMonitorChange;
    this.operationTimeoutMs = this.validTimeout(options.operationTimeoutMs ?? DEFAULT_COMPUTER_SUBAGENT_OPERATION_TIMEOUT_MS, "operationTimeoutMs");
    this.abortGraceMs = this.validTimeout(options.abortGraceMs ?? DEFAULT_COMPUTER_SUBAGENT_ABORT_GRACE_MS, "abortGraceMs");
    this.cleanupTimeoutMs = this.validTimeout(options.cleanupTimeoutMs ?? DEFAULT_COMPUTER_SUBAGENT_CLEANUP_TIMEOUT_MS, "cleanupTimeoutMs");
  }
  start(input: ComputerSubagentRuntimeStartInput): ComputerSubagentRuntimeHandle {
    return this.startInChain(input, { done: deferred(), callbackDelivered: false, resolved: false });
  }
  accountActions(handle: ComputerSubagentHandle, amount = 1): number {
    const execution = this.execution(handle);
    if (!execution.acceptingActions) throw new ComputerSubagentStateError(handle.childId, "is not accepting computer actions");
    const count = this.manager.consumeActions(handle, amount);
    const record = this.manager.get(handle.childId);
    if (record) this.publishMonitor(record);
    return count;
  }
  /** Pause the exact owned child while its current parent turn remains live. */
  async markWaitingOnHuman(handle: ComputerSubagentHandle, parent: ComputerSubagentParent): Promise<ComputerChildMonitor> {
    const execution = await this.currentOwnedExecution(handle, parent);
    this.requireHumanHandoffMutable(execution);
    const record = this.manager.markWaitingOnHuman(execution.handle);
    execution.acceptingActions = false;
    return this.publishMonitor(record);
  }
  /** Resume the exact owned child after human control returns to the agent. */
  async resumeAfterHuman(
    handle: ComputerSubagentHandle,
    parent: ComputerSubagentParent,
    mayResume: () => boolean = () => true,
  ): Promise<ComputerChildMonitor> {
    const execution = await this.currentOwnedExecution(handle, parent);
    this.requireHumanHandoffMutable(execution);
    // currentOwnedExecution awaits parent validation. A new human takeover can
    // begin during that await, so recheck its target reservation at the final
    // synchronous boundary before action admission becomes live again.
    if (!mayResume()) throw new ComputerSubagentStateError(handle.childId, "cannot resume while human control is reserved");
    const record = this.manager.markRunningAfterHuman(execution.handle);
    execution.acceptingActions = execution.child !== null && !execution.terminalized && !execution.abortRequested;
    return this.publishMonitor(record);
  }
  async abort(handle: ComputerSubagentHandle): Promise<ComputerSubagentCompletion | null> {
    const execution = this.execution(handle);
    if (execution.terminalized) return execution.chain.done.promise;
    execution.abortRequested = true; execution.interruptRequested = true;
    execution.abortController.abort();
    void this.interruptIfAvailable(execution);
    return execution.chain.done.promise;
  }
  steer(handle: ComputerSubagentHandle, prompt: string): Promise<ComputerSubagentRuntimeHandle> {
    const execution = this.execution(handle);
    // Returning the existing promise would acknowledge a second prompt even
    // though only the first queued prompt can seed the successor. Fail closed
    // so the caller can retry against that successor instead of losing text.
    if (execution.steerPromise) {
      throw new ComputerSubagentStateError(handle.childId, "is already steering; retry after its successor starts");
    }
    this.manager.queueSteer(handle, prompt);
    execution.steering = true; execution.interruptRequested = true;
    execution.abortController.abort();
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
      abortController: new AbortController(), targetReleased: false, targetReleasePromise: null,
    };
    this.executions.set(execution.handle.childId, execution);
    this.publishMonitor(created.record);
    execution.settled = this.run(execution);
    return { ...execution.handle, done: chain.done.promise };
  }
  private async run(execution: Execution): Promise<ComputerSubagentCompletion | null> {
    this.publishMonitor(this.manager.markRunning(execution.handle));
    const acquirePromise = Promise.resolve().then(() => this.acquireTarget(
      execution.handle,
      cloneParent(execution.input.parent),
      execution.abortController.signal,
    ));
    const acquired = await this.racePhase(execution, acquirePromise, this.operationTimeoutMs);
    if (!acquired.ok) {
      this.cleanupLateAcquire(execution, acquirePromise);
      const contained = await this.quarantine(execution);
      return this.finishInterruptedPhase(execution, "target acquisition", acquired, contained);
    }
    execution.target = acquired.value;
    if (acquired.value.targetKey !== execution.input.target.targetKey || acquired.value.targetGeneration !== execution.input.target.targetGeneration) {
      return this.finish(execution, { status: "failed", error: "acquired target identity does not match the leased target" }, true);
    }
    if (execution.abortRequested && !execution.steering) {
      return this.finish(execution, { status: "aborted", reason: "aborted before provider launch" }, true);
    }
    if (!(await this.parentCurrent(execution.input.parent))) {
      execution.abortController.abort();
      return this.finish(execution, { status: "aborted", reason: "parent generation is no longer current before provider launch" }, true);
    }

    const launchPromise = Promise.resolve().then(() => this.provider.launch({
      childId: execution.handle.childId,
      parent: cloneParent(execution.input.parent),
      model: cloneModel(execution.input.operatorModel),
      prompt: execution.input.prompt,
      target: acquired.value,
      signal: execution.abortController.signal,
    }));
    const launched = await this.racePhase(execution, launchPromise, this.operationTimeoutMs);
    if (!launched.ok) {
      this.cleanupLateLaunch(execution, launchPromise);
      const contained = await this.quarantine(execution);
      return this.finishInterruptedPhase(execution, "provider launch", launched, contained);
    }
    execution.child = launched.value;
    if (execution.interruptRequested) {
      const cleaned = await this.stopChild(execution, launched.value);
      const contained = cleaned || await this.quarantine(execution);
      return this.finish(execution, contained
        ? { status: "aborted", reason: execution.steering ? "interrupted for steer" : "aborted by caller" }
        : { status: "unknown", error: "provider child cleanup could not be proven after interruption" }, contained);
    }

    execution.acceptingActions = this.manager.get(execution.handle.childId)?.status === "running";
    const outcomeResult = await this.racePhase(execution, launched.value.completion, 0);
    execution.acceptingActions = false;
    if (!outcomeResult.ok) {
      const cleaned = await this.stopChild(execution, launched.value);
      const contained = cleaned || await this.quarantine(execution);
      return this.finishInterruptedPhase(execution, "provider completion", outcomeResult, contained);
    }
    const terminal = await this.bounded(launched.value.waitForTerminal(), this.cleanupTimeoutMs);
    if (!terminal.ok) {
      const contained = await this.quarantine(execution);
      return this.finish(execution, contained
        ? { status: "failed", error: `provider cleanup was quarantined: ${terminal.error ?? terminal.reason}` }
        : { status: "unknown", error: `provider cleanup did not settle: ${terminal.error ?? terminal.reason}` }, contained);
    }
    let outcome = outcomeResult.value;
    if (execution.abortRequested && !execution.steering && outcome.status !== "failed") outcome = { status: "aborted", reason: "aborted by caller" };
    return this.finish(execution, outcome, true);
  }
  private async racePhase<T>(execution: Execution, promise: Promise<T>, timeoutMs: number): Promise<PhaseResult<T>> {
    return new Promise((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let abortTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (result: PhaseResult<T>) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (abortTimer) clearTimeout(abortTimer);
        execution.abortController.signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => {
        abortTimer = setTimeout(() => finish({ ok: false, reason: "aborted" }), this.abortGraceMs);
        abortTimer.unref?.();
      };
      execution.abortController.signal.addEventListener("abort", onAbort, { once: true });
      if (execution.abortController.signal.aborted) onAbort();
      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          execution.abortController.abort();
          finish({ ok: false, reason: "timeout" });
        }, timeoutMs);
        timeout.unref?.();
      }
      void promise.then(
        (value) => finish({ ok: true, value }),
        (error) => finish({ ok: false, reason: "error", error: error instanceof Error ? error.message : String(error) }),
      );
    });
  }
  private async bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<PhaseResult<T>> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, reason: "timeout" });
      }, timeoutMs);
      timer.unref?.();
      void promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ ok: true, value });
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, reason: "error", error: error instanceof Error ? error.message : String(error) });
        },
      );
    });
  }
  private async parentCurrent(parent: ComputerSubagentParent): Promise<boolean> {
    let check: Promise<boolean>;
    try {
      check = Promise.resolve(this.isParentCurrent(cloneParent(parent))).then((value) => value === true, () => false);
    } catch {
      return false;
    }
    const result = await this.bounded(check, this.cleanupTimeoutMs);
    return result.ok && result.value;
  }
  private async quarantine(execution: Execution): Promise<boolean> {
    execution.acceptingActions = false;
    execution.abortController.abort();
    let quarantinePromise: Promise<void>;
    try {
      quarantinePromise = Promise.resolve(this.quarantineChild(execution.handle.childId, cloneParent(execution.input.parent)));
    } catch {
      return false;
    }
    void quarantinePromise.then(() => this.cleanupHeldExecution(execution), () => undefined);
    const result = await this.bounded(quarantinePromise, this.cleanupTimeoutMs);
    return result.ok;
  }
  private async stopChild(execution: Execution, child: ComputerSubagentProviderChild): Promise<boolean> {
    execution.acceptingActions = false;
    if (!execution.interruptPromise) execution.interruptPromise = Promise.resolve().then(() => child.interrupt());
    await this.bounded(execution.interruptPromise, this.cleanupTimeoutMs);
    const terminal = await this.bounded(Promise.resolve().then(() => child.waitForTerminal()), this.cleanupTimeoutMs);
    return terminal.ok;
  }
  private cleanupLateAcquire(execution: Execution, promise: Promise<ComputerSubagentCapabilityDescriptor>): void {
    void promise.then(async (target) => {
      execution.target = target;
      await this.releaseCapability(execution);
      this.releaseHeldManagerLease(execution);
    }, () => this.releaseHeldManagerLease(execution));
  }
  private cleanupLateLaunch(execution: Execution, promise: Promise<ComputerSubagentProviderChild>): void {
    void promise.then(async (child) => {
      execution.child = child;
      const cleaned = await this.stopChild(execution, child);
      if (!cleaned && !(await this.quarantine(execution))) return;
      await this.cleanupHeldExecution(execution);
    }, async () => this.cleanupHeldExecution(execution));
  }
  private async cleanupHeldExecution(execution: Execution): Promise<void> {
    if (!(await this.releaseCapability(execution))) return;
    this.releaseHeldManagerLease(execution);
  }
  private async releaseCapability(execution: Execution): Promise<boolean> {
    const target = execution.target;
    if (!target || execution.targetReleased) return true;
    if (!execution.targetReleasePromise) {
      execution.targetReleasePromise = Promise.resolve().then(() => this.releaseTarget(
        execution.handle.childId,
        cloneParent(execution.input.parent),
        target,
      )).then(() => {
        execution.targetReleased = true;
        this.releaseHeldManagerLease(execution);
      });
    }
    const result = await this.bounded(execution.targetReleasePromise, this.cleanupTimeoutMs);
    if (!result.ok && result.reason === "error") execution.targetReleasePromise = null;
    return result.ok;
  }
  private releaseHeldManagerLease(execution: Execution): void {
    const record = this.manager.get(execution.handle.childId);
    if (!record?.leaseHeld || !COMPUTER_SUBAGENT_TERMINAL_STATUSES.has(record.status)) return;
    try {
      this.manager.release(execution.handle);
      execution.released = true;
      const released = this.manager.get(execution.handle.childId);
      if (released) this.publishMonitor(released);
      this.executions.delete(execution.handle.childId);
    } catch { /* stale owner stays fail-closed */ }
  }
  private finishInterruptedPhase(
    execution: Execution,
    phase: string,
    result: Exclude<PhaseResult<never>, { ok: true }>,
    contained: boolean,
  ): Promise<ComputerSubagentCompletion | null> {
    const detail = result.error ?? result.reason;
    if (contained) {
      return this.finish(execution, execution.abortRequested || execution.steering
        ? { status: "aborted", reason: `${phase} cancelled: ${detail}` }
        : { status: "failed", error: `${phase} failed: ${detail}` }, true);
    }
    return this.finish(execution, { status: "unknown", error: `${phase} cleanup could not be proven: ${detail}` }, false);
  }
  private async runSteer(execution: Execution): Promise<ComputerSubagentRuntimeHandle> {
    await this.interruptIfAvailable(execution);
    const predecessor = await execution.settled;
    if (execution.abortRequested) { await this.deliverFinal(execution.chain, predecessor); throw new ComputerSubagentStateError(execution.handle.childId, "was aborted before steer successor launch"); }
    if (!predecessor || predecessor.status === "unknown" || !execution.released) {
      await this.deliverFinal(execution.chain, predecessor);
      throw new ComputerSubagentStateError(execution.handle.childId, "cleanup was not proven; steer successor is fenced");
    }
    if (!(await this.parentCurrent(execution.input.parent))) {
      await this.deliverFinal(execution.chain, predecessor);
      throw new ComputerSubagentStateError(execution.handle.childId, "parent generation is stale; steer successor is fenced");
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
    await this.bounded(execution.interruptPromise, this.cleanupTimeoutMs);
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
      else if (!(await this.parentCurrent(execution.input.parent))) {
        status = "aborted";
        error = "parent generation is no longer current before final screenshot";
        output = undefined;
      }
      else try {
        const captured = await this.bounded(this.captureFinalScreenshot({
          childId: execution.handle.childId,
          parent: cloneParent(execution.input.parent),
          target: execution.target,
          signal: execution.abortController.signal,
        }), this.operationTimeoutMs);
        if (!captured.ok) throw new Error(captured.error ?? captured.reason);
        finalScreenshot = validateScreenshot(captured.value);
      } catch (captureError) {
        status = execution.abortController.signal.aborted ? "aborted" : "failed";
        error = execution.abortController.signal.aborted
          ? "aborted during final screenshot"
          : `final screenshot failed: ${captureError instanceof Error ? captureError.message : String(captureError)}`;
        output = undefined;
      }
    }
    let capabilityReleased = !execution.target;
    if (cleanupProven && execution.target) {
      capabilityReleased = await this.releaseCapability(execution);
      if (!capabilityReleased) { status = "unknown"; error = "target capability release failed or timed out"; }
    }
    execution.terminalized = true;
    let record = status === "completed" ? this.manager.complete(execution.handle)
      : status === "failed" ? this.manager.fail(execution.handle, error ?? "provider failed")
        : status === "aborted" ? this.manager.abort(execution.handle, error ?? "aborted")
          : this.manager.markUnknown(execution.handle, error ?? "unknown provider result");
    this.publishMonitor(record);
    if (cleanupProven && capabilityReleased) {
      this.manager.release(execution.handle); execution.released = true;
      record = this.manager.get(execution.handle.childId) ?? record;
      this.publishMonitor(record);
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
    if (completion && !chain.callbackDelivered && await this.parentCurrent(completion.parent)) {
      chain.callbackDelivered = true;
      await this.bounded(Promise.resolve().then(() => this.onComplete(completion)), this.cleanupTimeoutMs);
    }
    chain.resolved = true; chain.done.resolve(completion);
  }
  async releaseAfterCleanup(handle: ComputerSubagentHandle): Promise<void> {
    const execution = this.execution(handle);
    if (!execution.terminalized) throw new ComputerSubagentStateError(handle.childId, "is not terminal");
    if (execution.target && !(await this.releaseCapability(execution))) throw new ComputerSubagentStateError(handle.childId, "target capability cleanup is not proven");
    this.releaseHeldManagerLease(execution);
  }
  private execution(handle: ComputerSubagentHandle): Execution {
    const execution = this.executions.get(handle.childId);
    if (!execution || execution.handle.ownerToken !== handle.ownerToken) throw new ComputerSubagentOwnershipError(handle.childId);
    return execution;
  }
  private async currentOwnedExecution(handle: ComputerSubagentHandle, parent: ComputerSubagentParent): Promise<Execution> {
    let execution = this.execution(handle);
    if (!this.sameParent(execution.input.parent, parent)) throw new ComputerSubagentOwnershipError(handle.childId);
    if (!(await this.parentCurrent(parent))) throw new ComputerSubagentOwnershipError(handle.childId);
    // Recheck ownership and the exact parent after the asynchronous current
    // generation fence so a terminal/replacement race cannot be resumed.
    execution = this.execution(handle);
    if (!this.sameParent(execution.input.parent, parent)) throw new ComputerSubagentOwnershipError(handle.childId);
    return execution;
  }
  private sameParent(a: ComputerSubagentParent, b: ComputerSubagentParent): boolean {
    return a.botId === b.botId && a.threadId === b.threadId && a.turnId === b.turnId && a.generation === b.generation;
  }
  private requireHumanHandoffMutable(execution: Execution): void {
    if (execution.abortRequested || execution.steering || execution.terminalized) {
      throw new ComputerSubagentStateError(execution.handle.childId, "cannot change human handoff while stopping");
    }
  }
  private publishMonitor(record: ComputerSubagentRecord): ComputerChildMonitor {
    const parent = Object.freeze({
      botId: record.parent.botId,
      threadId: record.parent.threadId,
      turnId: record.parent.turnId,
    });
    const monitor: ComputerChildMonitor = Object.freeze({
      childId: record.childId,
      parent,
      status: record.status,
      actionCount: record.actionCount,
      actionLimit: MAX_COMPUTER_SUBAGENT_ACTIONS,
      leaseHeld: record.leaseHeld,
      createdAt: record.createdAt,
      ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    });
    try { this.onMonitorChange?.(monitor); } catch { /* observation cannot break execution */ }
    return monitor;
  }
  private validTimeout(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) throw new TypeError(`${label} must be a positive bounded safe integer`);
    return value;
  }
}
