import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

import type { InternalCapabilityBinding } from "./internal-capabilities.ts";

export const MODEL_RELAY_ROUTE = "/api/internal/model-relay";
export const MODEL_RELAY_OPENAI_PATH = `${MODEL_RELAY_ROUTE}/v1`;
export const MODEL_RELAY_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const MODEL_RELAY_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
export const MODEL_RELAY_REQUEST_LIMIT = 256;
export const MODEL_RELAY_CONCURRENCY_LIMIT = 4;
export const MODEL_RELAY_TURN_REQUEST_BYTES = 32 * 1024 * 1024;
/** A visual parent makes at least one additional model call after the
 * delegated operator returns its screen. Large existing chats can exceed the
 * ordinary aggregate even though each individual request remains bounded. */
export const MODEL_RELAY_COMPUTER_PARENT_TURN_REQUEST_BYTES = 128 * 1024 * 1024;
/** Visual children resend a growing screenshot conversation on each model
 * step. Their 32-action ceiling and 8 MiB per-request cap keep this bounded,
 * but the ordinary text-turn aggregate is too small for legitimate runs. */
export const MODEL_RELAY_COMPUTER_OPERATOR_TURN_REQUEST_BYTES = 512 * 1024 * 1024;
export const MODEL_RELAY_TURN_RESPONSE_BYTES = 256 * 1024 * 1024;
export const MODEL_RELAY_MAX_STREAM_FRAME_BYTES = 1024 * 1024;
export const MODEL_RELAY_TURN_STREAM_FRAMES = 32_768;
export const MODEL_RELAY_TOTAL_TIMEOUT_MS = 10 * 60_000;

const MODEL_ID = /^[\w][\w./:+-]*$/;
const HOST_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const POST_PATHS = new Set([
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/responses",
  "/v1/messages",
  "/v1/messages/count_tokens",
]);

export interface ModelRelayAuthority {
  readonly capabilityToken: string;
  readonly botId: string;
  readonly threadId: string;
  readonly generation: string;
  readonly hostId: string;
  readonly model: string;
  readonly upstreamBaseUrl: string;
  readonly upstreamApiKey: string;
}

export interface ModelRelayConnection {
  readonly openaiBaseUrl: string;
  readonly anthropicBaseUrl: string;
  readonly token: string;
  readonly host: string;
  readonly model: string;
}

export class ModelRelayError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ModelRelayError";
    this.status = status;
  }
}

