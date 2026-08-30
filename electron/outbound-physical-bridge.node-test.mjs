import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { Duplex, PassThrough, Writable } from "node:stream";
import test from "node:test";

import { ClientWebSocket, startOutboundPhysicalBridge } from "./outbound-physical-bridge.mjs";
import {
  PHYSICAL_BRIDGE_ORIGIN,
  PHYSICAL_BRIDGE_PATH,
  PhysicalBridgeRegistry,
} from "../server/physical-bridge.ts";
import { acceptRawWebSocket } from "../server/raw-websocket.ts";

const TOKEN = "app-session-" + "x".repeat(48);
const GENERATION = "10000000-0000-4000-8000-000000000001";

test("Mac bridge WebSocket surfaces write backpressure instead of retaining an unbounded queue", () => {
  const socket = new Duplex({
    readableHighWaterMark: 1,
    writableHighWaterMark: 1,
    read() {},
    write(_chunk, _encoding, _callback) {},
  });
  const ws = new ClientWebSocket(socket);

  assert.equal(ws.sendText("backpressure"), false);
  assert.equal(ws.writeBackpressured, true);
  const queuedBytes = socket.writableLength;
  assert.equal(ws.sendText("must-not-grow-the-queue"), false);
  assert.equal(socket.writableLength, queuedBytes);
  let drained = false;
  ws.onDrain(() => { drained = true; });
  socket.emit("drain");
  assert.equal(drained, true);
  assert.equal(ws.writeBackpressured, false);
  ws.pause();
  assert.equal(socket.isPaused(), true);
  ws.resume();
  assert.equal(socket.isPaused(), false);
  ws.destroy();
});

test("a server frame coalesced with the HTTP upgrade is delivered after listeners attach", () => {
  const payload = Buffer.from(JSON.stringify({ type: "registered" }));
  const head = Buffer.concat([
    Buffer.from([0x81, payload.length]),
    payload,
  ]);
  const socket = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) { callback(); },
  });
  const ws = new ClientWebSocket(socket, head);
  let received = null;
  ws.onMessage((message) => { received = message.data.toString("utf8"); });
  assert.equal(received, payload.toString("utf8"));
  ws.destroy();
});

async function eventually(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition timed out");
}

