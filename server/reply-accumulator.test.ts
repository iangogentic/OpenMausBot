import { describe, expect, it } from "vitest";

import { BoundedReplyAccumulator, TRUNCATED_REPLY_MARKER } from "./reply-accumulator.ts";

describe("BoundedReplyAccumulator", () => {
  it("preserves separators while a reply fits", () => {
    const reply = new BoundedReplyAccumulator(128);
    reply.append("one");
    reply.append("two");
    expect(reply.text).toBe("one\ntwo");
    expect(reply.truncated).toBe(false);
  });

  it("caps multi-frame replies by UTF-8 bytes and appends one marker", () => {
    const reply = new BoundedReplyAccumulator(80);
    for (let i = 0; i < 20; i++) reply.append("🐭".repeat(10));
    expect(reply.truncated).toBe(true);
    expect(reply.byteLength).toBeLessThanOrEqual(80);
    expect(reply.text.endsWith(TRUNCATED_REPLY_MARKER)).toBe(true);
    expect(reply.text.match(/reply truncated/g)).toHaveLength(1);
    expect(reply.text).not.toContain("�");
  });
});
