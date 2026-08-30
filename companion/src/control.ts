// The bit a person looks at: a small page on loopback for pairing a device
// and revoking one.
//
// This replaces the Settings → Companion panel that used to live inside the
// desktop app. Losing that panel is the real cost of moving out of the
// harness, and this is the honest replacement rather than a pretence that
// the cost is zero: it is a separate page at a separate address, and you
// have to know it exists.
//
// Loopback only, deliberately and non-negotiably. This surface can open a
// pairing window and revoke devices — it is the thing the companion listener
// refuses to expose to phones for exactly that reason. Serving it anywhere
// else would hand away the control plane the design just took care to
// withhold.
import { createServer, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

import type { DeviceRegistry } from "./devices.ts";
import { companionEndpointCandidates, hostedCompanionUrl } from "./endpoints.ts";
import { lanAddresses, tailnetName, tailscaleAddress } from "./listener.ts";
import { defaultHostName } from "./mdns.ts";

/** What the pairing page needs to render itself and act on what you click. */
export interface ControlOptions {
  devices: DeviceRegistry;
  /** Dedicated companion-control session held only in this sidecar's memory.
   * It is intentionally not the bearer used for upstream harness requests. */
  sessionToken: string;
  /** Where a phone connects — for display, and for the pairing instructions. */
  companionPort: number;
  /** Stable HTTPS route provisioned for this computer, when available. */
  hostedUrl?: () => string | null;
  /** Electron alone uses this to publish a route after its connector health
   * check succeeds, and to withdraw it immediately on connector loss. */
  setHostedUrl?: (url: string | null) => void;
  /** Whether Bonjour came up, and under what name. */
  discovery: () => { advertising: boolean; name: string };
  /** Device ids with at least one live authenticated event stream. */
  connectedDeviceIds?: () => string[];
  /** Terminate every authenticated event stream owned by a revoked device. */
  disconnectDevice?: (deviceId: string) => void;
  /** Terminate pending cloud-desktop joins when that narrower grant is
   * withdrawn, while leaving normal companion traffic alone. */
  disconnectCloudDesktop?: (deviceId: string) => void;
}

/** The host out of a `Host` header, port removed.
 *
 * A bracketed IPv6 literal has colons of its own, so the obvious
 * `split(":")[0]` turns `[::1]:8811` into `[` — which matches no allowlist,
 * and refuses the loopback the browser was handed. A malformed authority
 * comes back unchanged rather than empty, so it fails the check instead of
 * skipping it. */
export function hostOf(authority: string): string {
  if (!authority.startsWith("[")) return authority.split(":")[0].toLowerCase();
  const end = authority.indexOf("]");
  // Only a port may follow the bracket. Without that check `[::1].evil.example`
  // unwraps to `::1` and passes the loopback allowlist — the parser would be
  // the hole rather than the fix.
  const rest = end > 1 ? authority.slice(end + 1) : "";
  const bracketed = end > 1 && (rest === "" || /^:\d+$/.test(rest));
  return (bracketed ? authority.slice(1, end) : authority).toLowerCase();
}

/** The only authorities this server answers to. `[::1]` is in the set as
 * well as `::1` because `new URL()` keeps the brackets on an IPv6 hostname
 * where `hostOf` strips them, and both spellings mean loopback. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Is this `Origin` one this server could plausibly have served itself?
 *
 * Absent counts as yes: a non-browser client — the desktop app, curl, the
 * phone's own app — sends no Origin at all, and those are exactly the callers
 * a CSRF check is not aimed at. Everything else must parse to a loopback
 * hostname. An opaque origin, which is what a sandboxed iframe or a `file://`
 * page sends, arrives as the literal string "null" and does not parse: that is
 * not a pass, it is precisely the shape an attacker reaches for, so it fails
 * with everything else foreign. Parsing rather than prefix-matching is what
 * refuses `https://127.0.0.1.evil.example`, which is not loopback at all.
 *
 * This is the floor, not the whole rule — see the caller, which additionally
 * requires the origin to be *this* server's, not merely some loopback one.
 */
export function originIsLoopback(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Send a JSON body with its length, the only response shape this API has. */
const json = (res: ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

function controlSessionAuthorized(header: string | string[] | undefined, expected: string): boolean {
  if (typeof header !== "string" || header.length < 32 || header.length > 512) return false;
  const supplied = createHash("sha256").update(header).digest();
  const wanted = createHash("sha256").update(expected).digest();
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

interface HostedEndpointPayload {
  url: string | null;
}

/** The control socket is also used by the packaged Electron app, where the
 * sidecar runs directly from its compiled output without a node_modules tree.
 * Keep this tiny wire contract dependency-free and deliberately exact: one
 * own enumerable `url` property, with no silently discarded extras. */
const isHostedEndpointPayload = (value: unknown): value is HostedEndpointPayload => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "url") return false;
  const url = (value as { url?: unknown }).url;
  return url === null || typeof url === "string";
};

const readHostedEndpoint = (
  req: import("node:http").IncomingMessage,
): Promise<HostedEndpointPayload> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4096) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!isHostedEndpointPayload(parsed)) throw new Error("invalid shape");
        resolve(parsed);
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
  });

