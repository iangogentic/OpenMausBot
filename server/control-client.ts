// Proxy-side client for the harness's human-control lease.
//
// This is a safety boundary, so uncertainty is blocking: a missing token,
// timeout, non-2xx response, malformed body, or old harness that does not
// return `valid: true` is reported as unavailable/held. A computer mutation
// must never slip through merely because the ownership check went offline.

import { readBoundedResponseText } from "./bounded-response.ts";
import { assertBoundedJsonShape, CATALOG_NDJSON_LIMITS } from "./drivers/bounded-json-lines.ts";

const MAX_CONTROL_RESPONSE_BYTES = 64 * 1024;

export interface ControlState {
  /** True while the person is driving OR authority could not be verified. */
  held: boolean;
  /** A help request the person has neither answered nor dismissed. */
  helpOpen: boolean;
  /** False distinguishes a real hold from a failed authority check. */
  available: boolean;
}

export type ActionPermit =
  | { allowed: true; actionId: string }
  | { allowed: false; reason: "human-control" | "takeover-pending" | "action-active" | "lifecycle-active" | "unavailable" };

export interface ControlClient {
  /** Current state, cached for `cacheMs`; `fresh` bypasses the cache. */
  state(fresh?: boolean): Promise<ControlState>;
  /** Atomically register a computer action before forwarding it. */
  beginAction(): Promise<ActionPermit>;
  /** Settle the exact action ticket after its MCP result arrives. */
  endAction(actionId: string): Promise<boolean>;
  /** Mark this bridge's unresolved tickets ambiguous after transport loss. */
  quarantineActions(): Promise<boolean>;
  /** Surface the bot's plea in the app. */
  requestHelp(reason: string): Promise<string | null>;
  /** Close only the unanswered plea opened by this client. */
  expireHelp(requestId: string): Promise<void>;
  readonly configured: boolean;
}

const VERIFIED_FREE: ControlState = { held: false, helpOpen: false, available: true };
const UNAVAILABLE: ControlState = { held: true, helpOpen: false, available: false };

export function createControlClient(options?: {
  url?: string;
  token?: string;
  cacheMs?: number;
  fetchImpl?: typeof fetch;
}): ControlClient {
  const url = options?.url ?? process.env.OMB_CONTROL_URL ?? "";
  const token = options?.token ?? process.env.OMB_CONTROL_TOKEN ?? "";
  const cacheMs = options?.cacheMs ?? 750;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const configured = Boolean(url && token);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  let cachedAt = 0;
  let cached: ControlState = UNAVAILABLE;

  async function request(init: RequestInit): Promise<Response | null> {
    if (!configured) return null;
    try {
      return await fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(2_000) });
    } catch {
      return null;
    }
  }

  async function responseJson(res: Response): Promise<any> {
    try {
      const text = await readBoundedResponseText(
        res,
        MAX_CONTROL_RESPONSE_BYTES,
        "computer control response exceeded 64 KB",
      );
      const parsed: unknown = text.trim() ? JSON.parse(text) : null;
      assertBoundedJsonShape(parsed, CATALOG_NDJSON_LIMITS);
      return parsed;
    } catch {
      return null;
    }
  }

  async function read(): Promise<ControlState> {
    const res = await request({ method: "GET" });
    if (!res?.ok) return UNAVAILABLE;
    const body: any = await responseJson(res);
    if (body?.valid !== true || typeof body?.held !== "boolean" || typeof body?.helpOpen !== "boolean") {
      return UNAVAILABLE;
    }
    return { held: body.held, helpOpen: body.helpOpen, available: true };
  }

  return {
    configured,
    async state(fresh = false): Promise<ControlState> {
      if (!configured) return UNAVAILABLE;
      const now = Date.now();
      if (!fresh && now - cachedAt < cacheMs) return cached;
      cached = await read();
      cachedAt = Date.now();
      return cached;
    },
    async beginAction(): Promise<ActionPermit> {
      const res = await request({ method: "POST", body: JSON.stringify({ op: "begin-action" }) });
      if (!res?.ok) return { allowed: false, reason: "unavailable" };
      const body: any = await responseJson(res);
      if (body?.valid !== true || typeof body?.allowed !== "boolean") {
        return { allowed: false, reason: "unavailable" };
      }
      if (body.allowed) {
        return typeof body.actionId === "string" && body.actionId
          ? { allowed: true, actionId: body.actionId }
          : { allowed: false, reason: "unavailable" };
      }
      return body.reason === "human-control" || body.reason === "takeover-pending" ||
        body.reason === "action-active" || body.reason === "lifecycle-active"
        ? { allowed: false, reason: body.reason }
        : { allowed: false, reason: "unavailable" };
    },
    async endAction(actionId: string): Promise<boolean> {
      if (!actionId) return false;
      const res = await request({
        method: "DELETE",
        body: JSON.stringify({ op: "end-action", actionId }),
      });
      if (!res?.ok) return false;
      const body: any = await responseJson(res);
      return body?.valid === true && body?.ended === true;
    },
    async quarantineActions(): Promise<boolean> {
      const res = await request({ method: "DELETE", body: JSON.stringify({ op: "quarantine-actions" }) });
      if (!res?.ok) return false;
      const body: any = await responseJson(res);
      return body?.valid === true && typeof body?.quarantined === "number";
    },
    async requestHelp(reason: string): Promise<string | null> {
      const res = await request({ method: "POST", body: JSON.stringify({ reason }) });
      if (!res?.ok) return null;
      const body: any = await responseJson(res);
      return body?.valid === true && typeof body?.requestId === "string" && body.requestId
        ? body.requestId
        : null;
    },
    async expireHelp(requestId: string): Promise<void> {
      if (!requestId) return;
      await request({ method: "DELETE", body: JSON.stringify({ requestId }) });
    },
  };
}

/** The one sentence every refused action gets. */
export const CONTROL_REFUSAL =
  "A person has taken control of this computer, so this call was NOT performed. " +
  "Do not retry it — the screen is changing under their hands. " +
  "Call computer_request_help (no reason needed) to wait for them to finish, " +
  "then take a fresh screenshot before your next action.";

export const CONTROL_REFUSAL_PLAIN =
  "A person has taken control of this computer, so this call was NOT performed. " +
  "Do not retry it — the screen is changing under their hands. " +
  "Pause this task, tell the person you are waiting for them to hand control back, " +
  "and take a fresh screenshot before your next action once they have.";

/** Do not tell the model a person is driving when the real fact is that the
 * authority check failed; both block mutation, but recovery differs. */
export const CONTROL_UNAVAILABLE_PLAIN =
  "Computer control authority could not be verified, so this call was NOT performed. " +
  "Do not retry blindly. Pause this task and wait for the OpenMaus server connection to recover, " +
  "then take a fresh screenshot before your next action.";

/** A lifecycle fence is neither human ownership nor lost authority. */
export const CONTROL_LIFECYCLE_PLAIN =
  "This computer is being started, stopped, or replaced, so this call was NOT performed. " +
  "Do not retry blindly. Wait for computer setup to finish, then take a fresh screenshot before your next action.";

/** One target accepts one ordered mutation at a time, across every bot. */
export const CONTROL_ACTION_BUSY_PLAIN =
  "Another computer action is still in progress on this same desktop, so this call was NOT performed. " +
  "Wait for that action to finish, then take a fresh screenshot before trying the next action.";

export { UNAVAILABLE as CONTROL_UNAVAILABLE_STATE, VERIFIED_FREE as CONTROL_VERIFIED_FREE_STATE };
