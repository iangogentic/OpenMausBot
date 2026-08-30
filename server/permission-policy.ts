import type { AutoVerdict } from "./auto-approve.ts";
import { z } from "zod";

/** User-facing permission modes, ordered from least to most permissive. */
export const PERMISSION_POLICIES = ["never", "ask", "always"] as const;
export type PermissionPolicy = (typeof PERMISSION_POLICIES)[number];
export const permissionPolicySchema = z.enum(PERMISSION_POLICIES);
export const permissionPolicyRequestSchema = z.object({ requested: permissionPolicySchema }).strict();

const POLICY_RANK: Readonly<Record<PermissionPolicy, number>> = Object.freeze({
  never: 0,
  ask: 1,
  always: 2,
});

/** Parse only an exact policy token. No aliases, case folding, or coercion. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the exact Zod-validated I/O parser for an untrusted policy token.
export function parsePermissionPolicy(value: unknown): PermissionPolicy | null {
  const parsed = permissionPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Strict wire parser for a policy update. Unknown fields are rejected. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the exact Zod-validated I/O parser for an untrusted request body.
export function parsePermissionPolicyRequest(value: unknown): Readonly<{ requested: PermissionPolicy }> | null {
  const parsed = permissionPolicyRequestSchema.safeParse(value);
  return parsed.success ? Object.freeze(parsed.data) : null;
}

export interface PermissionPolicyState {
  readonly requested: PermissionPolicy;
  readonly adminCeiling: PermissionPolicy;
  readonly effective: PermissionPolicy;
  readonly limitedByAdmin: boolean;
}

/**
 * Resolve a requested mode beneath the administrator's immutable ceiling.
 * The returned state is frozen so downstream status code cannot mutate the
 * authority it reports.
 */
export function resolvePermissionPolicy(
  requested: PermissionPolicy,
  adminCeiling: PermissionPolicy,
): Readonly<PermissionPolicyState> {
  const effective = POLICY_RANK[requested] <= POLICY_RANK[adminCeiling] ? requested : adminCeiling;
  return Object.freeze({
    requested,
    adminCeiling,
    effective,
    limitedByAdmin: effective !== requested,
  });
}

export interface PermissionPolicyStatus {
  readonly requested: PermissionPolicy;
  readonly effective: PermissionPolicy;
  readonly adminCeiling: PermissionPolicy;
  readonly limitedByAdmin: boolean;
}

/** Exact, bounded public projection: no internal verdict or grant data leaks. */
export function permissionPolicyStatus(state: PermissionPolicyState): Readonly<PermissionPolicyStatus> {
  return Object.freeze({
    requested: state.requested,
    effective: state.effective,
    adminCeiling: state.adminCeiling,
    limitedByAdmin: state.limitedByAdmin,
  });
}

export interface PermissionGuardContext {
  /** The turn was not initiated by a presently participating human. */
  readonly unattended?: boolean;
  /** The action reaches a user's physical computer rather than an isolated VM. */
  readonly physicalComputer?: boolean;
  /** Defense-in-depth flags for callers that classify before autoVerdict. */
  readonly destructive?: boolean;
  readonly sensitive?: boolean;
}

export type PermissionResolution =
  | Readonly<{
      decision: "deny";
      reason: "policy-never";
      freshHumanDecision: false;
      autoApproval: null;
    }>
  | Readonly<{
      decision: "ask";
      reason: "policy-ask" | "guarded-action" | "no-guarded-auto-verdict";
      freshHumanDecision: true;
      autoApproval: null;
    }>
  | Readonly<{
      decision: "auto";
      reason: "guarded-auto-verdict";
      freshHumanDecision: false;
      autoApproval: string;
    }>;

/**
 * Compose the global policy with the existing auto-approval engine.
 *
 * This function never invents approval. `always` merely allows an already
 * guarded AutoVerdict to pass through. Destructive, sensitive, unattended,
 * and physical-computer actions always require a fresh human decision.
 */
export function resolvePermission(
  state: Pick<PermissionPolicyState, "effective">,
  autoVerdict: AutoVerdict,
  context: PermissionGuardContext = {},
): PermissionResolution {
  if (state.effective === "never") {
    return Object.freeze({
      decision: "deny",
      reason: "policy-never",
      freshHumanDecision: false,
      autoApproval: null,
    });
  }

  if (state.effective === "ask") {
    return Object.freeze({
      decision: "ask",
      reason: "policy-ask",
      freshHumanDecision: true,
      autoApproval: null,
    });
  }

  const guarded =
    context.unattended === true ||
    context.physicalComputer === true ||
    context.destructive === true ||
    context.sensitive === true ||
    autoVerdict.source === "unattended-block" ||
    autoVerdict.source === "local-computer-block" ||
    autoVerdict.source === "destructive-guard" ||
    autoVerdict.source === "sensitive-guard";
  if (guarded) {
    return Object.freeze({
      decision: "ask",
      reason: "guarded-action",
      freshHumanDecision: true,
      autoApproval: null,
    });
  }

  if (
    autoVerdict.approve !== null &&
    autoVerdict.approve.length > 0 &&
    (autoVerdict.source === "always-allow" || autoVerdict.source === "auto-mode")
  ) {
    return Object.freeze({
      decision: "auto",
      reason: "guarded-auto-verdict",
      freshHumanDecision: false,
      autoApproval: autoVerdict.approve,
    });
  }

  return Object.freeze({
    decision: "ask",
    reason: "no-guarded-auto-verdict",
    freshHumanDecision: true,
    autoApproval: null,
  });
}
