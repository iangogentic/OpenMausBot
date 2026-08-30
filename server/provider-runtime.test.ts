import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createProviderTempDirectory,
  providerInstanceEnvironment,
  providerInstanceHomePath,
  providerInstanceStatePath,
  providerRuntimeBase,
  writeProviderRuntimeFile,
} from "./provider-runtime.ts";

const prior = { ...process.env };
const roots: string[] = [];
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
  Object.assign(process.env, prior);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("provider identity runtime", () => {
  it("overrides instance HOME before auth checks and confines special homes", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-provider-home-test-")));
    roots.push(root);
    const identity = { driverKind: "codex", instanceId: "codex-local" };
    const home = providerInstanceHomePath(root, identity);
    const stateRoot = join(root, "state");
    const state = providerInstanceStatePath(stateRoot, identity);
    mkdirSync(home, { recursive: true, mode: 0o2750 });
    mkdirSync(state, { recursive: true, mode: 0o750 });
    chmodSync(home, 0o2750);
    chmodSync(stateRoot, 0o750);
    chmodSync(state, 0o750);
    const env = providerInstanceEnvironment(
      { HOME: "/server", GROK_HOME: join(home, "grok") },
      {
        OMB_REQUIRE_PROVIDER_ISOLATION: "1",
        OMB_PROVIDER_HOME: root,
        OMB_PROVIDER_STATE_DIR: stateRoot,
      },
      identity,
    );
    expect(env.HOME).toBe(home);
    expect(env.USERPROFILE).toBe(home);
    expect(env.OMB_PROVIDER_INSTANCE_HOME).toBe(home);
    expect(env.OMB_PROVIDER_INSTANCE_STATE).toBe(state);
    expect(() => providerInstanceEnvironment(
      { CODEX_HOME: join(root, "instances", "sibling") },
      {
        OMB_REQUIRE_PROVIDER_ISOLATION: "1",
        OMB_PROVIDER_HOME: root,
        OMB_PROVIDER_STATE_DIR: stateRoot,
      },
      identity,
    )).toThrow("inside the isolated provider instance home");
  });

  it("maps different provider instances to different required home leaves", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-provider-instance-map-")));
    roots.push(root);
    const first = { driverKind: "claudeAgent", instanceId: "one/../../escape" };
    const second = { driverKind: "claudeAgent", instanceId: "two" };
    const firstHome = providerInstanceHomePath(root, first);
    const secondHome = providerInstanceHomePath(root, second);
    expect(firstHome).not.toBe(secondHome);
    expect(providerInstanceStatePath(join(root, "state"), first)).not.toBe(
      providerInstanceStatePath(join(root, "state"), second),
    );
    expect(firstHome.startsWith(join(root, "instances"))).toBe(true);
    mkdirSync(join(root, "state"), { mode: 0o750 });
    chmodSync(join(root, "state"), 0o750);
    expect(() => providerInstanceEnvironment(
      {},
      {
        OMB_REQUIRE_PROVIDER_ISOLATION: "1",
        OMB_PROVIDER_HOME: root,
        OMB_PROVIDER_STATE_DIR: join(root, "state"),
      },
      first,
    )).toThrow("missing or unsafe");
  });

  it("requires both home and runtime declarations when isolation is mandatory", () => {
    expect(() => providerInstanceEnvironment(
      {},
      { OMB_REQUIRE_PROVIDER_ISOLATION: "1" },
      { driverKind: "codex", instanceId: "one" },
    ))
      .toThrow("OMB_PROVIDER_HOME");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-provider-state-required-")));
    roots.push(root);
    expect(() => providerInstanceEnvironment(
      {},
      { OMB_REQUIRE_PROVIDER_ISOLATION: "1", OMB_PROVIDER_HOME: root },
      { driverKind: "codex", instanceId: "one" },
    )).toThrow("OMB_PROVIDER_STATE_DIR");
    expect(() => providerRuntimeBase({ OMB_REQUIRE_PROVIDER_ISOLATION: "1" }))
      .toThrow("OMB_PROVIDER_RUNTIME_DIR");
  });

  it.runIf(process.platform !== "win32")("publishes only group-readable per-turn files in the validated runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-provider-runtime-test-"));
    roots.push(root);
    const runtime = join(root, "runtime");
    mkdirSync(runtime, { mode: 0o750 });
    chmodSync(runtime, 0o750);
    process.env.OMB_PROVIDER_RUNTIME_DIR = realpathSync(runtime);
    const directory = createProviderTempDirectory("turn-");
    const file = writeProviderRuntimeFile(directory, "mcp.json", "{}");
    expect(statSync(directory.path).mode & 0o2777).toBe(0o2750);
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });

  it.runIf(process.platform !== "win32")("rejects a group-writable configured base", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-provider-runtime-bad-"));
    roots.push(root);
    chmodSync(root, 0o770);
    expect(() => providerRuntimeBase({ OMB_PROVIDER_RUNTIME_DIR: root }))
      .toThrow("non-writable by group/other");
  });
});
