import test from 'node:test';
import assert from 'node:assert/strict';
import { XlsError, parseXls } from '../src/lib/xls-reader.ts';
import { decodeText, importRows } from '../src/lib/contact-import-model.ts';

// Importar contatos (.XLS, contatos onda C): Excel 97-2003 (BIFF8 in an OLE2 compound file, regular and mini streams,
// SST strings across CONTINUE records), XML Spreadsheet 2003 and HTML tables saved as .xls. Synthetic files only.
const END = 0xfffffffe, FREE = 0xffffffff;
const record = (type, bytes) => { const out = new Uint8Array(4 + bytes.length), view = new DataView(out.buffer); view.setUint16(0, type, true); view.setUint16(2, bytes.length, true); out.set(bytes, 4); return out; };
const concat = parts => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const le = (bits, value) => { const out = new Uint8Array(bits / 8), view = new DataView(out.buffer); if (bits === 16) view.setUint16(0, value, true); else if (bits === 32) view.setUint32(0, value, true); else view.setFloat64(0, value, true); return out; };
const wide = text => /[^\u0000-ÿ]/.test(text);
const chars = (text, high) => high ? concat([...text].map(c => le(16, c.charCodeAt(0)))) : Uint8Array.from([...text].map(c => c.charCodeAt(0)));
const unicode = text => concat([le(16, text.length), Uint8Array.of(wide(text) ? 1 : 0), chars(text, wide(text))]);
/** SST split in records of at most `limit` bytes; a string cut in the middle continues with its high-byte flag. */
function sst(strings, limit = 8224) {
  const records = [], first = [le(32, strings.length), le(32, strings.length)]; let current = first, size = 8;
  const flush = () => { records.push(records.length ? record(0x3c, concat(current)) : record(0xfc, concat(current))); current = []; size = 0; };
  for (const text of strings) {
    const high = wide(text), unit = high ? 2 : 1;
    if (size + 3 + unit > limit) flush();
    current.push(le(16, text.length), Uint8Array.of(high ? 1 : 0)); size += 3;
    let rest = text;
    while (rest.length) {
      const room = Math.floor((limit - size) / unit), piece = rest.slice(0, room);
      if (!piece.length) { flush(); current.push(Uint8Array.of(high ? 1 : 0)); size = 1; continue; }
      current.push(chars(piece, high)); size += piece.length * unit; rest = rest.slice(piece.length);
      if (rest.length) { flush(); current.push(Uint8Array.of(high ? 1 : 0)); size = 1; }
    }
  }
  flush(); return records;
}
const cell = (row, column) => concat([le(16, row), le(16, column), le(16, 15)]);
/** A BIFF8 workbook stream with one worksheet. */
function workbook(strings, cells, { version = 0x600, sstLimit, sstRecords } = {}) {
  const bof = kind => record(0x809, concat([le(16, version), le(16, kind), le(16, 0), le(16, 0), le(32, 0), le(32, 0)]));
  const name = Uint8Array.from([...'Contatos'].map(c => c.charCodeAt(0)));
  const sheetRecord = offset => record(0x85, concat([le(32, offset), Uint8Array.of(0, 0), Uint8Array.of(name.length, 0), name]));
  const globalsWithout = concat([bof(5), ...(sstRecords ?? sst(strings, sstLimit))]);
  const sheetOffset = globalsWithout.length + sheetRecord(0).length + 4;
  const globals = concat([globalsWithout, sheetRecord(sheetOffset), record(0x0a, new Uint8Array())]);
  return concat([globals, bof(0x10), ...cells, record(0x0a, new Uint8Array())]);
}
/** A version 3 compound file with one stream; under 4096 bytes it lives in the mini stream. */
function compound(stream, name = 'Workbook') {
  const size = 512, sectors = [null, null], fat = [0xfffffffd, END];
  const chain = bytes => { const count = Math.max(1, Math.ceil(bytes.length / size)), start = sectors.length, padded = new Uint8Array(count * size); padded.set(bytes);
    for (let i = 0; i < count; i++) { sectors.push(padded.subarray(i * size, (i + 1) * size)); fat.push(i === count - 1 ? END : start + i + 1); } return start; };
  let miniFat = END, rootStart = END, rootSize = 0, start;
  if (stream.length < 4096) {
    const count = Math.ceil(stream.length / 64), table = new Uint8Array(size).fill(0xff), view = new DataView(table.buffer);
    for (let i = 0; i < count; i++) view.setUint32(i * 4, i === count - 1 ? END : i + 1, true);
    miniFat = chain(table); const mini = new Uint8Array(count * 64); mini.set(stream); rootStart = chain(mini); rootSize = mini.length; start = 0;
  } else start = chain(stream);
  const directory = new Uint8Array(size), dir = new DataView(directory.buffer);
  const entry = (index, text, type, first, length, child) => { const at = index * 128; [...text].forEach((c, i) => dir.setUint16(at + i * 2, c.charCodeAt(0), true)); dir.setUint16(at + 64, (text.length + 1) * 2, true);
    directory[at + 66] = type; directory[at + 67] = 1; dir.setUint32(at + 68, FREE, true); dir.setUint32(at + 72, FREE, true); dir.setUint32(at + 76, child, true); dir.setUint32(at + 116, first, true); dir.setUint32(at + 120, length, true); };
  entry(0, 'Root Entry', 5, rootStart, rootSize, 1); entry(1, name, 2, start, stream.length, FREE);
  for (const index of [2, 3]) { dir.setUint32(index * 128 + 68, FREE, true); dir.setUint32(index * 128 + 72, FREE, true); dir.setUint32(index * 128 + 76, FREE, true); }
  sectors[1] = directory;
  const table = new Uint8Array(size).fill(0xff), view = new DataView(table.buffer); fat.forEach((value, i) => view.setUint32(i * 4, value, true)); sectors[0] = table;
  const header = new Uint8Array(512), h = new DataView(header.buffer);
  header.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); h.setUint16(0x18, 0x3e, true); h.setUint16(0x1a, 3, true); h.setUint16(0x1c, 0xfffe, true); h.setUint16(0x1e, 9, true); h.setUint16(0x20, 6, true);
  h.setUint32(0x2c, 1, true); h.setUint32(0x30, 1, true); h.setUint32(0x38, 4096, true); h.setUint32(0x3c, miniFat, true); h.setUint32(0x40, miniFat === END ? 0 : 1, true); h.setUint32(0x44, END, true);
  for (let i = 0; i < 109; i++) h.setUint32(0x4c + i * 4, i === 0 ? 0 : FREE, true);
  return concat([header, ...sectors]);
}
const label = (row, column, index) => record(0xfd, concat([cell(row, column), le(32, index)]));
const rk = (row, column, value) => record(0x27e, concat([cell(row, column), le(32, value)]));

