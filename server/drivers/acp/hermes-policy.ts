// OpenMaus-owned Hermes containment.
//
// Hermes is a useful model harness, but its stock ACP surface also exposes the
// Razer host's terminal, files, browser profile, memories and prior sessions.
// A bot whose selected computer is a VM/VPS must never silently take that
// second path. Each OpenMaus bot therefore gets a private HERMES_HOME and a
// Python startup policy that leaves only explicitly mounted MCPs (plus a tiny
// network-only native surface) visible to the model.
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, win32 } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const HERMES_POLICY_VERSION = 1;
export const IAN_BRAIN_MCP_URL = "http://127.0.0.1:15050/mcp";

export interface HermesIanBrainBroker {
  url: string;
  token: string;
}

/** Mirror of the startup policy's server-prefix check, kept exported so the
 * exact names emitted by supported Hermes releases are regression-tested. */
export function hermesMcpToolMatchesServer(toolName: string, serverName: string): boolean {
  const safeName = serverName.replace(/[^A-Za-z0-9_]/g, "_");
  return toolName.startsWith(`mcp__${safeName}__`) || toolName.startsWith(`mcp_${safeName}_`);
}

/** Defense in depth for Hermes versions that honor agent.disabled_toolsets. */
export const HERMES_DISABLED_NATIVE_TOOLSETS = [
  "terminal",
  "file",
  "browser",
  "computer_use",
  "memory",
  "session_search",
  "skills",
  "code_execution",
  "delegation",
] as const;

const POLICY_FILENAME = "sitecustomize.py";

