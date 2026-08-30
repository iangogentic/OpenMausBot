#!/usr/bin/env node
// Root-only Linux integration proof for the exact installed launcher,
// sudoers seam, systemd namespace policy, bwrap mount/PID boundary, and
// TERM-ignoring descendant cleanup.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux" || process.getuid?.() !== 0) {
  console.error("SKIP: run this integration test as root on Linux");
  process.exit(77);
}

const user = (name) => {
  const fields = execFileSync("getent", ["passwd", name], { encoding: "utf8" }).trim().split(":");
  return { uid: Number(fields[2]), gid: Number(fields[3]), home: fields[5] };
};
const group = (name) => Number(execFileSync("getent", ["group", name], { encoding: "utf8" }).trim().split(":")[2]);
const server = user("openmaus-server");
const provider = user("openmaus-provider");
const runtimeGid = group("openmaus-runtime");
const workspaceGid = group("openmaus-workspace");
const dockerGid = group("docker");
for (const value of [server.uid, provider.uid, runtimeGid, workspaceGid, dockerGid]) {
  if (!Number.isSafeInteger(value)) throw new Error("OpenMaus deployment identities are missing");
}

const runtimeBase = "/run/openmaus-provider";
const workspaceBase = "/var/lib/openmausbot-workspaces";
const providerRoot = "/var/lib/openmaus-provider";
const providerStateRoot = join(providerRoot, "state");
const testDriverHome = join(providerRoot, "instances", "111111111111111111111111");
const providerHome = join(testDriverHome, "22222222222222222222222222222222");
const siblingHome = join(testDriverHome, "33333333333333333333333333333333");
const testDriverState = join(providerStateRoot, "111111111111111111111111");
const providerState = join(testDriverState, "22222222222222222222222222222222");
const siblingPersistentState = join(providerState, "ffffffffffffffffffffffffffffffffffffffffffffffff");
const serverState = "/var/lib/openmausbot";
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const sourceLauncher = join(sourceDirectory, "openmaus-provider-launch");
const sourceSupervisor = join(sourceDirectory, "openmaus-provider-supervisor");
const launcher = "/usr/local/libexec/openmaus-provider-launch";
const installedSupervisor = "/usr/local/libexec/openmaus-provider-supervisor";
const suffix = `${process.pid}-${Date.now()}`;
const stateImage = `/var/lib/.openmaus-provider-state-integration-${suffix}.btrfs`;
const unit = `openmaus-provider-integration-${process.pid}.service`;
const bombUnit = `openmaus-provider-bomb-${process.pid}.service`;
const aggregateSlice = `openmaus-provider-test${process.pid}.slice`;
const aggregateBombA = `openmaus-provider-aggregate-a-${process.pid}.service`;
const aggregateBombB = `openmaus-provider-aggregate-b-${process.pid}.service`;
const dockerProbeUnit = `openmaus-server-docker-integration-${process.pid}.service`;
const lifecycleParentUnit = `openmaus-provider-parent-integration-${process.pid}.service`;
const retirementOuterUnit = `openmaus-retirement-active-${process.pid}.service`;
const recreateUnit = `openmaus-retirement-recreate-${process.pid}.service`;
const bindsOuterUnit = `openmaus-provider-binds-${process.pid}.service`;
const providerSlice = "openmaus-provider.slice";
const root = join(workspaceBase, `.provider-supervisor-test-${suffix}`);
const output = join(root, "output");
const pidsFile = join(output, "host-pids");
const resultFile = join(output, "result.json");
const childFile = join(root, "child.cjs");
const parentFile = join(root, "parent.cjs");
const siblingFile = join(root, "sibling.cjs");
const bombFile = join(root, "memory-bomb.cjs");
const aggregateBombFile = join(root, "aggregate-memory-bomb.cjs");
const persistentWriterFile = join(root, "persistent-writer.cjs");
const persistentReaderFile = join(root, "persistent-reader.cjs");
const bombReady = join(output, "memory-bomb-ready");
const bombTrigger = join(output, "memory-bomb-trigger");
const aggregateReadyA = join(output, "aggregate-a-ready");
const aggregateReadyB = join(output, "aggregate-b-ready");
const aggregateTriggerA = join(output, "aggregate-a-trigger");
const aggregateTriggerB = join(output, "aggregate-b-trigger");
const scope = join(runtimeBase, `spawn-integration-${suffix}`);
const bombScope = join(runtimeBase, `spawn-bomb-${suffix}`);
const bindsScope = join(runtimeBase, `spawn-binds-${suffix}`);
const bindsReady = join(output, "binds-ready");
const declaredRuntime = join(runtimeBase, `proof-${suffix}`);
const loaderSource = join(root, "hostile-loader.c");
const loaderSo = join(declaredRuntime, "hostile-loader.so");
const loaderMarker = `/tmp/openmaus-root-loader-${suffix}`;
const policyRuntime = join(runtimeBase, `policy-${suffix}`);
const policyProof = join(policyRuntime, "proof.json");
const siblingRuntime = join(runtimeBase, `sibling-${suffix}`);
const homeBaseline = join(providerHome, `.integration-baseline-${suffix}`);
const homePrivate = join(providerHome, `.integration-private-${suffix}`);
const stateSentinel = join(serverState, `.integration-secret-${suffix}`);
const abstractSocketName = `openmaus-sibling-${suffix}`;
const abstractSocketReady = join(output, "abstract-sibling-ready");
const resourceUnitFor = (turnScope) => `openmaus-provider-turn-${basename(turnScope).slice(6)}.service`;
const resourceUnit = resourceUnitFor(scope);
const bombResourceUnit = resourceUnitFor(bombScope);
const bindsResourceUnit = resourceUnitFor(bindsScope);
let sibling;
let temporaryStateMount = false;
let temporaryRuntimeBase = false;
let temporaryHarness = null;
let aggregateOomKills = 0;
const createdSubvolumes = new Set();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const chownMode = (path, uid, gid, mode) => {
  chownSync(path, uid, gid);
  chmodSync(path, mode);
};
const unitActive = (unitName) => spawnSync("systemctl", ["is-active", "--quiet", unitName]).status === 0;
const createBtrfsSubvolume = (path) => {
  execFileSync("/usr/bin/btrfs", ["subvolume", "create", path], { stdio: "ignore" });
  execFileSync("/usr/bin/btrfs", ["qgroup", "limit", String(128 * 1024 ** 2), path], { stdio: "ignore" });
  createdSubvolumes.add(path);
};
const unitProperty = (unitName, property) => execFileSync(
  "systemctl",
  ["show", unitName, `--property=${property}`, "--value"],
  { encoding: "utf8" },
).trim();
const cgroupPathFor = (unitName) => {
  const controlGroup = unitProperty(unitName, "ControlGroup");
  if (!controlGroup.startsWith("/")) throw new Error(`${unitName} has no cgroup`);
  return `/sys/fs/cgroup${controlGroup}`;
};
const readKeyValues = (path) => Object.fromEntries(
  readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => {
    const [name, value] = line.trim().split(/\s+/, 2);
    return [name, Number(value)];
  }),
);
const waitFor = async (predicate, timeoutMs, message, intervalMs = 20) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(intervalMs);
  }
  throw new Error(message);
};
const startOuterUnit = (unitName, manifestPath, argv) => {
  execFileSync("/usr/bin/systemd-run", [
    `--unit=${unitName}`,
    "--property=Type=exec",
    "--property=User=openmaus-server",
    "--property=Group=openmaus-runtime",
    "--property=SupplementaryGroups=openmaus-workspace docker",
    "--property=KillMode=process",
    "--property=PrivateTmp=yes",
    "--property=ProtectSystem=strict",
    "--property=ProtectHome=yes",
    `--property=ReadWritePaths=${workspaceBase} ${runtimeBase} ${serverState} ${providerStateRoot}`,
    "--property=RestrictNamespaces=~cgroup",
    "--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    "--property=TimeoutStopSec=10",
    `--working-directory=${root}`,
    `--setenv=OMB_PROVIDER_LAUNCH_MANIFEST=${manifestPath}`,
    launcher, "--", ...argv,
  ], { stdio: "pipe" });
};
const startAggregateBomb = (unitName, ready, trigger) => {
  execFileSync("/usr/bin/systemd-run", [
    "--quiet",
    "--collect",
    `--unit=${unitName}`,
    `--slice=${aggregateSlice}`,
    "--property=Type=exec",
    "--property=User=openmaus-provider",
    "--property=Group=openmaus-provider",
    "--property=SupplementaryGroups=openmaus-workspace",
    "--property=UMask=0077",
    "--property=MemorySwapMax=0",
    "--property=LimitCORE=0",
    "--",
    process.execPath, aggregateBombFile, ready, trigger,
  ], { stdio: "pipe" });
};
const supervisorPidFor = (unitName) => {
  const cgroup = cgroupPathFor(unitName);
  const pids = readFileSync(join(cgroup, "cgroup.procs"), "utf8").trim().split("\n").filter(Boolean).map(Number);
  for (const pid of pids) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const uid = Number(status.split("\n").find((line) => line.startsWith("Uid:"))?.trim().split(/\s+/)[1]);
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      const executable = basename(readlinkSync(`/proc/${pid}/exe`));
      // A root sudo monitor also contains the supervisor path later in its
      // argv. Only the Python interpreter whose script argv[1] is the exact
      // immutable supervisor exercises the supervisor's signal handler.
      if (uid === 0 && executable.startsWith("python3") && argv[1] === installedSupervisor) return pid;
    } catch {
      // A short-lived sudo helper can disappear while the cgroup is scanned.
    }
  }
  return null;
};
const writeManifest = (manifestPath, paths, environment = {}, options = {}) => {
  const limits = options.limits ?? {
    memoryHigh: 3 * 1024 ** 3,
    memoryMax: 4 * 1024 ** 3,
    memorySwapMax: 0,
    cpuQuotaPercent: 200,
    tasksMax: 256,
  };
  writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    providerRoot,
    providerHome,
    providerStateRoot,
    providerState,
    persistentHomeKey: options.persistentHomeKey ?? null,
    runtimeBase,
    turnDirectory: dirname(manifestPath),
    environment: {
      ...environment,
      OMB_PROVIDER_HOME: providerRoot,
      OMB_PROVIDER_RUNTIME_DIR: runtimeBase,
      OMB_PROVIDER_TURN_DIR: dirname(manifestPath),
    },
    paths,
    homeImports: options.homeImports ?? [],
    limits,
    parentUnit: options.parentUnit ?? unit,
  }), { mode: 0o600 });
  chownMode(manifestPath, server.uid, runtimeGid, 0o600);
};
const writeRetireManifest = (manifestPath, persistentHomeKey) => {
  writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    operation: "retire-owner",
    providerRoot,
    providerStateRoot,
    persistentHomeKey,
    runtimeBase,
  }), { mode: 0o600 });
  chownMode(manifestPath, server.uid, runtimeGid, 0o600);
};
const invokeRetirement = (manifestPath) => spawnSync("/usr/bin/sudo", [
  "-n", "-u", "openmaus-server", "--",
  "/usr/bin/env", `OMB_PROVIDER_LAUNCH_MANIFEST=${manifestPath}`,
  launcher, "--retire-owner",
], { cwd: root, encoding: "utf8" });

