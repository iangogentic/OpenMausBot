// Async peer handoff (delegate_bot).
//
// A bot that finishes one task can hand the NEXT task to a peer without
// blocking its own turn — the source bot's turn.completed fires after it
// settles, and the queued delegation runs then. The peer gets a fresh
// depth-1 turn (depth cap still blocks A→B→C chains, see index.ts).
//
// Visiblity rides on the same comms-visibility helpers ask_bot uses
// (channel mirror + 1:1 chips) so a delegated exchange looks like an
// exchanged one. The optional approval gate (A2) is checked at drain
// time, never at queue time, because the user might have just turned
// approvePeerComms on between queueing and draining.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { getOrCreateChannel, mirrorExchange, type CommsBus } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import { cancelPeerApprovalsFor, requestPeerApproval, type ApprovalBus } from "./peer-approval.ts";
import { sectionKey, type BotRecord, type GroupRecord } from "./store.ts";

export interface DelegationItem {
  toBotId: string;
  message: string;
  reason?: string;
  /** The source bot's comms depth (0 for a user-initiated turn). The
   * delegated-to bot runs at `depth + 1`, which equals MAX_COMMS_DEPTH
   * (= 1) for a user turn — so the peer has no agents integration, and
   * recursive delegation is structurally impossible. */
  depth: number;
  /** Exact source dispatch. Production drains only after this generation's
   * successful terminal event, never after a later turn or process restart. */
  sourceGeneration?: string;
}

interface PendingDelegationItem extends DelegationItem {
  /** Stable acknowledgement key for crash-safe removal from the queue. */
  id: string;
  /** Immutable source authority. A thread id alone is not identity: queued
   * work must never be adopted by a different bot after an import/mutation. */
  sourceBotId?: string;
}

export type QueueResult = "ok" | "no_target" | "self" | "too_deep" | "too_many";

/** Per source-thread queue. Persisted to delegations.json on every change
 * and reloaded at boot: a handoff queued right before a restart runs after
 * it. (Provider PERMISSIONS still die with the process — nobody can answer
 * for an unattended bot — but queued work is not a permission; the target
 * and approvePeerComms are re-checked at drain time as always.) */
const pendingDelegations = new Map<string, PendingDelegationItem[]>();
const drainingThreads = new Set<string>();
const deferredDrainGenerations = new Map<string, string[]>();
// Stop is a generation change, not a one-time scan of whichever approval is
// visible at that instant. A serial drain can be between items when Stop is
// pressed; every item captures both endpoint epochs before the detached loop
// starts and re-checks after each await.
const cancellationEpochByBot = new Map<string, number>();
const drainPromisesBySourceBot = new Map<string, Set<Promise<void>>>();
const DELEGATIONS_FILE = join(DATA_DIR, "delegations.json");

interface DelegationFence {
  sourceBotId?: string;
  sourceEpoch: number;
  targetBotId: string;
  targetEpoch: number;
}

const cancellationEpoch = (botId: string | undefined): number =>
  botId ? cancellationEpochByBot.get(botId) ?? 0 : 0;

const delegationFenceCurrent = (fence: DelegationFence): boolean =>
  cancellationEpoch(fence.sourceBotId) === fence.sourceEpoch &&
  cancellationEpoch(fence.targetBotId) === fence.targetEpoch;

function savePending(): void {
  try {
    writeFileAtomic(DELEGATIONS_FILE, JSON.stringify(Object.fromEntries(pendingDelegations), null, 2), { mode: 0o600 });
  } catch (error) {
    console.error("delegations: could not persist queue", error);
  }
}

