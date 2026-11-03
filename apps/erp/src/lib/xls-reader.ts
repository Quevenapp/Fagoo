// Planilhas .XLS para Importar contatos (contatos onda C), lidas no navegador como as .XLSX: a primeira planilha em
// texto. Aceita o Excel 97-2003 (BIFF8 dentro de um arquivo composto OLE2) e os .XLS que são, na verdade, uma tabela
// HTML ou uma planilha XML 2003 (muitos sistemas exportam assim). Números ficam como escritos (datas como número de
// série do Excel, igual ao .XLSX). Estruturas fora do formato são recusadas, nunca adivinhadas.
export class XlsError extends Error {
  readonly reason: 'unsupported' | 'old_version' | 'invalid';
  constructor(reason: 'unsupported' | 'old_version' | 'invalid') { super(`XLS_${reason.toUpperCase()}`); this.reason = reason; }
}
const invalid = (): never => { throw new XlsError('invalid'); };
const END = 0xfffffffe, FREE = 0xffffffff, MAX_ROWS = 65536, MAX_COLUMNS = 256;

/** First worksheet of a .XLS file as rows of text cells (empty rows dropped). */
export function parseXls(bytes: Uint8Array, decodeText: (bytes: Uint8Array) => string): string[][] {
  if (bytes.length >= 8 && [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((byte, index) => bytes[index] === byte)) return clean(biffRows(workbookStream(bytes)));
  const text = decodeText(bytes);
  if (/<Workbook[\s>]/.test(text) && /urn:schemas-microsoft-com:office:spreadsheet/.test(text)) return clean(xmlRows(text));
  if (/<table[\s>]/i.test(text)) return clean(htmlRows(text));
  throw new XlsError('unsupported');
}
const clean = (rows: string[][]) => rows.filter(cells => cells.some(value => value.trim() !== ''));

// ---- OLE2 compound file: the "Workbook" (or "Book") stream ----
function workbookStream(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 512) invalid();
  const shift = view.getUint16(0x1e, true), miniShift = view.getUint16(0x20, true);
  if ((shift !== 9 && shift !== 12) || miniShift !== 6) invalid();
  const size = 1 << shift, cutoff = view.getUint32(0x38, true), sectors = Math.floor((bytes.length - 512) / size);
  const sector = (id: number) => { if (id >= sectors) invalid(); const start = (id + 1) * size; return bytes.subarray(start, start + size); };
  // FAT sector ids: 109 in the header, then the DIFAT chain.
  const fatIds: number[] = [];
  for (let i = 0; i < 109; i++) { const id = view.getUint32(0x4c + i * 4, true); if (id !== FREE) fatIds.push(id); }
  let difat = view.getUint32(0x44, true), guard = 0;
  while (difat !== END && difat !== FREE) {
    if (++guard > sectors) invalid();
    const data = new DataView(sector(difat).buffer, sector(difat).byteOffset, size);
    for (let i = 0; i < size / 4 - 1; i++) { const id = data.getUint32(i * 4, true); if (id !== FREE) fatIds.push(id); }
    difat = data.getUint32(size - 4, true);
  }
  const fat = new Uint32Array(fatIds.length * (size / 4));
  fatIds.forEach((id, index) => { const data = sector(id); for (let i = 0; i < size / 4; i++) fat[index * (size / 4) + i] = new DataView(data.buffer, data.byteOffset, size).getUint32(i * 4, true); });
  const chain = (start: number, table: Uint32Array, limit: number) => {
    const ids: number[] = []; let id = start;
    while (id !== END) { if (id >= table.length || ids.length > limit) invalid(); ids.push(id); id = table[id]!; }
    return ids;
  };
  const read = (start: number, length: number) => {
    const ids = chain(start, fat, sectors), out = new Uint8Array(ids.length * size);
    ids.forEach((id, index) => out.set(sector(id), index * size));
    if (length > out.length) invalid();
    return out.subarray(0, length);
  };
  const directory = read(view.getUint32(0x30, true), chain(view.getUint32(0x30, true), fat, sectors).length * size);
  const entries: { name: string; type: number; start: number; size: number }[] = [];
  for (let offset = 0; offset + 128 <= directory.length; offset += 128) {
    const entry = new DataView(directory.buffer, directory.byteOffset + offset, 128), length = entry.getUint16(64, true);
    if (length > 64 || length % 2) invalid();
    const name = String.fromCharCode(...Array.from({ length: Math.max(0, length / 2 - 1) }, (_, i) => entry.getUint16(i * 2, true)));
    entries.push({ name, type: directory[offset + 66]!, start: entry.getUint32(116, true), size: entry.getUint32(120, true) });
  }
  const root = entries[0], book = entries.find(entry => entry.type === 2 && (entry.name === 'Workbook' || entry.name === 'Book'));
  if (!root || root.type !== 5 || !book) throw new XlsError('unsupported');
  if (book.name === 'Book') throw new XlsError('old_version');
  if (book.size >= cutoff) return read(book.start, book.size);
  // Small stream: 64-byte mini sectors inside the root entry's stream, chained by the mini FAT.
  const miniStream = read(root.start, root.size), miniFatBytes = read(view.getUint32(0x3c, true), view.getUint32(0x40, true) * size);
  const miniFat = new Uint32Array(miniFatBytes.length / 4);
  for (let i = 0; i < miniFat.length; i++) miniFat[i] = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.length).getUint32(i * 4, true);
  const ids = chain(book.start, miniFat, miniFat.length), out = new Uint8Array(ids.length * 64);
  ids.forEach((id, index) => { if ((id + 1) * 64 > miniStream.length) invalid(); out.set(miniStream.subarray(id * 64, id * 64 + 64), index * 64); });
  if (book.size > out.length) invalid();
  return out.subarray(0, book.size);
}

