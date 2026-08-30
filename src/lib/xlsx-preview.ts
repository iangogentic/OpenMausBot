import { read, utils, type CellObject, type WorkSheet } from "xlsx";

export const XLSX_MAX_SHEETS = 20;
export const XLSX_MAX_ROWS = 1_000;
export const XLSX_MAX_COLUMNS = 100;
export const XLSX_MAX_CELLS = 25_000;
export const XLSX_MAX_CELL_CHARS = 10_000;
export const XLSX_MAX_TEXT_CHARS = 2_000_000;

export type WorkbookPreview = { sheets: Array<{ name: string; rows: string[][]; truncated: boolean }>; truncated: boolean };

function visibleCell(sheet: WorkSheet, row: number, column: number): string {
  // SAFETY: SheetJS WorkSheet indexes are documented as CellObject entries;
  // missing coordinates are explicitly handled below.
  const cell = sheet[utils.encode_cell({ r: row, c: column })] as CellObject | undefined;
  if (!cell || cell.t === "z") return "";
  const value = utils.format_cell({ ...cell, f: undefined, l: undefined, c: undefined, h: undefined });
  return String(value).slice(0, XLSX_MAX_CELL_CHARS);
}

/** Build a display-only, bounded representation. SheetJS never evaluates
 * formulas; formula source, hyperlinks, comments, HTML, VBA, and external
 * links are discarded before results cross the Worker boundary. */
export function parseWorkbookPreview(buffer: ArrayBuffer): WorkbookPreview {
  const workbook = read(buffer, {
    type: "array",
    dense: false,
    bookVBA: false,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    cellNF: false,
    WTF: false,
  });
  if (workbook.SheetNames.length === 0) throw new Error("This workbook has no worksheets.");
  let remainingCells = XLSX_MAX_CELLS;
  let remainingText = XLSX_MAX_TEXT_CHARS;
  let truncated = workbook.SheetNames.length > XLSX_MAX_SHEETS;
  const sheets: WorkbookPreview["sheets"] = [];
  for (const rawName of workbook.SheetNames.slice(0, XLSX_MAX_SHEETS)) {
    const sheet = workbook.Sheets[rawName];
    if (!sheet) continue;
    const range = sheet["!ref"] ? utils.decode_range(sheet["!ref"]!) : { s: { r: 0, c: 0 }, e: { r: -1, c: -1 } };
    const rowCount = Math.max(0, range.e.r - range.s.r + 1);
    const columnCount = Math.max(0, range.e.c - range.s.c + 1);
    const allowedColumns = Math.min(columnCount, XLSX_MAX_COLUMNS);
    const allowedRows = Math.min(rowCount, XLSX_MAX_ROWS, Math.floor(remainingCells / Math.max(1, allowedColumns)));
    const rows: string[][] = [];
    let contentTruncated = false;
    for (let row = range.s.r; row < range.s.r + allowedRows; row += 1) {
      const values: string[] = [];
      for (let column = range.s.c; column < range.s.c + allowedColumns; column += 1) {
        const rawValue = visibleCell(sheet, row, column);
        const value = rawValue.slice(0, remainingText);
        contentTruncated ||= value.length < rawValue.length;
        remainingText -= value.length;
        values.push(value);
      }
      rows.push(values);
    }
    remainingCells -= rows.length * allowedColumns;
    const sheetTruncated = rowCount > allowedRows || columnCount > allowedColumns || contentTruncated;
    truncated ||= sheetTruncated;
    sheets.push({ name: String(rawName).slice(0, 120), rows, truncated: sheetTruncated });
    if (remainingCells <= 0) break;
  }
  return { sheets, truncated };
}
