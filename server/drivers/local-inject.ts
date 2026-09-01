// Shared local-host inject — the sidecar workflow, inside the picker.
// Probe oMLX / Ollama / EXO / LM Studio / Unsloth, list whatever they
// serve under Custom on every agent, and decode a pick back into a host
// + API id the selected driver can inject.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog, SendTurnInput } from "../contracts.ts";
import { readBoundedResponseText } from "../bounded-response.ts";
import { IAN_MODELS_BASE_URL, normalizedPinnedModelBaseUrl } from "../model-relay.ts";
import { assertBoundedJsonShape, CATALOG_NDJSON_LIMITS } from "./bounded-json-lines.ts";

export interface LocalHost {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
}

export type LocalModelRelayConnection = NonNullable<
  NonNullable<SendTurnInput["integrations"]>["modelRelay"]
>;

export const MODEL_RELAY_ENV = Object.freeze({
  openaiBaseUrl: "OMB_MODEL_RELAY_OPENAI_BASE_URL",
  anthropicBaseUrl: "OMB_MODEL_RELAY_ANTHROPIC_BASE_URL",
  token: "OMB_MODEL_RELAY_TOKEN",
  host: "OMB_MODEL_RELAY_HOST",
  model: "OMB_MODEL_RELAY_MODEL",
} as const);

