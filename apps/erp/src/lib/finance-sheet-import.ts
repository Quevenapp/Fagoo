// Reading of the spreadsheets attached to the Origin-style importers (categorias, registros financeiros): CSV (";" or ","
// separated, quoted, with or without BOM) and XLSX (first worksheet; shared and inline strings). Everything runs in the
// browser; the file never leaves it. Cells are returned as text, never as floating point numbers.
export const SHEET_MAX_BYTES = 2 * 1024 * 1024;
export const SHEET_MAX_ROWS = 2001;
const MAX_INFLATED = 24 * 1024 * 1024, MAX_COLUMNS = 40;
export class SheetError extends Error {}
const fail = (message: string): never => { throw new SheetError(message); };

/** CSV in the pt-BR convention (";"), also accepting ",". Returns trimmed cells; empty trailing rows are dropped. */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^﻿/, '');
  const first = source.split(/\r?\n/, 1)[0] ?? '';
  const separator = (first.match(/;/g)?.length ?? 0) >= (first.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) { if (char === '"') { if (source[index + 1] === '"') { cell += '"'; index++; } else quoted = false; } else cell += char; continue; }
    if (char === '"' && cell === '') { quoted = true; continue; }
    if (char === separator) { row.push(cell.trim()); cell = ''; if (row.length > MAX_COLUMNS) fail('A planilha tem colunas demais.'); continue; }
    if (char === '\n' || char === '\r') { if (char === '\r' && source[index + 1] === '\n') index++; row.push(cell.trim()); rows.push(row); row = []; cell = ''; if (rows.length > SHEET_MAX_ROWS) fail('A planilha tem linhas demais.'); continue; }
    cell += char;
  }
  if (quoted) fail('A planilha tem aspas sem fechamento.');
  if (cell !== '' || row.length) { row.push(cell.trim()); rows.push(row); }
  while (rows.length && rows[rows.length - 1].every(value => value === '')) rows.pop();
  return rows;
}

const u16 = (bytes: Uint8Array, at: number) => bytes[at] | (bytes[at + 1] << 8);
const u32 = (bytes: Uint8Array, at: number) => (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
async function inflate(data: Uint8Array, method: number, size: number): Promise<Uint8Array> {
  if (size > MAX_INFLATED) fail('A planilha é grande demais.');
  if (method === 0) return data;
  if (method !== 8 || typeof DecompressionStream !== 'function') fail('Formato de planilha não suportado. Salve como .xlsx ou .csv.');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader(), parts: Uint8Array[] = []; let total = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > MAX_INFLATED) { await reader.cancel(); fail('A planilha é grande demais.'); } parts.push(value); }
  const out = new Uint8Array(total); let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}
/** Entries of a ZIP file (names → content). Only what the XLSX reader needs. */
async function unzip(bytes: Uint8Array, wanted: (name: string) => boolean): Promise<Map<string, string>> {
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) if (u32(bytes, at) === 0x06054b50) { end = at; break; }
  if (end < 0) fail('O arquivo não é uma planilha .xlsx válida.');
  const count = u16(bytes, end + 10), files = new Map<string, string>(); let at = u32(bytes, end + 16);
  const decoder = new TextDecoder('utf-8');
  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.length || u32(bytes, at) !== 0x02014b50) fail('O arquivo não é uma planilha .xlsx válida.');
    const method = u16(bytes, at + 10), compressed = u32(bytes, at + 20), size = u32(bytes, at + 24), nameLength = u16(bytes, at + 28), extra = u16(bytes, at + 30), comment = u16(bytes, at + 32), local = u32(bytes, at + 42);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extra + comment;
    if (!wanted(name)) continue;
    if (local + 30 > bytes.length || u32(bytes, local) !== 0x04034b50) fail('O arquivo não é uma planilha .xlsx válida.');
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    if (start + compressed > bytes.length) fail('O arquivo não é uma planilha .xlsx válida.');
    files.set(name, decoder.decode(await inflate(bytes.subarray(start, start + compressed), method, size)));
  }
  return files;
}
const entity = (value: string) => value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code: string) => code[0] === '#' ? String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)))
  : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[code.toLowerCase()]);
const runs = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match => entity(match[1])).join('');
const columnIndex = (ref: string) => { let n = 0; for (const char of ref.replace(/\d+$/, '')) n = n * 26 + char.charCodeAt(0) - 64; return n - 1; };
/** First worksheet of an XLSX file as rows of text cells. */
export async function readXlsx(bytes: Uint8Array): Promise<string[][]> {
  const files = await unzip(bytes, name => name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  const sheetName = [...files.keys()].filter(name => name.startsWith('xl/worksheets/')).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))[0];
  if (!sheetName) fail('A planilha não tem nenhuma aba.');
  const shared = [...(files.get('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(match => runs(match[1]));
  const rows: string[][] = [];
  for (const rowMatch of files.get(sheetName)!.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
    const row: string[] = [];
    for (const cell of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1], body = cell[2] ?? '', ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1], type = /\bt="(\w+)"/.exec(attrs)?.[1];
      const index = ref ? columnIndex(ref) : row.length; if (index >= MAX_COLUMNS) fail('A planilha tem colunas demais.');
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      const value = type === 's' ? shared[Number(raw)] ?? '' : type === 'inlineStr' ? runs(body) : type === 'b' ? (raw === '1' ? 'VERDADEIRO' : 'FALSO') : raw === undefined ? '' : entity(raw);
      while (row.length < index) row.push('');
      row[index] = value.trim();
    }
    rows.push(row); if (rows.length > SHEET_MAX_ROWS) fail('A planilha tem linhas demais.');
  }
  while (rows.length && rows[rows.length - 1].every(value => value === '')) rows.pop();
  return rows;
}
/** Reads an attached file (.csv or .xlsx) after the size check. */
export async function readSheet(name: string, bytes: Uint8Array): Promise<string[][]> {
  if (bytes.byteLength === 0) fail('O arquivo está vazio.');
  if (bytes.byteLength > SHEET_MAX_BYTES) fail('O arquivo passa de 2 MB.');
  if (/\.xlsx$/i.test(name)) return readXlsx(bytes);
  if (/\.csv$/i.test(name) || /\.txt$/i.test(name)) {
    let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = new TextDecoder('windows-1252').decode(bytes); }
    return parseCsv(text);
  }
  return fail('Anexe um arquivo .xlsx ou .csv.');
}
/** Header-based rows: each line becomes { header: value }, ignoring empty lines; headers are matched without accents and case. */
export function sheetRecords(rows: readonly (readonly string[])[], headers: readonly string[]): { line: number; values: Record<string, string> }[] {
  const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  if (!rows.length) fail('A planilha está vazia.');
  const header = rows[0].map(fold), positions = headers.map(name => header.indexOf(fold(name)));
  const missing = headers.filter((_, index) => positions[index] < 0); if (missing.length === headers.length) fail(`A primeira linha deve ter os títulos das colunas: ${headers.join(', ')}.`);
  return rows.slice(1).map((row, index) => ({ line: index + 2, values: Object.fromEntries(headers.map((name, column) => [name, positions[column] < 0 ? '' : (row[positions[column]] ?? '').trim()])) }))
    .filter(entry => Object.values(entry.values).some(value => value !== ''));
}
