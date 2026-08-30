import { newId, type ModelSelection } from "./contracts.ts";

/** The hard action ceiling for one computer-use child runtime. */
export const MAX_COMPUTER_SUBAGENT_ACTIONS = 9;

/** A parent identity is deliberately stronger than botId alone. A stale
 * completion from an older turn must never affect a newer turn of the same
 * bot. */
export interface ComputerSubagentParent {
  botId: string;
  threadId: string;
  turnId: string;
  generation: number;
}

export interface ComputerSubagentStartInput {
  parent: ComputerSubagentParent;
  targetKey: string;
  targetGeneration: string;
  operatorModel?: ModelSelection;
  /** Tests and deterministic callers may provide the runtime id. Production
   * callers should omit it and use the generated id. */
  childId?: string;
}

export type ComputerSubagentStatus =
  | "queued"
  | "running"
  | "waiting-on-human"
  | "completed"
  | "failed"
  | "aborted"
  | "unknown";

export const COMPUTER_SUBAGENT_TERMINAL_STATUSES: ReadonlySet<ComputerSubagentStatus> = new Set([
  "completed",
  "failed",
  "aborted",
  "unknown",
]);

export interface ComputerSubagentRecord {
  childId: string;
  parent: ComputerSubagentParent;
  targetKey: string;
  targetGeneration: string;
  operatorModel?: ModelSelection;
  status: ComputerSubagentStatus;
  actionCount: number;
  pendingSteerCount: number;
  leaseHeld: boolean;
  createdAt: number;
  finishedAt?: number;
  error?: string;
}

export interface ComputerSubagentHandle {
  childId: string;
  /** Opaque capability for the child owner. It is required for every
   * mutation so an old child cannot release or complete a successor. */
  ownerToken: string;
}

export class ComputerSubagentTargetBusyError extends Error {
  constructor(targetKey: string) {
    super(`Computer target is already leased: ${targetKey}`);
    this.name = "ComputerSubagentTargetBusyError";
  }
}

export class ComputerSubagentOwnershipError extends Error {
  constructor(childId: string) {
    super(`Computer subagent owner is stale or invalid: ${childId}`);
    this.name = "ComputerSubagentOwnershipError";
  }
}

export class ComputerSubagentStateError extends Error {
  constructor(childId: string, message: string) {
    super(`Computer subagent ${childId} ${message}`);
    this.name = "ComputerSubagentStateError";
  }
}

export class ComputerSubagentActionBudgetError extends Error {
  constructor(childId: string, requested: number, remaining: number) {
    super(
      `Computer subagent ${childId} action budget exceeded: requested ${requested}, `
      + `only ${remaining} action${remaining === 1 ? "" : "s"} remaining`,
    );
    this.name = "ComputerSubagentActionBudgetError";
  }
}

interface MutableRecord extends ComputerSubagentRecord {
  ownerToken: string;
  pendingSteer: string[];
}

function cloneParent(parent: ComputerSubagentParent): ComputerSubagentParent {
  return { ...parent };
}

function cloneModel(model: ModelSelection | undefined): ModelSelection | undefined {
  return model ? { ...model } : undefined;
}

function snapshot(record: MutableRecord): ComputerSubagentRecord {
  const result: ComputerSubagentRecord = {
    childId: record.childId,
    parent: cloneParent(record.parent),
    targetKey: record.targetKey,
    targetGeneration: record.targetGeneration,
    operatorModel: cloneModel(record.operatorModel),
    status: record.status,
    actionCount: record.actionCount,
    pendingSteerCount: record.pendingSteer.length,
    leaseHeld: record.leaseHeld,
    createdAt: record.createdAt,
  };
  if (record.finishedAt !== undefined) result.finishedAt = record.finishedAt;
  if (record.error !== undefined) result.error = record.error;
  return result;
}

function assertText(value: string, name: string): void {
  if (value.trim().length === 0) throw new TypeError(`${name} must be non-empty`);
}

function assertParent(parent: ComputerSubagentParent): void {
  assertText(parent.botId, "parent.botId");
  assertText(parent.threadId, "parent.threadId");
  assertText(parent.turnId, "parent.turnId");
  if (!Number.isSafeInteger(parent.generation) || parent.generation < 0) {
    throw new TypeError("parent.generation must be a non-negative integer");
  }
}

