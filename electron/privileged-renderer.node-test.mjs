import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const {
  bindPrivilegedRendererNavigation,
  createPrivilegedRendererController,
  exactRendererUrl,
  externalWebUrl,
  normalizeRendererOrigin,
} = require("./privileged-renderer.cjs");

const TOKEN_A = "11111111-1111-4111-8111-111111111111";
const TOKEN_B = "22222222-2222-4222-8222-222222222222";

class FakeWebContents extends EventEmitter {
  constructor(url = "http://127.0.0.1:5199/") {
    super();
    this.destroyed = false;
    this.mainFrame = { processId: 10, routingId: 20, url };
    this.url = url;
    this.stopCalls = 0;
  }

  getURL() {
    return this.url;
  }

  isDestroyed() {
    return this.destroyed;
  }

  stop() {
    this.stopCalls += 1;
  }
}

class FakeWindow extends EventEmitter {
  constructor(url) {
    super();
    this.destroyed = false;
    this.webContents = new FakeWebContents(url);
  }

  isDestroyed() {
    return this.destroyed;
  }
}

function ipcEvent(window, frame = window.webContents.mainFrame) {
  return { sender: window.webContents, senderFrame: frame };
}

function readyHarness(origin = "http://127.0.0.1:5199") {
  const window = new FakeWindow(`${origin}/`);
  let currentWindow = window;
  const controller = createPrivilegedRendererController({
    expectedOrigin: origin,
    getMainWindow: () => currentWindow,
  });
  controller.attach(window);
  assert.equal(controller.beginNavigation(window, `${origin}/`), true);
  assert.equal(controller.claim(ipcEvent(window), TOKEN_A), true);
  return { controller, setCurrentWindow: (next) => { currentWindow = next; }, window };
}

test("renderer URLs are limited to one normalized HTTP(S) origin", () => {
  assert.equal(normalizeRendererOrigin("http://127.0.0.1:5199/app"), "http://127.0.0.1:5199");
  assert.equal(normalizeRendererOrigin("https://razer.example/app"), "https://razer.example");
  assert.equal(exactRendererUrl("http://127.0.0.1:5199/rooms/1", "http://127.0.0.1:5199"), true);
  assert.equal(exactRendererUrl("http://127.0.0.1:5200/", "http://127.0.0.1:5199"), false);
  assert.equal(exactRendererUrl("https://razer.example.evil.test/", "https://razer.example"), false);
  assert.equal(exactRendererUrl("https://user@razer.example/", "https://razer.example"), false);
  assert.equal(exactRendererUrl("not a URL", "https://razer.example"), false);
  assert.throws(() => normalizeRendererOrigin("file:///tmp/index.html"), /HTTP\(S\)/);
});

test("external opening allows only credential-free HTTP(S) URLs", () => {
  assert.equal(externalWebUrl("https://example.com/docs?q=1"), "https://example.com/docs?q=1");
  assert.equal(externalWebUrl("http://example.com"), "http://example.com/");
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///etc/passwd",
    "mailto:test@example.com",
    "x-apple.systempreferences:Privacy",
    "https://user:password@example.com/",
    "//example.com/no-scheme",
    "%%%",
  ]) {
    assert.equal(externalWebUrl(value), null, value);
  }
});

test("a valid exact main-frame event receives a generation-bound proof", () => {
  const { controller, window } = readyHarness();
  const proof = controller.authorize(ipcEvent(window), TOKEN_A);
  assert.equal(controller.assertProof(proof), true);
  assert.throws(() => controller.authorize(ipcEvent(window), TOKEN_B), /rejected/);
  assert.throws(() => controller.claim(ipcEvent(window), "not-a-document-token"), /claim rejected/);
});

test("wrong windows, webContents, frames, and origins are rejected", () => {
  const { controller, setCurrentWindow, window } = readyHarness();
  const other = new FakeWindow("http://127.0.0.1:5199/");

  assert.throws(() => controller.authorize(ipcEvent(other), TOKEN_A), /rejected/);
  assert.throws(
    () => controller.authorize(ipcEvent(window, { processId: 10, routingId: 99, url: window.webContents.url }), TOKEN_A),
    /rejected/,
  );
  assert.throws(
    () => controller.authorize(ipcEvent(window, { ...window.webContents.mainFrame, url: "https://evil.test/" }), TOKEN_A),
    /rejected/,
  );

  window.webContents.url = "https://evil.test/";
  assert.throws(() => controller.authorize(ipcEvent(window), TOKEN_A), /rejected/);
  window.webContents.url = "http://127.0.0.1:5199/";

  setCurrentWindow(other);
  assert.throws(() => controller.authorize(ipcEvent(window), TOKEN_A), /rejected/);
});

