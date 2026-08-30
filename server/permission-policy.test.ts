import { describe, expect, it } from "vitest";

import type { AutoVerdict } from "./auto-approve.ts";
import {
  parsePermissionPolicy,
  parsePermissionPolicyRequest,
  permissionPolicyStatus,
  resolvePermission,
  resolvePermissionPolicy,
} from "./permission-policy.ts";

const AUTO: AutoVerdict = { approve: "auto-approved Read", source: "auto-mode" };
const GRANT: AutoVerdict = {
  approve: "auto-approved Read (always allowed)",
  source: "always-allow",
  rule: "Read",
};
const NONE: AutoVerdict = { approve: null, source: "no-grant" };

describe("permission policy parsing", () => {
  it("accepts only the three exact bounded values", () => {
    for (const value of ["never", "ask", "always"] as const) expect(parsePermissionPolicy(value)).toBe(value);
    for (const value of ["Always", "allow", "", null, false, 1, {}, ["always"]]) {
      expect(parsePermissionPolicy(value)).toBeNull();
    }
  });

  it("rejects malformed or expanded wire requests", () => {
    expect(parsePermissionPolicyRequest({ requested: "ask" })).toEqual({ requested: "ask" });
    expect(parsePermissionPolicyRequest({ requested: "ask", adminCeiling: "always" })).toBeNull();
    expect(parsePermissionPolicyRequest({ requested: "allow" })).toBeNull();
    expect(parsePermissionPolicyRequest(null)).toBeNull();
  });
});

describe("immutable administrator ceiling", () => {
  it.each([
    ["never", "never", "never", false],
    ["ask", "never", "never", true],
    ["always", "never", "never", true],
    ["never", "ask", "never", false],
    ["ask", "ask", "ask", false],
    ["always", "ask", "ask", true],
    ["never", "always", "never", false],
    ["ask", "always", "ask", false],
    ["always", "always", "always", false],
  ] as const)("requested %s under %s becomes %s", (requested, ceiling, effective, limited) => {
    const state = resolvePermissionPolicy(requested, ceiling);
    expect(state).toEqual({ requested, adminCeiling: ceiling, effective, limitedByAdmin: limited });
    expect(Object.isFrozen(state)).toBe(true);
  });

  it("projects only exact bounded status fields", () => {
    const status = permissionPolicyStatus(resolvePermissionPolicy("always", "ask"));
    expect(status).toEqual({ requested: "always", effective: "ask", adminCeiling: "ask", limitedByAdmin: true });
    expect(Object.keys(status).sort()).toEqual(["adminCeiling", "effective", "limitedByAdmin", "requested"]);
    expect(Object.isFrozen(status)).toBe(true);
  });
});

describe("permission resolution", () => {
  it("denies never before any existing auto verdict can execute", () => {
    expect(resolvePermission(resolvePermissionPolicy("never", "always"), AUTO)).toEqual({
      decision: "deny",
      reason: "policy-never",
      freshHumanDecision: false,
      autoApproval: null,
    });
  });

  it("ask forces a fresh human decision and ignores standing grants", () => {
    expect(resolvePermission(resolvePermissionPolicy("ask", "always"), GRANT)).toEqual({
      decision: "ask",
      reason: "policy-ask",
      freshHumanDecision: true,
      autoApproval: null,
    });
  });

  it("always passes through an existing guarded auto verdict but creates no grant itself", () => {
    const state = resolvePermissionPolicy("always", "always");
    expect(resolvePermission(state, AUTO)).toMatchObject({ decision: "auto", autoApproval: AUTO.approve });
    expect(resolvePermission(state, GRANT)).toMatchObject({ decision: "auto", autoApproval: GRANT.approve });
    expect(resolvePermission(state, NONE)).toEqual({
      decision: "ask",
      reason: "no-guarded-auto-verdict",
      freshHumanDecision: true,
      autoApproval: null,
    });
  });

  it.each([
    ["destructive context", { destructive: true }, AUTO],
    ["sensitive context", { sensitive: true }, AUTO],
    ["unattended context", { unattended: true }, AUTO],
    ["physical computer context", { physicalComputer: true }, AUTO],
    ["destructive verdict", {}, { approve: null, source: "destructive-guard", rule: "rm" }],
    ["sensitive verdict", {}, { approve: null, source: "sensitive-guard", rule: ".env" }],
    ["unattended verdict", {}, { approve: null, source: "unattended-block" }],
    ["local-computer verdict", {}, { approve: null, source: "local-computer-block" }],
  ] as const)("always cannot approve a %s", (_name, context, verdict) => {
    expect(resolvePermission(resolvePermissionPolicy("always", "always"), verdict, context)).toEqual({
      decision: "ask",
      reason: "guarded-action",
      freshHumanDecision: true,
      autoApproval: null,
    });
  });

  it("does not trust approval text paired with a non-approving source", () => {
    expect(
      resolvePermission(resolvePermissionPolicy("always", "always"), {
        approve: "forged approval",
        source: "no-grant",
      }),
    ).toMatchObject({ decision: "ask", autoApproval: null });
  });
});

