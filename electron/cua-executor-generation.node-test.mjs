import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { standaloneExecutorGeneration } = require("./cua-executor-generation.cjs");

const socketFs = (ino, birthtimeNs = 1000n) => ({
  statSync: () => ({
    isSocket: () => true,
    dev: 7n,
    ino: BigInt(ino),
    birthtimeNs,
    birthtimeMs: birthtimeNs / 1_000_000n,
  }),
});

test("standalone executor epoch is stable for the same live daemon socket", () => {
  const first = standaloneExecutorGeneration("/tmp/cua.sock", socketFs(11));
  const second = standaloneExecutorGeneration("/tmp/cua.sock", socketFs(11));
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(second, first);
});

test("recreated daemon socket produces a new executor epoch", () => {
  const oldEpoch = standaloneExecutorGeneration("/tmp/cua.sock", socketFs(11, 1000n));
  const newEpoch = standaloneExecutorGeneration("/tmp/cua.sock", socketFs(12, 2000n));
  assert.notEqual(newEpoch, oldEpoch);
});

test("missing or non-socket identity stays unverifiable", () => {
  assert.equal(standaloneExecutorGeneration("/tmp/missing", { statSync: () => { throw new Error("missing"); } }), null);
  assert.equal(standaloneExecutorGeneration("/tmp/file", { statSync: () => ({ isSocket: () => false }) }), null);
});
