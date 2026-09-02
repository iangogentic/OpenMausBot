// Contract test for the computer tools' latency shape. The proxy is a
// stdio MCP server that talks to the box's REST command endpoint, so a
// fake box lets us assert the things that actually make UI steps fast:
//
//   1. an action and its screenshot are ONE round trip (act, settle and
//      capture ride in a single shell command),
//   2. the frame comes back INSIDE the action's result as an MCP image
//      block, so the model never needs a follow-up screenshot call,
//   3. click coordinates are scaled box-side (no geometry round trip),
//   4. computer_batch runs a whole sequence in one round trip,
//   5. an unchanged screen is reported as text instead of resending the
//      same pixels.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PROXY = join(SERVER_DIR, "computer-proxy.ts");

// smallest valid JPEG header + payload — enough for the proxy's magic-byte
// check, which is what stops a truncated stdout reaching the model
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(700, 0x20),
  Buffer.from([0xff, 0xd9]),
]).toString("base64");
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(700, 0x20),
  Buffer.from("IEND", "ascii"),
]).toString("base64");

describe("computer proxy (fake box)", () => {
  let box: Server;
  let controlServer: Server;
  let proxy: ChildProcess;
  let port = 0;
  const commands: string[] = [];
  let fileReads = 0;
  let hash = "aaaa1111";
  let browserUrl = "https://example.com/";
  let cropFails = false;
  let captureFails = false;
  let actionFails = false;
  let fileReadFails = false;
  let semanticFails = false;
  let execFails = false;
  let frameData = JPEG;

  const rpc = (msg: unknown) => proxy.stdin!.write(JSON.stringify(msg) + "\n");
  const results = new Map<number, any>();
  const waitFor = async (id: number, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (results.has(id)) return results.get(id);
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no response for id ${id}; commands so far: ${commands.join(" | ")}`);
  };

  beforeAll(async () => {
    box = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/api/internal/box") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const parsed = JSON.parse(body || "{}");
          if (parsed.op === "read-file") {
            fileReads += 1;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(fileReadFails
              ? { ok: false, status: 500, error: "capture unavailable" }
              : { ok: true, status: 200, data: frameData }));
            return;
          }
          if (parsed.op !== "command") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, status: 200, body: { box: { state: "ready" } } }));
            return;
          }
          const command = parsed.command ?? "";
          commands.push(command);
          // a real box echoes what the capture block printed
          const size = Buffer.from(frameData, "base64").length;
          const stdout = command.includes("127.0.0.1:9222/json/list")
            ? JSON.stringify([
                { id: "page-1", type: "page", title: " Example ", url: browserUrl },
              ])
            : command.includes("openmausbot-cdp.mjs snapshot")
              ? JSON.stringify({
                  title: "Account",
                  url: "https://user:password@example.com/form?token=secret#private",
                  elements: [
                    { ref: "b41", role: "textbox", name: "Email" },
                    { ref: "b42", role: "button", name: "Continue" },
                  ],
                })
              : command.includes("openmausbot-cdp.mjs click") || command.includes("openmausbot-cdp.mjs fill")
                ? `GEOM 1920 1080\nHASH ${hash}\nSIZE ${size}\nB64 ${frameData}\nSEM ${semanticFails ? "failed" : "ok"}\n`
            : cropFails && /convert "\$f" -crop/.test(command)
              ? `GEOM 1920 1080\nHASH ${hash}\nCROP_FAILED\n`
              : captureFails && /GEOM/.test(command)
                ? `GEOM 1920 1080\nACT ${actionFails ? "failed" : "ok"}\n`
              : /GEOM/.test(command)
                ? `GEOM 1920 1080\nHASH ${hash}\nSIZE ${size}\nB64 ${frameData}\nACT ${actionFails ? "failed" : "ok"}\n`
                : "ACT ok\n";
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, status: 200, exitCode: execFails ? 7 : 0, stdout, stderr: execFails ? "command failed" : "" }));
        });
        return;
      }
      res.writeHead(404).end("{}");
    });
    await new Promise<void>((r) => box.listen(0, "127.0.0.1", r));
    port = (box.address() as any).port;

    let actionSequence = 0;
    controlServer = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        res.writeHead(200, { "content-type": "application/json" });
        if (req.method === "POST" && parsed.op === "begin-action") {
          res.end(JSON.stringify({ valid: true, allowed: true, actionId: `action-${++actionSequence}` }));
          return;
        }
        if (req.method === "DELETE" && parsed.op === "end-action") {
          res.end(JSON.stringify({ valid: true, ended: true }));
          return;
        }
        if (req.method === "DELETE" && parsed.op === "end-all-actions") {
          res.end(JSON.stringify({ valid: true, ended: true }));
          return;
        }
        res.end(JSON.stringify({ valid: true, held: false, helpOpen: false }));
      });
    });
    await new Promise<void>((resolve) => controlServer.listen(0, "127.0.0.1", resolve));
    const controlPort = (controlServer.address() as any).port;

    proxy = spawn(process.execPath, ["--experimental-strip-types", PROXY], {
      env: {
        ...process.env,
        OGB_BOX_ID: "box-1",
        OMB_BOX_BROKER_URL: `http://127.0.0.1:${port}/api/internal/box`,
        OMB_BOX_CAPABILITY_TOKEN: "box-capability",
        OMB_CONTROL_URL: `http://127.0.0.1:${controlPort}/api/internal/computer-control?botId=b1`,
        OMB_CONTROL_TOKEN: "control-secret",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    proxy.stdout!.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null) results.set(msg.id, msg);
        } catch {
          /* ignore */
        }
      }
    });
    rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(1);
  }, 20_000);

  afterAll(() => {
    proxy?.kill();
    box?.close();
    controlServer?.close();
  });

  it("exposes action, structured-state, crop, and metrics tools", async () => {
    rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const res = await waitFor(2);
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).toContain("computer_batch");
    expect(names).toEqual(
      expect.arrayContaining([
        "browser_state",
        "browser_snapshot",
        "browser_click",
        "browser_fill",
        "computer_status",
        "wait_for_navigation",
        "observation_metrics",
      ]),
    );
    const click = res.result.tools.find((t: any) => t.name === "click");
    expect(click.description).toMatch(/return the resulting screen/i);
    const screenshot = res.result.tools.find((t: any) => t.name === "screenshot");
    expect(screenshot.inputSchema.properties.region).toBeTruthy();
  });

  it("clicks and returns the frame in ONE round trip, scaled box-side", async () => {
    const before = commands.length;
    rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "click", arguments: { x: 100, y: 200 } },
    });
    const res = await waitFor(3);
    // one command carried the click, the settle and the capture
    expect(commands.length - before).toBe(1);
    const command = commands.at(-1)!;
    expect(command).not.toContain("exec env -i");
    if (process.platform !== "win32") expect(spawnSync("/bin/bash", ["-n", "-c", command]).status).toBe(0);
    expect(command).toMatch(/xdotool mousemove \$CX \$CY click 1/);
    expect(command).toContain("/opt/ogb/cua-driver call click");
    expect(command).toContain("CUA_DRIVER_RS_TELEMETRY_ENABLED=0");
    expect(command).toMatch(/getdisplaygeometry/); // scaling resolved box-side
    // scaling is conditional: a display narrower than the model's space is
    // captured at native size, so the coordinates must pass through as-is
    expect(command).toMatch(/if \[ "\$W" -gt 1280 \].*CX=\$\(\( 100 \* W \/ 1280 \)\).*else CX=100/);
    expect(command).toMatch(/scrot -o -q 75/); // JPEG, no unconditional convert
    expect(command).toContain("call get_desktop_state");
    // ...and the model got pixels back with it, no second tool call
    const content = res.result.content;
    expect(content[0].type).toBe("text");
    expect(content[0].text).toMatch(/clicked 100,200/);
    expect(content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(content[1].data).toBe(JPEG);
    expect(fileReads).toBe(0); // inline stdout, so no extra HTTP hop
  });

  it("reports an unchanged screen as text instead of resending pixels", async () => {
    rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "press_key", arguments: { keys: "Tab", pid: 42, window_id: 123, delivery_mode: "foreground" } },
    });
    const res = await waitFor(4);
    expect(res.result.content).toHaveLength(1);
    expect(res.result.content[0].text).toMatch(/identical to the frame you already have/i);
    // must not tell the model to redo a possibly-successful action
    expect(res.result.content[0].text).toMatch(/don't repeat the action/i);
  });

  it("forwards an exact 4,000-character computer command without pre-expanding it", async () => {
    const exact = "x".repeat(4_000);
    rpc({
      jsonrpc: "2.0",
      id: 4010,
      method: "tools/call",
      params: { name: "computer_exec", arguments: { command: exact, observe: false } },
    });
    const res = await waitFor(4010);

    expect(res.result.isError).not.toBe(true);
    expect(commands.at(-1)).toBe(exact);
  });

  it("sends a new frame once the screen actually changes", async () => {
    hash = "bbbb2222";
    rpc({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "type_text", arguments: { text: "hello", pid: 42, window_id: 123, delivery_mode: "foreground" } },
    });
    const res = await waitFor(5);
    expect(commands.at(-1)).toMatch(/xdotool type --clearmodifiers --delay 8 -- .*hello/);
    expect(res.result.content[1]).toMatchObject({ type: "image" });
  });

  it("types leading hyphens as text after clearing stuck modifiers", async () => {
    hash = "bbbb2223";
    rpc({
      jsonrpc: "2.0",
      id: 51,
      method: "tools/call",
      params: { name: "type_text", arguments: { text: "--safe", pid: 42, window_id: 123, delivery_mode: "foreground" } },
    });
    await waitFor(51);
    expect(commands.at(-1)).toMatch(/xdotool type --clearmodifiers --delay 8 -- .*--safe/);
  });

  it("runs a whole batch in one round trip with one frame at the end", async () => {
    hash = "cccc3333";
    const before = commands.length;
    rpc({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "computer_batch",
        arguments: {
          actions: [
            { action: "click", x: 10, y: 20, pid: 42, window_id: 123, delivery_mode: "foreground" },
            { action: "type_text", text: "milind@example.com", pid: 42, window_id: 123, delivery_mode: "foreground" },
            { action: "press_key", keys: "Tab", pid: 42, window_id: 123, delivery_mode: "foreground" },
          ],
        },
      },
    });
    const res = await waitFor(6);
    expect(commands.length - before).toBe(1);
    const command = commands.at(-1)!;
    expect(command).toMatch(/mousemove/);
    expect(command).toMatch(/xdotool type/);
    expect(command).toMatch(/xdotool key Tab/);
    expect(command).toContain("xdotool getwindowpid 123");
    expect(command).toContain('"window_id":123');
    if (process.platform !== "win32") expect(spawnSync("/bin/bash", ["-n", "-c", command]).status).toBe(0);
    expect((command.match(/scrot/g) ?? []).length).toBe(1); // one capture
    expect(res.result.content[1]).toMatchObject({ type: "image" });
  });

  it("rejects oversized or unfocused keyboard batches atomically", async () => {
    const before = commands.length;
    rpc({ jsonrpc: "2.0", id: 63, method: "tools/call", params: { name: "computer_batch", arguments: { actions: Array.from({ length: 10 }, () => ({ action: "click", x: 1, y: 1 })) } } });
    expect((await waitFor(63)).result.isError).toBe(true);
    rpc({ jsonrpc: "2.0", id: 64, method: "tools/call", params: { name: "computer_batch", arguments: { actions: [{ action: "type_text", text: "wrong focus" }] } } });
    expect((await waitFor(64)).result.isError).toBe(true);
    rpc({ jsonrpc: "2.0", id: 641, method: "tools/call", params: { name: "computer_batch", arguments: { actions: [
      { action: "click", x: 1, y: 1, pid: 42, window_id: 123, delivery_mode: "foreground" },
      { action: "type_text", text: "wrong window", pid: 42, window_id: 124, delivery_mode: "foreground" },
    ] } } });
    expect((await waitFor(641)).result.isError).toBe(true);
    expect(commands.length).toBe(before);
  });

  it("preserves a complete raw CUA PNG with the correct MIME without requiring ImageMagick", async () => {
    const old = frameData;
    frameData = PNG;
    hash = "raw-png-frame";
    try {
      rpc({ jsonrpc: "2.0", id: 65, method: "tools/call", params: { name: "click", arguments: { x: 20, y: 30 } } });
      const res = await waitFor(65);
      expect(res.result.content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: PNG });
      expect(commands.at(-1)).toContain('cp "$raw" "$f"');
      expect(commands.at(-1)).toContain("command -v ffmpeg");
    } finally {
      frameData = old;
    }
  });

  it("fails the protocol result when a batch cannot capture its proof frame", async () => {
    captureFails = true;
    fileReadFails = true;
    try {
      rpc({
        jsonrpc: "2.0",
        id: 61,
        method: "tools/call",
        params: { name: "computer_batch", arguments: { actions: [
          { action: "click", x: 1, y: 1, pid: 42, window_id: 123, delivery_mode: "foreground" },
          { action: "press_key", keys: "Tab", pid: 42, window_id: 123, delivery_mode: "foreground" },
        ] } },
      });
      const res = await waitFor(61);
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toMatch(/^FAILED: visual postcondition is unproven/);
    } finally {
      captureFails = false;
      actionFails = false;
      fileReadFails = false;
    }
  });

  it("keeps an action failure failed even when a proof frame is available", async () => {
    actionFails = true;
    const originalHash = hash;
    hash = "failed-action-frame";
    try {
      rpc({ jsonrpc: "2.0", id: 62, method: "tools/call", params: { name: "click", arguments: { x: 7, y: 8 } } });
      const failed = await waitFor(62);
      expect(failed.result.isError).toBe(true);
      expect(failed.result.content[0].text).toMatch(/^FAILED:/);
      expect(failed.result.content[1]).toMatchObject({ type: "image" });
    } finally {
      hash = originalHash;
      captureFails = false;
      actionFails = false;
    }
  });

  it("skips the capture entirely when the caller opts out", async () => {
    rpc({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "scroll", arguments: { direction: "down", observe: false } },
    });
    const res = await waitFor(7);
    expect(commands.at(-1)).not.toMatch(/scrot/);
    expect(res.result.content).toHaveLength(1);
  });

  it("never exposes browser credentials, queries, or fragments", async () => {
    browserUrl = "https://user:password@example.com/path?token=secret#private";
    rpc({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "browser_state", arguments: {} } });
    const res = await waitFor(8);
    const output = res.result.content[0].text;
    expect(output).toContain("https://example.com/path");
    expect(output).not.toMatch(/user|password|token|secret|private/);
  });

  it("uses fresh semantic browser refs without exposing URL secrets", async () => {
    rpc({ jsonrpc: "2.0", id: 81, method: "tools/call", params: { name: "browser_snapshot", arguments: {} } });
    const snapshot = await waitFor(81);
    const snapshotText = snapshot.result.content[0].text;
    expect(snapshotText).toContain("[b41] textbox: Email");
    expect(snapshotText).toContain("https://example.com/form");
    expect(snapshotText).not.toMatch(/user|password|token|secret|private/);

    hash = "semantic-1";
    const before = commands.length;
    rpc({
      jsonrpc: "2.0",
      id: 82,
      method: "tools/call",
      params: { name: "browser_fill", arguments: { ref: "b41", text: "person@example.com" } },
    });
    const filled = await waitFor(82);
    expect(commands.length - before).toBe(1);
    expect(commands.at(-1)).toContain("openmausbot-cdp.mjs fill");
    expect(commands.at(-1)).not.toContain("person@example.com");
    expect(filled.result.content[0].text).toMatch(/trusted Chrome DevTools input/);

    const staleBefore = commands.length;
    rpc({
      jsonrpc: "2.0",
      id: 83,
      method: "tools/call",
      params: { name: "browser_click", arguments: { ref: "b42" } },
    });
    const stale = await waitFor(83);
    expect(stale.result.isError).toBe(true);
    expect(stale.result.content[0].text).toMatch(/stale/i);
    expect(commands.length).toBe(staleBefore);
  });

  it("does not verify a different query or an invalid expected URL", async () => {
    browserUrl = "https://example.com/path?step=2#done";
    rpc({ jsonrpc: "2.0", id: 90, method: "tools/call", params: { name: "observation_metrics", arguments: {} } });
    const metricsBefore = JSON.parse((await waitFor(90)).result.content[0].text);
    const beforeInvalid = commands.length;
    rpc({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "wait_for_navigation", arguments: { url: "not a URL" } },
    });
    const invalid = await waitFor(9);
    expect(invalid.result.isError).toBe(true);
    expect(commands.length).toBe(beforeInvalid);

    rpc({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "wait_for_navigation",
        arguments: { url: "https://example.com/path?step=1#done" },
      },
    });
    const mismatch = await waitFor(10);
    expect(mismatch.result.isError).toBe(true);
    expect(mismatch.result.content[0].text).toMatch(/not verified/i);

    rpc({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "wait_for_navigation",
        arguments: { url: "https://example.com/path?step=2#done" },
      },
    });
    const exact = await waitFor(11);
    expect(exact.result.isError).not.toBe(true);
    expect(exact.result.content[0].text).toMatch(/verified/i);
    expect(exact.result.content[0].text).not.toContain("step=2");

    rpc({ jsonrpc: "2.0", id: 91, method: "tools/call", params: { name: "observation_metrics", arguments: {} } });
    const metricsAfter = JSON.parse((await waitFor(91)).result.content[0].text);
    expect(metricsAfter.structuredBrowserObservations).toBe(metricsBefore.structuredBrowserObservations);
  });

  it("keeps failed semantic browser actions failed even when pixels are returned", async () => {
    rpc({ jsonrpc: "2.0", id: 87, method: "tools/call", params: { name: "browser_snapshot", arguments: {} } });
    await waitFor(87);
    semanticFails = true;
    hash = "semantic-failed-frame";
    try {
      rpc({ jsonrpc: "2.0", id: 88, method: "tools/call", params: { name: "browser_click", arguments: { ref: "b42" } } });
      const failed = await waitFor(88);
      expect(failed.result.isError).toBe(true);
      expect(failed.result.content[0].text).toMatch(/^FAILED:/);
      expect(failed.result.content[1]).toMatchObject({ type: "image" });
    } finally {
      semanticFails = false;
    }
  });

  it("marks unverified navigation and observed shell failures as errors", async () => {
    const previousUrl = browserUrl;
    browserUrl = "https://example.com/different";
    hash = "navigation-failed-frame";
    try {
      rpc({ jsonrpc: "2.0", id: 89, method: "tools/call", params: { name: "open_url", arguments: { url: "https://example.com/expected" } } });
      const navigation = await waitFor(89);
      expect(navigation.result.isError).toBe(true);
      expect(navigation.result.content[0].text).toMatch(/^FAILED:/);

      execFails = true;
      hash = "exec-failed-frame";
      rpc({ jsonrpc: "2.0", id: 891, method: "tools/call", params: { name: "computer_exec", arguments: { command: "exit 7", observe: true } } });
      const executed = await waitFor(891);
      expect(executed.result.isError).toBe(true);
      expect(executed.result.content[0].text).toMatch(/^FAILED:/);
      expect(executed.result.content[1]).toMatchObject({ type: "image" });
    } finally {
      browserUrl = previousUrl;
      execFails = false;
    }
  });

  it("rejects out-of-height crops and fails closed when conversion fails", async () => {
    rpc({
      jsonrpc: "2.0",
      id: 120,
      method: "tools/call",
      params: { name: "screenshot", arguments: {} },
    });
    await waitFor(120);
    const beforeBounds = commands.length;
    rpc({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "screenshot",
        arguments: { region: { x: 0, y: 700, width: 100, height: 50 } },
      },
    });
    const bounds = await waitFor(12);
    expect(bounds.result.isError).toBe(true);
    expect(bounds.result.content[0].text).toMatch(/1280×720/);
    expect(commands.length).toBe(beforeBounds);

    cropFails = true;
    rpc({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: {
        name: "screenshot",
        arguments: { region: { x: 10, y: 20, width: 100, height: 80 } },
      },
    });
    const failed = await waitFor(13);
    expect(failed.result.isError).toBe(true);
    expect(failed.result.content).toHaveLength(1);
    expect(failed.result.content[0].text).toMatch(/crop failed/i);

    cropFails = false;
  });

  it("uses a private Chrome profile, strips URL credentials, and reports redirects", async () => {
    browserUrl = "https://example.com/landed?private=value#done";
    const before = commands.length;
    rpc({
      jsonrpc: "2.0",
      id: 130,
      method: "tools/call",
      params: {
        name: "open_url",
        arguments: {
          url: "https://user:password@example.com/requested?token=secret#fragment",
          observe: false,
        },
      },
    });
    const result = await waitFor(130);
    const issued = commands.slice(before);
    expect(issued).toHaveLength(2);
    expect(issued[0]).toContain('profile="$HOME/.openmausbot/chrome-profile"');
    expect(issued[0]).toContain('chmod 700 "$profile"');
    expect(issued[0]).toContain('! cp -a -n "$browser_dir"/. "$profile"/');
    expect(issued[0]).toContain('echo "failed to copy browser profile: $browser_dir" >&2');
    expect(issued[0]).toContain('ln -s "$profile" "$browser_dir"');
    expect(issued[0]).not.toContain("do;");
    expect(issued[0]).not.toContain("then;");
    expect(issued[0]).toContain('--user-data-dir="$HOME/.openmausbot/chrome-profile"');
    expect(issued[0]).toContain("--password-store=basic");
    expect(issued[0]).toContain("--disable-session-crashed-bubble");
    expect(issued[0]).not.toContain("user:password@");
    expect(issued[0]).toContain("'https://example.com/requested?token=secret#fragment'");
    expect(result.result.content[0].text).toContain("https://example.com/landed");
    expect(result.result.content[0].text).not.toMatch(/private|value|token|secret|fragment/);
  });

  it("hashes the full frame while treating distinct crops as distinct observations", async () => {
    hash = "dddd4444";
    rpc({
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: {
        name: "screenshot",
        arguments: { region: { x: 10, y: 20, width: 100, height: 80 } },
      },
    });
    const first = await waitFor(14);
    expect(first.result.content.some((item: any) => item.type === "image")).toBe(true);
    const command = commands.at(-1)!;
    expect(command.indexOf('echo "HASH')).toBeLessThan(command.indexOf('-crop 100x80+10+20'));

    rpc({
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: {
        name: "screenshot",
        arguments: { region: { x: 20, y: 20, width: 100, height: 80 } },
      },
    });
    const second = await waitFor(15);
    expect(second.result.content.some((item: any) => item.type === "image")).toBe(true);

    rpc({
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: {
        name: "screenshot",
        arguments: { region: { x: 20, y: 20, width: 100, height: 80 } },
      },
    });
    const repeated = await waitFor(16);
    expect(repeated.result.content).toHaveLength(1);
    expect(repeated.result.content[0].text).toMatch(/identical/i);
  });
});

