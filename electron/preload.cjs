// Renderer bridge. contextIsolation stays on; the renderer only ever sees
// this narrow surface (window.ogb), never Node or ipcRenderer itself.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

// A fresh token is created inside the isolated preload world for every
// document, including same-origin reloads that reuse the same WebContents and
// frame routing IDs. The page never sees it; every outbound bridge call adds
// it automatically and main rejects tokens from an earlier document.
const rendererDocumentToken = globalThis.crypto.randomUUID();
let rendererDocumentClaimed =
  ipcRenderer.sendSync("desktop:claim-renderer-document", rendererDocumentToken) === true;

// BrowserWindow creates an initial about:blank document before createWindow
// can bind its origin controller. Expose the narrow API, but keep it powerless
// until the first call from the loaded trusted document can claim authority.
// The main process validates the final frame, origin, window and navigation
// generation before it accepts the claim or any action.
const ensureRendererDocumentClaimed = () => {
  if (rendererDocumentClaimed) return true;
  rendererDocumentClaimed =
    ipcRenderer.sendSync("desktop:claim-renderer-document", rendererDocumentToken) === true;
  return rendererDocumentClaimed;
};
let rendererClaimPromise = null;
const waitForRendererDocumentClaim = () => {
  if (ensureRendererDocumentClaimed()) return Promise.resolve();
  if (rendererClaimPromise) return rendererClaimPromise;
  rendererClaimPromise = new Promise((resolve, reject) => {
    let attempts = 0;
    const retry = async () => {
      rendererDocumentClaimed =
        await ipcRenderer.invoke("desktop:claim-renderer-document-async", rendererDocumentToken) === true;
      if (rendererDocumentClaimed) {
        rendererClaimPromise = null;
        resolve();
        return;
      }
      attempts += 1;
      if (attempts >= 20) {
        rendererClaimPromise = null;
        reject(new Error("The OpenMausBot renderer document could not claim its desktop bridge"));
        return;
      }
      setTimeout(() => void retry(), 25);
    };
    setTimeout(() => void retry(), 0);
  });
  return rendererClaimPromise;
};
const invokePrivileged = (channel, ...args) =>
  waitForRendererDocumentClaim().then(() =>
    ipcRenderer.invoke(channel, rendererDocumentToken, ...args));
const sendPrivileged = (channel, ...args) => {
  void waitForRendererDocumentClaim()
    .then(() => ipcRenderer.send(channel, rendererDocumentToken, ...args))
    .catch(() => {});
};
const sendPrivilegedSync = (channel, ...args) => {
  if (!ensureRendererDocumentClaimed()) return false;
  return ipcRenderer.sendSync(channel, rendererDocumentToken, ...args);
};

let pendingPackageInstallUrl = null;
const packageInstallListeners = new Set();
ipcRenderer.on("package:install", (_event, url) => {
  if (typeof url !== "string") return;
  pendingPackageInstallUrl = url;
  for (const listener of packageInstallListeners) listener(url);
});

