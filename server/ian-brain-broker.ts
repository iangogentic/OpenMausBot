import { createHmac, timingSafeEqual } from "node:crypto";

const CREDENTIAL_TOOL = /^(?:mcp_ian_brain_)?creds_/i;

/**
 * The bot-facing Ian Brain surface is an allow-list, not "everything except
 * creds_*". Several otherwise innocently named tools can recover the same
 * secrets indirectly (for example shell env, arbitrary file reads, remote
 * commands, `gh auth token`, or a federated downstream call). Keep this list
 * in lockstep with Ian Brain's dedicated OpenMaus capability.
 *
 * These are the complete non-credential tools from the 0.5.0 Ian Brain act
 * catalog after removing every arbitrary command/file/downstream escape. The
 * remaining mutation tools change Ian's own knowledge model but cannot invoke
 * a host command or read an arbitrary path.
 */
export const IAN_BRAIN_BOT_SAFE_TOOL_NAMES = Object.freeze([
  "machines_access_guide",
  "machines_host_list",
  "projects_list",
  "projects_search",
  "projects_schema",
  "memory_recall",
  "memory_retain",
  "memory_reflect",
  "files_search",
  "wiki_index",
  "files_neighbors",
  "wiki_append",
  "graph_query",
  "graph_path",
  "graph_explain",
  "ian_context_brief",
  "timeline_query",
  "world_model_query",
  "priority_list",
  "work_item_list",
  "permission_list",
  "permission_check",
  "observation_health",
  "timeline_append",
  "world_model_upsert",
  "work_item_upsert",
  "context_store_stats",
] as const);

const IAN_BRAIN_BOT_SAFE_TOOLS: ReadonlySet<string> = new Set(IAN_BRAIN_BOT_SAFE_TOOL_NAMES);
const IAN_BRAIN_BOT_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "memory_retain",
  "wiki_append",
  "timeline_append",
  "world_model_upsert",
  "work_item_upsert",
]);

const IAN_BRAIN_OPENMAUS_BEARER_TTL_SECONDS = 120;
const IAN_BRAIN_SESSION_ID = /^[A-Za-z0-9._~-]{1,256}$/;
const IAN_BRAIN_SESSION_ENVELOPE = /^ombs1\.([A-Za-z0-9_-]{1,768})\.([A-Za-z0-9_-]{43})$/;
const IAN_BRAIN_ALLOWED_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "tools/call",
]);

export const IAN_BRAIN_MAX_RESPONSE_BYTES = 1_048_576;
const IAN_BRAIN_MAX_JSON_DEPTH = 48;
const IAN_BRAIN_MAX_JSON_NODES = 50_000;

export interface IanBrainBrokerResult {
  status: number;
  contentType: string;
  transportSessionId?: string;
  /** Trusted-server cleanup handle. Never serialize this value to a provider
   * child; the child receives only transportSessionId's signed envelope. */
  upstreamTransportSessionId?: string;
  bytes: Uint8Array;
}

export function ianBrainCredentialTool(name: unknown): boolean {
  return typeof name === "string" && CREDENTIAL_TOOL.test(name);
}

export function ianBrainBotToolAllowed(name: unknown): name is string {
  // MCP tool names are case-sensitive. Do not normalize, strip prefixes, or
  // accept lookalikes: unknown/new upstream tools remain unavailable until a
  // reviewed release explicitly adds them.
  return typeof name === "string" && IAN_BRAIN_BOT_SAFE_TOOLS.has(name);
}

/** Mint the short-lived upstream bearer for one immutable bot generation.
 * The provider never receives this value; it keeps only the unrelated local
 * broker capability. Ian Brain maps `botId` to a distinct writer principal. */
export function issueIanBrainOpenMausBearer(
  signingKey: string,
  botId: string,
  generation: string,
  nowMs = Date.now(),
): string {
  if (Buffer.byteLength(signingKey, "utf8") < 32) throw new Error("Ian Brain OpenMaus signing key is too short");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(botId)) throw new Error("Ian Brain OpenMaus bot identity is invalid");
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(generation)) throw new Error("Ian Brain OpenMaus generation is invalid");
  const iat = Math.floor(nowMs / 1000);
  const payload = Buffer.from(JSON.stringify({
    aud: "ian-brain",
    sub: botId,
    iat,
    exp: iat + IAN_BRAIN_OPENMAUS_BEARER_TTL_SECONDS,
    jti: generation,
  })).toString("base64url");
  const signed = `omb1.${payload}`;
  const signature = createHmac("sha256", signingKey).update(signed).digest("base64url");
  return `${signed}.${signature}`;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requestMessages(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) return body.filter(plainRecord);
  return plainRecord(body) ? [body] : [];
}

