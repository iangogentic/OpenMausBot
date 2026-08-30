import { randomBytes, randomUUID } from "node:crypto";

export interface ControlBridgeBinding {
  readonly bridgeId: string;
  readonly botId: string;
  readonly targetKey: string;
  readonly threadId: string;
  readonly dispatchGeneration: string;
  readonly token: string;
  /** Far-end executor epoch (not this stdio bridge generation). */
  readonly executorGeneration?: string;
  retired: boolean;
  closed: boolean;
  observed: boolean;
}

/** Per-child immutable authority. Mutable bot configuration is never used to
 * reinterpret an already spawned bridge. */
export class ControlBridgeRegistry {
  private readonly bindings = new Map<string, ControlBridgeBinding>();
  private readonly idFactory: () => string;
  private readonly tokenFactory: () => string;

  constructor(
    idFactory: () => string = randomUUID,
    tokenFactory: () => string = () => randomBytes(32).toString("base64url"),
  ) {
    this.idFactory = idFactory;
    this.tokenFactory = tokenFactory;
  }

  register(input: {
    botId: string;
    targetKey: string;
    threadId: string;
    dispatchGeneration: string;
    executorGeneration?: string;
  }): ControlBridgeBinding {
    const bridgeId = this.idFactory();
    if (this.bindings.has(bridgeId)) throw new Error("duplicate computer bridge id");
    const binding: ControlBridgeBinding = {
      bridgeId,
      ...input,
      token: this.tokenFactory(),
      retired: false,
      closed: false,
      observed: false,
    };
    this.bindings.set(bridgeId, binding);
    return binding;
  }

  get(bridgeId: string): ControlBridgeBinding | undefined {
    return this.bindings.get(bridgeId);
  }

  delete(bridgeId: string): boolean {
    return this.bindings.delete(bridgeId);
  }

  entries(): IterableIterator<[string, ControlBridgeBinding]> {
    return this.bindings.entries();
  }

  values(): IterableIterator<ControlBridgeBinding> {
    return this.bindings.values();
  }

  get size(): number {
    return this.bindings.size;
  }

  /** Retired bearer authority is discarded as soon as no safety ticket needs
   * its exact bridge identity. Ambiguous bridges stay as inert metadata until
   * verified reset/recovery clears their ticket. */
  pruneRetiredWithoutTickets(
    hasTickets: (binding: ControlBridgeBinding) => boolean,
    targetKey?: string,
  ): number {
    let removed = 0;
    for (const [bridgeId, binding] of this.bindings) {
      if (!binding.retired || (targetKey && binding.targetKey !== targetKey) || hasTickets(binding)) continue;
      this.bindings.delete(bridgeId);
      removed += 1;
    }
    return removed;
  }
}

/** Exact physical quarantine recovery proof. A new MCP child alone is not
 * enough; the far-end CUA executor epoch must differ from the retired child. */
export function recoverableRetiredBridgeIds(
  bindings: Iterable<ControlBridgeBinding>,
  targetKey: string,
): string[] {
  const values = [...bindings];
  const currentEpochs = new Set(
    values
      .filter(
        (binding) =>
          binding.targetKey === targetKey &&
          !binding.retired &&
          binding.observed &&
          Boolean(binding.executorGeneration),
      )
      .map((binding) => binding.executorGeneration!),
  );
  if (!currentEpochs.size) return [];
  return values
    .filter(
      (binding) =>
        binding.targetKey === targetKey &&
        binding.retired &&
        binding.closed &&
        Boolean(binding.executorGeneration) &&
        !currentEpochs.has(binding.executorGeneration!),
    )
    .map((binding) => binding.bridgeId);
}

/** Exact computer selected for a running turn. Configuration says what was
 * requested; this registry records what actually mounted after Auto fallback. */
export class ActiveComputerTargets {
  private readonly byBot = new Map<string, { threadId: string; targetKey: string; generation: string }>();
  private readonly byThread = new Map<string, { botId: string; generation: string }>();
  private readonly tokenFactory: () => string;

  constructor(tokenFactory: () => string = randomUUID) {
    this.tokenFactory = tokenFactory;
  }

