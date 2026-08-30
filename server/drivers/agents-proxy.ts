// Agent-to-agent comms MCP proxy — spawned as an MCP server inside a bot's
// agent process (via the "agents" integration). Exposes five tools that
// let one bot talk to another, routed back through the harness so the
// harness stays the single owner of turns, permissions, and recursion
// limits:
//
//   list_bots()                          → the other bots in this section + their status
//   ask_bot(bot_id, msg)                 → send msg to that bot, wait, return its reply
//   delegate_bot(bot_id, msg, reason?)   → hand the task to a peer ASYNC: returns
//                                          immediately, the peer runs after your
//                                          current turn finishes, the user sees
//                                          the peer's reply as its own turn
//   create_bot(name, role, instructions) → Chiefs can add a specialist to
//                                          their own section
//   request_credential(id, reason?)       → show a secure, allowlisted key card
//
// Speaks raw JSON-RPC 2.0 over stdio (no MCP SDK — house style, matches
// computer-proxy / permission-proxy). All state comes from env, injected by
// the harness when it builds the integration:
//   OMB_HARNESS_URL  base URL of the harness (http://127.0.0.1:8799)
//   OMB_AGENTS_CAPABILITY_TOKEN  turn-scoped authority for agents endpoints.
//                                Bot, thread, depth, and generation are bound
//                                server-side. The family-specific name avoids
//                                collisions in CLIs that flatten MCP env maps.
import { CREDENTIAL_TARGETS, isCredentialTargetId } from "../../shared/credential-request.ts";
import { readBoundedResponseText } from "../bounded-response.ts";
import {
  assertBoundedJsonShape,
  BoundedJsonLineDecoder,
  CATALOG_NDJSON_LIMITS,
  PROVIDER_NDJSON_LIMITS,
} from "./bounded-json-lines.ts";

const HARNESS = process.env.OMB_HARNESS_URL ?? "http://127.0.0.1:8799";
const TOKEN = process.env.OMB_AGENTS_CAPABILITY_TOKEN ?? "";
const MAX_CREATED_PER_TURN = 4;
const MAX_API_RESPONSE_BYTES = 1024 * 1024;
let createdThisTurn = 0;

const TOOLS = [
  {
    name: "list_bots",
    description:
      "List the other bots (agents) in your OpenMausBot section you can message, with their model and whether they're busy. Call this before ask_bot to discover who's available.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ask_bot",
    description:
      "Send a message to another bot in your section and wait for its reply. Use it to delegate a subtask to a specialist bot or ask a peer a question. The other bot runs a full turn under its own model and permissions; the reply is returned to you as text. Returns promptly with a note if that bot is busy.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
        message: { type: "string", description: "What to say / ask the bot." },
      },
      required: ["bot_id", "message"],
    },
  },
  {
    name: "delegate_bot",
    description:
      "Hand a task to another bot ASYNCHRONOUSLY: returns immediately and the peer runs after your current turn finishes. Use this when you want to keep working or hand off a long-running subtask without waiting. The user sees the peer's reply as its own turn; you do NOT receive the reply inline.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
        message: { type: "string", description: "What the peer should do / answer." },
        reason: { type: "string", description: "Optional one-line reason for the delegation (shown to the user as a chip)." },
      },
      required: ["bot_id", "message"],
    },
  },
  {
    name: "create_bot",
    description:
      "Create a specialist bot in your section. Only a section's Chief of Staff may use this. The new bot inherits the Chief's engine, starts with connected apps and automatic approvals disabled, and can then receive work through delegate_bot. Create only the smallest useful team (maximum four per turn).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short, unique display name for the specialist." },
        role: { type: "string", description: "The specialist's job title or role." },
        instructions: { type: "string", description: "What this specialist is responsible for and how it should work." },
      },
      required: ["name", "role", "instructions"],
    },
  },
  {
    name: "request_credential",
    description:
      "Ask the user for a supported API key through OpenMausBot's secure credential card. Use this instead of asking them to paste a secret into chat. The secret is saved by the desktop app and is never returned to you. After calling this tool, end the turn; OpenMausBot resumes the task after the user saves or declines.",
    inputSchema: {
      type: "object",
      properties: {
        credential_id: {
          type: "string",
          enum: Object.keys(CREDENTIAL_TARGETS),
          description: "The credential the current task requires.",
        },
        reason: {
          type: "string",
          description: "Optional short, non-sensitive explanation of why the task needs it.",
        },
      },
      required: ["credential_id"],
    },
  },
];

