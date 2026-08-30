import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AttachedFileGallery, parseWorkbookInWorker } from "./AttachmentFilePreview";

function validXlsxContainer(): Uint8Array {
  const names = ["[Content_Types].xml", "xl/workbook.xml"].map((name) => new TextEncoder().encode(name));
  const size = names.reduce((total, name) => total + 46 + name.length, 0);
  const bytes = new Uint8Array(size + 22);
  const view = new DataView(bytes.buffer);
  let cursor = 0;
  for (const name of names) {
    view.setUint32(cursor, 0x02014b50, true);
    view.setUint32(cursor + 20, 10, true);
    view.setUint32(cursor + 24, 10, true);
    view.setUint16(cursor + 28, name.length, true);
    bytes.set(name, cursor + 46);
    cursor += 46 + name.length;
  }
  view.setUint32(cursor, 0x06054b50, true);
  view.setUint16(cursor + 8, names.length, true);
  view.setUint16(cursor + 10, names.length, true);
  view.setUint32(cursor + 12, size, true);
  return bytes;
}

afterEach(() => vi.useRealTimers());

describe("AttachedFileGallery", () => {
  it("renders safe preview chips without revealing server paths", () => {
    const markup = renderToStaticMarkup(createElement(AttachedFileGallery, { files: [
      { path: "/var/lib/openmausbot/private/report.pdf", name: "report.pdf", preview: "pdf" },
      { path: "/var/lib/openmausbot/private/archive.zip", name: "archive.zip", preview: null },
    ] }));
    expect(markup).toContain("report.pdf");
    expect(markup).toContain("archive.zip");
    expect(markup).not.toContain("/var/lib/openmausbot");
    expect(markup).toContain("Preview");
    expect(markup).toContain("Download");
    expect(markup).not.toContain("disabled");
  });

  it("terminates a spreadsheet worker that exceeds the parser deadline", async () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const worker = { postMessage: vi.fn(), terminate, onmessage: null, onerror: null };
    const pending = parseWorkbookInWorker(
      { bytes: validXlsxContainer(), name: "book.xlsx" },
      new AbortController().signal,
      () => worker,
      10,
    );
    const rejection = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(11);
    await rejection;
    expect(terminate).toHaveBeenCalledOnce();
  });
});
