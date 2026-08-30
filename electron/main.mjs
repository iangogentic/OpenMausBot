import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, Menu, nativeImage, powerSaveBlocker, safeStorage, screen, session, shell, systemPreferences, Tray, utilityProcess } from "electron";
import { createRequire } from "node:module";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startCua, stopCua, registerCuaIpc, setCuaStateListener } from "./cua.mjs";
import { createAndroidDeviceController } from "./android-device.mjs";
import { assemblyAICredential, mintAssemblyAIStreamingToken } from "./assemblyai.mjs";
import { finishSpeech, startSpeech, stopSpeech } from "./speech.mjs";
import {
  recorderPermissionStatus,
  saveSkillRecording,
  startRecorder,
  stopRecorder,
} from "./skill-recorder.mjs";
import { openBlankTerminal } from "./terminal-launch.mjs";
import { startUpdater, registerUpdaterIpc } from "./updater.mjs";
import { shouldStartUpdater } from "./updater-policy.mjs";
import { buildDiagnosticsReport, decodeLogTail, diagnosticsFileName } from "./diagnostics.mjs";
import { migrateWorkspaceCredentials, workspaceCredentialEnv } from "./workspace-credentials.mjs";
import { activateExistingWindow } from "./single-instance.mjs";
import { pollServerIdentity } from "./server-boot-probe.mjs";
import { packageUrlFromCommandLine, packageUrlFromDeepLink } from "./package-link.mjs";
import { defaultSaveName, withSavableFile } from "./save-file.mjs";
import {
  readRemoteDeploymentConfig,
  removeLegacyBridgeSecrets,
} from "./remote-client.mjs";
import { startOwnedRemoteSshConnector } from "./remote-ssh-connector.mjs";
import { composePhysicalCapture, startOutboundPhysicalBridge } from "./outbound-physical-bridge.mjs";
import {
  ensureManagedComposioCredentials,
  managedComposioAccess,
  managedComposioChildEnvironment,
  normalizeManagedComposioBrokerUrl,
} from "./managed-composio.mjs";
import {
  createManagedCompanionTunnel,
  managedCompanionTunnelAccess,
  resolveCloudflaredBinary,
  resolveManagedCompanionGuardian,
  withManagedCompanionTunnelAccess,
  withoutManagedCompanionTunnelAccess,
} from "./managed-companion-tunnel.mjs";
import { createSecureCredentialState } from "./secure-credential-state.mjs";
import { readSecureCredentials } from "./secure-credentials.mjs";
import { createControlPlaneClient } from "./control-plane-client.mjs";
import {
  readBoundedResponseBytes,
  readBoundedResponseJson,
} from "./bounded-response.mjs";
import {
  companionAccountCleanupPending,
  createCompanionAccountService,
  resolveCompanionControlPlaneURL,
} from "./companion-account-service.mjs";
import capabilitiesModule from "./capabilities.cjs";

const { desktopCapabilities, nativeDesktopActions } = capabilitiesModule;
const nativeActions = nativeDesktopActions(process.platform);
const require = createRequire(import.meta.url);
const { createDisplayMediaGuard, invokeDisplayMediaCallback, selectCaptureSource } = require(
  "./screen-preview.cjs",
);
const { STAGE_PREFIX: APPIMAGE_CUA_STAGE_PREFIX } = require("./cua-linux-bundle.cjs");
const {
  desktopViewerUrl,
  desktopViewerNavigationAllowed,
  desktopViewerLoadFailureLabel,
  desktopViewerNeedsRfbProof,
  desktopViewerRequestAllowed,
  bindDesktopViewerNavigation,
  bindDesktopViewerToOwner,
} = require("./desktop-viewer.cjs");
const { createDesktopViewerRegistry } = require("./desktop-viewer-registry.cjs");
const { normalizeUnreadCount, parseWindowState, resolveWindowState } = require("./window-state.cjs");
const { uiSessionRequestHeaders } = require("./ui-session.cjs");
const {
  DEFAULT_AUXILIARY_CLEANUP_TIMEOUT_MS,
  DEFAULT_SERVER_SHUTDOWN_TIMEOUT_MS,
  runQuitLifecycle,
  trackUtilityProcessExit,
} = require("./quit-lifecycle.cjs");
const {
  bindPrivilegedRendererNavigation,
  createPrivilegedRendererController,
  externalWebUrl,
} = require("./privileged-renderer.cjs");
const { physicalApprovalDialogOptions } = require("./physical-approval-dialog.cjs");
const { remoteDownloadName } = require("./remote-file-name.cjs");
const {
  activateWindow,
  backgroundMenuTemplate,
  createWindowBackgroundPolicy,
} = require("./window-background-policy.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// electron-builder changes the bundle/executable name for the remote shell,
// but Electron still derives userData from package.json unless we override it.
// Keep its cookies and remote-client.json separate from a normal OpenMausBot
// installation on the same Mac.
const packagedExecutableName = path.basename(process.execPath, path.extname(process.execPath));
const IS_REMOTE_PACKAGE = app.isPackaged && packagedExecutableName === "OpenMaus Razer";
if (IS_REMOTE_PACKAGE) {
  app.setPath("userData", path.join(app.getPath("appData"), "OpenMaus Razer"));
}
const REMOTE_DEPLOYMENT = readRemoteDeploymentConfig(app.getPath("userData"));
if (IS_REMOTE_PACKAGE && !REMOTE_DEPLOYMENT) {
  throw new Error("OpenMaus Razer needs a private remote-client.json with pinned SSH settings");
}
const REMOTE_SSH_CONNECTOR = REMOTE_DEPLOYMENT
  ? await startOwnedRemoteSshConnector(REMOTE_DEPLOYMENT)
  : null;
const REMOTE_SERVER_URL = REMOTE_SSH_CONNECTOR?.serverUrl ?? null;
const REMOTE_COMPANION_URL = REMOTE_SSH_CONNECTOR?.companionUrl ?? null;
const REMOTE_SERVER_NAME = REMOTE_DEPLOYMENT?.serverName ?? "Remote server";
if (REMOTE_DEPLOYMENT) removeLegacyBridgeSecrets(app.getPath("userData"));
const UI_SESSION_TOKEN = REMOTE_DEPLOYMENT?.sessionToken
  ?? process.env.OMB_UI_SESSION_TOKEN?.trim()
  ?? randomBytes(32).toString("base64url");
const COMPANION_CONTROL_SESSION_TOKEN = REMOTE_DEPLOYMENT?.companionSessionToken
  ?? randomBytes(32).toString("base64url");
const UI_SESSION_TOKEN_SHA256 = createHash("sha256").update(UI_SESSION_TOKEN).digest("hex");
// 127.0.0.1 explicitly — vite binds IPv4; a bare "localhost" here can
// resolve to ::1 and paint a black window
const DEV_URL = process.env.ELECTRON_START_URL ?? "http://127.0.0.1:5199";
const DEFAULT_COMPOSIO_BROKER_URL = "https://openmausbot-composio.milindsoni201.workers.dev";
let SERVER_PORT = 8799;
const APP_ICON = path.join(__dirname, "resources/app-icon.png");
const desktopViewers = createDesktopViewerRegistry({
  destroyViewer: (viewer) => viewer.destroy(),
  isViewerDestroyed: (viewer) => viewer.isDestroyed(),
  isOwnerDestroyed: (owner) => owner.isDestroyed(),
  notifyOwner: (owner, state) => owner.send("desktop-viewer:state", state),
});
let pendingPackageInstallUrl = packageUrlFromCommandLine(process.argv);
let mainWindow = null;
let backgroundTray = null;
let remotePhysicalBridge = null;
let unreadCount = 0;
let unreadOverlayIcon = null;
let privilegedRendererController = null;
const windowBackgroundPolicy = createWindowBackgroundPolicy(process.platform);

function showMainWindow() {
  if (activateWindow(mainWindow)) return mainWindow;
  return createWindow();
}

function installBackgroundTray() {
  if (process.platform !== "darwin" || backgroundTray) return;
  const icon = nativeImage.createFromPath(APP_ICON).resize({ width: 18, height: 18 });
  icon.setTemplateImage(true);
  backgroundTray = new Tray(icon);
  backgroundTray.setToolTip("OpenMausBot is running in the background");
  backgroundTray.setContextMenu(Menu.buildFromTemplate(backgroundMenuTemplate({
    serverName: REMOTE_SERVER_URL ? REMOTE_SERVER_NAME : "this Mac",
    open: () => showMainWindow(),
    quit: () => app.quit(),
  })));
  backgroundTray.on("click", () => showMainWindow());
}

function windowStateFile() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function readWindowState() {
  try {
    return parseWindowState(fs.readFileSync(windowStateFile(), "utf8"));
  } catch {
    return null;
  }
}

function writeWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const file = windowStateFile();
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      temporary,
      JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }),
      { mode: 0o600 },
    );
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {}
    slog(`window state save failed: ${error?.message ?? error}`);
  }
}

function installWindowStatePersistence(win) {
  let timer = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    writeWindowState(win);
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 250);
    timer.unref?.();
  };
  win.on("resize", schedule);
  win.on("move", schedule);
  win.on("maximize", schedule);
  win.on("unmaximize", schedule);
  win.on("close", flush);
}

function applyUnreadBadge(win = mainWindow) {
  const count = normalizeUnreadCount(unreadCount);
  if (process.platform === "win32") {
    if (!win || win.isDestroyed()) return;
    unreadOverlayIcon ??= nativeImage.createFromPath(APP_ICON).resize({ width: 16, height: 16 });
    win.setOverlayIcon(
      count > 0 && !unreadOverlayIcon.isEmpty() ? unreadOverlayIcon : null,
      count > 0 ? `${count} unread conversation${count === 1 ? "" : "s"}` : "No unread conversations",
    );
    return;
  }
  if (process.platform === "darwin" || process.platform === "linux") app.setBadgeCount(count);
}

// GNOME groups the window with its installed desktop entry only when both
// identities match. This must run before Electron becomes ready. Ubuntu also
// uses Chromium's software renderer: the supported machine reproduced two
// NVIDIA/libGLES GPU-process crashes that left an invisible focused window
// intercepting input. This app is not graphics-heavy, so reliability wins.
if (process.platform === "linux") {
  app.disableHardwareAcceleration();
  app.setDesktopName("com.openmausbot.app.desktop");
}

