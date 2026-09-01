// Hermes Agent — Nous Research's `hermes acp` CLI. Custom-only: Hermes is
// a BYOK/local harness. ACP ignores `hermes -m` (cmd_acp does not forward
// it), and setting OPENAI_API_KEY makes provider:auto resolve to OpenRouter
// without an OpenRouter key — that is the "HTTP 401: Missing Authentication
// header" failure. Inject writes providers.<host> and session/set_model
// `custom:<host>:<model>` instead.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { ModelCatalog, SendTurnInput } from "../../contracts.ts";
import { DATA_DIR } from "../../config.ts";
import { providerRuntimeBase } from "../../provider-runtime.ts";
import { findCliCandidates } from "../../env-path.ts";
import { resolveCli, spawnCli } from "../../procs.ts";
import { decodeInjectId, INJECT_SEP, localHost, localInjectConnection, mergeLocalInject } from "../local-inject.ts";
import { BoundedJsonLineDecoder, CATALOG_NDJSON_LIMITS } from "../bounded-json-lines.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import {
  prepareHermesPolicyEnvironment,
  resolveManagedHermesPython,
  verifyHermesPolicyProof,
  type HermesPolicyProof,
} from "./hermes-policy.ts";

const EMPTY: ModelCatalog = { default: "", options: [] };
const turnPolicyProofs = new Map<string, HermesPolicyProof>();

function discardTurnPolicyProof(threadId: string): void {
  const previous = turnPolicyProofs.get(threadId);
  turnPolicyProofs.delete(threadId);
  if (!previous) return;
  try {
    unlinkSync(previous.path);
  } catch {
    /* the child may already have consumed/replaced it */
  }
}

function hermesHome(env: Record<string, string | undefined>): string {
  return env.HERMES_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".hermes");
}

