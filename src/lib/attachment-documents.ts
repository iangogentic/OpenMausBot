import { attachmentBasename, safeAttachmentDisplayName } from "./composer-attachments";

export const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;
export const XLSX_MAX_ENTRIES = 2_000;
export const XLSX_MAX_UNCOMPRESSED_BYTES = 75 * 1024 * 1024;
export const XLSX_MAX_COMPRESSION_RATIO = 200;

export type DownloadedAttachment = {
  bytes: Uint8Array;
  name: string;
};

function decodeBase64UrlUtf8(value: string | null): string | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Fetch through the existing authenticated, containment-checked server
 * route. The response is bounded both before and after buffering because
 * proxies are not required to send Content-Length. */
export async function downloadAttachment(path: string, signal?: AbortSignal): Promise<DownloadedAttachment> {
  if (!path || path.length > 4096) throw new Error("This attachment path is invalid.");
  const response = await fetch("/api/files/download", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
    signal,
  });
  if (!response.ok) {
    // SAFETY: this is used only for an optional human-readable error; all
    // missing or differently shaped JSON falls back to a constant message.
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error || "This attachment is unavailable.");
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > DOCUMENT_MAX_BYTES) throw new Error("This attachment exceeds 25 MB.");
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) throw new Error("This attachment is empty.");
  if (buffer.byteLength > DOCUMENT_MAX_BYTES) throw new Error("This attachment exceeds 25 MB.");
  const headerName = decodeBase64UrlUtf8(response.headers.get("x-openmausbot-file-name-b64"));
  const fallback = attachmentBasename(path);
  return { bytes: new Uint8Array(buffer), name: safeAttachmentDisplayName(headerName || fallback) };
}

export function validatePdf(bytes: Uint8Array): void {
  if (bytes.byteLength > DOCUMENT_MAX_BYTES) throw new Error("This PDF exceeds 25 MB.");
  if (bytes.byteLength < 5 || new TextDecoder("ascii").decode(bytes.subarray(0, 5)) !== "%PDF-") {
    throw new Error("This file is not a valid PDF.");
  }
}

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/** Reject obvious ZIP bombs and malformed XLSX containers before loading
 * SheetJS. Parsing still happens in a terminable Worker; no workbook code,
 * formulas, links, or macros are executed. */
export function validateXlsxArchive(bytes: Uint8Array): void {
  if (bytes.byteLength > DOCUMENT_MAX_BYTES) throw new Error("This spreadsheet exceeds 25 MB.");
  if (bytes.byteLength < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error("This file is not a valid XLSX workbook.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const floor = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= floor; offset -= 1) {
    if (u32(view, offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("This XLSX archive is incomplete.");
  const entries = u16(view, eocd + 10);
  const centralSize = u32(view, eocd + 12);
  const centralOffset = u32(view, eocd + 16);
  if (entries === 0 || entries > XLSX_MAX_ENTRIES) throw new Error("This XLSX has too many archive entries.");
  if (centralOffset + centralSize > eocd) throw new Error("This XLSX archive is malformed.");

  let cursor = centralOffset;
  let totalUncompressed = 0;
  let hasTypes = false;
  let hasWorkbook = false;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > bytes.byteLength || u32(view, cursor) !== 0x02014b50) throw new Error("This XLSX archive is malformed.");
    const flags = u16(view, cursor + 8);
    const compressed = u32(view, cursor + 20);
    const uncompressed = u32(view, cursor + 24);
    const nameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const commentLength = u16(view, cursor + 32);
    if (flags & 0x1) throw new Error("Encrypted XLSX files cannot be previewed.");
    if (uncompressed > XLSX_MAX_UNCOMPRESSED_BYTES) throw new Error("This XLSX expands beyond the preview limit.");
    if (uncompressed > 1_000_000 && (compressed === 0 || uncompressed / compressed > XLSX_MAX_COMPRESSION_RATIO)) {
      throw new Error("This XLSX is too highly compressed to preview safely.");
    }
    totalUncompressed += uncompressed;
    if (totalUncompressed > XLSX_MAX_UNCOMPRESSED_BYTES) throw new Error("This XLSX expands beyond the preview limit.");
    const nameStart = cursor + 46;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (next > bytes.byteLength) throw new Error("This XLSX archive is malformed.");
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)).replaceAll("\\", "/");
    if (name.startsWith("/") || name.split("/").includes("..")) throw new Error("This XLSX contains an unsafe archive path.");
    hasTypes ||= name === "[Content_Types].xml";
    hasWorkbook ||= name === "xl/workbook.xml";
    cursor = next;
  }
  if (!hasTypes || !hasWorkbook) throw new Error("This ZIP is not an XLSX workbook.");
}