// One instance per user: without this lock a second launch forks a second
// harness server on a fallback port and splits data dirs in two. The loser
// exits before any child or window exists; the winner surfaces itself.
if (!app.requestSingleInstanceLock()) {
  console.log("[desktop] OpenMausBot is already running — focusing that window");
  process.exit(0);
}
function deliverPackageInstall(win) {
  if (!pendingPackageInstallUrl || !win || win.isDestroyed()) return;
  if (win.webContents.isLoadingMainFrame()) return;
  win.webContents.send("package:install", pendingPackageInstallUrl);
  pendingPackageInstallUrl = null;
}

function queuePackageInstall(rawLink) {
  const packageUrl = packageUrlFromDeepLink(rawLink);
  if (!packageUrl) return false;
  pendingPackageInstallUrl = packageUrl;
  activateExistingWindow(BrowserWindow.getAllWindows());
  const target = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
  deliverPackageInstall(target);
  return true;
}

app.on("open-url", (event, url) => {
  if (!queuePackageInstall(url)) return;
  event.preventDefault();
});

app.on("second-instance", (_event, commandLine) => {
  const packageUrl = packageUrlFromCommandLine(commandLine);
  if (packageUrl) pendingPackageInstallUrl = packageUrl;
  activateExistingWindow(BrowserWindow.getAllWindows());
  const target = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
  deliverPackageInstall(target);
});

// Packaged: the harness server ships in Resources (compiled JS, zero deps)
// and runs on Electron's own Node via utilityProcess. It serves the built
// UI too, so the window talks to one origin and there is no dev proxy.
// A stray server on the default port must not brick the app — fall back to
// alternate ports until one binds AND identifies as ours (the probe checks
// our API shape, not just a 200).
let serverProc = null;
let serverExit = null;
let quitCleanupFinished = false;
let quitCleanup = null;
let serverReady = true;
let secureCredentials = {};
let secureCredentialState = null;

const CREDENTIALS_FILE = path.join(app.getPath("userData"), "credentials.bin");

/** Set once per launch: true when the store could not be READ, which is not
 * the same as the user having saved nothing. Everything downstream — the
 * server's view of "configured", and whether we may register a fresh
 * installation — keys off this rather than off an empty object. */
let credentialStoreUnavailable = false;

async function loadSecureCredentials() {
  const result = await readSecureCredentials({
    exists: () => fs.existsSync(CREDENTIALS_FILE),
    isAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    readFile: () => fs.readFileSync(CREDENTIALS_FILE),
    decrypt: (buffer) => safeStorage.decryptStringAsync(buffer),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  credentialStoreUnavailable = result.status === "unavailable";
  if (credentialStoreUnavailable) {
    // Deliberately loud. A silent {} here is what made a keychain hiccup
    // look like "your connected apps are gone".
    slog(`credential store unreadable after retries (${result.error}); saved keys are not loaded this launch`);
  }
  return result.credentials;
}

async function saveSecureCredentials(credentials) {
  // A failed read means we do not know what the existing encrypted document
  // contains. Never derive a replacement from that incomplete view: boot
  // migrations must leave plaintext in place so a later launch can retry.
  if (credentialStoreUnavailable) {
    throw new Error("The operating-system credential store could not be read this launch");
  }
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("The operating-system credential store is unavailable");
  }
  fs.mkdirSync(path.dirname(CREDENTIALS_FILE), { recursive: true });
  const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(credentials));
  const temporary = `${CREDENTIALS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, encrypted, { mode: 0o600 });
  fs.renameSync(temporary, CREDENTIALS_FILE);
}

async function secureComposioConfig() {
  const dataDir = process.env.OMB_DATA_DIR || path.join(app.getPath("home"), ".openmausbot");
  const configPath = path.join(dataDir, "config.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!config?.composio || typeof config.composio !== "object") return;
    let changed = false;
    const apiKey = config?.composio?.apiKey;
    if (typeof apiKey === "string" && apiKey.trim().startsWith("ak_")) {
      if (!secureCredentials.composioApiKey) {
        secureCredentials.composioApiKey = apiKey.trim();
        await saveSecureCredentials(secureCredentials);
      }
      config.composio.apiKey = "";
      changed = true;
    } else if (typeof apiKey === "string" && apiKey.trim()) {
      config.composio.apiKey = "";
      changed = true;
    }
    // These were the old Connect credential and endpoint. They are no longer
    // read; remove them during the upgrade so an unused secret is not left in
    // plaintext indefinitely.
    for (const field of ["key", "url"]) {
      if (Object.hasOwn(config.composio, field)) {
        delete config.composio[field];
        changed = true;
      }
    }
    if (!changed) return;
    const temporary = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, configPath);
  } catch (error) {
    if (error?.code !== "ENOENT") slog(`credential migration failed: ${error?.message ?? error}`);
  }
}

// The remaining workspace credentials (xai/box/voice/OpenCode keys) get
// the same at-rest treatment as the Composio key above. New packaged-app
// saves go straight through credential:set below; this boot-time sweep also
// migrates plaintext left by older versions or direct development clients.
// See workspace-credentials.mjs for the exact rules.
async function secureWorkspaceConfig() {
  const dataDir = process.env.OMB_DATA_DIR || path.join(app.getPath("home"), ".openmausbot");
  const configPath = path.join(dataDir, "config.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const migrated = migrateWorkspaceCredentials(config, secureCredentials);
    // credentials.bin first: if the OS store cannot take the secrets, the
    // plaintext stays put and the next boot retries — losing the only copy
    // is the one unacceptable outcome
    if (migrated.credentialsChanged) await saveSecureCredentials(migrated.credentials);
    secureCredentials = migrated.credentials;
    if (!migrated.configChanged) return;
    const temporary = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(migrated.config, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, configPath);
  } catch (error) {
    if (error?.code !== "ENOENT") slog(`credential migration failed: ${error?.message ?? error}`);
  }
}

function composioBrokerUrl() {
  const configured = process.env.OMB_COMPOSIO_BROKER_URL?.trim();
  return normalizeManagedComposioBrokerUrl(
    configured || (app.isPackaged ? DEFAULT_COMPOSIO_BROKER_URL : ""),
  );
}

// The packaged app has no terminal: everything about the server child's life
// goes to server.log in the OS log dir (~/Library/Logs/OpenMausBot on macOS,
// Console.app-visible; %APPDATA%\OpenMausBot\logs on Windows), which is also
// why stdio is piped, not inherited — under a Finder/Explorer launch the
// parent's stdio leads nowhere and a failed boot is otherwise undiagnosable.
const LOG_DIR = app.getPath("logs");
let logStream = null;
import {
  companionAdvertisedHostedUrl,
  companionEnabledAtRest,
  companionOriginTarget,
  companionPairing,
  companionCloudDesktopAccess,
  companionRevoke,
  companionRunning,
  companionState,
  rememberCompanionEnabled,
  rememberCompanionKeepAwake,
  setCompanionHostedUrl,
  setCompanionLifecycleListener,
  startCompanion,
  stopCompanion,
} from "./companion.mjs";

let companionPowerBlocker = null;

function syncCompanionKeepAwake(companionEnabled, keepAwake) {
  const shouldBlock = companionEnabled && keepAwake;
  if (shouldBlock && companionPowerBlocker === null) {
    companionPowerBlocker = powerSaveBlocker.start("prevent-app-suspension");
  } else if (!shouldBlock && companionPowerBlocker !== null) {
    if (powerSaveBlocker.isStarted(companionPowerBlocker)) powerSaveBlocker.stop(companionPowerBlocker);
    companionPowerBlocker = null;
  }
}

function slog(line) {
  try {
    if (!logStream) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      logStream = fs.createWriteStream(path.join(LOG_DIR, "server.log"), { flags: "a" });
    }
    logStream.write(`[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* logging must never break startup */
  }
}

// ── managed companion connection ───────────────────────────────────────
// Account onboarding provisions one remote Cloudflare Tunnel per desktop,
// then calls reconcileManagedCompanionEndpointProvision below. Only the
// endpoint is public state. The connector token stays in credentials.bin and
// is passed to cloudflared through a private token file by the lifecycle
// module — never through IPC, argv, the environment, or logs.
let managedCompanionConnector = null;
let companionAccountService = null;
let companionDesiredThisLaunch = false;
let companionLaunchGeneration = 0;
let advertisementTransition = Promise.resolve();

/** The one serialized credential mutation hook. Account onboarding and every
 * other runtime credential writer share this state, so persisting a tunnel
 * token can never overwrite an API key saved at the same time (or vice
 * versa). */
export async function updateSecureCredentialDocument(derive, afterPersist) {
  if (!secureCredentialState) throw new Error("Secure credentials are not ready");
  try {
    return await secureCredentialState.update(derive, afterPersist);
  } finally {
    secureCredentials = secureCredentialState.read();
  }
}

function publicManagedCompanionState() {
  const access = managedCompanionTunnelAccess(secureCredentials);
  const status = managedCompanionConnector?.getStatus();
  if (status) {
    const publicState = {
      status: status.status,
      configured: status.configured,
      ready: status.ready,
    };
    if (status.endpoint) publicState.url = status.endpoint;
    if (status.retryInMs) publicState.retryInMs = status.retryInMs;
    if (status.error) publicState.error = status.error;
    return publicState;
  }
  return access
    ? { status: "stopped", configured: true, ready: false, url: access.endpoint }
    : { status: "unconfigured", configured: false, ready: false };
}

function decorateDesktopCompanionState(state) {
  // The panel polls this state, so a sidecar that exited on its own releases
  // the blocker within one poll instead of keeping the computer awake forever.
  syncCompanionKeepAwake(state.enabled && !state.error, state.keepAwake === true);
  return { ...state, managedConnection: publicManagedCompanionState() };
}

async function desktopCompanionState() {
  if (REMOTE_COMPANION_URL) return remoteCompanionRequest("GET", "/state");
  return decorateDesktopCompanionState(await companionState());
}

