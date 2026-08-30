import { describe, expect, it } from "vitest";

import {
  clearComputerLease,
  clearComputerLeaseIfCurrent,
  computerLeaseIsCurrent,
  computerLeaseResultIfCurrent,
  computerControlSnapshotSchema,
  computerControlTakeSchema,
  computerViewerJoinSchema,
  computerControlOwnerId,
  computerReleaseFailureIsTerminal,
  readComputerLease,
  writeComputerLease,
} from "./computer-control-lease";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe("computer control lease storage", () => {
  it("retains release authority across recoverable server and transport failures", () => {
    expect(computerReleaseFailureIsTerminal(403)).toBe(true);
    expect(computerReleaseFailureIsTerminal(409)).toBe(false);
    expect(computerReleaseFailureIsTerminal(500)).toBe(false);
    expect(computerReleaseFailureIsTerminal(503)).toBe(false);
  });

  it("keeps one owner id per live renderer document", () => {
    const first = computerControlOwnerId();
    expect(first).toBeTruthy();
    expect(computerControlOwnerId()).toBe(first);
  });

  it("never persists cloneable owner or lease authority in session storage", () => {
    const storage = memoryStorage();
    computerControlOwnerId();
    writeComputerLease("memory-only", { ownerId: "owner", leaseToken: "secret" });
    expect(storage.length).toBe(0);
    clearComputerLease("memory-only");
  });

  it("stores, reads, and clears a bot-scoped lease", () => {
    const storage = memoryStorage();
    writeComputerLease("bot-a", { ownerId: "owner", leaseToken: "secret" }, storage);
    expect(readComputerLease("bot-a", storage)).toEqual({ ownerId: "owner", leaseToken: "secret" });
    expect(readComputerLease("bot-b", storage)).toBeNull();
    clearComputerLease("bot-a", storage);
    expect(readComputerLease("bot-a", storage)).toBeNull();
  });

  it("does not let a deferred old-lease finalizer erase its successor", async () => {
    const storage = memoryStorage();
    const oldLease = { ownerId: "renderer-a", leaseToken: "lease-L1" };
    const successor = { ownerId: "renderer-a", leaseToken: "lease-L2" };
    writeComputerLease("bot-a", oldLease, storage);

    let release!: () => void;
    const deferred = new Promise<void>((resolve) => { release = resolve; });
    const staleFinalizer = (async () => {
      await deferred;
      return clearComputerLeaseIfCurrent("bot-a", oldLease, storage);
    })();

    writeComputerLease("bot-a", successor, storage);
    release();
    await expect(staleFinalizer).resolves.toBe(false);
    expect(computerLeaseIsCurrent("bot-a", successor, storage)).toBe(true);
    expect(readComputerLease("bot-a", storage)).toEqual(successor);
  });

  it("drops a delayed false-state probe after a successor lease is installed", async () => {
    const storage = memoryStorage();
    const oldLease = { ownerId: "renderer-a", leaseToken: "lease-L1" };
    const successor = { ownerId: "renderer-a", leaseToken: "lease-L2" };
    writeComputerLease("bot-a", oldLease, storage);

    let finishProbe!: (held: boolean) => void;
    const delayedFalse = computerLeaseResultIfCurrent(
      "bot-a",
      oldLease,
      () => new Promise<boolean>((resolve) => { finishProbe = resolve; }),
      storage,
    );

    writeComputerLease("bot-a", successor, storage);
    finishProbe(false);

    await expect(delayedFalse).resolves.toEqual({ current: false });
    expect(readComputerLease("bot-a", storage)).toEqual(successor);
  });

  it("clears only the exact captured lease", () => {
    const storage = memoryStorage();
    const lease = { ownerId: "renderer-a", leaseToken: "lease-L1" };
    writeComputerLease("bot-a", lease, storage);
    expect(clearComputerLeaseIfCurrent("bot-a", lease, storage)).toBe(true);
    expect(readComputerLease("bot-a", storage)).toBeNull();
  });

  it("rejects malformed authority and viewer responses", () => {
    expect(computerControlSnapshotSchema.safeParse({ held: true, helpReason: null }).success).toBe(true);
    expect(computerControlSnapshotSchema.safeParse({ held: "yes", helpReason: null }).success).toBe(false);
    expect(computerControlTakeSchema.safeParse({ held: true, helpReason: null }).success).toBe(false);
    expect(computerViewerJoinSchema.safeParse({ joinUrl: "" }).success).toBe(false);
  });
});
