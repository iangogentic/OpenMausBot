import {
  SECURITY_KEY_RELAY_CEREMONY_TIMEOUT_MS,
  SECURITY_KEY_RELAY_HEARTBEAT_INTERVAL_MS,
  SECURITY_KEY_RELAY_LIVENESS_TIMEOUT_MS,
  SECURITY_KEY_RELAY_PROTOCOL_VERSION,
  SECURITY_KEY_RELAY_REGISTRATION_TIMEOUT_MS,
  type SecurityKeyBrowserToRelayFrame,
  type SecurityKeyControllerToRelayFrame,
  type SecurityKeyRelayToBrowserFrame,
  type SecurityKeyRelayToControllerFrame,
} from "../shared/security-key-relay.ts";
import {
  decodeCanonicalBase64url,
  hashCanonicalRequestJson,
  normalizeSecurityKeyOrigin,
  validateClientDataJson,
  validateRpIdForOrigin,
} from "../shared/security-key-validation.ts";
import { z } from "zod";

const MAX_STATUS_EVENTS = 100;
const MAX_PENDING_REGISTRATIONS = 128;
const MAX_LIVE_REGISTRATIONS = 64;
const MAX_RETIRED_CEREMONIES = 256;

export interface SecurityKeyRelayBinding {
  readonly connectionId: string;
  readonly registrationEpoch: string;
}

export interface SecurityKeyBrowserBinding extends SecurityKeyRelayBinding {
  readonly botId: string;
  readonly targetKey: string;
  readonly vmGeneration: number;
  readonly browserGeneration: number;
}

export interface SecurityKeyControllerBinding extends SecurityKeyRelayBinding {
  readonly controllerGeneration: number;
}

export interface SecurityKeyRelayEvent {
  readonly sequence: number;
  readonly at: number;
  readonly type: "registered" | "heartbeat" | "started" | "status" | "cancelled" | "completed" | "expired" | "disconnected" | "rejected";
  readonly peer: "browser" | "controller" | "ceremony";
  readonly ceremonyId?: string;
  readonly code?: string;
}

export interface SecurityKeyRelayStatus {
  readonly browserCount: number;
  readonly controllerCount: number;
  readonly eligibleBrowserCount: number;
  readonly eligibleControllerCount: number;
  readonly activeCeremony: null | {
    readonly ceremonyId: string;
    readonly botId: string;
    readonly kind: "create" | "get";
    readonly state: "awaiting-consent" | "select-device" | "waiting-for-touch" | "waiting-for-pin";
    readonly deadline: number;
  };
  readonly events: readonly SecurityKeyRelayEvent[];
}

export interface SecurityKeyRelayOptions {
  now?: () => number;
  idFactory?: () => string;
  ceremonyTimeoutMs?: number;
  registrationTimeoutMs?: number;
  livenessTimeoutMs?: number;
}

export interface SecurityKeyBrowserRegistrationStart {
  readonly binding: SecurityKeyRelayBinding;
  readonly frame: SecurityKeyRelayToBrowserFrame;
}

export interface SecurityKeyControllerRegistrationStart {
  readonly binding: SecurityKeyRelayBinding;
  readonly frame: SecurityKeyRelayToControllerFrame;
}

interface RelayEventDraft {
  sequence: number;
  at: number;
  type: SecurityKeyRelayEvent["type"];
  peer: SecurityKeyRelayEvent["peer"];
  ceremonyId?: string;
  code?: string;
}

interface PendingRegistration {
  connectionId: string;
  registrationEpoch: string;
  challenge: string;
  expiresAt: number;
}

interface BrowserRegistration extends SecurityKeyBrowserBinding {
  extensionId: string;
  registeredAt: number;
  heartbeatAt: number | null;
  heartbeatSequence: number;
  send: (frame: SecurityKeyRelayToBrowserFrame) => void;
}

interface ControllerRegistration extends SecurityKeyControllerBinding {
  platform: "macos" | "windows";
  capability: "security-key" | "platform-passkey";
  registeredAt: number;
  heartbeatAt: number | null;
  heartbeatSequence: number;
  send: (frame: SecurityKeyRelayToControllerFrame) => void;
}

