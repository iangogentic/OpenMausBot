// Harness-owned Composio MCP bridge.
//
// Provider CLIs only see this stdio server. Ordinary MCP traffic is relayed
// to the configured Composio Session, but connection requests are converted
// into first-class OpenMausBot chat cards. The agent never authors an auth
// URL and credentials never pass through its transcript.
//
// stdout is the MCP transport. Never log there.
import { randomUUID } from "node:crypto";

import { readBoundedResponseText } from "./bounded-response.ts";
import {
  assertBoundedJsonShape,
  BoundedJsonLineDecoder,
  CATALOG_NDJSON_LIMITS,
  PROVIDER_NDJSON_LIMITS,
} from "./drivers/bounded-json-lines.ts";

type Json = Record<string, unknown>;

const UPSTREAM = process.env.OMB_CONNECTOR_UPSTREAM_URL ?? "";
const HARNESS = process.env.OMB_HARNESS_URL ?? "http://127.0.0.1:8799";
// Codex flattens stdio MCP env maps into one child environment, so this must
// not share a variable name with the peer-agent capability.
const TOKEN = process.env.OMB_CONNECTOR_CAPABILITY_TOKEN ?? "";
const MAX_RESPONSE_BYTES = 1536 * 1024;
const INITIALIZE_RELAY_TIMEOUT_MS = 1_000;
const RELAY_TIMEOUT_MS = 10 * 60_000;

function parsedHeaders(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(process.env.OMB_CONNECTOR_UPSTREAM_HEADERS ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

const upstreamHeaders = parsedHeaders();
let upstreamSessionId = "";
const MAX_IN_FLIGHT = 4;
const MAX_PENDING_OUTPUT_BYTES = 4 * 1024 * 1024;
const activeRequests = new Set<AbortController>();
let proxyFailed = false;
const failProxy = (error: unknown) => {
  if (proxyFailed) return;
  proxyFailed = true;
  for (const controller of activeRequests) controller.abort(error);
  activeRequests.clear();
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.stdin.destroy();
  process.exitCode = 1;
  const failsafe = setTimeout(() => process.exit(1), 1_000);
  failsafe.unref?.();
};
const send = (message: Json) => {
  if (proxyFailed) return;
  const line = `${JSON.stringify(message)}\n`;
  const bytes = Buffer.byteLength(line);
  if (
    bytes > PROVIDER_NDJSON_LIMITS.maxLineBytes ||
    process.stdout.writableLength + bytes > MAX_PENDING_OUTPUT_BYTES
  ) return failProxy(new Error("connector proxy output exceeded its buffer limit"));
  process.stdout.write(line);
};

function textResult(id: unknown, text: string, isError = false): Json {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } };
}

function jsonRpcError(id: unknown, message: string): Json {
  return { jsonrpc: "2.0", id, error: { code: -32000, message } };
}

function initializeResult(id: unknown, protocolVersion: unknown): Json {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: typeof protocolVersion === "string" && protocolVersion ? protocolVersion : "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "openmausbot-connectors", version: "1" },
    },
  };
}

async function parseUpstream(response: Response, id: unknown): Promise<Json | null> {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("text/event-stream")) {
    const text = await readBoundedResponseText(response, MAX_RESPONSE_BYTES, "connector response exceeded 1536 KB");
    if (!text.trim()) return null;
    const parsed: unknown = JSON.parse(text);
    assertBoundedJsonShape(parsed, PROVIDER_NDJSON_LIMITS);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Json : null;
  }

  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new BoundedJsonLineDecoder(
    { ...PROVIDER_NDJSON_LIMITS, maxTotalBytes: MAX_RESPONSE_BYTES },
    { jsonPrefix: "data:", ignoredJsonPayloads: ["[DONE]"] },
  );
  let last: Json | null = null;
  let matching: Json | null = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of decoder.push(value)) {
        if (!frame.value || typeof frame.value !== "object" || Array.isArray(frame.value)) continue;
        const parsed = frame.value as Json;
        last = parsed;
        if (parsed.id === id) matching = parsed;
      }
    }
    for (const frame of decoder.flush()) {
      if (!frame.value || typeof frame.value !== "object" || Array.isArray(frame.value)) continue;
      const parsed = frame.value as Json;
      last = parsed;
      if (parsed.id === id) matching = parsed;
    }
    return matching ?? last;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function relay(message: Json, timeoutMs = RELAY_TIMEOUT_MS): Promise<Json | null> {
  if (!UPSTREAM) throw new Error("connected apps are unavailable");
  const controller = new AbortController();
  activeRequests.add(controller);
  try {
    const response = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...upstreamHeaders,
        ...(upstreamSessionId ? { "mcp-session-id": upstreamSessionId } : {}),
      },
      body: JSON.stringify(message),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
    });
    const nextSession = response.headers.get("mcp-session-id");
    if (nextSession) upstreamSessionId = nextSession;
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`connector service returned HTTP ${response.status}`);
    }
    return await parseUpstream(response, message.id);
  } finally {
    activeRequests.delete(controller);
  }
}

