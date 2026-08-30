#!/usr/bin/env node
// The sidecar, as one command.
//
//   node companion/src/index.ts
//
// Three public/runtime sockets, and one optional private managed origin. The
// split between them is the whole security model:
//
//   :8810  0.0.0.0    devices     token required, allowlisted, scrubbed
//   :8811  127.0.0.1  you         pairing and revocation — never off-machine
//   :8799  127.0.0.1  the harness spoken to as this machine, unmodified
//   UDS/pipe            one Electron-owned sidecar generation, never TCP
//
// 8810 rather than 8800, which is where these started: the harness opens a
// webhook receiver one port above its own, so 8800 is already taken by the
// app this is a sidecar to. Ten clear of the harness leaves it room to add
// another adjacent listener without taking this one out again.
//
// Running this process *is* the opt-in. There is no toggle, because a toggle
// inside a process you chose to start would be ceremony: stopping it is the
// off switch, and it is a more honest one than a flag in a file.
import { createServer, request as httpRequest } from "node:http";
import { chmodSync } from "node:fs";
import { isAbsolute } from "node:path";

import { createAddressWatcher } from "./advertise-watch.ts";
import { createControlServer, hostCandidates } from "./control.ts";
import { createConnectedDeviceTracker } from "./connected-devices.ts";
import { DeviceRegistry } from "./devices.ts";
import { companionEndpointCandidates, hostedCompanionUrl } from "./endpoints.ts";
import { lanAddresses, refreshTailnetName, tailnetName, tailscaleAddress } from "./listener.ts";
import {
  advertisableAddresses,
  clampBytes,
  defaultHostName,
  dnsLabel,
  MdnsResponder,
  type ServiceInfo,
} from "./mdns.ts";
import { createProxyHandler } from "./proxy.ts";
import { companionOriginSocket, listenCompanionOrigin } from "./origin.ts";
import { takeHeadlessSessionTokens } from "./session-token.ts";
import { CompanionLocalVmViewerGateway } from "./local-vm-viewer.ts";

/** A port from the environment, or the default. Anything that is not a whole
 * number in range is the default — a typo'd port must not become port 0. */
const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
};

const HARNESS_PORT = num(process.env.OMB_PORT, 8799);
const WEBHOOK_PORT = num(process.env.OMB_WEBHOOK_PORT, HARNESS_PORT + 1);
const COMPANION_PORT = num(process.env.OMB_COMPANION_PORT, 8810);
const CONTROL_PORT = num(process.env.OMB_CONTROL_PORT, 8811);
const SERVICE_TYPE = "_openmausbot._tcp";
let hostedUrl = hostedCompanionUrl(process.env.OMB_COMPANION_HOSTED_URL);
const PRIVATE_ORIGIN = companionOriginSocket(process.env.OMB_COMPANION_INTERNAL_ORIGIN);

/** A deployment-only backend socket. The advertised TCP port remains the
 * phone-facing endpoint held by systemd-socket-proxyd; this process binds
 * only the protected UDS behind it. Invalid configuration never falls back
 * to TCP, because that would silently discard the OS boundary. */
function deploymentSocket(value: string | undefined, name: string): string | null {
  if (!value) return null;
  if (
    process.platform === "win32" ||
    !isAbsolute(value) ||
    !value.endsWith(".sock") ||
    /[\0\r\n]/.test(value) ||
    Buffer.byteLength(value) > 96
  ) {
    throw new Error(`${name} must be an absolute Unix-socket path ending in .sock`);
  }
  return value;
}

const COMPANION_SOCKET = deploymentSocket(
  process.env.OMB_COMPANION_LISTEN_SOCKET,
  "OMB_COMPANION_LISTEN_SOCKET",
);
const CONTROL_SOCKET = deploymentSocket(
  process.env.OMB_CONTROL_LISTEN_SOCKET,
  "OMB_CONTROL_LISTEN_SOCKET",
);
// Never accept this bearer through argv/env: same-UID provider shells can
// inspect another Linux process's initial environment even after JS deletes
// its copy. Electron delivers it over the utility process's private channel.
delete process.env.OMB_UI_SESSION_TOKEN;
delete process.env.OMB_COMPANION_SESSION_TOKEN;
const HEADLESS_SESSION_TOKENS = takeHeadlessSessionTokens();

