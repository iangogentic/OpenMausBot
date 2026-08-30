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
import base64
import mimetypes
import os
import stat
import sys
import threading
import time
import traceback

_ACTIVE = os.environ.get("OPENMAUSBOT_HERMES_POLICY") == "1"
_RESTRICT_NATIVE = os.environ.get("OPENMAUSBOT_HERMES_RESTRICT_NATIVE") == "1"
_SPARK_IMPLICIT_THINK = os.environ.get("OPENMAUSBOT_HERMES_SPARK_IMPLICIT_THINK") == "1"
_ALLOWED_NATIVE = frozenset({
    "web_search", "todo",
    "tool_search", "tool_describe", "tool_call",
})
_PINNED_MCP = frozenset({
    # Common computer perception and control must remain directly visible to
    # local models; the complete catalog stays available through tool_search.
    "mcp_computer_get_desktop_state", "mcp_computer_get_screen_size",
    "mcp_computer_verify_state", "mcp_computer_list_apps",
    "mcp_computer_list_windows", "mcp_computer_launch_app",
    "mcp_computer_bring_to_front", "mcp_computer_click",
    "mcp_computer_double_click", "mcp_computer_right_click",
    "mcp_computer_drag", "mcp_computer_type_text",
    "mcp_computer_press_key", "mcp_computer_hotkey",
    "mcp_computer_scroll", "mcp_computer_get_browser_state",
    "mcp_computer_browser_prepare", "mcp_computer_browser_navigate",
    "mcp_computer_browser_click", "mcp_computer_browser_type",
    # High-frequency, read-oriented Ian Brain entry points.
    "mcp_ian_brain_context_store_stats", "mcp_ian_brain_ian_context_brief",
    "mcp_ian_brain_projects_search", "mcp_ian_brain_memory_recall",
    "mcp_ian_brain_files_search", "mcp_ian_brain_wiki_index",
    "mcp_ian_brain_world_model_query", "mcp_ian_brain_work_item_list",
})
_DENIED_MCP_PREFIXES = (
    "mcp__ian_brain__creds_",
    "mcp__ian_brain__mcp_ian_brain_creds_",
    "mcp_ian_brain_creds_",
    "mcp_ian_brain_mcp_ian_brain_creds_",
)
_MCP_IMAGE_MAX_BYTES = 20 * 1024 * 1024
_MCP_IMAGE_PROVENANCE_TTL_SECONDS = 60
_MCP_IMAGE_PROVENANCE_LIMIT = 128
_MCP_IMAGE_PROVENANCE = {}
_MCP_IMAGE_PROVENANCE_LOCK = threading.Lock()


def _remember_mcp_image_media_tag(media_tag):
    """Remember only paths emitted by Hermes' real MCP ImageContent cache."""
    if not isinstance(media_tag, str) or not media_tag.startswith("MEDIA:"):
        return media_tag
    path = media_tag[len("MEDIA:"):].strip()
    if not path:
        return media_tag
    now = time.monotonic()
    with _MCP_IMAGE_PROVENANCE_LOCK:
        expired = [
            candidate for candidate, created in _MCP_IMAGE_PROVENANCE.items()
            if now - created > _MCP_IMAGE_PROVENANCE_TTL_SECONDS
        ]
        for candidate in expired:
            _MCP_IMAGE_PROVENANCE.pop(candidate, None)
        while len(_MCP_IMAGE_PROVENANCE) >= _MCP_IMAGE_PROVENANCE_LIMIT:
            oldest = min(_MCP_IMAGE_PROVENANCE, key=_MCP_IMAGE_PROVENANCE.get)
            _MCP_IMAGE_PROVENANCE.pop(oldest, None)
        _MCP_IMAGE_PROVENANCE[path] = now
    return media_tag


