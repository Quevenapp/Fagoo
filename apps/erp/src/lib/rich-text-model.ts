// 202610200270 texto rico of the documents (Outros itens ou serviços, Condições comerciais › Texto, Cabeçalho personalizado): the pure
// operations of the editor on the closed structure of packages/erp-domain/src/rich-text.mjs, and the reading of the editable area
// (any DOM the browser builds while typing or pasting becomes blocks and runs; tags, attributes and scripts are never kept).
import { RICH_SIZES, normalizeRichText, type RichAlign, type RichBlock, type RichRun, type RichText } from '../../../../packages/erp-domain/src/rich-text.mjs';
export type { RichAlign, RichBlock, RichRun, RichText };
export { normalizeRichText, richTextEmpty, richTextPlain, RICH_SIZES, RICH_LIMITS } from '../../../../packages/erp-domain/src/rich-text.mjs';

export type RunFormat = Omit<RichRun, 'text'>;
export const PLAIN: RunFormat = { bold: false, italic: false, underline: false, color: null, background: null, size: null };
export const emptyBlock = (): RichBlock => ({ align: 'left', indent: 0, code: false, runs: [] });
export const emptyRichText = (): RichText => ({ version: 1, blocks: [emptyBlock()] });
/** A position in the text: the block and the offset (UTF-16 units) in the text of that block. */
export interface RichPosition { block: number; offset: number }
const sameFormat = (a: RunFormat, b: RunFormat) => a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.color === b.color && a.background === b.background && a.size === b.size;
const formatOf = (run: RichRun): RunFormat => ({ bold: run.bold, italic: run.italic, underline: run.underline, color: run.color, background: run.background, size: run.size });
/** Adjacent runs with the same format merge; empty runs are dropped. */
export function compactRuns(runs: readonly RichRun[]): RichRun[] {
  const out: RichRun[] = [];
  for (const run of runs) { if (!run.text) continue; const last = out.at(-1); if (last && sameFormat(formatOf(last), formatOf(run))) out[out.length - 1] = { ...last, text: last.text + run.text }; else out.push({ ...run }); }
  return out;
}
export const blockText = (block: RichBlock) => block.runs.map(run => run.text).join('');
const ordered = (a: RichPosition, b: RichPosition): [RichPosition, RichPosition] => a.block < b.block || (a.block === b.block && a.offset <= b.offset) ? [a, b] : [b, a];
/** The runs of a block cut at the offsets, each part tagged with whether it lies inside [from, to). */
function cut(block: RichBlock, from: number, to: number): { run: RichRun; inside: boolean }[] {
  const parts: { run: RichRun; inside: boolean }[] = []; let at = 0;
  for (const run of block.runs) {
    const start = at, end = at + run.text.length; at = end;
    const points = [start, Math.min(Math.max(from, start), end), Math.min(Math.max(to, start), end), end];
    for (let i = 0; i < 3; i++) { const a = points[i]!, b = points[i + 1]!; if (b > a) parts.push({ run: { ...run, text: run.text.slice(a - start, b - start) }, inside: i === 1 }); }
  }
  return parts;
}
/** The runs selected between two positions (a collapsed range selects nothing). */
function selected(doc: RichText, a: RichPosition, b: RichPosition): RichRun[] {
  const [start, end] = ordered(a, b), runs: RichRun[] = [];
  for (let i = start.block; i <= end.block; i++) { const block = doc.blocks[i]; if (!block) continue; const len = blockText(block).length;
    runs.push(...cut(block, i === start.block ? start.offset : 0, i === end.block ? end.offset : len).filter(part => part.inside).map(part => part.run)); }
  return runs;
}
/** Applies a format to the selected text. A toggle (negrito, itálico, sublinhado) removes it when every selected run has it. */
export function formatRange(doc: RichText, a: RichPosition, b: RichPosition, patch: Partial<RunFormat>): RichText {
  const [start, end] = ordered(a, b), runs = selected(doc, start, end);
  if (!runs.length) return doc;
  const applied: Partial<RunFormat> = { ...patch };
  for (const key of ['bold', 'italic', 'underline'] as const) if (patch[key] === true && runs.every(run => run[key])) applied[key] = false;
  return { version: 1, blocks: doc.blocks.map((block, i) => {
    if (i < start.block || i > end.block) return block;
    const len = blockText(block).length;
    return { ...block, runs: compactRuns(cut(block, i === start.block ? start.offset : 0, i === end.block ? end.offset : len).map(part => part.inside ? { ...part.run, ...applied } : part.run)) };
  }) };
}
/** Whether every selected run has the toggle (the state of the B / I / U buttons). */
export const rangeHas = (doc: RichText, a: RichPosition, b: RichPosition, key: 'bold' | 'italic' | 'underline') => { const runs = selected(doc, a, b); return runs.length > 0 && runs.every(run => run[key]); };
/** Alinhamento, recuo and Código apply to every block touched by the selection. */
export function formatBlocks(doc: RichText, a: RichPosition, b: RichPosition, patch: { align?: RichAlign; indent?: -1 | 1; code?: 'toggle' }): RichText {
  const [start, end] = ordered(a, b), touched = doc.blocks.slice(start.block, end.block + 1);
  const code = patch.code === 'toggle' ? !touched.every(block => block.code) : undefined;
  return { version: 1, blocks: doc.blocks.map((block, i) => i < start.block || i > end.block ? block : { ...block,
    ...(patch.align ? { align: patch.align } : {}), ...(patch.indent ? { indent: Math.min(5, Math.max(0, block.indent + patch.indent)) } : {}), ...(code !== undefined ? { code } : {}) }) };
}

