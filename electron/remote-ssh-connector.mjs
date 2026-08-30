import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const MAX_CONNECTIONS = 64;
const SSH_SETUP_TIMEOUT_MS = 15_000;
const SSH_STOP_GRACE_MS = 1_000;
const SSH_KILL_REAP_MS = 1_000;
const terminatingSsh = new WeakMap();

function terminateSsh(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const existing = terminatingSsh.get(child);
  if (existing) return existing;
  const termination = new Promise((resolve) => {
    let settled = false;
    let killTimer = null;
    let reapTimer = null;
    const done = () => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (reapTimer) clearTimeout(reapTimer);
      resolve();
    };
    child.once("close", done);
    try { child.kill("SIGTERM"); } catch { done(); return; }
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch {}
      }
      // A native process that does not report close even after TerminateProcess
      // must not wedge app shutdown forever. The force-kill has been issued;
      // keep a second bounded reap window for the close notification.
      reapTimer = setTimeout(done, SSH_KILL_REAP_MS);
    }, SSH_STOP_GRACE_MS);
  });
  terminatingSsh.set(child, termination);
  void termination.finally(() => terminatingSsh.delete(child));
  return termination;
}

function trustedSshBinary(platform = process.platform, environment = process.env, fileSystem = fs) {
  const candidate = platform === "win32"
    ? path.join(environment.SystemRoot || "C:\\Windows", "System32", "OpenSSH", "ssh.exe")
    : "/usr/bin/ssh";
  const stat = fileSystem.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("The system OpenSSH client is unavailable");
  if (platform !== "win32" && (stat.uid !== 0 || (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0)) {
    throw new Error("The system OpenSSH client is not root-owned and immutable");
  }
  return candidate;
}

function validateIdentityFile(file, platform = process.platform, fileSystem = fs) {
  if (!file) return;
  if (platform === "win32") {
    throw new Error("Use the Windows OpenSSH agent; identityFile is not accepted without native handle-bound ACL validation");
  }
  const stat = fileSystem.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("The configured SSH identity must be a regular non-symlink file");
  }
  if (stat.uid !== (process.getuid?.() ?? -1) || (stat.mode & 0o077) !== 0) {
    throw new Error("The configured SSH identity must be owned by this user and mode 0600");
  }
}

function knownHostAuthority(host, port) {
  if (port === 22 && !host.includes(":")) return host;
  return `[${host}]:${port}`;
}