type Json = Record<string, unknown>;
const MAX_IN_FLIGHT = 8;
const MAX_PENDING_OUTPUT_BYTES = 4 * 1024 * 1024;
const activeRequests = new Set<AbortController>();
let proxyFailed = false;
const failProxy = (error: unknown) => {
  if (proxyFailed) return;
  proxyFailed = true;
  for (const controller of activeRequests) controller.abort(error);
  activeRequests.clear();
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.stdin.destroy();
  process.exitCode = 1;
  const failsafe = setTimeout(() => process.exit(1), 1_000);
  failsafe.unref?.();
};
const send = (msg: Json) => {
  if (proxyFailed) return;
  const line = JSON.stringify(msg) + "\n";
  const bytes = Buffer.byteLength(line);
  if (
    bytes > PROVIDER_NDJSON_LIMITS.maxLineBytes ||
    process.stdout.writableLength + bytes > MAX_PENDING_OUTPUT_BYTES
  ) return failProxy(new Error("agents proxy output exceeded its buffer limit"));
  process.stdout.write(line);
};
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcErr = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (id: unknown, text: string, isError = false) =>
  ok(id, { content: [{ type: "text", text }], isError });

async function api(path: string, init?: RequestInit): Promise<Json> {
  const controller = new AbortController();
  activeRequests.add(controller);
  const timeout = AbortSignal.timeout(20 * 60_000);
  try {
    const signals = [controller.signal, timeout, ...(init?.signal ? [init.signal] : [])];
    const res = await fetch(HARNESS + path, {
      ...init,
      signal: AbortSignal.any(signals),
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...init?.headers },
    });
    const text = await readBoundedResponseText(res, MAX_API_RESPONSE_BYTES, "agents response exceeded 1 MB");
    let parsed: unknown = {};
    try {
      parsed = text.trim() ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    assertBoundedJsonShape(parsed, CATALOG_NDJSON_LIMITS);
    const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Json : {};
    if (!res.ok) throw new Error(String(body.error ?? `HTTP ${res.status}`));
    return body;
  } finally {
    activeRequests.delete(controller);
  }
}

