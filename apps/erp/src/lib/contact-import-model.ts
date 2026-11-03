import { SHEET_COLUMNS, type ContactTypeItem } from './contact-list-model.ts';
import { CONTACT_FORM_FIELDS, CRT_OPTIONS, MARITAL_OPTIONS, OPERATOR_OPTIONS, PUBLIC_AGENCY_OPTIONS, TAXPAYER_OPTIONS, isoDateValid } from './contact-form-model.ts';
import { textCell, toCsv, toXlsx } from './spreadsheet-export.ts';

// Importar contatos (Origin IC-01 e IC-02): planilha .XLSX, .XLS (xls-reader.ts) ou .CSV com o cabeçalho do modelo (o mesmo de "Exportar para
// a planilha"), até 10.000 contatos. Tudo é lido no navegador; o servidor valida e importa em lotes de 50 linhas.
export const IMPORT_LIMIT = 10000;
export const IMPORT_BATCH = 50;
export type ImportRow = { row: number; data: Record<string, unknown>; problems: string[]; ignored: string[] };
const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// ---- Leitura: CSV (; ou ,) em UTF-8 ou Windows-1252, e XLSX (OOXML, primeira planilha) ----
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^﻿/, ''), first = source.split(/\r?\n/, 1)[0] ?? '';
  const separator = (first.match(/;/g) ?? []).length >= (first.match(/,/g) ?? []).length ? ';' : ',';
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) { if (char === '"') { if (source[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += char; continue; }
    if (char === '"' && cell === '') { quoted = true; continue; }
    if (char === separator) { row.push(cell); cell = ''; continue; }
    if (char === '\n' || char === '\r') { if (char === '\r' && source[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += char;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(cells => cells.some(value => value.trim() !== ''));
}
export function decodeText(bytes: Uint8Array) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('windows-1252').decode(bytes); }
}
const unxml = (value: string) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
async function inflate(data: Uint8Array) {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** Entries of a ZIP (central directory), stored or deflated. */
export async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), files = new Map<string, Uint8Array>();
  let end = -1; for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('ZIP_INVALID');
  const count = view.getUint16(end + 10, true); let offset = view.getUint32(end + 16, true);
  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP_INVALID');
    const method = view.getUint16(offset + 10, true), size = view.getUint32(offset + 20, true), nameLength = view.getUint16(offset + 28, true), extra = view.getUint16(offset + 30, true), comment = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true), name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true), data = bytes.subarray(start, start + size);
    if (method === 0) files.set(name, data); else if (method === 8) files.set(name, await inflate(data)); else throw new Error('ZIP_METHOD');
    offset += 46 + nameLength + extra + comment;
  }
  return files;
}
const columnIndex = (ref: string) => { let n = 0; for (const char of ref.replace(/\d+$/, '')) n = n * 26 + char.charCodeAt(0) - 64; return n - 1; };
/** First worksheet as text cells. Numbers stay as written in the sheet (dates as Excel serial numbers). */
export async function parseXlsx(bytes: Uint8Array): Promise<string[][]> {
  const files = await unzip(bytes), text = (name: string) => files.has(name) ? new TextDecoder().decode(files.get(name)) : '';
  const shared = [...text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(match => unxml([...match[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')));
  const sheet = [...files.keys()].filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))[0];
  if (!sheet) throw new Error('XLSX_NO_SHEET');
  const rows: string[][] = [];
  for (const match of text(sheet).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cell of match[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cell[1] ?? '', body = cell[2] ?? '', ref = /\br="([A-Z]+\d+)"/.exec(attributes)?.[1], type = /\bt="(\w+)"/.exec(attributes)?.[1];
      const value = type === 'inlineStr' ? unxml([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')) : unxml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      const index = ref ? columnIndex(ref) : cells.length;
      while (cells.length < index) cells.push('');
      cells[index] = type === 's' ? shared[Number(value)] ?? '' : type === 'b' ? (value === '1' ? 'Sim' : 'Não') : value;
    }
    rows.push(cells);
  }
  return rows.filter(cells => cells.some(value => value.trim() !== ''));
}

// ---- Conversão de cada linha no corpo da API ----
const reverse = (options: readonly { value: string; label: string }[]) => new Map(options.filter(o => o.value).flatMap(o => [[fold(o.label), o.value], [fold(o.value), o.value]]));
const OPTION_VALUES: Record<string, Map<string, string>> = { crt: reverse(CRT_OPTIONS), taxpayer: reverse(TAXPAYER_OPTIONS), carrier_operator: reverse(OPERATOR_OPTIONS), public_agency: reverse(PUBLIC_AGENCY_OPTIONS),
  marital_status: reverse(MARITAL_OPTIONS), person_type: new Map([['fisica', 'F'], ['pessoa fisica', 'F'], ['f', 'F'], ['juridica', 'J'], ['pessoa juridica', 'J'], ['j', 'J'], ['estrangeiro', 'E'], ['e', 'E']]),
  situation: new Map([['ativo', 'A'], ['a', 'A'], ['inativo', 'I'], ['i', 'I'], ['sem movimento', 'S'], ['s', 'S']]), credit_limit_mode: new Map([['ilimitado', 'unlimited'], ['limite zero', 'zero'], ['valor', 'value']]),
  gender: new Map([['feminino', 'feminino'], ['masculino', 'masculino'], ['f', 'feminino'], ['m', 'masculino']]) };
// Columns exported for reading only: the import cannot resolve them to records (vendedor, categoria, natureza).
const READ_ONLY = new Set(['seller_name', 'finance_category_name', 'operation_nature_name']);
const MAX: Record<string, number> = Object.fromEntries(CONTACT_FORM_FIELDS.map(field => [field.key, field.max]));
const excelDate = (serial: number) => { const date = new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000); return date.toISOString().slice(0, 10); };
function dateValue(value: string) {
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value); if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (/^\d{4,6}(\.\d+)?$/.test(value)) return excelDate(Number(value));
  return null;
}
const decimalValue = (value: string) => { const text = value.replace(/\s/g, ''); return /,/.test(text) ? text.replace(/\./g, '').replace(',', '.') : text; };
// Same grammar as the API (contacts.mjs CONTACT_DECIMALS and CONTROL): a malformed cell is a problem of its row, never a
// refused batch. Only Observações and Informações do contato take line breaks.
const DECIMALS: Record<string, RegExp> = { avg_tax_load: /^(0|[1-9]\d?|100)(\.\d{1,2})?$/, credit_limit: /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/ };
const MULTILINE = new Set(['notes', 'contact_info']);
/** Header map: model column → index. Unknown headers are reported; a missing Nome makes the file invalid. */
export function mapHeader(header: readonly string[]) {
  const known = new Map(SHEET_COLUMNS.map(([label, key]) => [fold(label), key])), columns = new Map<string, number>(), unknown: string[] = [];
  header.forEach((label, index) => { const key = known.get(fold(label)); if (key && !columns.has(key)) columns.set(key, index); else if (label.trim()) unknown.push(label.trim()); });
  return { columns, unknown };
}
export function importRows(cells: readonly string[][], types: readonly ContactTypeItem[]): { rows: ImportRow[]; unknown: string[]; missingName: boolean } {
  const [header = [], ...lines] = cells, { columns, unknown } = mapHeader(header);
  const typeBySlugOrLabel = new Map(types.flatMap(type => [[fold(type.label), type.slug], [type.slug, type.slug]]));
  const rows = lines.map((line, index) => {
    const data: Record<string, unknown> = {}, problems: string[] = [], ignored: string[] = [];
    for (const [label, key, kind] of SHEET_COLUMNS) {
      const position = columns.get(key); if (position === undefined) continue;
      const raw = (line[position] ?? '').trim(); if (!raw) continue;
      if (READ_ONLY.has(key)) { ignored.push(label); continue; }
      if (kind === 'bool') { data[key] = ['sim', 's', 'true', '1', 'x'].includes(fold(raw)); continue; }
      if (kind === 'types') {
        const slugs = raw.split(/\s*[,;]\s*/).filter(Boolean).map(value => typeBySlugOrLabel.get(fold(value)) ?? typeBySlugOrLabel.get(value));
        if (slugs.some(slug => !slug)) problems.push(`${label}: tipo desconhecido`); data.types = [...new Set(slugs.filter(Boolean))]; continue;
      }
      if (kind === 'date') { const value = dateValue(raw); if (!value || !isoDateValid(value)) problems.push(`${label}: data inválida`); else data[key] = value; continue; }
      if (kind === 'number') {
        const value = decimalValue(raw);
        if (!DECIMALS[key]?.test(value) || (key === 'avg_tax_load' && value.startsWith('100') && /[1-9]/.test(value.slice(4)))) problems.push(`${label}: número inválido`); else data[key] = value;
        continue;
      }
      if (kind === 'option') { const value = OPTION_VALUES[key]?.get(fold(raw)) ?? OPTION_VALUES[key]?.get(fold(raw.split(' - ')[0] ?? '')); if (!value) problems.push(`${label}: opção desconhecida`); else data[key] = value; continue; }
      const max = MAX[key] ?? 200;
      const multiline = MULTILINE.has(key);
      if (raw.length > max || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(raw)) { problems.push(`${label}: até ${max} caracteres${multiline ? '' : ', em uma linha'}, sem caracteres de controle`); continue; }
      data[key] = key === 'state' || key === 'billing_state' ? raw.toUpperCase() : raw;
    }
    if (data.credit_limit && !data.credit_limit_mode) data.credit_limit_mode = 'value';
    if (!data.name) problems.push('Nome: obrigatório');
    return { row: index + 2, data, problems, ignored };
  });
  return { rows, unknown, missingName: !columns.has('name') };
}
export const API_FIELD_LABEL: Record<string, string> = Object.fromEntries(SHEET_COLUMNS.map(([label, key]) => [key, label]));
/** Planilha modelo: só o cabeçalho, em CSV ou XLSX. */
export const modelCsv = () => toCsv([SHEET_COLUMNS.map(([label]) => textCell(label))]);
export const modelXlsx = () => toXlsx('Contatos', [SHEET_COLUMNS.map(([label]) => textCell(label))]);
