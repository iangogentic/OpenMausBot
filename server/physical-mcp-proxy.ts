// Tiny stdio-to-WebSocket relay for an outbound physical-device bridge.
// The provider receives no CUA command, socket, raw device bearer, reverse
// port, or UI-session token: only this exact-turn opaque broker capability.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import net from "node:net";

import { PHYSICAL_BROKER_ORIGIN, PHYSICAL_MCP_PATH } from "./physical-bridge.ts";
import { RawWebSocket } from "./raw-websocket.ts";
import { PROVIDER_CREDENTIAL_ENV, stripWorkspaceCredentialEnv } from "./config.ts";
import { firstResponseDeadline } from "./first-response-deadline.ts";

// Hermes retries a failed MCP child three times while OpenMaus gives the
// complete session/new handshake 30 seconds. Six seconds leaves enough time
// for a healthy attended bridge (normally about four seconds) while ensuring
// an unavailable physical computer degrades to chat-without-computer instead
// of preventing the whole session from opening.
const FIRST_RESPONSE_TIMEOUT_MS = 6_000;

const rawUrl = process.env.OMB_PHYSICAL_MCP_URL ?? "";
const capability = process.env.OMB_PHYSICAL_MCP_CAPABILITY ?? "";
delete process.env.OMB_PHYSICAL_MCP_URL;
delete process.env.OMB_PHYSICAL_MCP_CAPABILITY;
stripWorkspaceCredentialEnv(process.env);
for (const key of PROVIDER_CREDENTIAL_ENV) delete process.env[key];

function brokerUrl(value: string): URL | null {
  if (!value || value.length > 2_048) return null;
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    return parsed.protocol === "ws:" &&
      // Provider MCP children run inside the slirp namespace. 127.0.0.1 is
      // used by ordinary local tests; 10.0.2.2 is the one fixed host gateway
      // that the production provider sandbox exposes. Keep this exact list so
      // a hostile provider cannot turn its opaque capability into an SSRF
      // primitive for any other host.
      ["127.0.0.1", "10.0.2.2"].includes(parsed.hostname) &&
      parsed.username === "" &&
      parsed.password === "" &&
      /^\d{1,5}$/.test(parsed.port) &&
      port >= 1 && port <= 65_535 &&
      parsed.pathname === PHYSICAL_MCP_PATH &&
      parsed.search === "" && parsed.hash === ""
      ? parsed
      : null;
  } catch {
    return null;
  }
}

const url = brokerUrl(rawUrl);
if (!url || !/^[A-Za-z0-9_-]{43}$/.test(capability)) {
  process.stderr.write("physical computer broker authority is unavailable\n");
  process.exit(2);
}

const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
socket.setNoDelay(true);
const key = randomBytes(16).toString("base64");
const expectedAccept = createHash("sha1")
  .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
  .digest();
let handshake = Buffer.alloc(0);
let connected = false;
let transport: RawWebSocket | null = null;
let providerRequestSeen = false;
let firstResponseSeen = false;
let cancelFirstResponseDeadline: (() => void) | null = null;
let failed = false;
const queued: Buffer[] = [];
let queuedBytes = 0;
const maxQueue = 1024 * 1024;

function enqueue(data: Buffer): boolean {
  queuedBytes += data.length;
  if (queuedBytes > maxQueue) {
    fail("physical computer MCP transport queue exceeded its limit");
    return false;
  }
  queued.push(Buffer.from(data));
  return true;
}

function flushQueued(): void {
  if (!transport?.open) return;
  while (queued.length && !transport.backpressured) {
    const data = queued.shift()!;
    queuedBytes -= data.length;
    if (!transport.sendBinary(data)) {
      fail("physical computer broker transport failed");
      return;
    }
  }
  if (transport.backpressured) process.stdin.pause();
  else process.stdin.resume();
}

function fail(message: string): void {
  if (failed) return;
  failed = true;
  cancelFirstResponseDeadline?.();
  cancelFirstResponseDeadline = null;
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  transport?.destroy();
  socket.destroy();
}

function armFirstResponseDeadline(): void {
  if (!connected || !providerRequestSeen || firstResponseSeen || cancelFirstResponseDeadline) return;
  cancelFirstResponseDeadline = firstResponseDeadline(
    () => fail("physical computer MCP did not become ready in time"),
    FIRST_RESPONSE_TIMEOUT_MS,
  );
}

socket.once("connect", () => {
  socket.write(
    `GET ${PHYSICAL_MCP_PATH} HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${url.port}\r\n` +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Origin: ${PHYSICAL_BROKER_ORIGIN}\r\n` +
    `Authorization: Bearer ${capability}\r\n` +
    `Sec-WebSocket-Key: ${key}\r\n` +
    "Sec-WebSocket-Version: 13\r\n\r\n",
  );
});

function onHandshakeData(chunk: Buffer): void {
  handshake = handshake.length ? Buffer.concat([handshake, chunk]) : Buffer.from(chunk);
  if (handshake.length > 16_384) {
    fail("physical computer broker handshake was rejected");
    return;
  }
  const boundary = handshake.indexOf("\r\n\r\n");
  if (boundary < 0) return;
  socket.off("data", onHandshakeData);
  const header = handshake.subarray(0, boundary).toString("latin1");
  const lines = header.split("\r\n");
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  const actualAccept = Buffer.from(headers.get("sec-websocket-accept") ?? "", "base64");
  if (
    lines[0] !== "HTTP/1.1 101 Switching Protocols" ||
    headers.get("upgrade")?.toLowerCase() !== "websocket" ||
    actualAccept.length !== expectedAccept.length ||
    !timingSafeEqual(actualAccept, expectedAccept)
  ) {
    fail("physical computer broker handshake was rejected");
    return;
  }
  const remainder = handshake.subarray(boundary + 4);
  handshake = Buffer.alloc(0);
  connected = true;
  transport = new RawWebSocket(socket, {
    expectMasked: false,
    maskOutgoing: true,
    head: remainder,
  });
  transport.onMessage((message) => {
    if (!firstResponseSeen) {
      firstResponseSeen = true;
      cancelFirstResponseDeadline?.();
      cancelFirstResponseDeadline = null;
    }
    if (message.data.length && !process.stdout.write(message.data)) socket.pause();
  });
  transport.onClose(() => {
    process.exitCode ??= 1;
    process.stdin.pause();
  });
  transport.onDrain(flushQueued);
  armFirstResponseDeadline();
  flushQueued();
}
socket.on("data", onHandshakeData);
socket.once("error", (error: NodeJS.ErrnoException) => {
  const code = typeof error.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code)
    ? ` (${error.code})`
    : "";
  fail(`physical computer broker transport failed${code}`);
});
socket.once("close", () => {
  if (!connected) process.exitCode = 1;
  process.stdin.pause();
});

process.stdout.on("drain", () => socket.resume());
process.stdin.on("data", (chunk: Buffer) => {
  providerRequestSeen = true;
  armFirstResponseDeadline();
  if (chunk.length > maxQueue) {
    fail("physical computer MCP frame exceeded its limit");
    return;
  }
  if (transport?.open) {
    if (transport.backpressured || queued.length) {
      if (enqueue(chunk)) process.stdin.pause();
      return;
    }
    if (!transport.sendBinary(chunk)) {
      fail("physical computer broker transport failed");
      return;
    }
    if (transport.backpressured) process.stdin.pause();
    return;
  }
  enqueue(chunk);
});
process.stdin.once("end", () => transport?.close(1000, "provider stdin ended"));
