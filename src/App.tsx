import { useEffect, useRef, useState } from "react";
import { Hand, Loader2, Menu, Monitor } from "lucide-react";
import { StoreProvider, useStore, type Bot } from "@/state/store";
import { Onboarding } from "@/components/Onboarding";
import { emailGateDone, initAnalytics } from "@/lib/analytics";
import { unreadConversationCount } from "@/lib/unread";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { SettingsPanel } from "@/components/SettingsPanel";
import { PluginsPanel, preloadConnectedApps } from "@/components/PluginsPanel";
import { ComputerPanel } from "@/components/ComputerPanel";
import { InspectorPanel } from "@/components/InspectorPanel";
import { SettingsModal } from "@/components/SettingsModal";
import { UpdateBanner } from "@/components/UpdateBanner";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { RoutinesPage } from "@/components/RoutinesPage";
import { NoEngines } from "@/components/NoEngines";
import { CommandPalette } from "@/components/CommandPalette";
import { SkillRecorderPage } from "@/components/SkillRecorderPage";
import { TeamMapPage } from "@/components/TeamMapPage";
import {
  clearComputerLeaseIfCurrent,
  computerLeaseIsCurrent,
  computerLeaseResultIfCurrent,
  computerControlSnapshotSchema,
  computerControlOwnerId,
  readComputerLease,
  type StoredComputerLease,
} from "@/lib/computer-control-lease";
import { closeBrowserDesktopViewer } from "@/lib/browser-desktop-viewer";
import { handBackComputerControl } from "@/lib/computer-control-handback";

function computerLeaseReleaseKey(botId: string, lease: StoredComputerLease): string {
  return `${botId}\0${lease.leaseToken}`;
}

