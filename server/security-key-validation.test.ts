import { describe, expect, it } from "vitest";
import {
  canonicalizeRequestJson,
  decodeCanonicalBase64url,
  encodeBase64url,
  hashCanonicalRequestJson,
  normalizeSecurityKeyOrigin,
  validateClientDataJson,
  validateRpIdForOrigin,
} from "../shared/security-key-validation.ts";

const challengeBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const challenge = encodeBase64url(challengeBytes);

type ClientDataOverride = Partial<{
  type: string;
  challenge: string;
  origin: string;
  crossOrigin: boolean;
  topOrigin: string;
}>;

function clientData(overrides: ClientDataOverride = {}): string {
  return encodeBase64url(new TextEncoder().encode(JSON.stringify({
    type: "webauthn.get",
    challenge,
    origin: "https://login.example.com",
    crossOrigin: false,
    ...overrides,
  })));
}

describe("security-key validation", () => {
  it("round-trips canonical base64url and rejects padding or aliases", () => {
    expect(decodeCanonicalBase64url(challenge)).toEqual(challengeBytes);
    expect(() => decodeCanonicalBase64url(`${challenge}=`)).toThrow();
    expect(() => decodeCanonicalBase64url("A")).toThrow();
    expect(() => decodeCanonicalBase64url("AA", { minBytes: 2 })).toThrow();
  });

  it("canonicalizes object keys recursively and hashes equivalent JSON equally", async () => {
    expect(canonicalizeRequestJson('{"z":1,"a":{"y":2,"x":3}}')).toBe('{"a":{"x":3,"y":2},"z":1}');
    await expect(hashCanonicalRequestJson('{"z":1,"a":2}')).resolves.toBe(
      await hashCanonicalRequestJson('{ "a": 2, "z": 1 }'),
    );
    expect(() => canonicalizeRequestJson("[]")).toThrow("request JSON must be an object");
  });

  it("normalizes only HTTPS origins and the explicit localhost HTTP exception", () => {
    expect(normalizeSecurityKeyOrigin("https://EXAMPLE.com:443")).toBe("https://example.com");
    expect(normalizeSecurityKeyOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeSecurityKeyOrigin("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(() => normalizeSecurityKeyOrigin("http://example.com")).toThrow();
    expect(() => normalizeSecurityKeyOrigin("https://example.com/login")).toThrow();
    expect(() => normalizeSecurityKeyOrigin("https://user@example.com")).toThrow();
  });

  it("accepts exact and registrable suffix RP IDs", () => {
    expect(validateRpIdForOrigin("login.example.com", "https://login.example.com")).toBe("login.example.com");
    expect(validateRpIdForOrigin("example.com", "https://login.example.com")).toBe("example.com");
    expect(validateRpIdForOrigin("localhost", "http://localhost:3000")).toBe("localhost");
  });

  it("rejects unrelated, public-suffix, private-suffix, and IP-parent RP IDs", () => {
    expect(() => validateRpIdForOrigin("evil.test", "https://login.example.com")).toThrow();
    expect(() => validateRpIdForOrigin("com", "https://login.example.com")).toThrow();
    expect(() => validateRpIdForOrigin("co.uk", "https://login.example.co.uk")).toThrow();
    expect(() => validateRpIdForOrigin("github.io", "https://tenant.github.io")).toThrow();
    expect(() => validateRpIdForOrigin("blogspot.com", "https://tenant.blogspot.com")).toThrow();
    expect(() => validateRpIdForOrigin("pages.dev", "https://tenant.pages.dev")).toThrow();
    expect(() => validateRpIdForOrigin("0.0.1", "https://127.0.0.1")).toThrow();
  });

  it("validates ceremony type, challenge, origin, and same-origin state", () => {
    expect(validateClientDataJson({
      clientDataJSON: clientData(),
      expectedKind: "get",
      expectedChallenge: challenge,
      expectedOrigin: "https://login.example.com:443",
    })).toEqual({
      type: "webauthn.get",
      challenge,
      origin: "https://login.example.com",
      crossOrigin: false,
    });
  });

  it("rejects mismatched, cross-origin, non-canonical, and malformed client data", () => {
    const base = { expectedKind: "get" as const, expectedChallenge: challenge, expectedOrigin: "https://login.example.com" };
    expect(() => validateClientDataJson({ ...base, clientDataJSON: clientData({ type: "webauthn.create" }) })).toThrow();
    expect(() => validateClientDataJson({ ...base, clientDataJSON: clientData({ challenge: encodeBase64url(new Uint8Array(32)) }) })).toThrow();
    expect(() => validateClientDataJson({ ...base, clientDataJSON: clientData({ origin: "https://evil.example" }) })).toThrow();
    expect(() => validateClientDataJson({ ...base, clientDataJSON: clientData({ crossOrigin: true }) })).toThrow();
    expect(() => validateClientDataJson({ ...base, clientDataJSON: `${clientData()}=` })).toThrow();
    expect(() => validateClientDataJson({ ...base, clientDataJSON: encodeBase64url(new TextEncoder().encode("not-json")) })).toThrow();
  });
});
