#!/usr/bin/env electron
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain } from "electron";
import { createServer as createViteServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preload = path.join(root, "electron", "preload.cjs");
const TOKEN = "acceptance-viewer-token-0123456789abcdef0123456789abcdef";
const BOT_IDS = ["bot-alpha", "bot-beta"];
const FRAME_MARKERS = {
  "bot-alpha": "ALPHA_FRAME_7d9a",
  "bot-beta": "BETA_FRAME_3f2c",
};

const requests = [];
const controls = new Map(BOT_IDS.map((id) => [id, null]));
const screenshotCounts = new Map(BOT_IDS.map((id) => [id, 0]));
let leaseSequence = 0;
const viewers = new Map();
const viewerEvents = [];
let window;
let vite;
let apiServer;
const sseResponses = new Set();
const rendererConsoleErrors = [];
const rendererDocumentTokens = new Map();

const bots = [
  makeBot("bot-alpha", "Alpha", "green"),
  makeBot("bot-beta", "Beta", "blue"),
];

async function availablePort() {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function makeBot(id, name, color) {
  return {
    id,
    threadId: `thread-${id}`,
    tasks: [{ threadId: `thread-${id}`, title: "Main", createdAt: 1 }],
    name,
    title: "Acceptance bot",
    description: `${name} renderer acceptance fixture`,
    notifications: false,
    color,
    unread: false,
    busy: false,
    activity: "idle",
    modelSelection: { instanceId: "acceptance-acp", model: "acceptance-model" },
    computer: "vm",
    autoApprove: false,
    messages: [],
  };
}

function json(response, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.length,
    "cache-control": "no-store",
  });
  response.end(bytes);
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function targetSnapshot(botId, control = controls.get(botId)) {
  return {
    held: Boolean(control),
    helpReason: null,
    heldSinceMs: control?.heldSinceMs ?? null,
    leaseExpiresAtMs: control ? Date.now() + 30_000 : null,
    targetSurface: "vm",
    targetKey: `vm:${botId}`,
    targetGeneration: `generation:${botId}`,
  };
}

function frameFor(botId) {
  const marker = FRAME_MARKERS[botId];
  const fill = botId === "bot-alpha" ? "#009957" : "#377FE6";
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="${fill}"/><text x="40" y="80" font-size="34">${marker}</text></svg>`,
  )}`;
}

async function handleApi(request, response) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/api/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(`data: ${JSON.stringify({ kind: "hello", resumed: false })}\n\n`);
    sseResponses.add(response);
    request.once("close", () => sseResponses.delete(response));
    return;
  }

  let body = {};
  if (request.method !== "GET" && request.method !== "HEAD") body = await requestBody(request);
  requests.push({ method: request.method, path: url.pathname, body });

  if (request.method === "GET" && url.pathname === "/api/bots") {
    return json(response, 200, {
      bots,
      groups: [],
      computerControl: Object.fromEntries(BOT_IDS.map((id) => [id, targetSnapshot(id)])),
    });
  }
  if (request.method === "GET" && url.pathname === "/api/instances") {
    return json(response, 200, {
      instances: [{
        instanceId: "acceptance-acp",
        driverKind: "acpAgent",
        displayName: "Acceptance ACP",
        snapshot: { state: "available", authenticated: true },
        models: {
          default: "acceptance-model",
          options: [{ id: "acceptance-model", label: "Acceptance model" }],
        },
        capabilities: { computerMcp: true, localComputerMcp: true, queueing: true },
        access: "custom",
      }],
    });
  }
  if (request.method === "GET" && url.pathname === "/api/config") {
    return json(response, 200, {
      composio: { configured: false, mode: "unavailable" },
      box: { configured: false },
      vps: { configured: false, sshAlias: "" },
      rooms: { turnTimeoutMinutes: 30 },
      localVm: { mode: "per-bot", maxInstances: 4 },
      tts: { configured: false, ready: false, voice: "", provider: "system" },
      imageGen: { configured: false },
      profile: { name: "Acceptance", email: "acceptance@example.invalid" },
      features: { skillRecorder: false },
    });
  }
  if (request.method === "GET" && url.pathname === "/api/routines") {
    return json(response, 200, { routines: [], runs: [] });
  }
  if (request.method === "GET" && url.pathname === "/api/webhooks") {
    return json(response, 200, { webhooks: [], attempts: [], ingress: null });
  }
  if (request.method === "GET" && url.pathname === "/api/connectors/connected") {
    return json(response, 200, { connectors: [] });
  }

  const botMatch = url.pathname.match(/^\/api\/bots\/([\w-]+)(.*)$/);
  if (!botMatch || !BOT_IDS.includes(botMatch[1])) return json(response, 404, { error: "not found" });
  const [, botId, suffix] = botMatch;

  if (request.method === "GET" && suffix === "") {
    return json(response, 200, { bot: bots.find((bot) => bot.id === botId) });
  }
  if (request.method === "PATCH" && suffix === "") {
    return json(response, 200, { bot: bots.find((bot) => bot.id === botId) });
  }
  if (request.method === "GET" && suffix === "/local-computer") {
    return json(response, 200, {
      mode: "per-bot",
      max_instances: 4,
      image: true,
      create_supported: true,
      container: "running",
      imageMatches: true,
      managed: true,
      network: "loopback",
      security: "hardened",
      persistence: "durable",
      desktopReady: true,
      ready: true,
      problem: null,
      viewer_available: true,
    });
  }
  if (request.method === "POST" && suffix === "/local-computer/screenshot") {
    const count = (screenshotCounts.get(botId) ?? 0) + 1;
    screenshotCounts.set(botId, count);
    // Alpha's third panel mount deliberately finishes after Beta's frame.
    // This recreates the stale-preview race that previously showed the wrong
    // computer after switching bots.
    const delay = botId === "bot-alpha" && count === 3 ? 550 : 25;
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (!response.destroyed) return json(response, 200, { image: frameFor(botId) });
    return;
  }
  if (request.method === "GET" && suffix === "/computer/control") {
    return json(response, 200, targetSnapshot(botId));
  }
  if (request.method === "POST" && suffix === "/computer/control") {
    const action = body.action;
    if (action === "take") {
      assert.equal(body.surface, "vm", "takeover must stay on the bot's VM surface");
      const current = controls.get(botId);
      if (current && current.ownerId !== body.ownerId) {
        return json(response, 409, { error: "already controlled", ...targetSnapshot(botId) });
      }
      const control = current ?? {
        ownerId: body.ownerId,
        leaseToken: `lease-${botId}-${++leaseSequence}`,
        heldSinceMs: Date.now(),
      };
      controls.set(botId, control);
      return json(response, 200, { ...targetSnapshot(botId, control), leaseToken: control.leaseToken });
    }
    if (action === "heartbeat") {
      const current = controls.get(botId);
      if (!current || current.ownerId !== body.ownerId || current.leaseToken !== body.leaseToken) {
        return json(response, 403, targetSnapshot(botId));
      }
      return json(response, 200, targetSnapshot(botId, current));
    }
    if (action === "release") {
      const current = controls.get(botId);
      if (!current || current.ownerId !== body.ownerId || current.leaseToken !== body.leaseToken) {
        return json(response, 403, targetSnapshot(botId));
      }
      controls.set(botId, null);
      return json(response, 200, targetSnapshot(botId, null));
    }
    if (action === "dismiss-help") return json(response, 200, targetSnapshot(botId));
    return json(response, 400, { error: "unknown control action" });
  }
  if (request.method === "POST" && suffix === "/local-computer/join") {
    const current = controls.get(botId);
    if (!current || current.ownerId !== body.ownerId || current.leaseToken !== body.leaseToken) {
      return json(response, 403, { error: "invalid viewer lease" });
    }
    return json(response, 200, {
      joinUrl: `/api/bots/${botId}/local-computer/viewer/${TOKEN}/vnc.html#autoconnect=true`,
    });
  }
  return json(response, 404, { error: "not found" });
}