// ---- BIFF8 records ----
type BiffRecord = { type: number; offset: number; data: Uint8Array };
function records(stream: Uint8Array): BiffRecord[] {
  const list: BiffRecord[] = []; let offset = 0;
  while (offset + 4 <= stream.length) {
    const type = stream[offset]! | stream[offset + 1]! << 8, length = stream[offset + 2]! | stream[offset + 3]! << 8;
    if (offset + 4 + length > stream.length) invalid();
    list.push({ type, offset, data: stream.subarray(offset + 4, offset + 4 + length) });
    offset += 4 + length;
  }
  return list;
}
const u16 = (data: Uint8Array, at: number) => { if (at + 2 > data.length) invalid(); return data[at]! | data[at + 1]! << 8; };
const u32 = (data: Uint8Array, at: number) => { if (at + 4 > data.length) invalid(); return (data[at]! | data[at + 1]! << 8 | data[at + 2]! << 16 | data[at + 3]! << 24) >>> 0; };
const float = (data: Uint8Array, at: number) => { if (at + 8 > data.length) invalid(); return new DataView(data.buffer, data.byteOffset + at, 8).getFloat64(0, true); };
const number = (value: number) => Number.isFinite(value) ? (Number.isInteger(value) && Math.abs(value) < 1e21 ? value.toFixed(0) : String(value)) : '';
// RK: a 30-bit integer, or the 30 high bits of a double; bit 0 divides by 100.
const rk = (value: number) => {
  let result: number;
  if (value & 2) result = value >> 2;
  else { const view = new DataView(new ArrayBuffer(8)); view.setUint32(4, (value & 0xfffffffc) >>> 0, true); result = view.getFloat64(0, true); }
  return value & 1 ? result / 100 : result;
};

/** Reads BIFF8 strings across a record and its CONTINUE records (each continuation restarts with the high-byte flag). */
class Reader {
  private part = 0; private at = 0; private readonly parts: Uint8Array[];
  constructor(parts: Uint8Array[]) { this.parts = parts; }
  private left() { return this.parts[this.part]!.length - this.at; }
  private next() { this.part++; this.at = 0; if (this.part >= this.parts.length) invalid(); }
  byte() { if (this.left() < 1) this.next(); return this.parts[this.part]![this.at++]!; }
  u16() { if (this.left() < 2) this.next(); const value = u16(this.parts[this.part]!, this.at); this.at += 2; return value; }
  u32() { if (this.left() < 4) this.next(); const value = u32(this.parts[this.part]!, this.at); this.at += 4; return value; }
  skip(count: number) { let remaining = count; while (remaining > 0) { if (!this.left()) this.next(); const step = Math.min(remaining, this.left()); this.at += step; remaining -= step; } }
  string() {
    const length = this.u16(), flags = this.byte(); let high = flags & 1, runs = 0, extended = 0, text = '';
    if (flags & 8) runs = this.u16();
    if (flags & 4) extended = this.u32();
    for (let read = 0; read < length;) {
      if (!this.left()) { this.next(); high = this.byte() & 1; }
      const part = this.parts[this.part]!, count = Math.min(length - read, Math.floor(this.left() / (high ? 2 : 1)));
      if (!count) invalid();
      for (let i = 0; i < count; i++) text += String.fromCharCode(high ? part[this.at + i * 2]! | part[this.at + i * 2 + 1]! << 8 : part[this.at + i]!);
      this.at += count * (high ? 2 : 1); read += count;
    }
    this.skip(runs * 4 + extended);
    return text;
  }
  /** The string after `count` fixed bytes (LABEL: row, column and format). */
  stringAfter(count: number) { this.skip(count); return this.string(); }
}
const withContinues = (list: BiffRecord[], index: number) => { const parts = [list[index]!.data]; for (let i = index + 1; i < list.length && list[i]!.type === 0x3c; i++) parts.push(list[i]!.data); return parts; };

