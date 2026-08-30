/** Trusted-server boundary for the blocking computer-operator MCP call.
 * Lifecycle, target authority, and provider execution are supplied by index;
 * this module only validates and bounds the provider-facing request/result. */

export const COMPUTER_OPERATOR_TASK_MAX_BYTES = 20_000;
export const COMPUTER_OPERATOR_TEXT_MAX_BYTES = 32_000;
export const COMPUTER_OPERATOR_IMAGE_MAX_BASE64_BYTES = 1024 * 1024;

export type ComputerOperatorImageMime = "image/png" | "image/jpeg" | "image/webp";

export interface ComputerOperatorImage {
  mimeType: ComputerOperatorImageMime;
  /** Canonical, unprefixed base64. */
  data: string;
}

export interface ComputerOperatorExecutionResult {
  text: string;
  image?: ComputerOperatorImage;
  isError?: boolean;
}

export type ComputerOperatorExecutor = (
  task: string,
  signal: AbortSignal,
) => Promise<ComputerOperatorExecutionResult>;

export interface ComputerOperatorSurfaceResponse {
  text: string;
  image?: ComputerOperatorImage;
  isError?: boolean;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null ? value as Record<string, unknown> : null;
}

function boundedUtf8(value: string, maxBytes: number, label: string): string {
  const normalized = value.replace(/\u0000/g, "");
  if (!normalized.trim()) throw new Error(`${label} must be non-empty`);
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) throw new Error(`${label} exceeded ${maxBytes} bytes`);
  return normalized;
}

function canonicalBase64(value: string): boolean {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  try {
    return Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}

function boundedImage(value: unknown): ComputerOperatorImage {
  const image = plainRecord(value);
  if (!image) throw new Error("computer operator image is invalid");
  const mimeType = image.mimeType;
  const data = image.data;
  if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp") {
    throw new Error("computer operator image type is unsupported");
  }
  if (typeof data !== "string" || data.length > COMPUTER_OPERATOR_IMAGE_MAX_BASE64_BYTES || !canonicalBase64(data)) {
    throw new Error("computer operator image is invalid or too large");
  }
  return { mimeType, data };
}

export function computerOperatorTask(body: unknown): string {
  const record = plainRecord(body);
  if (!record || typeof record.task !== "string") throw new Error("task is required");
  return boundedUtf8(record.task, COMPUTER_OPERATOR_TASK_MAX_BYTES, "task");
}

export function normalizeComputerOperatorResult(value: unknown): ComputerOperatorSurfaceResponse {
  const result = plainRecord(value);
  if (!result || typeof result.text !== "string") throw new Error("computer operator returned an invalid result");
  const text = boundedUtf8(result.text, COMPUTER_OPERATOR_TEXT_MAX_BYTES, "computer operator text");
  const isError = result.isError === true;
  const image = result.image === undefined ? undefined : boundedImage(result.image);
  if (!isError && !image) throw new Error("computer operator completed without final screen proof");
  return {
    text,
    ...(image ? { image } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

/** Blocks until the index-supplied lifecycle executor settles. The caller
 * should pass the exact parent-turn abort signal. */
export async function executeComputerOperatorRequest(
  body: unknown,
  signal: AbortSignal,
  execute: ComputerOperatorExecutor,
): Promise<ComputerOperatorSurfaceResponse> {
  if (signal.aborted) throw signal.reason ?? new Error("computer operator request was cancelled");
  const task = computerOperatorTask(body);
  const result = await execute(task, signal);
  if (signal.aborted) throw signal.reason ?? new Error("computer operator request was cancelled");
  return normalizeComputerOperatorResult(result);
}
