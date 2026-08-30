import { describe, expect, it } from "vitest";
import {
  SECURITY_KEY_RELAY_HEARTBEAT_INTERVAL_MS,
  SECURITY_KEY_RELAY_MAX_FRAME_BYTES,
  SECURITY_KEY_RELAY_PROTOCOL_VERSION,
  parseSecurityKeyBrowserFrame,
  parseSecurityKeyControllerFrame,
  parseSecurityKeyRelayControllerFrame,
} from "../shared/security-key-relay.ts";

const id = "0123456789abcdef";

describe("security-key relay frames", () => {
  it("parses an exact browser request from text", () => {
    expect(parseSecurityKeyBrowserFrame(JSON.stringify({
      type: "browser.request",
      protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION,
      ceremonyId: id,
      chromeRequestId: 12,
      kind: "get",
      requestDetailsJson: "{}",
      botId: "bot_0123456789ab",
      targetKey: "target_0123456789",
      vmGeneration: 2,
      browserGeneration: 3,
    }))).toMatchObject({ type: "browser.request", kind: "get", chromeRequestId: 12 });
  });

  it("rejects unknown keys, stale protocol shapes, and invalid identifiers", () => {
    const base = {
      type: "controller.heartbeat",
      protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION,
      controllerGeneration: 1,
      sequence: 1,
      sentAt: 1,
    };
    expect(() => parseSecurityKeyControllerFrame({ ...base, credential: "secret" })).toThrow();
    expect(() => parseSecurityKeyControllerFrame({ ...base, protocolVersion: "2" })).toThrow();
    expect(() => parseSecurityKeyControllerFrame({ ...base, controllerGeneration: -1 })).toThrow();
  });

  it("rejects oversized serialized frames before JSON parsing", () => {
    expect(() => parseSecurityKeyBrowserFrame("x".repeat(SECURITY_KEY_RELAY_MAX_FRAME_BYTES + 1))).toThrow(
      "invalid security-key relay frame size",
    );
  });

  it("rejects malformed UTF-8 byte frames", () => {
    expect(() => parseSecurityKeyBrowserFrame(Uint8Array.from([0xc3, 0x28]))).toThrow();
  });

  it("binds result frames to controller generation, request hash, kind, and ceremony", () => {
    const parsed = parseSecurityKeyControllerFrame({
      type: "controller.result",
      protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION,
      controllerGeneration: 7,
      ceremonyId: id,
      requestHash: "hash_01234567890",
      kind: "create",
      responseJson: "{}",
    });
    expect(parsed).toMatchObject({
      type: "controller.result",
      controllerGeneration: 7,
      requestHash: "hash_01234567890",
      kind: "create",
    });
  });

  it("parses the bounded controller ceremony without exposing credentials", () => {
    const parsed = parseSecurityKeyRelayControllerFrame({
      type: "controller.ceremony",
      protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION,
      controllerGeneration: 4,
      ceremonyId: id,
      requestHash: "hash_01234567890",
      kind: "get",
      requestDetailsJson: "{}",
      origin: "https://login.example.com",
      rpId: "example.com",
      botLabel: "Hermes",
      taskLabel: "Sign in",
      deadline: 1000,
    });
    expect(parsed.type).toBe("controller.ceremony");
    expect(Object.keys(parsed)).not.toContain("credential");
  });

  it("requires the fixed heartbeat interval in ready frames", () => {
    const base = {
      type: "controller.ready",
      protocolVersion: SECURITY_KEY_RELAY_PROTOCOL_VERSION,
      controllerGeneration: 1,
      heartbeatIntervalMs: SECURITY_KEY_RELAY_HEARTBEAT_INTERVAL_MS,
    };
    expect(parseSecurityKeyRelayControllerFrame(base)).toEqual(base);
    expect(() => parseSecurityKeyRelayControllerFrame({ ...base, heartbeatIntervalMs: 1 })).toThrow();
  });
});
