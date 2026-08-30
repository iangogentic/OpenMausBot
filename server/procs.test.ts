import { EventEmitter, once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { findCliCandidates } from "./env-path.ts";

import {
  prepareProviderSandboxEnvironment,
  resolveProviderSpawn,
  spawnCli,
  terminateCliTree,
} from "./procs.ts";

describe("provider OS identity boundary", () => {
  it("fails closed when a deployment requires isolation without a trusted launcher", () => {
    expect(() => resolveProviderSpawn(
      { command: "/usr/bin/provider", args: ["run"] },
      { OMB_REQUIRE_PROVIDER_ISOLATION: "1" },
    )).toThrow("provider OS isolation is required");
  });

  it("does not alter ordinary local-development spawns", () => {
    expect(resolveProviderSpawn(
      { command: "/usr/bin/provider", args: ["run"] },
      {},
    )).toEqual({ command: "/usr/bin/provider", args: ["run"] });
  });

  it.runIf(process.platform !== "win32")("wraps argv without a shell only through a trusted root-owned launcher", () => {
    expect(resolveProviderSpawn(
      { command: "/usr/bin/provider", args: ["--prompt", "$(id)", "two words"] },
      { OMB_PROVIDER_LAUNCHER: "/usr/bin/env", OMB_REQUIRE_PROVIDER_ISOLATION: "1" },
    )).toEqual({
      command: "/usr/bin/env",
      args: ["--", "/usr/bin/provider", "--prompt", "$(id)", "two words"],
    });
  });

  it.runIf(process.platform !== "win32")("resolves a PATH command before crossing the absolute-only launcher boundary", () => {
    const node = findCliCandidates("node")[0]!;
    expect(resolveProviderSpawn(
      { command: "node", args: ["--version"] },
      { OMB_PROVIDER_LAUNCHER: "/usr/bin/env", OMB_REQUIRE_PROVIDER_ISOLATION: "1" },
    )).toEqual({ command: "/usr/bin/env", args: ["--", node, "--version"] });
  });

  it.runIf(process.platform !== "win32")("rejects relative, missing, and writable launcher paths", () => {
    expect(() => resolveProviderSpawn(
      { command: "/usr/bin/provider", args: [] },
      { OMB_PROVIDER_LAUNCHER: "launcher" },
    )).toThrow("path is invalid");
    expect(() => resolveProviderSpawn(
      { command: "/usr/bin/provider", args: [] },
      { OMB_PROVIDER_LAUNCHER: "/definitely/not/an/openmaus-launcher" },
    )).toThrow("root-owned, executable, non-writable");
  });

  it("ignores launcher controls injected only into the provider child environment", async () => {
    const child = spawnCli(process.execPath, ["-e", "process.stdout.write('isolated-selection\\n')"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OMB_PROVIDER_LAUNCHER: "/provider-controlled/launcher",
        OMB_REQUIRE_PROVIDER_ISOLATION: "1",
      },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    const [code] = await once(child, "close");
    expect(code).toBe(0);
    expect(stdout).toBe("isolated-selection\n");
  });

  it.runIf(process.platform !== "win32")("creates a unique trusted sandbox manifest and replaces injected internals", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-provider-sandbox-"));
    try {
      const runtime = join(root, "runtime");
      const providerRoot = join(root, "provider-home");
      const providerHome = join(providerRoot, "instances", "driver", "instance");
      const providerStateRoot = join(providerRoot, "state");
      const providerState = join(providerStateRoot, "driver", "instance");
      const exact = join(runtime, "turn-existing");
      const importFile = join(runtime, "hermes-config.yaml");
      mkdirSync(exact, { recursive: true, mode: 0o2750 });
      mkdirSync(providerHome, { recursive: true, mode: 0o2750 });
      mkdirSync(providerState, { recursive: true, mode: 0o750 });
      chmodSync(runtime, 0o2750);
      chmodSync(exact, 0o2750);
      chmodSync(providerHome, 0o2750);
      chmodSync(providerStateRoot, 0o750);
      chmodSync(providerState, 0o750);
      writeFileSync(importFile, "model: local\n", { mode: 0o640 });
      const canonicalRuntime = realpathSync(runtime);
      const canonicalHome = realpathSync(providerHome);
      const canonicalExact = realpathSync(exact);
      const prepared = prepareProviderSandboxEnvironment(
        {
          OMB_PROVIDER_TURN_DIR: "/attacker/scope",
          OMB_PROVIDER_SANDBOX_PATHS: '[{"path":"/attacker"}]',
          OMB_PROVIDER_LAUNCH_MANIFEST: "/attacker/launch.json",
          OMB_PROVIDER_HOME: "/attacker/home",
          OMB_PROVIDER_RUNTIME_DIR: "/attacker/runtime",
          OMB_PROVIDER_INSTANCE_HOME: canonicalHome,
          OMB_PROVIDER_INSTANCE_STATE: realpathSync(providerState),
          OMB_PROVIDER_MEMORY_MAX_BYTES: "attacker-limit",
          OMB_PROVIDER_PARENT_UNIT: "attacker.service",
          PROVIDER_ONLY_SECRET: "turn-secret",
        },
        [{ path: exact, writable: false }],
        {
          OMB_PROVIDER_RUNTIME_DIR: canonicalRuntime,
          OMB_PROVIDER_HOME: realpathSync(providerRoot),
          OMB_PROVIDER_STATE_DIR: realpathSync(providerStateRoot),
        },
        { ownerKey: "bot-one" },
        [{ source: importFile, destination: ".hermes/config.yaml", replace: true }],
      );
      expect(prepared.scopePath.startsWith(`${canonicalRuntime}/spawn-`)).toBe(true);
      expect(statSync(prepared.scopePath).mode & 0o7777).toBe(0o2750);
      expect(prepared.environment).toEqual({
        PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
        OMB_PROVIDER_LAUNCH_MANIFEST: prepared.manifestPath,
      });
      expect(statSync(prepared.manifestPath).mode & 0o777).toBe(0o600);
      const manifest = JSON.parse(readFileSync(prepared.manifestPath, "utf8"));
      expect(manifest.providerRoot).toBe(realpathSync(providerRoot));
      expect(manifest.providerHome).toBe(canonicalHome);
      expect(manifest.providerStateRoot).toBe(realpathSync(providerStateRoot));
      expect(manifest.providerState).toBe(realpathSync(providerState));
      expect(manifest.persistentHomeKey).toMatch(/^[0-9a-f]{48}$/);
      expect(manifest.runtimeBase).toBe(canonicalRuntime);
      expect(manifest.turnDirectory).toBe(prepared.scopePath);
      expect(manifest.environment).toMatchObject({
        OMB_PROVIDER_HOME: realpathSync(providerRoot),
        OMB_PROVIDER_RUNTIME_DIR: canonicalRuntime,
        OMB_PROVIDER_TURN_DIR: prepared.scopePath,
        PROVIDER_ONLY_SECRET: "turn-secret",
      });
      expect(manifest.environment).not.toHaveProperty("OMB_PROVIDER_LAUNCH_MANIFEST");
      expect(manifest.environment).not.toHaveProperty("OMB_PROVIDER_SANDBOX_PATHS");
      expect(manifest.environment).not.toHaveProperty("OMB_PROVIDER_INSTANCE_HOME");
      expect(manifest.environment).not.toHaveProperty("OMB_PROVIDER_INSTANCE_STATE");
      expect(manifest.environment).not.toHaveProperty("OMB_PROVIDER_STATE_DIR");
      expect(manifest.environment).not.toHaveProperty("OMB_PROVIDER_MEMORY_MAX_BYTES");
      expect(manifest.environment).not.toHaveProperty("OMB_PROVIDER_PARENT_UNIT");
      expect(manifest.environment.HOME).toBe(canonicalHome);
      expect(manifest.environment.OMB_PROVIDER_HOME).toBe(realpathSync(providerRoot));
      expect(manifest.limits).toEqual({
        memoryHigh: 3 * 1024 ** 3,
        memoryMax: 4 * 1024 ** 3,
        memorySwapMax: 0,
        cpuQuotaPercent: 200,
        tasksMax: 256,
      });
      expect(manifest.parentUnit).toBe("openmausbot.service");
      expect(manifest.paths).toEqual([
        { path: prepared.scopePath, writable: true },
        { path: canonicalExact, writable: false },
      ]);
      expect(manifest.homeImports).toEqual([{
        source: realpathSync(importFile),
        destination: ".hermes/config.yaml",
        replace: true,
      }]);
      const startup = {
        OMB_PROVIDER_RUNTIME_DIR: canonicalRuntime,
        OMB_PROVIDER_HOME: realpathSync(providerRoot),
        OMB_PROVIDER_STATE_DIR: realpathSync(providerStateRoot),
      };
      const same = prepareProviderSandboxEnvironment(
        {
          OMB_PROVIDER_INSTANCE_HOME: canonicalHome,
          OMB_PROVIDER_INSTANCE_STATE: realpathSync(providerState),
        },
        [],
        startup,
        { ownerKey: "bot-one" },
      );
      const different = prepareProviderSandboxEnvironment(
        {
          OMB_PROVIDER_INSTANCE_HOME: canonicalHome,
          OMB_PROVIDER_INSTANCE_STATE: realpathSync(providerState),
        },
        [],
        startup,
        { ownerKey: "bot-two" },
      );
      expect(JSON.parse(readFileSync(same.manifestPath, "utf8")).persistentHomeKey)
        .toBe(manifest.persistentHomeKey);
      expect(JSON.parse(readFileSync(different.manifestPath, "utf8")).persistentHomeKey)
        .not.toBe(manifest.persistentHomeKey);
      expect(() => prepareProviderSandboxEnvironment(
        {
          OMB_PROVIDER_INSTANCE_HOME: canonicalHome,
          OMB_PROVIDER_INSTANCE_STATE: realpathSync(providerState),
        },
        [],
        startup,
        { ownerKey: "bad\0owner" },
      )).toThrow("persistent home identity is invalid");
      same.cleanup();
      different.cleanup();
      prepared.cleanup();
      expect(existsSync(prepared.scopePath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("allows only an exact file to override a read-only runtime directory", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-provider-sandbox-nested-file-"));
    try {
      const runtime = join(root, "runtime");
      const providerRoot = join(root, "provider-home");
      const providerHome = join(providerRoot, "instances", "driver", "instance");
      const providerStateRoot = join(providerRoot, "state");
      const providerState = join(providerStateRoot, "driver", "instance");
      const policy = join(runtime, "policy");
      const proof = join(policy, "proof.json");
      mkdirSync(policy, { recursive: true, mode: 0o2750 });
      mkdirSync(providerHome, { recursive: true, mode: 0o2750 });
      mkdirSync(providerState, { recursive: true, mode: 0o750 });
      chmodSync(runtime, 0o2750);
      chmodSync(policy, 0o2750);
      chmodSync(providerHome, 0o2750);
      chmodSync(providerStateRoot, 0o750);
      chmodSync(providerState, 0o750);
      writeFileSync(proof, "", { mode: 0o640 });
      const startup = {
        OMB_PROVIDER_RUNTIME_DIR: realpathSync(runtime),
        OMB_PROVIDER_HOME: realpathSync(providerRoot),
        OMB_PROVIDER_STATE_DIR: realpathSync(providerStateRoot),
        OMB_PROVIDER_MEMORY_HIGH_BYTES: String(256 * 1024 ** 2),
        OMB_PROVIDER_MEMORY_MAX_BYTES: String(512 * 1024 ** 2),
        OMB_PROVIDER_MEMORY_SWAP_MAX_BYTES: "0",
        OMB_PROVIDER_CPU_QUOTA_PERCENT: "75",
        OMB_PROVIDER_TASKS_MAX: "64",
        OMB_PROVIDER_PARENT_UNIT: "openmausbot-test@one.service",
      };
      const prepared = prepareProviderSandboxEnvironment(
        {
          OMB_PROVIDER_INSTANCE_HOME: realpathSync(providerHome),
          OMB_PROVIDER_INSTANCE_STATE: realpathSync(providerState),
        },
        [{ path: policy }, { path: proof, writable: true }],
        startup,
      );
      const manifest = JSON.parse(readFileSync(prepared.manifestPath, "utf8"));
      expect(manifest.paths).toEqual([
        { path: prepared.scopePath, writable: true },
        { path: realpathSync(policy), writable: false },
        { path: realpathSync(proof), writable: true },
      ]);
      expect(manifest.limits).toEqual({
        memoryHigh: 256 * 1024 ** 2,
        memoryMax: 512 * 1024 ** 2,
        memorySwapMax: 0,
        cpuQuotaPercent: 75,
        tasksMax: 64,
      });
      expect(manifest.parentUnit).toBe("openmausbot-test@one.service");
      prepared.cleanup();
      expect(() => prepareProviderSandboxEnvironment(
        {
          OMB_PROVIDER_INSTANCE_HOME: realpathSync(providerHome),
          OMB_PROVIDER_INSTANCE_STATE: realpathSync(providerState),
        },
        [{ path: policy, writable: true }, { path: proof, writable: true }],
        startup,
      )).toThrow("exact file inside a read-only directory");
      expect(() => prepareProviderSandboxEnvironment(
        {
          OMB_PROVIDER_INSTANCE_HOME: realpathSync(providerHome),
          OMB_PROVIDER_INSTANCE_STATE: realpathSync(providerState),
        },
        [],
        { ...startup, OMB_PROVIDER_MEMORY_MAX_BYTES: "127" },
      )).toThrow("outside the supported range");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("rejects a requested mount outside the validated runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-provider-sandbox-escape-"));
    try {
      const runtime = join(root, "runtime");
      const providerRoot = join(root, "provider-home");
      const providerHome = join(providerRoot, "instances", "driver", "instance");
      const providerStateRoot = join(providerRoot, "state");
      const providerState = join(providerStateRoot, "driver", "instance");
      const outside = join(root, "outside");
      mkdirSync(runtime, { mode: 0o2750 });
      mkdirSync(providerHome, { recursive: true, mode: 0o2750 });
      mkdirSync(providerState, { recursive: true, mode: 0o750 });
      chmodSync(runtime, 0o2750);
      chmodSync(providerHome, 0o2750);
      chmodSync(providerStateRoot, 0o750);
      chmodSync(providerState, 0o750);
      writeFileSync(outside, "no");
      expect(() => prepareProviderSandboxEnvironment(
        {
          OMB_PROVIDER_INSTANCE_HOME: realpathSync(providerHome),
          OMB_PROVIDER_INSTANCE_STATE: realpathSync(providerState),
        },
        [{ path: outside, writable: true }],
        {
          OMB_PROVIDER_RUNTIME_DIR: realpathSync(runtime),
          OMB_PROVIDER_HOME: realpathSync(providerRoot),
          OMB_PROVIDER_STATE_DIR: realpathSync(providerStateRoot),
        },
      )).toThrow("must stay inside");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function fakeWindowsChild(pid: number) {
  // SAFETY: this test double supplies precisely the ChildProcess surface used
  // by terminateCliTree; it is never passed to Node's process APIs.
  const child = Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: () => true,
  });
  // SAFETY: the assigned EventEmitter test double implements the complete
  // terminateCliTree access surface (pid/status/kill/once).
  return child as Parameters<typeof terminateCliTree>[0];
}

describe("CLI process-tree termination", () => {
  it("waits for exit proof and escalates a child that ignores TERM", async () => {
    const child = spawnCli(
      process.execPath,
      [
        "-e",
        [
          "process.on('SIGTERM', () => {});",
          "process.stdout.write('ready\\n');",
          "setInterval(() => {}, 1000);",
        ].join(""),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    await once(child.stdout, "data");
    const startedAt = Date.now();

    await terminateCliTree(child, { graceMs: 75, timeoutMs: 2_000 });

    if (process.platform !== "win32") expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("on Windows awaits delayed taskkill tree proof after the direct parent exits", async () => {
    const child = fakeWindowsChild(4242);
    let releaseTaskkill!: () => void;
    let descendantAlive = true;
    let markTaskkillStarted!: () => void;
    const started = new Promise<void>((resolve) => { markTaskkillStarted = resolve; });
    const windowsTaskkill = async (pid: number, signal: AbortSignal) => {
      expect(pid).toBe(4242);
      markTaskkillStarted();
      await new Promise<void>((resolve, reject) => {
        releaseTaskkill = resolve;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      descendantAlive = false;
    };

    const pending = terminateCliTree(child, {
      platform: "win32",
      graceMs: 0,
      timeoutMs: 1_000,
      windowsTaskkill,
    });
    await started;
    // SAFETY: fakeWindowsChild owns this writable test-only exitCode field.
    (child as any).exitCode = 0;
    child.emit("close", 0, null);
    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));

    expect(settled).toBe(false);
    expect(descendantAlive).toBe(true);
    releaseTaskkill();
    await pending;
    expect(descendantAlive).toBe(false);
  });

  it("on Windows rejects taskkill failure even when the direct parent already exited", async () => {
    const child = fakeWindowsChild(4343);
    let rejectTaskkill!: (error: Error) => void;
    let markTaskkillStarted!: () => void;
    const started = new Promise<void>((resolve) => { markTaskkillStarted = resolve; });
    const pending = terminateCliTree(child, {
      platform: "win32",
      graceMs: 0,
      timeoutMs: 1_000,
      windowsTaskkill: async () => {
        markTaskkillStarted();
        await new Promise<void>((_resolve, reject) => { rejectTaskkill = reject; });
      },
    });
    await started;
    // SAFETY: fakeWindowsChild owns this writable test-only exitCode field.
    (child as any).exitCode = 1;
    child.emit("close", 1, null);
    rejectTaskkill(new Error("taskkill access denied"));

    await expect(pending).rejects.toThrow("taskkill access denied");
  });
});