function exactString(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function oneHeader(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/** Accept either OpenAI's bearer header or Anthropic's x-api-key dialect.
 * If a client supplies both, both must name the same exact capability. */
export function modelRelayAuthorization(headers: IncomingHttpHeaders): string | null {
  const authorization = oneHeader(headers.authorization);
  const apiKey = oneHeader(headers["x-api-key"]);
  if (headers.authorization !== undefined && authorization === null) return null;
  if (headers["x-api-key"] !== undefined && apiKey === null) return null;

  let bearer: string | null = null;
  if (authorization !== null) {
    if (!authorization.startsWith("Bearer ")) return null;
    bearer = authorization.slice("Bearer ".length);
    if (!bearer || bearer.trim() !== bearer) return null;
  }
  if (apiKey !== null) {
    if (!apiKey || apiKey.trim() !== apiKey) return null;
    if (bearer !== null && !exactString(bearer, apiKey)) return null;
    bearer = apiKey;
  }
  return bearer === null ? null : `Bearer ${bearer}`;
}

function privateModelHostIp(value: string): boolean {
  if (isIP(value) === 4) {
    const [a, b] = value.split(".").map(Number);
    return a === 127 || a === 10 || (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
  }
  if (isIP(value) === 6) {
    const normalized = value.toLowerCase();
    return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd");
  }
  return false;
}

/** Canonicalize one trusted local-model source. Catalog probing and turn
 * relaying share this exact rule: no DNS (therefore no rebinding), no public
 * or link-local metadata address, explicit port, and an OpenAI `/v1` base. */
export function normalizedPinnedModelBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("the local model host has an invalid base URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error("the local model host has an invalid base URL");
  }
  // The reviewed local-host table uses explicit loopback/tunnel addresses.
  // Never turn a long-lived model capability into a DNS-rebinding primitive;
  // a DNS deployment must resolve and pin its address before it enters here.
  const literalHost = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  if (!privateModelHostIp(literalHost) || !url.port) {
    throw new Error("the local model host must use a private literal, pinned IP address and explicit port");
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith("/v1")) throw new Error("the local model host base URL must end in /v1");
  url.pathname = pathname;
  return url.toString().replace(/\/$/, "");
}

export function createModelRelayAuthority(input: {
  binding: InternalCapabilityBinding;
  hostId: string;
  model: string;
  upstreamBaseUrl: string;
  upstreamApiKey: string;
}): ModelRelayAuthority {
  if (input.binding.kind !== "model") throw new Error("a model capability is required");
  if (!HOST_ID.test(input.hostId)) throw new Error("the local model host id is invalid");
  if (!MODEL_ID.test(input.model)) throw new Error("the local model id is invalid");
  if (!input.upstreamApiKey) throw new Error("the local model host key is required");
  return Object.freeze({
    capabilityToken: input.binding.token,
    botId: input.binding.botId,
    threadId: input.binding.threadId,
    generation: input.binding.generation,
    hostId: input.hostId,
    model: input.model,
    upstreamBaseUrl: normalizedPinnedModelBaseUrl(input.upstreamBaseUrl),
    upstreamApiKey: input.upstreamApiKey,
  });
}

export function modelRelayConnection(authority: ModelRelayAuthority, harnessBaseUrl: string): ModelRelayConnection {
  const harness = new URL(harnessBaseUrl);
  if (
    harness.protocol !== "http:" ||
    !["127.0.0.1", "10.0.2.2"].includes(harness.hostname) ||
    harness.username ||
    harness.password ||
    harness.search ||
    harness.hash
  ) throw new Error("the provider harness URL is not an approved local relay origin");
  const base = harness.toString().replace(/\/$/, "");
  return Object.freeze({
    openaiBaseUrl: `${base}${MODEL_RELAY_OPENAI_PATH}`,
    anthropicBaseUrl: `${base}${MODEL_RELAY_ROUTE}`,
    token: authority.capabilityToken,
    host: authority.hostId,
    model: authority.model,
  });
}

export function normalizedModelRelayCapabilityPath(path: string): string {
  return path === MODEL_RELAY_ROUTE || path.startsWith(`${MODEL_RELAY_ROUTE}/`)
    ? MODEL_RELAY_ROUTE
    : path;
}

function relaySuffix(path: string): string {
  if (!path.startsWith(`${MODEL_RELAY_ROUTE}/`)) throw new ModelRelayError(404, "unsupported local model route");
  const suffix = path.slice(MODEL_RELAY_ROUTE.length);
  if (suffix.includes("%2f") || suffix.includes("%2F") || suffix.includes("\\") || suffix.includes("..")) {
    throw new ModelRelayError(404, "unsupported local model route");
  }
  return suffix;
}

export function validateModelRelayRequest(input: {
  authority: ModelRelayAuthority;
  method: string;
  path: string;
  search?: string;
  body?: Buffer;
}): { upstreamUrl: string; body?: Buffer } {
  if (input.search) throw new ModelRelayError(400, "local model relay query parameters are not supported");
  const suffix = relaySuffix(input.path);
  const method = input.method.toUpperCase();
  if (method === "GET" && suffix === "/v1/models") {
    if (input.body?.length) throw new ModelRelayError(400, "the model-list request must not have a body");
    return { upstreamUrl: `${input.authority.upstreamBaseUrl}/models` };
  }
  if (method !== "POST" || !POST_PATHS.has(suffix)) {
    throw new ModelRelayError(404, "unsupported local model route");
  }
  if (!input.body?.length) throw new ModelRelayError(400, "a JSON request body is required");
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body.toString("utf8"));
  } catch {
    throw new ModelRelayError(400, "the local model request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ModelRelayError(400, "the local model request body must be a JSON object");
  }
  const requestedModel = (parsed as { model?: unknown }).model;
  if (typeof requestedModel !== "string" || !exactString(requestedModel, input.authority.model)) {
    throw new ModelRelayError(403, "the model does not match this turn's capability");
  }
  return {
    upstreamUrl: `${input.authority.upstreamBaseUrl.replace(/\/v1$/, "")}${suffix}`,
    body: input.body,
  };
}

export function modelRelayUpstreamHeaders(
  incoming: IncomingHttpHeaders,
  authority: ModelRelayAuthority,
): Headers {
  const headers = new Headers();
  for (const name of ["accept", "content-type", "anthropic-version", "anthropic-beta", "openai-beta"] as const) {
    const value = oneHeader(incoming[name]);
    if (value) headers.set(name, value);
  }
  headers.set("accept", headers.get("accept") || "application/json");
  headers.set("content-type", headers.get("content-type") || "application/json");
  headers.set("authorization", `Bearer ${authority.upstreamApiKey}`);
  headers.set("x-api-key", authority.upstreamApiKey);
  return headers;
}

export async function readModelRelayBody(
  req: IncomingMessage,
  maxBytes = MODEL_RELAY_MAX_REQUEST_BYTES,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new ModelRelayError(500, "invalid model request limit");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > maxBytes) throw new ModelRelayError(413, "local model request body too large");
    chunks.push(value);
  }
  return Buffer.concat(chunks, bytes);
}

