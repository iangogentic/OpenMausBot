import { readBoundedResponseText } from "./bounded-response.ts";

import type { LocalHost } from "./drivers/local-inject.ts";
import { encodeInjectId } from "./drivers/local-inject.ts";

export const COMPUTER_OPERATOR_HOST_ID = "desktop2_qwen";
export const COMPUTER_OPERATOR_MODEL_ID = "qwen-3.8-27b";
export const COMPUTER_OPERATOR_UPSTREAM_MODEL_ID = "qwen-3.8-27b";
export const COMPUTER_OPERATOR_GLM_HOST_ID = "spark_glm";
export const COMPUTER_OPERATOR_GLM_MODEL_ID = "glm-5.3-flash";
export const COMPUTER_OPERATOR_GLM_UPSTREAM_MODEL_ID = "glm-5.3-flash";
export const COMPUTER_OPERATOR_MODEL_PREFLIGHT_MAX_BYTES = 256 * 1024;
export const COMPUTER_OPERATOR_MODEL_PREFLIGHT_TIMEOUT_MS = 30_000;

interface ComputerOperatorModelRoute {
  hostId: string;
  modelId: string;
  upstreamModelId: string;
}

const COMPUTER_OPERATOR_MODEL_ROUTES: readonly ComputerOperatorModelRoute[] = [
  {
    hostId: COMPUTER_OPERATOR_HOST_ID,
    modelId: COMPUTER_OPERATOR_MODEL_ID,
    upstreamModelId: COMPUTER_OPERATOR_UPSTREAM_MODEL_ID,
  },
  {
    hostId: COMPUTER_OPERATOR_GLM_HOST_ID,
    modelId: COMPUTER_OPERATOR_GLM_MODEL_ID,
    upstreamModelId: COMPUTER_OPERATOR_GLM_UPSTREAM_MODEL_ID,
  },
];

function computerOperatorModelRoute(host: string, model: string): ComputerOperatorModelRoute | null {
  const normalizedModel = model.toLowerCase();
  return COMPUTER_OPERATOR_MODEL_ROUTES.find((route) =>
    route.hostId === host && route.modelId === normalizedModel
  ) ?? null;
}

export function canonicalComputerOperatorModel(host: string, model: string): string | null {
  const route = computerOperatorModelRoute(host, model);
  return route ? encodeInjectId(route.hostId, route.modelId) : null;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Prove that the exact trusted relay upstream is alive and currently advertises
 * the exact operator model. Host aliases and merely-live Hermes processes are
 * insufficient authority for a visual child that can control a computer. */
export async function preflightComputerOperatorModel(
  host: LocalHost,
  model: string,
  apiKey: string,
  signal: AbortSignal,
  fetchImpl: Fetch = fetch,
): Promise<void> {
  const route = computerOperatorModelRoute(host.id, model);
  if (!route) throw new Error("computer operator model route is not trusted");
  signal.throwIfAborted();
  const url = `${host.baseUrl.replace(/\/+$/, "")}/models`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(COMPUTER_OPERATOR_MODEL_PREFLIGHT_TIMEOUT_MS)]),
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new Error(`computer operator model endpoint is unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`computer operator model endpoint returned HTTP ${response.status}`);
  }
  const text = await readBoundedResponseText(
    response,
    COMPUTER_OPERATOR_MODEL_PREFLIGHT_MAX_BYTES,
    "computer operator model catalog exceeded its bounded size",
  );
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error("computer operator model endpoint returned invalid JSON");
  }
  const rows = decoded && typeof decoded === "object" && Array.isArray((decoded as { data?: unknown }).data)
    ? (decoded as { data: unknown[] }).data
    : null;
  if (!rows) throw new Error("computer operator model endpoint returned an invalid catalog");
  const exact = rows.some((row) =>
    row !== null && typeof row === "object" &&
    typeof (row as { id?: unknown }).id === "string" &&
    (row as { id: string }).id.toLowerCase() === route.modelId,
  );
  if (!exact) throw new Error(`computer operator endpoint is not serving ${route.modelId}`);

  let completion: Response;
  try {
    completion = await fetchImpl(`${host.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: route.modelId,
        messages: [{ role: "user", content: "Reply OK." }],
        max_tokens: 1,
        temperature: 0,
        stream: false,
      }),
      // The inference probe gets its own deadline. Reusing the catalog
      // deadline makes a slow-but-valid catalog consume the probe's budget.
      signal: AbortSignal.any([signal, AbortSignal.timeout(COMPUTER_OPERATOR_MODEL_PREFLIGHT_TIMEOUT_MS)]),
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new Error(`computer operator model inference probe failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!completion.ok) {
    await completion.body?.cancel().catch(() => {});
    throw new Error(`computer operator model inference probe returned HTTP ${completion.status}`);
  }
  const completionText = await readBoundedResponseText(
    completion,
    COMPUTER_OPERATOR_MODEL_PREFLIGHT_MAX_BYTES,
    "computer operator inference probe exceeded its bounded size",
  );
  let completionJson: unknown;
  try {
    completionJson = JSON.parse(completionText);
  } catch {
    throw new Error("computer operator model inference probe returned invalid JSON");
  }
  const choices = completionJson && typeof completionJson === "object"
    ? (completionJson as { choices?: unknown }).choices
    : null;
  const servedModel = completionJson && typeof completionJson === "object"
    ? (completionJson as { model?: unknown }).model
    : null;
  if (servedModel !== route.upstreamModelId) {
    throw new Error("computer operator inference probe returned the wrong model identity");
  }
  const first = Array.isArray(choices) && choices[0] && typeof choices[0] === "object"
    ? choices[0] as { message?: unknown; text?: unknown }
    : null;
  const message = first?.message && typeof first.message === "object"
    ? (first.message as { content?: unknown; reasoning?: unknown })
    : null;
  const output = typeof message?.content === "string"
    ? message.content
    : typeof message?.reasoning === "string"
      ? message.reasoning
      : typeof first?.text === "string"
        ? first.text
        : "";
  if (!first || !output.trim() || Buffer.byteLength(output, "utf8") > 256) {
    throw new Error("computer operator model inference probe returned no completion");
  }
}
