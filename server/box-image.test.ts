import { describe, expect, it } from "vitest";

import { parseBoxProviderJson, wholeBoxScreenshot } from "./box.ts";

const jpeg = (): Buffer => {
  const bytes = Buffer.alloc(512, 0x44);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[510] = 0xff;
  bytes[511] = 0xd9;
  return bytes;
};

describe("Box screenshot integrity", () => {
  it("accepts a whole bounded JPEG", () => {
    const encoded = jpeg().toString("base64");
    expect(wholeBoxScreenshot(encoded)).toBe(encoded);
  });

  it("rejects truncated, mislabeled, and non-canonical base64 frames", () => {
    const truncated = jpeg().subarray(0, 510).toString("base64");
    expect(wholeBoxScreenshot(truncated)).toBeNull();
    expect(wholeBoxScreenshot(Buffer.alloc(512).toString("base64"))).toBeNull();
    expect(wholeBoxScreenshot(`${jpeg().toString("base64")}junk`)).toBeNull();
  });

  it("rejects provider JSON beyond the shared depth and node budgets", () => {
    const deep = `${'{"x":'.repeat(70)}null${"}".repeat(70)}`;
    expect(parseBoxProviderJson(deep)).toBeNull();
    expect(parseBoxProviderJson(JSON.stringify(Array.from({ length: 100_001 }, () => null)))).toBeNull();
    expect(parseBoxProviderJson('{"ok":true}')).toEqual({ ok: true });
  });
});