async function fixture() {
  const registry = new PhysicalBridgeRegistry();
  let attachedSocket = null;
  const server = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  server.on("upgrade", (req, socket, head) => {
    if (
      req.url !== PHYSICAL_BRIDGE_PATH ||
      req.headers.origin !== PHYSICAL_BRIDGE_ORIGIN ||
      req.headers["x-openmausbot-session"] !== TOKEN
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const ws = acceptRawWebSocket(req, socket, head);
    if (!ws) {
      socket.destroy();
      return;
    }
    attachedSocket = ws;
    registry.attachAuthenticated(ws);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    registry,
    serverUrl: `http://127.0.0.1:${address.port}`,
    sendRaw: (frame) => attachedSocket?.sendText(JSON.stringify(frame)) ?? false,
    close: async () => new Promise((resolve) => server.close(resolve)),
  };
}

const echoConnection = {
  mode: "embedded",
  generation: GENERATION,
  mcpCommand: process.execPath,
  mcpArgs: ["-e", "process.stdin.on('data', data => process.stdout.write(data))"],
  mcpEnv: {},
};

const stderrFloodConnection = {
  ...echoConnection,
  mcpArgs: ["-e", `
    process.stderr.write("discarded-stderr-secret-marker\\n");
    const chunk = Buffer.alloc(64 * 1024, 120);
    let remaining = 4 * 1024 * 1024;
    const flood = () => {
      while (remaining > 0) {
        remaining -= chunk.length;
        if (!process.stderr.write(chunk)) {
          process.stderr.once("drain", flood);
          return;
        }
      }
      process.stdin.on("data", data => process.stdout.write(data));
    };
    flood();
  `],
};

test("authenticates outbound, permits a slow human decision, and relays MCP without a disk token", async () => {
  const remote = await fixture();
  let decide;
  let approvalRequest;
  let childEnvironmentChecked = false;
  const bridge = await startOutboundPhysicalBridge({
    serverUrl: remote.serverUrl,
    sessionToken: TOKEN,
    platform: "darwin",
    getConnection: async () => ({
      ...echoConnection,
      mcpEnv: {
        OMB_COMPANION_SESSION_TOKEN: "must-not-cross",
        OMB_PROVIDER_LAUNCHER: "/must/not/cross",
        OPENAI_API_KEY: "must-not-cross",
        CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
      },
    }),
    approveConnection: (request) => new Promise((resolve) => {
      approvalRequest = request;
      decide = resolve;
    }),
    spawnProcess: (command, args, options) => {
      assert.equal(options.env.OMB_COMPANION_SESSION_TOKEN, undefined);
      assert.equal(options.env.OMB_PROVIDER_LAUNCHER, undefined);
      assert.equal(options.env.OPENAI_API_KEY, undefined);
      assert.equal(options.env.CUA_DRIVER_RS_TELEMETRY_ENABLED, "0");
      childEnvironmentChecked = true;
      return spawn(command, args, options);
    },
    reconnect: false,
    log: {},
  });
  try {
    const registration = await eventually(() => remote.registry.current);
    let opened = false;
    let output = "";
    const session = remote.registry.openSession(registration.registrationId, {
      botId: "bot-7",
      botLabel: "Research Cat",
      taskLabel: "Audit browser handoff",
      onOpened: () => { opened = true; },
      onData: (data) => { output += data.toString(); },
      onClose: () => {},
    });
    assert.ok(session);
    await eventually(() => decide);
    assert.equal(approvalRequest.botId, "bot-7");
    assert.equal(approvalRequest.botLabel, "Research Cat");
    assert.equal(approvalRequest.taskLabel, "Audit browser handoff");
    assert.equal(approvalRequest.sessionId, session.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(opened, false);
    decide("once");
    await eventually(() => opened);
    assert.equal(session.send(Buffer.from("slow-approval-round-trip\n")), true);
    await eventually(() => output.includes("slow-approval-round-trip"));
    assert.equal(output, "slow-approval-round-trip\n");
    assert.equal(childEnvironmentChecked, true);
    assert.equal(bridge.connected, true);
  } finally {
    await bridge.stop();
    await remote.close();
  }
});

test("a synchronous CUA spawn failure closes only that session without an unhandled rejection", async () => {
  const remote = await fixture();
  let unhandled = null;
  const onUnhandled = (error) => { unhandled = error; };
  process.once("unhandledRejection", onUnhandled);
  const bridge = await startOutboundPhysicalBridge({
    serverUrl: remote.serverUrl,
    sessionToken: TOKEN,
    platform: "darwin",
    getConnection: async () => echoConnection,
    approveConnection: async () => "once",
    spawnProcess: () => { throw new Error("synthetic spawn failure with secret text"); },
    reconnect: false,
    log: {},
  });
  try {
    const registration = await eventually(() => remote.registry.current);
    let closedReason = null;
    const session = remote.registry.openSession(registration.registrationId, {
      onOpened: () => assert.fail("failed spawn must never open"),
      onData: () => {},
      onClose: (reason) => { closedReason = reason; },
    });
    assert.ok(session);
    await eventually(() => closedReason);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closedReason, "local CUA session closed");
    assert.equal(unhandled, null);
    assert.equal(bridge.connected, true);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    await bridge.stop();
    await remote.close();
  }
});

test("a duplicate server spawn proof is rejected before any second child can exist", async () => {
  const remote = await fixture();
  let connectionCalls = 0;
  let releaseConnection;
  const delayedConnection = new Promise((resolve) => { releaseConnection = resolve; });
  let spawns = 0;
  const bridge = await startOutboundPhysicalBridge({
    serverUrl: remote.serverUrl,
    sessionToken: TOKEN,
    platform: "darwin",
    getConnection: async () => {
      connectionCalls += 1;
      return connectionCalls === 1 ? echoConnection : delayedConnection;
    },
    approveConnection: async () => "once",
    spawnProcess: (...args) => { spawns += 1; return spawn(...args); },
    reconnect: false,
    log: {},
  });
  try {
    const registration = await eventually(() => remote.registry.current);
    const session = remote.registry.openSession(registration.registrationId, {
      onOpened: () => assert.fail("replayed spawn must not open"),
      onData: () => {},
      onClose: () => {},
    });
    assert.ok(session);
    await eventually(() => connectionCalls === 2);
    assert.equal(remote.sendRaw({
      type: "spawn",
      sessionId: session.sessionId,
      executorGeneration: GENERATION,
    }), true);
    await eventually(() => remote.registry.current === null);
    assert.equal(spawns, 0);
  } finally {
    releaseConnection(echoConnection);
    await bridge.stop();
    await remote.close();
  }
});

test("server cancellation force-reaps a TERM-ignoring local CUA child", async () => {
  class StubbornCuaChild extends EventEmitter {
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
        queueMicrotask(() => this.emit("exit", null, signal));
      }
      return true;
    }
  }
  const remote = await fixture();
  let child;
  const bridge = await startOutboundPhysicalBridge({
    serverUrl: remote.serverUrl,
    sessionToken: TOKEN,
    platform: "darwin",
    getConnection: async () => echoConnection,
    approveConnection: async () => "once",
    spawnProcess: () => {
      child = new StubbornCuaChild();
      return child;
    },
    reconnect: false,
    log: {},
  });
  try {
    const registration = await eventually(() => remote.registry.current);
    let opened = false;
    const session = remote.registry.openSession(registration.registrationId, {
      onOpened: () => { opened = true; },
      onData: () => {},
      onClose: () => {},
    });
    assert.ok(session);
    await eventually(() => opened);

    session.close("server revoked exact turn");
    await eventually(() => child?.signalCode === "SIGKILL", 2_500);
    assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  } finally {
    await bridge.stop();
    await remote.close();
  }
});

