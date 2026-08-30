import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, File, FileSpreadsheet, LoaderCircle, Minus, Plus, X } from "lucide-react";

import { downloadAttachment, validatePdf, validateXlsxArchive, type DownloadedAttachment } from "@/lib/attachment-documents";
import type { TranscriptFileAttachment } from "@/lib/composer-attachments";

type WorkbookPreview = { sheets: Array<{ name: string; rows: string[][]; rowNumbers?: number[]; truncated: boolean }>; truncated: boolean };
type PreviewWorker = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">;
const PDF_MAX_IMAGE_PIXELS = 16_000_000;
const PDF_MAX_CANVAS_BYTES = 64 * 1024 * 1024;
const PDF_MAX_PAGE_PIXELS = 16_000_000;
const PDF_MAX_PAGES = 2_000;
const PDF_LOAD_TIMEOUT_MS = 15_000;
const PDF_PAGE_TIMEOUT_MS = 10_000;
const PDF_MAX_ACCESSIBLE_TEXT_CHARS = 20_000;
const SPREADSHEET_VISIBLE_ROW_STEP = 100;

export function withPreviewDeadline<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      try { onTimeout(); } catch {}
      reject(new Error(message));
    }, timeoutMs);
    promise.then((value) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      resolve(value);
    }, (reason) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      reject(reason);
    });
  });
}

function saveBytes(file: DownloadedAttachment) {
  const copied = new Uint8Array(file.bytes.byteLength);
  copied.set(file.bytes);
  const url = URL.createObjectURL(new Blob([copied]));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function PdfPages({ file }: { file: DownloadedAttachment }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<import("pdfjs-dist").PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [pageText, setPageText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let task: import("pdfjs-dist").PDFDocumentLoadingTask | undefined;
    let loaded: import("pdfjs-dist").PDFDocumentProxy | undefined;
    void (async () => {
      try {
        validatePdf(file.bytes);
        const pdfjs = await import("pdfjs-dist");
        const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        task = pdfjs.getDocument({
          data: file.bytes.slice(),
          isEvalSupported: false,
          useWorkerFetch: false,
          stopAtErrors: true,
          maxImageSize: PDF_MAX_IMAGE_PIXELS,
          canvasMaxAreaInBytes: PDF_MAX_CANVAS_BYTES,
        });
        loaded = await withPreviewDeadline(task.promise, PDF_LOAD_TIMEOUT_MS, () => { void task?.destroy(); }, "PDF preview timed out while opening.");
        if (!Number.isSafeInteger(loaded.numPages) || loaded.numPages < 1 || loaded.numPages > PDF_MAX_PAGES) {
          await loaded.destroy();
          throw new Error(`This PDF has more than ${PDF_MAX_PAGES.toLocaleString()} pages and cannot be previewed safely.`);
        }
        if (alive) setDocument(loaded);
      } catch (reason) {
        if (alive) setError(reason instanceof Error ? reason.message : "PDF preview failed.");
      }
    })();
    return () => {
      alive = false;
      void task?.destroy();
      void loaded?.destroy();
    };
  }, [file]);

  useEffect(() => {
    if (!document || !canvasRef.current) return;
    let cancelled = false;
    let renderTask: import("pdfjs-dist").RenderTask | undefined;
    let pdfPage: import("pdfjs-dist").PDFPageProxy | undefined;
    setPageText("");
    void (async () => {
      pdfPage = await withPreviewDeadline(document.getPage(page), PDF_PAGE_TIMEOUT_MS, () => { void document.destroy(); }, "PDF page loading timed out.");
      if (cancelled || !canvasRef.current) return;
      const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
      const viewport = pdfPage.getViewport({ scale: zoom * pixelRatio });
      if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0 || viewport.width * viewport.height > PDF_MAX_PAGE_PIXELS) {
        throw new Error("This PDF page is too large to preview safely.");
      }
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Canvas rendering is unavailable.");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `${viewport.width / pixelRatio}px`;
      canvas.style.height = `${viewport.height / pixelRatio}px`;
      renderTask = pdfPage.render({ canvas, canvasContext: context, viewport });
      const textPromise = withPreviewDeadline(pdfPage.getTextContent(), PDF_PAGE_TIMEOUT_MS, () => pdfPage?.cleanup(), "PDF text extraction timed out.")
        .then((content) => content.items.flatMap((item) => "str" in item ? [item.str] : []).join(" ").slice(0, PDF_MAX_ACCESSIBLE_TEXT_CHARS))
        .catch(() => "");
      await withPreviewDeadline(renderTask.promise, PDF_PAGE_TIMEOUT_MS, () => renderTask?.cancel(), "PDF page rendering timed out.");
      const text = await textPromise;
      if (!cancelled) setPageText(text);
    })().catch((reason) => {
      if (!cancelled && reason?.name !== "RenderingCancelledException") setError(reason instanceof Error ? reason.message : "This PDF page could not be rendered.");
    });
    return () => { cancelled = true; renderTask?.cancel(); pdfPage?.cleanup(); };
  }, [document, page, zoom]);

  if (error) return <ViewerError message={error} />;
  if (!document) return <Loading label="Opening PDF…" />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-center gap-2 border-b border-hairline/30 px-3 py-2 text-[12px] text-ink-secondary">
        <button className="rounded p-1 hover:bg-raised disabled:opacity-35" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} aria-label="Previous PDF page"><ChevronLeft size={16} /></button>
        <span className="min-w-20 text-center tabular-nums">Page {page} of {document.numPages}</span>
        <button className="rounded p-1 hover:bg-raised disabled:opacity-35" disabled={page >= document.numPages} onClick={() => setPage((value) => value + 1)} aria-label="Next PDF page"><ChevronRight size={16} /></button>
        <span className="mx-1 h-4 w-px bg-hairline/40" />
        <button className="rounded p-1 hover:bg-raised disabled:opacity-35" disabled={zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))} aria-label="Zoom PDF out"><Minus size={15} /></button>
        <span className="w-11 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
        <button className="rounded p-1 hover:bg-raised disabled:opacity-35" disabled={zoom >= 2.5} onClick={() => setZoom((value) => Math.min(2.5, value + 0.25))} aria-label="Zoom PDF in"><Plus size={15} /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-inset p-4 text-center">
        <canvas ref={canvasRef} className="mx-auto bg-white shadow-xl" aria-label={`PDF page ${page}`} aria-describedby={`pdf-page-text-${page}`}>PDF page {page}. Use the accessible page text below.</canvas>
        <details id={`pdf-page-text-${page}`} className="mx-auto mt-3 max-w-3xl rounded-lg bg-panel p-3 text-left text-[12px] text-ink-secondary">
          <summary className="cursor-pointer font-medium text-ink">Accessible page text</summary>
          <p className="mt-2 whitespace-pre-wrap">{pageText || "No extractable text is available for this page."}</p>
        </details>
      </div>
    </div>
  );
}

