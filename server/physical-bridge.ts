import { randomUUID } from "node:crypto";

import {
  COMPUTER_REQUEST_HELP_TOOL,
  MCP_MAX_PENDING_BYTES,
  MCP_MAX_PENDING_FRAMES,
  augmentToolsListResponse,
  createGateInterceptor,
  createLineSplitter,
  type GateInterceptor,
} from "./mcp-bridge.ts";
import type { ActionPermit } from "./control-client.ts";
import type { RawWebSocket } from "./raw-websocket.ts";

export const PHYSICAL_BRIDGE_PROTOCOL = 1;
export const PHYSICAL_BRIDGE_ORIGIN = "openmausbot://desktop-main";
export const PHYSICAL_BROKER_ORIGIN = "openmausbot://server-broker";
export const PHYSICAL_BRIDGE_PATH = "/api/internal/physical-bridge/register";
export const PHYSICAL_MCP_PATH = "/api/internal/physical-computer/mcp";
export const PHYSICAL_APPROVAL_TIMEOUT_MS = 125_000;
export const PHYSICAL_MAX_SESSIONS = 4;
export const PHYSICAL_MAX_BUFFERED_BYTES = 1024 * 1024;
// A decoded 1 MiB MCP line expands to about 1.34 MiB as base64 plus its
// strict JSON envelope. Keep the transport envelope separate from the MCP
// payload cap so valid screenshots are accepted without weakening the line
// parser's 1 MiB memory boundary.
export const PHYSICAL_MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;

type PhysicalPlatform = "darwin" | "win32";

export interface PhysicalRegistration {
  readonly registrationId: string;
  readonly platform: PhysicalPlatform;
  readonly executorGeneration: string;
}

export interface PhysicalSession {
  readonly sessionId: string;
  readonly registrationId: string;
  readonly backpressured: boolean;
  send(data: Buffer): boolean;
  onDrain(listener: () => void): () => void;
  pauseInput(): void;
  resumeInput(): void;
  close(reason?: string): void;
}

type SessionRecord = {
  readonly sessionId: string;
  readonly registrationId: string;
  readonly executorGeneration: string;
  readonly onData: (data: Buffer) => void;
  readonly onOpened: () => void;
  readonly onClose: (reason: string) => void;
  timer: ReturnType<typeof setTimeout> | null;
  spawnAuthorized: boolean;
  opened: boolean;
  closed: boolean;
  inputPaused: boolean;
};

type RegistrationRecord = PhysicalRegistration & {
  readonly socket: RawWebSocket;
  readonly sessions: Map<string, SessionRecord>;
  heartbeat: ReturnType<typeof setInterval> | null;
  lastSeenAt: number;
};

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && Object.keys(value).every((key) => expected.includes(key));
}

function validGeneration(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{32,64}$/i.test(value);
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{32,64}$/i.test(value);
}

function validDisplayLabel(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value === value.trim() && value.length > 0 &&
    Buffer.byteLength(value) <= maxBytes && !/[\u0000-\u001f\u007f]/.test(value);
}

