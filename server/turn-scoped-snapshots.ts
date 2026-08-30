import type { InternalCapabilityTurn } from "./internal-capabilities.ts";

function turnKey(turn: InternalCapabilityTurn): string {
  return `${turn.botId}\u0000${turn.threadId}\u0000${turn.generation}`;
}

/**
 * Keeps trusted configuration immutable for one exact provider turn.
 *
 * A long-lived integration must not reread a credential or authority-bearing
 * endpoint after dispatch: rotating the backing file halfway through a turn
 * would otherwise change who that already-running child can act as. Values
 * live only in the trusted server and are removed synchronously with turn
 * authority.
 */
export class TurnScopedSnapshots<T extends object> {
  private readonly values = new Map<string, Readonly<T>>();

  get(turn: InternalCapabilityTurn): Readonly<T> | null {
    return this.values.get(turnKey(turn)) ?? null;
  }

  capture(turn: InternalCapabilityTurn, value: T): Readonly<T> {
    const key = turnKey(turn);
    const existing = this.values.get(key);
    if (existing) return existing;
    const snapshot = Object.freeze({ ...value }) as Readonly<T>;
    this.values.set(key, snapshot);
    return snapshot;
  }

  finish(turn: InternalCapabilityTurn): boolean {
    return this.values.delete(turnKey(turn));
  }

  get size(): number {
    return this.values.size;
  }
}
