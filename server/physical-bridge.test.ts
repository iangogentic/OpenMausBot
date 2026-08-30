import { describe, expect, it, vi } from "vitest";

import {
  PhysicalApprovalGate,
  PhysicalBridgeRegistry,
  attachPhysicalMcpBroker,
} from "./physical-bridge.ts";
import { ComputerControl } from "./computer-control.ts";
import type { RawWebSocket, RawWebSocketMessage } from "./raw-websocket.ts";

class FakeSocket {
  open = true;
  backpressured = false;
  readonly sent: Array<{ type: "text" | "binary"; data: Buffer }> = [];
  private readonly messages = new Set<(message: RawWebSocketMessage) => void>();
  private readonly closes = new Set<() => void>();

  onMessage(listener: (message: RawWebSocketMessage) => void) {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }
  onClose(listener: () => void) {
    this.closes.add(listener);
    return () => this.closes.delete(listener);
  }
  onDrain(_listener: () => void) { return () => {}; }
  pauseInput() {}
  resumeInput() {}
  sendText(value: string) {
    if (!this.open) return false;
    this.sent.push({ type: "text", data: Buffer.from(value) });
    return true;
  }
  sendBinary(value: Buffer) {
    if (!this.open) return false;
    this.sent.push({ type: "binary", data: Buffer.from(value) });
    return true;
  }
  ping() { return this.open; }
  close() { this.disconnect(); }
  destroy() { this.disconnect(); }
  receive(value: Record<string, unknown> | Buffer, binary = false) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    for (const listener of [...this.messages]) listener({ binary, data });
  }
  disconnect() {
    if (!this.open) return;
    this.open = false;
    const listeners = [...this.closes];
    this.closes.clear();
    for (const listener of listeners) listener();
  }
  frames() {
    return this.sent.filter((entry) => entry.type === "text").map((entry) => JSON.parse(entry.data.toString()));
  }
}

const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
];

function attach(registry: PhysicalBridgeRegistry, socket = new FakeSocket(), generation = ids[3]!) {
  registry.attachAuthenticated(socket as unknown as RawWebSocket);
  socket.receive({ type: "register", protocol: 1, platform: "darwin", executorGeneration: generation });
  return socket;
}

function permissiveApprovalGate() {
  let sequence = 100;
  return new PhysicalApprovalGate({
    beginFence: () => ({ allowed: true, lifecycleId: "lifecycle-test" }),
    endFence: () => true,
    idFactory: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  });
}

