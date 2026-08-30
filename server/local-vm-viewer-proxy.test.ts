import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LocalVmViewerProxy,
  startViewerLeaseKeepalive,
  type LocalVmViewerBinding,
} from "./local-vm-viewer-proxy.ts";

const BOT_A = "bot-a";
const BOT_B = "bot-b";
const TOKEN_A = "a".repeat(43);
const TOKEN_B = "b".repeat(43);

let upstream: Server;
let gateway: Server;
let upstreamPort = 0;
let gatewayPort = 0;
let held = true;
let currentGeneration = "generation-1";
let now = 1_000;
let tokenIndex = 0;
let proxy: LocalVmViewerProxy;
let upstreamSockets: Set<Duplex>;
let released: Array<LocalVmViewerBinding>;

const binding = (overrides: Partial<LocalVmViewerBinding> = {}): LocalVmViewerBinding => ({
  botId: BOT_A,
  targetKey: "bot:target-a",
  viewerPort: upstreamPort,
  generation: "generation-1",
  password: "vnc-secret",
  controlOwnerId: "renderer-a",
  controlLeaseToken: "control-token-a",
  ...overrides,
});

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });

const close = (server: Server | undefined): Promise<void> =>
  new Promise((resolve) => {
    if (!server?.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });

function mountProxy(candidate: LocalVmViewerProxy): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${gatewayPort || 1}`);
    void candidate.handleHttp(req, res, url).then((handled) => {
      if (!handled && !res.writableEnded) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${gatewayPort || 1}`);
    void candidate.handleUpgrade(req, socket, head, url).then((handled) => {
      if (!handled && !socket.destroyed) socket.destroy();
    });
  });
  return server;
}

