import { createServer } from "node:http";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listenHarnessServer, privateListenSocket } from "./listen-socket.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("private harness listen socket", () => {
  it("keeps normal local development on loopback TCP", () => {
    expect(privateListenSocket(undefined)).toBeNull();
    expect(privateListenSocket("  ")).toBeNull();
  });

  it("rejects relative, non-socket, overlong, and Windows paths", () => {
    expect(() => privateListenSocket("relative.sock")).toThrow("absolute Unix-socket");
    expect(() => privateListenSocket("/run/openmausbot/private"))
      .toThrow("absolute Unix-socket");
    expect(() => privateListenSocket(`/${"x".repeat(100)}.sock`))
      .toThrow("absolute Unix-socket");
    expect(() => privateListenSocket("/run/openmausbot/harness.sock", { platform: "win32" }))
      .toThrow("absolute Unix-socket");
  });

  it.runIf(process.platform !== "win32")("binds a mode-0600 UDS without deleting arbitrary paths", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omb-listen-"));
    cleanup.push(directory);
    const socketPath = join(directory, "harness.sock");
    const server = createServer((_req, res) => res.end("ok"));
    const bound = await listenHarnessServer(server, { port: 8799, socketPath });
    expect(bound).toEqual({ socketPath, displayUrl: "http://127.0.0.1:8799" });
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
