import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";

const TOKEN = "t".repeat(43);
const entry = new URL("./ian-brain-proxy.ts", import.meta.url).pathname;

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

function childFor(url: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["--experimental-strip-types", entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      OMB_IAN_BRAIN_URL: url,
      OMB_IAN_BRAIN_CAPABILITY_TOKEN: TOKEN,
    },
  });
}

async function line(child: ChildProcessWithoutNullStreams): Promise<Record<string, unknown>> {
  let buffered = "";
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      child.stdout.off("data", onData);
      try {
        resolve(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
  });
}

describe("Ian Brain stdio bridge", () => {
  it("relays JSON and SSE frames with one opaque session and deletes it on teardown", async () => {
    const seen: Array<{ method: string; host: string; authorization: string; session: string; body: string }> = [];
    let deleted = false;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        seen.push({
          method: req.method ?? "",
          host: String(req.headers.host ?? ""),
          authorization: String(req.headers.authorization ?? ""),
          session: String(req.headers["mcp-session-id"] ?? ""),
          body,
        });
        if (req.method === "DELETE") {
          deleted = true;
          res.writeHead(204).end();
          return;
        }
        const message = JSON.parse(body) as { id?: unknown; method?: string };
        if (message.method === "initialize") {
          res.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": "session-exact-1",
          });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "ian-brain", version: "1" } },
          }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "wiki_index" }] } })}\n\n`);
      });
    });
    const port = await listen(server);
    const child = childFor(`http://127.0.0.1:${port}/api/internal/ian-brain/mcp`);
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })}\n`);
    expect(await line(child)).toMatchObject({ id: 1, result: { serverInfo: { name: "ian-brain" } } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    expect(await line(child)).toMatchObject({ id: 2, result: { tools: [{ name: "wiki_index" }] } });
    child.stdin.end();
    const [code] = await once(child, "exit") as [number];
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(code).toBe(0);
    expect(Buffer.concat(stderr).toString("utf8")).toBe("");
    expect(deleted).toBe(true);
    expect(seen.map((request) => request.method)).toEqual(["POST", "POST", "DELETE"]);
    expect(seen.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(seen.every((request) => request.host === `127.0.0.1:${port}`)).toBe(true);
    expect(seen[0]?.session).toBe("");
    expect(seen[1]?.session).toBe("session-exact-1");
    expect(seen[2]?.session).toBe("session-exact-1");
  });

  it("refuses a non-loopback broker before reading provider input", async () => {
    const child = childFor("https://example.com/api/internal/ian-brain/mcp");
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const [code] = await once(child, "exit") as [number];
    expect(code).not.toBe(0);
    expect(Buffer.concat(stderr).toString("utf8")).toContain("outside the private harness boundary");
  });

  it("accepts the provider namespace's private slirp gateway authority", async () => {
    const child = childFor("http://10.0.2.2:1/api/internal/ian-brain/mcp");
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    setTimeout(() => child.kill("SIGTERM"), 250).unref();
    const [code] = await once(child, "exit") as [number];
    const output = Buffer.concat(stderr).toString("utf8");
    expect(code === 0 || code === null).toBe(true);
    expect(output).not.toContain("outside the private harness boundary");
  });

  it("reports a bounded rejection category without echoing the broker body", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden: loopback host required", secret: "must-not-echo" }));
    });
    const port = await listen(server);
    const child = childFor(`http://127.0.0.1:${port}/api/internal/ian-brain/mcp`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} })}\n`);
    const response = await line(child);
    child.stdin.end();
    await once(child, "exit");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(response).toMatchObject({ id: 7, error: { message: expect.stringContaining("loopback Host rejected") } });
    expect(JSON.stringify(response)).not.toContain("must-not-echo");
  });
});
