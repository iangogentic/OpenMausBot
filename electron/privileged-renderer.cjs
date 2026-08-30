"use strict";

const MAX_URL_LENGTH = 8_192;
const WEB_PROTOCOLS = new Set(["http:", "https:"]);
const DOCUMENT_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseWebUrl(rawUrl) {
  if (Object.prototype.toString.call(rawUrl) !== "[object String]" || rawUrl.length < 1 || rawUrl.length > MAX_URL_LENGTH) {
    return null;
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    !WEB_PROTOCOLS.has(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.origin === "null"
  ) {
    return null;
  }
  return url;
}

function normalizeRendererOrigin(rawUrl) {
  const url = parseWebUrl(rawUrl);
  if (!url) throw new Error("The OpenMausBot renderer origin must be an ordinary HTTP(S) address");
  return url.origin;
}

function exactRendererUrl(rawUrl, expectedOrigin) {
  const url = parseWebUrl(rawUrl);
  if (!url) return false;
  try {
    return url.origin === normalizeRendererOrigin(expectedOrigin);
  } catch {
    return false;
  }
}

function externalWebUrl(rawUrl) {
  return parseWebUrl(rawUrl)?.toString() ?? null;
}

function live(object) {
  try {
    return object.isDestroyed() === false;
  } catch {
    return false;
  }
}

function currentWebContentsUrl(webContents) {
  try {
    return webContents.getURL();
  } catch {
    return null;
  }
}

function frameIdentity(frame) {
  if (!frame || !Number.isInteger(frame.processId) || !Number.isInteger(frame.routingId)) {
    return null;
  }
  return { processId: frame.processId, routingId: frame.routingId };
}

function sameFrame(left, right) {
  const a = frameIdentity(left);
  const b = frameIdentity(right);
  return Boolean(a && b && a.processId === b.processId && a.routingId === b.routingId);
}

function createPrivilegedRendererController({ expectedOrigin, getMainWindow }) {
  const origin = normalizeRendererOrigin(expectedOrigin);

  let epoch = 0;
  let binding = null;

  function current(window) {
    return Boolean(
      binding &&
        binding.window === window &&
        getMainWindow() === window &&
        live(window) &&
        live(binding.webContents) &&
        window.webContents === binding.webContents,
    );
  }

  function attach(window) {
    if (!live(window) || !live(window.webContents)) {
      throw new Error("Cannot attach renderer authority to a destroyed window");
    }
    epoch += 1;
    binding = {
      documentToken: null,
      epoch,
      frame: null,
      navigationGeneration: 0,
      ready: false,
      webContents: window.webContents,
      window,
    };
    return binding.epoch;
  }

  function beginNavigation(window, rawUrl, { sameDocument = false } = {}) {
    if (!current(window) || !exactRendererUrl(rawUrl, origin)) return false;
    if (!sameDocument) {
      binding.navigationGeneration += 1;
      binding.documentToken = null;
      binding.ready = false;
      binding.frame = null;
    }
    return true;
  }

  function claim(event, documentToken) {
    const window = getMainWindow();
    if (
      !current(window) ||
      binding.navigationGeneration < 1 ||
      !DOCUMENT_TOKEN_PATTERN.test(documentToken)
    ) {
      throw new Error("Renderer document claim rejected");
    }
    const webContents = binding.webContents;
    const eventFrame = event?.senderFrame;
    const frame = frameIdentity(webContents.mainFrame);
    if (
      event?.sender !== webContents ||
      !frame ||
      !sameFrame(eventFrame, frame) ||
      !exactRendererUrl(eventFrame?.url, origin) ||
      !exactRendererUrl(currentWebContentsUrl(webContents), origin)
    ) {
      throw new Error("Renderer document claim rejected");
    }
    binding.documentToken = documentToken;
    binding.ready = true;
    binding.frame = frame;
    return true;
  }

  function revoke(window) {
    if (!binding || (window && binding.window !== window)) return false;
    binding.documentToken = null;
    binding.ready = false;
    binding.frame = null;
    epoch += 1;
    binding.epoch = epoch;
    return true;
  }

  function authorize(event, documentToken) {
    const window = getMainWindow();
    if (
      !current(window) ||
      !binding.ready ||
      documentToken !== binding.documentToken
    ) {
      throw new Error("Privileged renderer action rejected");
    }
    const webContents = binding.webContents;
    const eventFrame = event?.senderFrame;
    const mainFrame = webContents.mainFrame;
    if (
      event?.sender !== webContents ||
      !sameFrame(eventFrame, mainFrame) ||
      !sameFrame(eventFrame, binding.frame) ||
      !exactRendererUrl(eventFrame?.url, origin) ||
      !exactRendererUrl(currentWebContentsUrl(webContents), origin)
    ) {
      throw new Error("Privileged renderer action rejected");
    }
    return Object.freeze({
      epoch: binding.epoch,
      documentToken: binding.documentToken,
      frame: { ...binding.frame },
      navigationGeneration: binding.navigationGeneration,
      webContents,
      window,
    });
  }

  function assertProof(proof) {
    if (
      !proof ||
      !current(proof.window) ||
      !binding.ready ||
      proof.webContents !== binding.webContents ||
      proof.epoch !== binding.epoch ||
      proof.documentToken !== binding.documentToken ||
      proof.navigationGeneration !== binding.navigationGeneration ||
      !sameFrame(proof.frame, binding.frame) ||
      !sameFrame(binding.webContents.mainFrame, binding.frame) ||
      !exactRendererUrl(currentWebContentsUrl(binding.webContents), origin)
    ) {
      throw new Error("Privileged renderer action expired");
    }
    return true;
  }

  return {
    assertProof,
    attach,
    authorize,
    beginNavigation,
    claim,
    expectedOrigin: origin,
    revoke,
  };
}

function bindPrivilegedRendererNavigation({ controller, window, onBlockedProgrammaticNavigation }) {
  if (!controller || !window?.webContents) throw new TypeError("A renderer controller and window are required");
  const webContents = window.webContents;
  const listeners = [];
  const listen = (target, event, handler) => {
    target.on(event, handler);
    listeners.push(() => target.removeListener(event, handler));
  };

  controller.attach(window);

  // Page-initiated main-frame navigation is preventable before the privileged
  // preload could ever be transferred to a different origin.
  listen(webContents, "will-frame-navigate", (event) => {
    if (!event?.isMainFrame || exactRendererUrl(event.url, controller.expectedOrigin)) return;
    event.preventDefault();
  });

  // Server redirects are a distinct navigation path and must be rejected at
  // the redirect boundary, including a same-origin URL that redirects away.
  listen(webContents, "will-redirect", (event) => {
    if (!event?.isMainFrame || exactRendererUrl(event.url, controller.expectedOrigin)) return;
    event.preventDefault();
  });

  // Electron intentionally omits will-navigate/will-frame-navigate for
  // webContents.loadURL/back/forward. did-start-navigation is the fail-closed
  // backstop for those programmatic paths.
  listen(webContents, "did-start-navigation", (event) => {
    if (!event?.isMainFrame) return;
    if (controller.beginNavigation(window, event.url, { sameDocument: event.isSameDocument })) return;
    controller.revoke(window);
    onBlockedProgrammaticNavigation?.(event.url);
  });

  listen(webContents, "render-process-gone", () => controller.revoke(window));
  listen(webContents, "destroyed", () => controller.revoke(window));
  listen(window, "closed", () => controller.revoke(window));

  return () => {
    for (const remove of listeners.splice(0)) remove();
    controller.revoke(window);
  };
}

module.exports = {
  bindPrivilegedRendererNavigation,
  createPrivilegedRendererController,
  exactRendererUrl,
  externalWebUrl,
  normalizeRendererOrigin,
};
