# Remote client deployment

OpenMaus can run in two pieces:

1. An always-on Linux host runs the harness server, provider CLIs, bot database, companion service, and virtual computers.
2. A lightweight macOS app renders that server. It does not start a second harness or copy provider credentials to the Mac.

Closing the Mac app does not stop work on the Linux host. The client checks server health and reloads itself after a service restart or temporary tunnel failure.

## Security boundary

Keep the harness and companion control ports bound to loopback on the server. Carry them through an encrypted SSH tunnel or put an HTTPS reverse proxy with authentication in front of the harness. The client rejects cleartext HTTP origins unless they are loopback addresses.

The bot runtime and the computer-control destination are separate. The harness, model CLI, shell, files, conversations, and routines stay on the Linux server. A bot can independently target a server-hosted Local VM, an external cloud computer, the physical Mac, or no graphical computer. For an always-on deployment, explicitly select the server-hosted Local VM instead of leaving the bot on Auto: Auto may fall back to the physical Mac when no cloud box exists.

Physical-Mac control is optional and uses a separate loopback-only, authenticated, approval-gated bridge. The Linux server cannot reach it when the Mac app, Mac, or SSH tunnel is offline.

## Server

Run the normal OpenMaus services on the Linux machine. A typical user service starts the harness on `127.0.0.1:8799`; the companion control plane listens on `127.0.0.1:8811`.

Verify both before connecting a client:

```sh
curl -fsS http://127.0.0.1:8799/api/health
curl -fsS http://127.0.0.1:8811/state
```

## Mac tunnel

Forward local ports to the server over SSH:

```sh
ssh -NT \
  -L 18799:127.0.0.1:8799 \
  -L 8811:127.0.0.1:8811 \
  -L 6080:127.0.0.1:6080 \
  -R 127.0.0.1:18798:127.0.0.1:18798 \
  user@server-tailnet-name
```

Use a macOS LaunchAgent with `RunAtLoad` and `KeepAlive` to make this connection survive app closes and reconnect after network changes.

## Client configuration

Place `remote-client.json` in the app's Electron user-data directory:

```json
{
  "mode": "remote",
  "serverName": "Razer",
  "serverUrl": "http://127.0.0.1:18799",
  "companionUrl": "http://127.0.0.1:8811",
  "macBridge": {
    "enabled": true,
    "port": 18798
  }
}
```

For diagnostics, `--remote-server` or `OMB_REMOTE_URL` overrides `serverUrl`, and `OMB_REMOTE_COMPANION_URL` overrides `companionUrl`.

Build the remote-only Apple silicon bundle with:

```sh
corepack pnpm package:remote:mac
```

The result is `release-remote/mac-arm64/OpenMaus Razer.app`. The remote package omits the harness, server database, and companion server. It includes the pinned macOS CUA runtime because that runtime controls the Mac and must run inside the Mac app's local security boundary.

Build the Windows x64 remote client on Windows with:

```powershell
corepack pnpm package:remote:win
```

The result is `release-remote/OpenMaus-Razer-<version>-setup.exe`. Put the same
`remote-client.json` in `%APPDATA%\OpenMaus Razer`. The Windows client is a
controller for the remote harness and server-hosted computers; the optional
physical-device bridge documented below is currently macOS-only.

The remote UI uses `serverName` to keep the topology explicit: **Razer VM** means the isolated Linux desktop hosted on the Razer, while **This Mac** means the user's physical Mac through the attended bridge. Neither option changes where the bot's model, shell, or files run.

An explicitly selected server VM recovers on demand. Idle cleanup removes only its disposable container, and a host reboot may leave that managed container stopped; the next bot turn recreates it from the already prepared image while preserving the durable workspace. OpenMaus never removes an unowned stopped container or downloads/builds an image implicitly.

## Optional physical-Mac bridge

The Mac app creates a 32-byte token at `mac-bridge-token` in its private Electron user-data directory. Copy that file to `~/.openmausbot/mac-bridge-token` on the Linux server without printing it, and keep both copies mode `0600`.

Install `scripts/remote-mac-mcp-proxy.mjs` on the Linux server at a private, executable path such as `~/.local/lib/openmaus/remote-mac-mcp-proxy.mjs`. Publish `~/.openmausbot/cua-connection.json` with mode `0600`:

```json
{
  "schemaVersion": 1,
  "mode": "remote-mac-bridge",
  "platform": "darwin",
  "scope": "local-computer",
  "generation": "01234567-89ab-cdef-0123-456789abcdef",
  "bridge": {
    "host": "127.0.0.1",
    "port": 18798,
    "tokenFile": "/home/user/.openmausbot/mac-bridge-token"
  },
  "proxy": {
    "path": "/home/user/.local/lib/openmaus/remote-mac-mcp-proxy.mjs",
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
  }
}
```

Generate a fresh UUID and replace the all-zero hash with the real SHA-256 of the installed proxy.

The server rejects unknown descriptor fields, non-loopback hosts, unsafe file ownership or modes, symlinks, invalid tokens, and proxy hash mismatches. The Mac rejects invalid tokens before showing a prompt and closes the CUA child when the tunneled connection closes.

At connection time the Mac offers **Deny**, **Allow once**, and **Always allow while app is open**. OpenMaus separately gates individual computer tools in chat. **Always allow** on a chat approval remembers only that exact `local-computer:<tool>` key; it does not cover VM/cloud tools, unattended turns, or destructive/sensitive actions.

## What survives a closed client

- Server-side bot turns and routines
- Conversations and bot configuration
- Provider CLI sessions and API-key configuration
- Companion and virtual-computer services

Mac-only dictation remains local to the client. Physical-Mac control becomes unavailable immediately when the Mac app quits or the reverse tunnel drops; this does not interrupt server-side work.
