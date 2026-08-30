// URL boundary for the in-app desktop viewer. Cloud viewers must use HTTPS;
// the one HTTP exception is the passworded noVNC server bound to loopback by
// OpenMausBot's Local VM.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "openmaus-viewer.localhost"]);
const TRUSTED_HOSTED_VIEWER_SUFFIXES = ["ascii.dev"];

function trustedHostedViewerHostname(hostname) {
  const value = hostname.toLowerCase().replace(/\.$/, "");
  return TRUSTED_HOSTED_VIEWER_SUFFIXES.some((suffix) => value === suffix || value.endsWith(`.${suffix}`));
}

function desktopViewerUrl(rawUrl) {
  if (Object.prototype.toString.call(rawUrl) !== "[object String]" || !rawUrl.trim()) {
    throw new Error("A desktop viewer address is required");
  }
  if (rawUrl.length > 16_384) throw new Error("The desktop viewer address is too long");

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("The desktop viewer address is invalid");
  }

  const localHttp = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("The desktop viewer must use HTTPS or the local VM address");
  }
  if (url.username || url.password) {
    throw new Error("Desktop viewer credentials must not use URL user info");
  }
  if (!localHttp && !trustedHostedViewerHostname(url.hostname)) {
    throw new Error("The hosted desktop viewer is not from the configured Box provider");
  }
  return url;
}

function sameDesktopViewerOrigin(rawUrl, origin) {
  try {
    return desktopViewerUrl(rawUrl).origin === origin;
  } catch {
    return false;
  }
}

/** Provider-controlled viewer content never gets to launch an external
 * browser window. Main-frame navigation is confined to the viewer's original
 * authority; everything else is denied in place. */
function desktopViewerNavigationAllowed(rawViewerUrl, rawTargetUrl, newWindow = false) {
  if (newWindow) return false;
  let viewer;
  try {
    viewer = rawViewerUrl instanceof URL ? rawViewerUrl : desktopViewerUrl(rawViewerUrl);
  } catch {
    return false;
  }
  return sameDesktopViewerOrigin(rawTargetUrl, viewer.origin);
}

/**
 * Bind every main-frame navigation phase to the viewer's original origin.
 * `will-navigate` does not cover HTTP redirects, and a late process/network
 * race can still commit before a preventative event is observed, so final
 * did-navigate events are checked too. Any uncertainty destroys the authority
 * window instead of leaving a redirected page holding keyboard/mouse control.
 */
function bindDesktopViewerNavigation(webContents, rawViewerUrl, requestClose) {
  let active = true;
  let closeRequested = false;
  const closeOnce = () => {
    if (!active || closeRequested) return;
    closeRequested = true;
    requestClose();
  };
  const allowed = (target) => desktopViewerNavigationAllowed(rawViewerUrl, target);
  const onWillNavigate = (event, target) => {
    if (allowed(target)) return;
    event?.preventDefault?.();
    closeOnce();
  };
  const onWillRedirect = (event, target, _isInPlace, isMainFrame) => {
    if (isMainFrame === false || allowed(target)) return;
    event?.preventDefault?.();
    closeOnce();
  };
  const onDidNavigate = (_event, target) => {
    if (!allowed(target)) closeOnce();
  };
  const onDidFrameNavigate = (_event, target, _statusCode, _statusText, isMainFrame) => {
    if (isMainFrame !== false && !allowed(target)) closeOnce();
  };
  webContents.on("will-navigate", onWillNavigate);
  webContents.on("will-redirect", onWillRedirect);
  webContents.on("did-navigate", onDidNavigate);
  webContents.on("did-frame-navigate", onDidFrameNavigate);
  return () => {
    if (!active) return;
    active = false;
    webContents.removeListener("will-navigate", onWillNavigate);
    webContents.removeListener("will-redirect", onWillRedirect);
    webContents.removeListener("did-navigate", onDidNavigate);
    webContents.removeListener("did-frame-navigate", onDidFrameNavigate);
  };
}

/** Electron navigation errors often echo the complete failed URL. Viewer
 * URLs contain path tokens and noVNC fragment passwords, so diagnostics may
 * retain only a numeric Chromium error code and never the error message. */
