# Razer OpenMaus to Ian Brain

This deployment connects the Hermes harness used by Razer-hosted OpenMaus to
Ian Brain on desktop2. Ian Brain stays bound to desktop2 loopback; a persistent
SSH tunnel exposes it only as `127.0.0.1:15050` on Razer.

The MCP connection must use a dedicated Ian Brain OpenMaus principal. **Never
use `external:grok`, ACT, or the legacy broad token here.** ACT can dispatch
shell and remote-command tools; those commands inherit Ian Brain's own secret
environment, so filtering only names beginning with `creds_` is not a
credential boundary.

Before Razer cutover, desktop2 Ian Brain must expose a separate OpenMaus
capability whose dispatch allow-list exactly matches
`IAN_BRAIN_BOT_SAFE_TOOL_NAMES` in `server/ian-brain-broker.ts` (currently 27
reviewed names). The upstream authorization layer must reject every other
tool, including new future tools, before execution. In particular it must
exclude shell, GitHub, Workspace, remote command/copy/log, arbitrary file
read/write/ingest, `wiki_read_all`, `projects_call`, and every `creds_*` tool.
The OpenMaus broker repeats the same closed allow-list as defense in depth; it
is not a substitute for the dedicated upstream capability.

The Ian Brain OpenMaus signing key must not live in the provider seed or the human
Hermes profile. In the hardened deployment it belongs only to the trusted
server source profile at `/var/lib/openmausbot/.hermes/.env` (owner
`openmaus-server`, mode `0600`). The same 32-byte-or-longer key is configured
on desktop2 Ian Brain as `IAN_BRAIN_OPENMAUS_SIGNING_KEY`. The provider sees
only its unrelated local broker capability; after rechecking exact
bot/thread/generation authority, the trusted server derives an `omb1` HMAC
bearer that expires after 120 seconds and is bound to that bot and generation.

Install the tunnel as the `ian` user on Razer:

```bash
install -Dm644 ian-brain-tunnel.service \
  /home/ian/.config/systemd/user/ian-brain-tunnel.service
systemctl --user daemon-reload
systemctl --user enable --now ian-brain-tunnel.service
```

Create the server-only opt-in marker and transfer the signing key through protected
stdin (use the non-logging credential-transfer pattern in
`docs/remote-client.md`; never put the value on argv or in shell history):

```bash
sudo install -d -o openmaus-server -g openmaus-runtime -m 0700 \
  /var/lib/openmausbot/.hermes
sudo install -o openmaus-server -g openmaus-runtime -m 0600 /dev/stdin \
  /var/lib/openmausbot/.hermes/config.yaml <<'YAML'
mcp_servers:
  ian_brain:
    enabled: true
YAML
# Write exactly MCP_IAN_BRAIN_API_KEY=<32+-byte-HMAC-signing-key> plus a trailing newline to
# /var/lib/openmausbot/.hermes/.env via protected stdin, then chmod 0600.
# Configure the identical secret as IAN_BRAIN_OPENMAUS_SIGNING_KEY only in the
# desktop2 Ian Brain service credential environment.
```

The provider instance seed needs the same *presence marker*, but never the
upstream key, URL/header override, or another MCP command. Provision the exact
Hermes driver/instance mapping, then create this minimal source config:

```yaml
mcp_servers:
  ian_brain:
    enabled: true
```

For example, with the service stopped, put that file at
`$(sudo /usr/local/libexec/openmaus-provider-home --print hermesAgent
<instance-id>)/.hermes/config.yaml`, owned
`openmaus-provider:openmaus-runtime`, with the directory `0750` and file `0640`.
Install only the model login material Hermes actually needs beside it; exclude
`MCP_IAN_BRAIN_API_KEY`, every UI/companion token, and unrelated provider
credentials. Native state is one persistent owner HOME per provider instance
and bot, shared by that bot's tasks but never by sibling bots. A changed seed
affects new bot owners only. Deleting a bot first commits a durable logical
deletion tombstone, then idempotently retires that exact owner HOME across all
instances; failed cleanup remains journaled and cannot recreate a blank live
bot. Do not purge a live bot merely to refresh its seed.

## Root-owned Hermes executable

The old `/home/ian/.local/bin/hermes` is a symlink whose shebang points back
into `/home/ian/.hermes/hermes-agent/venv`; `ProtectHome=yes` intentionally
hides both paths. A one-time root-admin migration must install the verified
Hermes source revision and a Python `<3.14` environment under
`/opt/openmaus-provider/`, then expose a root-owned, non-writable shim at
`/opt/openmaus-provider/bin/hermes`. Do not copy only the old shell entrypoint
or reuse a venv whose Python symlink still names `/home/ian`.

On the current Razer, the known working source is Hermes Agent `0.17.0` at git
revision `9f4c0b27c9c483b517d965651309630c51e6e481`, and it requires Python
`>=3.11,<3.14`. Copy that exact clean source (excluding its old `venv`, `.venv`,
and `.git`) to a versioned root-owned release, install a root-owned managed
Python 3.11 plus the frozen `uv.lock` and the pinned `acp` extra
(`agent-client-protocol==0.9.0`). Installing the base package alone leaves
`hermes acp` present but unusable. Verify all of these before enabling the
service:

```bash
sudo -u openmaus-server test -x /opt/openmaus-provider/bin/hermes
sudo -u openmaus-server /opt/openmaus-provider/bin/hermes --version
sudo -u openmaus-server /path/to/managed/python -c \
  'import acp, importlib.metadata as m; assert m.version("agent-client-protocol") == "0.9.0"'
readlink -f /opt/openmaus-provider/bin/hermes
head -n 1 "$(readlink -f /opt/openmaus-provider/bin/hermes)"
# Neither resolved path nor shebang may contain /home/ian.
```

The service PATH already includes `/opt/openmaus-provider/bin`. Keep the
versioned source, interpreter, venv, and shim root-owned and group/world
non-writable; do not let a provider turn update them in place.

The Ian Brain source currently needs the dedicated-principal/capability change
described above before this deployment is safe to enable. Treat that source
change and provisioning its independent signing key as a hard cutover gate; do not
temporarily substitute `external:grok`.

Acceptance requires all of the following:

- The user `ian-brain-tunnel.service` and system `openmausbot.service` are
  enabled and active.
- Hermes connects successfully to `ian_brain` through `127.0.0.1:15050`.
- The server source marker/key is readable by `openmaus-server` and denied to
  `openmaus-provider`; the provider seed contains only the marker.
- Ian Brain validates a fresh 120-second `omb1` token as the exact bot and
  generation, rejects expiry/replay under another generation, and exposes its
  exact 27-name closed allow-list. A direct upstream attempt to call
  `actions_shell_run`, `machines_command_exec`, `files_read`, `projects_call`,
  a `creds_*` name, and an unknown future name is rejected before dispatch.
- A real OpenMaus Hermes turn performs MCP `tools/list`, returns exactly the
  reviewed names, and returns none of the indirect credential-recovery tools
  above.
- The same turn performs one harmless representative `tools/call` successfully,
  and a direct attempt to call a `creds_*` name is unavailable/rejected.
- Native Hermes file/shell/web tools remain disabled; Ian Brain and the selected
  Computer MCP are the only external authorities in the sanitized turn profile.