export function isOfficialHermesLauncher(
  command: string,
  sourceHome: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathApi = platform === "win32" ? win32 : posix;
  const names = platform === "win32"
    ? ["hermes", "hermes.exe", "hermes.cmd", "hermes.bat"]
    : ["hermes"];
  const bare = platform === "win32" ? command.toLowerCase() : command;
  if (names.includes(bare)) return true;
  const home = env.HOME || env.USERPROFILE || homedir();
  const directories = [
    pathApi.join(home, ".local", "bin"),
    pathApi.join(sourceHome, "bin"),
    ...(platform === "win32" && env.LOCALAPPDATA
      ? [pathApi.join(env.LOCALAPPDATA, "hermes", "bin")]
      : [pathApi.join("/usr", "local", "bin")]),
  ];
  const documented = directories.flatMap((directory) => names.map((name) => pathApi.join(directory, name)));
  const comparable = (value: string) => {
    const normalized = pathApi.normalize(value);
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return documented.some((candidate) => comparable(candidate) === comparable(command));
}

function quoteYaml(value: string): string {
  if (/^[\w./:+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function upsertHermesProvider(text: string, hostId: string, baseUrl: string, apiKey: string): string {
  const block = [`  ${hostId}:`, `    base_url: ${quoteYaml(baseUrl)}`, `    api_key: ${quoteYaml(apiKey)}`, ""].join(
    "\n",
  );
  if (/^providers:\s*$/m.test(text)) {
    const replaced = replaceHermesHostBlock(text, hostId, block);
    if (replaced !== null) return replaced;
    return text.replace(/^providers:\s*$/m, `providers:\n${block.trimEnd()}`);
  }
  const prefix = text && !text.endsWith("\n") ? `${text}\n` : text;
  return `${prefix}\nproviders:\n${block}`;
}

/** Give Hermes ACP a valid agent for session/new, before OpenMaus can call
 * session/set_model. This is used only in the per-bot isolated profile;
 * never rewrite the user's real Hermes default as a side effect of a turn. */
function upsertHermesBootstrapModel(text: string, hostId: string, model: string): string {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    parsed = null;
  }
  const config = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? { ...(parsed as Record<string, unknown>) }
    : {};
  const previous = config.model;
  const modelConfig = previous && typeof previous === "object" && !Array.isArray(previous)
    ? { ...(previous as Record<string, unknown>) }
    : {};
  // These are active-route properties owned by OpenMaus policy. A Hermes HOME
  // is durable and may later switch providers, so never inherit either value
  // from the previous route.
  delete modelConfig.max_tokens;
  delete modelConfig.supports_vision;
  config.model = {
    ...modelConfig,
    default: model,
    provider: `custom:${hostId}`,
    // Keep Spark on an explicit bounded response budget. The scoped transport
    // policy below now fixes its false short post-tool `length` responses, so
    // the old 16K workaround is both unnecessary and harmful: one pathological
    // hidden-reasoning pass can otherwise hold a bot for many minutes before
    // its first tool call. Genuine long or tool-call truncations retain their
    // native `length` reason and Hermes' bounded continuation path.
    ...(hostId === "spark_glm" || model.toLowerCase() === "glm-5.3-flash" ? { max_tokens: 4_096 } : {}),
  };
  // The desktop2 gateway's audited Qwen and GLM routes accept OpenAI-compatible
  // image content in tool messages. Hermes cannot infer that capability for a
  // private model absent from models.dev, and otherwise replaces every
  // screenshot with a text-only fallback. Keep this exact-route allowlist in
  // sync with live multimodal acceptance tests; unknown local models remain
  // fail-closed.
  const auditedVisionModel = (new Set(["ian_models", "desktop2_qwen"]).has(hostId) && new Set([
    "qwen-3.8-27b",
    "qwen-quality-canary",
    "qwen3.8-27b-abliterated",
    "qwen3.8-27b",
    "glm-5.3-flash",
    "glm-live/glm-5.3-flash",
  ]).has(model.toLowerCase())) || (
    hostId === "spark_glm" && model.toLowerCase() === "glm-5.3-flash"
  );
  if (auditedVisionModel) {
    // Hermes normalizes `custom:desktop2_qwen` to the runtime provider
    // `custom`, but its current per-provider capability lookup does not strip
    // the configured prefix before indexing `providers`. Also set the
    // documented active-model shortcut so screenshots reach Qwen today; keep
    // the precise per-model declaration below for forward compatibility.
    (config.model as Record<string, unknown>).supports_vision = true;
    const providers = config.providers && typeof config.providers === "object" && !Array.isArray(config.providers)
      ? { ...(config.providers as Record<string, unknown>) }
      : {};
    const existingProvider = providers[hostId];
    const provider = existingProvider && typeof existingProvider === "object" && !Array.isArray(existingProvider)
      ? { ...(existingProvider as Record<string, unknown>) }
      : {};
    const existingModels = provider.models;
    const models = existingModels && typeof existingModels === "object" && !Array.isArray(existingModels)
      ? { ...(existingModels as Record<string, unknown>) }
      : {};
    const existingModel = models[model];
    models[model] = {
      ...(existingModel && typeof existingModel === "object" && !Array.isArray(existingModel)
        ? existingModel as Record<string, unknown>
        : {}),
      supports_vision: true,
    };
    provider.models = models;
    providers[hostId] = provider;
    config.providers = providers;
  }
  return stringifyYaml(config);
}

/** Replace `  hostId:` through the next sibling 2-space key or a top-level key. */
function replaceHermesHostBlock(text: string, hostId: string, block: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === `  ${hostId}:`);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end]!;
    if (/^  \S/.test(line) || /^\S/.test(line)) break;
    end++;
  }
  while (end > start + 1 && lines[end - 1] === "") end--;
  return [...lines.slice(0, start), ...block.replace(/\n$/, "").split("\n"), ...lines.slice(end)].join("\n");
}

/** Register an OpenAI-compatible host so ACP can `session/set_model custom:host:model`. */
export function ensureHermesInjectProvider(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;
  const connection = localInjectConnection(host, inject.model, env);

  const dir = hermesHome(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.yaml");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = "";
  }
  let next = upsertHermesProvider(text, inject.host, connection.openaiBaseUrl, connection.apiKey);
  if (env.OPENMAUSBOT_HERMES_POLICY === "1") {
    next = upsertHermesBootstrapModel(next, inject.host, inject.model);
  }
  if (next !== text) writeFileSync(path, next);
  return hermesAcpModelId(modelId) ?? modelId;
}

