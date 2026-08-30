// Revocable phone gateway for the harness-owned Local VM viewer.
//
// The harness deliberately publishes its noVNC surface only on the isolated
// `openmaus-viewer.localhost` origin. That origin and its token mean the
// Razer/server to a desktop renderer; neither is reachable from a phone. This
// gateway exchanges that internal bearer for a second random token bound to
// the authenticated companion device, bot, and VM generation. Only the
// second token crosses the phone boundary. Device revoke/capability removal
// closes every pending request and websocket and destroys the mapping.
import { createHash, randomBytes } from "node:crypto";
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";

const VIEWER_HOST = "openmaus-viewer.localhost";
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const ID = /^[\w-]{1,128}$/;
const GENERATION = /^[A-Za-z0-9._:-]{8,256}$/;
const MAX_SESSIONS_PER_DEVICE = 2;
const MAX_SESSIONS_GLOBAL = 32;
const MAX_TRANSPORTS_PER_SESSION = 24;
const MAX_TRANSPORTS_GLOBAL = 128;
const CONNECT_DEADLINE_MS = 60_000;
const DETACH_GRACE_MS = 2_500;
const MAX_SESSION_MS = 8 * 60 * 60_000;
const UPSTREAM_TIMEOUT_MS = 15_000;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface CompanionLocalVmViewerOptions {
  harnessPort: number;
  /** Reserve one long-lived, cloud-desktop-scoped device request. The shipped
   * tracker terminates this callback on device revoke or capability removal. */
  track: (deviceId: string, terminate: () => void) => (() => void) | null;
  now?: () => number;
  token?: () => string;
}

export interface LocalVmJoinPayload {
  joinUrl: string;
  expiresAt: number;
  viewerGeneration: string;
  [key: string]: unknown;
}

export type LocalVmViewerRegistration =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; status: number; error: string };

interface ViewerSession {
  botId: string;
  deviceId: string;
  generation: string;
  generationTag: string;
  publicToken: string;
  upstreamToken: string;
  password: string;
  expiresAt: number;
  connectTimer: NodeJS.Timeout;
  expiryTimer: NodeJS.Timeout;
  detachTimer: NodeJS.Timeout | null;
  releaseTrack: (() => void) | null;
  pending: Set<ClientRequest>;
  sockets: Set<Duplex>;
  activeTransports: number;
  websocketOpen: boolean;
}

interface ParsedPublicPath {
  botId: string;
  generationTag: string;
  token: string;
  rest: string;
}

function parsePublicPath(pathname: string): ParsedPublicPath | null {
  const match = pathname.match(
    /^\/api\/bots\/([\w-]+)\/phone-local-computer\/viewer\/([A-Za-z0-9_-]{16})\/([A-Za-z0-9_-]{32,128})\/(.+)$/,
  );
  return match
    ? { botId: match[1], generationTag: match[2], token: match[3], rest: match[4] }
    : null;
}

function safeAssetPath(rest: string): boolean {
  if (!rest || rest.startsWith("/") || rest.includes("%") || rest.includes("\\") || rest.includes("\0")) {
    return false;
  }
  return !rest.split("/").some((part) => part === "." || part === "..");
}

function publicHeaders(source: IncomingHttpHeaders): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(source)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "set-cookie" || lower === "location") continue;
    if (value !== undefined) result[lower] = value;
  }
  result["cache-control"] = "private, no-store";
  result["cdn-cache-control"] = "no-store";
  result["cloudflare-cdn-cache-control"] = "no-store";
  result["referrer-policy"] = "no-referrer";
  result["x-content-type-options"] = "nosniff";
  return result;
}