const currentHostedUrl = (options: ControlOptions): string | null =>
  options.hostedUrl?.() ?? null;

/** Every host a phone could dial for this computer, best first.
 *
 * One address is one point of failure: a phone paired over the tailnet keeps
 * a MagicDNS name that stops resolving the moment either device leaves the
 * tailnet — while the same computer sits reachable on the LAN. Handing the
 * phone the whole ordered list at pairing time is what lets it walk to the
 * next candidate instead of failing forever on the first.
 *
 * The order is the reachability story: the MagicDNS name works from anywhere
 * the tailnet does, the LAN addresses work on this network, and the sidecar's
 * synthetic mDNS name comes last because it only resolves while the sidecar
 * itself is running. The bare tailnet address is deliberately absent — iOS
 * refuses plain HTTP to 100.64/10, so it would be a candidate that can never
 * succeed. */
export function hostCandidates(
  addresses: string[] = lanAddresses(),
  magicDnsName: string | null = tailnetName(),
): string[] {
  const tailscale = tailscaleAddress(addresses);
  const out: string[] = [];
  if (tailscale && magicDnsName) out.push(magicDnsName);
  for (const address of addresses) {
    if (address !== tailscale) out.push(address);
  }
  out.push(defaultHostName());
  return out;
}

/** Everything the page shows, in one object: where to connect, whether a
 * pairing window is open, and which phones are paired. Recomputed per request
 * rather than cached — addresses change when you join another network. */
export function companionState(options: ControlOptions) {
  const addresses = lanAddresses();
  const tailscale = tailscaleAddress(addresses);
  const name = tailnetName();
  const pairing = options.devices.pairing();
  return {
    // Whoever starts this sidecar as a child process needs to be able to tell
    // it apart from an unrelated one that got to the control port first. An
    // answer on the port proves something is listening, not that it is ours.
    pid: process.pid,
    port: options.companionPort,
    addresses,
    ...(tailscale ? { tailscale } : {}),
    ...(tailscale && name ? { tailnetName: name } : {}),
    lan: addresses.find((a) => a !== tailscale) ?? null,
    // The ordered fallback list the pairing QR hands the phone, so it can
    // walk to the next address when the first stops resolving.
    hosts: hostCandidates(addresses, name),
    // Complete URLs for new clients. Unlike `hosts`, this can represent an
    // HTTPS route on its natural port without teaching the client to guess.
    endpoints: companionEndpointCandidates(
      options.companionPort,
      addresses,
      name,
      currentHostedUrl(options),
    ),
    pairing: pairing ? { code: pairing.code, token: pairing.token, expiresAt: pairing.expiresAt } : null,
    devices: options.devices.list(),
    connectedDeviceIds: options.connectedDeviceIds?.() ?? [],
    discovery: options.discovery(),
  };
}

/** The loopback control plane: the page, its state, and the two writes —
 * open a pairing window, revoke a device. Bound to 127.0.0.1 by the caller,
 * and it refuses anything suggesting it was reached from anywhere else. */