function Shell() {
  const { state, dispatch } = useStore();
  const unreadCount = unreadConversationCount(state.bots, state.groups);
  // Mobile-only drawer state. Above md, none of these properties are emitted
  // at all — Sidebar scopes every mobile class with max-md: rather than
  // cancelling them with md:, which would still emit a translate value and
  // turn the aside into a containing block for its fixed descendants (see
  // Sidebar.tsx's className comment).
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const computerOwnerId = useRef(computerControlOwnerId()).current;
  const releasingControlLeases = useRef(new Set<string>());
  const heartbeatFailures = useRef(new Map<string, { leaseToken: string; count: number }>());
  const electronViewerLeases = useRef(new Map<string, StoredComputerLease>());
  const group = state.groups.find((g) => g.id === state.selectedId);
  // Hydration owns the cold-start fallback. Rendering bots[0] for an invalid
  // non-empty selection makes a reconnect look like an unsolicited jump.
  const bot = group ? undefined : state.bots.find((b) => b.id === state.selectedId);
  const locallyControlledBots = state.bots.filter((candidate) => {
    if (!state.computerControl[candidate.id]?.held) return false;
    return readComputerLease(candidate.id)?.ownerId === computerOwnerId;
  });
  const handBackGlobalControl = async (controlledBot: Bot) => {
    const lease = readComputerLease(controlledBot.id);
    if (!lease || lease.ownerId !== computerOwnerId) return;
    const releaseKey = computerLeaseReleaseKey(controlledBot.id, lease);
    if (releasingControlLeases.current.has(releaseKey)) return;
    releasingControlLeases.current.add(releaseKey);
    try {
      await handBackComputerControl({
        botId: controlledBot.id,
        desktopViewer: window.ogb?.desktopViewer,
        release: async () => {
          const response = await fetch(`/api/bots/${controlledBot.id}/computer/control`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "release", ...lease }),
          });
          const parsed = computerControlSnapshotSchema.safeParse(await response.json().catch(() => null));
          if (!response.ok && !(response.status === 403 && parsed.success && parsed.data.held === false)) {
            throw new Error("Computer control could not be handed back yet");
          }
          const remainedCurrent = clearComputerLeaseIfCurrent(controlledBot.id, lease);
          if (parsed.success && remainedCurrent) {
            dispatch({
              type: "computerControl",
              botId: controlledBot.id,
              held: parsed.data.held === true,
              helpReason: parsed.data.helpReason,
            });
          }
        },
        closeBrowserViewer: () => { closeBrowserDesktopViewer(controlledBot.id); },
      });
    } catch {
      // Fail closed: retaining the short lease keeps bot input paused if the
      // desktop viewer could not be proven closed. The user can retry from
      // the still-visible global control banner.
    } finally {
      releasingControlLeases.current.delete(releaseKey);
    }
  };

  // Nothing on this machine can run a bot. A missing cloud login does not
  // count — that CLI can still host a local model. Wait for the first
  // /api/instances response before deciding: an empty list means "not asked
  // yet", and flashing the setup screen at every launch would be worse.
  const noEngines =
    state.connected &&
    state.instances.length > 0 &&
    !state.instances.some((i) => i.snapshot.state === "available");

  // App-wide shortcuts: ⌘N new bot · ⌘1–9 jump to bot · ⌘⇧[ / ⌘⇧] prev/next.
  // Kept deliberately small; every panel already closes on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const bots = state.bots.filter((b) => !b.hidden);
      if (e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "newBot" });
      } else if (/^[1-9]$/.test(e.key)) {
        const target = bots[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          dispatch({ type: "select", id: target.id });
        }
      } else if (e.shiftKey && (e.key === "[" || e.key === "]")) {
        const idx = bots.findIndex((b) => b.id === state.selectedId);
        const next = bots[(idx + (e.key === "]" ? 1 : -1) + bots.length) % bots.length];
        if (next) {
          e.preventDefault();
          dispatch({ type: "select", id: next.id });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.bots, state.selectedId, dispatch]);

  useEffect(() => {
    window.ogb?.setUnreadCount?.(unreadCount);
  }, [unreadCount]);

  // Warm connected-account state as soon as the local server is available.
  // The modal then opens with the correct Connect/Add account buttons and
  // quietly revalidates instead of rediscovering every account from scratch.
  useEffect(() => {
    if (!state.connected) return;
    void preloadConnectedApps().catch(() => {});
  }, [state.connected]);

  // Picking a conversation closes the drawer: on a phone the chat is what you
  // asked for, and leaving the list up would hide it. Watching activeView too
  // catches re-selecting the bot that is already current from another view —
  // the reducer switches the view without changing selectedId. pluginsOpen
  // and settingsOpen cover the same idea from a different trigger: close the
  // drawer whenever an action opens something over the chat.
  useEffect(() => {
    setDrawerOpen(false);
  }, [state.selectedId, state.activeView, state.pluginsOpen, state.settingsOpen]);

  // The viewer outlives ComputerPanel and can target any bot, so release control
  // here (always mounted) when a bot's viewer closes. release() is idempotent.
  useEffect(() => {
    const desktopViewer = window.ogb?.desktopViewer;
    if (!desktopViewer) return;
    let alive = true;
    const contextRevisions = new Map<string, number>();
    const observe = (viewer: { open: boolean; contextId: string }) => {
      if (!viewer.contextId) return;
      const botId = viewer.contextId;
      if (viewer.open) {
        const lease = readComputerLease(botId);
        if (lease?.ownerId === computerOwnerId) electronViewerLeases.current.set(botId, { ...lease });
        else electronViewerLeases.current.delete(botId);
        return;
      }
      // Bind close work to the lease that owned this viewer while it was open,
      // not whichever successor token happens to be current when IPC arrives.
      const lease = electronViewerLeases.current.get(botId);
      electronViewerLeases.current.delete(botId);
      if (lease?.ownerId === computerOwnerId && computerLeaseIsCurrent(botId, lease)) {
        const releaseKey = computerLeaseReleaseKey(botId, lease);
        if (releasingControlLeases.current.has(releaseKey)) return;
        releasingControlLeases.current.add(releaseKey);
        void (async () => {
          try {
            for (const delayMs of [0, 250, 750]) {
              if (delayMs) await new Promise((resolve) => window.setTimeout(resolve, delayMs));
              if (!computerLeaseIsCurrent(botId, lease)) break;
              try {
                const response = await fetch(`/api/bots/${botId}/computer/control`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ action: "release", ...lease }),
                  keepalive: true,
                });
                const body: unknown = await response.json().catch(() => null);
                const snapshot = computerControlSnapshotSchema.safeParse(body);
                if (snapshot.success && computerLeaseIsCurrent(botId, lease)) {
                  dispatch({
                    type: "computerControl",
                    botId,
                    held: snapshot.data.held,
                    helpReason: snapshot.data.helpReason,
                  });
                }
                if (response.ok || response.status === 403) {
                  break;
                }
              } catch {
                // Retry while the exact proof is still available. If all
                // attempts fail, dropping it stops heartbeats and lets the
                // server's short lease expire instead of pausing forever.
              }
            }
          } finally {
            clearComputerLeaseIfCurrent(botId, lease);
            releasingControlLeases.current.delete(releaseKey);
          }
        })();
      }
    };
    const off = desktopViewer.onState((viewer) => {
      contextRevisions.set(viewer.contextId, (contextRevisions.get(viewer.contextId) ?? 0) + 1);
      observe(viewer);
    });
    // Recover every viewer already owned by this document. The list is
    // bounded in main and cannot collapse concurrent bots into an arbitrary
    // singleton "current" viewer.
    void desktopViewer.currentStates().then((viewers) => {
      if (!alive) return;
      for (const viewer of viewers) {
        if ((contextRevisions.get(viewer.contextId) ?? 0) === 0) observe(viewer);
      }
    }).catch(() => {});
    return () => {
      alive = false;
      off();
    };
  }, [computerOwnerId, dispatch]);

  // Server state outranks a locally open viewer. Lease expiry, a revoke from
  // another trusted controller, or a server restart can all produce held=false
  // without this renderer initiating hand-back; close both viewer kinds at
  // that boundary so a hosted provider page never remains interactive in the
  // app after the bot has resumed.
  useEffect(() => {
    for (const [botId, snapshot] of Object.entries(state.computerControl)) {
      if (snapshot.held) continue;
      const lease = readComputerLease(botId);
      // `held=false` carries no lease generation and can arrive after a later
      // L2 take response on the separate HTTP connection. Keep any exact local
      // proof and let the heartbeat below validate it; only a 403 for that
      // exact proof may close its viewer.
      if (lease?.ownerId === computerOwnerId) continue;
      heartbeatFailures.current.delete(botId);
      closeBrowserDesktopViewer(botId);
      if (electronViewerLeases.current.has(botId)) {
        void window.ogb?.desktopViewer?.close(botId).catch(() => {});
      }
    }
  }, [computerOwnerId, state.computerControl]);

  // A server-owned short lease makes renderer reload/app quit/network loss
  // self-healing. Heartbeats continue even when the Computer panel is closed
  // but its separate live-desktop window remains open.
  useEffect(() => {
    const heartbeat = async () => {
      for (const [botId, snapshot] of Object.entries(state.computerControl)) {
        const lease = readComputerLease(botId);
        if (!lease || lease.ownerId !== computerOwnerId) continue;
        if (releasingControlLeases.current.has(computerLeaseReleaseKey(botId, lease))) continue;
        try {
          const fenced = await computerLeaseResultIfCurrent(botId, lease, async () => {
            const response = await fetch(`/api/bots/${botId}/computer/control`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "heartbeat", ...lease }),
              signal: AbortSignal.timeout(4_000),
            });
            const parsed = computerControlSnapshotSchema.safeParse(await response.json().catch(() => null));
            return { response, parsed };
          });
          if (!fenced.current) continue;
          const { response, parsed } = fenced.value;
          if (response.status === 403) {
            // This response belongs to the captured token. If the person has
            // already handed L1 back and taken L2, L1 may not clear or close L2.
            if (!clearComputerLeaseIfCurrent(botId, lease)) continue;
            heartbeatFailures.current.delete(botId);
            closeBrowserDesktopViewer(botId);
            void window.ogb?.desktopViewer?.close(botId).catch(() => {});
            if (parsed.success) {
              dispatch({
                type: "computerControl",
                botId,
                held: parsed.data.held,
                helpReason: parsed.data.helpReason,
              });
            }
            continue;
          }
          if (!response.ok) throw new Error(`heartbeat failed (${response.status})`);
          if (!parsed.success) throw new Error("heartbeat returned an invalid control snapshot");
          heartbeatFailures.current.delete(botId);
          // A delayed bare false event is not generation-bound. The successful
          // exact heartbeat is: restore held state for this L2 immediately.
          if (!snapshot.held) {
            dispatch({
              type: "computerControl",
              botId,
              held: parsed.data.held,
              helpReason: parsed.data.helpReason,
            });
          }
        } catch {
          if (!computerLeaseIsCurrent(botId, lease)) continue;
          // The server expires the lease after missed heartbeats. Do not claim
          // success or silently mint a replacement during a transport outage.
          // After one complete lease window of failed probes, close local
          // interaction and drop the proof; the server then expires it even if
          // the transport comes back in a half-open state.
          const previous = heartbeatFailures.current.get(botId);
          const failures = previous?.leaseToken === lease.leaseToken ? previous.count + 1 : 1;
          heartbeatFailures.current.set(botId, { leaseToken: lease.leaseToken, count: failures });
          if (failures >= 3) {
            heartbeatFailures.current.delete(botId);
            if (clearComputerLeaseIfCurrent(botId, lease)) {
              closeBrowserDesktopViewer(botId);
              void window.ogb?.desktopViewer?.close(botId).catch(() => {});
            }
          }
        }
      }
    };
    void heartbeat();
    const timer = window.setInterval(() => void heartbeat(), 5_000);
    return () => window.clearInterval(timer);
  }, [computerOwnerId, dispatch, state.computerControl]);

  useEffect(() => {
    const releaseOnUnload = () => {
      for (const [botId, snapshot] of Object.entries(state.computerControl)) {
        if (!snapshot.held) continue;
        const lease = readComputerLease(botId);
        if (!lease || lease.ownerId !== computerOwnerId) continue;
        void fetch(`/api/bots/${botId}/computer/control`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "release", ...lease }),
          keepalive: true,
        });
      }
    };
    window.addEventListener("pagehide", releaseOnUnload);
    return () => window.removeEventListener("pagehide", releaseOnUnload);
  }, [computerOwnerId, state.computerControl]);

  return (
    <div className="flex h-full flex-col">
      {/* fixed-position popup, bottom-left — outside the layout flow */}
      <UpdateBanner />
      <div className="relative flex min-h-0 flex-1">
      <button
        type="button"
        ref={menuButtonRef}
        aria-label="Open bot list"
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
        className="absolute left-3 top-3 z-30 rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink md:hidden"
      >
        <Menu size={18} />
      </button>
      {drawerOpen && (
        <div
          aria-hidden
          onMouseDown={(e) => e.target === e.currentTarget && setDrawerOpen(false)}
          className="absolute inset-0 z-30 bg-black/50 md:hidden"
        />
      )}
      <Sidebar
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          menuButtonRef.current?.focus();
        }}
      />
      {state.activeView === "team-map" ? (
        <TeamMapPage />
      ) : state.activeView === "routines" ? (
        <RoutinesPage />
      ) : state.activeView === "skill-recorder" ? (
        <SkillRecorderPage />
      ) : noEngines ? (
        <NoEngines />
      ) : group ? (
        <GroupView key={group.id} group={group} />
      ) : bot ? (
        <ChatView bot={bot} />
      ) : (
        <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
          <Loader2 size={20} className="animate-spin" />
          <div className="text-[14px]">
            {state.connected ? "No bots yet" : "Connecting to the bot server…"}
          </div>
          {!state.connected && (
            <div className="text-[12px]">
              Start it with <code className="rounded bg-raised px-1.5 py-0.5">pnpm dev</code>
            </div>
          )}
        </main>
      )}
      {state.settingsOpen && bot && <SettingsPanel bot={bot} />}
      {state.computerOpen && bot && <ComputerPanel key={bot.id} bot={bot} />}
      {state.inspectorOpen && bot && <InspectorPanel bot={bot} />}
      {state.appSettingsOpen && <SettingsModal />}
      {state.pluginsOpen && <PluginsPanel />}
      {/* mounted after the modals: same z-50 tier, so DOM order keeps the
          palette on top when one of them is open underneath */}
      <CommandPalette />
      {locallyControlledBots.length > 0 && (
        <div className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-30 flex max-h-[40vh] w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-1.5 overflow-y-auto rounded-xl border border-accent/25 bg-panel/95 p-2 text-[12px] text-ink shadow-2xl backdrop-blur">
          {locallyControlledBots.map((controlledBot) => (
            <div key={controlledBot.id} className="flex min-w-0 items-center gap-2">
              <span className="flex min-w-0 flex-1 items-center gap-1.5 px-1 font-medium">
                <Hand size={13} className="shrink-0 text-accent" />
                <span className="truncate">Controlling {controlledBot.name}</span>
              </span>
              <button
                type="button"
                onClick={() => {
                  dispatch({ type: "select", id: controlledBot.id });
                  dispatch({ type: "toggleComputer", open: true });
                }}
                className="flex shrink-0 items-center gap-1 rounded-lg bg-control px-2.5 py-1.5 hover:bg-raised-hover"
              >
                <Monitor size={12} /> Show
              </button>
              <button
                type="button"
                onClick={() => void handBackGlobalControl(controlledBot)}
                className="shrink-0 rounded-lg bg-accent px-2.5 py-1.5 font-medium text-white hover:brightness-110"
              >
                Hand back
              </button>
            </div>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}

export default function App() {
  const [gated, setGated] = useState(() => !emailGateDone());
  useEffect(() => {
    initAnalytics();
  }, []);
  return (
    <DesktopCapabilitiesProvider>
      <StoreProvider>
        <Shell />
        {gated && <Onboarding onDone={() => setGated(false)} />}
      </StoreProvider>
    </DesktopCapabilitiesProvider>
  );
}
