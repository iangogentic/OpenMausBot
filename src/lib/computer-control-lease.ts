import { z } from "zod";

const LEASE_PREFIX = "openmausbot.computer-control.lease.";
const storedLeaseSchema = z.object({ ownerId: z.string().min(1), leaseToken: z.string().min(1) });
const documentLeases = new Map<string, StoredComputerLease>();

export const computerControlSnapshotSchema = z.object({
  held: z.boolean(),
  helpReason: z.string().nullable().default(null),
  heldSinceMs: z.number().nullable().optional(),
  leaseExpiresAtMs: z.number().nullable().optional(),
  targetSurface: z.enum(["physical", "cloud", "vm"]).nullable().optional(),
  targetKey: z.string().min(1).nullable().optional(),
  targetGeneration: z.string().min(1).nullable().optional(),
});

export const computerControlTakeSchema = computerControlSnapshotSchema.extend({
  leaseToken: z.string().min(1),
});

export const computerViewerJoinSchema = z.object({ joinUrl: z.string().min(1) });
export const computerControlErrorSchema = z.object({ error: z.string().min(1) });
export const computerScreenshotSchema = z.object({
  png: z.string().min(1),
  format: z.enum(["png", "jpeg"]),
});
export const localComputerScreenshotSchema = z.object({ image: z.string().min(1) });

/** Only an authorization rejection proves this local lease token is stale.
 * A transport/5xx/target lookup failure may leave the exact server lease
 * alive, so retaining the proof is what lets the person retry hand-back. */
export function computerReleaseFailureIsTerminal(status: number): boolean {
  return status === 403;
}

export interface StoredComputerLease {
  ownerId: string;
  leaseToken: string;
}

function randomId(): string {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

// Deliberately memory-only. Browsers may clone sessionStorage when a tab is
// duplicated; storing the owner there would clone authority, allowing either
// live document to heartbeat or release the other's lease. A reload gets a
// new owner and the old short lease expires safely.
const documentOwnerId = randomId();

/** Stable for this live renderer document, never persisted or cloneable. */
export function computerControlOwnerId(): string {
  return documentOwnerId;
}

export function readComputerLease(
  botId: string,
  storage?: Storage,
): StoredComputerLease | null {
  if (!storage) return documentLeases.get(botId) ?? null;
  try {
    const parsed = storedLeaseSchema.safeParse(JSON.parse(storage.getItem(`${LEASE_PREFIX}${botId}`) ?? "null"));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeComputerLease(
  botId: string,
  lease: StoredComputerLease,
  storage?: Storage,
): void {
  if (storage) storage.setItem(`${LEASE_PREFIX}${botId}`, JSON.stringify(lease));
  else documentLeases.set(botId, lease);
}

export function clearComputerLease(botId: string, storage?: Storage): void {
  if (storage) storage.removeItem(`${LEASE_PREFIX}${botId}`);
  else documentLeases.delete(botId);
}

/** Exact renderer authority equality. Bot id alone is not a lease generation:
 * a release/heartbeat response for an old token may arrive after this document
 * has already taken control again with a successor token. */
export function sameComputerLease(
  left: StoredComputerLease | null | undefined,
  right: StoredComputerLease | null | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.ownerId === right.ownerId &&
    left.leaseToken === right.leaseToken,
  );
}

export function computerLeaseIsCurrent(
  botId: string,
  expected: StoredComputerLease,
  storage?: Storage,
): boolean {
  return sameComputerLease(readComputerLease(botId, storage), expected);
}

/** Clear only the exact captured lease. Returns false when a newer takeover is
 * already present, leaving that successor's proof untouched. */
export function clearComputerLeaseIfCurrent(
  botId: string,
  expected: StoredComputerLease,
  storage?: Storage,
): boolean {
  if (!computerLeaseIsCurrent(botId, expected, storage)) return false;
  clearComputerLease(botId, storage);
  return true;
}

export type FencedComputerLeaseResult<T> =
  | { current: true; value: T }
  | { current: false };

/** Run one async probe for an exact lease and fence its continuation on both
 * sides of the await. A delayed L1 GET/heartbeat/viewer callback therefore
 * cannot act after this renderer has installed L2 for the same bot. */
export async function computerLeaseResultIfCurrent<T>(
  botId: string,
  expected: StoredComputerLease,
  operation: () => Promise<T>,
  storage?: Storage,
): Promise<FencedComputerLeaseResult<T>> {
  if (!computerLeaseIsCurrent(botId, expected, storage)) return { current: false };
  const value = await operation();
  return computerLeaseIsCurrent(botId, expected, storage)
    ? { current: true, value }
    : { current: false };
}
