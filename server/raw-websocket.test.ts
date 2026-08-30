import { Duplex } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { RawWebSocket, acceptRawWebSocket } from "./raw-websocket.ts";

function transport() {
  const writes: Buffer[] = [];
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      writes.push(Buffer.from(chunk));
      callback();
    },
  });
  return { socket, writes };
}

function frame(payload: Buffer, options: { masked?: boolean; opcode?: number; fin?: boolean; reserved?: number } = {}) {
  if (payload.length >= 126) throw new Error("test frame helper only supports short payloads");
  const masked = options.masked ?? true;
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const header = Buffer.from([
    (options.fin === false ? 0 : 0x80) | (options.reserved ?? 0) | (options.opcode ?? 0x1),
    (masked ? 0x80 : 0) | payload.length,
  ]);
  if (!masked) return Buffer.concat([header, payload]);
  const body = Buffer.from(payload);
  for (let index = 0; index < body.length; index += 1) body[index] ^= mask[index & 3]!;
  return Buffer.concat([header, mask, body]);
}

describe("RawWebSocket backpressure", () => {
  it("accepts one bounded frame, reports backpressure, and resumes only on drain", () => {
    const socket = new Duplex({
      readableHighWaterMark: 1,
      writableHighWaterMark: 1,
      read() {},
      // Keep the first write pending so write() deterministically crosses the
      // one-byte high-water mark.
      write(_chunk, _encoding, _callback) {},
    });
    const ws = new RawWebSocket(socket, { expectMasked: true, maskOutgoing: false });
    const drained = vi.fn();
    ws.onDrain(drained);

    expect(ws.sendText("backpressure")).toBe(true);
    expect(ws.backpressured).toBe(true);
    expect(ws.sendText("must wait")).toBe(false);
    socket.emit("drain");
    expect(drained).toHaveBeenCalledOnce();
    expect(ws.backpressured).toBe(false);
    expect(ws.sendText("next bounded frame")).toBe(true);
    ws.destroy();
  });
});

describe("RawWebSocket hostile frame handling", () => {
  it("accepts a correctly masked client text frame", () => {
    const { socket } = transport();
    const ws = new RawWebSocket(socket, { expectMasked: true, maskOutgoing: false });
    const received = vi.fn();
    ws.onMessage(received);
    socket.emit("data", frame(Buffer.from("hello")));
    expect(received).toHaveBeenCalledWith({ binary: false, data: Buffer.from("hello") });
    expect(ws.open).toBe(true);
    ws.destroy();
  });

  it.each([
    ["unmasked client frame", frame(Buffer.from("x"), { masked: false }), true],
    ["masked server frame", frame(Buffer.from("x"), { masked: true }), false],
    ["fragmented frame", frame(Buffer.from("x"), { fin: false }), true],
    ["reserved extension bit", frame(Buffer.from("x"), { reserved: 0x40 }), true],
    ["unknown opcode", frame(Buffer.from("x"), { opcode: 0x3 }), true],
    ["invalid UTF-8 text", frame(Buffer.from([0xc3, 0x28])), true],
    ["one-byte close payload", frame(Buffer.from([0x03]), { opcode: 0x8 }), true],
  ])("closes on %s", (_label, encoded, expectMasked) => {
    const { socket } = transport();
    const ws = new RawWebSocket(socket, { expectMasked: expectMasked as boolean, maskOutgoing: false });
    socket.emit("data", encoded);
    expect(ws.open).toBe(false);
  });

  it("rejects an oversized declared length before waiting for its payload", () => {
    const { socket } = transport();
    const ws = new RawWebSocket(socket, {
      expectMasked: true,
      maskOutgoing: false,
      maxMessageBytes: 1024,
    });
    const header = Buffer.alloc(14);
    header[0] = 0x82;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(1025n, 2);
    socket.emit("data", header);
    expect(ws.open).toBe(false);
  });

  it("rejects non-minimal extended lengths", () => {
    const { socket } = transport();
    const ws = new RawWebSocket(socket, { expectMasked: true, maskOutgoing: false });
    socket.emit("data", Buffer.from([0x81, 0x80 | 126, 0x00, 0x01]));
    expect(ws.open).toBe(false);
  });

  it("rejects malformed WebSocket upgrade handshakes without switching protocols", () => {
    const { socket, writes } = transport();
    const req = {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-version": "13",
        "sec-websocket-key": "not-a-valid-key",
      },
    };
    expect(acceptRawWebSocket(req as never, socket)).toBeNull();
    expect(writes).toHaveLength(0);
  });
});