export function parseWorkbookInWorker(
  file: DownloadedAttachment,
  signal: AbortSignal,
  createWorker: () => PreviewWorker = () => new Worker(new URL("../workers/xlsx-preview.worker.ts", import.meta.url), { type: "module" }),
  timeoutMs = 15_000,
): Promise<WorkbookPreview> {
  validateXlsxArchive(file.bytes);
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const worker = createWorker();
    let settled = false;
    const timeout = globalThis.setTimeout(() => finish(() => reject(new Error("Spreadsheet preview timed out."))), timeoutMs);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      signal.removeEventListener("abort", aborted);
      worker.terminate();
      callback();
    };
    const aborted = () => finish(() => reject(new DOMException("Aborted", "AbortError")));
    signal.addEventListener("abort", aborted, { once: true });
    worker.onmessage = (event: MessageEvent<{ ok: boolean; result?: WorkbookPreview; error?: string }>) => {
      finish(() => event.data.ok && event.data.result ? resolve(event.data.result) : reject(new Error(event.data.error || "Spreadsheet parsing failed.")));
    };
    worker.onerror = () => finish(() => reject(new Error("Spreadsheet parsing failed.")));
    const transferable = file.bytes.slice().buffer;
    worker.postMessage(transferable, [transferable]);
  });
}