type UtilityParentPort = {
  on(event: "message", listener: (event: { data?: unknown }) => void): void;
};

type SessionTokens = { harnessSessionToken: string; controlSessionToken: string };

function validSessionToken(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value.length >= 32 && value.length <= 512 && !/[\r\n]/.test(value);
}

function validatedSessionTokens(
  harnessSessionToken: unknown,
  controlSessionToken: unknown,
): SessionTokens | null {
  if (
    !validSessionToken(harnessSessionToken) ||
    !validSessionToken(controlSessionToken) ||
    harnessSessionToken === controlSessionToken
  ) return null;
  return { harnessSessionToken, controlSessionToken };
}

async function receiveSessionTokens(): Promise<SessionTokens | null> {
  const parentPort = (process as NodeJS.Process & { parentPort?: UtilityParentPort }).parentPort;
  // `pnpm companion` / systemd have no Electron parent port. Their token is
  // read once from a systemd credential (or a strict private file) before
  // any provider subprocess can inherit an environment carrying it.
  if (!parentPort) {
    return validatedSessionTokens(
      HEADLESS_SESSION_TOKENS.harnessSessionToken,
      HEADLESS_SESSION_TOKENS.controlSessionToken,
    );
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: SessionTokens | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    parentPort.on("message", (event) => {
      const message = event?.data as {
        type?: unknown;
        harnessSessionToken?: unknown;
        controlSessionToken?: unknown;
      } | undefined;
      if (message?.type !== "openmausbot:companion-sessions") return;
      finish(validatedSessionTokens(message.harnessSessionToken, message.controlSessionToken));
    });
    setTimeout(() => finish(null), 10_000).unref?.();
  });
}

const SESSION_TOKENS = await receiveSessionTokens();
if (!SESSION_TOKENS) {
  throw new Error(
    "companion needs distinct harness and control sessions from Electron or private systemd credentials",
  );
}
const { harnessSessionToken: HARNESS_SESSION_TOKEN, controlSessionToken: CONTROL_SESSION_TOKEN } = SESSION_TOKENS;

/** Withdraw a paired device's live human-control lease at the same moment as
 * its sidecar grant. The ordinary 15-second lease expiry remains the crash
 * backstop; this makes an explicit click on Revoke immediate. */
function revokeHarnessDesktopLeases(deviceId: string): void {
  if (!/^[\w-]{1,128}$/.test(deviceId)) return;
  const req = httpRequest({
    hostname: "127.0.0.1",
    port: HARNESS_PORT,
    path: `/api/internal/companion-devices/${encodeURIComponent(deviceId)}/computer-control`,
    method: "DELETE",
    headers: { "x-openmausbot-session": HARNESS_SESSION_TOKEN },
    timeout: 2_000,
  }, (res) => res.resume());
  req.on("timeout", () => req.destroy());
  // The grant has already been removed locally. Harness outage falls back to
  // the bounded lease TTL instead of crashing the sidecar control plane.
  req.on("error", () => {});
  req.end();
}

/** Ports the harness takes for itself, and what it uses each for.
 *
 * Checked up front rather than left to EADDRINUSE, because the collision is
 * a race and the loser is whoever started second: bind first and the harness
 * reports its webhook receiver unavailable instead, which surfaces nowhere
 * near here. "Port 8800 is the webhook receiver" is a sentence someone can
 * act on; "address already in use" sends them to `lsof`. */
const HARNESS_PORTS = new Map([
  [HARNESS_PORT, "the harness itself"],
  [WEBHOOK_PORT, "the harness's webhook receiver"],
]);

/** A sentence naming what already owns this port, or null when nothing does. */
const conflict = (name: string, port: number): string | null => {
  const owner = HARNESS_PORTS.get(port);
  return owner ? `${name} is set to port ${port}, which is ${owner}` : null;
};

