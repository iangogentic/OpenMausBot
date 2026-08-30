import { afterEach, describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";

import { DOCUMENT_MAX_BYTES, downloadAttachment, validatePdf, validateXlsxArchive } from "./attachment-documents";

function write16(bytes: Uint8Array, offset: number, value: number) { new DataView(bytes.buffer).setUint16(offset, value, true); }
function write32(bytes: Uint8Array, offset: number, value: number) { new DataView(bytes.buffer).setUint32(offset, value, true); }

function centralArchive(names: string[], content = new Uint8Array([1])): Uint8Array {
  return zipSync(Object.fromEntries(names.map((name) => [name, content])));
}

function findSignature(bytes: Uint8Array, signature: number, from = 0): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = from; offset <= bytes.byteLength - 4; offset += 1) if (view.getUint32(offset, true) === signature) return offset;
  return -1;
}

describe("document parser guards", () => {
  it("accepts PDF magic and rejects malformed or oversized bytes", () => {
    expect(() => validatePdf(new TextEncoder().encode("%PDF-1.7"))).not.toThrow();
    expect(() => validatePdf(new TextEncoder().encode("<html>"))).toThrow(/not a valid PDF/);
    expect(() => validatePdf(new Uint8Array(DOCUMENT_MAX_BYTES + 1))).toThrow(/25 MB/);
  });

  it("accepts an XLSX-shaped central directory and rejects ZIP traversal and bombs", () => {
    expect(() => validateXlsxArchive(centralArchive(["[Content_Types].xml", "xl/workbook.xml"]))).not.toThrow();
    expect(() => validateXlsxArchive(centralArchive(["[Content_Types].xml", "../xl/workbook.xml"]))).toThrow(/unsafe archive path/);
    const duplicate = centralArchive(["[Content_Types].xml", "xl/workbook.xml", "xl/workbook.xm2"]);
    const needle = new TextEncoder().encode("xl/workbook.xm2");
    const replacement = new TextEncoder().encode("xl/workbook.xml");
    for (let offset = 0; offset <= duplicate.length - needle.length; offset += 1) {
      if (needle.every((value, index) => duplicate[offset + index] === value)) duplicate.set(replacement, offset);
    }
    expect(() => validateXlsxArchive(duplicate)).toThrow(/duplicate archive paths/);
    expect(() => validateXlsxArchive(centralArchive(["[Content_Types].xml", "xl/workbook.xml"], new Uint8Array(2_000_000)))).toThrow(/highly compressed/);
    expect(() => validateXlsxArchive(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toThrow(/valid XLSX/);
  });

  it("rejects ambiguous EOCDs, multi-disk, ZIP64, unsupported compression, and local-name mismatch", () => {
    const trailing = centralArchive(["[Content_Types].xml", "xl/workbook.xml"]);
    const withTrailing = new Uint8Array(trailing.length + 1); withTrailing.set(trailing);
    expect(() => validateXlsxArchive(withTrailing)).toThrow(/trailing or malformed/);

    const multiDisk = centralArchive(["[Content_Types].xml", "xl/workbook.xml"]);
    const eocd = findSignature(multiDisk, 0x06054b50);
    write16(multiDisk, eocd + 4, 1);
    expect(() => validateXlsxArchive(multiDisk)).toThrow(/Multi-disk/);

    const zip64 = centralArchive(["[Content_Types].xml", "xl/workbook.xml"]);
    const zip64Eocd = findSignature(zip64, 0x06054b50);
    write32(zip64, zip64Eocd + 16, 0xffffffff);
    expect(() => validateXlsxArchive(zip64)).toThrow(/ZIP64/);

    const unsupported = centralArchive(["[Content_Types].xml", "xl/workbook.xml"]);
    const local = findSignature(unsupported, 0x04034b50);
    const central = findSignature(unsupported, 0x02014b50);
    write16(unsupported, local + 8, 99); write16(unsupported, central + 10, 99);
    expect(() => validateXlsxArchive(unsupported)).toThrow(/unsupported compression/);

    const mismatch = centralArchive(["[Content_Types].xml", "xl/workbook.xml"]);
    mismatch[30] = "!".charCodeAt(0);
    expect(() => validateXlsxArchive(mismatch)).toThrow(/inconsistent entry names/);

    const sizeMismatch = centralArchive(["[Content_Types].xml", "xl/workbook.xml"]);
    write32(sizeMismatch, 18, 99);
    expect(() => validateXlsxArchive(sizeMismatch)).toThrow(/inconsistent local sizes/);
  });
});

describe("downloadAttachment", () => {
  const reference = { threadId: "thread-1", messageId: "message-1", attachmentId: "123e4567-e89b-42d3-a456-426614174000" };
  afterEach(() => vi.unstubAllGlobals());

  it("uses the authenticated same-origin POST and decodes filename metadata", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: {
      "content-length": "3",
      "x-openmausbot-file-name-b64": "cmVwb3J0LnBkZg",
    } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(downloadAttachment(reference)).resolves.toMatchObject({ name: "report.pdf" });
    expect(fetchMock).toHaveBeenCalledWith("/api/files/attachment", expect.objectContaining({ method: "POST", body: JSON.stringify(reference) }));
  });

  it("rejects declared and actual oversized responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1]), { headers: { "content-length": String(DOCUMENT_MAX_BYTES + 1) } })));
    await expect(downloadAttachment(reference)).rejects.toThrow(/25 MB/);

    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() { cancelled = true; },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    await expect(downloadAttachment(reference)).rejects.toThrow(/25 MB/);
    expect(cancelled).toBe(true);
  });

  it("bounds oversized error responses instead of buffering them", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(32 * 1024).fill(120);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(chunk); },
      cancel() { cancelled = true; },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 500 })));
    await expect(downloadAttachment(reference)).rejects.toThrow(/unavailable/);
    expect(cancelled).toBe(true);
  });
});
