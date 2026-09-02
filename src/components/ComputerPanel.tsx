// The bot's computer, in the right-side slot. Where it runs decides the
// whole flow: cloud → provision the box on open (idempotent) and preview
// via SSE frames or a ~4s screenshot poll. macOS local mode keeps the legacy
// in-panel capture. Linux local mode is an automation readiness state and its
// separate preview remains explicitly user-initiated. Auto never selects a
// Linux user's desktop.
import { useEffect, useRef, useState } from "react";
import {
  CalendarDays,
  CalendarClock,
  Hand,
  Loader2,
  Maximize2,
  Monitor,
  Moon,
  PanelRightClose,
  Plus,
  Power,
  RefreshCw,
  Settings,
  Smartphone,
  Trash2,
} from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import type { Routine } from "@/lib/routines";
import { ApiKeyRow } from "./ApiKeys";
import { cn } from "@/lib/cn";
import { usePageVisible } from "@/lib/page-visible";
import { CloudBackendPicker } from "./CloudBackendPicker";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { RoutineEditor } from "./RoutinesPage";
import { AndroidDevicePanel, useAndroidUsbDevices } from "./AndroidDevicePanel";
import { LocalScreenPreview } from "./LocalScreenPreview";
import { LinuxLocalControl } from "./LinuxLocalControl";
import { MacLocalControl } from "./MacLocalControl";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { ComputerChildMonitorStrip } from "./ComputerChildMonitorStrip";
import {
  autoSelectsLocalComputer,
  instanceSupportsLocalComputer,
  linuxAutoDescription,
  localComputerDisabledReason,
  localComputerSelectable,
} from "@/lib/local-computer";
import { vpsComputerNeedsReplacement, type VpsComputerStatus } from "@/lib/vps-computer";
import { computerLocationCopy } from "@/lib/computer-location";
import {
  frameMatchesPreviewTarget,
  historicalFrameMatchesPreviewTarget,
  newestPreviewFrame,
  previewFreshness,
  selectComputerPanelPreview,
} from "@/lib/computer-preview";
import {
  collapseComputerPanel,
  escapeClosesComputerPanel,
} from "@/lib/computer-panel-navigation";
import { resolveDesktopViewerUrl } from "@/lib/desktop-viewer-url";
import {
  browserDesktopViewerIsOpen,
  closeBrowserDesktopViewer,
  focusBrowserDesktopViewer,
  onBrowserDesktopViewerState,
  trackBrowserDesktopViewer,
} from "@/lib/browser-desktop-viewer";
import {
  clearComputerLeaseIfCurrent,
  computerLeaseIsCurrent,
  computerLeaseResultIfCurrent,
  computerControlErrorSchema,
  computerControlSnapshotSchema,
  computerControlTakeSchema,
  computerControlOwnerId,
  computerPanelLeaseToken,
  computerReleaseFailureIsTerminal,
  computerScreenshotSchema,
  computerViewerJoinSchema,
  localComputerScreenshotSchema,
  readComputerLease,
  sameComputerLease,
  type StoredComputerLease,
  writeComputerLease,
} from "@/lib/computer-control-lease";
import {
  computerHandbackInProgress,
  handBackComputerControl,
  onComputerHandbackState,
} from "@/lib/computer-control-handback";
import { cloudComputerRemovalConfirmation } from "@/lib/cloud-computer-removal";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

type Phase =
  | "checking"
  | "unconfigured"
  | "starting"
  | "ready"
  | "vm"
  | "vm-unavailable"
  | "vps-unconfigured"
  | "vps-incompatible"
  | "vps-stopped"
  | "local"
  | "local-unavailable"
  | "off"
  | "error";

type ControlSurface = "physical" | "cloud" | "vm";

function controlSurfaceForPhase(phase: Phase): ControlSurface | null {
  if (phase === "local") return "physical";
  if (phase === "vm") return "vm";
  if (phase === "ready") return "cloud";
  return null;
}

function phaseForControlSurface(surface: ControlSurface): Phase {
  if (surface === "physical") return "local";
  if (surface === "vm") return "vm";
  return "ready";
}

interface LocalVmStatus {
  mode: "shared" | "per-bot";
  max_instances: number;
  image: boolean;
  create_supported: boolean;
  container: "running" | "stopped" | "missing";
  imageMatches: boolean;
  managed: boolean;
  network: "loopback" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  persistence: "durable" | "unsafe" | "unknown";
  desktopReady: boolean;
  ready: boolean;
  problem: string | null;
  viewer_available?: boolean;
  /** Legacy shared-host builds only. New remote-safe builds never expose the
   * container port or VNC password to the renderer. */
  viewer_url?: string;
}