function desktopViewerLoadFailureLabel(error) {
  const code = error && typeof error === "object" && Number.isInteger(error.code)
    ? ` (code ${error.code})`
    : "";
  return `[desktop-viewer] live desktop failed to load${code}`;
}

/** Local VM/VPS viewers use the bundled noVNC page. Loading its HTML is not
 * evidence that mouse/keyboard input can reach the target; the RFB websocket
 * must have reached noVNC's connected state first. Provider-hosted viewers
 * have their own page contracts and retain the normal main-frame proof. */
function desktopViewerNeedsRfbProof(rawUrl) {
  const url = rawUrl instanceof URL ? rawUrl : desktopViewerUrl(rawUrl);
  return LOOPBACK_HOSTS.has(url.hostname) && /(?:^|\/)vnc\.html$/i.test(url.pathname);
}

/** Keep bundled noVNC inside its tokenized viewer namespace. This is a second
 * boundary behind the server's viewer-only Host routing: even compromised
 * noVNC content cannot probe the normal app API, another loopback service, or
 * a different bot's viewer token from the Electron session. Hosted HTTPS
 * viewers may load HTTPS/WSS dependencies, but never privileged/local schemes
 * or insecure HTTP subresources. */
function desktopViewerRequestAllowed(rawViewerUrl, rawRequestUrl) {
  const viewer = rawViewerUrl instanceof URL ? rawViewerUrl : desktopViewerUrl(rawViewerUrl);
  let request;
  try {
    request = new URL(rawRequestUrl);
  } catch {
    return false;
  }
  if (request.username || request.password) return false;

  if (!desktopViewerNeedsRfbProof(viewer)) {
    if (request.protocol === "data:" || request.protocol === "blob:") return true;
    if (request.protocol !== "https:" && request.protocol !== "wss:") return false;
    // Hosted Box content is untrusted remote content. It may speak only to
    // the exact TLS authority that minted the viewer; arbitrary CDNs or DNS
    // names would reopen loopback/LAN reachability through rebinding.
    return request.host === viewer.host && trustedHostedViewerHostname(request.hostname);
  }

  const requestProtocols = viewer.protocol === "https:"
    ? new Set(["https:", "wss:"])
    : new Set(["http:", "ws:"]);
  if (!requestProtocols.has(request.protocol) || request.host !== viewer.host) return false;

  // The current remote-safe proxy has an exact bot/token namespace. A direct
  // 127.0.0.1/localhost noVNC port remains supported for same-machine legacy
  // development, but it is still confined to that one loopback authority.
  if (viewer.hostname !== "openmaus-viewer.localhost") return true;
  const match = viewer.pathname.match(
    /^(\/api\/bots\/[\w-]+\/local-computer\/viewer\/[A-Za-z0-9_-]{32,}\/)(?:vnc\.html)$/i,
  );
  return Boolean(match && request.pathname.startsWith(match[1]));
}

/** A live desktop is authority owned by one renderer document, not merely by
 * its reusable BrowserWindow/WebContents. Reloading the app creates a fresh
 * memory-only owner id, so the old viewer must close before that new document
 * can coexist with bot actions. */
function bindDesktopViewerToOwner(ownerWebContents, requestClose) {
  let active = true;
  let closeRequested = false;
  const closeOnce = () => {
    if (!active || closeRequested) return;
    closeRequested = true;
    requestClose();
  };
  const onNavigation = (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) closeOnce();
  };
  ownerWebContents.on("did-start-navigation", onNavigation);
  ownerWebContents.on("render-process-gone", closeOnce);
  ownerWebContents.on("destroyed", closeOnce);
  return () => {
    if (!active) return;
    active = false;
    ownerWebContents.removeListener("did-start-navigation", onNavigation);
    ownerWebContents.removeListener("render-process-gone", closeOnce);
    ownerWebContents.removeListener("destroyed", closeOnce);
  };
}

module.exports = {
  desktopViewerUrl,
  sameDesktopViewerOrigin,
  desktopViewerNavigationAllowed,
  bindDesktopViewerNavigation,
  desktopViewerLoadFailureLabel,
  desktopViewerNeedsRfbProof,
  desktopViewerRequestAllowed,
  trustedHostedViewerHostname,
  bindDesktopViewerToOwner,
};
