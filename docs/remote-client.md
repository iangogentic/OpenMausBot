# Remote client deployment

OpenMaus can run in two pieces:

1. An always-on Linux host runs the harness server, provider CLIs, bot database, companion service, and virtual computers.
2. A lightweight macOS app renders that server. It does not start a second harness or copy provider credentials to the Mac.

Closing the Mac app does not stop work on the Linux host. The client checks server health and reloads itself after a service restart or temporary tunnel failure.

## Security boundary

Keep the harness and companion control ports bound to loopback on the server. Carry them through an encrypted SSH tunnel or put an HTTPS reverse proxy with authentication in front of the harness. The client rejects cleartext HTTP origins unless they are loopback addresses.

The Linux host remains the computer the bots control. Remote-client mode deliberately does not grant the Linux harness access to the physical Mac. Adding that requires a separate authenticated, approval-gated local-computer bridge.

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
  user@server-tailnet-name
```

Use a macOS LaunchAgent with `RunAtLoad` and `KeepAlive` to make this connection survive app closes and reconnect after network changes.

## Client configuration

Place `remote-client.json` in the app's Electron user-data directory:

```json
{
  "mode": "remote",
  "serverUrl": "http://127.0.0.1:18799",
  "companionUrl": "http://127.0.0.1:8811"
}
```

For diagnostics, `--remote-server` or `OMB_REMOTE_URL` overrides `serverUrl`, and `OMB_REMOTE_COMPANION_URL` overrides `companionUrl`.

Build the remote-only Apple silicon bundle with:

```sh
corepack pnpm package:remote:mac
```

The result is `release-remote/mac-arm64/OpenMaus Razer.app`. The remote package omits the harness, server database, CUA daemon, and companion server.

## What survives a closed client

- Server-side bot turns and routines
- Conversations and bot configuration
- Provider CLI sessions and API-key configuration
- Companion and virtual-computer services

Mac-only dictation remains local to the client. Physical-Mac control is intentionally unavailable from the remote harness until a dedicated authenticated bridge exists.
