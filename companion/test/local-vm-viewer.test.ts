import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CompanionLocalVmViewerGateway } from "../src/local-vm-viewer.ts";

const INTERNAL_TOKEN = "i".repeat(43);
const GENERATION = "generation-0123456789abcdef";

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
const close = (server: Server | undefined): Promise<void> =>
  new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));

function internalJoin(botId: string, generation = GENERATION) {
  const base = `/api/bots/${botId}/local-computer/viewer/${INTERNAL_TOKEN}`;
  const fragment = new URLSearchParams({
    autoconnect: "true",
    resize: "scale",
    password: "secret-vnc-password",
    path: `${base.slice(1)}/websockify`,
  });
  return {
    joinUrl: `${base}/vnc.html#${fragment.toString()}`,
    expiresAt: Date.now() + 60_000,
    viewerGeneration: generation,
  };
}

describe("paired phone Local VM viewer gateway", () => {
  let harness: Server;
  let publicServer: Server;
  let gateway: CompanionLocalVmViewerGateway;
  let harnessPort = 0;
  let publicPort = 0;
  let now = Date.now();
  const terminations = new Map<string, Set<() => void>>();
  const observed = { host: "", path: "" };
  const testSockets = new Set<Socket>();

  beforeEach(async () => {
    harness = createServer((req, res) => {
      observed.host = String(req.headers.host ?? "");
      observed.path = req.url ?? "";
      res.writeHead(200, { "content-type": "text/plain", "set-cookie": "must-not-cross=1" });
      res.end(`asset:${req.url}`);
    });
    harness.on("connection", (socket) => {
      testSockets.add(socket);
      socket.on("close", () => testSockets.delete(socket));
    });
    harness.on("upgrade", (req, socket) => {
      observed.host = String(req.headers.host ?? "");
      observed.path = req.url ?? "";
      const key = String(req.headers["sec-websocket-key"] ?? "");
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      // Echo one tiny masked browser text frame as an unmasked server frame.
      // The gateway itself remains byte-transparent; this is only the fake
      // websockify endpoint completing enough RFC 6455 for the client test.
      socket.on("data", (chunk) => {
        const length = chunk[1] & 0x7f;
        if (!(chunk[1] & 0x80) || length >= 126 || chunk.length < 6 + length) return;
        const mask = chunk.subarray(2, 6);
        const payload = Buffer.alloc(length);
        for (let i = 0; i < length; i++) payload[i] = chunk[6 + i] ^ mask[i % 4];
        socket.write(Buffer.concat([Buffer.from([0x81, length]), payload]));
      });
    });
    harnessPort = await listen(harness);
    gateway = new CompanionLocalVmViewerGateway({
      harnessPort,
      now: () => now,
      track: (deviceId, terminate) => {
        const active = terminations.get(deviceId) ?? new Set();
        active.add(terminate);
        terminations.set(deviceId, active);
        return () => {
          active.delete(terminate);
          if (!active.size) terminations.delete(deviceId);
        };
      },
    });
    publicServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://viewer.invalid");
      if (!gateway.handleHttp(req, res, url)) {
        res.writeHead(404).end();
      }
    });
    publicServer.on("connection", (socket) => {
      testSockets.add(socket);
      socket.on("close", () => testSockets.delete(socket));
    });
    publicServer.on("upgrade", (req, socket, head) => {
      if (!gateway.handleUpgrade(req, socket, head)) socket.destroy();
    });
    publicPort = await listen(publicServer);
  });

  afterEach(async () => {
    gateway.revokeAll();
    terminations.clear();
    for (const socket of testSockets) socket.destroy();
    testSockets.clear();
    await close(publicServer);
    await close(harness);
  });

  const register = (deviceId = "phone-1", botId = "bot-1", generation = GENERATION) => {
    const result = gateway.register(deviceId, botId, internalJoin(botId, generation));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    return String(result.payload.joinUrl);
  };

  const absolute = (joinUrl: string): URL => new URL(joinUrl, `http://127.0.0.1:${publicPort}`);

  it("exchanges the raw viewer for a device/bot/generation token and proxies assets", async () => {
    const joinUrl = register();
    expect(joinUrl).not.toContain(INTERNAL_TOKEN);
    expect(joinUrl).not.toContain(GENERATION);
    expect(joinUrl).not.toContain(String(harnessPort));
    const url = absolute(joinUrl);
    url.hash = "";

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("/local-computer/viewer/");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(observed.host).toBe(`openmaus-viewer.localhost:${harnessPort}`);
    expect(observed.path).toContain(INTERNAL_TOKEN);
  });

  it("rejects a wrong bot, generation tag, token, and malformed device", async () => {
    const url = absolute(register());
    url.hash = "";
    const segments = url.pathname.split("/");
    const botIndex = segments.indexOf("bot-1");
    const generationIndex = segments.indexOf("viewer") + 1;
    const tokenIndex = generationIndex + 1;

    for (const mutate of [
      (copy: URL) => { copy.pathname = copy.pathname.replace("/bot-1/", "/bot-2/"); },
      (copy: URL) => { const parts = copy.pathname.split("/"); parts[generationIndex] = "x".repeat(16); copy.pathname = parts.join("/"); },
      (copy: URL) => { const parts = copy.pathname.split("/"); parts[tokenIndex] = "z".repeat(43); copy.pathname = parts.join("/"); },
    ]) {
      const copy = new URL(url);
      mutate(copy);
      expect((await fetch(copy)).status).toBe(403);
    }
    expect(botIndex).toBeGreaterThan(0);
    expect(gateway.register("bad/device", "bot-1", internalJoin("bot-1"))).toMatchObject({ ok: false, status: 403 });
  });

  it("revokes on device removal, capability removal, expiry, and replay replacement", async () => {
    const first = absolute(register());
    first.hash = "";
    expect((await fetch(first)).status).toBe(200);
    for (const terminate of [...(terminations.get("phone-1") ?? [])]) terminate();
    expect((await fetch(first)).status).toBe(403);

    const expiring = absolute(register());
    expiring.hash = "";
    now += 120_000;
    expect((await fetch(expiring)).status).toBe(403);

    now = Date.now();
    const old = absolute(register("phone-1", "bot-1", "generation-old-12345678"));
    old.hash = "";
    const successor = absolute(register("phone-1", "bot-1", "generation-new-12345678"));
    successor.hash = "";
    expect((await fetch(old)).status).toBe(403);
    expect((await fetch(successor)).status).toBe(200);
  });

  it("bounds concurrent device sessions without disturbing another phone", () => {
    register("phone-1", "bot-1");
    register("phone-1", "bot-2");
    expect(gateway.register("phone-1", "bot-3", internalJoin("bot-3"))).toMatchObject({
      ok: false,
      status: 429,
    });
    expect(gateway.register("phone-2", "bot-3", internalJoin("bot-3")).ok).toBe(true);
  });

  it("carries the successful interactive websocket through the hidden harness token", async () => {
    const url = absolute(register());
    const fragment = new URLSearchParams(url.hash.slice(1));
    const socketPath = fragment.get("path");
    expect(socketPath).toBeTruthy();
    const socket = new WebSocket(`ws://127.0.0.1:${publicPort}/${socketPath}`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("viewer websocket did not open")), { once: true });
    });
    const echoed = new Promise<string>((resolve) => {
      socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
    });
    socket.send("phone-control-frame");
    expect(await echoed).toBe("phone-control-frame");
    expect(observed.path).toContain(INTERNAL_TOKEN);
    socket.close();
  });
});
