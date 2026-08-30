import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import tls from "node:tls";

const BRIDGE_PATH = "/api/internal/physical-bridge/register";
const BRIDGE_ORIGIN = "openmausbot://desktop-main";
const PROTOCOL = 1;
const MAX_MCP_DATA_BYTES = 1024 * 1024;
// A 1 MiB decoded MCP line expands to about 1.34 MiB as base64 inside its
// authenticated JSON envelope. Keep the envelope bounded but large enough
// to carry the full decoded limit.
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_SESSIONS = 4;
const APPROVAL_TIMEOUT_MS = 120_000;
const CHILD_STOP_GRACE_MS = 1_000;
const CHILD_KILL_REAP_MS = 1_000;
const CHILD_INPUT_DRAIN_TIMEOUT_MS = 30_000;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const terminatingChildren = new WeakMap();

function loopback(hostname) {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return value === "localhost" || value.endsWith(".localhost") || value === "::1" ||
    value === "0:0:0:0:0:0:0:1" || /^127(?:\.[0-9]{1,3}){3}$/.test(value);
}

function websocketTarget(serverUrl) {
  const parsed = new URL(serverUrl);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !loopback(parsed.hostname) || parsed.username || parsed.password ||
    parsed.pathname !== "/" || parsed.search || parsed.hash
  ) throw new Error("physical bridge requires the configured loopback server origin");
  return {
    secure: parsed.protocol === "https:",
    host: parsed.hostname,
    port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
    authority: parsed.host,
  };
}

