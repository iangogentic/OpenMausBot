/** A generation-aware, single-flight settlement registry. A provider may
 * reuse request ids after a turn, so identity is part of the key: only calls
 * for the exact same generation share the first delivery. */
export interface SettlementRecord<G, B, O> {
  readonly generation: G;
  readonly behavior: B;
  readonly promise: Promise<O>;
}

export class ProviderRequestSettlements<K, G, B, O> {
  readonly #records = new Map<K, SettlementRecord<G, B, O>>();

  settle(key: K, generation: G, behavior: B, deliver: () => Promise<O>): Promise<O> {
    const existing = this.#records.get(key);
    if (existing?.generation === generation) return existing.promise;
    const promise = deliver();
    this.#records.set(key, Object.freeze({ generation, behavior, promise }));
    return promise;
  }

  get(key: K): SettlementRecord<G, B, O> | null {
    return this.#records.get(key) ?? null;
  }

  delete(key: K, generation?: G): void {
    if (generation !== undefined && this.#records.get(key)?.generation !== generation) return;
    this.#records.delete(key);
  }
}
