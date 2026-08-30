// Cross-platform process spawning for the agent CLIs. Three Windows
// differences are exposed to drivers through this module:
//   1. CreateProcess can't exec npm .cmd/.bat shims or node-shebang scripts
//      directly. env-path resolves those to their real .exe / `node script`
//      entry without a shell, so quoting-sensitive JSON argv stays intact.
//   2. No process-group kill (kill(-pid) is POSIX) — taskkill /T reaps the
//      whole tree, CLI + its spawned MCP proxies alike.
//   3. Console apps spawned from the GUI shell flash a console window
//      unless windowsHide is set.
import {
  spawn,
  execFile,
  type ChildProcess,
  type ChildProcessByStdio,
  type ExecFileOptions,
  type ExecFileOptionsWithStringEncoding,
  type SpawnOptions,
} from "node:child_process";
import { createHash } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { findCliCandidates, resolveCliSpawn, type ResolvedSpawn } from "./env-path.ts";
import {
  PROVIDER_INSTANCE_HOME_ENV,
  PROVIDER_INSTANCE_STATE_ENV,
  providerRuntimeBase,
} from "./provider-runtime.ts";

const PROVIDER_TURN_DIR_ENV = "OMB_PROVIDER_TURN_DIR";
const PROVIDER_SANDBOX_PATHS_ENV = "OMB_PROVIDER_SANDBOX_PATHS";
const PROVIDER_LAUNCH_MANIFEST_ENV = "OMB_PROVIDER_LAUNCH_MANIFEST";
const PROVIDER_LIMIT_ENV = [
  "OMB_PROVIDER_MEMORY_HIGH_BYTES",
  "OMB_PROVIDER_MEMORY_MAX_BYTES",
  "OMB_PROVIDER_MEMORY_SWAP_MAX_BYTES",
  "OMB_PROVIDER_CPU_QUOTA_PERCENT",
  "OMB_PROVIDER_TASKS_MAX",
  "OMB_PROVIDER_PARENT_UNIT",
] as const;

export interface ProviderRuntimePath {
  /** Existing file or directory under OMB_PROVIDER_RUNTIME_DIR. */
  path: string;
  /** Read-only by default. Grant writes only when this turn creates output. */
  writable?: boolean;
}

export interface ProviderPersistentHome {
  /** Stable harness-owned bot/agent identity. All of that bot's tasks share
   * its native provider state; sibling bots remain isolated. Never taken
   * from child env. */
  ownerKey: string;
}

export interface ProviderHomeImport {
  /** Existing server-staged regular file under OMB_PROVIDER_RUNTIME_DIR. */
  source: string;
  /** Relative destination inside this bot's persistent HOME. */
  destination: string;
  /** Refresh a policy/config file each turn; false initializes once. */
  replace?: boolean;
}

export interface ProviderSpawnOptions extends SpawnOptions {
  /** Trusted harness metadata. Values with these names in `env` are ignored. */
  providerRuntimePaths?: ProviderRuntimePath[];
  /** Persist one private HOME view for this exact provider instance + bot
   * owner. The supervisor hashes the key and never exposes sibling homes. */
  providerPersistentHome?: ProviderPersistentHome;
  /** Narrow server-authored files to initialize/refresh inside persistent HOME. */
  providerHomeImports?: ProviderHomeImport[];
}