async function remoteCompanionRequest(method, endpoint) {
  try {
    const response = await fetch(`${REMOTE_COMPANION_URL}${endpoint}`, {
      method,
      headers: { "x-openmausbot-session": COMPANION_CONTROL_SESSION_TOKEN },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const body = await readBoundedResponseJson(
      response,
      1024 * 1024,
      "Razer companion response exceeded 1 MB",
    ).catch(() => ({}));
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    return {
      enabled: true,
      keepAwake: true,
      ...body,
      managedConnection: { status: "ready", configured: true, ready: true },
    };
  } catch (error) {
    return {
      enabled: true,
      keepAwake: true,
      port: 8810,
      devices: [],
      connectedDeviceIds: [],
      pairing: null,
      error: `The Razer companion is not responding: ${error?.message ?? error}`,
      managedConnection: { status: "error", configured: true, ready: false },
    };
  }
}

function companionLaunchOptions(hostedUrl = null) {
  return {
    resourcesPath: process.resourcesPath,
    harnessPort: SERVER_PORT,
    hostedUrl,
    harnessSessionToken: UI_SESSION_TOKEN,
    controlSessionToken: COMPANION_CONTROL_SESSION_TOKEN,
    log: slog,
  };
}

function ensureManagedCompanionConnector() {
  if (managedCompanionConnector) return managedCompanionConnector;
  managedCompanionConnector = createManagedCompanionTunnel({
    binaryPath: resolveCloudflaredBinary({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    }),
    guardianEntry: resolveManagedCompanionGuardian({ appPath: app.getAppPath() }),
    runtimeExecutable: process.execPath,
    runtimeRoot: path.join(app.getPath("userData"), "managed-companion-tunnel"),
    onChange: (status) => {
      slog(`managed companion connection ${status.status}`);
      if (!companionDesiredThisLaunch) return;
      void reconcileCompanionAdvertisement(status.ready ? status.endpoint : null);
    },
    log: slog,
  });
  return managedCompanionConnector;
}

/** Publish a hosted address only after its connector has passed public health
 * verification. Updating the owned sidecar in place preserves the exact
 * private origin generation and cannot invalidate an open pairing window. */
function reconcileCompanionAdvertisement(
  endpoint,
  ownedGeneration = companionLaunchGeneration,
) {
  const normalizedEndpoint = endpoint || null;
  const work = advertisementTransition.then(async () => {
    if (
      ownedGeneration !== companionLaunchGeneration ||
      !companionDesiredThisLaunch ||
      !companionRunning() ||
      companionAdvertisedHostedUrl() === normalizedEndpoint
    ) {
      return desktopCompanionState();
    }
    const updated = await setCompanionHostedUrl(normalizedEndpoint);
    return { ...updated, managedConnection: publicManagedCompanionState() };
  });
  advertisementTransition = work.then(
    () => {},
    () => {},
  );
  return work;
}

async function startManagedCompanionConnection({ waitForVerification = true } = {}) {
  if (companionAccountCleanupPending(secureCredentials)) {
    return publicManagedCompanionState();
  }
  const access = managedCompanionTunnelAccess(secureCredentials);
  if (!access) return publicManagedCompanionState();
  const target = companionOriginTarget();
  if (!target) return publicManagedCompanionState();
  const operation = ensureManagedCompanionConnector().start({ ...access, originTarget: target });
  if (!waitForVerification) {
    void operation.catch(() => {});
    return publicManagedCompanionState();
  }
  const status = await operation;
  await reconcileCompanionAdvertisement(status.ready ? status.endpoint : null);
  return publicManagedCompanionState();
}

async function startDesktopCompanion({ waitForHosted = true, remember = true } = {}) {
  companionDesiredThisLaunch = true;
  companionLaunchGeneration += 1;
  // Direct LAN comes up first. The hosted endpoint is added in place only
  // after the guardian has verified the public route to this exact sidecar.
  const localState = await startCompanion(companionLaunchOptions());
  if (!localState.enabled || localState.error) {
    companionDesiredThisLaunch = false;
    return desktopCompanionState();
  }
  if (remember) rememberCompanionEnabled(true);
  await startManagedCompanionConnection({ waitForVerification: waitForHosted });
  return desktopCompanionState();
}

async function stopDesktopCompanion({ remember = true } = {}) {
  companionDesiredThisLaunch = false;
  companionLaunchGeneration += 1;
  if (remember) rememberCompanionEnabled(false);
  syncCompanionKeepAwake(false, false);
  await managedCompanionConnector?.stop();
  await stopCompanion();
  return desktopCompanionState();
}

setCompanionLifecycleListener(({ expected, pid }) => {
  if (expected) return;
  slog(`owned companion exited unexpectedly pid=${pid ?? "unknown"}`);
  companionDesiredThisLaunch = false;
  companionLaunchGeneration += 1;
  syncCompanionKeepAwake(false, false);
  // stop() invalidates the guardian's owner pipe synchronously, before the
  // sidecar module removes this generation's private socket.
  void managedCompanionConnector?.stop().catch(() => {});
});

/** Narrow main-process hook for the account onboarding flow. Its return value
 * is explicitly secret-free and can be used to refresh the settings panel. */
export async function reconcileManagedCompanionEndpointProvision(provision) {
  await updateSecureCredentialDocument((credentials) =>
    withManagedCompanionTunnelAccess(credentials, provision),
  );
  if (companionDesiredThisLaunch) {
    await startManagedCompanionConnection({ waitForVerification: true });
  }
  return publicManagedCompanionState();
}

/** Called only after the control plane has revoked/deleted the endpoint. */
export async function clearManagedCompanionEndpointCredentials() {
  await updateSecureCredentialDocument((credentials) =>
    withoutManagedCompanionTunnelAccess(credentials),
  );
  await managedCompanionConnector?.stop();
  if (companionDesiredThisLaunch) await reconcileCompanionAdvertisement(null);
  return publicManagedCompanionState();
}

/** Account sign-out must stop advertising the hosted route before it asks
 * the control plane to revoke anything, but it must not erase the retry
 * credentials until that remote cleanup is durably scheduled. */
async function stopManagedCompanionEndpointLocally() {
  await managedCompanionConnector?.stop();
  if (companionDesiredThisLaunch) await reconcileCompanionAdvertisement(null);
  return publicManagedCompanionState();
}

async function activatePersistedManagedCompanionEndpoint() {
  if (companionDesiredThisLaunch) {
    return startManagedCompanionConnection({ waitForVerification: true });
  }
  return publicManagedCompanionState();
}

function installationDisplayName() {
  const hostname = [...os.hostname()]
    .filter((character) => character.codePointAt(0) >= 32 && character.codePointAt(0) !== 127)
    .join("")
    .trim();
  return hostname.slice(0, 80) || "This computer";
}

function ensureCompanionAccountService() {
  if (companionAccountService) return companionAccountService;
  const baseURL = resolveCompanionControlPlaneURL({
    isPackaged: app.isPackaged,
    environment: process.env,
  });
  let client = null;
  if (baseURL) {
    try {
      client = createControlPlaneClient({ baseURL });
    } catch {
      // An invalid explicit override disables hosted access. Direct LAN,
      // Bonjour, and Tailscale pairing remain completely independent.
    }
  }
  companionAccountService = createCompanionAccountService({
    client,
    readCredentials: () => secureCredentialState?.read() ?? secureCredentials,
    updateCredentials: updateSecureCredentialDocument,
    identity: {
      name: installationDisplayName(),
      platform:
        process.platform === "win32"
          ? "windows"
          : process.platform === "darwin"
            ? "darwin"
            : "linux",
      appVersion: app.getVersion().slice(0, 64),
    },
    newClientInstanceId: randomUUID,
    activatePersistedEndpoint: activatePersistedManagedCompanionEndpoint,
    stopManagedEndpoint: stopManagedCompanionEndpointLocally,
    managedConnectionState: publicManagedCompanionState,
    companionIsOn: () => companionDesiredThisLaunch,
  });
  return companionAccountService;
}

const LOG_TAIL_BYTES = 256 * 1024;

function readLogTail(logPath) {
  try {
    const size = fs.statSync(logPath).size;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const handle = fs.openSync(logPath, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(handle, buffer, 0, buffer.length, start);
      return decodeLogTail(buffer, start > 0);
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return null;
  }
}

// Everything the bug-report bundle needs. The config summary comes from the
// server's own booleans-only /api/config status (credentials are never
// echoed), and the log goes through the redactor in diagnostics.mjs — so the
// file is safe to paste into a public issue even if a future log line ever
// carried a secret.
async function gatherDiagnostics() {
  const serverStatus = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/config`, {
    headers: { "x-openmausbot-session": UI_SESSION_TOKEN },
    signal: AbortSignal.timeout(3_000),
  })
    .then((res) => res.ok
      ? readBoundedResponseJson(res, 1024 * 1024, "diagnostics response exceeded 1 MB").catch(() => null)
      : null)
    .catch(() => null);
  const logPath = path.join(LOG_DIR, "server.log");
  const log = readLogTail(logPath);
  return buildDiagnosticsReport({
    appInfo: {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
      packaged: app.isPackaged,
      uptimeSeconds: Math.round(process.uptime()),
    },
    configSummary: serverStatus ?? {},
    logTail: log?.tail ?? "",
  });
}

// Set by startServerPackaged: true only when every failing candidate port was
// taken by another process — decides which error-page message renders.
let serverStartConflictOnly = false;

async function startServerOn(port) {
  const entry = path.join(process.resourcesPath, "server", "index.js");
  const childEnv = managedComposioChildEnvironment(composioBrokerUrl(), secureCredentials, {
    ...process.env,
    OMB_STATIC_DIR: path.join(process.resourcesPath, "ui"),
    OMB_RESOURCES_PATH: process.resourcesPath,
    OMB_SKILLS_DIR: path.join(process.resourcesPath, "skills"),
    OMB_PORT: String(port),
    OMB_UI_SESSION_TOKEN_SHA256: UI_SESSION_TOKEN_SHA256,
    OMB_USER_DATA: app.getPath("userData"),
    ...(secureCredentials.composioApiKey
      ? { COMPOSIO_API_KEY: secureCredentials.composioApiKey }
      : {}),
    // "we could not read your keys" must not reach the UI as "you have none"
    OMB_CREDENTIAL_STORE: credentialStoreUnavailable ? "unavailable" : "ok",
    // one env var per stored workspace secret (xai/box/voice/OpenCode Go);
    // the server prefers these over config.json, whose plaintext fields
    // the boot migration has deleted
    ...workspaceCredentialEnv(secureCredentials),
  });
  slog(`fork ${entry} port=${port}`);
  const proc = utilityProcess.fork(entry, [], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (d) => slog(`[out] ${String(d).trimEnd()}`));
  proc.stderr?.on("data", (d) => slog(`[err] ${String(d).trimEnd()}`));
  proc.once("spawn", () => slog(`spawned pid=${proc.pid}`));
  const exitPromise = trackUtilityProcessExit(proc);
  // Publish the child before the first boot-probe await. Closing the app on a
  // cold-start/error screen must stop the server that is still trying to boot,
  // not treat it as though no embedded child existed yet.
  serverProc = proc;
  serverExit = exitPromise;
  let exited = false;
  proc.once("exit", (code) => {
    exited = true;
    slog(`exited code=${code}`);
  });
  // wait for the port to answer (fresh machine: first boot writes data dirs).
  // Identity check is by PID: a dev harness server has the same API shape,
  // so only the child we actually forked (matching pid + static serving)
  // counts as ours.
  // The budget is wall-clock, not a fixed poll count: a healthy boot can take
  // well past 20s on cold machines or when pre-listen network calls stall
  // (issue #506), and reaping an about-to-listen child reads to the user as
  // "something else is using its ports" even though nothing was on them.
  // The probe itself is deadline-bounded (a hung health endpoint cannot wedge
  // us here forever) and reports WHY it gave up, so the error page can tell
  // port conflict apart from slow startup.
  const identity = await pollServerIdentity({
    port,
    // Getter, not value: proc.pid stays undefined until the async `spawn`
    // event fires, and capturing it here would make the probe judge our own
    // child a "foreign owner" on its first health answer.
    pid: () => proc.pid,
    bootTimeoutMs: SERVER_BOOT_TIMEOUT_MS,
    isExited: () => exited,
  });
  if (identity.outcome === "ready") return { proc, exit: exitPromise };
  if (identity.outcome === "exited") {
    slog(`child on port ${port} exited before answering /api/health`);
  } else {
    slog(
      identity.outcome === "foreign-owner"
        ? `port ${port} answered health checks from another process`
        : `child on port ${port} did not answer /api/health within ${SERVER_BOOT_TIMEOUT_MS / 1000}s`,
    );
  }
  try {
    proc.kill();
  } catch {}
  return { proc: null, reason: identity.outcome };
}

async function startServerPackaged() {
  // two passes: a quit-and-reopen relaunch can race the dying instance's
  // server during teardown — one settle-and-retry covers it
  let everyPortForeignOwned = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const port of [8799, 18799, 28799]) {
      if (quitCleanup || quitCleanupFinished) return false;
      const started = await startServerOn(port);
      if (quitCleanup || quitCleanupFinished) return false;
      if (started.proc) {
        serverProc = started.proc;
        serverExit = started.exit;
        SERVER_PORT = port;
        return true;
      }
      // A child that exited or timed out is not evidence of a port conflict —
      // only "another process answered health checks" is.
      if (started.reason !== "foreign-owner") everyPortForeignOwned = false;
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  serverStartConflictOnly = everyPortForeignOwned;
  return false;
}

function syncManagedComposioCredentials() {
  if (!serverProc) return;
  try {
    serverProc.postMessage({
      type: "openmausbot:managed-composio",
      access: managedComposioAccess(composioBrokerUrl(), secureCredentials),
    });
  } catch (error) {
    slog(`connected-apps credential sync failed: ${error?.message ?? error}`);
  }
}

// The page is built at failure time (not import time): the message depends on
// how the boot failed, and the log path comes from LOG_DIR so Windows and
// Linux users see their real location instead of a macOS guess. This fallback
// window deliberately has no privileged preload.
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function buildErrorPage({ allPortsOccupied }) {
  const serverLogPath = path.join(LOG_DIR, "server.log");
  const reason = allPortsOccupied
    ? "Every OpenMausBot port answered health checks from another process — likely a second copy of the app, or another program on ports 8799–28799. Quit that program, then quit and reopen OpenMausBot."
    : "The background server didn't come up in time — this is usually slow startup, not a port conflict. Quit and reopen OpenMausBot.";
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(
      `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#070707;color:#fcfcfc;font:15px -apple-system,system-ui"><div style="text-align:center;max-width:440px"><div style="font-size:40px">🐭</div><h2 style="font-weight:600;margin:12px 0 6px">Couldn't start the bot server</h2><p style="color:#fcfcfc99;line-height:1.5">${escapeHtml(reason)} If it keeps happening, check the server log at <span style="color:#fcfcfc;overflow-wrap:anywhere">${escapeHtml(serverLogPath)}</span>.</p></div></body>`,
    )
  );
}

// How long one packaged-server child gets to answer /api/health before the
// parent reaps it and tries the next port. Wall-clock, deliberately generous:
// first boots write data dirs and pre-listen network calls (managed composio,
// workspace credentials) can stall a healthy child far past 20s on some
// machines, which used to surface as the misleading "ports are busy" page.
const SERVER_BOOT_TIMEOUT_MS = 60_000;

let cuaReady = Promise.resolve({ mode: "unavailable", reason: "not-started" });
const androidDevice = createAndroidDeviceController({ resourcesPath: process.resourcesPath });
const displayMediaGuard = createDisplayMediaGuard();
let displayMediaRequestCount = 0;

function rendererOrigin() {
  return new URL(
    REMOTE_SERVER_URL ?? (app.isPackaged ? `http://127.0.0.1:${SERVER_PORT}` : DEV_URL),
  ).origin;
}

// Every method exposed by preload.cjs crosses one of these two registrars.
// The proof is checked both before dispatch and after asynchronous handlers
// settle, so a reload, process swap, destroyed window, or replacement window
// cannot receive a result under authority minted for an earlier document.
function registerPrivilegedIpcHandle(channel, handler) {
  ipcMain.handle(channel, (event, documentToken, ...args) => {
    const controller = privilegedRendererController;
    if (!controller) throw new Error("Privileged renderer action rejected");
    const proof = controller.authorize(event, documentToken);
    return Promise.resolve(handler(event, ...args)).then(
      (value) => {
        controller.assertProof(proof);
        return value;
      },
      (error) => {
        controller.assertProof(proof);
        throw error;
      },
    );
  });
}

function registerPrivilegedIpcOn(channel, handler) {
  ipcMain.on(channel, (event, documentToken, ...args) => {
    try {
      const controller = privilegedRendererController;
      if (!controller) throw new Error("Privileged renderer action rejected");
      const proof = controller.authorize(event, documentToken);
      handler(event, ...args);
      controller.assertProof(proof);
    } catch {
      // sendSync callers must always receive a reply. Fire-and-forget callers
      // are deliberately dropped without revealing which boundary failed.
      if (channel === "screen:preview-intent") event.returnValue = false;
    }
  });
}

// A sandboxed preload creates a new unguessable token every time Chromium
// creates a document. Frame routing IDs can survive same-origin reloads, so
// this one bootstrap claim is what distinguishes the new isolated world from
// queued IPC sent by the document that just navigated away.
ipcMain.on("desktop:claim-renderer-document", (event, documentToken) => {
  event.returnValue = false;
  try {
    const controller = privilegedRendererController;
    if (!controller) return;
    controller.claim(event, documentToken);
    event.returnValue = true;
  } catch (error) {
    console.error(`[desktop] preload claim failed: ${error?.message ?? error}`);
    // The preload fails closed and does not expose window.ogb.
  }
});

// The first synchronous claim can run against BrowserWindow's transient blank
// document. Once the trusted page is loaded, preload retries through invoke;
// this handler applies the identical controller checks and returns no detail.
ipcMain.handle("desktop:claim-renderer-document-async", (event, documentToken) => {
  try {
    const controller = privilegedRendererController;
    if (!controller) return false;
    controller.claim(event, documentToken);
    return true;
  } catch {
    return false;
  }
});

async function installUiSessionHeader() {
  const origin = rendererOrigin();
  // Remove any cookie left by an earlier build. Cookies are host-scoped, not
  // port-scoped, and therefore cannot safely carry loopback authority.
  await session.defaultSession.cookies.remove(origin, "openmausbot_session").catch(() => {});
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["<all_urls>"] },
    (details, callback) => callback({
      requestHeaders: uiSessionRequestHeaders(origin, UI_SESSION_TOKEN, details.url, details.requestHeaders),
    }),
  );
}

