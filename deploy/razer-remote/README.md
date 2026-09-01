# Razer remote OpenMaus deployment

This deployment keeps four boundaries separate:

- `openmaus-server` is the trusted harness identity. Its state is mode `0700`.
- `openmaus-provider` runs every model/harness CLI and the shell it can open.
- `openmaus-companion` owns paired-phone state plus separate upstream-UI and
  companion-control credentials.
- PID 1 owns TCP ports 8799, 8800, 8810, and 8811 continuously. Hardened
  `systemd-socket-proxyd` processes connect those listeners to private Unix
  sockets. A provider process therefore cannot impersonate a restarting UI,
  webhook receiver, phone endpoint, or companion-control endpoint.

The provider UID cannot signal the server UID, traverse server or companion
state, reach private backend sockets, or modify the root-owned web release.
Each configured provider instance has a different immutable seed home. Actual
turns use a separate hash-only HOME keyed by provider instance and bot owner.
All tasks of one bot intentionally share that native state, and OpenMaus
serializes turns for a bot. The root supervisor seeds the leaf once, mounts only it,
and keeps a nonblocking lock for the whole process lifetime. Pi session files,
Claude project transcripts, ACP `session/load` data, refreshed provider tokens,
and other native HOME state therefore survive process exit without becoming a
cross-bot, cross-thread, or cross-harness channel. Sibling seed and state homes
are absent from the sandbox.

## One-time identities and directories

Create dedicated groups and service accounts. `ian` is optional in the
workspace group only so the human account can edit bot workspaces; it is not
in `openmaus-runtime`.

```bash
sudo groupadd --system openmaus-runtime
sudo groupadd --system openmaus-workspace
sudo useradd --system --user-group --home-dir /var/lib/openmausbot \
  --shell /usr/sbin/nologin openmaus-server
sudo usermod -g openmaus-runtime -aG openmaus-workspace openmaus-server
sudo useradd --system --user-group --home-dir /var/lib/openmaus-provider \
  --shell /usr/sbin/nologin openmaus-provider
sudo usermod -aG openmaus-runtime,openmaus-workspace openmaus-provider
sudo useradd --system --user-group --home-dir /var/lib/openmausbot-companion \
  --shell /usr/sbin/nologin openmaus-companion
# The Local VM image is rebuilt with this dedicated guest identity. Refuse
# setup if uid/gid 61000 already names any other account.
if getent group 61000 >/dev/null; then
  test "$(getent group 61000 | cut -d: -f1)" = openmaus-vm-guest
else
  sudo groupadd --system --gid 61000 openmaus-vm-guest
fi
if getent passwd 61000 >/dev/null; then
  test "$(getent passwd 61000 | cut -d: -f1)" = openmaus-vm-guest
else
  sudo useradd --system --uid 61000 --gid 61000 --home-dir /nonexistent \
    --shell /usr/sbin/nologin openmaus-vm-guest
fi
sudo usermod -aG openmaus-workspace ian
getent group docker
sudo install -d -o openmaus-server -g openmaus-runtime -m 0700 \
  /var/lib/openmausbot
sudo install -d -o root -g openmaus-runtime -m 0750 \
  /var/lib/openmaus-provider /var/lib/openmaus-provider/instances
sudo install -d -o root -g openmaus-runtime -m 0750 \
  /var/lib/openmaus-provider/state
sudo install -d -o root -g openmaus-workspace -m 3770 \
  /var/lib/openmausbot-workspaces
sudo install -d -o root -g openmaus-runtime -m 0730 \
  /var/lib/openmausbot-vm-homes
sudo install -d -o root -g root -m 0755 /opt/openmaus-provider/bin
```

The two model-writable host surfaces and Local VM homes must not share the
unbounded root filesystem. Install the immutable storage helper and mount
units, then let the helper create three fixed-size no-CoW Btrfs images: 10 GiB
for native provider state, 20 GiB for exact bot workspaces, and 40 GiB for VM
homes. Existing images are validation-only: rerunning this command never
truncates or reformats them. A partially created image stays under a private
temporary name and is never mistaken for valid state.

First activation also refuses any unmounted target that is nonempty; it will
not hide a legacy workspace or VM tree behind a fresh filesystem. Stop both
legacy and hardened services, prove their provider/container processes have
exited, take a root-owned backup, and migrate each bot into a helper-created
quota leaf before enabling the mount. Keep the backup until a real turn and VM
restart prove the migrated content. There is intentionally no automatic
delete-or-overwrite migration mode.

