import { unzipSync } from "fflate";
import { Parser } from "saxen";

export const XLSX_MAX_SHEETS = 20;
export const XLSX_MAX_ROWS = 1_000;
export const XLSX_MAX_COLUMNS = 100;
export const XLSX_MAX_CELLS = 5_000;
export const XLSX_MAX_CELL_CHARS = 10_000;
export const XLSX_MAX_TEXT_CHARS = 300_000;

const XLSX_MAX_XML_BYTES = 32 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const WORKSHEET_RELATIONSHIP_TYPES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet",
]);

export type WorkbookPreview = { sheets: Array<{ name: string; rows: string[][]; rowNumbers: number[]; truncated: boolean }>; truncated: boolean };
type Attributes = Record<string, string>;
type SaxDecode = (value: string) => string;

function localName(name: string): string { return name.slice(name.lastIndexOf(":") + 1); }

function xmlText(bytes: Uint8Array, label: string): string {
  if (bytes.byteLength > XLSX_MAX_XML_BYTES) throw new Error(`${label} exceeds the preview limit.`);
  let value: string;
  try { value = decoder.decode(bytes); } catch { throw new Error(`${label} is not valid UTF-8.`); }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(value)) throw new Error(`${label} contains prohibited XML declarations.`);
  return value;
}

function parseXml(xml: string, handlers: {
  open?: (name: string, attributes: Attributes) => void;
  close?: (name: string) => void;
  text?: (value: string) => void;
}): void {
  const parser = new Parser();
  let parseError: Error | null = null;
  parser.on("openTag", (name: string, getAttributes: () => Attributes, decode: SaxDecode) => {
    const attributes: Attributes = Object.create(null) as Attributes;
    for (const [key, value] of Object.entries(getAttributes())) attributes[key] = decode(value);
    handlers.open?.(localName(name), attributes);
  });
  parser.on("closeTag", (name: string) => handlers.close?.(localName(name)));
  parser.on("text", (value: string, decode: SaxDecode) => handlers.text?.(decode(value)));
  parser.on("cdata", (value: string) => handlers.text?.(value));
  parser.on("error", (error: Error) => { parseError = error; });
  const returned = parser.parse(xml);
  if (parseError) throw parseError;
  if (returned instanceof Error) throw returned;
}

