import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

export interface BoundedLogLimits {
  maxEntryBytes: number;
  maxSegmentBytes: number;
  /** Includes the active file. */
  maxSegmentsPerTenant: number;
  maxDirectoryBytes: number;
}
export const PERSISTENT_LOG_LIMITS: Readonly<BoundedLogLimits> = Object.freeze({
  maxEntryBytes: 256 * 1024,
  maxSegmentBytes: 2 * 1024 * 1024,
  maxSegmentsPerTenant: 3,
  maxDirectoryBytes: 128 * 1024 * 1024,
});

type DirectoryUsage = { dev: number; ino: number; bytes: number };
const usageCache = new Map<string, DirectoryUsage>();

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function limitsWithDefaults(input: Partial<BoundedLogLimits>): BoundedLogLimits {
  const limits = {
    maxEntryBytes: positive(input.maxEntryBytes ?? PERSISTENT_LOG_LIMITS.maxEntryBytes, "maxEntryBytes"),
    maxSegmentBytes: positive(input.maxSegmentBytes ?? PERSISTENT_LOG_LIMITS.maxSegmentBytes, "maxSegmentBytes"),
    maxSegmentsPerTenant: positive(
      input.maxSegmentsPerTenant ?? PERSISTENT_LOG_LIMITS.maxSegmentsPerTenant,
      "maxSegmentsPerTenant",
    ),
    maxDirectoryBytes: positive(
      input.maxDirectoryBytes ?? PERSISTENT_LOG_LIMITS.maxDirectoryBytes,
      "maxDirectoryBytes",
    ),
  };
  if (limits.maxEntryBytes > limits.maxSegmentBytes) {
    throw new TypeError("maxEntryBytes cannot exceed maxSegmentBytes");
  }
  if (limits.maxSegmentBytes > limits.maxDirectoryBytes) {
    throw new TypeError("maxSegmentBytes cannot exceed maxDirectoryBytes");
  }
  return limits;
}

/** Preserve ordinary UUID-like ids for compatibility; hash everything else. */
export function boundedLogTenantName(tenantId: string): string {
  if (/^[A-Za-z0-9_-]{1,128}$/.test(tenantId)) return tenantId;
  return `tenant-${createHash("sha256").update(tenantId).digest("hex").slice(0, 32)}`;
}

export function boundedLogPaths(
  directory: string,
  tenantId: string,
  maxSegments = PERSISTENT_LOG_LIMITS.maxSegmentsPerTenant,
): string[] {
  const active = join(directory, `${boundedLogTenantName(tenantId)}.ndjson`);
  return [active, ...Array.from({ length: Math.max(0, maxSegments - 1) }, (_, i) => `${active}.${i + 1}`)];
}

function regularFiles(directory: string): Array<{ path: string; bytes: number; mtimeMs: number }> {
  try {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isFile() || !/\.ndjson(?:\.\d+)?$/.test(entry.name)) return [];
      const path = join(directory, entry.name);
      try {
        const stat = statSync(path);
        return [{ path, bytes: stat.size, mtimeMs: stat.mtimeMs }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function directoryUsage(directory: string): DirectoryUsage {
  const root = statSync(directory);
  const cached = usageCache.get(directory);
  if (cached && cached.dev === root.dev && cached.ino === root.ino) return cached;
  const fresh = {
    dev: root.dev,
    ino: root.ino,
    bytes: regularFiles(directory).reduce((sum, file) => sum + file.bytes, 0),
  };
  usageCache.set(directory, fresh);
  return fresh;
}

function serializedRecord(value: unknown, maxBytes: number): Buffer {
  const json = JSON.stringify(value);
  const normal = Buffer.from(`${json === undefined ? "null" : json}\n`, "utf8");
  if (normal.length <= maxBytes) return normal;

  // Keep the replacement itself valid NDJSON. It intentionally contains only
  // a bounded preview of the already-redacted serialization supplied by the
  // caller; no recursive walk or second copy of the original object is kept.
  const originalBytes = normal.length - 1;
  let preview = (json ?? "null").slice(0, Math.max(0, Math.floor(maxBytes / 2)));
  for (;;) {
    const replacement = Buffer.from(
      `${JSON.stringify({ type: "log.entry.truncated", originalBytes, preview })}\n`,
      "utf8",
    );
    if (replacement.length <= maxBytes) return replacement;
    if (!preview.length) throw new Error("maxEntryBytes is too small for a truncation record");
    preview = preview.slice(0, Math.floor(preview.length * 0.75));
  }
}

function removeFile(path: string, usage: DirectoryUsage): void {
  try {
    const bytes = statSync(path).size;
    unlinkSync(path);
    usage.bytes = Math.max(0, usage.bytes - bytes);
  } catch {
    /* already absent */
  }
}

function rotate(paths: string[], usage: DirectoryUsage): void {
  removeFile(paths.at(-1)!, usage);
  for (let index = paths.length - 2; index >= 0; index--) {
    try {
      renameSync(paths[index]!, paths[index + 1]!);
    } catch {
      /* source did not exist */
    }
  }
}

function enforceAggregate(directory: string, usage: DirectoryUsage, maxBytes: number): void {
  if (usage.bytes <= maxBytes) return;
  const oldest = regularFiles(directory).sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  for (const file of oldest) {
    if (usage.bytes <= maxBytes) break;
    removeFile(file.path, usage);
  }
}

/** Append one valid NDJSON record with per-entry, tenant, and directory caps. */
export function appendBoundedNdjson(
  directory: string,
  tenantId: string,
  value: unknown,
  inputLimits: Partial<BoundedLogLimits> = {},
): void {
  const limits = limitsWithDefaults(inputLimits);
  const record = serializedRecord(value, limits.maxEntryBytes);
  const paths = boundedLogPaths(directory, tenantId, limits.maxSegmentsPerTenant);
  const usage = directoryUsage(directory);
  let activeBytes = 0;
  try {
    activeBytes = statSync(paths[0]!).size;
  } catch {}
  if (activeBytes > 0 && activeBytes + record.length > limits.maxSegmentBytes) rotate(paths, usage);
  appendFileSync(paths[0]!, record, { mode: 0o600 });
  // An existing file may have been created with a broader umask before this
  // hardening landed; appendFileSync's mode only applies at creation.
  if (process.platform !== "win32") chmodSync(paths[0]!, 0o600);
  usage.bytes += record.length;
  enforceAggregate(directory, usage, limits.maxDirectoryBytes);
}

export function deleteBoundedTenantLogs(
  directory: string,
  tenantId: string,
  maxSegments = PERSISTENT_LOG_LIMITS.maxSegmentsPerTenant,
): void {
  let usage: DirectoryUsage | null = null;
  try {
    usage = directoryUsage(directory);
  } catch {}
  for (const path of boundedLogPaths(directory, tenantId, maxSegments)) {
    if (usage) removeFile(path, usage);
    else {
      try {
        unlinkSync(path);
      } catch {}
    }
  }
}
