import { describe, expect, it } from "vitest";

import { BoundedJsonLineDecoder, BoundedUtf8LineDecoder, ProviderOutputLimitError } from "./bounded-json-lines.ts";

const limits = {
  maxLineBytes: 64,
  maxBufferedBytes: 64,
  maxTotalBytes: 256,
  maxFrames: 4,
  maxFramesPerWindow: 3,
  frameWindowMs: 1_000,
  maxJsonDepth: 4,
  maxJsonNodes: 8,
};

describe("BoundedJsonLineDecoder", () => {
  it("preserves fragmented UTF-8 and JSON frames", () => {
    const decoder = new BoundedJsonLineDecoder(limits);
    const bytes = Buffer.from('{"text":"hi 🐭"}\n');
    expect(decoder.push(bytes.subarray(0, 14))).toEqual([]);
    expect(decoder.push(bytes.subarray(14))).toEqual([{ value: { text: "hi 🐭" }, line: '{"text":"hi 🐭"}' }]);
  });

  it("decodes one bounded unterminated JSON frame at EOF", () => {
    const decoder = new BoundedJsonLineDecoder(limits);
    expect(decoder.push('{"ok":')).toEqual([]);
    expect(decoder.push("true}")).toEqual([]);
    expect(decoder.flush()).toEqual([{ value: { ok: true }, line: '{"ok":true}' }]);
    expect(decoder.flush()).toEqual([]);
  });

  it("rejects a fragmented no-newline line before it can grow unbounded", () => {
    const decoder = new BoundedJsonLineDecoder({ ...limits, maxLineBytes: 8, maxBufferedBytes: 12 });
    expect(decoder.push("1234")).toEqual([]);
    expect(decoder.push("5678")).toEqual([]);
    expect(() => decoder.push("9")).toThrowError(expect.objectContaining({ code: "line_bytes" }));
    expect(decoder.bufferedBytes).toBe(0);
  });

  it("enforces buffered and cumulative byte budgets independently", () => {
    const buffered = new BoundedJsonLineDecoder({ ...limits, maxLineBytes: 16, maxBufferedBytes: 8 });
    expect(() => buffered.push("123456789")).toThrowError(expect.objectContaining({ code: "buffered_bytes" }));

    const cumulative = new BoundedJsonLineDecoder({ ...limits, maxTotalBytes: 10 });
    expect(cumulative.push("{}\n")).toHaveLength(1);
    expect(cumulative.push("{}\n")).toHaveLength(1);
    expect(() => cumulative.push("12345")).toThrowError(expect.objectContaining({ code: "total_bytes" }));
  });

  it("rejects invalid UTF-8, excessive depth, and excessive node counts", () => {
    expect(() => new BoundedJsonLineDecoder(limits).push(Buffer.from([0xff, 0x0a]))).toThrowError(
      expect.objectContaining({ code: "invalid_utf8" }),
    );
    expect(() => new BoundedJsonLineDecoder(limits).push('{"a":{"b":{"c":{"d":1}}}}\n')).toThrowError(
      expect.objectContaining({ code: "json_depth" }),
    );
    expect(() => new BoundedJsonLineDecoder(limits).push('[1,2,3,4,5,6,7,8]\n')).toThrowError(
      expect.objectContaining({ code: "json_nodes" }),
    );
  });

  it("charges malformed JSON and valid-frame floods to count/rate budgets", () => {
    const decoder = new BoundedJsonLineDecoder(limits);
    expect(decoder.push("not-json\n{}\n{}\n")).toHaveLength(2);
    expect(() => decoder.push("{}\n")).toThrowError(expect.objectContaining({ code: "frame_rate" }));
  });

  it("charges blank frames and enforces the lifetime frame count", () => {
    let now = 0;
    const decoder = new BoundedJsonLineDecoder(
      { ...limits, maxFrames: 2, maxFramesPerWindow: 2 },
      { now: () => now },
    );
    expect(decoder.push("\n")).toEqual([]);
    now += 1_000;
    expect(decoder.push("{}\n")).toHaveLength(1);
    now += 1_000;
    expect(() => decoder.push("{}\n")).toThrowError(expect.objectContaining({ code: "frame_count" }));
  });

  it("keeps a sibling decoder usable after an exact-stream violation", () => {
    const hostile = new BoundedJsonLineDecoder({ ...limits, maxLineBytes: 4, maxBufferedBytes: 4 });
    const sibling = new BoundedJsonLineDecoder(limits);
    expect(() => hostile.push("12345")).toThrow(ProviderOutputLimitError);
    expect(sibling.push('{"ok":true}\n')[0]?.value).toEqual({ ok: true });
  });

  it("decodes bounded JSON payloads from SSE data frames", () => {
    const decoder = new BoundedJsonLineDecoder(limits, {
      jsonPrefix: "data:",
      ignoredJsonPayloads: ["[DONE]"],
    });
    expect(decoder.push('event: message\ndata: {"delta":"ok"}\ndata: [DONE]\n')).toEqual([
      { value: { delta: "ok" }, line: 'data: {"delta":"ok"}' },
    ]);
  });
});

describe("BoundedUtf8LineDecoder", () => {
  it("preserves non-JSON lines while enforcing fragmented and fatal UTF-8 bounds", () => {
    const decoder = new BoundedUtf8LineDecoder(limits);
    expect(decoder.push("not-")).toEqual([]);
    expect(decoder.push("json\n")).toEqual([{ line: "not-json" }]);
    expect(() => decoder.push(Buffer.from([0xff, 0x0a]))).toThrowError(
      expect.objectContaining({ code: "invalid_utf8" }),
    );
  });

  it("bounds total frames and emits one valid unterminated frame at EOF", () => {
    const decoder = new BoundedUtf8LineDecoder({ ...limits, maxFrames: 2, maxFramesPerWindow: 2 });
    expect(decoder.push("one\npart")).toEqual([{ line: "one" }]);
    expect(decoder.flush()).toEqual([{ line: "part" }]);
    expect(() => decoder.push("three\n")).toThrowError(expect.objectContaining({ code: "frame_count" }));
  });
});
