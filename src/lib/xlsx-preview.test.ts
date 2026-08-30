import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";

import { XLSX_MAX_CELL_CHARS, XLSX_MAX_COLUMNS, XLSX_MAX_ROWS, parseWorkbookPreview } from "./xlsx-preview";

const encode = (value: string) => new TextEncoder().encode(value);
function workbook(sheetXml: string, extras: Record<string, string> = {}): ArrayBuffer {
  const zipped = zipSync({
    "xl/workbook.xml": encode('<?xml version="1.0"?><workbook xmlns:r="rel"><sheets><sheet name="Bounds" r:id="rId1"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": encode('<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": encode(sheetXml),
    ...Object.fromEntries(Object.entries(extras).map(([name, value]) => [name, encode(value)])),
  });
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
}

describe("parseWorkbookPreview", () => {
  it("reads values while ignoring dimensions, formulas, links, comments, and distant cells", () => {
    const preview = parseWorkbookPreview(workbook(
      '<worksheet><dimension ref="A1:XFD1048576"/><sheetData><row r="1048576"><c r="A1048576" t="s"><f>WEBSERVICE(&quot;https://attacker.invalid&quot;)</f><v>0</v></c><c r="XFD1048576"><v>secret</v></c></row></sheetData></worksheet>',
      { "xl/sharedStrings.xml": '<sst><si><t>safe value</t></si></sst>' },
    ));
    expect(preview.sheets[0]?.rows).toEqual([["safe value"]]);
    expect(JSON.stringify(preview)).not.toMatch(/WEBSERVICE|attacker|secret/);
    expect(preview.truncated).toBe(true);
  });

  it("bounds rows, columns, and cell strings without dense allocation", () => {
    const cells = Array.from({ length: XLSX_MAX_COLUMNS + 1 }, (_, column) => `<c r="${column < 26 ? String.fromCharCode(65 + column) : "XFD"}1" t="inlineStr"><is><t>${"x".repeat(XLSX_MAX_CELL_CHARS + 10)}</t></is></c>`).join("");
    const rows = Array.from({ length: XLSX_MAX_ROWS + 1 }, (_, row) => `<row r="${row + 1}">${row === 0 ? cells : `<c r="A${row + 1}"><v>${row}</v></c>`}</row>`).join("");
    const preview = parseWorkbookPreview(workbook(`<worksheet><sheetData>${rows}</sheetData></worksheet>`));
    expect(preview.truncated).toBe(true);
    expect(preview.sheets[0]?.rows).toHaveLength(XLSX_MAX_ROWS);
    expect(preview.sheets[0]?.rows[0]?.length).toBeLessThanOrEqual(XLSX_MAX_COLUMNS);
    expect(preview.sheets[0]?.rows[0]?.[0]).toHaveLength(XLSX_MAX_CELL_CHARS);
  });

  it("rejects external relationships and prohibited XML declarations", () => {
    const external = zipSync({
      "xl/workbook.xml": encode("<workbook><sheets/></workbook>"),
      "xl/_rels/workbook.xml.rels": encode('<Relationships><Relationship Id="x" Target="https://attacker.invalid" TargetMode="External"/></Relationships>'),
    });
    expect(() => parseWorkbookPreview(external.buffer.slice(external.byteOffset, external.byteOffset + external.byteLength) as ArrayBuffer)).toThrow(/External/);
    expect(() => parseWorkbookPreview(workbook('<!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><worksheet/>'))).toThrow(/prohibited/);
  });
});
