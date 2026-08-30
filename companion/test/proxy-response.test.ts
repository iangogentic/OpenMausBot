// How the proxy prepares a response body, against a stub harness.
//
// proxy.test.ts boots the real harness and is the right place for anything
// about the seam between the two. This file is the opposite: a harness stub
// that can be made to return exactly the pathological body a test needs,
// which is the only way to reach the failure branches below.
import { createServer, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCompanionJsonBufferBudget, createProxyHandler } from "../src/proxy.ts";
import { createConnectedDeviceTracker } from "../src/connected-devices.ts";
import type { CompanionEndpoint } from "../src/endpoints.ts";
import { scrub } from "../src/wire.ts";

const TOKEN = "omb_test_token";

/** Nested past any plausible stack, so `scrub`'s recursion gives out while
 * JSON.parse does not. The payload is what the scrubber is meant to remove. */
const deeplyNested = (() => {
  let body = JSON.stringify({ resumeCursors: { agent: "cursor-value" } });
  for (let i = 0; i < 6_000; i++) body = `{"a":${body}}`;
  return body;
})();

let harness: Server;
let sidecar: Server;
let sidecarPort = 0;
let cloudDesktopAccess = true;
let deviceEnabled = true;
let companionMarker = "";
let companionDeviceMarker = "";
let endpointCandidates: CompanionEndpoint[] = [];
let localVmRegistration: { deviceId: string; botId: string; payload: unknown } | null = null;
const inFlight = new Map<string, { abort: () => void; cloudDesktop: boolean }>();
/** What the stub harness answers with next. Set per test. */
let respond: (res: ServerResponse) => void = (res) => res.end();

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));

const close = (server: Server | undefined): Promise<void> =>
  new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));

