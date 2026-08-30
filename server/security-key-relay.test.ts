import { describe, expect, it } from "vitest";

import { SECURITY_KEY_RELAY_PROTOCOL_VERSION, type SecurityKeyRelayToBrowserFrame, type SecurityKeyRelayToControllerFrame } from "../shared/security-key-relay.ts";
import { encodeBase64url } from "../shared/security-key-validation.ts";
import { SecurityKeyRelayManager, type SecurityKeyBrowserBinding, type SecurityKeyControllerBinding } from "./security-key-relay.ts";

const BOT_A = "bot_aaaaaaaaaaaaaaaa";
const BOT_B = "bot_bbbbbbbbbbbbbbbb";
const TARGET_A = "target_aaaaaaaaaaaaa";
const TARGET_B = "target_bbbbbbbbbbbbb";
const VM_A = "a".repeat(64);
const VM_B = "b".repeat(64);
const CEREMONY_A = "ceremony_aaaaaaaaaaaa";
const CEREMONY_B = "ceremony_bbbbbbbbbbbb";

function fixture() {
  let now = 1_000;
  let id = 0;
  const browserFrames: SecurityKeyRelayToBrowserFrame[] = [];
  const controllerFrames = new Map<string, SecurityKeyRelayToControllerFrame[]>();
  const manager = new SecurityKeyRelayManager({
    now: () => now,
    idFactory: () => `opaque_${String(++id).padStart(20, "0")}`,
    ceremonyTimeoutMs: 500,
    registrationTimeoutMs: 100,
    livenessTimeoutMs: 200,
  });

  function browser(connectionId = "browser-a", botId = BOT_A, targetKey = TARGET_A, vmGeneration = VM_A, browserGeneration = 1) {
    const pending = manager.beginBrowserRegistration(connectionId);
    const challenge = pending.frame.type === "relay.challenge" ? pending.frame.challenge : "";
    const binding = manager.completeBrowserRegistration(pending.binding, {
      type: "browser.register",
      protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION,
      botId,
      targetKey,
      vmGeneration,
      browserGeneration,
      extensionId: "a".repeat(32),
      challengeResponse: challenge,
    }, (frame) => browserFrames.push(frame));
    return binding;
  }

  function controller(connectionId = "controller-a", controllerGeneration = 1) {
    const frames: SecurityKeyRelayToControllerFrame[] = [];
    controllerFrames.set(connectionId, frames);
    const pending = manager.beginControllerRegistration(connectionId);
    const challenge = pending.frame.type === "relay.challenge" ? pending.frame.challenge : "";
    const binding = manager.completeControllerRegistration(pending.binding, {
      type: "controller.register",
      protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION,
      platform: "macos",
      controllerGeneration,
      capability: "security-key",
      challengeResponse: challenge,
    }, (frame) => frames.push(frame));
    return binding;
  }

  function beatBrowser(binding: SecurityKeyBrowserBinding, sequence = 0) {
    manager.heartbeatBrowser(binding, { type: "browser.heartbeat", protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION, browserGeneration: binding.browserGeneration, sequence, sentAt: now });
  }

  function beatController(binding: SecurityKeyControllerBinding, sequence = 0) {
    manager.heartbeatController(binding, { type: "controller.heartbeat", protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION, controllerGeneration: binding.controllerGeneration, sequence, sentAt: now });
  }

  function request(binding: SecurityKeyBrowserBinding, ceremonyId = CEREMONY_A, chromeRequestId = 10) {
    return {
      type: "browser.request" as const,
      protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION,
      ceremonyId,
      chromeRequestId,
      kind: "get" as const,
      requestDetailsJson: JSON.stringify({ challenge: challenge(), rpId: "login.example.com" }),
      botId: binding.botId,
      targetKey: binding.targetKey,
      vmGeneration: binding.vmGeneration,
      browserGeneration: binding.browserGeneration,
    };
  }

  async function start(browserBinding: SecurityKeyBrowserBinding, controllerBinding: SecurityKeyControllerBinding, ceremonyId = CEREMONY_A) {
    return manager.startCeremony({
      browser: browserBinding,
      controller: controllerBinding,
      frame: request(browserBinding, ceremonyId),
      trusted: {
        botId: browserBinding.botId,
        targetKey: browserBinding.targetKey,
        vmGeneration: browserBinding.vmGeneration,
        browserGeneration: browserBinding.browserGeneration,
      },
      origin: "https://login.example.com",
      rpId: "login.example.com",
      botLabel: "Hermes",
      taskLabel: "Sign in",
    });
  }

  return {
    manager, browserFrames, controllerFrames, browser, controller, beatBrowser, beatController, request, start,
    advance: (milliseconds: number) => { now += milliseconds; },
  };
}

function challenge(): string {
  return encodeBase64url(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
}

function clientData(origin = "https://login.example.com", value = challenge()): string {
  return encodeBase64url(new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge: value, origin, crossOrigin: false })));
}

