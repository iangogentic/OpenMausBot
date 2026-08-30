# Grok Bot parity ledger

Audit scope: source-level comparison of this OpenMausBot fork with the checked-in
`grok-bot-0.18-reconstructed` research repository. This is a parity ledger, not
a claim that the reconstruction is Anysphere's source code.

## Evidence and status vocabulary

The Grok repository identifies itself as an unofficial source-oriented
reconstruction, not the original monorepo or an official release
(`../grok-bot-0.18-reconstructed/README.md:5-24`). It says that runtimes are
compiled from readable sources while the shipped renderer is retained as the UI
baseline, and that the frontend is partial rather than pixel-perfect
(`README.md:38-64`). Its README's feature list is therefore reconstructed
evidence. A source file can show a UI contract, but cannot prove the private
server protocol or a production backend capability.

OpenMaus status in this ledger is deliberately split:

- **Built**: implementation exists in the checkout.
- **Source-tested**: focused tests exist and the complete repository gate passed
  on the implementation revision named below.
- **Live-proven**: an actual current end-to-end host/model/device run is
  recorded. Historical commits, health checks, generated bundles, and gated
  tests that were not run do not qualify.
- **Product parity**: a user-visible behavior can be specified and implemented.
- **Architecture parity**: the behavior needs a different state, transport, or
  trust boundary, not merely a component.
- **Impossible/undocumented**: the reconstruction does not establish enough of
  the official/private contract to make a faithful claim.

## Current checkout and deployment boundary

The audited implementation revision is `036f581` (`Scope attachment previews to
exact conversations`) on `feat/grokbot-remote-client`, 48 commits ahead of
`origin/feat/grokbot-remote-client` and 109 commits ahead of `upstream/main`.
The only working-tree change during this statement was this ledger. The complete
`pnpm test` gate passed: 267 Vitest files, broker tests, Electron-node tests, and
the packaged-server smoke test. `pnpm typecheck` passed and `pnpm audit --prod`
reported no known vulnerabilities.
The fork history identifies the material additions: hardened Razer deployment
(`3692be8`), physical Windows and Mac bridges, desktop2 Qwen, Spark GLM, Hermes,
Ian Brain, remote clients, and the recent Hermes visual-loop work. These are Ian
fork additions; they are not upstream OpenMaus behavior. The exact commit list
is available with `git log upstream/main..HEAD`.

Razer deployment is live-proven for the previously installed hardened computer
path, but revision `036f581` is not called deployed until its immutable release
cutover is completed. Commit `d6048b3` was installed at
`/opt/openmausbot/releases/d6048b3f2732c3a6575d314386261dd1df3f58a7`; the
server, companion, and four activation sockets were active after restart. A
real Hermes Qwen turn then selected the topmost terminal and executed one
strict two-action batch (`type_text`, `press_key enter`) with the exact PID,
window ID, and foreground delivery mode. The returned tool result carried a
final-screen hash, the agent reported the visible postcondition, and an
independent 1280x900 framebuffer pull visibly showed the executed command,
`OPENMAUS-FINAL-7319`, and a fresh prompt. This proves the deployment, targeted
keyboard delivery, final-capture path, and visible effect; a fresh-session
unknown-pixel reading remains a separate vision acceptance gate. The deploy
README separates server/provider/companion identities, gives Docker authority
to the server, and uses pinned SSH plus opaque per-turn capabilities
(`deploy/razer-remote/README.md:1-24,123-150,183-215,384-402`). Broader
acceptance still demands real generations, isolated VMs, and real
Hermes/Pi/Claude turns (`README.md:420-471`); the single Qwen proof above does
not satisfy those remaining lanes by itself.

## Parity matrix

### 1. Computer sidebar, preview, takeover, and shared screens

**Reconstructed evidence.** Grok's shell model projects running
`computerUse` subagents into selectable `ComputerMonitor` entries with VNC URLs,
status, attention state, and handoff (`../grok-bot-0.18-reconstructed/frontend/src/recovered/features/computer/shell/model.ts:21-44,128-163,250-269`). The shell view renders monitor thumbnails, a fullscreen selected monitor, and “Skip this step” / “I'm done, continue” handoff controls (`.../computer/shell/view.tsx:299-427`). The teach-recording surface records a task with screenshots and narration (`.../computer/teach-recording/view.tsx:45-160`). The recovered computer overlay itself returns `null` (`.../computer/overlay/view.tsx:3-7`), so it is not evidence for an additional exact overlay.

