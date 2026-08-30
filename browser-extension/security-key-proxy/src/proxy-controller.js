import {
  HANDSHAKE_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  LIVENESS_TIMEOUT_MS,
  makeCancel,
  makeHeartbeat,
  makeHello,
  makeRequest,
  parseBrokerMessage,
} from "./protocol.js";

const ERROR_DETAILS = Object.freeze({
  "not-allowed": { name: "NotAllowedError", message: "The security-key request was not allowed." },
  "invalid-state": { name: "InvalidStateError", message: "The security-key request is not valid in the current state." },
  "not-supported": { name: "NotSupportedError", message: "The requested security-key operation is not supported." },
  aborted: { name: "AbortError", message: "The security-key request was aborted." },
  timeout: { name: "NotAllowedError", message: "The security-key request timed out." },
  internal: { name: "UnknownError", message: "The security-key request could not be completed." },
});

export function createSecurityKeyProxyController(options) {
  const chromeApi = options.chromeApi;
  const proxy = chromeApi.webAuthenticationProxy;
  const port = options.port;
  const randomId = options.randomId ?? secureRandomId;
  const now = options.now ?? Date.now;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const onClosed = options.onClosed ?? (() => {});
  const pending = new Map();

  let nonce;
  let sessionId;
  let started = false;
  let ready = false;
  let attaching = false;
  let attached = false;
  let detachIssued = false;
  let closed = false;
  let closeReported = false;
  let connectionGeneration = 0;
  let lastBrokerHeartbeat = 0;
  let lastBrokerHeartbeatSequence = -1;
  let heartbeatSequence = 0;
  let handshakeTimer;
  let heartbeatTimer;
  let livenessTimer;

  function start() {
    if (started) return;
    started = true;
    nonce = randomId();
    connectionGeneration += 1;
    port.onMessage.addListener(onBrokerMessage);
    port.onDisconnect.addListener(onPortDisconnect);
    proxy.onCreateRequest.addListener(onCreateRequest);
    proxy.onGetRequest.addListener(onGetRequest);
    proxy.onIsUvpaaRequest.addListener(onIsUvpaaRequest);
    proxy.onRequestCanceled.addListener(onRequestCanceled);
    try {
      port.postMessage(makeHello(chromeApi.runtime.id, nonce));
    } catch {
      failClosed();
      return;
    }
    handshakeTimer = setTimeoutFn(failClosed, HANDSHAKE_TIMEOUT_MS);
  }

  function stop() {
    failClosed();
  }

  // Chrome requires these listeners to take ownership synchronously. Do not make them async.
  function onCreateRequest(requestInfo) {
    acceptChromeRequest("create", requestInfo);
  }

  function onGetRequest(requestInfo) {
    acceptChromeRequest("get", requestInfo);
  }

  function onIsUvpaaRequest(requestInfo) {
    acceptChromeRequest("isUvpaa", requestInfo);
  }

  function acceptChromeRequest(kind, requestInfo) {
    const requestId = requestInfo?.requestId;
    if (!ready || !attached || closed || pending.has(requestId)) {
      completeError(kind, requestId, "internal");
      return;
    }
    const ceremonyId = randomId();
    const entry = { ceremonyId, requestId, kind, completed: false };
    pending.set(requestId, entry);
    try {
      port.postMessage(makeRequest({
        sessionId,
        ceremonyId,
        chromeRequestId: requestId,
        kind,
        requestDetailsJson: requestInfo?.requestDetailsJson,
      }));
    } catch {
      pending.delete(requestId);
      entry.completed = true;
      completeError(kind, requestId, "internal");
    }
  }

  function onRequestCanceled(requestId) {
    const entry = pending.get(requestId);
    if (!entry || entry.completed || entry.kind === "isUvpaa") return;
    entry.completed = true;
    pending.delete(requestId);
    try {
      port.postMessage(makeCancel({
        sessionId,
        ceremonyId: entry.ceremonyId,
        chromeRequestId: requestId,
      }));
    } catch {
      failClosed();
    }
  }

  function onBrokerMessage(untrustedMessage) {
    let message;
    try {
      message = parseBrokerMessage(untrustedMessage);
    } catch {
      failClosed();
      return;
    }
    if (message.type === "broker.ready") {
      if (ready || message.nonce !== nonce || closed) {
        failClosed();
        return;
      }
      clearTimeoutFn(handshakeTimer);
      sessionId = message.sessionId;
      ready = true;
      lastBrokerHeartbeat = now();
      startHeartbeatTimers();
      attachProxy();
      return;
    }
    if (!ready || message.sessionId !== sessionId || closed) {
      failClosed();
      return;
    }
    if (message.type === "broker.heartbeat") {
      if (message.sequence <= lastBrokerHeartbeatSequence) {
        failClosed();
        return;
      }
      lastBrokerHeartbeatSequence = message.sequence;
      lastBrokerHeartbeat = now();
      return;
    }
    if (message.type === "broker.detach") {
      failClosed();
      return;
    }
    const entry = pending.get(message.chromeRequestId);
    if (!entry || entry.completed || entry.ceremonyId !== message.ceremonyId) return;
    if (message.type === "broker.uvpaa") {
      if (entry.kind !== "isUvpaa") {
        failClosed();
        return;
      }
      finishEntry(entry, () => proxy.completeIsUvpaaRequest({ requestId: entry.requestId, isUvpaa: message.isUvpaa }));
      return;
    }
    if (message.kind !== entry.kind) {
      failClosed();
      return;
    }
    if (message.type === "broker.error") {
      finishEntry(entry, () => completeError(entry.kind, entry.requestId, message.code));
      return;
    }
    if (message.type === "broker.result") {
      finishEntry(entry, () => completeSuccess(entry.kind, entry.requestId, message.responseJson));
    }
  }

  function attachProxy() {
    const generation = connectionGeneration;
    attaching = true;
    Promise.resolve(proxy.attach()).then(() => {
      attaching = false;
      if (closed || generation !== connectionGeneration || !ready) {
        detachProxyOnce();
        return;
      }
      attached = true;
    }, () => {
      attaching = false;
      failClosed();
    });
  }

  function startHeartbeatTimers() {
    heartbeatTimer = setIntervalFn(() => {
      if (!ready || closed) return;
      try {
        port.postMessage(makeHeartbeat(sessionId, heartbeatSequence, now()));
        heartbeatSequence += 1;
      } catch {
        failClosed();
      }
    }, HEARTBEAT_INTERVAL_MS);
    livenessTimer = setIntervalFn(() => {
      if (ready && now() - lastBrokerHeartbeat > LIVENESS_TIMEOUT_MS) failClosed();
    }, HEARTBEAT_INTERVAL_MS);
  }

  function onPortDisconnect() {
    // Reading lastError acknowledges Chrome's expected native-host disconnect error without logging it.
    void chromeApi.runtime.lastError;
    failClosed();
  }

  function failClosed() {
    if (closed) return;
    closed = true;
    connectionGeneration += 1;
    ready = false;
    clearTimeoutFn(handshakeTimer);
    clearIntervalFn(heartbeatTimer);
    clearIntervalFn(livenessTimer);
    for (const entry of pending.values()) {
      if (entry.completed) continue;
      entry.completed = true;
      completeError(entry.kind, entry.requestId, "not-allowed");
    }
    pending.clear();
    // Invoke detach in the same turn as broker loss; never wait for a network or timer boundary.
    if (attached || attaching) detachProxyOnce();
    attached = false;
    attaching = false;
    removeListeners();
    try {
      port.disconnect();
    } catch {
      // A native port can already be closed; there is no ceremony data to report.
    }
    if (!closeReported) {
      closeReported = true;
      onClosed();
    }
  }

  function removeListeners() {
    port.onMessage.removeListener(onBrokerMessage);
    port.onDisconnect.removeListener(onPortDisconnect);
    proxy.onCreateRequest.removeListener(onCreateRequest);
    proxy.onGetRequest.removeListener(onGetRequest);
    proxy.onIsUvpaaRequest.removeListener(onIsUvpaaRequest);
    proxy.onRequestCanceled.removeListener(onRequestCanceled);
  }

  function detachProxyOnce() {
    if (detachIssued) return;
    detachIssued = true;
    voidPromise(proxy.detach());
  }

  function finishEntry(entry, operation) {
    if (entry.completed) return;
    entry.completed = true;
    pending.delete(entry.requestId);
    try {
      voidPromise(operation());
    } catch {
      // Chrome rejects stale completions itself; the request is still dispatched exactly once.
    }
  }

  function completeSuccess(kind, requestId, responseJson) {
    if (kind === "create") return proxy.completeCreateRequest({ requestId, responseJson });
    if (kind === "get") return proxy.completeGetRequest({ requestId, responseJson });
    throw new Error("UVPAA does not accept credential JSON");
  }

  function completeError(kind, requestId, code) {
    const error = ERROR_DETAILS[code] ?? ERROR_DETAILS.internal;
    if (kind === "create") return proxy.completeCreateRequest({ requestId, error });
    if (kind === "get") return proxy.completeGetRequest({ requestId, error });
    return proxy.completeIsUvpaaRequest({ requestId, isUvpaa: false });
  }

  return { start, stop };
}

function secureRandomId() {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function voidPromise(value) {
  Promise.resolve(value).catch(() => {});
}