function parseObject(data: Buffer): Record<string, unknown> | null {
  if (!data.length || data.length > PHYSICAL_MAX_ENVELOPE_BYTES) return null;
  try {
    const value: unknown = JSON.parse(data.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function decodeData(value: unknown): Buffer | null {
  if (typeof value !== "string" || value.length > Math.ceil(PHYSICAL_MAX_BUFFERED_BYTES * 4 / 3) + 8) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.length <= PHYSICAL_MAX_BUFFERED_BYTES ? decoded : null;
}

/** In-memory identity for the currently attached Mac/Windows main process.
 * Nothing in this registry is serialized. Replacing or losing the outbound
 * socket synchronously retires every MCP child tied to its executor epoch. */
export class PhysicalBridgeRegistry {
  private currentRecord: RegistrationRecord | null = null;
  private readonly listeners = new Set<(registration: PhysicalRegistration | null) => void>();
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly approvalTimeoutMs: number;

  constructor(options: {
    now?: () => number;
    idFactory?: () => string;
    approvalTimeoutMs?: number;
  } = {}) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? PHYSICAL_APPROVAL_TIMEOUT_MS;
  }

  get current(): PhysicalRegistration | null {
    const record = this.currentRecord;
    return record && record.socket.open
      ? Object.freeze({ registrationId: record.registrationId, platform: record.platform, executorGeneration: record.executorGeneration })
      : null;
  }

  onChange(listener: (registration: PhysicalRegistration | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The HTTP upgrade has already checked Host, Origin, and UI-session proof.
   * This second stage accepts one exact protocol registration frame. */
  attachAuthenticated(socket: RawWebSocket): void {
    let registered: RegistrationRecord | null = null;
    const registrationTimer = setTimeout(() => socket.close(1008, "registration timeout"), 5_000);
    registrationTimer.unref?.();
    const offMessage = socket.onMessage((message) => {
      if (message.binary) {
        socket.close(1003, "registration messages must be JSON");
        return;
      }
      const frame = parseObject(message.data);
      if (!registered) {
        if (
          !frame ||
          !exactKeys(frame, ["type", "protocol", "platform", "executorGeneration"]) ||
          frame.type !== "register" ||
          frame.protocol !== PHYSICAL_BRIDGE_PROTOCOL ||
          (frame.platform !== "darwin" && frame.platform !== "win32") ||
          !validGeneration(frame.executorGeneration)
        ) {
          socket.close(1008, "invalid registration");
          return;
        }
        clearTimeout(registrationTimer);
        registered = this.install(socket, frame.platform, frame.executorGeneration);
        return;
      }
      registered.lastSeenAt = this.now();
      this.handleRegisteredMessage(registered, frame);
    });
    socket.onClose(() => {
      clearTimeout(registrationTimer);
      offMessage();
      if (registered) this.disconnect(registered, "physical app disconnected");
    });
  }

  openSession(
    registrationId: string,
    callbacks: {
      botId?: string;
      botLabel?: string;
      taskLabel?: string;
      onOpened: () => void;
      onData: (data: Buffer) => void;
      onClose: (reason: string) => void;
    },
  ): PhysicalSession | null {
    const record = this.currentRecord;
    if (!record || record.registrationId !== registrationId || !record.socket.open) return null;
    if (callbacks.botId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(callbacks.botId)) return null;
    if (callbacks.botLabel !== undefined && !validDisplayLabel(callbacks.botLabel, 160)) return null;
    if (callbacks.taskLabel !== undefined && !validDisplayLabel(callbacks.taskLabel, 240)) return null;
    if (record.sessions.size >= PHYSICAL_MAX_SESSIONS) return null;
    const sessionId = this.idFactory();
    if (!validSessionId(sessionId) || record.sessions.has(sessionId)) return null;
    const session: SessionRecord = {
      sessionId,
      registrationId,
      executorGeneration: record.executorGeneration,
      onOpened: callbacks.onOpened,
      onData: callbacks.onData,
      onClose: callbacks.onClose,
      timer: null,
      spawnAuthorized: false,
      opened: false,
      closed: false,
      inputPaused: false,
    };
    session.timer = setTimeout(() => this.closeSession(record, session, "local approval timed out", true), this.approvalTimeoutMs);
    session.timer.unref?.();
    record.sessions.set(sessionId, session);
    if (!record.socket.sendText(JSON.stringify({
      type: "open",
      sessionId,
      registrationId,
      executorGeneration: record.executorGeneration,
      botId: callbacks.botId ?? "unknown",
      botLabel: callbacks.botLabel ?? "OpenMaus bot",
      taskLabel: callbacks.taskLabel ?? "Current task",
    }))) {
      this.closeSession(record, session, "physical app transport failed", false);
      return null;
    }
    return Object.freeze({
      sessionId,
      registrationId,
      get backpressured() { return record.socket.backpressured; },
      send: (data: Buffer) => {
        if (
          session.closed ||
          !session.opened ||
          data.length > PHYSICAL_MAX_BUFFERED_BYTES ||
          this.currentRecord !== record ||
          !record.socket.open
        ) return false;
        return record.socket.sendText(JSON.stringify({ type: "data", sessionId, data: data.toString("base64") }));
      },
      onDrain: (listener: () => void) => record.socket.onDrain(listener),
      pauseInput: () => {
        if (session.closed || session.inputPaused) return;
        session.inputPaused = true;
        record.socket.pauseInput();
      },
      resumeInput: () => {
        if (!session.inputPaused) return;
        session.inputPaused = false;
        if (![...record.sessions.values()].some((candidate) => candidate.inputPaused)) {
          record.socket.resumeInput();
        }
      },
      close: (reason = "MCP session closed") => this.closeSession(record, session, reason, true),
    });
  }

  revokeRegistration(registrationId: string, reason = "physical registration revoked"): boolean {
    const record = this.currentRecord;
    if (!record || record.registrationId !== registrationId) return false;
    this.disconnect(record, reason);
    record.socket.close(1008, reason);
    return true;
  }

  closeAll(): void {
    const record = this.currentRecord;
    if (!record) return;
    this.disconnect(record, "server shutting down");
    record.socket.close(1001, "server shutting down");
  }

  private install(socket: RawWebSocket, platform: PhysicalPlatform, executorGeneration: string): RegistrationRecord {
    const old = this.currentRecord;
    if (old) {
      this.disconnect(old, "physical registration replaced");
      old.socket.close(1008, "physical registration replaced");
    }
    const record: RegistrationRecord = {
      registrationId: this.idFactory(),
      platform,
      executorGeneration,
      socket,
      sessions: new Map(),
      heartbeat: null,
      lastSeenAt: this.now(),
    };
    if (!validSessionId(record.registrationId)) {
      socket.close(1011, "registration identity unavailable");
      throw new Error("physical registration identity is invalid");
    }
    this.currentRecord = record;
    record.heartbeat = setInterval(() => {
      if (this.currentRecord !== record || !record.socket.open || this.now() - record.lastSeenAt > 45_000) {
        this.disconnect(record, "physical app heartbeat expired");
        record.socket.destroy();
        return;
      }
      record.socket.ping();
    }, 15_000);
    record.heartbeat.unref?.();
    record.socket.sendText(JSON.stringify({
      type: "registered",
      registrationId: record.registrationId,
      executorGeneration,
    }));
    this.emit(record);
    return record;
  }

  private handleRegisteredMessage(record: RegistrationRecord, frame: Record<string, unknown> | null): void {
    if (!frame) {
      record.socket.close(1008, "invalid bridge message");
      return;
    }
    if (exactKeys(frame, ["type"]) && frame.type === "heartbeat") return;
    if (
      exactKeys(frame, ["type", "executorGeneration"]) &&
      frame.type === "executor" &&
      validGeneration(frame.executorGeneration)
    ) {
      if (frame.executorGeneration !== record.executorGeneration) {
        this.disconnect(record, "CUA executor generation changed");
        // A new executor is a new authenticated registration, not an update
        // to an old identity. Force the desktop transport to reconnect so no
        // capability scoped to the retired registration can survive.
        record.socket.close(1008, "CUA executor generation changed");
      }
      return;
    }
    if (!validSessionId(frame.sessionId)) {
      record.socket.close(1008, "invalid bridge session");
      return;
    }
    const session = record.sessions.get(frame.sessionId);
    // A duplicate, late, or replayed session frame is a protocol violation.
    if (!session || session.closed || session.registrationId !== record.registrationId) {
      record.socket.close(1008, "stale bridge session");
      return;
    }
    if (
      exactKeys(frame, ["type", "sessionId", "executorGeneration"]) &&
      frame.type === "approved" &&
      frame.executorGeneration === session.executorGeneration &&
      !session.spawnAuthorized &&
      !session.opened
    ) {
      session.spawnAuthorized = true;
      record.socket.sendText(JSON.stringify({
        type: "spawn",
        sessionId: session.sessionId,
        executorGeneration: session.executorGeneration,
      }));
      return;
    }
    if (
      exactKeys(frame, ["type", "sessionId", "executorGeneration"]) &&
      frame.type === "opened" &&
      frame.executorGeneration === session.executorGeneration &&
      session.spawnAuthorized &&
      !session.opened
    ) {
      session.opened = true;
      if (session.timer) clearTimeout(session.timer);
      session.timer = null;
      session.onOpened();
      return;
    }
    if (exactKeys(frame, ["type", "sessionId"]) && frame.type === "denied" && !session.opened) {
      this.closeSession(record, session, "local approval denied", false);
      return;
    }
    if (exactKeys(frame, ["type", "sessionId"]) && frame.type === "closed") {
      this.closeSession(record, session, "local CUA session closed", false);
      return;
    }
    if (exactKeys(frame, ["type", "sessionId", "data"]) && frame.type === "data" && session.opened) {
      const data = decodeData(frame.data);
      if (!data) {
        record.socket.close(1009, "invalid bridge data");
        return;
      }
      session.onData(data);
      return;
    }
    record.socket.close(1008, "invalid bridge session state");
  }

  private closeSession(record: RegistrationRecord, session: SessionRecord, reason: string, notifyClient: boolean): void {
    if (session.closed) return;
    session.closed = true;
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    record.sessions.delete(session.sessionId);
    if (session.inputPaused) {
      session.inputPaused = false;
      if (![...record.sessions.values()].some((candidate) => candidate.inputPaused)) record.socket.resumeInput();
    }
    if (notifyClient && record.socket.open) {
      record.socket.sendText(JSON.stringify({ type: "close", sessionId: session.sessionId }));
    }
    session.onClose(reason);
  }

  private disconnect(record: RegistrationRecord, reason: string): void {
    if (record.heartbeat) clearInterval(record.heartbeat);
    record.heartbeat = null;
    for (const session of [...record.sessions.values()]) this.closeSession(record, session, reason, false);
    if (this.currentRecord === record) {
      this.currentRecord = null;
      this.emit(null);
    }
  }

  private emit(record: RegistrationRecord | null): void {
    const publicRecord = record
      ? Object.freeze({ registrationId: record.registrationId, platform: record.platform, executorGeneration: record.executorGeneration })
      : null;
    for (const listener of [...this.listeners]) listener(publicRecord);
  }
}

export interface PhysicalMcpAuthority {
  readonly capabilityToken: string;
  readonly registrationId: string;
  readonly botId: string;
  readonly botLabel?: string;
  readonly taskLabel?: string;
  readonly targetKey: "physical:host";
  readonly bridgeId: string;
}

type ApprovalFencePermit = { allowed: true; lifecycleId: string } | { allowed: false };

/** One target-wide approval fence shared by every physical MCP broker. The
 * first pending dialog drains older actions and acquires the server fence;
 * concurrent dialogs join it by exact reference. The target is unlocked only
 * after every dialog has been denied/closed or has produced a correlated
 * `opened` frame. */
export class PhysicalApprovalGate {
  private active: { lifecycleId: string; references: Set<string> } | null = null;
  private acquiring: Promise<string | null> | null = null;
  private readonly beginFence: () => ApprovalFencePermit | Promise<ApprovalFencePermit>;
  private readonly endFence: (lifecycleId: string) => boolean | Promise<boolean>;
  private readonly idFactory: () => string;

  constructor(options: {
    beginFence: () => ApprovalFencePermit | Promise<ApprovalFencePermit>;
    endFence: (lifecycleId: string) => boolean | Promise<boolean>;
    idFactory?: () => string;
  }) {
    this.beginFence = options.beginFence;
    this.endFence = options.endFence;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async acquire(): Promise<string | null> {
    if (!this.active) {
      if (!this.acquiring) {
        this.acquiring = Promise.resolve(this.beginFence())
          .then((permit) => {
            if (!permit.allowed) return null;
            this.active = { lifecycleId: permit.lifecycleId, references: new Set() };
            return permit.lifecycleId;
          })
          .finally(() => {
            this.acquiring = null;
          });
      }
      const lifecycleId = await this.acquiring;
      const acquired = this.active as { lifecycleId: string; references: Set<string> } | null;
      if (!lifecycleId || acquired?.lifecycleId !== lifecycleId) return null;
    }
    const active = this.active;
    if (!active) return null;
    const reference = this.idFactory();
    if (!validSessionId(reference) || active.references.has(reference)) return null;
    active.references.add(reference);
    return reference;
  }

  async release(reference: string): Promise<boolean> {
    const active = this.active;
    if (!active || !active.references.delete(reference)) return false;
    if (active.references.size) return true;
    const released = await this.endFence(active.lifecycleId);
    if (released && this.active === active && active.references.size === 0) this.active = null;
    return released;
  }
}

/** Gate and relay one provider stdio MCP WebSocket. The provider sees only
 * its exact-turn bearer. CUA command/socket details remain inside Electron,
 * and every tools/call obtains the normal ComputerControl action ticket
 * before a byte reaches the physical app. */
export function attachPhysicalMcpBroker(options: {
  broker: RawWebSocket;
  registry: PhysicalBridgeRegistry;
  authority: PhysicalMcpAuthority;
  stillAuthorized: () => boolean;
  beginAction: () => ActionPermit | Promise<ActionPermit>;
  endAction: (actionId: string) => boolean | Promise<boolean>;
  quarantine: () => void | Promise<void>;
  requestHelp: (reason: string) => Promise<{ text: string; isError?: boolean }>;
  approvalGate: PhysicalApprovalGate;
}): { close: (reason?: string) => void } | null {
  if (options.registry.current?.registrationId !== options.authority.registrationId) return null;
  let physical: PhysicalSession | null = null;
  let approvalReference: string | null = null;
  let closed = false;
  let opened = false;
  let pendingBytes = 0;
  const pending: Buffer[] = [];
  const pendingActions = new Map<string, string>();
  const pendingToolsList = new Set<string>();
  let outboundQueue: Promise<void> = Promise.resolve();
  let outboundPendingFrames = 0;
  let outboundPendingBytes = 0;
  let outboundFailed = false;
  let offBrokerDrain: () => void = () => {};
  let offPhysicalDrain: () => void = () => {};

  const finish = (reason: string, quarantine: boolean) => {
    if (closed) return;
    closed = true;
    offBrokerDrain();
    offPhysicalDrain();
    physical?.resumeInput();
    options.broker.resumeInput();
    if (approvalReference) {
      const reference = approvalReference;
      approvalReference = null;
      void options.approvalGate.release(reference).then((released) => {
        if (!released) void options.quarantine();
      });
    }
    physical?.close(reason);
    physical = null;
    if (quarantine && pendingActions.size) void options.quarantine();
    options.broker.close(1008, reason);
  };

  const emitBroker = (line: string) => {
    if (closed || !options.broker.open) return;
    if (!options.broker.sendBinary(Buffer.from(line + "\n"))) {
      finish("physical broker output queue exceeded its limit", pendingActions.size > 0);
      return;
    }
    if (options.broker.backpressured) physical?.pauseInput();
  };
  const queueForPhysical = (bytes: Buffer): boolean => {
    pendingBytes += bytes.length;
    if (pendingBytes > PHYSICAL_MAX_BUFFERED_BYTES) {
      finish("MCP physical-output queue exceeded its limit", pendingActions.size > 0);
      return false;
    }
    pending.push(bytes);
    return true;
  };
  const flushPhysicalQueue = () => {
    if (closed || !opened || !physical) return;
    while (pending.length && !physical.backpressured) {
      const bytes = pending.shift()!;
      pendingBytes -= bytes.length;
      if (!physical.send(bytes)) {
        finish("physical app transport failed", pendingActions.size > 0);
        return;
      }
    }
    if (physical.backpressured) options.broker.pauseInput();
  };
  const forwardPhysical = (line: string) => {
    if (closed) return;
    const bytes = Buffer.from(line + "\n");
    if (!opened || pending.length || physical?.backpressured) {
      if (!queueForPhysical(bytes)) return;
      flushPhysicalQueue();
      return;
    }
    if (!options.stillAuthorized() || !physical?.send(bytes)) {
      finish("physical authority expired", true);
      return;
    }
    if (physical.backpressured) options.broker.pauseInput();
  };
  const gate: GateInterceptor = createGateInterceptor({
    beginAction: async () => options.stillAuthorized()
      ? await options.beginAction()
      : { allowed: false, reason: "unavailable" },
    actionForwarded: (requestId, actionId) => pendingActions.set(requestId, actionId),
    actionAbandoned: async (actionId) => {
      if (!(await options.endAction(actionId))) await options.quarantine();
    },
    toolsListRequested: (requestId) => {
      if (pendingToolsList.size >= MCP_MAX_PENDING_FRAMES) {
        finish("too many unanswered physical MCP tool-list requests", pendingActions.size > 0);
        return;
      }
      pendingToolsList.add(requestId);
    },
    requestHelp: options.requestHelp,
    forward: forwardPhysical,
    refuse: emitBroker,
    onOverflow: () => finish("physical MCP request queue exceeded its limit", pendingActions.size > 0),
  });
  const inbound = createLineSplitter((line) => {
    if (Buffer.byteLength(line) > PHYSICAL_MAX_BUFFERED_BYTES) {
      finish("MCP frame exceeded its limit", false);
      return;
    }
    return gate(line);
  }, {
    maxLineBytes: PHYSICAL_MAX_BUFFERED_BYTES,
    onOverflow: () => finish("MCP frame exceeded its limit", pendingActions.size > 0),
  });
  const outbound = createLineSplitter((line) => {
    if (closed || outboundFailed) return false;
    const lineBytes = Buffer.byteLength(line) + 1;
    if (
      lineBytes > MCP_MAX_PENDING_BYTES ||
      outboundPendingFrames + 1 > MCP_MAX_PENDING_FRAMES ||
      outboundPendingBytes + lineBytes > MCP_MAX_PENDING_BYTES
    ) {
      outboundFailed = true;
      finish("physical MCP response queue exceeded its limit", pendingActions.size > 0);
      return false;
    }
    outboundPendingFrames += 1;
    outboundPendingBytes += lineBytes;
    const task = outboundQueue.then(async () => {
      if (closed || !options.stillAuthorized()) {
        finish("physical authority expired", true);
        return;
      }
      let frame: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(line);
        frame = parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : null;
      } catch {}
      const id = typeof frame?.id === "string" || typeof frame?.id === "number"
        ? `${typeof frame.id}:${String(frame.id)}`
        : null;
      if (id && ("result" in (frame ?? {}) || "error" in (frame ?? {}))) {
        const actionId = pendingActions.get(id);
        if (actionId) {
          if (!(await options.endAction(actionId))) {
            finish("computer control did not acknowledge the completed action", true);
            return;
          }
          pendingActions.delete(id);
        }
      }
      emitBroker(augmentToolsListResponse(line, pendingToolsList));
    });
    outboundQueue = task.catch(() => {
      finish("physical MCP response processing failed", pendingActions.size > 0);
    }).finally(() => {
      outboundPendingFrames -= 1;
      outboundPendingBytes -= lineBytes;
    });
    return true;
  }, {
    maxLineBytes: PHYSICAL_MAX_BUFFERED_BYTES,
    onOverflow: () => finish("physical MCP response exceeded its limit", pendingActions.size > 0),
  });

  offBrokerDrain = options.broker.onDrain(() => physical?.resumeInput());

  options.broker.onMessage((message) => {
    if (closed || !options.stillAuthorized()) {
      finish("physical authority expired", true);
      return;
    }
    if (message.data.length > PHYSICAL_MAX_BUFFERED_BYTES) {
      finish("MCP frame exceeded its limit", false);
      return;
    }
    inbound.push(message.data);
  });
  options.broker.onClose(() => {
    inbound.flush();
    void gate.drain().finally(() => {
      outbound.flush();
      void outboundQueue.finally(() => finish("provider MCP disconnected", pendingActions.size > 0));
    });
  });
  void options.approvalGate.acquire().then((reference) => {
    if (!reference) {
      finish("physical approval could not safely fence the desktop", false);
      return;
    }
    approvalReference = reference;
    if (closed || !options.stillAuthorized()) {
      finish("physical authority expired before approval", false);
      return;
    }
    physical = options.registry.openSession(options.authority.registrationId, {
      botId: options.authority.botId,
      botLabel: options.authority.botLabel,
      taskLabel: options.authority.taskLabel,
      onOpened: () => {
        if (closed || !options.stillAuthorized()) {
          finish("physical authority expired during approval", false);
          return;
        }
        const approvedReference = approvalReference;
        approvalReference = null;
        if (approvedReference) {
          void options.approvalGate.release(approvedReference).then((released) => {
            if (!released) {
              finish("physical approval fence could not be released", true);
              return;
            }
            opened = true;
            flushPhysicalQueue();
          });
        }
      },
      onData: (data) => outbound.push(data),
      onClose: (reason) => finish(reason, pendingActions.size > 0),
    });
    if (!physical) {
      finish("physical app unavailable during approval", false);
      return;
    }
    offPhysicalDrain = physical.onDrain(() => {
      flushPhysicalQueue();
      if (!physical?.backpressured) options.broker.resumeInput();
    });
  }).catch(() => finish("physical approval fence failed", false));
  return Object.freeze({ close: (reason = "physical MCP authority revoked") => finish(reason, pendingActions.size > 0) });
}

export { COMPUTER_REQUEST_HELP_TOOL };
