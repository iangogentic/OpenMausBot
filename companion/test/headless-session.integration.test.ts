// Proves the non-Electron deployment path used on Razer: the companion has
// no utility-process parentPort, obtains its harness bearer only from a
// private file, and can still proxy a paired device request.
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SESSION = "headless-session-token-" + "s".repeat(32);
const CONTROL_SESSION = "headless-control-token-" + "c".repeat(32);
const DEVICE = "paired-device-token";

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });

const close = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));
const stop = (child: ChildProcess): Promise<void> => new Promise((resolve) => {
  if (child.exitCode !== null) return resolve();
  child.once("close", () => resolve());
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 3_000).unref?.();
});

const unixRequest = (
  socketPath: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
  const outgoing = request({ socketPath, path, headers }, (incoming) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => resolve({
      status: incoming.statusCode ?? 0,
      body: Buffer.concat(chunks).toString("utf8"),
    }));
  });
  outgoing.once("error", reject);
  outgoing.end();
});

describe("headless companion harness session", () => {
  it.runIf(process.platform !== "win32")("reads private credentials and serves protected deployment sockets", async () => {
    // Unix socket paths are capped at roughly 104 bytes on macOS. `/tmp`
    // keeps this deployment-path test under that real kernel boundary.
    const root = mkdtempSync(join("/tmp", "omb-headless-companion-"));
    const data = join(root, "companion-data");
    const credentialsDirectory = join(root, "systemd-credentials");
    // Keep the socket names compact too.
    const runtimeDirectory = root;
    const companionSocket = join(runtimeDirectory, "c.sock");
    const controlSocket = join(runtimeDirectory, "x.sock");
    mkdirSync(data, { recursive: true, mode: 0o700 });
    mkdirSync(credentialsDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
    const sessionFile = join(credentialsDirectory, "openmausbot-ui-session");
    const controlSessionFile = join(credentialsDirectory, "openmausbot-companion-session");
    writeFileSync(sessionFile, `${SESSION}\n`, { mode: 0o600 });
    writeFileSync(controlSessionFile, `${CONTROL_SESSION}\n`, { mode: 0o600 });
    chmodSync(sessionFile, 0o600);
    chmodSync(controlSessionFile, 0o600);
    writeFileSync(join(data, "devices.json"), JSON.stringify({
      devices: [{
        id: "phone-1",
        name: "Test phone",
        tokenHash: createHash("sha256").update(DEVICE).digest("hex"),
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        cloudDesktopAccess: false,
      }],
    }), { mode: 0o600 });

    let harness: Server | undefined;
    let child: ChildProcess | undefined;
    try {
      const harnessPort = await freePort();
      const companionPort = await freePort();
      const controlPort = await freePort();
      const webhookPort = await freePort();
      const seenBearer: string[] = [];
      harness = createServer((req, res) => {
        seenBearer.push(String(req.headers["x-openmausbot-session"] ?? ""));
        if (req.headers["x-openmausbot-session"] !== SESSION) {
          res.writeHead(401).end();
          return;
        }
        if (req.url === "/api/health") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ app: "openmausbot" }));
          return;
        }
        if (req.url === "/api/config") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ profile: { name: "Razer" } }));
          return;
        }
        if (req.url === "/api/bots") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ bots: [] }));
          return;
        }
        res.writeHead(404).end();
      });
      await new Promise<void>((resolve) => harness!.listen(harnessPort, "127.0.0.1", resolve));

      child = spawn(process.execPath, ["--experimental-strip-types", "companion/src/index.ts"], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          USERPROFILE: root,
          OMB_PORT: String(harnessPort),
          OMB_WEBHOOK_PORT: String(webhookPort),
          OMB_COMPANION_PORT: String(companionPort),
          OMB_CONTROL_PORT: String(controlPort),
          OMB_COMPANION_LISTEN_SOCKET: companionSocket,
          OMB_CONTROL_LISTEN_SOCKET: controlSocket,
          OMB_COMPANION_DIR: data,
          CREDENTIALS_DIRECTORY: credentialsDirectory,
          OMB_COMPANION_NAME: "Headless test",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      let stdout = "";
      child.stderr?.on("data", (chunk) => (stderr += chunk));
      child.stdout?.on("data", (chunk) => (stdout += chunk));

      const deadline = Date.now() + 8_000;
      for (;;) {
        try {
          const ready = await unixRequest(companionSocket, "/api/health");
          if (ready.status === 200) break;
        } catch {
          // Still binding.
        }
        if (Date.now() > deadline) throw new Error(`headless companion did not start: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(statSync(companionSocket).mode & 0o777).toBe(0o600);
      expect(statSync(controlSocket).mode & 0o777).toBe(0o600);
      await expect(fetch(`http://127.0.0.1:${companionPort}/api/health`, {
        signal: AbortSignal.timeout(300),
      })).rejects.toThrow();

      const response = await unixRequest(companionSocket, "/api/bots", {
        authorization: `Bearer ${DEVICE}`,
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ bots: [] });
      const control = await unixRequest(controlSocket, "/state", {
        "x-openmausbot-session": CONTROL_SESSION,
      });
      expect(control.status).toBe(200);
      const harnessTokenRejectedByControl = await unixRequest(controlSocket, "/state", {
        "x-openmausbot-session": SESSION,
      });
      expect(harnessTokenRejectedByControl.status).toBe(401);
      const logDeadline = Date.now() + 2_000;
      while (!stdout.includes(`public :${companionPort}`) && Date.now() < logDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(stdout).toContain(`public :${companionPort}`);
      expect(stdout).toContain(`public 127.0.0.1:${controlPort}`);
      expect(seenBearer.length).toBeGreaterThan(1);
      expect(seenBearer.every((value) => value === SESSION)).toBe(true);
    } finally {
      if (child) await stop(child);
      if (harness) await close(harness);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