test("a CUA child that never drains stdin is closed instead of holding a turn forever", async () => {
  class BlockedCuaChild extends EventEmitter {
    stdin = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, _callback) {},
    });
    stdout = new PassThrough();
    stderr = new PassThrough();
    exitCode = null;
    signalCode = null;
    kill(signal = "SIGTERM") {
      this.signalCode = signal;
      queueMicrotask(() => this.emit("exit", null, signal));
      return true;
    }
  }
  const remote = await fixture();
  const bridge = await startOutboundPhysicalBridge({
    serverUrl: remote.serverUrl,
    sessionToken: TOKEN,
    platform: "darwin",
    getConnection: async () => echoConnection,
    approveConnection: async () => "once",
    spawnProcess: () => new BlockedCuaChild(),
    inputDrainTimeoutMs: 250,
    reconnect: false,
    log: {},
  });
  try {
    const registration = await eventually(() => remote.registry.current);
    let opened = false;
    let closedReason = null;
    const session = remote.registry.openSession(registration.registrationId, {
      onOpened: () => { opened = true; },
      onData: () => {},
      onClose: (reason) => { closedReason = reason; },
    });
    assert.ok(session);
    await eventually(() => opened);
    assert.equal(session.send(Buffer.from("request that fills child stdin\n")), true);
    await eventually(() => closedReason, 2_000);
    assert.equal(closedReason, "local CUA session closed");
  } finally {
    await bridge.stop();
    await remote.close();
  }
});