**OpenMaus.** The right-side `ComputerPanel` is built and rendered by
`src/App.tsx:411-414`; it supports cloud/VPS/VM/local preview and control leases
(`src/components/ComputerPanel.tsx:542-720,730-846,1599-1683`). The new
multi-session switcher is mounted inside that panel at
`src/components/ComputerPanel.tsx:1410-1417`, using
`ComputerSessionStrip.tsx:128-180`. Focused preview and handback tests exist in
`src/lib/computer-preview.test.ts`, `src/lib/computer-control-handback.test.ts`,
and `src/components/ComputerSessionStrip.test.ts`.

**Boundary.** OpenMaus's switcher derives sessions from bot/screen/control state;
the source does not yet establish Grok's per-running-subagent monitor identity,
VNC lifecycle, or transcript-linked handoff. Chat sessions and the execution
timeline were intentionally removed from the chat canvas by `4423af9`; controls
now belong in `ComputerPanel`.

**Status:** The panel, collapse behavior, preview generation checks, takeover,
and per-bot VM selection are built + source-tested. The older deployed revision
has live keyboard/final-frame proof, but the current rendered panel still needs
post-deployment browser QA. Shared child/subagent monitor selection remains an
**architecture parity** gap. Likely change points:
`ComputerSessionStrip.tsx`, `ComputerPanel.tsx`, `src/state/store.tsx`, and
server computer target/event state. Acceptance: start two concurrent computer-use
subagents, prove distinct monitor/session IDs and frames, select each exact
target, reject stale generation, and take/hand back control on the selected
monitor only.

### 2. Hermes, Qwen/GLM vision, and Cua routing

**OpenMaus routing.** `server/drivers/acp/core.ts:312-331` mounts
`turn.integrations.localComputer` directly as the official Cua MCP command for a
host/VM. A cloud Box computer instead mounts OpenMaus's REST
`COMPUTER_PROXY_PATH`; routing is selected in `server/index.ts:3535-3647` and
the distinction is explicit in `server/container-computer.ts:1865-1882`.
Replacing raw local Cua with the Box proxy would collapse separate authorization,
lease, generation, and host-containment boundaries and is not a safe parity fix.

**Why `MEDIA:` paths appear.** Hermes's MCP image cache flattens ImageContent to
`MEDIA:/cache/path`. OpenMaus records only paths returned by that cache helper,
checks cache containment, inode/symlink, size, magic bytes, and MIME, then
promotes the trusted image to a native-looking `image_url` envelope
(`server/drivers/acp/hermes-policy.ts:151-177,194-268`). User uploads are a
separate path-tagged protocol (`src/lib/composer-attachments.ts:239-252`) and
are staged into the provider runtime by `server/index.ts:3454-3469`.

**Capabilities and current hardening.** Generic ACP metadata says
`images: support.images !== false` (`server/drivers/acp/core.ts:821-831`), but
Hermes's injected model declaration marks only `desktop2_qwen` as
`supports_vision:true`; Spark GLM remains deliberately text-only
(`server/drivers/acp/hermes.ts:120-147`). HEAD `4b34dc8` adds policy version 2,
hook attestation, trusted image hashes, observation/mutation loop bounds, and
fail-closed computer-hook requirements (`hermes-policy.ts:27,117-148,237-268,
308-435,575-672,777-807`). Local VM post-action settle/capture is implemented
at `server/local-vm-broker.ts:37,65,486-490` and `server/index.ts:9742-9745`.

**Status:** Source-built and source-tested, including policy tests
(`server/drivers/acp/hermes.test.ts:624-719,721-805`). The exact desktop2
Qwen3.8 27B abliterated W8A16 service, its seven shards plus MTP artifact, both
RTX 3090s, direct inference, and the Razer tunnel inference were live-verified.
OpenMaus model discovery and the Hermes default select that exact model. This
proves the model route, not a fresh unknown-pixel visual turn. The remaining gap
is **live acceptance** at the provider observation boundary, not a reason to
route local Cua through Box. Likely future change points are
`hermes-policy.ts`, `local-vm-broker.ts`, and `server/index.ts`. Acceptance must
run the exact Razer VM Hermes turn: `get_desktop_state` -> mutating Cua action ->
next inference, and independently prove Qwen receives pixels while Spark is
correctly text-only. Also assert no host-native tools, raw socket, bearer, or
unscoped path is exposed.