interface ProviderSandboxEnvironment {
  /** Minimal environment crossing sudo. Provider credentials stay in the
   * server-owned manifest rather than a wildcard sudo env_keep rule. */
  environment: NodeJS.ProcessEnv;
  scopePath: string;
  manifestPath: string;
  providerHome: string;
  cleanup: () => void;
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function persistentHomeDigest(value: ProviderPersistentHome | undefined): string | null {
  if (!value) return null;
  if (
    typeof value.ownerKey !== "string" ||
    value.ownerKey.length < 1 ||
    value.ownerKey.length > 1024 ||
    /[\0\r\n]/.test(value.ownerKey)
  ) {
    throw new Error("provider persistent home identity is invalid");
  }
  return createHash("sha256")
    .update(`owner\0${value.ownerKey}`, "utf8")
    .digest("hex")
    .slice(0, 48);
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside the supported range`);
  }
  return value;
}

function providerResourceLimits(startup: NodeJS.ProcessEnv) {
  const memoryMax = boundedInteger(
    startup.OMB_PROVIDER_MEMORY_MAX_BYTES,
    4 * 1024 ** 3,
    128 * 1024 ** 2,
    64 * 1024 ** 3,
    "OMB_PROVIDER_MEMORY_MAX_BYTES",
  );
  const memoryHigh = boundedInteger(
    startup.OMB_PROVIDER_MEMORY_HIGH_BYTES,
    3 * 1024 ** 3,
    64 * 1024 ** 2,
    memoryMax,
    "OMB_PROVIDER_MEMORY_HIGH_BYTES",
  );
  return {
    memoryHigh,
    memoryMax,
    memorySwapMax: boundedInteger(
      startup.OMB_PROVIDER_MEMORY_SWAP_MAX_BYTES,
      0,
      0,
      16 * 1024 ** 3,
      "OMB_PROVIDER_MEMORY_SWAP_MAX_BYTES",
    ),
    cpuQuotaPercent: boundedInteger(
      startup.OMB_PROVIDER_CPU_QUOTA_PERCENT,
      200,
      10,
      800,
      "OMB_PROVIDER_CPU_QUOTA_PERCENT",
    ),
    tasksMax: boundedInteger(startup.OMB_PROVIDER_TASKS_MAX, 256, 16, 2048, "OMB_PROVIDER_TASKS_MAX"),
  };
}

function providerParentUnit(startup: NodeJS.ProcessEnv): string {
  const value = startup.OMB_PROVIDER_PARENT_UNIT?.trim() || "openmausbot.service";
  if (!/^[A-Za-z0-9_.@-]{1,128}\.service$/.test(value)) {
    throw new Error("OMB_PROVIDER_PARENT_UNIT must be one exact systemd service unit");
  }
  return value;
}

/** Create the trusted, unique mount manifest consumed by the immutable root
 * supervisor. Caller env is provider-controlled and therefore cannot name
 * either its scope or sibling runtime paths. */
export function prepareProviderSandboxEnvironment(
  childEnvironment: NodeJS.ProcessEnv,
  requestedPaths: ProviderRuntimePath[] = [],
  startup: NodeJS.ProcessEnv = process.env,
  persistentHome?: ProviderPersistentHome,
  requestedImports: ProviderHomeImport[] = [],
): ProviderSandboxEnvironment {
  if (requestedPaths.length > 32) throw new Error("provider runtime path list is capped at 32 entries");
  if (requestedImports.length > 16) throw new Error("provider home import list is capped at 16 entries");
  const base = providerRuntimeBase(startup);
  if (!base) throw new Error("provider sandbox requires OMB_PROVIDER_RUNTIME_DIR");
  const configuredRoot = startup.OMB_PROVIDER_HOME?.trim() ?? "";
  if (!configuredRoot || !isAbsolute(configuredRoot) || /[\0\r\n]/.test(configuredRoot)) {
    throw new Error("provider sandbox requires an absolute OMB_PROVIDER_HOME");
  }
  const providerRoot = realpathSync(configuredRoot);
  const configuredStateRoot = startup.OMB_PROVIDER_STATE_DIR?.trim() ?? "";
  if (!configuredStateRoot || !isAbsolute(configuredStateRoot) || /[\0\r\n]/.test(configuredStateRoot)) {
    throw new Error("provider sandbox requires an absolute OMB_PROVIDER_STATE_DIR");
  }
  const providerStateRoot = realpathSync(configuredStateRoot);
  if (providerStateRoot !== join(providerRoot, "state")) {
    throw new Error("provider state root must be the provider root's state directory");
  }
  const configuredHome = childEnvironment[PROVIDER_INSTANCE_HOME_ENV]?.trim() ?? "";
  if (!configuredHome || !isAbsolute(configuredHome) || /[\0\r\n]/.test(configuredHome)) {
    throw new Error("provider sandbox requires a trusted provider instance home");
  }
  const providerHome = realpathSync(configuredHome);
  const homeStat = lstatSync(providerHome);
  if (
    !pathInside(join(providerRoot, "instances"), providerHome) ||
    !homeStat.isDirectory() ||
    homeStat.isSymbolicLink() ||
    providerHome !== configuredHome ||
    (homeStat.mode & 0o7777) !== 0o2750
  ) {
    throw new Error("provider instance home must be an existing canonical isolated directory");
  }
  const configuredState = childEnvironment[PROVIDER_INSTANCE_STATE_ENV]?.trim() ?? "";
  if (!configuredState || !isAbsolute(configuredState) || /[\0\r\n]/.test(configuredState)) {
    throw new Error("provider sandbox requires a trusted provider instance state directory");
  }
  const providerState = realpathSync(configuredState);
  const stateStat = lstatSync(providerState);
  const homeParts = relative(join(providerRoot, "instances"), providerHome).split(/[\\/]/);
  const stateParts = relative(providerStateRoot, providerState).split(/[\\/]/);
  if (
    !pathInside(providerStateRoot, providerState) ||
    !stateStat.isDirectory() ||
    stateStat.isSymbolicLink() ||
    providerState !== configuredState ||
    (stateStat.mode & 0o7777) !== 0o750 ||
    homeParts.length !== 2 ||
    stateParts.length !== 2 ||
    homeParts.some((part, index) => part !== stateParts[index])
  ) {
    throw new Error("provider instance state must match the canonical isolated instance mapping");
  }
  const persistentHomeKey = persistentHomeDigest(persistentHome);
  const limits = providerResourceLimits(startup);
  const parentUnit = providerParentUnit(startup);
  const scopePath = mkdtempSync(join(base, "spawn-"));
  chmodSync(scopePath, 0o2750);
  const manifestPath = join(scopePath, "launch.json");
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    rmSync(scopePath, { recursive: true, force: true });
  };
  try {
    const paths = new Map<string, boolean>([[scopePath, true]]);
    for (const requested of requestedPaths) {
      if (!requested || !isAbsolute(requested.path)) {
        throw new Error("provider runtime paths must be existing absolute paths");
      }
      const canonical = realpathSync(requested.path);
      if (!pathInside(base, canonical)) {
        throw new Error("provider runtime path must stay inside OMB_PROVIDER_RUNTIME_DIR");
      }
      const stat = lstatSync(canonical);
      if ((!stat.isDirectory() && !stat.isFile()) || stat.isSymbolicLink()) {
        throw new Error("provider runtime path must be a regular file or directory; pass a socket's turn directory");
      }
      paths.set(canonical, paths.get(canonical) === true || requested.writable === true);
    }
    const pathEntries = [...paths].map(([path, writable]) => ({
      path,
      writable,
      directory: lstatSync(path).isDirectory(),
    }));
    for (let leftIndex = 0; leftIndex < pathEntries.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < pathEntries.length; rightIndex += 1) {
        const left = pathEntries[leftIndex];
        const right = pathEntries[rightIndex];
        const leftContainsRight = pathInside(left.path, right.path);
        const rightContainsLeft = pathInside(right.path, left.path);
        if (!leftContainsRight && !rightContainsLeft) continue;
        const ancestor = leftContainsRight ? left : right;
        const descendant = leftContainsRight ? right : left;
        // Hermes has one intentional overlap: a nonce-bound writable proof
        // file mounted on top of its read-only policy directory. A writable
        // ancestor or nested directory would broaden authority and is denied.
        if (ancestor.writable || descendant.directory) {
          throw new Error("provider runtime mounts may overlap only for an exact file inside a read-only directory");
        }
      }
    }
    pathEntries.sort((left, right) => left.path.split(/[\\/]/).length - right.path.split(/[\\/]/).length);
    const imports = requestedImports.map((requested) => {
      if (!requested || !isAbsolute(requested.source)) {
        throw new Error("provider home import source must be an existing absolute path");
      }
      const source = realpathSync(requested.source);
      const sourceStat = lstatSync(source);
      if (!pathInside(base, source) || !sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        throw new Error("provider home import source must be a regular file inside OMB_PROVIDER_RUNTIME_DIR");
      }
      const destination = requested.destination;
      if (
        typeof destination !== "string" ||
        destination.length < 1 ||
        destination.length > 512 ||
        isAbsolute(destination) ||
        /[\0\r\n]/.test(destination) ||
        destination.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
      ) {
        throw new Error("provider home import destination must be one safe relative path");
      }
      return { source, destination, replace: requested.replace === true };
    });
    const targetEnvironment: NodeJS.ProcessEnv = { ...childEnvironment };
    // Replace, never trust, boundary values injected through a provider
    // instance environment. Only this harness process selects them.
    delete targetEnvironment[PROVIDER_TURN_DIR_ENV];
    delete targetEnvironment[PROVIDER_SANDBOX_PATHS_ENV];
    delete targetEnvironment[PROVIDER_LAUNCH_MANIFEST_ENV];
    delete targetEnvironment[PROVIDER_INSTANCE_HOME_ENV];
    delete targetEnvironment[PROVIDER_INSTANCE_STATE_ENV];
    delete targetEnvironment.OMB_PROVIDER_STATE_DIR;
    for (const name of PROVIDER_LIMIT_ENV) delete targetEnvironment[name];
    targetEnvironment.HOME = providerHome;
    targetEnvironment.USERPROFILE = providerHome;
    targetEnvironment.OMB_PROVIDER_HOME = providerRoot;
    targetEnvironment.OMB_PROVIDER_RUNTIME_DIR = base;
    targetEnvironment[PROVIDER_TURN_DIR_ENV] = scopePath;
    writeFileSync(manifestPath, JSON.stringify({
      version: 1,
      providerRoot,
      providerHome,
      providerStateRoot,
      providerState,
      persistentHomeKey,
      runtimeBase: base,
      turnDirectory: scopePath,
      limits,
      parentUnit,
      environment: targetEnvironment,
      paths: pathEntries.map(({ path, writable }) => ({ path, writable })),
      homeImports: imports,
    }), { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(manifestPath, 0o600);
    // This is deliberately the entire environment seen by the shell launcher.
    // sudo preserves one exact, non-secret variable; the root supervisor
    // validates and consumes the manifest before the hostile UID exists.
    const environment: NodeJS.ProcessEnv = {
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      [PROVIDER_LAUNCH_MANIFEST_ENV]: manifestPath,
    };
    return { environment, scopePath, manifestPath, providerHome, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

export function providerIsolationConfigured(startup: NodeJS.ProcessEnv = process.env): boolean {
  return startup.OMB_REQUIRE_PROVIDER_ISOLATION === "1" || Boolean(startup.OMB_PROVIDER_LAUNCHER?.trim());
}

/** Retire one deleted bot's exact native provider HOME. The same immutable
 * launcher/supervisor validates the hashed instance namespace, holds the
 * nonblocking per-bot lock, and refuses deletion while a child is alive. */
export async function retireProviderOwnerState(
  ownerKey: string,
  startup: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!providerIsolationConfigured(startup)) return;
  const base = providerRuntimeBase(startup);
  if (!base) throw new Error("provider state retirement requires OMB_PROVIDER_RUNTIME_DIR");
  const configuredRoot = startup.OMB_PROVIDER_HOME?.trim() ?? "";
  const configuredStateRoot = startup.OMB_PROVIDER_STATE_DIR?.trim() ?? "";
  if (!isAbsolute(configuredRoot) || !isAbsolute(configuredStateRoot)) {
    throw new Error("provider state retirement requires absolute provider roots");
  }
  const providerRoot = realpathSync(configuredRoot);
  const providerStateRoot = realpathSync(configuredStateRoot);
  if (providerStateRoot !== join(providerRoot, "state")) {
    throw new Error("provider state retirement root is invalid");
  }
  const persistentHomeKey = persistentHomeDigest({ ownerKey });
  if (!persistentHomeKey) throw new Error("provider state retirement identity is invalid");
  const scopePath = mkdtempSync(join(base, "spawn-retire-"));
  chmodSync(scopePath, 0o2750);
  const manifestPath = join(scopePath, "launch.json");
  const cleanup = () => rmSync(scopePath, { recursive: true, force: true });
  try {
    writeFileSync(manifestPath, JSON.stringify({
      version: 1,
      operation: "retire-owner",
      providerRoot,
      providerStateRoot,
      persistentHomeKey,
      runtimeBase: base,
    }), { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(manifestPath, 0o600);
    const resolved = resolveProviderSpawn({ command: "/usr/bin/true", args: [] }, startup);
    await new Promise<void>((resolve, reject) => {
      execFile(resolved.command, ["--retire-owner"], {
        env: {
          PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
          [PROVIDER_LAUNCH_MANIFEST_ENV]: manifestPath,
        },
        timeout: 15_000,
        windowsHide: true,
      }, (error) => error ? reject(error) : resolve());
    });
  } finally {
    cleanup();
  }
}

export function resolveCli(cli: string, args: string[] = []): ResolvedSpawn {
  return resolveCliSpawn(cli, args);
}

/** Optional OS identity boundary for hostile provider CLIs. Production
 * remote deployments set this to a root-owned launcher that changes to the
 * unprivileged provider UID. Requiring isolation makes a missing/tampered
 * launcher a hard spawn failure instead of silently returning to same-UID. */
export function resolveProviderSpawn(
  resolved: ResolvedSpawn,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSpawn {
  const launcher = env.OMB_PROVIDER_LAUNCHER?.trim() ?? "";
  const required = env.OMB_REQUIRE_PROVIDER_ISOLATION === "1";
  if (process.platform === "win32") {
    if (launcher || required) {
      throw new Error("provider OS isolation is configured but is not supported on Windows");
    }
    return resolved;
  }
  if (!launcher) {
    if (required) {
      throw new Error("provider OS isolation is required but no launcher is configured");
    }
    return resolved;
  }
  if (!isAbsolute(launcher) || /[\0\r\n]/.test(launcher)) {
    throw new Error("provider launcher path is invalid");
  }
  let stat;
  try {
    stat = lstatSync(launcher);
  } catch {
    throw new Error("provider launcher must be a root-owned, executable, non-writable regular file");
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    realpathSync(launcher) !== launcher ||
    stat.uid !== 0 ||
    (stat.mode & 0o111) === 0 ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new Error("provider launcher must be a root-owned, executable, non-writable regular file");
  }
  const providerCommand = isAbsolute(resolved.command)
    ? resolved.command
    : findCliCandidates(resolved.command)[0] ?? resolved.command;
  // The separator is part of the launcher contract. It keeps a resolved
  // command beginning with a dash from becoming an option to the privileged,
  // root-owned wrapper. No shell parses either the command or its arguments.
  return { command: launcher, args: ["--", providerCommand, ...resolved.args] };
}

export function spawnCli(
  cli: string,
  args: string[],
  opts: ProviderSpawnOptions,
): ChildProcessByStdio<Writable, Readable, Readable> {
  // The caller-supplied child environment can contain provider configuration,
  // so it is attacker-influenced by definition. Only the harness's own
  // startup environment is allowed to select or disable the OS launcher.
  const resolved = resolveProviderSpawn(resolveCli(cli, args), process.env);
  const { providerRuntimePaths, providerPersistentHome, providerHomeImports, ...ordinaryOptions } = opts;
  const isolation = providerIsolationConfigured();
  const sandbox = isolation
    ? prepareProviderSandboxEnvironment(
        { ...(ordinaryOptions.env ?? process.env) },
        providerRuntimePaths,
        process.env,
        providerPersistentHome,
        providerHomeImports,
      )
    : null;
  const cwd = isolation && ordinaryOptions.cwd === undefined ? sandbox?.providerHome : ordinaryOptions.cwd;
  let child: ChildProcessByStdio<Writable, Readable, Readable>;
  try {
    const spawnOptions: SpawnOptions = {
      ...ordinaryOptions,
      // posix: own process group so kill(-pid) reaps child MCP servers;
      // win32: taskkill /T does the reaping instead (see killCliTree)
      ...(process.platform === "win32" ? { windowsHide: true } : { detached: true }),
    };
    if (cwd) spawnOptions.cwd = cwd;
    if (sandbox) spawnOptions.env = sandbox.environment;
    // SAFETY: every spawnCli call pipes stdout/stderr. Calls that request an
    // ignored stdin never dereference stdin; interactive calls request a pipe.
    child = spawn(resolved.command, resolved.args, spawnOptions) as ChildProcessByStdio<Writable, Readable, Readable>;
  } catch (error) {
    sandbox?.cleanup();
    throw error;
  }
  if (sandbox) child.once("close", sandbox.cleanup);

  // A write to a dying child's stdin fails differently per platform, and one
  // of the ways is fatal. On POSIX the kill is synchronous, the stream is
  // already destroyed by the time anything writes, and the write throws into
  // the caller's try/catch. On Windows killCliTree goes through taskkill — a
  // subprocess — so there is a window where the child is dead but its pipe is
  // not, and a write during it errors *asynchronously* on the stream. No
  // driver listens for that, an unlistened stream error is an uncaught
  // exception, and the whole harness exits over one dead CLI. The error
  // carries no information the drivers don't already get from `close`, which
  // is where every one of them settles the turn — so it is swallowed, not
  // logged.
  child.stdin?.on("error", () => {});
  return child;
}

export function execCli(
  cli: string,
  args: string[],
  opts: ExecFileOptions,
  cb: (err: Error | null, stdout: string, stderr?: string) => void,
): void {
  // As in spawnCli, never let a provider instance's env choose its launcher.
  const resolved = resolveProviderSpawn(resolveCli(cli, args), process.env);
  const isolation = providerIsolationConfigured();
  const sandbox = isolation
    ? prepareProviderSandboxEnvironment({ ...(opts.env ?? process.env) })
    : null;
  try {
    const execOptions: ExecFileOptionsWithStringEncoding = {
      ...opts,
      windowsHide: true,
      encoding: "utf8",
    };
    if (isolation && opts.cwd === undefined && sandbox?.providerHome) execOptions.cwd = sandbox.providerHome;
    if (sandbox) execOptions.env = sandbox.environment;
    execFile(
      resolved.command,
      resolved.args,
      execOptions,
      (err, stdout, stderr) => {
        sandbox?.cleanup();
        cb(err, stdout, stderr);
      },
    );
  } catch (error) {
    sandbox?.cleanup();
    throw error;
  }
}

/** Human wording for a failed CLI spawn.
 *
 * Node reports these as bare errno strings — "spawn grok ENOENT" — which
 * reads as a crash. On a CLI spawn the common codes mean exactly one thing
 * each, and both are setup problems the user can fix, so say which. The
 * `setup` flag lets the UI offer "Install" instead of a "Retry" that is
 * guaranteed to fail the same way. */
type SpawnFailure = { message: string; setup: boolean };

export function describeSpawnFailure(err: NodeJS.ErrnoException, cli: string): SpawnFailure {
  if (err.code === "ENOENT")
    return { message: `\`${cli}\` isn't installed, or isn't on this app's PATH`, setup: true };
  if (err.code === "EACCES" || err.code === "EPERM")
    return { message: `\`${cli}\` isn't executable — check its file permissions`, setup: true };
  return { message: `spawn failed: ${err.message}`, setup: false };
}

