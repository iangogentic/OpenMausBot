# Remote client deployment

OpenMaus can run in two pieces:

1. An always-on Linux host runs the harness, provider CLIs, bot database,
   phone companion, and virtual computers.
2. A lightweight macOS or Windows app renders that server and, while running,
   may attach its physical desktop through an attended outbound connection.

On macOS, the red window button hides OpenMausBot and leaves a persistent
menu-bar item: notifications and the attended Mac bridge remain active in the
background. **OpenMausBot → Quit** (or the menu-bar **Quit and disconnect this
computer** action) removes the physical Mac from the server. Either operation
leaves server-side turns, routines, and virtual computers running. Windows
currently quits and disconnects when its last window closes.

## Security boundary

Bind the harness and companion ports to loopback. The desktop app owns its
ephemeral loopback listeners and carries every accepted connection through
the system OpenSSH client with strict host-key pinning. Two independent raw bearers exist only in the
client's private `remote-client.json`: the harness receives only the SHA-256
digest of the UI bearer, while the companion receives root-owned systemd
credentials for upstream harness access and its separate pairing-control API.

A hostile provider shell must not share the harness Unix identity. File
permissions do not isolate two processes with the same UID: a provider could
otherwise signal the harness, inspect `/proc`, or race to bind its control
port. The production units therefore use three accounts:

- `openmaus-server`: harness and server-owned data;
- `openmaus-provider`: model/provider CLIs and their MCP children;
- `openmaus-companion`: phone companion.

`OMB_REQUIRE_PROVIDER_ISOLATION=1` makes provider launch fail closed unless a
root-owned identity-hop launcher is configured. Only the bot workspace root
is shared through `openmaus-workspace`; the release, server data, session
digest, credential store, and service definitions are not provider-readable
or writable. Do not deploy the remote harness as the old shared `ian` user.

## Server

Build and publish an immutable release under `/opt/openmausbot`; follow
[`deploy/razer-remote/README.md`](../deploy/razer-remote/README.md) for the
accounts, launcher, sudoers rule, system units, migration, and acceptance
checks. The harness listens on `127.0.0.1:8799`; companion control listens on
`127.0.0.1:8811`.

Generate two independent bearers on the client: one for the harness UI/API and
one for companion pairing control. Run this command twice and do not reuse the
first output as the second:

```sh
node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))'
```

Compute only the UI bearer's digest for the harness:

```sh
printf %s 'PASTE_THE_SAME_TOKEN' | shasum -a 256
```

Transfer each raw value separately through SSH stdin into the companion's
root-only credential store; neither may land in a provider-readable home
directory or unit `Environment=` line:

```sh
ssh user@server-tailnet-name 'sudo install -d -m 0700 -o root -g root /etc/credstore && \
  sudo sh -c "umask 077; cat > /etc/credstore/openmausbot-ui-session" && \
  sudo chown root:root /etc/credstore/openmausbot-ui-session && \
  sudo chmod 0400 /etc/credstore/openmausbot-ui-session'
# Paste the token, then press Ctrl-D.
```

Repeat that transfer for the companion-only token, changing the destination
filename to `/etc/credstore/openmausbot-companion-session`.

The harness drop-in contains only the 64-hex digest:

```ini
[Service]
Environment="OMB_UI_SESSION_TOKEN_SHA256=<digest>"
```

The companion unit uses:

```ini
LoadCredential=openmausbot-ui-session:/etc/credstore/openmausbot-ui-session
LoadCredential=openmausbot-companion-session:/etc/credstore/openmausbot-companion-session
```

The first credential is used only for the companion's upstream requests to
the harness. The second is used only by the desktop app against companion
control. Supplying the UI bearer to companion control is rejected.

## App-owned pinned SSH

Do not pre-bind `18799`/`8811` with an external `ssh -L` process. A fixed
caller-managed loopback port is not server identity: if that tunnel is absent,
another process could bind the port, receive a bearer, and serve privileged
HTML. These legacy origins are rejected.

Instead, copy the Razer host's public SSH host key through an already trusted
console or an independently verified channel. On the Razer, the Ed25519 value
is normally available with:

```sh
sudo cat /etc/ssh/ssh_host_ed25519_key.pub
```

The public key is not a password, but its authenticity matters. Do not trust
an unverified `ssh-keyscan` result from the same network path it is meant to
authenticate.

