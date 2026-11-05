// A one-sheet workbook (Office Open XML) with inline strings and a bold header row, for push summaries (./summary.ts).
import { ZipWriter } from "./zip.ts";

/** Excel's limit for the text of one cell. */
const CELL_MAX = 32_767;

/** XML 1.0 characters: tab, newline, carriage return, U+0020–U+D7FF, U+E000–U+FFFD and above U+FFFF. */
function allowed(char: string): boolean {
  const code = char.codePointAt(0)!;
  return code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || code >= 0x10000;
}

function xml(text: string): string {
  // Characters XML 1.0 does not allow are dropped; the rest is escaped.
  return [...text].filter(allowed).join("")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function column(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
  return name;
}

function cell(ref: string, value: string | number | null, style: number): string {
  if (value === null || value === "") return style ? `<c r="${ref}" s="${style}"/>` : "";
  if (typeof value === "number") return `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${value}</v></c>`;
  const text = [...value].length > CELL_MAX ? [...value].slice(0, CELL_MAX - 1).join("") + "…" : value;
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
}

export type Sheet = { name: string; columns: readonly { title: string; width: number }[]; rows: readonly (readonly (string | number | null)[])[] };

function sheetXml(sheet: Sheet): string {
  const header = `<row r="1">${sheet.columns.map((col, index) => cell(`${column(index)}1`, col.title, 1)).join("")}</row>`;
  const rows = sheet.rows.map((row, r) => `<row r="${r + 2}">${row.map((value, index) => cell(`${column(index)}${r + 2}`, value, 2)).join("")}</row>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    + `<cols>${sheet.columns.map((col, index) => `<col min="${index + 1}" max="${index + 1}" width="${col.width}" customWidth="1"/>`).join("")}</cols>`
    + `<sheetData>${header}${rows.join("")}</sheetData></worksheet>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
// Style 1: bold header with a fill; style 2: wrapped text, top aligned.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** Write the workbook to `path` (must not exist). */
export async function writeWorkbook(path: string, sheet: Sheet, at = Date.now()): Promise<void> {
  const name = xml(sheet.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet1");
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const zip = await ZipWriter.create(path, at);
  try {
    const text = (value: string) => new TextEncoder().encode(value);
    await zip.addBuffer("[Content_Types].xml", text(CONTENT_TYPES));
    await zip.addBuffer("_rels/.rels", text(ROOT_RELS));
    await zip.addBuffer("xl/workbook.xml", text(workbook));
    await zip.addBuffer("xl/_rels/workbook.xml.rels", text(WORKBOOK_RELS));
    await zip.addBuffer("xl/styles.xml", text(STYLES));
    await zip.addBuffer("xl/worksheets/sheet1.xml", text(sheetXml(sheet)));
  } catch (error) { await zip.abort(); throw error; }
  await zip.close();
}