export const LOCAL_HOSTS: LocalHost[] = [
  {
    id: "ian_models",
    label: "Ian Models API · Qwen 3.8 / GLM 5.3",
    baseUrl: process.env.OPENMAUSBOT_IAN_MODELS_URL || IAN_MODELS_BASE_URL,
    apiKeyEnv: "OPENMAUSBOT_IAN_MODELS_API_KEY",
  },
  {
    id: "desktop2_qwen",
    label: "desktop2 gateway · Qwen 3.8 / Spark GLM 5.3",
    baseUrl: process.env.OPENMAUSBOT_DESKTOP2_QWEN_URL || "http://127.0.0.1:18011/v1",
    apiKeyEnv: "OPENMAUSBOT_DESKTOP2_QWEN_API_KEY",
    apiKey: "local",
  },
  {
    id: "spark_glm",
    label: "DGX Sparks · GLM 5.3 Flash Abliterated",
    baseUrl: process.env.OPENMAUSBOT_SPARK_GLM_URL || "http://127.0.0.1:18002/v1",
    apiKeyEnv: "OPENMAUSBOT_SPARK_GLM_API_KEY",
    apiKey: "local",
  },
  { id: "omlx", label: "oMLX", baseUrl: "http://127.0.0.1:8080/v1", apiKey: "omlx" },
  { id: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "ollama" },
  { id: "local_ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "ollama" },
  { id: "exo", label: "EXO", baseUrl: "http://127.0.0.1:52415/v1", apiKey: "exo" },
  { id: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "lm-studio" },
  { id: "unsloth", label: "Unsloth", baseUrl: "http://127.0.0.1:8888/v1", apiKeyEnv: "UNSLOTH_STUDIO_AUTH_TOKEN" },
  { id: "unsloth_api", label: "Unsloth", baseUrl: "http://127.0.0.1:8888/v1", apiKeyEnv: "UNSLOTH_STUDIO_AUTH_TOKEN" },
];

export const INJECT_SEP = "::";

const HOST_BY_ID = new Map(LOCAL_HOSTS.map((host) => [host.id, host]));
export const LOCAL_MODEL_ID_MAX_CHARS = 256;
export const LOCAL_MODEL_CATALOG_MAX_RECORDS = 512;
export const LOCAL_MODEL_CATALOG_MAX_RESPONSE_BYTES = 1024 * 1024;
export const LOCAL_MODEL_CATALOG_MAX_TOTAL_MODELS = 2_048;
const MODEL_ID = new RegExp(`^[\\w][\\w./:+-]{0,${LOCAL_MODEL_ID_MAX_CHARS - 1}}$`);

export interface InjectedModel {
  id: string;
  host: string;
  model: string;
  label: string;
  /** In VRAM / running on the host right now — Custom pins these first. */
  loaded?: boolean;
  /** the host's own word on the model's context window (Ollama reports it
   * for running models in /api/ps) — sizes the model-facing rebuild instead
   * of guessing from the name */
  contextWindow?: number;
}

/** Ollama's /api/ps lists running models with their context_length; a
 * small model's real window matters more than a big one's — an 8k model
 * guessed at 32k gets a rebuild it cannot hold. */
export function contextWindowsFromPs(extra: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const rec = extra && typeof extra === "object" ? (extra as { models?: unknown }) : null;
  if (!rec || !Array.isArray(rec.models)) return out;
  for (const m of rec.models.slice(0, LOCAL_MODEL_CATALOG_MAX_RECORDS)) {
    if (!m || typeof m !== "object") continue;
    const row = m as { name?: unknown; model?: unknown; context_length?: unknown };
    const id = typeof row.model === "string" ? row.model : typeof row.name === "string" ? row.name : null;
    const ctx = typeof row.context_length === "number" && Number.isFinite(row.context_length) && row.context_length > 0 ? row.context_length : null;
    if (id && ctx) {
      out.set(id, ctx);
      const baseId = id.split(":")[0]!;
      const current = out.get(baseId);
      out.set(baseId, current === undefined ? ctx : Math.min(current, ctx));
    }
  }
  return out;
}

export function encodeInjectId(host: string, model: string): string {
  return `${host}${INJECT_SEP}${model}`;
}

export function decodeInjectId(id: string | null | undefined): { host: string; model: string } | null {
  if (!id) return null;
  const sep = id.indexOf(INJECT_SEP);
  if (sep <= 0) return null;
  const host = id.slice(0, sep);
  const model = id.slice(sep + INJECT_SEP.length);
  if (!HOST_BY_ID.has(host) || !MODEL_ID.test(model)) return null;
  return { host, model };
}

export function localHost(id: string): LocalHost | undefined {
  return HOST_BY_ID.get(id);
}

export function injectedApiModel(id: string | null | undefined): string | null {
  return decodeInjectId(id)?.model ?? null;
}

/**
 * Map a picker / leftover API id onto a live `host::model` inject id.
 * Claude Code's settings.model is the last slug it used (e.g.
 * `orcarouter/Qwen3.8-27B-Uncensored-GGUF`) and is not host-encoded, so a
 * Custom pick of that leftover would otherwise skip inject and demand /login.
 */
export function resolveInjectId(
  modelId: string | null | undefined,
  extras: readonly InjectedModel[],
): string | null | undefined {
  if (!modelId) return modelId;
  if (decodeInjectId(modelId)) return modelId;
  const matches = extras.filter((row) => row.id === modelId || row.model === modelId);
  const match = matches.find((row) => row.loaded) ?? matches[0];
  return match?.id ?? modelId;
}

/** Anthropic-compatible base (Claude Code wants this without a trailing /v1). */
export function anthropicBaseUrl(host: LocalHost): string {
  return host.baseUrl.replace(/\/v1\/?$/, "");
}

export function hostApiKey(host: LocalHost, env: Record<string, string | undefined> = process.env): string {
  // Positive provider environments deliberately exclude ambient secrets. The
  // trusted harness may still read the one key declared by the *selected*
  // local host and remap it into the child's generated target variable.
  if (host.apiKeyEnv) {
    const selected = env[host.apiKeyEnv] ?? process.env[host.apiKeyEnv];
    if (selected) return selected;
  }
  if (host.apiKey) return host.apiKey;
  if (host.id === "unsloth" || host.id === "unsloth_api") {
    const fromFile = readUnslothKey(env);
    if (fromFile) return fromFile;
  }
  return "local";
}

export interface LocalInjectConnection {
  readonly openaiBaseUrl: string;
  readonly anthropicBaseUrl: string;
  readonly apiKey: string;
  readonly relayed: boolean;
}

function checkedProviderRelayUrl(value: string, expectedPath: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("the local model relay URL is invalid");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "10.0.2.2"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/+$/, "") !== expectedPath
  ) throw new Error("the local model relay URL is not an approved provider-harness route");
  return url.toString().replace(/\/$/, "");
}