describe("computer proxy control gate (fake box + fake control)", () => {
  let box: Server;
  let controlServer: Server;
  let proxy: ChildProcess;
  const commands: string[] = [];
  let held = false;
  let helpOpen = false;
  let failHelpPost = false;
  let failActionCheck = false;
  let failStateRead = false;
  const expiredHelpIds: string[] = [];
  const begunActionIds: string[] = [];
  const endedActionIds: string[] = [];
  const completionOrder: string[] = [];
  const authHeaders: Array<string | undefined> = [];

  const rpc = (msg: unknown) => proxy.stdin!.write(JSON.stringify(msg) + "\n");
  const results = new Map<number, any>();
  const waitFor = async (id: number, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (results.has(id)) return results.get(id);
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no response for id ${id}`);
  };

  beforeAll(async () => {
    box = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/api/internal/box") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const parsed = JSON.parse(body || "{}");
          if (parsed.op !== "command") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, status: 200, body: { box: { state: "ready" } } }));
            return;
          }
          commands.push(parsed.command ?? "");
          const size = Buffer.from(JPEG, "base64").length;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              status: 200,
              exitCode: 0,
              stdout: `GEOM 1920 1080\nHASH h1\nSIZE ${size}\nB64 ${JPEG}\nACT ok\n`,
              stderr: "",
            }),
          );
        });
        return;
      }
      res.writeHead(404).end("{}");
    });
    await new Promise<void>((r) => box.listen(0, "127.0.0.1", r));
    const boxPort = (box.address() as any).port;

    controlServer = createServer((req, res) => {
      authHeaders.push(Array.isArray(req.headers.authorization) ? undefined : req.headers.authorization);
      if (req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const parsed = JSON.parse(body || "{}");
          if (parsed.op === "begin-action") {
            if (failActionCheck) {
              res.writeHead(503, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "offline" }));
              return;
            }
            if (held) {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ valid: true, allowed: false, reason: "human-control" }));
              return;
            }
            const actionId = `action-${begunActionIds.length + 1}`;
            begunActionIds.push(actionId);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ valid: true, allowed: true, actionId }));
            return;
          }
          if (failHelpPost) {
            res.writeHead(503, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "offline" }));
            return;
          }
          helpOpen = true;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ valid: true, held, helpOpen, requestId: "help-1" }));
        });
        return;
      }
      if (req.method === "DELETE") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const parsed = JSON.parse(body || "{}");
          if (parsed.op === "end-action") {
            endedActionIds.push(parsed.actionId);
            completionOrder.push(`end:${parsed.actionId}`);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ valid: true, ended: true }));
            return;
          }
          if (parsed.op === "end-all-actions") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ valid: true, ended: true }));
            return;
          }
          expiredHelpIds.push(parsed.requestId);
          helpOpen = false;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ valid: true, held, helpOpen }));
        });
        return;
      }
      if (failStateRead) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "offline" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ valid: true, held, helpOpen }));
    });
    await new Promise<void>((r) => controlServer.listen(0, "127.0.0.1", r));
    const controlPort = (controlServer.address() as any).port;

    proxy = spawn(process.execPath, ["--experimental-strip-types", PROXY], {
      env: {
        ...process.env,
        OGB_BOX_ID: "box-1",
        OMB_BOX_BROKER_URL: `http://127.0.0.1:${boxPort}/api/internal/box`,
        OMB_BOX_CAPABILITY_TOKEN: "box-capability",
        OMB_CONTROL_URL: `http://127.0.0.1:${controlPort}/api/internal/computer-control?botId=b1`,
        OMB_CONTROL_TOKEN: "control-secret",
        // fast cadence so the wait tests measure logic, not wall-clock
        OMB_CONTROL_POLL_MS: "25",
        OMB_CONTROL_WAIT_MS: "1500",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    proxy.stdout!.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null) {
            completionOrder.push(`result:${msg.id}`);
            results.set(msg.id, msg);
          }
        } catch {
          /* ignore */
        }
      }
    });
    rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(1);
  }, 20_000);

  afterAll(() => {
    proxy?.kill();
    box?.close();
    controlServer?.close();
  });

  it("acts normally while nobody is driving, sending the boot token along", async () => {
    held = false;
    rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "click", arguments: { x: 10, y: 10, observe: false } } });
    const result = await waitFor(2);
    expect(result.result.isError).toBeUndefined();
    expect(commands.length).toBeGreaterThan(0);
    const actionId = begunActionIds.at(-1)!;
    expect(endedActionIds).toContain(actionId);
    expect(completionOrder.indexOf(`end:${actionId}`)).toBeLessThan(completionOrder.indexOf("result:2"));
    expect(authHeaders.every((h) => h === "Bearer control-secret")).toBe(true);
  });

  it("refuses every action while the person is driving — nothing reaches the box", async () => {
    held = true;
    const before = commands.length;
    rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "click", arguments: { x: 10, y: 10 } } });
    const click = await waitFor(3);
    expect(click.result.isError).toBe(true);
    expect(click.result.content[0].text).toMatch(/taken control/i);
    rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "screenshot", arguments: {} } });
    const shot = await waitFor(4);
    expect(shot.result.isError).toBe(true);
    expect(commands.length).toBe(before);
  });

  it("fails closed when the control authority cannot issue an action ticket", async () => {
    held = false;
    failActionCheck = true;
    const before = commands.length;
    rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "click", arguments: { x: 20, y: 20 } } });
    const result = await waitFor(9);
    failActionCheck = false;
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toMatch(/authority could not be verified/i);
    expect(commands.length).toBe(before);
  });

  it("computer_request_help waits out the drive and reports the hand-back", async () => {
    held = true;
    helpOpen = false;
    rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "computer_request_help", arguments: {} } });
    await new Promise((r) => setTimeout(r, 120));
    expect(results.has(5)).toBe(false); // still waiting while they drive
    held = false;
    const result = await waitFor(5);
    expect(result.result.isError).toBeUndefined();
    expect(result.result.content[0].text).toMatch(/handed control back/i);
    expect(result.result.content[0].text).toMatch(/fresh screenshot/i);
  });

  it("computer_request_help posts the plea and reports a dismissal", async () => {
    held = false;
    helpOpen = false;
    await new Promise((r) => setTimeout(r, 40));
    rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "computer_request_help", arguments: { reason: "please log in" } } });
    await new Promise((r) => setTimeout(r, 120));
    expect(helpOpen).toBe(true); // the POST landed
    expect(results.has(6)).toBe(false); // and the bot is waiting
    helpOpen = false; // the person dismissed it
    const result = await waitFor(6);
    expect(result.result.content[0].text).toMatch(/dismissed/i);
  });

  it("times out politely when nobody comes", async () => {
    held = false;
    helpOpen = false;
    await new Promise((r) => setTimeout(r, 40));
    rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "computer_request_help", arguments: {} } });
    helpOpen = true; // plea stays open, nobody answers
    const result = await waitFor(7, 4000);
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toMatch(/nobody took control/i);
    expect(helpOpen).toBe(false);
    expect(expiredHelpIds).toContain("help-1");
  });

  it("returns immediately when the person cannot be paged", async () => {
    held = false;
    helpOpen = false;
    failHelpPost = true;
    rpc({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "computer_request_help", arguments: {} } });
    const result = await waitFor(8, 500);
    failHelpPost = false;
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toMatch(/could not be paged/i);
  });

  it("fails promptly and expires its plea if authority disappears while waiting", async () => {
    held = false;
    helpOpen = false;
    failStateRead = false;
    rpc({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "computer_request_help", arguments: {} } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(helpOpen).toBe(true);
    failStateRead = true;
    const result = await waitFor(10, 800);
    failStateRead = false;
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toMatch(/authority became unavailable/i);
    expect(expiredHelpIds).toContain("help-1");
  });
});

