export const MAX_ACCUMULATED_REPLY_BYTES = 512 * 1024;
export const TRUNCATED_REPLY_MARKER = "\n[reply truncated by OpenMausBot]";

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  // Do not retain half of a surrogate pair at the byte boundary.
  if (low > 0 && low < value.length) {
    const code = value.charCodeAt(low - 1);
    if (code >= 0xd800 && code <= 0xdbff) low -= 1;
  }
  return value.slice(0, low);
}

/** Bounded fold for assistant items that may arrive in arbitrarily many frames. */
export class BoundedReplyAccumulator {
  private readonly marker: string;
  private readonly contentLimit: number;
  private readonly chunks: string[] = [];
  private bytes = 0;
  private hasContent = false;
  private clipped = false;

  constructor(maxBytes = MAX_ACCUMULATED_REPLY_BYTES, marker = TRUNCATED_REPLY_MARKER) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError("reply byte cap must be positive");
    const markerBytes = Buffer.byteLength(marker, "utf8");
    if (markerBytes >= maxBytes) throw new TypeError("reply byte cap must exceed the truncation marker");
    this.marker = marker;
    this.contentLimit = maxBytes - markerBytes;
  }

  append(text: string, separator = "\n"): void {
    if (this.clipped || !text) return;
    const prefix = this.hasContent ? separator : "";
    const addition = prefix + text;
    const additionBytes = Buffer.byteLength(addition, "utf8");
    if (this.bytes + additionBytes <= this.contentLimit) {
      this.chunks.push(addition);
      this.bytes += additionBytes;
      this.hasContent = true;
      return;
    }
    const remaining = this.contentLimit - this.bytes;
    const tail = utf8Prefix(addition, remaining) + this.marker;
    this.chunks.push(tail);
    this.bytes += Buffer.byteLength(tail, "utf8");
    this.hasContent = true;
    this.clipped = true;
  }

  get text(): string {
    return this.chunks.join("");
  }

  get truncated(): boolean {
    return this.clipped;
  }

  get byteLength(): number {
    return this.bytes;
  }
}