try {
  if (!existsSync(launcher) || !existsSync(installedSupervisor)) {
    throw new Error("install the root launcher and supervisor before this test");
  }
  if (!readFileSync(sourceLauncher).equals(readFileSync(launcher))) {
    throw new Error("installed provider launcher differs from this checkout");
  }
  if (!readFileSync(sourceSupervisor).equals(readFileSync(installedSupervisor))) {
    throw new Error("installed provider supervisor differs from this checkout");
  }
  if (!existsSync(runtimeBase)) {
    mkdirSync(runtimeBase, { mode: 0o2750 });
    chownMode(runtimeBase, server.uid, runtimeGid, 0o2750);
    temporaryRuntimeBase = true;
  }
  // A production install uses the separately bounded Btrfs state filesystem.
  // For a non-cutover host proof, mount an isolated temporary image at the
  // exact path and restore the empty mountpoint afterward.
  if (spawnSync("/usr/bin/mountpoint", ["-q", providerStateRoot]).status !== 0) {
    if (existsSync(providerStateRoot) && readdirSync(providerStateRoot).length !== 0) {
      throw new Error("refusing to cover a non-empty provider state directory with the integration filesystem");
    }
    mkdirSync(providerStateRoot, { recursive: true, mode: 0o750 });
    execFileSync("/usr/bin/truncate", ["-s", "2G", stateImage]);
    execFileSync("/usr/bin/mkfs.btrfs", ["-q", "-f", stateImage]);
    execFileSync("/usr/bin/mount", ["-o", "loop,nodev,nosuid,noatime", stateImage, providerStateRoot]);
    temporaryStateMount = true;
    chownMode(providerStateRoot, 0, runtimeGid, 0o750);
    execFileSync("/usr/bin/btrfs", ["quota", "enable", providerStateRoot]);
    execFileSync("/usr/bin/btrfs", ["quota", "rescan", "-w", providerStateRoot]);
  }
  execFileSync("/usr/bin/btrfs", ["qgroup", "show", "--raw", providerStateRoot], { stdio: "ignore" });
  if (provider.home !== providerRoot) throw new Error("provider passwd home is not isolated provider root");
  if ((statSync(runtimeBase).mode & 0o7777) !== 0o2750) throw new Error("runtime base is not mode 2750");
  if (!existsSync(providerStateRoot) || (statSync(providerStateRoot).mode & 0o777) !== 0o750) {
    throw new Error("provider state root is missing or not mode 0750");
  }
  // A non-cutover staging host may not have a production listener yet. Keep
  // the positive slirp gateway proof self-contained without starting either
  // OpenMaus backend or claiming a public systemd socket.
  if (spawnSync("/usr/bin/python3", ["-c", "import socket; s=socket.create_connection(('127.0.0.1',8799),.25); s.close()"], {
    stdio: "ignore",
    timeout: 750,
  }).status !== 0) {
    temporaryHarness = createServer((socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      temporaryHarness.once("error", reject);
      temporaryHarness.listen(8799, "127.0.0.1", resolve);
    });
  }
  const dockerSocket = statSync("/run/docker.sock");
  if (!dockerSocket.isSocket() || dockerSocket.gid !== dockerGid || (dockerSocket.mode & 0o060) !== 0o060) {
    throw new Error("Docker socket is not restricted to its intended runtime group");
  }
  execFileSync("/usr/bin/systemd-run", [
    "--quiet",
    "--wait",
    "--pipe",
    "--collect",
    "--service-type=exec",
    `--unit=${dockerProbeUnit}`,
    "--uid=openmaus-server",
    "--gid=openmaus-runtime",
    "--property=SupplementaryGroups=openmaus-workspace docker",
    "--property=PrivateTmp=yes",
    "--property=ProtectSystem=strict",
    "--property=ProtectHome=yes",
    "--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    "--",
    "/usr/bin/docker", "info", "--format", "{{.ServerVersion}}",
  ], { stdio: "pipe" });
  mkdirSync(testDriverHome, { recursive: true, mode: 0o750 });
  mkdirSync(providerHome, { mode: 0o2750 });
  mkdirSync(siblingHome, { mode: 0o2750 });
  chownMode(testDriverHome, 0, runtimeGid, 0o750);
  chownMode(providerHome, provider.uid, runtimeGid, 0o2750);
  chownMode(siblingHome, provider.uid, runtimeGid, 0o2750);
  mkdirSync(testDriverState, { recursive: true, mode: 0o750 });
  mkdirSync(providerState, { mode: 0o750 });
  chownMode(testDriverState, 0, runtimeGid, 0o750);
  chownMode(providerState, 0, runtimeGid, 0o750);
  createBtrfsSubvolume(siblingPersistentState);
  chownMode(siblingPersistentState, provider.uid, runtimeGid, 0o700);
  writeFileSync(join(siblingPersistentState, "other-thread-token"), "must-not-be-visible", { mode: 0o600 });
  chownMode(join(siblingPersistentState, "other-thread-token"), provider.uid, runtimeGid, 0o600);
  writeFileSync(join(siblingHome, "other-instance-token"), "must-not-be-visible", { mode: 0o640 });
  chownMode(join(siblingHome, "other-instance-token"), provider.uid, runtimeGid, 0o640);

  mkdirSync(root, { recursive: true, mode: 0o2770 });
  mkdirSync(output, { mode: 0o2770 });
  chownMode(root, server.uid, workspaceGid, 0o2770);
  chownMode(output, server.uid, workspaceGid, 0o2770);
  for (const path of [scope, bombScope, bindsScope, declaredRuntime, policyRuntime, siblingRuntime]) {
    mkdirSync(path, { mode: 0o2750 });
    chownMode(path, server.uid, runtimeGid, 0o2750);
  }
  writeFileSync(join(declaredRuntime, "seed"), "declared", { mode: 0o640 });
  chownMode(join(declaredRuntime, "seed"), server.uid, runtimeGid, 0o640);
  writeFileSync(policyProof, "pending", { mode: 0o660 });
  chownMode(policyProof, server.uid, runtimeGid, 0o660);
  writeFileSync(join(siblingRuntime, "secret"), "sibling-secret", { mode: 0o640 });
  chownMode(join(siblingRuntime, "secret"), server.uid, runtimeGid, 0o640);
  writeFileSync(homeBaseline, "baseline", { mode: 0o640 });
  chownMode(homeBaseline, provider.uid, runtimeGid, 0o640);
  writeFileSync(stateSentinel, "server-secret", { mode: 0o600 });
  chownMode(stateSentinel, server.uid, runtimeGid, 0o600);

  writeFileSync(siblingFile, [
    'const fs = require("node:fs");',
    'const net = require("node:net");',
    'const [name, ready] = process.argv.slice(2);',
    'if (name && ready) {',
    '  const server = net.createServer((socket) => socket.end("sibling"));',
    '  server.listen({ path: `\\0${name}` }, () => fs.writeFileSync(ready, "ready"));',
    '}',
    'process.on("SIGTERM", () => {});',
    'setInterval(() => {}, 1000);',
  ].join("\n"), { mode: 0o550 });
  writeFileSync(childFile, [
    'const fs = require("node:fs");',
    'const line = fs.readFileSync("/proc/self/status", "utf8").split("\\n").find((v) => v.startsWith("NSpid:"));',
    'fs.appendFileSync(process.argv[2], `${line.trim().split(/\\s+/)[1]}\\n`);',
    '// A CPU bomb makes the cgroup throttle observable. Its blocked event',
    '// loop also behaves like a descendant that cannot process SIGTERM.',
    'for (;;) {}',
  ].join("\n"), { mode: 0o550 });
  writeFileSync(parentFile, [
    'const fs = require("node:fs");',
    'const { spawn, spawnSync } = require("node:child_process");',
    'const [pids, result, child, siblingPid, abstractName, runtimeBase, scope, declared, policy, policyProof, sibling, homeBaseline, homePrivate, siblingHome, sentinel] = process.argv.slice(2);',
    'const hostLine = fs.readFileSync("/proc/self/status", "utf8").split("\\n").find((v) => v.startsWith("NSpid:"));',
    'fs.appendFileSync(pids, `${hostLine.trim().split(/\\s+/)[1]}\\n`);',
    'spawn(process.execPath, [child, pids], { detached: true, stdio: "ignore" }).unref();',
    'const denied = (fn) => { try { fn(); return false; } catch { return true; } };',
    'const tcp = (host, port) => spawnSync("/usr/bin/python3", ["-c", `import socket; s=socket.create_connection((${JSON.stringify(host)},${port}),.75); s.close()`], { stdio: "ignore", timeout: 1500 }).status;',
    'const escapeLink = `${declared}/escape`;',
    'try { fs.unlinkSync(escapeLink); } catch {}',
    'fs.symlinkSync(`${sibling}/secret`, escapeLink);',
    'const checks = {',
    '  uidChanged: process.getuid() !== 0,',
    `  workspaceGid: process.getgid() === ${workspaceGid},`,
    `  dockerGroupAbsent: !fs.readFileSync("/proc/self/status", "utf8").split("\\n").find((line) => line.startsWith("Groups:"))?.trim().split(/\\s+/).slice(1).map(Number).includes(${dockerGid}),`,
    '  dockerControlDenied: spawnSync("/usr/bin/docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore", timeout: 2000 }).status !== 0,',
    '  intendedSecretArrived: process.env.PROVIDER_ONLY_SECRET === "turn-secret",',
    '  loaderControlEnvArrivedOnlyInsideSandbox: process.env.LD_PRELOAD?.endsWith("/hostile-loader.so") === true,',
    '  manifestEnvAbsent: process.env.OMB_PROVIDER_LAUNCH_MANIFEST === undefined,',
    '  controlTokenAbsent: process.env.OMB_UI_SESSION_TOKEN === undefined,',
    '  manifestFileHidden: !fs.existsSync(`${scope}/launch.json`),',
    '  siblingScopeHidden: !fs.existsSync(sibling),',
    '  siblingNameHidden: !fs.readdirSync(runtimeBase).includes(sibling.split("/").pop()),',
    '  serverStateHidden: denied(() => fs.readFileSync(sentinel)),',
    '  siblingProcHidden: denied(() => fs.readFileSync(`/proc/${siblingPid}/environ`)),',
    '  siblingSignalDenied: denied(() => process.kill(Number(siblingPid), 0)),',
    '  siblingAbstractSocketDenied: spawnSync("/usr/bin/python3", ["-c", `import socket; s=socket.socket(socket.AF_UNIX); s.settimeout(.5); s.connect("\\\\0${abstractName}")`], { stdio: "ignore", timeout: 1000 }).status !== 0,',
    '  dnsReachable: spawnSync("/usr/bin/python3", ["-c", "import socket; assert socket.getaddrinfo(\\\"example.com\\\", 443)"], { stdio: "ignore", timeout: 3000 }).status === 0,',
    '  harnessGatewayReachable: tcp("10.0.2.2", 8799) === 0,',
    '  otherHostLoopbackDenied: tcp("10.0.2.2", 8810) !== 0,',
    '  lanDenied: tcp("192.168.1.1", 443) !== 0,',
    '  tailscaleDenied: tcp("100.100.100.100", 443) !== 0,',
    '  ipv4MappedPrivateDenied: tcp("::ffff:100.100.100.100", 443) !== 0,',
    '  publicHttpsReachable: tcp("1.1.1.1", 443) === 0,',
    '  sparseFileBombDenied: spawnSync(process.execPath, ["-e", "const fs=require(\"node:fs\"); const p=process.env.HOME+\"/sparse-bomb\"; fs.writeFileSync(p,\"x\"); fs.truncateSync(p,9*1024**3)"], { stdio: "ignore", timeout: 1500 }).status !== 0,',
    '  siblingHomeHidden: !fs.existsSync(siblingHome),',
    '  symlinkEscapeDenied: denied(() => fs.readFileSync(escapeLink)),',
    '  mountRenameDenied: denied(() => fs.renameSync(declared, `${declared}-renamed`)),',
    '  declaredSeedVisible: fs.readFileSync(`${declared}/seed`, "utf8") === "declared",',
    '  policySiblingCreateDenied: denied(() => fs.writeFileSync(`${policy}/replace.py`, "bad")),',
    '};',
    'fs.writeFileSync(`${declared}/proof`, "provider-output", { mode: 0o640 });',
    'fs.writeFileSync(policyProof, "nonce-proof");',
    'fs.writeFileSync(homeBaseline, "private-change");',
    'fs.writeFileSync(homePrivate, "private-only");',
    'fs.writeFileSync(result, JSON.stringify(checks));',
    'process.on("SIGTERM", () => {});',
    'setInterval(() => {}, 1000);',
  ].join("\n"), { mode: 0o550 });
  writeFileSync(bombFile, [
    'const fs = require("node:fs");',
    'const [ready, trigger] = process.argv.slice(2);',
    'fs.writeFileSync(ready, "ready");',
    'const allocations = [];',
    'const timer = setInterval(() => {',
    '  if (!fs.existsSync(trigger)) return;',
    '  for (let i = 0; i < 2; i += 1) {',
    '    const chunk = Buffer.allocUnsafe(4 * 1024 * 1024);',
    '    chunk.fill(0xa5);',
    '    allocations.push(chunk);',
    '  }',
    '}, 20);',
    'timer.unref();',
    'setInterval(() => {}, 1000);',
  ].join("\n"), { mode: 0o550 });
  writeFileSync(aggregateBombFile, [
    'const fs = require("node:fs");',
    'const [ready, trigger] = process.argv.slice(2);',
    'fs.writeFileSync(ready, "ready");',
    'const allocations = [];',
    'setInterval(() => {',
    '  if (!fs.existsSync(trigger)) return;',
    '  const chunk = Buffer.allocUnsafe(4 * 1024 * 1024);',
    '  chunk.fill(0x5a);',
    '  allocations.push(chunk);',
    '}, 10);',
  ].join("\n"), { mode: 0o550 });
  writeFileSync(persistentWriterFile, [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const [relative, value, proof] = process.argv.slice(2);',
    'const target = path.join(process.env.HOME, relative);',
    'fs.mkdirSync(path.dirname(target), { recursive: true });',
    'fs.writeFileSync(target, value);',
    'fs.writeFileSync(proof, JSON.stringify({',
    '  home: process.env.HOME,',
    '  fileMode: fs.statSync(target).mode & 0o777,',
    '  dirMode: fs.statSync(path.dirname(target)).mode & 0o777,',
    '}));',
  ].join("\n"), { mode: 0o550 });
  writeFileSync(persistentReaderFile, [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const [relative, value, proof, siblingState, configExpected, authExpected] = process.argv.slice(2);',
    'const target = path.join(process.env.HOME, relative);',
    'const nextDirectory = path.join(process.env.HOME, "default-mode-directory");',
    'fs.mkdirSync(nextDirectory);',
    'const nextFile = path.join(nextDirectory, "second-turn");',
    'fs.writeFileSync(nextFile, "second");',
    'fs.writeFileSync(proof, JSON.stringify({',
    '  resumed: fs.readFileSync(target, "utf8") === value,',
    '  fileMode: fs.statSync(target).mode & 0o777,',
    '  dirMode: fs.statSync(path.dirname(target)).mode & 0o777,',
    '  secondFileMode: fs.statSync(nextFile).mode & 0o777,',
    '  secondDirMode: fs.statSync(nextDirectory).mode & 0o777,',
    '  siblingStateHidden: !fs.existsSync(siblingState),',
    '  configImportUpdated: !configExpected || fs.readFileSync(path.join(process.env.HOME, ".hermes/config.yaml"), "utf8") === configExpected,',
    '  authImportPreserved: !authExpected || fs.readFileSync(path.join(process.env.HOME, ".hermes/auth.json"), "utf8") === authExpected,',
    '}));',
  ].join("\n"), { mode: 0o550 });
  for (const path of [
    siblingFile,
    childFile,
    parentFile,
    bombFile,
    persistentWriterFile,
    persistentReaderFile,
  ]) {
    chownMode(path, server.uid, workspaceGid, 0o550);
  }
  writeFileSync(loaderSource, [
    "#include <fcntl.h>",
    "#include <unistd.h>",
    "__attribute__((constructor)) static void openmaus_probe(void) {",
    `  if (geteuid() == 0) { int fd = open(${JSON.stringify(loaderMarker)}, O_WRONLY|O_CREAT|O_TRUNC, 0600); if (fd >= 0) close(fd); }`,
    "}",
  ].join("\n"), { mode: 0o640 });
  chownMode(loaderSource, server.uid, workspaceGid, 0o640);
  execFileSync("/usr/bin/cc", ["-shared", "-fPIC", "-o", loaderSo, loaderSource]);
  chownMode(loaderSo, server.uid, runtimeGid, 0o640);

  sibling = spawn(process.execPath, [siblingFile, abstractSocketName, abstractSocketReady], {
    uid: provider.uid,
    gid: workspaceGid,
    detached: true,
    stdio: "ignore",
  });
  sibling.unref();
  if (!sibling.pid) throw new Error("failed to start hostile sibling probe");
  await waitFor(() => existsSync(abstractSocketReady), 2_000, "same-UID abstract socket did not become ready");
  if (!alive(sibling.pid)) throw new Error("same-UID sibling probe exited before sandbox start");

  execFileSync("/usr/bin/systemd-run", [
    "--quiet",
    "--collect",
    `--unit=${lifecycleParentUnit}`,
    "--property=Type=exec",
    "--property=User=openmaus-server",
    "--property=Group=openmaus-runtime",
    "--",
    "/usr/bin/sleep", "infinity",
  ]);
  await waitFor(() => unitActive(lifecycleParentUnit), 2_000, "stable lifecycle parent did not start");

  const manifestPath = join(scope, "launch.json");
  writeManifest(manifestPath, [
    { path: scope, writable: true },
    { path: declaredRuntime, writable: true },
    { path: policyRuntime, writable: false },
    { path: policyProof, writable: true },
  ], {
    PROVIDER_ONLY_SECRET: "turn-secret",
    LD_PRELOAD: loaderSo,
    OMB_UI_SESSION_TOKEN: "must-be-stripped",
  }, {
    limits: {
      memoryHigh: 3 * 1024 ** 3,
      memoryMax: 4 * 1024 ** 3,
      memorySwapMax: 0,
      cpuQuotaPercent: 50,
      tasksMax: 256,
    },
    parentUnit: lifecycleParentUnit,
  });

  startOuterUnit(unit, manifestPath, [
    process.execPath, parentFile, pidsFile, resultFile, childFile,
    String(sibling.pid), abstractSocketName, runtimeBase, scope, declaredRuntime, policyRuntime, policyProof, siblingRuntime,
    homeBaseline, homePrivate, siblingHome, stateSentinel,
  ]);

  const readyDeadline = Date.now() + 8_000;
  while (Date.now() < readyDeadline && (!existsSync(resultFile) || !existsSync(pidsFile))) await delay(25);
  if (!existsSync(resultFile)) throw new Error("systemd provider sandbox never produced its proof");
  let hostPids = [];
  while (Date.now() < readyDeadline) {
    hostPids = readFileSync(pidsFile, "utf8").trim().split("\n").filter(Boolean).map(Number);
    if (hostPids.length === 2) break;
    await delay(25);
  }
  if (hostPids.length !== 2) throw new Error(`expected provider and detached child, got ${hostPids.length}`);
  const checks = JSON.parse(readFileSync(resultFile, "utf8"));
  const failedChecks = Object.entries(checks).filter(([, ok]) => ok !== true).map(([name]) => name);
  if (failedChecks.length) throw new Error(`sandbox checks failed: ${failedChecks.join(", ")}`);
  if (existsSync(loaderMarker)) throw new Error("provider loader environment executed in a root helper");
  if (!alive(sibling.pid)) throw new Error("sandbox signaled the same-UID sibling process");

  const cgroup = cgroupPathFor(resourceUnit);
  if (unitProperty(resourceUnit, "Slice") !== providerSlice) {
    throw new Error("provider turn escaped the aggregate provider slice");
  }
  const [cpuQuota, cpuPeriod] = readFileSync(join(cgroup, "cpu.max"), "utf8").trim().split(/\s+/).map(Number);
  if (cpuQuota / cpuPeriod !== 0.5) throw new Error(`unexpected CPU cgroup limit: ${cpuQuota}/${cpuPeriod}`);
  if (readFileSync(join(cgroup, "memory.max"), "utf8").trim() !== String(4 * 1024 ** 3)) {
    throw new Error("provider MemoryMax did not reach its per-turn cgroup");
  }
  if (readFileSync(join(cgroup, "memory.swap.max"), "utf8").trim() !== "0") {
    throw new Error("provider MemorySwapMax did not reach its per-turn cgroup");
  }
  if (readFileSync(join(cgroup, "pids.max"), "utf8").trim() !== "256") {
    throw new Error("provider TasksMax did not reach its per-turn cgroup");
  }
  if (unitProperty(resourceUnit, "LimitCORE") !== "0") {
    throw new Error("provider core dumps were not disabled in the transient unit");
  }
  const cpuBefore = readKeyValues(join(cgroup, "cpu.stat"));
  const cpuWallStarted = Date.now();
  await delay(1_200);
  const cpuWallMicros = (Date.now() - cpuWallStarted) * 1_000;
  const cpuAfter = readKeyValues(join(cgroup, "cpu.stat"));
  const cpuUsageMicros = cpuAfter.usage_usec - cpuBefore.usage_usec;
  if (cpuAfter.nr_throttled <= cpuBefore.nr_throttled || cpuUsageMicros <= 0 || cpuUsageMicros > cpuWallMicros * 0.75) {
    throw new Error(`CPU bomb escaped quota: usage=${cpuUsageMicros}us wall=${cpuWallMicros}us`);
  }

  let supervisorPid = null;
  await waitFor(() => {
    supervisorPid = supervisorPidFor(unit);
    return supervisorPid !== null;
  }, 2_000, "root provider supervisor was not present in the harness cgroup");
  const supervisorArgv = readFileSync(`/proc/${supervisorPid}/cmdline`, "utf8").split("\0").filter(Boolean);
  const supervisorExecutable = readlinkSync(`/proc/${supervisorPid}/exe`);
  const resourcePidsBeforeSignal = readFileSync(join(cgroup, "cgroup.procs"), "utf8").trim().split("\n").filter(Boolean);
  const started = Date.now();
  process.kill(supervisorPid, "SIGTERM");
  await waitFor(() => !unitActive(unit), 5_000, "provider supervisor did not finish its bounded TERM/KILL drain", 25);
  const elapsedMs = Date.now() - started;
  if (elapsedMs < 700 || elapsedMs > 3_000) {
    throw new Error(`unexpected escalation time ${elapsedMs}ms: ${JSON.stringify({
      supervisorPid,
      supervisorArgv,
      supervisorExecutable,
      resourcePidsBeforeSignal,
    })}`);
  }
  const leaks = hostPids.filter(alive);
  if (leaks.length) throw new Error(`provider descendants survived: ${leaks.join(",")}`);
  if (readFileSync(homeBaseline, "utf8") !== "baseline" || existsSync(homePrivate)) {
    throw new Error("per-turn provider HOME writes escaped the private tmpfs copy");
  }
  if (statSync(declaredRuntime).uid !== server.uid || statSync(join(declaredRuntime, "proof")).uid !== server.uid) {
    throw new Error("runtime ownership was not restored after reaping");
  }
  if (readFileSync(policyProof, "utf8") !== "nonce-proof" || statSync(policyProof).uid !== server.uid) {
    throw new Error("exact nested proof write or ownership restoration failed");
  }

  // Universal per-instance + per-bot persistent HOME views preserve every
  // harness's native disk continuation without exposing a sibling bot.
  // Exercise the actual paths used by Pi, Claude and generic ACP in
  // two separate provider processes, with systemd/bwrap teardown in between.
  const persistenceCases = [
    { label: "pi", relative: ".omp/agent/sessions/openmaus.json" },
    { label: "claude", relative: ".claude/projects/workspace/session.jsonl" },
    { label: "acp", relative: ".generic-acp/sessions/session.json" },
    { label: "hermes", relative: ".hermes/session-state.db", imports: true },
  ];
  const persistenceResults = {};
  for (const persistence of persistenceCases) {
    const key = createHash("sha256")
      .update(`persistent\0${persistence.label}\0${suffix}`)
      .digest("hex")
      .slice(0, 48);
    const firstScope = join(runtimeBase, `spawn-persist-${persistence.label}-a-${suffix}`);
    const secondScope = join(runtimeBase, `spawn-persist-${persistence.label}-b-${suffix}`);
    const firstUnit = `openmaus-persist-${persistence.label}-a-${process.pid}.service`;
    const secondUnit = `openmaus-persist-${persistence.label}-b-${process.pid}.service`;
    const firstProof = join(output, `${persistence.label}-first.json`);
    const secondProof = join(output, `${persistence.label}-second.json`);
    const expectedValue = `${persistence.label}-cursor-${suffix}`;
    let firstImports = [];
    let secondImports = [];
    let importConfigExpected;
    let importAuthExpected;
    if (persistence.imports) {
      const configOne = join(runtimeBase, `hermes-config-one-${suffix}`);
      const configTwo = join(runtimeBase, `hermes-config-two-${suffix}`);
      const authOne = join(runtimeBase, `hermes-auth-one-${suffix}`);
      const authTwo = join(runtimeBase, `hermes-auth-two-${suffix}`);
      for (const [path, value] of [
        [configOne, "model: first\n"], [configTwo, "model: second\n"],
        [authOne, "auth-first\n"], [authTwo, "auth-second-must-not-replace\n"],
      ]) {
        writeFileSync(path, value, { mode: 0o640 });
        chownMode(path, server.uid, runtimeGid, 0o640);
      }
      firstImports = [
        { source: configOne, destination: ".hermes/config.yaml", replace: true },
        { source: authOne, destination: ".hermes/auth.json", replace: false },
      ];
      secondImports = [
        { source: configTwo, destination: ".hermes/config.yaml", replace: true },
        { source: authTwo, destination: ".hermes/auth.json", replace: false },
      ];
      importConfigExpected = "model: second\n";
      importAuthExpected = "auth-first\n";
    }
    for (const persistentScope of [firstScope, secondScope]) {
      mkdirSync(persistentScope, { mode: 0o2750 });
      chownMode(persistentScope, server.uid, runtimeGid, 0o2750);
    }
    const firstManifest = join(firstScope, "launch.json");
    writeManifest(firstManifest, [{ path: firstScope, writable: true }], {}, {
      parentUnit: firstUnit,
      persistentHomeKey: key,
      homeImports: firstImports,
    });
    startOuterUnit(firstUnit, firstManifest, [
      process.execPath,
      persistentWriterFile,
      persistence.relative,
      expectedValue,
      firstProof,
    ]);
    await waitFor(() => existsSync(firstProof), 8_000, `${persistence.label} first persistent turn did not finish`);
    await waitFor(() => !unitActive(firstUnit), 8_000, `${persistence.label} first persistent unit stayed active`);
    const firstResult = JSON.parse(readFileSync(firstProof, "utf8"));
    if (firstResult.fileMode !== 0o600 || firstResult.dirMode !== 0o700) {
      throw new Error(`${persistence.label} persistent HOME did not inherit UMask=0077`);
    }
    const stateHome = join(providerState, key);
    createdSubvolumes.add(stateHome);
    if (!existsSync(join(stateHome, persistence.relative))) {
      throw new Error(`${persistence.label} state was not durable after process exit`);
    }

    const secondManifest = join(secondScope, "launch.json");
    writeManifest(secondManifest, [{ path: secondScope, writable: true }], {}, {
      parentUnit: secondUnit,
      persistentHomeKey: key,
      homeImports: secondImports,
    });
    startOuterUnit(secondUnit, secondManifest, [
      process.execPath,
      persistentReaderFile,
      persistence.relative,
      expectedValue,
      secondProof,
      siblingPersistentState,
      ...(importConfigExpected ? [importConfigExpected, importAuthExpected] : []),
    ]);
    await waitFor(() => existsSync(secondProof), 8_000, `${persistence.label} second persistent turn did not finish`);
    await waitFor(() => !unitActive(secondUnit), 8_000, `${persistence.label} second persistent unit stayed active`);
    const secondResult = JSON.parse(readFileSync(secondProof, "utf8"));
    const failedPersistenceChecks = Object.entries(secondResult)
      .filter(([name, value]) => name.endsWith("Mode")
        ? value !== (name.toLowerCase().includes("dir") ? 0o700 : 0o600)
        : value !== true)
      .map(([name]) => name);
    if (failedPersistenceChecks.length) {
      throw new Error(`${persistence.label} persistent checks failed: ${failedPersistenceChecks.join(", ")}`);
    }
    persistenceResults[persistence.label] = true;
    for (const finishedUnit of [firstUnit, secondUnit]) {
      try { execFileSync("systemctl", ["reset-failed", finishedUnit], { stdio: "ignore" }); } catch {}
    }
  }

  // Bot deletion retires the same owner hash across every provisioned
  // instance. An active per-bot flock must fail closed; after process proof,
  // the exact subvolume is deleted and can be cleanly recreated.
  const retirementKey = createHash("sha256").update("owner\0retirement-bot").digest("hex").slice(0, 48);
  const retirementHome = join(providerState, retirementKey);
  const retirementTurnScope = join(runtimeBase, `spawn-retirement-active-${suffix}`);
  mkdirSync(retirementTurnScope, { mode: 0o2750 });
  chownMode(retirementTurnScope, server.uid, runtimeGid, 0o2750);
  const retirementTurnManifest = join(retirementTurnScope, "launch.json");
  writeManifest(retirementTurnManifest, [{ path: retirementTurnScope, writable: true }], {}, {
    parentUnit: retirementOuterUnit,
    persistentHomeKey: retirementKey,
  });
  startOuterUnit(retirementOuterUnit, retirementTurnManifest, [process.execPath, siblingFile]);
  await waitFor(() => existsSync(retirementHome), 8_000, "active retirement fixture HOME was not created");
  createdSubvolumes.add(retirementHome);
  const activeRetireScope = join(runtimeBase, `spawn-retire-active-${suffix}`);
  mkdirSync(activeRetireScope, { mode: 0o2750 });
  chownMode(activeRetireScope, server.uid, runtimeGid, 0o2750);
  const activeRetireManifest = join(activeRetireScope, "launch.json");
  writeRetireManifest(activeRetireManifest, retirementKey);
  const activeRetirement = invokeRetirement(activeRetireManifest);
  if (activeRetirement.status !== 69 || !existsSync(retirementHome)) {
    throw new Error(`active provider HOME retirement was not refused: status ${activeRetirement.status}`);
  }
  execFileSync("systemctl", ["stop", retirementOuterUnit], { stdio: "ignore" });
  await waitFor(() => !unitActive(retirementOuterUnit), 8_000, "active retirement fixture did not stop");
  const stoppedRetireScope = join(runtimeBase, `spawn-retire-stopped-${suffix}`);
  mkdirSync(stoppedRetireScope, { mode: 0o2750 });
  chownMode(stoppedRetireScope, server.uid, runtimeGid, 0o2750);
  const stoppedRetireManifest = join(stoppedRetireScope, "launch.json");
  writeRetireManifest(stoppedRetireManifest, retirementKey);
  const stoppedRetirement = invokeRetirement(stoppedRetireManifest);
  if (stoppedRetirement.status !== 0 || existsSync(retirementHome)) {
    throw new Error(`stopped provider HOME retirement failed: status ${stoppedRetirement.status}`);
  }
  const recreateScope = join(runtimeBase, `spawn-retire-recreate-${suffix}`);
  const recreateProof = join(output, "retirement-recreate.json");
  mkdirSync(recreateScope, { mode: 0o2750 });
  chownMode(recreateScope, server.uid, runtimeGid, 0o2750);
  const recreateManifest = join(recreateScope, "launch.json");
  writeManifest(recreateManifest, [{ path: recreateScope, writable: true }], {}, {
    parentUnit: recreateUnit,
    persistentHomeKey: retirementKey,
  });
  startOuterUnit(recreateUnit, recreateManifest, [
    process.execPath, persistentWriterFile, ".recreated/session", "fresh", recreateProof,
  ]);
  await waitFor(() => existsSync(recreateProof), 8_000, "retired provider HOME was not recreated");
  await waitFor(() => !unitActive(recreateUnit), 8_000, "recreated provider HOME stayed active");
  createdSubvolumes.add(retirementHome);

  // A malformed/sparse bot HOME is isolated to that owner. Aggregate usage
  // comes from qgroups, so it cannot poison a healthy sibling's launch.
  const poisonedKey = createHash("sha256").update(`poisoned\0${suffix}`).digest("hex").slice(0, 48);
  const poisonedHome = join(providerState, poisonedKey);
  createBtrfsSubvolume(poisonedHome);
  chownMode(poisonedHome, provider.uid, runtimeGid, 0o700);
  execFileSync("/usr/bin/truncate", ["-s", "9G", join(poisonedHome, "sparse")]);
  execFileSync("/usr/bin/mkfifo", [join(poisonedHome, "fifo")]);
  execFileSync("/usr/bin/python3", ["-c", `import socket; s=socket.socket(socket.AF_UNIX); s.bind(${JSON.stringify(join(poisonedHome, "socket"))}); s.close()`]);
  symlinkSync("sparse", join(poisonedHome, "link"));
  const poisonedScope = join(runtimeBase, `spawn-poisoned-${suffix}`);
  mkdirSync(poisonedScope, { mode: 0o2750 });
  chownMode(poisonedScope, server.uid, runtimeGid, 0o2750);
  const poisonedManifest = join(poisonedScope, "launch.json");
  writeManifest(poisonedManifest, [{ path: poisonedScope, writable: true }], {}, {
    parentUnit: lifecycleParentUnit,
    persistentHomeKey: poisonedKey,
  });
  const poisonedLaunch = spawnSync("/usr/bin/sudo", [
    "-n", "-u", "openmaus-server", "--",
    "/usr/bin/env", `OMB_PROVIDER_LAUNCH_MANIFEST=${poisonedManifest}`,
    launcher, "--", "/usr/bin/true",
  ], { cwd: root, encoding: "utf8" });
  if (poisonedLaunch.status !== 69) {
    throw new Error(`malformed owner HOME was not quarantined to itself: status ${poisonedLaunch.status}`);
  }
  const healthyKey = createHash("sha256").update(`healthy-after-poison\0${suffix}`).digest("hex").slice(0, 48);
  const healthyScope = join(runtimeBase, `spawn-healthy-${suffix}`);
  mkdirSync(healthyScope, { mode: 0o2750 });
  chownMode(healthyScope, server.uid, runtimeGid, 0o2750);
  const healthyManifest = join(healthyScope, "launch.json");
  writeManifest(healthyManifest, [{ path: healthyScope, writable: true }], {}, {
    parentUnit: lifecycleParentUnit,
    persistentHomeKey: healthyKey,
  });
  const healthyLaunch = spawnSync("/usr/bin/sudo", [
    "-n", "-u", "openmaus-server", "--",
    "/usr/bin/env", `OMB_PROVIDER_LAUNCH_MANIFEST=${healthyManifest}`,
    launcher, "--", "/usr/bin/true",
  ], { cwd: root, encoding: "utf8" });
  if (healthyLaunch.status !== 0) {
    throw new Error(`malformed sibling HOME blocked healthy owner: status ${healthyLaunch.status}`);
  }
  createdSubvolumes.add(join(providerState, healthyKey));

  // A second real transient turn deliberately exceeds a small MemoryMax.
  // The kernel must record a cgroup OOM kill, collect the whole turn, and
  // leave this root test/server process alive outside the bounded cgroup.
  const bombManifest = join(bombScope, "launch.json");
  writeManifest(bombManifest, [{ path: bombScope, writable: true }], {}, {
    parentUnit: bombUnit,
    limits: {
      memoryHigh: 64 * 1024 ** 2,
      memoryMax: 128 * 1024 ** 2,
      memorySwapMax: 0,
      cpuQuotaPercent: 100,
      tasksMax: 64,
    },
  });
  startOuterUnit(bombUnit, bombManifest, [process.execPath, bombFile, bombReady, bombTrigger]);
  await waitFor(() => existsSync(bombReady), 8_000, "memory bomb provider never became ready", 25);
  const bombCgroup = cgroupPathFor(bombResourceUnit);
  if (readFileSync(join(bombCgroup, "memory.max"), "utf8").trim() !== String(128 * 1024 ** 2)) {
    throw new Error("memory bomb did not receive the 128 MiB per-turn limit");
  }
  const memoryBefore = readKeyValues(join(bombCgroup, "memory.events"));
  writeFileSync(bombTrigger, "allocate");
  let observedOomKills = 0;
  const bombDeadline = Date.now() + 15_000;
  while (Date.now() < bombDeadline) {
    try {
      const events = readKeyValues(join(bombCgroup, "memory.events"));
      observedOomKills = Math.max(observedOomKills, events.oom_kill - memoryBefore.oom_kill);
    } catch {
      // The transient cgroup is removed immediately after the killed turn.
    }
    if (!unitActive(bombUnit)) break;
    await delay(10);
  }
  if (observedOomKills < 1) throw new Error("memory bomb exited without a kernel cgroup OOM kill");
  if (unitActive(bombUnit)) throw new Error("memory-bomb turn did not terminate after OOM");
  if (existsSync(bombCgroup)) {
    const remaining = readFileSync(join(bombCgroup, "cgroup.procs"), "utf8").trim();
    if (remaining) throw new Error(`memory-bomb cgroup leaked PIDs: ${remaining}`);
  }

  // Prove that a parent slice ceiling constrains the sum of simultaneous
  // children. This unique transient test slice is a child of the exact
  // production provider slice, so the proof never lowers the live 16 GiB
  // production ceiling or risks the trusted server/test process.
  execFileSync("/usr/bin/systemctl", ["start", aggregateSlice], { stdio: "ignore" });
  execFileSync("/usr/bin/systemctl", [
    "set-property", "--runtime", aggregateSlice,
    `MemoryHigh=${128 * 1024 ** 2}`,
    `MemoryMax=${192 * 1024 ** 2}`,
    "MemorySwapMax=0",
    "TasksMax=64",
  ], { stdio: "ignore" });
  const aggregateCgroup = cgroupPathFor(aggregateSlice);
  if (!unitProperty(aggregateSlice, "ControlGroup").startsWith(`/${providerSlice}/`)) {
    throw new Error("aggregate pressure fixture escaped the production provider slice");
  }
  if (readFileSync(join(aggregateCgroup, "memory.max"), "utf8").trim() !== String(192 * 1024 ** 2)) {
    throw new Error("aggregate pressure fixture did not load its exact kernel ceiling");
  }
  startAggregateBomb(aggregateBombA, aggregateReadyA, aggregateTriggerA);
  startAggregateBomb(aggregateBombB, aggregateReadyB, aggregateTriggerB);
  await waitFor(
    () => existsSync(aggregateReadyA) && existsSync(aggregateReadyB),
    5_000,
    "simultaneous aggregate pressure children did not become ready",
  );
  const aggregateBefore = readKeyValues(join(aggregateCgroup, "memory.events"));
  writeFileSync(aggregateTriggerA, "allocate");
  writeFileSync(aggregateTriggerB, "allocate");
  const aggregateDeadline = Date.now() + 15_000;
  while (Date.now() < aggregateDeadline) {
    const aggregateEvents = readKeyValues(join(aggregateCgroup, "memory.events"));
    aggregateOomKills = Math.max(aggregateOomKills, aggregateEvents.oom_kill - aggregateBefore.oom_kill);
    if (aggregateOomKills > 0) break;
    await delay(10);
  }
  if (aggregateOomKills < 1) {
    throw new Error("simultaneous provider children escaped their aggregate memory ceiling");
  }
  execFileSync("/usr/bin/systemctl", ["stop", aggregateBombA, aggregateBombB], { stdio: "ignore" });

  // A pre-existing symlink is rejected before target exec, even when the
  // hostile path was named in a trusted manifest.
  const badScope = join(runtimeBase, `spawn-bad-${suffix}`);
  const badRuntime = join(runtimeBase, `bad-${suffix}`);
  mkdirSync(badScope, { mode: 0o2750 });
  mkdirSync(badRuntime, { mode: 0o2750 });
  chownMode(badScope, server.uid, runtimeGid, 0o2750);
  chownMode(badRuntime, server.uid, runtimeGid, 0o2750);
  symlinkSync(stateSentinel, join(badRuntime, "escape"));
  const badManifest = join(badScope, "launch.json");
  writeManifest(badManifest, [
    { path: badScope, writable: true },
    { path: badRuntime, writable: false },
  ]);
  const rejected = spawnSync("/usr/bin/sudo", [
    "-n", "-u", "openmaus-server", "--",
    "/usr/bin/env", `OMB_PROVIDER_LAUNCH_MANIFEST=${badManifest}`,
    launcher, "--", "/usr/bin/true",
  ], { cwd: root, encoding: "utf8" });
  if (rejected.status !== 69) throw new Error(`symlink manifest was not rejected: status ${rejected.status}`);

  // Root-owned instance metadata caps the number of durable per-bot homes.
  // A provider cannot choose the host path, remove siblings or create the
  // 65th home by sending a fresh bot identity.
  let existingHomes = readdirSync(providerState)
    .filter((name) => /^[0-9a-f]{48}$/.test(name) && statSync(join(providerState, name)).isDirectory());
  for (let index = existingHomes.length; index < 64; index += 1) {
    const name = createHash("sha256").update(`cap-home\0${suffix}\0${index}`).digest("hex").slice(0, 48);
    const path = join(providerState, name);
    createBtrfsSubvolume(path);
    chownMode(path, provider.uid, runtimeGid, 0o700);
  }
  existingHomes = readdirSync(providerState)
    .filter((name) => /^[0-9a-f]{48}$/.test(name) && statSync(join(providerState, name)).isDirectory());
  if (existingHomes.length !== 64) throw new Error(`persistent-home cap fixture has ${existingHomes.length} homes`);
  const cappedKey = createHash("sha256").update(`cap-rejected\0${suffix}`).digest("hex").slice(0, 48);
  const capScope = join(runtimeBase, `spawn-cap-${suffix}`);
  mkdirSync(capScope, { mode: 0o2750 });
  chownMode(capScope, server.uid, runtimeGid, 0o2750);
  const capManifest = join(capScope, "launch.json");
  writeManifest(capManifest, [{ path: capScope, writable: true }], {}, { persistentHomeKey: cappedKey });
  const capRejected = spawnSync("/usr/bin/sudo", [
    "-n", "-u", "openmaus-server", "--",
    "/usr/bin/env", `OMB_PROVIDER_LAUNCH_MANIFEST=${capManifest}`,
    launcher, "--", "/usr/bin/true",
  ], { cwd: root, encoding: "utf8" });
  if (capRejected.status !== 69 || existsSync(join(providerState, cappedKey))) {
    throw new Error(`persistent-home count cap was not fail-closed: status ${capRejected.status}`);
  }

  // The real transient unit must die when its trusted parent stops, even when
  // the provider process ignores TERM. This proves the BindsTo lifecycle,
  // one-second systemd KILL escalation, root supervisor reap, and empty cgroup
  // together instead of merely inspecting the generated command line.
  const bindsManifest = join(bindsScope, "launch.json");
  writeManifest(bindsManifest, [{ path: bindsScope, writable: true }], {}, {
    parentUnit: lifecycleParentUnit,
  });
  startOuterUnit(bindsOuterUnit, bindsManifest, [
    process.execPath,
    "-e",
    'const fs=require("node:fs");fs.writeFileSync(process.argv[1],String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',
    bindsReady,
  ]);
  await waitFor(() => existsSync(bindsReady), 8_000, "BindsTo provider did not become ready", 25);
  if (!unitProperty(bindsResourceUnit, "BindsTo").split(/\s+/).includes(lifecycleParentUnit)) {
    throw new Error("provider transient unit omitted its exact parent BindsTo");
  }
  const bindsPid = Number(readFileSync(bindsReady, "utf8"));
  if (!Number.isSafeInteger(bindsPid) || !alive(bindsPid)) throw new Error("BindsTo fixture PID is invalid");
  execFileSync("/usr/bin/systemctl", ["stop", lifecycleParentUnit], { stdio: "ignore" });
  await waitFor(
    () => !unitActive(bindsResourceUnit) && !unitActive(bindsOuterUnit),
    5_000,
    "stopping the trusted parent did not collect its provider tree",
    25,
  );
  if (alive(bindsPid)) throw new Error("BindsTo provider survived trusted parent stop");

  console.log(JSON.stringify({
    ok: true,
    systemd: true,
    bwrap: true,
    elapsedMs,
    cpuQuotaPercent: 50,
    cpuUsageMicros,
    cpuThrottles: cpuAfter.nr_throttled - cpuBefore.nr_throttled,
    memoryMaxBytes: 128 * 1024 ** 2,
    memoryOomKills: observedOomKills,
    aggregateMemoryOomKills: aggregateOomKills,
    parentStopReaped: true,
    persistentTwoTurn: persistenceResults,
    persistentHomeLimit: 64,
    trustedServerDocker: true,
    descendants: hostPids.length,
    leaks: 0,
    siblingPidIsolated: sibling.pid,
    checks,
  }));
} finally {
  if (temporaryHarness) {
    await new Promise((resolve) => temporaryHarness.close(resolve));
  }
  try { execFileSync("systemctl", ["stop", unit], { stdio: "ignore" }); } catch {}
  try { execFileSync("systemctl", ["stop", bombUnit], { stdio: "ignore" }); } catch {}
  try { execFileSync("systemctl", ["stop", aggregateBombA, aggregateBombB], { stdio: "ignore" }); } catch {}
  try { execFileSync("systemctl", ["stop", aggregateSlice], { stdio: "ignore" }); } catch {}
  try { execFileSync("systemctl", ["revert", aggregateSlice], { stdio: "ignore" }); } catch {}
  try { execFileSync("systemctl", ["stop", dockerProbeUnit], { stdio: "ignore" }); } catch {}
  try { execFileSync("systemctl", ["stop", lifecycleParentUnit], { stdio: "ignore" }); } catch {}
  try { execFileSync("systemctl", ["stop", retirementOuterUnit], { stdio: "ignore" }); } catch {}
  try { execFileSync("systemctl", ["stop", recreateUnit], { stdio: "ignore" }); } catch {}
  try { execFileSync("systemctl", ["stop", bindsOuterUnit], { stdio: "ignore" }); } catch {}
  try { execFileSync("systemctl", ["reset-failed", unit], { stdio: "ignore" }); } catch {}
  try { execFileSync("systemctl", ["reset-failed", bombUnit], { stdio: "ignore" }); } catch {}
  try { execFileSync("systemctl", ["reset-failed", aggregateBombA, aggregateBombB, aggregateSlice], { stdio: "ignore" }); } catch {}
  try { execFileSync("systemctl", ["reset-failed", dockerProbeUnit], { stdio: "ignore" }); } catch {}
  try { execFileSync("systemctl", ["reset-failed", lifecycleParentUnit], { stdio: "ignore" }); } catch {}
  try { execFileSync("systemctl", ["reset-failed", retirementOuterUnit], { stdio: "ignore" }); } catch {}
  try { execFileSync("systemctl", ["reset-failed", recreateUnit], { stdio: "ignore" }); } catch {}
  try { execFileSync("systemctl", ["reset-failed", bindsOuterUnit, bindsResourceUnit], { stdio: "ignore" }); } catch {}
  if (sibling?.pid) {
    try { process.kill(-sibling.pid, "SIGKILL"); } catch {}
  }
  for (const path of [root, scope, bombScope, bindsScope, declaredRuntime, policyRuntime, siblingRuntime]) {
    rmSync(path, { recursive: true, force: true });
  }
  for (const path of [homeBaseline, homePrivate, stateSentinel, loaderMarker]) rmSync(path, { force: true });
  rmSync(testDriverHome, { recursive: true, force: true });
  for (const path of [...createdSubvolumes].sort((left, right) => right.length - left.length)) {
    if (!existsSync(path)) continue;
    try { execFileSync("/usr/bin/btrfs", ["subvolume", "delete", path], { stdio: "ignore" }); } catch {}
  }
  rmSync(testDriverState, { recursive: true, force: true });
  for (const name of readdirSync(runtimeBase)) {
    if (name.includes(suffix)) rmSync(join(runtimeBase, name), { recursive: true, force: true });
  }
  if (temporaryStateMount) {
    try { execFileSync("/usr/bin/umount", [providerStateRoot], { stdio: "ignore" }); } catch {}
    rmSync(stateImage, { force: true });
    chownMode(providerStateRoot, 0, runtimeGid, 0o750);
  }
  if (temporaryRuntimeBase && existsSync(runtimeBase) && readdirSync(runtimeBase).length === 0) {
    rmdirSync(runtimeBase);
  }
}
