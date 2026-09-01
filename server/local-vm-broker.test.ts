import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  LOCAL_VM_ACT_AND_OBSERVE_TOOLS,
  LOCAL_VM_MAX_MCP_FRAMES,
  LocalVmMcpAdmissions,
  attachLocalVmMcpBroker,
  localVmPostActionSettleMs,
  type LocalVmMcpAuthority,
} from "./local-vm-broker.ts";
import {
  SHARED_LOCAL_VM_TARGET,
  containerComputerStatus,
  currentContainerComputerGeneration,
  perBotLocalVmTarget,
} from "./container-computer.ts";
import type { RawWebSocket, RawWebSocketMessage } from "./raw-websocket.ts";

class FakeSocket {
  open = true;
  backpressured = false;
  inputPaused = false;
  readonly sent: Buffer[] = [];
  private readonly messages = new Set<(message: RawWebSocketMessage) => void>();
  private readonly closes = new Set<() => void>();
  private readonly drains = new Set<() => void>();

  onMessage(listener: (message: RawWebSocketMessage) => void) {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }
  onClose(listener: () => void) {
    this.closes.add(listener);
    return () => this.closes.delete(listener);
  }
  onDrain(listener: () => void) {
    this.drains.add(listener);
    return () => this.drains.delete(listener);
  }
  pauseInput() { this.inputPaused = true; }
  resumeInput() { this.inputPaused = false; }
  sendBinary(value: Buffer) {
    if (!this.open || this.backpressured) return false;
    this.sent.push(Buffer.from(value));
    return true;
  }
  sendText(value: string) { return this.sendBinary(Buffer.from(value)); }
  ping() { return this.open; }
  close() { this.disconnect(); }
  destroy() { this.disconnect(); }
  receive(value: string | Buffer, binary = true) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    for (const listener of [...this.messages]) listener({ binary, data });
  }
  disconnect() {
    if (!this.open) return;
    this.open = false;
    for (const listener of [...this.closes]) listener();
  }
  drain() {
    this.backpressured = false;
    for (const listener of [...this.drains]) listener();
  }
}

const AUTHORITY: LocalVmMcpAuthority = Object.freeze({
  capabilityToken: "x".repeat(43),
  botId: "bot-a",
  threadId: "thread-a",
  generation: "dispatch-a",
  targetKey: "bot:target-a",
  runtime: "docker",
  containerName: "openmausbot-computer-a",
  vmGeneration: "a".repeat(64),
  bridgeId: "bridge-a",
});

const responderScript = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { tools: [] } }) + "\n");
  } else if (frame.method === "tools/call") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { content: [] } }) + "\n");
  }
});
`;

function spawnResponder(script = responderScript): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["-e", script], {
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function semanticBrowserResponder(options: {
  actualNavigateUrl?: string;
  malformedState?: boolean;
  malformedAction?: boolean;
  extraText?: string;
  oversizedState?: boolean;
} = {}): string {
  const config = JSON.stringify(options);
  return String.raw`