test("CUA stderr beyond pipe capacity is discarded so MCP cannot deadlock", async () => {
  const remote = await fixture();
  const logs = [];
  const bridge = await startOutboundPhysicalBridge({
    serverUrl: remote.serverUrl,
    sessionToken: TOKEN,
    platform: "darwin",
    getConnection: async () => stderrFloodConnection,
    approveConnection: async () => "once",
    reconnect: false,
    log: { warn: (line) => logs.push(String(line)) },
  });
  try {
    const registration = await eventually(() => remote.registry.current);
    let opened = false;
    let output = "";
    const session = remote.registry.openSession(registration.registrationId, {
      onOpened: () => { opened = true; },
      onData: (data) => { output += data.toString(); },
      onClose: () => {},
    });
    assert.ok(session);
    await eventually(() => opened);
    assert.equal(session.send(Buffer.from("response-after-four-megabytes-of-stderr\n")), true);
    await eventually(() => output.includes("response-after-four-megabytes-of-stderr"), 5_000);
    assert.equal(output, "response-after-four-megabytes-of-stderr\n");
    assert.equal(logs.some((line) => line.includes("discarded-stderr-secret-marker")), false);
  } finally {
    await bridge.stop();
    await remote.close();
  }
});

test("an existing physical session cannot act while another connection prompt is pending", async () => {
  const remote = await fixture();
  let approvalCalls = 0;
  let decideSecond;
  const bridge = await startOutboundPhysicalBridge({
    serverUrl: remote.serverUrl,
    sessionToken: TOKEN,
    platform: "darwin",
    getConnection: async () => echoConnection,
    approveConnection: async () => {
      approvalCalls += 1;
      if (approvalCalls === 1) return "once";
      return new Promise((resolve) => { decideSecond = resolve; });
    },
    reconnect: false,
    log: {},
  });
  try {
    const registration = await eventually(() => remote.registry.current);
    let firstOpened = false;
    let firstClosed = false;
    let firstOutput = "";
    const first = remote.registry.openSession(registration.registrationId, {
      onOpened: () => { firstOpened = true; },
      onData: (data) => { firstOutput += data.toString(); },
      onClose: () => { firstClosed = true; },
    });
    assert.ok(first);
    await eventually(() => firstOpened);

    const second = remote.registry.openSession(registration.registrationId, {
      onOpened: () => assert.fail("pending approval must not open"),
      onData: () => {},
      onClose: () => {},
    });
    assert.ok(second);
    await eventually(() => decideSecond);
    assert.equal(first.send(Buffer.from("must-not-reach-local-cua\n")), true);
    await eventually(() => firstClosed);
    assert.equal(firstOutput, "");
    assert.equal(remote.registry.current, null);
  } finally {
    decideSecond?.(false);
    await bridge.stop();
    await remote.close();
  }
});

test("server cancellation cannot release the action fence before the native dialog is actually gone", async () => {
  const remote = await fixture();
  let approvalCalls = 0;
  let dialogAborted = false;
  let finishDialog;
  const bridge = await startOutboundPhysicalBridge({
    serverUrl: remote.serverUrl,
    sessionToken: TOKEN,
    platform: "darwin",
    getConnection: async () => echoConnection,
    approveConnection: async ({ signal }) => {
      approvalCalls += 1;
      if (approvalCalls === 1) return "once";
      signal.addEventListener("abort", () => { dialogAborted = true; }, { once: true });
      return new Promise((resolve) => { finishDialog = resolve; });
    },
    reconnect: false,
    log: {},
  });
  try {
    const registration = await eventually(() => remote.registry.current);
    let firstOpened = false;
    let firstClosed = false;
    let firstOutput = "";
    const first = remote.registry.openSession(registration.registrationId, {
      onOpened: () => { firstOpened = true; },
      onData: (data) => { firstOutput += data.toString(); },
      onClose: () => { firstClosed = true; },
    });
    assert.ok(first);
    await eventually(() => firstOpened);
    const second = remote.registry.openSession(registration.registrationId, {
      onOpened: () => assert.fail("cancelled session must not open"),
      onData: () => {},
      onClose: () => {},
    });
    assert.ok(second);
    await eventually(() => finishDialog);
    second.close("server cancelled while native dialog was pending");
    await eventually(() => dialogAborted);

    // The injected dialog deliberately has not settled yet. Cancellation of
    // its server session must not make this still-visible UI agent-clickable.
    assert.equal(first.send(Buffer.from("must-not-click-cancelling-dialog\n")), true);
    await eventually(() => firstClosed);
    assert.equal(firstOutput, "");
  } finally {
    finishDialog?.(false);
    await bridge.stop();
    await remote.close();
  }
});

