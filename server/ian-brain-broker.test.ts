import { describe, expect, it, vi } from "vitest";

import {
  filterIanBrainMcpBytes,
  IAN_BRAIN_BOT_SAFE_TOOL_NAMES,
  IAN_BRAIN_MAX_RESPONSE_BYTES,
  ianBrainBotToolAllowed,
  ianBrainRequestCallsCredentialTool,
  ianBrainRequestAllowed,
  ianBrainRequestCallsUnsafeTool,
  issueIanBrainOpenMausBearer,
  relayIanBrainMcp,
  relayIanBrainSessionDelete,
  validateIanBrainTransportSession,
} from "./ian-brain-broker.ts";

const TURN_IDENTITY = {
  botId: "bot-alpha",
  generation: "generation_1234567890abcdef",
} as const;
const SIGNING_KEY = "real-upstream-signing-key-1234567890abcdef";

describe("turn-scoped Ian Brain relay", () => {
  it("publishes only the reviewed safe catalog and keeps the real bearer only in the server-side fetch", async () => {
    const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string>).authorization;
      expect(authorization).toMatch(/^Bearer omb1\./);
      expect(authorization).not.toContain(SIGNING_KEY);
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          tools: [
            { name: "knowledge_search" },
            { name: "memory_recall" },
            { name: "actions_shell_run" },
            { name: "files_read" },
            { name: "projects_call" },
            { name: "creds_get" },
            { name: "mcp_ian_brain_creds_rotate" },
          ],
        },
      }), { headers: { "content-type": "application/json", "mcp-session-id": "session-a" } });
    }) as typeof fetch;

    const result = await relayIanBrainMcp({
      url: "https://mcp.iansalways.com/mcp",
      key: SIGNING_KEY,
      ...TURN_IDENTITY,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    }, upstream);
    const text = Buffer.from(result.bytes).toString("utf8");
    expect(JSON.parse(text).result.tools).toEqual([{ name: "memory_recall" }]);
    expect(text).not.toContain(SIGNING_KEY);
    expect(result.transportSessionId).toMatch(/^ombs1\./);
    expect(result.transportSessionId).not.toContain("session-a");
    expect(result.upstreamTransportSessionId).toBe("session-a");
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("pins a closed safe set and rejects dangerous or future tool names", () => {
    expect(IAN_BRAIN_BOT_SAFE_TOOL_NAMES).toHaveLength(27);
    for (const name of [
      "memory_recall",
      "wiki_append",
      "timeline_append",
      "machines_host_list",
    ]) expect(ianBrainBotToolAllowed(name)).toBe(true);
    for (const name of [
      "creds_token_get",
      "actions_shell_run",
      "actions_github_run",
      "actions_workspace_run",
      "machines_command_exec",
      "machines_file_copy",
      "machines_log_tail",
      "files_read",
      "files_write",
      "files_wiki_ingest",
      "wiki_read_all",
      "projects_call",
      "memory_forget",
      "timeline_tombstone",
      "world_model_correct",
      "Memory_Recall",
      "memory_recall_extra",
      "future_tool_added_upstream",
    ]) expect(ianBrainBotToolAllowed(name)).toBe(false);
  });

  it("matches the independently verified Ian Brain bearer protocol vector", () => {
    expect(issueIanBrainOpenMausBearer(
      "ed675252bfd6641991a0fa5b327d70f05cd7d25b9105c6db179c1460cff4f354",
      "bot-alpha",
      "generation_1234567890abcdef",
      1_760_000_000_000,
    )).toBe("omb1.eyJhdWQiOiJpYW4tYnJhaW4iLCJzdWIiOiJib3QtYWxwaGEiLCJpYXQiOjE3NjAwMDAwMDAsImV4cCI6MTc2MDAwMDEyMCwianRpIjoiZ2VuZXJhdGlvbl8xMjM0NTY3ODkwYWJjZGVmIn0.itxsWyZ0d94yDguo01V2Vq4ZLeOqIQOKH27Yj7xK1Fs");
  });

  it("denies credential dispatch before the upstream sees it", async () => {
    const upstream = vi.fn() as unknown as typeof fetch;
    const body = {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "creds_export", arguments: {} },
    };
    expect(ianBrainRequestCallsCredentialTool(body)).toBe(true);
    expect(ianBrainRequestCallsUnsafeTool(body)).toBe(true);
    const result = await relayIanBrainMcp({
      url: "https://mcp.iansalways.com/mcp",
      key: SIGNING_KEY,
      ...TURN_IDENTITY,
      body,
    }, upstream);
    expect(upstream).not.toHaveBeenCalled();
    expect(JSON.parse(Buffer.from(result.bytes).toString("utf8"))).toMatchObject({
      id: 7,
      error: { code: -32601 },
    });
  });

  it.each([
    ["actions_shell_run", { command: "env" }],
    ["actions_github_run", { args: ["auth", "token"] }],
    ["actions_workspace_run", { command: "auth" }],
    ["machines_command_exec", { host: "desktop2", command: "cat /proc/self/environ" }],
    ["machines_file_copy", { source: "/proc/self/environ", destination: "/tmp/out" }],
    ["machines_log_tail", { host: "desktop2", path: "/proc/self/environ" }],
    ["files_read", { path: "/proc/self/environ" }],
    ["files_write", { path: "/tmp/x", content: "x" }],
    ["files_wiki_ingest", { path: "/proc/self/environ" }],
    ["wiki_read_all", {}],
    ["projects_call", { name: "work__read_secret", args: {} }],
    ["future_tool_added_upstream", {}],
  ])("denies %s before the upstream sees an indirect credential attempt", async (name, args) => {
    const upstream = vi.fn() as unknown as typeof fetch;
    const result = await relayIanBrainMcp({
      url: "https://mcp.iansalways.com/mcp",
      key: SIGNING_KEY,
      ...TURN_IDENTITY,
      body: { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } },
    }, upstream);
    expect(upstream).not.toHaveBeenCalled();
    expect(JSON.parse(Buffer.from(result.bytes).toString("utf8"))).toMatchObject({
      id: 9,
      error: { code: -32601 },
    });
  });

  it("forwards an allow-listed knowledge call without exposing the upstream bearer", async () => {
    const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string>).authorization;
      expect(authorization).toMatch(/^Bearer omb1\./);
      expect(authorization).not.toContain(SIGNING_KEY);
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        result: { content: [{ type: "text", text: "safe result" }] },
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const result = await relayIanBrainMcp({
      url: "https://mcp.iansalways.com/mcp",
      key: SIGNING_KEY,
      ...TURN_IDENTITY,
      body: { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "memory_recall", arguments: { query: "GPU Cats" } } },
    }, upstream);
    expect(upstream).toHaveBeenCalledTimes(1);
    const text = Buffer.from(result.bytes).toString("utf8");
    expect(text).toContain("safe result");
    expect(text).not.toContain(SIGNING_KEY);
  });

  it("rejects every unreviewed MCP method and malformed envelope before upstream", async () => {
    const upstream = vi.fn() as unknown as typeof fetch;
    for (const body of [
      { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "file:///proc/self/environ" } },
      { jsonrpc: "2.0", id: 2, method: "prompts/get", params: { name: "credential-dump" } },
      { jsonrpc: "2.0", id: 3, method: "creds/export", params: {} },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "memory_recall", arguments: [], smuggled: true } },
      { jsonrpc: "1.0", id: 5, method: "tools/list" },
      [],
      [null, { jsonrpc: "2.0", id: 6, method: "tools/list" }],
    ]) {
      expect(ianBrainRequestAllowed(body)).toBe(false);
      const result = await relayIanBrainMcp({
        url: "https://mcp.iansalways.com/mcp",
        key: SIGNING_KEY,
        ...TURN_IDENTITY,
        body,
      }, upstream);
      expect(result.status).toBe(200);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects an entire mixed batch before any safe sibling can partially execute", async () => {
    const upstream = vi.fn() as unknown as typeof fetch;
    const body = [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_recall", arguments: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "actions_shell_run", arguments: { command: "env" } } },
      { jsonrpc: "2.0", id: 3, method: "ping" },
    ];
    const result = await relayIanBrainMcp({
      url: "https://mcp.iansalways.com/mcp",
      key: SIGNING_KEY,
      ...TURN_IDENTITY,
      body,
    }, upstream);
    expect(upstream).not.toHaveBeenCalled();
    expect(JSON.parse(Buffer.from(result.bytes).toString("utf8"))).toEqual([
      expect.objectContaining({ id: 1, error: expect.objectContaining({ code: -32000 }) }),
      expect.objectContaining({ id: 2, error: expect.objectContaining({ code: -32601 }) }),
      expect.objectContaining({ id: 3, error: expect.objectContaining({ code: -32000 }) }),
    ]);
  });

  it("filters Streamable HTTP SSE catalogs and drops every uninspected metadata field", () => {
    const bytes = filterIanBrainMcpBytes(
      "text/event-stream",
      Buffer.from(': secret-comment\nevent: secret-event\nid: secret-id\nretry: 1234\ndata: {"jsonrpc":"2.0","result":{"tools":[{"name":"memory_recall"},{"name":"files_read"},{"name":"creds_read"}]}}\n\n'),
    );
    const text = Buffer.from(bytes).toString("utf8");
    expect(text).toContain("memory_recall");
    expect(text).not.toContain("files_read");
    expect(text).not.toContain("creds_read");
    expect(text).not.toContain("secret-comment");
    expect(text).not.toContain("secret-event");
    expect(text).not.toContain("secret-id");
    expect(text).not.toContain("retry:");
  });

  it("rejects compact responses that exceed the JSON depth or node budget", () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 60; depth += 1) nested = [nested];
    const tooDeep = Buffer.from(filterIanBrainMcpBytes(
      "application/json",
      Buffer.from(JSON.stringify(nested)),
    )).toString("utf8");
    expect(tooDeep).toContain("overly complex");

    const tooManyNodes = Buffer.from(filterIanBrainMcpBytes(
      "application/json",
      Buffer.from(JSON.stringify(Array.from({ length: 50_001 }, () => null))),
    )).toString("utf8");
    expect(tooManyNodes).toContain("overly complex");
  });

  it("binds an opaque transport session to the exact bot generation", async () => {
    let expectedUpstreamSession: string | undefined;
    const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      if (expectedUpstreamSession) expect(headers["mcp-session-id"]).toBe(expectedUpstreamSession);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
        headers: { "content-type": "application/json", "mcp-session-id": "upstream-session-a" },
      });
    }) as typeof fetch;
    const initialized = await relayIanBrainMcp({
      url: "https://mcp.iansalways.com/mcp", key: SIGNING_KEY, ...TURN_IDENTITY,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    }, upstream);
    const clientSession = initialized.transportSessionId!;
    expect(clientSession).toMatch(/^ombs1\./);
    expect(validateIanBrainTransportSession(SIGNING_KEY, TURN_IDENTITY.botId, TURN_IDENTITY.generation, clientSession)).toBe(true);
    expect(validateIanBrainTransportSession(SIGNING_KEY, "bot-beta", TURN_IDENTITY.generation, clientSession)).toBe(false);
    expectedUpstreamSession = "upstream-session-a";
    await relayIanBrainMcp({
      url: "https://mcp.iansalways.com/mcp", key: SIGNING_KEY, ...TURN_IDENTITY,
      transportSessionId: clientSession,
      body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    }, upstream);
    await expect(relayIanBrainMcp({
      url: "https://mcp.iansalways.com/mcp", key: SIGNING_KEY,
      botId: "bot-beta", generation: TURN_IDENTITY.generation,
      transportSessionId: clientSession,
      body: { jsonrpc: "2.0", id: 3, method: "tools/list" },
    }, upstream)).rejects.toThrow(/different turn/);
    await expect(relayIanBrainMcp({
      url: "https://mcp.iansalways.com/mcp", key: SIGNING_KEY,
      botId: TURN_IDENTITY.botId, generation: "generation_abcdef1234567890",
      transportSessionId: clientSession,
      body: { jsonrpc: "2.0", id: 4, method: "tools/list" },
    }, upstream)).rejects.toThrow(/different turn/);
  });

  it("terminates only the exact signed upstream transport session", async () => {
    const initializeUpstream = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
      headers: { "content-type": "application/json", "mcp-session-id": "upstream-delete-a" },
    })) as typeof fetch;
    const initialized = await relayIanBrainMcp({
      url: "https://mcp.iansalways.com/mcp", key: SIGNING_KEY, ...TURN_IDENTITY,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    }, initializeUpstream);
    const deleteUpstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("DELETE");
      expect((init?.headers as Record<string, string>)["mcp-session-id"]).toBe("upstream-delete-a");
      expect((init?.headers as Record<string, string>).authorization).toMatch(/^Bearer omb1\./);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const deleted = await relayIanBrainSessionDelete({
      url: "https://mcp.iansalways.com/mcp", key: SIGNING_KEY, ...TURN_IDENTITY,
      transportSessionId: initialized.transportSessionId!,
    }, deleteUpstream);
    expect(deleted.status).toBe(204);
    expect(deleteUpstream).toHaveBeenCalledTimes(1);
    await expect(relayIanBrainSessionDelete({
      url: "https://mcp.iansalways.com/mcp", key: SIGNING_KEY,
      botId: "bot-beta", generation: TURN_IDENTITY.generation,
      transportSessionId: initialized.transportSessionId!,
    }, deleteUpstream)).rejects.toThrow(/different turn/);
    expect(deleteUpstream).toHaveBeenCalledTimes(1);
  });

  it("rejects non-canonical upstream authorities", async () => {
    await expect(relayIanBrainMcp({
      url: "http://127.0.0.1:15050@evil.invalid/mcp",
      key: "secret",
      ...TURN_IDENTITY,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    })).rejects.toThrow(/canonical/);
  });

  it("aborts an in-flight upstream request when the owning turn is revoked", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      receivedSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error("missing abort signal"));
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;
    const pending = relayIanBrainMcp({
      url: "https://mcp.iansalways.com/mcp",
      key: SIGNING_KEY,
      ...TURN_IDENTITY,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      signal: controller.signal,
    }, upstream);

    controller.abort(new Error("turn authority revoked"));

    await expect(pending).rejects.toThrow("turn authority revoked");
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("rejects an oversized declared response before retaining its body", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(Buffer.from("{}"));
        controller.close();
      },
      cancel: cancelled,
    });
    const upstream = vi.fn(async () => new Response(body, {
      headers: {
        "content-type": "application/json",
        "content-length": String(IAN_BRAIN_MAX_RESPONSE_BYTES + 1),
      },
    })) as typeof fetch;

    await expect(relayIanBrainMcp({
      url: "https://mcp.iansalways.com/mcp",
      key: SIGNING_KEY,
      ...TURN_IDENTITY,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    }, upstream)).rejects.toMatchObject({ status: 502 });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("stops an unframed streaming response at the byte ceiling", async () => {
    const cancelled = vi.fn();
    const chunk = Buffer.alloc(Math.floor(IAN_BRAIN_MAX_RESPONSE_BYTES / 2) + 1, 0x20);
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted += 1;
        controller.enqueue(chunk);
        if (emitted === 3) controller.close();
      },
      cancel: cancelled,
    });
    const upstream = vi.fn(async () => new Response(body, {
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;

    await expect(relayIanBrainMcp({
      url: "https://mcp.iansalways.com/mcp",
      key: SIGNING_KEY,
      ...TURN_IDENTITY,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    }, upstream)).rejects.toMatchObject({ status: 502 });
    expect(cancelled).toHaveBeenCalledTimes(1);
    // WHATWG streams may prefetch one chunk, but cancellation happens as soon
    // as the reader observes that retaining the second chunk would cross the
    // ceiling; it never drains the producer to completion.
    expect(emitted).toBeLessThanOrEqual(3);
  });
});