interface ActiveCeremony {
  ceremonyId: string;
  chromeRequestId: number;
  requestHash: string;
  kind: "create" | "get";
  requestDetailsJson: string;
  expectedChallenge: string;
  origin: string;
  rpId: string;
  botLabel: string;
  taskLabel: string;
  deadline: number;
  consentApproved: boolean;
  state: "awaiting-consent" | "select-device" | "waiting-for-touch" | "waiting-for-pin";
  browser: SecurityKeyBrowserBinding;
  controller: SecurityKeyControllerBinding;
}

export class SecurityKeyRelayManager {
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly ceremonyTimeoutMs: number;
  private readonly registrationTimeoutMs: number;
  private readonly livenessTimeoutMs: number;
  private readonly pendingBrowsers = new Map<string, PendingRegistration>();
  private readonly pendingControllers = new Map<string, PendingRegistration>();
  private readonly browsers = new Map<string, BrowserRegistration>();
  private readonly controllers = new Map<string, ControllerRegistration>();
  private readonly events: SecurityKeyRelayEvent[] = [];
  private readonly retiredCeremonies = new Set<string>();
  private active: ActiveCeremony | null = null;
  private deadlineTimer: NodeJS.Timeout | null = null;
  private eventSequence = 0;

  constructor(options: SecurityKeyRelayOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomId;
    this.ceremonyTimeoutMs = validTimeout(options.ceremonyTimeoutMs ?? SECURITY_KEY_RELAY_CEREMONY_TIMEOUT_MS);
    this.registrationTimeoutMs = validTimeout(options.registrationTimeoutMs ?? SECURITY_KEY_RELAY_REGISTRATION_TIMEOUT_MS);
    this.livenessTimeoutMs = validTimeout(options.livenessTimeoutMs ?? SECURITY_KEY_RELAY_LIVENESS_TIMEOUT_MS);
  }

  beginBrowserRegistration(connectionId: string): SecurityKeyBrowserRegistrationStart {
    const pending = this.beginRegistration(this.pendingBrowsers, connectionId);
    return {
      binding: pending.binding,
      frame: { type: "relay.challenge", protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION, challenge: pending.challenge, expiresAt: pending.expiresAt },
    };
  }

  beginControllerRegistration(connectionId: string): SecurityKeyControllerRegistrationStart {
    const pending = this.beginRegistration(this.pendingControllers, connectionId);
    return {
      binding: pending.binding,
      frame: { type: "relay.challenge", protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION, challenge: pending.challenge, expiresAt: pending.expiresAt },
    };
  }

  completeBrowserRegistration(
    binding: SecurityKeyRelayBinding,
    frame: Extract<SecurityKeyBrowserToRelayFrame, { type: "browser.register" }>,
    send: BrowserRegistration["send"],
  ): SecurityKeyBrowserBinding {
    const pending = this.consumePending(this.pendingBrowsers, binding, frame.challengeResponse);
    this.disconnectBrowser(binding.connectionId, "registration-replaced");
    for (const registration of this.browsers.values()) {
      if (registration.botId === frame.botId && registration.targetKey === frame.targetKey) {
        this.disconnectBrowser(registration.connectionId, "registration-replaced");
      }
    }
    if (this.browsers.size >= MAX_LIVE_REGISTRATIONS) throw this.reject("browser registration capacity reached");
    const registration: BrowserRegistration = {
      connectionId: pending.connectionId,
      registrationEpoch: pending.registrationEpoch,
      botId: frame.botId,
      targetKey: frame.targetKey,
      vmGeneration: frame.vmGeneration,
      browserGeneration: frame.browserGeneration,
      extensionId: frame.extensionId,
      registeredAt: this.now(),
      heartbeatAt: null,
      heartbeatSequence: -1,
      send,
    };
    this.browsers.set(registration.connectionId, registration);
    try {
      send({
        type: "browser.ready",
        protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION,
        browserGeneration: registration.browserGeneration,
        heartbeatIntervalMs: SECURITY_KEY_RELAY_HEARTBEAT_INTERVAL_MS,
      });
    } catch {
      this.browsers.delete(registration.connectionId);
      throw this.reject("browser transport failed during registration");
    }
    this.record("registered", "browser");
    return browserBinding(registration);
  }

