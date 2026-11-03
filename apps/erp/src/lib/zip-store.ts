// Origin Gerenciador de arquivos "Fazer download" of the selected files as one ZIP. A local "stored" ZIP (no compression, CRC-32,
// UTF-8 names), built in the browser from the bytes already checked by size and SHA-256; no library and nothing leaves the page.
export interface ZipEntry { name: string; data: Uint8Array; modified: Date }
export const ZIP_MAX_FILES = 100, ZIP_MAX_BYTES = 100 * 1024 * 1024;

const CRC_TABLE = (() => { const table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
export function crc32(data: Uint8Array): number { let c = 0xffffffff; for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
/** DOS date and time of the moment in America/Sao_Paulo (the ZIP format has no time zone). */
function dosTime(moment: Date): { time: number; date: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(Number.isFinite(moment.getTime()) ? moment : new Date(0)).map(part => [part.type, Number(part.value)]));
  const year = Math.min(Math.max(parts.year ?? 1980, 1980), 2107);
  return { time: ((parts.hour ?? 0) << 11) | ((parts.minute ?? 0) << 5) | Math.floor((parts.second ?? 0) / 2), date: ((year - 1980) << 9) | ((parts.month ?? 1) << 5) | (parts.day ?? 1) };
}
/** Names inside the ZIP: no folders or control characters, and a repeated name becomes "nome (2).ext". */
export function zipNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map(raw => {
    const clean = raw.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/^\.+/, '_').slice(0, 200) || 'arquivo';
    const dot = clean.lastIndexOf('.'), stem = dot > 0 ? clean.slice(0, dot) : clean, ext = dot > 0 ? clean.slice(dot) : '';
    let name = clean, n = 2; while (used.has(name.toLowerCase())) name = `${stem} (${n++})${ext}`;
    used.add(name.toLowerCase()); return name;
  });
}
export function storedZip(entries: readonly ZipEntry[]): Uint8Array {
  if (!entries.length || entries.length > ZIP_MAX_FILES) throw new Error('ZIP_ENTRIES_INVALID');
  if (entries.reduce((sum, entry) => sum + entry.data.byteLength, 0) > ZIP_MAX_BYTES) throw new Error('ZIP_TOO_LARGE');
  const encoder = new TextEncoder(), names = zipNames(entries.map(entry => entry.name)).map(name => encoder.encode(name));
  const locals: Uint8Array[] = [], centrals: Uint8Array[] = []; let offset = 0;
  entries.forEach((entry, index) => {
    const name = names[index]!, crc = crc32(entry.data), size = entry.data.byteLength, { time, date } = dosTime(entry.modified);
    const local = new Uint8Array(30 + name.byteLength), l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x0800, true); l.setUint16(8, 0, true); l.setUint16(10, time, true); l.setUint16(12, date, true);
    l.setUint32(14, crc, true); l.setUint32(18, size, true); l.setUint32(22, size, true); l.setUint16(26, name.byteLength, true); l.setUint16(28, 0, true); local.set(name, 30);
    const central = new Uint8Array(46 + name.byteLength), c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true); c.setUint16(12, time, true); c.setUint16(14, date, true);
    c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true); c.setUint16(28, name.byteLength, true); c.setUint32(42, offset, true); central.set(name, 46);
    locals.push(local, entry.data); centrals.push(central); offset += local.byteLength + size;
  });
  const directory = centrals.reduce((sum, part) => sum + part.byteLength, 0), end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true); e.setUint32(12, directory, true); e.setUint32(16, offset, true);
  const out = new Uint8Array(offset + directory + 22); let at = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, at); at += part.byteLength; }
  return out;
}