async function callTool(name: string, args: Json): Promise<{ text: string; isError?: boolean }> {
  if (name === "list_bots") {
    const r = await api("/api/internal/agents");
    const bots = (r.bots as Array<Json>) ?? [];
    if (!bots.length) return { text: "No other bots in this section yet." };
    const lines = bots.map((b) => {
      const role = b.title ? ` — ${b.title}` : "";
      const about = b.description ? ` (${String(b.description).slice(0, 120)})` : "";
      return `- ${b.name}${role}${about} [id: ${b.id}, model: ${b.model}${b.busy ? ", busy" : ""}]`;
    });
    return { text: `Other bots you can message with ask_bot:\n${lines.join("\n")}` };
  }
  if (name === "ask_bot") {
    const toBotId = String(args.bot_id ?? "").trim();
    const message = String(args.message ?? "").trim();
    if (!toBotId || !message) return { text: "ask_bot needs bot_id and message.", isError: true };
    const r = await api(`/api/internal/ask-bot`, {
      method: "POST",
      body: JSON.stringify({ toBotId, message }),
    });
    if (r.busy) return { text: `That bot is busy right now — try again after it finishes.` };
    if (r.error) return { text: `Couldn't reach that bot: ${r.error}`, isError: true };
    return { text: `${r.botName ?? "Bot"} replied:\n${r.text ?? "(no reply)"}` };
  }
  if (name === "delegate_bot") {
    const toBotId = String(args.bot_id ?? "").trim();
    const message = String(args.message ?? "").trim();
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    if (!toBotId || !message) return { text: "delegate_bot needs bot_id and message.", isError: true };
    const body: Record<string, unknown> = {
      toBotId,
      message,
    };
    if (reason) body.reason = reason;
    const r = await api(`/api/internal/delegate-bot`, { method: "POST", body: JSON.stringify(body) });
    if (r.error) return { text: `Couldn't queue the delegation: ${r.error}`, isError: true };
    // Fire-and-forget by contract: the harness returns immediately, the
    // peer turn runs after our current turn finishes.
    return { text: typeof r.message === "string" ? r.message : "Delegation queued." };
  }
  if (name === "create_bot") {
    const botName = String(args.name ?? "").trim();
    const role = String(args.role ?? "").trim();
    const instructions = String(args.instructions ?? "").trim();
    if (!botName || !role || !instructions) {
      return { text: "create_bot needs name, role, and instructions.", isError: true };
    }
    if (createdThisTurn >= MAX_CREATED_PER_TURN) {
      return { text: `You can create at most ${MAX_CREATED_PER_TURN} bots in one turn. Use the team you have before adding more.`, isError: true };
    }
    const r = await api(`/api/internal/create-bot`, {
      method: "POST",
      body: JSON.stringify({
        name: botName,
        role,
        instructions,
      }),
    });
    createdThisTurn += 1;
    return {
      text: `Created @${r.name ?? botName} in ${r.section ?? "General"} [id: ${r.id}]. Assign work with delegate_bot.`,
    };
  }
  if (name === "request_credential") {
    const credentialId = args.credential_id;
    if (!isCredentialTargetId(credentialId)) {
      return { text: "request_credential needs a supported credential_id.", isError: true };
    }
    const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, 240) : "";
    const r = await api("/api/internal/request-credential", {
      method: "POST",
      body: JSON.stringify({
        credentialId,
        ...(reason ? { reason } : {}),
      }),
    });
    if (r.alreadyConfigured) {
      return { text: `${r.label ?? CREDENTIAL_TARGETS[credentialId].label} is already configured. Continue the task.` };
    }
    return {
      text: `A secure ${r.label ?? CREDENTIAL_TARGETS[credentialId].label} card is now visible to the user. End this turn; OpenMausBot will resume the task after they save or decline. Never ask them to paste the key into chat.`,
    };
  }
  return { text: `Unknown tool: ${name}`, isError: true };
}

async function handle(msg: Json) {
  const id = msg.id;
  const method = msg.method as string | undefined;
  if (!method) return;
  const params = (msg.params ?? {}) as Json;
  switch (method) {
    case "initialize":
      ok(id, {
        protocolVersion: (params.protocolVersion as string) ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "opengrokbot-agents", version: "0.1.0" },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      ok(id, {});
      return;
    case "tools/list":
      ok(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params.name as string;
      if (!TOOLS.some((t) => t.name === name)) return rpcErr(id, -32602, `Unknown tool: ${name}`);
      try {
        const { text, isError } = await callTool(name, (params.arguments ?? {}) as Json);
        textResult(id, text, isError);
      } catch (e) {
        textResult(id, (e as Error).message, true);
      }
      return;
    }
    default:
      if (id !== undefined) rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

const input = new BoundedJsonLineDecoder(PROVIDER_NDJSON_LIMITS);
const inFlight = new Set<Promise<void>>();
let inputEnded = false;
const dispatch = (msg: Json) => {
  if (proxyFailed) return;
  if (inFlight.size >= MAX_IN_FLIGHT) return failProxy(new Error("agents proxy exceeded 8 concurrent requests"));
  const task = handle(msg).catch((e) => {
    if (msg.id !== undefined) rpcErr(msg.id, -32603, e instanceof Error ? e.message : String(e));
  });
  inFlight.add(task);
  void task.finally(() => inFlight.delete(task));
};
process.stdin.on("data", (chunk: Buffer) => {
  if (inputEnded || proxyFailed) return;
  try {
    for (const { value } of input.push(chunk)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      dispatch(value as Json);
    }
  } catch (error) {
    failProxy(error);
  }
});
process.stdin.on("end", () => {
  inputEnded = true;
  try {
    for (const { value } of input.flush()) {
      if (value && typeof value === "object" && !Array.isArray(value)) dispatch(value as Json);
    }
  } catch (error) {
    failProxy(error);
    return;
  }
  void Promise.allSettled([...inFlight]).then(() => { if (!proxyFailed) process.exitCode = 0; });
});
