import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  normalizeRemoteLoopbackPorts,
  readRemoteLoopbackPorts,
  writeRemoteLoopbackPorts,
} from "./remote-loopback-ports.mjs";

test("persists one private pair of distinct unprivileged loopback ports", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omb-loopback-"));
  const file = path.join(root, "nested", "remote-loopback-ports.json");
  try {
    assert.equal(writeRemoteLoopbackPorts(file, { server: 59176, companion: 59177 }), true);
    assert.deepEqual(readRemoteLoopbackPorts(file), {
      version: 1,
      server: 59176,
      companion: 59177,
    });
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects malformed, privileged, duplicate and out-of-range ports", () => {
  for (const value of [
    null,
    [],
    {},
    { server: 80, companion: 59177 },
    { server: 59176, companion: 59176 },
    { server: 59176, companion: 70000 },
    { server: "59176", companion: 59177 },
  ]) {
    assert.equal(normalizeRemoteLoopbackPorts(value), null);
  }
});

test("a server-only remote client also retains its renderer origin", () => {
  assert.deepEqual(normalizeRemoteLoopbackPorts({ server: 59176, companion: null }), {
    version: 1,
    server: 59176,
    companion: null,
  });
});

test("a missing or malformed file has no preferred origin", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omb-loopback-"));
  const file = path.join(root, "remote-loopback-ports.json");
  try {
    assert.equal(readRemoteLoopbackPorts(file), null);
    fs.writeFileSync(file, "{not json");
    assert.equal(readRemoteLoopbackPorts(file), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the single-instance winner is established before any remote port is bound", () => {
  const source = fs.readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const lock = source.indexOf("app.requestSingleInstanceLock()");
  const connector = source.indexOf("await startOwnedRemoteSshConnector(");
  const persistence = source.indexOf("writeRemoteLoopbackPorts(REMOTE_LOOPBACK_PORTS_FILE");
  assert.ok(lock >= 0 && connector > lock && persistence > connector);
});