// Python imports sitecustomize automatically during interpreter startup. The
// process exits if the policy cannot be installed; Python's usual behaviour of
// printing-and-ignoring a sitecustomize exception is not acceptable here.
//
// Current Hermes MCP tools are namespaced as mcp__<server>__<tool>; retain
// the older mcp_<server>_<tool> spelling for mixed-version deployments. Native tools are
// allowlisted, rather than trying to keep up with every new host-capable tool
// Hermes may add. The bridge helpers can only discover/call the already scoped
// MCP catalog. web_search is provider-backed and todo is ephemeral. Native
// web_extract is intentionally excluded: upstream can be configured to fetch
// localhost/private URLs, which would become a host-network escape.
export const HERMES_POLICY_PYTHON = String.raw`"""OpenMaus Hermes ACP containment. Installed and verified per turn."""
import json
import os
import sys
import traceback

_ACTIVE = os.environ.get("OPENMAUSBOT_HERMES_POLICY") == "1"
_RESTRICT_NATIVE = os.environ.get("OPENMAUSBOT_HERMES_RESTRICT_NATIVE") == "1"
_ALLOWED_NATIVE = frozenset({
    "web_search", "todo",
    "tool_search", "tool_describe", "tool_call",
})
_DENIED_MCP_PREFIXES = (
    "mcp__ian_brain__creds_",
    "mcp__ian_brain__mcp_ian_brain_creds_",
    "mcp_ian_brain_creds_",
    "mcp_ian_brain_mcp_ian_brain_creds_",
)


def _mcp_server_prefixes(server_name):
    safe_name = "".join(ch if (ch.isalnum() or ch == "_") else "_" for ch in server_name)
    return ("mcp__" + safe_name + "__", "mcp_" + safe_name + "_")


def _has_mcp_server_tool(names, server_name):
    prefixes = _mcp_server_prefixes(server_name)
    return any(
        isinstance(name, str) and any(name.startswith(prefix) for prefix in prefixes)
        for name in names
    )


def _allowed_tool(name):
    return (
        isinstance(name, str)
        and not any(name.startswith(prefix) for prefix in _DENIED_MCP_PREFIXES)
        and (
            not _RESTRICT_NATIVE
            or name.startswith("mcp_")
            or name in _ALLOWED_NATIVE
        )
    )


def _filter_definitions(definitions):
    safe = []
    for item in definitions or []:
        try:
            name = item.get("function", {}).get("name")
        except Exception:
            name = None
        if _allowed_tool(name):
            safe.append(item)
    return safe


def _install():
    import model_tools

    original_definitions = model_tools.get_tool_definitions
    original_dispatch = model_tools.handle_function_call

    def guarded_definitions(*args, **kwargs):
        return _filter_definitions(original_definitions(*args, **kwargs))

    def guarded_dispatch(function_name, *args, **kwargs):
        if not _allowed_tool(function_name):
            return json.dumps({
                "error": "OpenMaus policy blocked a Hermes-native host tool; use the mounted MCP tools."
            })
        return original_dispatch(function_name, *args, **kwargs)

    model_tools.get_tool_definitions = guarded_definitions
    model_tools.handle_function_call = guarded_dispatch

    # SessionManager imports AIAgent after startup. Patch its constructor now
    # so no SOUL/AGENTS/project rule, native memory provider, or context file is
    # loaded before the tool catalog is filtered.
    import run_agent
    original_init = run_agent.AIAgent.__init__

    def guarded_agent_init(self, *args, **kwargs):
        if _RESTRICT_NATIVE:
            disabled = set(kwargs.get("disabled_toolsets") or [])
            disabled.update({
                "terminal", "file", "browser", "computer_use", "memory",
                "session_search", "skills", "code_execution", "delegation",
            })
            kwargs["disabled_toolsets"] = sorted(disabled)
            kwargs["skip_context_files"] = True
            kwargs["skip_memory"] = True
            kwargs["load_soul_identity"] = False
        result = original_init(self, *args, **kwargs)
        self.tools = _filter_definitions(getattr(self, "tools", []))
        self.valid_tool_names = {
            item.get("function", {}).get("name")
            for item in self.tools
            if _allowed_tool(item.get("function", {}).get("name"))
        }
        return result

    run_agent.AIAgent.__init__ = guarded_agent_init

    # Hermes normally logs and swallows a failed ACP MCP registration, then
    # lets the model run without the computer it was promised. Turn that into
    # a session/new failure and assert the post-registration raw catalog. Tool
    # Search may collapse schemas in the model-facing list, so inspect the raw
    # scoped definitions here.
    from acp_adapter.server import HermesACPAgent
    original_register_mcp = HermesACPAgent._register_session_mcp_servers

    async def guarded_register_mcp(self, state, mcp_servers):
        await original_register_mcp(self, state, mcp_servers)
        # Hermes may collapse the model-facing MCP catalog into its native
        # tool_search schema. Prove required servers against the authoritative
        # connected registry, not that compressed snapshot.
        from tools.mcp_tool import _existing_tool_names
        registered_names = set(_existing_tool_names())
        raw = guarded_definitions(
            enabled_toolsets=getattr(state.agent, "enabled_toolsets", None),
            disabled_toolsets=getattr(state.agent, "disabled_toolsets", None),
            quiet_mode=True,
            skip_tool_search_assembly=True,
        )
        names = {
            item.get("function", {}).get("name")
            for item in raw
            if isinstance(item, dict)
        }
        names.update(registered_names)
        unexpected = sorted(name for name in names if not _allowed_tool(name))
        if unexpected:
            raise RuntimeError("OpenMaus Hermes policy catalog contained forbidden tools")
        required = {
            item.strip() for item in
            os.environ.get("OPENMAUSBOT_HERMES_REQUIRED_MCP", "").split(",")
            if item.strip()
        }
        for server_name in sorted(required):
            if not _has_mcp_server_tool(names, server_name):
                visible = ",".join(sorted(
                    name for name in registered_names if isinstance(name, str)
                ))[:1000]
                raise RuntimeError(
                    "OpenMaus required MCP server '" + server_name
                    + "' exposed no tools (registered: " + visible + ")"
                )

    HermesACPAgent._register_session_mcp_servers = guarded_register_mcp

    proof = os.environ.get("OPENMAUSBOT_HERMES_POLICY_PROOF", "")
    nonce = os.environ.get("OPENMAUSBOT_HERMES_POLICY_NONCE", "")
    if not proof or not nonce:
        raise RuntimeError("OpenMaus Hermes policy proof variables are missing")
    # The harness pre-creates this exact regular file. In cross-UID mode the
    # surrounding policy directory is server-owned and not provider-writable,
    # so creating a sibling temporary and replacing it would (correctly) fail.
    # O_NOFOLLOW keeps a compromised provider profile from redirecting proof.
    flags = os.O_WRONLY | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(proof, flags)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump({
            "version": 1,
            "nonce": nonce,
            "pid": os.getpid(),
            "restrict_native": _RESTRICT_NATIVE,
            "allowed_native": sorted(_ALLOWED_NATIVE),
        }, stream)
    # The privileged cross-UID launcher temporarily owns this exact policy
    # leaf while Hermes is alive. Restore group traversal/readability only on
    # the nonce-bound proof after writing it so the server can verify the
    # loaded policy before sending the prompt. The policy module itself stays
    # mode 0600 and the directory remains non-listable to the runtime group.
    if os.environ.get("OPENMAUSBOT_HERMES_POLICY_SHARED") == "1":
        os.chmod(proof, 0o640)
        os.chmod(os.path.dirname(proof), 0o710)
        stream.flush()
        os.fsync(stream.fileno())


if _ACTIVE:
    try:
        _install()
    except BaseException:
        traceback.print_exc(file=sys.stderr)
        os._exit(78)
`;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function pick(source: JsonObject, keys: readonly string[]): JsonObject {
  const out: JsonObject = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

/**
 * Keep model routing and the explicitly approved Ian Brain connection, while
 * dropping global Hermes plugins, hooks, host MCPs, identities and tool config.
 */
export function sanitizeHermesConfig(
  text: string,
  restricted = true,
  ianBrainBroker?: HermesIanBrainBroker,
): string {
  let parsed: unknown = {};
  try {
    parsed = parseYaml(text) ?? {};
  } catch {
    parsed = {};
  }
  const source = object(parsed) ?? {};
  const safe = pick(source, [
    "_config_version",
    "model",
    "provider",
    "providers",
    "fallback_providers",
    "credential_pool_strategies",
    "bedrock",
    "openrouter",
    "model_catalog",
    "network",
    "compression",
    "context",
    "prompt_caching",
    "smart_model_routing",
    "streaming",
    "tool_loop_guardrails",
    "tool_output",
    "max_concurrent_sessions",
    "logging",
  ]);

  const sourceAgent = object(source.agent) ?? {};
  const agent = pick(sourceAgent, [
    "max_turns",
    "api_max_retries",
    "service_tier",
    "reasoning_effort",
    "tool_use_enforcement",
    "task_completion_guidance",
    "parallel_tool_call_guidance",
  ]);
  const existingDisabled = Array.isArray(sourceAgent.disabled_toolsets)
    ? sourceAgent.disabled_toolsets.filter((item): item is string => typeof item === "string")
    : [];
  agent.disabled_toolsets = restricted
    ? [...new Set([...existingDisabled, ...HERMES_DISABLED_NATIVE_TOOLSETS])].sort()
    : existingDisabled;
  agent.coding_context = "off";
  agent.environment_probe = false;
  safe.agent = agent;

  const toolSearch = object(object(source.tools)?.tool_search);
  if (toolSearch) safe.tools = { tool_search: toolSearch };

  const configuredMcps = object(source.mcp_servers);
  const ianBrain = configuredMcps ? object(configuredMcps.ian_brain) : null;
  if (ianBrain && ianBrainBroker) {
    // Presence is the only source-controlled bit. Never preserve command,
    // args, env, alternate URL, or headers from a host Hermes config: a
    // malicious named stdio server would otherwise inherit the trusted
    // mcp_ian_brain_* tool prefix inside the policy.
    safe.mcp_servers = {
      ian_brain: {
        url: ianBrainBroker.url,
        headers: { Authorization: `Bearer ${ianBrainBroker.token}` },
        enabled: true,
      },
    };
  }

  return stringifyYaml(safe, { lineWidth: 0 });
}

const HERMES_DOTENV_ALLOWLIST = new Set([
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "CEREBRAS_API_KEY",
  "SAMBANOVA_API_KEY",
  "COHERE_API_KEY",
]);

/** Copy only explicitly supported model/Ian Brain variables. A suffix such as
 * TOKEN/PASSWORD is not authority: unrelated host secrets must stay out. */
export function sanitizeHermesDotenv(text: string, sanitizedConfig: string): string {
  const referenced = new Set<string>();
  for (const match of sanitizedConfig.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) referenced.add(match[1]!);
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match) continue;
    const name = match[1]!;
    if (HERMES_DOTENV_ALLOWLIST.has(name) && (referenced.has(name) || name.endsWith("_API_KEY"))) {
      kept.push(line);
    }
  }
  return kept.length ? `${kept.join("\n")}\n` : "";
}

