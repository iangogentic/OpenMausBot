import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const WRAPPER = fileURLToPath(new URL("./gated-mcp.ts", import.meta.url));

describe("physical computer gated MCP wrapper", () => {
  let control: Server;
  let child: ChildProcess;
  let directory = "";
  let driverPath = "";
  let held = false;
  let authorityUp = true;
  let helpOpen = false;
  let actionSequence = 0;
  const begun: string[] = [];
  const ended: string[] = [];
  const results = new Map<number, any>();

  const rpc = (message: unknown) => child.stdin!.write(`${JSON.stringify(message)}\n`);
  const waitFor = async (id: number, timeoutMs = 4_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (results.has(id)) return results.get(id);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no MCP result for ${id}`);
  };

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "openmaus-gated-mcp-"));
    const driver = join(directory, "driver.mjs");
    driverPath = driver;
    writeFileSync(
      driver,
      `let buffer = "";
process.stdin.setEncoding("utf8");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") send({jsonrpc:"2.0", id:msg.id, result:{protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"fake-physical",version:"1"}}});
    else if (msg.method === "tools/list") send({jsonrpc:"2.0", id:msg.id, result:{tools:[{name:"click",inputSchema:{type:"object"}},{name:"env_probe",inputSchema:{type:"object"}}]}});
    else if (msg.method === "tools/call") send({jsonrpc:"2.0", id:msg.id, result:{content:[{type:"text",text:msg.params.name === "env_probe" ? JSON.stringify({wrapper:Boolean(process.env.OMB_CONTROL_TOKEN || process.env.OMB_GATED_MCP_COMMAND),provider:Boolean(process.env.OPENAI_API_KEY)}) : "driver performed " + msg.params.name}]}});
  }
});
`,
      "utf8",
    );

    control = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        if (!authorityUp) {
          res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "offline" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        if (req.method === "GET") {
          res.end(JSON.stringify({ valid: true, held, helpOpen }));
          return;
        }
        if (req.method === "POST" && body.op === "begin-action") {
          if (held) {
            res.end(JSON.stringify({ valid: true, allowed: false, reason: "human-control" }));
            return;
          }
          const actionId = `action-${++actionSequence}`;
          begun.push(actionId);
          res.end(JSON.stringify({ valid: true, allowed: true, actionId }));
          return;
        }
        if (req.method === "POST") {
          helpOpen = true;
          res.end(JSON.stringify({ valid: true, held, helpOpen, requestId: "help-1" }));
          return;
        }
        if (req.method === "DELETE" && body.op === "end-action") {
          ended.push(body.actionId);
          res.end(JSON.stringify({ valid: true, ended: true }));
          return;
        }
        if (req.method === "DELETE") {
          helpOpen = false;
          res.end(JSON.stringify({ valid: true, held, helpOpen }));
          return;
        }
        res.end(JSON.stringify({ valid: true }));
      });
    });
    await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
    const controlPort = (control.address() as any).port;

    child = spawn(process.execPath, ["--experimental-strip-types", WRAPPER], {
      env: {
        ...process.env,
        OMB_GATED_MCP_COMMAND: process.execPath,
        OMB_GATED_MCP_ARGS: JSON.stringify([driver]),
        OMB_CONTROL_URL: `http://127.0.0.1:${controlPort}/api/internal/computer-control?botId=b1&bridgeId=bridge-test-1`,
        OMB_CONTROL_TOKEN: "scoped-control-secret",
        OMB_CONTROL_POLL_MS: "25",
        OMB_CONTROL_WAIT_MS: "1000",
        OPENAI_API_KEY: "planted-provider-secret-must-not-reach-driver",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    child.stdout!.on("data", (chunk) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (typeof message.id === "number") results.set(message.id, message);
      }
    });
    rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(1);
  }, 10_000);

  afterAll(() => {
    child?.kill();
    control?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("adds human handoff and tickets each forwarded physical mutation", async () => {
    rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listed = await waitFor(2);
    expect(listed.result.tools.map((tool: any) => tool.name)).toEqual(["click", "env_probe", "computer_request_help"]);

    rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "click", arguments: {} } });
    const clicked = await waitFor(3);
    expect(clicked.result.content[0].text).toBe("driver performed click");
    expect(ended).toContain(begun.at(-1));
  });

  it("refuses to start an unscoped physical bridge", async () => {
    const unscoped = spawn(process.execPath, ["--experimental-strip-types", WRAPPER], {
      env: {
        ...process.env,
        OMB_GATED_MCP_COMMAND: process.execPath,
        OMB_GATED_MCP_ARGS: JSON.stringify([driverPath]),
        OMB_CONTROL_URL: "",
        OMB_CONTROL_TOKEN: "",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const exit = await new Promise<number | null>((resolve) => unscoped.on("close", resolve));
    expect(exit).toBe(2);
  });

  it.each([
    "http://127.0.0.1:123@evil.example/api/internal/computer-control?botId=b1&bridgeId=bridge-test-1",
    "https://127.0.0.1:8799/api/internal/computer-control?botId=b1&bridgeId=bridge-test-1",
    "http://localhost:8799/api/internal/computer-control?botId=b1&bridgeId=bridge-test-1",
    "http://127.0.0.1:8799/other?botId=b1&bridgeId=bridge-test-1",
    "http://127.0.0.1:8799/api/internal/computer-control?botId=b1&bridgeId=bridge-test-1&target=physical",
    "http://127.0.0.1/api/internal/computer-control?botId=b1&bridgeId=bridge-test-1",
  ])("refuses a control URL outside the exact loopback authority: %s", async (badUrl) => {
    const rejected = spawn(process.execPath, ["--experimental-strip-types", WRAPPER], {
      env: {
        ...process.env,
        OMB_GATED_MCP_COMMAND: process.execPath,
        OMB_GATED_MCP_ARGS: JSON.stringify([driverPath]),
        OMB_CONTROL_URL: badUrl,
        OMB_CONTROL_TOKEN: "scoped-control-secret",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const exit = await new Promise<number | null>((resolve) => rejected.on("close", resolve));
    expect(exit).toBe(2);
  });

  it("strips ownership and provider secrets before spawning the physical driver", async () => {
    rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "env_probe", arguments: {} } });
    const result = await waitFor(4);
    expect(JSON.parse(result.result.content[0].text)).toEqual({ wrapper: false, provider: false });
  });

  it("refuses without forwarding while held or when authority is unavailable", async () => {
    held = true;
    rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "click", arguments: {} } });
    expect((await waitFor(5)).result.content[0].text).toMatch(/taken control/i);
    held = false;
    authorityUp = false;
    rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "click", arguments: {} } });
    expect((await waitFor(6)).result.content[0].text).toMatch(/authority could not be verified/i);
    authorityUp = true;
  });

  it("handles computer_request_help locally and resumes only after hand-back", async () => {
    helpOpen = false;
    rpc({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "computer_request_help", arguments: { reason: "captcha" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(helpOpen).toBe(true);
    expect(results.has(7)).toBe(false);
    held = true;
    await new Promise((resolve) => setTimeout(resolve, 80));
    held = false;
    helpOpen = false;
    const result = await waitFor(7);
    expect(result.result.content[0].text).toMatch(/handed control back/i);
    expect(result.result.content[0].text).toMatch(/fresh screenshot/i);
  });
});
