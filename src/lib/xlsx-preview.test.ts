import { describe, expect, it } from "vitest";
import { utils, write, type WorkBook } from "xlsx";

import { XLSX_MAX_CELL_CHARS, XLSX_MAX_CELLS, XLSX_MAX_COLUMNS, XLSX_MAX_ROWS, parseWorkbookPreview } from "./xlsx-preview";

function bytes(workbook: WorkBook): ArrayBuffer {
  // SAFETY: SheetJS documents `type: "array"` as returning ArrayBuffer.
  return write(workbook, { type: "array", bookType: "xlsx", bookVBA: false }) as ArrayBuffer;
}

describe("parseWorkbookPreview", () => {
  it("bounds rows, columns, and strings", () => {
    const rows = Array.from({ length: XLSX_MAX_ROWS + 1 }, (_, row) =>
      Array.from({ length: XLSX_MAX_COLUMNS + 1 }, (_, column) => row === 0 && column === 0 ? "x".repeat(XLSX_MAX_CELL_CHARS + 50) : `${row}:${column}`),
    );
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, utils.aoa_to_sheet(rows), "Bounds");
    const preview = parseWorkbookPreview(bytes(workbook));
    expect(preview.truncated).toBe(true);
    expect(preview.sheets[0]?.rows.length).toBeLessThanOrEqual(XLSX_MAX_ROWS);
    expect(preview.sheets[0]?.rows[0]).toHaveLength(XLSX_MAX_COLUMNS);
    expect((preview.sheets[0]?.rows.length ?? 0) * (preview.sheets[0]?.rows[0]?.length ?? 0)).toBeLessThanOrEqual(XLSX_MAX_CELLS);
    expect(preview.sheets[0]?.rows[0]?.[0]).toHaveLength(XLSX_MAX_CELL_CHARS);
  });

  it("does not expose formula source, links, comments, or HTML", () => {
    const sheet = utils.aoa_to_sheet([[2]]);
    sheet.A1 = { t: "n", v: 2, f: "WEBSERVICE(\"https://attacker.invalid\")", l: { Target: "https://attacker.invalid" }, c: [{ a: "x", t: "secret" }], h: "<script>evil()</script>" };
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, sheet, "Safe");
    const serialized = JSON.stringify(parseWorkbookPreview(bytes(workbook)));
    expect(serialized).toContain('"2"');
    expect(serialized).not.toMatch(/WEBSERVICE|attacker|script|secret/);
  });
});
