// A project API key (ak_…) creates/reuses one Composio Session. That
// Session owns connection state, auth links and the MCP endpoint.
import { saveConfig, type AppConfig } from "./config.ts";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { readBoundedResponseBytes, readBoundedResponseText } from "./bounded-response.ts";

const DEFAULT_BACKEND_ORIGIN = "https://backend.composio.dev";
const MAX_COMPOSIO_JSON_BYTES = 2 * 1024 * 1024;
const MAX_COMPOSIO_ERROR_BYTES = 64 * 1024;
const MAX_COMPOSIO_MCP_BYTES = 20 * 1024 * 1024;

function composioRequestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function apiBase() {
  return (process.env.OMB_COMPOSIO_API ?? `${DEFAULT_BACKEND_ORIGIN}/api/v3.1`).replace(/\/$/, "");
}

function toolkitBase() {
  return (process.env.OMB_COMPOSIO_TOOLKITS_API ?? `${DEFAULT_BACKEND_ORIGIN}/api/v3`).replace(/\/$/, "");
}

const sessionResponseSchema = z.object({
  session_id: z.string().min(1),
  mcp: z.object({ type: z.enum(["http", "sse"]), url: z.string().min(1) }),
  config: z.object({
    user_id: z.string().optional(),
    multi_account: z.object({
      enable: z.boolean().optional(),
      max_accounts_per_toolkit: z.number().optional(),
      require_explicit_selection: z.boolean().optional(),
    }).optional(),
  }).optional(),
});
type SessionResponse = z.infer<typeof sessionResponseSchema>;

export interface ConnectedAccountSummary {
  id: string;
  alias?: string;
  status: string;
}

export interface ConnectorServiceState {
  connected: boolean;
  pending: boolean;
  status: string;
  accounts: ConnectedAccountSummary[];
}

interface AccountLinkRequest {
  toolkit: string;
  alias?: string;
}

const connectedAccountResponseSchema = z.object({
  id: z.string().optional(),
  alias: z.string().nullable().optional(),
  status: z.string().optional(),
  updated_at: z.string().optional(),
  toolkit: z.object({ slug: z.string().optional() }).optional(),
});
type ConnectedAccountResponse = z.infer<typeof connectedAccountResponseSchema>;

const connectedAccountsPageSchema = z.object({
  items: z.array(connectedAccountResponseSchema),
  next_cursor: z.string().nullable().optional(),
});

const toolkitItemSchema = z.object({
  slug: z.string().optional(),
  is_no_auth: z.boolean().optional(),
  connected_account: z.object({ id: z.string().optional(), status: z.string().optional() }).nullable().optional(),
});
type ToolkitItem = z.infer<typeof toolkitItemSchema>;
const toolkitPageSchema = z.object({
  items: z.array(toolkitItemSchema).optional(),
  next_cursor: z.string().nullable().optional(),
});

const connectorServiceSchema = z.object({
  connected: z.boolean(),
  pending: z.boolean().optional(),
  status: z.string().optional(),
  accounts: z.array(z.object({ id: z.string(), alias: z.string().optional(), status: z.string() })).optional(),
});
const connectorServicesResponseSchema = z.object({ services: z.record(z.string(), connectorServiceSchema).optional() });
const removalResponseSchema = z.object({ removed: z.number() });
const authUrlResponseSchema = z.object({ url: z.string().optional() });
const linkResponseSchema = z.object({ redirect_url: z.string().optional() });

