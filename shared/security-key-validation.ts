import {
  SECURITY_KEY_RELAY_MAX_CLIENT_DATA_JSON_BYTES,
  SECURITY_KEY_RELAY_MAX_REQUEST_JSON_BYTES,
} from "./security-key-relay.ts";
import { z } from "zod";

/* oxlint-disable anti-slop/no-runtime-typeof -- canonicalJson discriminates an already Zod-validated recursive JSON domain union. */

export type SecurityKeyCeremonyKind = "create" | "get";

export interface ValidatedClientData {
  readonly type: "webauthn.create" | "webauthn.get";
  readonly challenge: string;
  readonly origin: string;
  readonly crossOrigin: false;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const clientDataSchema = z.object({
  type: z.string(),
  challenge: z.string(),
  origin: z.string(),
  crossOrigin: z.boolean().optional(),
  topOrigin: z.string().optional(),
}).passthrough();

const HIGH_RISK_PUBLIC_SUFFIXES = new Set([
  "com", "org", "net", "edu", "gov", "mil", "int", "io", "ai", "app", "dev", "xyz", "info", "biz", "me", "co",
  "co.uk", "org.uk", "me.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "co.nz", "net.nz", "org.nz", "ac.nz", "govt.nz",
  "co.za", "org.za", "net.za", "gov.za", "com.br", "net.br", "org.br", "gov.br", "com.cn", "net.cn", "org.cn", "gov.cn",
  "github.io", "gitlab.io", "pages.dev", "workers.dev", "appspot.com", "firebaseapp.com", "web.app", "vercel.app", "netlify.app",
]);

export function encodeBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export function decodeCanonicalBase64url(
  value: string,
  limits: { minBytes?: number; maxBytes?: number } = {},
): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) {
    throw new Error("invalid canonical base64url");
  }
  let decoded: string;
  try {
    const standard = value.replace(/-/g, "+").replace(/_/g, "/");
    decoded = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
  } catch {
    throw new Error("invalid canonical base64url");
  }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (encodeBase64url(bytes) !== value) throw new Error("non-canonical base64url");
  if (bytes.byteLength < (limits.minBytes ?? 0) || bytes.byteLength > (limits.maxBytes ?? Number.MAX_SAFE_INTEGER)) {
    throw new Error("base64url value outside byte limits");
  }
  return bytes;
}

export function canonicalizeRequestJson(requestDetailsJson: string): string {
  if (new TextEncoder().encode(requestDetailsJson).byteLength > SECURITY_KEY_RELAY_MAX_REQUEST_JSON_BYTES) {
    throw new Error("request JSON exceeds byte limit");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(requestDetailsJson);
  } catch {
    throw new Error("invalid request JSON");
  }
  const parsed = z.record(z.string(), z.json()).safeParse(decoded);
  if (!parsed.success) throw new Error("request JSON must be an object");
  return canonicalJson(parsed.data);
}

export async function hashCanonicalRequestJson(requestDetailsJson: string): Promise<string> {
  const canonical = canonicalizeRequestJson(requestDetailsJson);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return encodeBase64url(new Uint8Array(digest));
}

export function normalizeSecurityKeyOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid WebAuthn origin");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin === "null" || url.hostname.endsWith(".")) {
    throw new Error("WebAuthn origin must be an origin, not a URL");
  }
  const localhost = isLocalhost(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localhost)) {
    throw new Error("WebAuthn origin must use HTTPS or HTTP localhost");
  }
  return url.origin;
}

export function normalizeRpId(value: string): string {
  if (value.length === 0 || value.length > 253 || value.endsWith(".")) {
    throw new Error("invalid RP ID");
  }
  let url: URL;
  try {
    url = new URL(`https://${value}`);
  } catch {
    throw new Error("invalid RP ID");
  }
  if (url.hostname !== value.toLowerCase() || url.port || url.username || url.password || url.pathname !== "/") {
    throw new Error("invalid RP ID");
  }
  return url.hostname;
}

export function validateRpIdForOrigin(rpIdValue: string, originValue: string): string {
  const origin = new URL(normalizeSecurityKeyOrigin(originValue));
  const rpId = normalizeRpId(rpIdValue);
  const originHost = origin.hostname.toLowerCase();
  if (isIpAddress(originHost) || isLocalhost(originHost)) {
    if (rpId !== originHost) throw new Error("RP ID must exactly match a localhost or IP origin");
    return rpId;
  }
  if (rpId !== originHost && !originHost.endsWith(`.${rpId}`)) throw new Error("RP ID is not a suffix of the origin host");
  if (isConservativePublicSuffix(rpId)) throw new Error("RP ID must not be a public suffix");
  return rpId;
}

export function validateClientDataJson(input: {
  clientDataJSON: string;
  expectedKind: SecurityKeyCeremonyKind;
  expectedChallenge: string;
  expectedOrigin: string;
}): ValidatedClientData {
  const bytes = decodeCanonicalBase64url(input.clientDataJSON, {
    minBytes: 2,
    maxBytes: SECURITY_KEY_RELAY_MAX_CLIENT_DATA_JSON_BYTES,
  });
  const expectedChallenge = decodeCanonicalBase64url(input.expectedChallenge, { minBytes: 16, maxBytes: 1024 });
  let decodedJson: JsonValue;
  try {
    decodedJson = z.json().parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    throw new Error("invalid clientDataJSON");
  }
  const parsedResult = clientDataSchema.safeParse(decodedJson);
  if (!parsedResult.success) throw new Error("invalid clientDataJSON object");
  const parsed = parsedResult.data;
  const expectedType = input.expectedKind === "create" ? "webauthn.create" : "webauthn.get";
  if (parsed.type !== expectedType) throw new Error("clientDataJSON ceremony type mismatch");
  const actualChallenge = decodeCanonicalBase64url(parsed.challenge, { minBytes: 16, maxBytes: 1024 });
  if (!constantTimeEqual(actualChallenge, expectedChallenge)) throw new Error("clientDataJSON challenge mismatch");
  if (normalizeSecurityKeyOrigin(parsed.origin) !== normalizeSecurityKeyOrigin(input.expectedOrigin)) {
    throw new Error("clientDataJSON origin mismatch");
  }
  if (parsed.crossOrigin !== undefined && parsed.crossOrigin !== false) throw new Error("cross-origin WebAuthn is not allowed");
  if (parsed.topOrigin !== undefined) throw new Error("cross-origin topOrigin is not allowed");
  return {
    type: expectedType,
    challenge: parsed.challenge,
    origin: normalizeSecurityKeyOrigin(parsed.origin),
    crossOrigin: false,
  };
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("request JSON contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("request JSON contains an unsupported value");
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isIpAddress(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname) || hostname.startsWith("[");
}

function isConservativePublicSuffix(rpId: string): boolean {
  if (HIGH_RISK_PUBLIC_SUFFIXES.has(rpId)) return true;
  const labels = rpId.split(".");
  if (labels.length < 2) return true;
  const tld = labels.at(-1) ?? "";
  const secondLevel = labels.at(-2) ?? "";
  return labels.length === 2 && tld.length === 2 && new Set(["ac", "co", "com", "edu", "gov", "net", "org"]).has(secondLevel);
}
