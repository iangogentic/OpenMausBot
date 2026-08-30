import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export const WEBSOCKET_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export type RawWebSocketMessage = { readonly binary: boolean; readonly data: Buffer };

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function validUtf8(value: Buffer): boolean {
  try {
    UTF8.decode(value);
    return true;
  } catch {
    return false;
  }
}

function validCloseCode(code: number): boolean {
  return code === 1000 ||
    (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
    (code >= 3000 && code <= 4999);
}

/** Minimal, deliberately strict RFC 6455 transport for the two private
 * OpenMaus bridges. It accepts only complete, uncompressed messages and
 * enforces the client/server mask direction. Keeping this tiny avoids
 * shipping a general WebSocket package in the zero-node_modules server. */
export class RawWebSocket {
  private buffer = Buffer.alloc(0);
  private closed = false;
  private closeSent = false;
  private readonly socket: Duplex;
  private readonly expectMasked: boolean;
  private readonly maskOutgoing: boolean;
  private readonly maxMessageBytes: number;
  private readonly maxBufferedBytes: number;
  private writeBlocked = false;
  private readonly messageListeners = new Set<(message: RawWebSocketMessage) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly drainListeners = new Set<() => void>();

  constructor(socket: Duplex, options: {
    expectMasked: boolean;
    maskOutgoing: boolean;
    head?: Buffer;
    maxMessageBytes?: number;
    maxBufferedBytes?: number;
  }) {
    this.socket = socket;
    this.expectMasked = options.expectMasked;
    this.maskOutgoing = options.maskOutgoing;
    this.maxMessageBytes = options.maxMessageBytes ?? WEBSOCKET_MAX_MESSAGE_BYTES;
    this.maxBufferedBytes = options.maxBufferedBytes ?? (this.maxMessageBytes * 2 + 64);
    socket.on("data", (chunk: Buffer) => this.push(chunk));
    socket.once("close", () => this.finish());
    socket.once("end", () => this.finish());
    socket.once("error", () => this.finish());
    socket.on("drain", () => {
      if (this.closed) return;
      this.writeBlocked = false;
      for (const listener of [...this.drainListeners]) listener();
    });
    if (options.head?.length) this.push(options.head);
  }

  get open(): boolean {
    return !this.closed && !(this.socket as Duplex & { destroyed?: boolean }).destroyed;
  }

  /** True after Node accepted a frame but filled its bounded writable queue.
   * Producers must pause until onDrain fires; another send fails closed. */
  get backpressured(): boolean {
    return this.writeBlocked;
  }

  onMessage(listener: (message: RawWebSocketMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onDrain(listener: () => void): () => void {
    this.drainListeners.add(listener);
    return () => this.drainListeners.delete(listener);
  }

  pauseInput(): void {
    this.socket.pause();
  }

  resumeInput(): void {
    if (this.open) this.socket.resume();
  }

  sendText(value: string): boolean {
    return this.sendFrame(0x1, Buffer.from(value, "utf8"));
  }

  sendBinary(value: Buffer): boolean {
    return this.sendFrame(0x2, value);
  }

  ping(value: Buffer = Buffer.alloc(0)): boolean {
    return value.length <= 125 && this.sendFrame(0x9, value);
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    if (!this.closeSent) {
      const safeReason = Buffer.from(reason, "utf8").subarray(0, 123);
      const payload = Buffer.allocUnsafe(2 + safeReason.length);
      payload.writeUInt16BE(code, 0);
      safeReason.copy(payload, 2);
      this.closeSent = true;
      this.sendFrame(0x8, payload);
    }
    this.closed = true;
    this.socket.end();
    this.notifyClose();
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.notifyClose();
  }

  private push(chunk: Buffer): void {
    if (this.closed || !chunk.length) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    if (this.buffer.length > this.maxMessageBytes + 32) {
      this.close(1009, "message too large");
      return;
    }
    while (this.consumeFrame()) {}
  }

  private consumeFrame(): boolean {
    if (this.buffer.length < 2 || this.closed) return false;
    const first = this.buffer[0]!;
    const second = this.buffer[1]!;
    const fin = (first & 0x80) !== 0;
    const reserved = first & 0x70;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    if (!fin || reserved !== 0 || masked !== this.expectMasked || opcode === 0x0 || ![0x1, 0x2, 0x8, 0x9, 0xa].includes(opcode)) {
      this.close(1002, "invalid frame");
      return false;
    }
    const lengthMarker = second & 0x7f;
    let length = lengthMarker;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < 4) return false;
      length = this.buffer.readUInt16BE(2);
      offset = 4;
      if (length < 126) {
        this.close(1002, "non-minimal frame length");
        return false;
      }
    } else if (length === 127) {
      if (this.buffer.length < 10) return false;
      const wide = this.buffer.readBigUInt64BE(2);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.close(1009, "message too large");
        return false;
      }
      length = Number(wide);
      offset = 10;
      if (length <= 0xffff) {
        this.close(1002, "non-minimal frame length");
        return false;
      }
    }
    const control = opcode >= 0x8;
    if ((control && length > 125) || (!control && length > this.maxMessageBytes)) {
      this.close(1009, "message too large");
      return false;
    }
    const maskBytes = masked ? 4 : 0;
    if (this.buffer.length < offset + maskBytes + length) return false;
    const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
    offset += maskBytes;
    const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
    this.buffer = this.buffer.subarray(offset + length);
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index & 3]!;
    }
    if (opcode === 0x1 && !validUtf8(payload)) {
      this.close(1007, "invalid UTF-8");
      return false;
    }
    if (opcode === 0x8) {
      if (
        payload.length === 1 ||
        (payload.length >= 2 && (!validCloseCode(payload.readUInt16BE(0)) || !validUtf8(payload.subarray(2))))
      ) {
        this.close(1002, "invalid close frame");
        return false;
      }
      if (!this.closeSent) {
        this.closeSent = true;
        this.sendFrame(0x8, payload.subarray(0, 125));
      }
      this.closed = true;
      this.socket.end();
      this.notifyClose();
    } else if (opcode === 0x9) {
      this.sendFrame(0xa, payload);
    } else if (opcode === 0xa) {
      // A pong is liveness proof; users of this class need no payload.
    } else {
      for (const listener of [...this.messageListeners]) listener({ binary: opcode === 0x2, data: payload });
    }
    return this.buffer.length >= 2 && !this.closed;
  }

  private sendFrame(opcode: number, payload: Buffer): boolean {
    if (!this.open || this.writeBlocked) return false;
    const maskBytes = this.maskOutgoing ? 4 : 0;
    const extended = payload.length < 126 ? 0 : payload.length <= 0xffff ? 2 : 8;
    const header = Buffer.allocUnsafe(2 + extended + maskBytes);
    header[0] = 0x80 | opcode;
    header[1] = (this.maskOutgoing ? 0x80 : 0) | (extended === 0 ? payload.length : extended === 2 ? 126 : 127);
    let offset = 2;
    if (extended === 2) {
      header.writeUInt16BE(payload.length, offset);
      offset += 2;
    } else if (extended === 8) {
      header.writeBigUInt64BE(BigInt(payload.length), offset);
      offset += 8;
    }
    let body = payload;
    if (this.maskOutgoing) {
      const mask = randomBytes(4);
      mask.copy(header, offset);
      body = Buffer.from(payload);
      for (let index = 0; index < body.length; index += 1) body[index] ^= mask[index & 3]!;
    }
    const queuedBytes = this.socket.writableLength;
    if (queuedBytes + header.length + body.length > this.maxBufferedBytes) return false;
    // write(false) still accepted this exact bounded frame. Surface that as
    // `backpressured`, reject every later send, and let the producer resume
    // only after onDrain. This avoids both silent queue growth and needless
    // disconnects on ordinary screenshot-sized frames.
    try {
      this.writeBlocked = !this.socket.write(Buffer.concat([header, body]));
      return true;
    } catch {
      this.destroy();
      return false;
    }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.notifyClose();
  }

  private notifyClose(): void {
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    this.drainListeners.clear();
    for (const listener of listeners) listener();
  }
}

export function acceptRawWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  head = Buffer.alloc(0),
  options: { maxMessageBytes?: number; maxBufferedBytes?: number } = {},
): RawWebSocket | null {
  const key = req.headers["sec-websocket-key"];
  const version = req.headers["sec-websocket-version"];
  const upgrade = req.headers.upgrade;
  const connection = req.headers.connection;
  if (
    typeof key !== "string" ||
    !/^[A-Za-z0-9+/]{22}==$/.test(key) ||
    version !== "13" ||
    typeof upgrade !== "string" ||
    upgrade.toLowerCase() !== "websocket" ||
    typeof connection !== "string" ||
    !connection.toLowerCase().split(",").some((value) => value.trim() === "upgrade")
  ) return null;
  const accept = createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return new RawWebSocket(socket, { expectMasked: true, maskOutgoing: false, head, ...options });
}