const MULTI_ACCOUNT_CONFIG = {
  enable: true,
  max_accounts_per_toolkit: 5,
  require_explicit_selection: true,
} as const;
const MAX_CONNECTED_ACCOUNT_PAGES = 100;
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const printableAliasSchema = z.string().min(1).max(64).refine((value) => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 32 || codePoint === 127) return false;
  }
  return true;
});

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ComposioMcpIntegration {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface IntegrationContext {
  harnessUrl: string;
  capabilityToken: string;
}

type ManagedBrokerAccess = { url: string; token: string };

let managedBrokerAccess: ManagedBrokerAccess | null | undefined;

export const COMPOSIO_CREDENTIAL_CHANGE_ERROR =
  "wait for active connected-app operations to finish before changing the Composio account";

let composioCredentialMutation = false;
let activeComposioConfigUses = 0;
const NO_PENDING_MANAGED_ACCESS = Symbol("no-pending-managed-access");
let pendingManagedBrokerAccess: ManagedBrokerAccess | null | typeof NO_PENDING_MANAGED_ACCESS =
  NO_PENDING_MANAGED_ACCESS;

interface ComposioConfigUse {
  /** Root object is retained only for the stale-generation persistence fence. */
  source: AppConfig;
  /** Immutable account snapshot used for every await in this operation. */
  config: AppConfig;
  broker: ManagedBrokerAccess | null;
  namespace: string;
  release: () => void;
}

function sameBrokerAccess(left: ManagedBrokerAccess | null, right: ManagedBrokerAccess | null): boolean {
  return left?.url === right?.url && left?.token === right?.token;
}

function applyPendingManagedBrokerAccess(): void {
  if (
    pendingManagedBrokerAccess === NO_PENDING_MANAGED_ACCESS ||
    composioCredentialMutation ||
    activeComposioConfigUses > 0
  ) {
    return;
  }
  managedBrokerAccess = pendingManagedBrokerAccess;
  pendingManagedBrokerAccess = NO_PENDING_MANAGED_ACCESS;
}

function credentialNamespace(mode: "managed" | "self-hosted" | "unavailable", identity = ""): string {
  // Namespace caches and upgrade markers by account without retaining a
  // credential in diagnostic heap/map keys.
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return `${mode}:${digest}`;
}

/** Pin one Composio account generation for an entire multi-await operation.
 * AppConfig and the desktop's managed-broker credential are both mutable;
 * every downstream request must use this copy instead of rereading either. */
export function acquireComposioConfigUse(cfg: AppConfig): ComposioConfigUse {
  if (composioCredentialMutation || pendingManagedBrokerAccess !== NO_PENDING_MANAGED_ACCESS) {
    throw Object.assign(new Error("Connected-app settings are being updated; retry the action"), { status: 409 });
  }
  const config: AppConfig = {
    ...cfg,
    composio: cfg.composio ? { ...cfg.composio } : undefined,
  };
  const broker = brokerAccess();
  const pinnedBroker = broker ? { ...broker } : null;
  const namespace = pinnedBroker
    ? credentialNamespace("managed", `${pinnedBroker.url}\0${pinnedBroker.token}`)
    : config.composio?.apiKey
      ? credentialNamespace("self-hosted", config.composio.apiKey)
      : credentialNamespace("unavailable");
  // Increment only after parsing env-backed broker credentials and building
  // the snapshot. A malformed boot credential must not leak a phantom lease.
  activeComposioConfigUses += 1;
  let released = false;
  return {
    source: cfg,
    config,
    broker: pinnedBroker,
    namespace,
    release: () => {
      if (released) return;
      released = true;
      activeComposioConfigUses = Math.max(0, activeComposioConfigUses - 1);
      applyPendingManagedBrokerAccess();
    },
  };
}

/** Atomically exclude new account-bound work while a project-key rotation is
 * validated and committed. The config route must hold the returned mutation
 * through validation, saveConfig, live cfg replacement, and provider reload. */
export function beginComposioCredentialMutation(
  currentApiKey: string | undefined,
  nextApiKey: string | undefined,
  options: { force?: boolean } = {},
): { allowed: true; changing: boolean; release: () => void } | { allowed: false; error: string } {
  // Supplying even the same project key revalidates/possibly upgrades its
  // derived userId+Session. Config routes should pass force:true whenever a
  // composio patch is present, including a session-only hostile patch.
  if (!options.force && currentApiKey === nextApiKey) {
    return { allowed: true, changing: false, release: () => {} };
  }
  if (
    composioCredentialMutation ||
    activeComposioConfigUses > 0 ||
    pendingManagedBrokerAccess !== NO_PENDING_MANAGED_ACCESS
  ) {
    return { allowed: false, error: COMPOSIO_CREDENTIAL_CHANGE_ERROR };
  }
  composioCredentialMutation = true;
  let released = false;
  return {
    allowed: true,
    changing: true,
    release: () => {
      if (released) return;
      released = true;
      composioCredentialMutation = false;
      applyPendingManagedBrokerAccess();
    },
  };
}

const managedBrokerMessageSchema = z.record(z.string(), z.unknown());
const managedBrokerToken = /^[0-9a-f]{64}$/;

function normalizeManagedBrokerUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The connected-apps service URL must not include credentials, a query, or a fragment");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("The connected-apps service must use HTTPS");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

// Private parent-port data is still an I/O boundary; the schema below parses
// the complete record before any field is consumed.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function applyManagedBrokerMessage(message: unknown): boolean {
  const parsed = managedBrokerMessageSchema.safeParse(message);
  if (
    !parsed.success ||
    parsed.data.type !== "openmausbot:managed-composio" ||
    !Object.hasOwn(parsed.data, "access")
  ) {
    return false;
  }
  setManagedBrokerAccess(parsed.data.access);
  return true;
}

// Called both with schema output and direct private-port input in tests; the
// strict schema below is the single validation boundary.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function setManagedBrokerAccess(access: unknown): void {
  let next: ManagedBrokerAccess | null;
  if (access === null) {
    next = null;
  } else {
    const parsed = z.object({ url: z.string().url(), token: z.string().regex(managedBrokerToken) }).strict().parse(access);
    next = { url: normalizeManagedBrokerUrl(parsed.url), token: parsed.token };
  }
  const current = managedBrokerAccess ?? null;
  if (
    managedBrokerAccess !== undefined &&
    pendingManagedBrokerAccess === NO_PENDING_MANAGED_ACCESS &&
    sameBrokerAccess(current, next)
  ) {
    return;
  }
  // Credential sync is delivered over Electron's private parent port and has
  // no request/response retry channel. Queue it behind active operations,
  // block new generations, then publish it as soon as the old one drains.
  if (composioCredentialMutation || activeComposioConfigUses > 0) {
    pendingManagedBrokerAccess = next;
    return;
  }
  managedBrokerAccess = next;
  pendingManagedBrokerAccess = NO_PENDING_MANAGED_ACCESS;
}

function brokerAccess(): { url: string; token: string } | null {
  if (managedBrokerAccess !== undefined) return managedBrokerAccess;
  const url = process.env.OMB_COMPOSIO_BROKER_URL?.trim();
  const token = process.env.OMB_COMPOSIO_BROKER_TOKEN?.trim();
  if (!url || !token) return null;
  if (!managedBrokerToken.test(token)) throw new Error("The connected-apps service token is invalid");
  return { url: normalizeManagedBrokerUrl(url), token };
}

export function connectionMode(cfg: AppConfig): "managed" | "self-hosted" | "unavailable" {
  if (brokerAccess()) return "managed";
  return cfg.composio?.apiKey ? "self-hosted" : "unavailable";
}