function usableConnection(connection) {
  return connection &&
    (connection.mode === "embedded" || connection.mode === "standalone") &&
    typeof connection.generation === "string" && /^[0-9a-f-]{32,64}$/i.test(connection.generation) &&
    typeof connection.mcpCommand === "string" && connection.mcpCommand.length <= 8_192 &&
    Array.isArray(connection.mcpArgs) && connection.mcpArgs.length <= 64 &&
    connection.mcpArgs.every((value) => typeof value === "string" && value.length <= 8_192 && !value.includes("\0")) &&
    connection.mcpEnv && typeof connection.mcpEnv === "object" && !Array.isArray(connection.mcpEnv) &&
    Object.entries(connection.mcpEnv).every(([key, value]) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === "string" && value.length <= 8_192
    );
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function parseMessage(data) {
  if (!data.length || data.length > MAX_MESSAGE_BYTES) return null;
  try {
    const value = JSON.parse(data.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function decodeData(value) {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_MCP_DATA_BYTES * 4 / 3) + 8) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const data = Buffer.from(value, "base64");
  return data.length <= MAX_MCP_DATA_BYTES ? data : null;
}

export class ClientWebSocket {
  constructor(socket, head = Buffer.alloc(0)) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.listeners = new Set();
    this.closeListeners = new Set();
    this.drainListeners = new Set();
    this.backpressured = false;
    this.readPaused = false;
    socket.on("data", (chunk) => this.push(chunk));
    socket.on("drain", () => {
      this.backpressured = false;
      const listeners = [...this.drainListeners];
      this.drainListeners.clear();
      for (const listener of listeners) listener();
    });
    socket.once("close", () => this.finish());
    socket.once("end", () => this.finish());
    socket.once("error", () => this.finish());
    // Do not consume an application frame coalesced with the HTTP 101 before
    // the bridge has installed its protocol listener.
    if (head.length) {
      this.buffer = Buffer.from(head);
      if (this.buffer.length > MAX_MESSAGE_BYTES + 32) this.close(1009, "message too large");
    }
  }

  get open() { return !this.closed && !this.socket.destroyed; }
  get writeBackpressured() { return this.backpressured; }
  onMessage(listener) {
    if (this.closed) return () => {};
    this.listeners.add(listener);
    while (this.consume()) {}
    return () => this.listeners.delete(listener);
  }
  onClose(listener) {
    if (this.closed) {
      queueMicrotask(listener);
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  onDrain(listener) {
    if (!this.backpressured) {
      queueMicrotask(listener);
      return () => {};
    }
    this.drainListeners.add(listener);
    return () => this.drainListeners.delete(listener);
  }
  pause() {
    if (this.closed || this.readPaused) return;
    this.readPaused = true;
    this.socket.pause();
  }
  resume() {
    if (this.closed || !this.readPaused) return;
    this.readPaused = false;
    this.socket.resume();
    while (this.consume()) {}
  }
  sendText(value) { return this.sendFrame(0x1, Buffer.from(value, "utf8")); }
  ping() { return this.sendFrame(0x9, Buffer.alloc(0)); }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 123);
    const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.sendFrame(0x8, payload);
    this.closed = true;
    this.socket.end();
    this.notifyClose();
  }
  destroy() { if (!this.closed) { this.closed = true; this.socket.destroy(); this.notifyClose(); } }

  push(chunk) {
    if (this.closed || !chunk.length) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    if (this.buffer.length > MAX_MESSAGE_BYTES + 32) return this.close(1009, "message too large");
    while (this.consume()) {}
  }

  consume() {
    if (this.buffer.length < 2 || this.closed || this.readPaused) return false;
    const first = this.buffer[0];
    const second = this.buffer[1];
    const opcode = first & 0x0f;
    if ((first & 0x80) === 0 || (first & 0x70) !== 0 || (second & 0x80) !== 0 || ![1, 2, 8, 9, 10].includes(opcode)) {
      this.close(1002, "invalid frame");
      return false;
    }
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < 4) return false;
      length = this.buffer.readUInt16BE(2); offset = 4;
    } else if (length === 127) {
      if (this.buffer.length < 10) return false;
      const wide = this.buffer.readBigUInt64BE(2);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return void this.close(1009, "message too large");
      length = Number(wide); offset = 10;
    }
    if ((opcode >= 8 && length > 125) || (opcode < 8 && length > MAX_MESSAGE_BYTES)) {
      this.close(1009, "message too large"); return false;
    }
    if (this.buffer.length < offset + length) return false;
    if ((opcode === 1 || opcode === 2) && this.listeners.size === 0) return false;
    const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
    this.buffer = this.buffer.subarray(offset + length);
    if (opcode === 8) this.close(1000, "peer closed");
    else if (opcode === 9) this.sendFrame(0x0a, payload);
    else if (opcode === 10) {}
    else for (const listener of [...this.listeners]) listener({ binary: opcode === 2, data: payload });
    return this.buffer.length >= 2 && !this.closed;
  }

  sendFrame(opcode, payload) {
    if (!this.open || this.backpressured || payload.length > MAX_MESSAGE_BYTES) return false;
    const extended = payload.length < 126 ? 0 : payload.length <= 0xffff ? 2 : 8;
    const header = Buffer.allocUnsafe(2 + extended + 4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | (extended === 0 ? payload.length : extended === 2 ? 126 : 127);
    let offset = 2;
    if (extended === 2) { header.writeUInt16BE(payload.length, offset); offset += 2; }
    else if (extended === 8) { header.writeBigUInt64BE(BigInt(payload.length), offset); offset += 8; }
    const mask = randomBytes(4); mask.copy(header, offset);
    const body = Buffer.from(payload);
    for (let index = 0; index < body.length; index += 1) body[index] ^= mask[index & 3];
    // Surface stream backpressure so session owners can reap the local CUA
    // instead of accumulating an unbounded socket write queue.
    try {
      const flowing = this.socket.write(Buffer.concat([header, body]));
      this.backpressured = !flowing;
      return flowing;
    } catch {
      this.destroy();
      return false;
    }
  }

  finish() { if (!this.closed) { this.closed = true; this.notifyClose(); } }
  notifyClose() {
    this.drainListeners.clear();
    this.listeners.clear();
    this.buffer = Buffer.alloc(0);
    const listeners = [...this.closeListeners]; this.closeListeners.clear();
    for (const listener of listeners) listener();
  }
}