  completeControllerRegistration(
    binding: SecurityKeyRelayBinding,
    frame: Extract<SecurityKeyControllerToRelayFrame, { type: "controller.register" }>,
    send: ControllerRegistration["send"],
  ): SecurityKeyControllerBinding {
    const pending = this.consumePending(this.pendingControllers, binding, frame.challengeResponse);
    this.disconnectController(binding.connectionId, "registration-replaced");
    if (this.controllers.size >= MAX_LIVE_REGISTRATIONS) throw this.reject("controller registration capacity reached");
    const registration: ControllerRegistration = {
      connectionId: pending.connectionId,
      registrationEpoch: pending.registrationEpoch,
      controllerGeneration: frame.controllerGeneration,
      platform: frame.platform,
      capability: frame.capability,
      registeredAt: this.now(),
      heartbeatAt: null,
      heartbeatSequence: -1,
      send,
    };
    this.controllers.set(registration.connectionId, registration);
    try {
      send({
        type: "controller.ready",
        protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION,
        controllerGeneration: registration.controllerGeneration,
        heartbeatIntervalMs: SECURITY_KEY_RELAY_HEARTBEAT_INTERVAL_MS,
      });
    } catch {
      this.controllers.delete(registration.connectionId);
      throw this.reject("controller transport failed during registration");
    }
    this.record("registered", "controller");
    return controllerBinding(registration);
  }

  heartbeatBrowser(binding: SecurityKeyBrowserBinding, frame: Extract<SecurityKeyBrowserToRelayFrame, { type: "browser.heartbeat" }>): void {
    const registration = this.requireBrowser(binding);
    if (frame.browserGeneration !== registration.browserGeneration || frame.sequence <= registration.heartbeatSequence) {
      throw this.reject("stale browser heartbeat");
    }
    registration.heartbeatSequence = frame.sequence;
    registration.heartbeatAt = this.now();
    this.record("heartbeat", "browser");
  }

  heartbeatController(binding: SecurityKeyControllerBinding, frame: Extract<SecurityKeyControllerToRelayFrame, { type: "controller.heartbeat" }>): void {
    const registration = this.requireController(binding);
    if (frame.controllerGeneration !== registration.controllerGeneration || frame.sequence <= registration.heartbeatSequence) {
      throw this.reject("stale controller heartbeat");
    }
    registration.heartbeatSequence = frame.sequence;
    registration.heartbeatAt = this.now();
    this.record("heartbeat", "controller");
  }

  async startCeremony(input: {
    browser: SecurityKeyBrowserBinding;
    controller: SecurityKeyControllerBinding;
    frame: Extract<SecurityKeyBrowserToRelayFrame, { type: "browser.request" }>;
    trusted: { botId: string; targetKey: string; vmGeneration: number; browserGeneration: number };
    origin: string;
    rpId: string;
    botLabel: string;
    taskLabel: string;
  }): Promise<{ ceremonyId: string; requestHash: string; deadline: number }> {
    this.sweep();
    if (this.active) throw this.reject("another security-key ceremony is active");
    const browser = this.requireEligibleBrowser(input.browser);
    const controller = this.requireEligibleController(input.controller);
    const frame = input.frame;
    if (this.retiredCeremonies.has(frame.ceremonyId)) throw this.reject("ceremony identifier has already been retired");
    if (frame.ceremonyId.length < 16 || frame.botId !== browser.botId || frame.targetKey !== browser.targetKey
      || frame.vmGeneration !== browser.vmGeneration || frame.browserGeneration !== browser.browserGeneration
      || input.trusted.botId !== browser.botId || input.trusted.targetKey !== browser.targetKey
      || input.trusted.vmGeneration !== browser.vmGeneration || input.trusted.browserGeneration !== browser.browserGeneration) {
      throw this.reject("browser request generation fence mismatch");
    }
    const origin = normalizeSecurityKeyOrigin(input.origin);
    const rpId = validateRpIdForOrigin(input.rpId, origin);
    const request = parseRequestDetails(frame.requestDetailsJson, frame.kind, rpId);
    const requestHash = await hashCanonicalRequestJson(frame.requestDetailsJson);
    // An awaited hash must not let a second caller or reconnect steal authority.
    if (this.active || this.browsers.get(browser.connectionId) !== browser || this.controllers.get(controller.connectionId) !== controller) {
      throw this.reject("registration changed while starting ceremony");
    }
    const deadline = this.now() + this.ceremonyTimeoutMs;
    this.active = {
      ceremonyId: frame.ceremonyId,
      chromeRequestId: frame.chromeRequestId,
      requestHash,
      kind: frame.kind,
      requestDetailsJson: frame.requestDetailsJson,
      expectedChallenge: request.challenge,
      origin,
      rpId,
      botLabel: boundedLabel(input.botLabel, 160, "botLabel"),
      taskLabel: boundedLabel(input.taskLabel, 240, "taskLabel"),
      deadline,
      consentApproved: false,
      state: "awaiting-consent",
      browser: browserBinding(browser),
      controller: controllerBinding(controller),
    };
    try {
      controller.send({
        type: "controller.ceremony",
        protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION,
        controllerGeneration: controller.controllerGeneration,
        ceremonyId: frame.ceremonyId,
        requestHash,
        kind: frame.kind,
        requestDetailsJson: frame.requestDetailsJson,
        origin,
        rpId,
        botLabel: this.active.botLabel,
        taskLabel: this.active.taskLabel,
        deadline,
      });
    } catch {
      this.sendBrowserError(this.active, "internal");
      this.clearActive();
      throw this.reject("selected controller transport failed");
    }
    this.deadlineTimer = setTimeout(() => this.sweep(), this.ceremonyTimeoutMs);
    this.deadlineTimer.unref?.();
    this.record("started", "ceremony", frame.ceremonyId);
    return { ceremonyId: frame.ceremonyId, requestHash, deadline };
  }