function dotenvValue(text: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${escaped}[ \\t]*=[ \\t]*([^\\r\\n]*)$`, "m").exec(text);
  if (!match) return null;
  const raw = match[1]!.trim();
  if (!raw || raw.startsWith("#")) return null;
  if (raw[0] === '"' || raw[0] === "'") {
    const quote = raw[0];
    const end = raw.indexOf(quote, 1);
    if (end < 0 || raw.slice(end + 1).trim().replace(/^#.*$/, "")) return null;
    return raw.slice(1, end) || null;
  }
  return raw.replace(/[ \\t]+#.*$/, "").trim() || null;
}

/** Read the upstream Ian Brain credential only in harness code. Presence in
 * the source config remains the user's opt-in, but no source URL/header or
 * secret is copied into the bot's isolated Hermes profile. */
export function readHermesIanBrainSource(
  sourceHome: string,
  env: Record<string, string | undefined> = process.env,
): { sourceHome: string; url: string; key: string } | null {
  let configText = "";
  try {
    configText = readFileSync(join(sourceHome, "config.yaml"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(configText);
  } catch {
    return null;
  }
  const present = Boolean(object(object(parsed)?.mcp_servers)?.ian_brain);
  if (!present) return null;
  let dotenv = "";
  try {
    dotenv = readFileSync(join(sourceHome, ".env"), "utf8");
  } catch {
    /* an environment-injected key is also supported */
  }
  const key = env.MCP_IAN_BRAIN_API_KEY?.trim() || dotenvValue(dotenv, "MCP_IAN_BRAIN_API_KEY");
  return key ? { sourceHome, url: IAN_BRAIN_MCP_URL, key } : null;
}

export function hermesIsolationHome(dataDir: string, isolationKey: string): string {
  const digest = createHash("sha256").update(isolationKey).digest("hex").slice(0, 32);
  return join(dataDir, "hermes-bots", digest);
}

function writePrivate(path: string, value: string, mode = 0o600, directoryMode = 0o700): void {
  mkdirSync(dirname(path), { recursive: true, mode: directoryMode });
  chmodSync(dirname(path), directoryMode);
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, value, { mode, flag: "wx" });
    renameSync(temporary, path);
    chmodSync(path, mode);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* renamed or never created */
    }
  }
}

function copyPrivate(source: string, destination: string, mode = 0o600, directoryMode = 0o700): void {
  try {
    const sourceStat = lstatSync(source);
    if (!sourceStat.isFile()) return;
    try {
      const destinationStat = lstatSync(destination);
      if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
        unlinkSync(destination);
        throw new Error("replace unsafe destination");
      }
      // A provider may rotate OAuth credentials inside this bot's private
      // profile. Preserve that newer copy instead of replacing it with the
      // older shared-profile token on the next turn.
      if (destinationStat.mtimeMs >= sourceStat.mtimeMs) return;
    } catch {
      /* first copy */
    }
    mkdirSync(dirname(destination), { recursive: true, mode: directoryMode });
    chmodSync(dirname(destination), directoryMode);
    copyFileSync(source, destination);
    chmodSync(destination, mode);
  } catch {
    // Hosted auth is optional. Local injected providers need no auth.json.
  }
}

export interface HermesPolicyProof {
  path: string;
  nonce: string;
  home: string;
}

export interface ManagedHermesPythonTarget {
  cli: string;
  argsPrefix: ["-m", "hermes_cli.main"];
}

/** Resolve an official managed Hermes install to its venv Python. Current
 * Hermes launch shims intentionally remove PYTHONPATH, which would bypass the
 * containment sitecustomize. We never parse or execute shim text: candidates
 * come only from the configured executable's real path, an explicit install
 * directory, and documented install locations, then must contain both the
 * venv interpreter and Hermes package/entry markers. */
export function resolveManagedHermesPython(input: {
  sourceHome: string;
  cliCandidates: string[];
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** True only for the documented/bare official launcher. An explicit custom
   * CLI must never be silently replaced by some unrelated default install. */
  allowDefaultLocations?: boolean;
  isFile?: (path: string) => boolean;
  realpath?: (path: string) => string;
}): ManagedHermesPythonTarget | null {
  const platform = input.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  const isFile = input.isFile ?? ((path: string) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
  const canonical = input.realpath ?? ((path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  });
  const roots: string[] = [];
  const addRoot = (root: string | undefined) => {
    const trimmed = root?.trim();
    if (trimmed) roots.push(pathApi.normalize(trimmed));
  };
  const rootFromCli = (candidate: string) => {
    const normalized = pathApi.normalize(canonical(candidate));
    const lowered = normalized.toLowerCase();
    const marker = platform === "win32" ? `${win32.sep}venv${win32.sep}scripts${win32.sep}` : "/venv/bin/";
    const markerIndex = lowered.lastIndexOf(marker.toLowerCase());
    if (markerIndex > 0) addRoot(normalized.slice(0, markerIndex));
    const base = pathApi.basename(lowered);
    const parent = pathApi.basename(pathApi.dirname(lowered));
    if (["hermes", "hermes.exe", "hermes.cmd", "hermes.bat"].includes(base) && parent === "bin") {
      addRoot(pathApi.dirname(pathApi.dirname(normalized)));
    }
  };

  for (const candidate of input.cliCandidates) rootFromCli(candidate);
  addRoot(input.env.HERMES_INSTALL_DIR);
  if (input.env.HERMES_INSTALL_DIR) addRoot(pathApi.join(input.env.HERMES_INSTALL_DIR, "hermes-agent"));
  if (input.allowDefaultLocations) {
    addRoot(pathApi.join(input.sourceHome, "hermes-agent"));
    const userHome = input.env.HOME || input.env.USERPROFILE;
    if (userHome) addRoot(pathApi.join(userHome, ".hermes", "hermes-agent"));
    if (platform === "win32" && input.env.LOCALAPPDATA) {
      addRoot(pathApi.join(input.env.LOCALAPPDATA, "hermes", "hermes-agent"));
    }
    if (platform !== "win32") addRoot("/usr/local/lib/hermes-agent");
  }

  for (const root of [...new Set(roots)]) {
    const python = platform === "win32"
      ? pathApi.join(root, "venv", "Scripts", "python.exe")
      : pathApi.join(root, "venv", "bin", "python");
    const consoleEntry = platform === "win32"
      ? pathApi.join(root, "venv", "Scripts", "hermes.exe")
      : pathApi.join(root, "venv", "bin", "hermes");
    const sourceMarker = pathApi.join(root, "hermes_cli", "main.py");
    if (isFile(python) && (isFile(sourceMarker) || isFile(consoleEntry))) {
      return { cli: python, argsPrefix: ["-m", "hermes_cli.main"] };
    }
  }
  return null;
}

/** Build/refresh one bot's private Hermes profile and mutate only this turn's env. */
export function prepareHermesPolicyEnvironment(input: {
  env: Record<string, string | undefined>;
  sourceHome: string;
  dataDir: string;
  isolationKey: string;
  restricted: boolean;
  computerMounted?: boolean;
  ianBrain?: HermesIanBrainBroker;
  /** Server and provider are distinct UIDs joined only by the runtime group. */
  sharedAcrossUid?: boolean;
}): HermesPolicyProof | null {
  // Sticky group-writable: Hermes can create state.db journals/logs, while a
  // sibling provider process cannot replace server-owned config/policy files.
  const directoryMode = input.sharedAcrossUid ? 0o1770 : 0o700;
  const dataMode = input.sharedAcrossUid ? 0o640 : 0o600;
  const providerWritableMode = input.sharedAcrossUid ? 0o660 : 0o600;
  const policyDirectoryMode = input.sharedAcrossUid ? 0o750 : 0o700;
  const policyFileMode = input.sharedAcrossUid ? 0o640 : 0o600;
  const home = hermesIsolationHome(input.dataDir, input.isolationKey);
  // The parent stays server-owned/non-writable. The exact bot profile is
  // writable by the provider because Hermes' SQLite database creates journal
  // files beside state.db. Native host tools are still removed by the policy
  // loaded from the separate read-only directory below.
  mkdirSync(dirname(home), { recursive: true, mode: policyDirectoryMode });
  chmodSync(dirname(home), policyDirectoryMode);
  mkdirSync(home, { recursive: true, mode: directoryMode });
  chmodSync(home, directoryMode);

  let sourceConfig = "";
  try {
    sourceConfig = readFileSync(join(input.sourceHome, "config.yaml"), "utf8");
  } catch {
    sourceConfig = "";
  }
  const config = sanitizeHermesConfig(sourceConfig, input.restricted, input.ianBrain);
  writePrivate(join(home, "config.yaml"), config, dataMode, directoryMode);

  let sourceDotenv = "";
  try {
    sourceDotenv = readFileSync(join(input.sourceHome, ".env"), "utf8");
  } catch {
    sourceDotenv = "";
  }
  writePrivate(join(home, ".env"), sanitizeHermesDotenv(sourceDotenv, config), dataMode, directoryMode);
  copyPrivate(join(input.sourceHome, "auth.json"), join(home, "auth.json"), providerWritableMode, directoryMode);

  const digest = createHash("sha256").update(input.isolationKey).digest("hex").slice(0, 32);
  const policyRoot = input.sharedAcrossUid ? join(input.dataDir, "hermes-policy") : home;
  if (input.sharedAcrossUid) {
    // Bubblewrap dereferences inherited O_PATH descriptors through
    // /proc/self/fd after switching to the provider UID. Give the runtime
    // group traversal (but not listing) access to this one parent. Each
    // server-owned bot leaf remains 0700 until the privileged supervisor
    // temporarily transfers that exact tree to the provider for its turn.
    mkdirSync(policyRoot, { recursive: true, mode: 0o710 });
    chmodSync(policyRoot, 0o710);
  }
  const policyDir = input.sharedAcrossUid
    ? join(policyRoot, digest)
    : join(home, "openmaus-policy");
  const isolatedPolicyDirectoryMode = input.sharedAcrossUid ? 0o700 : policyDirectoryMode;
  const isolatedPolicyFileMode = input.sharedAcrossUid ? 0o600 : policyFileMode;
  const isolatedProviderWritableMode = input.sharedAcrossUid ? 0o600 : providerWritableMode;
  mkdirSync(policyDir, { recursive: true, mode: isolatedPolicyDirectoryMode });
  chmodSync(policyDir, isolatedPolicyDirectoryMode);
  writePrivate(
    join(policyDir, POLICY_FILENAME),
    HERMES_POLICY_PYTHON,
    isolatedPolicyFileMode,
    isolatedPolicyDirectoryMode,
  );

  input.env.HERMES_HOME = home;
  const nonce = randomBytes(24).toString("hex");
  const proofPath = join(policyDir, `proof-${nonce}.json`);
  if (existsSync(proofPath)) unlinkSync(proofPath);
  // The provider may write this one nonce-bound file but cannot create,
  // replace, or alter the policy module in the surrounding directory.
  writePrivate(proofPath, "", isolatedProviderWritableMode, isolatedPolicyDirectoryMode);
  input.env.PYTHONPATH = policyDir;
  input.env.OPENMAUSBOT_HERMES_POLICY = "1";
  input.env.OPENMAUSBOT_HERMES_RESTRICT_NATIVE = input.restricted ? "1" : "0";
  input.env.OPENMAUSBOT_HERMES_POLICY_NONCE = nonce;
  input.env.OPENMAUSBOT_HERMES_POLICY_PROOF = proofPath;
  if (input.sharedAcrossUid) input.env.OPENMAUSBOT_HERMES_POLICY_SHARED = "1";
  else delete input.env.OPENMAUSBOT_HERMES_POLICY_SHARED;
  const requiresIanBrain = Boolean(object(object(parseYaml(config))?.mcp_servers)?.ian_brain);
  input.env.OPENMAUSBOT_HERMES_REQUIRED_MCP = [
    ...((input.computerMounted ?? input.restricted) ? ["computer"] : []),
    ...(requiresIanBrain ? ["ian_brain"] : []),
  ].join(",");
  if (input.restricted) {
    input.env.HERMES_IGNORE_RULES = "1";
    // Defense in depth for any upstream URL helper reached indirectly. The
    // injected allowlist already removes native web_extract, but a hostile
    // ambient host setting must never re-enable private/loopback fetches.
    input.env.HERMES_ALLOW_PRIVATE_URLS = "false";
  }
  delete input.env.PYTHONHOME;
  delete input.env.PYTHONSTARTUP;

  return { path: proofPath, nonce, home };
}

/** The prompt is never sent unless the exact child process proved policy load. */
export function verifyHermesPolicyProof(proof: HermesPolicyProof): void {
  let raw = "";
  try {
    const stat = lstatSync(proof.path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
    raw = readFileSync(proof.path, "utf8");
  } catch {
    throw new Error("Hermes containment policy did not load; refusing to send the prompt");
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; nonce?: unknown };
    if (parsed.version !== HERMES_POLICY_VERSION || parsed.nonce !== proof.nonce) throw new Error("mismatch");
  } catch {
    throw new Error("Hermes containment policy proof was invalid; refusing to send the prompt");
  } finally {
    try {
      unlinkSync(proof.path);
    } catch {
      /* proof is one-shot */
    }
  }
}