function connectWebSocket({ target, sessionToken, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("physical bridge stopped"));
    const socket = target.secure
      ? tls.connect({ host: target.host, port: target.port, servername: target.host })
      : net.createConnection({ host: target.host, port: target.port });
    const key = randomBytes(16).toString("base64");
    const expected = createHash("sha1").update(key + WS_GUID).digest();
    let response = Buffer.alloc(0);
    let settled = false;
    let timeout = null;
    let onData = null;
    let abort = null;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      timeout = null;
      if (onData) socket.off("data", onData);
      socket.off("error", fail);
      socket.off("end", fail);
      socket.off("close", fail);
      if (abort) signal.removeEventListener("abort", abort);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(new Error("physical bridge connection failed"));
    };
    timeout = setTimeout(fail, timeoutMs);
    timeout.unref?.();
    abort = () => fail();
    signal.addEventListener("abort", abort, { once: true });
    socket.once(target.secure ? "secureConnect" : "connect", () => {
      socket.write(
        `GET ${BRIDGE_PATH} HTTP/1.1\r\n` +
        `Host: ${target.authority}\r\n` +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Origin: ${BRIDGE_ORIGIN}\r\n` +
        `x-openmausbot-session: ${sessionToken}\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    socket.once("error", fail);
    socket.once("end", fail);
    socket.once("close", fail);
    onData = (chunk) => {
      response = response.length ? Buffer.concat([response, chunk]) : Buffer.from(chunk);
      if (response.length > 16_384) return fail();
      const boundary = response.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const lines = response.subarray(0, boundary).toString("latin1").split("\r\n");
      const headers = new Map();
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(":");
        if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
      }
      const actual = Buffer.from(headers.get("sec-websocket-accept") ?? "", "base64");
      const connection = (headers.get("connection") ?? "").toLowerCase().split(",").map((value) => value.trim());
      if (
        lines[0] !== "HTTP/1.1 101 Switching Protocols" ||
        headers.get("upgrade")?.toLowerCase() !== "websocket" || !connection.includes("upgrade") ||
        actual.length !== expected.length || !timingSafeEqual(actual, expected)
      ) return fail();
      settled = true;
      cleanup();
      resolve(new ClientWebSocket(socket, response.subarray(boundary + 4)));
    };
    socket.on("data", onData);
  });
}

function terminateChild(child) {
  if (
    !child || (typeof child !== "object" && typeof child !== "function") ||
    child.exitCode != null || child.signalCode != null
  ) return Promise.resolve();
  const existing = terminatingChildren.get(child);
  if (existing) return existing;
  const termination = new Promise((resolve) => {
    let settled = false;
    let killTimer = null;
    let reapTimer = null;
    const done = () => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (reapTimer) clearTimeout(reapTimer);
      resolve();
    };
    try { child.once?.("exit", done); } catch {}
    try { child.kill?.("SIGTERM"); } catch {}
    if (settled) return;
    killTimer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) {
        try { child.kill?.("SIGKILL"); } catch {}
      }
      // Never wedge app shutdown if a malformed/native child fails to report
      // exit after the force-kill attempt.
      reapTimer = setTimeout(done, CHILD_KILL_REAP_MS);
      reapTimer.unref?.();
    }, CHILD_STOP_GRACE_MS);
    killTimer.unref?.();
  });
  terminatingChildren.set(child, termination);
  void termination.finally(() => terminatingChildren.delete(child));
  return termination;
}

function sanitizedChildEnv(extra) {
  const env = {};
  for (const key of [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
    "LANG", "LC_ALL", "LC_CTYPE", "SystemRoot", "WINDIR", "USERPROFILE",
    "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "ComSpec", "PATHEXT",
  ]) {
    if (typeof process.env[key] === "string") env[key] = process.env[key];
  }
  // The descriptor is generated inside Electron main, but still restrict its
  // additions to CUA's own namespace. Ambient API keys and app bearers never
  // become part of the stdio proxy child environment.
  for (const [key, value] of Object.entries(extra)) {
    if (/^CUA_DRIVER_[A-Z0-9_]{1,64}$/.test(key)) env[key] = value;
  }
  return env;
}