  handleBrowserCancel(
    binding: SecurityKeyBrowserBinding,
    frame: Extract<SecurityKeyBrowserToRelayFrame, { type: "browser.cancel" }>,
  ): boolean {
    const browser = this.requireBrowser(binding);
    const active = this.active;
    if (!active || !sameBrowser(active.browser, browser) || frame.ceremonyId !== active.ceremonyId
      || frame.chromeRequestId !== active.chromeRequestId || frame.botId !== browser.botId || frame.targetKey !== browser.targetKey
      || frame.vmGeneration !== browser.vmGeneration || frame.browserGeneration !== browser.browserGeneration) {
      throw this.reject("browser cancellation does not own active ceremony");
    }
    this.cancelActive("browser-cancelled", false);
    return true;
  }

  handleControllerFrame(binding: SecurityKeyControllerBinding, frame: Exclude<SecurityKeyControllerToRelayFrame,
    { type: "controller.register" | "controller.heartbeat" }>): void {
    const controller = this.requireController(binding);
    const active = this.active;
    if (!active || !sameController(active.controller, controller) || frame.controllerGeneration !== controller.controllerGeneration
      || frame.ceremonyId !== active.ceremonyId || frame.requestHash !== active.requestHash) {
      throw this.reject("controller response does not own active ceremony");
    }
    if (frame.type === "controller.status") {
      if (!active.consentApproved) throw this.reject("controller status arrived before attended consent");
      active.state = frame.status;
      this.record("status", "ceremony", active.ceremonyId, frame.status);
      return;
    }
    if (frame.type === "controller.consent") {
      if (frame.decision === "declined") {
        this.finishWithBrowserError("not-allowed", "cancelled");
      } else {
        active.consentApproved = true;
        this.record("status", "ceremony", active.ceremonyId, "consent-approved");
      }
      return;
    }
    if (frame.type === "controller.cancelled") {
      this.finishWithBrowserError("aborted", "cancelled");
      return;
    }
    if (frame.type === "controller.error") {
      this.finishWithBrowserError(controllerErrorCode(frame.code), "completed");
      return;
    }
    if (!active.consentApproved) throw this.reject("controller result arrived before attended consent");
    if (frame.kind !== active.kind) throw this.reject("controller result ceremony kind mismatch");
    const response = parseControllerResponse(frame.responseJson);
    validateClientDataJson({
      clientDataJSON: response.clientDataJSON,
      expectedKind: active.kind,
      expectedChallenge: active.expectedChallenge,
      expectedOrigin: active.origin,
    });
    const browser = this.requireBrowser(active.browser);
    try {
      browser.send({
        type: "browser.result",
        protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION,
        ceremonyId: active.ceremonyId,
        chromeRequestId: active.chromeRequestId,
        responseJson: frame.responseJson,
      });
      this.record("completed", "ceremony", active.ceremonyId);
    } finally {
      this.clearActive();
    }
  }

