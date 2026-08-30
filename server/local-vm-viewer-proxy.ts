// Isolated-origin gateway for a server-owned loopback noVNC viewer.
//
// Local containers use runtime-assigned loopback ports; VPS desktops use an
// SSH tunnel whose loopback port also lives on the harness host. Returning
// either URL to a remote renderer is incorrect (127.0.0.1 would mean the
// renderer's machine) and unnecessarily exposes the VNC credential. This one
// gateway keeps both upstreams server-side and gives a renderer a short-lived,
// bot-scoped path. server/index.ts serves it only on openmaus-viewer.localhost
// so upstream noVNC JavaScript never shares the app/API origin.
import { randomBytes } from "node:crypto";
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";

const VIEWER_PREFIX = "/api/bots/";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
const DEFAULT_TTL_MS = 8 * 60 * 60_000;
const DEFAULT_LEASE_KEEPALIVE_MS = 5_000;
const DEFAULT_DETACH_GRACE_MS = 2_500;
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

export interface LocalVmViewerBinding {
  botId: string;
  targetKey: string;
  viewerPort: number;
  /** Changes whenever the container/viewer identity changes. */
  generation: string;
  /** Never appears before the URL fragment, so it is not sent over HTTP. */
  password: string;
  /** Bound to the renderer control lease, but never serialized to its URL. */
  controlOwnerId: string;
  controlLeaseToken: string;
}

export interface LocalVmViewerSession extends LocalVmViewerBinding {
  token: string;
  expiresAt: number;
}

export interface LocalVmViewerProxyOptions {
  /** A live control-hold check. It is run for every HTTP and WS attachment. */
  isHeld: (binding: LocalVmViewerBinding) => boolean | Promise<boolean>;
  /** Revalidates target, port, and generation against the current container. */
  isCurrent: (binding: LocalVmViewerBinding) => boolean | Promise<boolean>;
  /** Renew the exact owner/token while an authorized noVNC socket is alive. */
  renewHeld?: (binding: LocalVmViewerBinding) => boolean | Promise<boolean>;
  /** Release the exact owner/token after the final viewer socket is gone. */
  releaseHeld?: (binding: LocalVmViewerBinding) => boolean | Promise<boolean>;
  leaseKeepaliveMs?: number;
  detachGraceMs?: number;
  ttlMs?: number;
  now?: () => number;
  token?: () => string;
}

interface SessionRecord extends LocalVmViewerSession {
  timer: NodeJS.Timeout;
  sockets: Set<Duplex>;
  pending: Set<ClientRequest>;
  keepalives: Set<() => void>;
  detachTimer: NodeJS.Timeout | null;
}

interface ParsedViewerPath {
  botId: string;
  token: string;
  rest: string;
}

function parseViewerPath(pathname: string): ParsedViewerPath | null {
  if (!pathname.startsWith(VIEWER_PREFIX)) return null;
  const match = pathname.match(
    /^\/api\/bots\/([\w-]+)\/local-computer\/viewer\/([A-Za-z0-9_-]{32,})\/(.+)$/,
  );
  if (!match) return null;
  return { botId: match[1], token: match[2], rest: match[3] };
}

function safeViewerAssetPath(rest: string): boolean {
  // noVNC's bundled asset names do not need percent escapes. Refusing every
  // encoded byte avoids one decoder seeing a harmless-looking `%2f`/`%2e`
  // that a later static-file layer turns into a separator or dot segment
  // (including double-encoded and mixed-case variants).
  if (!rest || rest.startsWith("/") || rest.includes("%") || rest.includes("\\") || rest.includes("\0")) {
    return false;
  }
  return !rest.split("/").some((part) => part === ".." || part === ".");
}

function clientHeaders(source: IncomingHttpHeaders, port: number): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = { host: `127.0.0.1:${port}` };
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

function publicResponseHeaders(source: IncomingHttpHeaders): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(source)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "set-cookie" || lower === "location") continue;
    if (value !== undefined) result[lower] = value;
  }
  // A tokenized viewer must never be cached or leak its token through a
  // cross-origin Referer header, even if the bundled noVNC server says less.
  result["cache-control"] = "private, no-store";
  result["referrer-policy"] = "no-referrer";
  result["x-content-type-options"] = "nosniff";
  return result;
}

