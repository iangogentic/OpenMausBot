// The bridge's dead-transport watchdog, pinned at the unit level: the 45s
// e2e wait is too slow for the suite, and the property that matters is not
// the constant but the decision table — silence alone never kills, only
// silence PLUS a failed liveness probe does, and traffic always vetoes.
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  COMPUTER_BATCH_MAX_ACTIONS,
  augmentToolsListResponse,
  createGateInterceptor,
  createInactivityWatchdog,
  createLineSplitter,
  runLivenessProbe,
  validateComputerBatchArguments,
} from "./mcp-bridge.ts";

describe("computer_batch validation", () => {
  it("accepts only the explicit bounded mechanical schema", () => {
    expect(validateComputerBatchArguments({ actions: [
      { name: "click", arguments: { x: 10, y: 20, button: "left" } },
      { name: "type_text", arguments: { text: "hello" } },
      { name: "press_key", arguments: { key: "enter" } },
      { name: "hotkey", arguments: { keys: ["ctrl", "l"] } },
      { name: "scroll", arguments: { x: 10, y: 20, direction: "down", amount: 3, by: "line" } },
    ] }).ok).toBe(true);
    expect(validateComputerBatchArguments({ actions: Array.from(
      { length: COMPUTER_BATCH_MAX_ACTIONS + 1 },
      () => ({ name: "press_key", arguments: { key: "tab" } }),
    ) }).ok).toBe(false);
    expect(validateComputerBatchArguments({ actions: [
      { name: "click", arguments: { x: 1, y: 2, command: "cat /etc/passwd" } },
    ] }).ok).toBe(false);
    expect(validateComputerBatchArguments({ actions: [
      { name: "computer_exec", arguments: { command: "id" } },
    ] }).ok).toBe(false);
  });
});

/** a probe whose answers the test scripts one call at a time */
function scriptedProbe(answers: boolean[]) {
  const calls: Array<(alive: boolean) => void> = [];
  let handed = 0;
  return {
    calls,
    probe: () =>
      new Promise<boolean>((resolve) => {
        calls.push(resolve);
        const next = answers[handed];
        handed += 1;
        if (next !== undefined) resolve(next);
      }),
  };
}

