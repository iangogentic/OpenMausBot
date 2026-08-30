import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";

import { AttachedFileGallery, parseWorkbookInWorker, withPreviewDeadline, WorkbookPreviewView } from "./AttachmentFilePreview";

function validXlsxContainer(): Uint8Array {
  return zipSync({ "[Content_Types].xml": new Uint8Array([1]), "xl/workbook.xml": new Uint8Array([1]) });
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

  it("cancels an operation deterministically at its deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => { throw new Error("cancellation failure"); });
    const pending = withPreviewDeadline(new Promise<never>(() => {}), 20, cancel, "Preview timed out.");
    const rejection = expect(pending).rejects.toThrow("Preview timed out.");
    await vi.advanceTimersByTimeAsync(21);
    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("renders bounded accessible worksheet tabs, coordinates, caption, and progressive rows", () => {
    const rows = Array.from({ length: 150 }, (_, index) => [`row ${index + 1}`, "value"]);
    const markup = renderToStaticMarkup(createElement(WorkbookPreviewView, { book: { sheets: [
      { name: "First", rows, truncated: false },
      { name: "Second", rows: [["two"]], truncated: false },
    ], truncated: false } }));
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('role="tabpanel"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain("Worksheet First; showing 100 of 150 preview rows");
    expect(markup).toContain('aria-label="A1: row 1"');
    expect(markup).toContain("Show 50 more rows");
    expect(markup).not.toContain("row 101");
  });
});
