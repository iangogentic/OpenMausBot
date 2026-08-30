/**
 * A hostile-process boundary for UTF-8 NDJSON streams.
 *
 * Provider CLIs are not trusted server code.  In particular, never grow a
 * JavaScript string until a newline happens to arrive: keep raw bytes bounded,
 * validate UTF-8 only after a complete frame is present, and charge malformed
 * frames against the same byte/rate budgets as valid ones.
 */

export type ProviderOutputViolation =
  | "invalid_utf8"
  | "line_bytes"
  | "buffered_bytes"
  | "total_bytes"
  | "frame_count"
  | "frame_rate"
  | "json_depth"
  | "json_nodes";

export class ProviderOutputLimitError extends Error {
  readonly code: ProviderOutputViolation;

  constructor(code: ProviderOutputViolation, detail: string) {
    super(`provider output rejected (${code}): ${detail}`);
    this.name = "ProviderOutputLimitError";
    this.code = code;
  }
}

export interface BoundedJsonLineLimits {
  /** Maximum bytes before one newline (the newline itself is not counted). */
  maxLineBytes: number;
  /** Maximum bytes retained while waiting for a newline. */
  maxBufferedBytes: number;
  /** Maximum bytes accepted for this decoder's lifetime. */
  maxTotalBytes: number;
  /** Maximum non-empty frames accepted for this decoder's lifetime. */
  maxFrames: number;
  /** Maximum non-empty frames accepted within one rate window. */
  maxFramesPerWindow: number;
  frameWindowMs: number;
  /** Root is depth 1. */
  maxJsonDepth: number;
  /** Values (including primitive leaves) count as nodes. */
  maxJsonNodes: number;
}

export const PROVIDER_NDJSON_LIMITS: Readonly<BoundedJsonLineLimits> = Object.freeze({
  maxLineBytes: 2 * 1024 * 1024,
  maxBufferedBytes: 2 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxFrames: 100_000,
  maxFramesPerWindow: 5_000,
  frameWindowMs: 1_000,
  maxJsonDepth: 64,
  maxJsonNodes: 100_000,
});

export const CATALOG_NDJSON_LIMITS: Readonly<BoundedJsonLineLimits> = Object.freeze({
  maxLineBytes: 512 * 1024,
  maxBufferedBytes: 512 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxFrames: 10_000,
  maxFramesPerWindow: 2_000,
  frameWindowMs: 1_000,
  maxJsonDepth: 32,
  maxJsonNodes: 25_000,
});

export const PERMISSION_NDJSON_LIMITS: Readonly<BoundedJsonLineLimits> = Object.freeze({
  maxLineBytes: 256 * 1024,
  maxBufferedBytes: 256 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxFrames: 10_000,
  maxFramesPerWindow: 500,
  frameWindowMs: 1_000,
  maxJsonDepth: 32,
  maxJsonNodes: 10_000,
});

type JsonFrame = { value: unknown; line: string };
export type Utf8LineFrame = { line: string };

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