### 3. Browser lane

Both Box and native local-VM lanes now have semantic browser state and bounded
refs. Box implements URL verification/redaction in `server/computer-proxy.ts`;
the native broker maps `get_browser_state`, validates exact target/tab binding,
rejects stale refs, and fail-closes malformed HTTP(S) state in
`server/local-vm-broker.ts:699-822,1085-1153`. Hermes treats semantic state as a
visual observation. Focused tests cover navigation, fill/upload, stale refs,
secret redaction, and failed actions.

**Status:** Built + source-tested. Remaining work is live post-deployment browser
QA and WebAuthn/passkey relay. WebAuthn is an **architecture parity** gap because
it crosses browser, user-presence, and credential trust boundaries; it must not
be approximated by exposing credentials to the model.

### 4. Bots, sidebar, search, and groups

OpenMaus sidebar has bot/group rows, avatars, unread/preview text, context-menu
actions, sections, and New Channel (`src/components/Sidebar.tsx:206-259,
393-464,603-725,730-? ,1215-1255,1420-1465`). Command palette and in-chat find
cover bots, rooms, and messages (`src/components/CommandPalette.tsx:25-103`,
`src/components/ChatFindBar.tsx:25-69`, `server/index.ts:6828-6844`,
`server/message-db.test.ts:81-143`). Groups support multiple bots, mentions,
pins, replies, reactions, attachments, and cards (`src/components/GroupView.tsx:1-4,
95-255`; `server/index.ts:3977-4229`). These are built and source-tested.

Grok's reconstructed sidebar adds hover/focus/outside/Escape preview composition
with latest entry, attachment, status, and pinned state
(`.../sidebar-agent-preview-content.tsx:63-193`) and its host has durable indexed
content/roster search (`source/host/extensions/content-search/*`). OpenMaus now
mounts `SidebarBotPreview.tsx` for pointer and keyboard previews with latest
message, status, pin, draft, and safe attachment names. Message search uses a
durable SQLite FTS5 trigram index, updates on edit/delete/reopen, searches safe
visible fields, and never indexes private directories or attachment capability
IDs. Hover preview and indexed exact-message search are therefore built +
source-tested. Remaining product gaps are a richer action command palette,
durable sidebar section reorder/resize/bulk operations, and a parent/child
conversation outline.

Grok's shared-room reconstruction additionally shows external invite links,
pending approval, and adding/removing owned agents
(`.../agent-info/shared-room/view.tsx:18-108`). OpenMaus local group membership
is built (`ManageMembersPanel.tsx`, `room-members.test.ts`), but the external
authenticated shared-room protocol is not established. Treat faithful parity as
**impossible/undocumented** unless that protocol is supplied; do not infer it
from local groups.

### 5. Files and transcript content

OpenMaus safely uploads/downloads workspace files and previews images with an
in-app lightbox. It now includes bounded PDF and XLSX viewers in
`AttachmentFilePreview.tsx`: PDF load/page/text deadlines and cancellation,
page/pixel/memory limits, safe XLSX ZIP/CRC/relationship validation, worker
revalidation, multi-sheet navigation, bounded rows/cells/text, and accessible
table semantics. Conversation uploads use opaque UUID capabilities scoped to an
exact thread and, after send, an exact user message. Transcript paths are never
authority; cross-thread, cross-message, wrong-ID, and symlink replay are tested.
Grok's recovered PDF viewer has PDF.js loading, page,
zoom, download, error, and 25 MB handling (`.../pdf-viewer.tsx:1-17,343-395`),
while its spreadsheet viewer supports multiple sheets, rows, and download
(`.../spreadsheet-viewer.tsx:1-20,150-179`). **Status:** built + source-tested.
Remaining content gaps are rich media viewing, Mermaid/math rendering, and
structured MCP/PR/file references.

