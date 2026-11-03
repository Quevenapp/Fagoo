/** Local QR Code encoder (ISO/IEC 18004) for the static Pix BR Code of the Frente de caixa: byte mode, error correction level
 * M, versions 1 to 15, best of the eight masks. No library and no network; the result is the module matrix (true = dark). */

// Error correction level M: EC codewords per block and the blocks of each group (count, data codewords), versions 1-15.
const M_BLOCKS: readonly (readonly [number, number, number, number, number])[] = [
  [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37], [26, 4, 43, 1, 44], [30, 1, 50, 4, 51], [22, 6, 36, 2, 37], [22, 8, 37, 1, 38], [24, 4, 40, 5, 41], [24, 5, 41, 5, 42],
];
const ALIGNMENT: readonly (readonly number[])[] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70]];
export const QR_MAX_VERSION = 15;

const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!; }
const mul = (a: number, b: number) => a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!;
function generator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) { const next = new Array(poly.length + 1).fill(0); poly.forEach((c, j) => { next[j] ^= c; next[j + 1] ^= mul(c, EXP[i]!); }); poly = next; }
  return poly;
}
function remainder(data: readonly number[], degree: number): number[] {
  const gen = generator(degree), result = new Array(degree).fill(0);
  for (const byte of data) { const factor = byte ^ result.shift()!; result.push(0); gen.slice(1).forEach((c, i) => { result[i] ^= mul(c, factor); }); }
  return result;
}
const dataCodewords = (version: number) => { const [, g1, d1, g2, d2] = M_BLOCKS[version - 1]!; return g1 * d1 + g2 * d2; };
const countBits = (version: number) => version < 10 ? 8 : 16;
/** Bytes a version holds in byte mode at level M. */
export const qrCapacity = (version: number) => Math.floor((dataCodewords(version) * 8 - 4 - countBits(version)) / 8);

function codewords(bytes: Uint8Array, version: number): number[] {
  const total = dataCodewords(version), bits: number[] = [];
  const push = (value: number, length: number) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(0b0100, 4); push(bytes.length, countBits(version)); for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, total * 8 - bits.length)); while (bits.length % 8) bits.push(0);
  const data: number[] = []; for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  for (let pad = 0; data.length < total; pad++) data.push(pad % 2 ? 0x11 : 0xec);
  const [ec, g1, d1, g2, d2] = M_BLOCKS[version - 1]!, blocks: number[][] = []; let offset = 0;
  for (let i = 0; i < g1 + g2; i++) { const size = i < g1 ? d1 : d2; blocks.push(data.slice(offset, offset + size)); offset += size; }
  const ecc = blocks.map(block => remainder(block, ec)), out: number[] = [];
  for (let i = 0; i < Math.max(d1, d2); i++) for (const block of blocks) if (i < block.length) out.push(block[i]!);
  for (let i = 0; i < ec; i++) for (const block of ecc) out.push(block[i]!);
  return out;
}

