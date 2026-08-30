import { NATIVE_HOST_NAME } from "./protocol.js";
import { createSecurityKeyProxyController } from "./proxy-controller.js";

const RECONNECT_DELAY_MS = 1_000;
let controller;
let reconnectTimer;

function connectBroker() {
  clearTimeout(reconnectTimer);
  if (controller) return;
  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch {
    scheduleReconnect();
    return;
  }
  controller = createSecurityKeyProxyController({
    chromeApi: chrome,
    port,
    onClosed() {
      controller = undefined;
      scheduleReconnect();
    },
  });
  controller.start();
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectBroker, RECONNECT_DELAY_MS);
}

// This native signal wakes a suspended MV3 worker when the managed broker changes state.
chrome.webAuthenticationProxy.onRemoteSessionStateChange?.addListener(() => {
  controller?.stop();
  controller = undefined;
  connectBroker();
});

chrome.runtime.onSuspend.addListener(() => {
  controller?.stop();
  controller = undefined;
  clearTimeout(reconnectTimer);
});

connectBroker();
