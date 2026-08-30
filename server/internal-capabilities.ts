import { randomBytes } from "node:crypto";

export type InternalCapabilityKind =
  | "agents"
  | "connectors"
  | "box"
  | "ian-brain"
  | "physical"
  | "local-vm"
  | "model";

/** Optional immutable resource binding for a scoped service broker. The
 * opaque bearer is useless against a different computer/source even while
 * the owning turn is still alive. Secrets themselves never live here. */
export interface InternalCapabilityScope {
  readonly targetKey: string | null;
  readonly resourceId: string;
}

export interface InternalCapabilityBinding {
  readonly kind: InternalCapabilityKind;
  readonly botId: string;
  readonly threadId: string;
  readonly depth: number;
  readonly generation: string;
  readonly token: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly scope?: InternalCapabilityScope;
}

export interface InternalCapabilityRequest {
  method: string;
  path: string;
}

export interface InternalCapabilityRegistration {
  kind: InternalCapabilityKind;
  botId: string;
  threadId: string;
  depth: number;
  generation: string;
  ttlMs?: number;
  scope?: InternalCapabilityScope;
}

export interface InternalCapabilityTurn {
  readonly botId: string;
  readonly threadId: string;
  readonly generation: string;
}

export interface InternalCapabilityTargetSelection {
  botId: string;
  threadId: string;
  generation: string;
  targetKey: string;
}

export type InternalCapabilityQuotaFailure = "revoked" | "count" | "concurrency";

export type InternalCapabilityQuotaLease = {
  readonly ok: true;
  /** Idempotent. A late release after turn revocation cannot resurrect usage. */
  release: () => void;
} | {
  readonly ok: false;
  readonly reason: InternalCapabilityQuotaFailure;
};

interface InternalCapabilityTurnUsage {
  readonly botId: string;
  readonly threadId: string;
  readonly generation: string;
  readonly counts: Map<string, number>;
  readonly concurrent: Map<string, number>;
  expiresAtMs: number;
}

const ROUTES = {
  agents: new Set([
    "GET /api/internal/agents",
    "POST /api/internal/ask-bot",
    "POST /api/internal/delegate-bot",
    "POST /api/internal/create-bot",
    "POST /api/internal/request-credential",
  ]),
  connectors: new Set([
    "POST /api/internal/connectors/mcp",
    "POST /api/internal/connectors/request",
  ]),
  box: new Set(["POST /api/internal/box"]),
  "ian-brain": new Set([
    "POST /api/internal/ian-brain/mcp",
    "GET /api/internal/ian-brain/mcp",
    "DELETE /api/internal/ian-brain/mcp",
  ]),
  physical: new Set(["GET /api/internal/physical-computer/mcp"]),
  "local-vm": new Set(["GET /api/internal/local-vm-computer/mcp"]),
  model: new Set([
    "GET /api/internal/model-relay",
    "POST /api/internal/model-relay",
  ]),
} satisfies Readonly<Record<InternalCapabilityKind, ReadonlySet<string>>>;

export const DEFAULT_INTERNAL_CAPABILITY_TTL_MS = 24 * 60 * 60_000;
const MAX_TOKEN_COLLISION_RETRIES = 16;