describe("createInactivityWatchdog", () => {
  it("kills only after silence AND a failed probe, then never re-arms", async () => {
    vi.useFakeTimers();
    try {
      const onDead = vi.fn();
      const scripted = scriptedProbe([true, false]);
      createInactivityWatchdog({ inactivityMs: 1_000, probe: scripted.probe, onDead });

      // first silence window: the probe answers alive → no kill, re-armed
      await vi.advanceTimersByTimeAsync(1_000);
      expect(scripted.calls).toHaveLength(1);
      expect(onDead).not.toHaveBeenCalled();

      // second silence window: the probe fails → dead, exactly once
      await vi.advanceTimersByTimeAsync(1_000);
      expect(scripted.calls).toHaveLength(2);
      expect(onDead).toHaveBeenCalledTimes(1);

      // dead is terminal: no timer survives to fire again
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onDead).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats traffic as proof of life, resetting the window and vetoing an in-flight probe", async () => {
    vi.useFakeTimers();
    try {
      const onDead = vi.fn();
      let probeResolvers: Array<(alive: boolean) => void> = [];
      const watchdog = createInactivityWatchdog({
        inactivityMs: 1_000,
        probe: () => new Promise<boolean>((resolve) => probeResolvers.push(resolve)),
        onDead,
      });

      // steady traffic keeps the probe from ever firing
      for (let i = 0; i < 5; i += 1) {
        await vi.advanceTimersByTimeAsync(900);
        watchdog.touch();
      }
      expect(probeResolvers).toHaveLength(0);

      // silence fires the probe — but a byte arriving WHILE it runs must
      // outrank even a failed answer (a slow screenshot finishing is life)
      await vi.advanceTimersByTimeAsync(1_000);
      expect(probeResolvers).toHaveLength(1);
      watchdog.touch();
      probeResolvers[0]!(false); // SAFETY: length asserted above
      await vi.advanceTimersByTimeAsync(0);
      expect(onDead).not.toHaveBeenCalled();

      // the veto re-armed the window; a stopped watchdog stays quiet
      watchdog.stop();
      probeResolvers = [];
      await vi.advanceTimersByTimeAsync(10_000);
      expect(probeResolvers).toHaveLength(0);
      expect(onDead).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a rejected probe as not alive", async () => {
    vi.useFakeTimers();
    try {
      const onDead = vi.fn();
      createInactivityWatchdog({
        inactivityMs: 1_000,
        probe: () => Promise.reject(new Error("probe spawn failed")),
        onDead,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onDead).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runLivenessProbe", () => {
  it("maps exit status to liveness and treats an unspawnable probe as dead", async () => {
    await expect(
      runLivenessProbe({ command: process.execPath, args: ["-e", "process.exit(0)"] }),
    ).resolves.toBe(true);
    await expect(
      runLivenessProbe({ command: process.execPath, args: ["-e", "process.exit(3)"] }),
    ).resolves.toBe(false);
    await expect(
      runLivenessProbe({ command: "/nonexistent/openmausbot-probe", args: [] }),
    ).resolves.toBe(false);
  });

  it("times out a probe that hangs instead of inheriting the hang", async () => {
    await expect(
      runLivenessProbe({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }, 300),
    ).resolves.toBe(false);
  });
});

describe("createLineSplitter", () => {
  it("reassembles lines across arbitrary chunk boundaries", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => { lines.push(line); });
    splitter.push('{"a"');
    splitter.push(':1}\n{"b":2}\n{"c"');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    splitter.flush();
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c"']);
  });

  it("does not corrupt a UTF-8 character split between buffers", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => { lines.push(line); });
    const bytes = Buffer.from('{"text":"mouse 🐭"}\n');
    const splitAt = bytes.indexOf(Buffer.from("🐭")) + 2;
    splitter.push(bytes.subarray(0, splitAt));
    splitter.push(bytes.subarray(splitAt));
    splitter.flush();
    expect(lines).toEqual(['{"text":"mouse 🐭"}']);
  });

  it("bounds a fragmented unterminated frame across every pushed chunk", () => {
    const lines: string[] = [];
    const overflow = vi.fn();
    const splitter = createLineSplitter((line) => { lines.push(line); }, {
      maxLineBytes: 8,
      onOverflow: overflow,
    });
    expect(splitter.push("1234")).toBe(true);
    expect(splitter.push("5678")).toBe(true);
    expect(splitter.push("9")).toBe(false);
    expect(splitter.push("\nnext\n")).toBe(false);
    expect(splitter.flush()).toBe(false);
    expect(overflow).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([]);
  });

  it("rejects an oversized complete frame before delivering it", () => {
    const lines: string[] = [];
    const overflow = vi.fn();
    const splitter = createLineSplitter((line) => { lines.push(line); }, {
      maxLineBytes: 4,
      onOverflow: overflow,
    });
    expect(splitter.push("12345\n")).toBe(false);
    expect(overflow).toHaveBeenCalledOnce();
    expect(lines).toEqual([]);
  });

  it("applies the byte cap per line rather than per input chunk", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => { lines.push(line); }, { maxLineBytes: 4 });
    expect(splitter.push("1234\na\nbb\n")).toBe(true);
    expect(lines).toEqual(["1234", "a", "bb"]);
  });

  it("fails closed on invalid UTF-8 and valid-frame floods", () => {
    const invalid = vi.fn();
    const invalidSplitter = createLineSplitter(vi.fn(), { onOverflow: invalid });
    expect(invalidSplitter.push(Buffer.from([0xff, 0x0a]))).toBe(false);
    expect(invalid).toHaveBeenCalledOnce();

    const flooded = vi.fn();
    const floodSplitter = createLineSplitter(vi.fn(), {
      maxFrames: 2,
      maxFramesPerWindow: 2,
      onOverflow: flooded,
    });
    expect(floodSplitter.push("{}\n{}\n{}\n")).toBe(false);
    expect(flooded).toHaveBeenCalledOnce();
  });
});

