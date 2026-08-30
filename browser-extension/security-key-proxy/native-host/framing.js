import { MAX_NATIVE_FRAME_BYTES } from "../src/protocol.js";

/* oxlint-disable anti-slop/no-runtime-typeof -- This helper is the native stdio byte-stream boundary and validates callback/byte representations before use. */

/**
 * Incremental Chrome native-messaging decoder. The four-byte length is validated
 * before a body buffer is allocated. Callers must terminate the helper on any throw.
 */
export class NativeMessageDecoder {
  #onMessage;
  #header = new Uint8Array(4);
  #headerBytes = 0;
  #body;
  #bodyBytes = 0;

  constructor(onMessage) {
    if (typeof onMessage !== "function") throw new Error("onMessage callback required");
    this.#onMessage = onMessage;
  }

  push(chunk) {
    if (!(chunk instanceof Uint8Array)) throw new Error("native input must be bytes");
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.#body === undefined) {
        const headerCount = Math.min(4 - this.#headerBytes, chunk.byteLength - offset);
        this.#header.set(chunk.subarray(offset, offset + headerCount), this.#headerBytes);
        this.#headerBytes += headerCount;
        offset += headerCount;
        if (this.#headerBytes !== 4) continue;
        const declaredBytes = new DataView(this.#header.buffer).getUint32(0, true);
        if (declaredBytes === 0 || declaredBytes > MAX_NATIVE_FRAME_BYTES) throw new Error("native frame outside byte limit");
        this.#body = new Uint8Array(declaredBytes);
        this.#bodyBytes = 0;
      }
      const bodyCount = Math.min(this.#body.byteLength - this.#bodyBytes, chunk.byteLength - offset);
      this.#body.set(chunk.subarray(offset, offset + bodyCount), this.#bodyBytes);
      this.#bodyBytes += bodyCount;
      offset += bodyCount;
      if (this.#bodyBytes !== this.#body.byteLength) continue;
      let message;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(this.#body);
        message = JSON.parse(text);
      } catch {
        throw new Error("invalid native frame JSON");
      }
      this.#body = undefined;
      this.#bodyBytes = 0;
      this.#headerBytes = 0;
      this.#onMessage(message);
    }
  }
}

export function encodeNativeMessage(message) {
  let payload;
  try {
    payload = new TextEncoder().encode(JSON.stringify(message));
  } catch {
    throw new Error("native frame is not serializable");
  }
  if (payload.byteLength === 0 || payload.byteLength > MAX_NATIVE_FRAME_BYTES) throw new Error("native frame outside byte limit");
  const framed = new Uint8Array(4 + payload.byteLength);
  new DataView(framed.buffer).setUint32(0, payload.byteLength, true);
  framed.set(payload, 4);
  return framed;
}
