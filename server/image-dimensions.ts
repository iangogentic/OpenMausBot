/** Minimal bounded PNG/JPEG dimension reader for trusted screenshots. It
 * never decodes pixels and never scans beyond the supplied buffer. */
export function imageDimensions(bytes: Buffer, mimeType: "image/png" | "image/jpeg"): { width: number; height: number } {
  if (mimeType === "image/png") {
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      throw new Error("invalid PNG screenshot");
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (!width || !height) throw new Error("invalid PNG dimensions");
    return { width, height };
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