/** ACP session/set_model id. Hermes parse_model_input treats `custom:name:model`. */
export function hermesAcpModelId(modelId: string | null | undefined): string | null {
  const inject = decodeInjectId(modelId);
  if (inject) return `custom:${inject.host}:${inject.model}`;
  // Hermes' own ACP ids are `<provider>:<model>` (`openrouter:qwen/qwen3.8-max`).
  // They are not inject ids and must be forwarded untouched; returning null here
  // is what limited the picker to locally injected hosts.
  const native = typeof modelId === "string" ? modelId.trim() : "";
  if (native && !native.includes(INJECT_SEP) && /^[a-z0-9_-]+:[\w./:-]+$/i.test(native)) return native;
  return null;
}

/** The id used when Hermes should run on the provider its own config names.
 *
 * Deliberately not an inject id: `hermesAcpModelId` returns null for it, so
 * `configureSession` sends no `session/set_model` and Hermes falls through to
 * the model in its own `config.yaml`. `spawnArgs` passes no `-m` either (ACP
 * ignores it), so nothing overrides that choice.
 */
export const HERMES_CONFIG_MODEL_ID = "hermes-default";
const SPARK_FINAL_OPEN = "<openmaus_final>";
const SPARK_FINAL_CLOSE = "</openmaus_final>";
const SPARK_FINAL_CONTRACT = [
  "OpenMaus output protocol for this turn:",
  "You may reason internally, but after completing the task emit exactly one user-visible final response",
  `wrapped once in ${SPARK_FINAL_OPEN} and ${SPARK_FINAL_CLOSE}.`,
  "Put no reasoning inside that element. The closing tag must be your final output.",
].join(" ");
const HERMES_EMPTY_REPLY = /^⚠️\s*No reply:\s*the model returned empty content after retries\b/i;

function isSparkHermesModel(modelId: string | undefined): boolean {
  const injected = decodeInjectId(modelId);
  return injected?.host === "spark_glm" || injected?.model.toLowerCase() === "glm-5.3-flash";
}

export function buildHermesPromptText(turn: Pick<SendTurnInput, "model" | "system" | "text">): string {
  const prompt = turn.system ? `${turn.system}\n\n${turn.text}` : turn.text;
  return isSparkHermesModel(turn.model) ? `${prompt}\n\n${SPARK_FINAL_CONTRACT}` : prompt;
}

/** Spark GLM occasionally returns the complete terminal answer twice in one
 * response after a tool turn. Collapse only an exact whole-answer repeat,
 * only for this injected host. Do not fuzzy-match or alter partial repeats. */
export function normalizeHermesAssistantText(text: string, modelId: string | undefined): string {
  if (!isSparkHermesModel(modelId)) return text;
  const leading = text.match(/^\s*/u)?.[0] ?? "";
  const trailing = text.match(/\s*$/u)?.[0] ?? "";
  const body = text.slice(leading.length, text.length - trailing.length);
  const closeIndex = body.lastIndexOf(SPARK_FINAL_CLOSE);
  const openIndex = closeIndex >= 0 ? body.lastIndexOf(SPARK_FINAL_OPEN, closeIndex) : -1;
  if (openIndex >= 0) {
    return body.slice(openIndex + SPARK_FINAL_OPEN.length, closeIndex).trim();
  }
  for (let tailLength = 0; tailLength <= 4; tailLength += 1) {
    for (let separatorLength = 0; separatorLength <= 4; separatorLength += 1) {
      const repeatedLength = body.length - separatorLength - tailLength;
      if (repeatedLength < 24 || repeatedLength % 2 !== 0) continue;
      const unitLength = repeatedLength / 2;
      const first = body.slice(0, unitLength);
      const separator = body.slice(unitLength, unitLength + separatorLength);
      const second = body.slice(unitLength + separatorLength, body.length - tailLength);
      if (separator.trim() === "" && first === second) return `${leading}${first}${trailing}`;
    }
  }
  return text;
}

/** Hermes can finish an ACP prompt with end_turn while its user-visible text
 * is only the empty-response explainer. Continue on the same ACP session so
 * the successful tool results remain available. Two bounded stages avoid an
 * infinite loop: first permit necessary follow-up tools, then require a best-
 * effort answer from evidence already collected. */
