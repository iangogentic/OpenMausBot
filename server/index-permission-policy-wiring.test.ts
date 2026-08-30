import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("fleet permission policy wiring", () => {
  it("derives the immutable ceiling from environment and never from the renderer", () => {
    expect(source).toContain("process.env.OPENMAUSBOT_PERMISSION_POLICY_CEILING");
    expect(source).toContain('parsePermissionPolicy(rawCeiling) ?? "never"');
    expect(source).toContain('resolvePermissionPolicy(cfg.permissions?.policy ?? "ask", adminCeiling)');
    expect(source).not.toMatch(/body[^\n]*adminCeiling/);
  });

  it("runs every permission through the policy resolver before provider response", () => {
    expect(source).toContain("resolvePermission(permissionState, verdict");
    expect(source).toContain('automaticBehavior = policyResolution.decision === "auto" ? "allow" : "deny"');
    expect(source).toContain("respondToRequest(event.threadId, requestId, { behavior: automaticBehavior })");
    expect(source).toContain('physicalComputer: event.approvalScope === "local-computer"');
  });

  it("never degrades a failed policy denial into an approval card", () => {
    expect(source).toMatch(/if \(automaticBehavior === "deny"\)[\s\S]*?interruptTurn\(event\.threadId\)[\s\S]*?return;[\s\S]*?const card = pushMessage/);
    expect(source).toContain('decision: automaticBehavior === "allow" ? "auto-approved" : "policy-denied"');
  });
});