function rawUpgrade(path: string): Promise<{ socket: Socket; response: string }> {
  return new Promise((resolve, reject) => {
    const websocketKey = Buffer.from("openmaus-testkey", "ascii").toString("base64");
    const socket = connect(gatewayPort, "127.0.0.1");
    let response = "";
    const timer = setTimeout(() => reject(new Error(`upgrade timed out: ${response}`)), 3_000);
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
      if (response.includes("\r\n\r\n") && (response.includes("101 Switching Protocols") || !response.startsWith("HTTP/1.1 101"))) {
        clearTimeout(timer);
        resolve({ socket, response });
      }
    });
    socket.once("connect", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${gatewayPort}\r\n` +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          `Sec-WebSocket-Key: ${websocketKey}\r\n` +
          "Origin: http://127.0.0.1:18799\r\n\r\n",
      );
    });
  });
}

beforeEach(async () => {
  held = true;
  currentGeneration = "generation-1";
  now = 1_000;
  tokenIndex = 0;
  upstreamSockets = new Set();
  released = [];
  upstream = createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "text/plain",
      "set-cookie": "upstream-secret=yes",
      "x-upstream-path": req.url ?? "",
      "x-upstream-host": req.headers.host ?? "",
      "x-saw-cookie": String(Boolean(req.headers.cookie)),
    });
    res.end("noVNC asset");
  });
  upstream.on("upgrade", (req, socket) => {
    upstreamSockets.add(socket);
    socket.once("close", () => upstreamSockets.delete(socket));
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  upstreamPort = await listen(upstream);
  proxy = new LocalVmViewerProxy({
    isHeld: () => held,
    isCurrent: (candidate) => candidate.generation === currentGeneration,
    releaseHeld: (candidate) => {
      released.push({ ...candidate });
      held = false;
      return true;
    },
    detachGraceMs: 50,
    ttlMs: 10_000,
    now: () => now,
    token: () => [TOKEN_A, TOKEN_B][tokenIndex++] ?? "c".repeat(43),
  });
  gateway = mountProxy(proxy);
  gatewayPort = await listen(gateway);
});

afterEach(async () => {
  proxy.revokeAll();
  for (const socket of upstreamSockets) socket.destroy();
  await Promise.all([close(gateway), close(upstream)]);
});

describe("LocalVmViewerProxy", () => {
  it("renews while a viewer socket is alive and stops immediately on disconnect", async () => {
    vi.useFakeTimers();
    try {
      const renew = vi.fn(async () => true);
      const invalid = vi.fn();
      const stop = await startViewerLeaseKeepalive({ intervalMs: 5_000, renew, onInvalid: invalid });
      expect(stop).not.toBeNull();
      expect(renew).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(15_001);
      expect(renew).toHaveBeenCalledTimes(4);
      stop?.();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(renew).toHaveBeenCalledTimes(4);
      expect(invalid).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a same-origin relative URL while keeping the VNC secret in its fragment", () => {
    const result = proxy.create(binding());
    const [requestPath, rawFragment] = result.joinUrl.split("#");

    expect(requestPath).toBe(`/api/bots/${BOT_A}/local-computer/viewer/${TOKEN_A}/vnc.html`);
    expect(requestPath).not.toContain(String(upstreamPort));
    expect(requestPath).not.toContain("vnc-secret");
    const fragment = new URLSearchParams(rawFragment);
    expect(fragment.get("autoconnect")).toBe("true");
    expect(fragment.get("view_only")).toBe("false");
    expect(fragment.get("password")).toBe("vnc-secret");
    expect(fragment.get("path")).toBe(
      `api/bots/${BOT_A}/local-computer/viewer/${TOKEN_A}/websockify`,
    );
    expect(result.expiresAt).toBe(11_000);
  });

  it("gives a remote Mac the same harness-origin path for a Razer-owned VPS tunnel", async () => {
    const result = proxy.create(binding({
      targetKey: "vps:razer:openmausbot-vps-bot-a",
      password: "vps-secret",
    }));
    const requestPath = result.joinUrl.split("#")[0];
    expect(requestPath.startsWith("/api/bots/bot-a/")).toBe(true);
    expect(requestPath).not.toContain("127.0.0.1");
    expect(requestPath).not.toContain(String(upstreamPort));
    expect(new URLSearchParams(result.joinUrl.split("#")[1]).get("password")).toBe("vps-secret");

    const response = await fetch(`http://127.0.0.1:${gatewayPort}${requestPath}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("noVNC asset");
  });

  it("proxies viewer assets to the bound loopback port without forwarding cookies", async () => {
    const { joinUrl } = proxy.create(binding());
    const assetPath = joinUrl.split("#")[0].replace(/vnc\.html$/, "app/ui.js?build=one");
    const response = await fetch(`http://127.0.0.1:${gatewayPort}${assetPath}`, {
      headers: { cookie: "renderer-secret=yes" },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("noVNC asset");
    expect(response.headers.get("x-upstream-path")).toBe("/app/ui.js?build=one");
    expect(response.headers.get("x-upstream-host")).toBe(`127.0.0.1:${upstreamPort}`);
    expect(response.headers.get("x-saw-cookie")).toBe("false");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("preserves HEAD semantics and rejects every encoded path separator", async () => {
    const { joinUrl } = proxy.create(binding());
    const base = joinUrl.split("#")[0].replace(/\/vnc\.html$/, "");
    const head = await fetch(`http://127.0.0.1:${gatewayPort}${base}/vnc.html`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    for (const suffix of [
      "%2e%2e/secret",
      "%2E%2E/secret",
      "app%2fsecret",
      "app%2Fsecret",
      "app%5csecret",
      "app%5Csecret",
      "app%00secret",
      "%252e%252e%252fsecret",
    ]) {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}${base}/${suffix}`);
      expect(response.status, suffix).not.toBe(200);
    }
  });

  it("revokes the previous bot token and refuses cross-bot token reuse", async () => {
    const first = proxy.create(binding());
    const second = proxy.create(binding());
    const firstResponse = await fetch(`http://127.0.0.1:${gatewayPort}${first.joinUrl.split("#")[0]}`);
    expect(firstResponse.status).toBe(403);

    const crossed = second.joinUrl.replace(`/bots/${BOT_A}/`, `/bots/${BOT_B}/`).split("#")[0];
    const crossResponse = await fetch(`http://127.0.0.1:${gatewayPort}${crossed}`);
    expect(crossResponse.status).toBe(403);
  });

  it("revalidates the control hold, target generation, and expiry", async () => {
    const holdSession = proxy.create(binding());
    held = false;
    expect(
      (await fetch(`http://127.0.0.1:${gatewayPort}${holdSession.joinUrl.split("#")[0]}`)).status,
    ).toBe(403);

    held = true;
    const generationSession = proxy.create(binding());
    currentGeneration = "generation-2";
    expect(
      (await fetch(`http://127.0.0.1:${gatewayPort}${generationSession.joinUrl.split("#")[0]}`)).status,
    ).toBe(403);

    currentGeneration = "generation-1";
    const expiringSession = proxy.create(binding());
    now = expiringSession.expiresAt;
    expect(
      (await fetch(`http://127.0.0.1:${gatewayPort}${expiringSession.joinUrl.split("#")[0]}`)).status,
    ).toBe(403);
  });

  it("proxies the noVNC websocket and closes it when the target is revoked", async () => {
    const { joinUrl } = proxy.create(binding());
    const base = joinUrl.split("#")[0].replace(/\/vnc\.html$/, "");
    const { socket, response } = await rawUpgrade(`${base}/websockify`);
    expect(response).toContain("101 Switching Protocols");

    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    proxy.revokeTarget("bot:target-a");
    await closed;
  });

  it("keeps the lease through a transient reconnect but releases after the final detach", async () => {
    const { joinUrl } = proxy.create(binding());
    const base = joinUrl.split("#")[0].replace(/\/vnc\.html$/, "");
    const first = await rawUpgrade(`${base}/websockify`);
    expect(first.response).toContain("101 Switching Protocols");
    first.socket.end();

    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await rawUpgrade(`${base}/websockify`);
    expect(second.response).toContain("101 Switching Protocols");
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(released).toHaveLength(0);

    second.socket.end();
    await expect.poll(() => released.length, { timeout: 1_000 }).toBe(1);
    expect(released[0]).toMatchObject({
      botId: BOT_A,
      targetKey: "bot:target-a",
      controlOwnerId: "renderer-a",
      controlLeaseToken: "control-token-a",
    });
  });

  it("closes an attached websocket and rejects reconnect after token expiry", async () => {
    const session = proxy.create(binding());
    const base = session.joinUrl.split("#")[0].replace(/\/vnc\.html$/, "");
    const { socket } = await rawUpgrade(`${base}/websockify`);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

    now = session.expiresAt;
    const expiredAsset = await fetch(`http://127.0.0.1:${gatewayPort}${base}/vnc.html`);
    expect(expiredAsset.status).toBe(403);
    await closed;
    const reconnect = await rawUpgrade(`${base}/websockify`);
    expect(reconnect.response).toContain("403 Forbidden");
    reconnect.socket.destroy();
  });

  it("rejects non-websocket paths on the upgrade route", async () => {
    const { joinUrl } = proxy.create(binding());
    const invalid = joinUrl.split("#")[0].replace(/vnc\.html$/, "app.js");
    const { socket, response } = await rawUpgrade(invalid);
    expect(response).toContain("400 Bad Request");
    socket.destroy();
  });
});
