import type {
  ComputerSubagentHandle,
  ComputerSubagentManager,
  ComputerSubagentParent,
  ComputerSubagentRecord,
} from "./computer-subagent-manager.ts";
import { COMPUTER_SUBAGENT_TERMINAL_STATUSES, ComputerSubagentOwnershipError, ComputerSubagentStateError } from "./computer-subagent-manager.ts";
import type { ModelSelection } from "./contracts.ts";

/** A selected target plus a harness-owned capability. The capability is
 * intentionally opaque here: this runtime never reads, logs, persists, or
 * turns it into provider credentials. */
export interface ComputerSubagentCapabilityDescriptor {
  targetKey: string;
  targetGeneration: string;
  readonly opaqueCapability: unknown;
  boxId?: string;
}

export type ComputerSubagentProviderOutcome =
  | { status: "completed"; output?: string }
  | { status: "failed"; error: string }
  | { status: "aborted"; reason?: string };

type FinishOutcome = ComputerSubagentProviderOutcome | { status: "unknown"; error: string };

/** The only provider-facing input. In particular, there is no API key or
 * upstream endpoint in this contract; the harness interprets the opaque
 * scoped capability descriptor. */
export interface ComputerSubagentProviderLaunchInput {
  childId: string;
  parent: ComputerSubagentParent;
  model: ModelSelection;
  prompt: string;
  target: ComputerSubagentCapabilityDescriptor;
  /** Called by the provider adapter for each individual GUI action or batch. */
  onActions: (amount?: number) => number;
}

export interface ComputerSubagentProviderChild {
  /** Provider terminal result. Cleanup is a separate promise so callers can
   * prove that a remote action/process has settled before releasing a lease. */
  completion: Promise<ComputerSubagentProviderOutcome>;
  waitForTerminal: () => Promise<void>;
  interrupt: () => Promise<void>;
}

export interface ComputerSubagentProviderRuntime {
  launch: (input: ComputerSubagentProviderLaunchInput) => Promise<ComputerSubagentProviderChild>;
}

export interface ComputerSubagentCompletion {
  childId: string;
  parent: ComputerSubagentParent;
  status: "completed" | "failed" | "aborted" | "unknown";
  record: ComputerSubagentRecord;
  finalScreenshotCaptured: boolean;
  output?: string;
  error?: string;
}

export interface ComputerSubagentRuntimeOptions {
  manager: ComputerSubagentManager;
  provider: ComputerSubagentProviderRuntime;
  /** Must resolve before a successful completion is delivered. */
  captureFinalScreenshot: (input: {
    childId: string;
    parent: ComputerSubagentParent;
    target: ComputerSubagentCapabilityDescriptor;
  }) => Promise<void>;
  /** Invoked at most once per child, after final screenshot capture and state transition. */
  onComplete: (completion: ComputerSubagentCompletion) => void | Promise<void>;
}

export interface ComputerSubagentRuntimeStartInput {
  parent: ComputerSubagentParent;
  target: ComputerSubagentCapabilityDescriptor;
  operatorModel: ModelSelection;
  prompt: string;
  childId?: string;
}

export interface ComputerSubagentRuntimeHandle extends ComputerSubagentHandle {
  done: Promise<ComputerSubagentCompletion | null>;
}

interface Execution {
  handle: ComputerSubagentHandle;
  input: ComputerSubagentRuntimeStartInput;
  child: ComputerSubagentProviderChild | null;
  done: Promise<ComputerSubagentCompletion | null>;
  interruptPromise: Promise<void> | null;
  abortRequested: boolean;
  terminalized: boolean;
  released: boolean;
  callbackDelivered: boolean;
  steerPromise: Promise<ComputerSubagentRuntimeHandle> | null;
}

function cloneParent(parent: ComputerSubagentParent): ComputerSubagentParent {
  return { ...parent };
}

function cloneModel(model: ModelSelection): ModelSelection {
  return { ...model };
}

/**
 * Provider-runtime composition layer for one dedicated Qwen computer-use
 * child. It owns no Store/index integration and deliberately delegates all
 * lease/state authority to ComputerSubagentManager.
 */
export class ComputerSubagentRuntime {
  private readonly manager: ComputerSubagentManager;
  private readonly provider: ComputerSubagentProviderRuntime;
  private readonly captureFinalScreenshot: ComputerSubagentRuntimeOptions["captureFinalScreenshot"];
  private readonly onComplete: ComputerSubagentRuntimeOptions["onComplete"];
  private readonly executions = new Map<string, Execution>();