export function remoteSshArgs(config, knownHostsFile, targetPort, platform = process.platform) {
  const nullFile = platform === "win32" ? "NUL" : "/dev/null";
  const args = [
    "-F", nullFile,
    "-T",
    "-o", "BatchMode=yes",
    "-o", "NumberOfPasswordPrompts=0",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${knownHostsFile}`,
    "-o", `GlobalKnownHostsFile=${nullFile}`,
    "-o", "CheckHostIP=no",
    "-o", "VerifyHostKeyDNS=no",
    "-o", "UpdateHostKeys=no",
    "-o", "CanonicalizeHostname=no",
    "-o", "ProxyCommand=none",
    "-o", "ProxyJump=none",
    "-o", "ConnectTimeout=10",
    "-o", "ConnectionAttempts=1",
    "-o", "ClearAllForwardings=yes",
    "-o", "PermitLocalCommand=no",
    "-p", String(config.port),
    "-l", config.user,
  ];
  if (config.identityFile) args.push("-o", "IdentitiesOnly=yes", "-i", config.identityFile);
  args.push("-W", `127.0.0.1:${targetPort}`, config.host);
  return args;
}

function sshEnvironment(environment = process.env) {
  const allowed = [
    "HOME", "USERPROFILE", "SystemRoot", "WINDIR", "SSH_AUTH_SOCK",
    "SSH_AGENT_PID", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL",
  ];
  const result = {};
  for (const name of allowed) {
    if (typeof environment[name] === "string") result[name] = environment[name];
  }
  return result;
}

async function listenOwnedProxy({
  sshBinary,
  sshConfig,
  knownHostsFile,
  targetPort,
  spawnProcess,
  createServer,
  preferredPort = 0,
}) {
  const active = new Set();
  const sockets = new Set();
  let stopped = false;
  const server = createServer({ allowHalfOpen: false }, (socket) => {
    if (stopped || active.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    socket.pause();
    sockets.add(socket);
    let child;
    try {
      child = spawnProcess(
        sshBinary,
        remoteSshArgs(sshConfig, knownHostsFile, targetPort),
        {
          env: sshEnvironment(),
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    } catch {
      sockets.delete(socket);
      socket.destroy();
      return;
    }
    active.add(child);
    let finished = false;
    const timer = setTimeout(() => finish(), SSH_SETUP_TIMEOUT_MS);
    timer.unref?.();
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      sockets.delete(socket);
      active.delete(child);
      socket.destroy();
      try { child.stdin?.destroy(); } catch {}
      try { child.stdout?.destroy(); } catch {}
      try { child.stderr?.destroy(); } catch {}
      terminateSsh(child);
    };
    child.once("error", finish);
    child.once("close", finish);
    socket.once("error", finish);
    socket.once("close", finish);
    child.stdout.once("data", () => clearTimeout(timer));
    // No parser or logging touches this stream. Credentials enter only after
    // the pinned SSH transport has authenticated and opened its -W channel.
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    child.stderr?.resume();
    socket.resume();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    // A remote desktop shell must keep one origin across full restarts: all
    // browser-owned drafts, onboarding state, webhook one-time secrets and UI
    // preferences are scoped by origin. Once allocated, the exact port is
    // therefore an app-owned identity. If another process squats it, fail
    // closed instead of silently loading a new origin with empty state.
    server.listen({ host: "127.0.0.1", port: preferredPort, exclusive: true }, resolve);
  });
  server.on("error", () => {
    // A listener failure only removes the owned route; it must not make the
    // app fall back to any pre-existing loopback endpoint.
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The owned SSH proxy could not allocate a local port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      const children = [...active];
      const closed = new Promise((resolve) => server.close(() => resolve()));
      for (const socket of [...sockets]) socket.destroy();
      await Promise.all([closed, ...children.map((child) => terminateSsh(child))]);
    },
  };
}

/** Own the only local origins the renderer and physical bridge can use. Each
 * accepted TCP connection is carried by a fresh, pinned `ssh -W` process;
 * an absent tunnel therefore yields a closed request, never a fall-through
 * to an arbitrary loopback listener. */
export async function startOwnedRemoteSshConnector(config, options = {}) {
  const fileSystem = options.fileSystem ?? fs;
  const platform = options.platform ?? process.platform;
  const sshBinary = options.sshBinary ?? trustedSshBinary(platform, process.env, fileSystem);
  validateIdentityFile(config.ssh.identityFile, platform, fileSystem);
  const runtimeDirectory = fileSystem.mkdtempSync(path.join(options.tmpdir ?? os.tmpdir(), "openmaus-ssh-"));
  fileSystem.chmodSync?.(runtimeDirectory, 0o700);
  const knownHostsFile = path.join(runtimeDirectory, "known_hosts");
  const authority = knownHostAuthority(config.ssh.host, config.ssh.port);
  fileSystem.writeFileSync(knownHostsFile, `${authority} ${config.ssh.hostPublicKey}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  const spawnProcess = options.spawnProcess ?? spawn;
  const createServer = options.createServer ?? net.createServer;
  const proxies = [];
  try {
    const server = await listenOwnedProxy({
      sshBinary,
      sshConfig: config.ssh,
      knownHostsFile,
      targetPort: 8799,
      spawnProcess,
      createServer,
      preferredPort: options.preferredServerPort ?? 0,
    });
    proxies.push(server);
    let companion = null;
    if (config.companionEnabled) {
      companion = await listenOwnedProxy({
        sshBinary,
        sshConfig: config.ssh,
        knownHostsFile,
        targetPort: 8811,
        spawnProcess,
        createServer,
        preferredPort: options.preferredCompanionPort ?? 0,
      });
      proxies.push(companion);
    }
    return Object.freeze({
      serverUrl: server.origin,
      serverPort: server.port,
      companionUrl: companion?.origin ?? null,
      companionPort: companion?.port ?? null,
      stop: async () => {
        await Promise.all(proxies.map((proxy) => proxy.stop()));
        try { fileSystem.rmSync(runtimeDirectory, { recursive: true, force: true }); } catch {}
      },
    });
  } catch (error) {
    await Promise.all(proxies.map((proxy) => proxy.stop()));
    try { fileSystem.rmSync(runtimeDirectory, { recursive: true, force: true }); } catch {}
    throw error;
  }
}