/** Install the server-generated connection after the positive provider env is
 * constructed. User-configured instance env cannot forge these reserved
 * fields, and every writer below fails closed on a partial/mismatched relay. */
export function applyModelRelayEnvironment(
  env: Record<string, string | undefined>,
  modelId: string | null | undefined,
  relay: LocalModelRelayConnection | undefined,
): void {
  if (!relay) return;
  const inject = decodeInjectId(modelId);
  if (!inject || inject.host !== relay.host || inject.model !== relay.model) {
    throw new Error("the local model relay does not match the selected host and model");
  }
  const openaiBaseUrl = checkedProviderRelayUrl(relay.openaiBaseUrl, "/api/internal/model-relay/v1");
  const anthropicBaseUrl = checkedProviderRelayUrl(relay.anthropicBaseUrl, "/api/internal/model-relay");
  if (new URL(openaiBaseUrl).origin !== new URL(anthropicBaseUrl).origin) {
    throw new Error("the local model relay URLs must share one provider-harness origin");
  }
  if (!relay.token || relay.token.trim() !== relay.token || relay.token.length < 16) {
    throw new Error("the local model relay token is invalid");
  }
  env[MODEL_RELAY_ENV.openaiBaseUrl] = openaiBaseUrl;
  env[MODEL_RELAY_ENV.anthropicBaseUrl] = anthropicBaseUrl;
  env[MODEL_RELAY_ENV.token] = relay.token;
  env[MODEL_RELAY_ENV.host] = relay.host;
  env[MODEL_RELAY_ENV.model] = relay.model;
}

export function localInjectConnection(
  host: LocalHost,
  model: string,
  env: Record<string, string | undefined>,
): LocalInjectConnection {
  const values = {
    openaiBaseUrl: env[MODEL_RELAY_ENV.openaiBaseUrl],
    anthropicBaseUrl: env[MODEL_RELAY_ENV.anthropicBaseUrl],
    token: env[MODEL_RELAY_ENV.token],
    host: env[MODEL_RELAY_ENV.host],
    model: env[MODEL_RELAY_ENV.model],
  };
  const present = Object.values(values).filter((value) => value !== undefined).length;
  if (present === 0) {
    return {
      openaiBaseUrl: host.baseUrl,
      anthropicBaseUrl: anthropicBaseUrl(host),
      apiKey: hostApiKey(host, env),
      relayed: false,
    };
  }
  if (
    present !== Object.keys(values).length ||
    values.host !== host.id ||
    values.model !== model ||
    !values.token ||
    values.token.trim() !== values.token ||
    values.token.length < 16
  ) throw new Error("the local model relay environment is incomplete or belongs to another model");
  return {
    openaiBaseUrl: checkedProviderRelayUrl(values.openaiBaseUrl!, "/api/internal/model-relay/v1"),
    anthropicBaseUrl: checkedProviderRelayUrl(values.anthropicBaseUrl!, "/api/internal/model-relay"),
    apiKey: values.token,
    relayed: true,
  };
}

const CODEX_RESERVED_PROVIDERS = new Set(["openai", "ollama", "lmstudio"]);

/**
 * Configure the custom local providers on the Codex app-server without
 * rewriting the user's config.toml. Provider secrets ride in the child
 * environment; argv only contains the corresponding environment key name.
 */
