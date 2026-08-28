# Razer OpenMaus to Ian Brain

This deployment connects the Hermes harness used by Razer-hosted OpenMaus to
Ian Brain on desktop2. Ian Brain stays bound to desktop2 loopback; a persistent
SSH tunnel exposes it only as `127.0.0.1:15050` on Razer.

The MCP connection uses Ian Brain's `external:grok` compatibility principal.
That principal has the normal `act` tool surface, including knowledge, files,
memory, machines, shell, Google Workspace, GitHub, and federated projects, but
Ian Brain filters out every `creds_*` tool before MCP discovery. Permission
administration remains owner-only, and Ian Brain's normal action permission
checks still apply.

The bearer token belongs only in `/home/ian/.hermes/.env` on Razer with mode
`0600`. Keep the config template in `/home/ian/.hermes/config.yaml` as an
environment-variable reference; never commit the token or return it to a phone
client.

Install the tunnel as the `ian` user on Razer:

```bash
install -Dm644 ian-brain-tunnel.service \
  /home/ian/.config/systemd/user/ian-brain-tunnel.service
systemctl --user daemon-reload
systemctl --user enable --now ian-brain-tunnel.service
```

Hermes MCP config shape:

```yaml
mcp_servers:
  ian_brain:
    url: http://127.0.0.1:15050/mcp
    headers:
      Authorization: Bearer ${MCP_IAN_BRAIN_API_KEY}
    enabled: true
```

After configuring the protected environment value, test the server and restart
OpenMaus so the long-running Hermes ACP process discovers the new tools:

```bash
/home/ian/.local/bin/hermes mcp test ian_brain
systemctl --user restart openmausbot.service
```

Acceptance requires all of the following:

- `ian-brain-tunnel.service` and `openmausbot.service` are enabled and active.
- Hermes connects successfully to `ian_brain` through `127.0.0.1:15050`.
- MCP discovery returns representative read and action tools.
- MCP discovery returns zero tool names beginning with `creds_`.
- A real OpenMaus Hermes turn calls an Ian Brain tool successfully.
