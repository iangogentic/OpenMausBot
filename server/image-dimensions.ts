/** Minimal bounded PNG/JPEG dimension reader for trusted screenshots. It
 * never decodes pixels and never scans beyond the supplied buffer. */
export function imageDimensions(bytes: Buffer, mimeType: "image/png" | "image/jpeg" | "image/webp"): { width: number; height: number } {
  if (mimeType === "image/png") {
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      throw new Error("invalid PNG screenshot");
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (!width || !height) throw new Error("invalid PNG dimensions");
    return { width, height };
  }
  if (mimeType === "image/webp") {
    if (
      bytes.length < 30 ||
      bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
      bytes.subarray(8, 12).toString("ascii") !== "WEBP"
    ) throw new Error("invalid WebP screenshot");
    const kind = bytes.subarray(12, 16).toString("ascii");
    if (kind === "VP8X") {
      const width = 1 + bytes.readUIntLE(24, 3);
      const height = 1 + bytes.readUIntLE(27, 3);
      return { width, height };
    }
    if (kind === "VP8 " && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      const width = bytes.readUInt16LE(26) & 0x3fff;
      const height = bytes.readUInt16LE(28) & 0x3fff;
      if (width && height) return { width, height };
    }
    if (kind === "VP8L" && bytes[20] === 0x2f && bytes.length >= 25) {
      const b0 = bytes[21]!;
      const b1 = bytes[22]!;
      const b2 = bytes[23]!;
      const b3 = bytes[24]!;
      const width = 1 + b0 + ((b1 & 0x3f) << 8);
      const height = 1 + (b1 >> 6) + (b2 << 2) + ((b3 & 0x0f) << 10);
      return { width, height };
    }
    throw new Error("WebP dimensions were unavailable");
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("invalid JPEG screenshot");
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (sof) {
      if (length < 7) break;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (!width || !height) break;
      return { width, height };
    }
    offset += length;
  }
  throw new Error("JPEG dimensions were unavailable");
}
