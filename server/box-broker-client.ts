/** Client for the harness-owned, turn-scoped Box broker.
 *
 * This module is safe to bundle into model-side MCP helpers: it knows only an
 * opaque capability and a loopback URL. The provider-wide ascii.dev key never
 * crosses into the child process. */

import { readBoundedResponseText } from "./bounded-response.ts";
import { assertBoundedJsonShape, PROVIDER_NDJSON_LIMITS } from "./drivers/bounded-json-lines.ts";

const MAX_BOX_BROKER_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface BoxBrokerConnection {
  url: string;
  token: string;
  /** Exact ComputerControl ticket held by the official computer proxy for
   * this async request. A raw model-side broker caller cannot invent it. */
  controlActionId?: () => string | undefined;
}

export type BoxBrokerOperation =
  | "command"
  | "resume"
  | "state"
  | "read-file"
  | "prompt"
  | "prompt-status"
  | "events"
  | "interrupt";

export interface BoxBrokerResponse {
  ok?: boolean;
  status?: number;
  body?: unknown;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  data?: string | null;
}

/** Do not let an injected environment value turn the capability into an
 * outbound credential. The harness always supplies this exact authority. */
export function validBoxBrokerUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !/^\d+$/.test(url.port) ||
      Number(url.port) < 1 ||
      Number(url.port) > 65_535 ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      url.pathname !== "/api/internal/box"
    ) return null;
    return url;
  } catch {
    return null;
  }
}

export async function callBoxBroker(
  connection: BoxBrokerConnection,
  op: BoxBrokerOperation,
  input: Record<string, unknown> = {},
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<BoxBrokerResponse> {
  const url = validBoxBrokerUrl(connection.url);
  if (!url || !connection.token || connection.token.trim() !== connection.token) {
    throw new Error("the scoped Box broker is unavailable");
  }
  const timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? 120_000, 180_000));
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const controlActionId = connection.controlActionId?.();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${connection.token}`,
      "content-type": "application/json",
      ...(controlActionId
        ? { "x-openmausbot-control-action": controlActionId }
        : {}),
    },
    body: JSON.stringify({ op, ...input }),
    signal,
  });
  const text = await readBoundedResponseText(
    res,
    MAX_BOX_BROKER_RESPONSE_BYTES,
    "Box broker response exceeded 16 MB",
  );
  let parsed: unknown = null;
  try {
    parsed = text.trim() ? JSON.parse(text) : null;
  } catch {}
  if (parsed !== null) assertBoundedJsonShape(parsed, PROVIDER_NDJSON_LIMITS);
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as BoxBrokerResponse
    : null;
  if (!res.ok || !body) {
    const message = (body as { error?: unknown } | null)?.error;
    throw new Error(typeof message === "string" && message ? message : `Box broker HTTP ${res.status}`);
  }
  return body;
}