test("the physical action fence releases only after the real approval dialog resolves", async () => {
  const remote = await fixture();
  let approvalCalls = 0;
  let decideSecond;
  const bridge = await startOutboundPhysicalBridge({
    serverUrl: remote.serverUrl,
    sessionToken: TOKEN,
    platform: "darwin",
    getConnection: async () => echoConnection,
    approveConnection: async () => {
      approvalCalls += 1;
      if (approvalCalls === 1) return "once";
      return new Promise((resolve) => { decideSecond = resolve; });
    },
    reconnect: false,
    log: {},
  });
  try {
    const registration = await eventually(() => remote.registry.current);
    let firstOpened = false;
    let firstOutput = "";
    const first = remote.registry.openSession(registration.registrationId, {
      onOpened: () => { firstOpened = true; },
      onData: (data) => { firstOutput += data.toString(); },
      onClose: () => {},
    });
    assert.ok(first);
    await eventually(() => firstOpened);

    let secondClosed = false;
    const second = remote.registry.openSession(registration.registrationId, {
      onOpened: () => assert.fail("denied session must not open"),
      onData: () => {},
      onClose: () => { secondClosed = true; },
    });
    assert.ok(second);
    await eventually(() => decideSecond);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(firstOutput, "");
    decideSecond(false);
    await eventually(() => secondClosed);

    assert.equal(first.send(Buffer.from("allowed-after-human-denial\n")), true);
    await eventually(() => firstOutput.includes("allowed-after-human-denial"));
    assert.equal(firstOutput, "allowed-after-human-denial\n");
  } finally {
    await bridge.stop();
    await remote.close();
  }
});

