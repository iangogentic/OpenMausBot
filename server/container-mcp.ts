// Provider-side stdio relay for a server-hosted Local VM.
//
// This process deliberately knows nothing about Docker/Podman, container
// names, Cua's socket, or the ComputerControl bridge. It receives one opaque
// exact-turn capability and can only stream MCP bytes to the trusted harness
// broker on loopback.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import net from "node:net";

import {
  LOCAL_VM_BROKER_ORIGIN,
  LOCAL_VM_MCP_PATH,
  LOCAL_VM_PROXY_MAX_BUFFERED_BYTES,
} from "./local-vm-broker-protocol.ts";
import { RawWebSocket, WEBSOCKET_MAX_MESSAGE_BYTES } from "./raw-websocket.ts";
import { PROVIDER_CREDENTIAL_ENV, stripWorkspaceCredentialEnv } from "./config.ts";

const rawUrl = process.env.OMB_LOCAL_VM_MCP_URL ?? "";
const capability = process.env.OMB_LOCAL_VM_MCP_CAPABILITY ?? "";
delete process.env.OMB_LOCAL_VM_MCP_URL;
delete process.env.OMB_LOCAL_VM_MCP_CAPABILITY;
stripWorkspaceCredentialEnv(process.env);
for (const key of PROVIDER_CREDENTIAL_ENV) delete process.env[key];

function brokerUrl(value: string): URL | null {
  if (!value || value.length > 2_048) return null;
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    return parsed.protocol === "ws:" &&
      ["127.0.0.1", "10.0.2.2"].includes(parsed.hostname) &&
      parsed.username === "" &&
      parsed.password === "" &&
      /^\d{1,5}$/.test(parsed.port) &&
      Number.isInteger(port) && port >= 1 && port <= 65_535 &&
      parsed.pathname === LOCAL_VM_MCP_PATH &&
      parsed.search === "" && parsed.hash === ""
      ? parsed
      : null;
  } catch {
    return null;
  }
}

const url = brokerUrl(rawUrl);
if (!url || !/^[A-Za-z0-9_-]{43}$/.test(capability)) {
  process.stderr.write("Local VM broker authority is unavailable\n");
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
let inputEnded = false;
let eofSent = false;
let transport: RawWebSocket | null = null;
const queued: Buffer[] = [];
let queuedBytes = 0;

function fail(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  process.stdin.pause();
  transport?.destroy();
  socket.destroy();
}

function enqueue(data: Buffer): boolean {
  queuedBytes += data.length;
  if (data.length > WEBSOCKET_MAX_MESSAGE_BYTES || queuedBytes > LOCAL_VM_PROXY_MAX_BUFFERED_BYTES) {
    fail("Local VM MCP transport queue exceeded its limit");
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
      fail("Local VM broker transport failed");
      return;
    }
  }
  if (transport.backpressured) process.stdin.pause();
  else if (!inputEnded) process.stdin.resume();
  if (inputEnded && !eofSent && queued.length === 0 && !transport.backpressured) {
    eofSent = true;
    if (!transport.sendBinary(Buffer.alloc(0))) fail("Local VM broker EOF transport failed");
  }
}

socket.once("connect", () => {
  socket.write(
    `GET ${LOCAL_VM_MCP_PATH} HTTP/1.1\r\n` +
    // The provider reaches the host through slirp's 10.0.2.2 gateway, but
    // the trusted harness deliberately accepts this control plane only with
    // a loopback Host authority. Connection destination and HTTP authority
    // are therefore intentionally different inside the sandbox.
    `Host: 127.0.0.1:${url.port}\r\n` +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Origin: ${LOCAL_VM_BROKER_ORIGIN}\r\n` +
    `Authorization: Bearer ${capability}\r\n` +
    `Sec-WebSocket-Key: ${key}\r\n` +
    "Sec-WebSocket-Version: 13\r\n\r\n",
  );
});

function onHandshakeData(chunk: Buffer): void {
  handshake = handshake.length ? Buffer.concat([handshake, chunk]) : Buffer.from(chunk);
  if (handshake.length > 16_384) {
    fail("Local VM broker handshake was rejected");
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
    fail("Local VM broker handshake was rejected");
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
    if (message.data.length && !process.stdout.write(message.data)) socket.pause();
  });
  transport.onClose(() => {
    process.exitCode ??= 0;
    process.stdin.pause();
  });
  transport.onDrain(flushQueued);
  flushQueued();
}

socket.on("data", onHandshakeData);
socket.once("error", () => fail("Local VM broker transport failed"));
socket.once("close", () => {
  if (!connected) process.exitCode = 1;
  process.stdin.pause();
});
process.stdout.on("drain", () => socket.resume());
process.stdin.on("data", (chunk: Buffer) => {
  if (chunk.length > WEBSOCKET_MAX_MESSAGE_BYTES) {
    fail("Local VM MCP frame exceeded its limit");
    return;
  }
  if (transport?.open && !transport.backpressured && queued.length === 0) {
    if (!transport.sendBinary(chunk)) {
      fail("Local VM broker transport failed");
      return;
    }
    if (transport.backpressured) process.stdin.pause();
    return;
  }
  if (enqueue(chunk)) process.stdin.pause();
});
process.stdin.once("end", () => {
  inputEnded = true;
  process.stdin.pause();
  flushQueued();
});
