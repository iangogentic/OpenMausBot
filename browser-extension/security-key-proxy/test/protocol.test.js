import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_NATIVE_FRAME_BYTES,
  makeRequest,
  parseBrokerMessage,
} from "../src/protocol.js";

const sessionId = "session_abcdefghijklmnop";
const ceremonyId = "ceremony_abcdefghijklmnop";

test("accepts exact bounded broker results", () => {
  const frame = parseBrokerMessage({
    type: "broker.result",
    protocolVersion: "1",
    sessionId,
    ceremonyId,
    chromeRequestId: 7,
    kind: "get",
    responseJson: JSON.stringify({ id: "credential" }),
  });
  assert.equal(frame.kind, "get");
});

test("rejects extra fields and oversized native frames", () => {
  assert.throws(() => parseBrokerMessage({
    type: "broker.heartbeat",
    protocolVersion: "1",
    sessionId,
    sequence: 1,
    sentAt: 2,
    ceremonyContent: "must-not-pass",
  }), /unexpected/);
  assert.throws(() => parseBrokerMessage({
    type: "broker.detach",
    protocolVersion: "1",
    sessionId,
    reason: "protocol-error",
    padding: "x".repeat(MAX_NATIVE_FRAME_BYTES),
  }), /byte limit/);
});

test("UVPAA requests do not synthesize credential JSON", () => {
  assert.deepEqual(makeRequest({ sessionId, ceremonyId, chromeRequestId: 9, kind: "isUvpaa" }), {
    type: "extension.request",
    protocolVersion: "1",
    sessionId,
    ceremonyId,
    chromeRequestId: 9,
    kind: "isUvpaa",
  });
});