test("reloads and process swaps invalidate stale frame generations", () => {
  const { controller, window } = readyHarness();
  const oldEvent = ipcEvent(window, { ...window.webContents.mainFrame });
  const oldProof = controller.authorize(oldEvent, TOKEN_A);

  assert.equal(controller.beginNavigation(window, "http://127.0.0.1:5199/rooms/next"), true);
  assert.throws(() => controller.authorize(oldEvent, TOKEN_A), /rejected/);
  assert.throws(() => controller.assertProof(oldProof), /expired/);

  window.webContents.url = "http://127.0.0.1:5199/rooms/next";
  // Chromium may reuse the same frame routing identity across a reload. The
  // isolated-preload document token, not a hoped-for routing-ID change, is the
  // generation boundary.
  window.webContents.mainFrame.url = "http://127.0.0.1:5199/rooms/next";
  assert.equal(controller.claim(ipcEvent(window), TOKEN_B), true);
  assert.doesNotThrow(() => controller.authorize(ipcEvent(window), TOKEN_B));
  assert.throws(() => controller.authorize(oldEvent, TOKEN_A), /rejected/);
});

test("destroyed and replacement windows invalidate prior authority", () => {
  const { controller, setCurrentWindow, window } = readyHarness();
  const oldProof = controller.authorize(ipcEvent(window), TOKEN_A);
  window.webContents.destroyed = true;
  assert.throws(() => controller.authorize(ipcEvent(window), TOKEN_A), /rejected/);
  assert.throws(() => controller.assertProof(oldProof), /expired/);

  const replacement = new FakeWindow("http://127.0.0.1:5199/");
  setCurrentWindow(replacement);
  controller.attach(replacement);
  controller.beginNavigation(replacement, replacement.webContents.url);
  controller.claim(ipcEvent(replacement), TOKEN_B);
  assert.doesNotThrow(() => controller.authorize(ipcEvent(replacement), TOKEN_B));
  assert.throws(() => controller.authorize(ipcEvent(window), TOKEN_A), /rejected/);
});

test("navigation binding blocks page redirects and programmatic origin escapes", () => {
  const origin = "https://razer.example";
  const window = new FakeWindow(`${origin}/`);
  const controller = createPrivilegedRendererController({
    expectedOrigin: origin,
    getMainWindow: () => window,
  });
  const blocked = [];
  bindPrivilegedRendererNavigation({
    controller,
    window,
    onBlockedProgrammaticNavigation: (url) => blocked.push(url),
  });

  window.webContents.emit("did-start-navigation", {
    isMainFrame: true,
    isSameDocument: false,
    url: `${origin}/rooms/1`,
  });
  window.webContents.url = `${origin}/rooms/1`;
  window.webContents.mainFrame.url = `${origin}/rooms/1`;
  controller.claim(ipcEvent(window), TOKEN_A);
  assert.doesNotThrow(() => controller.authorize(ipcEvent(window), TOKEN_A));

  let prevented = false;
  window.webContents.emit("will-frame-navigate", {
    isMainFrame: true,
    preventDefault: () => { prevented = true; },
    url: "https://evil.test/phish",
  });
  assert.equal(prevented, true);

  prevented = false;
  window.webContents.emit("will-redirect", {
    isMainFrame: true,
    preventDefault: () => { prevented = true; },
    url: "data:text/html,redirected",
  });
  assert.equal(prevented, true);

  prevented = false;
  window.webContents.emit("will-frame-navigate", {
    isMainFrame: true,
    preventDefault: () => { prevented = true; },
    url: `${origin}/settings`,
  });
  assert.equal(prevented, false);

  window.webContents.emit("did-start-navigation", {
    isMainFrame: true,
    isSameDocument: false,
    url: "file:///tmp/foreign.html",
  });
  assert.deepEqual(blocked, ["file:///tmp/foreign.html"]);
  assert.throws(() => controller.authorize(ipcEvent(window), TOKEN_A), /rejected/);
});