### 6. Skills, plugins, and teaching

OpenMaus intentionally implements a narrow agentskills Markdown format with
frontmatter/name/size/red-flag validation, provenance hashes, and scripts/imports
disabled by default (`server/skills.ts:1-99`). Its recorder captures desktop
actions/screenshots/narration while avoiding raw keystrokes and requires review
(`src/components/SkillRecorderPage.tsx:180-245,370-421`; skill tests exist).
Grok has managed/plugin skill and marketplace/publish services
(`.../source/host/extensions/mcp/plugin-skills.ts`, `skill-publish.ts`,
`managed-skills-service.ts`). Basic teach/skill behavior is built and tested;
marketplace lifecycle is a **product + architecture parity** gap. Likely files:
`server/skills.ts`, `skill-library.ts`, and `SkillRecorderPage.tsx`. Acceptance
must include review, publish, version/rollback, trust boundary, and malicious
frontmatter/script/import tests. Do not loosen the current parser merely for
surface parity.

### 7. Routines and event listeners

OpenMaus supports once/daily/weekday/manual/webhook routines, persisted runs,
startup recovery, and a routines UI (`server/routines.ts:9-18,29-68,135-209`,
`src/components/RoutinesPage.tsx`, routine/timezone tests). Grok's reconstructed
automation schema includes connector event listeners for Slack, GitHub, Teams,
Linear, Sentry, and PagerDuty, connector accounts, self-expiring watches,
pause/resume/delete, confirmations, and run history
(`.../automations/automation.ts:50-70`, `.../automations/routines/view.tsx:18-120`).
Connector listener/auth/self-expiry parity is **product + architecture parity**;
OpenMaus schedules are built/source-tested but not live-proven. Likely files:
`server/routines.ts`, `server/webhook-ingress.ts`, `RoutinesPage.tsx`, and event
adapters. Acceptance: one-shot event delivery, dedupe, auth failure pause,
self-expiry, confirmation, retry, and visible run history.

### 8. Voice and calling

OpenMaus has one-to-one and group calls, but documents an explicitly half-duplex,
Mac-only model with no AEC or barge-in (`src/components/CallView.tsx:1-19,43-110`,
`GroupCallView.tsx:1-5,28-110`, `docs/voice-mode.md:46-75`). Source tests cover
call state and peer lifecycle. Grok's recovered workspace has a browser voice
recorder/transcriber (`.../conversation/workspace/voice.tsx:1-100`), but does not
prove its private call transport. OpenMaus calls are built/source-tested, not
live-proven. Full-duplex/AEC/barge-in is **product parity**; exact Grok transport
is **impossible/undocumented**. Likely files: `CallView.tsx`, `GroupCallView.tsx`,
`src/lib/call.ts`, native speech/TTS. Acceptance: real Mac call, interruption,
feedback suppression, group speaker queue, and approval behavior.

### 9. Settings, router, usage, and updates

OpenMaus has a searchable settings modal with General, Connections, Engines,
Companion, Computer, and Usage plus per-bot settings
(`src/components/SettingsModal.tsx:250-435`, `SettingsPanel.tsx:430-560`). Grok's
recovered settings includes General, Router, Usage & Billing, Updates, computer
reset/update, security key, local-tool permissions, and auto-review
(`.../settings/overlay/view.tsx:10-24,49-119`, `computer-view.tsx:7-50`,
`panels.tsx:92-210`). OpenMaus base settings are built/source-tested. The
reconstruction-added Router/Docker experiments and synthetic unavailable
1Password entry are not reliable evidence of official shipped requirements.
Computer reset/update, security-key relay, global permission policy, and
adaptive auto-review are genuine **product parity** gaps where user-visible and
**architecture/undocumented** gaps where a private account service is inferred.
Likely files: `SettingsModal.tsx`,
`EnginesSettings.tsx`, `UsageSection.tsx`, `ModelPicker.tsx`, and routing APIs.
Acceptance: selecting a route changes the actual provider/model/tools/MCP,
settings persist across restart, usage is labeled non-authoritative, and secrets
never enter transcripts.

### 10. Async tasks, terminal, cards, and reactions