function boundedJsonRpcId(value: unknown): boolean {
  return value === null ||
    (typeof value === "string" && value.length <= 256) ||
    (typeof value === "number" && Number.isSafeInteger(value));
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedOptionalString(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= max);
}

/** Closed Streamable HTTP MCP request surface. Unknown methods and malformed
 * envelopes never reach Ian Brain, including future resources/prompts/custom
 * methods that might expose a credential through a differently named route. */
export function ianBrainRequestAllowed(body: unknown): boolean {
  const messages = requestMessages(body);
  if (!messages.length || (Array.isArray(body) && messages.length !== body.length)) return false;
  return messages.every((message) => {
    if (!onlyKeys(message, ["jsonrpc", "id", "method", "params"]) || message.jsonrpc !== "2.0") return false;
    if (typeof message.method !== "string" || !IAN_BRAIN_ALLOWED_METHODS.has(message.method)) return false;
    if (Object.hasOwn(message, "id") && !boundedJsonRpcId(message.id)) return false;
    const params = message.params;
    if (params !== undefined && !plainRecord(params)) return false;
    if (message.method === "notifications/initialized") {
      return !Object.hasOwn(message, "id") && (!params || Object.keys(params).length === 0);
    }
    if (!Object.hasOwn(message, "id")) return false;
    if (message.method === "ping") return !params || Object.keys(params).length === 0;
    if (message.method === "tools/list") {
      return !params || (
        onlyKeys(params, ["cursor"]) &&
        boundedOptionalString(params.cursor, 512)
      );
    }
    if (message.method === "tools/call") {
      return Boolean(
        params &&
        onlyKeys(params, ["name", "arguments"]) &&
        ianBrainBotToolAllowed(params.name) &&
        (params.arguments === undefined || plainRecord(params.arguments)),
      );
    }
    if (message.method === "initialize") {
      if (!params || !onlyKeys(params, ["protocolVersion", "capabilities", "clientInfo"])) return false;
      const clientInfo = params.clientInfo;
      return typeof params.protocolVersion === "string" && params.protocolVersion.length <= 64 &&
        plainRecord(params.capabilities) &&
        plainRecord(clientInfo) &&
        onlyKeys(clientInfo, ["name", "title", "version"]) &&
        typeof clientInfo.name === "string" && clientInfo.name.length > 0 && clientInfo.name.length <= 160 &&
        boundedOptionalString(clientInfo.title, 160) &&
        typeof clientInfo.version === "string" && clientInfo.version.length <= 80;
    }
    return false;
  });
}

export function ianBrainRequestCallsCredentialTool(body: unknown): boolean {
  return requestMessages(body).some((message) => {
    if (message.method !== "tools/call") return false;
    const params = message.params;
    return Boolean(params && typeof params === "object" && ianBrainCredentialTool((params as any).name));
  });
}

export function ianBrainRequestCallsUnsafeTool(body: unknown): boolean {
  return !ianBrainRequestAllowed(body);
}

export function ianBrainRequestMutationNames(body: unknown): string[] {
  return requestMessages(body).flatMap((message) => {
    if (message.method !== "tools/call" || !message.params || typeof message.params !== "object") return [];
    const name = (message.params as any).name;
    return typeof name === "string" && IAN_BRAIN_BOT_MUTATING_TOOLS.has(name) ? [name] : [];
  });
}

function filterMessage(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const message = value as Record<string, any>;
  const tools = message.result?.tools;
  if (!Array.isArray(tools)) return value;
  return {
    ...message,
    result: {
      ...message.result,
      tools: tools.filter((tool: any) => ianBrainBotToolAllowed(tool?.name)),
    },
  };
}

function redactIanBrainText(text: string, sensitiveValues: readonly string[]): string {
  let output = text;
  for (const value of sensitiveValues) {
    if (value && output.includes(value)) output = output.split(value).join("[REDACTED]");
  }
  return output
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/\b(authorization|proxy-authorization)\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\s,;"'}\]]+/gi, "$1: [REDACTED]")
    .replace(/\b(api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|credential|oauth[ _-]?secret|pass(?:word|wd)?|private[ _-]?key|secret|session[ _-]?token)\s*(?:is|[:=])\s*["']?[^\s,;"'}\]]+/gi, "$1: [REDACTED]")
    .replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\b[A-Za-z0-9+/_-]{48,}={0,2}\b/g, "[REDACTED]");
}

function redactMcpValue(value: unknown, sensitiveValues: readonly string[]): unknown {
  if (typeof value === "string") return redactIanBrainText(value, sensitiveValues);
  if (Array.isArray(value)) return value.map((item) => redactMcpValue(item, sensitiveValues));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    /(?:token|secret|password|credential|authorization|api_?key)/i.test(key)
      ? "[REDACTED]"
      : redactMcpValue(child, sensitiveValues),
  ]));
}