function assetRequestHeaders(source: IncomingHttpHeaders, port: number): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = { host: `${VIEWER_HOST}:${port}` };
  for (const name of [
    "accept",
    "accept-encoding",
    "accept-language",
    "cache-control",
    "if-modified-since",
    "if-none-match",
    "range",
    "user-agent",
  ]) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function websocketHeaders(source: IncomingHttpHeaders, port: number): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {
    host: `${VIEWER_HOST}:${port}`,
    connection: "Upgrade",
    upgrade: "websocket",
    origin: `http://${VIEWER_HOST}:${port}`,
  };
  for (const name of [
    "sec-websocket-extensions",
    "sec-websocket-key",
    "sec-websocket-protocol",
    "sec-websocket-version",
    "user-agent",
  ]) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function socketResponse(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\n` +
      "Connection: close\r\n" +
      "Cache-Control: no-store\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function serializeUpgrade(response: IncomingMessage): string {
  const lines = [
    `HTTP/${response.httpVersion} ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}`,
  ];
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined || name.toLowerCase() === "set-cookie") continue;
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`);
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function parseInternalJoin(botId: string, value: unknown): {
  upstreamToken: string;
  password: string;
  expiresAt: number;
  generation: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Partial<LocalVmJoinPayload>;
  if (
    typeof body.joinUrl !== "string" ||
    body.joinUrl.length > 4_096 ||
    !body.joinUrl.startsWith("/") ||
    body.joinUrl.startsWith("//") ||
    typeof body.expiresAt !== "number" ||
    !Number.isFinite(body.expiresAt) ||
    typeof body.viewerGeneration !== "string" ||
    !GENERATION.test(body.viewerGeneration)
  ) return null;
  let url: URL;
  try {
    url = new URL(body.joinUrl, "http://viewer.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "http://viewer.invalid" || url.search || url.username || url.password) return null;
  const match = url.pathname.match(
    new RegExp(`^/api/bots/${botId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/local-computer/viewer/([A-Za-z0-9_-]{32,128})/vnc\\.html$`),
  );
  if (!match) return null;
  const fragment = new URLSearchParams(url.hash.slice(1));
  const expectedSocket = `api/bots/${botId}/local-computer/viewer/${match[1]}/websockify`;
  const password = fragment.get("password") ?? "";
  if (
    fragment.get("path") !== expectedSocket ||
    !password ||
    password.length > 512 ||
    /[\0\r\n]/.test(password)
  ) return null;
  return {
    upstreamToken: match[1],
    password,
    expiresAt: body.expiresAt,
    generation: body.viewerGeneration,
  };
}

export class CompanionLocalVmViewerGateway {
  private readonly options: CompanionLocalVmViewerOptions;
  private readonly now: () => number;
  private readonly mintToken: () => string;
  private readonly byToken = new Map<string, ViewerSession>();
  private readonly byDeviceBot = new Map<string, string>();
  private readonly perDevice = new Map<string, number>();
  private activeTransports = 0;

  constructor(options: CompanionLocalVmViewerOptions) {
    if (!Number.isInteger(options.harnessPort) || options.harnessPort < 1 || options.harnessPort > 65_535) {
      throw new Error("invalid harness port for phone Local VM viewer");
    }
    this.options = options;
    this.now = options.now ?? Date.now;
    this.mintToken = options.token ?? (() => randomBytes(32).toString("base64url"));
  }

  /** Exchange the loopback viewer capability for a companion-scoped one.
   * `payload` has already passed the normal response scrubber. */
  register(deviceId: string, botId: string, payload: unknown): LocalVmViewerRegistration {
    if (!ID.test(deviceId) || !ID.test(botId)) {
      return { ok: false, status: 403, error: "the paired viewer identity is invalid" };
    }
    const parsed = parseInternalJoin(botId, payload);
    if (!parsed) {
      return { ok: false, status: 502, error: "OpenMausBot returned an invalid Local VM viewer" };
    }
    const now = this.now();
    if (parsed.expiresAt <= now) {
      return { ok: false, status: 409, error: "the Local VM viewer expired before it could be opened" };
    }
    const existingKey = `${deviceId}\0${botId}`;
    const previous = this.byDeviceBot.get(existingKey);
    if (previous) this.revoke(previous);
    if (
      (this.perDevice.get(deviceId) ?? 0) >= MAX_SESSIONS_PER_DEVICE ||
      this.byToken.size >= MAX_SESSIONS_GLOBAL
    ) {
      return { ok: false, status: 429, error: "too many phone desktop viewers are already open" };
    }

    let publicToken = "";
    do publicToken = this.mintToken(); while (this.byToken.has(publicToken));
    if (!TOKEN.test(publicToken)) {
      return { ok: false, status: 500, error: "could not mint a safe phone viewer token" };
    }
    const generationTag = createHash("sha256")
      .update(`${botId}\0${parsed.generation}`)
      .digest("base64url")
      .slice(0, 16);
    const expiresAt = Math.min(parsed.expiresAt, now + MAX_SESSION_MS);
    let session!: ViewerSession;
    const releaseTrack = this.options.track(deviceId, () => this.revoke(publicToken));
    if (!releaseTrack) {
      return { ok: false, status: 429, error: "too many phone requests are already active" };
    }
    session = {
      botId,
      deviceId,
      generation: parsed.generation,
      generationTag,
      publicToken,
      upstreamToken: parsed.upstreamToken,
      password: parsed.password,
      expiresAt,
      connectTimer: setTimeout(() => this.revoke(publicToken), CONNECT_DEADLINE_MS),
      expiryTimer: setTimeout(() => this.revoke(publicToken), Math.max(1, expiresAt - now)),
      detachTimer: null,
      releaseTrack,
      pending: new Set(),
      sockets: new Set(),
      activeTransports: 0,
      websocketOpen: false,
    };
    session.connectTimer.unref?.();
    session.expiryTimer.unref?.();
    this.byToken.set(publicToken, session);
    this.byDeviceBot.set(existingKey, publicToken);
    this.perDevice.set(deviceId, (this.perDevice.get(deviceId) ?? 0) + 1);

    const base = `/api/bots/${botId}/phone-local-computer/viewer/${generationTag}/${publicToken}`;
    const fragment = new URLSearchParams({
      autoconnect: "true",
      resize: "scale",
      // noVNC's VNC challenge needs this in the fragment. Fragments are not
      // sent in HTTP requests, referrers are disabled, and this ephemeral
      // WebKit view is non-persistent. The internal viewer token/port remain
      // server-side and are never returned.
      password: parsed.password,
      path: `${base.slice(1)}/websockify`,
    });
    const safePayload = { ...(payload as Record<string, unknown>) };
    delete safePayload.viewerGeneration;
    safePayload.joinUrl = `${base}/vnc.html#${fragment.toString()}`;
    safePayload.expiresAt = expiresAt;
    safePayload.viewerKind = "local-vm";
    return { ok: true, payload: safePayload };
  }

  /** True means this path belonged to the gateway, including invalid tokens. */
  handleHttp(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    const parsed = parsePublicPath(url.pathname);
    if (!parsed) return false;
    if ((req.method !== "GET" && req.method !== "HEAD") || !safeAssetPath(parsed.rest)) {
      res.writeHead(400, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
      res.end("Bad Request\n");
      return true;
    }
    const session = this.authorized(parsed);
    if (!session) {
      res.writeHead(403, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
      res.end("Viewer authorization expired\n");
      return true;
    }
    if (!this.acquireTransport(session)) {
      res.writeHead(429, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
      res.end("Too Many Requests\n");
      return true;
    }
    this.proxyHttp(req, res, url, parsed.rest, session);
    return true;
  }

  /** True means this websocket path belonged to the gateway. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://companion.invalid");
    } catch {
      return false;
    }
    const parsed = parsePublicPath(url.pathname);
    if (!parsed) return false;
    socket.pause();
    const session = this.authorized(parsed);
    if (
      req.method !== "GET" ||
      parsed.rest !== "websockify" ||
      !session ||
      session.websocketOpen ||
      !this.acquireTransport(session)
    ) {
      socketResponse(socket, session?.websocketOpen ? 409 : session ? 429 : 403, "Forbidden");
      return true;
    }
    session.websocketOpen = true;
    clearTimeout(session.connectTimer);
    if (session.detachTimer) {
      clearTimeout(session.detachTimer);
      session.detachTimer = null;
    }
    this.proxyUpgrade(req, socket, head, session);
    return true;
  }

  revokeAll(): void {
    for (const token of [...this.byToken.keys()]) this.revoke(token);
  }

  private authorized(parsed: ParsedPublicPath): ViewerSession | null {
    const session = this.byToken.get(parsed.token);
    if (
      !session ||
      session.botId !== parsed.botId ||
      session.generationTag !== parsed.generationTag
    ) return null;
    if (this.now() >= session.expiresAt) {
      this.revoke(session.publicToken);
      return null;
    }
    return session;
  }

  private acquireTransport(session: ViewerSession): boolean {
    if (
      session.activeTransports >= MAX_TRANSPORTS_PER_SESSION ||
      this.activeTransports >= MAX_TRANSPORTS_GLOBAL
    ) return false;
    session.activeTransports += 1;
    this.activeTransports += 1;
    return true;
  }

  private releaseTransport(session: ViewerSession): void {
    if (session.activeTransports <= 0) return;
    session.activeTransports -= 1;
    this.activeTransports = Math.max(0, this.activeTransports - 1);
  }

  private revoke(token: string): void {
    const session = this.byToken.get(token);
    if (!session) return;
    this.byToken.delete(token);
    const key = `${session.deviceId}\0${session.botId}`;
    if (this.byDeviceBot.get(key) === token) this.byDeviceBot.delete(key);
    const nextCount = Math.max(0, (this.perDevice.get(session.deviceId) ?? 1) - 1);
    if (nextCount) this.perDevice.set(session.deviceId, nextCount);
    else this.perDevice.delete(session.deviceId);
    clearTimeout(session.connectTimer);
    clearTimeout(session.expiryTimer);
    if (session.detachTimer) clearTimeout(session.detachTimer);
    for (const pending of session.pending) pending.destroy();
    for (const socket of session.sockets) socket.destroy();
    session.pending.clear();
    session.sockets.clear();
    this.activeTransports = Math.max(0, this.activeTransports - session.activeTransports);
    session.activeTransports = 0;
    session.websocketOpen = false;
    const release = session.releaseTrack;
    session.releaseTrack = null;
    release?.();
  }

  private upstreamPath(session: ViewerSession, rest: string, search = ""): string {
    return `/api/bots/${session.botId}/local-computer/viewer/${session.upstreamToken}/${rest}${search}`;
  }

  private proxyHttp(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    rest: string,
    session: ViewerSession,
  ): void {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.releaseTransport(session);
    };
    const upstream = httpRequest({
      hostname: "127.0.0.1",
      port: this.options.harnessPort,
      method: req.method,
      path: this.upstreamPath(session, rest, url.search),
      headers: assetRequestHeaders(req.headers, this.options.harnessPort),
    }, (response) => {
      session.pending.delete(upstream);
      if (this.byToken.get(session.publicToken) !== session) {
        response.destroy();
        if (!res.headersSent) res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("Viewer authorization expired\n");
        release();
        return;
      }
      res.writeHead(response.statusCode ?? 502, publicHeaders(response.headers));
      response.on("end", release);
      response.on("error", release);
      response.pipe(res);
    });
    session.pending.add(upstream);
    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy(new Error("viewer upstream timed out")));
    upstream.on("error", () => {
      session.pending.delete(upstream);
      if (!res.headersSent) {
        res.writeHead(502, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
      }
      if (!res.writableEnded) res.end("Viewer upstream unavailable\n");
      release();
    });
    res.on("close", () => {
      if (!res.writableEnded) upstream.destroy();
      release();
    });
    upstream.end();
  }

  private proxyUpgrade(req: IncomingMessage, client: Duplex, head: Buffer, session: ViewerSession): void {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      session.websocketOpen = false;
      this.releaseTransport(session);
      if (this.byToken.get(session.publicToken) === session && !session.detachTimer) {
        session.detachTimer = setTimeout(() => this.revoke(session.publicToken), DETACH_GRACE_MS);
        session.detachTimer.unref?.();
      }
    };
    const upstreamRequest = httpRequest({
      hostname: "127.0.0.1",
      port: this.options.harnessPort,
      method: "GET",
      path: this.upstreamPath(session, "websockify"),
      headers: websocketHeaders(req.headers, this.options.harnessPort),
    });
    session.pending.add(upstreamRequest);
    upstreamRequest.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstreamRequest.destroy(new Error("viewer websocket timed out")));
    upstreamRequest.on("upgrade", (response, upstream, upstreamHead) => {
      session.pending.delete(upstreamRequest);
      if (this.byToken.get(session.publicToken) !== session) {
        upstream.destroy();
        socketResponse(client, 403, "Forbidden");
        release();
        return;
      }
      session.sockets.add(client);
      session.sockets.add(upstream);
      const clientGone = () => {
        session.sockets.delete(client);
        session.sockets.delete(upstream);
        if (!upstream.destroyed) upstream.destroy();
        release();
      };
      const upstreamGone = () => {
        session.sockets.delete(client);
        session.sockets.delete(upstream);
        if (!client.destroyed) client.destroy();
        release();
      };
      client.on("end", clientGone);
      client.on("close", clientGone);
      upstream.on("end", upstreamGone);
      upstream.on("close", upstreamGone);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.write(serializeUpgrade(response));
      if (upstreamHead.length) client.write(upstreamHead);
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
      client.resume();
    });
    upstreamRequest.on("response", (response) => {
      session.pending.delete(upstreamRequest);
      socketResponse(client, response.statusCode ?? 502, "WebSocket Upgrade Failed");
      response.destroy();
      release();
    });
    upstreamRequest.on("error", () => {
      session.pending.delete(upstreamRequest);
      socketResponse(client, 502, "Bad Gateway");
      release();
    });
    upstreamRequest.end();
  }
}