describe("createGateInterceptor", () => {
  const frame = (method: string, id?: number) => JSON.stringify({ jsonrpc: "2.0", id, method, params: {} });
  const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

  function harness(beginAction: () => Promise<
    | { allowed: true; actionId: string }
    | { allowed: false; reason: "human-control" | "takeover-pending" | "action-active" | "unavailable" }
  >) {
    const forwarded: string[] = [];
    const refused: string[] = [];
    const actions: Array<{ requestId: string; actionId: string }> = [];
    const intercept = createGateInterceptor({
      beginAction,
      forward: (line) => forwarded.push(line),
      refuse: (line) => refused.push(line),
      actionForwarded: (requestId, actionId) => actions.push({ requestId, actionId }),
    });
    return { forwarded, refused, actions, intercept };
  }

  it("forwards everything untouched while nobody is driving", async () => {
    let action = 0;
    const { forwarded, refused, actions, intercept } = harness(async () => ({
      allowed: true,
      actionId: `action-${++action}`,
    }));
    for (const line of [frame("initialize", 1), frame("tools/list", 2), frame("tools/call", 3), "not json at all"]) {
      intercept(line);
    }
    await drain();
    expect(refused).toEqual([]);
    expect(forwarded).toHaveLength(4);
    // byte-for-byte: the transparent path must not re-serialize a frame
    expect(forwarded[3]).toBe("not json at all");
    expect(actions).toEqual([{ requestId: "number:3", actionId: "action-1" }]);
  });

  it("refuses only tools/call while the person is driving", async () => {
    const { forwarded, refused, intercept } = harness(async () => ({ allowed: false, reason: "human-control" }));
    intercept(frame("tools/list", 1));
    intercept(frame("tools/call", 2));
    await drain();
    expect(forwarded).toEqual([frame("tools/list", 1)]);
    expect(refused).toHaveLength(1);
    const answer = JSON.parse(refused[0]!);
    expect(answer.id).toBe(2);
    expect(answer.result.isError).toBe(true);
    expect(answer.result.content[0].text).toMatch(/taken control/i);
  });

  it("does not forward a second mutation while this target already has one in flight", async () => {
    const { forwarded, refused, intercept } = harness(async () => ({ allowed: false, reason: "action-active" }));
    intercept(frame("tools/call", 2));
    await drain();
    expect(forwarded).toEqual([]);
    expect(refused).toHaveLength(1);
    expect(JSON.parse(refused[0]!).result.content[0].text).toMatch(/another computer action is still in progress/i);
  });

  it("preserves protocol order even though the held-check is async", async () => {
    const order: string[] = [];
    let calls = 0;
    let releaseFirst!: (held: boolean) => void;
    const first = new Promise<boolean>((resolve) => (releaseFirst = resolve));
    let drained!: () => void;
    const allForwarded = new Promise<void>((resolve) => (drained = resolve));
    const intercept = createGateInterceptor({
      beginAction: async () => {
        const sequence = calls++;
        if (sequence === 0) await first;
        return { allowed: true, actionId: `action-${sequence + 1}` };
      },
      forward: (line) => {
        const parsed = JSON.parse(line);
        order.push(`fwd:${parsed.id ?? parsed.marker}`);
        if (parsed.marker === "drained") drained();
      },
      refuse: (line) => order.push(`ref:${JSON.parse(line).id}`),
    });
    intercept(frame("tools/call", 1));
    intercept(frame("tools/call", 2));
    intercept(JSON.stringify({ marker: "drained" }));
    expect(order).toEqual([]);
    releaseFirst(false);
    await allForwarded;
    expect(order).toEqual(["fwd:1", "fwd:2", "fwd:drained"]);
  });

  it("fails closed: a broken authority check refuses the mutation", async () => {
    const { forwarded, refused, intercept } = harness(async () => {
      throw new Error("harness went away");
    });
    intercept(frame("tools/call", 1));
    await drain();
    expect(forwarded).toEqual([]);
    expect(refused).toHaveLength(1);
    expect(JSON.parse(refused[0]!).result.content[0].text).toMatch(/authority could not be verified/i);
  });

  it("fails closed when a tools/call has no correlatable JSON-RPC id", async () => {
    const { forwarded, refused, intercept } = harness(async () => ({ allowed: true, actionId: "must-not-leak" }));
    intercept(JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: {} }));
    await drain();
    expect(forwarded).toEqual([]);
    expect(refused).toHaveLength(1);
    expect(JSON.parse(refused[0]!).id).toBeNull();
  });

  it("rejects an entire JSON-RPC batch before any embedded computer call is ticketed", async () => {
    const beginAction = vi.fn(async () => ({ allowed: true as const, actionId: "must-not-run" }));
    const { forwarded, refused, intercept } = harness(beginAction);
    intercept(JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "click", arguments: {} } },
    ]));
    await intercept.drain();
    expect(beginAction).not.toHaveBeenCalled();
    expect(forwarded).toEqual([]);
    expect(refused).toHaveLength(1);
    expect(JSON.parse(refused[0]!)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: expect.objectContaining({ code: -32600, message: expect.stringMatching(/batches/i) }),
    });
  });

  it("rejects a duplicate live request id on the serialized gate queue", async () => {
    const forwarded: string[] = [];
    const refused: string[] = [];
    const live = new Set<string>();
    const beginAction = vi.fn(async () => ({ allowed: true as const, actionId: "action-a" }));
    const intercept = createGateInterceptor({
      beginAction,
      requestIdAvailable: (id) => !live.has(id),
      actionForwarded: (id) => { live.add(id); },
      forward: (line) => forwarded.push(line),
      refuse: (line) => refused.push(line),
    });
    intercept(frame("tools/call", 5));
    intercept(frame("tools/call", 5));
    await intercept.drain();
    expect(beginAction).toHaveBeenCalledOnce();
    expect(forwarded).toEqual([frame("tools/call", 5)]);
    expect(JSON.parse(refused[0]!).error).toMatchObject({ code: -32600 });
  });

  it("does not let a tool call reuse an unanswered initialize id", async () => {
    const forwarded: string[] = [];
    const refused: string[] = [];
    const live = new Set<string>();
    const beginAction = vi.fn(async () => ({ allowed: true as const, actionId: "must-not-run" }));
    const intercept = createGateInterceptor({
      beginAction,
      requestIdAvailable: (id) => !live.has(id),
      requestForwarded: (id) => { live.add(id); },
      forward: (line) => forwarded.push(line),
      refuse: (line) => refused.push(line),
    });
    intercept(frame("initialize", 8));
    intercept(frame("tools/call", 8));
    await intercept.drain();
    expect(beginAction).not.toHaveBeenCalled();
    expect(forwarded).toEqual([frame("initialize", 8)]);
    expect(JSON.parse(refused[0]!).error).toMatchObject({ code: -32600 });
  });

  it("handles computer_request_help locally without acquiring or forwarding a driver action", async () => {
    const beginAction = vi.fn(async () => ({ allowed: true as const, actionId: "should-not-run" }));
    const requestHelp = vi.fn(async () => ({ text: "handed back" }));
    const forwarded: string[] = [];
    const responses: string[] = [];
    const intercept = createGateInterceptor({
      beginAction,
      requestHelp,
      forward: (line) => forwarded.push(line),
      refuse: (line) => responses.push(line),
    });
    intercept(JSON.stringify({
      jsonrpc: "2.0",
      id: "help-1",
      method: "tools/call",
      params: { name: "computer_request_help", arguments: { reason: "captcha" } },
    }));
    await drain();
    expect(beginAction).not.toHaveBeenCalled();
    expect(forwarded).toEqual([]);
    expect(requestHelp).toHaveBeenCalledWith("captcha");
    expect(JSON.parse(responses[0]!).result).toEqual({ content: [{ type: "text", text: "handed back" }] });
  });

  it("bounds its async queue and releases an action acquired after fail-closed overflow", async () => {
    let release!: (permit: { allowed: true; actionId: string }) => void;
    const firstPermit = new Promise<{ allowed: true; actionId: string }>((resolve) => { release = resolve; });
    const abandoned = vi.fn();
    const overflow = vi.fn();
    const forwarded: string[] = [];
    const intercept = createGateInterceptor({
      beginAction: () => firstPermit,
      forward: (line) => { forwarded.push(line); },
      refuse: vi.fn(),
      actionAbandoned: abandoned,
      onOverflow: overflow,
      maxPendingFrames: 1,
      maxPendingBytes: 1024,
    });
    expect(intercept(frame("tools/call", 1))).toBe(true);
    await Promise.resolve();
    expect(intercept(frame("initialize", 2))).toBe(false);
    release({ allowed: true, actionId: "late-action" });
    await intercept.drain();
    expect(overflow).toHaveBeenCalledOnce();
    expect(abandoned).toHaveBeenCalledWith("late-action");
    expect(forwarded).toEqual([]);
  });

  it("rejects parsed frames that exceed the shared JSON depth bound", async () => {
    const overflow = vi.fn();
    const forwarded = vi.fn();
    const intercept = createGateInterceptor({
      beginAction: async () => ({ allowed: true, actionId: "unused" }),
      forward: forwarded,
      refuse: vi.fn(),
      onOverflow: overflow,
    });
    let nested: unknown = { method: "ping" };
    for (let i = 0; i < 70; i += 1) nested = { nested };
    expect(intercept(JSON.stringify(nested))).toBe(true);
    await intercept.drain();
    expect(overflow).toHaveBeenCalledOnce();
    expect(forwarded).not.toHaveBeenCalled();
  });

  it("adds the handoff tool only to a correlated tools/list response", async () => {
    const pending = new Set(["number:7"]);
    const line = JSON.stringify({ jsonrpc: "2.0", id: 7, result: { tools: [{ name: "screenshot" }] } });
    const augmented = JSON.parse(augmentToolsListResponse(line, pending));
    expect(augmented.result.tools.map((tool: any) => tool.name)).toEqual(["screenshot", "computer_request_help"]);
    expect(pending.size).toBe(0);
    expect(augmentToolsListResponse(line, pending)).toBe(line);
  });
});

