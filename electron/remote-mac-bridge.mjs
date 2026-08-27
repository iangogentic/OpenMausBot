import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

export const REMOTE_MAC_BRIDGE_PORT = 18798;
export const REMOTE_MAC_BRIDGE_TOKEN_FILE = "mac-bridge-token";
const AUTH_PREFIX = "OMB-MAC-BRIDGE/1 ";
const MAX_AUTH_LINE = 256;
const AUTH_TIMEOUT_MS = 5_000;
const MAX_CONNECTIONS = 4;
const CHILD_STOP_GRACE_MS = 1_000;

export function ensureRemoteMacBridgeToken(userDataDir, fileSystem = fs) {
  fileSystem.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  try {
    fileSystem.chmodSync(userDataDir, 0o700);
  } catch {}
  const tokenFile = path.join(userDataDir, REMOTE_MAC_BRIDGE_TOKEN_FILE);
  try {
    const stat = fileSystem.lstatSync(tokenFile);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error("Mac bridge token file is not a private regular file");
    }
    const token = fileSystem.readFileSync(tokenFile, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Mac bridge token is invalid");
    return { token, tokenFile };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const token = randomBytes(32).toString("base64url");
  const temporary = `${tokenFile}.${process.pid}.tmp`;
  const handle = fileSystem.openSync(temporary, "wx", 0o600);
  try {
    fileSystem.writeFileSync(handle, `${token}\n`, "utf8");
    fileSystem.fsyncSync(handle);
  } finally {
    fileSystem.closeSync(handle);
  }
  fileSystem.renameSync(temporary, tokenFile);
  try {
    fileSystem.chmodSync(tokenFile, 0o600);
  } catch {}
  return { token, tokenFile };
}

function tokenMatches(candidate, expected) {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function usableCuaConnection(connection) {
  return (
    connection &&
    (connection.mode === "embedded" || connection.mode === "standalone") &&
    typeof connection.mcpCommand === "string" &&
    Array.isArray(connection.mcpArgs) &&
    connection.mcpArgs.every((value) => typeof value === "string") &&
    connection.mcpEnv &&
    typeof connection.mcpEnv === "object"
  );
}

export async function startRemoteMacBridge({
  userDataDir,
  getConnection,
  approveConnection,
  port = REMOTE_MAC_BRIDGE_PORT,
  host = "127.0.0.1",
  spawnProcess = spawn,
  log = console,
} = {}) {
  if (host !== "127.0.0.1") throw new Error("The Mac bridge may listen only on IPv4 loopback");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid Mac bridge port");
  if (typeof approveConnection !== "function") throw new Error("Mac bridge requires local approval");
  if (typeof getConnection !== "function") throw new Error("Mac bridge requires a CUA connection provider");
  const { token, tokenFile } = ensureRemoteMacBridgeToken(userDataDir);
  const sockets = new Set();
  const children = new Set();

  const terminateChild = (child) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, CHILD_STOP_GRACE_MS);
    force.unref();
    child.once("exit", () => clearTimeout(force));
  };

  const server = net.createServer((socket) => {
    if (sockets.size >= MAX_CONNECTIONS) {
      socket.end("BUSY\n");
      return;
    }
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.setTimeout(AUTH_TIMEOUT_MS, () => socket.destroy());
    let authBuffer = Buffer.alloc(0);
    let authenticated = false;
    let child = null;

    const closeChild = () => {
      terminateChild(child);
      child = null;
    };
    socket.once("close", () => {
      sockets.delete(socket);
      closeChild();
    });
    socket.once("error", (error) => log.warn?.("[mac-bridge] socket closed:", error.message));

    socket.on("data", async function authenticate(chunk) {
      if (authenticated) return;
      socket.pause();
      authBuffer = Buffer.concat([authBuffer, chunk]);
      const newline = authBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (authBuffer.length > MAX_AUTH_LINE) socket.destroy();
        else socket.resume();
        return;
      }
      socket.removeListener("data", authenticate);
      const line = authBuffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      const remainder = authBuffer.subarray(newline + 1);
      const candidate = line.startsWith(AUTH_PREFIX) ? line.slice(AUTH_PREFIX.length) : "";
      if (!tokenMatches(candidate, token)) {
        socket.end("DENIED\n");
        return;
      }

      let approved = false;
      try {
        approved = await approveConnection();
      } catch (error) {
        log.error?.("[mac-bridge] local approval failed:", error);
      }
      if (!approved) {
        socket.end("DENIED\n");
        return;
      }

      const connection = await getConnection();
      if (!usableCuaConnection(connection)) {
        socket.end("UNAVAILABLE\n");
        return;
      }
      child = spawnProcess(connection.mcpCommand, connection.mcpArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...connection.mcpEnv },
      });
      children.add(child);
      child.once("exit", () => {
        children.delete(child);
        if (!socket.destroyed) socket.end();
      });
      child.once("error", (error) => {
        log.error?.("[mac-bridge] CUA MCP failed:", error);
        if (!socket.destroyed) socket.destroy();
      });
      child.stderr?.on("data", (data) => log.warn?.(`[mac-bridge:cua] ${String(data).trim()}`));
      socket.write("OK\n");
      child.stdout.pipe(socket);
      socket.pipe(child.stdin);
      authenticated = true;
      socket.setTimeout(0);
      if (remainder.length) child.stdin.write(remainder);
      socket.resume();
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  return Object.freeze({
    host,
    port,
    tokenFile,
    async stop() {
      for (const socket of sockets) socket.destroy();
      for (const child of children) {
        terminateChild(child);
      }
      await new Promise((resolve) => server.close(() => resolve()));
    },
  });
}
