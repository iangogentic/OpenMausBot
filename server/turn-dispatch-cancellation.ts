export interface DispatchIdentity {
  readonly botId: string;
  readonly threadId: string;
  readonly generation: string;
}

export class TurnDispatchCancelled extends Error {
  constructor() {
    super("turn stopped before provider dispatch completed");
    this.name = "TurnDispatchCancelled";
  }
}

function sameDispatch(left: DispatchIdentity, right: DispatchIdentity): boolean {
  return left.botId === right.botId &&
    left.threadId === right.threadId &&
    left.generation === right.generation;
}

/**
 * Cancellation fence for the async gap between the HTTP send and a provider
 * actually owning the turn. Aborting rejects setup immediately; callers still
 * attach cleanup to any underlying operation that cannot itself be cancelled.
 */
export class TurnDispatchCancellations {
  private readonly pending = new Map<string, {
    turn: DispatchIdentity;
    controller: AbortController;
    settled: Promise<void>;
    resolveSettled: () => void;
    rejectSettled: (error: unknown) => void;
    operations: Set<Promise<void>>;
    completeRequested: boolean;
    failure?: unknown;
  }>();
  private readonly cancelledSettlements = new Map<string, {
    turn: DispatchIdentity;
    settled: Promise<void>;
  }>();

  private key(turn: DispatchIdentity): string {
    return `${turn.botId}\u0000${turn.threadId}\u0000${turn.generation}`;
  }

  private rememberCancelled(current: { turn: DispatchIdentity; settled: Promise<void> }): void {
    this.cancelledSettlements.set(this.key(current.turn), {
      turn: current.turn,
      settled: current.settled,
    });
  }

  begin(turn: DispatchIdentity): AbortSignal {
    // A cancelled provider-registration await is still capable of spawning a
    // child until sendTurn actually returns. Never let a replacement overwrite
    // that proof; the caller keeps the bot busy and calls complete() when the
    // old registration has definitively settled.
    if (this.pending.has(turn.botId)) {
      throw new Error("a provider dispatch is still settling for this bot");
    }
    const controller = new AbortController();
    let resolveSettled!: () => void;
    let rejectSettled!: (error: unknown) => void;
    const settled = new Promise<void>((resolve, reject) => {
      resolveSettled = resolve;
      rejectSettled = reject;
    });
    // A Stop waiter may attach after the late-child cleanup has already
    // failed. Observe now without consuming the rejection it must receive.
    void settled.catch(() => {});
    this.pending.set(turn.botId, {
      turn: Object.freeze({ ...turn }),
      controller,
      settled,
      resolveSettled,
      rejectSettled,
      operations: new Set(),
      completeRequested: false,
    });
    return controller.signal;
  }

  signal(turn: DispatchIdentity): AbortSignal | null {
    const current = this.pending.get(turn.botId);
    return current && sameDispatch(current.turn, turn) ? current.controller.signal : null;
  }

  isInFlight(turn: DispatchIdentity): boolean {
    const current = this.pending.get(turn.botId);
    return Boolean(current && sameDispatch(current.turn, turn));
  }

  isPending(turn: DispatchIdentity): boolean {
    const current = this.pending.get(turn.botId);
    return Boolean(current && sameDispatch(current.turn, turn) && !current.controller.signal.aborted);
  }

  assertPending(turn: DispatchIdentity): void {
    if (!this.isPending(turn)) throw new TurnDispatchCancelled();
  }

  async race<T>(turn: DispatchIdentity, operation: Promise<T>): Promise<T> {
    const current = this.pending.get(turn.botId);
    if (!current || !sameDispatch(current.turn, turn) || current.controller.signal.aborted) {
      // Observe a later rejection from a non-cancellable setup operation.
      void operation.catch(() => {});
      throw new TurnDispatchCancelled();
    }
    // The abort races only the caller's wait; it cannot magically cancel an
    // already-issued provider/SSH/HTTP operation. Keep an independent proof
    // for the underlying promise so reload/delete/shutdown cannot interpret
    // the wrapper rejection as "the setup can no longer create anything".
    let observed!: Promise<void>;
    observed = operation.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      current.operations.delete(observed);
      this.tryFinalize(current);
    });
    current.operations.add(observed);
    const { signal } = current.controller;
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => finish(() => reject(new TurnDispatchCancelled()));
      signal.addEventListener("abort", onAbort, { once: true });
      operation.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
      if (signal.aborted) onAbort();
    });
  }

  complete(turn: DispatchIdentity, failure?: unknown): boolean {
    const current = this.pending.get(turn.botId);
    if (!current || !sameDispatch(current.turn, turn)) return false;
    if (failure !== undefined && current.failure === undefined) current.failure = failure;
    current.completeRequested = true;
    this.tryFinalize(current);
    return !current.controller.signal.aborted;
  }

  cancelBot(botId: string): DispatchIdentity | null {
    const current = this.pending.get(botId);
    if (!current) return null;
    this.rememberCancelled(current);
    current.controller.abort();
    return current.turn;
  }

  cancelTurn(turn: DispatchIdentity): boolean {
    const current = this.pending.get(turn.botId);
    if (!current || !sameDispatch(current.turn, turn)) return false;
    this.rememberCancelled(current);
    current.controller.abort();
    return true;
  }

  cancelAll(): DispatchIdentity[] {
    const turns = [...this.pending.values()].map((entry) => entry.turn);
    for (const entry of this.pending.values()) {
      this.rememberCancelled(entry);
      entry.controller.abort();
    }
    return turns;
  }

  /** Wait until the exact cancelled sendTurn registrations can no longer
   * spawn a child. Reload uses this after disposing the old provider fleet and
   * before it marks bots idle or admits work on the replacement fleet. */
  async waitFor(turns: readonly DispatchIdentity[]): Promise<void> {
    const waits = turns.flatMap((turn) => {
      const current = this.pending.get(turn.botId);
      if (current && sameDispatch(current.turn, turn)) return [current.settled];
      const cancelled = this.cancelledSettlements.get(this.key(turn));
      return cancelled && sameDispatch(cancelled.turn, turn) ? [cancelled.settled] : [];
    });
    try {
      await Promise.all(waits);
    } finally {
      for (const turn of turns) this.cancelledSettlements.delete(this.key(turn));
    }
  }

  private tryFinalize(current: {
    turn: DispatchIdentity;
    controller: AbortController;
    settled: Promise<void>;
    resolveSettled: () => void;
    rejectSettled: (error: unknown) => void;
    operations: Set<Promise<void>>;
    completeRequested: boolean;
    failure?: unknown;
  }): void {
    if (!current.completeRequested || current.operations.size > 0) return;
    const mapped = this.pending.get(current.turn.botId);
    if (mapped !== current) return;
    this.pending.delete(current.turn.botId);
    if (current.failure !== undefined) current.rejectSettled(current.failure);
    else current.resolveSettled();
  }
}