  /** Select returns an opaque per-dispatch generation. A thread id is stable
   * across turns, so it is never sufficient proof that a late completion or
   * watchdog callback still belongs to the computer currently mounted. */
  select(botId: string, threadId: string, targetKey: string, generation = this.tokenFactory()): string {
    const previous = this.byBot.get(botId);
    if (previous) {
      const threadOwner = this.byThread.get(previous.threadId);
      if (threadOwner?.botId === botId && threadOwner.generation === previous.generation) {
        this.byThread.delete(previous.threadId);
      }
    }
    this.byBot.set(botId, { threadId, targetKey, generation });
    this.byThread.set(threadId, { botId, generation });
    return generation;
  }

  forBot(botId: string): string | null {
    return this.byBot.get(botId)?.targetKey ?? null;
  }

  /** Read target and dispatch generation as one authority snapshot. */
  selectionForBot(botId: string): { threadId: string; targetKey: string; generation: string } | null {
    const current = this.byBot.get(botId);
    return current
      ? { threadId: current.threadId, targetKey: current.targetKey, generation: current.generation }
      : null;
  }

  generationForThread(threadId: string): string | null {
    return this.byThread.get(threadId)?.generation ?? null;
  }

  matchesThread(threadId: string, generation: string): boolean {
    return this.byThread.get(threadId)?.generation === generation;
  }

  /** A caller must present the generation it captured for its own dispatch.
   * This is deliberately a no-op for stale callbacks, including callbacks
   * for an older turn that reused the exact same thread id. */
  clearThread(threadId: string, generation: string): boolean {
    const owner = this.byThread.get(threadId);
    if (!owner || owner.generation !== generation) return false;
    this.byThread.delete(threadId);
    const current = this.byBot.get(owner.botId);
    if (current?.threadId === threadId && current.generation === generation) {
      this.byBot.delete(owner.botId);
    }
    return true;
  }

  clearBot(botId: string): void {
    const current = this.byBot.get(botId);
    if (current) {
      const threadOwner = this.byThread.get(current.threadId);
      if (threadOwner?.botId === botId && threadOwner.generation === current.generation) {
        this.byThread.delete(current.threadId);
      }
    }
    this.byBot.delete(botId);
  }
}

export type PublicComputerSurface = "physical" | "cloud" | "vm";

/** Lifecycle code compares exact physical identities, never merely bot busy.
 * A bot can be working without a computer, and shared targets can be owned by
 * another bot; equality is the authority boundary for destructive mutation. */
export function activeTurnOwnsTarget(activeTarget: string | null, targetKey: string): boolean {
  return activeTarget === targetKey;
}

/** A turn may not mount a different computer while this bot still owns a
 * human-control lease. Otherwise the human and bot would each act on a
 * different machine while both UIs claim exclusive control. */
export function controlLeaseConflictsWithSelection(
  leaseTarget: string | null,
  selectedTarget: string,
): boolean {
  return leaseTarget !== null && leaseTarget !== selectedTarget;
}

/** Runtime selection is the identity authority. A stale lease must never
 * retarget gates/viewers away from the computer the turn actually mounted. */
export function preferActiveControlTarget(
  activeTarget: string | null,
  leaseTarget: string | null,
): string | null {
  return activeTarget ?? leaseTarget;
}

/** Resolve what an idle panel is actually showing. In Auto, mere provider
 * configuration is not proof that a computer exists: prefer a ready physical
 * bridge, and use cloud only after a live readiness check. */
export function selectIdleControlSurface(input: {
  assignment: "cloud" | "vm" | "local" | "off" | undefined;
  requested?: PublicComputerSurface;
  physicalReady: boolean;
  cloudReady: boolean;
}): PublicComputerSurface | null {
  const explicit = input.assignment === "cloud"
    ? "cloud"
    : input.assignment === "vm"
      ? "vm"
      : input.assignment === "local"
        ? "physical"
        : input.assignment === "off"
          ? null
          : undefined;
  if (explicit !== undefined) return !input.requested || input.requested === explicit ? explicit : null;
  if (input.requested === "physical") return input.physicalReady ? "physical" : null;
  if (input.requested === "cloud") return input.cloudReady ? "cloud" : null;
  if (input.requested === "vm") return null;
  if (input.physicalReady) return "physical";
  return input.cloudReady ? "cloud" : null;
}