/** What the phone sees this computer called.
 *
 * Asked of the harness rather than invented here: it already knows whose
 * computer this is, from the profile collected during onboarding, and the
 * built-in companion used exactly this. A phone that paired before the move
 * should not suddenly find a differently-named computer in its list.
 *
 * Read once at startup and cached. An override wins, and a harness that is
 * not up or has no profile falls back rather than blocking — the name is a
 * label, and no part of pairing depends on it. */
let cachedName = process.env.OMB_COMPANION_NAME?.trim() || "";

/** What this computer is called on the phone. Never empty. */
const machineName = (): string => cachedName || "OpenMausBot";

/** Ask the harness whose computer this is, once, at startup. Every failure
 * is survivable: the name is a label, and no part of pairing depends on it. */
async function refreshMachineName(): Promise<void> {
  if (cachedName) return; // an explicit override is not ours to second-guess
  try {
    const res = await fetch(`http://127.0.0.1:${HARNESS_PORT}/api/config`, {
      headers: HARNESS_SESSION_TOKEN ? { "x-openmausbot-session": HARNESS_SESSION_TOKEN } : undefined,
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const config = (await res.json()) as { profile?: { name?: string } };
    const owner = config.profile?.name?.trim();
    if (owner) cachedName = `${owner}'s computer`;
  } catch {
    /* not up, or no profile — "OpenMausBot" is a fine thing to be called */
  }
}

const devices = new DeviceRegistry();
const mdns = new MdnsResponder();

/** Keeps the Bonjour record matching the interface table: advertise when a
 * network appears, re-advertise when DHCP moves us, withdraw when it goes —
 * so `mdns.advertising` stays a true statement rather than a boot-time one. */
const watcher = createAddressWatcher({
  addresses: advertisableAddresses,
  // service() reads the current addresses, so a re-advertise carries them
  advertise: () => mdns.advertise(service()),
  withdraw: () => mdns.stop(),
  log: (line) => console.log(`bonjour: ${line}`),
});

/** This machine as a Bonjour record: one DNS label, the device port, and the
 * addresses a phone could reach it on. */
const service = (): ServiceInfo => ({
  // one DNS label: no dots, and inside the 63-byte limit
  name: dnsLabel(machineName()),
  type: SERVICE_TYPE,
  port: COMPANION_PORT,
  host: defaultHostName(),
  addresses: advertisableAddresses(),
  // TXT entries cap at 255 bytes, and this one is user-supplied — measured in
  // bytes, since that is the unit the wire format actually counts in, and
  // `slice` counts UTF-16 code units.
  txt: ["v=1", `name=${clampBytes(machineName(), 200)}`],
});

const connectedDevices = createConnectedDeviceTracker();
const localVmViewer = new CompanionLocalVmViewerGateway({
  harnessPort: HARNESS_PORT,
  track: (deviceId, terminate) => connectedDevices.openRequest(
    deviceId,
    terminate,
    { cloudDesktop: true },
  ),
});
const proxy = createProxyHandler({
    harnessPort: HARNESS_PORT,
    harnessSessionToken: HARNESS_SESSION_TOKEN || undefined,
    // `authenticate` also stamps lastSeenAt, which is what makes the control
    // page able to say when a phone was last heard from.
    authenticate: (token) => devices.authenticate(token),
    redeem: (code, deviceName, pairRequestId) => devices.redeem(code, deviceName, pairRequestId),
    serverName: machineName,
    // Recomputed per pairing rather than cached: addresses change when the
    // machine joins another network, and a pairing is exactly the moment the
    // list has to be right.
    hosts: () => hostCandidates(),
    endpoints: () => companionEndpointCandidates(COMPANION_PORT, undefined, undefined, hostedUrl),
    connected: connectedDevices.open,
    track: connectedDevices.openRequest,
    localVmViewer,
  });
const deviceHandler = (req: Parameters<typeof proxy>[0], res: Parameters<typeof proxy>[1]) => {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://companion.invalid");
  } catch {
    res.writeHead(400, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
    res.end("Bad Request\n");
    return;
  }
  if (localVmViewer.handleHttp(req, res, url)) return;
  proxy(req, res);
};
const companion = createServer(deviceHandler);
const managedOrigin = PRIVATE_ORIGIN ? createServer(deviceHandler) : null;
const attachViewerUpgrades = (server: ReturnType<typeof createServer>) => {
  server.on("upgrade", (req, socket, head) => {
    if (!localVmViewer.handleUpgrade(req, socket, head)) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  });
};
attachViewerUpgrades(companion);
if (managedOrigin) attachViewerUpgrades(managedOrigin);

const control = createControlServer({
  devices,
  sessionToken: CONTROL_SESSION_TOKEN,
  companionPort: COMPANION_PORT,
  hostedUrl: () => hostedUrl,
  setHostedUrl: (next) => {
    hostedUrl = next;
  },
  discovery: () => ({ advertising: mdns.advertising, name: service().name }),
  connectedDeviceIds: connectedDevices.ids,
  disconnectDevice: (deviceId) => {
    connectedDevices.disconnect(deviceId);
    revokeHarnessDesktopLeases(deviceId);
  },
  disconnectCloudDesktop: (deviceId) => {
    connectedDevices.disconnectCloudDesktop(deviceId);
    revokeHarnessDesktopLeases(deviceId);
  },
});

/** Bind a server, turning a bind failure into a sentence rather than a stack
 * trace, and leaving a handler behind for the errors that come after. */
type ListenTarget = { port: number; host: string } | { socketPath: string; advertisedPort: number };

const listen = (server: ReturnType<typeof createServer>, target: ListenTarget): Promise<void> =>
  new Promise((resolve, reject) => {
    const socketPath = "socketPath" in target ? target.socketPath : null;
    const port = "port" in target ? target.port : target.advertisedPort;
    const label = "socketPath" in target ? target.socketPath : `${target.host}:${target.port}`;
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      // A second copy of the sidecar is the usual cause once the harness's
      // own ports are ruled out above, and "close whatever is using it"
      // sends someone hunting through `lsof` for a process they started.
      const hint = socketPath
        ? ` — remove only this stale socket after proving no companion owns it: ${socketPath}`
        : ` — another copy of the companion may already be running; ${
            port === COMPANION_PORT ? "OMB_COMPANION_PORT" : "OMB_CONTROL_PORT"
          } chooses a different one`;
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`${socketPath ? "socket" : "port"} ${socketPath ?? port} is already in use${hint}`)
          : error,
      );
    };
    const onListening = () => {
      server.removeListener("error", onError);
      if (socketPath) {
        try {
          chmodSync(socketPath, 0o600);
        } catch (error) {
          // A backend socket whose filesystem authority cannot be restricted
          // must not stay reachable through a wider inherited umask.
          server.close();
          reject(error);
          return;
        }
      }
      // Bound is not safe, and removing the startup handler while leaving
      // nothing in its place is how a running sidecar dies later. A listening
      // socket still emits `error` — EMFILE on accept, or an interface
      // disappearing under it — and an `error` with no listener is re-thrown
      // as an uncaught exception, which here means the sidecar dies and every
      // paired phone loses the machine over one refused connection. It is
      // worth a line on stderr and nothing more: the other listener, and
      // every connection on this one, carry on.
      server.on("error", (error: NodeJS.ErrnoException) => {
        console.warn(`companion: error on ${label} — ${error.message}`);
      });
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    if ("socketPath" in target) server.listen(target.socketPath);
    else server.listen(target.port, target.host);
  });

