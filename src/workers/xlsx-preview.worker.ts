/// <reference lib="webworker" />
import { parseWorkbookPreview } from "../lib/xlsx-preview";

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  try {
    const result = parseWorkbookPreview(event.data);
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : "Spreadsheet parsing failed." });
  }
};