function connectorAdds(args: unknown): string[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const toolkits = (args as { toolkits?: unknown }).toolkits;
  if (!Array.isArray(toolkits)) return [];
  return [...new Set(toolkits.flatMap((item) => {
    if (typeof item === "string") return [item.toLowerCase()];
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as { name?: unknown; toolkit?: unknown; action?: unknown };
    const slug = typeof row.toolkit === "string" ? row.toolkit : row.name;
    const action = String(row.action ?? "add").toLowerCase();
    return typeof slug === "string" && ["add", "connect", "initiate"].includes(action) ? [slug.toLowerCase()] : [];
  }))];
}

async function showConnectorCards(slugs: string[]): Promise<void> {
  const controller = new AbortController();
  activeRequests.add(controller);
  try {
    const response = await fetch(`${HARNESS}/api/internal/connectors/request`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ slugs, resumeKey: randomUUID() }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) {
      const text = await readBoundedResponseText(response, 1024 * 1024, "connector card response exceeded 1 MB");
      let body: { error?: unknown } = {};
      try {
        const parsed: unknown = text.trim() ? JSON.parse(text) : {};
        assertBoundedJsonShape(parsed, CATALOG_NDJSON_LIMITS);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as { error?: unknown };
      } catch {}
      throw new Error(String(body.error ?? `could not show connection card (HTTP ${response.status})`));
    }
    await response.body?.cancel().catch(() => {});
  } finally {
    activeRequests.delete(controller);
  }
}

async function handle(message: Json): Promise<void> {
  const id = message.id;
  const method = String(message.method ?? "");
  // OpenCode (and other MCP clients) mark a stdio server failed unless
  // initialize returns capabilities/serverInfo. Relaying that handshake to
  // Composio can time out, return a newer protocolVersion, or throw when the
  // upstream URL never reached the child env — all of which previously
  // surfaced as a tools/call-shaped {content,isError} payload.
  if (method === "notifications/initialized" || method === "initialized") {
    if (UPSTREAM) void relay(message).catch(() => {});
    return;
  }
  if (method === "initialize") {
    if (UPSTREAM) {
      try {
        // Capture the upstream session id when the service is healthy, but
        // never let a stalled provider prevent the local MCP client from
        // mounting the connector tools. The client sends initialized only
        // after this bounded attempt and the local initialize response.
        await relay(message, INITIALIZE_RELAY_TIMEOUT_MS);
      } catch {
        // Best-effort session setup. The client still needs a valid result.
      }
    }
    if (id !== undefined) {
      const params = (message.params ?? {}) as Json;
      send(initializeResult(id, params.protocolVersion));
    }
    return;
  }
  if (method === "tools/call") {
    const params = (message.params ?? {}) as Json;
    const name = String(params.name ?? "");
    const slugs = /MANAGE_CONNECTIONS$/i.test(name) ? connectorAdds(params.arguments) : [];
    if (slugs.length) {
      await showConnectorCards(slugs);
      send(textResult(
        id,
        `OpenMausBot showed the user a secure connection card for ${slugs.join(", ")}. End this turn now. The app will continue the task automatically after the connection finishes.`,
      ));
      return;
    }
    if (/WAIT_FOR_CONNECTIONS$/i.test(name)) {
      send(textResult(id, "OpenMausBot is handling connection completion and will continue the task automatically."));
      return;
    }
  }
  try {
    const response = await relay(message);
    if (response && id !== undefined) send(response);
  } catch (error) {
    if (id === undefined) return;
    const messageText = error instanceof Error ? error.message : String(error);
    if (method === "tools/call") send(textResult(id, messageText, true));
    else send(jsonRpcError(id, messageText));
  }
}

const input = new BoundedJsonLineDecoder(PROVIDER_NDJSON_LIMITS);
const inFlight = new Set<Promise<void>>();
let inputEnded = false;
const dispatch = (message: Json) => {
  if (proxyFailed) return;
  if (inFlight.size >= MAX_IN_FLIGHT) return failProxy(new Error("connector proxy exceeded 4 concurrent requests"));
  const task = handle(message).catch((error) => {
    if (message.id === undefined) return;
    const method = String(message.method ?? "");
    const messageText = error instanceof Error ? error.message : String(error);
    if (method === "tools/call") send(textResult(message.id, messageText, true));
    else send(jsonRpcError(message.id, messageText));
  });
  inFlight.add(task);
  void task.finally(() => inFlight.delete(task));
};
process.stdin.on("data", (chunk: Buffer) => {
  if (inputEnded || proxyFailed) return;
  try {
    for (const { value } of input.push(chunk)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      dispatch(value as Json);
    }
  } catch (error) {
    failProxy(error);
  }
});
process.stdin.on("end", () => {
  inputEnded = true;
  try {
    for (const { value } of input.flush()) {
      if (value && typeof value === "object" && !Array.isArray(value)) dispatch(value as Json);
    }
  } catch (error) {
    failProxy(error);
    return;
  }
  void Promise.allSettled([...inFlight]).then(() => { if (!proxyFailed) process.exitCode = 0; });
});
