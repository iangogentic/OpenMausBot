/// <reference lib="webworker" />
import { parseWorkbookPreview } from "../lib/xlsx-preview";
import { validateXlsxArchive } from "../lib/attachment-documents";

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  try {
    validateXlsxArchive(new Uint8Array(event.data));
    const result = parseWorkbookPreview(event.data);
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : "Spreadsheet parsing failed." });
  }
};