export function codexLocalProviderArgs(
  env: Record<string, string | undefined>,
  modelId: string | null | undefined,
): string[] {
  const inject = decodeInjectId(modelId);
  if (!inject) return [];
  const host = localHost(inject.host);
  if (!host) return [];
  const connection = localInjectConnection(host, inject.model, env);
  if (!connection.relayed && CODEX_RESERVED_PROVIDERS.has(inject.host)) return [];
  const providerId = connection.relayed ? `openmaus_${host.id}` : host.id;
  const envKey = `OPENMAUSBOT_LOCAL_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
  env[envKey] = connection.apiKey;
  return [
    "-c",
    `model_providers.${providerId}.name=${JSON.stringify(host.label)}`,
    "-c",
    `model_providers.${providerId}.base_url=${JSON.stringify(connection.openaiBaseUrl)}`,
    "-c",
    `model_providers.${providerId}.env_key=${JSON.stringify(envKey)}`,
  ];
}

/** Codex has built-in `ollama`/`lmstudio` providers that cannot be safely
 * repointed per turn. Relay-backed turns use a private provider id instead. */
export function codexLocalProviderSelection(
  env: Record<string, string | undefined>,
  modelId: string | null | undefined,
): { model: string | null; modelProvider: string | null } | null {
  const inject = decodeInjectId(modelId);
  if (!inject) return null;
  const host = localHost(inject.host);
  if (!host) return null;
  const connection = localInjectConnection(host, inject.model, env);
  return {
    model: inject.model,
    modelProvider: connection.relayed ? `openmaus_${host.id}` : host.id,
  };
}

function firstUnslothToken(row: unknown): string | null {
  if (!row || typeof row !== "object") return null;
  const rec = row as { minted?: unknown; saved?: unknown; api_key?: unknown };
  for (const bucket of [rec.minted, rec.saved]) {
    if (typeof bucket === "string" && bucket) return bucket;
    if (Array.isArray(bucket)) {
      const token = bucket.find((value) => typeof value === "string" && value);
      if (typeof token === "string") return token;
    }
  }
  if (typeof rec.api_key === "string" && rec.api_key) return rec.api_key;
  return null;
}

function readUnslothKey(env: Record<string, string | undefined>): string | null {
  const home = env.HOME || env.USERPROFILE || homedir();
  try {
    const raw = JSON.parse(readFileSync(join(home, ".unsloth", "studio", "auth", "agent_api_key.json"), "utf8")) as {
      api_key?: unknown;
      servers?: unknown;
    };
    // Older Studio wrote `{ api_key }`. Current Studio writes
    // `{ servers: { "http://127.0.0.1:8888": { minted: ["sk-unsloth-…"] } } }`.
    // Prefer the localhost minted token so a stale mixed-format file cannot
    // win; keep the top-level key as fallback.
    if (raw.servers && typeof raw.servers === "object") {
      const servers = raw.servers as Record<string, unknown>;
      for (const url of ["http://127.0.0.1:8888", "http://localhost:8888"]) {
        const token = firstUnslothToken(servers[url]);
        if (token) return token;
      }
      for (const row of Object.values(servers)) {
        const token = firstUnslothToken(row);
        if (token) return token;
      }
    }
    if (typeof raw.api_key === "string" && raw.api_key) return raw.api_key;
    return null;
  } catch {
    return null;
  }
}

function idsFromModelsPayload(payload: unknown): string[] {
  const records = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : payload && typeof payload === "object" && Array.isArray((payload as { models?: unknown }).models)
        ? (payload as { models: unknown[] }).models
        : [];
  return records.slice(0, LOCAL_MODEL_CATALOG_MAX_RECORDS).flatMap((record) => {
    const validChatId = (id: string) => {
      if (!MODEL_ID.test(id)) return false;
      const low = id.toLowerCase();
      return !low.includes("embed") && !low.includes("bge-") && !low.includes("nomic");
    };
    if (typeof record === "string") return validChatId(record) ? [record] : [];
    if (!record || typeof record !== "object") return [];
    const id = (record as { id?: unknown; name?: unknown }).id ?? (record as { name?: unknown }).name;
    if (typeof id !== "string" || !validChatId(id)) return [];
    return [id];
  });
}

export async function boundedLocalCatalogJson(response: Response): Promise<unknown | null> {
  try {
    const text = await readBoundedResponseText(
      response,
      LOCAL_MODEL_CATALOG_MAX_RESPONSE_BYTES,
      "local model catalog exceeded 1 MB",
    );
    const parsed: unknown = JSON.parse(text);
    assertBoundedJsonShape(parsed, CATALOG_NDJSON_LIMITS);
    return parsed;
  } catch {
    return null;
  }
}

async function timedJson(
  url: string,
  env: Record<string, string | undefined>,
  host: LocalHost,
  fetchImpl: typeof fetch,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${hostApiKey(host, env)}`,
      },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    return await boundedLocalCatalogJson(response);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Which of this host's models are actually in memory / running. */
