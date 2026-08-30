import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  LOCAL_VM_MAX_MCP_FRAMES,
  LocalVmMcpAdmissions,
  attachLocalVmMcpBroker,
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

describe.skipIf(process.platform === "win32")("trusted Local VM MCP broker", () => {
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
      text: "Fresh post-action screen attached for click. Inspect this image before requesting another desktop capture.",
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

  it("does not add redundant captures to read-only computer inspection", async () => {
    const socket = new FakeSocket();
    const captureAfterAction = vi.fn(async () => ({ data: "aW1hZ2U=", mimeType: "image/png" as const }));
    const handle = attachLocalVmMcpBroker(baseOptions(socket, { captureAfterAction }));

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