test("every exposed preload action carries the isolated document token", async () => {
  const source = fs.readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
  const outbound = [];
  const listeners = new Map();
  let api;
  const ipcRenderer = {
    invoke(channel, ...args) {
      outbound.push({ channel, args, kind: "invoke" });
      return Promise.resolve(undefined);
    },
    on(channel, handler) {
      listeners.set(channel, handler);
    },
    removeListener(channel) {
      listeners.delete(channel);
    },
    send(channel, ...args) {
      outbound.push({ channel, args, kind: "send" });
    },
    sendSync(channel, ...args) {
      outbound.push({ channel, args, kind: "sendSync" });
      return channel === "desktop:claim-renderer-document";
    },
  };
  vm.runInNewContext(source, {
    console,
    crypto: { randomUUID: () => TOKEN_A },
    process: { platform: "darwin" },
    require(specifier) {
      assert.equal(specifier, "electron");
      return {
        contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
        ipcRenderer,
        webUtils: { getPathForFile: () => "/tmp/file" },
      };
    },
  });
  assert.ok(api);

  const promises = [
    api.connection(),
    api.getCapabilities(),
    api.companion.state(),
    api.companion.start(),
    api.companion.stop(),
    api.companion.keepAwake(true),
    api.companion.pairing(true, "pairing"),
    api.companion.cloudDesktop("device", true),
    api.companion.revoke("device"),
    api.companionAccount.state(),
    api.companionAccount.requestCode("person@example.com"),
    api.companionAccount.verifyCode("person@example.com", "123456"),
    api.companionAccount.retry(),
    api.companionAccount.signOut(),
    api.localControl.status(),
    api.localControl.enable(),
    api.localControl.disable(),
    api.localControl.retry(),
    api.screenFrame(),
    api.androidDevice.status(),
    api.androidDevice.frame("serial"),
    api.androidDevice.input("serial", { type: "tap" }),
    api.speechStart({}),
    api.speechStop(),
    api.speechFinish(),
    api.skillRecorder.permissions(),
    api.skillRecorder.start(),
    api.skillRecorder.stop(),
    api.skillRecorder.save({}),
    api.transcription.status(),
    api.transcription.setKey("key"),
    api.transcription.streamingToken(),
    api.permStatus(),
    api.permRequestMic(),
    api.permOpenSettings("mic"),
    api.openInstallTerminal("install"),
    api.openExternal("https://example.com"),
    api.desktopViewer.open("https://viewer.example", "Viewer", "context"),
    api.desktopViewer.close("context"),
    api.desktopViewer.currentState("context"),
    api.desktopViewer.currentStates(),
    api.pickFolder("/tmp"),
    api.exportDiagnostics(),
    api.saveFile("/tmp/file"),
    api.setCredential("boxToken", "secret"),
    api.updater.check(),
    api.updater.download(),
    api.updater.install(),
  ];
  api.beginScreenPreviewIntent();
  api.setUnreadCount(3);
  api.updater.onState(() => {});
  await Promise.all(promises);

  const claim = outbound.shift();
  assert.deepEqual(claim, {
    channel: "desktop:claim-renderer-document",
    args: [TOKEN_A],
    kind: "sendSync",
  });
  for (const call of outbound) assert.equal(call.args[0], TOKEN_A, call.channel);

  const declaredChannels = new Set(
    [...source.matchAll(/(?:invokePrivileged|sendPrivileged|sendPrivilegedSync)\("([^"]+)"/g)]
      .map((match) => match[1]),
  );
  assert.deepEqual(
    [...declaredChannels].filter((channel) => !outbound.some((call) => call.channel === channel)),
    [],
    "the test must exercise every privileged preload action",
  );
});

test("preload exposes no bridge when the document claim is rejected", () => {
  const source = fs.readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
  let exposed = false;
  assert.throws(
    () => vm.runInNewContext(source, {
      console,
      crypto: { randomUUID: () => TOKEN_A },
      process: { platform: "darwin" },
      require: () => ({
        contextBridge: { exposeInMainWorld: () => { exposed = true; } },
        ipcRenderer: {
          invoke: () => Promise.resolve(),
          on: () => {},
          removeListener: () => {},
          send: () => {},
          sendSync: () => false,
        },
        webUtils: {},
      }),
    }),
    /could not claim/,
  );
  assert.equal(exposed, false);
});

test("all privileged preload registrations use the central gate", () => {
  const main = fs.readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const preload = fs.readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
  const delegated = ["./android-device.mjs", "./cua.mjs", "./updater.mjs"]
    .map((file) => fs.readFileSync(new URL(file, import.meta.url), "utf8"))
    .join("\n");
  assert.equal((main.match(/ipcMain\.handle\(/g) ?? []).length, 1);
  assert.equal((main.match(/ipcMain\.on\(/g) ?? []).length, 2);
  assert.match(main, /ipcMain\.on\("desktop:claim-renderer-document"/);
  assert.match(main, /registerCuaIpc\(registerPrivilegedIpcHandle\)/);
  assert.match(main, /androidDevice\.registerIpc\(\{ handle: registerPrivilegedIpcHandle \}\)/);
  assert.match(main, /registerUpdaterIpc\(registerPrivilegedIpcHandle\)/);
  assert.match(main, /bindPrivilegedRendererNavigation/);
  assert.match(main, /externalWebUrl\(url\)/);

  const invokedChannels = new Set(
    [...preload.matchAll(/(?:invokePrivileged|sendPrivileged|sendPrivilegedSync)\("([^"]+)"/g)]
      .map((match) => match[1]),
  );
  const registeredChannels = new Set(
    [...`${main}\n${delegated}`.matchAll(
      /(?:registerPrivilegedIpcHandle|registerPrivilegedIpcOn|registerHandle|ipcMain\.handle)\("([^"]+)"/g,
    )].map((match) => match[1]),
  );
  assert.deepEqual(
    [...invokedChannels].filter((channel) => !registeredChannels.has(channel)),
    [],
    "every privileged preload send must have a guarded main-process registration",
  );
});
