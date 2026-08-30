export interface PeerTurnIdentity {
  readonly botId: string;
  readonly threadId: string;
  readonly generation: string;
}

export interface PeerCallHandle {
  finish(): boolean;
  cancel(): Promise<boolean>;
}

interface PeerCall {
  source: PeerTurnIdentity;
  target: PeerTurnIdentity;
  cancelTarget: (target: PeerTurnIdentity) => Promise<void>;
  onCancelled: () => void;
}

const turnKey = (turn: PeerTurnIdentity) => `${turn.botId}\0${turn.threadId}\0${turn.generation}`;

/** Exact source→target ownership for synchronous ask_bot calls. */
export class PeerCallLifecycle {
  private readonly bySource = new Map<string, Set<PeerCall>>();
  private readonly drainsBySource = new Map<string, Promise<void>>();

  register(input: PeerCall): PeerCallHandle {
    const key = turnKey(input.source);
    const call: PeerCall = {
      source: Object.freeze({ ...input.source }),
      target: Object.freeze({ ...input.target }),
      cancelTarget: input.cancelTarget,
      onCancelled: input.onCancelled,
    };
    let calls = this.bySource.get(key);
    if (!calls) {
      calls = new Set();
      this.bySource.set(key, calls);
    }
    calls.add(call);
    const remove = () => {
      if (!calls!.delete(call)) return false;
      if (calls!.size === 0) this.bySource.delete(key);
      return true;
    };
    return {
      finish: remove,
      cancel: async () => {
        if (!remove()) return false;
        try {
          await call.cancelTarget(call.target);
        } finally {
          call.onCancelled();
        }
        return true;
      },
    };
  }

  cancelSource(source: PeerTurnIdentity): Promise<void> {
    const key = turnKey(source);
    const existing = this.drainsBySource.get(key);
    if (existing) return existing;
    const calls = this.bySource.get(key);
    if (!calls) return Promise.resolve();
    this.bySource.delete(key);
    const drain = this.cancelCalls([...calls], "one or more peer turns could not be stopped");
    this.drainsBySource.set(key, drain);
    // Lifecycle listeners are synchronous, so a Stop route may attach its
    // exact await immediately. The returned promise remains valid after this
    // registry entry is released; keeping every random generation forever
    // would otherwise leak memory on a long-running server.
    void drain.finally(() => {
      if (this.drainsBySource.get(key) === drain) this.drainsBySource.delete(key);
    }).catch(() => {});
    return drain;
  }

  waitForSource(source: PeerTurnIdentity): Promise<void> {
    return this.drainsBySource.get(turnKey(source)) ?? Promise.resolve();
  }

  activeDrainCount(): number {
    return this.drainsBySource.size;
  }

  cancelAll(): Promise<void> {
    const calls = [...this.bySource.values()].flatMap((entries) => [...entries]);
    this.bySource.clear();
    const drain = this.cancelCalls(calls, "one or more peer turns could not be stopped");
    void drain.catch(() => {});
    return drain;
  }

  private async cancelCalls(calls: PeerCall[], message: string): Promise<void> {
    const results = await Promise.allSettled(calls.map(async (call) => {
      try {
        await call.cancelTarget(call.target);
      } finally {
        call.onCancelled();
      }
    }));
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, message);
  }
}