type Grid = { size: number; dark: boolean[][]; reserved: boolean[][] };
function base(version: number): Grid {
  const size = 17 + 4 * version, dark = Array.from({ length: size }, () => new Array<boolean>(size).fill(false)), reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (r: number, c: number, value: boolean) => { if (r >= 0 && c >= 0 && r < size && c < size) { dark[r]![c] = value; reserved[r]![c] = true; } };
  for (const [row, col] of [[0, 0], [0, size - 7], [size - 7, 0]] as const)
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) set(row + r, col + c, r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)));
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const centers = ALIGNMENT[version - 1]!;
  for (const r of centers) for (const c of centers) {
    if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  set(size - 8, 8, true);
  for (let i = 0; i < 9; i++) { if (!reserved[8]![i]) reserved[8]![i] = true; if (!reserved[i]![8]) reserved[i]![8] = true; }
  for (let i = 0; i < 8; i++) { reserved[8]![size - 1 - i] = true; reserved[size - 1 - i]![8] = true; }
  if (version >= 7) for (let i = 0; i < 18; i++) { const a = Math.floor(i / 3), b = size - 11 + (i % 3); reserved[a]![b] = true; reserved[b]![a] = true; }
  return { size, dark, reserved };
}
const MASKS: readonly ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0, r => r % 2 === 0, (_, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];
function bch(value: number, poly: number, shift: number): number {
  let data = value << shift;
  const degree = (n: number) => 31 - Math.clz32(n);
  while (data && degree(data) >= degree(poly)) data ^= poly << (degree(data) - degree(poly));
  return (value << shift) | data;
}
function functionInfo(grid: Grid, version: number, mask: number) {
  const { size, dark } = grid, format = bch((0b00 << 3) | mask, 0x537, 10) ^ 0x5412;
  const bit = (i: number) => ((format >>> i) & 1) === 1;
  // Rows and columns as dark[row][column]: the first copy around the top-left finder, the second split between the
  // top-right (row 8) and the bottom-left (column 8) finders.
  for (let i = 0; i <= 5; i++) dark[i]![8] = bit(i);
  dark[7]![8] = bit(6); dark[8]![8] = bit(7); dark[8]![7] = bit(8);
  for (let i = 9; i < 15; i++) dark[8]![14 - i] = bit(i);
  for (let i = 0; i < 8; i++) dark[8]![size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) dark[size - 15 + i]![8] = bit(i);
  dark[size - 8]![8] = true;
  if (version >= 7) { const info = bch(version, 0x1f25, 12); for (let i = 0; i < 18; i++) { const value = ((info >>> i) & 1) === 1, a = Math.floor(i / 3), b = size - 11 + (i % 3); dark[a]![b] = value; dark[b]![a] = value; } }
}
function place(grid: Grid, data: readonly number[]) {
  const { size, dark, reserved } = grid; let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) for (let j = 0; j < 2; j++) {
      const c = right - j, upward = ((right + 1) & 2) === 0, r = upward ? size - 1 - vertical : vertical;
      if (reserved[r]![c]) continue;
      dark[r]![c] = index < data.length * 8 ? ((data[index >>> 3]! >>> (7 - (index & 7))) & 1) === 1 : false; index++;
    }
  }
}
function penalty(m: boolean[][]): number {
  const size = m.length; let score = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1, s = 0;
    for (let i = 1; i < size; i++) { if (get(i) === get(i - 1)) { run++; if (run === 5) s += 3; else if (run > 5) s++; } else run = 1; }
    for (let i = 0; i + 10 < size; i++) {
      const p = Array.from({ length: 11 }, (_, k) => get(i + k));
      const a = [true, false, true, true, true, false, true, false, false, false, false], b = [false, false, false, false, true, false, true, true, true, false, true];
      if (p.every((v, k) => v === a[k]) || p.every((v, k) => v === b[k])) s += 40;
    }
    return s;
  };
  for (let r = 0; r < size; r++) score += line(i => m[r]![i]!);
  for (let c = 0; c < size; c++) score += line(i => m[i]![c]!);
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) { const v = m[r]![c]; if (v === m[r]![c + 1] && v === m[r + 1]![c] && v === m[r + 1]![c + 1]) score += 3; }
  const darkCount = m.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  score += Math.floor(Math.abs(darkCount * 20 - size * size * 10) / (size * size)) * 10;
  return score;
}

export type QrMatrix = { version: number; size: number; modules: readonly (readonly boolean[])[] };
/** Encodes a UTF-8 text; throws when it does not fit version 15 at level M (412 bytes). */
export function qrEncode(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  let version = 1; while (version <= QR_MAX_VERSION && qrCapacity(version) < bytes.length) version++;
  if (version > QR_MAX_VERSION || !bytes.length) throw new Error('QR_TOO_LONG');
  const data = codewords(bytes, version);
  let best: { score: number; modules: boolean[][] } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const grid = base(version); place(grid, data);
    for (let r = 0; r < grid.size; r++) for (let c = 0; c < grid.size; c++) if (!grid.reserved[r]![c] && MASKS[mask]!(r, c)) grid.dark[r]![c] = !grid.dark[r]![c];
    functionInfo(grid, version, mask);
    const score = penalty(grid.dark);
    if (!best || score < best.score) best = { score, modules: grid.dark };
  }
  return { version, size: 17 + 4 * version, modules: best!.modules };
}
/** SVG path of the dark modules with a four-module quiet zone (viewBox = size + 8). */
export function qrPath(matrix: QrMatrix): string {
  let path = '';
  matrix.modules.forEach((row, r) => row.forEach((dark, c) => { if (dark) path += `M${c + 4} ${r + 4}h1v1h-1z`; }));
  return path;
}
