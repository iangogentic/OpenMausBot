// Claude driver — upstream ClaudeDriver skeleton over agentcal's
// drivers/claude.js runtime (stream-json both directions, prompt over
// stdin, completion from a real `result` event — verified against
// claude 2.1.211 by agentcal). Per-turn CLI process; the conversation
// continues across turns via --resume <sessionId> (the resumeCursor).
//
// Integrations become MCP servers on the CLI:
//   - Composio Sessions (connected apps → tools) over streamable HTTP
//   - the bot's cloud computer (box.ascii.dev) via server/computer-proxy.ts
//     — screenshot/exec/open_url, the CUA-on-the-box bridge
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { DATA_DIR } from "../config.ts";
import { augmentedPath } from "../env-path.ts";
import { providerChildEnvironment } from "../provider-child-env.ts";
import {
  brokerSocketPath,
  describeSpawnFailure,
  execCli,
  killCliTree,
  spawnCli,
  terminateCliTree,
} from "../procs.ts";

import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { computerProxyEnv } from "../container-computer.ts";
import { newEventId, newId } from "../contracts.ts";
import { classifyError, computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "./retry.ts";
import {
  applyClaudeInject,
  applyModelRelayEnvironment,
  decodeInjectId,
  mergeLocalInject,
  probeLocalInjects,
  resolveInjectId,
} from "./local-inject.ts";
import { appendNative } from "./native.ts";
import {
  BoundedJsonLineDecoder,
  PERMISSION_NDJSON_LIMITS,
  ProviderOutputLimitError,
} from "./bounded-json-lines.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import {
  createProviderTempDirectory,
  providerRuntimeBase,
  providerRuntimeSocketBase,
  publishProviderRuntimeSocket,
  writeProviderRuntimeFile,
} from "../provider-runtime.ts";

/** Whether `claude` has been signed in.
 *
 * Credential storage is deliberately not inspected here. Claude Code uses the
 * macOS Keychain for OAuth, a JSON file on some platforms, and may gain other
 * backends over time. Presence checks also accept stale credentials. The CLI's
 * own machine-readable auth command is the source of truth for every backend.
 */
export function claudeSignedIn(
  cli: string,
  env: NodeJS.ProcessEnv,
  run: typeof execCli = execCli,
): Promise<boolean> {
  return new Promise((resolve) => {
    run(cli, ["auth", "status", "--json"], { timeout: 8000, env }, (_error, stdout) => {
      try {
        const status: unknown = JSON.parse(stdout);
        resolve(
          typeof status === "object" && status !== null && "loggedIn" in status && status.loggedIn === true,
        );
      } catch {
        resolve(false);
      }
    });
  });
}

/** The CLI environment shared by auth probes and real turns.
 *
 * Subscription users can be billed pay-as-you-go if an inherited API key
 * leaks through, and a nested CLI must not inherit this session's identity.
 * Keeping the probe and turn environments identical prevents setup from
 * claiming an API-key login that the turn itself would deliberately remove.
 */
function claudeEnvironment(
  model?: string | null,
  explicit: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env = providerChildEnvironment(explicit, {
    internal: { PATH: augmentedPath(), NPM_CONFIG_LOGLEVEL: "error" },
  });
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const applied = applyClaudeInject(env, model);
  if (!applied.injected) delete env.ANTHROPIC_API_KEY;
  return env;
}

const DRIVER_KIND = "claudeAgent";

export interface ClaudeConfig {
  cli: string;
  permissionMode: "acceptEdits" | "auto" | "bypassPermissions";
  /** Available Claude built-ins. An empty list passes `--tools ""`. */
  tools?: string[];
  /** Claude tool patterns to deny after the available set is selected. */
  disallowedTools?: string[];
}

// model catalog ported from upstream packages/contracts/src/model.ts
export const STATIC_CLAUDE_MODELS: ModelCatalog = {
  default: "claude-sonnet-5",
  options: [
    { id: "claude-fable-5", label: "Claude Fable 5" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
};

const CLAUDE_MODEL_ID = /^[a-z0-9][a-z0-9._:/-]*$/i;

/** Rewrite a leftover API slug (`orcarouter/Qwen…`) to `host::model` when a
 *  local host is serving it, so the turn injects instead of asking for /login.
 *  Official cloud ids and already-encoded inject ids skip the probe. */
async function resolveClaudeTurnModel(
  model: string | null | undefined,
  env: Record<string, string | undefined>,
): Promise<string | null | undefined> {
  if (!model || decodeInjectId(model) || STATIC_CLAUDE_MODELS.options.some((option) => option.id === model)) {
    return model;
  }
  return resolveInjectId(model, await probeLocalInjects(env)) ?? model;
}

function claudeConfigDir(env: Record<string, string | undefined>): string {
  if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR;
  return join(env.HOME || env.USERPROFILE || homedir(), ".claude");
}

function extrasFromUnknown(value: unknown): Array<{ id: string; label: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") {
      return CLAUDE_MODEL_ID.test(item) ? [{ id: item, label: item }] : [];
    }
    if (!item || typeof item !== "object") return [];
    const row = item as { id?: unknown; model?: unknown; slug?: unknown; name?: unknown; displayName?: unknown; label?: unknown };
    const id = [row.id, row.model, row.slug].find((candidate): candidate is string => typeof candidate === "string");
    if (!id || !CLAUDE_MODEL_ID.test(id)) return [];
    const label = [row.name, row.displayName, row.label].find((candidate): candidate is string => typeof candidate === "string");
    return [{ id, label: label || id }];
  });
}

/** Extra ids from ~/.claude/settings.json. Official cloud rows stay untagged.
 *  `model` is Claude Code's last-used slug, not a catalog — listing it as
 *  Custom put a non-inject id in the picker and the turn then had no
 *  ANTHROPIC_API_KEY ("Not logged in · Please run /login"). Live injects
 *  come from mergeLocalInject. */
