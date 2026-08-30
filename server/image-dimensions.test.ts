import { describe, expect, it } from "vitest";
import { imageDimensions } from "./image-dimensions.ts";

describe("image dimensions", () => {
  it("reads PNG IHDR dimensions", () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(1280, 16);
    png.writeUInt32BE(720, 20);
    expect(imageDimensions(png, "image/png")).toEqual({ width: 1280, height: 720 });
  });

  it("reads JPEG SOF dimensions and rejects malformed input", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 1, 1, 0, 2, 1, 0, 3, 1, 0, 0xff, 0xd9]);
    expect(imageDimensions(jpeg, "image/jpeg")).toEqual({ width: 1280, height: 720 });
    expect(() => imageDimensions(Buffer.from("nope"), "image/jpeg")).toThrow(/invalid JPEG/);
  });
});
