// Human ownership of a bot's graphical computer.
//
// A hold is a short, renewable lease, not a boolean. The lease is scoped to
// the physical target (so two bots sharing one VM cannot both drive it), the
// renderer session that took it, and an unguessable proof token. A renderer
// that crashes, sleeps, or loses its network stops heartbeating and the lease
// expires automatically.
//
// Tool calls also take short-lived action tickets. A takeover first fences
// the target against new actions, waits for already-forwarded calls to finish,
// and only then reports `held: true`. This avoids the dangerous state where
// the UI says "you have control" while an earlier bot click is still in flight.

import { randomBytes, timingSafeEqual } from "node:crypto";

export const DEFAULT_CONTROL_LEASE_TTL_MS = 15_000;
export const DEFAULT_CONTROL_DRAIN_TIMEOUT_MS = 10_000;

export interface ControlSnapshot {
  /** True only after every earlier bot action has drained. */
  held: boolean;
  /** The bot's open plea for help, verbatim, or null when none is open. */
  helpReason: string | null;
  heldSinceMs: number | null;
  /** The UI uses this to detect a heartbeat that has fallen behind. */
  leaseExpiresAtMs: number | null;
}

export interface LeaseBinding {
  botId: string;
  targetKey: string;
  ownerId: string;
  leaseToken: string;
}

export interface LeaseRevocation extends LeaseBinding {
  reason: "release" | "expired" | "forgotten" | "replaced" | "shutdown";
}

export type TakeLeaseResult =
  | { ok: true; snapshot: ControlSnapshot; leaseToken: string }
  | { ok: false; snapshot: ControlSnapshot; reason: "held" | "takeover-pending" | "actions-busy" | "lifecycle-active" | "target-changed" };

export type LeaseMutationResult =
  | { ok: true; snapshot: ControlSnapshot }
  | { ok: false; snapshot: ControlSnapshot; reason: "invalid-lease" };

export type BeginActionResult =
  | { allowed: true; actionId: string }
  | { allowed: false; reason: "human-control" | "takeover-pending" | "action-active" | "lifecycle-active" };

export type BeginLifecycleMutationResult =
  | { allowed: true; lifecycleId: string }
  | { allowed: false; reason: "held" | "takeover-pending" | "actions-active" | "lifecycle-active" };

const EMPTY_SNAPSHOT: ControlSnapshot = {
  held: false,
  helpReason: null,
  heldSinceMs: null,
  leaseExpiresAtMs: null,
};

/** Keep a shouted help reason card-sized; the transcript has the rest. */
const MAX_REASON_CHARS = 280;

interface HelpEntry {
  reason: string;
  requestId: string;
  targetKey: string;
}

interface LeaseEntry {
  botId: string;
  ownerId: string;
  token: string;
  heldSinceMs: number;
  expiresAtMs: number;
}

interface PendingTake {
  requestId: string;
  botId: string;
  ownerId: string;
}

interface ActionEntry {
  botId: string;
  bridgeId: string;
  startedAtMs: number;
  /** Transport ended without a correlated result. The remote action may
   * still be running, so only a verified target stop/replacement may clear. */
  quarantined: boolean;
}

interface TargetEntry {
  lease: LeaseEntry | null;
  pendingTake: PendingTake | null;
  lifecycleId: string | null;
  actions: Map<string, ActionEntry>;
  drainWaiters: Set<() => void>;
}

export interface ComputerControlOptions {
  leaseTtlMs?: number;
  drainTimeoutMs?: number;
  tokenFactory?: () => string;
}

