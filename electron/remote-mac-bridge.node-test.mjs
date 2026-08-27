import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startRemoteMacBridge } from "./remote-mac-bridge.mjs";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

function fixture() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omb-mac-bridge-"));
  fs.chmodSync(userDataDir, 0o700);
  return {
    userDataDir,
    cleanup: () => fs.rmSync(userDataDir, { recursive: true, force: true }),
  };
}

const echoConnection = Promise.resolve({
  mode: "standalone",
  mcpCommand: process.execPath,
  mcpArgs: ["-e", "process.stdin.on('data',d=>process.stdout.write(d))"],
  mcpEnv: {},
});

test("authenticates, asks locally, and relays MCP bytes without exposing the token", async () => {
  const { userDataDir, cleanup } = fixture();
  const port = await freePort();
  let approvals = 0;
  const bridge = await startRemoteMacBridge({
    userDataDir,
    port,
    getConnection: () => echoConnection,
    approveConnection: async () => {
      approvals += 1;
      return true;
    },
    log: {},
  });
  try {
    const token = fs.readFileSync(bridge.tokenFile, "utf8").trim();
    assert.equal(fs.statSync(bridge.tokenFile).mode & 0o777, 0o600);
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(`OMB-MAC-BRIDGE/1 ${token}\nhello-mcp\n`);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("relay timeout")), 3_000);
      const check = () => {
        if (Buffer.concat(chunks).toString().includes("hello-mcp")) {
          clearTimeout(timeout);
          resolve();
        } else setTimeout(check, 10);
      };
      check();
    });
    assert.equal(Buffer.concat(chunks).toString(), "OK\nhello-mcp\n");
    assert.equal(approvals, 1);
    socket.destroy();
  } finally {
    await bridge.stop();
    cleanup();
  }
});

test("denies bad credentials before asking and honors a local denial", async () => {
  const { userDataDir, cleanup } = fixture();
  const port = await freePort();
  let approvals = 0;
  const bridge = await startRemoteMacBridge({
    userDataDir,
    port,
    getConnection: () => echoConnection,
    approveConnection: async () => {
      approvals += 1;
      return false;
    },
    log: {},
  });
  try {
    const bad = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port }, () =>
        socket.write(`OMB-MAC-BRIDGE/1 ${"x".repeat(43)}\n`),
      );
      socket.once("data", (chunk) => resolve(String(chunk)));
      socket.once("error", reject);
    });
    assert.equal(bad, "DENIED\n");
    assert.equal(approvals, 0);

    const token = fs.readFileSync(bridge.tokenFile, "utf8").trim();
    const denied = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port }, () =>
        socket.write(`OMB-MAC-BRIDGE/1 ${token}\n`),
      );
      socket.once("data", (chunk) => resolve(String(chunk)));
      socket.once("error", reject);
    });
    assert.equal(denied, "DENIED\n");
    assert.equal(approvals, 1);
  } finally {
    await bridge.stop();
    cleanup();
  }
});

test("the deployed stdio proxy relays through the authenticated bridge", async () => {
  const { userDataDir, cleanup } = fixture();
  const port = await freePort();
  const bridge = await startRemoteMacBridge({
    userDataDir,
    port,
    getConnection: () => echoConnection,
    approveConnection: async () => true,
    log: {},
  });
  try {
    const proxy = spawn(process.execPath, [
      path.resolve("scripts/remote-mac-mcp-proxy.mjs"),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--token-file",
      bridge.tokenFile,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    proxy.stdout.on("data", (chunk) => { output += String(chunk); });
    proxy.stdin.write("proxy-round-trip\n");
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("proxy timeout")), 3_000);
      const check = () => {
        if (output.includes("proxy-round-trip")) {
          clearTimeout(timeout);
          resolve();
        } else setTimeout(check, 10);
      };
      check();
    });
    assert.equal(output, "proxy-round-trip\n");
    proxy.kill("SIGTERM");
  } finally {
    await bridge.stop();
    cleanup();
  }
});

test("force-reaps a CUA child that ignores graceful shutdown after its socket closes", async () => {
  const { userDataDir, cleanup } = fixture();
  const port = await freePort();
  const stubbornConnection = Promise.resolve({
    mode: "standalone",
    mcpCommand: process.execPath,
    mcpArgs: [
      "-e",
      "process.on('SIGTERM',()=>{}); process.stdout.write(String(process.pid)+'\\n'); process.stdin.resume()",
    ],
    mcpEnv: {},
  });
  const bridge = await startRemoteMacBridge({
    userDataDir,
    port,
    getConnection: () => stubbornConnection,
    approveConnection: async () => true,
    log: {},
  });
  try {
    const token = fs.readFileSync(bridge.tokenFile, "utf8").trim();
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let output = "";
    socket.on("data", (chunk) => { output += String(chunk); });
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(`OMB-MAC-BRIDGE/1 ${token}\n`);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("child pid timeout")), 3_000);
      const check = () => {
        if (/OK\n\d+\n/.test(output)) {
          clearTimeout(timeout);
          resolve();
        } else setTimeout(check, 10);
      };
      check();
    });
    const childPid = Number(output.trim().split("\n")[1]);
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    assert.throws(() => process.kill(childPid, 0), /ESRCH/);
  } finally {
    await bridge.stop();
    cleanup();
  }
});

test("does not spawn CUA when the client disconnects while local approval is pending", async () => {
  const { userDataDir, cleanup } = fixture();
  const port = await freePort();
  let finishApproval;
  let spawnCount = 0;
  const bridge = await startRemoteMacBridge({
    userDataDir,
    port,
    getConnection: () => echoConnection,
    approveConnection: () => new Promise((resolve) => { finishApproval = resolve; }),
    spawnProcess: (...args) => {
      spawnCount += 1;
      return spawn(...args);
    },
    log: {},
  });
  try {
    const token = fs.readFileSync(bridge.tokenFile, "utf8").trim();
    const socket = net.createConnection({ host: "127.0.0.1", port });
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(`OMB-MAC-BRIDGE/1 ${token}\n`);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("approval did not start")), 1_000);
      const check = () => {
        if (finishApproval) {
          clearTimeout(timeout);
          resolve();
        } else setTimeout(check, 10);
      };
      check();
    });
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    finishApproval(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(spawnCount, 0);
  } finally {
    await bridge.stop();
    cleanup();
  }
});