export function assertBoundedJsonShape(
  value: unknown,
  limits: Pick<BoundedJsonLineLimits, "maxJsonDepth" | "maxJsonNodes">,
): void {
  let nodes = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > limits.maxJsonNodes) {
      throw new ProviderOutputLimitError("json_nodes", `JSON frame exceeded ${limits.maxJsonNodes} nodes`);
    }
    if (current.depth > limits.maxJsonDepth) {
      throw new ProviderOutputLimitError("json_depth", `JSON frame exceeded depth ${limits.maxJsonDepth}`);
    }
    if (Array.isArray(current.value)) {
      for (let i = current.value.length - 1; i >= 0; i--) {
        stack.push({ value: current.value[i], depth: current.depth + 1 });
      }
    } else if (current.value !== null && typeof current.value === "object") {
      for (const child of Object.values(current.value as Record<string, unknown>)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

/**
 * Incrementally split an arbitrary newline-framed byte stream while applying
 * the same hostile-stream byte, frame, rate, and fatal UTF-8 limits as the
 * JSON decoder. This is used by transparent protocols (such as the gated MCP
 * bridge) that must preserve malformed/non-JSON lines byte-for-byte after
 * decoding rather than silently dropping them.
 */
export class BoundedUtf8LineDecoder {
  private readonly limits: BoundedJsonLineLimits;
  private readonly now: () => number;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private totalBytes = 0;
  private frames = 0;
  private windowStartedAt: number;
  private windowFrames = 0;
  private failed: ProviderOutputLimitError | null = null;

  constructor(limits: Partial<BoundedJsonLineLimits> = {}, options: { now?: () => number } = {}) {
    this.limits = {
      maxLineBytes: positiveInteger(limits.maxLineBytes ?? PROVIDER_NDJSON_LIMITS.maxLineBytes, "maxLineBytes"),
      maxBufferedBytes: positiveInteger(limits.maxBufferedBytes ?? PROVIDER_NDJSON_LIMITS.maxBufferedBytes, "maxBufferedBytes"),
      maxTotalBytes: positiveInteger(limits.maxTotalBytes ?? PROVIDER_NDJSON_LIMITS.maxTotalBytes, "maxTotalBytes"),
      maxFrames: positiveInteger(limits.maxFrames ?? PROVIDER_NDJSON_LIMITS.maxFrames, "maxFrames"),
      maxFramesPerWindow: positiveInteger(
        limits.maxFramesPerWindow ?? PROVIDER_NDJSON_LIMITS.maxFramesPerWindow,
        "maxFramesPerWindow",
      ),
      frameWindowMs: positiveInteger(limits.frameWindowMs ?? PROVIDER_NDJSON_LIMITS.frameWindowMs, "frameWindowMs"),
      maxJsonDepth: positiveInteger(limits.maxJsonDepth ?? PROVIDER_NDJSON_LIMITS.maxJsonDepth, "maxJsonDepth"),
      maxJsonNodes: positiveInteger(limits.maxJsonNodes ?? PROVIDER_NDJSON_LIMITS.maxJsonNodes, "maxJsonNodes"),
    };
    this.now = options.now ?? Date.now;
    this.windowStartedAt = this.now();
  }

  get bufferedBytes(): number {
    return this.pendingBytes;
  }

  get bytesSeen(): number {
    return this.totalBytes;
  }

  get framesSeen(): number {
    return this.frames;
  }

  push(chunk: Uint8Array | string): Utf8LineFrame[] {
    if (this.failed) throw this.failed;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.totalBytes += bytes.byteLength;
    if (this.totalBytes > this.limits.maxTotalBytes) {
      return this.fail("total_bytes", `stream exceeded ${this.limits.maxTotalBytes} bytes`);
    }

    const frames: Utf8LineFrame[] = [];
    let start = 0;
    for (;;) {
      const newline = bytes.indexOf(0x0a, start);
      if (newline === -1) {
        this.appendPending(bytes.subarray(start));
        break;
      }
      this.appendPending(bytes.subarray(start, newline));
      frames.push(this.decodeFrame(this.takePending()));
      start = newline + 1;
    }
    return frames;
  }

  /** Deliver a final unterminated frame at EOF, matching readline semantics. */
  flush(): Utf8LineFrame[] {
    if (this.failed) throw this.failed;
    if (!this.pendingBytes) return [];
    return [this.decodeFrame(this.takePending())];
  }

  private fail(code: ProviderOutputViolation, detail: string): never {
    const error = new ProviderOutputLimitError(code, detail);
    this.failed = error;
    this.pending = [];
    this.pendingBytes = 0;
    throw error;
  }

  private appendPending(part: Buffer): void {
    if (!part.length) return;
    const next = this.pendingBytes + part.length;
    if (next > this.limits.maxLineBytes) {
      this.fail("line_bytes", `line exceeded ${this.limits.maxLineBytes} bytes before newline`);
    }
    if (next > this.limits.maxBufferedBytes) {
      this.fail("buffered_bytes", `decoder buffered more than ${this.limits.maxBufferedBytes} bytes`);
    }
    // Copy short fragments so they cannot retain an arbitrarily large caller
    // chunk after push() returns.
    this.pending.push(Buffer.from(part));
    this.pendingBytes = next;
  }

  private takePending(): Buffer {
    const raw = this.pending.length === 1
      ? this.pending[0]!
      : Buffer.concat(this.pending, this.pendingBytes);
    this.pending = [];
    this.pendingBytes = 0;
    return raw;
  }

  private decodeFrame(raw: Buffer): Utf8LineFrame {
    this.frames += 1;
    if (this.frames > this.limits.maxFrames) {
      return this.fail("frame_count", `stream exceeded ${this.limits.maxFrames} frames`);
    }
    const now = this.now();
    if (now - this.windowStartedAt >= this.limits.frameWindowMs) {
      this.windowStartedAt = now;
      this.windowFrames = 0;
    }
    this.windowFrames += 1;
    if (this.windowFrames > this.limits.maxFramesPerWindow) {
      return this.fail(
        "frame_rate",
        `stream exceeded ${this.limits.maxFramesPerWindow} frames per ${this.limits.frameWindowMs}ms`,
      );
    }
    try {
      return { line: new TextDecoder("utf-8", { fatal: true }).decode(raw) };
    } catch {
      return this.fail("invalid_utf8", "frame was not valid UTF-8");
    }
  }
}

/**
 * Incrementally decode newline-delimited JSON. Malformed JSON is ignored for
 * protocol compatibility, but it still consumes byte, frame-count, and rate
 * budgets. Resource/encoding violations are terminal and sticky.
 */
export class BoundedJsonLineDecoder {
  private readonly limits: BoundedJsonLineLimits;
  private readonly now: () => number;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private totalBytes = 0;
  private frames = 0;
  private windowStartedAt: number;
  private windowFrames = 0;
  private failed: ProviderOutputLimitError | null = null;
  private readonly jsonPrefix: string | null;
  private readonly ignoredJsonPayloads: ReadonlySet<string>;

  constructor(
    limits: Partial<BoundedJsonLineLimits> = {},
    options: {
      now?: () => number;
      /** Parse only lines with this prefix (for example SSE's `data:`). */
      jsonPrefix?: string;
      /** Prefixed payloads that are protocol sentinels rather than JSON. */
      ignoredJsonPayloads?: readonly string[];
    } = {},
  ) {
    this.limits = {
      maxLineBytes: positiveInteger(limits.maxLineBytes ?? PROVIDER_NDJSON_LIMITS.maxLineBytes, "maxLineBytes"),
      maxBufferedBytes: positiveInteger(limits.maxBufferedBytes ?? PROVIDER_NDJSON_LIMITS.maxBufferedBytes, "maxBufferedBytes"),
      maxTotalBytes: positiveInteger(limits.maxTotalBytes ?? PROVIDER_NDJSON_LIMITS.maxTotalBytes, "maxTotalBytes"),
      maxFrames: positiveInteger(limits.maxFrames ?? PROVIDER_NDJSON_LIMITS.maxFrames, "maxFrames"),
      maxFramesPerWindow: positiveInteger(
        limits.maxFramesPerWindow ?? PROVIDER_NDJSON_LIMITS.maxFramesPerWindow,
        "maxFramesPerWindow",
      ),
      frameWindowMs: positiveInteger(limits.frameWindowMs ?? PROVIDER_NDJSON_LIMITS.frameWindowMs, "frameWindowMs"),
      maxJsonDepth: positiveInteger(limits.maxJsonDepth ?? PROVIDER_NDJSON_LIMITS.maxJsonDepth, "maxJsonDepth"),
      maxJsonNodes: positiveInteger(limits.maxJsonNodes ?? PROVIDER_NDJSON_LIMITS.maxJsonNodes, "maxJsonNodes"),
    };
    this.now = options.now ?? Date.now;
    this.jsonPrefix = options.jsonPrefix ?? null;
    this.ignoredJsonPayloads = new Set(options.ignoredJsonPayloads ?? []);
    this.windowStartedAt = this.now();
  }

  get bufferedBytes(): number {
    return this.pendingBytes;
  }

  get bytesSeen(): number {
    return this.totalBytes;
  }

  get framesSeen(): number {
    return this.frames;
  }

  push(chunk: Uint8Array | string): JsonFrame[] {
    if (this.failed) throw this.failed;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.totalBytes += bytes.byteLength;
    if (this.totalBytes > this.limits.maxTotalBytes) {
      return this.fail("total_bytes", `stream exceeded ${this.limits.maxTotalBytes} bytes`);
    }

    const frames: JsonFrame[] = [];
    let start = 0;
    for (;;) {
      const newline = bytes.indexOf(0x0a, start);
      if (newline === -1) {
        this.appendPending(bytes.subarray(start));
        break;
      }
      this.appendPending(bytes.subarray(start, newline));
      const raw = this.takePending();
      start = newline + 1;
      // Every delimiter is a frame for rate/count purposes. Otherwise a
      // newline-only flood gets millions of iterations before the byte cap.
      frames.push(...this.decodeFrame(raw));
    }
    return frames;
  }

  /** Decode one final unterminated frame at EOF without relaxing any limit. */
  flush(): JsonFrame[] {
    if (this.failed) throw this.failed;
    if (!this.pendingBytes) return [];
    return this.decodeFrame(this.takePending());
  }

  private fail(code: ProviderOutputViolation, detail: string): never {
    const error = new ProviderOutputLimitError(code, detail);
    this.failed = error;
    this.pending = [];
    this.pendingBytes = 0;
    throw error;
  }

  private appendPending(part: Buffer): void {
    if (!part.length) return;
    const next = this.pendingBytes + part.length;
    if (next > this.limits.maxLineBytes) {
      this.fail("line_bytes", `line exceeded ${this.limits.maxLineBytes} bytes before newline`);
    }
    if (next > this.limits.maxBufferedBytes) {
      this.fail("buffered_bytes", `decoder buffered more than ${this.limits.maxBufferedBytes} bytes`);
    }
    // Copy short fragments so they cannot retain an arbitrarily large caller
    // chunk after push() returns.
    this.pending.push(Buffer.from(part));
    this.pendingBytes = next;
  }

  private takePending(): Buffer {
    const raw = this.pending.length === 1
      ? this.pending[0]!
      : Buffer.concat(this.pending, this.pendingBytes);
    this.pending = [];
    this.pendingBytes = 0;
    return raw;
  }

  private decodeFrame(raw: Buffer): JsonFrame[] {
    this.frames += 1;
    if (this.frames > this.limits.maxFrames) {
      return this.fail("frame_count", `stream exceeded ${this.limits.maxFrames} frames`);
    }
    const now = this.now();
    if (now - this.windowStartedAt >= this.limits.frameWindowMs) {
      this.windowStartedAt = now;
      this.windowFrames = 0;
    }
    this.windowFrames += 1;
    if (this.windowFrames > this.limits.maxFramesPerWindow) {
      return this.fail(
        "frame_rate",
        `stream exceeded ${this.limits.maxFramesPerWindow} frames per ${this.limits.frameWindowMs}ms`,
      );
    }

    let line: string;
    try {
      line = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      return this.fail("invalid_utf8", "frame was not valid UTF-8");
    }
    let json = line.trim();
    if (this.jsonPrefix !== null) {
      if (!json.startsWith(this.jsonPrefix)) return [];
      json = json.slice(this.jsonPrefix.length).trim();
    }
    if (!json || this.ignoredJsonPayloads.has(json)) return [];
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      return [];
    }
    try {
      assertBoundedJsonShape(value, this.limits);
    } catch (error) {
      if (error instanceof ProviderOutputLimitError) this.failed = error;
      throw error;
    }
    return [{ value, line }];
  }
}