/** Stop a CLI and every process it spawned (MCP proxies included). */
export function killCliTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (err) => {
      if (!err) return;
      try {
        // taskkill is unavailable or the tree lookup failed. At least stop
        // the process we own instead of leaving the entire turn running.
        child.kill();
      } catch {
        /* already gone */
      }
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

const treeTerminations = new WeakMap<ChildProcess, Promise<void>>();

type WindowsTaskkill = (pid: number, signal: AbortSignal) => Promise<void>;

function taskkillTree(pid: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "taskkill",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, signal },
      (error) => {
        if (!error) return resolve();
        reject(new Error(`taskkill /T /F could not terminate CLI process tree ${pid}: ${error.message}`, {
          cause: error,
        }));
      },
    );
  });
}

function posixTreeAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // SAFETY: Node documents process-signal failures as ErrnoException and
    // this branch reads only its stable `code` discriminator.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Terminate a CLI process group and do not resolve until exit is proven.
 *
 * Lifecycle callers use this stronger primitive before delete/reload admits a
 * replacement turn. TERM gets a short grace; a surviving POSIX group then
 * receives KILL. Windows taskkill already uses /T /F. Concurrent callers share
 * one proof promise so Stop + reload cannot race separate teardown attempts. */
export function terminateCliTree(
  child: ChildProcess,
  options: {
    graceMs?: number;
    timeoutMs?: number;
    /** Test seam for Windows' distinct process-tree contract. */
    platform?: NodeJS.Platform;
    /** Test seam; production always runs taskkill.exe /T /F. */
    windowsTaskkill?: WindowsTaskkill;
  } = {},
): Promise<void> {
  const existing = treeTerminations.get(child);
  if (existing) return existing;
  const graceMs = Math.max(0, options.graceMs ?? 2_000);
  const timeoutMs = Math.max(graceMs + 250, options.timeoutMs ?? 8_000);
  const pid = child.pid;
  if (!pid) return Promise.resolve();
  const platform = options.platform ?? process.platform;

  const termination = (async () => {
    if (platform === "win32") {
      // A Windows parent exiting says nothing about descendants: unlike a
      // POSIX process group, they survive re-parenting and cannot be inferred
      // from ChildProcess.exitCode. taskkill /T is the OS-owned descendant
      // traversal, and its successful completion is the teardown proof. Even
      // if Node reports the direct child closed first, keep awaiting taskkill;
      // failure or timeout must remain a fail-closed lifecycle error.
      const signal = AbortSignal.timeout(timeoutMs);
      await (options.windowsTaskkill ?? taskkillTree)(pid, signal);
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([
          new Promise<void>((resolve) => child.once("close", () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 250)),
        ]);
      }
      return;
    }

    const treeAlive = () => posixTreeAlive(pid);
    if (!treeAlive()) return;
    killCliTree(child);
    const startedAt = Date.now();
    while (treeAlive() && Date.now() - startedAt < graceMs) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (treeAlive()) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch {}
      }
    }
    while (treeAlive() && Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (treeAlive()) {
      throw new Error(`could not prove CLI process tree ${pid} exited within ${timeoutMs}ms`);
    }
    // Let Node deliver the parent's close status too. Drivers use that event
    // to remove temp MCP files and settle their exact turn bookkeeping.
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        new Promise<void>((resolve) => child.once("close", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ]);
    }
  })();
  treeTerminations.set(child, termination);
  void termination.catch(() => {
    // A bounded proof failure must surface to the caller, but it must not
    // permanently memoize failure: Stop/delete/reload may retry and obtain
    // proof after the process finally reacts to KILL/taskkill.
    if (treeTerminations.get(child) === termination) treeTerminations.delete(child);
  });
  return termination;
}

/** Per-turn broker channel: unix socket on POSIX, named pipe on Windows
 * (Node can't listen on a filesystem socket path there — EACCES). */
export function brokerSocketPath(dataDir: string, tag: string): string {
  return process.platform === "win32"
    // Named pipes share a global namespace; DATA_DIR cannot isolate two
    // concurrent app instances the way a POSIX socket directory does.
    ? `\\\\.\\pipe\\openmausbot-perm-${process.pid}-${tag}`
    : join(dataDir, `perm-${tag}.sock`);
}