export interface ComputerSubagentStartResult {
  handle: ComputerSubagentHandle;
  record: ComputerSubagentRecord;
}

/**
 * In-memory lifecycle authority for one computer-use child per target.
 *
 * This module intentionally has no provider or Store integration yet. Its
 * synchronous methods make target acquisition and generation checks atomic
 * within the server event loop; the integration layer can attach provider
 * cleanup and persistence without duplicating this safety boundary.
 */
export class ComputerSubagentManager {
  private readonly records = new Map<string, MutableRecord>();
  private readonly targetLeases = new Map<string, string>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Acquire one target and create a queued child. Acquisition and record
   * insertion happen synchronously, so two callers cannot claim the target. */
  start(input: ComputerSubagentStartInput): ComputerSubagentStartResult {
    assertParent(input.parent);
    assertText(input.targetKey, "targetKey");
    assertText(input.targetGeneration, "targetGeneration");
    if (input.operatorModel) {
      assertText(input.operatorModel.instanceId, "operatorModel.instanceId");
      assertText(input.operatorModel.model, "operatorModel.model");
    }
    if (this.targetLeases.has(input.targetKey)) throw new ComputerSubagentTargetBusyError(input.targetKey);

    const childId = input.childId ?? newId();
    if (this.records.has(childId)) throw new ComputerSubagentStateError(childId, "already exists");
    const record: MutableRecord = {
      childId,
      parent: cloneParent(input.parent),
      targetKey: input.targetKey,
      targetGeneration: input.targetGeneration,
      operatorModel: cloneModel(input.operatorModel),
      status: "queued",
      actionCount: 0,
      pendingSteer: [],
      pendingSteerCount: 0,
      leaseHeld: true,
      ownerToken: newId(),
      createdAt: this.now(),
    };
    this.records.set(childId, record);
    this.targetLeases.set(input.targetKey, childId);
    return { handle: { childId, ownerToken: record.ownerToken }, record: snapshot(record) };
  }

  get(childId: string): ComputerSubagentRecord | null {
    const record = this.records.get(childId);
    return record ? snapshot(record) : null;
  }

  list(): ComputerSubagentRecord[] {
    return [...this.records.values()].map(snapshot);
  }

  markRunning(handle: ComputerSubagentHandle): ComputerSubagentRecord {
    const record = this.owned(handle);
    this.requireStatus(record, "queued");
    record.status = "running";
    return snapshot(record);
  }

  /** Pause action dispatch while the human owns the computer. */
  markWaitingOnHuman(handle: ComputerSubagentHandle): ComputerSubagentRecord {
    const record = this.owned(handle);
    this.requireStatus(record, "running");
    record.status = "waiting-on-human";
    return snapshot(record);
  }

  markRunningAfterHuman(handle: ComputerSubagentHandle): ComputerSubagentRecord {
    const record = this.owned(handle);
    this.requireStatus(record, "waiting-on-human");
    record.status = "running";
    return snapshot(record);
  }

  /** Consume a number of individual GUI actions. Over-budget requests are
   * rejected before mutation; they are never silently truncated. */
  consumeActions(handle: ComputerSubagentHandle, amount = 1): number {
    const record = this.owned(handle);
    this.requireStatus(record, "running");
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new TypeError("action amount must be a positive integer");
    const remaining = MAX_COMPUTER_SUBAGENT_ACTIONS - record.actionCount;
    if (amount > remaining) throw new ComputerSubagentActionBudgetError(record.childId, amount, remaining);
    record.actionCount += amount;
    return record.actionCount;
  }

  /** Queue steering text for a later non-overlapping child turn. This method
   * never starts another runtime while the current one is active. */
  queueSteer(handle: ComputerSubagentHandle, prompt: string): number {
    const record = this.owned(handle);
    if (record.status !== "queued" && record.status !== "running" && record.status !== "waiting-on-human") {
      throw new ComputerSubagentStateError(record.childId, `cannot queue steer while ${record.status}`);
    }
    assertText(prompt, "steer prompt");
    if (prompt.length > 20_000) throw new RangeError("steer prompt is too long");
    record.pendingSteer.push(prompt);
    record.pendingSteerCount = record.pendingSteer.length;
    return record.pendingSteer.length;
  }