/** Start the three-socket arrangement, in the order that makes a failure
 * legible: refuse impossible ports, bind, learn this machine's name, then
 * advertise and print where to point the phone. */
async function main(): Promise<void> {
  const clash =
    conflict("OMB_COMPANION_PORT", COMPANION_PORT) ?? conflict("OMB_CONTROL_PORT", CONTROL_PORT);
  if (clash) throw new Error(`${clash}. Pick another port.`);

  // The sidecar's own two ports, for the same reason as the harness's: bound
  // in order, the second one loses with a bare EADDRINUSE that reads as
  // "something else is using it" when the something else is this process.
  // Worth naming even though the hosts differ — 127.0.0.1 and 0.0.0.0 on one
  // port collide, and if they somehow did not the control plane would be
  // sharing a socket with the device port, which is the one thing the three
  // sockets exist to prevent.
  if (COMPANION_PORT === CONTROL_PORT) {
    throw new Error(
      `OMB_COMPANION_PORT and OMB_CONTROL_PORT are both port ${COMPANION_PORT}, and they cannot share one: ` +
        `the first is open to your network and the second must never be. Pick another port.`,
    );
  }

  await listen(
    control,
    CONTROL_SOCKET
      ? { socketPath: CONTROL_SOCKET, advertisedPort: CONTROL_PORT }
      : { port: CONTROL_PORT, host: "127.0.0.1" },
  );
  await listen(
    companion,
    COMPANION_SOCKET
      ? { socketPath: COMPANION_SOCKET, advertisedPort: COMPANION_PORT }
      : { port: COMPANION_PORT, host: "0.0.0.0" },
  );
  if (managedOrigin && PRIVATE_ORIGIN) {
    await listenCompanionOrigin(managedOrigin, PRIVATE_ORIGIN);
  }

  // Before advertising: the service name goes into the Bonjour record, and
  // re-advertising under a new name later would show the phone two computers.
  await refreshMachineName();

  // Asking Tailscale costs a subprocess, so it happens once, here, rather
  // than per request. Silent on every failure: not installed, not logged in,
  // not running all just mean "no name", and the address still works.
  const tailscaleTried: string[] = [];
  await refreshTailnetName((cli, outcome) => tailscaleTried.push(`  ${cli} — ${outcome}`)).catch(() => {});

  // Discovery failing is not an error anyone has to fix — port 5353 taken by
  // another responder, multicast off, a guest network that isolates its
  // clients. Pairing by typed address still works, and the control page says
  // so rather than pretending the list will fill in.
  //
  // Through the watcher rather than a single advertise: a laptop opened
  // before wifi associates has no addresses yet, and addresses change under
  // a running sidecar. The first check advertises (or says why not), and the
  // interval re-advertises on every change after that.
  await watcher.check();
  watcher.start();

  const addresses = lanAddresses();
  const tailscale = tailscaleAddress(addresses);
  const reach = tailnetName() ?? tailscale ?? addresses[0];
  console.log(
    `companion  public :${COMPANION_PORT}${COMPANION_SOCKET ? ` via ${COMPANION_SOCKET}` : ""}` +
      `  →  harness 127.0.0.1:${HARNESS_PORT}`,
  );
  console.log(`pair here  public 127.0.0.1:${CONTROL_PORT}${CONTROL_SOCKET ? ` via ${CONTROL_SOCKET}` : ""}`);
  if (reach) console.log(`on your phone, enter  ${reach}:${COMPANION_PORT}`);
  if (tailscale && !tailnetName()) {
    // Do not tell someone to turn on MagicDNS when they may well have it on
    // already — say what was actually tried, so the difference between "off"
    // and "we could not find the CLI" is visible instead of guessed at.
    console.log("no MagicDNS name found. Tailscale CLI attempts:");
    for (const line of tailscaleTried) console.log(line);
  }
}

/** Withdraw the Bonjour record, drop the sockets, exit. Stopping this process
 * is the off switch, so it has to actually stop. */
const shutdown = async (signal: string): Promise<void> => {
  console.log(`\n${signal} — stopping`);
  // the watcher first, or a tick could re-advertise the record the next
  // line just withdrew
  watcher.stop();
  localVmViewer.revokeAll();
  await mdns.stop().catch(() => {});
  // close() waits for open connections, and an SSE stream never ends on its
  // own — drop the sockets so "stop" means stopped, now.
  companion.closeAllConnections?.();
  control.closeAllConnections?.();
  managedOrigin?.closeAllConnections?.();
  await Promise.all([
    new Promise<void>((r) => companion.close(() => r())),
    new Promise<void>((r) => control.close(() => r())),
    ...(managedOrigin ? [new Promise<void>((r) => managedOrigin.close(() => r()))] : []),
  ]);
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