  constructor(options: ComputerSubagentRuntimeOptions) {
    this.manager = options.manager;
    this.provider = options.provider;
    this.captureFinalScreenshot = options.captureFinalScreenshot;
    this.onComplete = options.onComplete;
  }

  /** Acquires the manager lease synchronously, then launches the provider in
   * the background. A caller can abort immediately while launch is pending. */
  start(input: ComputerSubagentRuntimeStartInput): ComputerSubagentRuntimeHandle {
    if (input.target.targetKey.trim().length === 0) throw new TypeError("target.targetKey must be non-empty");
    if (input.target.targetGeneration.trim().length === 0) throw new TypeError("target.targetGeneration must be non-empty");
    const created = this.manager.start({
      parent: input.parent,
      targetKey: input.target.targetKey,
      targetGeneration: input.target.targetGeneration,
      operatorModel: input.operatorModel,
      childId: input.childId,
    });
    const execution: Execution = {
      handle: created.handle,
      input: {
        parent: cloneParent(input.parent),
        target: input.target,
        operatorModel: cloneModel(input.operatorModel),
        prompt: input.prompt,
      },
      child: null,
      done: Promise.resolve(null),
      interruptPromise: null,
      abortRequested: false,
      terminalized: false,
      released: false,
      callbackDelivered: false,
      steerPromise: null,
    };
    execution.done = this.run(execution);
    this.executions.set(execution.handle.childId, execution);
    return { ...execution.handle, done: execution.done };
  }

  async abort(handle: ComputerSubagentHandle): Promise<ComputerSubagentCompletion | null> {
    const execution = this.execution(handle);
    if (execution.terminalized) return execution.done;
    execution.abortRequested = true;
    await this.interrupt(execution);
    return execution.done;
  }

  /** Queue a steer, interrupt the current provider child, and launch one
   * successor only after the old child has fully settled and released its
   * target lease. */
  steer(handle: ComputerSubagentHandle, prompt: string): Promise<ComputerSubagentRuntimeHandle> {
    const execution = this.execution(handle);
    if (execution.steerPromise) return execution.steerPromise;
    this.manager.queueSteer(handle, prompt);
    execution.steerPromise = this.runSteer(execution);
    return execution.steerPromise;
  }

  /** Parent cancellation is exact-generation scoped and waits for every
   * matching child to finish cleanup. */
  async cancelParent(parent: ComputerSubagentParent): Promise<string[]> {
    const executions = [...this.executions.values()].filter((execution) => {
      const record = this.manager.get(execution.handle.childId);
      return record?.parent.botId === parent.botId
        && record.parent.threadId === parent.threadId
        && record.parent.turnId === parent.turnId
        && record.parent.generation === parent.generation
        && !COMPUTER_SUBAGENT_TERMINAL_STATUSES.has(record.status);
    });
    await Promise.all(executions.map((execution) => this.abort(execution.handle)));
    return executions.map((execution) => execution.handle.childId);
  }

