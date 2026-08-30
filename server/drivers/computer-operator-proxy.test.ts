import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "computer-operator-proxy.ts");
const TOKEN = "operator-test-token";
const image = Buffer.from([0xff, 0xd8, 0x70, 0x78, 0xff, 0xd9]).toString("base64");
let server: Server;
let port = 0;
let child: ChildProcess;
let lastAuthorization: string | undefined;
let lastHost: string | undefined;
let lastBody: unknown;
let releaseResponse: (() => void) | null = null;
const pending = new Map<number, (message: any) => void>();
let nextId = 1;

function rpc(method: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 10_000).unref?.();
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url !== "/api/internal/computer-operator" || req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    lastAuthorization = req.headers.authorization;
    lastHost = req.headers.host;
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      lastBody = JSON.parse(raw);
      releaseResponse = () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: "operator finished", image: { mimeType: "image/jpeg", data: image } }));
      };
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as { port: number }).port;
  child = spawn(process.execPath, [PROXY], {
    env: {
      ...process.env,
      // `localhost` proves that the transport connects to the configured
      // address while overriding Host to the loopback authority expected by
      // the production harness (the real provider address is 10.0.2.2).
      OMB_HARNESS_URL: `http://localhost:${port}`,
      OMB_COMPUTER_OPERATOR_CAPABILITY_TOKEN: TOKEN,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buffered = "";
  child.stdout!.on("data", (chunk) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
});

afterAll(async () => {
  child?.kill();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("computer operator MCP proxy", () => {
  it("exposes one blocking delegation tool and returns text plus final image", async () => {
    const initialized = await rpc("initialize", { protocolVersion: "2024-11-05" });
    expect(initialized.result.serverInfo.name).toContain("computer-operator");
    const listed = await rpc("tools/list");
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["delegate_computer"]);

    const call = rpc("tools/call", { name: "delegate_computer", arguments: { task: "open Terminal" } });
    for (let attempt = 0; attempt < 50 && !releaseResponse; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(lastAuthorization).toBe(`Bearer ${TOKEN}`);
    expect(lastHost).toBe(`127.0.0.1:${port}`);
    expect(lastBody).toEqual({ task: "open Terminal" });
    let settled = false;
    void call.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseResponse!();
    const result = await call;
    expect(result.result.content).toEqual([
      { type: "text", text: "operator finished" },
      { type: "image", data: image, mimeType: "image/jpeg" },
    ]);
  });

  it("aborts the matching blocking HTTP request on MCP cancellation", async () => {
    releaseResponse = null;
    const requestId = nextId;
    const call = rpc("tools/call", { name: "delegate_computer", arguments: { task: "wait here" } });
    for (let attempt = 0; attempt < 50 && !releaseResponse; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    child.stdin!.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId },
    }) + "\n");
    const result = await call;
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toMatch(/cancelled/i);
  });
});
