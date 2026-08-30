import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import lifecycleModule from "./quit-lifecycle.cjs";

const { runQuitLifecycle, trackUtilityProcessExit } = lifecycleModule;

class FakeUtilityProcess extends EventEmitter {
  constructor(onKill = () => {}) {
    super();
    this.kills = 0;
    this.onKill = onKill;
  }

  kill() {
    this.kills += 1;
    this.onKill(this);
    return true;
  }
}

test("tracks a synchronous clean exit emitted by the graceful kill request", async () => {
  const child = new FakeUtilityProcess((process) => process.emit("exit", 0));
  const result = await runQuitLifecycle({
    serverProcess: child,
    serverExit: trackUtilityProcessExit(child),
  });

  assert.equal(child.kills, 1);
  assert.deepEqual(result.server, { ok: true, status: "exited", code: 0 });
  assert.equal(result.ok, true);
});

test("does not finish quit when the short auxiliary budget expires before the server exits", async () => {
  const child = new FakeUtilityProcess();
  const serverExit = trackUtilityProcessExit(child);
  let finished = false;
  const quitting = runQuitLifecycle({
    serverProcess: child,
    serverExit,
    stopAuxiliaries: () => new Promise(() => {}),
    auxiliaryTimeoutMs: 5,
    serverTimeoutMs: 200,
  }).then((value) => {
    finished = true;
    return value;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(finished, false);
  child.emit("exit", 0);
  const result = await quitting;
  assert.equal(result.auxiliaries.status, "timeout");
  assert.equal(result.server.status, "exited");
  assert.equal(result.ok, true);
});

test("marks a non-zero server exit as abnormal", async () => {
  const child = new FakeUtilityProcess((process) => process.emit("exit", 1));
  const result = await runQuitLifecycle({
    serverProcess: child,
    serverExit: trackUtilityProcessExit(child),
  });

  assert.deepEqual(result.server, { ok: false, status: "abnormal-exit", code: 1, requestError: null });
  assert.equal(result.ok, false);
});

test("fails closed when the server does not exit within its own bound", async () => {
  const child = new FakeUtilityProcess();
  const result = await runQuitLifecycle({
    serverProcess: child,
    serverExit: trackUtilityProcessExit(child),
    serverTimeoutMs: 10,
  });

  assert.equal(child.kills, 1);
  assert.deepEqual(result.server, { ok: false, status: "timeout", code: null, requestError: null });
  assert.equal(result.ok, false);
});

test("remote and development clients without an embedded server still run auxiliary cleanup", async () => {
  let stopped = false;
  const result = await runQuitLifecycle({
    stopAuxiliaries: async () => {
      stopped = true;
    },
  });

  assert.equal(stopped, true);
  assert.equal(result.server.status, "not-running");
  assert.equal(result.auxiliaries.status, "fulfilled");
  assert.equal(result.ok, true);
});