/** Bound recursive filtering work independently of the byte cap. A compact
 * JSON document can still contain tens of thousands of nested arrays and
 * exhaust the trusted server's stack while it redacts an otherwise valid
 * one-megabyte response. */
function ianBrainShapeWithinBudget(value: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > IAN_BRAIN_MAX_JSON_NODES || current.depth > IAN_BRAIN_MAX_JSON_DEPTH) return false;
    if (!current.value || typeof current.value !== "object") continue;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
  }
  return true;
}

export function filterIanBrainMcpBytes(
  contentType: string,
  bytes: Uint8Array,
  sensitiveValues: readonly string[] = [],
): Uint8Array {
  const text = Buffer.from(bytes).toString("utf8");
  if (/application\/json/i.test(contentType)) {
    try {
      const parsed = JSON.parse(text);
      if (!ianBrainShapeWithinBudget(parsed)) {
        return Buffer.from(JSON.stringify({ error: "Ian Brain returned an overly complex MCP response" }));
      }
      const filtered = Array.isArray(parsed) ? parsed.map(filterMessage) : filterMessage(parsed);
      return Buffer.from(JSON.stringify(redactMcpValue(filtered, sensitiveValues)));
    } catch {
      // A malformed tools/list response must not leak an uninspected catalog.
      return Buffer.from(JSON.stringify({ error: "Ian Brain returned an invalid MCP response" }));
    }
  }
  if (/text\/event-stream/i.test(contentType)) {
    // Re-emit only inspected JSON data. SSE comments, event names, ids, and
    // retry fields are not part of MCP's JSON-RPC value and therefore have no
    // reason to cross this credential boundary.
    const output: string[] = [];
    for (const event of text.split(/\r?\n\r?\n/)) {
      const raw = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (!ianBrainShapeWithinBudget(parsed)) {
          output.push("data: {\"error\":\"Ian Brain returned an overly complex MCP event\"}\n\n");
          continue;
        }
        const filtered = Array.isArray(parsed) ? parsed.map(filterMessage) : filterMessage(parsed);
        output.push(`data: ${JSON.stringify(redactMcpValue(filtered, sensitiveValues))}\n\n`);
      } catch {
        output.push("data: {\"error\":\"Ian Brain returned an invalid MCP event\"}\n\n");
      }
    }
    if (!output.length) {
      output.push("data: {\"error\":\"Ian Brain returned an invalid MCP event\"}\n\n");
    }
    return Buffer.from(output.join(""));
  }
  // Streamable HTTP MCP must be JSON or SSE. Fail closed on an unexpected
  // content type instead of passing an unfiltered credential catalog.
  return Buffer.from(JSON.stringify({ error: "Ian Brain returned an unsupported MCP response" }));
}

function encodeIanBrainTransportSession(
  signingKey: string,
  botId: string,
  generation: string,
  upstreamSessionId: string,
): string {
  if (!IAN_BRAIN_SESSION_ID.test(upstreamSessionId)) {
    throw new Error("Ian Brain transport session id is invalid");
  }
  const payload = Buffer.from(JSON.stringify({ b: botId, g: generation, s: upstreamSessionId })).toString("base64url");
  const signed = `ombs1.${payload}`;
  const signature = createHmac("sha256", signingKey).update(signed).digest("base64url");
  return `${signed}.${signature}`;
}

function decodeIanBrainTransportSession(
  signingKey: string,
  botId: string,
  generation: string,
  envelope: string,
): string {
  const match = IAN_BRAIN_SESSION_ENVELOPE.exec(envelope);
  if (!match) throw new Error("Ian Brain transport session id is invalid");
  const signed = `ombs1.${match[1]}`;
  const expected = Buffer.from(createHmac("sha256", signingKey).update(signed).digest("base64url"));
  const supplied = Buffer.from(match[2]);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new Error("Ian Brain transport session id is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Ian Brain transport session id is invalid");
  }
  if (!plainRecord(parsed) || parsed.b !== botId || parsed.g !== generation ||
      typeof parsed.s !== "string" || !IAN_BRAIN_SESSION_ID.test(parsed.s)) {
    throw new Error("Ian Brain transport session id belongs to a different turn");
  }
  return parsed.s;
}

export function validateIanBrainTransportSession(
  signingKey: string,
  botId: string,
  generation: string,
  envelope: string,
): boolean {
  try {
    decodeIanBrainTransportSession(signingKey, botId, generation, envelope);
    return true;
  } catch {
    return false;
  }
}

function canonicalIanBrainUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "mcp.iansalways.com" ||
    url.port ||
    url.pathname !== "/mcp" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) throw new Error("Ian Brain broker upstream is not canonical");
  return url;
}