describe("outbound physical bridge registry", () => {
  it("keeps identity in memory and revokes every session on replacement", () => {
    const queue = [...ids];
    const registry = new PhysicalBridgeRegistry({ idFactory: () => queue.shift()! });
    const oldSocket = attach(registry);
    const old = registry.current!;
    const closed = vi.fn();
    const session = registry.openSession(old.registrationId, {
      onOpened: vi.fn(),
      onData: vi.fn(),
      onClose: closed,
    });
    expect(session).not.toBeNull();

    const nextSocket = attach(registry, new FakeSocket(), "10000000-0000-4000-8000-000000000004");
    expect(oldSocket.open).toBe(false);
    expect(nextSocket.open).toBe(true);
    expect(registry.current?.registrationId).not.toBe(old.registrationId);
    expect(closed).toHaveBeenCalledWith("physical registration replaced");
    expect(session!.send(Buffer.from("stale"))).toBe(false);
  });

  it("rejects stale, duplicate, and wrong-generation session frames", () => {
    const queue = [...ids];
    const registry = new PhysicalBridgeRegistry({ idFactory: () => queue.shift()! });
    const socket = attach(registry);
    const registration = registry.current!;
    registry.openSession(registration.registrationId, {
      onOpened: vi.fn(),
      onData: vi.fn(),
      onClose: vi.fn(),
    });
    const open = socket.frames().find((frame) => frame.type === "open")!;
    socket.receive({ type: "opened", sessionId: open.sessionId, executorGeneration: "ffffffff-ffff-4fff-8fff-ffffffffffff" });
    expect(socket.open).toBe(false);
    expect(registry.current).toBeNull();
  });

  it("allows a bounded human decision window and times out fail-closed", () => {
    vi.useFakeTimers();
    try {
      const queue = [...ids];
      const registry = new PhysicalBridgeRegistry({
        idFactory: () => queue.shift()!,
        approvalTimeoutMs: 120_000,
        now: () => 0,
      });
      attach(registry);
      const closed = vi.fn();
      registry.openSession(registry.current!.registrationId, {
        onOpened: vi.fn(),
        onData: vi.fn(),
        onClose: closed,
      });
      vi.advanceTimersByTime(119_000);
      expect(closed).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_001);
      expect(closed).toHaveBeenCalledWith("local approval timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends bounded server-derived bot and task labels with the exact session", () => {
    const queue = [...ids];
    const registry = new PhysicalBridgeRegistry({ idFactory: () => queue.shift()! });
    const socket = attach(registry);
    const registration = registry.current!;
    const session = registry.openSession(registration.registrationId, {
      botId: "bot-7",
      botLabel: "Research Cat",
      taskLabel: "Audit browser handoff",
      onOpened: vi.fn(),
      onData: vi.fn(),
      onClose: vi.fn(),
    });

    const open = socket.frames().find((frame) => frame.type === "open")!;
    expect(open).toMatchObject({
      type: "open",
      sessionId: session!.sessionId,
      registrationId: registration.registrationId,
      executorGeneration: registration.executorGeneration,
      botId: "bot-7",
      botLabel: "Research Cat",
      taskLabel: "Audit browser handoff",
    });
  });

  it("accepts the base64 envelope for a full-size bounded MCP payload", () => {
    const queue = [...ids];
    const registry = new PhysicalBridgeRegistry({ idFactory: () => queue.shift()! });
    const socket = attach(registry);
    const onData = vi.fn();
    const session = registry.openSession(registry.current!.registrationId, {
      onOpened: vi.fn(),
      onData,
      onClose: vi.fn(),
    })!;
    socket.receive({ type: "approved", sessionId: session.sessionId, executorGeneration: registry.current!.executorGeneration });
    socket.receive({ type: "opened", sessionId: session.sessionId, executorGeneration: registry.current!.executorGeneration });
    const payload = Buffer.alloc(1024 * 1024, 0x61);
    socket.receive({ type: "data", sessionId: session.sessionId, data: payload.toString("base64") });
    expect(onData).toHaveBeenCalledOnce();
    expect(onData.mock.calls[0]![0]).toEqual(payload);
  });
});

describe("physical MCP gate", () => {
  it("closes on a fragmented unterminated provider frame before aggregate memory can exceed the cap", async () => {
    const queue = [...ids];
    const registry = new PhysicalBridgeRegistry({ idFactory: () => queue.shift()! });
    const device = attach(registry);
    const broker = new FakeSocket();
    const attached = attachPhysicalMcpBroker({
      broker: broker as unknown as RawWebSocket,
      registry,
      authority: {
        capabilityToken: "z".repeat(43),
        registrationId: registry.current!.registrationId,
        botId: "bot-1",
        targetKey: "physical:host",
        bridgeId: "bridge-1",
      },
      stillAuthorized: () => true,
      beginAction: () => ({ allowed: true, actionId: "must-not-start" }),
      endAction: () => true,
      quarantine: vi.fn(),
      requestHelp: async () => ({ text: "done" }),
      approvalGate: permissiveApprovalGate(),
    });
    expect(attached).not.toBeNull();

    const fragment = Buffer.alloc(600 * 1024, 0x61);
    broker.receive(fragment, true);
    expect(broker.open).toBe(true);
    broker.receive(fragment, true);
    await vi.waitFor(() => expect(broker.open).toBe(false));
    expect(device.frames().filter((frame) => frame.type === "data")).toHaveLength(0);
  });

  it("never forwards a tool call unless the exact server action gate permits it", async () => {
    const queue = [...ids];
    const registry = new PhysicalBridgeRegistry({ idFactory: () => queue.shift()! });
    const device = attach(registry);
    const broker = new FakeSocket();
    let held = true;
    const endAction = vi.fn(() => true);
    const attached = attachPhysicalMcpBroker({
      broker: broker as unknown as RawWebSocket,
      registry,
      authority: {
        capabilityToken: "x".repeat(43),
        registrationId: registry.current!.registrationId,
        botId: "bot-1",
        targetKey: "physical:host",
        bridgeId: "bridge-1",
      },
      stillAuthorized: () => true,
      beginAction: () => held
        ? { allowed: false, reason: "human-control" }
        : { allowed: true, actionId: "action-1" },
      endAction,
      quarantine: vi.fn(),
      requestHelp: async () => ({ text: "done" }),
      approvalGate: permissiveApprovalGate(),
    });
    expect(attached).not.toBeNull();
    await vi.waitFor(() => expect(device.frames().some((frame) => frame.type === "open")).toBe(true));
    const open = device.frames().find((frame) => frame.type === "open")!;
    device.receive({ type: "approved", sessionId: open.sessionId, executorGeneration: registry.current!.executorGeneration });
    expect(device.frames().some((frame) => frame.type === "spawn" && frame.sessionId === open.sessionId)).toBe(true);
    device.receive({ type: "opened", sessionId: open.sessionId, executorGeneration: registry.current!.executorGeneration });

    const denied = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "click", arguments: {} } });
    broker.receive(Buffer.from(denied + "\n"), true);
    await vi.waitFor(() => expect(broker.sent.some((entry) => entry.data.includes(Buffer.from("taken control")))).toBe(true));
    expect(device.frames().filter((frame) => frame.type === "data")).toHaveLength(0);

    held = false;
    const allowed = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "click", arguments: {} } });
    broker.receive(Buffer.from(allowed + "\n"), true);
    await vi.waitFor(() => expect(device.frames().filter((frame) => frame.type === "data")).toHaveLength(1));
    device.receive({
      type: "data",
      sessionId: open.sessionId,
      data: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [] } }) + "\n").toString("base64"),
    });
    await vi.waitFor(() => expect(endAction).toHaveBeenCalledWith("action-1"));
  });

  it("closes on lost turn authority and quarantines an in-flight action", async () => {
    const queue = [...ids];
    const registry = new PhysicalBridgeRegistry({ idFactory: () => queue.shift()! });
    const device = attach(registry);
    const broker = new FakeSocket();
    let authorized = true;
    const quarantine = vi.fn();
    attachPhysicalMcpBroker({
      broker: broker as unknown as RawWebSocket,
      registry,
      authority: {
        capabilityToken: "y".repeat(43),
        registrationId: registry.current!.registrationId,
        botId: "bot-1",
        targetKey: "physical:host",
        bridgeId: "bridge-1",
      },
      stillAuthorized: () => authorized,
      beginAction: () => ({ allowed: true, actionId: "action-live" }),
      endAction: () => true,
      quarantine,
      requestHelp: async () => ({ text: "done" }),
      approvalGate: permissiveApprovalGate(),
    });
    await vi.waitFor(() => expect(device.frames().some((frame) => frame.type === "open")).toBe(true));
    const open = device.frames().find((frame) => frame.type === "open")!;
    device.receive({ type: "approved", sessionId: open.sessionId, executorGeneration: registry.current!.executorGeneration });
    device.receive({ type: "opened", sessionId: open.sessionId, executorGeneration: registry.current!.executorGeneration });
    broker.receive(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "type_text" } }) + "\n"), true);
    await vi.waitFor(() => expect(device.frames().some((frame) => frame.type === "data")).toBe(true));
    authorized = false;
    broker.receive(Buffer.from("{}\n"), true);
    await vi.waitFor(() => expect(quarantine).toHaveBeenCalledOnce());
    expect(broker.open).toBe(false);
  });

  it("shares one target-wide approval and action fence across two bots", async () => {
    const queue = [...ids];
    const registry = new PhysicalBridgeRegistry({ idFactory: () => queue.shift()! });
    const device = attach(registry);
    let controlToken = 0;
    const control = new ComputerControl(() => {}, Date.now, {
      tokenFactory: () => `token-${++controlToken}`,
    });
    let approvalRef = 200;
    const approvalGate = new PhysicalApprovalGate({
      beginFence: async () => {
        const permit = await control.beginLifecycleMutationAfterDrain("physical:host", 1_000);
        return permit.allowed ? permit : { allowed: false };
      },
      endFence: (lifecycleId) => control.endLifecycleMutation("physical:host", lifecycleId),
      idFactory: () => `00000000-0000-4000-8000-${String(++approvalRef).padStart(12, "0")}`,
    });
    const brokerA = new FakeSocket();
    const brokerB = new FakeSocket();
    const attachBroker = (broker: FakeSocket, botId: string, bridgeId: string) => attachPhysicalMcpBroker({
      broker: broker as unknown as RawWebSocket,
      registry,
      authority: {
        capabilityToken: botId.repeat(43).slice(0, 43),
        registrationId: registry.current!.registrationId,
        botId,
        botLabel: botId,
        taskLabel: `Task for ${botId}`,
        targetKey: "physical:host",
        bridgeId,
      },
      stillAuthorized: () => true,
      beginAction: () => control.beginAction(botId, "physical:host", bridgeId),
      endAction: (actionId) => control.endAction(botId, "physical:host", bridgeId, actionId),
      quarantine: () => {
        control.quarantineActionsForBridge(botId, "physical:host", bridgeId);
      },
      requestHelp: async () => ({ text: "done" }),
      approvalGate,
    });
    expect(attachBroker(brokerA, "bot-a", "bridge-a")).not.toBeNull();
    expect(attachBroker(brokerB, "bot-b", "bridge-b")).not.toBeNull();
    await vi.waitFor(() => expect(device.frames().filter((entry) => entry.type === "open")).toHaveLength(2));
    const openA = device.frames().find((entry) => entry.type === "open" && entry.botId === "bot-a")!;
    const openB = device.frames().find((entry) => entry.type === "open" && entry.botId === "bot-b")!;

    // A has been approved, but B's genuine OS dialog is still pending. The
    // server target fence refuses A, so A cannot click B's approval dialog.
    device.receive({ type: "approved", sessionId: openA.sessionId, executorGeneration: registry.current!.executorGeneration });
    device.receive({ type: "opened", sessionId: openA.sessionId, executorGeneration: registry.current!.executorGeneration });
    brokerA.receive(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "click" } }) + "\n"), true);
    await vi.waitFor(() => expect(brokerA.sent.some((entry) => entry.data.includes(Buffer.from("being started")))).toBe(true));
    expect(device.frames().filter((entry) => entry.type === "data")).toHaveLength(0);

    device.receive({ type: "approved", sessionId: openB.sessionId, executorGeneration: registry.current!.executorGeneration });
    device.receive({ type: "opened", sessionId: openB.sessionId, executorGeneration: registry.current!.executorGeneration });
    await vi.waitFor(() => expect(control.targetBusy("physical:host")).toEqual({ busy: false, reason: null }));

    brokerA.receive(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "click" } }) + "\n"), true);
    await vi.waitFor(() => expect(device.frames().filter((entry) => entry.type === "data")).toHaveLength(1));
    brokerB.receive(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "type_text" } }) + "\n"), true);
    await vi.waitFor(() => expect(brokerB.sent.some((entry) => entry.data.includes(Buffer.from("Another computer action")))).toBe(true));
    expect(device.frames().filter((entry) => entry.type === "data")).toHaveLength(1);

    device.receive({
      type: "data",
      sessionId: openA.sessionId,
      data: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 11, result: { content: [] } }) + "\n").toString("base64"),
    });
    await vi.waitFor(() => expect(control.targetBusy("physical:host")).toEqual({ busy: false, reason: null }));
    brokerB.receive(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "type_text" } }) + "\n"), true);
    await vi.waitFor(() => expect(device.frames().filter((entry) => entry.type === "data")).toHaveLength(2));
    device.receive({
      type: "data",
      sessionId: openB.sessionId,
      data: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 13, result: { content: [] } }) + "\n").toString("base64"),
    });
    await vi.waitFor(() => expect(control.targetBusy("physical:host")).toEqual({ busy: false, reason: null }));
    control.dispose();
  });
});
