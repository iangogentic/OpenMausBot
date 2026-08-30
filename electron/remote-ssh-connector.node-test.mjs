import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";

import { remoteSshArgs, startOwnedRemoteSshConnector } from "./remote-ssh-connector.mjs";

const CONFIG = Object.freeze({
  companionEnabled: false,
  ssh: Object.freeze({
    host: "razer.example.test",
    user: "openmaus",
    port: 2222,
    hostPublicKey: `ssh-ed25519 ${Buffer.alloc(32, 7).toString("base64")}`,
    identityFile: null,
  }),
});

class FakeSshChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode = null;
  signalCode = null;
  constructor(onRequest) {
    super();
    this.stdin.once("data", (data) => onRequest(this, Buffer.from(data)));
  }
  kill(signal = "SIGTERM") {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.signalCode = signal;
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }
}

test("owned proxy pins every connection to exact OpenSSH host identity", async () => {
  const spawns = [];
  const requests = [];
  const connector = await startOwnedRemoteSshConnector(CONFIG, {
    sshBinary: process.platform === "win32" ? "C:\\Windows\\System32\\OpenSSH\\ssh.exe" : "/usr/bin/ssh",
    spawnProcess: (command, args, options) => {
      spawns.push({ command, args, options });
      return new FakeSshChild((child, request) => {
        requests.push(request.toString("latin1"));
        child.stdout.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
      });
    },
  });
  try {
    const token = `secret-${"s".repeat(40)}`;
    const response = await fetch(`${connector.serverUrl}/api/health`, {
      headers: { "x-openmausbot-session": token },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "{}");
    assert.equal(spawns.length, 1);
    const launch = spawns[0];
    assert.equal(
      launch.command,
      process.platform === "win32" ? "C:\\Windows\\System32\\OpenSSH\\ssh.exe" : "/usr/bin/ssh",
    );
    assert.ok(launch.args.includes("StrictHostKeyChecking=yes"));
    assert.ok(launch.args.includes("CheckHostIP=no"));
    assert.ok(launch.args.includes("VerifyHostKeyDNS=no"));
    assert.ok(launch.args.includes("UpdateHostKeys=no"));
    assert.ok(launch.args.includes("CanonicalizeHostname=no"));
    assert.ok(launch.args.includes("ProxyCommand=none"));
    assert.ok(launch.args.includes("ProxyJump=none"));
    assert.ok(launch.args.includes("127.0.0.1:8799"));
    assert.equal(launch.args.at(-1), CONFIG.ssh.host);
    assert.equal(JSON.stringify(launch).includes(token), false);
    assert.equal(requests.some((request) => request.includes(token)), true);

    const knownHostsOption = launch.args.find((value) => value.startsWith("UserKnownHostsFile="));
    const knownHostsFile = knownHostsOption.slice("UserKnownHostsFile=".length);
    assert.match(fs.readFileSync(knownHostsFile, "utf8"), /^\[razer\.example\.test\]:2222 ssh-ed25519 /);

    const port = Number(new URL(connector.serverUrl).port);
    const hostile = net.createServer();
    const occupied = await new Promise((resolve) => {
      hostile.once("error", (error) => resolve(error.code));
      hostile.listen(port, "127.0.0.1", () => resolve("bound"));
    });
    assert.equal(occupied, "EADDRINUSE");
    if (hostile.listening) hostile.close();
    await connector.stop();
    assert.equal(fs.existsSync(knownHostsFile), false);
  } finally {
    await connector.stop();
  }
});

test("SSH argv has a fixed -W target and cannot execute config text", () => {
  const args = remoteSshArgs(CONFIG.ssh, "/private/known_hosts", 8811);
  assert.deepEqual(args.slice(-3), ["-W", "127.0.0.1:8811", "razer.example.test"]);
  assert.equal(args.includes("sh"), false);
  assert.equal(args.includes("-c"), false);
});

test("connector shutdown waits for a stubborn SSH child to be force-reaped", async () => {
  let child;
  class StubbornSshChild extends EventEmitter {
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
    exitCode = null;
    signalCode = null;
    signals = [];
    kill(signal = "SIGTERM") {
      this.signals.push(signal);
      if (signal === "SIGKILL") {
        this.signalCode = signal;
        queueMicrotask(() => this.emit("close", null, signal));
      }
      return true;
    }
  }
  const connector = await startOwnedRemoteSshConnector(CONFIG, {
    sshBinary: process.platform === "win32" ? "C:\\Windows\\System32\\OpenSSH\\ssh.exe" : "/usr/bin/ssh",
    spawnProcess: () => {
      child = new StubbornSshChild();
      return child;
    },
  });
  const socket = net.createConnection({
    host: "127.0.0.1",
    port: Number(new URL(connector.serverUrl).port),
  });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  await new Promise((resolve) => setImmediate(resolve));

  await connector.stop();
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.signalCode, "SIGKILL");
});

test("Windows fails closed instead of accepting an unverified identityFile", async () => {
  await assert.rejects(
    startOwnedRemoteSshConnector({
      ...CONFIG,
      ssh: { ...CONFIG.ssh, identityFile: "C:\\Users\\Ian\\.ssh\\id_ed25519" },
    }, {
      platform: "win32",
      sshBinary: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
    }),
    /requires the OpenSSH agent|not accepted/,
  );
});

test("POSIX identityFile must be current-user-only and cannot be a symlink", {
  skip: process.platform === "win32",
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omb-ssh-key-"));
  try {
    const identity = path.join(directory, "id");
    fs.writeFileSync(identity, "private-test-key", { mode: 0o600 });
    fs.chmodSync(identity, 0o644);
    await assert.rejects(
      startOwnedRemoteSshConnector({ ...CONFIG, ssh: { ...CONFIG.ssh, identityFile: identity } }),
      /mode 0600/,
    );
    fs.chmodSync(identity, 0o600);
    const link = path.join(directory, "link");
    fs.symlinkSync(identity, link);
    await assert.rejects(
      startOwnedRemoteSshConnector({ ...CONFIG, ssh: { ...CONFIG.ssh, identityFile: link } }),
      /non-symlink/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