export function WorkbookPreviewView({ book }: { book: WorkbookPreview }) {
  const instanceId = useId().replaceAll(":", "");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [sheet, setSheet] = useState(0);
  const [visibleRows, setVisibleRows] = useState(SPREADSHEET_VISIBLE_ROW_STEP);
  const active = book.sheets[sheet];
  useEffect(() => { setVisibleRows(SPREADSHEET_VISIBLE_ROW_STEP); }, [sheet]);
  if (!active) return <ViewerError message="This workbook has no visible worksheets." />;
  const shownRows = active.rows.slice(0, visibleRows);
  const columnCount = Math.min(100, shownRows.reduce((maximum, row) => Math.max(maximum, row.length), 0));
  const selectSheet = (index: number, focus = false) => {
    const normalized = (index + book.sheets.length) % book.sheets.length;
    setSheet(normalized);
    if (focus) queueMicrotask(() => tabRefs.current[normalized]?.focus());
  };
  const columnName = (index: number) => {
    let value = index + 1;
    let label = "";
    while (value > 0) { value -= 1; label = String.fromCharCode(65 + value % 26) + label; value = Math.floor(value / 26); }
    return label;
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label="Workbook sheets" className="flex shrink-0 gap-1 overflow-x-auto border-b border-hairline/30 px-3 py-2">
        {book.sheets.map((item, index) => <button
          key={`${item.name}:${index}`}
          ref={(element) => { tabRefs.current[index] = element; }}
          id={`${instanceId}-sheet-tab-${index}`}
          role="tab"
          tabIndex={index === sheet ? 0 : -1}
          aria-selected={index === sheet}
          aria-controls={`${instanceId}-sheet-panel-${index}`}
          onClick={() => selectSheet(index)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") { event.preventDefault(); selectSheet(index + 1, true); }
            else if (event.key === "ArrowLeft") { event.preventDefault(); selectSheet(index - 1, true); }
            else if (event.key === "Home") { event.preventDefault(); selectSheet(0, true); }
            else if (event.key === "End") { event.preventDefault(); selectSheet(book.sheets.length - 1, true); }
          }}
          className={`shrink-0 rounded-md px-2.5 py-1 text-[11.5px] ${index === sheet ? "bg-accent/15 text-accent-text" : "text-ink-secondary hover:bg-raised"}`}
        >{item.name}</button>)}
      </div>
      {(active.truncated || book.truncated) && <div role="status" className="shrink-0 border-b border-warning/20 bg-warning/10 px-3 py-2 text-[11px] text-warning">Preview limited for safety. Download the workbook to see omitted sheets or cells.</div>}
      <div id={`${instanceId}-sheet-panel-${sheet}`} role="tabpanel" tabIndex={0} aria-labelledby={`${instanceId}-sheet-tab-${sheet}`} className="min-h-0 flex-1 overflow-auto bg-inset p-3">
        {shownRows.length === 0 ? <p className="text-[12px] text-ink-secondary">This worksheet is empty.</p> : <table className="border-collapse bg-panel text-[11.5px] text-ink">
          <caption className="sr-only">Worksheet {active.name}; showing {shownRows.length} of {active.rows.length} preview rows</caption>
          <thead><tr><th scope="col" className="border border-hairline/35 bg-raised px-2 py-1.5" aria-label="Row number" />{Array.from({ length: columnCount }, (_, index) => <th key={index} scope="col" className="border border-hairline/35 bg-raised px-2 py-1.5 font-medium">{columnName(index)}</th>)}</tr></thead>
          <tbody>{shownRows.map((row, rowIndex) => { const sourceRow = active.rowNumbers?.[rowIndex] ?? rowIndex + 1; return <tr key={`${sourceRow}:${rowIndex}`}><th scope="row" className="border border-hairline/35 bg-raised px-2 py-1.5 font-medium tabular-nums">{sourceRow}</th>{Array.from({ length: columnCount }, (_, columnIndex) => <td key={columnIndex} aria-label={`${columnName(columnIndex)}${sourceRow}: ${row[columnIndex] || "blank"}`} className="max-w-[360px] overflow-hidden border border-hairline/35 px-2 py-1.5 align-top whitespace-pre-wrap break-words">{row[columnIndex] || ""}</td>)}</tr>; })}</tbody>
        </table>}
        {visibleRows < active.rows.length && <button className="mt-3 rounded-md border border-hairline/40 bg-panel px-3 py-2 text-[11.5px] text-ink hover:bg-raised" onClick={() => setVisibleRows((value) => Math.min(active.rows.length, value + SPREADSHEET_VISIBLE_ROW_STEP))}>Show {Math.min(SPREADSHEET_VISIBLE_ROW_STEP, active.rows.length - visibleRows)} more rows</button>}
      </div>
    </div>
  );
}