function deniedToolResponse(body: unknown): Uint8Array {
  const messages = requestMessages(body);
  const responses = messages
    .filter((message) => Object.hasOwn(message, "id"))
    .map((message) => {
      const params = message.params;
      const denied = message.method === "tools/call"
        && (!params || typeof params !== "object" || !ianBrainBotToolAllowed((params as any).name));
      return {
        jsonrpc: "2.0",
        id: message.id ?? null,
        error: denied
          ? { code: -32601, message: "This Ian Brain tool is not available to bots" }
          : { code: -32000, message: "The MCP batch was rejected because it included an unavailable Ian Brain tool" },
      };
    });
  const fallback = {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32601, message: "This Ian Brain tool is not available to bots" },
  };
  return Buffer.from(JSON.stringify(Array.isArray(body) ? responses : (responses[0] ?? fallback)));
}

async function boundedResponseBytes(
  response: Response,
  maxBytes = IAN_BRAIN_MAX_RESPONSE_BYTES,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error("Ian Brain response exceeded the broker limit"), { status: 502 });
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.length) continue;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error("Ian Brain response exceeded the broker limit"), { status: 502 });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/** Relay one turn-scoped Streamable HTTP MCP request. The real upstream key
 * is used only in this server-side fetch and never appears in the result. */
export async function relayIanBrainMcp(
  input: {
    url: string;
    key: string;
    botId: string;
    generation: string;
    body: unknown;
    transportSessionId?: string;
    signal?: AbortSignal;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<IanBrainBrokerResult> {
  if (!ianBrainRequestAllowed(input.body)) {
    return {
      status: 200,
      contentType: "application/json",
      bytes: deniedToolResponse(input.body),
    };
  }
  const url = canonicalIanBrainUrl(input.url);
  if (!input.key) throw new Error("Ian Brain broker upstream is not canonical");

  const upstreamBearer = issueIanBrainOpenMausBearer(input.key, input.botId, input.generation);

  const headers: Record<string, string> = {
    authorization: `Bearer ${upstreamBearer}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (input.transportSessionId) {
    headers["mcp-session-id"] = decodeIanBrainTransportSession(
      input.key,
      input.botId,
      input.generation,
      input.transportSessionId,
    );
  }
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(input.body),
    redirect: "error",
    signal: input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000),
  });
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const bytes = await boundedResponseBytes(response);
  const filtered = filterIanBrainMcpBytes(contentType, bytes, [input.key, upstreamBearer]);
  if (filtered.byteLength > IAN_BRAIN_MAX_RESPONSE_BYTES) {
    throw Object.assign(new Error("Ian Brain response exceeded the broker limit after filtering"), { status: 502 });
  }
  const upstreamResponseSessionId = response.headers.get("mcp-session-id");
  if (upstreamResponseSessionId && !IAN_BRAIN_SESSION_ID.test(upstreamResponseSessionId)) {
    throw Object.assign(new Error("Ian Brain returned an invalid transport session id"), { status: 502 });
  }
  return {
    status: response.status,
    contentType: /application\/json|text\/event-stream/i.test(contentType)
      ? contentType
      : "application/json",
    ...(upstreamResponseSessionId
      ? { transportSessionId: encodeIanBrainTransportSession(
          input.key,
          input.botId,
          input.generation,
          upstreamResponseSessionId,
        ), upstreamTransportSessionId: upstreamResponseSessionId }
      : {}),
    bytes: filtered,
  };
}

/** Terminate one upstream Streamable HTTP session. The caller supplies the
 * provider-visible signed envelope; this function authenticates and unwraps
 * it for the exact bot generation before the canonical DELETE. */
export async function relayIanBrainSessionDelete(
  input: {
    url: string;
    key: string;
    botId: string;
    generation: string;
    transportSessionId: string;
    signal?: AbortSignal;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<IanBrainBrokerResult> {
  const url = canonicalIanBrainUrl(input.url);
  if (!input.key) throw new Error("Ian Brain broker upstream is not canonical");
  const upstreamSessionId = decodeIanBrainTransportSession(
    input.key,
    input.botId,
    input.generation,
    input.transportSessionId,
  );
  const upstreamBearer = issueIanBrainOpenMausBearer(input.key, input.botId, input.generation);
  const response = await fetchImpl(url, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${upstreamBearer}`,
      "mcp-session-id": upstreamSessionId,
      accept: "application/json",
    },
    redirect: "error",
    signal: input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000),
  });
  const contentType = response.headers.get("content-type") ?? "application/json";
  const bytes = await boundedResponseBytes(response, 65_536);
  return {
    status: response.status,
    contentType: /application\/json/i.test(contentType) ? contentType : "application/json",
    bytes: bytes.length
      ? filterIanBrainMcpBytes(contentType, bytes, [input.key, upstreamBearer, upstreamSessionId])
      : bytes,
  };
}