export function createControlServer(options: ControlOptions): Server {
  return createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = requestUrl.pathname;
    const method = req.method ?? "GET";

    // Belt and braces: this server binds 127.0.0.1, so a non-loopback Host
    // should be impossible. It is still worth refusing, because "impossible"
    // here rests on a bind argument three files away, and the cost of being
    // wrong is the control plane.
    // An *absent* Host is HTTP/1.0, which has nothing to check and predates
    // the attack. A Host that is present is checked, and that includes one
    // that parses to nothing: a bare `::1` or a lone `:8811` is not a valid
    // authority, and the previous `host && …` guard waved both through for
    // exactly the reason they should have been refused — the parser could
    // make no sense of them, so it declined to have an opinion. Anything
    // unrecognised is refused now, which is the only safe direction for a
    // check whose job is to say no.
    const authority = String(req.headers.host ?? "");
    const host = hostOf(authority);
    if (authority && !LOOPBACK_HOSTS.has(host)) {
      return json(res, 403, { error: "forbidden: loopback only" });
    }

    // The Host check above stops DNS rebinding. It does not stop a page the
    // user happens to be reading from posting here directly: 127.0.0.1 is a
    // real address to a browser, a form POST or a simple fetch to it carries
    // a perfectly correct Host, and neither is preflighted — so CORS never
    // gets a say. That page cannot read the reply, but it does not need to.
    // `POST /pairing` opens a pairing window, and `DELETE /devices/:id`
    // revokes a phone; both do their damage on the way in.
    //
    // Origin is what separates the two callers, and it is the one header page
    // script cannot forge. The page below is served from this server and its
    // writes carry this server's origin, so an origin that both parses to
    // loopback and matches Host — already proven loopback — admits it and
    // nothing else: not a loopback page on some other port, not an opaque
    // "null" origin, not a hostname that merely begins with `127.0.0.1`. Not a
    // blanket refusal, which is what the device proxy can afford: there no
    // legitimate client is a browser at all, and here exactly one is.
    //
    // Safe methods are checked too. Nothing legitimate reads this API
    // cross-origin either, and a check that has to decide which methods
    // change state is a check with a list to keep up to date.
    const origin = req.headers.origin;
    if (origin && !(originIsLoopback(origin) && origin === `http://${authority}`)) {
      return json(res, 403, { error: "forbidden: cross-origin request" });
    }

    if (method === "GET" && (path === "/" || path === "/index.html")) {
      const html = page();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html) });
      return res.end(html);
    }
    if (!controlSessionAuthorized(req.headers["x-openmausbot-session"], options.sessionToken)) {
      return json(res, 401, { error: "the OpenMausBot app session is required" });
    }
    if (method === "GET" && path === "/state") return json(res, 200, companionState(options));
    if (method === "POST" && path === "/pairing") {
      const window = options.devices.openPairing();
      // Keep the freshly issued credentials at the top level as well as in
      // `pairing`, matching the existing code response and making this write
      // sufficient for native control clients that do not immediately poll.
      return json(res, 201, {
        ...companionState(options),
        code: window.code,
        token: window.token,
      });
    }
    if (method === "DELETE" && path === "/pairing") {
      const expectedToken = requestUrl.searchParams.get("expectedToken") ?? undefined;
      options.devices.closePairing(expectedToken);
      return json(res, 200, companionState(options));
    }
    const updateHostedUrl = options.setHostedUrl;
    if (method === "PUT" && path === "/hosted-endpoint" && updateHostedUrl) {
      readHostedEndpoint(req).then(
        (body) => {
          try {
            const requested = body.url == null || body.url === "" ? null : hostedCompanionUrl(body.url);
            updateHostedUrl(requested);
            return json(res, 200, companionState(options));
          } catch {
            return json(res, 400, { error: "invalid hosted endpoint" });
          }
        },
        (error: Error) => json(res, 400, { error: error.message }),
      );
      return;
    }
    const cloudDesktop = path.match(/^\/devices\/([\w-]+)\/cloud-desktop$/);
    if (cloudDesktop && (method === "POST" || method === "DELETE")) {
      try {
        if (!options.devices.setCloudDesktopAccess(cloudDesktop[1], method === "POST")) {
          return json(res, 404, { error: "no such device" });
        }
      } catch {
        return json(res, 500, { error: "could not save cloud desktop access" });
      }
      if (method === "DELETE") options.disconnectCloudDesktop?.(cloudDesktop[1]);
      return json(res, 200, companionState(options));
    }
    const revoke = path.match(/^\/devices\/([\w-]+)$/);
    if (revoke && method === "DELETE") {
      if (!options.devices.revoke(revoke[1])) return json(res, 404, { error: "no such device" });
      options.disconnectDevice?.(revoke[1]);
      return json(res, 200, companionState(options));
    }
    return json(res, 404, { error: `no route: ${method} ${path}` });
  });
}

/** The browser page is informational only. Putting the control bearer in
 * HTML, a cookie, or browser storage would hand it to same-origin script and
 * undo the native-app boundary. All state and mutations live in the desktop
 * app's authenticated Settings surface. */
function page(): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenMausBot Companion</title>
<style>
  :root { color-scheme: light dark; --fg: #111; --dim: #666; --line: #0002; --bg: #fff; --card: #fafafa; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #eee; --dim: #999; --line: #fff2; --bg: #151515; --card: #1e1e1e; }
  }
  body { font: 15px/1.55 ui-sans-serif, system-ui, sans-serif; color: var(--fg); background: var(--bg);
         margin: 0; padding: 2.5rem 1.25rem; }
  main { max-width: 34rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 .35rem; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 12px;
            padding: 1rem 1.15rem; margin-bottom: 1rem; }
  .dim { color: var(--dim); }
</style>
<main>
  <h1>OpenMausBot Companion</h1>
  <section>
    <p>Phone access is running.</p>
    <p class="dim">Open <strong>App Settings → Phone</strong> in the OpenMaus desktop app to pair, remove, or grant cloud-desktop access to a device.</p>
  </section>
</main>
`;
}