test('BIFF8 in the mini stream: shared strings, accents, wide characters, numbers, RK, MULRK, booleans and a string formula', () => {
  const strings = ['Nome', 'CPF / CNPJ', 'Cidade', 'Ação Sintética Ltda', 'Zoë 日本 Comércio', 'Piracicaba'];
  const cells = [label(0, 0, 0), label(0, 1, 1), label(0, 2, 2), label(1, 0, 3), record(0x203, concat([cell(1, 1), le(64, 52998224725)])), label(1, 2, 5),
    label(2, 0, 4), rk(2, 1, (1234 << 2) | 2), record(0xbd, concat([le(16, 3), le(16, 0), le(16, 15), le(32, (7 << 2) | 2), le(16, 15), le(32, (1250 << 2) | 3), le(16, 1)])),
    record(0x205, concat([cell(4, 0), Uint8Array.of(1, 0)])), record(0x06, concat([cell(5, 0), Uint8Array.of(0, 0, 0, 0, 0, 0, 0xff, 0xff), le(16, 0), le(32, 0)])), record(0x207, unicode('Fórmula')),
    record(0x204, concat([cell(6, 0), unicode('Rótulo antigo')]))];
  const file = compound(workbook(strings, cells));
  assert.ok(file.length < 8192, 'a small workbook uses the mini stream');
  assert.deepEqual(parseXls(file, decodeText), [['Nome', 'CPF / CNPJ', 'Cidade'], ['Ação Sintética Ltda', '52998224725', 'Piracicaba'], ['Zoë 日本 Comércio', '1234'], ['7', '12.5'], ['Sim'], ['Fórmula'], ['Rótulo antigo']]);
  const rows = importRows(parseXls(file, decodeText).slice(0, 2), []).rows;
  assert.equal(rows[0].data.name, 'Ação Sintética Ltda');
});