export async function fetchModelRelay(input: {
  authority: ModelRelayAuthority;
  method: string;
  path: string;
  search?: string;
  headers: IncomingHttpHeaders;
  body?: Buffer;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<Response> {
  const request = validateModelRelayRequest(input);
  return await (input.fetchImpl ?? fetch)(request.upstreamUrl, {
    method: input.method,
    headers: modelRelayUpstreamHeaders(input.headers, input.authority),
    ...(request.body ? { body: request.body } : {}),
    redirect: "error",
    signal: input.signal,
  });
}

function filteredModelsBody(authority: ModelRelayAuthority, bytes: Buffer): Buffer {
  let payload: unknown;
  try {
    payload = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ModelRelayError(502, "the local model host returned an invalid model catalog");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ModelRelayError(502, "the local model host returned an invalid model catalog");
  }
  const record = payload as { object?: unknown; data?: unknown };
  const data = Array.isArray(record.data)
    ? record.data.filter((row) => row && typeof row === "object" && (row as { id?: unknown }).id === authority.model)
    : [];
  return Buffer.from(JSON.stringify({
    object: typeof record.object === "string" ? record.object : "list",
    data,
  }));
}

async function readBoundedResponse(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException("the source turn ended", "AbortError");
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new ModelRelayError(502, "the local model response exceeded its size limit");
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function responseHeaders(response: Response): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-type": response.headers.get("content-type") || "application/json",
    "x-content-type-options": "nosniff",
  };
}

/** Wait for one downstream drain without losing a close/error/turn-abort that
 * happens first. Waiting on `once("drain")` alone strands the relay forever
 * when a slow client disconnects while Node is backpressuring it. */
function waitForModelRelayDrain(response: ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const disconnected = () => new DOMException("the model relay was disconnected", "AbortError");
    const onDrain = () => settle();
    const onClose = () => settle(disconnected());
    const onError = (error: Error) => settle(error);
    const onAbort = () => settle(disconnected());

    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    // Close/abort may have happened immediately before listeners were added.
    if (signal.aborted || response.destroyed || response.writableEnded) onAbort();
  });
}

/** Stream one model response with explicit backpressure. Upstream errors are
 * replaced by a generic body so a local server cannot disclose its URL or
 * credentials through an attacker-controlled diagnostic. */