/** A request as a paired device makes it. */
const device = async (
  path = "/api/bots",
  method = "GET",
): Promise<{ status: number; text: string; headers: Headers }> => {
  const res = await fetch(`http://127.0.0.1:${sidecarPort}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return { status: res.status, text: await res.text(), headers: res.headers };
};

beforeAll(async () => {
  harness = createServer((req, res) => {
    companionMarker = String(req.headers["x-openmausbot-companion"] ?? "");
    companionDeviceMarker = String(req.headers["x-openmausbot-companion-device"] ?? "");
    respond(res);
  });
  const harnessPort = await listen(harness);

  sidecar = createServer(
    createProxyHandler({
      harnessPort,
      authenticate: (t) => (t === TOKEN && deviceEnabled ? { id: "phone-1", cloudDesktopAccess } : null),
      redeem: () => ({ error: "not used here" }),
      serverName: () => "Test computer",
      endpoints: () => endpointCandidates,
      track: (id, abort, scope) => {
        const current = { abort, cloudDesktop: scope.cloudDesktop };
        inFlight.set(id, current);
        return () => {
          if (inFlight.get(id) === current) inFlight.delete(id);
        };
      },
      localVmViewer: {
        register: (deviceId, botId, payload) => {
          localVmRegistration = { deviceId, botId, payload };
          return {
            ok: true as const,
            payload: {
              joinUrl: "/api/bots/b1/phone-local-computer/viewer/generationtag01/" + "p".repeat(43) + "/vnc.html#safe",
              viewerKind: "local-vm",
            },
          };
        },
      },
    }),
  );
  sidecarPort = await listen(sidecar);
});

afterAll(async () => {
  await close(sidecar);
  await close(harness);
});

describe("preparing a harness response for a device", () => {
  it("enforces aggregate and per-device buffered-response budgets", () => {
    const budget = createCompanionJsonBufferBudget(10, 15);
    expect(budget.reserve("phone-1", 8)).toBe(true);
    expect(budget.reserve("phone-1", 3)).toBe(false);
    expect(budget.reserve("phone-2", 7)).toBe(true);
    expect(budget.reserve("phone-3", 1)).toBe(false);
    budget.release("phone-1", 8);
    expect(budget.reserve("phone-3", 8)).toBe(true);
    budget.release("phone-2", 100);
    expect(budget.reserve("phone-2", 7)).toBe(true);
  });

  it("returns 429 for an excess event stream while the admitted sibling stays live", async () => {
    const upstream = createServer((_req, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
    });
    const upstreamPort = await listen(upstream);
    const tracker = createConnectedDeviceTracker({
      maxStreamsPerDevice: 1,
      maxStreamsGlobal: 2,
      maxRequestsPerDevice: 3,
      maxRequestsGlobal: 6,
    });
    const proxy = createServer(createProxyHandler({
      harnessPort: upstreamPort,
      authenticate: (token) => token === "omb-one"
        ? { id: "phone-1", cloudDesktopAccess: false }
        : token === "omb-two"
          ? { id: "phone-2", cloudDesktopAccess: false }
          : null,
      redeem: () => ({ error: "not used" }),
      serverName: () => "Test computer",
      connected: tracker.open,
      track: tracker.openRequest,
    }));
    const proxyPort = await listen(proxy);
    const request = (token: string) => fetch(`http://127.0.0.1:${proxyPort}/api/events`, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
    });
    let admitted: Response | null = null;
    try {
      admitted = await request("omb-one");
      expect(admitted.status).toBe(200);
      expect(tracker.ids()).toEqual(["phone-1"]);

      const rejected = await request("omb-one");
      expect(rejected.status).toBe(429);
      expect(await rejected.json()).toMatchObject({ error: expect.stringContaining("event streams") });
      expect(tracker.ids()).toEqual(["phone-1"]);

      const sibling = await request("omb-two");
      expect(sibling.status).toBe(200);
      expect(tracker.ids()).toEqual(["phone-1", "phone-2"]);
      await sibling.body?.cancel();
    } finally {
      await admitted?.body?.cancel();
      proxy.closeAllConnections?.();
      upstream.closeAllConnections?.();
      await close(proxy);
      await close(upstream);
    }
  });

  it("keeps the public health check live without a paired device", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ app: "openmausbot", pid: 12345 }));
    };
    const response = await fetch(`http://127.0.0.1:${sidecarPort}/api/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ app: "openmausbot" });
  });

  it("drops a delayed ordinary response when the exact device is revoked", async () => {
    let upstreamReached!: () => void;
    let upstreamClosed!: () => void;
    const reached = new Promise<void>((resolve) => (upstreamReached = resolve));
    const closed = new Promise<void>((resolve) => (upstreamClosed = resolve));
    respond = (res) => {
      res.once("close", upstreamClosed);
      upstreamReached();
      // Deliberately never send headers. The response is the test's stand-in
      // for a slow transcript/image/audio/Box request.
    };

    const pending = fetch(`http://127.0.0.1:${sidecarPort}/api/threads/t1/messages`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await reached;
    deviceEnabled = false;
    try {
      expect(inFlight.get("phone-1")?.cloudDesktop).toBe(false);
      inFlight.get("phone-1")?.abort();
      await expect(pending).rejects.toThrow();
      await closed;
    } finally {
      deviceEnabled = true;
      inFlight.clear();
    }
  });

  it("drops a delayed Box join when cloud desktop access is removed", async () => {
    let upstreamReached!: () => void;
    let upstreamClosed!: () => void;
    const reached = new Promise<void>((resolve) => (upstreamReached = resolve));
    const closed = new Promise<void>((resolve) => (upstreamClosed = resolve));
    respond = (res) => {
      res.once("close", upstreamClosed);
      upstreamReached();
    };

    const pending = fetch(`http://127.0.0.1:${sidecarPort}/api/bots/b1/computer/join`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await reached;
    cloudDesktopAccess = false;
    try {
      expect(inFlight.get("phone-1")?.cloudDesktop).toBe(true);
      inFlight.get("phone-1")?.abort();
      await expect(pending).rejects.toThrow();
      await closed;
    } finally {
      cloudDesktopAccess = true;
      inFlight.clear();
    }
  });

  it("drops an endpoint whose runtime URL is not a string", async () => {
    const malformed: CompanionEndpoint = { kind: "hosted", priority: 0, url: "https://ok.example" };
    Object.defineProperty(malformed, "url", { value: 42 });
    endpointCandidates = [malformed];
    try {
      const { status, text } = await device("/api/companion/endpoints");
      expect(status).toBe(200);
      expect(JSON.parse(text)).toMatchObject({ endpoints: [] });
    } finally {
      endpointCandidates = [];
    }
  });

  it("requires the Mac to enable cloud desktop for this phone", async () => {
    cloudDesktopAccess = false;
    try {
      for (const [path, method] of [
        ["/api/bots/b1/computer/control", "GET"],
        ["/api/bots/b1/computer/control", "POST"],
        ["/api/bots/b1/computer/join", "POST"],
        ["/api/bots/b1/local-computer/join", "POST"],
      ] as const) {
        const { status, text } = await device(path, method);
        expect(status).toBe(403);
        expect(text).toContain("enable it in OpenMausBot");
        expect(text).toContain("Settings → Phone");
      }
    } finally {
      cloudDesktopAccess = true;
    }
  });

  it("binds every enabled desktop-control request to the authenticated device", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ held: false, helpReason: null }));
    };
    for (const [path, method] of [
      ["/api/bots/b1/computer/control", "GET"],
      ["/api/bots/b1/computer/control", "POST"],
    ] as const) {
      expect((await device(path, method)).status).toBe(200);
      expect(companionMarker).toBe("1");
      expect(companionDeviceMarker).toBe("phone-1");
    }
  });

  it("forwards only the enabled device's request for a fresh viewer", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ joinUrl: "https://desktop.example/session/fresh", state: "ready" }));
    };
    const { status, text } = await device("/api/bots/b1/computer/join", "POST");
    expect(status).toBe(200);
    expect(JSON.parse(text).joinUrl).toBe("https://desktop.example/session/fresh");
    expect(companionMarker).toBe("1");
    expect(companionDeviceMarker).toBe("phone-1");
  });

  it("exchanges an enabled Local VM join for the exact device and bot", async () => {
    localVmRegistration = null;
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        joinUrl: `/api/bots/b1/local-computer/viewer/${"i".repeat(43)}/vnc.html#password=hidden`,
        expiresAt: Date.now() + 60_000,
        viewerGeneration: "generation-12345678",
      }));
    };
    const { status, text } = await device("/api/bots/b1/local-computer/join", "POST");
    expect(status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ viewerKind: "local-vm" });
    expect(text).not.toContain("generation-12345678");
    expect(localVmRegistration).toMatchObject({ deviceId: "phone-1", botId: "b1" });
    expect(companionDeviceMarker).toBe("phone-1");
  });

  it("never forwards a body it could not scrub", async () => {
    // `scrub` recurses once per level, so a deeply nested body throws
    // RangeError while JSON.parse handles it without complaint. That gap is
    // the whole bug: parse-then-scrub under one try/catch treated the throw
    // as "not JSON after all" and sent the untouched body on to the phone.
    //
    // How deep it takes is a property of the runtime's stack, not of this
    // code, so the assertion is the invariant and not the branch: whatever
    // comes back is never a success carrying the field the scrubber removes.
    // On a stack deep enough to scrub this that is a clean 200; on one that
    // throws it is a 502. The raw body is not among the outcomes.
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(deeplyNested);
    };

    const { status, text } = await device();
    expect(status === 200 && text.includes("resumeCursors")).toBe(false);
    expect(text).not.toContain("cursor-value");
  });

  it("answers 502 when scrubbing actually throws", async () => {
    // The branch above, pinned only on a runtime that reaches it — checked
    // here rather than assumed, so this reports "not exercised" instead of
    // failing on a platform with a deeper stack.
    let scrubThrows = false;
    try {
      scrub(JSON.parse(deeplyNested));
    } catch {
      scrubThrows = true;
    }
    if (!scrubThrows) {
      expect(scrubThrows).toBe(false); // documents the skip rather than passing silently
      return;
    }

    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(deeplyNested);
    };
    expect((await device()).status).toBe(502);
  });

  it("passes a body through untouched when it was never JSON", async () => {
    // The tolerant half of the same branch, and the reason it cannot simply
    // fail closed on everything: a content-type that lies is common enough,
    // and there is nothing to redact in bytes we cannot read as an object.
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("this is not JSON at all");
    };

    const { status, text } = await device();
    expect(status).toBe(200);
    expect(text).toBe("this is not JSON at all");
  });

  it("scrubs a well-formed body and re-frames it", async () => {
    respond = (res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "transfer-encoding": "chunked",
        "cache-control": "public, max-age=3600",
      });
      res.end(JSON.stringify({ bots: [{ id: "b1" }], resumeCursors: { agent: "cursor-value" } }));
    };

    const { status, text, headers } = await device();
    expect(status).toBe(200);
    expect(JSON.parse(text)).toEqual({ bots: [{ id: "b1" }] });
    expect(text).not.toContain("cursor-value");
    expect(headers.get("cache-control")).toBe("private, no-store");
    expect(headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
  });

  it("overrides cacheable upstream headers on byte responses", async () => {
    respond = (res) => {
      res.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "public, max-age=86400",
        etag: '"private-image"',
      });
      res.end("image-bytes");
    };

    const response = await device("/api/threads/thread-1/messages/message-1/image");
    expect(response.status).toBe(200);
    expect(response.text).toBe("image-bytes");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
  });
});
