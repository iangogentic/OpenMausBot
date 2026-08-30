import { safeAttachmentDisplayName } from "./composer-attachments";

export const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;
export const XLSX_MAX_ENTRIES = 2_000;
export const XLSX_MAX_UNCOMPRESSED_BYTES = 75 * 1024 * 1024;
export const XLSX_MAX_COMPRESSION_RATIO = 200;
const ZIP_FLAG_ENCRYPTED = 0x0001;
const ZIP_FLAG_DATA_DESCRIPTOR = 0x0008;
const ZIP_FLAG_UTF8 = 0x0800;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;

export type DownloadedAttachment = {
  bytes: Uint8Array;
  name: string;
};

const ATTACHMENT_ERROR_MAX_BYTES = 64 * 1024;

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("This attachment response has no readable body.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("attachment response exceeded its bounded size").catch(() => {});
        throw new Error(maxBytes === DOCUMENT_MAX_BYTES
          ? "This attachment exceeds 25 MB."
          : "This attachment error response was too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

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
export type AttachmentDownloadReference = {
  threadId: string;
  messageId?: string;
  attachmentId: string;
  draft?: boolean;
};

export async function downloadAttachment(reference: AttachmentDownloadReference, signal?: AbortSignal): Promise<DownloadedAttachment> {
  if (!/^[\w-]{1,128}$/.test(reference.threadId) || !/^[0-9a-f-]{36}$/i.test(reference.attachmentId)) {
    throw new Error("This attachment reference is invalid.");
  }
  const response = await fetch("/api/files/attachment", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reference),
    signal,
  });
  if (!response.ok) {
    const errorBytes = await readBoundedBody(response, ATTACHMENT_ERROR_MAX_BYTES).catch(() => new Uint8Array());
    let detail: { error?: string } | null = null;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(errorBytes)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) detail = parsed as { error?: string };
    } catch {}
    throw new Error(detail?.error || "This attachment is unavailable.");
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > DOCUMENT_MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("This attachment exceeds 25 MB.");
  }
  const bytes = await readBoundedBody(response, DOCUMENT_MAX_BYTES);
  if (bytes.byteLength === 0) throw new Error("This attachment is empty.");
  const headerName = decodeBase64UrlUtf8(response.headers.get("x-openmausbot-file-name-b64"));
  const fallback = "attachment";
  return { bytes, name: safeAttachmentDisplayName(headerName || fallback) };
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
  const commentLength = u16(view, eocd + 20);
  if (eocd + 22 + commentLength !== bytes.byteLength) throw new Error("This XLSX archive has trailing or malformed data.");
  if (u16(view, eocd + 4) !== 0 || u16(view, eocd + 6) !== 0) throw new Error("Multi-disk XLSX archives cannot be previewed.");
  const diskEntries = u16(view, eocd + 8);
  const entries = u16(view, eocd + 10);
  const centralSize = u32(view, eocd + 12);
  const centralOffset = u32(view, eocd + 16);
  if (diskEntries !== entries) throw new Error("Multi-disk XLSX archives cannot be previewed.");
  if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff || (eocd >= 20 && u32(view, eocd - 20) === 0x07064b50)) {
    throw new Error("ZIP64 XLSX archives cannot be previewed.");
  }
  if (entries === 0 || entries > XLSX_MAX_ENTRIES) throw new Error("This XLSX has too many archive entries.");
  if (centralOffset + centralSize !== eocd) throw new Error("This XLSX archive is malformed.");

  let cursor = centralOffset;
  let totalUncompressed = 0;
  let hasTypes = false;
  let hasWorkbook = false;
  const archiveNames = new Set<string>();
  const localRanges: Array<[number, number]> = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > bytes.byteLength || u32(view, cursor) !== 0x02014b50) throw new Error("This XLSX archive is malformed.");
    const flags = u16(view, cursor + 8);
    const method = u16(view, cursor + 10);
    const crc = u32(view, cursor + 16);
    const compressed = u32(view, cursor + 20);
    const uncompressed = u32(view, cursor + 24);
    const nameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const commentLength = u16(view, cursor + 32);
    const localOffset = u32(view, cursor + 42);
    if (flags & ZIP_FLAG_ENCRYPTED) throw new Error("Encrypted XLSX files cannot be previewed.");
    if (method !== ZIP_METHOD_STORE && method !== ZIP_METHOD_DEFLATE) throw new Error("This XLSX uses an unsupported compression method.");
    if (uncompressed > XLSX_MAX_UNCOMPRESSED_BYTES) throw new Error("This XLSX expands beyond the preview limit.");
    if (uncompressed > 1_000_000 && (compressed === 0 || uncompressed / compressed > XLSX_MAX_COMPRESSION_RATIO)) {
      throw new Error("This XLSX is too highly compressed to preview safely.");
    }
    totalUncompressed += uncompressed;
    if (totalUncompressed > XLSX_MAX_UNCOMPRESSED_BYTES) throw new Error("This XLSX expands beyond the preview limit.");
    const nameStart = cursor + 46;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (next > bytes.byteLength) throw new Error("This XLSX archive is malformed.");
    let name: string;
    try { name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)); }
    catch { throw new Error("This XLSX contains an invalid UTF-8 archive path."); }
    if (!(flags & ZIP_FLAG_UTF8) && bytes.subarray(nameStart, nameStart + nameLength).some((value) => value >= 0x80)) {
      throw new Error("This XLSX contains a non-UTF-8 archive path.");
    }
    if (!name || name.includes("\\") || name.startsWith("/") || name.split("/").includes("..") || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new Error("This XLSX contains an unsafe archive path.");
    }
    if (archiveNames.has(name)) throw new Error("This XLSX contains duplicate archive paths.");
    archiveNames.add(name);
    hasTypes ||= name === "[Content_Types].xml";
    hasWorkbook ||= name === "xl/workbook.xml";
    if (localOffset + 30 > centralOffset || u32(view, localOffset) !== 0x04034b50) throw new Error("This XLSX archive has an invalid local entry.");
    const localFlags = u16(view, localOffset + 6);
    const localMethod = u16(view, localOffset + 8);
    const localCrc = u32(view, localOffset + 14);
    const localCompressed = u32(view, localOffset + 18);
    const localUncompressed = u32(view, localOffset + 22);
    const localNameLength = u16(view, localOffset + 26);
    const localExtraLength = u16(view, localOffset + 28);
    const localNameStart = localOffset + 30;
    const localDataStart = localNameStart + localNameLength + localExtraLength;
    let localDataEnd = localDataStart + compressed;
    if (localDataEnd > centralOffset || localFlags !== flags || localMethod !== method) {
      throw new Error("This XLSX archive has inconsistent local metadata.");
    }
    if (flags & ZIP_FLAG_DATA_DESCRIPTOR) {
      let descriptor = localDataEnd;
      if (descriptor + 4 <= centralOffset && u32(view, descriptor) === 0x08074b50) descriptor += 4;
      if (descriptor + 12 > centralOffset || u32(view, descriptor) !== crc || u32(view, descriptor + 4) !== compressed || u32(view, descriptor + 8) !== uncompressed) {
        throw new Error("This XLSX archive has an invalid data descriptor.");
      }
      localDataEnd = descriptor + 12;
    } else if (localCrc !== crc || localCompressed !== compressed || localUncompressed !== uncompressed) {
      throw new Error("This XLSX archive has inconsistent local sizes.");
    }
    const localName = bytes.subarray(localNameStart, localNameStart + localNameLength);
    const centralName = bytes.subarray(nameStart, nameStart + nameLength);
    if (localNameLength !== nameLength || localName.some((value, position) => value !== centralName[position])) {
      throw new Error("This XLSX archive has inconsistent entry names.");
    }
    localRanges.push([localOffset, localDataEnd]);
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize) throw new Error("This XLSX central directory is malformed.");
  localRanges.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index]![0] < localRanges[index - 1]![1]) throw new Error("This XLSX archive contains overlapping entries.");
  }
  if (!hasTypes || !hasWorkbook) throw new Error("This ZIP is not an XLSX workbook.");
}