export function configured(cfg: AppConfig): boolean {
  return connectionMode(cfg) !== "unavailable";
}

/** Three answers, not two. The desktop shell sets OMB_CREDENTIAL_STORE to
 * "unavailable" when it could not read credentials.bin this launch; without
 * that signal an unreadable store is indistinguishable from a user who never
 * connected anything, and the UI wipes a list it should have kept. */
export type ConnectorAvailability = "configured" | "unconfigured" | "unreadable";

export function connectorAvailability(
  cfg: AppConfig,
  storeState: string | undefined = process.env.OMB_CREDENTIAL_STORE,
): ConnectorAvailability {
  if (configured(cfg)) return "configured";
  return storeState === "unavailable" ? "unreadable" : "unconfigured";
}

async function brokerRequest(
  broker: ManagedBrokerAccess | null,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  if (!broker) throw new Error("The connected-apps service is unavailable");
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${broker.token}`);
  if (init?.body) headers.set("content-type", "application/json");
  return fetch(`${broker.url}${path}`, {
    ...init,
    headers,
    redirect: "error",
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
}

function projectHeaders(apiKey: string, json = false) {
  const headers = new Headers({ "x-api-key": apiKey });
  if (json) headers.set("content-type", "application/json");
  return headers;
}

async function responseError(res: Response, fallback: string) {
  const raw = await readBoundedResponseText(
    res,
    MAX_COMPOSIO_ERROR_BYTES,
    "Composio error response was too large",
  ).catch(() => "");
  try {
    const body = JSON.parse(raw);
    return String(body?.message ?? body?.error?.message ?? body?.error ?? fallback);
  } catch {
    return raw.trim().slice(0, 300) || fallback;
  }
}

async function responseJson(res: Response, maxBytes = MAX_COMPOSIO_JSON_BYTES): Promise<unknown> {
  const raw = await readBoundedResponseText(res, maxBytes, "Composio response was too large");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Composio returned invalid JSON");
  }
}

async function throwBrokerError(res: Response, fallback: string): Promise<never> {
  const status = res.status >= 400 && res.status < 500 ? res.status : 502;
  throw Object.assign(new Error(await responseError(res, fallback)), { status });
}

function trustedAuthUrl(value: string | undefined, slug: string): string {
  if (!value) throw new Error(`Connected-apps service returned no authorization link for ${slug}`);
  const url = new URL(value);
  if (url.protocol !== "https:" || (url.hostname !== "composio.dev" && !url.hostname.endsWith(".composio.dev"))) {
    throw new Error("Connected-apps service returned an untrusted authorization link");
  }
  return url.toString();
}

function parseSessionResponse(session: SessionResponse): SessionResponse {
  const mcp = new URL(session.mcp.url);
  if (mcp.protocol !== "https:" || (mcp.hostname !== "composio.dev" && !mcp.hostname.endsWith(".composio.dev"))) {
    throw new Error("Composio returned an untrusted Session MCP URL");
  }
  return { ...session, mcp: { ...session.mcp, url: mcp.toString() } };
}

function supportsMultiAccount(session: SessionResponse): boolean {
  // Only `enable` gates reuse. The cap and selection flags are what we ASK
  // for at creation; if Composio clamps or omits them in the echo, recreating
  // the Session would post the same config and get the same echo back — a
  // strict equality check here can only manufacture a recreate-per-request
  // loop, never fix anything.
  return session.config?.multi_account?.enable === true;
}

/** Session ids this boot already tried to upgrade once. If the fresh Session
 *  STILL doesn't echo multi-account, Composio isn't granting it — run with
 *  what we have (single-account behavior) instead of recreating a Session and
 *  rewriting config.json on every request. */
const multiAccountUpgradeAttempted = new Set<string>();

function inputError(message: string, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function normalizeAccountAlias(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = z.string().safeParse(value);
  if (!parsed.success) throw inputError("Account alias must be text");
  const alias = parsed.data.trim();
  if (!printableAliasSchema.safeParse(alias).success) {
    throw inputError("Account alias must be 1-64 printable characters");
  }
  return alias;
}

function validAccountId(value: string | undefined): value is string {
  return Boolean(value && ACCOUNT_ID.test(value));
}

async function getProjectSession(
  apiKey: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionResponse | null> {
  const res = await fetch(`${apiBase()}/tool_router/session/${encodeURIComponent(sessionId)}`, {
    headers: projectHeaders(apiKey),
    redirect: "error",
    signal: composioRequestSignal(15_000, signal),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await responseError(res, `Composio session: HTTP ${res.status}`));
  return parseSessionResponse(sessionResponseSchema.parse(await responseJson(res)));
}

/** Validate a project key and return one reusable Session for this install. */
export async function prepareProjectSession(
  apiKey: string,
  current?: { apiKey?: string; userId?: string; sessionId?: string },
  options: { signal?: AbortSignal } = {},
): Promise<{ apiKey: string; userId: string; sessionId: string }> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("Enter a Composio project API key");
  if (!trimmed.startsWith("ak_")) throw new Error("Composio project API keys start with ak_");
  // Config validation races ordinary requests. Never reread a caller-owned
  // section after the first await: the live cfg may have been replaced.
  const prior = current ? { ...current } : undefined;

  let priorUserId = prior?.userId;
  if (trimmed === prior?.apiKey && prior.sessionId) {
    const existing = await getProjectSession(trimmed, prior.sessionId, options.signal);
    if (existing && supportsMultiAccount(existing)) {
      return {
        apiKey: trimmed,
        userId: existing.config?.user_id ?? prior.userId ?? `openmausbot_${randomUUID()}`,
        sessionId: existing.session_id,
      };
    }
    // Connections belong to the Composio user, not the Session. Recreate old
    // single-account Sessions with the same user ID so every existing grant is
    // retained while the new Session opts into explicit multi-account routing.
    priorUserId = existing?.config?.user_id ?? priorUserId;
  }

  const userId = priorUserId ?? `openmausbot_${randomUUID()}`;
  const res = await fetch(`${apiBase()}/tool_router/session`, {
    method: "POST",
    headers: projectHeaders(trimmed, true),
    body: JSON.stringify({
      user_id: userId,
      manage_connections: {
        enable: true,
        enable_wait_for_connections: true,
        enable_connection_removal: true,
      },
      multi_account: MULTI_ACCOUNT_CONFIG,
    }),
    redirect: "error",
    signal: composioRequestSignal(30_000, options.signal),
  });
  if (!res.ok) throw new Error(await responseError(res, `Composio rejected this key (HTTP ${res.status})`));
  const session = parseSessionResponse(sessionResponseSchema.parse(await responseJson(res)));
  return { apiKey: trimmed, userId, sessionId: session.session_id };
}

interface ProjectSessionUse {
  apiKey: string;
  userId?: string;
  session: SessionResponse;
}

function selfHostedGenerationIsCurrent(use: ComposioConfigUse): boolean {
  const captured = use.config.composio;
  const current = use.source.composio;
  return (
    use.broker === null &&
    brokerAccess() === null &&
    current?.apiKey === captured?.apiKey &&
    current?.userId === captured?.userId &&
    current?.sessionId === captured?.sessionId
  );
}

async function ensureProjectSession(use: ComposioConfigUse, signal?: AbortSignal): Promise<ProjectSessionUse> {
  const composio = use.config.composio;
  if (!composio?.apiKey) throw new Error("No Composio project key configured");
  if (composio.sessionId) {
    const existing = await getProjectSession(composio.apiKey, composio.sessionId, signal);
    const upgradeKey = `${use.namespace}:${existing?.session_id ?? composio.sessionId}`;
    if (existing && (supportsMultiAccount(existing) || multiAccountUpgradeAttempted.has(upgradeKey))) {
      return {
        apiKey: composio.apiKey,
        userId: existing.config?.user_id ?? composio.userId,
        session: existing,
      };
    }
  }
  // A missing/deleted session is recreated and its non-secret identifiers are
  // persisted so an edited config/env setup does not recreate it every launch.
  const prepared = await prepareProjectSession(composio.apiKey, composio, { signal });
  multiAccountUpgradeAttempted.add(`${use.namespace}:${prepared.sessionId}`);
  // The index mutation lease makes this branch stable in production. Keep an
  // independent generation fence as defense in depth and for other embedders:
  // a stale A operation may finish, but it cannot write A's Session into B.
  if (selfHostedGenerationIsCurrent(use)) {
    saveConfig({ composio: { userId: prepared.userId, sessionId: prepared.sessionId } });
    const live = use.source.composio;
    if (live) {
      live.userId = prepared.userId;
      live.sessionId = prepared.sessionId;
    }
  }
  const created = await getProjectSession(composio.apiKey, prepared.sessionId, signal);
  if (!created) throw new Error("Composio Session disappeared after creation");
  return {
    apiKey: composio.apiKey,
    userId: created.config?.user_id ?? prepared.userId,
    session: created,
  };
}

export async function mcpIntegration(
  cfg: AppConfig,
  context: IntegrationContext,
): Promise<ComposioMcpIntegration | null> {
  if (!configured(cfg)) return null;
  return {
    command: process.execPath,
    args: [SPAWNED_PROXIES.connectors],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      // The provider-facing bridge receives only this turn's connector
      // capability. It cannot call agent-comms routes or impersonate another
      // bot/thread because identity is bound in the harness registry.
      // Project/broker credentials stay in the harness process, so a coding
      // agent that prints its environment cannot export a durable secret.
      OMB_CONNECTOR_UPSTREAM_URL: `${context.harnessUrl}/api/internal/connectors/mcp`,
      OMB_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: `Bearer ${context.capabilityToken}` }),
      OMB_HARNESS_URL: context.harnessUrl,
      OMB_CONNECTOR_CAPABILITY_TOKEN: context.capabilityToken,
    },
  };
}

export async function relayMcp(
  cfg: AppConfig,
  payload: JsonValue,
  transportSessionId?: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ status: number; bytes: Uint8Array; contentType: string; transportSessionId?: string }> {
  const use = acquireComposioConfigUse(cfg);
  try {
    let url: string;
    const headers = new Headers({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    });
    if (transportSessionId) headers.set("mcp-session-id", transportSessionId);
    if (use.broker) {
      url = `${use.broker.url}/v1/mcp`;
      headers.set("authorization", `Bearer ${use.broker.token}`);
    } else {
      if (!use.config.composio?.apiKey) throw new Error("Connected apps are unavailable");
      const project = await ensureProjectSession(use, options.signal);
      url = project.session.mcp.url;
      headers.set("x-api-key", project.apiKey);
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      redirect: "error",
      signal: composioRequestSignal(10 * 60_000, options.signal),
    });
    const bytes = await readBoundedResponseBytes(
      response,
      MAX_COMPOSIO_MCP_BYTES,
      "Connected-app response exceeded 20 MB",
    );
    return {
      status: response.status,
      bytes,
      contentType: response.headers.get("content-type") ?? "application/json",
      transportSessionId: response.headers.get("mcp-session-id") ?? undefined,
    };
  } finally {
    use.release();
  }
}

async function listConnectedAccounts(
  apiKey: string,
  userId: string,
  slugs: string[],
): Promise<ConnectedAccountResponse[]> {
  const accounts: ConnectedAccountResponse[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  // Five accounts per toolkit can exceed one provider page when a user has
  // many apps. Follow Composio's cursor instead of silently dropping entries.
  for (let page = 0; page < MAX_CONNECTED_ACCOUNT_PAGES; page += 1) {
    const params = new URLSearchParams({
      limit: "50",
      user_ids: userId,
      order_by: "updated_at",
      order_direction: "desc",
    });
    if (slugs.length) params.set("toolkit_slugs", slugs.join(","));
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`${apiBase()}/connected_accounts?${params}`, {
      headers: projectHeaders(apiKey),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(await responseError(response, `Composio accounts: HTTP ${response.status}`));
    const body = connectedAccountsPageSchema.parse(await responseJson(response));
    accounts.push(...body.items);
    const next = body.next_cursor || undefined;
    if (!next || seenCursors.has(next)) return accounts;
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error("Composio account inventory exceeded the pagination safety limit");
}

async function listSessionToolkits(
  apiKey: string,
  sessionId: string,
): Promise<ToolkitItem[]> {
  const toolkits: ToolkitItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CONNECTED_ACCOUNT_PAGES; page += 1) {
    // The unfiltered endpoint contains the entire Composio marketplace and is
    // cursor-paginated in 50-item pages. The Connected tab only needs the
    // user's connected toolkits, so avoid scanning hundreds of unrelated apps.
    const params = new URLSearchParams({ limit: "50", is_connected: "true" });
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(
      `${apiBase()}/tool_router/session/${encodeURIComponent(sessionId)}/toolkits?${params}`,
      { headers: projectHeaders(apiKey), redirect: "error", signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) throw new Error(await responseError(response, `Composio toolkits: HTTP ${response.status}`));
    const body = toolkitPageSchema.parse(await responseJson(response));
    toolkits.push(...(body.items ?? []));
    const next = body.next_cursor || undefined;
    if (!next || seenCursors.has(next)) return toolkits;
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error("Composio toolkit inventory exceeded the pagination safety limit");
}

function summarizeAccounts(accounts: ConnectedAccountResponse[], slugs: string[]) {
  const requested = new Set(slugs.map((slug) => slug.toLowerCase()));
  const bySlug = new Map<string, Array<ConnectedAccountSummary & { updatedAt: string }>>();
  for (const account of accounts) {
    const slug = account.toolkit?.slug?.toLowerCase();
    if (!slug || (requested.size && !requested.has(slug)) || !validAccountId(account.id)) continue;
    const alias = account.alias?.trim() ?? "";
    const summary: ConnectedAccountSummary & { updatedAt: string } = {
      id: account.id,
      status: account.status || "UNKNOWN",
      updatedAt: account.updated_at ?? "",
    };
    if (printableAliasSchema.safeParse(alias).success) summary.alias = alias;
    const list = bySlug.get(slug) ?? [];
    list.push(summary);
    bySlug.set(slug, list);
  }
  for (const list of bySlug.values()) list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return bySlug;
}

function publicAccount({ id, alias, status }: ConnectedAccountSummary): ConnectedAccountSummary {
  const account: ConnectedAccountSummary = { id, status };
  if (alias) account.alias = alias;
  return account;
}

function serviceStateFromAccounts(
  accounts: ConnectedAccountSummary[],
): ConnectorServiceState {
  const active = accounts.find((account) => /^active$/i.test(account.status));
  const pending = accounts.find((account) => /^(initiated|initializing|pending)$/i.test(account.status));
  const selected = active ?? pending ?? accounts[0];
  return {
    connected: Boolean(active),
    pending: Boolean(pending),
    status: selected?.status ?? "not_connected",
    accounts: accounts.map(publicAccount),
  };
}

function allServiceStates(
  accountsBySlug: ReadonlyMap<string, ConnectedAccountSummary[]>,
  toolkits: ToolkitItem[],
): Record<string, ConnectorServiceState> {
  const services = new Map(
    [...accountsBySlug].map(([slug, accounts]) => [slug, serviceStateFromAccounts(accounts)]),
  );
  for (const toolkit of toolkits) {
    const slug = toolkit.slug?.toLowerCase();
    const selected = toolkit.connected_account;
    const selectedId = validAccountId(selected?.id) ? selected.id : undefined;
    if (!slug || (!toolkit.is_no_auth && !selectedId)) continue;
    const existingAccounts = accountsBySlug.get(slug) ?? [];
    const accounts = [...existingAccounts];
    if (selectedId && !accounts.some((account) => account.id === selectedId)) {
      accounts.push({ id: selectedId, status: selected?.status ?? "ACTIVE" });
    }
    const accountState = serviceStateFromAccounts(accounts);
    const status = toolkit.is_no_auth ? "ACTIVE" : selected?.status ?? accountState.status;
    services.set(slug, {
      connected: toolkit.is_no_auth === true || accountState.connected || /^active$/i.test(status),
      pending: accountState.pending || /^(initiated|initializing|pending)$/i.test(status),
      status,
      accounts: accountState.accounts,
    });
  }
  return Object.fromEntries(services);
}

/**
 * Enumerate the user's complete connected-account inventory without depending
 * on marketplace ordering or catalog pagination.
 */
export async function connectedServices(cfg: AppConfig): Promise<Record<string, ConnectorServiceState>> {
  const use = acquireComposioConfigUse(cfg);
  try {
    if (use.broker) {
      const response = await brokerRequest(use.broker, "/v1/connectors/connected");
      if (!response.ok) await throwBrokerError(response, `Connected apps: HTTP ${response.status}`);
      const body = connectorServicesResponseSchema.parse(await responseJson(response));
      return Object.fromEntries(
        Object.entries(body.services ?? {}).map(([slug, state]) => [slug, {
          connected: state.connected,
          pending: state.pending ?? false,
          status: state.status ?? (state.connected ? "ACTIVE" : "not_connected"),
          accounts: state.accounts ?? [],
        }]),
      );
    }
    if (!use.config.composio?.apiKey) throw new Error("Connected apps are unavailable");
    const project = await ensureProjectSession(use);
    if (!project.userId) throw new Error("Composio Session returned no user ID");
    const [toolkits, accounts] = await Promise.all([
      listSessionToolkits(project.apiKey, project.session.session_id),
      // Scoped project keys can grant Session reads without granting the raw
      // connected-account list. The Session still proves which selected/no-auth
      // toolkits belong to this installation, so retain that safe fallback.
      listConnectedAccounts(project.apiKey, project.userId, []).catch(() => []),
    ]);
    return allServiceStates(summarizeAccounts(accounts, []), toolkits);
  } finally {
    use.release();
  }
}

export async function connectionStatus(cfg: AppConfig, slugs: string[]) {
  const use = acquireComposioConfigUse(cfg);
  try {
    if (use.broker || !use.config.composio?.apiKey) {
      const response = await brokerRequest(
        use.broker,
        `/v1/connectors?${new URLSearchParams({ services: slugs.join(",") })}`,
      );
      if (!response.ok) await throwBrokerError(response, `Connected apps: HTTP ${response.status}`);
      const body = connectorServicesResponseSchema.parse(await responseJson(response));
      return body.services ?? {};
    }
    const project = await ensureProjectSession(use);
    const params = new URLSearchParams({ limit: "50" });
    if (slugs.length) params.set("toolkits", slugs.join(","));
    const [res, accounts] = await Promise.all([
      fetch(`${apiBase()}/tool_router/session/${encodeURIComponent(project.session.session_id)}/toolkits?${params}`, {
        headers: projectHeaders(project.apiKey),
        signal: AbortSignal.timeout(15_000),
      }),
      // Session toolkits only include an account once it is usable. Read the
      // account lifecycle too so the UI can distinguish an OAuth flow that is
      // still waiting in the browser from one that expired or failed. Scoped
      // keys may omit connected-account read permission, so this is additive:
      // the normal session result remains the fallback.
      project.userId
        ? listConnectedAccounts(project.apiKey, project.userId, slugs).catch(() => [])
        : Promise.resolve([]),
    ]);
    if (!res.ok) throw new Error(await responseError(res, `Composio toolkits: HTTP ${res.status}`));
    const body = toolkitPageSchema.parse(await responseJson(res));
    const bySlug = new Map((body.items ?? []).map((item) => [item.slug?.toLowerCase(), item]));
    const accountsBySlug = summarizeAccounts(accounts, slugs);
    return Object.fromEntries(
      slugs.map((slug) => {
        const item = bySlug.get(slug.toLowerCase());
        const serviceAccounts = accountsBySlug.get(slug.toLowerCase()) ?? [];
        // Mirror allServiceStates: a scoped key can be denied the raw account
        // list while the Session still names its selected account. Synthesize
        // that account here too, so a status poll never wipes the row the
        // inventory paths render (merge replaces a slug's state wholesale).
        const selected = item?.connected_account;
        const selectedId = validAccountId(selected?.id) ? selected.id : undefined;
        const withSelected = selectedId && !serviceAccounts.some((account) => account.id === selectedId)
          ? [...serviceAccounts, { id: selectedId, status: selected?.status ?? "ACTIVE" }]
          : serviceAccounts;
        const accountState = serviceStateFromAccounts(withSelected);
        const state = item?.connected_account?.status
          ?? (item?.is_no_auth ? "ACTIVE" : accountState.status);
        return [slug, {
          connected: item?.is_no_auth === true || accountState.connected || /^active$/i.test(state),
          pending: accountState.pending || /^(initiated|initializing|pending)$/i.test(state),
          status: state,
          accounts: accountState.accounts,
        }];
      }),
    );
  } finally {
    use.release();
  }
}

/** Backward-compatible service disconnect: removes the Session-selected account. */
export async function removeService(cfg: AppConfig, slug: string) {
  const use = acquireComposioConfigUse(cfg);
  try {
    if (use.broker || !use.config.composio?.apiKey) {
      const response = await brokerRequest(
        use.broker,
        `/v1/connectors/${encodeURIComponent(slug)}`,
        { method: "DELETE" },
      );
      if (!response.ok) await throwBrokerError(response, `Connected apps: HTTP ${response.status}`);
      return removalResponseSchema.parse(await responseJson(response));
    }
    const project = await ensureProjectSession(use);
    const params = new URLSearchParams({ limit: "50", toolkits: slug });
    const list = await fetch(
      `${apiBase()}/tool_router/session/${encodeURIComponent(project.session.session_id)}/toolkits?${params}`,
      { headers: projectHeaders(project.apiKey), redirect: "error", signal: AbortSignal.timeout(15_000) },
    );
    if (!list.ok) throw new Error(await responseError(list, `Composio toolkits: HTTP ${list.status}`));
    const body = toolkitPageSchema.parse(await responseJson(list));
    const id = body.items?.find((item) => item.slug?.toLowerCase() === slug.toLowerCase())?.connected_account?.id;
    if (!id) return { removed: 0 };
    const removed = await fetch(
      `${apiBase()}/connected_accounts/${encodeURIComponent(id)}?revoke_on_delete=true`,
      { method: "DELETE", headers: projectHeaders(project.apiKey), redirect: "error", signal: AbortSignal.timeout(30_000) },
    );
    if (!removed.ok) throw new Error(await responseError(removed, `Composio disconnect: HTTP ${removed.status}`));
    return { removed: 1 };
  } finally {
    use.release();
  }
}

/** Disconnect exactly one account after proving it belongs to this user/toolkit. */
export async function removeAccount(cfg: AppConfig, slug: string, accountId: string) {
  if (!validAccountId(accountId)) throw inputError("Invalid connected-account ID");
  const use = acquireComposioConfigUse(cfg);
  try {
    if (use.broker || !use.config.composio?.apiKey) {
      const response = await brokerRequest(
        use.broker,
        `/v1/connectors/${encodeURIComponent(slug)}/accounts/${encodeURIComponent(accountId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) await throwBrokerError(response, `Connected apps: HTTP ${response.status}`);
      return removalResponseSchema.parse(await responseJson(response));
    }
    const project = await ensureProjectSession(use);
    if (!project.userId) throw new Error("Composio Session has no user ID");
    const accounts = await listConnectedAccounts(project.apiKey, project.userId, [slug]);
    const owned = accounts.some((account) =>
      account.id === accountId && account.toolkit?.slug?.toLowerCase() === slug.toLowerCase()
    );
    if (!owned) return { removed: 0 };
    const removed = await fetch(
      `${apiBase()}/connected_accounts/${encodeURIComponent(accountId)}?revoke_on_delete=true`,
      { method: "DELETE", headers: projectHeaders(project.apiKey), redirect: "error", signal: AbortSignal.timeout(30_000) },
    );
    if (!removed.ok) throw new Error(await responseError(removed, `Composio disconnect: HTTP ${removed.status}`));
    return { removed: 1 };
  } finally {
    use.release();
  }
}