```bash
sudo install -D -o root -g root -m 0755 \
  deploy/razer-remote/openmaus-storage-setup \
  /usr/local/libexec/openmaus-storage-setup
sudo install -D -o root -g root -m 0755 \
  deploy/razer-remote/openmaus-storage-leaf \
  /usr/local/libexec/openmaus-storage-leaf
sudo install -D -o root -g root -m 0440 \
  deploy/razer-remote/openmaus-storage.sudoers \
  /etc/sudoers.d/openmaus-storage
sudo visudo -cf /etc/sudoers.d/openmaus-storage
sudo install -o root -g root -m 0644 deploy/razer-remote/*.mount \
  deploy/razer-remote/openmaus-storage-preflight.service \
  deploy/razer-remote/openmaus-storage-prepare.service \
  /etc/systemd/system/
sudo /usr/local/libexec/openmaus-storage-setup --provision-images
sudo systemctl daemon-reload
sudo systemctl enable --now openmaus-storage-prepare.service
sudo /usr/local/libexec/openmaus-storage-setup --prepare-mounted
sudo /usr/local/libexec/openmaus-storage-setup --integration-test
sudo /usr/local/libexec/openmaus-storage-leaf --integration-test
sudo btrfs qgroup show --raw /var/lib/openmaus-provider/state
sudo btrfs qgroup show --raw /var/lib/openmausbot-workspaces
sudo btrfs qgroup show --raw /var/lib/openmausbot-vm-homes
```

Do not add parallel fstab entries for these paths. The named mount units are
the one boot-time source of truth. `openmaus-storage-prepare.service` validates
the exact image, label, size, loop backing device, Btrfs mount, ownership, and
active qgroup accounting before the harness can start. The fixed filesystems
protect the host and trusted server state from a hostile workspace/VM disk
bomb. The root-owned leaf helper additionally creates every bot workspace as a
4 GiB qgroup-limited subvolume and every Local VM home as an 8 GiB
qgroup-limited subvolume, so one bot cannot consume the aggregate and starve
all siblings. Provider native homes retain a narrower 512 MiB ceiling plus the
instance-wide 8 GiB aggregate ceiling.

`openmaus-server` is deliberately trusted and the service unit's explicit
Docker supplementary group is root-equivalent: the harness already exposes
arbitrary container creation for Local VM computers. The account does not need
permanent membership in `/etc/group`; the grant is scoped to the systemd
service. Never add `docker` to the provider or companion unit. Provider
transient units receive an explicit supplementary-group list that excludes it,
and the bwrap test proves the hostile shell cannot reach the socket. If Docker
is not installed and running, the Razer service fails its startup preflight
instead of presenting a broken Local VM picker.

Docker bind mounts preserve numeric ownership, so the derivative Cua image
renumbers its guest to the dedicated locked uid/gid `61000`; it must never use
Razer human UID `1000`. `OMB_LOCAL_VM_HOME_DIR` points only at the bounded VM
filesystem. Its root is `root:openmaus-runtime 0730`, which lets the trusted
server create an exact hash leaf without letting Ian, the provider, companion,
or the locked guest list/traverse sibling homes. Before every Linux-Docker
create/run, source provisions/revalidates the exact 8 GiB qgroup leaf, rejects
symlinks/nested mounts, and replaces ACLs with only the exact server and guest
UIDs. Because guest-created files are numerically owned by uid 61000, the
root-owned storage helper first walks the stopped VM leaf through pinned file
descriptors, rejects links, nested subvolumes, mounts and special inodes, and
returns each bounded entry to the server owner. The unprivileged server can
then replace every ACL without needing `CAP_FOWNER`. A networkless,
read-only-root, tightly capped cleanup container under the
trusted server's Docker authority removes hostile guest-owned contents before
the exact leaf is retired. Never make the directory world-writable, reuse a
human host UID, or give the provider Docker/VM-guest group authority.

Install shared provider CLI executables as root-owned, non-writable files under
`/opt/openmaus-provider/bin`; do not depend on `/home/ian` or a mutable shared
provider home. Systemwide root-owned CLI shims under `/usr/local/bin` are also
acceptable. The trusted server resolves CLI paths before the UID hop, so every
configured executable must be visible and executable from that service PATH.

