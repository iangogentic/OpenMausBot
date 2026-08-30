import assert from "node:assert/strict";
import test from "node:test";
import { createSecurityKeyProxyController } from "../src/proxy-controller.js";

class FakeEvent {
  listeners = new Set();
  addListener(listener) { this.listeners.add(listener); }
  removeListener(listener) { this.listeners.delete(listener); }
  emit(value) { for (const listener of this.listeners) listener(value); }
}

function fixture() {
  const events = {
    create: new FakeEvent(), get: new FakeEvent(), uvpaa: new FakeEvent(), cancel: new FakeEvent(),
    message: new FakeEvent(), disconnect: new FakeEvent(),
  };
  const calls = { attach: 0, detach: 0, create: [], get: [], uvpaa: [] };
  const sent = [];
  const port = {
    onMessage: events.message,
    onDisconnect: events.disconnect,
    postMessage(message) { sent.push(message); },
    disconnect() {},
  };
  const proxy = {
    onCreateRequest: events.create,
    onGetRequest: events.get,
    onIsUvpaaRequest: events.uvpaa,
    onRequestCanceled: events.cancel,
    attach() { calls.attach += 1; return Promise.resolve(); },
    detach() { calls.detach += 1; return Promise.resolve(); },
    completeCreateRequest(details) { calls.create.push(details); return Promise.resolve(); },
    completeGetRequest(details) { calls.get.push(details); return Promise.resolve(); },
    completeIsUvpaaRequest(details) { calls.uvpaa.push(details); return Promise.resolve(); },
  };
  let id = 0;
  const timers = new Map();
  const chromeApi = { runtime: { id: "iaopmdekcnajdahgiacemakfgdlihime", lastError: undefined }, webAuthenticationProxy: proxy };
  const controller = createSecurityKeyProxyController({
    chromeApi,
    port,
    randomId: () => `identifier_${String(++id).padStart(16, "0")}`,
    setTimeoutFn: (fn) => { const key = Symbol(); timers.set(key, fn); return key; },
    clearTimeoutFn: (key) => timers.delete(key),
    setIntervalFn: (fn) => { const key = Symbol(); timers.set(key, fn); return key; },
    clearIntervalFn: (key) => timers.delete(key),
  });
  return { controller, events, calls, sent };
}

async function ready(state) {
  state.controller.start();
  assert.equal(state.calls.attach, 0, "must remain detached before handshake");
  const nonce = state.sent[0].nonce;
  state.events.message.emit({
    type: "broker.ready",
    protocolVersion: "1",
    nonce,
    sessionId: "session_abcdefghijklmnop",
    heartbeatIntervalMs: 10_000,
    capabilities: ["create", "get", "isUvpaa", "cancel"],
  });
  await Promise.resolve();
  assert.equal(state.calls.attach, 1);
}

test("forwards and completes a create request exactly once", async () => {
  const state = fixture();
  await ready(state);
  state.events.create.emit({ requestId: 17, requestDetailsJson: JSON.stringify({ challenge: "abc" }) });
  const request = state.sent.at(-1);
  assert.equal(request.type, "extension.request", "handler forwards synchronously");
  state.events.message.emit({
    type: "broker.result",
    protocolVersion: "1",
    sessionId: request.sessionId,
    ceremonyId: request.ceremonyId,
    chromeRequestId: 17,
    kind: "create",
    responseJson: JSON.stringify({ id: "credential" }),
  });
  state.events.message.emit({
    type: "broker.result",
    protocolVersion: "1",
    sessionId: request.sessionId,
    ceremonyId: request.ceremonyId,
    chromeRequestId: 17,
    kind: "create",
    responseJson: JSON.stringify({ id: "duplicate" }),
  });
  assert.deepEqual(state.calls.create, [{ requestId: 17, responseJson: JSON.stringify({ id: "credential" }) }]);
});

test("propagates Chrome cancellation without completing the canceled request", async () => {
  const state = fixture();
  await ready(state);
  state.events.get.emit({ requestId: 18, requestDetailsJson: JSON.stringify({ challenge: "abc" }) });
  state.events.cancel.emit(18);
  assert.equal(state.sent.at(-1).type, "extension.cancel");
  assert.equal(state.calls.get.length, 0);
});

test("forwards and completes UVPAA", async () => {
  const state = fixture();
  await ready(state);
  state.events.uvpaa.emit({ requestId: 19 });
  const request = state.sent.at(-1);
  assert.equal(request.kind, "isUvpaa");
  state.events.message.emit({
    type: "broker.uvpaa",
    protocolVersion: "1",
    sessionId: request.sessionId,
    ceremonyId: request.ceremonyId,
    chromeRequestId: 19,
    isUvpaa: true,
  });
  assert.deepEqual(state.calls.uvpaa, [{ requestId: 19, isUvpaa: true }]);
});

test("broker loss fails pending work and detaches immediately", async () => {
  const state = fixture();
  await ready(state);
  state.events.get.emit({ requestId: 20, requestDetailsJson: JSON.stringify({ challenge: "abc" }) });
  state.events.disconnect.emit();
  assert.equal(state.calls.detach, 1);
  assert.equal(state.calls.get.length, 1);
  assert.equal(state.calls.get[0].error.name, "NotAllowedError");
  state.events.disconnect.emit();
  assert.equal(state.calls.detach, 1, "disconnect cleanup is idempotent");
  assert.equal(state.calls.get.length, 1, "pending completion is dispatched exactly once");
});

test("wrong handshake nonce never attaches and fails closed", () => {
  const state = fixture();
  state.controller.start();
  state.events.message.emit({
    type: "broker.ready",
    protocolVersion: "1",
    nonce: "identifier_9999999999999999",
    sessionId: "session_abcdefghijklmnop",
    heartbeatIntervalMs: 10_000,
    capabilities: ["create", "get", "isUvpaa", "cancel"],
  });
  assert.equal(state.calls.attach, 0);
});

test("broker loss while attach is pending detaches only once", async () => {
  const state = fixture();
  // The fixture attach promise resolves immediately, so exercise the generation fence by
  // delivering ready and disconnecting in the same turn before its microtask settles.
  state.controller.start();
  const nonce = state.sent[0].nonce;
  state.events.message.emit({
    type: "broker.ready",
    protocolVersion: "1",
    nonce,
    sessionId: "session_abcdefghijklmnop",
    heartbeatIntervalMs: 10_000,
    capabilities: ["create", "get", "isUvpaa", "cancel"],
  });
  state.events.disconnect.emit();
  await Promise.resolve();
  assert.equal(state.calls.detach, 1);
});

test("replayed broker heartbeats fail closed", async () => {
  const state = fixture();
  await ready(state);
  const heartbeat = {
    type: "broker.heartbeat",
    protocolVersion: "1",
    sessionId: "session_abcdefghijklmnop",
    sequence: 4,
    sentAt: 100,
  };
  state.events.message.emit(heartbeat);
  state.events.message.emit(heartbeat);
  assert.equal(state.calls.detach, 1);
});
