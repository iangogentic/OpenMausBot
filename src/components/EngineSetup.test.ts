import { describe, expect, it } from "vitest";

import { engineSetupPlan, needsCli, needsSignIn } from "./EngineSetup";
import type { InstanceInfo } from "@/state/store";

function instance(snapshot: InstanceInfo["snapshot"]): InstanceInfo {
  return {
    instanceId: "kimi",
    driverKind: "kimiAgent",
    displayName: "Kimi",
    models: { default: "kimi-code/k3", options: [] },
    snapshot,
  };
}

describe("needsCli / needsSignIn", () => {
  it("treats a missing binary as a CLI install, not a sign-in", () => {
    const missing = instance({ state: "unavailable", reason: "`kimi` CLI not found" });
    expect(needsCli(missing)).toBe(true);
    expect(needsSignIn(missing)).toBe(false);
  });

  it("lets Custom inject run when the CLI is installed but unsigned-in", () => {
    const unsigned = instance({ state: "available", authenticated: false, version: "0.36.1" });
    expect(needsCli(unsigned)).toBe(false);
    expect(needsSignIn(unsigned)).toBe(true);
  });

  it("is ready for inject when the CLI is present", () => {
    const ready = instance({ state: "available", authenticated: true, version: "0.36.1" });
    expect(needsCli(ready)).toBe(false);
    expect(needsSignIn(ready)).toBe(false);
  });
});

describe("remote EngineSetup presentation", () => {
  const install = { command: { darwin: "brew install agent", linux: "npm i -g agent" } };

  it("uses the server-reported Linux command and never offers a local terminal", () => {
    const plan = engineSetupPlan(install, "remote", "linux");
    expect(plan).toEqual({ command: "npm i -g agent", runOnServer: true });
  });

  it("withholds a remote install action until the server reports its platform", () => {
    expect(engineSetupPlan(install, "remote")).toEqual({ command: null, runOnServer: true });
  });

  it("preserves the local-machine install behavior", () => {
    // Explicitly Linux here keeps this test host-independent.
    expect(engineSetupPlan({ command: { linux: "npm i -g agent" } }, "local")).toMatchObject({ runOnServer: false });
  });
});