/** Load what a previous process left queued. Missing or corrupt → empty. */
export function _loadPending(): void {
  pendingDelegations.clear();
  try {
    const raw = JSON.parse(readFileSync(DELEGATIONS_FILE, "utf8")) as Record<string, unknown>;
    for (const [threadId, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      const items = list.flatMap((value): PendingDelegationItem[] => {
        if (!value || typeof value !== "object") return [];
        const item = value as Partial<PendingDelegationItem>;
        if (
          typeof item.toBotId !== "string" ||
          typeof item.message !== "string" ||
          !Number.isFinite(item.depth)
        ) return [];
        return [{
          id: typeof item.id === "string" && item.id ? item.id : newId(),
          ...(typeof item.sourceBotId === "string" && item.sourceBotId
            ? { sourceBotId: item.sourceBotId }
            : {}),
          toBotId: item.toBotId,
          message: item.message,
          ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
          depth: Math.max(0, Math.trunc(item.depth!)),
          ...(typeof item.sourceGeneration === "string" && item.sourceGeneration
            ? { sourceGeneration: item.sourceGeneration }
            : {}),
        }];
      });
      if (items.length) pendingDelegations.set(threadId, items);
    }
  } catch {
    /* fresh install, or unreadable — start empty */
  }
}

/** Source threads with something queued — what a boot drain iterates. */
export function pendingThreads(): string[] {
  return [...pendingDelegations.keys()];
}

/** Read-only metadata for the local Team Map. Task prompts stay private;
 * the UI only needs to know who handed work to whom and the optional label. */
export function pendingDelegationSnapshot(): Array<{
  sourceThreadId: string;
  toBotId: string;
  reason?: string;
}> {
  return [...pendingDelegations.entries()].flatMap(([sourceThreadId, items]) =>
    items.map((item) => ({
      sourceThreadId,
      toBotId: item.toBotId,
      ...(item.reason ? { reason: item.reason } : {}),
    })),
  );
}

/** How many handoffs one turn may queue. Small on purpose: this is the only
 * thing standing between a confused bot and a fan-out of real turns. */
const MAX_QUEUED_PER_THREAD = 4;

/** Validate and enqueue a delegation. Pushes a "Delegated to @B: reason"
 * chip to the source thread so the user can see what was queued. */
export function queueDelegation(
  bus: CommsBus,
  from: BotRecord,
  item: DelegationItem,
  maxDepth: number,
  sourceThreadId = from.threadId,
): QueueResult {
  if (item.toBotId === from.id) return "self";
  if (item.depth >= maxDepth) return "too_deep";
  const target = bus.store.bot(item.toBotId);
  if (!target) return "no_target";
  const list = pendingDelegations.get(sourceThreadId) ?? [];
  // Async handoff removes the backpressure that ask_bot got for free by
  // making the caller wait. Without a cap, one turn can queue unboundedly
  // and fan out into as many real turns on the next settle.
  if (list.length >= MAX_QUEUED_PER_THREAD) return "too_many";
  list.push({ ...item, id: newId(), sourceBotId: from.id });
  pendingDelegations.set(sourceThreadId, list);
  savePending();
  const label = `Delegated to @${target.name}${item.reason ? `: ${item.reason}` : ""}`;
  bus.store.appendMessage(sourceThreadId, {
    role: "bot",
    kind: "activity",
    tool: { name: label },
  });
  return "ok";
}

/** Drain queued delegations for a source thread (called on its
 * turn.completed). Each item is processed independently: a deny, a busy
 * target, or an error in one does not stop the rest. The actual start
 * of the target turn is delegated to `runTarget` so delegations.ts
 * stays free of harness-level concerns (commsDepth is the only thing
 * the caller needs). */
export function drainDelegations(
  bus: CommsBus,
  approvalBus: ApprovalBus,
  threadId: string,
  runTarget: (
    toBotId: string,
    message: string,
    commsDepth: number,
    sourceThreadId: string,
    channel?: GroupRecord,
  ) => void | Promise<void>,
  sourceGeneration?: string,
): void {
  if (drainingThreads.has(threadId)) {
    if (sourceGeneration !== undefined) {
      const deferred = deferredDrainGenerations.get(threadId) ?? [];
      if (!deferred.includes(sourceGeneration)) deferred.push(sourceGeneration);
      deferredDrainGenerations.set(threadId, deferred);
    }
    return;
  }
  const list = pendingDelegations.get(threadId);
  if (!list?.length) return;
  const snapshot = sourceGeneration === undefined
    ? [...list]
    : list.filter((item) => item.sourceGeneration === sourceGeneration);
  if (!snapshot.length) {
    // Legacy/orphaned entries have no proof that their source turn settled
    // successfully. Drop them instead of letting a later turn execute them.
    const retained = list.filter((item) => item.sourceGeneration !== undefined);
    if (retained.length) pendingDelegations.set(threadId, retained);
    else pendingDelegations.delete(threadId);
    savePending();
    return;
  }
  const fences = new Map(snapshot.map((item) => [item.id, {
    sourceBotId: item.sourceBotId,
    sourceEpoch: cancellationEpoch(item.sourceBotId),
    targetBotId: item.toBotId,
    targetEpoch: cancellationEpoch(item.toBotId),
  } satisfies DelegationFence]));
  drainingThreads.add(threadId);
  const work = (async () => {
    for (const item of snapshot) {
      try {
        await processOne(bus, approvalBus, threadId, item, runTarget, fences.get(item.id)!);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        try {
          bus.store.appendMessage(threadId, {
            role: "bot",
            kind: "activity",
            tool: { name: `error: delegation failed — ${why.slice(0, 120)}`, ok: false },
          });
        } catch (reportError) {
          console.error("delegation failed and could not be reported", reportError);
        }
      } finally {
        acknowledgeDelegation(threadId, item.id);
      }
    }
  })();
  const sourceBotIds = new Set(snapshot.flatMap((item) => item.sourceBotId ? [item.sourceBotId] : []));
  for (const botId of sourceBotIds) {
    const drains = drainPromisesBySourceBot.get(botId) ?? new Set<Promise<void>>();
    drains.add(work);
    drainPromisesBySourceBot.set(botId, drains);
  }
  void work.finally(() => {
    for (const botId of sourceBotIds) {
      const drains = drainPromisesBySourceBot.get(botId);
      drains?.delete(work);
      if (drains?.size === 0) drainPromisesBySourceBot.delete(botId);
    }
    drainingThreads.delete(threadId);
    const deferred = deferredDrainGenerations.get(threadId);
    const nextGeneration = deferred?.shift();
    if (deferred && deferred.length === 0) deferredDrainGenerations.delete(threadId);
    // A later turn may have settled while this one waited for approval. Its
    // exact generation was recorded above; drain only that proven turn.
    if (nextGeneration !== undefined) {
      drainDelegations(bus, approvalBus, threadId, runTarget, nextGeneration);
    } else if (sourceGeneration === undefined && pendingDelegations.get(threadId)?.length) {
      // Unit/legacy callers without generation ownership keep their original
      // in-memory behavior; production never enters this branch.
      drainDelegations(bus, approvalBus, threadId, runTarget);
    }
  }).catch(() => {});
}

/** Cancel every queued or currently-draining handoff that names a bot.
 * Source drains are awaited; target-only drains need not block because their
 * captured target epoch becomes invalid synchronously before this returns. */
export async function cancelDelegationsForBot(
  bus: CommsBus,
  botId: string,
  reason = "the source bot was stopped",
): Promise<void> {
  cancellationEpochByBot.set(botId, cancellationEpoch(botId) + 1);
  cancelPeerApprovalsFor(botId);
  let changed = false;
  for (const [threadId, list] of [...pendingDelegations]) {
    const cancelled = list.filter((item) => item.sourceBotId === botId || item.toBotId === botId);
    if (!cancelled.length) continue;
    const retained = list.filter((item) => item.sourceBotId !== botId && item.toBotId !== botId);
    if (retained.length) pendingDelegations.set(threadId, retained);
    else pendingDelegations.delete(threadId);
    for (const item of cancelled) reportDelegationCancellation(bus, threadId, item, reason);
    changed = true;
  }
  if (changed) savePending();
  const drains = [...(drainPromisesBySourceBot.get(botId) ?? [])];
  const settled = await Promise.allSettled(drains);
  const failures = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "delegation cancellation did not settle");
}