describe("SecurityKeyRelayManager", () => {
  it("requires completed live heartbeats from both exact registrations", async () => {
    const f = fixture();
    const browser = f.browser();
    const controller = f.controller();
    await expect(f.start(browser, controller)).rejects.toThrow("browser has not completed");
    f.beatBrowser(browser);
    await expect(f.start(browser, controller)).rejects.toThrow("controller has not completed");
    f.beatController(controller);
    await expect(f.start(browser, controller)).resolves.toMatchObject({ ceremonyId: CEREMONY_A });
  });

  it("binds a ceremony to the explicitly selected controller without a latest-provider fallback", async () => {
    const f = fixture();
    const browser = f.browser();
    const selected = f.controller("controller-a", 1);
    const other = f.controller("controller-b", 7);
    f.beatBrowser(browser); f.beatController(selected); f.beatController(other);
    const started = await f.start(browser, selected);
    expect(f.controllerFrames.get("controller-a")?.at(-1)).toMatchObject({ type: "controller.ceremony", ceremonyId: CEREMONY_A });
    expect(f.controllerFrames.get("controller-b")).toHaveLength(1);
    expect(() => f.manager.handleControllerFrame(other, {
      type: "controller.status", protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION, controllerGeneration: other.controllerGeneration,
      ceremonyId: CEREMONY_A, requestHash: started.requestHash, status: "waiting-for-touch",
    })).toThrow(/does not own|stale controller registration/u);
    f.manager.handleControllerFrame(selected, {
      type: "controller.consent", protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION, controllerGeneration: selected.controllerGeneration,
      ceremonyId: CEREMONY_A, requestHash: started.requestHash, decision: "approved",
    });
    f.manager.handleControllerFrame(selected, {
      type: "controller.status", protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION, controllerGeneration: selected.controllerGeneration,
      ceremonyId: CEREMONY_A, requestHash: started.requestHash, status: "waiting-for-touch",
    });
    expect(f.manager.status().activeCeremony?.state).toBe("waiting-for-touch");
  });

  it("rejects cross-bot and trusted-generation substitution", async () => {
    const f = fixture();
    const browser = f.browser(); const controller = f.controller();
    f.beatBrowser(browser); f.beatController(controller);
    const crossBot = { ...f.request(browser), botId: BOT_B };
    await expect(f.manager.startCeremony({
      browser, controller, frame: crossBot,
      trusted: { botId: browser.botId, targetKey: browser.targetKey, vmGeneration: VM_A, browserGeneration: 1 },
      origin: "https://login.example.com", rpId: "login.example.com", botLabel: "Hermes", taskLabel: "Sign in",
    })).rejects.toThrow("generation fence mismatch");
    await expect(f.manager.startCeremony({
      browser, controller, frame: f.request(browser),
      trusted: { botId: BOT_B, targetKey: TARGET_B, vmGeneration: VM_B, browserGeneration: 1 },
      origin: "https://login.example.com", rpId: "login.example.com", botLabel: "Hermes", taskLabel: "Sign in",
    })).rejects.toThrow("generation fence mismatch");
  });

  it("allows only one active ceremony globally", async () => {
    const f = fixture();
    const browserA = f.browser(); const controllerA = f.controller();
    const browserB = f.browser("browser-b", BOT_B, TARGET_B); const controllerB = f.controller("controller-b", 2);
    f.beatBrowser(browserA); f.beatController(controllerA); f.beatBrowser(browserB); f.beatController(controllerB);
    await f.start(browserA, controllerA);
    await expect(f.start(browserB, controllerB, CEREMONY_B)).rejects.toThrow("another security-key ceremony is active");
  });

  it("cancels only the exact browser request and rejects replay", async () => {
    const f = fixture();
    const browser = f.browser(); const controller = f.controller();
    f.beatBrowser(browser); f.beatController(controller);
    const started = await f.start(browser, controller);
    expect(() => f.manager.handleBrowserCancel(browser, {
      type: "browser.cancel", protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION, ceremonyId: CEREMONY_A, chromeRequestId: 11,
      botId: browser.botId, targetKey: browser.targetKey, vmGeneration: browser.vmGeneration, browserGeneration: browser.browserGeneration,
    })).toThrow("does not own");
    expect(f.manager.handleBrowserCancel(browser, {
      type: "browser.cancel", protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION, ceremonyId: CEREMONY_A, chromeRequestId: 10,
      botId: browser.botId, targetKey: browser.targetKey, vmGeneration: browser.vmGeneration, browserGeneration: browser.browserGeneration,
    })).toBe(true);
    expect(f.controllerFrames.get("controller-a")?.at(-1)).toMatchObject({ type: "controller.cancel", reason: "browser-cancelled" });
    await expect(f.start(browser, controller)).rejects.toThrow("already been retired");
    expect(() => f.manager.handleControllerFrame(controller, {
      type: "controller.status", protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION, controllerGeneration: 1,
      ceremonyId: CEREMONY_A, requestHash: started.requestHash, status: "waiting-for-touch",
    })).toThrow("does not own");
  });

  it("invalidates active and old epochs on reconnect", async () => {
    const f = fixture();
    const oldBrowser = f.browser(); const controller = f.controller();
    f.beatBrowser(oldBrowser); f.beatController(controller);
    await f.start(oldBrowser, controller);
    const replacement = f.browser("browser-a", BOT_A, TARGET_A, VM_A, 2);
    expect(f.manager.status().activeCeremony).toBeNull();
    expect(() => f.beatBrowser(oldBrowser, 1)).toThrow("stale browser registration");
    f.beatBrowser(replacement);
    await expect(f.start(oldBrowser, controller)).rejects.toThrow("stale browser registration");
  });

  it("times out and rejects late results without retaining response material", async () => {
    const f = fixture();
    const browser = f.browser(); const controller = f.controller();
    f.beatBrowser(browser); f.beatController(controller);
    const started = await f.start(browser, controller);
    f.advance(501);
    f.manager.sweep();
    expect(f.manager.status().activeCeremony).toBeNull();
    expect(f.browserFrames).toContainEqual(expect.objectContaining({ type: "browser.error", code: "timeout" }));
    expect(() => f.manager.handleControllerFrame(controller, {
      type: "controller.result", protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION, controllerGeneration: 1,
      ceremonyId: CEREMONY_A, requestHash: started.requestHash, kind: "get",
      responseJson: JSON.stringify({ response: { clientDataJSON: clientData(), credential: "never-store-this-secret" } }),
    })).toThrow(/does not own|stale controller registration/u);
    expect(JSON.stringify(f.manager.status())).not.toContain("never-store-this-secret");
  });

  it("validates clientData before forwarding and rejects mismatched origin", async () => {
    const f = fixture();
    const browser = f.browser(); const controller = f.controller();
    f.beatBrowser(browser); f.beatController(controller);
    const started = await f.start(browser, controller);
    expect(() => f.manager.handleControllerFrame(controller, {
      type: "controller.result", protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION, controllerGeneration: 1,
      ceremonyId: CEREMONY_A, requestHash: started.requestHash, kind: "get",
      responseJson: JSON.stringify({ response: { clientDataJSON: clientData() } }),
    })).toThrow("before attended consent");
    f.manager.handleControllerFrame(controller, {
      type: "controller.consent", protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION, controllerGeneration: 1,
      ceremonyId: CEREMONY_A, requestHash: started.requestHash, decision: "approved",
    });
    expect(() => f.manager.handleControllerFrame(controller, {
      type: "controller.result", protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION, controllerGeneration: 1,
      ceremonyId: CEREMONY_A, requestHash: started.requestHash, kind: "get",
      responseJson: JSON.stringify({ response: { clientDataJSON: clientData("https://evil.example") } }),
    })).toThrow("origin mismatch");
    expect(f.manager.status().activeCeremony?.ceremonyId).toBe(CEREMONY_A);
    f.manager.handleControllerFrame(controller, {
      type: "controller.result", protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION, controllerGeneration: 1,
      ceremonyId: CEREMONY_A, requestHash: started.requestHash, kind: "get",
      responseJson: JSON.stringify({ response: { clientDataJSON: clientData() } }),
    });
    expect(f.browserFrames.at(-1)).toMatchObject({ type: "browser.result", ceremonyId: CEREMONY_A });
    expect(f.manager.status().activeCeremony).toBeNull();
  });

  it("bounds status events and exposes no challenge, request, result, origin, RP, or controller identity", () => {
    const f = fixture();
    const browser = f.browser();
    for (let index = 0; index < 140; index += 1) f.beatBrowser(browser, index);
    const serialized = JSON.stringify(f.manager.status());
    expect(f.manager.status().events).toHaveLength(100);
    expect(serialized).not.toContain(challenge());
    expect(serialized).not.toContain("login.example.com");
    expect(serialized).not.toContain("controller-a");
    expect(serialized).not.toContain("requestDetailsJson");
  });

  it("expires unanswered registration challenges and never-heartbeated peers remain ineligible", async () => {
    const f = fixture();
    const pending = f.manager.beginControllerRegistration("controller-late");
    f.advance(101);
    expect(() => f.manager.completeControllerRegistration(pending.binding, {
      type: "controller.register", protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION, platform: "macos",
      controllerGeneration: 1, capability: "security-key",
      challengeResponse: pending.frame.type === "relay.challenge" ? pending.frame.challenge : "",
    }, () => undefined)).toThrow("invalid or expired");
    const browser = f.browser(); const controller = f.controller();
    f.beatBrowser(browser);
    await expect(f.start(browser, controller)).rejects.toThrow("controller has not completed");
  });
});
