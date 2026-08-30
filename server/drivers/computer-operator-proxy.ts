// Blocking parent-facing MCP proxy for a dedicated computer-use child. The
// harness owns the target, operator model, child lifecycle, and final screen;
// this process receives only one exact-parent capability.
import { readBoundedResponseText } from "../bounded-response.ts";
import {
  COMPUTER_OPERATOR_IMAGE_MAX_BASE64_BYTES,
  normalizeComputerOperatorResult,
} from "../computer-operator-surface.ts";
import { BoundedJsonLineDecoder, PROVIDER_NDJSON_LIMITS } from "./bounded-json-lines.ts";

const HARNESS = process.env.OMB_HARNESS_URL ?? "http://127.0.0.1:8799";
const TOKEN = process.env.OMB_COMPUTER_OPERATOR_CAPABILITY_TOKEN ?? "";
const RESPONSE_MAX_BYTES = COMPUTER_OPERATOR_IMAGE_MAX_BASE64_BYTES + 128 * 1024;
const OUTPUT_MAX_PENDING_BYTES = 2 * 1024 * 1024;

const TOOL = {
  name: "delegate_computer",
  description:
    "Delegate visual computer work to the dedicated computer operator and wait for it to finish. Give it the complete concrete task and expected visible result. It returns the operator's bounded report and final verified screen. Do not call direct computer tools while this call is running.",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", minLength: 1, maxLength: 20_000, description: "The complete visual task for the computer operator." },
    },
    required: ["task"],
    additionalProperties: false,
  },
} as const;

type Json = Record<string, unknown>;
let failed = false;
let activeCall: { requestId: unknown; controller: AbortController } | null = null;

function send(message: Json): void {
  if (failed) return;
  const line = JSON.stringify(message) + "\n";
  const bytes = Buffer.byteLength(line);
  if (bytes > PROVIDER_NDJSON_LIMITS.maxLineBytes || process.stdout.writableLength + bytes > OUTPUT_MAX_PENDING_BYTES) {
    fail(new Error("computer operator proxy output exceeded its limit"));
    return;
  }
  process.stdout.write(line);
}

function fail(error: unknown): void {
  if (failed) return;
  failed = true;
  activeCall?.controller.abort(error);
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.stdin.destroy();
  process.exitCode = 1;
}

const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) =>
  send({ jsonrpc: "2.0", id, error: { code, message } });

async function run(requestId: unknown, task: unknown): Promise<ReturnType<typeof normalizeComputerOperatorResult>> {
  if (activeCall) throw new Error("the computer operator is already working for this parent turn");
  if (typeof task !== "string") throw new Error("task is required");
  const controller = new AbortController();
  const call = { requestId, controller };
  activeCall = call;
  try {
    const response = await fetch(`${HARNESS}/api/internal/computer-operator`, {
      method: "POST",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)]),
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ task }),
    });
    const raw = await readBoundedResponseText(response, RESPONSE_MAX_BYTES, "computer operator response exceeded its limit");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("computer operator returned invalid JSON");
    }
    if (!response.ok) {
      const detail = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? String((parsed as Json).error ?? `HTTP ${response.status}`)
        : `HTTP ${response.status}`;
      throw new Error(detail.slice(0, 500));
    }
    return normalizeComputerOperatorResult(parsed);
  } finally {
    if (activeCall === call) activeCall = null;
  }
}

async function handle(message: Json): Promise<void> {
  const id = message.id;
  const method = typeof message.method === "string" ? message.method : "";
  const params = message.params && typeof message.params === "object" && !Array.isArray(message.params)
    ? message.params as Json
    : {};
  if (method === "initialize") {
    ok(id, {
      protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "openmausbot-computer-operator", version: "0.1.0" },
    });
  } else if (method === "notifications/initialized") {
    return;
  } else if (method === "notifications/cancelled") {
    const cancelledId = params.requestId;
    if (activeCall && (cancelledId === undefined || cancelledId === activeCall.requestId)) {
      activeCall.controller.abort(new Error("computer operator call was cancelled by the parent provider"));
    }
    return;
  } else if (method === "ping") {
    ok(id, {});
  } else if (method === "tools/list") {
    ok(id, { tools: [TOOL] });
  } else if (method === "tools/call") {
    if (params.name !== TOOL.name) return rpcError(id, -32602, `Unknown tool: ${String(params.name ?? "")}`);
    const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? params.arguments as Json
      : {};
    try {
      const result = await run(id, args.task);
      ok(id, {
        content: [
          { type: "text", text: result.text },
          ...(result.image ? [{ type: "image", data: result.image.data, mimeType: result.image.mimeType }] : []),
        ],
        ...(result.isError ? { isError: true } : {}),
      });
    } catch (error) {
      ok(id, {
        content: [{ type: "text", text: (error instanceof Error ? error.message : String(error)).slice(0, 500) }],
        isError: true,
      });
    }
  } else if (id !== undefined) {
    rpcError(id, -32601, `Method not found: ${method}`);
  }
}

const decoder = new BoundedJsonLineDecoder(PROVIDER_NDJSON_LIMITS);
const inFlight = new Set<Promise<void>>();
process.stdin.on("data", (chunk: Buffer) => {
  if (failed) return;
  try {
    for (const frame of decoder.push(chunk)) {
      if (!frame.value || typeof frame.value !== "object" || Array.isArray(frame.value)) continue;
      const work = handle(frame.value as Json).catch((error) => {
        const id = (frame.value as Json).id;
        if (id !== undefined) rpcError(id, -32603, error instanceof Error ? error.message : String(error));
      });
      inFlight.add(work);
      void work.finally(() => inFlight.delete(work));
    }
  } catch (error) {
    fail(error);
  }
});
process.stdin.on("end", () => {
  activeCall?.controller.abort(new Error("computer operator parent disconnected"));
  void Promise.allSettled([...inFlight]).then(() => { if (!failed) process.exitCode = 0; });
});