/** Persistent, outbound-only physical bridge owned by Electron main. */
export async function startOutboundPhysicalBridge({
  serverUrl,
  sessionToken,
  platform = process.platform,
  getConnection,
  approveConnection,
  spawnProcess = spawn,
  log = console,
  approvalTimeoutMs = APPROVAL_TIMEOUT_MS,
  inputDrainTimeoutMs = CHILD_INPUT_DRAIN_TIMEOUT_MS,
  connectTimeoutMs = 15_000,
  reconnect = true,
} = {}) {
  if (platform !== "darwin" && platform !== "win32") throw new Error("physical bridge supports only Mac and Windows");
  if (typeof sessionToken !== "string" || sessionToken.length < 32 || sessionToken.length > 512 || /[\r\n]/.test(sessionToken)) {
    throw new Error("physical bridge requires the in-memory app session");
  }
  if (typeof getConnection !== "function" || typeof approveConnection !== "function") {
    throw new Error("physical bridge requires local CUA and approval providers");
  }
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs < 250 || connectTimeoutMs > 60_000) {
    throw new Error("physical bridge connect timeout is invalid");
  }
  if (!Number.isFinite(approvalTimeoutMs) || approvalTimeoutMs < 1_000 || approvalTimeoutMs > APPROVAL_TIMEOUT_MS) {
    throw new Error("physical bridge approval timeout is invalid");
  }
  if (!Number.isFinite(inputDrainTimeoutMs) || inputDrainTimeoutMs < 250 || inputDrainTimeoutMs > 60_000) {
    throw new Error("physical bridge child input drain timeout is invalid");
  }
  const target = websocketTarget(serverUrl);
  const stopController = new AbortController();
  const sessions = new Map();
  let transport = null;
  let registrationId = null;
  let generation = null;
  let alwaysAllow = false;
  let approvalFenceCount = 0;
  let approvalSerial = Promise.resolve();
  let reconnectTimer = null;
  let heartbeat = null;
  let connectAttempt = null;
  const childReaps = new Set();

  const reapChild = (child) => {
    if (!child) return;
    const reap = terminateChild(child);
    childReaps.add(reap);
    void reap.finally(() => childReaps.delete(reap));
  };

  const sendWithPressure = (frame) => {
    if (!transport?.open || transport.writeBackpressured) {
      return { accepted: false, backpressured: Boolean(transport?.writeBackpressured) };
    }
    const encoded = JSON.stringify(frame);
    if (Buffer.byteLength(encoded) > MAX_MESSAGE_BYTES) {
      return { accepted: false, backpressured: false };
    }
    const flowing = transport.sendText(encoded);
    return {
      accepted: flowing || transport.open,
      backpressured: !flowing && transport.open,
    };
  };
  const send = (frame) => sendWithPressure(frame).accepted;
  const releaseApprovalFence = (session) => {
    if (!session?.approvalFenced) return;
    session.approvalFenced = false;
    approvalFenceCount -= 1;
  };
  const serializeApproval = (task) => {
    const result = approvalSerial.then(task, task);
    approvalSerial = result.then(() => {}, () => {});
    return result;
  };
  const closeSession = (sessionId, notify = false) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    if (session.approvalTimer) clearTimeout(session.approvalTimer);
    session.approvalTimer = null;
    session.controller.abort();
    // Abort asks Electron to close an active native dialog. Keep the global
    // action fence until that dialog promise actually settles; releasing on
    // the signal alone leaves a small window in which another bot could click
    // a prompt that is still on screen.
    if (!session.dialogPending) releaseApprovalFence(session);
    session.cancelDrain?.();
    session.cancelDrain = null;
    session.cancelInputDrain?.();
    session.cancelInputDrain = null;
    reapChild(session.child);
    session.child = null;
    if (notify) send({ type: "closed", sessionId });
  };
  const dropTransport = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    for (const sessionId of [...sessions.keys()]) closeSession(sessionId, false);
    registrationId = null;
    generation = null;
    transport = null;
  };

  const handleOpen = async (frame) => {
    if (
      !registrationId || sessions.size >= MAX_SESSIONS ||
      !exactKeys(frame, ["type", "sessionId", "registrationId", "executorGeneration", "botId", "botLabel", "taskLabel"]) ||
      frame.registrationId !== registrationId || frame.executorGeneration !== generation ||
      typeof frame.sessionId !== "string" || !/^[0-9a-f-]{32,64}$/i.test(frame.sessionId) ||
      typeof frame.botId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(frame.botId) ||
      typeof frame.botLabel !== "string" || frame.botLabel !== frame.botLabel.trim() ||
      !frame.botLabel || Buffer.byteLength(frame.botLabel) > 160 || /[\u0000-\u001f\u007f]/.test(frame.botLabel) ||
      typeof frame.taskLabel !== "string" || frame.taskLabel !== frame.taskLabel.trim() ||
      !frame.taskLabel || Buffer.byteLength(frame.taskLabel) > 240 || /[\u0000-\u001f\u007f]/.test(frame.taskLabel) ||
      sessions.has(frame.sessionId)
    ) {
      transport?.close(1008, "invalid MCP session");
      return;
    }
    const record = {
      controller: new AbortController(),
      child: null,
      approved: false,
      spawning: false,
      approvalFenced: true,
      approvalTimer: null,
      dialogPending: false,
      cancelDrain: null,
      cancelInputDrain: null,
    };
    // Fence every already-open physical CUA session before yielding to the
    // async dialog provider. A bot that already controls the desktop must not
    // be able to click Allow on a later bot's connection prompt.
    approvalFenceCount += 1;
    sessions.set(frame.sessionId, record);
    record.approvalTimer = setTimeout(() => record.controller.abort(), approvalTimeoutMs);
    record.approvalTimer.unref?.();
    let decision = false;
    try {
      decision = await serializeApproval(async () => {
        if (
          record.controller.signal.aborted || sessions.get(frame.sessionId) !== record ||
          !transport?.open
        ) return false;
        if (alwaysAllow) return true;
        record.dialogPending = true;
        let result = false;
        try {
          result = await approveConnection({
            signal: record.controller.signal,
            timeoutMs: approvalTimeoutMs,
            platform,
            botId: frame.botId,
            botLabel: frame.botLabel,
            taskLabel: frame.taskLabel,
            sessionId: frame.sessionId,
          });
        } finally {
          record.dialogPending = false;
          if (sessions.get(frame.sessionId) !== record) releaseApprovalFence(record);
        }
        if (
          record.controller.signal.aborted || sessions.get(frame.sessionId) !== record ||
          !transport?.open
        ) return false;
        if (result === "always") {
          alwaysAllow = true;
          return true;
        }
        return result === true || result === "once";
      });
    } catch {}
    if (record.approvalTimer) clearTimeout(record.approvalTimer);
    record.approvalTimer = null;
    if (!decision || record.controller.signal.aborted || sessions.get(frame.sessionId) !== record || !transport?.open) {
      if (sessions.get(frame.sessionId) === record) {
        send({ type: "denied", sessionId: frame.sessionId });
        closeSession(frame.sessionId, false);
      }
      return;
    }
    // The server may have cancelled/replaced this exact MCP session while a
    // person was deciding. Ask it to revalidate before any CUA process is
    // spawned; only its correlated `spawn` reply crosses that final fence.
    record.approved = true;
    if (!send({ type: "approved", sessionId: frame.sessionId, executorGeneration: generation })) {
      closeSession(frame.sessionId, false);
    }
  };

  const handleSpawn = async (frame) => {
    if (
      !exactKeys(frame, ["type", "sessionId", "executorGeneration"]) ||
      frame.executorGeneration !== generation
    ) {
      transport?.close(1008, "invalid MCP spawn proof");
      return;
    }
    const record = sessions.get(frame.sessionId);
    if (!record?.approved || record.spawning || record.child || record.controller.signal.aborted || !transport?.open) {
      transport?.close(1008, "stale MCP spawn proof");
      return;
    }
    record.spawning = true;
    let connection;
    try { connection = await getConnection(); } catch {}
    if (
      !usableConnection(connection) || connection.generation !== generation ||
      record.controller.signal.aborted || sessions.get(frame.sessionId) !== record || !transport?.open
    ) {
      if (usableConnection(connection) && connection.generation !== generation) {
        send({ type: "executor", executorGeneration: connection.generation });
      } else send({ type: "denied", sessionId: frame.sessionId });
      closeSession(frame.sessionId, false);
      return;
    }
    let child = null;
    try {
      child = spawnProcess(connection.mcpCommand, connection.mcpArgs, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: sanitizedChildEnv(connection.mcpEnv),
      });
      if (
        !child?.stdin || typeof child.stdin.on !== "function" ||
        !child?.stdout || typeof child.stdout.on !== "function" ||
        !child?.stderr || typeof child.stderr.on !== "function" || typeof child.stderr.resume !== "function" ||
        typeof child.once !== "function" || typeof child.kill !== "function"
      ) throw new Error("CUA MCP child is invalid");
      record.child = child;
      child.stdin.on("error", () => closeSession(frame.sessionId, true));
      // CUA stderr is untrusted and can contain credentials or screenshots.
      // Drain and discard it so a pipe-capacity stall cannot deadlock MCP,
      // but never log it or relay it over the bridge.
      child.stderr.on("error", () => {});
      child.stderr.resume();
      child.stdout.on("data", (data) => {
        if (sessions.get(frame.sessionId) !== record || record.child !== child) return;
        if (data.length > MAX_MCP_DATA_BYTES) {
          closeSession(frame.sessionId, true);
          return;
        }
        const status = sendWithPressure({
          type: "data",
          sessionId: frame.sessionId,
          data: Buffer.from(data).toString("base64"),
        });
        if (!status.accepted) {
          closeSession(frame.sessionId, true);
          return;
        }
        if (status.backpressured && sessions.get(frame.sessionId) === record && !record.cancelDrain) {
          child.stdout.pause();
          const blockedTransport = transport;
          record.cancelDrain = blockedTransport.onDrain(() => {
            record.cancelDrain = null;
            if (
              sessions.get(frame.sessionId) === record &&
              record.child === child && transport === blockedTransport && transport?.open
            ) child.stdout.resume();
          });
        }
      });
      child.stdout.on("error", () => closeSession(frame.sessionId, true));
      // Never forward arbitrary CUA stderr or include commands/arguments in logs.
      child.once("error", () => closeSession(frame.sessionId, true));
      child.once("exit", () => closeSession(frame.sessionId, true));
    } catch {
      if (child && record.child !== child) reapChild(child);
      closeSession(frame.sessionId, true);
      return;
    }
    if (!send({ type: "opened", sessionId: frame.sessionId, executorGeneration: generation })) {
      closeSession(frame.sessionId, false);
    } else {
      // The approval prompt is gone and the exact server-correlated child is
      // live. Only now may already-open sessions receive further CUA input.
      releaseApprovalFence(record);
    }
  };

  const handleMessage = (message) => {
    if (message.binary) return transport?.close(1003, "bridge messages must be JSON");
    const frame = parseMessage(message.data);
    if (!frame) return transport?.close(1008, "invalid bridge message");
    if (exactKeys(frame, ["type", "registrationId", "executorGeneration"]) && frame.type === "registered") {
      if (registrationId || typeof frame.registrationId !== "string" || !/^[0-9a-f-]{32,64}$/i.test(frame.registrationId) || frame.executorGeneration !== generation) {
        transport?.close(1008, "invalid registration response");
        return;
      }
      registrationId = frame.registrationId;
      return;
    }
    if (frame.type === "open") { void handleOpen(frame); return; }
    if (frame.type === "spawn") { void handleSpawn(frame); return; }
    if (exactKeys(frame, ["type", "sessionId", "data"]) && frame.type === "data") {
      if (approvalFenceCount > 0) {
        // Fail closed if a buggy or compromised server delivers any physical
        // action while a local connection prompt could be clicked by a bot.
        transport?.close(1008, "physical actions blocked during approval");
        return;
      }
      const session = sessions.get(frame.sessionId);
      const data = decodeData(frame.data);
      if (!session?.child || !data || session.cancelInputDrain) {
        transport?.close(1008, "invalid MCP data");
        return;
      }
      let wrote;
      try { wrote = session.child.stdin.write(data); } catch {
        transport?.close(1008, "invalid MCP data");
        return;
      }
      if (!wrote) {
        const blockedTransport = transport;
        const blockedChild = session.child;
        blockedTransport.pause();
        const release = () => {
          clearTimeout(inputDrainTimer);
          blockedChild.stdin.off("drain", release);
          if (session.cancelInputDrain === release) session.cancelInputDrain = null;
          if (transport === blockedTransport && transport?.open) blockedTransport.resume();
        };
        const inputDrainTimer = setTimeout(() => {
          if (session.cancelInputDrain === release) closeSession(frame.sessionId, true);
        }, inputDrainTimeoutMs);
        inputDrainTimer.unref?.();
        session.cancelInputDrain = release;
        blockedChild.stdin.once("drain", release);
      }
      return;
    }
    if (exactKeys(frame, ["type", "sessionId"]) && frame.type === "close") {
      if (!sessions.has(frame.sessionId)) {
        transport?.close(1008, "stale MCP close");
        return;
      }
      closeSession(frame.sessionId, false);
      return;
    }
    transport?.close(1008, "invalid bridge message");
  };

  const connect = async () => {
    if (stopController.signal.aborted || connectAttempt) return;
    connectAttempt = (async () => {
      let connection;
      try { connection = await getConnection(); } catch {}
      if (!usableConnection(connection)) throw new Error("local CUA is unavailable");
      const socket = await connectWebSocket({
        target,
        sessionToken,
        signal: stopController.signal,
        timeoutMs: connectTimeoutMs,
      });
      if (stopController.signal.aborted) { socket.destroy(); return; }
      transport = socket;
      generation = connection.generation;
      socket.onClose(() => {
        dropTransport();
        if (reconnect && !stopController.signal.aborted) {
          reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(); }, 1_500);
          reconnectTimer.unref?.();
        }
      });
      socket.onMessage(handleMessage);
      if (!socket.open) return;
      heartbeat = setInterval(() => {
        if (!send({ type: "heartbeat" })) socket.destroy();
      }, 15_000);
      heartbeat.unref?.();
      if (!send({ type: "register", protocol: PROTOCOL, platform, executorGeneration: generation })) socket.destroy();
    })().catch((error) => {
      log.warn?.(`[physical-bridge] ${error?.message ?? "connection unavailable"}`);
      if (reconnect && !stopController.signal.aborted) {
        reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(); }, 1_500);
        reconnectTimer.unref?.();
      }
    }).finally(() => { connectAttempt = null; });
    await connectAttempt;
  };

  await connect();
  return Object.freeze({
    get registrationId() { return registrationId; },
    get connected() { return Boolean(registrationId && transport?.open); },
    async refresh() {
      if (stopController.signal.aborted) return false;
      let connection;
      try { connection = await getConnection(); } catch {}
      if (!usableConnection(connection)) {
        transport?.close(1008, "local CUA became unavailable");
        return false;
      }
      if (transport?.open && generation && connection.generation !== generation) {
        // The server retires this registration and every child, then the
        // normal reconnect path publishes the new executor epoch.
        send({ type: "executor", executorGeneration: connection.generation });
        transport.close(1008, "CUA executor generation changed");
        return false;
      }
      if (!transport?.open) await connect();
      return Boolean(registrationId && transport?.open);
    },
    async stop() {
      stopController.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      for (const sessionId of [...sessions.keys()]) closeSession(sessionId, false);
      transport?.close(1000, "app closing");
      dropTransport();
      await connectAttempt?.catch(() => {});
      await Promise.allSettled([...childReaps]);
    },
  });
}
