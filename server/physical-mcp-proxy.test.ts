import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PHYSICAL_MCP_PATH } from "./physical-bridge.ts";

const posixOnly = describe.skipIf(process.platform === "win32");

async function launch(url: string, capability = "g".repeat(43)) {
  return await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./physical-mcp-proxy.ts", import.meta.url))],
      {
        env: {
          ...process.env,
          NODE_NO_WARNINGS: "1",
          OMB_PHYSICAL_MCP_URL: url,
          OMB_PHYSICAL_MCP_CAPABILITY: capability,
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
}

posixOnly("physical computer provider relay authority", () => {
  it("accepts the production provider namespace's fixed slirp gateway", async () => {
    const result = await launch(`ws://10.0.2.2:1${PHYSICAL_MCP_PATH}`);
    expect(result.stderr).not.toMatch(/authority is unavailable/);
  });

  it("connects to the validated gateway instead of silently rewriting it to provider loopback", async () => {
    let accepted = false;
    const decoy = createServer((socket) => {
      accepted = true;
      socket.destroy();
    });
    await new Promise<void>((resolve) => decoy.listen(0, "127.0.0.1", resolve));
    const address = decoy.address();
    if (!address || typeof address === "string") throw new Error("decoy broker did not bind TCP");
    await launch(`ws://10.0.2.2:${address.port}${PHYSICAL_MCP_PATH}`);
    await new Promise<void>((resolve) => decoy.close(() => resolve()));
    expect(accepted).toBe(false);
  });

  it("rejects every other network host", async () => {
    const result = await launch(`ws://10.0.2.3:1${PHYSICAL_MCP_PATH}`);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/authority is unavailable/);
  });

  it("rejects malformed capability proof", async () => {
    const result = await launch(`ws://10.0.2.2:1${PHYSICAL_MCP_PATH}`, "too-short");
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/authority is unavailable/);
  });
});