Install the deterministic home provisioner with the launcher:

```bash
sudo install -D -o root -g root -m 0755 \
  deploy/razer-remote/openmaus-provider-home \
  /usr/local/libexec/openmaus-provider-home
sudo install -D -o root -g root -m 0755 \
  deploy/razer-remote/openmaus-provider-network \
  /usr/local/libexec/openmaus-provider-network
sudo install -D -o root -g root -m 0755 \
  deploy/razer-remote/openmaus-provider-slice-check \
  /usr/local/libexec/openmaus-provider-slice-check
sudo /usr/local/libexec/openmaus-provider-home <driver-kind> <instance-id>
```

Use exactly the driver kind and instance ID from the OpenMaus config. The
command prints the resulting hash-only seed path under
`/var/lib/openmaus-provider/instances/` and also creates the matching root-owned
instance namespace under `/var/lib/openmaus-provider/state/`. Its driver parent is
`root:openmaus-runtime 0750`; its exact instance leaf is
`openmaus-provider:openmaus-runtime 2750`. Put only that instance's provider
login/config in its leaf, with directories `0750` and regular files `0640` or
stricter. Provision and refresh durable authentication only through a trusted
administrative flow while the harness is stopped. The first turn for a new
bot owner copies this seed into an owner-only persistent leaf; later turns
reuse the leaf. Updating the seed does not silently rewrite existing session
homes, so intentionally retire or migrate those homes before rotating a login.
Never put another instance's credential, or any UI, companion, server-state,
Ian Brain upstream, or broker-control secret in the seed.

The supervisor accepts at most 64 persistent bot homes per provider instance.
Every home is a Btrfs subvolume with a hard 512 MiB referenced-byte qgroup
limit and is also validated at 16,384 inodes or less. The provider instance has
a separate hard 8 GiB aggregate ceiling across its maximum 64 homes. An
instance-wide root lock serializes new-home accounting while a separate per-bot
lock rejects a second process against the same native session. Bot deletion
retires its exact hash-only home; the root-admin procedure below is the
whole-instance emergency reset. Never delete or rename a state leaf by hand.

The exact sharing contract is:

- server `User=openmaus-server`, primary `Group=openmaus-runtime`,
  supplementary `openmaus-workspace`, `UMask=0077`;
- provider service primary group `openmaus-provider`; the transient unit uses
  `UMask=0077`, and bwrap selects
  `openmaus-workspace` as the turn's primary GID and mounts only the exact
  workspace. Host-side setup retains the provider's runtime/workspace group
  memberships;
- `/run/openmaus-provider` is mode `2750`, server-owned and runtime-grouped;
- per-turn directories placed there must be explicitly mode `2750`, regular
  capability files `0640`, and broker sockets `0660`. The restrictive server
  umask is intentional, so code must chmod/chgrp only these exact artifacts;
- the immutable supervisor validates those exact nofollow inode trees,
  temporarily makes only the declared artifacts provider-owned while bwrap
  runs, and restores server ownership after every descendant is reaped;
- `/run/openmausbot-private` and `/run/openmausbot-companion` are mode `0700`
  and must never be shared with the provider group.

The current source passes Pi's unique MCP directory, Claude's unique
per-thread permission-socket/MCP directories, and Hermes' exact home, policy,
and proof paths through `providerRuntimePaths`. A Unix socket must live inside
a unique per-turn directory and that directory is mounted; never expose the
runtime base just to mount one socket. Deployment acceptance still requires a
real turn for each configured harness after its instance seed is provisioned.

Root-admin state retirement is deliberately separate from the provider sudo
grant. It removes every native session HOME for one exact hashed provider
instance, leaves the immutable login seed intact, and refuses to run if any
matching turn lock is active:

```bash
sudo systemctl stop openmausbot.service
sudo /usr/local/libexec/openmaus-provider-home \
  --purge-state <driver-kind> <instance-id>
sudo systemctl start openmausbot.service
```

This is irreversible session cleanup. Use it only after exporting anything
needed for audit/continuation and only with the exact driver kind and instance
ID from config. New turns are seeded from the current instance login after the
purge.

## Root-owned launcher and release

Install the immutable launcher and validate the sudo policy before restarting
anything:

```bash
sudo install -D -o root -g root -m 0755 \
  deploy/razer-remote/openmaus-provider-launch \
  /usr/local/libexec/openmaus-provider-launch
sudo install -D -o root -g root -m 0755 \
  deploy/razer-remote/openmaus-provider-supervisor \
  /usr/local/libexec/openmaus-provider-supervisor
sudo install -D -o root -g root -m 0755 \
  deploy/razer-remote/provider-supervisor.integration.mjs \
  /usr/local/libexec/openmaus-provider-integration
sudo install -D -o root -g root -m 0755 \
  deploy/razer-remote/openmaus-noncutover-preflight \
  /usr/local/libexec/openmaus-noncutover-preflight
sudo install -D -o root -g root -m 0755 \
  deploy/razer-remote/openmaus-provider-home \
  /usr/local/libexec/openmaus-provider-home
sudo install -D -o root -g root -m 0440 \
  deploy/razer-remote/openmaus-provider.sudoers \
  /etc/sudoers.d/openmaus-provider
sudo visudo -cf /etc/sudoers.d/openmaus-provider
```

Never execute a JavaScript integration test as root from an agent- or
human-writable checkout. The command above installs the reviewed bytes first;
the live proof below invokes only that root-owned copy.

The launcher has no general sudo grant and no credential wildcard in
`env_keep`. The server writes one mode-`0600` launch manifest in its unique
runtime scope; sudo preserves only that manifest pointer. The immutable root
supervisor validates its owner/path/inode, reads it, and unlinks it before the
provider exists. It then opens exact declared paths with `O_PATH|O_NOFOLLOW`,
drops UID, and requires root-owned `/usr/bin/bwrap`.

Every turn gets private PID, mount, IPC, UTS, network, `/proc`, `/run`, and
`/tmp` scopes. Install root-owned `/usr/bin/slirp4netns`; its per-turn user-mode
gateway preserves public Internet access while keeping loopback and abstract
Unix sockets private to that turn. Catalog/auth probes without a bot get an ephemeral 128 MiB home;
actual turns bind one exact persistent per-bot HOME initialized from the
selected seed. The shared provider root and real state path remain masked.
Host-side gateway traffic still carries `openmaus-provider`'s UID, so the
root-owned nft policy permits only public egress plus TCP 8799 and DNS while
rejecting direct host, LAN, Tailscale, multicast, reserved, and IPv4-mapped
private destinations. Provider-facing capability URLs use the slirp host
gateway `10.0.2.2:8799`; configured local models must use the turn-scoped
trusted model relay, never direct desktop2/Spark exceptions. The entire runtime root and all
other workspaces are hidden; only the exact current workspace and declared
runtime artifacts are mounted. Nested user namespaces and all capabilities are
disabled. The root supervisor stays alive as a child subreaper. On
TERM/INT/HUP it forwards TERM for 750 ms, then sends SIGKILL and continues
reaping until no descendant remains. Killing sudo's monitor therefore cannot
orphan a provider shell.

Each turn also runs in its own transient systemd cgroup, bound to
`openmausbot.service`; the trusted server remains outside the turn limit. The
default per-turn budgets are `MemoryHigh=3 GiB`, `MemoryMax=4 GiB`, no swap,
`CPUQuota=200%`, `TasksMax=256`, and a one-hour maximum runtime. Root-owned
service environment values `OMB_PROVIDER_MEMORY_HIGH_BYTES`,
`OMB_PROVIDER_MEMORY_MAX_BYTES`, `OMB_PROVIDER_MEMORY_SWAP_MAX_BYTES`,
`OMB_PROVIDER_CPU_QUOTA_PERCENT`, and `OMB_PROVIDER_TASKS_MAX` can tune them
within the supervisor's hard validation bounds. Private tmpfs sizes are caps,
not preallocated memory, and their charged pages still count against the same
turn cgroup.

All transient turn units live under the root-owned
`openmaus-provider.slice`. Its aggregate defaults are `MemoryHigh=12 GiB`,
`MemoryMax=16 GiB`, no swap, `CPUQuota=400%`, and `TasksMax=1024`; therefore N
simultaneous bots cannot multiply the per-turn ceilings without bound.

Build the exact checked-out revision:

```bash
corepack pnpm build
corepack pnpm build:server
corepack pnpm build:companion
```

Publish only verified `dist/`, `dist-server/`, and `dist-companion/` under a
root-owned versioned directory such as
`/opt/openmausbot/releases/<git-sha>`. Record and verify a SHA-256 manifest,
then atomically change the root-owned `/opt/openmausbot/current` symlink. No
agent-writable checkout may be used as `OMB_STATIC_DIR` or an executable
release path.