export function loadedIdsFromPayloads(_host: LocalHost, catalog: unknown, extra: unknown): Set<string> {
  const loaded = new Set<string>();
  const catalogIds = new Set(idsFromModelsPayload(catalog));
  const add = (id: string) => {
    const base = id.split(":")[0]!;
    if (catalogIds.size && !catalogIds.has(id) && !catalogIds.has(base)) return;
    if (!MODEL_ID.test(id)) return;
    loaded.add(id);
    if (catalogIds.has(base)) loaded.add(base);
  };

  if (extra && typeof extra === "object") {
    const rec = extra as {
      default_model?: unknown;
      models?: unknown;
      data?: unknown;
    };
    const running = Array.isArray(rec.models)
      ? rec.models
      : Array.isArray(rec.data)
        ? rec.data
        : [];
    // oMLX /v1/models/status lists every model with loaded:true/false.
    // /health only has default_model, which is the configured default — not
    // necessarily what is in memory. Prefer explicit flags when present.
    const hasLoadedFlags = running.some(
      (row) => row && typeof row === "object" && ("loaded" in row || "state" in row),
    );
    if (!hasLoadedFlags && typeof rec.default_model === "string") add(rec.default_model);
    for (const row of running.slice(0, LOCAL_MODEL_CATALOG_MAX_RECORDS)) {
      if (typeof row === "string") {
        if (!hasLoadedFlags) add(row);
        continue;
      }
      if (!row || typeof row !== "object") continue;
      const item = row as { name?: unknown; model?: unknown; id?: unknown; state?: unknown; loaded?: unknown };
      const id =
        (typeof item.name === "string" && item.name) ||
        (typeof item.model === "string" && item.model) ||
        (typeof item.id === "string" && item.id) ||
        "";
      if (!id) continue;
      const state = typeof item.state === "string" ? item.state.toLowerCase() : "";
      if (item.loaded === false || state === "not-loaded" || state === "unloaded") continue;
      if (item.loaded === true || state === "loaded" || state === "idle" || !hasLoadedFlags) {
        add(id);
      }
    }
  }

  if (!loaded.size && catalog && typeof catalog === "object") {
    const rec = catalog as { default_model?: unknown; data?: unknown };
    if (typeof rec.default_model === "string") add(rec.default_model);
    const records = Array.isArray(rec.data)
      ? rec.data.slice(0, LOCAL_MODEL_CATALOG_MAX_RECORDS)
      : [];
    for (const row of records) {
      if (!row || typeof row !== "object") continue;
      const item = row as { id?: unknown; state?: unknown; loaded?: unknown };
      if (typeof item.id !== "string") continue;
      const state = typeof item.state === "string" ? item.state.toLowerCase() : "";
      if (item.loaded === true || state === "loaded") add(item.id);
    }
  }

  return loaded;
}

function loadedProbeUrl(host: LocalHost): string | null {
  const origin = anthropicBaseUrl(host);
  if (host.id === "omlx") return `${origin}/v1/models/status`;
  if (host.id === "ollama" || host.id === "local_ollama") return `${origin}/api/ps`;
  if (host.id === "lmstudio") return `${origin}/api/v0/models`;
  return null;
}