function requiredIdentity(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} is required`);
  return value;
}

function routeKey(request: InternalCapabilityRequest): string {
  return `${request.method.toUpperCase()} ${request.path}`;
}

export function internalCapabilityAllows(
  kind: InternalCapabilityKind,
  request: InternalCapabilityRequest,
): boolean {
  return ROUTES[kind].has(routeKey(request));
}

/** Compare an immutable broker binding with the exact active computer
 * selection. A null target is authority only while the bot has no active
 * computer at all. */
export function internalCapabilityScopeMatchesTarget(
  binding: InternalCapabilityBinding,
  selection: InternalCapabilityTargetSelection | null,
): boolean {
  if (!binding.scope) return false;
  if (binding.scope.targetKey === null) return selection === null;
  return Boolean(
    selection &&
    selection.botId === binding.botId &&
    selection.threadId === binding.threadId &&
    selection.generation === binding.generation &&
    selection.targetKey === binding.scope.targetKey,
  );
}

/**
 * Turn-scoped bearer authority for localhost integrations.
 *
 * Identity lives in this registry, not in request bodies supplied by an MCP
 * child. A token is valid for one integration family, bot, thread, depth, and
 * dispatch generation. Lifecycle owners revoke the turn explicitly; expiry
 * and pruning are a bounded backstop for crashed children.
 */
export class InternalCapabilityRegistry {
  private readonly bindings = new Map<string, InternalCapabilityBinding>();
  /** Quotas belong to the exact provider turn, not its replaceable bearer.
   * Remounting an MCP child therefore cannot reset a billable-operation cap. */
  private readonly usage = new Map<string, InternalCapabilityTurnUsage>();
  private readonly tokenFactory: () => string;
  private readonly now: () => number;
  private readonly defaultTtlMs: number;

  constructor(options: {
    tokenFactory?: () => string;
    now?: () => number;
    defaultTtlMs?: number;
  } = {}) {
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
    this.now = options.now ?? Date.now;
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_INTERNAL_CAPABILITY_TTL_MS;
    if (!Number.isFinite(this.defaultTtlMs) || this.defaultTtlMs <= 0) {
      throw new Error("internal capability TTL must be positive");
    }
  }

  register(input: InternalCapabilityRegistration): InternalCapabilityBinding {
    const botId = requiredIdentity(input.botId, "botId");
    const threadId = requiredIdentity(input.threadId, "threadId");
    const generation = requiredIdentity(input.generation, "generation");
    if (!Number.isSafeInteger(input.depth) || input.depth < 0) {
      throw new Error("depth must be a non-negative safe integer");
    }
    const ttlMs = input.ttlMs ?? this.defaultTtlMs;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("internal capability TTL must be positive");
    }

    this.pruneExpired();
    // Allocate while the prior binding is still present. Even a broken or
    // deterministic token source therefore cannot resurrect an old child's
    // bearer when this exact integration is remounted.
    let token = "";
    for (let attempt = 0; attempt < MAX_TOKEN_COLLISION_RETRIES; attempt += 1) {
      token = this.tokenFactory();
      if (token && !this.bindings.has(token)) break;
      token = "";
    }
    if (!token) throw new Error("could not allocate a unique internal capability token");

    // Remounting one integration for the same dispatch invalidates its older
    // child immediately. Agents and connectors remain separate capabilities.
    for (const [existingToken, binding] of this.bindings) {
      if (
        binding.kind === input.kind &&
        binding.botId === botId &&
        binding.threadId === threadId &&
        binding.generation === generation
      ) {
        this.deleteBinding(existingToken);
      }
    }

    const createdAtMs = this.now();
    const scope = input.scope
      ? Object.freeze({
          targetKey: input.scope.targetKey === null
            ? null
            : requiredIdentity(input.scope.targetKey, "scope.targetKey"),
          resourceId: requiredIdentity(input.scope.resourceId, "scope.resourceId"),
        })
      : undefined;
    const binding = Object.freeze({
      kind: input.kind,
      botId,
      threadId,
      depth: input.depth,
      generation,
      token,
      createdAtMs,
      expiresAtMs: createdAtMs + ttlMs,
      ...(scope ? { scope } : {}),
    });
    this.bindings.set(token, binding);
    const usageKey = this.usageKey(binding);
    const usage = this.usage.get(usageKey);
    if (usage) usage.expiresAtMs = Math.max(usage.expiresAtMs, binding.expiresAtMs);
    else {
      this.usage.set(usageKey, {
        botId: binding.botId,
        threadId: binding.threadId,
        generation: binding.generation,
        counts: new Map<string, number>(),
        concurrent: new Map<string, number>(),
        expiresAtMs: binding.expiresAtMs,
      });
    }
    return binding;
  }

  authorize(
    authorization: string | string[] | undefined,
    request: InternalCapabilityRequest,
  ): InternalCapabilityBinding | null {
    if (authorization === undefined || Array.isArray(authorization) || !authorization.startsWith("Bearer ")) {
      return null;
    }
    const token = authorization.slice("Bearer ".length);
    if (!token || token.trim() !== token) return null;
    const binding = this.bindings.get(token);
    if (!binding) return null;
    if (binding.expiresAtMs <= this.now()) {
      this.deleteBinding(token);
      return null;
    }
    return internalCapabilityAllows(binding.kind, request) ? binding : null;
  }

  revoke(token: string): boolean {
    return this.deleteBinding(token);
  }

  /** Atomically consume a server-enforced per-capability allowance. */
  consume(binding: InternalCapabilityBinding, counter: string, limit: number): boolean {
    return this.reserve(binding, counter, 1, limit);
  }

  /** Atomically reserve several units from an exact-turn allowance. This is
   * used before appending a batch of cards so parallel requests cannot each
   * observe room below the ceiling and then overrun it after an await. */
  reserve(binding: InternalCapabilityBinding, counter: string, amount: number, limit: number): boolean {
    if (this.bindings.get(binding.token) !== binding) return false;
    if (
      !counter ||
      !Number.isSafeInteger(amount) ||
      amount < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1
    ) return false;
    const usage = this.turnUsage(binding);
    const used = usage.counts.get(counter) ?? 0;
    if (amount > limit - used) return false;
    usage.counts.set(counter, used + amount);
    return true;
  }

  /** Atomically enforce both an accepted-request count and an in-flight cap
   * for one exact turn. Failed concurrency attempts do not burn count quota. */
  acquire(
    binding: InternalCapabilityBinding,
    counter: string,
    countLimit: number,
    concurrencyLimit: number,
  ): InternalCapabilityQuotaLease {
    if (this.bindings.get(binding.token) !== binding) return { ok: false, reason: "revoked" };
    if (
      !counter ||
      !Number.isSafeInteger(countLimit) ||
      countLimit < 1 ||
      !Number.isSafeInteger(concurrencyLimit) ||
      concurrencyLimit < 1
    ) return { ok: false, reason: "count" };
    const usageKey = this.usageKey(binding);
    const usage = this.turnUsage(binding);
    const active = usage.concurrent.get(counter) ?? 0;
    if (active >= concurrencyLimit) return { ok: false, reason: "concurrency" };
    const used = usage.counts.get(counter) ?? 0;
    if (used >= countLimit) return { ok: false, reason: "count" };
    usage.counts.set(counter, used + 1);
    usage.concurrent.set(counter, active + 1);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        const current = this.usage.get(usageKey);
        if (current !== usage) return;
        const inFlight = current.concurrent.get(counter) ?? 0;
        if (inFlight <= 1) current.concurrent.delete(counter);
        else current.concurrent.set(counter, inFlight - 1);
      },
    };
  }

  revokeTurn(input: { botId: string; threadId: string; generation: string }): number {
    let revoked = 0;
    for (const [token, binding] of this.bindings) {
      if (
        binding.botId === input.botId &&
        binding.threadId === input.threadId &&
        binding.generation === input.generation
      ) {
        this.deleteBinding(token);
        revoked += 1;
      }
    }
    this.usage.delete(this.usageKey(input));
    return revoked;
  }

  revokeBot(botId: string): number {
    let revoked = 0;
    for (const [token, binding] of this.bindings) {
      if (binding.botId !== botId) continue;
      this.deleteBinding(token);
      revoked += 1;
    }
    for (const [key, usage] of this.usage) {
      if (usage.botId === botId) this.usage.delete(key);
    }
    return revoked;
  }

  revokeAll(): number {
    const revoked = this.bindings.size;
    this.bindings.clear();
    this.usage.clear();
    return revoked;
  }

  pruneExpired(): number {
    const now = this.now();
    let removed = 0;
    for (const [token, binding] of this.bindings) {
      if (binding.expiresAtMs > now) continue;
      this.deleteBinding(token);
      removed += 1;
    }
    for (const [key, usage] of this.usage) {
      if (usage.expiresAtMs <= now) this.usage.delete(key);
    }
    return removed;
  }

  get size(): number {
    return this.bindings.size;
  }

  private deleteBinding(token: string): boolean {
    return this.bindings.delete(token);
  }

  private usageKey(input: { botId: string; threadId: string; generation: string }): string {
    return JSON.stringify([input.botId, input.threadId, input.generation]);
  }

  private turnUsage(binding: InternalCapabilityBinding): InternalCapabilityTurnUsage {
    const key = this.usageKey(binding);
    let usage = this.usage.get(key);
    if (!usage) {
      usage = {
        botId: binding.botId,
        threadId: binding.threadId,
        generation: binding.generation,
        counts: new Map<string, number>(),
        concurrent: new Map<string, number>(),
        expiresAtMs: binding.expiresAtMs,
      };
      this.usage.set(key, usage);
    }
    return usage;
  }
}

/**
 * Correlates short-lived integration authority with the exact provider turn
 * that owns it. The registry answers "is this token well formed and scoped to
 * this route?"; this coordinator additionally answers "is that turn still the
 * current turn?". Keeping both checks means a crashed child loses authority
 * immediately at settlement even if its process survives and its TTL has not
 * elapsed yet.
 */
export class InternalCapabilityTurns {
  private readonly activeByBot = new Map<string, InternalCapabilityTurn>();
  private readonly runtimeTurns = new Map<string, InternalCapabilityTurn>();
  private readonly finishedListeners = new Set<(turn: InternalCapabilityTurn) => void>();
  private readonly registry: InternalCapabilityRegistry;

  constructor(registry: InternalCapabilityRegistry) {
    this.registry = registry;
  }

  begin(input: InternalCapabilityTurn): InternalCapabilityTurn {
    const turn = Object.freeze({
      botId: requiredIdentity(input.botId, "botId"),
      threadId: requiredIdentity(input.threadId, "threadId"),
      generation: requiredIdentity(input.generation, "generation"),
    });

    // A bot cannot legitimately run two provider turns at once. A room thread
    // likewise has one speaker. Never treat an attempted successor as proof
    // the existing provider actually stopped: preserving the old authority
    // keeps Stop/retry correlated to the process that still may be alive.
    for (const current of this.activeByBot.values()) {
      if (current.botId === turn.botId || current.threadId === turn.threadId) {
        throw new Error("an internal capability turn is already active for this bot or thread");
      }
    }
    this.activeByBot.set(turn.botId, turn);
    return turn;
  }

  register(
    kind: InternalCapabilityKind,
    turn: InternalCapabilityTurn,
    depth: number,
    scope?: InternalCapabilityScope,
  ): InternalCapabilityBinding {
    if (!this.matches(turn)) throw new Error("internal capability turn is no longer active");
    return this.registry.register({ kind, ...turn, depth, ...(scope ? { scope } : {}) });
  }

  authorize(
    authorization: string | string[] | undefined,
    request: InternalCapabilityRequest,
  ): InternalCapabilityBinding | null {
    const binding = this.registry.authorize(authorization, request);
    if (!binding) return null;
    if (this.matches(binding)) return binding;
    // An inactive token is never useful again. Delete it on first sight so a
    // surviving MCP child cannot keep probing it until the TTL backstop.
    this.registry.revoke(binding.token);
    return null;
  }

  bindRuntime(runtimeKey: string, turn: InternalCapabilityTurn): boolean {
    if (!runtimeKey || !this.matches(turn)) return false;
    this.runtimeTurns.set(runtimeKey, turn);
    return true;
  }

  finishRuntime(runtimeKey: string): InternalCapabilityTurn | null {
    const turn = this.runtimeTurns.get(runtimeKey);
    if (!turn) return null;
    this.runtimeTurns.delete(runtimeKey);
    this.finish(turn);
    return turn;
  }

  finish(input: InternalCapabilityTurn): boolean {
    const current = this.activeByBot.get(input.botId);
    const exact = Boolean(
      current &&
      current.threadId === input.threadId &&
      current.generation === input.generation
    );
    if (exact) this.activeByBot.delete(input.botId);
    this.registry.revokeTurn(input);
    for (const [runtimeKey, turn] of this.runtimeTurns) {
      if (
        turn.botId === input.botId &&
        turn.threadId === input.threadId &&
        turn.generation === input.generation
      ) {
        this.runtimeTurns.delete(runtimeKey);
      }
    }
    if (exact) {
      for (const listener of [...this.finishedListeners]) listener(current!);
    }
    return exact;
  }

  finishBot(botId: string): number {
    const current = this.activeByBot.get(botId);
    if (current) this.finish(current);
    return this.registry.revokeBot(botId);
  }

  finishAll(): number {
    const active = [...this.activeByBot.values()];
    this.activeByBot.clear();
    this.runtimeTurns.clear();
    const revoked = this.registry.revokeAll();
    for (const turn of active) {
      for (const listener of [...this.finishedListeners]) listener(turn);
    }
    return revoked;
  }

  forBot(botId: string): InternalCapabilityTurn | null {
    return this.activeByBot.get(botId) ?? null;
  }

  forThread(threadId: string): InternalCapabilityTurn | null {
    const candidates = [...this.activeByBot.values()].filter((turn) => turn.threadId === threadId);
    return candidates.length === 1 ? candidates[0]! : null;
  }

  isActive(input: InternalCapabilityTurn): boolean {
    return this.matches(input);
  }

  onFinished(listener: (turn: InternalCapabilityTurn) => void): () => void {
    this.finishedListeners.add(listener);
    return () => this.finishedListeners.delete(listener);
  }

  private matches(input: InternalCapabilityTurn): boolean {
    const current = this.activeByBot.get(input.botId);
    return Boolean(
      current &&
      current.threadId === input.threadId &&
      current.generation === input.generation
    );
  }
}