describe("gated bridge transport teardown", () => {
  let controlServer: Server;
  let controlPort = 0;
  let sequence = 0;
  const operations: Array<{ op: string; actionId?: string }> = [];
  const moduleUrl = new URL("./mcp-bridge.ts", import.meta.url).href;

  const waitUntil = async (predicate: () => boolean, message: string, ms = 4_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(message);
  };

  const spawnBridge = (driverSource: string) => {
    const launcher = [
      `import { runMcpBridge } from ${JSON.stringify(moduleUrl)};`,
      `runMcpBridge({`,
      `  command: process.execPath,`,
      `  args: ["-e", ${JSON.stringify(driverSource)}],`,
      `  label: "fake CUA driver",`,
      `  gate: { url: ${JSON.stringify(`http://127.0.0.1:${controlPort}/control`)}, token: "secret" },`,
      `});`,
    ].join("\n");
    return spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", launcher], {
      stdio: ["pipe", "pipe", "pipe"],
    });
  };

  beforeAll(async () => {
    controlServer = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        operations.push(parsed);
        res.writeHead(200, { "content-type": "application/json" });
        if (req.method === "POST" && parsed.op === "begin-action") {
          res.end(JSON.stringify({ valid: true, allowed: true, actionId: `action-${++sequence}` }));
          return;
        }
        if (req.method === "DELETE" && parsed.op === "end-action") {
          res.end(JSON.stringify({ valid: true, ended: true }));
          return;
        }
        res.end(JSON.stringify({ valid: true, held: false, helpOpen: false }));
      });
    });
    await new Promise<void>((resolve) => controlServer.listen(0, "127.0.0.1", resolve));
    controlPort = (controlServer.address() as any).port;
  });

  afterAll(() => {
    controlServer?.closeAllConnections?.();
    controlServer?.close();
  });

  it("drains a delayed normal result after stdin EOF before ending its exact ticket", async () => {
    const driver = `
      let buffer = "";
      let ended = false;
      let pending = 0;
      const settle = () => { if (ended && pending === 0) process.exitCode = 0; };
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const frame = JSON.parse(line);
          if (frame.method === "tools/call") {
            pending += 1;
            setTimeout(() => {
              process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { content: [{ type: "text", text: "done" }] } }) + "\\n");
              pending -= 1;
              settle();
            }, 250);
          }
        }
      });
      process.stdin.on("end", () => { ended = true; settle(); });
    `;
    const bridge = spawnBridge(driver);
    const closed = new Promise<void>((resolve) => bridge.once("close", () => resolve()));
    let stdout = "";
    bridge.stdout!.on("data", (chunk) => (stdout += chunk));
    bridge.stdin!.end(JSON.stringify({ jsonrpc: "2.0", id: 71, method: "tools/call", params: { name: "click" } }) + "\n");

    await waitUntil(() => operations.some((entry) => entry.op === "begin-action"), "bridge action never began");
    expect(operations.some((entry) => entry.op === "end-action")).toBe(false);
    await waitUntil(
      () => operations.some((entry) => entry.op === "end-action" && entry.actionId === "action-1"),
      "bridge did not end the exact completed action",
    );
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("bridge did not drain and exit")), 3_000)),
    ]);
    expect(stdout).toContain('"id":71');
    expect(operations.some((entry) => entry.op === "end-all-actions")).toBe(false);
  });

  it("quarantines the ticket when the driver is SIGKILLed mid-action", async () => {
    const driver = `
      let buffer = "";
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.includes("\\n")) setTimeout(() => process.kill(process.pid, "SIGKILL"), 50);
      });
    `;
    const bridge = spawnBridge(driver);
    const closed = new Promise<void>((resolve) => bridge.once("close", () => resolve()));
    bridge.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 72, method: "tools/call", params: { name: "click" } }) + "\n");
    await waitUntil(
      () => operations.filter((entry) => entry.op === "begin-action").length === 2,
      "killed bridge action never began",
    );
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("killed bridge did not exit")), 3_000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(operations.some((entry) => entry.op === "end-action" && entry.actionId === "action-2")).toBe(false);
    expect(operations.some((entry) => entry.op === "end-all-actions")).toBe(false);
    expect(operations.some((entry) => entry.op === "quarantine-actions")).toBe(true);
  });
});