// ---------------------------------------------------------------- Reading the editable area
/** The part of a DOM node the reader uses (a real Node of the browser, or a plain object in the tests). */
export interface RichNode { nodeType: number; nodeName: string; nodeValue?: string | null; childNodes: ArrayLike<RichNode>;
  style?: { fontWeight?: string; fontStyle?: string; textDecoration?: string; textDecorationLine?: string; color?: string; backgroundColor?: string; fontSize?: string; textAlign?: string };
  getAttribute?: (name: string) => string | null }
const BLOCK_TAGS = new Set(['DIV', 'P', 'PRE', 'BLOCKQUOTE', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'TR']);
const SKIPPED = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'IMG', 'SVG', 'VIDEO', 'AUDIO', 'CANVAS', 'NOSCRIPT', 'TITLE', 'HEAD', 'META', 'LINK']);
/** `#rrggbb` (lower case) from `#abc`, `#aabbcc` or `rgb(r, g, b)`; anything else is no color. */
export function cssColor(value: string | null | undefined): string | null {
  const text = (value ?? '').trim().toLowerCase(); if (!text || text === 'transparent' || text === 'inherit' || text === 'initial') return null;
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text); if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`;
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([\d.]+))?\s*\)$/.exec(text);
  if (m && (m[4] === undefined || Number(m[4]) > 0)) return `#${[m[1], m[2], m[3]].map(v => Math.min(255, Number(v)).toString(16).padStart(2, '0')).join('')}`;
  return null;
}
const ptSize = (value: string | undefined): number | null => { const m = /^(\d{1,2})pt$/.exec((value ?? '').trim()); return m && RICH_SIZES.includes(Number(m[1])) ? Number(m[1]) : null; };
const ALIGNS: Record<string, RichAlign> = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', justify: 'justify' };
/** Text node → where its text starts (block and offset) in the result; used to map the caret. */
export type RichTextMap = Map<RichNode, RichPosition>;
export function richFromDom(root: RichNode, map?: RichTextMap): RichText {
  const blocks: RichBlock[] = []; let current: RichBlock | null = null;
  const open = (from: Partial<RichBlock> = {}) => { current = { ...emptyBlock(), ...from }; blocks.push(current); return current; };
  const blockOf = (): RichBlock => current ?? open();
  const walk = (node: RichNode, format: RunFormat, blockFormat: Partial<RichBlock>) => {
    if (node.nodeType === 3) {
      const text = (node.nodeValue ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '');
      const block = blockOf(); map?.set(node, { block: blocks.length - 1, offset: blockText(block).length });
      if (text) block.runs.push({ text, ...format }); return;
    }
    if (node.nodeType !== 1 || SKIPPED.has(node.nodeName)) return;
    if (node.nodeName === 'BR') { open(blockFormat); return; }
    const style = node.style ?? {}, tag = node.nodeName, next: RunFormat = { ...format };
    if (tag === 'B' || tag === 'STRONG' || /^(bold|bolder|[6-9]00)$/.test(style.fontWeight ?? '')) next.bold = true;
    if ((style.fontWeight ?? '') === 'normal') next.bold = false;
    if (tag === 'I' || tag === 'EM' || style.fontStyle === 'italic') next.italic = true;
    if (tag === 'U' || /underline/.test(`${style.textDecoration ?? ''} ${style.textDecorationLine ?? ''}`)) next.underline = true;
    const color = cssColor(style.color ?? (tag === 'FONT' ? node.getAttribute?.('color') : null)); if (color) next.color = color;
    const background = cssColor(style.backgroundColor); if (background) next.background = background;
    const size = ptSize(style.fontSize); if (size) next.size = size;
    if (BLOCK_TAGS.has(tag)) {
      const indent = Number(node.getAttribute?.('data-indent') ?? '0'), align = ALIGNS[(style.textAlign ?? '').toLowerCase()];
      const own: Partial<RichBlock> = { ...blockFormat, ...(align ? { align } : {}), ...(Number.isInteger(indent) && indent >= 0 && indent <= 5 && indent > 0 ? { indent } : {}),
        ...(tag === 'PRE' || node.getAttribute?.('data-code') === 'true' ? { code: true } : {}) };
      open(own);
      for (const child of Array.from(node.childNodes)) walk(child, next, own);
      current = null; return;
    }
    for (const child of Array.from(node.childNodes)) walk(child, next, blockFormat);
  };
  for (const child of Array.from(root.childNodes)) walk(child, PLAIN, {});
  const out = blocks.map(block => ({ ...block, runs: compactRuns(block.runs) }));
  // A trailing empty block left by a last <br> (browsers add one) is not a line of the text.
  while (out.length > 1 && !out.at(-1)!.runs.length && !out.at(-2)!.runs.length) out.pop();
  return { version: 1, blocks: out.length ? out : [emptyBlock()] };
}
/** CSS of a run and of a block (the editor, the view and the print use the same). */
export function runStyle(run: RunFormat): Record<string, string> {
  return { ...(run.bold ? { fontWeight: 'bold' } : {}), ...(run.italic ? { fontStyle: 'italic' } : {}), ...(run.underline ? { textDecoration: 'underline' } : {}),
    ...(run.color ? { color: run.color } : {}), ...(run.background ? { backgroundColor: run.background } : {}), ...(run.size ? { fontSize: `${run.size}pt` } : {}) };
}
export const blockStyle = (block: RichBlock): Record<string, string> => ({ textAlign: block.align, ...(block.indent ? { paddingLeft: `${block.indent * 2}em` } : {}) });