function Spreadsheet({ file }: { file: DownloadedAttachment }) {
  const [book, setBook] = useState<WorkbookPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void parseWorkbookInWorker(file, controller.signal).then(setBook).catch((reason) => {
      if (reason?.name !== "AbortError") setError(reason instanceof Error ? reason.message : "Spreadsheet preview failed.");
    });
    return () => controller.abort();
  }, [file]);
  if (error) return <ViewerError message={error} />;
  if (!book) return <Loading label="Opening spreadsheet…" />;
  return <WorkbookPreviewView book={book} />;
}

function Loading({ label }: { label: string }) { return <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-ink-secondary" role="status"><LoaderCircle size={18} className="animate-spin" />{label}</div>; }
function ViewerError({ message }: { message: string }) { return <div className="flex flex-1 items-center justify-center p-8 text-center text-[13px] text-danger" role="alert">{message}</div>; }
function DownloadOnly({ file }: { file: DownloadedAttachment }) { return <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center"><File size={38} className="text-ink-secondary" /><div><div className="text-[13px] font-medium text-ink">No in-app preview for this file type</div><div className="mt-1 text-[11.5px] text-ink-secondary">Download it without opening or executing it.</div></div><button onClick={() => saveBytes(file)} className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-[12px] font-medium text-white"><Download size={15} />Download file</button></div>; }

export function AttachmentFilePreviewDialog({ attachment, onClose }: { attachment: TranscriptFileAttachment; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const [file, setFile] = useState<DownloadedAttachment | null>(null);
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const controller = new AbortController();
    void downloadAttachment(attachment.path, controller.signal).then(setFile).catch((reason) => {
      if (reason?.name !== "AbortError") setError(reason instanceof Error ? reason.message : "Attachment preview failed.");
    });
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) { event.preventDefault(); dialogRef.current.focus(); }
      else if (event.shiftKey && (document.activeElement === dialogRef.current || document.activeElement === first)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", key);
    return () => { controller.abort(); window.removeEventListener("keydown", key); previous?.focus(); };
  }, [attachment.path]);
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Preview ${attachment.name}`} className="flex h-full max-h-[900px] w-full max-w-[1200px] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl outline-none">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline/30 px-4 py-3">
          <div className="min-w-0"><div className="truncate text-[13px] font-medium text-ink">{file?.name || attachment.name}</div><div className="text-[10.5px] text-ink-secondary">Safe in-app preview</div></div>
          <div className="flex gap-1"><button disabled={!file} onClick={() => file && saveBytes(file)} aria-label={`Download ${attachment.name}`} className="flex size-9 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-35"><Download size={17} /></button><button onClick={onClose} aria-label="Close file preview" className="flex size-9 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"><X size={19} /></button></div>
        </header>
        {error ? <ViewerError message={error} /> : !file ? <Loading label="Loading attachment…" /> : attachment.preview === "pdf" ? <PdfPages file={file} /> : attachment.preview === "xlsx" ? <Spreadsheet file={file} /> : <DownloadOnly file={file} />}
      </div>
    </div>, document.body,
  );
}

export function AttachedFileGallery({ files }: { files: TranscriptFileAttachment[] }) {
  const [selected, setSelected] = useState<TranscriptFileAttachment | null>(null);
  if (!files.length) return null;
  return <><div className="mb-2 flex flex-wrap justify-end gap-2">{files.map((file, index) => {
    const Icon = file.preview === "xlsx" ? FileSpreadsheet : File;
    return <button key={`${file.name}:${index}`} onClick={() => setSelected(file)} aria-label={file.preview ? `Preview attached file ${file.name}` : `Download attached file ${file.name}`} className="flex max-w-[260px] items-center gap-2 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-left hover:border-hairline"><Icon size={16} className="shrink-0 text-ink-secondary" /><span className="truncate text-[12px] text-ink">{file.name}</span><span className="rounded bg-accent/10 px-1.5 py-0.5 text-[9.5px] uppercase text-accent-text">{file.preview ? "Preview" : "Download"}</span></button>;
  })}</div>{selected && <AttachmentFilePreviewDialog attachment={selected} onClose={() => setSelected(null)} />}</>;
}
