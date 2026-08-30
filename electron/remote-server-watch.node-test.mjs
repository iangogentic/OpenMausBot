import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { watchRemoteServer } from "./remote-server-watch.mjs";

function harness(fetchImpl) {
  const webContents = new EventEmitter();
  const windowEvents = new EventEmitter();
  const loads = [];
  const intervals = [];
  const win = {
    webContents,
    isDestroyed: () => false,
    loadURL: async (url) => { loads.push(url); },
    once: windowEvents.once.bind(windowEvents),
  };
  watchRemoteServer(win, "http://remote.test", {
    fetchImpl,
    setIntervalImpl: (callback) => {
      intervals.push(callback);
      return { unref() {} };
    },
    clearIntervalImpl: () => {},
    timeoutSignal: () => undefined,
  });
  return { intervals, loads, webContents };
}

test("does not reload a live renderer after a transient health miss", async () => {
  let healthy = true;
  const state = harness(async () => {
    if (!healthy) throw new Error("temporary tunnel miss");
    return { ok: true };
  });
  await new Promise((resolve) => setImmediate(resolve));
  healthy = false;
  await state.intervals[0]();
  await new Promise((resolve) => setImmediate(resolve));
  healthy = true;
  await state.intervals[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.loads, []);
});

test("reloads the UI bundle after a confirmed sustained outage recovers", async () => {
  let healthy = true;
  const state = harness(async () => {
    if (!healthy) throw new Error("backend unavailable");
    return { ok: true };
  });
  await new Promise((resolve) => setImmediate(resolve));
  healthy = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await state.intervals[0]();
    await new Promise((resolve) => setImmediate(resolve));
  }
  healthy = true;
  await state.intervals[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.loads, ["http://remote.test"]);
});

test("reloads only after the remote main document itself failed", async () => {
  const state = harness(async () => ({ ok: true }));
  state.webContents.emit("did-fail-load", {}, -105, "offline", "http://remote.test/", true);
  await state.intervals[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.loads, ["http://remote.test"]);
});

test("ignores subframe and foreign-origin failures", async () => {
  const state = harness(async () => ({ ok: true }));
  state.webContents.emit("did-fail-load", {}, -1, "subframe", "http://remote.test/frame", false);
  state.webContents.emit("did-fail-load", {}, -1, "foreign", "https://example.test/", true);
  await state.intervals[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.loads, []);
});