  /** A queued steer may only be handed to a successor after the current
   * runtime is terminal. The caller must release this handle and acquire a
   * fresh child before launching that successor. */
  takeQueuedSteer(handle: ComputerSubagentHandle): string | null {
    const record = this.owned(handle);
    if (!COMPUTER_SUBAGENT_TERMINAL_STATUSES.has(record.status)) {
      throw new ComputerSubagentStateError(record.childId, "is still active; steer cannot overlap it");
    }
    const prompt = record.pendingSteer.shift() ?? null;
    record.pendingSteerCount = record.pendingSteer.length;
    return prompt;
  }

  complete(handle: ComputerSubagentHandle): ComputerSubagentRecord {
    return this.finish(handle, "completed");
  }

  fail(handle: ComputerSubagentHandle, error: string): ComputerSubagentRecord {
    assertText(error, "error");
    return this.finish(handle, "failed", error.slice(0, 500));
  }

  markUnknown(handle: ComputerSubagentHandle, error = "child runtime ended without a terminal result"): ComputerSubagentRecord {
    assertText(error, "error");
    return this.finish(handle, "unknown", error.slice(0, 500));
  }

  abort(handle: ComputerSubagentHandle, reason = "aborted"): ComputerSubagentRecord {
    assertText(reason, "abort reason");
    return this.finish(handle, "aborted", reason.slice(0, 500));
  }

  /** Abort every active child belonging to this exact parent generation.
   * Older parent identities cannot cancel a successor generation. */
  cancelParent(parent: ComputerSubagentParent, reason = "parent turn cancelled"): string[] {
    assertParent(parent);
    assertText(reason, "cancel reason");
    const cancelled: string[] = [];
    for (const record of this.records.values()) {
      if (!this.sameParent(record.parent, parent) || COMPUTER_SUBAGENT_TERMINAL_STATUSES.has(record.status)) continue;
      this.finishRecord(record, "aborted", reason.slice(0, 500));
      cancelled.push(record.childId);
    }
    return cancelled;
  }

  /** Release only after provider/process and computer-action cleanup is
   * verified. The historical terminal record remains queryable, while the
   * target becomes available for a successor. */
  release(handle: ComputerSubagentHandle): void {
    const record = this.owned(handle);
    if (!COMPUTER_SUBAGENT_TERMINAL_STATUSES.has(record.status)) {
      throw new ComputerSubagentStateError(record.childId, `cannot release while ${record.status}`);
    }
    if (!record.leaseHeld || this.targetLeases.get(record.targetKey) !== record.childId) {
      throw new ComputerSubagentOwnershipError(record.childId);
    }
    record.leaseHeld = false;
    this.targetLeases.delete(record.targetKey);
  }

  private finish(handle: ComputerSubagentHandle, status: "completed" | "failed" | "unknown" | "aborted", error?: string): ComputerSubagentRecord {
    const record = this.owned(handle);
    if (COMPUTER_SUBAGENT_TERMINAL_STATUSES.has(record.status)) {
      throw new ComputerSubagentStateError(record.childId, `is already terminal (${record.status})`);
    }
    this.finishRecord(record, status, error);
    return snapshot(record);
  }

  private finishRecord(record: MutableRecord, status: "completed" | "failed" | "unknown" | "aborted", error?: string): void {
    record.status = status;
    record.finishedAt = this.now();
    if (error !== undefined) record.error = error;
  }

  private owned(handle: ComputerSubagentHandle): MutableRecord {
    const record = this.records.get(handle.childId);
    if (!record || record.ownerToken !== handle.ownerToken) throw new ComputerSubagentOwnershipError(handle.childId);
    return record;
  }

  private requireStatus(record: MutableRecord, expected: ComputerSubagentStatus): void {
    if (record.status !== expected) throw new ComputerSubagentStateError(record.childId, `must be ${expected}, got ${record.status}`);
  }

  private sameParent(a: ComputerSubagentParent, b: ComputerSubagentParent): boolean {
    return a.botId === b.botId
      && a.threadId === b.threadId
      && a.turnId === b.turnId
      && a.generation === b.generation;
  }
}