describe("computer proxy teardown safety", () => {
  let box: Server;
  let controlServer: Server;
  let boxPort = 0;
  let controlPort = 0;
  const pendingBoxResponses: Array<import("node:http").ServerResponse> = [];
  const controlOps: Array<{ op: string; actionId?: string }> = [];
  let actionSequence = 0;

  const waitUntil = async (predicate: () => boolean, message: string, ms = 4_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(message);
  };

  const startProxy = () => spawn(process.execPath, ["--experimental-strip-types", PROXY], {
    env: {
      ...process.env,
      OGB_BOX_ID: "box-1",
      OMB_BOX_BROKER_URL: `http://127.0.0.1:${boxPort}/api/internal/box`,
      OMB_BOX_CAPABILITY_TOKEN: "box-capability",
      OMB_CONTROL_URL: `http://127.0.0.1:${controlPort}/api/internal/computer-control?botId=b1`,
      OMB_CONTROL_TOKEN: "control-secret",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const finishNextBoxAction = () => {
    const response = pendingBoxResponses.shift();
    if (!response) throw new Error("no pending Box action");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, status: 200, exitCode: 0, stdout: "ACT ok\n", stderr: "" }));
  };

  beforeAll(async () => {
    box = createServer((req, res) => {
      if (new URL(req.url ?? "/", "http://x").pathname === "/api/internal/box") {
        req.resume();
        req.on("end", () => pendingBoxResponses.push(res));
        return;
      }
      res.writeHead(404).end("{}");
    });
    await new Promise<void>((resolve) => box.listen(0, "127.0.0.1", resolve));
    boxPort = (box.address() as any).port;

    controlServer = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        controlOps.push(parsed);
        res.writeHead(200, { "content-type": "application/json" });
        if (req.method === "POST" && parsed.op === "begin-action") {
          res.end(JSON.stringify({ valid: true, allowed: true, actionId: `action-${++actionSequence}` }));
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
    for (const response of pendingBoxResponses.splice(0)) response.destroy();
    box?.closeAllConnections?.();
    controlServer?.closeAllConnections?.();
    box?.close();
    controlServer?.close();
  });

  it("waits through stdin EOF and ends only the exact delayed action after proof of completion", async () => {
    const proxy = startProxy();
    const closed = new Promise<void>((resolve) => proxy.once("close", () => resolve()));
    let stdout = "";
    proxy.stdout!.on("data", (chunk) => (stdout += chunk));
    proxy.stdin!.end(JSON.stringify({
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: { name: "click", arguments: { x: 1, y: 1, observe: false } },
    }) + "\n");

    await waitUntil(() => controlOps.some((entry) => entry.op === "begin-action") && pendingBoxResponses.length === 1,
      "delayed Box action never started");
    expect(controlOps.some((entry) => entry.op === "end-action")).toBe(false);
    expect(proxy.exitCode).toBeNull();

    finishNextBoxAction();
    await waitUntil(() => controlOps.some((entry) => entry.op === "end-action" && entry.actionId === "action-1"),
      "exact action was not ended after Box completed");
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error("proxy did not exit after its in-flight request drained")),
        3_000,
      )),
    ]);
    expect(stdout).toContain('"id":41');
    expect(controlOps.some((entry) => entry.op === "end-all-actions")).toBe(false);
  });

  it("kills only the proxy receiving a fragmented no-newline frame", async () => {
    const hostile = startProxy();
    const sibling = startProxy();
    hostile.stdin!.on("error", () => {});
    const hostileClosed = new Promise<number | null>((resolve) => hostile.once("close", (code) => resolve(code)));
    const fragment = Buffer.alloc(64 * 1024, 0x78);
    for (let i = 0; i < 33; i += 1) hostile.stdin!.write(fragment);
    await expect(hostileClosed).resolves.toBe(1);

    let siblingOutput = "";
    sibling.stdout!.on("data", (chunk) => { siblingOutput += chunk; });
    sibling.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "initialize", params: {} }) + "\n");
    await waitUntil(() => siblingOutput.includes('"id":99'), "sibling computer proxy stopped responding");
    sibling.kill("SIGKILL");
  });

  it("does not clear an ambiguous action when the proxy is SIGKILLed", async () => {
    const proxy = startProxy();
    const closed = new Promise<void>((resolve) => proxy.once("close", () => resolve()));
    proxy.stdin!.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "click", arguments: { x: 2, y: 2, observe: false } },
    }) + "\n");
    await waitUntil(() => controlOps.filter((entry) => entry.op === "begin-action").length === 2 && pendingBoxResponses.length === 1,
      "second delayed Box action never started");

    proxy.kill("SIGKILL");
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(controlOps.some((entry) => entry.op === "end-action" && entry.actionId === "action-2")).toBe(false);
    expect(controlOps.some((entry) => entry.op === "end-all-actions")).toBe(false);
    pendingBoxResponses.shift()?.destroy();
  });
});