function biffRows(stream: Uint8Array): string[][] {
  const list = records(stream);
  if (!list.length || list[0]!.type !== 0x809) invalid();
  if (u16(list[0]!.data, 0) !== 0x600) throw new XlsError('old_version');
  const strings: string[] = []; let sheetOffset: number | null = null;
  for (let index = 0; index < list.length; index++) {
    const record = list[index]!;
    if (record.type === 0x0a) break;
    if (record.type === 0x85 && sheetOffset === null && record.data[5] === 0) sheetOffset = u32(record.data, 0);
    if (record.type === 0xfc) {
      const reader = new Reader(withContinues(list, index)); reader.u32(); const unique = reader.u32();
      if (unique > 1_000_000) invalid();
      for (let i = 0; i < unique; i++) strings.push(reader.string());
    }
  }
  if (sheetOffset === null) throw new XlsError('unsupported');
  const start = list.findIndex(record => record.offset === sheetOffset);
  if (start < 0 || list[start]!.type !== 0x809) invalid();
  const rows: string[][] = [];
  const put = (row: number, column: number, value: string) => {
    if (row >= MAX_ROWS || column >= MAX_COLUMNS) invalid();
    const cells = rows[row] ??= []; while (cells.length < column) cells.push(''); cells[column] = value;
  };
  let pendingFormula: { row: number; column: number } | null = null;
  for (let index = start + 1; index < list.length; index++) {
    const { type, data } = list[index]!;
    if (type === 0x0a) break;
    if (type === 0xfd) { const at = u32(data, 6); put(u16(data, 0), u16(data, 2), strings[at] ?? invalid()); }
    else if (type === 0x203) put(u16(data, 0), u16(data, 2), number(float(data, 6)));
    else if (type === 0x27e) put(u16(data, 0), u16(data, 2), number(rk(u32(data, 6))));
    else if (type === 0xbd) { const row = u16(data, 0), first = u16(data, 2), last = u16(data, data.length - 2); if (last < first || 4 + (last - first + 1) * 6 + 2 !== data.length) invalid(); for (let c = first; c <= last; c++) put(row, c, number(rk(u32(data, 4 + (c - first) * 6 + 2)))); }
    else if (type === 0x204) put(u16(data, 0), u16(data, 2), new Reader(withContinues(list, index)).stringAfter(6));
    else if (type === 0x205) put(u16(data, 0), u16(data, 2), data[7] ? '' : data[6] ? (data[6] === 1 ? 'Sim' : String(data[6])) : 'Não');
    else if (type === 0x06) {
      const row = u16(data, 0), column = u16(data, 2);
      if (u16(data, 12) !== 0xffff) put(row, column, number(float(data, 6)));
      else if (data[6] === 0) pendingFormula = { row, column };
      else if (data[6] === 1) put(row, column, data[8] ? 'Sim' : 'Não');
    } else if (type === 0x207 && pendingFormula) { put(pendingFormula.row, pendingFormula.column, new Reader(withContinues(list, index)).string()); pendingFormula = null; }
  }
  return Array.from(rows, cells => cells ?? []);
}

// ---- XML Spreadsheet 2003 and HTML tables saved as .xls ----
const entities = (value: string) => value.replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&apos;|&#39;/gi, "'")
  .replace(/&#(\d{1,7});/g, (_, n) => { const code = Number(n); return code <= 0x10ffff ? String.fromCodePoint(code) : ''; }).replace(/&#x([0-9a-f]{1,6});/gi, (_, n) => { const code = parseInt(n, 16); return code <= 0x10ffff ? String.fromCodePoint(code) : ''; }).replace(/&amp;/gi, '&');
const plain = (html: string) => entities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')).replace(/[ \t]+/g, ' ').trim();
function xmlRows(text: string): string[][] {
  const table = /<(?:ss:)?Worksheet\b[\s\S]*?<\/(?:ss:)?Worksheet>/.exec(text)?.[0] ?? invalid();
  const rows: string[][] = [];
  for (const row of table.matchAll(/<(?:ss:)?Row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:ss:)?Row>)/g)) {
    const index = /\bss:Index="(\d+)"/.exec(row[1] ?? '')?.[1];
    if (index) { if (Number(index) > MAX_ROWS) invalid(); while (rows.length < Number(index) - 1) rows.push([]); }
    const cells: string[] = [];
    for (const cell of (row[2] ?? '').matchAll(/<(?:ss:)?Cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:ss:)?Cell>)/g)) {
      const at = /\bss:Index="(\d+)"/.exec(cell[1] ?? '')?.[1];
      if (at) { if (Number(at) > MAX_COLUMNS) invalid(); while (cells.length < Number(at) - 1) cells.push(''); }
      cells.push(plain(/<(?:ss:)?Data\b[^>]*>([\s\S]*?)<\/(?:ss:)?Data>/.exec(cell[2] ?? '')?.[1] ?? ''));
    }
    rows.push(cells);
    if (rows.length > MAX_ROWS) invalid();
  }
  return rows;
}
function htmlRows(text: string): string[][] {
  const table = /<table\b[\s\S]*?<\/table>/i.exec(text)?.[0] ?? invalid();
  const rows: string[][] = [];
  for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/table>)/gi)) {
    rows.push([...row[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)(?=<t[dh]\b|<\/tr>|$)/gi)].map(cell => plain(cell[1]!.replace(/<\/t[dh]>\s*$/i, ''))));
    if (rows.length > MAX_ROWS) invalid();
  }
  return rows;
}
