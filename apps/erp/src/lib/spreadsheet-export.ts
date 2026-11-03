// "Exportar" do Origin para planilhas: CSV (separado por ponto e vírgula, com BOM) e XLSX mínimo (OOXML sem compressão).
// Números saem do texto decimal exato; nada passa por ponto flutuante. Textos que pareçam fórmulas são neutralizados.
export type SheetCell = { text: string } | { number: string };
const FORMULA = /^[\s\u0000-\u001f]*[=+@-]|^[\t\r\n]/u;
const DECIMAL = /^-?(0|[1-9]\d*)(?:\.\d+)?$/;
export const textCell = (value: string | null | undefined): SheetCell => ({ text: value ?? '' });
export const numberCell = (value: string | null | undefined): SheetCell => typeof value === 'string' && DECIMAL.test(value) ? { number: value } : { text: value ?? '' };
const plain = (cell: SheetCell) => 'text' in cell ? cell.text : cell.number;
const safeText = (value: string) => FORMULA.test(value) && !DECIMAL.test(value) ? `'${value}` : value;
/** CSV in the pt-BR spreadsheet convention: ";" separator and decimal comma; every cell quoted. */
export function toCsv(rows: readonly (readonly SheetCell[])[]): string {
  const cell = (value: SheetCell) => `"${('number' in value ? value.number.replace('.', ',') : safeText(value.text)).replaceAll('"', '""')}"`;
  return '﻿' + rows.map(row => row.map(cell).join(';')).join('\r\n') + '\r\n';
}
const xml = (value: string) => value.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const column = (index: number) => { let name = '', n = index + 1; while (n > 0) { const r = (n - 1) % 26; name = String.fromCharCode(65 + r) + name; n = Math.floor((n - 1) / 26); } return name; };
// Excel keeps 15 significant digits; a longer exact decimal is written as text so it is never rounded.
const excelNumber = (value: string) => { const trimmed = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value; return trimmed.replace(/^-/, '').replace('.', '').replace(/^0+/, '').length <= 15 ? trimmed : null; };
function sheetXml(rows: readonly (readonly SheetCell[])[]): string {
  const body = rows.map((row, r) => `<row r="${r + 1}">${row.map((cell, c) => {
    const ref = `${column(c)}${r + 1}`, number = 'number' in cell ? excelNumber(cell.number) : null;
    return number !== null ? `<c r="${ref}"><v>${number}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(safeText(plain(cell)))}</t></is></c>`;
  }).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}
const CRC = (() => { const table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
const crc32 = (data: Uint8Array) => { let c = 0xffffffff; for (const byte of data) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
/** ZIP with stored (uncompressed) entries: enough for the OOXML parts of one sheet. */
export function zipStore(files: readonly { name: string; data: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder(), local: Uint8Array[] = [], central: Uint8Array[] = []; let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name), crc = crc32(file.data), size = file.data.length;
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true); header.setUint16(4, 20, true); header.setUint16(6, 0x0800, true); header.setUint16(8, 0, true);
    header.setUint32(14, crc, true); header.setUint32(18, size, true); header.setUint32(22, size, true); header.setUint16(26, name.length, true);
    local.push(new Uint8Array(header.buffer), name, file.data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 20, true); entry.setUint16(6, 20, true); entry.setUint16(8, 0x0800, true);
    entry.setUint32(16, crc, true); entry.setUint32(20, size, true); entry.setUint32(24, size, true); entry.setUint16(28, name.length, true); entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + size;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  const parts = [...local, ...central, new Uint8Array(end.buffer)], out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
export function toXlsx(sheetName: string, rows: readonly (readonly SheetCell[])[]): Uint8Array {
  const encode = (value: string) => new TextEncoder().encode(value), name = xml(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Planilha');
  return zipStore([
    { name: '[Content_Types].xml', data: encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>') },
    { name: '_rels/.rels', data: encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
    { name: 'xl/workbook.xml', data: encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') },
    { name: 'xl/styles.xml', data: encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>') },
    { name: 'xl/worksheets/sheet1.xml', data: encode(sheetXml(rows)) },
  ]);
}
/** Browser download of a generated file; nothing is uploaded. */
export function downloadFile(filename: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type })), anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const CSV_TYPE = 'text/csv;charset=utf-8';