## Units and credentials

Install the bounded-storage mounts, two backends, four persistent sockets, and
four socket proxies:

```bash
sudo install -o root -g root -m 0644 deploy/razer-remote/*.service \
  /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/razer-remote/*.socket \
  /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/razer-remote/*.mount \
  /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/razer-remote/openmaus-provider.slice \
  /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/razer-remote/openmausbot.tmpfiles.conf \
  /etc/tmpfiles.d/openmausbot.conf
sudo systemd-tmpfiles --create /etc/tmpfiles.d/openmausbot.conf
sudo systemctl daemon-reload
sudo systemctl start openmaus-provider.slice openmaus-provider-network.service
sudo /usr/local/libexec/openmaus-provider-slice-check --check
sudo /usr/local/libexec/openmaus-provider-network --check
```

Before stopping a legacy backend or activating any production socket, run the
non-cutover proof. It refuses to proceed if either production backend or any of
the four public socket units is active. It validates the installed root-owned
assets and exact systemd fragments; checks the three mounted Btrfs images and
qgroups without repairing drift; compares the complete normalized live nft
JSON policy (including hooks, priorities, policies, ordered expressions, UID,
CIDRs, rates, verdicts, and any extra object); and exercises bounded temporary
Btrfs leaves plus a real private provider network namespace through
slirp4netns. The test never starts `openmausbot.service`, the companion, or a
public listener:

```bash
sudo /usr/local/libexec/openmaus-noncutover-preflight --check
```

Keep cutover blocked unless this returns JSON containing `"ok": true` and
`"cutover": false`, and independently finish the model relay, bounded hostile
stdout decoders, configured-harness real turns, Local VM firewall test, and
Mac package acceptance described below.

The harness receives only the SHA-256 digest of the Mac UI token:

```ini
# /etc/systemd/system/openmausbot.service.d/session.conf
[Service]
Environment="OMB_UI_SESSION_TOKEN_SHA256=<digest>"
```

Generate a second, different 48-byte token for companion pairing control.
Transfer the two raw values separately through SSH stdin into
`/etc/credstore/openmausbot-ui-session` and
`/etc/credstore/openmausbot-companion-session`, each root-owned and mode
`0400`. Only the companion sees their private systemd credential mounts. The
first authorizes companion-to-harness requests; the second authorizes only the
desktop app's companion-control requests. Add the second value to the Mac's
mode-`0600` `remote-client.json` as `companionSessionToken`; it must differ
from `sessionToken`. The provider launcher strips UI/session, server-state,
listener, and credential-mount variables before the UID hop.

The Mac remote app owns ephemeral loopback proxies and reaches Razer through
pinned `ssh -W`; do not restore fixed external `ssh -L` listeners. Copy
`ssh.hostPublicKey` through a trusted console, not from a first unverified
network connection. The current client intentionally rejects legacy
`serverUrl`/`companionUrl` remote configs.

Model endpoint drop-ins belong under
`/etc/systemd/system/openmausbot.service.d/`. After copying current Qwen,
Spark GLM, and session drop-ins, verify units before migration:

```bash
sudo systemd-analyze verify \
  /etc/systemd/system/openmaus-storage-prepare.service \
  /etc/systemd/system/openmausbot.service \
  /etc/systemd/system/openmausbot-companion.service \
  /etc/systemd/system/*.mount \
  /etc/systemd/system/openmausbot-*.socket \
  /etc/systemd/system/openmausbot-*-proxy.service
```

Stop and disable the legacy same-UID user services only after proving their
provider process trees exited. Then start the socket units immediately so PID
1 owns every public port before either new backend starts:

```bash
systemctl --user disable --now openmausbot-companion.service openmausbot.service
sudo systemctl daemon-reload
sudo systemctl enable --now openmaus-storage-prepare.service
sudo systemctl enable --now \
  openmausbot-harness.socket openmausbot-webhook.socket \
  openmausbot-companion.socket openmausbot-control.socket
sudo systemctl enable --now openmausbot.service openmausbot-companion.service
```

The proxy services are socket-activated and are not enabled separately.

## Acceptance

Acceptance requires direct evidence, not only `active`:

1. `systemctl show` reports all four `.socket` units active across a forced
   backend restart, and `ss -ltnp` attributes 8799/8800/8810/8811 to systemd.
2. Backend sockets are mode `0600`; the provider UID cannot traverse either
   private runtime directory or connect to those sockets.
3. `sudo node deploy/razer-remote/provider-supervisor.integration.mjs` passes
   through a transient hardened systemd service and the exact installed
   launcher. It proves a provider cannot see a same-UID sibling PID/runtime
   scope or sibling instance home, the one-use manifest, server state, or a
   symlink/rename escape; ephemeral probe-home writes remain private; separate
   Pi-, Claude-, and generic-ACP-shaped files survive a complete first-process
   exit into the same exact bot HOME, default modes remain `0600/0700`, a
   sibling state leaf stays hidden, and a 65th HOME is rejected; TERM-ignoring detached
   descendants are root-KILLed; temporary runtime ownership is restored; a CPU
   bomb is throttled by the exact kernel quota; and a RAM bomb is OOM-killed
   inside its 128 MiB test cgroup without killing the server/test process. The
   proof also runs two simultaneous children under a unique bounded child of
   `openmaus-provider.slice` and observes a kernel OOM kill at the aggregate
   ceiling, without lowering or adding a drop-in to the production slice. The
   same test runs `docker info` as the exact hardened server identity, then
   proves the provider turn has neither the Docker group nor socket authority.
4. A provider turn's process UID is `openmaus-provider`; it cannot signal
   `openmaus-server`, read `/var/lib/openmausbot`, read companion state, or
   write `/opt/openmausbot/current`. `systemctl show openmausbot.service -p
   Environment` contains exactly
   `OMB_PROVIDER_HOME=/var/lib/openmaus-provider` and
   `OMB_PROVIDER_STATE_DIR=/var/lib/openmaus-provider/state`; the shared roots
   are masked in each turn, only the selected per-bot HOME persists, and
   `openmaus-server` can read a mode-`0640` selected-instance config probe.
5. Unauthenticated harness and companion-control requests are rejected. The
   UI bearer is also rejected by companion control; only the distinct
   companion token works. Authenticated Mac and phone paths succeed. Webhook
   capability URLs still report public port 8800 even though ingress binds a
   UDS.
6. Each configured model answers a real generation. Ian Brain uses a dedicated
   OpenMaus upstream capability matching the exact 27-name broker allow-list;
   neither ACT/`external:grok` nor a merely `creds_*`-filtered principal is
   accepted. Two bots independently use their own Local VM.
   As the exact `openmaus-server` service UID, create both VM homes, launch each
   container as the locked Cua UID `61000`, write a distinct file from guest and server,
   recreate/restart the containers, and prove both files remain writable and
   isolated. `getfacl` must show no group/other access; the provider UID must
   still lack Docker socket authority.
7. Pi/Claude/Hermes each complete a real turn with only their exact declared
   MCP files, proof directories, and unique socket directory visible through
   `providerRuntimePaths`; every artifact meets the runtime-group modes above.
8. The remote app rejects a wrong SSH host key and a legacy URL config. A
   hostile process occupying an old/fixed loopback port cannot intercept the
   app-owned ephemeral proxy or either session token.
9. `/usr/local/libexec/openmaus-provider-network --check` succeeds only for the
   exact normalized nft JSON policy. A real provider turn resolves DNS and can
   reach public HTTPS plus only the trusted host gateway on TCP 8799. It cannot
   reach another loopback port, RFC1918/LAN, CGNAT/Tailscale, link-local,
   multicast, IPv4-mapped private addresses, a sibling turn's abstract Unix
   socket, or a sibling runtime path. Sustained provider egress is bounded to
   50 MiB/s with a 100 MiB burst.
10. For two real Local VMs A and B, A can resolve DNS and reach public HTTPS,
    but cannot reach the host bridge/gateway, LAN, Tailscale, B, or any host
    service except its loopback-published TCP 6901 viewer. The host viewer can
    connect through the published loopback port; direct host-to-VM-IP,
    default-Docker-bridge-to-VM, LAN/public unsolicited ingress, and B-to-A are
    denied. VM aggregate egress is bounded to 100 MiB/s with a 200 MiB burst.
    Run these probes against the production network creation path, not a
    hand-written Docker fixture.

See `docs/remote-client.md` for non-logging credential-transfer commands and
the complete two-token Mac client configuration.