/** Remove one terminal handoff only after approval/dispatch has settled. */
function acknowledgeDelegation(threadId: string, itemId: string): void {
  const current = pendingDelegations.get(threadId);
  if (!current) return;
  const remaining = current.filter((item) => item.id !== itemId);
  if (remaining.length) pendingDelegations.set(threadId, remaining);
  else pendingDelegations.delete(threadId);
  savePending();
}

/** Drop a thread's queued handoffs without running them, telling the user
 * they were dropped. Used when the queueing turn failed or was interrupted. */
export function discardDelegations(bus: CommsBus, threadId: string): void {
  const list = pendingDelegations.get(threadId);
  if (!list?.length) return;
  pendingDelegations.delete(threadId);
  savePending();
  const from = bus.store.botByThread(threadId);
  if (!from) return;
  bus.store.appendMessage(threadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `${list.length} queued delegation${list.length > 1 ? "s" : ""} dropped — the turn did not finish`, ok: false },
  });
}

async function processOne(
  bus: CommsBus,
  approvalBus: ApprovalBus,
  sourceThreadId: string,
  item: PendingDelegationItem,
  runTarget: (
    toBotId: string,
    message: string,
    commsDepth: number,
    sourceThreadId: string,
    channel?: GroupRecord,
  ) => void | Promise<void>,
  fence: DelegationFence,
): Promise<void> {
  if (!delegationFenceCurrent(fence)) return;
  let route = liveDelegationRoute(bus, sourceThreadId, item);
  if (!route.ok) return reportDelegationCancellation(bus, sourceThreadId, item, route.reason);
  let { sender, target } = route;
  if (sender.approvePeerComms) {
    const verdict = await requestPeerApproval(
      approvalBus,
      sender,
      target,
      item.message,
      "delegate_bot",
      sourceThreadId,
    );
    if (!delegationFenceCurrent(fence)) return;
    // Approval may remain open for minutes. Re-read the immutable source
    // owner/task and both section memberships before interpreting the answer;
    // no stale approval may authorize a newly cross-section delegation.
    route = liveDelegationRoute(bus, sourceThreadId, item);
    if (!route.ok) return reportDelegationCancellation(bus, sourceThreadId, item, route.reason);
    ({ sender, target } = route);
    if (verdict !== "allow") {
      bus.store.appendMessage(sourceThreadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `Delegation to @${target.name} denied by user`, ok: false },
      });
      return;
    }
  }
  if (!delegationFenceCurrent(fence)) return;
  // liveDelegationRoute is deliberately the final operation before creating
  // visibility state or dispatching. getOrCreateChannel/mirror/runTarget are
  // synchronous up to the target handoff, so nothing authority-bearing sits
  // between this check and the work it authorizes.
  const channel = getOrCreateChannel(bus.store, sender, target);
  mirrorExchange(bus, sender, target, item.message, channel, sourceThreadId);
  const reasonLine = item.reason ? `\n\n[Reason: ${item.reason}]` : "";
  const prefixed = `[Delegated by @${sender.name}, another bot in this OpenMausBot workspace. Do the work and reply directly.]\n\n${item.message}${reasonLine}`;
  await runTarget(item.toBotId, prefixed, item.depth + 1, sourceThreadId, channel);
}