function routineScheduleLabel(routine: Routine) {
  if (routine.schedule.type === "once") {
    return new Date(routine.schedule.at).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  const days = routine.schedule.weekdays;
  const cadence =
    days.length === 7
      ? "Every day"
      : days.join(",") === "1,2,3,4,5"
        ? "Weekdays"
        : days.map((day) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]).join(", ");
  const [hour, minute] = routine.schedule.time.split(":").map(Number);
  return `${cadence} · ${new Date(2000, 0, 1, hour, minute).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function nextRunLabel(at: number | null) {
  if (at == null) return "Paused";
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return `${sameDay ? "Today" : date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

export function ComputerPanel({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
  const computerCopy = computerLocationCopy(capabilities);
  const localAvailable = capabilities.localComputer.available;
  const isLinux = capabilities.host.platform === "linux";
  const providerSupportsLocal = instanceSupportsLocalComputer(state.instances, bot);
  const localSelectable = localComputerSelectable({ capabilities, providerSupportsLocal });
  const [localAutoWarning, setLocalAutoWarning] = useState<"auto" | "local" | null>(null);
  const localDisabledReason = localComputerDisabledReason({ capabilities, providerSupportsLocal });
  const [phase, setPhase] = useState<Phase>("checking");
  const [boxState, setBoxState] = useState<string | null>(null);
  const [polledFrame, setPolledFrame] = useState<{ png: string; mime: string; at: number } | null>(null);
  const [vmFrame, setVmFrame] = useState<{ src: string; at: number } | null>(null);
  // The renderer learns only that a viewer exists. Opening it mints a short-
  // lived same-origin session bound to this exact bot and VM generation.
  const [vmViewerAvailable, setVmViewerAvailable] = useState(false);
  const [vmStatus, setVmStatus] = useState<LocalVmStatus | null>(null);
  const [vpsStatus, setVpsStatus] = useState<VpsComputerStatus | null>(null);
  const [localFrame, setLocalFrame] = useState<string | null>(null);
  const [pending, setPending] = useState<
    | "join"
    | "sleep"
    | "provision"
    | "box-delete"
    | "vps-remove"
    | "vps-replace"
    | "vm-create"
    | "vm-recreate"
    | "vm-delete"
    | null
  >(null);
  const [controlPending, setControlPending] = useState(false);
  const [controlTargetKey, setControlTargetKey] = useState<string | null>(null);
  const [controlTargetGeneration, setControlTargetGeneration] = useState<string | null>(null);
  const ownerId = useRef(computerControlOwnerId()).current;
  const [leaseToken, setLeaseToken] = useState(() => computerPanelLeaseToken(bot.id, ownerId));
  const [electronViewerOpen, setElectronViewerOpen] = useState(false);
  const [browserViewerOpen, setBrowserViewerOpen] = useState(() => browserDesktopViewerIsOpen(bot.id));
  const [handbackPending, setHandbackPending] = useState(() => computerHandbackInProgress(bot.id));
  const viewerOpen = electronViewerOpen || browserViewerOpen;
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewNow, setPreviewNow] = useState(Date.now());
  const [creatingRoutine, setCreatingRoutine] = useState(false);
  const [panelView, setPanelView] = useState<"computer" | "android">("computer");
  const androidStatus = useAndroidUsbDevices();
  const androidConnected = androidStatus.devices.length > 0;
  // bumped when a Box API key is saved inline, to re-run the spin-up flow
  const [retry, setRetry] = useState(0);
  const vmReadinessAttempts = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  const collapseButtonRef = useRef<HTMLButtonElement>(null);
  const [mobilePanel, setMobilePanel] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  const desktopOperationGeneration = useRef(0);
  const desktopOperationAbort = useRef<AbortController | null>(null);
  const selectedInstance = state.instances.find(
    (instance) => instance.instanceId === bot.modelSelection.instanceId,
  );
  const computerMode = bot.computer ?? "auto";
  const autoMayUseLocal = autoSelectsLocalComputer({
    platform: capabilities.host.platform,
    computer: undefined,
    capabilitiesReady,
    localSelectable,
  });

  // The panel intentionally stays mounted when a session tile selects another
  // bot. Fence any in-flight take/join from the old bot immediately and reset
  // transient UI state; otherwise the old continuation could open the wrong
  // desktop, or leave the new bot's controls permanently disabled as "join".
  useEffect(() => {
    desktopOperationGeneration.current += 1;
    desktopOperationAbort.current?.abort();
    desktopOperationAbort.current = null;
    setPending(null);
    setControlPending(false);
    setLeaseToken(computerPanelLeaseToken(bot.id, ownerId));
    return () => {
      desktopOperationGeneration.current += 1;
      desktopOperationAbort.current?.abort();
      desktopOperationAbort.current = null;
    };
  }, [bot.id, ownerId]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setMobilePanel(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // Seed the separate viewer state so the panel can explain that its
  // watch-only preview is intentionally continuing behind the live window.
  useEffect(() => {
    let alive = true;
    const dv = window.ogb?.desktopViewer;
    if (dv?.currentState) {
      void dv
        .currentState(bot.id)
        .then((s) => {
          if (alive) setElectronViewerOpen(s.open && s.contextId === bot.id);
        })
        .catch(() => {});
    }
    const off = dv?.onState((viewer) => {
      if (viewer.contextId === bot.id) setElectronViewerOpen(viewer.open);
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [bot.id]);

  useEffect(() => {
    setBrowserViewerOpen(browserDesktopViewerIsOpen(bot.id));
    return onBrowserDesktopViewerState((viewerBotId, open) => {
      if (viewerBotId === bot.id) setBrowserViewerOpen(open);
    });
  }, [bot.id]);

  useEffect(() => {
    setHandbackPending(computerHandbackInProgress(bot.id));
    return onComputerHandbackState((handbackBotId, active) => {
      if (handbackBotId !== bot.id) return;
      setHandbackPending(active);
      if (!active) return;
      desktopOperationGeneration.current += 1;
      desktopOperationAbort.current?.abort();
      desktopOperationAbort.current = null;
    });
  }, [bot.id]);

  useEffect(() => {
    if (!androidConnected && panelView === "android") setPanelView("computer");
  }, [androidConnected, panelView]);
  useEffect(() => {
    vmReadinessAttempts.current = 0;
  }, [bot.id, bot.computer]);
  const vmSupported = Boolean(
    selectedInstance?.snapshot.state === "available" &&
      selectedInstance.capabilities?.computerMcp &&
      selectedInstance.driverKind !== "boxAgent",
  );
  const computerToolSupported = selectedInstance?.capabilities?.computerMcp === true;
  const vpsSupported = Boolean(computerToolSupported && selectedInstance?.driverKind !== "boxAgent");
  const cloudBackend = bot.cloudBackend ?? "box";
  const cloudSupported = cloudBackend === "vps"
    ? vpsSupported
    : computerToolSupported || selectedInstance?.driverKind === "boxAgent";
  const botRoutines = state.routines
    .filter((routine) => routine.botId === bot.id)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
  const cloudRoutineReady = Boolean(
    state.config?.box.configured &&
      state.instances.some((instance) => instance.driverKind === "boxAgent" && instance.snapshot.state === "available"),
  );
  const activeRoutineRun = state.routineRuns.find(
    (run) => run.botId === bot.id && ["queued", "running", "waiting"].includes(run.status),
  );
  const computerDestination =
    bot.computer === "cloud"
      ? cloudBackend === "vps" ? "this self-hosted VPS" : "this cloud box"
      : bot.computer === "vm"
        ? computerCopy.vmDestination
      : bot.computer === "local"
        ? computerCopy.localDestination
        : bot.computer === "off"
          ? null
          : phase === "ready"
            ? cloudBackend === "vps" ? "the self-hosted VPS selected by Auto" : "the cloud box selected by Auto"
            : `${computerCopy.localDestination} selected by Auto`;

  // resolve the mode on open; box endpoints are only ever hit on the
  // cloud path, so local/off can never render a JSON error as an image
  useEffect(() => {
    let alive = true;
    setPhase("checking");
    setPolledFrame(null);
    setVmFrame(null);
    setVmViewerAvailable(false);
    setVmStatus(null);
    setVpsStatus(null);
    setLocalFrame(null);
    setError(null);
    setPreviewError(null);
    // A destination transition invalidates prior live identity immediately;
    // the control snapshot below will install the new exact target.
    setControlTargetKey(null);
    setControlTargetGeneration(null);
    if (bot.computer === "off") {
      setPhase("off");
      return;
    }
    if (bot.computer === "local") {
      if (!providerSupportsLocal) {
        setError("This model engine cannot control this computer. Choose Claude or an ACP engine.");
      }
      setPhase(capabilitiesReady && localAvailable && providerSupportsLocal ? "local" : "local-unavailable");
      return;
    }
    if (bot.computer === "vm") {
      if (!vmSupported) {
        setError("This model engine cannot use the Local VM. Choose Claude or an ACP engine.");
        setPhase("vm-unavailable");
        return;
      }
      let retryTimer: number | undefined;
      api(`/api/bots/${bot.id}/local-computer`)
        .then((rawStatus) => {
          if (!alive) return;
          const status: LocalVmStatus = rawStatus;
          setVmStatus(status);
          // Modern servers keep the port/password private and expose only
          // availability. The legacy URL check keeps same-machine dev builds
          // usable during a rolling server/client update.
          const legacyViewerUrl = String(status.viewer_url ?? "");
          setVmViewerAvailable(status.viewer_available === true || legacyViewerUrl.startsWith("http"));
          if (status.ready) {
            vmReadinessAttempts.current = 0;
            setPhase("vm");
          } else if (
            status.container === "running" &&
            status.imageMatches &&
            status.managed &&
            status.network === "loopback" &&
            status.security === "hardened" &&
            status.persistence === "durable" &&
            !status.desktopReady &&
            vmReadinessAttempts.current < 15
          ) {
            vmReadinessAttempts.current += 1;
            setError(null);
            setPhase("checking");
            retryTimer = window.setTimeout(() => setRetry((n) => n + 1), 2000);
          }
          else {
            const canCreateHere =
              status.mode === "per-bot" &&
              status.container === "missing" &&
              status.image &&
              status.create_supported;
            setError(canCreateHere ? null : `${status.problem ?? "The Local VM is not ready"}. Open App Settings → Local VM.`);
            setPhase("vm-unavailable");
          }
        })
        .catch((e) => {
          if (!alive) return;
          setError(e.message);
          setPhase("vm-unavailable");
        });
      return () => {
        alive = false;
        if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      };
    }
    if (bot.computer === "cloud" && !cloudSupported) {
      setError("This model engine cannot use cloud computer tools. Choose Claude, an ACP engine, or the Computer engine.");
      setPhase("error");
      return;
    }
    if (bot.computer !== "cloud" && !capabilitiesReady) return;
    if (cloudBackend === "vps") {
      const autoLocal =
        !isLinux && bot.computer !== "cloud" && capabilitiesReady && localSelectable;
      if (!vpsSupported) {
        if (autoLocal) setPhase("local");
        else {
          setError("This model engine cannot use a self-hosted VPS. Choose Claude or an ACP engine, or switch the cloud backend to Box.");
          setPhase("error");
        }
        return;
      }
      api(`/api/bots/${bot.id}/computer`)
        .then((rawStatus) => {
          if (!alive) return;
          const status: VpsComputerStatus = rawStatus;
          setVpsStatus(status);
          if (!status.configured) {
            if (autoLocal) setPhase("local");
            else {
              setError("Add the VPS SSH config alias in App Settings → Connections.");
              setPhase("vps-unconfigured");
            }
            return;
          }
          if (status.ready) {
            setBoxState(status.container ?? null);
            setPhase("ready");
            return;
          }
          // App updates can bump IMAGE_LAYER_VERSION while this bot still has
          // a managed container from the previous release. Provision refuses
          // to overwrite it by design, so surface the explicit replacement
          // path instead of automatically issuing a request that can only 409.
          if (vpsComputerNeedsReplacement(status)) {
            setError(status.problem);
            setPhase("vps-incompatible");
            return;
          }
          if (bot.computer === "cloud") {
            setPhase("starting");
            return api(`/api/bots/${bot.id}/computer/provision`, { method: "POST" }).then((result) => {
              if (!alive) return;
              setBoxState(result.container ?? null);
              if (result.ready) setPhase("ready");
              else {
                setError(result.problem ?? "The VPS Cua desktop is not ready yet");
                setPhase("error");
              }
            });
          }
          if (autoLocal) {
            setPhase("local");
            return;
          }
          setBoxState(status.container ?? null);
          setError(
            bot.autoStartVps
              ? `${status.problem ?? "No ready VPS container"}. Auto will prepare or wake it when this bot next works.`
              : `${status.problem ?? "No ready VPS container"}. Enable Start VPS automatically below, or choose Cloud to provision it.`,
          );
          setPhase(status.container === "stopped" ? "vps-stopped" : "vps-unconfigured");
        })
        .catch((e) => {
          if (!alive) return;
          setError(e.message);
          setPhase("error");
        });
      return () => {
        alive = false;
      };
    }
    // cloud, or auto (cloud box wins when one exists, else local in-app)
    api(`/api/bots/${bot.id}/computer`)
      .then((status) => {
        if (!alive) return;
        const autoLocal = autoSelectsLocalComputer({
          platform: capabilities.host.platform,
          computer: bot.computer,
          capabilitiesReady,
          localSelectable,
        });
        if (!status.configured) {
          setPhase(autoLocal ? "local" : "unconfigured");
          return;
        }
        if (!status.box && autoLocal) {
          setPhase("local");
          return;
        }
        setPhase("starting");
        return api(`/api/bots/${bot.id}/computer/provision`, { method: "POST" }).then((r) => {
          if (!alive) return;
          setBoxState(r.state ?? null);
          setPhase("ready");
        });
      })
      .catch((e) => {
        if (!alive) return;
        setError(e.message);
        setPhase("error");
      });
    return () => {
      alive = false;
    };
  }, [
    bot.id,
    bot.computer,
    bot.autoStartVps,
    cloudBackend,
    retry,
    capabilitiesReady,
    localSelectable,
    isLinux,
    providerSupportsLocal,
    vmSupported,
    cloudSupported,
    vpsSupported,
    state.config?.vps?.sshAlias,
  ]);

  // Cloud preview prefers a fresh SSE stream while the bot works, then falls
  // back to exact-target polls. A one-shot expiry prevents a frame from an old
  // turn suppressing polls forever.
  const pageVisible = usePageVisible();
  const candidateLive = state.screens[bot.id];
  const live = frameMatchesPreviewTarget(
    candidateLive,
    controlTargetKey,
    controlTargetGeneration,
  ) ? candidateLive : undefined;
  useEffect(() => {
    if (phase === "ready" && live) setPreviewError(null);
  }, [phase, live]);
  // A poll response has no transport-level target metadata. Bind its whole
  // lifecycle to the exact control snapshot instead: changing computer or
  // dispatch generation aborts the old request and removes its last frame
  // before the new target can render.
  useEffect(() => {
    setPolledFrame(null);
    setVmFrame(null);
  }, [bot.id, controlTargetKey, controlTargetGeneration]);
  const [sseFlowing, setSseFlowing] = useState(false);
  useEffect(() => {
    if (!bot.busy || !live) {
      setSseFlowing(false);
      return;
    }
    const remaining = Math.max(0, 8_000 - (Date.now() - live.at));
    if (remaining === 0) {
      setSseFlowing(false);
      return;
    }
    setSseFlowing(true);
    const timer = window.setTimeout(() => setSseFlowing(false), remaining);
    return () => window.clearTimeout(timer);
  }, [bot.busy, live]);
  useEffect(() => {
    if (phase !== "ready" || (sseFlowing && !viewerOpen) || !pageVisible) return;
    let alive = true;
    let inFlight = false;
    const controller = new AbortController();
    const shoot = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const { png, format } = computerScreenshotSchema.parse(
          await api(`/api/bots/${bot.id}/computer/screenshot`, {
            method: "POST",
            signal: controller.signal,
          }),
        );
        if (alive) {
          setPolledFrame({ png, mime: format === "jpeg" ? "image/jpeg" : "image/png", at: Date.now() });
          setPreviewError(null);
        }
      } catch (e) {
        if (alive && !controller.signal.aborted) {
          setPreviewError(e instanceof Error ? e.message : "Preview capture failed");
        }
      } finally {
        inFlight = false;
      }
    };
    void shoot();
    const timer = setInterval(shoot, bot.busy || viewerOpen ? 4000 : 30_000);
    return () => {
      alive = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [
    phase,
    sseFlowing,
    bot.id,
    pageVisible,
    bot.busy,
    viewerOpen,
    controlTargetKey,
    controlTargetGeneration,
  ]);

  // Local VM preview comes directly from Cua Driver through the harness. It
  // does not use the password-protected noVNC viewer or cloud endpoints.
  useEffect(() => {
    if (phase !== "vm" || !pageVisible) return;
    let alive = true;
    let inFlight = false;
    const controller = new AbortController();
    const shoot = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const { image } = localComputerScreenshotSchema.parse(
          await api(`/api/bots/${bot.id}/local-computer/screenshot`, {
            method: "POST",
            signal: controller.signal,
          }),
        );
        if (alive) {
          setVmFrame({ src: image, at: Date.now() });
          setPreviewError(null);
        }
      } catch (e) {
        if (alive && !controller.signal.aborted) {
          setPreviewError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        inFlight = false;
      }
    };
    void shoot();
    const timer = window.setInterval(() => void shoot(), bot.busy || viewerOpen ? 3000 : 30_000);
    return () => {
      alive = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [
    phase,
    bot.id,
    pageVisible,
    bot.busy,
    viewerOpen,
    controlTargetKey,
    controlTargetGeneration,
  ]);

  // local preview: frames from the Electron main process. The FIRST capture
  // attempt is what makes macOS show the Screen Recording prompt (there is
  // no reliable pre-grant flow on macOS 15+), so repeated empty frames mean
  // the user denied — surface the Settings repair path instead of spinning.
  const [localMisses, setLocalMisses] = useState(0);
  useEffect(() => {
    if (phase !== "local" || !window.ogb || isLinux || !pageVisible) return;
    let alive = true;
    setLocalMisses(0);
    const shoot = async () => {
      try {
        const url = await window.ogb!.screenFrame();
        if (alive && url) setLocalFrame(url);
        else if (alive) setLocalMisses((n) => n + 1);
      } catch {
        if (alive) setLocalMisses((n) => n + 1);
      }
    };
    void shoot();
    // A real ScreenCaptureKit capture + PNG encode per tick: idle bots get a
    // slow heartbeat, working ones the live cadence.
    const timer = setInterval(shoot, bot.busy || viewerOpen ? 3000 : 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [phase, isLinux, pageVisible, bot.busy, viewerOpen]);

  const lastScreenMessage = [...bot.messages].reverse().find(
    (m) =>
      m.kind === "screen" &&
      m.png &&
      historicalFrameMatchesPreviewTarget(m, controlTargetKey, controlTargetGeneration),
  );
  // Transcript screenshots are historical and carry a remote-host timestamp.
  // They are a visual fallback only: never let one outrank a frame received or
  // captured by this client, and mark it stale instead of pretending that
  // opening the panel made it current.
  const historicalFrame = lastScreenMessage
    ? { png: lastScreenMessage.png!, mime: lastScreenMessage.mime ?? "image/png", at: 0 }
    : null;
  const cloudFrame = newestPreviewFrame([live, polledFrame]) ?? historicalFrame;
  const frameSrc = selectComputerPanelPreview({
    surface: phase === "vm"
      ? "vm"
      : phase === "local" && !isLinux
        ? "physical"
        : phase === "ready" || phase === "starting"
          ? "cloud"
          : "none",
    vm: vmFrame?.src ?? null,
    physical: localFrame,
    cloud: cloudFrame && `data:${cloudFrame.mime};base64,${cloudFrame.png}`,
  });
  const frameAt = phase === "vm" ? vmFrame?.at ?? null : cloudFrame?.at ?? null;
  const freshness = previewFreshness(frameAt, previewNow, Boolean(bot.busy || viewerOpen));
  useEffect(() => {
    if (!pageVisible) return;
    setPreviewNow(Date.now());
    const timer = window.setInterval(() => setPreviewNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [pageVisible]);

  // who-is-driving: SSE keeps this fresh; the mount fetch covers a panel
  // opened after the last frame (e.g. an app reload mid-hold)
  const control = state.computerControl[bot.id] ?? { held: false, helpReason: null };
  const storedLease = readComputerLease(bot.id);
  const controlIsMine = Boolean(
    control.held &&
      storedLease?.ownerId === ownerId &&
      storedLease.leaseToken === leaseToken,
  );
  const controlSurface = controlSurfaceForPhase(phase);
  const operationBusy = pending !== null || controlPending || handbackPending;
  const legacyDesktopAppWithoutViewer = Boolean(window.ogb && !window.ogb.desktopViewer);
  const viewerUnavailableReason =
    (phase === "vm" || phase === "ready") && legacyDesktopAppWithoutViewer
      ? "Update the OpenMaus desktop app before taking control. This older Mac controller cannot safely confirm or revoke a live desktop."
      : phase === "ready" && cloudBackend === "box" && !window.ogb?.desktopViewer
        ? "Interactive cloud Box control requires the OpenMaus desktop app so the viewer closes safely on reload or a browser crash. The browser preview still works."
        : null;
  const previewOpensDesktop = Boolean(
    frameSrc &&
      !viewerUnavailableReason &&
      (!control.held || controlIsMine) &&
      ((phase === "vm" && vmViewerAvailable) || phase === "ready"),
  );
  useEffect(() => {
    if (!controlSurface) return;
    let alive = true;
    let inFlight = false;
    const controller = new AbortController();
    const refreshControl = () => {
      if (inFlight) return;
      inFlight = true;
      const leaseAtRequestStart = readComputerLease(bot.id);
      api(`/api/bots/${bot.id}/computer/control?surface=${controlSurface}`, {
        signal: controller.signal,
      }).then(async (rawSnapshot) => {
        if (!alive) return;
        const snap = computerControlSnapshotSchema.parse(rawSnapshot);
        setControlTargetKey(snap.targetKey ?? null);
        setControlTargetGeneration(snap.targetGeneration ?? null);
        if (snap.targetSurface && snap.targetSurface !== controlSurface && (snap.held || bot.busy)) {
          // An active/held exact target outranks an Auto availability guess.
          // This keeps the preview and takeover card attached to the computer
          // the bot is really using, even if availability changes mid-turn.
          setPhase(phaseForControlSurface(snap.targetSurface));
        }
        if (snap.held !== true) {
          const currentLease = readComputerLease(bot.id);
          if (currentLease?.ownerId === ownerId) {
            // A GET started under L1 can return after another flow installed
            // L2. Bare false has no generation, so validate whichever exact
            // proof is current instead of erasing it.
            const probe = await computerLeaseResultIfCurrent(bot.id, currentLease, async () => {
              const response = await fetch(`/api/bots/${bot.id}/computer/control`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: "heartbeat", ...currentLease }),
                signal: controller.signal,
              });
              const parsed = computerControlSnapshotSchema.safeParse(await response.json().catch(() => null));
              return { response, parsed };
            });
            if (!alive || !probe.current) return;
            if (probe.value.response.ok && probe.value.parsed.success) {
              dispatch({
                type: "computerControl",
                botId: bot.id,
                held: probe.value.parsed.data.held,
                helpReason: probe.value.parsed.data.helpReason,
              });
              return;
            }
            if (probe.value.response.status === 403) {
              const cleared = clearComputerLeaseIfCurrent(bot.id, currentLease);
              if (!cleared) return;
              setLeaseToken((currentToken) => currentToken === currentLease.leaseToken ? null : currentToken);
              closeBrowserDesktopViewer(bot.id);
              void window.ogb?.desktopViewer?.close(bot.id).catch(() => {});
              dispatch({
                type: "computerControl",
                botId: bot.id,
                held: false,
                helpReason: probe.value.parsed.success ? probe.value.parsed.data.helpReason : snap.helpReason,
              });
            }
            return;
          }
          // When the request began with a local proof but a successor was
          // installed before this continuation, even a now-empty read is not
          // authority to publish the old false snapshot.
          if (leaseAtRequestStart?.ownerId === ownerId) return;
        }
        dispatch({
          type: "computerControl",
          botId: bot.id,
          held: snap.held === true,
          helpReason: snap.helpReason,
        });
      }).catch(() => {
        if (!alive) return;
        // No authoritative target means no SSE frame may claim to be live.
        setControlTargetKey(null);
        setControlTargetGeneration(null);
      }).finally(() => {
        inFlight = false;
      });
    };
    void refreshControl();
    // `busy` flips before async provider/computer setup registers the exact
    // dispatch generation. Re-resolve during that setup window so the first
    // correctly tagged SSE frame becomes visible instead of being discarded
    // for the whole turn after one early GET returned generation:null.
    const timer = bot.busy ? window.setInterval(refreshControl, 1_000) : null;
    return () => {
      alive = false;
      controller.abort();
      if (timer !== null) window.clearInterval(timer);
    };
  }, [bot.busy, bot.id, controlSurface, dispatch]);
  const requestControl = async (
    action: "take" | "release" | "dismiss-help",
    signal?: AbortSignal,
    leaseProof?: StoredComputerLease,
  ) => {
    const leaseAtRequestStart = readComputerLease(bot.id);
    const requestLease = action === "release"
      ? leaseProof ?? (leaseAtRequestStart?.ownerId === ownerId ? leaseAtRequestStart : null)
      : null;
    const requestOwnerId = requestLease?.ownerId ?? ownerId;
    const token = requestLease?.leaseToken ?? null;
    if (action === "take" && !controlSurface) {
      throw new Error("Wait for the computer destination to finish loading");
    }
    if (action === "release" && !requestLease) {
      throw new Error("This window no longer owns computer control");
    }
    const body = action === "take"
      ? { action, ownerId, surface: controlSurface }
      : action === "release"
        ? { action, ownerId: requestOwnerId, leaseToken: token }
        : { action };
    const response = await fetch(`/api/bots/${bot.id}/computer/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const rawSnapshot: unknown = await response.json().catch(() => null);
    const parsedSnapshot = computerControlSnapshotSchema.safeParse(rawSnapshot);
    if (!response.ok) {
      // Viewer-close and the always-mounted Shell may race to release the
      // same exact lease. A 403 snapshot that is already unheld is the
      // idempotent success state, not a reason to tell the user hand-back
      // failed after the computer is already safe.
      if (action === "release" && requestLease && computerReleaseFailureIsTerminal(response.status)) {
        const cleared = clearComputerLeaseIfCurrent(bot.id, requestLease);
        if (cleared) {
          setLeaseToken((currentToken) => currentToken === requestLease.leaseToken ? null : currentToken);
          if (parsedSnapshot.success) {
            dispatch({
              type: "computerControl",
              botId: bot.id,
              held: parsedSnapshot.data.held,
              helpReason: parsedSnapshot.data.helpReason,
            });
          }
        }
        if (parsedSnapshot.success && parsedSnapshot.data.held === false) {
          return parsedSnapshot.data;
        }
      }
      const parsedError = computerControlErrorSchema.safeParse(rawSnapshot);
      throw new Error(parsedError.success ? parsedError.data.error : `${response.status} ${response.statusText}`);
    }
    const snap = parsedSnapshot.success
      ? parsedSnapshot.data
      : computerControlSnapshotSchema.parse(rawSnapshot);
    if (action === "take") {
      const taken = computerControlTakeSchema.parse(rawSnapshot);
      const currentBeforeWrite = readComputerLease(bot.id);
      const requestGenerationIsCurrent = leaseAtRequestStart === null
        ? currentBeforeWrite === null
        : sameComputerLease(currentBeforeWrite, leaseAtRequestStart);
      if (!requestGenerationIsCurrent) {
        // The server minted this take, but another local flow already installed
        // a successor proof before its HTTP response arrived. Never overwrite
        // that successor; retire only the exact token returned here.
        await fetch(`/api/bots/${bot.id}/computer/control`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "release", ownerId, leaseToken: taken.leaseToken }),
          keepalive: true,
        }).catch(() => null);
        throw new DOMException("Computer control request was superseded", "AbortError");
      }
      writeComputerLease(bot.id, { ownerId, leaseToken: taken.leaseToken });
      setLeaseToken(taken.leaseToken);
      dispatch({
        type: "computerControl",
        botId: bot.id,
        held: taken.held,
        helpReason: taken.helpReason,
      });
    } else if (action === "release") {
      const cleared = clearComputerLeaseIfCurrent(bot.id, requestLease!);
      if (cleared) {
        setLeaseToken((currentToken) => currentToken === requestLease!.leaseToken ? null : currentToken);
        dispatch({
          type: "computerControl",
          botId: bot.id,
          held: snap.held,
          helpReason: snap.helpReason,
        });
      }
    } else {
      dispatch({
        type: "computerControl",
        botId: bot.id,
        held: snap.held,
        helpReason: snap.helpReason,
      });
    }
    return snap;
  };

  const releaseClosedBrowserViewer = async (closedLease: { ownerId: string; leaseToken: string }) => {
    // Stop the app-wide heartbeat immediately. If the release request cannot
    // reach the server, its short lease then expires instead of pausing the
    // bot forever merely because a plain-browser noVNC tab was closed.
    if (clearComputerLeaseIfCurrent(bot.id, closedLease)) {
      setLeaseToken((currentToken) => currentToken === closedLease.leaseToken ? null : currentToken);
    }
    try {
      const response = await fetch(`/api/bots/${bot.id}/computer/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "release", ...closedLease }),
        keepalive: true,
      });
      const raw: unknown = await response.json().catch(() => null);
      const snapshot = computerControlSnapshotSchema.safeParse(raw);
      const currentLease = readComputerLease(bot.id);
      if (snapshot.success && (currentLease === null || sameComputerLease(currentLease, closedLease))) {
        dispatch({
          type: "computerControl",
          botId: bot.id,
          held: snapshot.data.held,
          helpReason: snapshot.data.helpReason,
        });
      }
    } catch {
      // The local proof is already gone, so lease expiry is the bounded
      // recovery path for a server/tunnel outage.
    }
  };

  const controlAction = (action: "take" | "release" | "dismiss-help") => {
    if (controlPending || pending !== null) return;
    setControlPending(true);
    setError(null);
    requestControl(action)
      .then(() => setError(null))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setControlPending(false));
  };

  const handBackControl = async () => {
    if (handbackPending) return;
    setControlPending(true);
    setError(null);
    try {
      const releaseLease = readComputerLease(bot.id);
      if (!releaseLease || releaseLease.ownerId !== ownerId) {
        throw new Error("This window no longer owns computer control");
      }
      await handBackComputerControl({
        botId: bot.id,
        desktopViewer: window.ogb?.desktopViewer,
        release: async () => { await requestControl("release", undefined, releaseLease); },
        closeBrowserViewer: () => { closeBrowserDesktopViewer(bot.id); },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setControlPending(false);
    }
  };

  const openDesktop = async () => {
    if (pending !== null || controlPending || handbackPending || computerHandbackInProgress(bot.id)) return;
    if (viewerUnavailableReason) {
      setError(viewerUnavailableReason);
      return;
    }
    if (!window.ogb?.desktopViewer && focusBrowserDesktopViewer(bot.id)) return;
    const generation = ++desktopOperationGeneration.current;
    const controller = new AbortController();
    desktopOperationAbort.current?.abort();
    desktopOperationAbort.current = controller;
    const ensureCurrent = () => {
      if (controller.signal.aborted || desktopOperationGeneration.current !== generation) {
        throw new DOMException("Desktop open was superseded", "AbortError");
      }
    };
    setPending("join");
    setControlPending(true);
    setError(null);
    let tookControlLease: StoredComputerLease | null = null;
    // A plain-web development session still needs a synchronous blank tab;
    // the packaged app uses the reliable Electron viewer window below.
    let fallbackTab: Window | null = null;
    if (!window.ogb?.desktopViewer) {
      fallbackTab = window.open("", "_blank");
      if (fallbackTab) fallbackTab.opener = null;
    }
    try {
      if (!control.held) {
        await requestControl("take");
        const acquired = readComputerLease(bot.id);
        if (!acquired || acquired.ownerId !== ownerId) {
          throw new DOMException("Computer control request was superseded", "AbortError");
        }
        tookControlLease = { ...acquired };
      } else {
        const existingLease = readComputerLease(bot.id);
        if (!existingLease || existingLease.ownerId !== ownerId) {
          throw new Error("Another OpenMausBot window is controlling this computer");
        }
      }
      ensureCurrent();

      const joinPath = phase === "vm"
        ? `/api/bots/${bot.id}/local-computer/join`
        : `/api/bots/${bot.id}/computer/join`;
      const activeLease = readComputerLease(bot.id);
      if (!activeLease || activeLease.ownerId !== ownerId) {
        throw new Error("The computer control lease was lost before the desktop opened");
      }
      const { joinUrl: rawViewerUrl } = computerViewerJoinSchema.parse(
        await api(joinPath, {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({
            ownerId: activeLease?.ownerId,
            leaseToken: activeLease?.leaseToken,
          }),
        }),
      );
      ensureCurrent();
      if (!computerLeaseIsCurrent(bot.id, activeLease)) {
        throw new DOMException("Desktop control lease was superseded", "AbortError");
      }
      // Local VM sessions are deliberately same-origin relative URLs so the
      // existing Mac→Razer harness tunnel carries both noVNC assets and its
      // WebSocket. Cloud providers may still return an absolute HTTPS URL.
      const viewerUrl = resolveDesktopViewerUrl({
        rawUrl: rawViewerUrl,
        appUrl: window.location.href,
        botId: bot.id,
        transport: phase === "vm" || cloudBackend === "vps" ? "proxied" : "hosted",
      });

      if (window.ogb?.desktopViewer) {
        const opened = await window.ogb.desktopViewer.open(viewerUrl, `${bot.name}'s live desktop`, bot.id);
        if (
          desktopOperationGeneration.current !== generation ||
          !computerLeaseIsCurrent(bot.id, activeLease)
        ) {
          await window.ogb.desktopViewer.close(bot.id).catch(() => false);
        }
        ensureCurrent();
        if (!computerLeaseIsCurrent(bot.id, activeLease)) {
          throw new DOMException("Desktop control lease was superseded", "AbortError");
        }
        if (!opened) throw new Error("OpenMausBot could not open the live desktop");
      } else if (fallbackTab) {
        ensureCurrent();
        fallbackTab.location.replace(viewerUrl);
        if (!activeLease) throw new Error("The computer control lease was lost before the desktop opened");
        trackBrowserDesktopViewer(bot.id, fallbackTab, () => releaseClosedBrowserViewer(activeLease));
      } else {
        const viewerTab = window.open(viewerUrl, "_blank", "noopener");
        if (!viewerTab) throw new Error("Your browser blocked the live desktop tab");
        if (!activeLease) throw new Error("The computer control lease was lost before the desktop opened");
        trackBrowserDesktopViewer(bot.id, viewerTab, () => releaseClosedBrowserViewer(activeLease));
      }
    } catch (e) {
      fallbackTab?.close();
      // Release the bot before waiting on best-effort tunnel cleanup. A sick
      // SSH process must never leave the agent paused indefinitely.
      if (tookControlLease) await requestControl("release", undefined, tookControlLease).catch(() => {});
      if (desktopOperationGeneration.current === generation && !(e instanceof DOMException && e.name === "AbortError")) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (desktopOperationGeneration.current === generation) {
        desktopOperationAbort.current = null;
        setPending(null);
        setControlPending(false);
      }
    }
  };

  const run = (kind: "sleep" | "provision") => {
    setPending(kind);
    setError(null);
    api(`/api/bots/${bot.id}/computer/${kind}`, { method: "POST" })
      .then((result) => {
        if (kind === "provision") {
          setBoxState(result.container ?? null);
          if (result.ready) setPhase("ready");
          else {
            setError(result.problem ?? "The VPS Cua desktop is not ready yet");
            setPhase("error");
          }
        }
        if (kind === "sleep") {
          setBoxState(cloudBackend === "vps" ? "stopped" : "archived");
          if (cloudBackend === "vps") setPhase("vps-stopped");
        }
      })
      .catch((e) => {
        setError(e.message);
      })
      .finally(() => setPending(null));
  };

  const runVmAction = async (action: "vm-create" | "vm-recreate" | "vm-delete") => {
    if (
      (action === "vm-recreate" || action === "vm-delete") &&
      !window.confirm(
        action === "vm-delete"
          ? `Delete ${bot.name}'s Local VM? Its private durable workspace will remain.`
          : `Replace ${bot.name}'s Local VM? Its private durable workspace will remain.`,
      )
    ) return;
    setPending(action);
    setError(null);
    setPreviewError(null);
    setVmFrame(null);
    setVmViewerAvailable(false);
    setVmStatus(null);
    vmReadinessAttempts.current = 0;
    try {
      if (action !== "vm-create") {
        await api(`/api/bots/${bot.id}/local-computer/remove`, {
          method: "POST",
          body: "{}",
        });
      }
      if (action !== "vm-delete") {
        const status: LocalVmStatus = await api(`/api/bots/${bot.id}/local-computer/run`, {
          method: "POST",
          body: "{}",
        });
        setVmStatus(status);
        setVmViewerAvailable(status.viewer_available === true || String(status.viewer_url ?? "").startsWith("http"));
        setPhase(status.ready ? "vm" : "checking");
      } else {
        setVmStatus((current) => current ? { ...current, container: "missing", ready: false } : current);
        setPhase("vm-unavailable");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("vm-unavailable");
    } finally {
      setPending(null);
      setRetry((n) => n + 1);
    }
  };

  const replaceVpsComputer = async () => {
    if (!window.confirm(`Replace ${bot.name}'s VPS computer with the version required by this OpenMausBot update? Files stored only inside the disposable container will be deleted.`)) return;
    setPending("vps-replace");
    setError(null);
    try {
      await api(`/api/bots/${bot.id}/computer/remove`, { method: "POST", body: "{}" });
      const result: VpsComputerStatus = await api(`/api/bots/${bot.id}/computer/provision`, {
        method: "POST",
        body: "{}",
      });
      setVpsStatus(result);
      setBoxState(result.container ?? null);
      setPhase(result.ready ? "ready" : "error");
      if (!result.ready) setError(result.problem ?? "The replacement VPS Cua desktop is not ready yet");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    } finally {
      setPending(null);
      setRetry((n) => n + 1);
    }
  };

  const removeCloudComputer = async () => {
    if (!window.confirm(cloudComputerRemovalConfirmation(cloudBackend, bot.name))) return;
    const action = cloudBackend === "vps" ? "vps-remove" : "box-delete";
    setPending(action);
    setError(null);
    let turnedOff = false;
    try {
      // Explicit Cloud would otherwise provision the resource again the next
      // time this panel mounts. Persist Off before destructive work so even a
      // provider timeout cannot turn a deletion attempt into an automatic
      // recreate loop.
      await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ computer: "off" }),
      });
      turnedOff = true;
      await api(`/api/bots/${bot.id}/computer/remove`, { method: "POST", body: "{}" });
      setBoxState(null);
      setVpsStatus((current) => current ? { ...current, container: "missing", ready: false } : current);
      setPhase("off");
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      setError(turnedOff
        ? `Computer tools were turned Off, but the ${cloudBackend === "vps" ? "managed VPS container" : "hosted Box"} was not deleted: ${detail}`
        : `The computer was not changed: ${detail}`);
    } finally {
      setPending(null);
    }
  };

  const openVmSettings = () => {
    window.sessionStorage.setItem("openmausbot.settings.section", "computer");
    dispatch({ type: "toggleAppSettings", open: true });
  };

  const openConnectionSettings = () => {
    dispatch({ type: "toggleAppSettings", open: true, section: "connections" });
  };

  const emptyState = {
    checking: "Checking…",
    starting: "Starting your bot's computer…",
    unconfigured: "No cloud computer configured",
    "vps-unconfigured": "No managed VPS computer is configured for this bot",
    "vps-incompatible": "This VPS computer belongs to an earlier OpenMausBot version",
    "vps-stopped": "The managed VPS computer is stopped",
    "local-unavailable": localDisabledReason ?? "Local computer control isn't ready.",
    "vm-unavailable": "The Local VM isn't available for this bot",
    off: "This bot's computer is off",
    error: "Couldn't reach the computer",
  } satisfies Record<Exclude<Phase, "ready" | "local" | "vm">, string>;

  const closePanel = () => {
    collapseComputerPanel(dispatch);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>("[data-computer-toggle]")?.focus();
    });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!escapeClosesComputerPanel({
        key: event.key,
        defaultPrevented: event.defaultPrevented,
        routineEditorOpen: creatingRoutine,
        warningOpen: localAutoWarning !== null,
      })) return;
      event.preventDefault();
      closePanel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [creatingRoutine, localAutoWarning]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => collapseButtonRef.current?.focus());
    if (!mobilePanel) {
      return () => {
        window.cancelAnimationFrame(frame);
        if (previousFocus?.isConnected) previousFocus.focus();
      };
    }

    const siblings = panel.parentElement
      ? [...panel.parentElement.children].filter(
          (element): element is HTMLElement => element !== panel && element instanceof HTMLElement,
        )
      : [];
    const previousSiblingState = siblings.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    for (const { element } of previousSiblingState) {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hidden && element.getClientRects().length > 0);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    panel.addEventListener("keydown", trapFocus);
    return () => {
      window.cancelAnimationFrame(frame);
      panel.removeEventListener("keydown", trapFocus);
      for (const { element, inert, ariaHidden } of previousSiblingState) {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      }
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [mobilePanel]);

  return (
    <>
    <aside
      ref={panelRef}
      role={mobilePanel ? "dialog" : "complementary"}
      aria-modal={mobilePanel || undefined}
      aria-label={`${bot.name}'s computer`}
      tabIndex={-1}
      className="animate-panel-in flex h-full w-[min(400px,100vw)] shrink-0 flex-col border-l border-hairline/40 bg-panel max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-40 max-md:shadow-2xl"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: true })}
          aria-label="Open bot settings"
          className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
          title="Bot settings"
        >
          <Settings size={18} />
        </button>
        {androidConnected ? (
          <div className="flex overflow-hidden rounded-lg border border-hairline/40">
            <button
              onClick={() => setPanelView("computer")}
              aria-pressed={panelView === "computer"}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 text-[12.5px]",
                panelView === "computer" ? "bg-control text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              <Monitor size={13} /> Computer
            </button>
            <button
              onClick={() => setPanelView("android")}
              aria-pressed={panelView === "android"}
              className={cn(
                "flex items-center gap-1.5 border-l border-hairline/40 px-2.5 py-1 text-[12.5px]",
                panelView === "android" ? "bg-control text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              <Smartphone size={13} /> Android
            </button>
          </div>
        ) : (
          <span className="text-[15px] font-semibold text-ink">Computer</span>
        )}
        <button
          ref={collapseButtonRef}
          onClick={closePanel}
          aria-label="Collapse computer panel"
          title="Collapse computer panel (Esc)"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-ink-secondary hover:bg-control hover:text-ink"
        >
          <PanelRightClose size={16} />
          <span>Collapse</span>
        </button>
      </div>

      <ComputerChildMonitorStrip
        monitors={state.computerChildren}
        visuals={state.computerChildVisuals}
        botId={bot.id}
        threadId={bot.threadId}
      />

      {panelView === "android" && androidConnected ? (
        <div className="flex-1 overflow-y-auto px-4 pt-2">
          <AndroidDevicePanel status={androidStatus} />
        </div>
      ) : (
      <div className={cn("flex-1 overflow-y-auto px-5", controlIsMine ? "pb-24" : "pb-5")}>
          {/* Screen preview */}
          <div className="mb-1.5 mt-2 flex items-end justify-between gap-3 text-[13px] text-ink-secondary">
            <div className="min-w-0">
              <div className="truncate font-medium text-ink">{bot.name}'s screen</div>
              <div className="truncate text-[11px]">
                {phase === "local" && computerCopy.localLabel}
                {phase === "vm" && computerCopy.vmLabel}
                {cloudBackend === "vps" && (phase === "ready" || phase === "starting") && "self-hosted VPS"}
                {cloudBackend === "box" && (phase === "ready" || phase === "starting") && "cloud computer"}
              </div>
            </div>
            {frameSrc && phase !== "local" && (
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                  freshness.stale ? "bg-warning/15 text-warning" : "bg-success/15 text-success",
                )}
                title={freshness.stale ? "This is the last good frame; refresh is retrying" : "Preview is current"}
              >
                {freshness.label}
              </span>
            )}
          </div>
        <div className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl bg-card">
          {frameSrc && previewOpensDesktop ? (
            <button
              type="button"
              onClick={() => void openDesktop()}
              disabled={operationBusy || (control.held && !controlIsMine)}
              className="group relative flex h-full w-full cursor-pointer items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait"
              aria-label={`Open ${bot.name}'s live desktop`}
              title="Open live desktop"
            >
              <img
                src={frameSrc}
                alt={`${bot.name}'s screen`}
                className="h-full w-full object-contain transition group-hover:brightness-75 group-focus-visible:brightness-75"
              />
              <span className="pointer-events-none absolute right-2 top-2 flex items-center gap-1 rounded-md bg-black/70 px-2 py-1 text-[11px] font-medium text-white opacity-80 shadow-sm transition group-hover:opacity-100 group-focus-visible:opacity-100">
                {pending === "join" ? <Loader2 size={12} className="animate-spin" /> : <Maximize2 size={12} />}
                Open
              </span>
            </button>
          ) : frameSrc ? (
            <img
              src={frameSrc}
              alt={`${bot.name}'s screen`}
              className="h-full w-full object-contain"
              title={phase === "vm" ? "Watch-only preview" : undefined}
            />
          ) : (
            <div className="flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
              {phase === "checking" || phase === "starting" || phase === "vm" || (phase === "local" && !isLinux) ? (
                <Loader2 size={18} className="animate-spin" />
              ) : phase === "off" ? (
                <Power size={22} />
              ) : (
                <Monitor size={22} />
              )}
              <span className="text-[12px]">
                {phase === "ready"
                  ? "Waiting for the first frame…"
                  : phase === "vm"
                    ? "Capturing the Local VM screen…"
                  : phase === "local"
                    ? isLinux
                      ? "Ready for approved bot actions. Start the separate preview below when you want to watch the screen."
                      : localMisses >= 3
                      ? "No frames yet — the preview needs Screen Recording permission. After granting, relaunch the app."
                      : "Capturing this computer's screen…"
                    : emptyState[phase]}
              </span>
              {phase === "local" && !isLinux && localMisses >= 3 && (
                <button
                  onClick={() => window.ogb?.permOpenSettings?.("screen")}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  Open Settings
                </button>
              )}
              {phase === "vm-unavailable" && (
                vmStatus?.mode === "per-bot" && vmStatus.image && vmStatus.create_supported ? (
                  <button
                    onClick={() => void runVmAction(vmStatus.container === "missing" ? "vm-create" : "vm-recreate")}
                    disabled={operationBusy || control.held}
                    className="mt-1 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                  >
                    {(pending === "vm-create" || pending === "vm-recreate") && (
                      <Loader2 size={13} className="mr-1.5 inline animate-spin" />
                    )}
                    {vmStatus.container === "missing" ? `Create ${bot.name}'s VM` : `Replace ${bot.name}'s VM`}
                  </button>
                ) : (
                  <button
                    onClick={openVmSettings}
                    className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                  >
                    Open Local VM setup
                  </button>
                )
              )}
              {(phase === "vps-unconfigured" || phase === "vps-stopped") && (
                <button
                  onClick={openConnectionSettings}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  Open VPS settings
                </button>
              )}
              {(phase === "vps-stopped" || (phase === "vps-unconfigured" && vpsStatus?.configured)) &&
                (bot.computer === "cloud" || bot.autoStartVps) && (
                <button
                  onClick={() => run("provision")}
                  disabled={operationBusy || control.held}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50"
                >
                  {pending === "provision" && <Loader2 size={13} className="mr-1.5 inline animate-spin" />}
                  {phase === "vps-stopped" ? "Start VPS computer" : "Prepare VPS computer"}
                </button>
              )}
              {phase === "vps-incompatible" && vpsStatus?.managed &&
                (bot.computer === "cloud" || bot.autoStartVps) && (
                <button
                  onClick={() => void replaceVpsComputer()}
                  disabled={operationBusy || control.held}
                  className="mt-1 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                >
                  {pending === "vps-replace" && <Loader2 size={13} className="mr-1.5 inline animate-spin" />}
                  Replace VPS computer
                </button>
              )}
            </div>
          )}
          {viewerOpen && (
            <span className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-black/70 px-2 py-1 text-[10px] font-medium text-white">
              Live desktop open · preview keeps updating
            </span>
          )}
        </div>

        {previewError && (
          <div className="mt-2 flex items-center gap-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-[12px] text-warning">
            <span className="min-w-0 flex-1">Preview reconnecting: {previewError}</span>
            <button
              type="button"
              onClick={() => setRetry((value) => value + 1)}
              aria-label="Retry computer preview"
              title="Retry preview now"
              className="shrink-0 rounded-md p-1 hover:bg-warning/10"
            >
              <RefreshCw size={13} />
            </button>
          </div>
        )}
        {error && (
          <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {error}
          </div>
        )}
        {phase === "unconfigured" && (
          <div className="mt-3 rounded-xl bg-card p-4">
            <div className="mb-3 text-[13px] text-ink-secondary">
              Add a Box API key to give this bot a cloud computer — it spins up right here.
            </div>
            <ApiKeyRow
              section="box"
              onSaved={(configured) => configured && setRetry((n) => n + 1)}
            />
          </div>
        )}
        {phase === "vps-unconfigured" && (
          <div className="mt-3 rounded-xl bg-card p-4">
            <div className="mb-3 text-[13px] text-ink-secondary">
              Configure the VPS SSH alias in App Settings → Connections. Auto only reuses an existing ready container.
            </div>
            <button
              onClick={openConnectionSettings}
              className="rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover"
            >
              Open VPS settings
            </button>
          </div>
        )}

        {/* Who is driving — take the wheel / hand it back */}
        {(phase === "ready" || phase === "vm" || phase === "local") && control.helpReason && !control.held && (
          <div className="mt-3 rounded-xl border border-warning/25 bg-warning/10 p-4">
            <div className="text-[13px] leading-relaxed text-warning">
              <b>{bot.name}</b> asked for your hands: {control.helpReason}
            </div>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() =>
                  phase === "vm" || phase === "ready" ? void openDesktop() : controlAction("take")
                }
                disabled={operationBusy || Boolean(viewerUnavailableReason)}
                title={viewerUnavailableReason ?? undefined}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
              >
                {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
                Take control
              </button>
              <button
                onClick={() => controlAction("dismiss-help")}
                disabled={operationBusy}
                className="rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        {(phase === "ready" || phase === "vm" || phase === "local") && control.held && (
          <div className={cn(
            "mt-3 rounded-xl border p-4",
            controlIsMine ? "border-accent/25 bg-accent/10" : "border-warning/25 bg-warning/10",
          )}>
            <div className="text-[13px] leading-relaxed text-ink">
              {controlIsMine
                ? "You have the wheel — the bot's clicks and keystrokes are refused until you hand it back."
                : "Another OpenMausBot window is controlling this computer. This window cannot steal or release its control."}
              {controlIsMine && phase === "ready" && " Use Open desktop to drive."}
              {controlIsMine && phase === "vm" && " Use Open desktop to drive — the preview here is watch-only."}
              {controlIsMine && phase === "local" && " You can safely use this computer directly."}
            </div>
            {controlIsMine && (
              <button
                onClick={() => void handBackControl()}
                disabled={operationBusy}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
              >
                <Hand size={14} />
                Hand control back
              </button>
            )}
          </div>
        )}
        {phase === "vm" && vmViewerAvailable && controlIsMine && (
          <button
            onClick={() => void openDesktop()}
            disabled={operationBusy || Boolean(viewerUnavailableReason)}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            title={viewerUnavailableReason ?? "Open the Local VM's live desktop inside OpenMausBot"}
          >
            {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Monitor size={14} />}
            Open live desktop
          </button>
        )}
        {phase === "vm" && !control.held && !control.helpReason && (
          <button
            onClick={() => void openDesktop()}
            disabled={operationBusy || !vmViewerAvailable || Boolean(viewerUnavailableReason)}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            title={viewerUnavailableReason ?? "Pause the bot's hands and open the Local VM's live desktop"}
          >
            {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
            Take control
          </button>
        )}
        {phase === "local" && !control.held && !control.helpReason && (
          <button
            onClick={() => controlAction("take")}
            disabled={operationBusy}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            title="Pause this bot's computer actions while you use the physical computer"
          >
            {controlPending ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
            Take control of this computer
          </button>
        )}
        {phase === "vm" && vmStatus?.mode === "per-bot" && (
          <button
            onClick={() => void runVmAction("vm-delete")}
            disabled={operationBusy || control.held || bot.busy}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-danger/30 py-2 text-[13px] text-danger hover:bg-danger/10 disabled:opacity-50"
            title={bot.busy ? "Stop this bot's turn before deleting its VM" : `Delete ${bot.name}'s Local VM`}
          >
            {pending === "vm-delete" ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
            Delete this bot's VM
          </button>
        )}
        {/* Cloud-only actions */}
        {phase === "ready" && (
          <div className="mt-3 flex gap-2">
            {!control.held && !control.helpReason && (
              <button
                onClick={() =>
                  void openDesktop()
                }
                disabled={operationBusy || Boolean(viewerUnavailableReason)}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
                title={viewerUnavailableReason ?? "Pause the bot's hands and drive this computer yourself"}
              >
                {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
                Take control
              </button>
            )}
            {controlIsMine && (
              <button
                onClick={() => void openDesktop()}
                disabled={operationBusy || Boolean(viewerUnavailableReason)}
                title={viewerUnavailableReason ?? "Open the live desktop"}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Monitor size={14} />}
                Open live desktop
              </button>
            )}
            {(cloudBackend === "vps" || boxState !== "archived") && (
              <button
                onClick={() => run("sleep")}
                disabled={operationBusy || control.held || bot.busy}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
                title="Put the computer to sleep"
              >
                {pending === "sleep" ? <Loader2 size={14} className="animate-spin" /> : <Moon size={14} />}
                Sleep
              </button>
            )}
          </div>
        )}
        {cloudBackend === "box" && phase === "ready" && boxState !== null && (
          <button
            onClick={() => void removeCloudComputer()}
            disabled={operationBusy || control.held || bot.busy}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-danger/30 py-2 text-[13px] text-danger hover:bg-danger/10 disabled:opacity-50"
            title={bot.busy ? "Stop this bot's turn before deleting its Box" : `Permanently delete ${bot.name}'s hosted Box`}
          >
            {pending === "box-delete" ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            Permanently delete Box
          </button>
        )}
        {cloudBackend === "vps" && vpsStatus?.container !== "missing" && (
          <button
            onClick={() => void removeCloudComputer()}
            disabled={operationBusy || control.held || bot.busy}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-danger/30 py-2 text-[13px] text-danger hover:bg-danger/10 disabled:opacity-50"
            title={bot.busy ? "Stop this bot's turn before removing its VPS container" : `Remove ${bot.name}'s managed VPS container`}
          >
            {pending === "vps-remove" ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            Remove managed VPS container
          </button>
        )}

        {(phase === "local" || phase === "local-unavailable") && (
          <>
            <LocalScreenPreview />
            <LinuxLocalControl />
            <MacLocalControl />
          </>
        )}

        {/* Computer source */}
          <div className="mt-4 rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">Computer tools act on</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {!bot.computer &&
                (isLinux || !localSelectable
                  ? cloudBackend === "vps"
                    ? "Auto reuses a ready VPS when one is configured; otherwise computer use stays off. "
                    : `${linuxAutoDescription()} `
                  : cloudBackend === "vps"
                    ? `Auto reuses a ready VPS when one exists, otherwise ${computerCopy.localDestination}. `
                    : `Auto uses a cloud box when one exists, otherwise ${computerCopy.localDestination}. `)}
              {computerCopy.remote && `${bot.name}'s model, shell, and files remain on ${computerCopy.serverName}. `}
              Pick where browser and computer-control tools act. <b className="text-ink">{computerCopy.vmLabel}</b> is a Cua-controlled Linux desktop
              on {computerCopy.remote ? computerCopy.serverName : "this computer"} — isolated from your physical desktop. Set it up in App
              Settings → Local VM.
          </div>
          <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
            {(
              [
                ["auto", "Auto"],
                ["cloud", "Cloud"],
                ["vm", computerCopy.vmLabel],
                ["local", computerCopy.localLabel],
                ["off", "Off"],
              ] as const
            ).map(([mode, label], i) => (
              (() => {
                const disabled =
                  operationBusy ||
                  bot.busy ||
                  control.held ||
                  (mode === "cloud" && !cloudSupported) ||
                  (mode === "vm" && !vmSupported) ||
                  (mode === "local" && !localSelectable);
                const unavailableTitle =
                  bot.busy
                    ? "Stop this turn before changing its computer destination"
                    : control.held
                    ? "Hand computer control back before changing its destination"
                    : mode === "vm" && !vmSupported
                    ? "This model engine cannot use the Local VM"
                    : mode === "cloud" && !cloudSupported
                      ? "This model engine cannot use cloud computer tools"
                      : mode === "local" && !localSelectable
                        ? localDisabledReason ?? "Local computer control isn't ready"
                          : undefined;
                return (
              <button
                key={mode}
                aria-pressed={computerMode === mode}
                disabled={disabled}
                title={unavailableTitle}
                onClick={() => {
                  if (mode === computerMode) return;
                  if (mode === "auto") {
                    if (bot.autoApprove && autoMayUseLocal) setLocalAutoWarning("auto");
                    else dispatch({ type: "setComputerAuto", botId: bot.id });
                  } else if (mode === "local" && bot.autoApprove) {
                    setLocalAutoWarning("local");
                  } else {
                    dispatch({ type: "updateBot", botId: bot.id, patch: { computer: mode } });
                  }
                }}
                className={cn(
                  "min-w-0 flex-1 px-1 py-1.5 text-[12.5px]",
                  i > 0 && "border-l border-hairline/40",
                  disabled && "cursor-not-allowed opacity-40",
                  computerMode === mode
                    ? "bg-control text-ink"
                    : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                )}
              >
                <span className="block truncate">{label}</span>
              </button>
                );
              })()
            ))}
          </div>
          {(!bot.computer || bot.computer === "cloud") && (
            <>
              <CloudBackendPicker
                value={cloudBackend}
                vpsSupported={vpsSupported}
                disabled={operationBusy || bot.busy || control.held}
                onChange={(backend) => dispatch({ type: "updateBot", botId: bot.id, patch: { cloudBackend: backend } })}
              />
              {!bot.computer && cloudBackend === "vps" && (
                <div className="mt-3 flex items-center justify-between gap-4 rounded-lg bg-inset px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="text-[13px] text-ink">Start VPS automatically</div>
                    <div className="mt-0.5 text-[11.5px] text-ink-secondary">
                      Off by default. When enabled, Auto may create or wake this bot's managed container.
                    </div>
                  </div>
                  <button
                    role="switch"
                    aria-checked={Boolean(bot.autoStartVps)}
                    aria-label="Start VPS automatically"
                    disabled={operationBusy || bot.busy || control.held}
                    onClick={() => dispatch({
                      type: "updateBot",
                      botId: bot.id,
                      patch: { autoStartVps: !bot.autoStartVps },
                    })}
                    className={cn(
                      "relative h-6 w-11 shrink-0 rounded-full transition-colors",
                      (operationBusy || bot.busy || control.held) && "cursor-not-allowed opacity-40",
                      bot.autoStartVps ? "bg-accent" : "bg-control",
                    )}
                  >
                    <span
                      className={cn(
                        "absolute top-[3px] size-[18px] rounded-full bg-white transition-all",
                        bot.autoStartVps ? "left-[22px]" : "left-[4px]",
                      )}
                    />
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Routines */}
        <div className="mt-4 rounded-xl bg-card p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[15px] font-medium text-ink">
              <CalendarClock size={16} className="text-accent" />
              Scheduled tasks
            </div>
            {botRoutines.length > 0 && (
              <span className="rounded-full bg-control px-2 py-0.5 text-[10px] font-medium text-ink-secondary">
                {botRoutines.length}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            Schedule work for {bot.name}. Use its current setup, or run the whole job inside its cloud VM.
          </div>
          {!computerDestination && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-[11.5px] leading-relaxed text-warning">
              <Power size={13} className="mt-0.5 shrink-0" />
              Scheduled tasks on this computer will not have desktop access while this is Off. Choose Cloud VM in the schedule editor to run the whole job there.
            </div>
          )}
          {activeRoutineRun && (
            <button
              onClick={() => dispatch({ type: "showRoutines" })}
              className="mt-3 flex w-full items-center gap-2 rounded-lg border border-accent/25 bg-accent/10 px-3 py-2 text-left text-[12px] text-accent hover:bg-accent/15"
            >
              <Loader2 size={13} className={activeRoutineRun.status === "queued" ? "" : "animate-spin"} />
              <span className="min-w-0 flex-1 truncate">
                {activeRoutineRun.routineName} · {activeRoutineRun.status === "waiting" ? "needs you" : activeRoutineRun.status}
              </span>
            </button>
          )}
          {botRoutines.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {botRoutines.slice(0, 3).map((routine) => (
                <button
                  key={routine.id}
                  onClick={() => dispatch({ type: "showRoutines" })}
                  className="flex w-full items-center gap-2 rounded-lg bg-inset px-3 py-2 text-left hover:bg-control/60"
                >
                  <span className={cn("size-1.5 shrink-0 rounded-full", routine.enabled ? "bg-success" : "bg-ink-secondary/40")} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-ink">{routine.name}</span>
                    <span className="block truncate text-[10.5px] text-ink-secondary">
                      {routineScheduleLabel(routine)}{routine.runOn === "cloud" ? " · runs on VM" : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] text-ink-secondary">{nextRunLabel(routine.nextRunAt)}</span>
                </button>
              ))}
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => setCreatingRoutine(true)}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent py-2 text-[13px] font-medium text-white hover:brightness-110"
            >
              <Plus size={14} />
              Create schedule
            </button>
            <button
              onClick={() => dispatch({ type: "showRoutines" })}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover"
              title="Open schedules"
            >
              <CalendarDays size={14} />
              Schedules
            </button>
          </div>
        </div>
      </div>
      )}
      {creatingRoutine && (
        <RoutineEditor
          bots={[bot]}
          lockedBotId={bot.id}
          defaultRunOn={cloudRoutineReady ? "cloud" : "maus"}
          onClose={() => setCreatingRoutine(false)}
        />
      )}
    </aside>
    <LocalComputerAutoWarning
      open={localAutoWarning !== null}
      onCancel={() => setLocalAutoWarning(null)}
      onConfirm={() => {
        if (localAutoWarning === "auto") {
          dispatch({ type: "setComputerAuto", botId: bot.id, acknowledgeLocalAuto: true });
        } else {
          dispatch({ type: "updateBot", botId: bot.id, patch: { computer: "local", acknowledgeLocalAuto: true } });
        }
        setLocalAutoWarning(null);
      }}
    />
    </>
  );
}