  disconnectBrowser(connectionId: string, reason: "registration-replaced" | "protocol-error" = "protocol-error"): boolean {
    this.pendingBrowsers.delete(connectionId);
    const browser = this.browsers.get(connectionId);
    if (!browser) return false;
    if (this.active && sameBrowser(this.active.browser, browser)) this.cancelActive("target-replaced", false);
    this.browsers.delete(connectionId);
    try { browser.send({ type: "browser.detach", protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION, reason }); } catch { /* disconnected */ }
    this.record("disconnected", "browser");
    return true;
  }

  disconnectController(connectionId: string, _reason: "registration-replaced" | "protocol-error" = "protocol-error"): boolean {
    this.pendingControllers.delete(connectionId);
    const controller = this.controllers.get(connectionId);
    if (!controller) return false;
    if (this.active && sameController(this.active.controller, controller)) this.cancelActive("target-replaced", true);
    this.controllers.delete(connectionId);
    this.record("disconnected", "controller");
    return true;
  }

  cancelForTrustedTarget(input: { botId: string; targetKey: string; vmGeneration: number; browserGeneration: number }, reason: "turn-ended" | "target-replaced"): boolean {
    const active = this.active;
    if (!active || active.browser.botId !== input.botId || active.browser.targetKey !== input.targetKey
      || active.browser.vmGeneration !== input.vmGeneration || active.browser.browserGeneration !== input.browserGeneration) return false;
    this.cancelActive(reason, true);
    return true;
  }

  sweep(): void {
    const now = this.now();
    for (const [key, pending] of this.pendingBrowsers) if (pending.expiresAt <= now) this.pendingBrowsers.delete(key);
    for (const [key, pending] of this.pendingControllers) if (pending.expiresAt <= now) this.pendingControllers.delete(key);
    // Complete the globally bounded ceremony before pruning peers whose last
    // heartbeat expired in the same sweep. That preserves the exact timeout
    // outcome for a browser that is still writable at its deadline.
    if (this.active && this.active.deadline <= now) {
      const id = this.active.ceremonyId;
      this.cancelActive("deadline", true);
      this.record("expired", "ceremony", id);
    }
    for (const registration of this.browsers.values()) {
      const livenessBase = registration.heartbeatAt ?? registration.registeredAt;
      if (livenessBase + this.livenessTimeoutMs <= now) this.disconnectBrowser(registration.connectionId);
    }
    for (const registration of this.controllers.values()) {
      const livenessBase = registration.heartbeatAt ?? registration.registeredAt;
      if (livenessBase + this.livenessTimeoutMs <= now) this.disconnectController(registration.connectionId);
    }
  }

  shutdown(): void {
    if (this.active) this.cancelActive("server-shutdown", true);
    for (const browser of this.browsers.values()) {
      try { browser.send({ type: "browser.detach", protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION, reason: "server-shutdown" }); } catch { /* disconnected */ }
    }
    this.pendingBrowsers.clear(); this.pendingControllers.clear(); this.browsers.clear(); this.controllers.clear();
    this.retiredCeremonies.clear();
  }

  status(): SecurityKeyRelayStatus {
    this.sweep();
    const now = this.now();
    return {
      browserCount: this.browsers.size,
      controllerCount: this.controllers.size,
      eligibleBrowserCount: [...this.browsers.values()].filter((entry) => eligible(entry, now, this.livenessTimeoutMs)).length,
      eligibleControllerCount: [...this.controllers.values()].filter((entry) => eligible(entry, now, this.livenessTimeoutMs)).length,
      activeCeremony: this.active ? {
        ceremonyId: this.active.ceremonyId,
        botId: this.active.browser.botId,
        kind: this.active.kind,
        state: this.active.state,
        deadline: this.active.deadline,
      } : null,
      events: this.events.map((event) => ({ ...event })),
    };
  }