export class ComputerControl {
  private readonly help = new Map<string, HelpEntry>();
  private readonly targets = new Map<string, TargetEntry>();
  private readonly botTargets = new Map<string, string>();
  private readonly revokedListeners = new Set<(event: LeaseRevocation) => void>();
  private readonly onChange: (botId: string, snapshot: ControlSnapshot) => void;
  private readonly now: () => number;
  /** Public protocol metadata; clients use it only to close their local
   * interactive viewer before an unrenewed server lease can expire. */
  readonly leaseTtlMs: number;
  private readonly drainTimeoutMs: number;
  private readonly tokenFactory: () => string;
  private requestSequence = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    onChange: (botId: string, snapshot: ControlSnapshot) => void = () => {},
    now: () => number = Date.now,
    options: ComputerControlOptions = {},
  ) {
    this.onChange = onChange;
    this.now = now;
    this.leaseTtlMs = Math.max(1, options.leaseTtlMs ?? DEFAULT_CONTROL_LEASE_TTL_MS);
    this.drainTimeoutMs = Math.max(1, options.drainTimeoutMs ?? DEFAULT_CONTROL_DRAIN_TIMEOUT_MS);
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
  }

  /** Remembering the resolved target makes shared-VM broadcasts reach every
   * bot whose panel has observed that target. Callers must still pass the
   * server-derived target on authority-bearing operations. */
  snapshot(botId: string, targetKey = this.botTargets.get(botId) ?? botId): ControlSnapshot {
    this.rememberTarget(botId, targetKey);
    this.reapExpired();
    return this.snapshotUnchecked(botId, targetKey);
  }

  /** Fence a target, drain actions that were already forwarded, then mint a
   * lease. A conflicting takeover never learns the current secret. */
  async takeLease(input: {
    botId: string;
    targetKey: string;
    ownerId: string;
    drainTimeoutMs?: number;
    /** Server-owned routing proof. Checked before fencing and again after
     * draining, immediately before a lease can be minted. */
    stillAuthoritative?: () => boolean;
  }): Promise<TakeLeaseResult> {
    const { botId, targetKey, ownerId } = input;
    this.reapExpired();
    if (!this.takeAuthorityIsCurrent(input.stillAuthoritative)) {
      return { ok: false, reason: "target-changed", snapshot: this.snapshotUnchecked(botId, targetKey) };
    }
    const previouslyRememberedTarget = this.botTargets.get(botId);
    this.rememberTarget(botId, targetKey);
    const target = this.target(targetKey);
    if (target.lifecycleId) {
      return { ok: false, reason: "lifecycle-active", snapshot: this.snapshotUnchecked(botId, targetKey) };
    }
    if (target.lease) {
      return { ok: false, reason: "held", snapshot: this.snapshotUnchecked(botId, targetKey) };
    }
    if (target.pendingTake) {
      return { ok: false, reason: "takeover-pending", snapshot: this.snapshotUnchecked(botId, targetKey) };
    }

    const requestId = this.newToken("take");
    target.pendingTake = { requestId, botId, ownerId };
    const drained = await this.waitForDrain(targetKey, requestId, input.drainTimeoutMs ?? this.drainTimeoutMs);
    if (!drained) {
      return { ok: false, reason: "actions-busy", snapshot: this.snapshotUnchecked(botId, targetKey) };
    }

    if (!this.takeAuthorityIsCurrent(input.stillAuthoritative)) {
      if (target.pendingTake?.requestId === requestId) target.pendingTake = null;
      if (this.botTargets.get(botId) === targetKey) {
        if (previouslyRememberedTarget) this.botTargets.set(botId, previouslyRememberedTarget);
        else this.botTargets.delete(botId);
      }
      this.pruneTarget(targetKey);
      return { ok: false, reason: "target-changed", snapshot: this.snapshotUnchecked(botId, targetKey) };
    }

    // No new action can have started while pendingTake was present.
    const token = this.newToken("lease");
    const now = this.now();
    target.pendingTake = null;
    target.lease = {
      botId,
      ownerId,
      token,
      heldSinceMs: now,
      expiresAtMs: now + this.leaseTtlMs,
    };
    this.armExpiryTimer();
    this.changedTarget(targetKey);
    return { ok: true, leaseToken: token, snapshot: this.snapshotUnchecked(botId, targetKey) };
  }

  private takeAuthorityIsCurrent(stillAuthoritative: (() => boolean) | undefined): boolean {
    if (!stillAuthoritative) return true;
    try {
      return stillAuthoritative() === true;
    } catch {
      return false;
    }
  }

  heartbeatLease(binding: LeaseBinding): LeaseMutationResult {
    this.rememberTarget(binding.botId, binding.targetKey);
    this.reapExpired();
    const lease = this.targets.get(binding.targetKey)?.lease;
    if (!this.matches(lease, binding)) {
      return { ok: false, reason: "invalid-lease", snapshot: this.snapshotUnchecked(binding.botId, binding.targetKey) };
    }
    lease.expiresAtMs = this.now() + this.leaseTtlMs;
    this.armExpiryTimer();
    return { ok: true, snapshot: this.snapshotUnchecked(binding.botId, binding.targetKey) };
  }

  releaseLease(binding: LeaseBinding): LeaseMutationResult {
    this.rememberTarget(binding.botId, binding.targetKey);
    this.reapExpired();
    const lease = this.targets.get(binding.targetKey)?.lease;
    if (!this.matches(lease, binding)) {
      return { ok: false, reason: "invalid-lease", snapshot: this.snapshotUnchecked(binding.botId, binding.targetKey) };
    }
    this.revoke(binding.targetKey, "release", true);
    return { ok: true, snapshot: this.snapshotUnchecked(binding.botId, binding.targetKey) };
  }

  /** Viewer sessions use the same proof as heartbeat/release. */
  authorizeLease(binding: LeaseBinding): boolean {
    this.rememberTarget(binding.botId, binding.targetKey);
    this.reapExpired();
    return this.matches(this.targets.get(binding.targetKey)?.lease, binding);
  }

  /** Keep heartbeat/release bound to the machine a person already controls
   * even after the bot turn that selected it has settled. */
  leaseTargetForBot(botId: string): string | null {
    this.reapExpired();
    for (const [targetKey, target] of this.targets) {
      if (target.lease?.botId === botId) return targetKey;
    }
    return null;
  }

  /** Subscribe a viewer proxy so sockets disappear the instant ownership is
   * released or expires. Returns an unsubscribe function. */
  onRevoked(listener: (event: LeaseRevocation) => void): () => void {
    this.revokedListeners.add(listener);
    return () => this.revokedListeners.delete(listener);
  }

  /** Revoke every lease bound to one trusted client identity. The companion
   * sidecar uses this when a paired device or its desktop grant is revoked;
   * waiting for the normal TTL would leave that phone interactive after the
   * control page said access was gone. */
  revokeLeasesForOwner(ownerId: string, reason: LeaseRevocation["reason"] = "forgotten"): number {
    this.reapExpired();
    let revoked = 0;
    for (const [targetKey, target] of [...this.targets]) {
      if (target.lease?.ownerId !== ownerId) continue;
      this.revoke(targetKey, reason, true);
      revoked += 1;
    }
    return revoked;
  }

  /** Atomically gate one bot tool call. `pendingTake` is a fence: after a
   * person clicks Take control, no new action may enter while old ones drain. */
  beginAction(botId: string, targetKey: string, bridgeId: string): BeginActionResult {
    this.rememberTarget(botId, targetKey);
    this.reapExpired();
    const target = this.target(targetKey);
    if (target.lease) return { allowed: false, reason: "human-control" };
    if (target.pendingTake) return { allowed: false, reason: "takeover-pending" };
    if (target.lifecycleId) return { allowed: false, reason: "lifecycle-active" };
    // A graphical desktop is one ordered input stream. Even two bots (or two
    // bridges for one bot) must not click/type concurrently on a shared VM or
    // physical host; the second call waits at the model/proxy boundary until
    // the first exact ticket settles.
    if (target.actions.size) return { allowed: false, reason: "action-active" };
    const actionId = this.newToken("action");
    target.actions.set(actionId, { botId, bridgeId, startedAtMs: this.now(), quarantined: false });
    return { allowed: true, actionId };
  }

  /** End only the ticket issued for this bot and target. Unknown/duplicate
   * completions are rejected and cannot drain somebody else's action. */
  endAction(botId: string, targetKey: string, bridgeId: string, actionId: unknown): boolean {
    if (typeof actionId !== "string" || !actionId) return false;
    this.rememberTarget(botId, targetKey);
    const target = this.targets.get(targetKey);
    const action = target?.actions.get(actionId);
    if (!target || action?.botId !== botId || action.bridgeId !== bridgeId) return false;
    target.actions.delete(actionId);
    if (target.actions.size === 0) {
      for (const resolve of target.drainWaiters) resolve();
      target.drainWaiters.clear();
      this.pruneTarget(targetKey);
    }
    return true;
  }

  /** Verify an exact live ticket without mutating it. The Box broker uses
   * this only to recognize a request already fenced by the official computer
   * proxy, so it can avoid minting a second ticket for the same action. */
  authorizeAction(botId: string, targetKey: string, bridgeId: string, actionId: unknown): boolean {
    if (typeof actionId !== "string" || !actionId) return false;
    const action = this.targets.get(targetKey)?.actions.get(actionId);
    return Boolean(action && !action.quarantined && action.botId === botId && action.bridgeId === bridgeId);
  }

  bridgeTicketCount(targetKey: string, bridgeId: string): number {
    const target = this.targets.get(targetKey);
    if (!target) return 0;
    let count = 0;
    for (const action of target.actions.values()) {
      if (action.bridgeId === bridgeId) count += 1;
    }
    return count;
  }

  /** Transport loss changes an action from live to ambiguous; it does not
   * complete it. The ticket continues fencing takeover and ordinary lifecycle
   * mutations until a server-owned target reset proves execution stopped. */
  quarantineActionsForBridge(botId: string, targetKey: string, bridgeId: string): number {
    const target = this.targets.get(targetKey);
    if (!target) return 0;
    let quarantined = 0;
    for (const action of target.actions.values()) {
      if (action.botId !== botId || action.bridgeId !== bridgeId || action.quarantined) continue;
      action.quarantined = true;
      quarantined += 1;
    }
    return quarantined;
  }

  /** Provider/session death is the server-owned equivalent for a proxy that
   * was itself SIGKILLed and could not report transport loss. */
  quarantineActionsForBotTarget(botId: string, targetKey: string): number {
    const target = this.targets.get(targetKey);
    if (!target) return 0;
    let quarantined = 0;
    for (const action of target.actions.values()) {
      if (action.botId !== botId || action.quarantined) continue;
      action.quarantined = true;
      quarantined += 1;
    }
    return quarantined;
  }

  /** A physical-host bridge cannot be reset by stopping a VM. Recovery is
   * instead generation-bound: the server has confirmed the old child closed
   * and observed a newly spawned bridge for the same host. Clear only tickets
   * owned by those retired bridge ids; never touch another live bridge. */
  recoverQuarantinedActionsForBridges(targetKey: string, bridgeIds: Iterable<string>): number {
    const target = this.targets.get(targetKey);
    if (!target) return 0;
    const allowed = new Set(bridgeIds);
    let recovered = 0;
    for (const [actionId, action] of target.actions) {
      if (!action.quarantined || !allowed.has(action.bridgeId)) continue;
      target.actions.delete(actionId);
      recovered += 1;
    }
    if (target.actions.size === 0) {
      for (const resolve of target.drainWaiters) resolve();
      target.drainWaiters.clear();
      this.pruneTarget(targetKey);
    }
    return recovered;
  }

  /** Enter a stop/remove/replacement operation only when every outstanding
   * ticket is already quarantined. A live action is never cleared by reset. */
  beginTargetReset(targetKey: string): BeginLifecycleMutationResult {
    this.reapExpired();
    const target = this.target(targetKey);
    if (target.lease) return { allowed: false, reason: "held" };
    if (target.pendingTake) return { allowed: false, reason: "takeover-pending" };
    if (target.lifecycleId) return { allowed: false, reason: "lifecycle-active" };
    if ([...target.actions.values()].some((action) => !action.quarantined)) {
      return { allowed: false, reason: "actions-active" };
    }
    const lifecycleId = this.newToken("reset");
    target.lifecycleId = lifecycleId;
    return { allowed: true, lifecycleId };
  }

  /** Call only after stop/remove/replacement succeeded. It clears ambiguous
   * tickets, never live ones, and releases the reset lifecycle fence. */
  completeTargetReset(targetKey: string, lifecycleId: unknown): boolean {
    if (typeof lifecycleId !== "string" || !lifecycleId) return false;
    const target = this.targets.get(targetKey);
    if (!target || target.lifecycleId !== lifecycleId) return false;
    for (const [actionId, action] of target.actions) {
      if (action.quarantined) target.actions.delete(actionId);
    }
    target.lifecycleId = null;
    if (target.actions.size === 0) {
      for (const resolve of target.drainWaiters) resolve();
      target.drainWaiters.clear();
    }
    this.pruneTarget(targetKey);
    return true;
  }

  /** Atomically claim the exact target for a server-owned start/stop/remove
   * (or another direct mutation such as Box exec). This closes the reverse
   * race: once lifecycle work starts, neither a human lease nor an agent
   * action can enter until the exact claim is released. */
  beginLifecycleMutation(targetKey: string): BeginLifecycleMutationResult {
    this.reapExpired();
    const target = this.target(targetKey);
    if (target.lease) return { allowed: false, reason: "held" };
    if (target.pendingTake) return { allowed: false, reason: "takeover-pending" };
    if (target.actions.size) return { allowed: false, reason: "actions-active" };
    if (target.lifecycleId) return { allowed: false, reason: "lifecycle-active" };
    const lifecycleId = this.newToken("lifecycle");
    target.lifecycleId = lifecycleId;
    return { allowed: true, lifecycleId };
  }

  /** Fence new actions immediately, then wait for an already-forwarded action
   * to finish. Physical-computer approval dialogs use this stronger form: a
   * model must never be able to click an OS authorization prompt, including
   * through a different bot sharing the same physical target. */
  async beginLifecycleMutationAfterDrain(
    targetKey: string,
    timeoutMs = this.drainTimeoutMs,
  ): Promise<BeginLifecycleMutationResult> {
    this.reapExpired();
    const target = this.target(targetKey);
    if (target.lease) return { allowed: false, reason: "held" };
    if (target.pendingTake) return { allowed: false, reason: "takeover-pending" };
    if (target.lifecycleId) return { allowed: false, reason: "lifecycle-active" };

    const lifecycleId = this.newToken("lifecycle");
    target.lifecycleId = lifecycleId;
    if (target.actions.size === 0) return { allowed: true, lifecycleId };

    let timer: ReturnType<typeof setTimeout> | null = null;
    const drained = await new Promise<boolean>((resolve) => {
      const done = () => {
        if (timer) clearTimeout(timer);
        resolve(true);
      };
      target.drainWaiters.add(done);
      timer = setTimeout(() => {
        target.drainWaiters.delete(done);
        resolve(false);
      }, Math.max(1, timeoutMs));
      timer.unref?.();
    });
    if (!drained || target.lifecycleId !== lifecycleId || target.actions.size !== 0) {
      if (target.lifecycleId === lifecycleId) target.lifecycleId = null;
      this.pruneTarget(targetKey);
      return { allowed: false, reason: drained ? "lifecycle-active" : "actions-active" };
    }
    return { allowed: true, lifecycleId };
  }

  /** Release only the exact lifecycle claim that was issued. A stale finally
   * block cannot unlock a newer operation on the same target. */
  endLifecycleMutation(targetKey: string, lifecycleId: unknown): boolean {
    if (typeof lifecycleId !== "string" || !lifecycleId) return false;
    const target = this.targets.get(targetKey);
    if (!target || target.lifecycleId !== lifecycleId) return false;
    target.lifecycleId = null;
    this.pruneTarget(targetKey);
    return true;
  }

  /** Lifecycle mutations (stop/remove/mode switch) must not tear down a
   * computer under a person or an action. */
  targetBusy(targetKey: string): { busy: boolean; reason: "held" | "takeover-pending" | "actions-active" | "lifecycle-active" | null } {
    this.reapExpired();
    const target = this.targets.get(targetKey);
    if (target?.lease) return { busy: true, reason: "held" };
    if (target?.pendingTake) return { busy: true, reason: "takeover-pending" };
    if (target?.actions.size) return { busy: true, reason: "actions-active" };
    if (target?.lifecycleId) return { busy: true, reason: "lifecycle-active" };
    return { busy: false, reason: null };
  }

  requestHelp(botId: string, reason: unknown, targetKey = this.botTargets.get(botId) ?? botId): ControlSnapshot {
    return this.requestHelpLease(botId, reason, targetKey).snapshot;
  }

  requestHelpLease(
    botId: string,
    reason: unknown,
    targetKey = this.botTargets.get(botId) ?? botId,
  ): { snapshot: ControlSnapshot; requestId: string } {
    this.rememberTarget(botId, targetKey);
    const text = typeof reason === "string" ? reason.trim().slice(0, MAX_REASON_CHARS) : "";
    let entry = this.help.get(botId);
    if (!entry || entry.targetKey !== targetKey) {
      entry = {
        reason: text || "the bot asked you to take over",
        requestId: `${botId}-${++this.requestSequence}`,
        targetKey,
      };
      this.help.set(botId, entry);
      this.changedBot(botId);
    }
    return { snapshot: this.snapshot(botId, targetKey), requestId: entry.requestId };
  }

  dismissHelp(botId: string, targetKey = this.botTargets.get(botId) ?? botId): ControlSnapshot {
    this.rememberTarget(botId, targetKey);
    const entry = this.help.get(botId);
    if (!entry || entry.targetKey !== targetKey) return this.snapshot(botId, targetKey);
    this.help.delete(botId);
    return this.changedBot(botId);
  }

  expireHelp(botId: string, requestId: unknown, targetKey = this.botTargets.get(botId) ?? botId): ControlSnapshot {
    this.rememberTarget(botId, targetKey);
    const entry = this.help.get(botId);
    if (!entry || entry.requestId !== requestId || entry.targetKey !== targetKey) return this.snapshot(botId, targetKey);
    this.help.delete(botId);
    return this.changedBot(botId);
  }

  /** The normal delete path should call targetBusy first. `forget` is the
   * final cleanup fence for a bot that is actually gone. */
  forget(botId: string): void {
    const targetKeys = new Set<string>();
    const remembered = this.botTargets.get(botId);
    if (remembered) targetKeys.add(remembered);
    for (const [targetKey, target] of this.targets) {
      if (target.lease?.botId === botId || target.pendingTake?.botId === botId) targetKeys.add(targetKey);
      for (const action of target.actions.values()) {
        if (action.botId === botId) targetKeys.add(targetKey);
      }
    }
    const hadHelp = this.help.delete(botId);
    for (const targetKey of targetKeys) {
      const target = this.targets.get(targetKey);
      if (!target) continue;
      if (target.lease?.botId === botId) this.revoke(targetKey, "forgotten", false);
      if (target.pendingTake?.botId === botId) target.pendingTake = null;
      this.endActionsForBot(botId, targetKey);
      this.pruneTarget(targetKey);
    }
    this.botTargets.delete(botId);
    if (hadHelp && targetKeys.size === 0) this.onChange(botId, { ...EMPTY_SNAPSHOT });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    for (const [targetKey, target] of this.targets) {
      if (target.lease) this.revoke(targetKey, "shutdown", false);
    }
    this.targets.clear();
    this.help.clear();
    this.botTargets.clear();
    this.revokedListeners.clear();
  }

  private target(targetKey: string): TargetEntry {
    let target = this.targets.get(targetKey);
    if (!target) {
      target = { lease: null, pendingTake: null, lifecycleId: null, actions: new Map(), drainWaiters: new Set() };
      this.targets.set(targetKey, target);
    }
    return target;
  }

  /** Deletion is the one operation authorized to clean every bridge owned by
   * a bot. Transport detach is intentionally not cancellation proof. */
  private endActionsForBot(botId: string, targetKey: string): number {
    const target = this.targets.get(targetKey);
    if (!target) return 0;
    let ended = 0;
    for (const [id, action] of target.actions) {
      if (action.botId !== botId) continue;
      target.actions.delete(id);
      ended += 1;
    }
    if (target.actions.size === 0) {
      for (const resolve of target.drainWaiters) resolve();
      target.drainWaiters.clear();
      this.pruneTarget(targetKey);
    }
    return ended;
  }

  private rememberTarget(botId: string, targetKey: string): void {
    this.botTargets.set(botId, targetKey);
  }

  private snapshotUnchecked(botId: string, targetKey: string): ControlSnapshot {
    const lease = this.targets.get(targetKey)?.lease ?? null;
    const help = this.help.get(botId);
    return {
      held: lease !== null,
      helpReason: help?.targetKey === targetKey ? help.reason : null,
      heldSinceMs: lease?.heldSinceMs ?? null,
      leaseExpiresAtMs: lease?.expiresAtMs ?? null,
    };
  }

  private changedBot(botId: string): ControlSnapshot {
    const targetKey = this.botTargets.get(botId) ?? botId;
    const snapshot = this.snapshotUnchecked(botId, targetKey);
    this.onChange(botId, snapshot);
    return snapshot;
  }

  private changedTarget(targetKey: string): void {
    let notified = false;
    for (const [botId, knownTarget] of this.botTargets) {
      if (knownTarget !== targetKey) continue;
      notified = true;
      this.onChange(botId, this.snapshotUnchecked(botId, targetKey));
    }
    const leaseBot = this.targets.get(targetKey)?.lease?.botId;
    if (!notified && leaseBot) this.onChange(leaseBot, this.snapshotUnchecked(leaseBot, targetKey));
  }

  private async waitForDrain(targetKey: string, requestId: string, timeoutMs: number): Promise<boolean> {
    const target = this.targets.get(targetKey);
    if (!target || target.pendingTake?.requestId !== requestId) return false;
    if (target.actions.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const drained = await new Promise<boolean>((resolve) => {
      const done = () => {
        if (timer) clearTimeout(timer);
        resolve(true);
      };
      target.drainWaiters.add(done);
      timer = setTimeout(() => {
        target.drainWaiters.delete(done);
        resolve(false);
      }, Math.max(1, timeoutMs));
      timer.unref?.();
    });
    if (!drained && target.pendingTake?.requestId === requestId) {
      target.pendingTake = null;
      this.pruneTarget(targetKey);
    }
    return drained && target.pendingTake?.requestId === requestId;
  }

  private reapExpired(): void {
    const now = this.now();
    for (const [targetKey, target] of this.targets) {
      if (target.lease && target.lease.expiresAtMs <= now) this.revoke(targetKey, "expired", true);
    }
    this.armExpiryTimer();
  }

  private armExpiryTimer(): void {
    if (this.disposed) return;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    let soonest = Number.POSITIVE_INFINITY;
    for (const target of this.targets.values()) {
      if (target.lease) soonest = Math.min(soonest, target.lease.expiresAtMs);
    }
    if (!Number.isFinite(soonest)) return;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.reapExpired();
    }, Math.max(0, soonest - this.now()));
    this.expiryTimer.unref?.();
  }

  private revoke(targetKey: string, reason: LeaseRevocation["reason"], settleHelp: boolean): void {
    const target = this.targets.get(targetKey);
    const lease = target?.lease;
    if (!target || !lease) return;
    target.lease = null;
    if (settleHelp) {
      // A and B can be two bots sharing one VM. If A asked for help and the
      // person happened to take/release through B's panel, that hand-back
      // settles every waiter for this physical target, not only lease.botId.
      for (const [botId, entry] of this.help) {
        if (entry.targetKey === targetKey) this.help.delete(botId);
      }
    }
    const event: LeaseRevocation = {
      botId: lease.botId,
      targetKey,
      ownerId: lease.ownerId,
      leaseToken: lease.token,
      reason,
    };
    for (const listener of this.revokedListeners) listener(event);
    this.changedTarget(targetKey);
    this.pruneTarget(targetKey);
    this.armExpiryTimer();
  }

  private matches(lease: LeaseEntry | null | undefined, binding: LeaseBinding): lease is LeaseEntry {
    return Boolean(
      lease &&
        lease.botId === binding.botId &&
        lease.ownerId === binding.ownerId &&
        secretEqual(lease.token, binding.leaseToken),
    );
  }

  private pruneTarget(targetKey: string): void {
    const target = this.targets.get(targetKey);
    if (!target || target.lease || target.pendingTake || target.lifecycleId || target.actions.size || target.drainWaiters.size) return;
    this.targets.delete(targetKey);
  }

  private newToken(prefix: string): string {
    return `${prefix}_${this.tokenFactory()}`;
  }
}

function secretEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