test('BIFF8 in regular sectors with shared strings split across CONTINUE records', () => {
  const long = 'x'.repeat(5000), wideLong = 'ç日'.repeat(1500);
  const strings = ['Nome', long, wideLong, ...Array.from({ length: 300 }, (_, i) => `Contato sintético ${i}`)];
  const cells = [label(0, 0, 0), label(1, 0, 1), label(2, 0, 2), ...Array.from({ length: 300 }, (_, i) => label(3 + i, 0, 3 + i))];
  const file = compound(workbook(strings, cells, { sstLimit: 3000 }));
  assert.ok(file.length > 8192);
  const rows = parseXls(file, decodeText);
  assert.deepEqual([rows.length, rows[1][0].length, rows[1][0], rows[2][0], rows.at(-1)[0]], [303, 5000, long, wideLong, 'Contato sintético 299']);
});

test('rich and extended shared strings skip their formatting runs', () => {
  const ascii = text => Uint8Array.from([...text].map(c => c.charCodeAt(0)));
  const raw = record(0xfc, concat([le(32, 3), le(32, 3), le(16, 4), Uint8Array.of(0x08), le(16, 2), ascii('Rico'), new Uint8Array(8).fill(7),
    le(16, 3), Uint8Array.of(0x04), le(32, 4), ascii('Ext'), new Uint8Array(4).fill(9), le(16, 3), Uint8Array.of(0), ascii('Fim')]));
  const file = compound(workbook([], [label(0, 0, 0), label(0, 1, 1), label(0, 2, 2)], { sstRecords: [raw] }));
  assert.deepEqual(parseXls(file, decodeText), [['Rico', 'Ext', 'Fim']]);
});

test('XML Spreadsheet 2003 and HTML tables saved as .xls; older and broken files are refused', () => {
  const xml = `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Contatos"><Table>
    <Row><Cell><Data ss:Type="String">Nome</Data></Cell><Cell ss:Index="3"><Data ss:Type="String">Cidade</Data></Cell></Row>
    <Row><Cell><Data ss:Type="String">Ana &amp; Filhos</Data></Cell><Cell><Data ss:Type="Number">12</Data></Cell><Cell><Data ss:Type="String">São Carlos</Data></Cell></Row></Table></Worksheet></Workbook>`;
  assert.deepEqual(parseXls(new TextEncoder().encode(xml), decodeText), [['Nome', '', 'Cidade'], ['Ana & Filhos', '12', 'São Carlos']]);
  const html = '<html><body><table><thead><tr><th>Nome</th><th>Cidade</th></tr></thead><tbody><tr><td>Bia&nbsp;Fornecedora</td><td><b>Campinas</b></td></tr><tr><td></td><td></td></tr></tbody></table></body></html>';
  assert.deepEqual(parseXls(Uint8Array.from([...html].map(c => c.charCodeAt(0))), decodeText), [['Nome', 'Cidade'], ['Bia Fornecedora', 'Campinas']]);
  const latin1 = Uint8Array.from([...'<table><tr><td>João</td></tr></table>'].map(c => c.charCodeAt(0)));
  assert.deepEqual(parseXls(latin1, decodeText), [['João']], 'Windows-1252 HTML');
  assert.throws(() => parseXls(compound(workbook(['Nome'], [label(0, 0, 0)], { version: 0x500 })), decodeText), error => error instanceof XlsError && error.reason === 'old_version');
  assert.throws(() => parseXls(compound(new Uint8Array(100), 'Book'), decodeText), error => error instanceof XlsError && error.reason === 'old_version');
  assert.throws(() => parseXls(new TextEncoder().encode('Nome;Cidade'), decodeText), error => error instanceof XlsError && error.reason === 'unsupported');
  const broken = compound(workbook(['Nome'], [label(0, 0, 7)]));
  assert.throws(() => parseXls(broken, decodeText), error => error instanceof XlsError && error.reason === 'invalid', 'a shared string index outside the table');
  const truncated = compound(workbook(['Nome'], [label(0, 0, 0)])).subarray(0, 1100);
  assert.throws(() => parseXls(truncated, decodeText), XlsError);
});