  private async run(execution: Execution): Promise<ComputerSubagentCompletion | null> {
    let providerChild: ComputerSubagentProviderChild | null = null;
    let outcome: ComputerSubagentProviderOutcome | null = null;
    let launchError: string | null = null;
    try {
      this.manager.markRunning(execution.handle);
      providerChild = await this.provider.launch({
        childId: execution.handle.childId,
        parent: cloneParent(execution.input.parent),
        model: cloneModel(execution.input.operatorModel),
        prompt: execution.input.prompt,
        target: execution.input.target,
        onActions: (amount = 1) => this.manager.consumeActions(execution.handle, amount),
      });
      execution.child = providerChild;
      if (execution.abortRequested) await this.interrupt(execution);
      try {
        outcome = await providerChild.completion;
      } catch (error) {
        launchError = error instanceof Error ? error.message : String(error);
      }
    } catch (error) {
      launchError = error instanceof Error ? error.message : String(error);
    }

    if (providerChild) {
      try {
        await providerChild.waitForTerminal();
      } catch (error) {
        return this.finishUnknown(execution, `provider cleanup did not settle: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (launchError) {
      return execution.abortRequested
        ? this.finishOutcome(execution, { status: "aborted", reason: launchError })
        : this.finishOutcome(execution, { status: "failed", error: launchError });
    }
    if (!outcome) return this.finishUnknown(execution, "provider ended without a terminal result");
    if (execution.abortRequested && outcome.status !== "failed") {
      return this.finishOutcome(execution, { status: "aborted", reason: "aborted by caller" });
    }
    return this.finishOutcome(execution, outcome);
  }

  private async runSteer(execution: Execution): Promise<ComputerSubagentRuntimeHandle> {
    await this.interrupt(execution);
    await execution.done;
    if (execution.abortRequested) throw new ComputerSubagentStateError(execution.handle.childId, "was aborted before steer successor launch");
    const prompt = this.manager.takeQueuedSteer(execution.handle);
    if (!prompt) throw new ComputerSubagentStateError(execution.handle.childId, "has no queued steer");
    const record = this.manager.get(execution.handle.childId);
    if (!record) throw new ComputerSubagentOwnershipError(execution.handle.childId);
    return this.start({
      parent: record.parent,
      target: execution.input.target,
      operatorModel: record.operatorModel ?? execution.input.operatorModel,
      prompt,
    });
  }

  private async interrupt(execution: Execution): Promise<void> {
    if (execution.interruptPromise) return execution.interruptPromise;
    execution.interruptPromise = execution.child
      ? execution.child.interrupt().catch(() => undefined)
      : Promise.resolve();
    return execution.interruptPromise;
  }

  private finishUnknown(execution: Execution, error: string): Promise<ComputerSubagentCompletion | null> {
    return this.finishOutcome(execution, { status: "unknown", error }, false);
  }

  private async finishOutcome(
    execution: Execution,
    outcome: FinishOutcome,
    cleanupProven = true,
  ): Promise<ComputerSubagentCompletion | null> {
    if (execution.terminalized) return null;
    const current = this.manager.get(execution.handle.childId);
    if (!current || current.leaseHeld === false || COMPUTER_SUBAGENT_TERMINAL_STATUSES.has(current.status)) {
      execution.terminalized = true;
      this.executions.delete(execution.handle.childId);
      return null;
    }

    let finalScreenshotCaptured = false;
    let status: "completed" | "failed" | "aborted" | "unknown";
    let output: string | undefined;
    let error: string | undefined;
    if (outcome.status === "completed") {
      try {
        await this.captureFinalScreenshot({
          childId: execution.handle.childId,
          parent: cloneParent(execution.input.parent),
          target: execution.input.target,
        });
        finalScreenshotCaptured = true;
        status = "completed";
        output = outcome.output;
      } catch (captureError) {
        status = "failed";
        error = `final screenshot failed: ${captureError instanceof Error ? captureError.message : String(captureError)}`;
      }
    } else {
      status = outcome.status;
      if (outcome.status === "failed") error = outcome.error;
      if (outcome.status === "aborted") error = outcome.reason;
    }

    execution.terminalized = true;
    const record = status === "completed"
      ? this.manager.complete(execution.handle)
      : status === "failed"
        ? this.manager.fail(execution.handle, error ?? "provider failed")
        : status === "aborted"
          ? this.manager.abort(execution.handle, error ?? "aborted")
          : this.manager.markUnknown(execution.handle, error ?? "unknown provider result");
    const completion: ComputerSubagentCompletion = {
      childId: execution.handle.childId,
      parent: cloneParent(execution.input.parent),
      status,
      record,
      finalScreenshotCaptured,
    };
    if (output !== undefined) completion.output = output;
    if (error !== undefined) completion.error = error;
    if (!execution.callbackDelivered) {
      execution.callbackDelivered = true;
      try {
        await this.onComplete(completion);
      } catch {
        // Completion delivery cannot keep a verified terminal target leased.
      }
    }
    if (cleanupProven) {
      this.manager.release(execution.handle);
      execution.released = true;
      this.executions.delete(execution.handle.childId);
    }
    return completion;
  }

  /** Fail-closed recovery hook: an integration that later proves the child
   * process/action has settled may release an `unknown` lease explicitly. */
  releaseAfterCleanup(handle: ComputerSubagentHandle): void {
    const execution = this.execution(handle);
    if (!execution.terminalized) throw new ComputerSubagentStateError(handle.childId, "is not terminal");
    this.manager.release(handle);
    execution.released = true;
    this.executions.delete(handle.childId);
  }

  private execution(handle: ComputerSubagentHandle): Execution {
    const execution = this.executions.get(handle.childId);
    if (!execution || execution.handle.ownerToken !== handle.ownerToken) throw new ComputerSubagentOwnershipError(handle.childId);
    return execution;
  }
}
