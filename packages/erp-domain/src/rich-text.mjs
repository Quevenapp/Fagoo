// 202610200270 rich text of the documents (Origin editors of "Outros itens ou serviços", of the "Condições comerciais" Texto tab and of
// the "Cabeçalho personalizado" of the prints): a closed structure, never HTML. Every block and run carries every key; the editor
// and the print render it as text (escaped by React), so no markup typed or pasted by a user reaches a page. The same rules are
// checked by erp_documents.rich_text (SQL 270).
export const RICH_ALIGNS = Object.freeze(['left', 'center', 'right', 'justify']);
/** Origin "Tamanho" (11pt by default). */
export const RICH_SIZES = Object.freeze([8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36]);
export const RICH_LIMITS = Object.freeze({ blocks: 200, runs: 1000, characters: 20000, indent: 5 });
export const RICH_BLOCK_KEYS = Object.freeze(['align', 'indent', 'code', 'runs']);
export const RICH_RUN_KEYS = Object.freeze(['text', 'bold', 'italic', 'underline', 'color', 'background', 'size']);
const COLOR = /^#[0-9a-f]{6}$/;
export class RichTextError extends Error { constructor() { super('DOCUMENT_RICH_TEXT_INVALID'); this.name = 'RichTextError'; this.code = 'DOCUMENT_RICH_TEXT_INVALID'; } }
const fail = () => { throw new RichTextError(); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** null, or `{version: 1, blocks: [{align, indent, code, runs: [{text, bold, italic, underline, color, background, size}]}]}`. */
export function normalizeRichText(value) {
  if (value === null) return null;
  if (!exact(value, ['version', 'blocks']) || value.version !== 1 || !Array.isArray(value.blocks) || value.blocks.length > RICH_LIMITS.blocks) fail();
  let runs = 0, characters = 0;
  const blocks = value.blocks.map(block => {
    if (!exact(block, RICH_BLOCK_KEYS) || !RICH_ALIGNS.includes(block.align) || !Number.isInteger(block.indent) || block.indent < 0 || block.indent > RICH_LIMITS.indent
      || typeof block.code !== 'boolean' || !Array.isArray(block.runs)) fail();
    return { align: block.align, indent: block.indent, code: block.code, runs: block.runs.map(run => {
      if (!exact(run, RICH_RUN_KEYS) || typeof run.text !== 'string' || !run.text || /[\u0000-\u001f\u007f]/.test(run.text)
        || ['bold', 'italic', 'underline'].some(key => typeof run[key] !== 'boolean')
        || [run.color, run.background].some(color => color !== null && (typeof color !== 'string' || !COLOR.test(color)))
        || (run.size !== null && !RICH_SIZES.includes(run.size))) fail();
      runs += 1; characters += Array.from(run.text).length;
      return { text: run.text, bold: run.bold, italic: run.italic, underline: run.underline, color: run.color, background: run.background, size: run.size };
    }) };
  });
  if (runs > RICH_LIMITS.runs || characters > RICH_LIMITS.characters) fail();
  return { version: 1, blocks };
}
/** The text without the formatting (one line per block). */
export const richTextPlain = doc => doc ? doc.blocks.map(block => block.runs.map(run => run.text).join('')).join('\n') : '';
/** No visible character in any block. */
export const richTextEmpty = doc => !doc || doc.blocks.every(block => block.runs.every(run => !run.text.trim()));