/** Live models from the same local hosts the sidecar probed. */
export async function probeLocalInjects(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<InjectedModel[]> {
  const seenHosts = new Set<string>();
  const hosts: LocalHost[] = [];
  for (const configured of LOCAL_HOSTS) {
    let baseUrl: string;
    try {
      baseUrl = normalizedPinnedModelBaseUrl(configured.baseUrl);
    } catch {
      // Discovery is read-only convenience. A DNS/public/malformed source is
      // never probed with a host credential and simply does not appear.
      continue;
    }
    const key = baseUrl.replace(/\/$/, "");
    if (seenHosts.has(key)) continue;
    seenHosts.add(key);
    hosts.push({ ...configured, baseUrl });
  }
  const found: InjectedModel[] = [];
  const pages = await Promise.all(
    hosts.map(async (host) => {
      const catalogUrl = `${host.baseUrl.replace(/\/$/, "")}/models`;
      const extraUrl = loadedProbeUrl(host);
      const [catalog, extra] = await Promise.all([
        timedJson(catalogUrl, env, host, fetchImpl),
        extraUrl ? timedJson(extraUrl, env, host, fetchImpl) : Promise.resolve(null),
      ]);
      const catalogIds = catalog ? idsFromModelsPayload(catalog) : [];
      const extraIds = extra ? idsFromModelsPayload(extra) : [];
      const loaded = loadedIdsFromPayloads(host, catalog ?? extra, extra);
      const ids = [...new Set([...catalogIds, ...extraIds, ...loaded])]
        .slice(0, LOCAL_MODEL_CATALOG_MAX_RECORDS);
      const windows = contextWindowsFromPs(extra);
      return { host, ids, loaded, windows };
    }),
  );
  for (const { host, ids, loaded, windows } of pages) {
    for (const model of ids) {
      if (found.length >= LOCAL_MODEL_CATALOG_MAX_TOTAL_MODELS) return found;
      const contextWindow = windows.get(model);
      found.push({
        id: encodeInjectId(host.id, model),
        host: host.id,
        model,
        label: `${model} (${host.label})`,
        loaded: loaded.has(model),
        ...(contextWindow ? { contextWindow } : {}),
      });
    }
  }
  return found;
}

/** Append live local models as custom rows. Official rows stay first. */
export async function mergeLocalInject(
  catalog: ModelCatalog,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelCatalog> {
  const vitest = env.VITEST ?? process.env.VITEST;
  const probe = env.OPENMAUSBOT_PROBE_LOCAL_INJECT ?? process.env.OPENMAUSBOT_PROBE_LOCAL_INJECT;
  if (vitest === "true" && probe !== "1") return catalog;
  const extras = await probeLocalInjects(env, fetchImpl);
  if (!extras.length) return catalog;
  const liveApiIds = new Set(extras.map((extra) => extra.model));
  // A settings leftover that is just the API id of a live inject is not a
  // second model — Custom should only offer the host:: row.
  const options = catalog.options
    .filter((option) => decodeInjectId(option.id) || !option.custom || !liveApiIds.has(option.id))
    .map((option) => ({ ...option }));
  const seen = new Set(options.map((option) => option.id));
  for (const extra of extras) {
    const existing = options.find((option) => option.id === extra.id);
    if (existing) {
      if (extra.loaded) existing.loaded = true;
      if (extra.contextWindow) existing.contextWindow = extra.contextWindow;
      continue;
    }
    seen.add(extra.id);
    options.push({
      id: extra.id,
      label: extra.label,
      custom: true,
      ...(extra.loaded ? { loaded: true } : {}),
      ...(extra.contextWindow ? { contextWindow: extra.contextWindow } : {}),
    });
  }
  return { default: catalog.default, options };
}

/** Point an OpenAI-compatible CLI at the injected host. */
export function applyOpenAIInject(
  env: Record<string, string | undefined>,
  modelId: string | null | undefined,
): { model: string | null; injected: boolean } {
  const inject = decodeInjectId(modelId);
  if (!inject) return { model: modelId ?? null, injected: false };
  const host = localHost(inject.host);
  if (!host) return { model: modelId ?? null, injected: false };
  const connection = localInjectConnection(host, inject.model, env);
  env.OPENAI_BASE_URL = connection.openaiBaseUrl;
  env.OPENAI_API_KEY = connection.apiKey;
  return { model: inject.model, injected: true };
}

/** Point Claude Code at the injected host instead of Anthropic cloud. */
export function applyClaudeInject(
  env: Record<string, string | undefined>,
  modelId: string | null | undefined,
): { model: string | null; injected: boolean } {
  const inject = decodeInjectId(modelId);
  if (!inject) return { model: modelId ?? null, injected: false };
  const host = localHost(inject.host);
  if (!host) return { model: modelId ?? null, injected: false };
  const connection = localInjectConnection(host, inject.model, env);
  env.ANTHROPIC_BASE_URL = connection.anthropicBaseUrl;
  env.ANTHROPIC_AUTH_TOKEN = connection.apiKey;
  env.ANTHROPIC_API_KEY = connection.apiKey;
  env.ANTHROPIC_MODEL = inject.model;
  return { model: inject.model, injected: true };
}