/** Mint a browser auth link for one service. Returns { url } or throws. */
export async function authorizeService(cfg: AppConfig, slug: string, requestedAlias?: string | null) {
  const alias = normalizeAccountAlias(requestedAlias);
  const use = acquireComposioConfigUse(cfg);
  try {
    if (use.broker || !use.config.composio?.apiKey) {
      const request: RequestInit = { method: "POST" };
      if (alias) request.body = JSON.stringify({ alias });
      const response = await brokerRequest(
        use.broker,
        `/v1/connectors/${encodeURIComponent(slug)}/authorize`,
        request,
      );
      if (!response.ok) await throwBrokerError(response, `Connected apps: HTTP ${response.status}`);
      const body = authUrlResponseSchema.parse(await responseJson(response));
      return { url: trustedAuthUrl(body.url, slug) };
    }
    const project = await ensureProjectSession(use);
    if (!project.userId) throw new Error("Composio Session has no user ID");
    // A scoped key may be denied account listing — authorization must still
    // work (it always did pre-multi-account), so the alias guardrails degrade
    // to first-account behavior, the same fallback every inventory path takes.
    const accounts = await listConnectedAccounts(project.apiKey, project.userId, [slug]).catch(() => []);
    const serviceAccounts = accounts.filter((account) => account.toolkit?.slug?.toLowerCase() === slug.toLowerCase());
    const usableAccounts = serviceAccounts.filter((account) => /^(active|initiated|initializing|pending)$/i.test(account.status ?? ""));
    if (usableAccounts.length >= MULTI_ACCOUNT_CONFIG.max_accounts_per_toolkit) {
      throw inputError(`${slug} already has the maximum of ${MULTI_ACCOUNT_CONFIG.max_accounts_per_toolkit} accounts`, 409);
    }
    if (usableAccounts.length > 0 && !alias) {
      throw inputError("Add an account alias so the existing connection is not replaced");
    }
    if (alias && serviceAccounts.some((account) => account.alias?.trim().toLowerCase() === alias.toLowerCase())) {
      throw inputError(`Account alias "${alias}" is already in use for ${slug}`, 409);
    }
    const linkRequest: AccountLinkRequest = { toolkit: slug };
    if (alias) linkRequest.alias = alias;
    const res = await fetch(`${apiBase()}/tool_router/session/${encodeURIComponent(project.session.session_id)}/link`, {
      method: "POST",
      headers: projectHeaders(project.apiKey, true),
      body: JSON.stringify(linkRequest),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(await responseError(res, `Composio authorization: HTTP ${res.status}`));
    const body = linkResponseSchema.parse(await responseJson(res));
    return { url: trustedAuthUrl(body.redirect_url, slug) };
  } finally {
    use.release();
  }
}

// ── marketplace catalog ────────────────────────────────────────────────
export interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  /** Toolkits such as public search need no user authorization. */
  noAuth?: boolean;
  /** used for the client-side favicon fallback when logo is null/broken */
  domain: string | null;
}

// Curated fallback — the services agentcal's connectors page ships plus the
// long marketplace tail. Logos resolve client-side:
// logo → favicon(domain) → monogram.
const CURATED: ToolkitCard[] = [
  { slug: "slack", label: "Slack", blurb: "Post updates and read channels", domain: "slack.com", logo: null },
  { slug: "github", label: "GitHub", blurb: "Issues, pull requests, and code", domain: "github.com", logo: null },
  { slug: "gmail", label: "Gmail", blurb: "Read and send email", domain: "gmail.com", logo: null },
  { slug: "googlecalendar", label: "Google Calendar", blurb: "Read and create events", domain: "calendar.google.com", logo: null },
  { slug: "googlesheets", label: "Google Sheets", blurb: "Read and update spreadsheets", domain: "sheets.google.com", logo: null },
  { slug: "googledocs", label: "Google Docs", blurb: "Read and write documents", domain: "docs.google.com", logo: null },
  { slug: "googledrive", label: "Google Drive", blurb: "Browse and manage files", domain: "drive.google.com", logo: null },
  { slug: "notion", label: "Notion", blurb: "Pages and databases", domain: "notion.so", logo: null },
  { slug: "linear", label: "Linear", blurb: "Issues and project tracking", domain: "linear.app", logo: null },
  { slug: "sentry", label: "Sentry", blurb: "Errors and alerts", domain: "sentry.io", logo: null },
  { slug: "posthog", label: "PostHog", blurb: "Analytics, feature flags, experiments", domain: "posthog.com", logo: null },
  { slug: "discord", label: "Discord", blurb: "Messages and channels", domain: "discord.com", logo: null },
  { slug: "x", label: "X (Twitter)", blurb: "Post and read on X", domain: "x.com", logo: null },
  { slug: "reddit", label: "Reddit", blurb: "Browse and post", domain: "reddit.com", logo: null },
  { slug: "zapier", label: "Zapier", blurb: "Connect 9,000+ apps", domain: "zapier.com", logo: null },
  { slug: "hubspot", label: "HubSpot", blurb: "CRM search & updates", domain: "hubspot.com", logo: null },
  { slug: "salesforce", label: "Salesforce", blurb: "CRM records and reports", domain: "salesforce.com", logo: null },
  { slug: "jira", label: "Jira", blurb: "Issues and sprints", domain: "atlassian.com", logo: null },
  { slug: "asana", label: "Asana", blurb: "Tasks and projects", domain: "asana.com", logo: null },
  { slug: "trello", label: "Trello", blurb: "Boards and cards", domain: "trello.com", logo: null },
  { slug: "dropbox", label: "Dropbox", blurb: "Files and folders", domain: "dropbox.com", logo: null },
  { slug: "airtable", label: "Airtable", blurb: "Bases and records", domain: "airtable.com", logo: null },
  { slug: "figma", label: "Figma", blurb: "Files and comments", domain: "figma.com", logo: null },
  { slug: "stripe", label: "Stripe", blurb: "Payments and customers", domain: "stripe.com", logo: null },
];

const toolkitCaches = new Map<string, { at: number; cards: ToolkitCard[] }>();

/**
 * Marketplace catalog. Tries the v3 toolkits API (official names,
 * descriptions, logos — cached 10 min); falls back to the curated list.
 */
export async function listToolkits(cfg: AppConfig): Promise<{ cards: ToolkitCard[]; source: "api" | "curated" }> {
  const use = acquireComposioConfigUse(cfg);
  try {
    const toolkitCache = toolkitCaches.get(use.namespace);
    if (toolkitCache && Date.now() - toolkitCache.at < 10 * 60_000) {
      return { cards: toolkitCache.cards, source: "api" };
    }
    const backendKey = use.broker ? undefined : use.config.composio?.apiKey;
    if (backendKey || use.broker) {
      try {
        const res = backendKey
          ? await fetch(`${toolkitBase()}/toolkits?limit=500&sort_by=usage`, {
              headers: { "x-api-key": backendKey },
              redirect: "error",
              signal: AbortSignal.timeout(15_000),
            })
          : await brokerRequest(use.broker, "/v1/catalog", { signal: AbortSignal.timeout(15_000) });
        if (res.ok) {
          const json: any = await responseJson(res);
          const items = json.items ?? json.data ?? [];
          if (Array.isArray(items) && items.length) {
            const cards: ToolkitCard[] = items.map((t: any) => ({
              slug: (t.slug ?? t.key ?? t.name ?? "").toLowerCase(),
              label: t.name ?? t.slug ?? "",
              blurb: (t.meta?.description ?? t.description ?? "").slice(0, 90),
              logo: t.meta?.logo ?? t.logo ?? null,
              noAuth: t.no_auth === true,
              domain: null,
            }));
            toolkitCaches.set(use.namespace, { at: Date.now(), cards });
            return { cards, source: "api" };
          }
        }
      } catch {
        /* fall through to curated */
      }
    }
    return { cards: CURATED, source: "curated" };
  } finally {
    use.release();
  }
}

export async function toolkitCard(cfg: AppConfig, slug: string): Promise<ToolkitCard> {
  const normalized = slug.toLowerCase();
  const { cards } = await listToolkits(cfg);
  return cards.find((card) => card.slug.toLowerCase() === normalized)
    ?? CURATED.find((card) => card.slug === normalized)
    ?? {
      slug: normalized,
      label: normalized.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      blurb: "Connect this app so your bot can continue",
      logo: null,
      domain: null,
    };
}

export const CURATED_SLUGS = CURATED.map((c) => c.slug);
