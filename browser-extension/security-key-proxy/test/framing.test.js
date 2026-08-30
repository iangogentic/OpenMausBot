import assert from "node:assert/strict";
import test from "node:test";
import { MAX_NATIVE_FRAME_BYTES } from "../src/protocol.js";
import { NativeMessageDecoder, encodeNativeMessage } from "../native-host/framing.js";

test("native framing survives split headers and bodies", () => {
  const messages = [];
  const decoder = new NativeMessageDecoder((message) => messages.push(message));
  const frame = encodeNativeMessage({ type: "health", value: true });
  decoder.push(frame.subarray(0, 2));
  decoder.push(frame.subarray(2, 7));
  decoder.push(frame.subarray(7));
  assert.deepEqual(messages, [{ type: "health", value: true }]);
});

test("native decoder rejects an oversized declaration before receiving a body", () => {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, MAX_NATIVE_FRAME_BYTES + 1, true);
  const decoder = new NativeMessageDecoder(() => assert.fail("oversized frame must not dispatch"));
  assert.throws(() => decoder.push(header), /byte limit/);
});

test("native encoder enforces the same ceiling", () => {
  assert.throws(() => encodeNativeMessage({ padding: "x".repeat(MAX_NATIVE_FRAME_BYTES) }), /byte limit/);
});