At launch, the app exclusively binds unpredictable loopback ports and writes a
temporary known-hosts file containing only this pin. Every browser/API/
WebSocket connection is sent through a fixed `ssh -W 127.0.0.1:<target>`
process using `StrictHostKeyChecking=yes`, `BatchMode=yes`, and no user SSH
config. If SSH or the Razer is unavailable, that app-owned connection closes;
it never falls through to another loopback listener. There is no reverse CUA
port.

## Client configuration

Place `remote-client.json` in the remote app's Electron user-data directory:

```json
{
  "mode": "remote",
  "serverName": "Razer",
  "companion": true,
  "ssh": {
    "host": "razer.your-tailnet.ts.net",
    "user": "ian",
    "port": 22,
    "hostPublicKey": "ssh-ed25519 AAAA..."
  },
  "sessionToken": "PASTE_THE_UI_TOKEN_GENERATED_ABOVE",
  "companionSessionToken": "PASTE_THE_DIFFERENT_COMPANION_TOKEN_GENERATED_ABOVE"
}
```

The app uses the normal SSH agent/default identity. If necessary, add an
absolute `identityFile` inside `ssh`; on POSIX it must be owner-only, regular,
and not a symlink. Windows requires the OpenSSH agent/default identity and
rejects `identityFile` until native handle-bound ACL validation is available.

Older configs without `companionSessionToken` fail closed with a setup error;
the app never derives it from `sessionToken`. Generate and provision a fresh
independent value as described above.

On macOS/Linux, make it owner-only before launch:

```sh
chmod 600 'remote-client.json'
```

The app opens and reads the same checked file handle, rejecting symlink-swap
races, non-regular or oversized files, foreign ownership, and group/world-
readable POSIX modes. On Windows it replaces the ACL with a SID-based rule for
only the current process identity and verifies that exact ACL before opening;
failure is fatal. Never copy this file to the Linux server.

URL and environment overrides are deliberately unsupported in remote mode;
they would bypass app ownership and host-key identity.

Build the Apple-silicon remote app with:

```sh
corepack pnpm package:remote:mac
```

The result is `release-remote/mac-arm64/OpenMaus Razer.app`. Build the Windows
x64 installer on Windows with:

```powershell
corepack pnpm package:remote:win
```

The remote package includes the pinned local CUA runtime but no harness,
database, provider credentials, or companion listener.

## Physical Mac/Windows bridge

There is no bridge token, descriptor, proxy command, or listening/reverse
port. Electron main opens one authenticated outbound WebSocket through the
app-owned pinned SSH origin using `x-openmausbot-session`. The bearer is never
sent to an arbitrary pre-existing loopback listener. The server keeps only an
in-memory registration bound to the exact platform and CUA executor generation.

For each provider turn, the provider receives one opaque, turn-scoped
capability and a tiny stdio MCP broker. The server validates the live turn,
target `physical:host`, registration ID, executor generation, and normal
`ComputerControl` action ticket before relaying any `tools/call`. A human
takeover therefore blocks actions even after **Always Allow While App Is
Open** was selected.

Before spawning a local CUA MCP child, the client shows:

- **Deny**
- **Allow Once**
- **Always Allow While App Is Open**

The dialog identifies the server-authenticated bot and exact session; this
identity is supplied by the turn capability, never by renderer JavaScript.

The decision window is bounded at two minutes and cancellable. After approval,
the client obtains a fresh server `spawn` proof before creating the child, so
a cancellation or replacement that raced the dialog spawns nothing. App
disconnect, registration replacement, turn end, executor-generation change,
transport failure, and shutdown close and force-reap the exact children.

The old `macBridge`/`deviceBridge` config fields are ignored. The old
`mac-bridge-token`, `device-bridge-token`, reverse-port listeners, stdio
proxies, and Linux remote descriptors are retired and fail closed. The client
removes its legacy token files during migration; delete matching legacy token,
descriptor, and proxy files from the server before acceptance.

## What survives a hidden or quit client

- server-side bot turns and routines;
- conversations and bot configuration;
- provider CLI sessions and model endpoints;
- companion and virtual-computer services.

Physical-device control survives a hidden macOS window while its menu-bar
indicator is present. It does not survive an actual app quit. Mac-only
dictation likewise requires the Mac app process.
