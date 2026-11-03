// Minimal PDF 1.4 writer for the DANFE file (notas fiscais lane, wave E): A4 pages with rectangles, lines, filled bars and text in
// the standard Helvetica / Helvetica-Bold / Courier fonts (WinAnsiEncoding), no compression, no images, no scripts and no network.
// Widths are the standard Adobe metrics (1/1000 em) used to wrap and align text; characters outside WinAnsi print as "?".
export const MM = 72 / 25.4;
export type PdfFont = 'regular' | 'bold' | 'mono';
const FONT_NAMES: Record<PdfFont, string> = { regular: 'Helvetica', bold: 'Helvetica-Bold', mono: 'Courier' };
const FONT_KEYS: Record<PdfFont, string> = { regular: 'F1', bold: 'F2', mono: 'F3' };
// Helvetica widths for the characters 32..126.
const HELVETICA = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELVETICA_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
// Accented Latin letters take the width of their base letter.
const BASE: Record<string, string> = { 'á': 'a', 'à': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'é': 'e', 'ê': 'e', 'è': 'e', 'ë': 'e', 'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i', 'ó': 'o', 'ô': 'o', 'õ': 'o', 'ò': 'o', 'ö': 'o',
  'ú': 'u', 'ù': 'u', 'û': 'u', 'ü': 'u', 'ç': 'c', 'ñ': 'n', 'Á': 'A', 'À': 'A', 'Â': 'A', 'Ã': 'A', 'Ä': 'A', 'É': 'E', 'Ê': 'E', 'È': 'E', 'Ë': 'E', 'Í': 'I', 'Ì': 'I', 'Î': 'I', 'Ï': 'I', 'Ó': 'O', 'Ô': 'O',
  'Õ': 'O', 'Ò': 'O', 'Ö': 'O', 'Ú': 'U', 'Ù': 'U', 'Û': 'U', 'Ü': 'U', 'Ç': 'C', 'Ñ': 'N', 'º': 'o', 'ª': 'a', '°': 'o', '·': '.', '–': '-', '—': '-', '’': "'", '‘': "'", '“': '"', '”': '"' };
/** WinAnsi byte of a character, or "?" (63). */
function winAnsi(char: string): number {
  const code = char.codePointAt(0)!;
  if (code >= 32 && code <= 126) return code;
  if (code >= 160 && code <= 255) return code;
  const special: Record<string, number> = { '–': 150, '—': 151, '’': 146, '‘': 145, '“': 147, '”': 148, '•': 149, '…': 133, '€': 128 };
  return special[char] ?? 63;
}
/** Width of a text in points. */
export function textWidth(text: string, size: number, font: PdfFont = 'regular'): number {
  if (font === 'mono') return [...text].length * 600 * size / 1000;
  const table = font === 'bold' ? HELVETICA_BOLD : HELVETICA;
  let total = 0;
  for (const char of text) { const base = BASE[char] ?? char, code = base.codePointAt(0)!; total += code >= 32 && code <= 126 ? table[code - 32]! : 556; }
  return total * size / 1000;
}
/** Words wrapped into lines of at most `width` points (a long word is cut by characters). */
export function wrapText(text: string, width: number, size: number, font: PdfFont = 'regular'): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r/g, '').split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, size, font) <= width) { line = candidate; continue; }
      if (line) lines.push(line);
      let rest = word;
      while (textWidth(rest, size, font) > width) {
        let cut = rest.length; while (cut > 1 && textWidth(rest.slice(0, cut), size, font) > width) cut--;
        lines.push(rest.slice(0, cut)); rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}
const escapeText = (text: string) => [...text].map(winAnsi).map(byte => byte === 40 || byte === 41 || byte === 92 ? `\\${String.fromCharCode(byte)}` : byte < 32 || byte > 126 ? `\\${byte.toString(8).padStart(3, '0')}` : String.fromCharCode(byte)).join('');
const num = (value: number) => (Math.round(value * 100) / 100).toString();

/** One A4 page; coordinates in millimetres from the top-left corner (converted to PDF points from the bottom-left). */
export class PdfPage {
  readonly ops: string[] = [];
  readonly width: number;
  readonly height: number;
  constructor(width = 210, height = 297) { this.width = width; this.height = height; }
  private x(mm: number) { return num(mm * MM); }
  private y(mm: number) { return num((this.height - mm) * MM); }
  rect(x: number, y: number, w: number, h: number, { fill = false, width = 0.25 }: { fill?: boolean; width?: number } = {}) {
    this.ops.push(`${num(width * MM / 1)} w ${this.x(x)} ${this.y(y + h)} ${num(w * MM)} ${num(h * MM)} re ${fill ? 'f' : 'S'}`);
  }
  line(x1: number, y1: number, x2: number, y2: number, { width = 0.2, dash = false }: { width?: number; dash?: boolean } = {}) {
    this.ops.push(`${dash ? '[1 1] 0 d ' : ''}${num(width * MM)} w ${this.x(x1)} ${this.y(y1)} m ${this.x(x2)} ${this.y(y2)} l S${dash ? ' [] 0 d' : ''}`);
  }
  /** Text with its baseline at `y` (mm); align is relative to `x` (left), the centre or the right edge `x`. */
  text(x: number, y: number, text: string, { size = 7, font = 'regular' as PdfFont, align = 'left' as 'left' | 'center' | 'right', gray = 0 } = {}) {
    if (!text) return;
    const width = textWidth(text, size, font) / MM, left = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
    this.ops.push(`BT ${gray ? `${num(gray)} g ` : ''}/${FONT_KEYS[font]} ${num(size)} Tf ${this.x(left)} ${this.y(y)} Td (${escapeText(text)}) Tj ET${gray ? ' 0 g' : ''}`);
  }
  /** Text rotated around (x, y), used for the "SEM VALOR FISCAL" mark. */
  rotated(x: number, y: number, text: string, degrees: number, { size = 40, font = 'bold' as PdfFont, gray = 0.85 } = {}) {
    const r = degrees * Math.PI / 180, c = num(Math.cos(r)), s = num(Math.sin(r));
    this.ops.push(`BT ${num(gray)} g /${FONT_KEYS[font]} ${num(size)} Tf ${c} ${s} ${num(-Math.sin(r))} ${c} ${this.x(x)} ${this.y(y)} Tm (${escapeText(text)}) Tj ET 0 g`);
  }
}
/** The PDF file of the pages (catalog, page tree, the three fonts and one content stream per page; byte offsets in the xref table). */
export function pdfDocument(pages: readonly PdfPage[], { title = 'DANFE', producer = 'FAGOO' } = {}): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };
  const catalog = add(''), tree = add('');
  const fonts = (['regular', 'bold', 'mono'] as const).map(font => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_NAMES[font]} /Encoding /WinAnsiEncoding >>`));
  const resources = `<< /Font << /F1 ${fonts[0]} 0 R /F2 ${fonts[1]} 0 R /F3 ${fonts[2]} 0 R >> >>`;
  const kids: number[] = [];
  for (const page of pages) {
    const content = page.ops.join('\n'), stream = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${num(page.width * MM)} ${num(page.height * MM)}] /Resources ${resources} /Contents ${stream} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${escapeText(title)}) /Producer (${escapeText(producer)}) >>`);
  // Every body is ASCII (text is escaped to octal), so string length equals byte length.
  let out = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => { offsets.push(byteLength(out)); out += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return latin1(out);
}
const byteLength = (text: string) => text.length; // latin1: one byte per character
function latin1(text: string): Uint8Array { const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff; return bytes; }