  private beginRegistration(
    pendingMap: Map<string, PendingRegistration>,
    connectionId: string,
  ) {
    if (!connectionId.trim()) throw new TypeError("connectionId must be non-empty");
    if (!pendingMap.has(connectionId) && pendingMap.size >= MAX_PENDING_REGISTRATIONS) throw this.reject("registration challenge capacity reached");
    const registrationEpoch = this.idFactory();
    const challenge = this.idFactory();
    assertOpaqueId(registrationEpoch); assertOpaqueId(challenge);
    const expiresAt = this.now() + this.registrationTimeoutMs;
    pendingMap.set(connectionId, { connectionId, registrationEpoch, challenge, expiresAt });
    return { binding: { connectionId, registrationEpoch }, challenge, expiresAt };
  }

  private consumePending(map: Map<string, PendingRegistration>, binding: SecurityKeyRelayBinding, response: string): PendingRegistration {
    const pending = map.get(binding.connectionId);
    map.delete(binding.connectionId);
    if (!pending || pending.registrationEpoch !== binding.registrationEpoch || pending.expiresAt <= this.now() || pending.challenge !== response) {
      throw this.reject("invalid or expired registration challenge");
    }
    return pending;
  }

  private requireBrowser(binding: SecurityKeyBrowserBinding): BrowserRegistration {
    const registration = this.browsers.get(binding.connectionId);
    if (!registration || !sameBrowser(binding, registration)) throw this.reject("stale browser registration");
    return registration;
  }

  private requireController(binding: SecurityKeyControllerBinding): ControllerRegistration {
    const registration = this.controllers.get(binding.connectionId);
    if (!registration || !sameController(binding, registration)) throw this.reject("stale controller registration");
    return registration;
  }

  private requireEligibleBrowser(binding: SecurityKeyBrowserBinding): BrowserRegistration {
    const registration = this.requireBrowser(binding);
    if (!eligible(registration, this.now(), this.livenessTimeoutMs)) throw this.reject("browser has not completed a live heartbeat");
    return registration;
  }

  private requireEligibleController(binding: SecurityKeyControllerBinding): ControllerRegistration {
    const registration = this.requireController(binding);
    if (!eligible(registration, this.now(), this.livenessTimeoutMs)) throw this.reject("controller has not completed a live heartbeat");
    return registration;
  }

  private cancelActive(reason: Extract<SecurityKeyRelayToControllerFrame, { type: "controller.cancel" }>["reason"], notifyBrowser: boolean): void {
    const active = this.active;
    if (!active) return;
    const controller = this.controllers.get(active.controller.connectionId);
    if (controller && sameController(active.controller, controller)) {
      try { controller.send({ type: "controller.cancel", protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION, controllerGeneration: controller.controllerGeneration, ceremonyId: active.ceremonyId, requestHash: active.requestHash, reason }); } catch { /* disconnected */ }
    }
    if (notifyBrowser) this.sendBrowserError(active, reason === "deadline" ? "timeout" : "aborted");
    this.record("cancelled", "ceremony", active.ceremonyId, reason);
    this.clearActive();
  }

  private finishWithBrowserError(code: Extract<SecurityKeyRelayToBrowserFrame, { type: "browser.error" }>["code"], event: "cancelled" | "completed"): void {
    const active = this.active;
    if (!active) return;
    this.sendBrowserError(active, code);
    this.record(event, "ceremony", active.ceremonyId, code);
    this.clearActive();
  }

  private sendBrowserError(active: ActiveCeremony, code: Extract<SecurityKeyRelayToBrowserFrame, { type: "browser.error" }>["code"]): void {
    const browser = this.browsers.get(active.browser.connectionId);
    if (!browser || !sameBrowser(active.browser, browser)) return;
    try { browser.send({ type: "browser.error", protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION, ceremonyId: active.ceremonyId, chromeRequestId: active.chromeRequestId, code }); } catch { /* disconnected */ }
  }

  private reject(message: string): Error {
    this.record("rejected", "ceremony", undefined, safeCode(message));
    return new Error(message);
  }

  private clearActive(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
    if (this.active) {
      this.retiredCeremonies.delete(this.active.ceremonyId);
      this.retiredCeremonies.add(this.active.ceremonyId);
      while (this.retiredCeremonies.size > MAX_RETIRED_CEREMONIES) {
        const oldest = this.retiredCeremonies.values().next().value;
        if (oldest === undefined) break;
        this.retiredCeremonies.delete(oldest);
      }
    }
    this.active = null;
  }