function watchRemoteServer(win) {
  if (!REMOTE_SERVER_URL) return;
  let lastReachable = null;
  let loadFailed = false;
  let checking = false;

  win.webContents.on("did-fail-load", (_event, _code, _description, url, isMainFrame) => {
    if (isMainFrame !== false && typeof url === "string" && url.startsWith(REMOTE_SERVER_URL)) {
      loadFailed = true;
      lastReachable = false;
    }
  });

  const check = async () => {
    if (checking || win.isDestroyed()) return;
    checking = true;
    let reachable = false;
    try {
      const response = await fetch(`${REMOTE_SERVER_URL}/api/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      reachable = response.ok;
    } catch {
      reachable = false;
    } finally {
      checking = false;
    }

    const recovered = reachable && (lastReachable === false || loadFailed);
    lastReachable = reachable;
    if (recovered && !win.isDestroyed()) {
      loadFailed = false;
      void win.loadURL(REMOTE_SERVER_URL).catch(() => {
        loadFailed = true;
      });
    }
  };

  const timer = setInterval(() => void check(), 3_000);
  timer.unref?.();
  win.once("closed", () => clearInterval(timer));
  void check();
}

function respondToDisplayMediaRequest(callback, response) {
  const error = invokeDisplayMediaCallback(callback, response);
  // An empty response intentionally rejects the renderer request, and Electron
  // can surface that rejection by throwing from the callback. A selected
  // source should never fail delivery, so keep that path visible in logs.
  if (error && response.video) {
    console.error("[screen-preview] failed to deliver selected source:", error);
  }
}

function openDesktopViewer(owner, rawUrl, rawTitle, contextId) {
  if (!owner || owner.isDestroyed()) throw new Error("The OpenMausBot window is unavailable");
  const url = desktopViewerUrl(rawUrl);
  const titleCandidate = Object.prototype.toString.call(rawTitle) === "[object String]" ? rawTitle.trim() : "";
  const title = titleCandidate ? titleCandidate.slice(0, 80) : "Live desktop";
  const nextContextId = desktopViewers.contextId(contextId);

  const viewer = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    parent: owner,
    // Not modal: the person still needs the app's "Hand control back" button
    // while the desktop is open. `parent` keeps it floating above the app.
    modal: false,
    show: false,
    title,
    icon: APP_ICON,
    backgroundColor: "#070707",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Keep provider cookies away from the app renderer and discard them on
      // close. A fresh in-memory partition also prevents a closing viewer
      // from sharing cookies or request-filter state with its replacement;
      // the secret-bearing URL is sufficient to authenticate.
      partition: `openmausbot-desktop-viewer-${randomUUID()}`,
    },
  });
  const record = { contextId: nextContextId, owner: owner.webContents, viewer };
  try {
    // A rotating URL replaces only this bot's old authority window. Other
    // bots retain their own windows, sessions, request filters and leases.
    desktopViewers.install(nextContextId, record);
  } catch (error) {
    if (!viewer.isDestroyed()) viewer.destroy();
    throw error;
  }
  const unbindViewerOwner = bindDesktopViewerToOwner(owner.webContents, () => {
    desktopViewers.closeRecord(record);
  });
  viewer.once("closed", unbindViewerOwner);
  // VNC needs rendering, keyboard/mouse input and WebSockets — never host
  // camera, microphone, geolocation, notifications, USB, or other privileged
  // browser capabilities in this remote-content window.
  viewer.webContents.session.setPermissionCheckHandler(() => false);
  viewer.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  viewer.webContents.session.webRequest.onBeforeRequest(
    { urls: ["<all_urls>"] },
    (details, callback) => callback({ cancel: !desktopViewerRequestAllowed(url, details.url) }),
  );

  let settleOpen;
  const opened = new Promise((resolve) => {
    let settled = false;
    let timeout;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(value);
    };
    settleOpen = finish;
    timeout = setTimeout(() => {
      finish(false);
      if (!viewer.isDestroyed()) viewer.destroy();
    }, 15_000);
    viewer.webContents.once("did-finish-load", () => {
      if (viewer.isDestroyed() || !desktopViewers.isCurrent(record)) return finish(false);
      viewer.show();
      if (!desktopViewerNeedsRfbProof(url)) {
        desktopViewers.notifyOpen(record);
        finish(true);
        return;
      }

      // noVNC's main frame can load while websockify/RFB is dead. Only its
      // connected class proves that the live window can actually send input.
      // Keep the connecting window visible, but report success to the app only
      // after that proof; an HTTP error page simply times out and closes.
      const checkRfb = async () => {
        if (settled || viewer.isDestroyed() || !desktopViewers.isCurrent(record)) return;
        try {
          const state = await viewer.webContents.executeJavaScript(
            `(() => {
              const root = document.documentElement;
              const status = document.getElementById("noVNC_status");
              return {
                connected: root.classList.contains("noVNC_connected"),
                failed: Boolean(status?.classList.contains("noVNC_status_error")),
              };
            })()`,
            true,
          );
          if (state?.connected === true) {
            desktopViewers.notifyOpen(record);
            finish(true);
            return;
          }
          if (state?.failed === true) {
            finish(false);
            if (!viewer.isDestroyed()) viewer.destroy();
            return;
          }
        } catch {
          // Navigation/teardown races settle through fail-load, close, or the
          // bounded timeout. Never turn an evaluation error into success.
        }
        setTimeout(() => void checkRfb(), 150);
      };
      void checkRfb();
    });
    viewer.once("closed", () => {
      finish(false);
    });
  });
  viewer.on("closed", () => {
    // Identity fencing makes a stale close from A1 a no-op after A2 replaced
    // it, while a real close reports only this bot to its owning document.
    desktopViewers.handleClosed(record);
  });
  viewer.on("page-title-updated", (event) => {
    event.preventDefault();
    viewer.setTitle(title);
  });
  viewer.webContents.setWindowOpenHandler(({ url: target }) => {
    // Hosted viewer content is untrusted. It cannot launch the user's normal
    // browser, even for HTTPS: that would turn an automatic popup/navigation
    // into phishing or a localhost-probing escape from this isolated session.
    return { action: desktopViewerNavigationAllowed(url, target, true) ? "allow" : "deny" };
  });
  const unbindViewerNavigation = bindDesktopViewerNavigation(viewer.webContents, url, () => {
    settleOpen?.(false);
    if (!viewer.isDestroyed()) viewer.destroy();
  });
  viewer.once("closed", unbindViewerNavigation);
  viewer.webContents.on("did-fail-load", (_event, code, _description, failedUrl, isMainFrame) => {
    if (
      !isMainFrame ||
      code === -3 ||
      viewer.isDestroyed() ||
      (typeof failedUrl === "string" && failedUrl.startsWith("data:"))
    ) return;
    settleOpen?.(false);
    viewer.destroy();
  });

  void viewer.loadURL(url.toString()).catch((error) => {
    if (viewer.isDestroyed()) return;
    console.error(desktopViewerLoadFailureLabel(error));
    settleOpen?.(false);
    viewer.destroy();
  });
  return opened;
}

registerPrivilegedIpcOn("screen:preview-intent", (event) => {
  event.returnValue = displayMediaGuard.begin(event.senderFrame);
});

registerPrivilegedIpcOn("desktop:unread-count", (event, value) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (!sender || sender !== mainWindow || sender.isDestroyed()) return;
  unreadCount = normalizeUnreadCount(value);
  applyUnreadBadge(sender);
});

function createWindow() {
  const isMac = process.platform === "darwin";
  const hostsPrivilegedRenderer = Boolean(REMOTE_SERVER_URL || !app.isPackaged || serverReady);
  const primary = screen.getPrimaryDisplay();
  const displays = [primary, ...screen.getAllDisplays().filter((display) => display.id !== primary.id)];
  const restored = resolveWindowState(readWindowState(), displays.map((display) => display.workArea));
  const webPreferences = {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    // Control leases are intentionally short. Keep the renderer heartbeat
    // timely when the user is driving the separate live-desktop window or
    // has minimized the main app. The server-side viewer keepalive remains
    // authoritative; this also keeps non-viewer physical takeover healthy.
    backgroundThrottling: false,
  };
  if (hostsPrivilegedRenderer) webPreferences.preload = path.join(__dirname, "preload.cjs");
  const win = new BrowserWindow({
    ...restored.bounds,
    minWidth: 900,
    minHeight: 600,
    icon: APP_ICON,
    backgroundColor: "#070707",
    autoHideMenuBar: process.platform !== "darwin",
    // macOS keeps inset traffic lights, Windows keeps its custom overlay,
    // and Linux uses the native desktop title bar and window controls.
    ...(isMac
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 } }
      : process.platform === "win32"
        ? {
            titleBarStyle: "hidden",
            // height MUST match the ChatView/GroupView header strip (px-5 py-3
            // around a 36px control row = 60). Windows draws the caption buttons
            // to fill the overlay, so anything shorter leaves a dead band under
            // them and anything taller overhangs the header.
            titleBarOverlay: { color: "#070707", symbolColor: "#b5b5b5", height: 60 },
          }
        : {}),
    webPreferences,
  });
  mainWindow = win;
  if (hostsPrivilegedRenderer) {
    privilegedRendererController = createPrivilegedRendererController({
      expectedOrigin: rendererOrigin(),
      getMainWindow: () => mainWindow,
    });
    bindPrivilegedRendererNavigation({
      controller: privilegedRendererController,
      window: win,
      onBlockedProgrammaticNavigation: () => {
        try {
          win.webContents.stop();
        } finally {
          // Programmatic loadURL/back/forward bypass the preventable
          // will-navigate events. Destroying is the only fail-closed way to
          // ensure Chromium cannot commit a foreign document with our preload.
          if (!win.isDestroyed()) win.destroy();
        }
      },
    });
  } else {
    privilegedRendererController = null;
  }
  installWindowStatePersistence(win);
  applyUnreadBadge(win);
  if (restored.maximized) win.maximize();
  win.on("close", (event) => {
    if (!windowBackgroundPolicy.shouldHideOnClose()) return;
    // Keep the renderer's event stream and native notifications alive, and
    // keep the attended bridge visibly represented by the menu-bar item.
    // OpenMausBot -> Quit remains the explicit disconnect operation.
    event.preventDefault();
    win.hide();
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalWebUrl(url);
    if (external) {
      void shell.openExternal(external).catch((error) => {
        console.error(`[desktop] external link failed: ${error?.message ?? error}`);
      });
    }
    return { action: "deny" };
  });
  win.webContents.on("did-finish-load", () => deliverPackageInstall(win));

  // Native context menu for text inputs — without this, right-click does
  // nothing in the Electron window (no Cut/Copy/Paste/Select All).
  win.webContents.on("context-menu", (_event, params) => {
    // nothing actionable here — no menu at all, rather than a wall of
    // disabled items
    if (!params.isEditable && !params.linkURL && !params.misspelledWord && !params.selectionText) return;
    const menuItems = [];
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        menuItems.push({
          label: suggestion,
          click: () => win.webContents.replaceMisspelling(suggestion),
        });
      }
      if (menuItems.length) menuItems.push({ type: "separator" });
    }
    if (params.linkURL) {
      menuItems.push(
        { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) },
        { type: "separator" },
      );
    }
    menuItems.push(
      { label: "Undo", role: "undo", enabled: params.editFlags.canUndo },
      { label: "Redo", role: "redo", enabled: params.editFlags.canRedo },
      { type: "separator" },
      { label: "Cut", role: "cut", enabled: params.editFlags.canCut },
      { label: "Copy", role: "copy", enabled: params.editFlags.canCopy },
      { label: "Paste", role: "paste", enabled: params.editFlags.canPaste },
      { label: "Paste and Match Style", role: "pasteAndMatchStyle", enabled: params.editFlags.canPaste },
      { type: "separator" },
      { label: "Select All", role: "selectAll", enabled: params.editFlags.canSelectAll },
    );
    Menu.buildFromTemplate(menuItems).popup({ window: win, frame: params.frame });
  });

  // Packaged CI smoke hook. It validates the real renderer/preload bridge and
  // same-origin embedded server, then follows the normal window-close path.
  // No debugging port or sandbox override is needed.
  if (process.env.OMB_SMOKE_TEST === "1") {
    win.webContents.once("did-finish-load", async () => {
      try {
        const result = await win.webContents.executeJavaScript(`
          (async () => {
            if (!window.ogb?.getCapabilities) throw new Error("desktop preload bridge is unavailable");
            let crashPromise = null;
            if (${JSON.stringify(process.env.OMB_SMOKE_CUA === "1")}) {
              crashPromise = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                  unsubscribe?.();
                  reject(new Error("timed out waiting for CUA crash invalidation"));
                }, 10000);
                const unsubscribe = window.ogb.onCapabilitiesChanged((next) => {
                  if (next.localComputer.reasonCode !== "daemon-exited") return;
                  clearTimeout(timeout);
                  unsubscribe();
                  resolve(next.localComputer.reasonCode);
                });
              });
            }
            const [initialCapabilities, connection, companion, healthResponse] = await Promise.all([
              window.ogb.getCapabilities(),
              window.ogb.connection(),
              window.ogb.companion.state(),
              fetch("/api/health"),
            ]);
            if (!healthResponse.ok) {
              throw new Error(\`health request failed: \${healthResponse.status} \${healthResponse.statusText}\`);
            }
            const health = await healthResponse.json();
            let capabilities = initialCapabilities;
            let cuaCrashReason = null;
            let cuaRetryStatus = null;
            if (crashPromise) {
              if (!initialCapabilities.localComputer.available) {
                throw new Error("CUA was not ready before the simulated crash");
              }
              cuaCrashReason = await crashPromise;
              cuaRetryStatus = await window.ogb.localControl.retry();
              capabilities = await window.ogb.getCapabilities();
            }
            return {
              initialCapabilities,
              capabilities,
              connection,
              companion,
              cuaCrashReason,
              cuaRetryStatus,
              health,
              location: window.location.href,
              title: document.title,
            };
          })()
        `);
        const expectedLocation = `${rendererOrigin()}/`;
        if (result.location !== expectedLocation) {
          throw new Error(
            `unexpected packaged renderer URL: ${result.location} (expected ${expectedLocation})`,
          );
        }
        if (process.env.OMB_SMOKE_BUNDLED_CUA === "1") {
          const connection = await cuaReady;
          const expectedDriver = path.join(
            process.resourcesPath,
            "cua-linux-x64",
            "cua-driver",
          );
          let exactBundledPath = false;
          try {
            exactBundledPath =
              Boolean(connection?.driver?.path) &&
              fs.realpathSync(connection.driver.path) === fs.realpathSync(expectedDriver);
          } catch {}
          result.cuaRuntime = {
            driverSource: connection?.driver?.source,
            exactBundledPath,
            appImagePrivateStage:
              Boolean(process.env.APPIMAGE) &&
              connection?.driver?.path !== expectedDriver &&
              path.basename(path.dirname(connection?.driver?.path ?? "")).startsWith(
                APPIMAGE_CUA_STAGE_PREFIX,
              ),
            driverPath: connection?.driver?.path,
            driverVersion: connection?.driver?.version,
            daemonPid: connection?.daemon?.pid,
            socketPath: connection?.daemon?.socketPath,
            pidFile: connection?.daemon?.socketPath
              ? path.join(path.dirname(connection.daemon.socketPath), "driver.pid")
              : undefined,
            mcpEnv: connection?.mcp?.env,
          };
        }
        result.hardwareAccelerationEnabled = app.isHardwareAccelerationEnabled();
        result.displayMediaRequests = displayMediaRequestCount;
        console.log(`[smoke] renderer-ready ${JSON.stringify(result)}`);
      } catch (error) {
        console.error(`[smoke] renderer-failed ${error?.stack ?? error}`);
      } finally {
        if (process.env.OMB_SMOKE_KEEP_OPEN !== "1") win.close();
      }
    });
  }

  if (REMOTE_SERVER_URL) {
    void win.loadURL(REMOTE_SERVER_URL).catch(() => {});
    watchRemoteServer(win);
  } else if (app.isPackaged) {
    win.loadURL(serverReady ? `http://127.0.0.1:${SERVER_PORT}` : buildErrorPage({ allPortsOccupied: serverStartConflictOnly }));
  } else {
    win.loadURL(DEV_URL);
  }
  return win;
}

