import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  appendBoundedNdjson,
  boundedLogPaths,
  boundedLogTenantName,
  deleteBoundedTenantLogs,
} from "./bounded-log.ts";
import { removeTempDir } from "./testing/cleanup.ts";

describe("bounded persistent NDJSON logs", () => {
  const dirs: string[] = [];
  afterEach(async () => Promise.all(dirs.splice(0).map(removeTempDir)));

  const fresh = () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-bounded-log-"));
    dirs.push(dir);
    return dir;
  };

  it("rotates per tenant, caps entries, and keeps every segment valid NDJSON", () => {
    const dir = fresh();
    const limits = { maxEntryBytes: 160, maxSegmentBytes: 256, maxSegmentsPerTenant: 3, maxDirectoryBytes: 2_048 };
    for (let i = 0; i < 20; i++) appendBoundedNdjson(dir, "tenant-a", { i, text: "x".repeat(300) }, limits);

    const paths = boundedLogPaths(dir, "tenant-a", 3).filter((path) => {
      try { return statSync(path).isFile(); } catch { return false; }
    });
    expect(paths).toHaveLength(3);
    for (const path of paths) {
      expect(statSync(path).size).toBeLessThanOrEqual(256);
      for (const line of readFileSync(path, "utf8").trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("enforces the aggregate disk budget across tenants", () => {
    const dir = fresh();
    const limits = { maxEntryBytes: 96, maxSegmentBytes: 128, maxSegmentsPerTenant: 2, maxDirectoryBytes: 320 };
    for (let tenant = 0; tenant < 12; tenant++) {
      for (let row = 0; row < 3; row++) appendBoundedNdjson(dir, `tenant-${tenant}`, { row, value: "x".repeat(40) }, limits);
    }
    const total = readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
    expect(total).toBeLessThanOrEqual(320);
  });

  it("contains hostile tenant ids and deletes every rotated segment", () => {
    const dir = fresh();
    const hostile = "../../outside";
    expect(boundedLogTenantName(hostile)).toMatch(/^tenant-[a-f0-9]{32}$/);
    const limits = { maxEntryBytes: 64, maxSegmentBytes: 64, maxSegmentsPerTenant: 2, maxDirectoryBytes: 256 };
    appendBoundedNdjson(dir, hostile, { ok: true }, limits);
    expect(readdirSync(dir)).toHaveLength(1);
    deleteBoundedTenantLogs(dir, hostile, 2);
    expect(readdirSync(dir)).toEqual([]);
  });
});