export function hermesEmptyReplyRecovery(
  text: string,
  modelId: string | undefined,
  attempt: number,
): string | null {
  if (!isSparkHermesModel(modelId) || !HERMES_EMPTY_REPLY.test(text.trim())) return null;
  if (attempt === 0) {
    return [
      "OpenMaus recovery: your previous internal pass completed tool calls but emitted no user-visible answer.",
      "Continue from the tool results already present in this same session; do not restart broad discovery.",
      "Use another tool only when it is strictly necessary to finish the user's task.",
      SPARK_FINAL_CONTRACT,
    ].join(" ");
  }
  if (attempt === 1) {
    return [
      "OpenMaus final recovery: stop calling tools and answer now using the evidence already collected.",
      "Provide the most useful complete result possible and state any missing evidence plainly.",
      SPARK_FINAL_CONTRACT,
    ].join(" ");
  }
  return null;
}

export function hermesTerminalAssistantFailure(
  text: string,
  modelId: string | undefined,
): string | null {
  return isSparkHermesModel(modelId) && HERMES_EMPTY_REPLY.test(text.trim())
    ? "empty_response"
    : null;
}

function nonEmptyDotenvValue(text: string, name: string): string | null {
  const match = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=[ \\t]*([^\\r\\n]*)$`, "m").exec(text);
  if (!match) return null;
  const raw = match[1].trim();
  if (!raw || raw.startsWith("#")) return null;
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    const closing = raw.indexOf(quote, 1);
    if (closing < 0) return null;
    const trailing = raw.slice(closing + 1).trim();
    if (trailing && !trailing.startsWith("#")) return null;
    return raw.slice(1, closing).trim() || null;
  }
  return raw.replace(/[ \t]+#.*$/, "").trim() || null;
}

const HERMES_HOSTED_PROVIDER_KEYS = [
  "OPENROUTER_API_KEY",
  "GLM_API_KEY",
  "ZAI_API_KEY",
  "Z_AI_API_KEY",
] as const;

const HERMES_LOCAL_CONFIG_PROVIDERS = new Set(["custom", "lmstudio", "ollama", "vllm", "llamacpp"]);

function yamlString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Read the model/provider forms accepted by Hermes' `_normalize_root_model_keys`:
 * a scalar `model`, or a mapping whose id is `default`, `model`, or `name`.
 * Those id fields may themselves be `{ provider, model/default }` mappings.
 * An explicit outer provider wins, except `auto`, where the nested provider is
 * the more specific routing choice. Root-level `provider` is Hermes' legacy
 * fallback. YAML parsing also handles quotes and trailing comments correctly.
 */
function hermesConfigDefault(text: string): { model: string; provider: string } | null {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const config = raw as Record<string, unknown>;
  const rootProvider = yamlString(config.provider);
  if (typeof config.model === "string") {
    const model = config.model.trim();
    return model ? { model, provider: rootProvider } : null;
  }
  if (!config.model || typeof config.model !== "object" || Array.isArray(config.model)) return null;

  const modelConfig = config.model as Record<string, unknown>;
  const outerProvider = yamlString(modelConfig.provider) || rootProvider;
  for (const key of ["default", "model", "name"] as const) {
    const candidate = modelConfig[key];
    const scalar = yamlString(candidate);
    if (scalar) return { model: scalar, provider: outerProvider };
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const nested = candidate as Record<string, unknown>;
    const nestedModel = yamlString(nested.model) || yamlString(nested.default);
    if (!nestedModel) continue;
    const nestedProvider = yamlString(nested.provider);
    const provider = !outerProvider || outerProvider === "auto" ? nestedProvider || outerProvider : outerProvider;
    return { model: nestedModel, provider };
  }
  return null;
}

/** Detect whether Hermes has a hosted provider configured.
 *
 * Hermes supports multiple auth methods:
 * - OpenRouter API key in `~/.hermes/.env` (OPENROUTER_API_KEY)
 * - Nous Portal OAuth (tokens stored in `~/.hermes/` — the default for
 *   `hermes setup` / `hermes login`)
 * - Z.AI / GLM keys in `~/.hermes/.env`
 *
 * Previously only OPENROUTER_API_KEY was checked, so a Nous Portal user
 * — logged in via OAuth, no OpenRouter key — saw "No local models found"
 * despite Hermes being installed, authenticated, and serving 100+ models.
 *
 * Read-only on purpose. `ensureHermesInjectProvider` writes `config.yaml`,
 * and doing that from a catalog probe would rewrite the user's real Hermes
 * config as a side effect of opening a menu.
 *
 * Returns null when no hosted provider is configured, which leaves the
 * catalog exactly as it was for local-only setups.
 */
export function hermesConfiguredModel(
  env: Record<string, string | undefined> = process.env,
): { id: string; label: string; custom: true } | null {
  const dir = hermesHome(env);
  let secrets = "";
  try {
    secrets = readFileSync(join(dir, ".env"), "utf8");
  } catch {
    /* .env may not exist — check OAuth below */
  }

  const hasHostedProviderKey = HERMES_HOSTED_PROVIDER_KEYS.some((name) => nonEmptyDotenvValue(secrets, name));

  // `hermes login` / `hermes setup` records the selected default in
  // config.yaml while the OAuth token lives in Hermes' auth store. An explicit
  // local/custom provider must not trigger the hosted catalog probe.
  let configuredDefault: { model: string; provider: string } | null = null;
  try {
    configuredDefault = hermesConfigDefault(readFileSync(join(dir, "config.yaml"), "utf8"));
  } catch {
    /* config may not exist or may be unreadable */
  }

  const configuredProvider = configuredDefault?.provider.toLowerCase() ?? "";
  // The model/provider selected in config.yaml is the user's explicit routing
  // choice. A stale hosted key must not override an explicitly local setup.
  const configIsLocal =
    HERMES_LOCAL_CONFIG_PROVIDERS.has(configuredProvider) || configuredProvider.startsWith("custom:");
  if (configuredDefault && configIsLocal) return null;

  const configIsHosted = configuredDefault !== null;
  if (!hasHostedProviderKey && !configIsHosted) return null;

  const model = configuredDefault?.model ?? "";
  // `custom: true` is not cosmetic. ModelPicker renders a custom-only agent's
  // *custom* pane exclusively, and that pane lists only options carrying this
  // flag; anything without it lands in the "official" bucket the pane never
  // shows. Omitting it puts the option in the API response while leaving the
  // picker saying "No local models found" — present, but unselectable.
  return {
    id: HERMES_CONFIG_MODEL_ID,
    label: model ? `${model} (Hermes config)` : "Hermes default (config)",
    custom: true as const,
  };
}

/** Ask a short-lived `hermes acp` session what models it can actually run.
 *
 * Hermes advertises its full catalog on `session/new` — every model its
 * configured providers expose, ids shaped `openrouter:qwen/qwen3.8-max`. There
 * is no `hermes models` subcommand, so a throwaway session is the only way to
 * read it, and it is worth the spawn: without it the picker can only offer
 * locally injected hosts, which is a fraction of what the user is paying for.
 *
 * Failure is non-fatal and returns [] — a catalog probe must never be the
 * reason an agent becomes unselectable.
 */
async function fetchHermesAcpModels(
  cli: string,
  env: Record<string, string | undefined>,
): Promise<{ id: string; label: string; custom: true }[]> {
  return await new Promise((resolve) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(cli, ["acp"], { stdio: ["pipe", "pipe", "pipe"], env: env as NodeJS.ProcessEnv });
    } catch {
      return resolve([]);
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
    const done = (out: { id: string; label: string; custom: true }[]) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        if (child.kill()) {
          hardKillTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* already gone */
            }
          }, 1_000);
          hardKillTimer.unref?.();
        }
      } catch {
        /* already gone */
      }
      resolve(out);
    };
    timer = setTimeout(() => done([]), 5_000);
    child.once("error", () => done([]));
    child.once("close", () => {
      if (hardKillTimer) clearTimeout(hardKillTimer);
      done([]);
    });

    const stdout = new BoundedJsonLineDecoder(CATALOG_NDJSON_LIMITS);
    let id = 0;
    const send = (method: string, params: unknown) => {
      id += 1;
      try {
        if (!child.stdin?.writable) {
          done([]);
          return 0;
        }
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
          if (error) done([]);
        });
      } catch {
        done([]);
        return 0;
      }
      return id;
    };
    let initId = 0;
    let sessionId = 0;
    child.stdout?.on("data", (chunk) => {
      try {
        for (const { value } of stdout.push(chunk)) {
          const msg: any = value;
          if (msg?.id === initId) {
            if (!msg.result) return done([]);
            sessionId = send("session/new", { cwd: env.HOME || env.USERPROFILE || homedir(), mcpServers: [] });
          } else if (sessionId && msg?.id === sessionId) {
            const list = Array.isArray(msg.result?.models?.availableModels)
              ? msg.result.models.availableModels
              : [];
            done(
              list
                .filter((m: any) => typeof m?.modelId === "string" && m.modelId)
                .map((m: any) => ({
                  id: m.modelId as string,
                  // Hermes labels these "OpenRouter · <model>"; keep its wording.
                  label: (typeof m.name === "string" && m.name.trim()) || (m.modelId as string),
                  custom: true as const,
                })),
            );
          }
        }
      } catch {
        done([]);
      }
    });
    initId = send("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
  });
}

async function resolveModels(
  env: Record<string, string | undefined>,
  config?: { cli?: string },
): Promise<ModelCatalog> {
  const catalog = await mergeLocalInject(EMPTY, env);
  const configured = hermesConfiguredModel(env);
  // Only probe when a hosted provider is configured; a local-only install has
  // nothing to gain from the spawn.
  const remote = configured ? await fetchHermesAcpModels(config?.cli || "hermes", env) : [];
  const seen = new Set<string>();
  const options = [...(configured ? [configured] : []), ...remote, ...catalog.options].filter((o) => {
    if (seen.has(o.id)) return false;
    seen.add(o.id);
    return true;
  });
  return { default: options[0]?.id ?? "", options };
}

async function applySetting(
  request: (method: string, params: unknown, timeoutMs?: number) => Promise<any>,
  method: string,
  params: Record<string, unknown>,
  what: string,
) {
  try {
    await request(method, params);
  } catch (e) {
    throw new Error(`Hermes rejected ${what} via ${method}: ${(e as Error).message}`);
  }
}

const support: AcpSupport = {
  driverKind: "hermesAgent",
  displayName: "Hermes",
  access: "custom",
  models: EMPTY,
  resolveModels: (env: Record<string, string | undefined>, config: any) => resolveModels(env, config),
  resolveTurnModel: (model, env) => {
    if (!model) return model;
    ensureHermesInjectProvider(model, env);
    return model;
  },
  defaultCli: "hermes",
  nativeSource: "hermes.acp",
  loginNote: "Hermes CLI is not installed",
  install: {
    command: {
      darwin: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
      linux: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
      win32: "iex (irm https://hermes-agent.nousresearch.com/install.ps1)",
    },
    docsUrl: "https://hermes-agent.nousresearch.com/docs/getting-started/quickstart",
    signInCommand: "hermes setup",
  },
  spawnArgs: () => ["acp"],
  transformEnv: (env) => {
    // A leftover OPENAI_API_KEY makes Hermes auto-resolve to OpenRouter and
    // send no Authorization header. ACP also reloads ~/.hermes/.env, so the
    // named custom provider + session/set_model is the real route.
    delete env.OPENAI_API_KEY;
    delete env.OPENROUTER_API_KEY;
  },
  prepareTurnEnv: (env, { turn, config }) => {
    discardTurnPolicyProof(turn.threadId);
    const sourceHome = hermesHome(env);
    // Hermes runs in the host OS process, not a per-turn OS sandbox. Native
    // terminal/file/browser tools would therefore expose the Razer host and
    // the model-provider credentials Hermes itself needs in its private .env,
    // even when Computer is Off. Every OpenMaus-managed Hermes turn is
    // restricted; mounted MCPs are the only computer/Ian Brain authorities.
    const restricted = true;
    const computerMounted = Boolean(turn.integrations?.computer || turn.integrations?.localComputer);
    const injected = decodeInjectId(turn.model);
    if (injected?.host === "spark_glm" || injected?.model.toLowerCase() === "glm-5.3-flash") {
      env.OPENMAUSBOT_HERMES_SPARK_IMPLICIT_THINK = "1";
    }
    else delete env.OPENMAUSBOT_HERMES_SPARK_IMPLICIT_THINK;
    // The Ian Brain credential deny applies even when Computer is Off. The
    // official Hermes launcher strips PYTHONPATH, so every turn must bypass it
    // through the managed interpreter when one can be verified.
    const resolvedCommand = resolveCli(config.cli).command;
    const cliCandidates = findCliCandidates(resolvedCommand);
    if (cliCandidates.length === 0) cliCandidates.push(resolvedCommand);
    const managed = resolveManagedHermesPython({
      sourceHome,
      cliCandidates,
      env,
      allowDefaultLocations: isOfficialHermesLauncher(resolvedCommand, sourceHome, env),
    });
    if (managed) env.OPENMAUSBOT_HERMES_POLICY_PYTHON = managed.cli;
    const providerRuntime = providerRuntimeBase();
    const proof = prepareHermesPolicyEnvironment({
      env,
      sourceHome,
      dataDir: providerRuntime ?? DATA_DIR,
      isolationKey: turn.isolationKey || turn.threadId,
      restricted,
      computerMounted,
      ianBrain: turn.integrations?.ianBrain,
      sharedAcrossUid: Boolean(providerRuntime),
    });
    if (proof) turnPolicyProofs.set(turn.threadId, proof);
  },
  providerRuntimePaths: (_env, { turn }) => {
    const proof = turnPolicyProofs.get(turn.threadId);
    if (!proof) return [];
    return [
      { path: proof.policyDir ?? dirname(proof.path) },
      ...(proof.policyDir && proof.policyDir !== dirname(proof.path)
        ? [{ path: dirname(proof.path) }]
        : []),
      { path: proof.path, writable: true },
    ];
  },
  providerHomeImports: (env, { turn }) => {
    const proof = turnPolicyProofs.get(turn.threadId);
    // Local desktop mode uses the already-staged profile directly. Imports
    // exist only for the hardened cross-UID persistent HOME contract.
    if (!proof || !env.OMB_PROVIDER_INSTANCE_HOME) return [];
    const home = env.HOME || env.USERPROFILE;
    if (!home) throw new Error("Hermes persistent HOME is unavailable");
    const imports = [
      { source: join(proof.home, "config.yaml"), destination: ".hermes/config.yaml", replace: true },
      { source: join(proof.home, ".env"), destination: ".hermes/.env", replace: true },
      { source: join(proof.home, "auth.json"), destination: ".hermes/auth.json", replace: false },
    ].filter((item) => existsSync(item.source));
    env.HERMES_HOME = join(home, ".hermes");
    return imports;
  },
  resolveSpawnTarget: ({ cli, args, env }) => {
    const managedPython = env.OPENMAUSBOT_HERMES_POLICY_PYTHON;
    delete env.OPENMAUSBOT_HERMES_POLICY_PYTHON;
    return managedPython
      ? { cli: managedPython, args: ["-m", "hermes_cli.main", ...args] }
      : { cli, args };
  },
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
  async configureSession({ request, sessionId, turn }) {
    const proof = turnPolicyProofs.get(turn.threadId);
    if (proof) {
      turnPolicyProofs.delete(turn.threadId);
      verifyHermesPolicyProof(proof);
    } else {
      throw new Error("Hermes containment policy was not prepared; refusing to send the prompt");
    }
    // Decode only — resolveTurnModel already wrote the named provider using
    // the instance HOME. Calling ensure* again here would hit process.env
    // and rewrite the user's real ~/.hermes/config.yaml.
    const native = hermesAcpModelId(turn.model);
    if (!native) return;
    await applySetting(
      request,
      "session/set_model",
      { sessionId, modelId: native },
      `model "${native}"`,
    );
  },
  buildPromptText: buildHermesPromptText,
  normalizeAssistantText: (text, turn) => normalizeHermesAssistantText(text, turn.model),
  // A terminal Hermes warning must never flash in the chat before the same
  // session gets its bounded recovery prompt. Tool and reasoning events still
  // stream; only Spark's final assistant text is deferred until settlement.
  deferAssistantText: (turn) => isSparkHermesModel(turn.model),
  recoverAssistantText: (text, turn, attempt) => hermesEmptyReplyRecovery(text, turn.model, attempt),
  terminalAssistantFailure: (text, turn) => hermesTerminalAssistantFailure(text, turn.model),
  discardAssistantTextBeforeTool: (_text, turn) => isSparkHermesModel(turn.model),
};

export const HermesAgentDriver = createAcpDriver(support);