const readline = require("node:readline");
const config = ${config};
let currentUrl = "https://example.test/start";
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method !== "tools/call") return send({ jsonrpc: "2.0", id: frame.id, result: {} });
  const name = frame.params.name;
  const args = frame.params.arguments || {};
  if (name === "get_browser_state") {
    if (config.malformedState) return send({ jsonrpc: "2.0", id: frame.id, result: { content: "invalid" } });
    const padding = config.oversizedState ? "x".repeat(600000) : "";
    return send({
      jsonrpc: "2.0",
      id: frame.id,
      result: {
        content: [{ type: "text", text: "browser state " + currentUrl + " " + (config.extraText || "") + padding }],
        structuredContent: {
          status: "ok",
          target_id: args.target_id || "target-a",
          tab_id: args.tab_id || "tab-a",
          url: currentUrl,
          snapshot_id: "snapshot-a",
          elements: [
            { ref: "p1:1", role: "button", name: "Continue" },
            { ref: "p1:2", role: "textbox", name: "Email" },
            { ref: "p1:3", role: "button", name: "Upload" },
          ],
        },
      },
    });
  }
  if (name === "browser_navigate") currentUrl = config.actualNavigateUrl || args.url;
  if (config.malformedAction) return send({ jsonrpc: "2.0", id: frame.id, result: { content: [] } });
  send({
    jsonrpc: "2.0",
    id: frame.id,
    result: {
      content: [{ type: "text", text: "action complete " + (config.extraText || "") }],
      structuredContent: { status: "ok", echoed_url: currentUrl, files: args.files },
    },
  });
});
`;
}

function baseOptions(socket: FakeSocket, overrides: Record<string, unknown> = {}) {
  return {
    broker: socket as unknown as RawWebSocket,
    authority: AUTHORITY,
    stillAuthorized: () => true,
    verifyCurrentGeneration: () => true,
    beginAction: () => ({ allowed: true as const, actionId: "action-a" }),
    endAction: () => true,
    quarantine: vi.fn(),
    requestHelp: async () => ({ text: "done" }),
    spawnDriver: () => spawnResponder(),
    generationPollMs: 60_000,
    ...overrides,
  };
}

async function processGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe("Local VM MCP admission", () => {
  it("makes a capability one-shot until its exact turn is revoked", () => {
    const admissions = new LocalVmMcpAdmissions();
    expect(admissions.claim(AUTHORITY.capabilityToken)).toBe(true);
    expect(admissions.claim(AUTHORITY.capabilityToken)).toBe(false);
    expect(admissions.has(AUTHORITY.capabilityToken)).toBe(true);
    expect(admissions.revoke(AUTHORITY.capabilityToken)).toBe(true);
    expect(admissions.claim(AUTHORITY.capabilityToken)).toBe(true);
  });
});

describe("Local VM visual action policy", () => {
  it("matches the reviewed Cua mutation names and repaint classes", () => {
    expect(LOCAL_VM_ACT_AND_OBSERVE_TOOLS).toContain("browser_type");
    expect(LOCAL_VM_ACT_AND_OBSERVE_TOOLS).not.toContain("browser_fill");
    expect(LOCAL_VM_ACT_AND_OBSERVE_TOOLS).toContain("set_window_frame");
    expect(LOCAL_VM_ACT_AND_OBSERVE_TOOLS).toContain("browser_set_input_files");
    expect(localVmPostActionSettleMs("click")).toBe(250);
    expect(localVmPostActionSettleMs("browser_navigate")).toBe(600);
    expect(localVmPostActionSettleMs("launch_app")).toBe(800);
  });
});

describe.skipIf(process.platform === "win32")("trusted Local VM MCP broker", () => {
  it("advertises the bounded native computer_batch synthetic tool", async () => {
    const socket = new FakeSocket();
    const handle = attachLocalVmMcpBroker(baseOptions(socket));
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) + "\n");
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    const response = JSON.parse(socket.sent[0]!.toString());
    const batch = response.result.tools.find((tool: { name?: string }) => tool.name === "computer_batch");
    expect(batch.inputSchema.properties.actions).toMatchObject({ minItems: 1, maxItems: 9 });
    expect(batch.inputSchema.properties.actions.items.oneOf).toHaveLength(5);
    handle.close("tools list complete");
    await handle.closed;
  });

  it("preserves direct parent mutations when child accounting is not requested", async () => {
    const socket = new FakeSocket();
    const beginAction = vi.fn(() => ({ allowed: true as const, actionId: "direct-parent-ticket" }));
    const endAction = vi.fn(() => true);
    const handle = attachLocalVmMcpBroker(baseOptions(socket, { beginAction, endAction }));
    socket.receive(JSON.stringify({
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: { name: "click", arguments: { x: 10, y: 20 } },
    }) + "\n");
    await vi.waitFor(() => expect(socket.sent.length).toBe(1));
    const response = JSON.parse(socket.sent[0]!.toString());
    expect(response).toMatchObject({ id: 100, result: { content: [] } });
    expect(response.result.isError).toBeUndefined();
    expect(beginAction).toHaveBeenCalledOnce();
    expect(endAction).toHaveBeenCalledExactlyOnceWith("direct-parent-ticket");
    handle.close("direct parent compatibility complete");
    await handle.closed;
  });

  it("publishes only bounded forwarded coordinates and trusted post-action child frames", async () => {
    const socket = new FakeSocket();
    const onChildCursor = vi.fn(() => { throw new Error("listener is isolated"); });
    const onChildFrame = vi.fn(async () => { throw new Error("async listener is isolated"); });
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      captureAfterAction: async () => ({ data: "iVBORw0KGgo=", mimeType: "image/png" as const }),
      onChildCursor,
      onChildFrame,
    }));
    socket.receive(JSON.stringify({
      jsonrpc: "2.0",
      id: 101,
      method: "tools/call",
      params: { name: "click", arguments: { x: 640, y: 450, text: "must-not-leak", url: "https://secret.test", path: "/private" } },
    }) + "\n");
    await vi.waitFor(() => expect(socket.sent.length).toBe(1));
    const response = JSON.parse(socket.sent[0]!.toString());
    expect(response.result.isError).toBeUndefined();
    expect(onChildCursor).toHaveBeenCalledExactlyOnceWith({ x: 640, y: 450 });
    expect(onChildFrame).toHaveBeenCalledExactlyOnceWith({
      mime: "image/png",
      data: "iVBORw0KGgo=",
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(onChildCursor.mock.calls)).not.toContain("must-not-leak");
    handle.close("telemetry complete");
    await handle.closed;
  });

  it("does not publish rejected or out-of-bound child coordinates", async () => {
    const socket = new FakeSocket();
    const onChildCursor = vi.fn();
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      beginAction: () => ({ allowed: false as const, reason: "human-control" as const }),
      onChildCursor,
    }));
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 102, method: "tools/call", params: { name: "click", arguments: { x: 20, y: 30 } } }) + "\n");
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 103, method: "tools/call", params: { name: "click", arguments: { x: 99_999, y: 30 } } }) + "\n");
    await vi.waitFor(() => expect(socket.sent.length).toBe(2));
    expect(onChildCursor).not.toHaveBeenCalled();
    handle.close("rejection complete");
    await handle.closed;
  });

  it("fails a wrong post-navigation URL, redacts credentials/query data, and still attaches trusted pixels", async () => {
    const socket = new FakeSocket();
    const secretUrl = "https://alice:password123@example.test/private?token=query-secret#fragment-secret";
    const captureAfterAction = vi.fn(async () => ({ data: "iVBORw0KGgo=", mimeType: "image/png" as const }));
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      captureAfterAction,
      spawnDriver: () => spawnResponder(semanticBrowserResponder({
        actualNavigateUrl: "https://example.test/wrong?token=driver-secret",
        extraText: secretUrl,
      })),
    }));

    socket.receive(JSON.stringify({
      jsonrpc: "2.0",
      id: 201,
      method: "tools/call",
      params: {
        name: "browser_navigate",
        arguments: { target_id: "target-a", tab_id: "tab-a", url: secretUrl },
      },
    }) + "\n");

    await vi.waitFor(() => expect(socket.sent.length).toBe(1));
    const raw = socket.sent[0]!.toString();
    const response = JSON.parse(raw);
    expect(response.result.isError).toBe(true);
    expect(response.result.content).toContainEqual({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
    expect(raw).not.toContain("alice");
    expect(raw).not.toContain("password123");
    expect(raw).not.toContain("query-secret");
    expect(raw).not.toContain("fragment-secret");
    expect(raw).not.toContain("driver-secret");
    expect(captureAfterAction).toHaveBeenCalledExactlyOnceWith("browser_navigate");

    handle.close("wrong URL test complete");
    await handle.closed;
  });

  it("reports navigation success only when trusted state proves the exact http(s) URL", async () => {
    const socket = new FakeSocket();
    const destination = "https://example.test/exact/path?view=compact";
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      captureAfterAction: async () => ({ data: "iVBORw0KGgo=", mimeType: "image/png" as const }),
      spawnDriver: () => spawnResponder(semanticBrowserResponder()),
    }));
    socket.receive(JSON.stringify({
      jsonrpc: "2.0",
      id: 226,
      method: "tools/call",
      params: {
        name: "browser_navigate",
        arguments: { target_id: "target-a", tab_id: "tab-a", url: destination },
      },
    }) + "\n");
    await vi.waitFor(() => expect(socket.sent.length).toBe(1));
    const raw = socket.sent[0]!.toString();
    const response = JSON.parse(raw);
    expect(response.result.isError).toBeUndefined();
    expect(response.result.content).toContainEqual({
      type: "image",
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
    });
    expect(raw).not.toContain("view=compact");
    handle.close("exact URL test complete");
    await handle.closed;
  });

  it("accepts only refs from the latest exact-tab state and makes them stale after a mutation", async () => {
    const socket = new FakeSocket();
    let actionSequence = 0;
    const beginAction = vi.fn(() => ({ allowed: true as const, actionId: `browser-${++actionSequence}` }));
    const captureAfterAction = vi.fn(async () => ({ data: "iVBORw0KGgo=", mimeType: "image/png" as const }));
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      beginAction,
      captureAfterAction,
      spawnDriver: () => spawnResponder(semanticBrowserResponder({ extraText: "page text p9:9 is not an action ref" })),
    }));
    const send = (id: number, name: string, args: Record<string, unknown>) => socket.receive(JSON.stringify({
      jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args },
    }) + "\n");

    send(202, "get_browser_state", { target_id: "target-a", tab_id: "tab-a", snapshot_format: "semantic_v2" });
    await vi.waitFor(() => expect(socket.sent.length).toBe(1));
    expect(JSON.parse(socket.sent[0]!.toString()).result.isError).toBeUndefined();

    send(220, "browser_click", { target_id: "target-a", tab_id: "tab-a", ref: "p9:9" });
    await vi.waitFor(() => expect(socket.sent.length).toBe(2));
    expect(JSON.parse(socket.sent[1]!.toString())).toMatchObject({ result: { isError: true } });
    expect(beginAction).toHaveBeenCalledOnce();

    send(203, "browser_click", { target_id: "target-a", tab_id: "tab-a", ref: "p1:1" });
    await vi.waitFor(() => expect(socket.sent.length).toBe(3));
    expect(JSON.parse(socket.sent[2]!.toString()).result.content)
      .toContainEqual({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });

    send(204, "browser_click", { target_id: "target-a", tab_id: "tab-a", ref: "p1:1" });
    await vi.waitFor(() => expect(socket.sent.length).toBe(4));
    expect(JSON.parse(socket.sent[3]!.toString())).toMatchObject({ result: { isError: true } });
    expect(socket.sent[3]!.toString()).toContain("unknown or stale browser ref");
    expect(beginAction).toHaveBeenCalledTimes(2);

    send(205, "browser_type", { target_id: "target-a", tab_id: "tab-a", ref: "p9:9", text: "nope" });
    await vi.waitFor(() => expect(socket.sent.length).toBe(5));
    expect(JSON.parse(socket.sent[4]!.toString())).toMatchObject({ result: { isError: true } });
    expect(beginAction).toHaveBeenCalledTimes(2);

    send(221, "get_browser_state", { target_id: "target-a", tab_id: "tab-a" });
    await vi.waitFor(() => expect(socket.sent.length).toBe(6));
    send(222, "browser_click", { target_id: "target-a", tab_id: "tab-a", ref: "p1:1" });
    send(223, "browser_click", { target_id: "target-a", tab_id: "tab-a", ref: "p1:1" });
    await vi.waitFor(() => expect(socket.sent.length).toBe(8));
    const raced = socket.sent.slice(6).map((item) => JSON.parse(item.toString()));
    expect(raced.find((item) => item.id === 223)).toMatchObject({ result: { isError: true } });
    expect(raced.find((item) => item.id === 222)?.result.isError).toBeUndefined();
    expect(beginAction).toHaveBeenCalledTimes(4);

    handle.close("browser ref test complete");
    await handle.closed;
  });

  it("fails malformed browser state and action results instead of reporting success", async () => {
    const malformedStateSocket = new FakeSocket();
    const stateBegin = vi.fn(() => ({ allowed: true as const, actionId: "bad-state" }));
    const stateHandle = attachLocalVmMcpBroker(baseOptions(malformedStateSocket, {
      beginAction: stateBegin,
      spawnDriver: () => spawnResponder(semanticBrowserResponder({ malformedState: true })),
    }));
    malformedStateSocket.receive(JSON.stringify({
      jsonrpc: "2.0", id: 206, method: "tools/call",
      params: { name: "get_browser_state", arguments: { target_id: "target-a", tab_id: "tab-a" } },
    }) + "\n");
    await vi.waitFor(() => expect(malformedStateSocket.sent.length).toBe(1));
    expect(JSON.parse(malformedStateSocket.sent[0]!.toString())).toMatchObject({ result: { isError: true } });
    malformedStateSocket.receive(JSON.stringify({
      jsonrpc: "2.0", id: 207, method: "tools/call",
      params: { name: "browser_click", arguments: { target_id: "target-a", tab_id: "tab-a", ref: "p1:1" } },
    }) + "\n");
    await vi.waitFor(() => expect(malformedStateSocket.sent.length).toBe(2));
    expect(stateBegin).toHaveBeenCalledOnce();
    stateHandle.close("malformed state test complete");
    await stateHandle.closed;

    const malformedActionSocket = new FakeSocket();
    let actionId = 0;
    const captureAfterAction = vi.fn(async () => ({ data: "iVBORw0KGgo=", mimeType: "image/png" as const }));
    const actionHandle = attachLocalVmMcpBroker(baseOptions(malformedActionSocket, {
      beginAction: () => ({ allowed: true as const, actionId: `malformed-${++actionId}` }),
      captureAfterAction,
      spawnDriver: () => spawnResponder(semanticBrowserResponder({ malformedAction: true })),
    }));
    malformedActionSocket.receive(JSON.stringify({
      jsonrpc: "2.0", id: 208, method: "tools/call",
      params: { name: "get_browser_state", arguments: { target_id: "target-a", tab_id: "tab-a" } },
    }) + "\n");
    await vi.waitFor(() => expect(malformedActionSocket.sent.length).toBe(1));
    malformedActionSocket.receive(JSON.stringify({
      jsonrpc: "2.0", id: 209, method: "tools/call",
      params: { name: "browser_type", arguments: { target_id: "target-a", tab_id: "tab-a", ref: "p1:2", text: "credential-value", replace: true } },
    }) + "\n");
    await vi.waitFor(() => expect(malformedActionSocket.sent.length).toBe(2));
    const malformedAction = JSON.parse(malformedActionSocket.sent[1]!.toString());
    expect(malformedAction.result.isError).toBe(true);
    expect(malformedAction.result.content).toContainEqual({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
    expect(malformedActionSocket.sent[1]!.toString()).not.toContain("credential-value");
    actionHandle.close("malformed action test complete");
    await actionHandle.closed;
  });

  it("redacts successful upload paths and fails a later mutation when trusted capture is absent", async () => {
    const socket = new FakeSocket();
    let actionId = 0;
    const captureAfterAction = vi.fn()
      .mockResolvedValueOnce({ data: "iVBORw0KGgo=", mimeType: "image/png" as const })
      .mockResolvedValueOnce(null);
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      beginAction: () => ({ allowed: true as const, actionId: `capture-${++actionId}` }),
      captureAfterAction,
      spawnDriver: () => spawnResponder(semanticBrowserResponder()),
    }));
    const send = (id: number, name: string, args: Record<string, unknown>) => socket.receive(JSON.stringify({
      jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args },
    }) + "\n");
    send(210, "get_browser_state", { target_id: "target-a", tab_id: "tab-a" });
    await vi.waitFor(() => expect(socket.sent.length).toBe(1));
    send(211, "browser_set_input_files", {
      target_id: "target-a", tab_id: "tab-a", ref: "p1:3", files: ["/tmp/private-upload-name.txt"],
    });
    await vi.waitFor(() => expect(socket.sent.length).toBe(2));
    const uploadRaw = socket.sent[1]!.toString();
    expect(JSON.parse(uploadRaw).result.isError).toBeUndefined();
    expect(uploadRaw).not.toContain("private-upload-name.txt");
    expect(uploadRaw).toContain("[REDACTED]");

    send(224, "get_browser_state", { target_id: "target-a", tab_id: "tab-a" });
    await vi.waitFor(() => expect(socket.sent.length).toBe(3));
    send(225, "browser_click", { target_id: "target-a", tab_id: "tab-a", ref: "p1:1" });
    await vi.waitFor(() => expect(socket.sent.length).toBe(4));
    const failureRaw = socket.sent[3]!.toString();
    expect(JSON.parse(failureRaw)).toMatchObject({ result: { isError: true } });
    expect(failureRaw).toContain("no bounded trusted post-action image");
    expect(captureAfterAction).toHaveBeenNthCalledWith(1, "browser_set_input_files");
    expect(captureAfterAction).toHaveBeenNthCalledWith(2, "browser_click");
    handle.close("capture failure test complete");
    await handle.closed;
  });

  it("bounds semantic state and explicitly rejects unsupported browser aliases", async () => {
    const socket = new FakeSocket();
    const beginAction = vi.fn(() => ({ allowed: true as const, actionId: "bounded" }));
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      beginAction,
      spawnDriver: () => spawnResponder(semanticBrowserResponder({ oversizedState: true })),
    }));
    socket.receive(JSON.stringify({
      jsonrpc: "2.0", id: 212, method: "tools/call",
      params: { name: "get_browser_state", arguments: { target_id: "target-a", tab_id: "tab-a" } },
    }) + "\n");
    await vi.waitFor(() => expect(socket.sent.length).toBe(1));
    expect(JSON.parse(socket.sent[0]!.toString())).toMatchObject({ result: { isError: true } });
    expect(socket.sent[0]!.byteLength).toBeLessThan(10_000);

    for (const [offset, name] of ["browser_state", "browser_fill", "browser_upload"].entries()) {
      socket.receive(JSON.stringify({
        jsonrpc: "2.0", id: 213 + offset, method: "tools/call", params: { name, arguments: {} },
      }) + "\n");
    }
    await vi.waitFor(() => expect(socket.sent.length).toBe(4));
    for (const response of socket.sent.slice(1)) {
      expect(JSON.parse(response.toString())).toMatchObject({ result: { isError: true } });
      expect(response.toString()).toContain("is not a Cua Driver tool");
    }
    expect(beginAction).toHaveBeenCalledOnce();
    handle.close("bounded browser test complete");
    await handle.closed;
  });

  it("runs a validated batch sequentially under one ticket and returns only one final screen", async () => {
    const socket = new FakeSocket();
    const accountingOrder: string[] = [];
    const beginAction = vi.fn(() => { accountingOrder.push("permit"); return { allowed: true as const, actionId: "batch-ticket" }; });
    const onActions = vi.fn((amount: number) => { accountingOrder.push(`account:${amount}`); return amount; });
    const endAction = vi.fn(() => true);
    const onChildCursor = vi.fn();
    const onChildFrame = vi.fn();
    const captureAfterAction = vi.fn(async (toolName: string) => {
      expect(toolName).toBe("press_key");
      return { data: "iVBORw0KGgo=", mimeType: "image/png" as const };
    });
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      beginAction,
      onActions,
      requireActionAccounting: true,
      endAction,
      captureAfterAction,
      onChildCursor,
      onChildFrame,
      maxToolCalls: 3,
    }));
    socket.receive(JSON.stringify({
      jsonrpc: "2.0",
      id: 101,
      method: "tools/call",
      params: {
        name: "computer_batch",
        arguments: { actions: [
          { name: "click", arguments: { x: 10, y: 20 } },
          { name: "type_text", arguments: { text: "hello", pid: 1, window_id: 2, delivery_mode: "foreground" } },
          { name: "press_key", arguments: { key: "enter", pid: 1, window_id: 2, delivery_mode: "foreground" } },
        ] },
      },
    }) + "\n");
    await vi.waitFor(() => expect(socket.sent.some((bytes) => JSON.parse(bytes.toString()).id === 101)).toBe(true));
    const frames = socket.sent.map((bytes) => JSON.parse(bytes.toString()));
    const response = frames.find((frame) => frame.id === 101);
    expect(beginAction).toHaveBeenCalledOnce();
    expect(onActions).toHaveBeenCalledWith(3);
    expect(accountingOrder).toEqual(["permit", "account:3"]);
    expect(endAction).toHaveBeenCalledOnce();
    expect(endAction).toHaveBeenCalledWith("batch-ticket");
    expect(captureAfterAction).toHaveBeenCalledOnce();
    expect(response.result.isError).toBeUndefined();
    expect(response.result.content.filter((item: { type?: string }) => item.type === "image")).toEqual([
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]);
    expect(onChildCursor).toHaveBeenCalledExactlyOnceWith({ x: 10, y: 20 });
    expect(onChildFrame).toHaveBeenCalledExactlyOnceWith({
      mime: "image/png",
      data: "iVBORw0KGgo=",
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(frames)).not.toContain("__openmaus_computer_batch_");
    handle.close("batch complete");
    await handle.closed;
  });

  it("releases the permit and forwards no ordinary action when authoritative accounting fails", async () => {
    const socket = new FakeSocket();
    const beginAction = vi.fn(() => ({ allowed: true as const, actionId: "accounting-ticket" }));
    const endAction = vi.fn(() => true);
    const onActions = vi.fn(() => { throw new Error("child action budget exhausted"); });
    const captureAfterAction = vi.fn(async () => ({ data: "aW1hZ2U=", mimeType: "image/png" as const }));
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      beginAction,
      endAction,
      onActions,
      requireActionAccounting: true,
      captureAfterAction,
    }));
    socket.receive(JSON.stringify({
      jsonrpc: "2.0",
      id: 104,
      method: "tools/call",
      params: { name: "click", arguments: { x: 10, y: 20 } },
    }) + "\n");
    await vi.waitFor(() => expect(socket.sent.length).toBe(1));
    const response = JSON.parse(socket.sent[0]!.toString());
    expect(response).toMatchObject({ id: 104, result: { isError: true } });
    expect(beginAction).toHaveBeenCalledOnce();
    expect(onActions).toHaveBeenCalledWith(1);
    expect(endAction).toHaveBeenCalledExactlyOnceWith("accounting-ticket");
    expect(captureAfterAction).not.toHaveBeenCalled();
    handle.close("accounting rejection complete");
    await handle.closed;
  });

  it("fails a required child closed when its action accountant is missing", async () => {
    const socket = new FakeSocket();
    const endAction = vi.fn(() => true);
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      requireActionAccounting: true,
      onActions: undefined,
      endAction,
    }));
    socket.receive(JSON.stringify({
      jsonrpc: "2.0",
      id: 106,
      method: "tools/call",
      params: { name: "click", arguments: { x: 1, y: 2 } },
    }) + "\n");
    await vi.waitFor(() => expect(socket.sent.length).toBe(1));
    expect(JSON.parse(socket.sent[0]!.toString())).toMatchObject({ id: 106, result: { isError: true } });
    expect(endAction).toHaveBeenCalledExactlyOnceWith("action-a");
    handle.close("missing accounting rejection complete");
    await handle.closed;
  });

  it("rejects a whole batch before reservation or forwarding when authoritative accounting fails", async () => {
    const socket = new FakeSocket();
    const beginAction = vi.fn(() => ({ allowed: true as const, actionId: "batch-accounting-ticket" }));
    const endAction = vi.fn(() => true);
    const onActions = vi.fn(() => { throw new Error("child action budget exhausted"); });
    const captureAfterAction = vi.fn(async () => ({ data: "aW1hZ2U=", mimeType: "image/png" as const }));
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      beginAction,
      endAction,
      onActions,
      requireActionAccounting: true,
      captureAfterAction,
    }));
    socket.receive(JSON.stringify({
      jsonrpc: "2.0",
      id: 105,
      method: "tools/call",
      params: { name: "computer_batch", arguments: { actions: [
        { name: "click", arguments: { x: 10, y: 20 } },
        { name: "press_key", arguments: { key: "enter", pid: 1, window_id: 2, delivery_mode: "foreground" } },
      ] } },
    }) + "\n");
    await vi.waitFor(() => expect(socket.sent.length).toBe(1));
    const response = JSON.parse(socket.sent[0]!.toString());
    expect(response).toMatchObject({ id: 105, result: { isError: true } });
    expect(response.result.content[0].text).toContain("accounting is unavailable");
    expect(onActions).toHaveBeenCalledWith(2);
    expect(endAction).toHaveBeenCalledExactlyOnceWith("batch-accounting-ticket");
    expect(captureAfterAction).not.toHaveBeenCalled();
    handle.close("batch accounting rejection complete");
    await handle.closed;
  });

  it("retries only the final observation after a transient capture failure", async () => {
    const socket = new FakeSocket();
    const captureAfterAction = vi.fn()
      .mockRejectedValueOnce(new Error("guest screenshot socket was briefly busy"))
      .mockResolvedValueOnce({ data: "aW1hZ2U=", mimeType: "image/png" as const });
    const handle = attachLocalVmMcpBroker(baseOptions(socket, { captureAfterAction }));
    socket.receive(JSON.stringify({
      jsonrpc: "2.0",
      id: 111,
      method: "tools/call",
      params: { name: "computer_batch", arguments: { actions: [{ name: "press_key", arguments: { key: "enter", pid: 1, window_id: 2, delivery_mode: "foreground" } }] } },
    }) + "\n");
    await vi.waitFor(() => expect(socket.sent.some((bytes) => JSON.parse(bytes.toString()).id === 111)).toBe(true));
    const response = socket.sent.map((bytes) => JSON.parse(bytes.toString())).find((frame) => frame.id === 111);
    expect(captureAfterAction).toHaveBeenCalledTimes(2);
    expect(response.result.isError).toBeUndefined();
    expect(JSON.stringify(response)).toContain('"type":"image"');
    handle.close("capture retry complete");
    await handle.closed;
  });

  it("rejects ten batch actions atomically without truncation or a control ticket", async () => {
    const socket = new FakeSocket();
    const beginAction = vi.fn(() => ({ allowed: true as const, actionId: "must-not-run" }));
    const handle = attachLocalVmMcpBroker(baseOptions(socket, { beginAction }));
    socket.receive(JSON.stringify({
      jsonrpc: "2.0",
      id: 102,
      method: "tools/call",
      params: {
        name: "computer_batch",
        arguments: { actions: Array.from({ length: 10 }, () => ({ name: "press_key", arguments: { key: "tab", pid: 1, window_id: 2, delivery_mode: "foreground" } })) },
      },
    }) + "\n");
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    const response = JSON.parse(socket.sent[0]!.toString());
    expect(response).toMatchObject({ id: 102, result: { isError: true } });
    expect(JSON.stringify(response)).toContain("was not run");
    expect(beginAction).not.toHaveBeenCalled();
    handle.close("invalid batch complete");
    await handle.closed;
  });

  it("shares the nine-action turn budget across ordinary actions and repeated batches", async () => {
    const socket = new FakeSocket();
    let ticket = 0;
    const beginAction = vi.fn(() => ({ allowed: true as const, actionId: `budget-${++ticket}` }));
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      beginAction,
      captureAfterAction: async () => ({ data: "aW1hZ2U=", mimeType: "image/png" as const }),
    }));
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 110, method: "tools/call", params: { name: "click", arguments: { x: 1, y: 1 } } }) + "\n");
    await vi.waitFor(() => expect(socket.sent.some((bytes) => JSON.parse(bytes.toString()).id === 110)).toBe(true));
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 111, method: "tools/call", params: { name: "computer_batch", arguments: { actions: Array.from({ length: 8 }, () => ({ name: "press_key", arguments: { key: "tab", pid: 1, window_id: 2, delivery_mode: "foreground" } })) } } }) + "\n");
    await vi.waitFor(() => expect(socket.sent.some((bytes) => JSON.parse(bytes.toString()).id === 111)).toBe(true));
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 112, method: "tools/call", params: { name: "computer_batch", arguments: { actions: [{ name: "click", arguments: { x: 2, y: 2 } }] } } }) + "\n");
    await vi.waitFor(() => expect(socket.sent.some((bytes) => JSON.parse(bytes.toString()).id === 112)).toBe(true));
    const rejected = socket.sent.map((bytes) => JSON.parse(bytes.toString())).find((frame) => frame.id === 112);
    expect(rejected.result.isError).toBe(true);
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 113, method: "tools/call", params: { name: "click", arguments: { x: 3, y: 3 } } }) + "\n");
    await vi.waitFor(() => expect(socket.sent.some((bytes) => JSON.parse(bytes.toString()).id === 113)).toBe(true));
    const rejectedSingle = socket.sent.map((bytes) => JSON.parse(bytes.toString())).find((frame) => frame.id === 113);
    expect(rejectedSingle.result.isError).toBe(true);
    expect(beginAction).toHaveBeenCalledTimes(2);
    handle.close("shared budget complete");
    await handle.closed;
  });

  it("supports a larger whole-turn budget while keeping each batch capped at nine", async () => {
    const socket = new FakeSocket();
    let ticket = 0;
    const beginAction = vi.fn(() => ({ allowed: true as const, actionId: `extended-${++ticket}` }));
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      beginAction,
      maxComputerActions: 10,
      captureAfterAction: async () => ({ data: "aW1hZ2U=", mimeType: "image/png" as const }),
    }));
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 120, method: "tools/call", params: { name: "click", arguments: { x: 1, y: 1 } } }) + "\n");
    await vi.waitFor(() => expect(socket.sent.some((bytes) => JSON.parse(bytes.toString()).id === 120)).toBe(true));
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 121, method: "tools/call", params: { name: "computer_batch", arguments: { actions: Array.from({ length: 9 }, () => ({ name: "press_key", arguments: { key: "tab", pid: 1, window_id: 2, delivery_mode: "foreground" } })) } } }) + "\n");
    await vi.waitFor(() => expect(socket.sent.some((bytes) => JSON.parse(bytes.toString()).id === 121)).toBe(true));
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 122, method: "tools/call", params: { name: "click", arguments: { x: 2, y: 2 } } }) + "\n");
    await vi.waitFor(() => expect(socket.sent.some((bytes) => JSON.parse(bytes.toString()).id === 122)).toBe(true));
    const rejected = socket.sent.map((bytes) => JSON.parse(bytes.toString())).find((frame) => frame.id === 122);
    expect(rejected.result.isError).toBe(true);
    expect(beginAction).toHaveBeenCalledTimes(2);
    handle.close("extended budget complete");
    await handle.closed;
  });

  it("does not interleave a second provider request while the batch ticket is held", async () => {
    const socket = new FakeSocket();
    const delayed = String.raw`
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      rl.on("line", (line) => { const frame = JSON.parse(line); setTimeout(() => {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { content: [] } }) + "\n");
      }, 100); });
    `;
    let ticket = 0;
    const beginAction = vi.fn(() => ({ allowed: true as const, actionId: `ticket-${++ticket}` }));
    const endAction = vi.fn(() => true);
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      beginAction,
      endAction,
      captureAfterAction: async () => ({ data: "aW1hZ2U=", mimeType: "image/png" as const }),
      spawnDriver: () => spawnResponder(delayed),
    }));
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 103, method: "tools/call", params: { name: "computer_batch", arguments: { actions: [{ name: "click", arguments: { x: 1, y: 1 } }] } } }) + "\n");
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 104, method: "tools/call", params: { name: "click", arguments: { x: 2, y: 2 } } }) + "\n");
    await vi.waitFor(() => expect(beginAction).toHaveBeenCalledOnce(), { timeout: 80 });
    expect(endAction).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(beginAction).toHaveBeenCalledTimes(2));
    expect(endAction.mock.calls[0]).toEqual(["ticket-1"]);
    handle.close("interleave test complete");
    await handle.closed;
  });

  it("settles a driver-error batch without capturing or leaking the driver error", async () => {
    const socket = new FakeSocket();
    const beginAction = vi.fn(() => ({ allowed: true as const, actionId: "action-a" }));
    const endAction = vi.fn(() => true);
    const captureAfterAction = vi.fn();
    const failing = String.raw`
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      rl.on("line", (line) => { const frame = JSON.parse(line);
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: 99, message: "secret runtime path /var/run/host" } }) + "\n");
      });
    `;
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      beginAction,
      endAction,
      captureAfterAction,
      spawnDriver: () => spawnResponder(failing),
    }));
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 105, method: "tools/call", params: { name: "computer_batch", arguments: { actions: Array.from({ length: 9 }, () => ({ name: "click", arguments: { x: 1, y: 1 } })) } } }) + "\n");
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    const response = socket.sent.map((bytes) => bytes.toString()).join("");
    expect(response).toContain('"isError":true');
    expect(response).not.toContain("secret runtime path");
    expect(captureAfterAction).not.toHaveBeenCalled();
    expect(endAction).toHaveBeenCalledOnce();
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 108, method: "tools/call", params: { name: "click", arguments: { x: 2, y: 2 } } }) + "\n");
    await vi.waitFor(() => expect(socket.sent.some((bytes) => JSON.parse(bytes.toString()).id === 108)).toBe(true));
    expect(beginAction).toHaveBeenCalledOnce();
    handle.close("driver error complete");
    await handle.closed;
  });

  it.each([
    ["nested MCP error", `{ content: [], isError: true }`],
    ["nested error object", `{ content: [], error: { message: "private detail" } }`],
    ["malformed result", `"unexpected"`],
    ["malformed truthy isError", `{ content: [], isError: "yes" }`],
  ])("fails closed for a %s in a batch action", async (_label, resultSource) => {
    const socket = new FakeSocket();
    const captureAfterAction = vi.fn();
    const script = String.raw`
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      rl.on("line", (line) => { const frame = JSON.parse(line);
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: ${resultSource} }) + "\n");
      });
    `;
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      captureAfterAction,
      spawnDriver: () => spawnResponder(script),
    }));
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 112, method: "tools/call", params: { name: "computer_batch", arguments: { actions: [{ name: "press_key", arguments: { key: "enter", pid: 1, window_id: 2, delivery_mode: "foreground" } }] } } }) + "\n");
    await vi.waitFor(() => expect(socket.sent.some((bytes) => JSON.parse(bytes.toString()).id === 112)).toBe(true));
    const response = socket.sent.map((bytes) => JSON.parse(bytes.toString())).find((frame) => frame.id === 112);
    expect(response.result.isError).toBe(true);
    expect(captureAfterAction).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain("private detail");
    handle.close("nested failure complete");
    await handle.closed;
  });

  it("marks a completed ordinary mutation unproven when post-action capture throws", async () => {
    const socket = new FakeSocket();
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      captureAfterAction: async () => { throw new Error("private screenshot failure"); },
    }));
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 113, method: "tools/call", params: { name: "click", arguments: { x: 1, y: 2 } } }) + "\n");
    await vi.waitFor(() => expect(socket.sent.some((bytes) => JSON.parse(bytes.toString()).id === 113)).toBe(true));
    const response = socket.sent.map((bytes) => JSON.parse(bytes.toString())).find((frame) => frame.id === 113);
    expect(response.result.isError).toBe(true);
    expect(JSON.stringify(response)).toContain("FAILED: visual postcondition unproven");
    expect(JSON.stringify(response)).not.toContain("private screenshot failure");
    handle.close("ordinary capture failure complete");
    await handle.closed;
  });

  it("fails closed on a malformed ordinary mutation result", async () => {
    const socket = new FakeSocket();
    const captureAfterAction = vi.fn();
    const malformed = String.raw`
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      rl.on("line", (line) => { const frame = JSON.parse(line);
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: "unexpected private value" }) + "\n");
      });
    `;
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      captureAfterAction,
      spawnDriver: () => spawnResponder(malformed),
    }));
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 114, method: "tools/call", params: { name: "click", arguments: { x: 1, y: 2 } } }) + "\n");
    await vi.waitFor(() => expect(socket.sent.some((bytes) => JSON.parse(bytes.toString()).id === 114)).toBe(true));
    const response = socket.sent.map((bytes) => JSON.parse(bytes.toString())).find((frame) => frame.id === 114);
    expect(response.result.isError).toBe(true);
    expect(JSON.stringify(response)).toContain("malformed driver result");
    expect(JSON.stringify(response)).not.toContain("unexpected private value");
    expect(captureAfterAction).not.toHaveBeenCalled();
    handle.close("ordinary malformed result complete");
    await handle.closed;
  });

  it("reports a missing final capture as an error after safely releasing the batch ticket", async () => {
    const socket = new FakeSocket();
    const endAction = vi.fn(() => true);
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      endAction,
      captureAfterAction: async () => null,
    }));
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 109, method: "tools/call", params: { name: "computer_batch", arguments: { actions: [{ name: "click", arguments: { x: 1, y: 1 } }] } } }) + "\n");
    await vi.waitFor(() => expect(socket.sent.some((bytes) => JSON.parse(bytes.toString()).id === 109)).toBe(true));
    const response = socket.sent.map((bytes) => JSON.parse(bytes.toString())).find((frame) => frame.id === 109);
    expect(response.result.isError).toBe(true);
    expect(JSON.stringify(response)).toContain("final screenshot was unavailable");
    expect(endAction).toHaveBeenCalledOnce();
    handle.close("capture failure complete");
    await handle.closed;
  });

  it("fails closed and quarantines when a completed batch ticket cannot be released", async () => {
    const socket = new FakeSocket();
    const quarantine = vi.fn();
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      endAction: () => false,
      quarantine,
      captureAfterAction: async () => ({ data: "aW1hZ2U=", mimeType: "image/png" as const }),
    }));
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 106, method: "tools/call", params: { name: "computer_batch", arguments: { actions: [{ name: "press_key", arguments: { key: "tab", pid: 1, window_id: 2, delivery_mode: "foreground" } }] } } }) + "\n");
    await handle.closed;
    await vi.waitFor(() => expect(quarantine).toHaveBeenCalledOnce());
    expect(socket.open).toBe(false);
    expect(socket.sent.some((bytes) => JSON.parse(bytes.toString()).id === 106)).toBe(false);
  });

  it("quarantines a batch ticket when teardown interrupts an unanswered action", async () => {
    const socket = new FakeSocket();
    const quarantine = vi.fn();
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      quarantine,
      responseTimeoutMs: 100,
      spawnDriver: () => spawnResponder("setInterval(() => {}, 1000);"),
    }));
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 107, method: "tools/call", params: { name: "computer_batch", arguments: { actions: [{ name: "click", arguments: { x: 1, y: 1 } }] } } }) + "\n");
    await handle.closed;
    await vi.waitFor(() => expect(quarantine).toHaveBeenCalledOnce());
  });

  it("gates an exact action, correlates its result, and reaps the runtime process group", async () => {
    const socket = new FakeSocket();
    const beginAction = vi.fn(() => ({ allowed: true as const, actionId: "action-7" }));
    const endAction = vi.fn(() => true);
    let child!: ChildProcessWithoutNullStreams;
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      beginAction,
      endAction,
      spawnDriver: (authority: LocalVmMcpAuthority) => {
        expect(authority).toBe(AUTHORITY);
        child = spawnResponder();
        return child;
      },
    }));

    const call = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "click", arguments: {} } });
    socket.receive(call + "\n");
    await vi.waitFor(() => expect(endAction).toHaveBeenCalledWith("action-7"));
    expect(beginAction).toHaveBeenCalledOnce();
    expect(socket.sent.map((value) => value.toString()).join("")).toContain('"id":7');

    const pid = child.pid!;
    handle.close("test complete");
    await handle.closed;
    expect(await processGone(pid)).toBe(true);
  });

  it("returns the resulting screen with a visual action in one act-observe response", async () => {
    const socket = new FakeSocket();
    const captureAfterAction = vi.fn(async (toolName: string) => {
      expect(toolName).toBe("click");
      return { data: "aW1hZ2U=", mimeType: "image/png" as const };
    });
    const handle = attachLocalVmMcpBroker(baseOptions(socket, { captureAfterAction }));

    socket.receive(JSON.stringify({
      jsonrpc: "2.0",
      id: 81,
      method: "tools/call",
      params: { name: "click", arguments: { x: 10, y: 20 } },
    }) + "\n");

    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    const response = JSON.parse(socket.sent.map((value) => value.toString()).join("").trim());
    expect(response.result.content).toContainEqual({
      type: "text",
      text: "Fresh post-action screen attached for click (sha256=8ee314812d71b74b906d8a49d5119930806da86b4ead9bed83c5a12bccf08c91). Inspect this image before requesting another desktop capture.",
    });
    expect(response.result.content).toContainEqual({
      type: "image",
      data: "aW1hZ2U=",
      mimeType: "image/png",
    });
    expect(captureAfterAction).toHaveBeenCalledOnce();

    handle.close("act-observe test complete");
    await handle.closed;
  });

  it("does not resend byte-identical post-action pixels", async () => {
    const socket = new FakeSocket();
    const captureAfterAction = vi.fn(async () => ({ data: "aW1hZ2U=", mimeType: "image/png" as const }));
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      captureAfterAction,
      beginAction: vi.fn()
        .mockReturnValueOnce({ allowed: true as const, actionId: "action-1" })
        .mockReturnValueOnce({ allowed: true as const, actionId: "action-2" }),
    }));

    for (const id of [91, 92]) {
      socket.receive(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "click", arguments: { x: 10, y: 20 } },
      }) + "\n");
      await vi.waitFor(() => expect(socket.sent.length).toBe(id - 90));
    }
    const responses = socket.sent.map((value) => JSON.parse(value.toString().trim()));
    expect(responses[0].result.content.filter((item: { type?: string }) => item.type === "image")).toHaveLength(1);
    expect(responses[1].result.content.filter((item: { type?: string }) => item.type === "image")).toHaveLength(0);
    expect(responses[1].result.content).toContainEqual({
      type: "text",
      text: "Post-action screen for click is unchanged (sha256=8ee314812d71b74b906d8a49d5119930806da86b4ead9bed83c5a12bccf08c91). Do not repeat the action; use the current screen or finish.",
    });

    handle.close("dedupe test complete");
    await handle.closed;
  });

  it("does not add redundant captures to read-only computer inspection", async () => {
    const socket = new FakeSocket();
    const captureAfterAction = vi.fn(async () => ({ data: "aW1hZ2U=", mimeType: "image/png" as const }));
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      captureAfterAction,
      requireActionAccounting: true,
      onActions: undefined,
    }));

    socket.receive(JSON.stringify({
      jsonrpc: "2.0",
      id: 82,
      method: "tools/call",
      params: { name: "get_desktop_state", arguments: {} },
    }) + "\n");

    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    expect(captureAfterAction).not.toHaveBeenCalled();

    handle.close("read-only observation test complete");
    await handle.closed;
  });

  it("rejects a stale/replaced VM generation before a tool byte reaches Cua", async () => {
    const socket = new FakeSocket();
    let checks = 0;
    const beginAction = vi.fn();
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      verifyCurrentGeneration: () => ++checks === 1,
      beginAction,
    }));
    await vi.waitFor(() => expect(checks).toBeGreaterThanOrEqual(1));
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "click" } }) + "\n");
    await handle.closed;
    expect(beginAction).not.toHaveBeenCalled();
    expect(socket.open).toBe(false);
  });

  it("treats a throwing authority revalidation as revoked without spawning Cua", async () => {
    const socket = new FakeSocket();
    const spawnDriver = vi.fn(() => spawnResponder());
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      stillAuthorized: () => { throw new Error("store unavailable"); },
      spawnDriver,
    }));
    await handle.closed;
    expect(spawnDriver).not.toHaveBeenCalled();
    expect(socket.open).toBe(false);
  });

  it("rejects a mixed JSON-RPC batch before an embedded Cua action can bypass ticketing", async () => {
    const socket = new FakeSocket();
    const beginAction = vi.fn(() => ({ allowed: true as const, actionId: "must-not-run" }));
    const handle = attachLocalVmMcpBroker(baseOptions(socket, { beginAction }));
    socket.receive(JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "click", arguments: {} } },
    ]) + "\n");
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    const response = JSON.parse(socket.sent[0]!.toString());
    expect(response).toMatchObject({ id: null, error: { code: -32600 } });
    expect(beginAction).not.toHaveBeenCalled();
    handle.close("batch test complete");
    await handle.closed;
  });

  it("rejects a duplicate in-flight request id without acquiring a second action", async () => {
    const socket = new FakeSocket();
    const delayedResponder = String.raw`
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      rl.on("line", (line) => {
        const frame = JSON.parse(line);
        if (frame.method === "tools/call") setTimeout(() => {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { content: [] } }) + "\n");
        }, 250);
      });
    `;
    let sequence = 0;
    const beginAction = vi.fn(() => ({ allowed: true as const, actionId: `action-${++sequence}` }));
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      beginAction,
      spawnDriver: () => spawnResponder(delayedResponder),
    }));
    const call = JSON.stringify({ jsonrpc: "2.0", id: "same", method: "tools/call", params: { name: "click" } }) + "\n";
    socket.receive(call);
    await vi.waitFor(() => expect(beginAction).toHaveBeenCalledOnce());
    socket.receive(call);
    await vi.waitFor(() => expect(socket.sent.some((bytes) => JSON.parse(bytes.toString()).error?.code === -32600)).toBe(true));
    expect(beginAction).toHaveBeenCalledOnce();
    handle.close("duplicate test complete");
    await handle.closed;
  });

  it("does not let a tool call reuse an unanswered initialize id to settle early", async () => {
    const socket = new FakeSocket();
    const delayedInitialize = String.raw`
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      rl.on("line", (line) => {
        const frame = JSON.parse(line);
        if (frame.method === "initialize") setTimeout(() => {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } }) + "\n");
        }, 250);
      });
    `;
    const beginAction = vi.fn(() => ({ allowed: true as const, actionId: "must-not-run" }));
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      beginAction,
      spawnDriver: () => spawnResponder(delayedInitialize),
    }));
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "initialize", params: {} }) + "\n");
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "click" } }) + "\n");
    await vi.waitFor(() => expect(socket.sent.some((bytes) => JSON.parse(bytes.toString()).error?.code === -32600)).toBe(true));
    expect(beginAction).not.toHaveBeenCalled();
    handle.close("cross-method duplicate test complete");
    await handle.closed;
  });

  it("quarantines an unanswered action and reaps its transport on provider disconnect", async () => {
    const socket = new FakeSocket();
    const silentResponder = String.raw`
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      rl.on("line", (line) => {
        const frame = JSON.parse(line);
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "fixture/received", params: { id: frame.id } }) + "\n");
      });
    `;
    const quarantine = vi.fn();
    let child!: ChildProcessWithoutNullStreams;
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      quarantine,
      spawnDriver: () => {
        child = spawnResponder(silentResponder);
        return child;
      },
    }));
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "click" } }) + "\n");
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    const pid = child.pid!;
    socket.disconnect();
    await handle.closed;
    expect(quarantine).toHaveBeenCalledOnce();
    expect(await processGone(pid)).toBe(true);
  });

  it("times out an unanswered Cua action, quarantines its ticket, and reaps the driver", async () => {
    const socket = new FakeSocket();
    const quarantine = vi.fn();
    let child!: ChildProcessWithoutNullStreams;
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      quarantine,
      responseTimeoutMs: 100,
      spawnDriver: () => {
        child = spawnResponder("setInterval(() => {}, 1000);");
        return child;
      },
    }));
    socket.receive(JSON.stringify({
      jsonrpc: "2.0",
      id: 19,
      method: "tools/call",
      params: { name: "click", arguments: {} },
    }) + "\n");
    await handle.closed;
    expect(quarantine).toHaveBeenCalledOnce();
    expect(await processGone(child.pid!)).toBe(true);
  });

  it("retires a failed tools/list id so it cannot block a later exact action", async () => {
    const socket = new FakeSocket();
    const beginAction = vi.fn(() => ({ allowed: true as const, actionId: "action-reused" }));
    const script = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -1, message: "failed" } }) + "\n");
  else if (frame.method === "tools/call") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { content: [] } }) + "\n");
});`;
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      beginAction,
      spawnDriver: () => spawnResponder(script),
    }));
    socket.receive(JSON.stringify({ jsonrpc: "2.0", id: 33, method: "tools/list" }) + "\n");
    await vi.waitFor(() => expect(socket.sent.map((value) => value.toString()).join(""))
      .toContain('"message":"failed"'));
    socket.receive(JSON.stringify({
      jsonrpc: "2.0",
      id: 33,
      method: "tools/call",
      params: { name: "click", arguments: {} },
    }) + "\n");
    await vi.waitFor(() => expect(beginAction).toHaveBeenCalledOnce());
    handle.close();
    await handle.closed;
  });

  it("fails closed if the trusted Cua driver emits a JSON-RPC batch", async () => {
    const socket = new FakeSocket();
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      spawnDriver: () => spawnResponder('process.stdout.write("[]\\n"); process.stdin.resume();'),
    }));
    await handle.closed;
    expect(socket.open).toBe(false);
    expect(socket.sent).toEqual([]);
  });

  it("bounds a backpressured async action queue and fails closed", async () => {
    const socket = new FakeSocket();
    let release!: (value: { allowed: false; reason: "unavailable" }) => void;
    const blocked = new Promise<{ allowed: false; reason: "unavailable" }>((resolve) => { release = resolve; });
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      beginAction: () => blocked,
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    for (let index = 0; index < 70; index += 1) {
      socket.receive(JSON.stringify({
        jsonrpc: "2.0",
        id: index,
        method: "tools/call",
        params: { name: "click", arguments: {} },
      }) + "\n");
    }
    release({ allowed: false, reason: "unavailable" });
    await handle.closed;
    expect(socket.open).toBe(false);
  });

  it("never replays a startup-queued MCP frame when child stdin applies backpressure", async () => {
    const socket = new FakeSocket();
    let releaseStartup!: (current: boolean) => void;
    const startup = new Promise<boolean>((resolve) => { releaseStartup = resolve; });
    const countingDriver = String.raw`
      const readline = require("node:readline");
      let count = 0;
      const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      rl.on("line", () => { count += 1; });
      rl.on("close", () => {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "fixture/count", params: { count } }) + "\n");
      });
    `;
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      verifyCurrentGeneration: () => startup,
      spawnDriver: () => spawnResponder(countingDriver),
    }));
    const frameCount = 50;
    for (let index = 0; index < frameCount; index += 1) {
      socket.receive(JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { index, padding: "x".repeat(50_000) },
      }) + "\n");
    }
    socket.receive(Buffer.alloc(0));
    releaseStartup(true);
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0), { timeout: 10_000 });
    const count = socket.sent.map((bytes) => JSON.parse(bytes.toString()))
      .find((frame) => frame.method === "fixture/count")?.params.count;
    expect(count).toBe(frameCount);
    handle.close("backpressure replay test complete");
    await handle.closed;
  });

  it("reaps docker-exec descendants, not merely the direct broker child", async () => {
    const socket = new FakeSocket();
    const descendantScript = String.raw`
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "fixture/descendant", params: { pid: child.pid } }) + "\n");
      process.stdin.resume();
    `;
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      spawnDriver: () => spawnResponder(descendantScript),
    }));
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    const notification = JSON.parse(socket.sent[0]!.toString());
    const descendantPid = notification.params.pid as number;
    expect(descendantPid).toBeGreaterThan(1);

    handle.close("Stop");
    await handle.closed;
    expect(await processGone(descendantPid)).toBe(true);
  });

  it("caps the whole turn even when frames are individually small", async () => {
    const socket = new FakeSocket();
    const handle = attachLocalVmMcpBroker(baseOptions(socket));
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (let index = 0; index <= LOCAL_VM_MAX_MCP_FRAMES; index += 1) {
      socket.receive(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { index } }) + "\n");
      if (!socket.open) break;
    }
    await handle.closed;
    expect(socket.open).toBe(false);
  });

  it("caps a noisy Cua driver's whole-turn output even when every frame is small", async () => {
    const socket = new FakeSocket();
    const noisyDriver = String.raw`
      let index = 0;
      function send() {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "fixture/noise", params: { index } }) + "\n");
        index += 1;
        if (index <= ${LOCAL_VM_MAX_MCP_FRAMES}) setImmediate(send);
        else setInterval(() => {}, 1000);
      }
      send();
    `;
    const handle = attachLocalVmMcpBroker(baseOptions(socket, {
      spawnDriver: () => spawnResponder(noisyDriver),
    }));
    await handle.closed;
    expect(socket.open).toBe(false);
    expect(socket.sent.length).toBeLessThanOrEqual(LOCAL_VM_MAX_MCP_FRAMES);
  });

  it("counts locally handled help calls against the whole-turn tool quota", async () => {
    const socket = new FakeSocket();
    const requestHelp = vi.fn(async () => ({ text: "done" }));
    const handle = attachLocalVmMcpBroker(baseOptions(socket, { requestHelp, maxToolCalls: 2 }));
    for (let id = 1; id <= 2; id += 1) {
      socket.receive(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "computer_request_help", arguments: { reason: `help-${id}` } },
      }) + "\n");
      await vi.waitFor(() => expect(socket.sent.some((bytes) => JSON.parse(bytes.toString()).id === id)).toBe(true));
    }
    socket.receive(JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "computer_request_help", arguments: { reason: "help-3" } },
    }) + "\n");
    await handle.closed;
    expect(requestHelp).toHaveBeenCalledTimes(2);
    expect(socket.open).toBe(false);
  });

  it.runIf(process.env.OMB_RAZER_LOCAL_VM_ACCEPTANCE === "1")(
    "drives the real isolated Razer Cua MCP through a gated screenshot and click",
    async () => {
      const botId = process.env.OMB_RAZER_LOCAL_VM_BOT_ID?.trim();
      const target = botId ? perBotLocalVmTarget(botId) : SHARED_LOCAL_VM_TARGET;
      const status = await containerComputerStatus(undefined, "linux", target);
      expect(status).toMatchObject({ runtime: "docker", ready: true, target_key: target.key });
      expect(status.vm_generation).toMatch(/^[a-f0-9]{64}$/);

      const socket = new FakeSocket();
      let actionSequence = 0;
      const beginAction = vi.fn(() => ({ allowed: true as const, actionId: `razer-action-${++actionSequence}` }));
      const endAction = vi.fn(() => true);
      const authority: LocalVmMcpAuthority = Object.freeze({
        ...AUTHORITY,
        targetKey: target.key,
        containerName: target.containerName,
        vmGeneration: status.vm_generation!,
      });
      const handle = attachLocalVmMcpBroker({
        broker: socket as unknown as RawWebSocket,
        authority,
        stillAuthorized: () => true,
        verifyCurrentGeneration: async () =>
          await currentContainerComputerGeneration("docker", target) === authority.vmGeneration,
        beginAction,
        endAction,
        quarantine: vi.fn(),
        requestHelp: async () => ({ text: "not needed" }),
        generationPollMs: 60_000,
      });

      const frames = () => socket.sent.flatMap((bytes) => bytes.toString("utf8").trim().split("\n"))
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const waitForId = async (id: number) => {
        await vi.waitFor(() => expect(frames().some((frame) => frame.id === id)).toBe(true), { timeout: 45_000 });
        return frames().find((frame) => frame.id === id)!;
      };
      const send = (frame: unknown) => socket.receive(JSON.stringify(frame) + "\n");

      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "openmaus-razer-acceptance", version: "1" } },
      });
      expect((await waitForId(1)).error).toBeUndefined();
      send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const catalog = await waitForId(2);
      expect(catalog.result.tools.map((tool: { name: string }) => tool.name)).toEqual(
        expect.arrayContaining(["get_desktop_state", "click", "computer_request_help"]),
      );

      send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_desktop_state", arguments: {} } });
      const screenshot = await waitForId(3);
      expect(screenshot.error).toBeUndefined();
      expect(JSON.stringify(screenshot.result)).toMatch(/image|screenshot/i);

      // Top-left desktop background is the acceptance-safe target: it proves
      // a gated pointer action without launching or mutating an application.
      send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "click", arguments: { x: 2, y: 2 } } });
      expect((await waitForId(4)).error).toBeUndefined();
      expect(beginAction).toHaveBeenCalledTimes(2);
      expect(endAction).toHaveBeenCalledTimes(2);

      handle.close("Razer acceptance complete");
      await handle.closed;
    },
    180_000,
  );
});
