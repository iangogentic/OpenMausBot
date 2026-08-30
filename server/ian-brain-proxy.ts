// Exact-turn Ian Brain MCP bridge for provider CLIs that only accept stdio
// MCP servers. The provider receives a harness-local URL and an opaque,
// turn-scoped capability; the upstream Ian Brain credential never leaves the
// trusted OpenMausBot server.
//
// stdout is the MCP transport. Never log there.
import { readBoundedResponseText } from "./bounded-response.ts";
import {
  assertBoundedJsonShape,
  BoundedJsonLineDecoder,
  PROVIDER_NDJSON_LIMITS,
} from "./drivers/bounded-json-lines.ts";

type Json = Record<string, unknown>;

const RAW_UPSTREAM = process.env.OMB_IAN_BRAIN_URL ?? "";
const TOKEN = process.env.OMB_IAN_BRAIN_CAPABILITY_TOKEN ?? "";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_IN_FLIGHT = 4;
const MAX_PENDING_OUTPUT_BYTES = 4 * 1024 * 1024;
const RELAY_TIMEOUT_MS = 10 * 60_000;

function checkedUpstream(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Ian Brain MCP URL is invalid");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1", "10.0.2.2"].includes(host) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/api/internal/ian-brain/mcp"
  ) throw new Error("Ian Brain MCP URL is outside the private harness boundary");
  return url.toString();
}

const UPSTREAM = checkedUpstream(RAW_UPSTREAM);
const HARNESS_HOST = `127.0.0.1:${new URL(UPSTREAM).port}`;
if (TOKEN.length < 32 || TOKEN.length > 1_024 || /[\s\0\r\n]/.test(TOKEN)) {
  throw new Error("Ian Brain MCP capability is invalid");
}

let upstreamSessionId = "";
let failed = false;
let inputEnded = false;
const active = new Set<AbortController>();
const inFlight = new Set<Promise<void>>();

function fail(error: unknown): void {
  if (failed) return;
  failed = true;
  for (const controller of active) controller.abort(error);
  active.clear();
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.stdin.destroy();
  process.exitCode = 1;
  const failsafe = setTimeout(() => process.exit(1), 1_000);
  failsafe.unref?.();
}

function send(message: Json): void {
  if (failed) return;
  const line = `${JSON.stringify(message)}\n`;
  const bytes = Buffer.byteLength(line);
  if (
    bytes > PROVIDER_NDJSON_LIMITS.maxLineBytes ||
    process.stdout.writableLength + bytes > MAX_PENDING_OUTPUT_BYTES
  ) return fail(new Error("Ian Brain proxy output exceeded its buffer limit"));
  process.stdout.write(line);
}

function rpcError(id: unknown, message: string): Json {
  return { jsonrpc: "2.0", id, error: { code: -32000, message } };
}

async function parseUpstream(response: Response, expectedId: unknown): Promise<Json | null> {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("text/event-stream")) {
    const text = await readBoundedResponseText(
      response,
      MAX_RESPONSE_BYTES,
      "Ian Brain response exceeded 2 MB",
    );
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
        const message = frame.value as Json;
        last = message;
        if (message.id === expectedId) matching = message;
      }
    }
    for (const frame of decoder.flush()) {
      if (!frame.value || typeof frame.value !== "object" || Array.isArray(frame.value)) continue;
      const message = frame.value as Json;
      last = message;
      if (message.id === expectedId) matching = message;
    }
    return matching ?? last;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function relay(message: Json): Promise<Json | null> {
  const controller = new AbortController();
  active.add(controller);
  try {
    const response = await fetch(UPSTREAM, {
      method: "POST",
      redirect: "error",
      headers: {
        host: HARNESS_HOST,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TOKEN}`,
        ...(upstreamSessionId ? { "mcp-session-id": upstreamSessionId } : {}),
      },
      body: JSON.stringify(message),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(RELAY_TIMEOUT_MS)]),
    });
    const nextSession = response.headers.get("mcp-session-id");
    if (nextSession) upstreamSessionId = nextSession;
    if (!response.ok) {
      const body = await readBoundedResponseText(
        response,
        8 * 1024,
        "Ian Brain broker rejection exceeded 8 KB",
      ).catch(() => "");
      const category = body.includes("loopback host required")
        ? "loopback Host rejected"
        : body.includes("cross-origin request")
          ? "origin rejected"
          : body.includes("invalid_token") || body.includes("Invalid or expired token")
            ? "upstream bearer rejected"
            : body.includes("scoped Ian Brain turn")
              ? "turn scope rejected"
              : "request rejected";
      throw new Error(`Ian Brain broker returned HTTP ${response.status} (${category})`);
    }
    return parseUpstream(response, message.id);
  } finally {
    active.delete(controller);
  }
}

async function handle(message: Json): Promise<void> {
  const response = await relay(message);
  if (response && message.id !== undefined) send(response);
}

function dispatch(message: Json): void {
  if (failed) return;
  if (inFlight.size >= MAX_IN_FLIGHT) return fail(new Error("Ian Brain proxy exceeded 4 concurrent requests"));
  const task = handle(message).catch((error) => {
    if (message.id !== undefined) send(rpcError(message.id, error instanceof Error ? error.message : String(error)));
  });
  inFlight.add(task);
  void task.finally(() => inFlight.delete(task));
}

async function closeUpstream(): Promise<void> {
  if (!upstreamSessionId) return;
  const session = upstreamSessionId;
  upstreamSessionId = "";
  await fetch(UPSTREAM, {
    method: "DELETE",
    redirect: "error",
    headers: {
      host: HARNESS_HOST,
      authorization: `Bearer ${TOKEN}`,
      "mcp-session-id": session,
    },
    signal: AbortSignal.timeout(2_000),
  }).then((response) => response.body?.cancel()).catch(() => {});
}

const input = new BoundedJsonLineDecoder(PROVIDER_NDJSON_LIMITS);
process.stdin.on("data", (chunk: Buffer) => {
  if (inputEnded || failed) return;
  try {
    for (const { value } of input.push(chunk)) {
      if (value && typeof value === "object" && !Array.isArray(value)) dispatch(value as Json);
    }
  } catch (error) {
    fail(error);
  }
});
process.stdin.on("end", () => {
  inputEnded = true;
  try {
    for (const { value } of input.flush()) {
      if (value && typeof value === "object" && !Array.isArray(value)) dispatch(value as Json);
    }
  } catch (error) {
    fail(error);
    return;
  }
  void Promise.allSettled([...inFlight]).then(closeUpstream).then(() => {
    if (!failed) process.exitCode = 0;
  });
});
