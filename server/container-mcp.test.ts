import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { LOCAL_VM_BROKER_ORIGIN, LOCAL_VM_MCP_PATH } from "./local-vm-broker-protocol.ts";
import { acceptRawWebSocket } from "./raw-websocket.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("Local VM provider relay", () => {
  it("passes MCP bytes through one opaque capability and never invokes a runtime CLI", async () => {
    const bin = await mkdtemp(join(tmpdir(), "openmausbot-container-mcp-"));
    temporary.push(bin);
    const runtimeWasCalled = join(bin, "runtime-was-called");
    for (const name of ["docker", "podman", "container"]) {
      const executable = join(bin, name);
      await writeFile(executable, `#!/bin/sh\ntouch '${runtimeWasCalled}'\nexit 91\n`, { mode: 0o700 });
      await chmod(executable, 0o700);
    }

    const capability = "z".repeat(43);
    let seenHeaders: Record<string, string | string[] | undefined> | null = null;
    const broker = createServer();
    broker.on("upgrade", (req, socket, head) => {
      seenHeaders = req.headers;
      const websocket = acceptRawWebSocket(req, socket, head);
      if (!websocket) return socket.destroy();
      websocket.onMessage((message) => {
        if (message.data.length === 0) websocket.close(1000, "provider EOF");
        else websocket.sendBinary(message.data);
      });
    });
    await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
    const address = broker.address();
    if (!address || typeof address === "string") throw new Error("test broker did not bind TCP");

    const input = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n';
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./container-mcp.ts", import.meta.url))],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            NODE_NO_WARNINGS: "1",
            OMB_LOCAL_VM_MCP_URL: `ws://127.0.0.1:${address.port}${LOCAL_VM_MCP_PATH}`,
            OMB_LOCAL_VM_MCP_CAPABILITY: capability,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });
    await new Promise<void>((resolve) => broker.close(() => resolve()));

    expect(result).toEqual({ code: 0, stdout: input, stderr: "" });
    expect(seenHeaders).toMatchObject({
      origin: LOCAL_VM_BROKER_ORIGIN,
      authorization: `Bearer ${capability}`,
    });
    expect(existsSync(runtimeWasCalled)).toBe(false);
  });

  it("rejects malformed authority without opening a network or runtime process", async () => {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./container-mcp.ts", import.meta.url))],
        {
          env: {
            ...process.env,
            NODE_NO_WARNINGS: "1",
            OMB_LOCAL_VM_MCP_URL: `ws://127.0.0.1:8799${LOCAL_VM_MCP_PATH}`,
            OMB_LOCAL_VM_MCP_CAPABILITY: "too-short",
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/authority is unavailable/);
  });

  it("accepts the provider namespace's private slirp gateway authority", async () => {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./container-mcp.ts", import.meta.url))],
        {
          env: {
            ...process.env,
            NODE_NO_WARNINGS: "1",
            OMB_LOCAL_VM_MCP_URL: `ws://10.0.2.2:1${LOCAL_VM_MCP_PATH}`,
            OMB_LOCAL_VM_MCP_CAPABILITY: "g".repeat(43),
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
      setTimeout(() => child.kill("SIGTERM"), 250).unref();
    });
    expect(result.stderr).not.toMatch(/authority is unavailable/);
  });
});