contextBridge.exposeInMainWorld("ogb", {
  /** Host platform ("darwin" | "win32" | "linux") — for platform-aware UI. */
  platform: process.platform,
  /** Whether this shell owns an embedded harness or controls an existing one. */
  connection: () => invokePrivileged("desktop:connection"),
  getCapabilities: () => invokePrivileged("desktop:capabilities"),
  onCapabilitiesChanged: (cb) => {
    const handler = (_event, capabilities) => cb(capabilities);
    ipcRenderer.on("desktop:capabilities-changed", handler);
    return () => ipcRenderer.removeListener("desktop:capabilities-changed", handler);
  },
  /** The companion sidecar: the one part of this app that listens off the
   * machine, so it runs as its own process and is off until switched on.
   * Every call answers with the whole state, so the panel never has to
   * stitch two round-trips together. */
  companion: {
    state: () => invokePrivileged("companion:state"),
    start: () => invokePrivileged("companion:start"),
    stop: () => invokePrivileged("companion:stop"),
    keepAwake: (enabled) => invokePrivileged("companion:keep-awake", enabled),
    pairing: (open, expectedToken) => invokePrivileged("companion:pairing", open, expectedToken),
    cloudDesktop: (deviceId, allowed) => invokePrivileged("companion:cloud-desktop", deviceId, allowed),
    revoke: (deviceId) => invokePrivileged("companion:revoke", deviceId),
  },
  /** Optional account-backed HTTPS access for Companion. Secrets stay in the
   * main process; the renderer sees only status and narrow user actions. */
  companionAccount: {
    state: () => invokePrivileged("companion-account:state"),
    requestCode: (email) => invokePrivileged("companion-account:request-code", email),
    verifyCode: (email, code) => invokePrivileged("companion-account:verify-code", email, code),
    retry: () => invokePrivileged("companion-account:retry"),
    signOut: () => invokePrivileged("companion-account:sign-out"),
  },
  localControl: {
    status: () => invokePrivileged("cua:linux-status"),
    enable: () => invokePrivileged("cua:linux-enable"),
    disable: () => invokePrivileged("cua:linux-disable"),
    retry: () => invokePrivileged("cua:linux-retry"),
  },
  /** Arms exactly one display-media request from the current renderer frame. */
  beginScreenPreviewIntent: () => sendPrivilegedSync("screen:preview-intent"),
  /** One frame of this computer's screen as a data: URL when supported. */
  screenFrame: () => invokePrivileged("screen:frame"),
  /** Physical USB Android devices. Network ADB is deliberately excluded. */
  androidDevice: {
    status: () => invokePrivileged("android-device:status"),
    frame: (serial) => invokePrivileged("android-device:frame", serial),
    input: (serial, payload) =>
      invokePrivileged("android-device:input", serial, payload).then(() => undefined),
  },
  speechStart: (options) => invokePrivileged("speech:start", options),
  speechStop: () => invokePrivileged("speech:stop"),
  speechFinish: () => invokePrivileged("speech:finish"),
  onSpeechTranscript: (cb) => {
    const handler = (_event, line) => cb(line);
    ipcRenderer.on("speech:transcript", handler);
    return () => ipcRenderer.removeListener("speech:transcript", handler);
  },
  onSpeechEnd: (cb) => {
    const handler = (_event, info) => cb(info);
    ipcRenderer.on("speech:end", handler);
    return () => ipcRenderer.removeListener("speech:end", handler);
  },
  /** A local-first demonstration recorder. Global events stay in main; the
   * renderer receives only the privacy-filtered event stream. */
  skillRecorder: {
    permissions: () => invokePrivileged("skill-recorder:permissions"),
    start: () => invokePrivileged("skill-recorder:start"),
    stop: () => invokePrivileged("skill-recorder:stop"),
    save: (payload) => invokePrivileged("skill-recorder:save", payload),
    onEvent: (cb) => {
      const handler = (_event, value) => cb(value);
      ipcRenderer.on("skill-recorder:event", handler);
      return () => ipcRenderer.removeListener("skill-recorder:event", handler);
    },
    onEnd: (cb) => {
      const handler = (_event, value) => cb(value);
      ipcRenderer.on("skill-recorder:end", handler);
      return () => ipcRenderer.removeListener("skill-recorder:end", handler);
    },
  },
  transcription: {
    status: () => invokePrivileged("assemblyai:status"),
    setKey: (value) => invokePrivileged("assemblyai:set-key", value),
    streamingToken: () => invokePrivileged("assemblyai:streaming-token"),
  },
  /** Absolute path of a dropped File — Electron 32 removed File.path, and
   * only the preload can ask. "" when the drag carried no file on disk. */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  /** {mic} TCC status strings: granted|denied|not-determined|unknown.
   * No screen field — macOS 15+ caches that status per-process, so any
   * value here would lie for the whole session after a grant. */
  permStatus: () => invokePrivileged("perm:status"),
  /** Triggers the macOS microphone prompt; resolves true when granted. */
  permRequestMic: () => invokePrivileged("perm:request-mic"),
  /** Opens System Settings on the given privacy pane: mic|screen|speech. */
  permOpenSettings: (pane) => invokePrivileged("perm:open-settings", pane),

  /** Copies an engine install command and opens a blank terminal. Resolves
   * false if no terminal could be launched; the clipboard still has it. */
  openInstallTerminal: (command) => invokePrivileged("engine:open-terminal", command),
  /** Open a web link in the default browser. Unlike renderer window.open,
   * this remains reliable after an asynchronous API request. */
  openExternal: (url) => invokePrivileged("desktop:open-external", url),
  /** A reviewed BotMRR package opened through openmausbot://install. */
  onPackageInstall: (cb) => {
    packageInstallListeners.add(cb);
    if (pendingPackageInstallUrl) cb(pendingPackageInstallUrl);
    return () => packageInstallListeners.delete(cb);
  },
  /** Mirrors durable unread state into the native Dock/taskbar badge. */
  setUnreadCount: (count) => sendPrivileged("desktop:unread-count", count),
  /** Live VNC/noVNC in a sandboxed window owned by the app window. */
  desktopViewer: {
    open: (url, title, contextId) => invokePrivileged("desktop-viewer:open", url, title, contextId),
    close: (contextId) => invokePrivileged("desktop-viewer:close", contextId),
    currentState: (contextId) => invokePrivileged("desktop-viewer:state-now", contextId),
    currentStates: () => invokePrivileged("desktop-viewer:states-now"),
    onState: (cb) => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("desktop-viewer:state", handler);
      return () => ipcRenderer.removeListener("desktop-viewer:state", handler);
    },
  },
  /** Native folder picker for a bot's working folder; null when cancelled. */
  pickFolder: (current) => invokePrivileged("desktop:pick-folder", current),
  /** Writes the redacted diagnostics report to a user-chosen file; resolves
   * the path, or null when the save dialog was cancelled. */
  exportDiagnostics: () => invokePrivileged("desktop:export-diagnostics"),
  /** Ask where to save a bot-created file (inside ~/.openmausbot), copy it
   * there and reveal it. Returns the chosen path, or null if the user
   * cancelled the dialog. The chat bubble shows the
   * rejection text verbatim, so strip the "Error invoking remote method"
   * wrapper ipcRenderer adds around a main-process throw. */
  saveFile: (filePath) =>
    invokePrivileged("desktop:save-file", filePath).catch((error) => {
      const message = String(error?.message ?? error);
      throw new Error(message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ""));
    }),
  /** Store a provider credential with OS-backed encryption. */
  setCredential: (name, value) => invokePrivileged("credential:set", name, value),

  /** In-app auto-update. State object:
   *  { status: "idle"|"checking"|"available"|"downloading"|"downloaded"|"error",
   *    version?, percent?, message? }. onState fires immediately with the
   *    current state, then on every transition. Dormant in dev (no bridge). */
  updater: {
    check: () => invokePrivileged("update:check"),
    download: () => invokePrivileged("update:download"),
    install: () => invokePrivileged("update:install"),
    onState: (cb) => {
      invokePrivileged("update:get-state")
        .then((s) => cb(s))
        .catch(() => {});
      const handler = (_event, s) => cb(s);
      ipcRenderer.on("update:state", handler);
      return () => ipcRenderer.removeListener("update:state", handler);
    },
  },
});
