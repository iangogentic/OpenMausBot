// permission-proxy — the MCP stdio server the claude CLI spawns for
// --permission-prompt-tool (ported from agentcal's runPermissionProxy;
// dedicated entry file, so there is no argv-dispatch fork-bomb hazard).
// Forwards each ask over a unix socket to the broker living in the
// OpenMausBot server and waits for the human's answer.
//
//   approve   — the CLI calls this for any tool use its permission mode
//               would deny; the answer is the --permission-prompt-tool
//               JSON contract ({behavior:"allow"|"deny", …}).
//   ask_user  — the agent can pose a question mid-run and wait; the
//               human's words come back verbatim.
//
// stdout is the MCP channel — never console.log here.
import { connect } from "node:net";
import { randomUUID } from "node:crypto";

import {
  BoundedJsonLineDecoder,
  PERMISSION_NDJSON_LIMITS,
  PROVIDER_NDJSON_LIMITS,
} from "./drivers/bounded-json-lines.ts";

const socketPath = process.argv[2] ?? "";
const MAX_WAITING = 64;
const MAX_PENDING_OUTPUT_BYTES = 4 * 1024 * 1024;
const ASK_TIMEOUT_MS = 16 * 60_000;

const waiting = new Map<string, (msg: any) => void>();
const conn = connect(socketPath);
let proxyFailed = false;
const failProxy = (error: unknown) => {
  if (proxyFailed) return;
  proxyFailed = true;
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  conn.destroy();
  process.stdin.destroy();
  process.exitCode = 1;
  const failsafe = setTimeout(() => process.exit(1), 1_000);
  failsafe.unref?.();
};

interface AllowPermissionResult {
  behavior: "allow";
  updatedInput: object;
  updatedPermissions?: object[];
}
const dead = () => {
  for (const resolve of waiting.values()) {
    resolve({ behavior: "deny", message: "OpenMausBot: permission broker unavailable — skip this action" });
  }
  waiting.clear();
};
conn.on("error", dead);
conn.on("close", dead);

const brokerInput = new BoundedJsonLineDecoder(PERMISSION_NDJSON_LIMITS);
let brokerInputFailed = false;
conn.on("data", (chunk) => {
  if (brokerInputFailed) return;
  try {
    for (const { value } of brokerInput.push(chunk)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const msg = value as { t?: unknown; id?: unknown };
      if (msg.t === "answer" && typeof msg.id === "string") {
        waiting.get(msg.id)?.(msg);
        waiting.delete(msg.id);
      }
    }
  } catch (error) {
    brokerInputFailed = true;
    failProxy(error);
  }
});

const send = (obj: unknown) => {
  if (proxyFailed) return;
  const line = JSON.stringify(obj) + "\n";
  const bytes = Buffer.byteLength(line);
  if (
    bytes > PROVIDER_NDJSON_LIMITS.maxLineBytes ||
    process.stdout.writableLength + bytes > MAX_PENDING_OUTPUT_BYTES
  ) return failProxy(new Error("permission proxy output exceeded its buffer limit"));
  process.stdout.write(line);
};

const writeBroker = (obj: unknown) => {
  if (proxyFailed || conn.destroyed) return false;
  const line = JSON.stringify(obj) + "\n";
  const bytes = Buffer.byteLength(line);
  if (
    bytes > PERMISSION_NDJSON_LIMITS.maxLineBytes ||
    conn.writableLength + bytes > MAX_PENDING_OUTPUT_BYTES
  ) {
    failProxy(new Error("permission broker request exceeded its buffer limit"));
    return false;
  }
  conn.write(line);
  return true;
};

const TOOLS = [
  {
    name: "approve",
    description: "Ask the OpenMausBot user whether a tool use is allowed",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string" },
        input: { type: "object" },
        tool_use_id: { type: "string" },
      },
      required: ["tool_name", "input"],
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the human who owns this bot a question and wait for their answer. Use whenever you need a decision, a preference, missing information, or sign-off before doing something consequential — do not guess on things the owner would want to decide. Returns their answer as text.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, with enough context to answer at a glance" },
        choices: {
          type: "array",
          items: { type: "string" },
          description: "Optional 2-5 suggested answers, shown as one-tap buttons",
        },
      },
      required: ["question"],
    },
  },
];

async function handle(msg: any) {
  if (msg.method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "openmausbot-permissions", version: "1" },
      },
    });
  }
  if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    const askId = randomUUID();
    const isQuestion = name === "ask_user";
    if (waiting.size >= MAX_WAITING) {
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{
            type: "text",
            text: isQuestion
              ? "No answer was given — use your best judgment."
              : JSON.stringify({ behavior: "deny", message: "OpenMausBot: too many pending permission requests" }),
          }],
        },
      });
    }
    // the CLI may include its own suggested permission rules; on allow we
    // hand them straight back as updatedPermissions so claude stops asking
    // at its own layer — no invented rule syntax (agentcal)
    const suggestions = Array.isArray(args.permission_suggestions)
      ? args.permission_suggestions
      : Array.isArray(args.suggestions)
        ? args.suggestions
        : null;
    const answer: any = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(askId);
        resolve({ behavior: "deny", message: "OpenMausBot: permission broker timed out — skip this action" });
      }, ASK_TIMEOUT_MS);
      timer.unref?.();
      waiting.set(askId, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      if (conn.destroyed) return dead();
      const ask = isQuestion
        ? { t: "ask", id: askId, kind: "question", tool: "ask_user", input: { question: args.question, choices: args.choices } }
        : { t: "ask", id: askId, tool: args.tool_name, input: args.input };
      if (!writeBroker(ask)) dead();
    });
    let text = answer.message || "No answer was given — use your best judgment.";
    if (!isQuestion) {
      if (answer.behavior === "allow") {
        const result: AllowPermissionResult = { behavior: "allow", updatedInput: args.input ?? {} };
        if (answer.always && suggestions) result.updatedPermissions = suggestions;
        text = JSON.stringify(result);
      } else {
        text = JSON.stringify({ behavior: "deny", message: answer.message || "Denied from OpenMausBot" });
      }
    }
    return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
  }
  if (String(msg.method ?? "").startsWith("notifications/")) return;
  if (msg.id != null) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}

const providerInput = new BoundedJsonLineDecoder(PROVIDER_NDJSON_LIMITS);
const inFlight = new Set<Promise<void>>();
let inputEnded = false;
const dispatch = (value: object) => {
  if (proxyFailed) return;
  if (inFlight.size >= MAX_WAITING) return failProxy(new Error("permission proxy exceeded 64 concurrent requests"));
  const task = handle(value).catch((error) => {
    process.stderr.write(`permission proxy request failed: ${error instanceof Error ? error.message : String(error)}\n`);
  });
  inFlight.add(task);
  void task.finally(() => inFlight.delete(task));
};
process.stdin.on("data", (chunk) => {
  if (inputEnded || proxyFailed) return;
  try {
    for (const { value } of providerInput.push(chunk)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      dispatch(value);
    }
  } catch (error) {
    failProxy(error);
  }
});
process.stdin.on("end", () => {
  inputEnded = true;
  try {
    for (const { value } of providerInput.flush()) {
      if (value && typeof value === "object" && !Array.isArray(value)) dispatch(value);
    }
  } catch (error) {
    failProxy(error);
    return;
  }
  conn.destroy();
  dead();
  void Promise.allSettled([...inFlight]).then(() => { if (!proxyFailed) process.exitCode = 0; });
});
