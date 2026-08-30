import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppConfig } from "./config.ts";
import { loadConfig, saveConfig } from "./config.ts";
import {
  acquireComposioConfigUse,
  applyManagedBrokerMessage,
  authorizeService,
  beginComposioCredentialMutation,
  connectedServices,
  connectionMode,
  connectionStatus,
  listToolkits,
  mcpIntegration,
  normalizeAccountAlias,
  prepareProjectSession,
  relayMcp,
  removeAccount,
  removeService,
  setManagedBrokerAccess,
} from "./composio.ts";

let api: Server;
let base = "";
const calls: Array<{ method: string; path: string; query: string; body: any }> = [];
let malformedConnectedAccounts = false;
let connectedAccountsUnavailable = false;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeAll(async () => {
  api = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: req.method ?? "GET", path: url.pathname, query: url.search, body });

    if (req.headers["x-api-key"] !== "ak_test") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "invalid project key" } }));
    }

    if (req.method === "POST" && url.pathname === "/api/v3.1/tool_router/session") {
      res.writeHead(201, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        session_id: "trs_test",
        mcp: { type: "http", url: "https://app.composio.dev/tool_router/v3/trs_test/mcp" },
        config: { user_id: body.user_id, multi_account: body.multi_account },
      }));
    }
    if (req.method === "GET" && url.pathname === "/api/v3.1/tool_router/session/trs_test") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        session_id: "trs_test",
        mcp: { type: "http", url: "https://app.composio.dev/tool_router/v3/trs_test/mcp" },
        config: {
          user_id: "openmausbot_existing",
          multi_account: {
            enable: true,
            max_accounts_per_toolkit: 5,
            require_explicit_selection: true,
          },
        },
      }));
    }
    if (req.method === "GET" && url.pathname === "/api/v3.1/tool_router/session/trs_legacy") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        session_id: "trs_legacy",
        mcp: { type: "http", url: "https://app.composio.dev/tool_router/v3/trs_legacy/mcp" },
        config: { user_id: "openmausbot_legacy" },
      }));
    }
    if (req.method === "GET" && url.pathname.endsWith("/toolkits")) {
      res.writeHead(200, { "content-type": "application/json" });
      if (url.searchParams.get("cursor") === "toolkits-page-2") {
        return res.end(JSON.stringify({
          items: [
            { slug: "publicsearch", is_no_auth: true },
            { slug: "selectedonly", connected_account: { id: "ca_session_only", status: "ACTIVE" } },
          ],
        }));
      }
      const page = {
        items: [
          { slug: "github", connected_account: { id: "ca_github", status: "ACTIVE" } },
          { slug: "gmail", is_no_auth: true },
          { slug: "slack" },
          { slug: "unconnected", connected_account: null },
        ],
        next_cursor: url.searchParams.has("toolkits") ? undefined : "toolkits-page-2",
      };
      return res.end(JSON.stringify(page));
    }
    if (req.method === "GET" && url.pathname === "/api/v3.1/connected_accounts") {
      if (connectedAccountsUnavailable) {
        res.writeHead(403, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "connected-account read not granted" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (malformedConnectedAccounts) return res.end(JSON.stringify({ items: {} }));
      if (url.searchParams.get("cursor") === "accounts-page-2") {
        return res.end(JSON.stringify({
          items: [
            { id: "ca_toolkit_41", alias: "overflow", toolkit: { slug: "toolkit_41" }, status: "ACTIVE", updated_at: "2026-08-17T10:00:00Z" },
          ],
        }));
      }
      return res.end(JSON.stringify({
        items: [
          { id: "ca_github_work", alias: "work", toolkit: { slug: "github" }, status: "ACTIVE", updated_at: "2026-08-17T08:00:00Z" },
          { id: "ca_github_personal", alias: "personal", toolkit: { slug: "github" }, status: "ACTIVE", updated_at: "2026-08-17T09:00:00Z" },
          { id: "ca_notion", alias: "team", toolkit: { slug: "notion" }, status: "INITIATED", updated_at: "2026-08-17T08:01:00Z" },
          { id: "ca_linear", toolkit: { slug: "linear" }, status: "EXPIRED", updated_at: "2026-08-17T08:02:00Z" },
        ],
        next_cursor: "accounts-page-2",
      }));
    }
    if (req.method === "POST" && url.pathname.endsWith("/link")) {
      res.writeHead(201, { "content-type": "application/json" });
      return res.end(JSON.stringify({ redirect_url: `https://connect.composio.dev/link/${body.toolkit}` }));
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/v3.1/connected_accounts/ca_")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ success: true }));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  // SAFETY: listen() above binds an IPv4 TCP host, so Node returns AddressInfo rather than a pipe name.
  base = `http://127.0.0.1:${(api.address() as { port: number }).port}/api/v3.1`;
  process.env.OMB_COMPOSIO_API = base;
});

afterAll(async () => {
  setManagedBrokerAccess(null);
  delete process.env.OMB_COMPOSIO_API;
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

describe.sequential("Composio Sessions", () => {
  it("rejects broker URL components and invalid tokens from the environment", () => {
    process.env.OMB_COMPOSIO_BROKER_TOKEN = "a".repeat(64);
    try {
      for (const url of [
        "https://user:secret@broker.example/root",
        "https://broker.example/root?redirect=evil",
        "https://broker.example/root#fragment",
      ]) {
        process.env.OMB_COMPOSIO_BROKER_URL = url;
        expect(() => connectionMode({})).toThrow(/must not include/);
      }
      process.env.OMB_COMPOSIO_BROKER_URL = "http://[::1]:3210/root/";
      expect(connectionMode({})).toBe("managed");
      process.env.OMB_COMPOSIO_BROKER_TOKEN = "short";
      expect(() => connectionMode({})).toThrow(/token is invalid/);
      expect(() => acquireComposioConfigUse({})).toThrow(/token is invalid/);
    } finally {
      delete process.env.OMB_COMPOSIO_BROKER_URL;
      delete process.env.OMB_COMPOSIO_BROKER_TOKEN;
    }
    const mutation = beginComposioCredentialMutation(undefined, "ak_after_invalid_env");
    expect(mutation).toMatchObject({ allowed: true, changing: true });
    if (mutation.allowed) mutation.release();
  });
  it("accepts a private desktop credential update and rejects unsafe broker URLs", () => {
    setManagedBrokerAccess({ url: "http://127.0.0.1:3210/", token: "a".repeat(64) });
    expect(connectionMode({})).toBe("managed");
    setManagedBrokerAccess({ url: "http://[::1]:3210/", token: "a".repeat(64) });
    expect(connectionMode({})).toBe("managed");
    expect(() =>
      setManagedBrokerAccess({ url: "http://broker.example", token: "a".repeat(64) }),
    ).toThrow(/HTTPS/);
    for (const url of [
      "https://user:secret@broker.example/root",
      "https://broker.example/root?redirect=evil",
      "https://broker.example/root#fragment",
    ]) {
      expect(() => setManagedBrokerAccess({ url, token: "a".repeat(64) })).toThrow(/must not include/);
    }
    expect(() => setManagedBrokerAccess({ url: "https://broker.example", token: "short" })).toThrow();
    setManagedBrokerAccess(null);
  });
  it("ignores credential sync without access and clears only on explicit null", () => {
    const messageType = "openmausbot:managed-composio";
    setManagedBrokerAccess({ url: "http://127.0.0.1:3210/", token: "a".repeat(64) });

    expect(applyManagedBrokerMessage({ type: messageType })).toBe(false);
    expect(connectionMode({})).toBe("managed");

    expect(applyManagedBrokerMessage({ type: messageType, access: null })).toBe(true);
    expect(connectionMode({})).toBe("unavailable");
  });
  it("accepts only project API keys", async () => {
    await expect(prepareProjectSession("old_key")).rejects.toThrow(/start with ak_/i);
    await expect(prepareProjectSession("ak_wrong")).rejects.toThrow(/invalid project key/i);
  });

  it("creates one stable per-installation session and reuses it", async () => {
    const created = await prepareProjectSession("ak_test", { userId: "openmausbot_existing" });
    expect(created).toEqual({
      apiKey: "ak_test",
      userId: "openmausbot_existing",
      sessionId: "trs_test",
    });
    expect(calls.filter((call) => call.method === "POST" && call.path.endsWith("/session")).at(-1)?.body).toEqual({
      user_id: "openmausbot_existing",
      manage_connections: {
        enable: true,
        enable_wait_for_connections: true,
        enable_connection_removal: true,
      },
      multi_account: {
        enable: true,
        max_accounts_per_toolkit: 5,
        require_explicit_selection: true,
      },
    });

    const reused = await prepareProjectSession("ak_test", created);
    expect(reused).toEqual({
      apiKey: "ak_test",
      userId: "openmausbot_existing",
      sessionId: "trs_test",
    });
  });

  it("holds a credential mutation outside every active account generation", () => {
    const use = acquireComposioConfigUse({
      composio: { apiKey: "ak_generation_a", userId: "user-a", sessionId: "session-a" },
    });
    expect(beginComposioCredentialMutation("ak_generation_a", "ak_generation_b")).toMatchObject({
      allowed: false,
      error: expect.stringMatching(/active connected-app operations/i),
    });
    expect(beginComposioCredentialMutation("ak_generation_a", "ak_generation_a", { force: true })).toMatchObject({
      allowed: false,
      error: expect.stringMatching(/active connected-app operations/i),
    });
    use.release();

    const mutation = beginComposioCredentialMutation("ak_generation_a", "ak_generation_a", { force: true });
    expect(mutation).toMatchObject({ allowed: true, changing: true });
    expect(() => acquireComposioConfigUse({ composio: { apiKey: "ak_generation_a" } })).toThrow(
      /settings are being updated/i,
    );
    if (mutation.allowed) mutation.release();

    const after = acquireComposioConfigUse({ composio: { apiKey: "ak_generation_b" } });
    after.release();
  });

  it("snapshots config validation before its first await", async () => {
    const previousFetch = globalThis.fetch;
    const started = deferred();
    const unblock = deferred();
    const current = {
      apiKey: "ak_test",
      userId: "openmausbot_generation_a",
      sessionId: "trs_prepare_race",
    };
    const observedBodies: unknown[] = [];
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith("/tool_router/session/trs_prepare_race")) {
        started.resolve();
        await unblock.promise;
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("/tool_router/session") && init?.method === "POST") {
        observedBodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({
          session_id: "trs_prepare_created",
          mcp: { type: "http", url: "https://app.composio.dev/tool_router/v3/trs_prepare_created/mcp" },
          config: {
            user_id: "openmausbot_generation_a",
            multi_account: {
              enable: true,
              max_accounts_per_toolkit: 5,
              require_explicit_selection: true,
            },
          },
        }), { status: 201, headers: { "content-type": "application/json" } });
      }
      return previousFetch(input, init);
    };
    try {
      const pending = prepareProjectSession("ak_test", current);
      await started.promise;
      Object.assign(current, {
        apiKey: "ak_generation_b",
        userId: "openmausbot_generation_b",
        sessionId: "trs_generation_b",
      });
      unblock.resolve();
      await expect(pending).resolves.toEqual({
        apiKey: "ak_test",
        userId: "openmausbot_generation_a",
        sessionId: "trs_prepare_created",
      });
      expect(observedBodies).toEqual([expect.objectContaining({ user_id: "openmausbot_generation_a" })]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("never mixes a stale Session generation into a replacement project config", async () => {
    const previousFetch = globalThis.fetch;
    const started = deferred();
    const unblock = deferred();
    const observedKeys: string[] = [];
    const cfg: AppConfig = {
      composio: {
        apiKey: "ak_generation_race_a",
        userId: "openmausbot_race_a",
        sessionId: "trs_generation_race_a",
      },
    };
    let staleSessionReads = 0;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const key = new Headers(input instanceof Request ? input.headers : init?.headers).get("x-api-key");
      if (key) observedKeys.push(key);
      if (url.pathname.endsWith("/tool_router/session/trs_generation_race_a")) {
        staleSessionReads += 1;
        if (staleSessionReads === 1) {
          started.resolve();
          await unblock.promise;
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("/tool_router/session") && init?.method === "POST") {
        return new Response(JSON.stringify({
          session_id: "trs_generation_created_a",
          mcp: { type: "http", url: "https://app.composio.dev/tool_router/v3/trs_generation_created_a/mcp" },
          config: {
            user_id: "openmausbot_race_a",
            multi_account: {
              enable: true,
              max_accounts_per_toolkit: 5,
              require_explicit_selection: true,
            },
          },
        }), { status: 201, headers: { "content-type": "application/json" } });
      }
      if (url.pathname.endsWith("/tool_router/session/trs_generation_created_a")) {
        return new Response(JSON.stringify({
          session_id: "trs_generation_created_a",
          mcp: { type: "http", url: "https://app.composio.dev/tool_router/v3/trs_generation_created_a/mcp" },
          config: {
            user_id: "openmausbot_race_a",
            multi_account: { enable: true },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname.endsWith("/tool_router/session/trs_generation_created_a/toolkits")) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("/connected_accounts")) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return previousFetch(input, init);
    };
    try {
      const pending = connectedServices(cfg);
      await started.promise;
      cfg.composio = {
        apiKey: "ak_generation_race_b",
        userId: "openmausbot_race_b",
        sessionId: "trs_generation_race_b",
      };
      saveConfig({ composio: cfg.composio });
      unblock.resolve();
      await expect(pending).resolves.toEqual({});

      expect(new Set(observedKeys)).toEqual(new Set(["ak_generation_race_a"]));
      expect(cfg.composio).toEqual({
        apiKey: "ak_generation_race_b",
        userId: "openmausbot_race_b",
        sessionId: "trs_generation_race_b",
      });
      expect(loadConfig().composio).toEqual(cfg.composio);
    } finally {
      globalThis.fetch = previousFetch;
      saveConfig({ composio: { apiKey: "", userId: "", sessionId: "" } });
    }
  });

  it("keeps an agent MCP relay on the exact project generation it started with", async () => {
    const previousFetch = globalThis.fetch;
    const started = deferred();
    const unblock = deferred();
    const cfg: AppConfig = {
      composio: {
        apiKey: "ak_relay_generation_a",
        userId: "openmausbot_relay_a",
        sessionId: "trs_relay_generation_a",
      },
    };
    let relayKey = "";
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith("/tool_router/session/trs_relay_generation_a")) {
        started.resolve();
        await unblock.promise;
        return new Response(JSON.stringify({
          session_id: "trs_relay_generation_a",
          mcp: { type: "http", url: "https://app.composio.dev/tool_router/v3/trs_relay_generation_a/mcp" },
          config: { user_id: "openmausbot_relay_a", multi_account: { enable: true } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.hostname === "app.composio.dev" && url.pathname.endsWith("/trs_relay_generation_a/mcp")) {
        relayKey = new Headers(input instanceof Request ? input.headers : init?.headers).get("x-api-key") ?? "";
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "transport-a" },
        });
      }
      return previousFetch(input, init);
    };
    try {
      const pending = relayMcp(cfg, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      await started.promise;
      cfg.composio = {
        apiKey: "ak_relay_generation_b",
        userId: "openmausbot_relay_b",
        sessionId: "trs_relay_generation_b",
      };
      unblock.resolve();
      await expect(pending).resolves.toMatchObject({
        status: 200,
        contentType: "application/json",
        transportSessionId: "transport-a",
      });
      expect(relayKey).toBe("ak_relay_generation_a");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("keeps a destructive disconnect on its pinned project generation", async () => {
    const previousFetch = globalThis.fetch;
    const started = deferred();
    const unblock = deferred();
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "openmausbot_existing", sessionId: "trs_test" },
    };
    let deleteKey = "";
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith("/tool_router/session/trs_test/toolkits")) {
        started.resolve();
        await unblock.promise;
        return new Response(JSON.stringify({
          items: [{ slug: "github", connected_account: { id: "ca_disconnect_race", status: "ACTIVE" } }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname.endsWith("/connected_accounts/ca_disconnect_race")) {
        deleteKey = new Headers(input instanceof Request ? input.headers : init?.headers).get("x-api-key") ?? "";
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return previousFetch(input, init);
    };
    try {
      const pending = removeService(cfg, "github");
      await started.promise;
      cfg.composio = {
        apiKey: "ak_disconnect_generation_b",
        userId: "openmausbot_disconnect_b",
        sessionId: "trs_disconnect_b",
      };
      unblock.resolve();
      await expect(pending).resolves.toEqual({ removed: 1 });
      expect(deleteKey).toBe("ak_test");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("queues managed-account rotation until the pinned generation drains", async () => {
    const previousFetch = globalThis.fetch;
    const started = deferred();
    const unblock = deferred();
    const tokenA = "a".repeat(64);
    const tokenB = "b".repeat(64);
    const observedTokens: string[] = [];
    setManagedBrokerAccess({ url: "http://127.0.0.1:3210", token: tokenA });
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/v1/connectors/connected") {
        const token = new Headers(input instanceof Request ? input.headers : init?.headers)
          .get("authorization")
          ?.replace(/^Bearer /, "") ?? "";
        observedTokens.push(token);
        if (token === tokenA) {
          started.resolve();
          await unblock.promise;
        }
        return new Response(JSON.stringify({ services: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return previousFetch(input, init);
    };
    try {
      const first = connectedServices({});
      await started.promise;
      setManagedBrokerAccess({ url: "http://127.0.0.1:3210", token: tokenB });
      await expect(connectedServices({})).rejects.toThrow(/settings are being updated/i);
      unblock.resolve();
      await expect(first).resolves.toEqual({});
      await expect(connectedServices({})).resolves.toEqual({});
      expect(observedTokens).toEqual([tokenA, tokenB]);
    } finally {
      globalThis.fetch = previousFetch;
      setManagedBrokerAccess(null);
    }
  });

  it("namespaces the marketplace cache by credential generation", async () => {
    const previousFetch = globalThis.fetch;
    const previousToolkitsApi = process.env.OMB_COMPOSIO_TOOLKITS_API;
    const cfg: AppConfig = { composio: { apiKey: "ak_catalog_generation_a" } };
    const observedKeys: string[] = [];
    process.env.OMB_COMPOSIO_TOOLKITS_API = "https://catalog-race.invalid/api/v3";
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === "catalog-race.invalid") {
        const key = new Headers(input instanceof Request ? input.headers : init?.headers).get("x-api-key") ?? "";
        observedKeys.push(key);
        const generation = key.endsWith("_a") ? "A" : "B";
        return new Response(JSON.stringify({
          items: [{ slug: `generation-${generation.toLowerCase()}`, name: `Generation ${generation}` }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return previousFetch(input, init);
    };
    try {
      await expect(listToolkits(cfg)).resolves.toMatchObject({
        cards: [expect.objectContaining({ slug: "generation-a" })],
        source: "api",
      });
      cfg.composio = { apiKey: "ak_catalog_generation_b" };
      await expect(listToolkits(cfg)).resolves.toMatchObject({
        cards: [expect.objectContaining({ slug: "generation-b" })],
        source: "api",
      });
      cfg.composio = { apiKey: "ak_catalog_generation_a" };
      await expect(listToolkits(cfg)).resolves.toMatchObject({
        cards: [expect.objectContaining({ slug: "generation-a" })],
        source: "api",
      });
      expect(observedKeys).toEqual(["ak_catalog_generation_a", "ak_catalog_generation_b"]);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousToolkitsApi === undefined) delete process.env.OMB_COMPOSIO_TOOLKITS_API;
      else process.env.OMB_COMPOSIO_TOOLKITS_API = previousToolkitsApi;
    }
  });

  it("recreates a legacy Session with the same Composio user ID", async () => {
    const upgraded = await prepareProjectSession("ak_test", {
      apiKey: "ak_test",
      userId: "stale-local-user-id",
      sessionId: "trs_legacy",
    });
    expect(upgraded).toEqual({
      apiKey: "ak_test",
      userId: "openmausbot_legacy",
      sessionId: "trs_test",
    });
    expect(calls.filter((call) => call.method === "POST" && call.path.endsWith("/session")).at(-1)?.body).toMatchObject({
      user_id: "openmausbot_legacy",
      multi_account: {
        enable: true,
        max_accounts_per_toolkit: 5,
        require_explicit_selection: true,
      },
    });
  });

  it("validates account aliases before sending them upstream", () => {
    expect(normalizeAccountAlias("  personal gmail  ")).toBe("personal gmail");
    expect(() => normalizeAccountAlias("bad\nalias")).toThrow(/printable/i);
    expect(() => normalizeAccountAlias("x".repeat(65))).toThrow(/1-64/i);
  });

  it("mounts the Session MCP endpoint with the project key header", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "openmausbot_existing", sessionId: "trs_test" },
    };
    const integration = await mcpIntegration(cfg, {
      harnessUrl: "http://127.0.0.1:8799",
      capabilityToken: "secret",
    });
    expect(integration).toMatchObject({
      command: process.execPath,
      args: [expect.stringContaining("connector-proxy")],
      env: {
        OMB_CONNECTOR_UPSTREAM_URL: "http://127.0.0.1:8799/api/internal/connectors/mcp",
        OMB_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: "Bearer secret" }),
        OMB_HARNESS_URL: "http://127.0.0.1:8799",
        OMB_CONNECTOR_CAPABILITY_TOKEN: "secret",
      },
    });
  });

  it("aborts an in-flight MCP relay when the owning turn is revoked", async () => {
    const previousFetch = globalThis.fetch;
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    setManagedBrokerAccess({ url: "http://127.0.0.1:3210", token: "a".repeat(64) });
    globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      receivedSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error("missing abort signal"));
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    try {
      const pending = relayMcp(
        {},
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        undefined,
        { signal: controller.signal },
      );
      controller.abort(new Error("turn authority revoked"));
      await expect(pending).rejects.toThrow("turn authority revoked");
      expect(receivedSignal?.aborted).toBe(true);
    } finally {
      globalThis.fetch = previousFetch;
      setManagedBrokerAccess(null);
    }
  });

  it("reports connection state, creates auth links and revokes disconnects", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "openmausbot_existing", sessionId: "trs_test" },
    };
    await expect(connectionStatus(cfg, ["github", "gmail", "slack", "notion", "linear"])).resolves.toEqual({
      github: {
        connected: true,
        pending: false,
        status: "ACTIVE",
        accounts: [
          { id: "ca_github_personal", alias: "personal", status: "ACTIVE" },
          { id: "ca_github_work", alias: "work", status: "ACTIVE" },
          // the Session-selected account is synthesized when the raw list
          // omits it — same rule as the inventory path
          { id: "ca_github", status: "ACTIVE" },
        ],
      },
      gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [] },
      slack: { connected: false, pending: false, status: "not_connected", accounts: [] },
      notion: {
        connected: false,
        pending: true,
        status: "INITIATED",
        accounts: [{ id: "ca_notion", alias: "team", status: "INITIATED" }],
      },
      linear: {
        connected: false,
        pending: false,
        status: "EXPIRED",
        accounts: [{ id: "ca_linear", status: "EXPIRED" }],
      },
    });
    await expect(authorizeService(cfg, "github")).rejects.toThrow(/alias.*not replaced/i);
    await expect(authorizeService(cfg, "github", "work")).rejects.toThrow(/already in use/i);
    await expect(authorizeService(cfg, "github", "personal-two")).resolves.toEqual({
      url: "https://connect.composio.dev/link/github",
    });
    expect(calls.filter((call) => call.method === "POST" && call.path.endsWith("/link")).at(-1)?.body).toEqual({
      toolkit: "github",
      alias: "personal-two",
    });
    await expect(removeAccount(cfg, "github", "ca_github_personal")).resolves.toEqual({ removed: 1 });
    await expect(removeAccount(cfg, "github", "ca_other_user")).resolves.toEqual({ removed: 0 });
    await expect(removeAccount(cfg, "github", "../other")).rejects.toThrow(/invalid connected-account ID/i);
    await expect(removeService(cfg, "github")).resolves.toEqual({ removed: 1 });
    expect(calls.some(
      (call) => call.method === "DELETE"
        && call.path.endsWith("/connected_accounts/ca_github")
        && call.query === "?revoke_on_delete=true",
    )).toBe(true);
  });

  it("enumerates connected services independently of catalog position", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "openmausbot_existing", sessionId: "trs_test" },
    };
    const callCount = calls.length;

    await expect(connectedServices(cfg)).resolves.toMatchObject({
      toolkit_41: {
        connected: true,
        pending: false,
        status: "ACTIVE",
        accounts: [{ id: "ca_toolkit_41", alias: "overflow", status: "ACTIVE" }],
      },
      github: {
        accounts: [
          { id: "ca_github_personal", alias: "personal", status: "ACTIVE" },
          { id: "ca_github_work", alias: "work", status: "ACTIVE" },
          { id: "ca_github", status: "ACTIVE" },
        ],
      },
      publicsearch: {
        connected: true,
        pending: false,
        status: "ACTIVE",
        accounts: [],
      },
      selectedonly: {
        connected: true,
        pending: false,
        status: "ACTIVE",
        accounts: [{ id: "ca_session_only", status: "ACTIVE" }],
      },
    });

    const inventoryCalls = calls.slice(callCount).filter((call) => call.path.endsWith("/connected_accounts"));
    expect(inventoryCalls).toHaveLength(2);
    expect(inventoryCalls[0]?.query).not.toContain("toolkit_slugs=");
    expect(inventoryCalls[1]?.query).toContain("cursor=accounts-page-2");
    const toolkitCalls = calls.slice(callCount).filter((call) => call.path.endsWith("/toolkits"));
    expect(toolkitCalls).toHaveLength(2);
    expect(toolkitCalls[0]?.query).toContain("is_connected=true");
    expect(toolkitCalls[1]?.query).toContain("cursor=toolkits-page-2");
  });

  it("falls back to complete Session toolkit state without connected-account read permission", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "openmausbot_existing", sessionId: "trs_test" },
    };
    connectedAccountsUnavailable = true;
    try {
      await expect(connectedServices(cfg)).resolves.toMatchObject({
        github: {
          connected: true,
          status: "ACTIVE",
          accounts: [{ id: "ca_github", status: "ACTIVE" }],
        },
        gmail: { connected: true, status: "ACTIVE", accounts: [] },
        publicsearch: { connected: true, status: "ACTIVE", accounts: [] },
        selectedonly: {
          connected: true,
          status: "ACTIVE",
          accounts: [{ id: "ca_session_only", status: "ACTIVE" }],
        },
      });
    } finally {
      connectedAccountsUnavailable = false;
    }
  });

  it("falls back to session toolkit state when connected-account items is malformed", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "openmausbot_existing", sessionId: "trs_test" },
    };
    malformedConnectedAccounts = true;
    try {
      await expect(connectionStatus(cfg, ["github", "slack"])).resolves.toEqual({
        // the malformed list degrades to [], but the Session still names its
        // selected account — synthesized so a poll never wipes the row
        github: { connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "ca_github", status: "ACTIVE" }] },
        slack: { connected: false, pending: false, status: "not_connected", accounts: [] },
      });
    } finally {
      malformedConnectedAccounts = false;
    }
  });
});