function visibleElementExpression(selector, text = null) {
  return `(() => {
    const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
    const elements = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const element = elements.find((candidate) => {
      if (${JSON.stringify(text)} !== null && normalize(candidate.textContent) !== ${JSON.stringify(text)}) return false;
      const style = getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      return !candidate.hidden && !candidate.disabled && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    });
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), width: rect.width, height: rect.height };
  })()`;
}

async function evaluate(source) {
  return window.webContents.executeJavaScript(source, true);
}

async function waitFor(description, probe, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`);
}

async function click(selector, text = null) {
  const rect = await waitFor(
    `${text ?? selector} to become clickable`,
    () => evaluate(visibleElementExpression(selector, text)),
  );
  window.webContents.sendInputEvent({ type: "mouseMove", x: rect.x, y: rect.y });
  window.webContents.sendInputEvent({ type: "mouseDown", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  window.webContents.sendInputEvent({ type: "mouseUp", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function clickBot(name) {
  const expression = `(() => {
    const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
    const element = [...document.querySelectorAll('[role="button"]')].find((candidate) => {
      const style = getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      return normalize(candidate.querySelector('.font-semibold')?.textContent) === ${JSON.stringify(name)} &&
        style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`;
  const rect = await waitFor(`${name} bot row`, () => evaluate(expression));
  window.webContents.sendInputEvent({ type: "mouseMove", x: rect.x, y: rect.y });
  window.webContents.sendInputEvent({ type: "mouseDown", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  window.webContents.sendInputEvent({ type: "mouseUp", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
}

async function pressEscape() {
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
}

async function panelState(name) {
  return evaluate(`(() => {
    const panel = document.querySelector(${JSON.stringify(`aside[aria-label="${name}'s computer"]`)});
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    const style = getComputedStyle(panel);
    return { width: rect.width, height: rect.height, display: style.display, visibility: style.visibility };
  })()`);
}

async function waitForPanel(name) {
  return waitFor(`${name} computer panel`, async () => {
    const state = await panelState(name);
    return state && state.width >= 300 && state.height >= 400 && state.display !== "none" && state.visibility !== "hidden" ? state : null;
  });
}

async function waitForPanelClosed(name) {
  return waitFor(`${name} computer panel to collapse`, async () => !(await panelState(name)));
}

async function waitForFrame(name, marker) {
  return waitFor(`${name} exact computer frame`, () => evaluate(`(() => {
    const image = document.querySelector(${JSON.stringify(`img[alt="${name}'s screen"]`)});
    return image && image.getBoundingClientRect().width > 0 && image.src.includes(${JSON.stringify(marker)}) ? image.src : null;
  })()`));
}

function latestRequest(method, pathName, predicate = () => true) {
  return [...requests].reverse().find(
    (request) => request.method === method && request.path === pathName && predicate(request.body),
  );
}

async function waitForViewer(contextId) {
  return waitFor(`viewer for ${contextId}`, () => {
    const event = [...viewerEvents].reverse().find((candidate) => candidate.open && candidate.contextId === contextId);
    return event ?? null;
  });
}

async function runAcceptance() {
  await waitFor("hydrated Alpha chat", () => evaluate(`document.body.innerText.includes("Alpha")`));

  // 1. The real toolbar button opens a measurable panel; its own Collapse
  // button and a genuine Escape key event both remove that panel.
  await click("[data-computer-toggle]");
  const opened = await waitForPanel("Alpha");
  assert.ok(opened.width > 0 && opened.height > 0);
  await waitForFrame("Alpha", FRAME_MARKERS["bot-alpha"]);
  await click("button", "Collapse");
  await waitForPanelClosed("Alpha");
  assert.equal(await evaluate(`document.querySelector('[data-computer-toggle]')?.getAttribute('aria-expanded')`), "false");

  await click("[data-computer-toggle]");
  await waitForPanel("Alpha");
  await pressEscape();
  await waitForPanelClosed("Alpha");
  assert.equal(await evaluate(`document.activeElement?.hasAttribute('data-computer-toggle')`), true);
  console.log("PASS sidebar opens and visibly collapses by button and Escape");

  // 2. Alpha's third screenshot is delayed across the switch. Beta's exact
  // frame must remain the only preview even after that stale response lands.
  await click("[data-computer-toggle]");
  await waitForPanel("Alpha");
  await clickBot("Beta");
  await waitForPanel("Beta");
  await waitForFrame("Beta", FRAME_MARKERS["bot-beta"]);
  await new Promise((resolve) => setTimeout(resolve, 700));
  const previewIdentity = await evaluate(`(() => ({
    beta: document.querySelector('img[alt="Beta\\'s screen"]')?.src || null,
    alphaCount: document.querySelectorAll('img[alt="Alpha\\'s screen"]').length,
    panel: document.querySelector('aside[aria-label="Beta\\'s computer"]')?.getAttribute('aria-label') || null,
  }))()`);
  assert.ok(previewIdentity.beta.includes(FRAME_MARKERS["bot-beta"]));
  assert.equal(previewIdentity.beta.includes(FRAME_MARKERS["bot-alpha"]), false);
  assert.equal(previewIdentity.alphaCount, 0);
  assert.equal(previewIdentity.panel, "Beta's computer");
  console.log("PASS switching bots cannot show another bot's delayed frame");

  // 3. Take control must mint one exact lease, join that same bot with that
  // exact lease, and open a viewer whose context and path are both Beta.
  await click("button", "Take control");
  const betaViewer = await waitForViewer("bot-beta");
  await waitFor("Beta control card", () => evaluate(`document.body.innerText.includes("You have the wheel")`));
  const betaControl = controls.get("bot-beta");
  assert.ok(betaControl?.leaseToken);
  const betaTake = latestRequest("POST", "/api/bots/bot-beta/computer/control", (body) => body.action === "take");
  const betaJoin = latestRequest("POST", "/api/bots/bot-beta/local-computer/join");
  assert.equal(betaTake.body.ownerId, betaControl.ownerId);
  assert.deepEqual(betaJoin.body, { ownerId: betaControl.ownerId, leaseToken: betaControl.leaseToken });
  const betaUrl = new URL(betaViewer.url);
  assert.equal(betaViewer.contextId, "bot-beta");
  assert.equal(betaUrl.hostname, "openmaus-viewer.localhost");
  assert.match(betaUrl.pathname, /^\/api\/bots\/bot-beta\/local-computer\/viewer\//);

  const firstBetaToken = betaControl.leaseToken;
  await click("button", "Hand control back");
  await waitFor("Beta lease release", () => controls.get("bot-beta") === null);
  await waitFor("Beta viewer close", () => viewerEvents.some((event) => !event.open && event.contextId === "bot-beta"));
  const betaRelease = latestRequest(
    "POST",
    "/api/bots/bot-beta/computer/control",
    (body) => body.action === "release" && body.leaseToken === firstBetaToken,
  );
  assert.deepEqual(
    { ownerId: betaRelease.body.ownerId, leaseToken: betaRelease.body.leaseToken },
    { ownerId: betaControl.ownerId, leaseToken: firstBetaToken },
  );
  await waitFor("Beta control UI to clear", () =>
    evaluate(`!document.body.innerText.includes("Controlling Beta") && !document.body.innerText.includes("You have the wheel")`));
  console.log("PASS Take control opens the exact bot viewer and Hand back releases its exact lease");

  // 4. Open Alpha, then Beta. Both exact Electron viewers and leases must
  // coexist; handing Beta back must leave Alpha interactive and paused.
  await clickBot("Alpha");
  await waitForPanel("Alpha");
  await waitForFrame("Alpha", FRAME_MARKERS["bot-alpha"]);
  await click("button", "Take control");
  const alphaViewer = await waitForViewer("bot-alpha");
  const alphaControl = controls.get("bot-alpha");
  assert.ok(alphaControl?.leaseToken);
  assert.equal(new URL(alphaViewer.url).pathname.includes("/bots/bot-alpha/"), true);

  await clickBot("Beta");
  await waitForPanel("Beta");
  await waitForFrame("Beta", FRAME_MARKERS["bot-beta"]);
  await click("button", "Take control");
  const secondBetaViewer = await waitFor("new Beta viewer generation", () => {
    const opens = viewerEvents.filter((event) => event.open && event.contextId === "bot-beta");
    return opens.length >= 2 ? opens.at(-1) : null;
  });
  const secondBetaControl = controls.get("bot-beta");
  assert.ok(secondBetaControl?.leaseToken);
  assert.notEqual(alphaControl.leaseToken, secondBetaControl.leaseToken);
  assert.equal(new URL(secondBetaViewer.url).pathname.includes("/bots/bot-beta/"), true);
  assert.equal(controls.get("bot-alpha")?.leaseToken, alphaControl.leaseToken);
  assert.equal(controls.get("bot-beta")?.leaseToken, secondBetaControl.leaseToken);
  assert.deepEqual([...viewers.keys()].sort(), ["bot-alpha", "bot-beta"]);
  assert.equal(viewerEvents.some((event) => !event.open && event.contextId === "bot-alpha"), false);

  const identitySummary = await evaluate(`(() => ({
    panel: document.querySelector('aside[aria-label="Beta\\'s computer"]')?.getAttribute('aria-label') || null,
    betaFrame: document.querySelector('img[alt="Beta\\'s screen"]')?.src || null,
    alphaFrameCount: document.querySelectorAll('img[alt="Alpha\\'s screen"]').length,
    controllingBeta: document.body.innerText.includes("Controlling Beta"),
    controllingAlpha: document.body.innerText.includes("Controlling Alpha"),
  }))()`);
  assert.equal(identitySummary.panel, "Beta's computer");
  assert.ok(identitySummary.betaFrame.includes(FRAME_MARKERS["bot-beta"]));
  assert.equal(identitySummary.alphaFrameCount, 0);
  assert.equal(identitySummary.controllingBeta, true);
  assert.equal(identitySummary.controllingAlpha, true);

  await click("button", "Hand control back");
  await waitFor("final Beta release", () => controls.get("bot-beta") === null);
  assert.equal(controls.get("bot-alpha")?.leaseToken, alphaControl.leaseToken);
  assert.deepEqual([...viewers.keys()], ["bot-alpha"]);

  await clickBot("Alpha");
  await waitForPanel("Alpha");
  await click("button", "Hand control back");
  await waitFor("final Alpha release", () => controls.get("bot-alpha") === null);
  console.log("PASS two bots keep distinct preview, viewer, context, owner, and lease identities");

  assert.deepEqual(BOT_IDS.map((id) => controls.get(id)), [null, null]);
  assert.equal(viewers.size, 0);
  assert.equal(rendererConsoleErrors.length, 0, rendererConsoleErrors.join("\n"));
}

function installViewerBridge() {
  const assertCurrentDocument = (event, token) => {
    assert.equal(token, rendererDocumentTokens.get(event.sender.id), "IPC must carry the current renderer-document token");
  };
  const privileged = (channel, handler) => {
    ipcMain.handle(channel, (event, token, ...args) => {
      assertCurrentDocument(event, token);
      return handler(event, ...args);
    });
  };

  ipcMain.on("desktop:claim-renderer-document", (event, token) => {
    assert.equal(typeof token, "string");
    assert.ok(token.length >= 16);
    rendererDocumentTokens.set(event.sender.id, token);
    event.returnValue = true;
  });
  ipcMain.on("desktop:unread-count", (event, token) => {
    assertCurrentDocument(event, token);
  });
  privileged("desktop:connection", () => ({ mode: "remote", serverName: "Acceptance Razer" }));
  privileged("desktop:capabilities", () => ({
    connection: { mode: "remote", serverName: "Acceptance Razer" },
    host: {
      platform: "darwin",
      homeDir: "/Users/acceptance",
      label: "macOS",
      session: "unknown",
      packaged: true,
    },
    windowChrome: "native",
    screenPreview: { available: false, interaction: "none", reasonCode: "acceptance-fixture" },
    dictation: { available: false, engine: "none", onDevice: false, reasonCode: "acceptance-fixture" },
    localComputer: {
      available: false,
      support: "unsupported",
      enabled: false,
      status: "unavailable",
      reasonCode: "acceptance-fixture",
    },
  }));
  privileged("android-device:status", () => ({ available: false, devices: [] }));
  privileged("companion:state", () => ({
    enabled: false,
    keepAwake: false,
    port: 8810,
    devices: [],
    pairing: null,
  }));
  privileged("companion-account:state", () => ({ available: false, status: "signed-out" }));
  privileged("update:get-state", () => ({ status: "idle" }));
  privileged("desktop-viewer:state-now", (_event, contextId) => ({
    open: viewers.has(contextId),
    contextId,
  }));
  privileged("desktop-viewer:states-now", () => (
    [...viewers.keys()].map((contextId) => ({ open: true, contextId }))
  ));
  privileged("desktop-viewer:open", (event, url, title, contextId) => {
    assert.equal(typeof url, "string");
    assert.equal(typeof contextId, "string");
    viewers.set(contextId, { url, title });
    const opened = { open: true, contextId, url, title };
    viewerEvents.push(opened);
    event.sender.send("desktop-viewer:state", { open: true, contextId });
    return true;
  });
  privileged("desktop-viewer:close", (event, contextId) => {
    if (!viewers.has(contextId)) return false;
    const closed = { open: false, contextId };
    viewerEvents.push(closed);
    viewers.delete(contextId);
    event.sender.send("desktop-viewer:state", closed);
    return true;
  });
}

async function main() {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
  app.commandLine.appendSwitch("disable-http-cache");
  await app.whenReady();

  apiServer = http.createServer((request, response) => {
    void handleApi(request, response).catch((error) => {
      console.error(error);
      if (!response.headersSent) json(response, 500, { error: error.message });
      else response.destroy(error);
    });
  });
  apiServer.listen(0, "127.0.0.1");
  await once(apiServer, "listening");
  const apiPort = apiServer.address().port;
  process.env.OMB_PORT = String(apiPort);

  const requestedUiPort = await availablePort();

  vite = await createViteServer({
    root,
    configFile: path.join(root, "vite.config.ts"),
    logLevel: "error",
    server: { host: "127.0.0.1", port: requestedUiPort, strictPort: true },
  });
  await vite.listen();
  const uiPort = vite.httpServer.address().port;
  installViewerBridge();

  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    show: true,
    backgroundColor: "#090909",
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") rendererConsoleErrors.push(event.message);
  });
  await window.loadURL(`http://127.0.0.1:${uiPort}`);
  await evaluate(`(() => {
    localStorage.setItem("omb-email-gate", "skipped");
    localStorage.setItem("omb-analytics-opt-out", "1");
    localStorage.setItem("openmausbot.sidebar-density", "comfortable");
  })()`);
  await window.webContents.reload();
  await runAcceptance();
}

async function cleanup() {
  for (const response of sseResponses) response.destroy();
  sseResponses.clear();
  if (window && !window.isDestroyed()) window.destroy();
  for (const channel of [
    "desktop:connection",
    "desktop:capabilities",
    "android-device:status",
    "companion:state",
    "companion-account:state",
    "update:get-state",
    "desktop-viewer:state-now",
    "desktop-viewer:states-now",
    "desktop-viewer:open",
    "desktop-viewer:close",
  ]) ipcMain.removeHandler(channel);
  ipcMain.removeAllListeners("desktop:claim-renderer-document");
  ipcMain.removeAllListeners("desktop:unread-count");
  if (vite) await vite.close();
  if (apiServer?.listening) {
    apiServer.closeAllConnections?.();
    await new Promise((resolve) => apiServer.close(resolve));
  }
}

let exitCode = 0;
try {
  await main();
  console.log(`PASS renderer acceptance complete (${requests.length} API requests, ${viewerEvents.length} viewer transitions)`);
} catch (error) {
  exitCode = 1;
  console.error("FAIL renderer acceptance");
  console.error(error?.stack ?? error);
  if (window && !window.isDestroyed()) {
    const debugState = await evaluate(`(() => ({
      title: document.title,
      text: document.body.innerText.slice(0, 2_000),
      toggle: [...document.querySelectorAll('[data-computer-toggle]')].map((element) => ({
        expanded: element.getAttribute('aria-expanded'),
        pressed: element.getAttribute('aria-pressed'),
        rect: element.getBoundingClientRect().toJSON(),
      })),
      panels: [...document.querySelectorAll('aside')].map((element) => element.getAttribute('aria-label')),
    }))()`).catch(() => null);
    console.error("Renderer state:", JSON.stringify(debugState));
  }
  if (rendererConsoleErrors.length) console.error("Renderer console errors:", rendererConsoleErrors.join("\n"));
} finally {
  await cleanup();
  app.exit(exitCode);
}