type LiveDelegationRoute =
  | { ok: true; sender: BotRecord; target: BotRecord }
  | { ok: false; reason: string };

/** Resolve queued authority from immutable ids, never from whichever bot a
 * thread happens to map to now. This is called at drain and after approval. */
function liveDelegationRoute(
  bus: CommsBus,
  sourceThreadId: string,
  item: PendingDelegationItem,
): LiveDelegationRoute {
  if (!item.sourceBotId) {
    return { ok: false, reason: "queued source identity is missing" };
  }
  const sender = bus.store.bot(item.sourceBotId);
  if (!sender) return { ok: false, reason: "the source bot no longer exists" };
  if (!bus.store.taskByThread(sender.id, sourceThreadId)) {
    return { ok: false, reason: `the queued source task no longer belongs to @${sender.name}` };
  }
  const target = bus.store.bot(item.toBotId);
  if (!target) return { ok: false, reason: `no such bot (${item.toBotId})` };
  if (sectionKey(sender.section) !== sectionKey(target.section)) {
    return { ok: false, reason: `@${sender.name} and @${target.name} are no longer in the same section` };
  }
  if (target.busy) return { ok: false, reason: `@${target.name} is busy` };
  return { ok: true, sender, target };
}

/** Every safe discard is visible when any source-owned task still exists.
 * If the source was deleted, its transcripts were deleted with it; log the
 * reason without recreating an orphan thread under a different bot. */
function reportDelegationCancellation(
  bus: CommsBus,
  sourceThreadId: string,
  item: PendingDelegationItem,
  reason: string,
): void {
  // A pre-binding legacy queue item may use the thread mapping solely as a
  // safe place to display its discard. It is never accepted as authority by
  // liveDelegationRoute above.
  const sender = item.sourceBotId
    ? bus.store.bot(item.sourceBotId)
    : bus.store.botByThread(sourceThreadId);
  const reportThreadId = sender
    ? (bus.store.taskByThread(sender.id, sourceThreadId)?.threadId ?? sender.threadId)
    : null;
  if (!reportThreadId) {
    console.warn(`delegation ${item.id} discarded: ${reason}`);
    return;
  }
  const target = bus.store.bot(item.toBotId);
  const label = target ? `Delegation to @${target.name}` : "Queued delegation";
  bus.store.appendMessage(reportThreadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `${label} canceled — ${reason}`, ok: false },
  });
}

/** Test helper: how many items remain queued for a thread. */
export function _pendingCount(threadId: string): number {
  return pendingDelegations.get(threadId)?.length ?? 0;
}

/** Test helper: forget the in-memory queue (a simulated restart). */
export function _resetPending(): void {
  pendingDelegations.clear();
  drainingThreads.clear();
  deferredDrainGenerations.clear();
  cancellationEpochByBot.clear();
  drainPromisesBySourceBot.clear();
}