OpenMaus has `ActivityRun.tsx`, `TaskPicker.tsx`, timeline tests, tool chips,
approval/connector/secret cards, reactions, replies, and transcript attachments.
Grok has richer async-task state. Its reconstructed terminal output leaf exists,
but the audited parent route does not mount it; it is not evidence of a shipped
terminal panel. The reconstruction also contains listener/auto-review/connector
transcript-card variants. Basic OpenMaus cards and task surfaces are
built/source-tested. Exact async/listener cards remain a **product parity** gap;
private transcript protocol details are **impossible/undocumented**. A terminal
pane is an optional OpenMaus enhancement, not a source-established Grok parity
requirement.

### 11. Mobile and remote clients

OpenMaus packages local and remote Mac/Windows/Linux clients
(`package.json:63-68`), defines separate SSH/Tailscale service identities
(`docs/remote-client.md:3-39,183-211`), and contains an iOS thin-client source
and tests (`docs/ios-companion.md:1-33,280-297`, `ios/`). The Android proxy is
physical USB only (`server/drivers/phone-proxy.ts:1-2`). README status says
mobile connectivity is still being built and calls are Mac-only
(`README.md:297-304`). Thus remote source is built/tested in parts, but no live
iPhone/Razer proof exists in this audit. The Grok reconstruction targets one
pinned macOS/arm64 release and supplies no authoritative mobile client
(`grok-bot-0.18-reconstructed/README.md:215-221`): Grok mobile parity is
**impossible/undocumented**. Acceptance: real iPhone QR pairing, Tailscale or
hosted HTTPS, SSE reconnect, approval delivery, and remote Mac/Windows/Linux
computer session.

### 12. Other recovered surfaces

The recovered tree also contains onboarding, avatar editing, org chart, local
tool permissions, plugin UI, root-resilience, roster, update banners, hidden
chats, deep links, feedback, account/session, and window chrome. OpenMaus maps
the first group to `Onboarding.tsx`, `BotProfileAvatarCard.tsx`/`SkinPicker.tsx`,
`TeamMapPage.tsx`, approval components, `PluginsPanel.tsx`, connection state,
sidebar, and `UpdateBanner.tsx`; these are source-built with varying focused
tests. It has no established authenticated account, hidden-chat, deep-link,
feedback, or exact window-chrome protocol equivalent. Treat those exact
behaviors as **impossible/undocumented** rather than claiming parity from names
alone. Acceptance for any explicitly requested surface must exercise the
rendered App route and its backend lifecycle.

## Priority order

1. **P0 — Deploy and live acceptance:** cut an immutable Razer release, verify
   rollback, exercise the rendered computer panel, two per-bot VMs, semantic
   browser actions, attachment preview isolation, and a fresh unknown-pixel
   Hermes/Qwen turn.
2. **P0 — True child monitors and cursor telemetry:** give each running computer
   child its own monitor/frame/handoff identity and child-scoped cursor overlay.
3. **P0 — WebAuthn/passkey relay:** preserve user presence and credential
   isolation across the remote browser boundary.
4. **P1 — Product shell depth:** richer command palette, durable sidebar
   organization, parent/child outline, structured references, Mermaid/math,
   media viewer, complete action audit/export, scoped memory controls, and a
   global Always/Ask/Never policy with a non-bypassable team ceiling.
5. **P1 — Routine listeners and approvals:** add connector events only with
   dedupe, auth, expiry, and confirmation semantics.
6. **P2 — Skills marketplace, full-duplex voice, terminal pane, and richer cards:**
   implement only where the private Grok contract is not being guessed.
7. **P2 — Hosted relay and mobile acceptance:** remove the Tailscale/SSH
   requirement only by adding authenticated enrollment, TLS, revocation,
   reconnect, rate limiting, and audit—not by exposing Razer directly.
8. **P2 — Undocumented private services:** account/billing, cross-user shared
   rooms, hosted cloud computers, and a cloud-code-agent substitute remain new
   services, not renderer-only parity work.

## Acceptance rule

No row should be promoted to live-proven from a component test, `/api/health`,
provider availability, a screenshot, a generated package, or a historical
deployment commit. The decisive evidence is the exact user path: rendered UI ->
OpenMaus route -> selected provider/harness -> scoped computer/connector/device
authority -> persisted transcript/result, with restart and stale-target checks.