function websocketRequestHeaders(source: IncomingHttpHeaders, port: number): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {
    host: `127.0.0.1:${port}`,
    connection: "Upgrade",
    upgrade: "websocket",
    // Keep the untrusted browser origin away from websockify. The only
    // reachable upstream is this exact loopback viewer, already selected by
    // an unguessable authorized session.
    origin: `http://127.0.0.1:${port}`,
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
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function serializeUpgradeResponse(response: IncomingMessage): string {
  const lines = [
    `HTTP/${response.httpVersion} ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}`,
  ];
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined || name.toLowerCase() === "set-cookie") continue;
    if (Array.isArray(value)) {
      for (const entry of value) lines.push(`${name}: ${entry}`);
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

export class LocalVmViewerProxy {
  private readonly options: Required<Pick<LocalVmViewerProxyOptions, "isHeld" | "isCurrent">> &
    Pick<LocalVmViewerProxyOptions, "now" | "token" | "renewHeld" | "releaseHeld"> & {
      ttlMs: number;
      leaseKeepaliveMs: number;
      detachGraceMs: number;
    };
  private readonly byToken = new Map<string, SessionRecord>();
  private readonly byBot = new Map<string, string>();

  constructor(options: LocalVmViewerProxyOptions) {
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const leaseKeepaliveMs = options.leaseKeepaliveMs ?? DEFAULT_LEASE_KEEPALIVE_MS;
    const detachGraceMs = options.detachGraceMs ?? DEFAULT_DETACH_GRACE_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("viewer token TTL must be positive");
    if (!Number.isSafeInteger(leaseKeepaliveMs) || leaseKeepaliveMs <= 0) {
      throw new Error("viewer lease keepalive must be positive");
    }
    if (!Number.isSafeInteger(detachGraceMs) || detachGraceMs < 0) {
      throw new Error("viewer detach grace must be non-negative");
    }
    this.options = { ...options, ttlMs, leaseKeepaliveMs, detachGraceMs };
  }

  create(binding: LocalVmViewerBinding): { joinUrl: string; expiresAt: number } {
    if (!/^[\w-]+$/.test(binding.botId)) throw new Error("invalid viewer bot id");
    if (!binding.targetKey || !binding.generation) throw new Error("viewer target identity is required");
    if (!Number.isInteger(binding.viewerPort) || binding.viewerPort < 1 || binding.viewerPort > 65_535) {
      throw new Error("invalid viewer port");
    }

    // Replacing a viewer for the same live lease must close the old token but
    // must not release the authority the replacement is about to use.
    const previous = this.byBot.get(binding.botId);
    if (previous) this.revokeToken(previous, false);
    let token = "";
    do token = (this.options.token ?? (() => randomBytes(32).toString("base64url")))();
    while (this.byToken.has(token));
    if (!TOKEN_PATTERN.test(token)) throw new Error("viewer token must be URL-safe and at least 32 characters");

    const expiresAt = (this.options.now ?? Date.now)() + this.options.ttlMs;
    const record = {
      ...binding,
      token,
      expiresAt,
      sockets: new Set<Duplex>(),
      pending: new Set<ClientRequest>(),
      keepalives: new Set<() => void>(),
      detachTimer: null,
      timer: setTimeout(() => this.revokeToken(token, true), this.options.ttlMs),
    };
    record.timer.unref?.();
    this.byToken.set(token, record);
    this.byBot.set(binding.botId, token);

    const base = `/api/bots/${binding.botId}/local-computer/viewer/${token}`;
    const fragment = new URLSearchParams({
      autoconnect: "true",
      resize: "scale",
      // The viewer is opened only after an exact human-control lease is
      // acquired. Make the intended interactive mode explicit instead of
      // depending on whichever noVNC default ships in a future image.
      view_only: "false",
      password: binding.password,
      // noVNC constructs ws(s)://host/<path>; omit the leading slash.
      path: `${base.slice(1)}/websockify`,
    });
    return { joinUrl: `${base}/vnc.html#${fragment.toString()}`, expiresAt };
  }

  revokeBot(botId: string): void {
    const token = this.byBot.get(botId);
    if (token) this.revokeToken(token, true);
  }

  revokeTarget(targetKey: string): void {
    for (const record of [...this.byToken.values()]) {
      if (record.targetKey === targetKey) this.revokeToken(record.token, true);
    }
  }

  revokeAll(): void {
    for (const token of [...this.byToken.keys()]) this.revokeToken(token, true);
  }

  /** Returns true when this request belonged to the viewer route. */
  async handleHttp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const parsed = parseViewerPath(url.pathname);
    if (!parsed) return false;
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed\n");
      return true;
    }
    if (!safeViewerAssetPath(parsed.rest)) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Bad Request\n");
      return true;
    }
    const record = await this.authorized(parsed);
    if (!record) {
      res.writeHead(403, {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
        "referrer-policy": "no-referrer",
      });
      res.end("Viewer authorization expired\n");
      return true;
    }
    await this.proxyHttp(req, res, url, parsed.rest, record);
    return true;
  }

  /** Returns true when this upgrade belonged to the viewer route. */
  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): Promise<boolean> {
    const parsed = parseViewerPath(url.pathname);
    if (!parsed) return false;
    socket.pause();
    if (req.method !== "GET" || parsed.rest !== "websockify") {
      socketResponse(socket, 400, "Bad Request");
      return true;
    }
    const record = await this.authorized(parsed);
    if (!record) {
      socketResponse(socket, 403, "Forbidden");
      return true;
    }
    this.proxyUpgrade(req, socket, head, record);
    return true;
  }

  private async authorized(parsed: ParsedViewerPath): Promise<SessionRecord | null> {
    const record = this.byToken.get(parsed.token);
    if (!record || record.botId !== parsed.botId) return null;
    if ((this.options.now ?? Date.now)() >= record.expiresAt) {
      this.revokeToken(record.token, true);
      return null;
    }
    try {
      if (!(await this.options.isHeld(record)) || !(await this.options.isCurrent(record))) {
        this.revokeToken(record.token, true);
        return null;
      }
    } catch {
      this.revokeToken(record.token, true);
      return null;
    }
    return this.byToken.get(record.token) === record ? record : null;
  }

  private revokeToken(token: string, releaseLease: boolean): void {
    const record = this.byToken.get(token);
    if (!record) return;
    this.byToken.delete(token);
    if (this.byBot.get(record.botId) === token) this.byBot.delete(record.botId);
    clearTimeout(record.timer);
    if (record.detachTimer) clearTimeout(record.detachTimer);
    for (const pending of record.pending) pending.destroy();
    for (const socket of record.sockets) socket.destroy();
    for (const stop of record.keepalives) stop();
    record.pending.clear();
    record.sockets.clear();
    record.keepalives.clear();
    record.detachTimer = null;
    if (releaseLease && this.options.releaseHeld) {
      // Remove the session first: release can synchronously emit the control
      // revocation callback, which calls revokeBot again.
      void Promise.resolve(this.options.releaseHeld(record)).catch(() => false);
    }
  }

  private proxyHttp(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    rest: string,
    record: SessionRecord,
  ): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const upstream = httpRequest(
        {
          hostname: "127.0.0.1",
          port: record.viewerPort,
          method: req.method,
          path: `/${rest}${url.search}`,
          headers: clientHeaders(req.headers, record.viewerPort),
        },
        (upstreamResponse) => {
          record.pending.delete(upstream);
          if (this.byToken.get(record.token) !== record) {
            upstreamResponse.destroy();
            if (!res.headersSent) res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
            res.end("Viewer authorization expired\n");
            done();
            return;
          }
          res.writeHead(upstreamResponse.statusCode ?? 502, publicResponseHeaders(upstreamResponse.headers));
          upstreamResponse.on("end", done);
          upstreamResponse.on("error", done);
          upstreamResponse.pipe(res);
        },
      );
      record.pending.add(upstream);
      upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy(new Error("viewer upstream timed out")));
      upstream.on("error", () => {
        record.pending.delete(upstream);
        if (!res.headersSent) {
          res.writeHead(502, {
            "cache-control": "no-store",
            "content-type": "text/plain; charset=utf-8",
            "referrer-policy": "no-referrer",
          });
        }
        if (!res.writableEnded) res.end("Viewer upstream unavailable\n");
        done();
      });
      res.on("close", () => {
        if (!res.writableEnded) upstream.destroy();
        done();
      });
      upstream.end();
    });
  }

  private proxyUpgrade(req: IncomingMessage, client: Duplex, head: Buffer, record: SessionRecord): void {
    const upstreamRequest = httpRequest({
      hostname: "127.0.0.1",
      port: record.viewerPort,
      method: "GET",
      path: "/websockify",
      headers: websocketRequestHeaders(req.headers, record.viewerPort),
    });
    record.pending.add(upstreamRequest);
    upstreamRequest.setTimeout(UPSTREAM_TIMEOUT_MS, () =>
      upstreamRequest.destroy(new Error("viewer websocket upstream timed out")),
    );
    upstreamRequest.on("upgrade", async (response, upstream, upstreamHead) => {
      record.pending.delete(upstreamRequest);
      if (this.byToken.get(record.token) !== record) {
        upstream.destroy();
        socketResponse(client, 403, "Forbidden");
        return;
      }
      const stopKeepalive = await startViewerLeaseKeepalive({
        intervalMs: this.options.leaseKeepaliveMs,
        renew: () => this.options.renewHeld?.(record) ?? this.options.isHeld(record),
        onInvalid: () => this.revokeToken(record.token, true),
      });
      if (!stopKeepalive || this.byToken.get(record.token) !== record) {
        upstream.destroy();
        socketResponse(client, 403, "Forbidden");
        return;
      }
      record.keepalives.add(stopKeepalive);
      if (record.detachTimer) {
        clearTimeout(record.detachTimer);
        record.detachTimer = null;
      }
      record.sockets.add(client);
      record.sockets.add(upstream);
      let detached = false;
      const detach = () => {
        if (detached) return;
        detached = true;
        stopKeepalive();
        record.keepalives.delete(stopKeepalive);
        record.sockets.delete(client);
        record.sockets.delete(upstream);
        if (
          record.sockets.size === 0 &&
          this.byToken.get(record.token) === record &&
          record.detachTimer === null
        ) {
          record.detachTimer = setTimeout(() => {
            record.detachTimer = null;
            if (record.sockets.size === 0 && this.byToken.get(record.token) === record) {
              this.revokeToken(record.token, true);
            }
          }, this.options.detachGraceMs);
          record.detachTimer.unref?.();
        }
      };
      const clientGone = () => {
        detach();
        if (!upstream.destroyed) upstream.destroy();
      };
      const upstreamGone = () => {
        detach();
        if (!client.destroyed) client.destroy();
      };
      client.on("end", clientGone);
      client.on("close", clientGone);
      upstream.on("end", upstreamGone);
      upstream.on("close", upstreamGone);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.write(serializeUpgradeResponse(response));
      if (upstreamHead.length) client.write(upstreamHead);
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
      client.resume();
    });
    upstreamRequest.on("response", (response) => {
      record.pending.delete(upstreamRequest);
      socketResponse(client, response.statusCode ?? 502, "WebSocket Upgrade Failed");
      response.destroy();
    });
    upstreamRequest.on("error", () => {
      record.pending.delete(upstreamRequest);
      socketResponse(client, 502, "Bad Gateway");
    });
    upstreamRequest.end();
  }
}

/** Start with a synchronous authorization renewal before the 101 response,
 * then renew for as long as the socket pair remains attached. */
export async function startViewerLeaseKeepalive(options: {
  intervalMs: number;
  renew: () => boolean | Promise<boolean>;
  onInvalid: () => void;
}): Promise<(() => void) | null> {
  let stopped = false;
  let renewing = false;
  const renew = async (): Promise<boolean> => {
    if (stopped) return false;
    try {
      return (await options.renew()) === true;
    } catch {
      return false;
    }
  };
  if (!(await renew())) return null;
  const timer = setInterval(() => {
    if (stopped || renewing) return;
    renewing = true;
    void renew().then((valid) => {
      renewing = false;
      if (!valid && !stopped) {
        stopped = true;
        clearInterval(timer);
        options.onInvalid();
      }
    });
  }, options.intervalMs);
  timer.unref?.();
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
