import type { InternalCapabilityTurn } from "./internal-capabilities.ts";

function turnKey(turn: InternalCapabilityTurn): string {
  return `${turn.botId}\u0000${turn.threadId}\u0000${turn.generation}`;
}

function sameTurn(left: InternalCapabilityTurn, right: InternalCapabilityTurn): boolean {
  return left.botId === right.botId &&
    left.threadId === right.threadId &&
    left.generation === right.generation;
}

interface ExternalTurnEntry {
  readonly turn: InternalCapabilityTurn;
  readonly controller: AbortController;
  readonly operations: Set<Promise<void>>;
  readonly drained: Promise<void>;
  resolveDrained: () => void;
  cancelled: boolean;
}

/**
 * Owns every network/provider side effect launched through a turn-scoped
 * internal capability. Revoking the capability prevents new work; this
 * registry additionally aborts and drains work that already crossed the
 * upstream boundary so Stop/reload/delete cannot admit a successor while an
 * old generation may still mutate its remote computer or connected app.
 */
export class TurnExternalOperations {
  private readonly entries = new Map<string, ExternalTurnEntry>();

  run<T>(
    turn: InternalCapabilityTurn,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const entry = this.entry(turn);
    if (entry.cancelled || entry.controller.signal.aborted) {
      return Promise.reject(new DOMException("the source turn ended", "AbortError"));
    }

    let result: Promise<T>;
    try {
      result = operation(entry.controller.signal);
    } catch (error) {
      result = Promise.reject(error);
    }
    let observed!: Promise<void>;
    observed = result.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      entry.operations.delete(observed);
      this.maybeDrain(entry);
    });
    entry.operations.add(observed);
    return result;
  }

  cancelTurn(turn: InternalCapabilityTurn): Promise<void> {
    const entry = this.entries.get(turnKey(turn));
    if (!entry || !sameTurn(entry.turn, turn)) return Promise.resolve();
    entry.cancelled = true;
    entry.controller.abort();
    this.maybeDrain(entry);
    return entry.drained;
  }

  cancelBot(botId: string): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.turn.botId !== botId) continue;
      waits.push(this.cancelTurn(entry.turn));
    }
    return Promise.all(waits).then(() => undefined);
  }

  cancelAll(): Promise<void> {
    const waits = [...this.entries.values()].map((entry) => this.cancelTurn(entry.turn));
    return Promise.all(waits).then(() => undefined);
  }

  hasInFlightForBot(botId: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.turn.botId === botId && entry.operations.size > 0) return true;
    }
    return false;
  }

  hasInFlightForThread(threadId: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.turn.threadId === threadId && entry.operations.size > 0) return true;
    }
    return false;
  }

  waitFor(turns: readonly InternalCapabilityTurn[]): Promise<void> {
    const waits = turns.flatMap((turn) => {
      const entry = this.entries.get(turnKey(turn));
      return entry && sameTurn(entry.turn, turn) ? [entry.drained] : [];
    });
    return Promise.all(waits).then(() => undefined);
  }

  private entry(turn: InternalCapabilityTurn): ExternalTurnEntry {
    const key = turnKey(turn);
    const existing = this.entries.get(key);
    if (existing) return existing;
    let resolveDrained!: () => void;
    const drained = new Promise<void>((resolve) => { resolveDrained = resolve; });
    const entry: ExternalTurnEntry = {
      turn: Object.freeze({ ...turn }),
      controller: new AbortController(),
      operations: new Set(),
      drained,
      resolveDrained,
      cancelled: false,
    };
    this.entries.set(key, entry);
    return entry;
  }

  private maybeDrain(entry: ExternalTurnEntry): void {
    if (!entry.cancelled || entry.operations.size > 0) return;
    const key = turnKey(entry.turn);
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    entry.resolveDrained();
  }
}
