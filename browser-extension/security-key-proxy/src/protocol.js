export const NATIVE_HOST_NAME = "com.openmausbot.security_key_proxy";
export const PROTOCOL_VERSION = "1";
export const MAX_NATIVE_FRAME_BYTES = 256 * 1024;
export const MAX_REQUEST_JSON_BYTES = 128 * 1024;
export const MAX_RESPONSE_JSON_BYTES = 128 * 1024;
export const HANDSHAKE_TIMEOUT_MS = 5_000;
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const LIVENESS_TIMEOUT_MS = 30_000;

/* oxlint-disable anti-slop/no-runtime-typeof -- This dependency-free MV3 module is the native-messaging I/O boundary and must reject untrusted JavaScript values before they enter the controller domain. */

const IDENTIFIER = /^[A-Za-z0-9_-]{16,128}$/u;
const EXTENSION_ID = /^[a-p]{32}$/u;
const KINDS = new Set(["create", "get", "isUvpaa"]);
const ERROR_CODES = new Set(["not-allowed", "invalid-state", "not-supported", "aborted", "timeout", "internal"]);
const DETACH_REASONS = new Set(["controller-unavailable", "registration-replaced", "server-shutdown", "protocol-error"]);

export function makeHello(extensionId, nonce) {
  if (!EXTENSION_ID.test(extensionId) || !IDENTIFIER.test(nonce)) throw new Error("invalid proxy identity");
  return bounded({ type: "extension.hello", protocolVersion: PROTOCOL_VERSION, extensionId, nonce });
}

export function makeRequest(input) {
  const base = {
    type: "extension.request",
    protocolVersion: PROTOCOL_VERSION,
    sessionId: requireIdentifier(input.sessionId),
    ceremonyId: requireIdentifier(input.ceremonyId),
    chromeRequestId: requireRequestId(input.chromeRequestId),
    kind: requireKind(input.kind),
  };
  if (input.kind === "isUvpaa") return bounded(base);
  return bounded({ ...base, requestDetailsJson: requireJsonObject(input.requestDetailsJson, MAX_REQUEST_JSON_BYTES) });
}

export function makeCancel(input) {
  return bounded({
    type: "extension.cancel",
    protocolVersion: PROTOCOL_VERSION,
    sessionId: requireIdentifier(input.sessionId),
    ceremonyId: requireIdentifier(input.ceremonyId),
    chromeRequestId: requireRequestId(input.chromeRequestId),
  });
}

export function makeHeartbeat(sessionId, sequence, sentAt) {
  return bounded({
    type: "extension.heartbeat",
    protocolVersion: PROTOCOL_VERSION,
    sessionId: requireIdentifier(sessionId),
    sequence: requireSafeInteger(sequence),
    sentAt: requireSafeInteger(sentAt),
  });
}

export function parseBrokerMessage(value) {
  bounded(value);
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION || typeof value.type !== "string") {
    throw new Error("invalid broker frame");
  }
  switch (value.type) {
    case "broker.ready":
      exactKeys(value, ["type", "protocolVersion", "nonce", "sessionId", "heartbeatIntervalMs", "capabilities"]);
      requireIdentifier(value.nonce);
      requireIdentifier(value.sessionId);
      if (value.heartbeatIntervalMs !== HEARTBEAT_INTERVAL_MS) throw new Error("invalid heartbeat interval");
      if (!Array.isArray(value.capabilities) || value.capabilities.length !== 4 ||
          !["create", "get", "isUvpaa", "cancel"].every((capability) => value.capabilities.includes(capability)) ||
          new Set(value.capabilities).size !== 4) throw new Error("missing broker capability");
      return value;
    case "broker.result":
      exactKeys(value, ["type", "protocolVersion", "sessionId", "ceremonyId", "chromeRequestId", "kind", "responseJson"]);
      requireCommonResult(value);
      if (value.kind === "isUvpaa") throw new Error("invalid result kind");
      requireJsonObject(value.responseJson, MAX_RESPONSE_JSON_BYTES);
      return value;
    case "broker.error":
      exactKeys(value, ["type", "protocolVersion", "sessionId", "ceremonyId", "chromeRequestId", "kind", "code"]);
      requireCommonResult(value);
      if (!ERROR_CODES.has(value.code)) throw new Error("invalid broker error");
      return value;
    case "broker.uvpaa":
      exactKeys(value, ["type", "protocolVersion", "sessionId", "ceremonyId", "chromeRequestId", "isUvpaa"]);
      requireIdentifier(value.sessionId);
      requireIdentifier(value.ceremonyId);
      requireRequestId(value.chromeRequestId);
      if (typeof value.isUvpaa !== "boolean") throw new Error("invalid UVPAA result");
      return value;
    case "broker.heartbeat":
      exactKeys(value, ["type", "protocolVersion", "sessionId", "sequence", "sentAt"]);
      requireIdentifier(value.sessionId);
      requireSafeInteger(value.sequence);
      requireSafeInteger(value.sentAt);
      return value;
    case "broker.detach":
      exactKeys(value, ["type", "protocolVersion", "sessionId", "reason"]);
      requireIdentifier(value.sessionId);
      if (!DETACH_REASONS.has(value.reason)) throw new Error("invalid detach reason");
      return value;
    default:
      throw new Error("unknown broker frame");
  }
}

function requireCommonResult(value) {
  requireIdentifier(value.sessionId);
  requireIdentifier(value.ceremonyId);
  requireRequestId(value.chromeRequestId);
  requireKind(value.kind);
}

function requireKind(value) {
  if (!KINDS.has(value)) throw new Error("invalid ceremony kind");
  return value;
}

function requireIdentifier(value) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error("invalid identifier");
  return value;
}

function requireRequestId(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0x7fff_ffff) throw new Error("invalid Chrome request ID");
  return value;
}

function requireSafeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid integer");
  return value;
}

function requireJsonObject(value, maxBytes) {
  if (typeof value !== "string" || utf8Bytes(value) === 0 || utf8Bytes(value) > maxBytes) throw new Error("invalid JSON size");
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("invalid JSON");
  }
  if (!isRecord(parsed)) throw new Error("JSON payload must be an object");
  return value;
}

function bounded(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("native frame is not serializable");
  }
  if (typeof serialized !== "string" || utf8Bytes(serialized) === 0 || utf8Bytes(serialized) > MAX_NATIVE_FRAME_BYTES) {
    throw new Error("native frame outside byte limit");
  }
  return value;
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error("unexpected broker frame field");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}
