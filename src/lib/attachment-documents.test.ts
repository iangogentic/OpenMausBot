import { afterEach, describe, expect, it, vi } from "vitest";

import { DOCUMENT_MAX_BYTES, downloadAttachment, validatePdf, validateXlsxArchive } from "./attachment-documents";

function write16(bytes: Uint8Array, offset: number, value: number) { new DataView(bytes.buffer).setUint16(offset, value, true); }
function write32(bytes: Uint8Array, offset: number, value: number) { new DataView(bytes.buffer).setUint32(offset, value, true); }

function centralArchive(names: string[], opts: { uncompressed?: number; compressed?: number } = {}): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = names.map((name) => encoder.encode(name));
  const centralSize = encoded.reduce((sum, name) => sum + 46 + name.length, 0);
  const bytes = new Uint8Array(centralSize + 22);
  let cursor = 0;
  for (const name of encoded) {
    write32(bytes, cursor, 0x02014b50);
    write32(bytes, cursor + 20, opts.compressed ?? 10);
    write32(bytes, cursor + 24, opts.uncompressed ?? 10);
    write16(bytes, cursor + 28, name.length);
    bytes.set(name, cursor + 46);
    cursor += 46 + name.length;
  }
  write32(bytes, cursor, 0x06054b50);
  write16(bytes, cursor + 8, names.length);
  write16(bytes, cursor + 10, names.length);
  write32(bytes, cursor + 12, centralSize);
  write32(bytes, cursor + 16, 0);
  return bytes;
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
    expect(() => validateXlsxArchive(centralArchive(["[Content_Types].xml", "xl/workbook.xml"], { compressed: 1, uncompressed: 2_000_000 }))).toThrow(/highly compressed/);
    expect(() => validateXlsxArchive(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toThrow(/valid XLSX/);
  });
});

describe("downloadAttachment", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the authenticated same-origin POST and decodes filename metadata", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: {
      "content-length": "3",
      "x-openmausbot-file-name-b64": "cmVwb3J0LnBkZg",
    } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(downloadAttachment("/server/private/report.pdf")).resolves.toMatchObject({ name: "report.pdf" });
    expect(fetchMock).toHaveBeenCalledWith("/api/files/download", expect.objectContaining({ method: "POST", body: JSON.stringify({ path: "/server/private/report.pdf" }) }));
  });

  it("rejects declared and actual oversized responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1]), { headers: { "content-length": String(DOCUMENT_MAX_BYTES + 1) } })));
    await expect(downloadAttachment("/safe/a.pdf")).rejects.toThrow(/25 MB/);

    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() { cancelled = true; },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    await expect(downloadAttachment("/safe/streamed.pdf")).rejects.toThrow(/25 MB/);
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
    await expect(downloadAttachment("/safe/error.pdf")).rejects.toThrow(/unavailable/);
    expect(cancelled).toBe(true);
  });
});