export function readClaudeModelCatalog(env: Record<string, string | undefined> = process.env) {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(join(claudeConfigDir(env), "settings.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return STATIC_CLAUDE_MODELS;
  }

  const extras = [
    ...extrasFromUnknown(settings.availableModels),
    ...extrasFromUnknown(settings.customModels),
    ...extrasFromUnknown(settings.extraModels),
  ];
  const nestedEnv = settings.env && typeof settings.env === "object" ? (settings.env as Record<string, unknown>) : {};
  const envModel = nestedEnv.ANTHROPIC_MODEL ?? env.ANTHROPIC_MODEL;
  if (typeof envModel === "string") extras.push(...extrasFromUnknown([envModel]));

  const options = STATIC_CLAUDE_MODELS.options.map((option) => ({ ...option }));
  const seen = new Set(options.map((option) => option.id));
  for (const extra of extras) {
    if (seen.has(extra.id)) continue;
    seen.add(extra.id);
    options.push({ id: extra.id, label: extra.label, custom: true });
  }
  return { default: STATIC_CLAUDE_MODELS.default, options };
}

// Resolved from the server root, never relative to this file: bundling inlines
// this module into an entry one directory up, so a `".."` here would climb too
// far. See server/proxy-paths.ts.
const PROXY_PATH = SPAWNED_PROXIES.computer;
const PERM_PROXY_PATH = SPAWNED_PROXIES.permission;
const DWEB_PROXY_PATH = SPAWNED_PROXIES.dweb;
// in the packaged app process.execPath is the Electron binary — this env
// makes it behave as plain node for the spawned MCP proxies (harmless in dev)
const NODE_ENV_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

// ── permission broker (ported from agentcal drivers/claude.js) ─────────
// A headless run that hits a permission acceptEdits doesn't cover should
// neither stall silently NOR get blanket-denied — it should ask the user.
// The broker is a net server on a per-turn socket; the proxy (spawned by
// the claude CLI) forwards asks over it and waits. Unanswered permission
// asks deny after timeoutMs with a keep-moving note; unanswered questions
// answer with "use your best judgment" — guidance, never a block.
interface Ask {
  id: string;
  kind: "permission" | "question";
  tool: string;
  input: Record<string, unknown>;
  at: number;
}
type AskBehavior = "allow" | "deny" | "answer";
type AskResolutionSource = "user" | "timeout" | "system";

const DENY_TIMEOUT_NOTE =
  "OpenMausBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";
const QUESTION_TIMEOUT_NOTE = "OpenMausBot: nobody answered in time. Use your best judgment and continue.";
const DUPLICATE_ASK_ID_NOTE = "OpenMausBot: duplicate ask id — skipping this request.";

/** The system-source reply for an ask that outlives the turn — used both to
 * drain in-flight `pending` asks on close() and to answer one that arrives
 * on an already-closed broker (see the `closed` branch below). */
function systemEndedReply(kind: Ask["kind"]): { behavior: AskBehavior; message: string } {
  return kind === "question"
    ? { behavior: "answer", message: "OpenMausBot: the turn is ending — wrap up." }
    : { behavior: "deny", message: "OpenMausBot: the turn ended" };
}

/** One human-readable line for an ask — what the card subtitle shows. */
function askSummary(ask: Ask): string {
  const input = ask.input ?? {};
  if (typeof input.question === "string") return input.question.slice(0, 300);
  if (typeof input.command === "string") return input.command.slice(0, 200);
  if (typeof input.url === "string") return input.url.slice(0, 200);
  const text = JSON.stringify(input);
  return text === "{}" ? (ask.tool ?? "tool") : text.slice(0, 200);
}

export function permissionSocketPath(threadId: string) {
  // A readable prefix alone is not unique: ids that agree on their first
  // characters ("t-perm-dup-1", "t-perm-dup-2") would share a socket. A
  // 16-bit suffix also collides surprisingly quickly in a fleet, so use a
  // 64-bit digest of the full id. The POSIX directory layout keeps this well
  // below sun_path on the supported deployment and normal desktop data roots.
  const prefix = threadId.replace(/[^\w-]/g, "").slice(0, 4);
  const digest = createHash("sha256").update(threadId).digest("hex").slice(0, 16);
  if (process.platform === "win32") {
    return brokerSocketPath(providerRuntimeSocketBase(DATA_DIR), `${prefix}${digest}`);
  }
  // The OS sandbox can mount an exact directory FD but cannot reopen an
  // O_PATH Unix-socket FD. Give each thread a tiny server-owned directory so
  // mounting the broker never exposes sibling runtime artifacts.
  // macOS has a very small sockaddr_un path limit. DATA_DIR may sit below a
  // long test/user home, so the non-isolated desktop fallback uses a short
  // per-process namespace in the OS temp directory. The production runtime
  // root is already short, canonical, and server-owned.
  const runtimeBase = providerRuntimeBase();
  const fallbackBase = join(
    tmpdir(),
    `ombp-${process.pid}-${createHash("sha256").update(DATA_DIR).digest("hex").slice(0, 8)}`,
  );
  return join(runtimeBase ?? fallbackBase, `p-${digest}`, "s");
}

function preparePermissionSocketDirectory(socketPath: string): void {
  if (process.platform === "win32") return;
  const directory = dirname(socketPath);
  const sharedAcrossUid = Boolean(providerRuntimeBase());
  try {
    mkdirSync(directory, { recursive: true, mode: sharedAcrossUid ? 0o2750 : 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(directory);
  // A configured cross-UID runtime root is a security boundary and is
  // required to be canonical by providerRuntimeBase(). In ordinary desktop
  // and test mode DATA_DIR can legitimately live below macOS's /var ->
  // /private/var alias; rejecting that platform alias breaks every local
  // Claude turn without buying any isolation. We still reject a symlink at
  // the per-turn directory itself in both modes.
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (sharedAcrossUid && realpathSync(directory) !== directory)
  ) {
    throw new Error("permission broker directory is not a canonical directory");
  }
  chmodSync(directory, sharedAcrossUid ? 0o2750 : 0o700);
}

function createPermissionBroker(opts: {
  socketPath: string;
  onAsk: (ask: Ask) => void;
  onResolve: (resolved: Ask & { behavior: AskBehavior; source: AskResolutionSource }) => void;
  isActive?: () => boolean;
  onViolation?: (error: Error) => void;
  timeoutMs?: number;
}) {
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const pending = new Map<
    string,
    { ask: Ask; finish: (behavior: AskBehavior, message: string | undefined, source: AskResolutionSource) => void }
  >();
  // server.close() only stops accepting NEW connections — it does not touch
  // a connection that's already open. A still-alive child's MCP proxy can
  // keep sending asks on such a connection after the turn has ended, and
  // this handler stays fully wired to it. Without this flag those asks would
  // become new `pending` entries and `request.opened` cards for a turn the
  // driver already forgot (`active.delete(threadId)` already ran), which can
  // never be answered — the "zombie card" in issue #211.
  let closed = false;
  let violated = false;
  let liveConnections = 0;
  let totalInputBytes = 0;
  let totalInputFrames = 0;
  let rateWindowStartedAt = Date.now();
  let rateWindowFrames = 0;
  const violate = (error: Error) => {
    if (violated) return;
    violated = true;
    opts.onViolation?.(error);
  };
  preparePermissionSocketDirectory(opts.socketPath);
  try {
    unlinkSync(opts.socketPath);
  } catch {}
  const server = createNetServer((conn) => {
    conn.on("error", () => {});
    liveConnections += 1;
    let connectionClosed = false;
    conn.on("close", () => {
      if (connectionClosed) return;
      connectionClosed = true;
      liveConnections -= 1;
    });
    if (violated || liveConnections > 4) {
      conn.destroy();
      violate(new ProviderOutputLimitError("frame_rate", "permission broker accepted too many simultaneous connections"));
      return;
    }
    const input = new BoundedJsonLineDecoder(PERMISSION_NDJSON_LIMITS);
    let rejected = false;
    conn.on("data", (chunk) => {
      if (rejected) return;
      try {
        totalInputBytes += Buffer.byteLength(chunk);
        if (totalInputBytes > PERMISSION_NDJSON_LIMITS.maxTotalBytes) {
          throw new ProviderOutputLimitError(
            "total_bytes",
            `permission broker exceeded ${PERMISSION_NDJSON_LIMITS.maxTotalBytes} bytes`,
          );
        }
        const framesBefore = input.framesSeen;
        const decoded = input.push(chunk);
        const acceptedFrames = input.framesSeen - framesBefore;
        totalInputFrames += acceptedFrames;
        if (totalInputFrames > PERMISSION_NDJSON_LIMITS.maxFrames) {
          throw new ProviderOutputLimitError(
            "frame_count",
            `permission broker exceeded ${PERMISSION_NDJSON_LIMITS.maxFrames} frames`,
          );
        }
        const now = Date.now();
        if (now - rateWindowStartedAt >= PERMISSION_NDJSON_LIMITS.frameWindowMs) {
          rateWindowStartedAt = now;
          rateWindowFrames = 0;
        }
        rateWindowFrames += acceptedFrames;
        if (rateWindowFrames > PERMISSION_NDJSON_LIMITS.maxFramesPerWindow) {
          throw new ProviderOutputLimitError(
            "frame_rate",
            `permission broker exceeded ${PERMISSION_NDJSON_LIMITS.maxFramesPerWindow} frames per window`,
          );
        }
        for (const { value } of decoded) {
          const msg: any = value;
        if (msg.t !== "ask") continue;
        const askId = String(msg.id ?? newId());
        const kind = msg.kind === "question" ? ("question" as const) : ("permission" as const);
        if (closed) {
          // Closure is terminal and takes precedence over every active-turn
          // rule, including duplicate-id rejection. Never register a pending
          // entry or notify onAsk, but always answer an existing connection:
          // permission-proxy.ts only resolves on an explicit answer (or a
          // connection error/close), so a silent drop would hang the tool.
          try {
            conn.write(JSON.stringify({ t: "answer", id: askId, ...systemEndedReply(kind) }) + "\n");
          } catch {}
          continue;
        }
        // A retained Claude process keeps its proxy connection between
        // turns. Late/background asks must still fail closed without opening
        // a card for a turn that has already settled.
        if (opts.isActive && !opts.isActive()) {
          try {
            conn.write(JSON.stringify({ t: "answer", id: askId, ...systemEndedReply(kind) }) + "\n");
          } catch {}
          continue;
        }
        // `pending` is server-scoped, not per-connection: two asks with the
        // same id — a buggy/adversarial client, never a legitimate retry
        // (permission-proxy mints a fresh randomUUID per ask) — would
        // otherwise let the second `pending.set` silently overwrite the
        // first, orphaning it as an unanswerable card once the first
        // resolves and deletes the shared key. Reject before either ask
        // becomes visible to onAsk.
        if (pending.has(askId)) {
          // askId is client-controlled; JSON.stringify escapes newlines and
          // control characters so it can't corrupt the log line or terminal.
          console.error(`permission broker on ${opts.socketPath}: duplicate ask id ${JSON.stringify(askId)} — denying`);
          try {
            conn.write(JSON.stringify({ t: "answer", id: askId, behavior: "deny", message: DUPLICATE_ASK_ID_NOTE }) + "\n");
          } catch {}
          continue;
        }
        const ask: Ask = { id: askId, kind, tool: msg.tool ?? "tool", input: msg.input ?? {}, at: Date.now() };
        const finish = (behavior: AskBehavior, message: string | undefined, source: AskResolutionSource) => {
          if (!pending.delete(askId)) return;
          clearTimeout(timer);
          try {
            conn.write(JSON.stringify({ t: "answer", id: askId, behavior, message }) + "\n");
          } catch {}
          opts.onResolve({ ...ask, behavior, source });
        };
        const timer = setTimeout(
          () =>
            kind === "question"
              ? finish("answer", QUESTION_TIMEOUT_NOTE, "timeout")
              : finish("deny", DENY_TIMEOUT_NOTE, "timeout"),
          timeoutMs,
        );
        timer.unref?.();
        pending.set(askId, { ask, finish });
        opts.onAsk(ask);
        }
      } catch (error) {
        rejected = true;
        conn.destroy();
        violate(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
  // A broker that never came up used to be silent — every approval then
  // timed out into a deny nobody could explain. Keep the turn fail-closed,
  // but leave an actionable diagnostic.
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  server.on("error", (error) => {
    console.error(`permission broker unavailable on ${opts.socketPath}: ${error.message}`);
    rejectReady(error);
  });
  server.listen(opts.socketPath, () => {
    try {
      publishProviderRuntimeSocket(opts.socketPath);
      resolveReady();
    } catch (error) {
      server.close();
      rejectReady(error as Error);
    }
  });
  const drain = () => {
    for (const p of [...pending.values()]) {
      const { behavior, message } = systemEndedReply(p.ask.kind);
      p.finish(behavior, message, "system");
    }
  };
  return {
    ready,
    answer(askId: string, behavior: AskBehavior, message?: string): boolean {
      const p = pending.get(askId);
      if (!p) return false;
      if (p.ask.kind === "question" ? behavior !== "answer" : behavior === "answer") return false;
      p.finish(behavior, message, "user");
      return true;
    },
    pause() {
      drain();
    },
    close() {
      closed = true;
      drain();
      try {
        server.close();
      } catch {}
      try {
        unlinkSync(opts.socketPath);
      } catch {}
      if (process.platform !== "win32") {
        try {
          rmSync(dirname(opts.socketPath), { recursive: false, force: true });
        } catch {}
      }
    },
  };
}

function decodeToolList(value: unknown, field: "tools" | "disallowedTools"): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`claude: ${field} must be an array of non-empty strings`);
  const decoded: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`claude: ${field} must be an array of non-empty strings`);
    }
    const normalized = entry.trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    decoded.push(normalized);
  }
  return decoded;
}

function decodeConfig(raw: unknown): ClaudeConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const mode = o.permissionMode;
  if (mode !== undefined && mode !== "acceptEdits" && mode !== "auto" && mode !== "bypassPermissions") {
    throw new Error(`claude: invalid permissionMode ${JSON.stringify(mode)}`);
  }
  const tools = decodeToolList(o.tools, "tools");
  const disallowedTools = decodeToolList(o.disallowedTools, "disallowedTools");
  return {
    cli: typeof o.cli === "string" ? o.cli : "claude",
    permissionMode: (mode as ClaudeConfig["permissionMode"]) ?? "acceptEdits",
    ...(tools !== undefined ? { tools } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
  };
}

function firstText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === "text" && b.text)
      .map((b) => b.text)
      .join("");
  }
  return "";
}

export const ClaudeDriver: ProviderDriver<ClaudeConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Claude", supportsMultipleInstances: true },
  // npm on all three: the one recipe that is genuinely cross-platform. The
  // native installers differ per OS and would need verifying separately.
  install: {
    command: {
      darwin: "npm install -g @anthropic-ai/claude-code",
      linux: "npm install -g @anthropic-ai/claude-code",
      win32: "npm install -g @anthropic-ai/claude-code",
    },
    needsNode: true,
    docsUrl: "https://claude.com/claude-code",
    signInCommand: "claude",
  },
  models: STATIC_CLAUDE_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<ClaudeConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    // A hardened provider process owns the per-bot HOME flock for its whole
    // lifetime. It must be reaped before terminal/idle is published, or a
    // second task for the same bot would collide with the retained process.
    const isolatedProviderLifetime = Boolean(input.environment.OMB_PROVIDER_INSTANCE_HOME);
    // Deterministic integration-test seam for Stop and provider disposal: a
    // positive file counter fails before shutdown, while a negative one fails
    // after the child exits. The latter reproduces a terminal event clearing
    // visible busy state before the caller learns that shutdown proof failed.
    // This is disabled outside NODE_ENV=test and exposes no production API.
    const fixtureInterruptFailureFile = process.env.NODE_ENV === "test"
      ? input.environment.FAKE_CLAUDE_INTERRUPT_FAILURE_FILE
      : undefined;
    const fixtureShutdownFailure = (): "before" | "after" | null => {
      if (!fixtureInterruptFailureFile) return null;
      let remaining = 0;
      try {
        remaining = Number(readFileSync(fixtureInterruptFailureFile, "utf8")) || 0;
      } catch {
        return null;
      }
      if (remaining === 0) return null;
      writeFileSync(fixtureInterruptFailureFile, String(remaining + (remaining < 0 ? 1 : -1)));
      return remaining < 0 ? "after" : "before";
    };
    const catalogEnv = claudeEnvironment(undefined, input.environment);
    let models = STATIC_CLAUDE_MODELS;
    const refreshModels = async () => {
      try {
        const resolved = await mergeLocalInject(readClaudeModelCatalog(catalogEnv), catalogEnv);
        if (resolved.options.length) models = resolved;
      } catch {
        // Keep the last usable catalog when settings.json is unreadable.
      }
    };
    await refreshModels();
    const listeners = new Set<RuntimeEventListener>();
    // one active turn per thread; a second send while busy is a caller bug
    const active = new Map<string, {
      stop: () => Promise<void>;
      turnId: string;
      broker?: ReturnType<typeof createPermissionBroker>;
    }>();

    // One live CLI process per thread, kept across turns. Under
    // --input-format stream-json the CLI settles a turn with `result` while
    // stdin stays open, takes the next user message on the same stdin as a
    // new turn, and folds a message that arrives MID-turn into the running
    // one before its next model call (verified against 2.1.221 — that fold
    // is what "steer" is). So a session is spawned once, reused while its
    // spawn contract (args, MCP config, cwd, model) is unchanged, closed
    // after SESSION_IDLE_MS of quiet, and resumed by --resume when needed.
    interface Session {
      child: ReturnType<typeof spawnCli>;
      broker?: ReturnType<typeof createPermissionBroker>;
      mcpConfigPath: string | null;
      /** the spawn contract — a different one means a fresh process */
      argsKey: string;
      /** the CLI's session id from `init`, what --resume takes later */
      sessionId: string | null;
      /** the running turn, or null between turns */
      turn: { turnId: string; settled: boolean; sawStreamDelta: boolean } | null;
      idleTimer: ReturnType<typeof setTimeout> | null;
      closing: boolean;
      stderr: string;
    }
    const sessions = new Map<string, Session>();
    const configuredIdleMinimum = Number(process.env.OMB_CLAUDE_SESSION_IDLE_MIN_MS);
    const sessionIdleMinimum = Number.isFinite(configuredIdleMinimum) && configuredIdleMinimum > 0
      ? configuredIdleMinimum
      : 10_000;
    const SESSION_IDLE_MS = Math.max(sessionIdleMinimum, Number(process.env.OMB_CLAUDE_SESSION_IDLE_MS) || 10 * 60_000);

    const closeSession = (threadId: string, why: string) => {
      const s = sessions.get(threadId);
      if (!s || s.closing) return;
      s.closing = true;
      if (s.idleTimer) clearTimeout(s.idleTimer);
      // Broker ownership belongs to this session. Detach and close it now,
      // before a replacement can bind the same per-thread socket; the old
      // child's later close event must never unlink a new broker.
      const broker = s.broker;
      s.broker = undefined;
      broker?.close();
      appendNative(threadId, { dir: "out", source: "claude.session", msg: { close: why } });
      // stdin EOF is the CLI's exit signal; give it a moment, then insist
      try {
        s.child.stdin.end();
      } catch {}
      const kill = setTimeout(() => {
        if (s.child.exitCode === null) killCliTree(s.child);
      }, 5_000);
      kill.unref?.();
    };
    const armIdle = (threadId: string) => {
      const s = sessions.get(threadId);
      if (!s) return;
      if (s.idleTimer) clearTimeout(s.idleTimer);
      s.idleTimer = setTimeout(() => closeSession(threadId, "idle"), SESSION_IDLE_MS);
      s.idleTimer.unref?.();
    };
    const writeUser = (s: Session, threadId: string, text: string): Promise<boolean> => {
      const promptMsg = { type: "user", message: { role: "user", content: text } };
      if (!s.child.stdin.writable || s.child.stdin.destroyed) return Promise.resolve(false);
      return new Promise((resolve) => {
        try {
          s.child.stdin.write(JSON.stringify(promptMsg) + "\n", (error) => {
            if (error) return resolve(false);
            appendNative(threadId, { dir: "out", source: "claude.sdk.message", msg: promptMsg });
            resolve(true);
          });
        } catch {
          resolve(false);
        }
      });
    };

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });
    // retry bookkeeping lives PER THREAD, not per sendTurn call: a relaunch
    // is a fresh sendTurn, and the attempt cap must survive across launches
    const retryState = new Map<string, { attempt: number; cancelled: boolean }>();

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
      if (controlsHost && config.permissionMode === "bypassPermissions") {
        throw new Error("local computer control requires the interactive approval broker");
      }
      const turnId = turn.turnId ?? newId();
      const retryAbort = new AbortController();
      const retry = retryState.get(threadId) ?? { attempt: 0, cancelled: false };
      retry.cancelled = false;
      retryState.set(threadId, retry);
      // a retry relaunches the whole CLI; the backoff is scaled down in tests
      // so a fake's transient failures don't stall real seconds
      const retryScale = Number(process.env.FAKE_CLAUDE_RETRY_SCALE ?? "1");
      const sessionId = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
      const newSessionId = sessionId ? null : newId();

      const args = [
        "-p",
        "--output-format", "stream-json",
        "--input-format", "stream-json",
        "--verbose", // required by stream-json output
        // token-level streaming: content_block_delta events between the
        // whole-message frames, so the bubble grows as the model writes
        "--include-partial-messages",
        "--permission-mode", config.permissionMode === "auto" ? "acceptEdits" : config.permissionMode,
      ];
      if (config.tools !== undefined) args.push("--tools", config.tools.join(","));
      if (config.disallowedTools?.length) {
        args.push("--disallowedTools", config.disallowedTools.join(","));
      }
      const turnEnvironment = claudeEnvironment(undefined, input.environment);
      const turnModel = await resolveClaudeTurnModel(turn.model, turnEnvironment);
      applyModelRelayEnvironment(turnEnvironment, turnModel, turn.integrations?.modelRelay);
      const injected = applyClaudeInject(turnEnvironment, turnModel);
      if (injected.model) args.push("--model", injected.model);
      if (turn.effort) args.push("--effort", turn.effort);
      if (turn.system) args.push("--append-system-prompt", turn.system);

      // integrations → MCP servers; pre-allow their tools (a headless
      // acceptEdits run silently denies anything unlisted)
      const mcpServers: Record<string, unknown> = {};
      const allowed: string[] = [];
      if (turn.integrations?.composio) {
        mcpServers.composio = { ...turn.integrations.composio };
        allowed.push("mcp__composio");
      }
      if (turn.integrations?.computerOperator) {
        mcpServers.computer_operator = { ...turn.integrations.computerOperator };
        allowed.push("mcp__computer_operator");
      }
      if (!turn.integrations?.computerOperator && turn.integrations?.computer) {
        mcpServers.computer = {
          command: process.execPath,
          args: [PROXY_PATH],
          env: { ...NODE_ENV_FLAG, ...computerProxyEnv(turn.integrations.computer) },
        };
        allowed.push("mcp__computer");
      } else if (!turn.integrations?.computerOperator && turn.integrations?.localComputer) {
        const local = turn.integrations.localComputer;
        mcpServers.computer = {
          command: local.command,
          args: local.args,
          env: local.env,
        };
        // The isolated Local VM preserves the established pre-allow behavior.
        // Host tools always route through OpenMausBot's permission broker.
        if (!controlsHost) allowed.push("mcp__computer");
      }
      // peer-agent comms (list_bots/ask_bot) — the harness builds the whole
      // spawn contract (command/args/env incl. the boot token) in
      // agentsIntegration(); pre-allowing matters doubly here, or the CLI's
      // own ListAgents look-alike shadows it and "@Bot" asks go nowhere
      if (turn.integrations?.agents) {
        mcpServers.agents = { ...turn.integrations.agents };
        allowed.push("mcp__agents");
      }
      if (turn.integrations?.ianBrain) {
        mcpServers.ian_brain = {
          command: process.execPath,
          args: [SPAWNED_PROXIES.ianBrain],
          env: {
            ...NODE_ENV_FLAG,
            OMB_IAN_BRAIN_URL: turn.integrations.ianBrain.url,
            OMB_IAN_BRAIN_CAPABILITY_TOKEN: turn.integrations.ianBrain.token,
          },
        };
        allowed.push("mcp__ian_brain");
      }
      if (turn.integrations?.phone) {
        mcpServers.phone = { ...turn.integrations.phone };
        allowed.push("mcp__phone");
      }
      // dweb network daemon (status / repo / opencode model access) via
      // server/drivers/dweb-proxy.ts — points at the configured dweb instance
      if (turn.integrations?.dweb) {
        mcpServers.dweb = {
          command: process.execPath,
          args: [DWEB_PROXY_PATH],
          env: {
            ...NODE_ENV_FLAG,
            DWEB_URL: turn.integrations.dweb.url,
          },
        };
        allowed.push("mcp__dweb");
      }
      // permission broker: anything acceptEdits would silently deny becomes
      // an Allow/Deny card in chat, and the agent gets ask_user. Skipped in
      // bypassPermissions (fullAuto) — nothing would ever ask.
      let broker: ReturnType<typeof createPermissionBroker> | undefined;
      // Wired after the exact session exists. The broker is ready before its
      // child can connect, so no provider byte can reach this placeholder.
      let rejectProviderOutput: (error: Error) => void = () => {};
      let socketPath: string | null = null;
      if (config.permissionMode !== "bypassPermissions") {
        socketPath = permissionSocketPath(threadId);
        args.push("--permission-prompt-tool", "mcp__ogb__approve");
        mcpServers.ogb = { command: process.execPath, args: [PERM_PROXY_PATH, socketPath], env: { ...NODE_ENV_FLAG } };
        allowed.push("mcp__ogb");
      }
      // The MCP config carries credentials — a Composio consumer key in a
      // header, the box token in the computer proxy's env, the comms token in
      // the agents proxy's env. On argv every one of those is world-readable
      // through `ps` for the life of the turn, to any local process. The CLI
      // accepts a FILE for this flag, so the secrets go in a 0600 file that
      // is removed when the turn settles.
      let mcpConfigPath: string | null = null;
      if (Object.keys(mcpServers).length) {
        const runtime = createProviderTempDirectory("omb-mcp-");
        mcpConfigPath = writeProviderRuntimeFile(runtime, "mcp.json", JSON.stringify({ mcpServers }));
        args.push("--mcp-config", mcpConfigPath);
        // A dedicated operator turn must not inherit user/global MCP servers
        // (especially another computer tool) alongside its exact-turn proxy.
        if (turn.integrations?.computerOperator) args.push("--strict-mcp-config");
        args.push("--allowedTools", allowed.join(","));
      }

      const env = turnEnvironment;
      const cwd = turn.cwd ?? homedir();
      // everything that shapes the process, minus session/turn specifics
      // (the --mcp-config file is a fresh temp path each time; its CONTENT
      // is what matters and mcpServers carries that)
      const keyArgs = args.filter((a, i) => a !== "--mcp-config" && args[i - 1] !== "--mcp-config");
      const argsKey = JSON.stringify({
        args: keyArgs,
        mcpServers,
        cwd,
        model: injected.model ?? null,
        base: env.ANTHROPIC_BASE_URL ?? null,
        // An exact-turn relay token must never be reused by a retained Claude
        // process. Including it in the spawn contract forces a clean resume on
        // the next turn even though the relay URL and selected model are equal.
        modelRelayToken: turn.integrations?.modelRelay?.token ?? null,
        // bwrap mounts are immutable for the life of this retained process.
        // A new exact-turn attachment directory therefore changes the spawn
        // contract and forces a resumed replacement instead of writing an
        // inaccessible staged path to the old process's stdin.
        providerRuntimePaths: turn.providerRuntimePaths ?? [],
      });

      // Reuse the live process when it is idle, unchanged, and is the session
      // the harness wants resumed. Anything else: close it and spawn fresh
      // (with --resume, so the conversation continues in the new process).
      const live = sessions.get(threadId);
      if (live && !live.turn && !live.closing && live.child.exitCode === null && live.argsKey === argsKey && (!sessionId || sessionId === live.sessionId)) {
        if (live.idleTimer) clearTimeout(live.idleTimer);
        live.turn = { turnId, settled: false, sawStreamDelta: false };
        active.set(threadId, { stop: () => terminateCliTree(live.child), turnId, broker: live.broker });
        emit({ ...base(threadId, turnId), type: "turn.started" });
        const written = await writeUser(live, threadId, turn.text);
        if (!written) {
          active.delete(threadId);
          live.turn = null;
          closeSession(threadId, "stdin write failed");
          throw new Error("claude session stdin is not writable");
        }
        // the MCP config was for the first spawn; nothing to clean here
        if (mcpConfigPath) {
          try {
            rmSync(dirname(mcpConfigPath), { recursive: true, force: true });
          } catch {}
        }
        return { turnId };
      }
      if (live) closeSession(threadId, "spawn contract changed");

      // Only create a broker for a new process. A compatible retained process
      // keeps its existing proxy connection and broker across turns.
      if (socketPath) {
        // remembers which tool each pending ask came from, so the resolved
        // event can scope approvals to real desktop-control tools only
        const askTools = new Map<string, string | undefined>();
        broker = createPermissionBroker({
          socketPath,
          isActive: () => Boolean(sessions.get(threadId)?.turn),
          onViolation: (error) => rejectProviderOutput(error),
          onAsk: (ask) => {
            const eventTurnId = sessions.get(threadId)?.turn?.turnId ?? turnId;
            askTools.set(ask.id, typeof ask.tool === "string" ? ask.tool : undefined);
            emit({
              ...base(threadId, eventTurnId),
              type: "request.opened",
              requestId: ask.id,
              requestType: ask.kind,
              tool: ask.tool,
              summary: askSummary(ask),
              approvalScope:
                typeof ask.tool === "string" && controlsHost && ask.tool.startsWith("mcp__computer")
                  ? "local-computer"
                  : undefined,
              choices: Array.isArray(ask.input?.choices) ? (ask.input.choices as string[]).slice(0, 5) : undefined,
            });
          },
          onResolve: (resolved) => {
            const eventTurnId = sessions.get(threadId)?.turn?.turnId ?? turnId;
            emit({
              ...base(threadId, eventTurnId),
              type: "request.resolved",
              requestId: resolved.id,
              behavior: resolved.behavior,
              source: resolved.source,
              approvalScope:
                controlsHost && typeof askTools.get(resolved.id) === "string" && askTools.get(resolved.id)!.startsWith("mcp__computer") ? "local-computer" : undefined,
            });
            askTools.delete(resolved.id);
          },
        });
        await broker.ready;
      }
      if (sessionId) args.push("--resume", sessionId);
      else args.push("--session-id", newSessionId!);

      const child = spawnCli(config.cli, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        providerRuntimePaths: [
          ...(turn.providerRuntimePaths ?? []),
          ...(mcpConfigPath ? [{ path: dirname(mcpConfigPath) }] : []),
          ...(socketPath && process.platform !== "win32" ? [{ path: dirname(socketPath) }] : []),
        ],
        providerPersistentHome: {
          ownerKey: turn.isolationKey ?? threadId,
        },
      });
      const session: Session = {
        child,
        broker,
        mcpConfigPath,
        argsKey,
        sessionId: sessionId ?? newSessionId,
        turn: { turnId, settled: false, sawStreamDelta: false },
        idleTimer: null,
        closing: false,
        stderr: "",
      };
      sessions.set(threadId, session);

      type TerminalOutcome = {
        turnId: string;
        ok: boolean;
        stopReason: string | null;
        cost: number | null;
        usage?: { input: number; output: number };
      };
      let pendingAttachmentTerminal: TerminalOutcome | null = null;
      let attachmentTeardown: Promise<void> | null = null;
      const finishTerminal = (outcome: TerminalOutcome, retainSession: boolean) => {
        active.delete(threadId);
        session.turn = null;
        // A settled turn owns no retry budget. Retained CLI sessions may run
        // many later turns on this thread, and each must start fresh.
        retryState.delete(threadId);
        emit({
          ...base(threadId, outcome.turnId),
          type: "turn.completed",
          ok: outcome.ok,
          stopReason: outcome.stopReason,
          cost: outcome.cost,
          ...(outcome.usage ? { usage: outcome.usage } : {}),
        });
        if (retainSession && session.child.exitCode === null && !session.closing) armIdle(threadId);
      };
      const finishAttachmentTerminal = () => {
        const outcome = pendingAttachmentTerminal;
        if (!outcome) return;
        pendingAttachmentTerminal = null;
        if (sessions.get(threadId) === session) sessions.delete(threadId);
        finishTerminal(outcome, false);
      };
      let providerOutputShutdown: Promise<void> | null = null;
      rejectProviderOutput = (error) => {
        const t = session.turn;
        if (!t || t.settled || providerOutputShutdown) return;
        t.settled = true;
        session.closing = true;
        retry.cancelled = true;
        retryAbort.abort();
        retryState.delete(threadId);
        emit({ ...base(threadId, t.turnId), type: "runtime.error", message: error.message });
        session.broker?.pause();
        const heldBroker = session.broker;
        session.broker = undefined;
        heldBroker?.close();
        if (session.mcpConfigPath) {
          try {
            rmSync(dirname(session.mcpConfigPath), { recursive: true, force: true });
          } catch {}
          session.mcpConfigPath = null;
        }
        const outcome = { turnId: t.turnId, ok: false, stopReason: "provider_output_limit", cost: null };
        const attempt = terminateCliTree(session.child)
          .then(() => {
            if (sessions.get(threadId) === session) sessions.delete(threadId);
            finishTerminal(outcome, false);
          })
          .catch((shutdownError) => {
            if (providerOutputShutdown === attempt) providerOutputShutdown = null;
            emit({
              ...base(threadId, t.turnId),
              type: "runtime.error",
              message: `provider output was rejected but shutdown could not be verified: ${shutdownError instanceof Error ? shutdownError.message : String(shutdownError)}`,
            });
          });
        providerOutputShutdown = attempt;
      };
      const proveAttachmentSessionStopped = (): Promise<void> => {
        if (!pendingAttachmentTerminal) return Promise.resolve();
        if (attachmentTeardown) return attachmentTeardown;
        const attempt = terminateCliTree(session.child)
          .then(() => finishAttachmentTerminal())
          .catch((error) => {
            if (attachmentTeardown === attempt) attachmentTeardown = null;
            throw error;
          });
        attachmentTeardown = attempt;
        return attempt;
      };

      // Settles the TURN. Ordinary turns retain the process until the idle
      // timer, but a process that received an exact-turn attachment mount is
      // reaped before its terminal event. Unlinking the host staging path
      // alone would leave the deleted inode readable through bwrap's still-
      // live bind mount.
      const settle = (
        ok: boolean,
        stopReason: string | null,
        cost: number | null = null,
        usage?: { input: number; output: number },
      ) => {
        const t = session.turn;
        if (!t || t.settled) return;
        t.settled = true;
        // Resolve any ask still open for this turn, but keep the broker
        // listening for the next turn on the retained process. Between turns
        // isActive() rejects late background asks without creating cards.
        session.broker?.pause();
        // the config file holds live credentials — the CLI read it at start;
        // it must not sit on disk for the life of the session
        if (session.mcpConfigPath) {
          try {
            rmSync(dirname(session.mcpConfigPath), { recursive: true, force: true });
          } catch {}
          session.mcpConfigPath = null;
        }
        const outcome = { turnId: t.turnId, ok, stopReason, cost, ...(usage ? { usage } : {}) };
        if (turn.providerRuntimePaths?.length || isolatedProviderLifetime) {
          pendingAttachmentTerminal = outcome;
          session.closing = true;
          const heldBroker = session.broker;
          session.broker = undefined;
          heldBroker?.close();
          void proveAttachmentSessionStopped().catch((error) => {
            emit({
              ...base(threadId, t.turnId),
              type: "runtime.error",
              message: `provider session shutdown could not be verified: ${error instanceof Error ? error.message : String(error)}`,
            });
          });
          return;
        }
        finishTerminal(outcome, true);
      };
      const currentTurnId = () => session.turn?.turnId ?? turnId;

      const handleLine = (line: string) => {
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          return;
        }
        appendNative(threadId, { dir: "in", source: "claude.sdk.message", msg: o });
        switch (o.type) {
          case "system":
            if (o.subtype === "init") {
              if (typeof o.session_id === "string") session.sessionId = o.session_id;
              emit({ ...base(threadId, currentTurnId()), type: "session.started", sessionId: o.session_id, model: o.model });
            } else if (o.subtype === "thinking_tokens") {
              emit({ ...base(threadId, currentTurnId()), type: "item.updated", itemType: "reasoning", tokens: o.estimated_tokens });
            }
            break;
          case "stream_event": {
            // subagent narration is dropped — N parallel Tasks would
            // interleave their prose into one bubble (upstream-verified bug)
            if (o.parent_tool_use_id) break;
            const ev = o.event ?? {};
            if (ev.type !== "content_block_delta") break;
            const d = ev.delta ?? {};
            if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
              if (session.turn) session.turn.sawStreamDelta = true;
              emit({ ...base(threadId, currentTurnId()), type: "content.delta", streamKind: "assistant_text", delta: d.text });
            } else if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking) {
              emit({ ...base(threadId, currentTurnId()), type: "content.delta", streamKind: "reasoning_text", delta: d.thinking });
            }
            break;
          }
          case "assistant": {
            const msg = o.message ?? {};
            const text = firstText(msg.content);
            if (text.trim()) {
              // fallback delta for CLIs/paths that never streamed the block
              if (!session.turn?.sawStreamDelta) {
                emit({ ...base(threadId, currentTurnId()), type: "content.delta", streamKind: "assistant_text", delta: text });
              }
              if (session.turn) session.turn.sawStreamDelta = false;
              emit({ ...base(threadId, currentTurnId()), type: "item.completed", itemType: "assistant_text", text });
            }
            for (const b of Array.isArray(msg.content) ? msg.content : []) {
              if (b.type === "tool_use") {
                emit({ ...base(threadId, currentTurnId()), type: "item.started", itemType: "tool", itemId: b.id, title: b.name });
              }
            }
            if (msg.usage) {
              emit({
                ...base(threadId, currentTurnId()),
                type: "thread.token-usage.updated",
                input: (msg.usage.input_tokens || 0) + (msg.usage.cache_read_input_tokens || 0),
                output: msg.usage.output_tokens || 0,
              });
            }
            break;
          }
          case "user":
            for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
              if (b.type === "tool_result") {
                emit({ ...base(threadId, currentTurnId()), type: "item.completed", itemType: "tool", itemId: b.tool_use_id, ok: !b.is_error });
              }
            }
            break;
          case "result":
            // result.usage is this invocation's total — one process per turn,
            // so it is the turn's figure. cache reads count as input: they
            // are billed (at the cache rate) and they fill the window.
            settle(
              o.is_error !== true,
              o.stop_reason ?? o.terminal_reason ?? null,
              o.total_cost_usd ?? null,
              o.usage
                ? {
                    input: (o.usage.input_tokens || 0) + (o.usage.cache_read_input_tokens || 0) + (o.usage.cache_creation_input_tokens || 0),
                    output: o.usage.output_tokens || 0,
                  }
                : undefined,
            );
            break;
        }
      };

      const stdout = new BoundedJsonLineDecoder();
      let outputRejected = false;
      child.stdout.on("data", (chunk) => {
        if (outputRejected) return;
        try {
          for (const { line } of stdout.push(chunk)) handleLine(line);
        } catch (error) {
          outputRejected = true;
          rejectProviderOutput(error instanceof Error ? error : new Error(String(error)));
        }
      });

      child.stderr.on("data", (c) => {
        session.stderr += c;
        if (session.stderr.length > 8192) session.stderr = session.stderr.slice(-8192);
      });

      child.on("error", (e) => {
        emit({ ...base(threadId, currentTurnId()), type: "runtime.error", ...describeSpawnFailure(e, config.cli) });
        settle(false, "spawn_error");
      });

      child.on("close", (code) => {
        // a turn still running when the process died is a failed turn; a
        // process that exited between turns (idle close, contract change)
        // is just a session ending
        if (session.turn && !session.turn.settled) {
          const message = `claude exited ${code} before result${session.stderr ? `: ${session.stderr.trim().slice(-300)}` : ""}`;
          const verdict = classifyError({ exitCode: code, stderr: message });
          if (
            !retry.cancelled &&
            code !== 0 &&
            verdict.transient &&
            !session.turn.sawStreamDelta &&
            retry.attempt < RETRY_MAX_ATTEMPTS - 1
          ) {
            // the CLI is gone but the TURN continues: keep the thread busy,
            // emit no terminal event, and relaunch after the backoff. The
            // `active` entry STAYS — it is what makes an interrupt during
            // the backoff reach this turn's stop() and cancel the retry.
            const failedBroker = session.broker;
            session.broker = undefined;
            failedBroker?.pause();
            failedBroker?.close();
            if (session.mcpConfigPath) {
              try {
                rmSync(dirname(session.mcpConfigPath), { recursive: true, force: true });
              } catch {}
              session.mcpConfigPath = null;
            }
            sessions.delete(threadId);
            session.turn = null;
            retry.attempt++;
            const delayMs = computeBackoff(retry.attempt - 1);
            emit({
              ...base(threadId, turnId),
              type: "turn.retrying",
              attempt: retry.attempt,
              delayMs,
              reason: verdict.reason,
            });
            void (async () => {
              const wait = interruptibleDelay(delayMs * retryScale, retryAbort.signal);
              await wait.promise;
              // an interrupt during the backoff landed here via stop(); the
              // turn settles as interrupted and no zombie relaunch happens
              if (retry.cancelled) {
                active.delete(threadId);
                retryState.delete(threadId);
                emit({
                  ...base(threadId, turnId),
                  type: "turn.completed",
                  ok: false,
                  stopReason: "interrupted",
                  cost: null,
                });
                return;
              }
              // hand the thread back before recursing — the relaunch's own
              // guard would otherwise reject it as "already running"
              active.delete(threadId);
              try {
                const cursor = session.sessionId ?? sessionId ?? undefined;
                await sendTurn({ ...turn, resumeCursor: cursor });
              } catch (e) {
                retryState.delete(threadId);
                emit({
                  ...base(threadId, turnId),
                  type: "runtime.error",
                  message: e instanceof Error ? e.message : String(e),
                });
                emit({
                  ...base(threadId, turnId),
                  type: "turn.completed",
                  ok: false,
                  stopReason: "exit_before_result",
                  cost: null,
                });
              }
            })();
            return;
          }
          retryState.delete(threadId);
          emit({
            ...base(threadId, currentTurnId()),
            type: "runtime.error",
            message,
          });
          settle(false, "exit_before_result");
        }
        if (session.idleTimer) clearTimeout(session.idleTimer);
        session.broker?.close();
        if (session.mcpConfigPath) {
          try {
            rmSync(dirname(session.mcpConfigPath), { recursive: true, force: true });
          } catch {}
        }
        if (sessions.get(threadId) === session) sessions.delete(threadId);
      });

      const stop = async () => {
        retry.cancelled = true;
        retryAbort.abort();
        await terminateCliTree(child);
        // A result-bearing attachment turn deliberately withholds its
        // terminal event until process-tree teardown is proven. Stop/dispose
        // may be the successful retry after an earlier bounded proof failure.
        finishAttachmentTerminal();
      };
      active.set(threadId, { stop, turnId, broker });
      emit({ ...base(threadId, turnId), type: "turn.started" });

      // prompt over stdin as a stream-json message — never argv (ARG_MAX).
      // stdin stays OPEN: that is what keeps the session alive for a
      // mid-turn steer or the next turn; closeSession() ends it.
      if (!(await writeUser(session, threadId, turn.text))) {
        settle(false, "stdin_write_failed");
        closeSession(threadId, "stdin write failed");
      }

      return { turnId };
    };

    /** A user message into the running turn: the CLI delivers it before its
     * next model call. False when nothing is running here to steer. */
    const steer = async (threadId: string, text: string): Promise<boolean> => {
      const s = sessions.get(threadId);
      if (!s || !s.turn || s.turn.settled || s.closing || s.child.exitCode !== null) return false;
      return writeUser(s, threadId, text);
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const env = claudeEnvironment(undefined, input.environment);
      const version = await new Promise<string | null>((resolve) => {
        execCli(config.cli, ["--version"], { timeout: 8000, env }, (err, stdout) =>
          resolve(err ? null : stdout.trim()),
        );
      });
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      const authenticated = await claudeSignedIn(config.cli, env);
      // claudeEnvironment strips ANTHROPIC_API_KEY, so turns run on the
      // CLI's own login (Pro/Max): the cost it reports is what the call
      // WOULD bill, not a charge
      return { state: "available", version, authenticated, billing: "subscription" };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return models;
      },
      refreshModels,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: {
          sessionModelSwitch: "in-session",
          agentsMcp: true,
          computerMcp: true,
          computerOperatorMcp: true,
          composioMcp: true,
          phoneMcp: true,
          images: true,
          effortLevels: ["low", "medium", "high", "xhigh", "max"],
          queueing: true,
          localComputerMcp: config.permissionMode !== "bypassPermissions",
        },
        sendTurn,
        steer,
        interruptTurn: async (threadId) => {
          const fixtureFailure = fixtureShutdownFailure();
          if (fixtureFailure === "before") throw new Error("fixture interrupt failed before shutdown proof");
          const turn = active.get(threadId);
          if (turn) await turn.stop();
          if (fixtureFailure === "after") throw new Error("fixture interrupt failed after terminal cleanup");
        },
        respondToRequest: async (threadId, requestId, decision) => {
          // fail-closed by construction: no broker, or an ask that already
          // timed out / settled, is `unavailable` — the caller denies
          const broker = sessions.get(threadId)?.broker ?? active.get(threadId)?.broker;
          if (!broker) return "unavailable";
          const behavior = decision.behavior === "answer" ? "answer" : decision.behavior;
          if (!broker.answer(requestId, behavior, decision.message)) return "unavailable";
          return behavior === "allow" ? "allowed-once" : behavior === "answer" ? "answered" : "rejected";
        },
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          const activeStops = [...active.values()].map(({ stop }) => stop());
          for (const threadId of [...sessions.keys()]) closeSession(threadId, "stopAll");
          const sessionStops = [...sessions.values()].map((session) => terminateCliTree(session.child));
          await Promise.all([...activeStops, ...sessionStops]);
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: (prompt: string) =>
        new Promise((resolve, reject) => {
          execCli(
            config.cli,
            ["-p", prompt, "--model", "claude-haiku-4-5", "--output-format", "text"],
            { timeout: 60_000, env: claudeEnvironment("claude-haiku-4-5", input.environment) },
            (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
          );
        }),
      dispose: async () => {
        const fixtureFailure = fixtureShutdownFailure();
        if (fixtureFailure === "before") throw new Error("fixture dispose failed before shutdown proof");
        const activeStops = [...active.values()].map(({ stop }) => stop());
        for (const threadId of [...sessions.keys()]) closeSession(threadId, "dispose");
        const sessionStops = [...sessions.values()].map((session) => terminateCliTree(session.child));
        await Promise.all([...activeStops, ...sessionStops]);
        if (fixtureFailure === "after") throw new Error("fixture dispose failed after terminal cleanup");
        listeners.clear();
      },
    };
  },
};