function relationshipTarget(target: string): string {
  if (!target || target.includes("\\") || /[\u0000-\u001f\u007f?#%]/.test(target) || /^[a-z]+:/i.test(target) || target.startsWith("/")) {
    throw new Error("This XLSX contains an unsafe relationship target.");
  }
  const segments = target.replace(/^\.\//, "").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error("This XLSX contains an unsafe relationship target.");
  const normalized = segments[0] === "xl" ? segments.join("/") : `xl/${segments.join("/")}`;
  if (!/^xl\/worksheets\/[^/]+\.xml$/i.test(normalized)) throw new Error("This XLSX contains an invalid worksheet target.");
  return normalized;
}

function columnIndex(reference: string): number | null {
  const match = /^([A-Za-z]{1,3})[1-9][0-9]*$/.exec(reference);
  if (!match) return null;
  let result = 0;
  for (const character of match[1]!.toUpperCase()) result = result * 26 + character.charCodeAt(0) - 64;
  return result - 1;
}

/** Parse a deliberately small, display-only subset of OOXML. Only workbook
 * relationships, shared strings, and worksheet cell values are extracted.
 * Dimensions, formulas, links, comments, macros, styles, and external
 * relationships are never interpreted. */
export function parseWorkbookPreview(buffer: ArrayBuffer): WorkbookPreview {
  const bytes = new Uint8Array(buffer);
  const allowed = /^(?:xl\/workbook\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/sharedStrings\.xml|xl\/worksheets\/[^/]+\.xml)$/;
  const archive = unzipSync(bytes, {
    filter(file) {
      if (file.name.startsWith("/") || file.name.includes("\\") || file.name.split("/").includes("..")) throw new Error("This XLSX contains an unsafe archive path.");
      return allowed.test(file.name);
    },
  });
  const workbookBytes = archive["xl/workbook.xml"];
  const relationsBytes = archive["xl/_rels/workbook.xml.rels"];
  if (!workbookBytes || !relationsBytes) throw new Error("This workbook is missing required metadata.");

  const relationships = new Map<string, string>();
  const relationshipPaths = new Set<string>();
  parseXml(xmlText(relationsBytes, "Workbook relationships"), {
    open(name, attributes) {
      if (name !== "Relationship") return;
      if (attributes.TargetMode?.toLowerCase() === "external") throw new Error("External workbook relationships cannot be previewed.");
      if (!attributes.Id || !attributes.Target || !WORKSHEET_RELATIONSHIP_TYPES.has(attributes.Type || "")) return;
      if (relationships.has(attributes.Id)) throw new Error("This workbook contains duplicate relationship IDs.");
      const path = relationshipTarget(attributes.Target);
      if (relationshipPaths.has(path)) throw new Error("This workbook contains duplicate worksheet targets.");
      relationships.set(attributes.Id, path);
      relationshipPaths.add(path);
    },
  });

  const sheetRecords: Array<{ name: string; path: string }> = [];
  parseXml(xmlText(workbookBytes, "Workbook metadata"), {
    open(name, attributes) {
      if (name !== "sheet" || sheetRecords.length >= XLSX_MAX_SHEETS + 1) return;
      const id = attributes["r:id"] ?? attributes.id;
      const path = id ? relationships.get(id) : undefined;
      if (id && !path) throw new Error("This workbook references an invalid worksheet relationship.");
      if (path) sheetRecords.push({ name: String(attributes.name || "Sheet").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120) || "Sheet", path });
    },
  });
  if (sheetRecords.length === 0) throw new Error("This workbook has no worksheets.");

  const sharedStrings: string[] = [];
  const sharedBytes = archive["xl/sharedStrings.xml"];
  if (sharedBytes) {
    let inString = false;
    let inText = false;
    let current = "";
    let sharedChars = 0;
    parseXml(xmlText(sharedBytes, "Shared strings"), {
      open(name) { if (name === "si") { inString = true; current = ""; } if (inString && name === "t") inText = true; },
      close(name) {
        if (name === "t") inText = false;
        if (name === "si" && inString) {
          sharedStrings.push(current.slice(0, XLSX_MAX_CELL_CHARS));
          sharedChars += current.length;
          if (sharedStrings.length > XLSX_MAX_CELLS || sharedChars > XLSX_MAX_TEXT_CHARS) throw new Error("Shared strings exceed the preview limit.");
          inString = false;
        }
      },
      text(value) { if (inString && inText) current += value.slice(0, XLSX_MAX_CELL_CHARS + 1 - current.length); },
    });
  }

  let remainingCells = XLSX_MAX_CELLS;
  let remainingText = XLSX_MAX_TEXT_CHARS;
  let truncated = sheetRecords.length > XLSX_MAX_SHEETS;
  const sheets: WorkbookPreview["sheets"] = [];
  for (const record of sheetRecords.slice(0, XLSX_MAX_SHEETS)) {
    const sheetBytes = archive[record.path];
    if (!sheetBytes) continue;
    const rows: string[][] = [];
    const rowNumbers: number[] = [];
    let row: string[] | null = null;
    let rowNumber = 1;
    let cellColumn: number | null = null;
    let cellType = "n";
    let cellText = "";
    let collectingValue = false;
    let sheetTruncated = false;
    parseXml(xmlText(sheetBytes, `Worksheet ${record.name}`), {
      open(name, attributes) {
        if (name === "row") {
          const candidate = Number.parseInt(attributes.r || "", 10);
          rowNumber = Number.isSafeInteger(candidate) && candidate >= 1 && candidate <= 1_048_576 ? candidate : rows.length + 1;
          row = rows.length < XLSX_MAX_ROWS && remainingCells > 0 ? [] : null;
          if (!row) sheetTruncated = true;
        }
        else if (name === "c") { cellColumn = attributes.r ? columnIndex(attributes.r) : row?.length ?? null; cellType = attributes.t || "n"; cellText = ""; }
        else if ((name === "v" || (name === "t" && cellType === "inlineStr")) && cellColumn !== null) collectingValue = true;
      },
      close(name) {
        if (name === "v" || name === "t") collectingValue = false;
        if (name === "c" && cellColumn !== null) {
          if (row && cellColumn < XLSX_MAX_COLUMNS && remainingCells > 0) {
            let value = cellText;
            if (cellType === "s") { const index = Number.parseInt(cellText, 10); value = Number.isSafeInteger(index) && index >= 0 ? sharedStrings[index] ?? "" : ""; }
            else if (cellType === "b") value = cellText === "1" ? "TRUE" : cellText === "0" ? "FALSE" : "";
            value = String(value).slice(0, Math.min(XLSX_MAX_CELL_CHARS, remainingText));
            while (row.length < cellColumn) row.push("");
            row[cellColumn] = value;
            remainingCells -= 1;
            remainingText -= value.length;
          } else if (cellColumn >= XLSX_MAX_COLUMNS || remainingCells <= 0) sheetTruncated = true;
          cellColumn = null; collectingValue = false;
        } else if (name === "row" && row) { rows.push(row); rowNumbers.push(rowNumber); row = null; }
      },
      text(value) { if (collectingValue && cellText.length <= XLSX_MAX_CELL_CHARS) cellText += value.slice(0, XLSX_MAX_CELL_CHARS + 1 - cellText.length); },
    });
    truncated ||= sheetTruncated;
    sheets.push({ name: record.name, rows, rowNumbers, truncated: sheetTruncated });
    if (remainingCells <= 0 || remainingText <= 0) { truncated = true; break; }
  }
  if (sheets.length === 0) throw new Error("This workbook has no readable worksheets.");
  return { sheets, truncated };
}