def _consume_mcp_image_provenance(path):
    now = time.monotonic()
    with _MCP_IMAGE_PROVENANCE_LOCK:
        created = _MCP_IMAGE_PROVENANCE.pop(path, None)
    return created is not None and now - created <= _MCP_IMAGE_PROVENANCE_TTL_SECONDS


def _image_mime_from_magic(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data.startswith(b"BM"):
        return "image/bmp"
    if data.startswith(b"RIFF") and len(data) >= 12 and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _validated_mcp_image_data_url(path):
    """Load one provenance-bound cache image without following symlinks."""
    if not _consume_mcp_image_provenance(path):
        return None
    try:
        from gateway.platforms.base import get_image_cache_dir
        cache_root = os.path.realpath(str(get_image_cache_dir()))
        candidate = os.path.realpath(path)
        if os.path.commonpath((cache_root, candidate)) != cache_root:
            return None
        if os.path.islink(path):
            return None
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                return None
            if info.st_size <= 0 or info.st_size > _MCP_IMAGE_MAX_BYTES:
                return None
            with os.fdopen(fd, "rb", closefd=False) as stream:
                data = stream.read(_MCP_IMAGE_MAX_BYTES + 1)
            if len(data) != info.st_size:
                return None
        finally:
            os.close(fd)
        magic_mime = _image_mime_from_magic(data)
        extension_mime = mimetypes.guess_type(candidate)[0]
        if magic_mime is None:
            return None
        if extension_mime == "image/jpg":
            extension_mime = "image/jpeg"
        if extension_mime != magic_mime:
            return None
        encoded = base64.b64encode(data).decode("ascii")
        return "data:" + magic_mime + ";base64," + encoded
    except (OSError, RuntimeError, ValueError):
        return None


def _promote_mcp_images_to_multimodal(result):
    """Turn trusted MCP cache tags into Hermes' native vision envelope."""
    if not isinstance(result, str) or "MEDIA:" not in result:
        return result
    try:
        parsed = json.loads(result)
        if isinstance(parsed, dict) and "error" in parsed:
            return result
    except (TypeError, ValueError):
        pass
    with _MCP_IMAGE_PROVENANCE_LOCK:
        candidates = list(_MCP_IMAGE_PROVENANCE)
    image_parts = []
    for path in candidates:
        if "MEDIA:" + path not in result:
            continue
        data_url = _validated_mcp_image_data_url(path)
        if data_url:
            image_parts.append({"type": "image_url", "image_url": {"url": data_url}})
    if not image_parts:
        return result
    return {
        "_multimodal": True,
        "content": [{"type": "text", "text": result}] + image_parts,
        "text_summary": result,
    }


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
    # The reviewed Spark GLM chat template sometimes emits Qwen-style hidden
    # reasoning without the opening <think>, followed by </think> and the real
    # answer. Upstream Hermes deliberately removes only the orphan close tag,
    # exposing the preceding reasoning as assistant text. Scope a stateful
    # repair to this exact model route: buffer only the initial stream, discard
    # it when a recognized close arrives, and preserve it unchanged at flush
    # when the model emitted no close tag at all.
    if _SPARK_IMPLICIT_THINK:
        from agent import think_scrubber as think_scrubber_module
        original_scrubber = think_scrubber_module.StreamingThinkScrubber

        class OpenMausSparkThinkScrubber:
            _BUFFER_LIMIT = 1024 * 1024

            def __init__(self):
                self._delegate = original_scrubber()
                self._probing = True
                self._prefix = ""

            def reset(self):
                self._delegate.reset()
                self._probing = True
                self._prefix = ""

            def feed(self, text):
                if not self._probing:
                    return self._delegate.feed(text)
                if not text:
                    return ""
                self._prefix += text
                lowered = self._prefix.lower()
                matches = [
                    (lowered.find(tag.lower()), len(tag))
                    for tag in original_scrubber._CLOSE_TAGS
                    if lowered.find(tag.lower()) >= 0
                ]
                if matches:
                    index, length = min(matches, key=lambda match: match[0])
                    suffix = self._prefix[index + length:]
                    self._prefix = ""
                    self._probing = False
                    self._delegate.reset()
                    return self._delegate.feed(suffix)
                if len(self._prefix) > self._BUFFER_LIMIT:
                    visible = self._prefix
                    self._prefix = ""
                    self._probing = False
                    self._delegate.reset()
                    return visible
                return ""

            def flush(self):
                if self._probing:
                    visible = self._prefix
                    self._prefix = ""
                    self._probing = False
                    return visible
                return self._delegate.flush()

        think_scrubber_module.StreamingThinkScrubber = OpenMausSparkThinkScrubber

    import model_tools

    # Hermes currently flattens MCP ImageContent into a MEDIA:/cache/path
    # string. That is suitable for chat attachment delivery but leaves the
    # agent itself blind. Record the exact paths created by the upstream MCP
    # image-cache helper, then promote only those paths at the common dispatch
    # boundary. This also covers MCP handlers registered after startup and MCP
    # calls reached through Tool Search, without trusting model/server supplied
    # arbitrary MEDIA paths.
    try:
        from tools import mcp_tool as mcp_tool_module
    except ImportError:
        mcp_tool_module = None
    if mcp_tool_module is not None:
        original_cache_mcp_image = getattr(mcp_tool_module, "_cache_mcp_image_block", None)
        if callable(original_cache_mcp_image):
            def openmaus_cache_mcp_image(block):
                return _remember_mcp_image_media_tag(original_cache_mcp_image(block))

            mcp_tool_module._cache_mcp_image_block = openmaus_cache_mcp_image

    # Keep a compact everyday MCP rail visible while Hermes progressively
    # discloses the long tail. Pushing all 93 schemas at a 27B local model
    # caused valid function names to be confused; deferring every MCP tool
    # caused requested computer tools to look absent. This split preserves
    # both accuracy and complete reachability.
    try:
        from tools import tool_search as tool_search_module
    except ImportError:
        tool_search_module = None
    if _RESTRICT_NATIVE and tool_search_module is not None:
        original_core_tool_names = tool_search_module._core_tool_names

        def guarded_core_tool_names():
            return frozenset(original_core_tool_names()) | _PINNED_MCP

        tool_search_module._core_tool_names = guarded_core_tool_names

    original_definitions = model_tools.get_tool_definitions
    original_dispatch = model_tools.handle_function_call

    def guarded_definitions(*args, **kwargs):
        return _filter_definitions(original_definitions(*args, **kwargs))

    def guarded_dispatch(function_name, *args, **kwargs):
        if not _allowed_tool(function_name):
            return json.dumps({
                "error": "OpenMaus policy blocked a Hermes-native host tool; use the mounted MCP tools."
            })
        return _promote_mcp_images_to_multimodal(
            original_dispatch(function_name, *args, **kwargs)
        )

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
        if _SPARK_IMPLICIT_THINK and hasattr(self, "_get_transport"):
            # This Spark endpoint has repeatedly labelled short, complete
            # post-tool answers as length (and Hermes' GLM heuristic also
            # upgrades an otherwise normal stop when a stray final glyph is
            # present). Hermes then asks the model to continue, exposing its
            # recovery prompt and duplicating the answer. Treat only short,
            # text-only Spark responses as terminal; genuine large truncations
            # and tool-call responses keep their native finish reason.
            original_get_transport = self._get_transport

            class OpenMausSparkTransport:
                def __init__(self, delegate):
                    self._delegate = delegate

                def __getattr__(self, name):
                    return getattr(self._delegate, name)

                def normalize_response(self, response, **normalize_kwargs):
                    normalized = self._delegate.normalize_response(
                        response, **normalize_kwargs
                    )
                    content = getattr(normalized, "content", None)
                    if (
                        getattr(normalized, "finish_reason", None) == "length"
                        and isinstance(content, str)
                        and 0 < len(content.encode("utf-8")) < 8192
                        and not getattr(normalized, "tool_calls", None)
                    ):
                        normalized.finish_reason = "stop"
                    return normalized

            def openmaus_get_transport(*transport_args, **transport_kwargs):
                return OpenMausSparkTransport(
                    original_get_transport(*transport_args, **transport_kwargs)
                )

            self._get_transport = openmaus_get_transport
            self._should_treat_stop_as_truncated = lambda *_args, **_kwargs: False
        # Upstream Hermes only applies its successful-result no-progress
        # circuit breaker to a short built-in read-tool allowlist. Scoped MCP
        # tools otherwise can repeat forever (including a mutating computer
        # action) even when the exact call keeps returning the exact result.
        # Changed results reset the counter; identical results use Hermes'
        # native bounded warning/halt path configured below.
        guard = getattr(self, "_tool_guardrails", None)
        if _RESTRICT_NATIVE and guard is not None:
            original_is_idempotent = guard._is_idempotent
            guard._is_idempotent = lambda name: (
                isinstance(name, str) and name.startswith("mcp_")
            ) or original_is_idempotent(name)
            # Search is a bridge, not productive work by itself. Some local
            # models vary the query forever, evading exact-call detection.
            # Bound consecutive bridge exploration while leaving repeated
            # direct computer actions governed by result-based progress.
            from agent.tool_guardrails import ToolGuardrailDecision
            original_after_call = guard.after_call
            original_reset_for_turn = guard.reset_for_turn
            guard._openmaus_search_calls = 0

            def guarded_reset_for_turn():
                guard._openmaus_search_calls = 0
                return original_reset_for_turn()

            def guarded_after_call(name, call_args, call_result, **call_kwargs):
                decision = original_after_call(name, call_args, call_result, **call_kwargs)
                if name in {"tool_search", "tool_describe"}:
                    guard._openmaus_search_calls += 1
                    if guard._openmaus_search_calls >= 5 and not decision.should_halt:
                        return ToolGuardrailDecision(
                            action="halt",
                            code="openmaus_search_loop_halt",
                            message=(
                                "Stopped repeated tool discovery after five searches. "
                                "Use a discovered tool directly or answer with the available result."
                            ),
                            tool_name=name,
                            count=guard._openmaus_search_calls,
                        )
                return decision

            guard.reset_for_turn = guarded_reset_for_turn
            guard.after_call = guarded_after_call
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
        # Hermes set_session_model replaces state.agent wholesale. Retain only
        # the ACP-provided descriptors on the state object so the exact same
        # scoped servers can be registered on the replacement agent below.
        state._openmaus_mcp_servers = list(mcp_servers or [])
        required = {
            item.strip() for item in
            os.environ.get("OPENMAUSBOT_HERMES_REQUIRED_MCP", "").split(",")
            if item.strip()
        }
        pending_servers = list(mcp_servers or [])
        # The desktop2 SSH tunnel is user-owned and can trail Tailscale during
        # a cold boot. Stock Hermes swallows a failed registration, so retry
        # only the still-missing required descriptor. The exact-turn broker
        # token remains active while we wait; forbidden tools still fail on
        # every attempt, and a truly unavailable dependency fails closed after
        # a bounded 20 seconds rather than running without Ian Brain.
        for attempt in range(11):
            await original_register_mcp(self, state, pending_servers)
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
            missing = {
                server_name for server_name in required
                if not _has_mcp_server_tool(names, server_name)
            }
            if not missing:
                break
            if attempt == 10:
                visible = ",".join(sorted(
                    name for name in registered_names if isinstance(name, str)
                ))[:1000]
                raise RuntimeError(
                    "OpenMaus required MCP server '" + sorted(missing)[0]
                    + "' exposed no tools after cold-start retries (registered: "
                    + visible + ")"
                )
            retry_servers = []
            for descriptor in list(mcp_servers or []):
                descriptor_name = (
                    descriptor.get("name") if isinstance(descriptor, dict)
                    else getattr(descriptor, "name", None)
                )
                if descriptor_name in missing:
                    retry_servers.append(descriptor)
            pending_servers = retry_servers or list(mcp_servers or [])
            import asyncio
            await asyncio.sleep(2)

    HermesACPAgent._register_session_mcp_servers = guarded_register_mcp

    # Upstream Hermes 0.17 creates the ACP session (and registers its MCPs)
    # before OpenMaus applies session/set_model. The model switch constructs a
    # new AIAgent and drops the session-mounted computer/agents tool surface.
    # Re-register the nonce-scoped descriptors immediately after that switch;
    # guarded_register_mcp re-runs both the catalog filter and required-server
    # assertions before the prompt can be sent.
    original_set_session_model = getattr(HermesACPAgent, "set_session_model", None)
    if callable(original_set_session_model):
        async def guarded_set_session_model(self, model_id, session_id, **kwargs):
            before = self.session_manager.get_session(session_id)
            servers = list(getattr(before, "_openmaus_mcp_servers", []) or []) if before else []
            result = await original_set_session_model(
                self, model_id=model_id, session_id=session_id, **kwargs
            )
            after = self.session_manager.get_session(session_id)
            if after is not None and servers:
                await self._register_session_mcp_servers(after, servers)
            return result

        HermesACPAgent.set_session_model = guarded_set_session_model

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
        stream.flush()
        os.fsync(stream.fileno())
    # The privileged cross-UID launcher temporarily owns this exact proof
    # leaf while Hermes is alive. Restore group readability only on
    # the nonce-bound proof after writing it so the server can verify the
    # loaded policy before sending the prompt. The policy module itself stays
    # mode 0600 and the directory remains non-listable to the runtime group.
    if os.environ.get("OPENMAUSBOT_HERMES_POLICY_SHARED") == "1":
        os.chmod(proof, 0o640)


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
    "tool_output",
    "max_concurrent_sessions",
    "logging",
  ]);

  // Hosted turns must remain bounded even when the shared Hermes profile
  // disabled its optional circuit breaker. The policy shim extends successful
  // no-progress tracking to the scoped MCP catalog at runtime.
  safe.tool_loop_guardrails = {
    warnings_enabled: true,
    hard_stop_enabled: true,
    warn_after: {
      exact_failure: 2,
      same_tool_failure: 3,
      idempotent_no_progress: 2,
    },
    hard_stop_after: {
      exact_failure: 5,
      same_tool_failure: 8,
      idempotent_no_progress: 5,
    },
  };

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
  // Hosted local models receive a compact direct MCP rail from the policy
  // shim and discover the remaining permitted tools through this bridge.
  if (restricted) safe.tools = { tool_search: { enabled: "on" } };
  else if (toolSearch) safe.tools = { tool_search: toolSearch };

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
  policyDir?: string;
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
  const proofDir = input.sharedAcrossUid
    ? join(input.dataDir, "hermes-proof", digest)
    : policyDir;
  if (input.sharedAcrossUid) {
    mkdirSync(dirname(proofDir), { recursive: true, mode: 0o710 });
    chmodSync(dirname(proofDir), 0o710);
    mkdirSync(proofDir, { recursive: true, mode: 0o710 });
    chmodSync(proofDir, 0o710);
  }
  const nonce = randomBytes(24).toString("hex");
  const proofPath = join(proofDir, `proof-${nonce}.json`);
  if (existsSync(proofPath)) unlinkSync(proofPath);
  // The provider may write this one nonce-bound file but cannot create or
  // replace a sibling. In cross-UID mode it lives outside the policy module
  // directory so proof readability never makes the module traversable.
  writePrivate(
    proofPath,
    "",
    isolatedProviderWritableMode,
    input.sharedAcrossUid ? 0o710 : isolatedPolicyDirectoryMode,
  );
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

  return { path: proofPath, nonce, home, policyDir };
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
