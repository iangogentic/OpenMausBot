import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("fleet permission policy wiring", () => {
  it("derives the immutable ceiling from environment and never from the renderer", () => {
    expect(source).toContain("process.env.OPENMAUSBOT_PERMISSION_POLICY_CEILING");
    expect(source).toContain('parsePermissionPolicy(rawCeiling) ?? "never"');
    expect(source).toContain('permissionPolicyForRequested(cfg.permissions?.policy ?? "ask")');
    expect(source).not.toMatch(/body[^\n]*adminCeiling/);
  });

  it("runs every permission through the policy resolver before provider response", () => {
    expect(source).toContain("resolvePermission(permissionState, verdict");
    expect(source).toContain('const initialAutomaticBehavior: "allow" | "deny" = policyResolution.decision === "auto" ? "allow" : "deny"');
    expect(source).toContain("respondToRequest(event.threadId, requestId, { behavior: automaticBehavior })");
    expect(source).toContain('physicalComputer: event.approvalScope === "local-computer"');
  });

  it("never degrades a failed policy denial into an approval card", () => {
    expect(source).toMatch(/if \(automaticBehavior === "deny"\)[\s\S]*?interruptTurn\(event\.threadId\)[\s\S]*?return "unavailable";[\s\S]*?const card = pushMessage/);
    expect(source).toContain('decision: automaticBehavior === "allow" ? "auto-approved" : "policy-denied"');
  });

  it("fences policy mutation and rechecks authority at the delivery boundary", () => {
    expect(source).toContain("isMoreRestrictivePermissionPolicy(targetPermissionPolicy, previousPermissionPolicy)");
    expect(source).toContain("permissionPolicyMutationFence = targetPermissionPolicy");
    expect(source).toContain("const latestResolution = resolvePermission(currentPermissionPolicy(), verdict!");
    expect(source).toContain('behavior === "allow" && currentPermissionPolicy().effective === "never"');
    expect(source).toContain("await enforceNeverOnPendingPermissions()");
  });

  it("serializes every provider request generation before delivery", () => {
    expect(source).toContain("pendingProviderSettlements.settle(key, pending, deliveredBehavior");
    expect(source).toContain("pendingProviderSettlements.settle(");
    expect(source).toContain("if (settling?.generation === pending)");
    expect(source).toContain("void cancelExactTargetTurn(pending.turn).catch(() => {})");
    expect(source).not.toMatch(/await settling\.promise[\s\S]{0,500}interruptTurn\(pending\.threadId\)/);
  });
});
