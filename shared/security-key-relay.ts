import { z } from "zod";

/* oxlint-disable anti-slop/no-runtime-typeof -- This module is the transport boundary: it distinguishes serialized text/bytes before exact Zod parsing. */

/** Wire protocol for the attended hardware-security-key relay. */
export const SECURITY_KEY_RELAY_PROTOCOL_VERSION = "1" as const;
export const SECURITY_KEY_RELAY_MAX_FRAME_BYTES = 256 * 1024;
export const SECURITY_KEY_RELAY_MAX_REQUEST_JSON_BYTES = 128 * 1024;
export const SECURITY_KEY_RELAY_MAX_RESPONSE_JSON_BYTES = 128 * 1024;
export const SECURITY_KEY_RELAY_MAX_CLIENT_DATA_JSON_BYTES = 16 * 1024;
export const SECURITY_KEY_RELAY_CEREMONY_TIMEOUT_MS = 120_000;
export const SECURITY_KEY_RELAY_REGISTRATION_TIMEOUT_MS = 30_000;
export const SECURITY_KEY_RELAY_HEARTBEAT_INTERVAL_MS = 10_000;
export const SECURITY_KEY_RELAY_LIVENESS_TIMEOUT_MS = 30_000;

const id = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);
const targetKey = z.string().min(3).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
const vmGeneration = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const protocolVersion = z.literal(SECURITY_KEY_RELAY_PROTOCOL_VERSION);
const requestKind = z.enum(["create", "get"]);
const jsonText = (maxBytes: number) => z.string()
  .refine((value) => utf8ByteLength(value) <= maxBytes, `JSON exceeds ${maxBytes} bytes`)
  .refine((value) => {
    try {
      return z.record(z.string(), z.json()).safeParse(JSON.parse(value)).success;
    } catch {
      return false;
    }
  }, "value must be a JSON object");

export const securityKeyBrowserToRelayFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("browser.register"),
    protocolVersion,
    botId: id,
    targetKey,
    vmGeneration,
    browserGeneration: generation,
    extensionId: z.string().length(32).regex(/^[a-p]+$/),
    challengeResponse: id,
  }).strict(),
  z.object({
    type: z.literal("browser.request"),
    protocolVersion,
    ceremonyId: id,
    chromeRequestId: z.number().int().nonnegative().max(0x7fff_ffff),
    kind: requestKind,
    requestDetailsJson: jsonText(SECURITY_KEY_RELAY_MAX_REQUEST_JSON_BYTES),
    botId: id,
    targetKey,
    vmGeneration,
    browserGeneration: generation,
  }).strict(),
  z.object({
    type: z.literal("browser.cancel"),
    protocolVersion,
    ceremonyId: id,
    chromeRequestId: z.number().int().nonnegative().max(0x7fff_ffff),
    botId: id,
    targetKey,
    vmGeneration,
    browserGeneration: generation,
  }).strict(),
  z.object({
    type: z.literal("browser.heartbeat"),
    protocolVersion,
    browserGeneration: generation,
    sequence,
    sentAt: timestamp,
  }).strict(),
]);

export const securityKeyRelayToBrowserFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("relay.challenge"),
    protocolVersion,
    challenge: id,
    expiresAt: timestamp,
  }).strict(),
  z.object({
    type: z.literal("browser.ready"),
    protocolVersion,
    browserGeneration: generation,
    heartbeatIntervalMs: z.literal(SECURITY_KEY_RELAY_HEARTBEAT_INTERVAL_MS),
  }).strict(),
  z.object({
    type: z.literal("browser.result"),
    protocolVersion,
    ceremonyId: id,
    chromeRequestId: z.number().int().nonnegative().max(0x7fff_ffff),
    responseJson: jsonText(SECURITY_KEY_RELAY_MAX_RESPONSE_JSON_BYTES),
  }).strict(),
  z.object({
    type: z.literal("browser.error"),
    protocolVersion,
    ceremonyId: id,
    chromeRequestId: z.number().int().nonnegative().max(0x7fff_ffff),
    code: z.enum(["not-allowed", "invalid-state", "not-supported", "aborted", "timeout", "internal"]),
  }).strict(),
  z.object({
    type: z.literal("browser.detach"),
    protocolVersion,
    reason: z.enum(["controller-unavailable", "registration-replaced", "server-shutdown", "protocol-error"]),
  }).strict(),
]);

export const securityKeyControllerToRelayFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("controller.register"),
    protocolVersion,
    platform: z.enum(["macos", "windows"]),
    controllerGeneration: generation,
    capability: z.enum(["security-key", "platform-passkey"]),
    challengeResponse: id,
  }).strict(),
  z.object({
    type: z.literal("controller.heartbeat"),
    protocolVersion,
    controllerGeneration: generation,
    sequence,
    sentAt: timestamp,
  }).strict(),
  z.object({
    type: z.literal("controller.consent"),
    protocolVersion,
    controllerGeneration: generation,
    ceremonyId: id,
    requestHash: id,
    decision: z.enum(["approved", "declined"]),
  }).strict(),
  z.object({
    type: z.literal("controller.status"),
    protocolVersion,
    controllerGeneration: generation,
    ceremonyId: id,
    requestHash: id,
    status: z.enum(["select-device", "waiting-for-touch", "waiting-for-pin"]),
  }).strict(),
  z.object({
    type: z.literal("controller.result"),
    protocolVersion,
    controllerGeneration: generation,
    ceremonyId: id,
    requestHash: id,
    kind: requestKind,
    responseJson: jsonText(SECURITY_KEY_RELAY_MAX_RESPONSE_JSON_BYTES),
  }).strict(),
  z.object({
    type: z.literal("controller.error"),
    protocolVersion,
    controllerGeneration: generation,
    ceremonyId: id,
    requestHash: id,
    code: z.enum(["not-allowed", "no-device", "pin-invalid", "pin-blocked", "timeout", "internal"]),
  }).strict(),
  z.object({
    type: z.literal("controller.cancelled"),
    protocolVersion,
    controllerGeneration: generation,
    ceremonyId: id,
    requestHash: id,
  }).strict(),
]);

export const securityKeyRelayToControllerFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("relay.challenge"),
    protocolVersion,
    challenge: id,
    expiresAt: timestamp,
  }).strict(),
  z.object({
    type: z.literal("controller.ready"),
    protocolVersion,
    controllerGeneration: generation,
    heartbeatIntervalMs: z.literal(SECURITY_KEY_RELAY_HEARTBEAT_INTERVAL_MS),
  }).strict(),
  z.object({
    type: z.literal("controller.ceremony"),
    protocolVersion,
    controllerGeneration: generation,
    ceremonyId: id,
    requestHash: id,
    kind: requestKind,
    requestDetailsJson: jsonText(SECURITY_KEY_RELAY_MAX_REQUEST_JSON_BYTES),
    origin: z.string().min(1).max(2048),
    rpId: z.string().min(1).max(253),
    botLabel: z.string().min(1).max(160),
    taskLabel: z.string().min(1).max(240),
    deadline: timestamp,
  }).strict(),
  z.object({
    type: z.literal("controller.cancel"),
    protocolVersion,
    controllerGeneration: generation,
    ceremonyId: id,
    requestHash: id,
    reason: z.enum(["browser-cancelled", "deadline", "turn-ended", "target-replaced", "server-shutdown"]),
  }).strict(),
]);

export type SecurityKeyBrowserToRelayFrame = z.infer<typeof securityKeyBrowserToRelayFrameSchema>;
export type SecurityKeyRelayToBrowserFrame = z.infer<typeof securityKeyRelayToBrowserFrameSchema>;
export type SecurityKeyControllerToRelayFrame = z.infer<typeof securityKeyControllerToRelayFrameSchema>;
export type SecurityKeyRelayToControllerFrame = z.infer<typeof securityKeyRelayToControllerFrameSchema>;

// These exported functions are the I/O boundary; their strict schemas establish the domain contract.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function parseSecurityKeyBrowserFrame(input: unknown): SecurityKeyBrowserToRelayFrame {
  return parseFrame(input, securityKeyBrowserToRelayFrameSchema);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function parseSecurityKeyRelayBrowserFrame(input: unknown): SecurityKeyRelayToBrowserFrame {
  return parseFrame(input, securityKeyRelayToBrowserFrameSchema);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function parseSecurityKeyControllerFrame(input: unknown): SecurityKeyControllerToRelayFrame {
  return parseFrame(input, securityKeyControllerToRelayFrameSchema);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function parseSecurityKeyRelayControllerFrame(input: unknown): SecurityKeyRelayToControllerFrame {
  return parseFrame(input, securityKeyRelayToControllerFrameSchema);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters
function parseFrame<T>(input: unknown, schema: z.ZodType<T>): T {
  let value = input;
  if (typeof input === "string" || input instanceof Uint8Array) {
    const bytes = typeof input === "string" ? utf8ByteLength(input) : input.byteLength;
    if (bytes === 0 || bytes > SECURITY_KEY_RELAY_MAX_FRAME_BYTES) throw new Error("invalid security-key relay frame size");
    const text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("invalid security-key relay frame JSON");
    }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("invalid security-key relay frame");
  return parsed.data;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