// Local-control screen preview — served from the main process so the Screen
// Recording permission prompt attributes to the app, never the server
registerPrivilegedIpcHandle("screen:frame", async () => {
  if (process.platform !== "darwin") return null;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1280, height: 800 },
  });
  return sources[0]?.thumbnail.toDataURL() ?? null;
});

// Onboarding permission checks. Status reads are free; the mic request
// pops the real TCC prompt attributed to the app.
//
// Screen Recording deliberately has NO request path here. On macOS 15+
// every pre-grant mechanism is broken: getMediaAccessStatus("screen")
// wraps CGPreflightScreenCaptureAccess, which caches per-process (stays
// "denied" for the whole session after the user grants); a helper child
// binary gets TCC-attributed to ITSELF on macOS 26, not the app, and
// plain executables no longer appear in the Settings pane at all; and
// Sequoia+ re-prompts periodically regardless, so a pre-grant expires.
// The one reliable path is the first real in-process capture
// (screen:frame above / getDisplayMedia via the handler below) — macOS
// prompts then, attributed correctly, at the moment of actual use. The
// perm:open-settings deep link stays as the repair path for denials.
// Copy the engine command, then open a blank terminal. Renderer-controlled
// text must never become a process argument: the user reviews and pastes it.
// Returns false when the renderer should show the clipboard fallback.
registerPrivilegedIpcHandle("engine:open-terminal", async (_event, command) => {
  if (typeof command !== "string" || !command.trim()) return false;
  clipboard.writeText(command);
  return openBlankTerminal();
});