export async function writeModelRelayResponse(input: {
  authority: ModelRelayAuthority;
  upstream: Response;
  response: ServerResponse;
  signal: AbortSignal;
  modelList: boolean;
  maxBytes?: number;
  reserveTurnBytes?: (amount: number) => boolean;
  reserveTurnFrames?: (amount: number) => boolean;
}): Promise<void> {
  const maxBytes = input.maxBytes ?? MODEL_RELAY_MAX_RESPONSE_BYTES;
  if (!input.upstream.ok) {
    await input.upstream.body?.cancel().catch(() => {});
    const body = Buffer.from(JSON.stringify({ error: "the local model request failed", status: input.upstream.status }));
    if (input.reserveTurnBytes && !input.reserveTurnBytes(body.length)) {
      throw new ModelRelayError(429, "this turn reached its local model response-byte limit");
    }
    input.response.writeHead(input.upstream.status, {
      "cache-control": "no-store",
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
    });
    input.response.end(body);
    return;
  }
  if (input.modelList) {
    const upstreamBody = await readBoundedResponse(input.upstream, Math.min(maxBytes, 1_048_576), input.signal);
    if (input.reserveTurnBytes && !input.reserveTurnBytes(upstreamBody.length)) {
      throw new ModelRelayError(429, "this turn reached its local model response-byte limit");
    }
    const body = filteredModelsBody(input.authority, upstreamBody);
    input.response.writeHead(input.upstream.status, responseHeaders(input.upstream));
    input.response.end(body);
    return;
  }

  input.response.writeHead(input.upstream.status, responseHeaders(input.upstream));
  const reader = input.upstream.body?.getReader();
  if (!reader) {
    input.response.end();
    return;
  }
  let bytes = 0;
  const contentType = input.upstream.headers.get("content-type")?.toLowerCase() ?? "";
  const frameGuard = contentType.includes("text/event-stream") || contentType.includes("ndjson")
    ? new ModelRelayFrameGuard(contentType.includes("text/event-stream") ? "sse" : "ndjson", (count) => {
        if (input.reserveTurnFrames && !input.reserveTurnFrames(count)) {
          throw new ModelRelayError(429, "this turn reached its local model stream-frame limit");
        }
      })
    : null;
  try {
    for (;;) {
      if (input.signal.aborted || input.response.destroyed) {
        throw new DOMException("the model relay was disconnected", "AbortError");
      }
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new ModelRelayError(502, "the local model response exceeded its size limit");
      if (input.reserveTurnBytes && !input.reserveTurnBytes(next.value.byteLength)) {
        throw new ModelRelayError(429, "this turn reached its local model response-byte limit");
      }
      frameGuard?.push(next.value);
      if (!input.response.write(Buffer.from(next.value))) {
        await waitForModelRelayDrain(input.response, input.signal);
      }
    }
    frameGuard?.finish();
    input.response.end();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Incremental SSE/NDJSON guard. A stream cannot hide one unbounded record in
 * many transport chunks or spend an unbounded number of tiny frames. */
export class ModelRelayFrameGuard {
  private frameBytes = 0;
  private lineHasData = false;
  private readonly mode: "sse" | "ndjson";
  private readonly reserveFrames: (count: number) => void;
  private readonly maxFrameBytes: number;

  constructor(
    mode: "sse" | "ndjson",
    reserveFrames: (count: number) => void,
    maxFrameBytes = MODEL_RELAY_MAX_STREAM_FRAME_BYTES,
  ) {
    this.mode = mode;
    this.reserveFrames = reserveFrames;
    this.maxFrameBytes = maxFrameBytes;
  }

  push(chunk: Uint8Array): void {
    for (const byte of chunk) {
      if (byte === 13) continue;
      if (byte === 10) {
        if (this.mode === "ndjson") {
          if (this.frameBytes > 0) this.completeFrame();
        } else if (!this.lineHasData) {
          if (this.frameBytes > 0) this.completeFrame();
        } else {
          this.lineHasData = false;
          this.frameBytes += 1;
        }
        continue;
      }
      this.lineHasData = true;
      this.frameBytes += 1;
      if (this.frameBytes > this.maxFrameBytes) {
        throw new ModelRelayError(502, "the local model stream frame exceeded its size limit");
      }
    }
  }

  finish(): void {
    if (this.frameBytes > 0) this.completeFrame();
  }

  private completeFrame(): void {
    this.reserveFrames(1);
    this.frameBytes = 0;
    this.lineHasData = false;
  }
}