  private record(type: SecurityKeyRelayEvent["type"], peer: SecurityKeyRelayEvent["peer"], ceremonyId?: string, code?: string): void {
    const event: RelayEventDraft = {
      sequence: ++this.eventSequence, at: this.now(), type, peer,
    };
    if (ceremonyId) event.ceremonyId = ceremonyId;
    if (code) event.code = safeCode(code);
    this.events.push(event);
    if (this.events.length > MAX_STATUS_EVENTS) this.events.splice(0, this.events.length - MAX_STATUS_EVENTS);
  }
}

const requestPublicKeySchema = z.object({
  challenge: z.string(),
  rpId: z.string().optional(),
  rp: z.object({ id: z.string().optional() }).passthrough().optional(),
}).passthrough();
const requestDetailsSchema = z.union([
  z.object({ publicKey: requestPublicKeySchema }).passthrough().transform((value) => value.publicKey),
  requestPublicKeySchema,
]);
const controllerResponseSchema = z.union([
  z.object({ response: z.object({ clientDataJSON: z.string() }).passthrough() }).passthrough().transform((value) => value.response),
  z.object({ clientDataJSON: z.string() }).passthrough(),
]);

function parseRequestDetails(json: string, kind: "create" | "get", rpId: string) {
  const publicKey = requestDetailsSchema.parse(JSON.parse(json));
  decodeCanonicalBase64url(publicKey.challenge, { minBytes: 16, maxBytes: 1024 });
  const requestRpId = kind === "create"
    ? publicKey.rp?.id
    : publicKey.rpId;
  if (requestRpId !== undefined && requestRpId !== rpId) throw new Error("request RP ID mismatch");
  return { challenge: publicKey.challenge };
}

function parseControllerResponse(json: string) {
  return controllerResponseSchema.parse(JSON.parse(json));
}

function eligible(registration: { heartbeatAt: number | null }, now: number, timeout: number): boolean {
  return registration.heartbeatAt !== null && registration.heartbeatAt + timeout > now;
}

function browserBinding(registration: SecurityKeyBrowserBinding): SecurityKeyBrowserBinding {
  return { connectionId: registration.connectionId, registrationEpoch: registration.registrationEpoch, botId: registration.botId, targetKey: registration.targetKey, vmGeneration: registration.vmGeneration, browserGeneration: registration.browserGeneration };
}

function controllerBinding(registration: SecurityKeyControllerBinding): SecurityKeyControllerBinding {
  return { connectionId: registration.connectionId, registrationEpoch: registration.registrationEpoch, controllerGeneration: registration.controllerGeneration };
}

function sameBrowser(left: SecurityKeyBrowserBinding, right: SecurityKeyBrowserBinding): boolean {
  return left.connectionId === right.connectionId && left.registrationEpoch === right.registrationEpoch && left.botId === right.botId
    && left.targetKey === right.targetKey && left.vmGeneration === right.vmGeneration && left.browserGeneration === right.browserGeneration;
}

function sameController(left: SecurityKeyControllerBinding, right: SecurityKeyControllerBinding): boolean {
  return left.connectionId === right.connectionId && left.registrationEpoch === right.registrationEpoch && left.controllerGeneration === right.controllerGeneration;
}

function controllerErrorCode(code: Extract<SecurityKeyControllerToRelayFrame, { type: "controller.error" }>["code"]): Extract<SecurityKeyRelayToBrowserFrame, { type: "browser.error" }>["code"] {
  if (code === "timeout") return "timeout";
  if (code === "not-allowed" || code === "no-device" || code === "pin-invalid" || code === "pin-blocked") return "not-allowed";
  return "internal";
}

function boundedLabel(value: string, max: number, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\r\n\0]/u.test(trimmed)) throw new TypeError(`${label} is invalid`);
  return trimmed;
}

function safeCode(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 64) || "unknown";
}

function validTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("relay timeout must be a positive integer");
  return value;
}

function assertOpaqueId(value: string): void {
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(value)) throw new TypeError("idFactory returned an invalid opaque id");
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Buffer.from(bytes).toString("base64url");
}