// OAuth/connect links are returned asynchronously, after Chromium's direct
// click gesture has ended. Opening them through window.open can therefore be
// rejected as a popup before setWindowOpenHandler ever sees the URL. Keep the
// renderer sandboxed and let the main process open only ordinary web links.
// A bot's working folder: the native picker, so the path is real and the
// user never types one. Returns null when they cancel.
registerPrivilegedIpcHandle("desktop:pick-folder", async (event, current) => {
  if (REMOTE_SERVER_URL) {
    throw new Error("Choose a server working folder in OpenMaus; this native dialog can only see folders on this computer");
  }
  const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const result = await dialog.showOpenDialog(win, {
    title: "Choose a working folder",
    properties: ["openDirectory", "createDirectory"],
    ...(typeof current === "string" && current ? { defaultPath: current } : {}),
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

// One-click bug-report bundle. Secrets are never read; the report is
// redacted again on the way out (diagnostics.mjs). null means the user
// cancelled the save dialog.
registerPrivilegedIpcHandle("desktop:export-diagnostics", async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const report = await gatherDiagnostics();
  const result = await dialog.showSaveDialog(owner, {
    title: "Export diagnostics",
    defaultPath: diagnosticsFileName(),
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  if (result.canceled || !result.filePath) return null;
  if (process.platform === "win32") {
    fs.writeFileSync(result.filePath, report, { mode: 0o600 });
  } else {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
    const handle = fs.openSync(result.filePath, flags, 0o600);
    try {
      fs.fchmodSync(handle, 0o600);
      fs.writeFileSync(handle, report, "utf8");
    } finally {
      fs.closeSync(handle);
    }
  }
  return result.filePath;
});

// Bots hand users files as markdown links to paths inside the OpenMausBot
// home (workspaces, attachments). As plain anchors those resolved against the
// page origin, so the click opened http://127.0.0.1:8799<path> in the default
// browser and the server's SPA fallback answered with index.html — a second
// copy of the chat UI instead of the file. Ask where to put it and copy it
// there instead: a save dialog tells the user the file landed somewhere and
// where, which a silent copy into ~/Downloads does not. The path is
// renderer-controlled, so it must resolve inside ~/.openmausbot and be a
// regular file — never a symlink escape or directory. In remote mode that
// pathname lives on Razer, so it is fetched through the authenticated harness
// endpoint; the Mac must never try to resolve it locally.
const REMOTE_FILE_MAX_BYTES = 25 * 1024 * 1024;

async function fetchRemoteSavableFile(rawPath) {
  if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.length > 4096) {
    throw new Error("That server file path is invalid");
  }
  const response = await fetch(`${REMOTE_SERVER_URL}/api/files/download`, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      "x-openmausbot-session": UI_SESSION_TOKEN,
    },
    body: JSON.stringify({ path: rawPath }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = await readBoundedResponseJson(
      response,
      64 * 1024,
      "Razer file error response exceeded 64 KB",
    ).catch(() => null);
    throw new Error(typeof detail?.error === "string" ? detail.error : "That Razer file could not be downloaded");
  }
  const declared = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > REMOTE_FILE_MAX_BYTES) {
    throw new Error("That Razer file is too large to save");
  }
  const bytes = Buffer.from(await readBoundedResponseBytes(
    response,
    REMOTE_FILE_MAX_BYTES,
    "That Razer file is too large to save",
  ));
  if (bytes.byteLength !== declared || bytes.byteLength > REMOTE_FILE_MAX_BYTES) {
    throw new Error("That Razer file changed while it was being downloaded");
  }
  return {
    bytes,
    defaultName: remoteDownloadName(
      response.headers.get("x-openmausbot-file-name-b64"),
      response.headers.get("x-openmausbot-file-name"),
    ),
  };
}

function writeRemoteSaveDestination(destination, bytes) {
  if (process.platform === "win32") {
    fs.writeFileSync(destination, bytes, { mode: 0o600 });
    return;
  }
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
  const handle = fs.openSync(destination, flags, 0o600);
  try {
    fs.fchmodSync(handle, 0o600);
    fs.writeFileSync(handle, bytes);
  } finally {
    fs.closeSync(handle);
  }
}

registerPrivilegedIpcHandle("desktop:save-file", async (event, rawPath) => {
  if (REMOTE_SERVER_URL) {
    const file = await fetchRemoteSavableFile(rawPath);
    const parent = BrowserWindow.fromWebContents(event.sender);
    const defaultPath = await defaultSaveName(app.getPath("downloads"), file.defaultName);
    const choice = await dialog.showSaveDialog(parent ?? undefined, {
      title: "Where do you want to save it?",
      message: "Save a copy from Razer",
      defaultPath,
      buttonLabel: "Save",
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    if (choice.canceled || !choice.filePath) return null;
    writeRemoteSaveDestination(choice.filePath, file.bytes);
    shell.showItemInFolder(choice.filePath);
    return choice.filePath;
  }
  return withSavableFile(rawPath, { home: os.homedir() }, async ({ defaultName, copyTo }) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const defaultPath = await defaultSaveName(app.getPath("downloads"), defaultName);
    const choice = await dialog.showSaveDialog(parent ?? undefined, {
      title: "Where do you want to save it?",
      message: "Where do you want to save it?",
      defaultPath,
      buttonLabel: "Save",
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    // Cancelling is a decision, not a failure — the bubble stays quiet.
    if (choice.canceled || !choice.filePath) return null;
    await copyTo(choice.filePath);
    shell.showItemInFolder(choice.filePath);
    return choice.filePath;
  });
});

registerPrivilegedIpcHandle("desktop:open-external", async (_event, rawUrl) => {
  const url = externalWebUrl(rawUrl);
  if (!url) throw new Error("Only ordinary HTTP(S) web links can be opened");
  await shell.openExternal(url);
  return true;
});

// The Box VNC viewer must be a top-level page for its token exchange. A
// sandboxed modal BrowserWindow satisfies that requirement while keeping the
// live desktop inside OpenMausBot instead of sending the person to a browser.
registerPrivilegedIpcHandle("desktop-viewer:open", (event, rawUrl, title, contextId) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  return openDesktopViewer(owner, rawUrl, title, contextId);
});

// Close only this exact bot's viewer and only from its owning renderer
// document. A different bot's window and lease are never collateral damage.
registerPrivilegedIpcHandle("desktop-viewer:close", (event, contextId) => {
  return desktopViewers.close(contextId, event.sender);
});

// Panels query one exact bot. The global lease observer uses the bounded list
// to recover all windows already owned by this renderer without choosing an
// arbitrary "current" viewer from a concurrent set.
registerPrivilegedIpcHandle("desktop-viewer:state-now", (event, contextId) => {
  return desktopViewers.state(contextId, event.sender);
});
registerPrivilegedIpcHandle("desktop-viewer:states-now", (event) => {
  return desktopViewers.states(event.sender);
});

registerPrivilegedIpcHandle("perm:status", () => ({
  mic:
    nativeActions.appleMediaPermissions
      ? systemPreferences.getMediaAccessStatus?.("microphone") ?? "unknown"
      : "unsupported",
}));
registerPrivilegedIpcHandle("perm:request-mic", async () => {
  if (!nativeActions.appleMediaPermissions) return false;
  try {
    return await systemPreferences.askForMediaAccess("microphone");
  } catch {
    return false;
  }
});

// macOS never re-prompts a denied permission — the only path is System
// Settings; deep-link straight to the right privacy pane.
registerPrivilegedIpcHandle("perm:open-settings", (_event, pane) => {
  if (!nativeActions.applePrivacySettings) return false;
  const panes = {
    mic: "Privacy_Microphone",
    screen: "Privacy_ScreenCapture",
    speech: "Privacy_SpeechRecognition",
    accessibility: "Privacy_Accessibility",
  };
  // own-property lookup only — a renderer-supplied "__proto__"/"constructor"
  // would otherwise resolve up the prototype chain to a truthy object
  const anchor = Object.hasOwn(panes, pane) ? panes[pane] : "Privacy";
  return shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`);
});

registerPrivilegedIpcHandle("speech:start", (event, options) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (!nativeActions.appleSpeech) {
    win.webContents.send("speech:end", { code: 2, reason: "unsupported-platform" });
    return;
  }
  startSpeech(win, options);
});
registerPrivilegedIpcHandle("speech:stop", () => {
  if (nativeActions.appleSpeech) stopSpeech();
});
registerPrivilegedIpcHandle("speech:finish", () => {
  if (nativeActions.appleSpeech) finishSpeech();
});

registerPrivilegedIpcHandle("skill-recorder:permissions", () => recorderPermissionStatus());
registerPrivilegedIpcHandle("skill-recorder:start", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) throw new Error("The recorder window is unavailable");
  return startRecorder(win);
});
registerPrivilegedIpcHandle("skill-recorder:stop", () => stopRecorder());
registerPrivilegedIpcHandle("skill-recorder:save", (_event, payload) => saveSkillRecording(payload));

// ── companion sidecar ──────────────────────────────────────────────────
// The renderer gets these five and nothing else: it can turn the companion
// on and off, look at it, open or cancel a pairing window, and remove a
// device. It cannot reach the sidecar's control port itself.
registerPrivilegedIpcHandle("companion:state", () => desktopCompanionState());
registerPrivilegedIpcHandle("companion:start", () =>
  REMOTE_COMPANION_URL ? desktopCompanionState() : startDesktopCompanion(),
);
registerPrivilegedIpcHandle("companion:stop", () =>
  REMOTE_COMPANION_URL ? desktopCompanionState() : stopDesktopCompanion(),
);
registerPrivilegedIpcHandle("companion:keep-awake", async (_event, enabled) => {
  if (REMOTE_COMPANION_URL) return desktopCompanionState();
  rememberCompanionKeepAwake(Boolean(enabled));
  return desktopCompanionState();
});
registerPrivilegedIpcHandle("companion:pairing", (_event, open, expectedToken) =>
  REMOTE_COMPANION_URL
    ? remoteCompanionRequest(
        open ? "POST" : "DELETE",
        !open && expectedToken
          ? `/pairing?expectedToken=${encodeURIComponent(String(expectedToken))}`
          : "/pairing",
      )
    : companionPairing(Boolean(open), expectedToken).then(decorateDesktopCompanionState),
);
registerPrivilegedIpcHandle("companion:cloud-desktop", (_event, deviceId, allowed) =>
  REMOTE_COMPANION_URL
    ? remoteCompanionRequest(
        allowed ? "POST" : "DELETE",
        `/devices/${encodeURIComponent(String(deviceId))}/cloud-desktop`,
      )
    : companionCloudDesktopAccess(deviceId, Boolean(allowed)).then(() => desktopCompanionState()),
);
registerPrivilegedIpcHandle("companion:revoke", (_event, deviceId) =>
  REMOTE_COMPANION_URL
    ? remoteCompanionRequest("DELETE", `/devices/${encodeURIComponent(String(deviceId))}`)
    : companionRevoke(deviceId).then(() => desktopCompanionState()),
);

// Auth and connector credentials never cross this boundary. Every handler
// returns the same deliberately tiny, secret-free public account state.
registerPrivilegedIpcHandle("companion-account:state", () => ensureCompanionAccountService().state());
registerPrivilegedIpcHandle("companion-account:request-code", (_event, email) =>
  ensureCompanionAccountService().requestCode(email),
);
registerPrivilegedIpcHandle("companion-account:verify-code", (_event, email, code) =>
  ensureCompanionAccountService().verifyCode(email, code),
);
registerPrivilegedIpcHandle("companion-account:retry", () => ensureCompanionAccountService().retry());
registerPrivilegedIpcHandle("companion-account:sign-out", () => ensureCompanionAccountService().signOut());

registerPrivilegedIpcHandle("desktop:connection", () => ({
  mode: REMOTE_SERVER_URL ? "remote" : "local",
  serverUrl: rendererOrigin(),
}));

function desktopCapabilitiesForRenderer(localConnection) {
  const connection = { mode: REMOTE_SERVER_URL ? "remote" : "local" };
  if (REMOTE_SERVER_URL) connection.serverName = REMOTE_SERVER_NAME;
  return {
    ...desktopCapabilities({
      platform: process.platform,
      env: process.env,
      packaged: app.isPackaged,
      localConnection,
    }),
    connection,
  };
}

registerPrivilegedIpcHandle("desktop:capabilities", async () =>
  desktopCapabilitiesForRenderer(await cuaReady),
);

registerPrivilegedIpcHandle("assemblyai:status", () => ({
  configured: Boolean(assemblyAICredential(secureCredentials)),
}));

registerPrivilegedIpcHandle("assemblyai:set-key", async (_event, value) => {
  if (typeof value !== "string") throw new Error("Unsupported credential");
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("The operating-system credential store is unavailable");
  }
  const secret = value.trim();
  await updateSecureCredentialDocument((credentials) => {
    if (secret) credentials.assemblyAiApiKey = secret;
    else delete credentials.assemblyAiApiKey;
    return credentials;
  });
  return { configured: Boolean(secret) };
});

registerPrivilegedIpcHandle("assemblyai:streaming-token", () =>
  mintAssemblyAIStreamingToken(assemblyAICredential(secureCredentials)),
);

const CREDENTIAL_PATCH = {
  composioApiKey: (value) => ({ composio: { apiKey: value } }),
  xaiApiKey: (value) => ({ xai: { key: value } }),
  boxToken: (value) => ({ box: { token: value } }),
  opencodeGoApiKey: (value) => ({ opencodeGo: { apiKey: value } }),
  ttsKey: (value) => ({ tts: { key: value } }),
  openaiImageApiKey: (value) => ({ imageGen: { key: value } }),
};

registerPrivilegedIpcHandle("credential:set", async (_event, name, value) => {
  const patchFor = CREDENTIAL_PATCH[name];
  if (!patchFor || typeof value !== "string") {
    throw new Error("Unsupported credential");
  }
  if (!REMOTE_SERVER_URL && app.isPackaged && !(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("The operating-system credential store is unavailable");
  }
  const secret = value.trim();
  const applyToHarness = async () => {
    // In development the server is a separately launched process, so it
    // cannot receive credentials from Electron at boot. Keep its established
    // local config path there; production always uses the encrypted store.
    const secretStorage = app.isPackaged && !REMOTE_SERVER_URL ? "?secretStorage=external" : "";
    const requestUrl = `${rendererOrigin()}/api/config${secretStorage}`;
    const response = await fetch(requestUrl, {
      method: "PUT",
      redirect: "error",
      // This is Node's main-process fetch, not a Chromium request, so the
      // defaultSession webRequest hook cannot add the remote UI bearer. Use
      // the same exact-origin helper explicitly; it also strips a caller-
      // supplied copy if this target ever stops being the harness origin.
      headers: uiSessionRequestHeaders(rendererOrigin(), UI_SESSION_TOKEN, requestUrl, {
        "content-type": "application/json",
      }),
      body: JSON.stringify(patchFor(secret)),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await readBoundedResponseJson(
      response,
      1024 * 1024,
      "credential update response exceeded 1 MB",
    ).catch(() => null);
    if (!response.ok) throw new Error(body?.error || `Could not save credential (HTTP ${response.status})`);
    return body;
  };
  if (!app.isPackaged || REMOTE_SERVER_URL) return applyToHarness();

  // Commit the encrypted value before the server makes it live. The shared
  // state rolls credentials.bin back if validation/reload fails, while also
  // keeping concurrent account and provider updates serialized.
  return updateSecureCredentialDocument(
    (credentials) => {
      if (secret) credentials[name] = secret;
      else delete credentials[name];
      return credentials;
    },
    applyToHarness,
  );
});

async function broadcastDesktopCapabilities() {
  const capabilities = desktopCapabilitiesForRenderer(await cuaReady);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("desktop:capabilities-changed", capabilities);
  }
}

setCuaStateListener((connection) => {
  cuaReady = Promise.resolve(connection);
  void remotePhysicalBridge?.refresh().catch(() => {});
  void broadcastDesktopCapabilities().catch((error) => {
    console.error("[desktop] capability broadcast failed:", error);
  });
});

app.whenReady().then(async () => {
  if (app.isPackaged) app.setAsDefaultProtocolClient("openmausbot");
  if (process.platform === "darwin") app.dock.setIcon(APP_ICON);
  secureCredentials = await loadSecureCredentials();
  if (app.isPackaged) {
    await secureComposioConfig();
    await secureWorkspaceConfig();
  }
  // Boot migrations above are deliberately sequential. From this point on,
  // every account/API-key writer must use the shared serialized state.
  // An unreadable store must not become a WRITE of an empty document.
  secureCredentialState = createSecureCredentialState(secureCredentials, saveSecureCredentials, {
    writable: !credentialStoreUnavailable,
  });
  secureCredentials = secureCredentialState.read();
  const hostedAccount = ensureCompanionAccountService();
  // Display capture remains user-initiated. The renderer first sends a
  // short-lived one-shot intent, then calls getDisplayMedia in the same click.
  // The handler binds that request to the same frame/origin, rejects audio,
  // and requires Electron's active user-gesture signal.
  if (process.platform === "darwin" || process.platform === "linux") {
    session.defaultSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        displayMediaRequestCount += 1;
        if (!displayMediaGuard.consume(request, rendererOrigin())) {
          respondToDisplayMediaRequest(callback, {});
          return;
        }

        const capabilities = desktopCapabilities({
          platform: process.platform,
          env: process.env,
          packaged: app.isPackaged,
        });
        const captureHost =
          process.platform === "darwin" ? "darwin" : capabilities.host.session;
        if (!capabilities.screenPreview.available) {
          respondToDisplayMediaRequest(callback, {});
          return;
        }

        desktopCapturer
          .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
          .then((sources) => {
            const source = selectCaptureSource({
              sources,
              host: captureHost,
              primaryDisplayId:
                process.platform === "linux" && captureHost === "x11"
                  ? screen.getPrimaryDisplay().id
                  : null,
            });
            if (!source) {
              console.warn(
                `[screen-preview] rejected ${captureHost} source set (${sources.length} candidates)`,
              );
            }
            respondToDisplayMediaRequest(callback, source ? { video: source } : {});
          })
          .catch((error) => {
            console.warn("[screen-preview] source discovery failed:", error);
            respondToDisplayMediaRequest(callback, {});
          });
      },
      { useSystemPicker: false },
    );
  }
  registerCuaIpc(registerPrivilegedIpcHandle);
  androidDevice.registerIpc({ handle: registerPrivilegedIpcHandle });
  registerUpdaterIpc(registerPrivilegedIpcHandle);
  // Start the CUA daemon before the window so the harness can pick up the
  // connection descriptor on first render. Never blocks window creation on
  // failure — computer use degrades to "unavailable", the rest still works.
  cuaReady =
    process.platform === "darwin" ||
    process.platform === "win32" ||
    (process.platform === "linux" && !REMOTE_SERVER_URL)
      ? startCua().catch((e) => {
          console.error("[cua] start failed:", e);
          return { mode: "unavailable", reason: String(e) };
        })
      : Promise.resolve({
          mode: "unavailable",
          reason: REMOTE_SERVER_URL ? "remote-client" : "unsupported-platform",
        });
  if (app.isPackaged && !REMOTE_SERVER_URL) serverReady = await startServerPackaged();
  // The raw human-app capability never enters renderer JavaScript. Electron
  // injects it only on requests to the exact harness origin (port included),
  // so bot-authored remote/loopback images cannot receive it.
  await installUiSessionHeader();
  // The companion the user left on comes back without anyone finding the
  // toggle again — one attempt, after the harness port is settled, with the
  // exact options the IPC handler uses. A failure surfaces in companionState
  // (the panel shows the error) rather than retrying; and it never delays
  // the window.
  if (!REMOTE_SERVER_URL && serverReady && companionEnabledAtRest()) {
    void startDesktopCompanion({ waitForHosted: false, remember: false });
  }
  const win = createWindow();
  installBackgroundTray();
  if (
    REMOTE_SERVER_URL &&
    (process.platform === "darwin" || process.platform === "win32")
  ) {
    const deviceName = process.platform === "win32" ? "Windows PC" : "Mac";
    remotePhysicalBridge = await startOutboundPhysicalBridge({
      serverUrl: REMOTE_SERVER_URL,
      sessionToken: UI_SESSION_TOKEN,
      platform: process.platform,
      getConnection: () => cuaReady,
      captureScreenshot: async ({ signal }) => {
        if (signal.aborted) throw new Error("physical screenshot capture was cancelled");
        const sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 1280, height: 800 },
        });
        if (signal.aborted) throw new Error("physical screenshot capture was cancelled");
        const activeDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        const bytes = composePhysicalCapture(sources, activeDisplay?.id, nativeImage);
        return { mimeType: "image/jpeg", dataBase64: bytes.toString("base64") };
      },
      approveConnection: async ({ signal, botId, botLabel, taskLabel, sessionId }) => {
        const options = physicalApprovalDialogOptions({
          deviceName,
          botId,
          botLabel,
          taskLabel,
          sessionId,
          signal,
        });
        const result = mainWindow && !mainWindow.isDestroyed()
          ? await dialog.showMessageBox(mainWindow, options)
          : await dialog.showMessageBox(options);
        return result.response === 2 ? "always" : result.response === 1 ? "once" : false;
      },
    }).catch((error) => {
      console.error("[physical-bridge] start failed:", error?.message ?? error);
      return null;
    });
  }
  // Reconcile incomplete setup and resume interrupted sign-out only after the
  // local app is usable. This background network work never gates LAN pairing
  // or the first window.
  if (!REMOTE_SERVER_URL) void hostedAccount.restore().catch(() => {});
  // Registration is optional network work. Start it only after the local
  // server and first window are usable, then update the server child over its
  // private parent port so Connected Apps becomes available without restart.
  // Registering while the store is unreadable would mint a SECOND installation
  // identity for a user who already has one — the first thing they would
  // notice is every connected app gone, permanently.
  if (credentialStoreUnavailable) {
    slog("skipping connected-apps registration: the credential store was unreadable this launch");
  }
  if (app.isPackaged && !REMOTE_SERVER_URL && composioBrokerUrl() && !credentialStoreUnavailable) {
    void updateSecureCredentialDocument(async (credentials) => {
      await ensureManagedComposioCredentials({
        brokerUrl: composioBrokerUrl(),
        credentials,
        // The shared credential state performs the one atomic encrypted
        // write after this registration has derived its complete document.
        saveCredentials: async () => {},
        log: slog,
      });
      return credentials;
    }).finally(syncManagedComposioCredentials);
  }
  // in-app auto-update (packaged only) — checks GitHub releases, downloads on
  // the user's click, installs on "Restart to update"
  if (shouldStartUpdater({ packaged: app.isPackaged, remotePackage: IS_REMOTE_PACKAGE, platform: process.platform })) {
    startUpdater(win);
  }
  app.on("activate", () => {
    showMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// EMBEDDING.md lifecycle rule: defer the first quit until embedded children
// finish their own shutdown. CUA/bridge cleanup keeps its short bound, while
// the harness server gets a separate budget long enough to run its verified
// provider drain. The CUA timeout must never cut that server drain short.
let signalQuitRequested = false;

// Package managers, desktop watchdogs, and terminal launchers commonly stop
// Linux apps with SIGTERM/SIGINT. Convert the first signal into Electron's
// normal quit path so the embedded server, Cua descriptor/socket, and private
// AppImage stage receive the same bounded cleanup as a window close. A second
// signal keeps Node's default force-quit behavior because these are `once`
// listeners.
const requestSignalQuit = () => {
  if (signalQuitRequested) return;
  signalQuitRequested = true;
  app.quit();
};
process.once("SIGINT", requestSignalQuit);
process.once("SIGTERM", requestSignalQuit);

app.on("before-quit", (e) => {
  windowBackgroundPolicy.requestQuit();
  if (quitCleanupFinished) return;
  e.preventDefault();
  if (quitCleanup) return;
  // Release the sleep blocker synchronously; child shutdown is awaited below.
  syncCompanionKeepAwake(false, false);
  // a live dictation session runs its own helper child that holds the mic —
  // stop it here so quitting never orphans a recording process
  if (nativeActions.appleSpeech) stopSpeech();
  stopRecorder();
  quitCleanup = runQuitLifecycle({
    serverProcess: serverProc,
    serverExit,
    serverTimeoutMs: DEFAULT_SERVER_SHUTDOWN_TIMEOUT_MS,
    auxiliaryTimeoutMs: DEFAULT_AUXILIARY_CLEANUP_TIMEOUT_MS,
    stopAuxiliaries: () => Promise.allSettled([
      Promise.resolve().then(async () => {
        await remotePhysicalBridge?.stop();
        await REMOTE_SSH_CONNECTOR?.stop();
        await stopCua();
      }),
      // Both listeners reachable from outside the app are owned children.
      // Shut the connector down first, then the sidecar, without changing the
      // remembered toggle the next launch will restore.
      Promise.resolve().then(() => stopDesktopCompanion({ remember: false })),
    ]),
  });
  void quitCleanup.then((result) => {
    if (result.auxiliaries.status === "timeout") {
      slog(`auxiliary cleanup exceeded ${DEFAULT_AUXILIARY_CLEANUP_TIMEOUT_MS}ms`);
    } else if (result.auxiliaries.status === "rejected") {
      slog(`auxiliary cleanup failed: ${result.auxiliaries.error?.message ?? result.auxiliaries.error}`);
    } else {
      const failures = (result.auxiliaries.value ?? [])
        .filter((entry) => entry.status === "rejected")
        .map((entry) => entry.reason?.message ?? String(entry.reason));
      if (failures.length) slog(`auxiliary cleanup failures: ${failures.join("; ")}`);
    }

    quitCleanupFinished = true;
    if (result.ok) {
      app.quit();
      return;
    }

    const detail = result.server.status === "timeout"
      ? `embedded server did not exit within ${DEFAULT_SERVER_SHUTDOWN_TIMEOUT_MS}ms`
      : result.server.status === "abnormal-exit"
        ? `embedded server exited abnormally with code ${result.server.code ?? "unknown"}`
        : `embedded server shutdown failed (${result.server.status})`;
    slog(detail);
    console.error(`[quit] ${detail}`);
    // A non-zero desktop exit is observable to launchd/systemd/updaters and
    // must not be confused with the server's clean, verified shutdown path.
    process.exitCode = 1;
    try {
      serverProc?.kill();
    } catch {}
    app.exit(1);
  }, (error) => {
    quitCleanupFinished = true;
    const detail = `embedded shutdown coordinator failed: ${error?.message ?? error}`;
    slog(detail);
    console.error(`[quit] ${detail}`);
    process.exitCode = 1;
    app.exit(1);
  });
});