test("physical approval dialogs are serialized", async () => {
  const remote = await fixture();
  let activeApprovals = 0;
  let maxActiveApprovals = 0;
  const decisions = [];
  const bridge = await startOutboundPhysicalBridge({
    serverUrl: remote.serverUrl,
    sessionToken: TOKEN,
    platform: "darwin",
    getConnection: async () => echoConnection,
    approveConnection: () => {
      activeApprovals += 1;
      maxActiveApprovals = Math.max(maxActiveApprovals, activeApprovals);
      return new Promise((resolve) => decisions.push((decision) => {
        activeApprovals -= 1;
        resolve(decision);
      }));
    },
    reconnect: false,
    log: {},
  });
  try {
    const registration = await eventually(() => remote.registry.current);
    let firstOpened = false;
    const first = remote.registry.openSession(registration.registrationId, {
      onOpened: () => { firstOpened = true; },
      onData: () => {},
      onClose: () => {},
    });
    const second = remote.registry.openSession(registration.registrationId, {
      onOpened: () => {},
      onData: () => {},
      onClose: () => {},
    });
    assert.ok(first);
    assert.ok(second);
    await eventually(() => decisions.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(decisions.length, 1);
    decisions[0]("once");
    await eventually(() => decisions.length === 2);
    assert.equal(maxActiveApprovals, 1);
    decisions[1](false);
    await eventually(() => firstOpened);
  } finally {
    await bridge.stop();
    await remote.close();
  }
});

test("Always Allow skips only later connection prompts while sessions remain server-opened", async () => {
  const remote = await fixture();
  let approvalCalls = 0;
  const bridge = await startOutboundPhysicalBridge({
    serverUrl: remote.serverUrl,
    sessionToken: TOKEN,
    platform: "darwin",
    getConnection: async () => echoConnection,
    approveConnection: async () => {
      approvalCalls += 1;
      return "always";
    },
    reconnect: false,
    log: {},
  });
  try {
    const registration = await eventually(() => remote.registry.current);
    let firstOpened = false;
    const first = remote.registry.openSession(registration.registrationId, {
      onOpened: () => { firstOpened = true; },
      onData: () => {},
      onClose: () => {},
    });
    assert.ok(first);
    await eventually(() => firstOpened);
    first.close("first exact turn ended");

    let secondOpened = false;
    const second = remote.registry.openSession(registration.registrationId, {
      onOpened: () => { secondOpened = true; },
      onData: () => {},
      onClose: () => {},
    });
    assert.ok(second);
    await eventually(() => secondOpened);
    assert.equal(approvalCalls, 1);
    second.close("second exact turn ended");
  } finally {
    await bridge.stop();
    await remote.close();
  }
});

test("denial or disconnect while approval is pending never spawns CUA", async () => {
  const remote = await fixture();
  let decide;
  let spawns = 0;
  const bridge = await startOutboundPhysicalBridge({
    serverUrl: remote.serverUrl,
    sessionToken: TOKEN,
    platform: "darwin",
    getConnection: async () => echoConnection,
    approveConnection: () => new Promise((resolve) => { decide = resolve; }),
    spawnProcess: (...args) => { spawns += 1; return spawn(...args); },
    reconnect: false,
    log: {},
  });
  try {
    const registration = await eventually(() => remote.registry.current);
    const session = remote.registry.openSession(registration.registrationId, {
      onOpened: () => assert.fail("session must not open"),
      onData: () => {},
      onClose: () => {},
    });
    assert.ok(session);
    await eventually(() => decide);
    session.close("cancelled while dialog pending");
    const firstDecision = decide;
    decide = null;
    firstDecision("once");
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(spawns, 0);
  } finally {
    await bridge.stop();
    await remote.close();
  }
});

test("wrong UI session is rejected before registration and no secret is logged", async () => {
  const remote = await fixture();
  const logs = [];
  const bridge = await startOutboundPhysicalBridge({
    serverUrl: remote.serverUrl,
    sessionToken: "wrong-session-" + "z".repeat(48),
    platform: "darwin",
    getConnection: async () => echoConnection,
    approveConnection: async () => "once",
    reconnect: false,
    log: { warn: (line) => logs.push(String(line)) },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(remote.registry.current, null);
    assert.equal(bridge.connected, false);
    assert.equal(logs.some((line) => line.includes("wrong-session")), false);
  } finally {
    await bridge.stop();
    await remote.close();
  }
});

test("a listener that accepts but never completes the WebSocket handshake times out", async () => {
  const silent = createServer(() => {
    // Deliberately keep the HTTP request open without headers or a body.
  });
  await new Promise((resolve, reject) => {
    silent.once("error", reject);
    silent.listen(0, "127.0.0.1", resolve);
  });
  const address = silent.address();
  const logs = [];
  const startedAt = Date.now();
  const bridge = await startOutboundPhysicalBridge({
    serverUrl: `http://127.0.0.1:${address.port}`,
    sessionToken: TOKEN,
    platform: "darwin",
    getConnection: async () => echoConnection,
    approveConnection: async () => "once",
    reconnect: false,
    connectTimeoutMs: 250,
    log: { warn: (line) => logs.push(String(line)) },
  });
  try {
    assert.equal(bridge.connected, false);
    assert.ok(Date.now() - startedAt < 2_000);
    assert.equal(logs.some((line) => line.includes(TOKEN)), false);
  } finally {
    await bridge.stop();
    await new Promise((resolve) => silent.close(resolve));
  }
});

test("external origins and unbounded approval deadlines fail before any bearer is sent", async () => {
  const common = {
    sessionToken: TOKEN,
    platform: "darwin",
    getConnection: async () => echoConnection,
    approveConnection: async () => "once",
    reconnect: false,
    log: {},
  };
  await assert.rejects(
    startOutboundPhysicalBridge({ ...common, serverUrl: "https://example.com" }),
    /loopback server origin/,
  );
  await assert.rejects(
    startOutboundPhysicalBridge({
      ...common,
      serverUrl: "http://127.0.0.1:1",
      approvalTimeoutMs: Number.POSITIVE_INFINITY,
    }),
    /approval timeout/,
  );
});
