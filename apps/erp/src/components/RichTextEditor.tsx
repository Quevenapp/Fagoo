import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { blockStyle, emptyRichText, formatBlocks, formatRange, normalizeRichText, richFromDom, runStyle, RICH_SIZES, type RichAlign, type RichNode, type RichPosition, type RichText,
  type RichTextMap, type RunFormat } from '../lib/rich-text-model';
import { RichTextView } from './RichTextView';
import { Icon } from './Icon';
import './rich-text.css';

const HISTORY = 50;
/**
 * 202610200270 Origin editor of "Outros itens ou serviços", of the "Condições comerciais" Texto tab and of the "Cabeçalho personalizado":
 * Negrito, Itálico, Sublinhado, the four alignments, Tamanho (11pt), Cor do texto, Cor de fundo, recuo − / +, Código, Desfazer and Refazer.
 * The editable area is read back into the closed structure after every change (pasting keeps only the text), and the structure is
 * drawn with createElement/textContent, never with HTML. A disabled editor shows the formatted text only.
 */
export function RichTextEditor({ id, label, value, onChange, disabled = false }: { id: string; label: string; value: RichText | null; onChange: (value: RichText) => void; disabled?: boolean }) {
  const area = useRef<HTMLDivElement | null>(null), current = useRef<RichText>(value ?? emptyRichText()), history = useRef<{ past: RichText[]; future: RichText[] }>({ past: [], future: [] });
  const [error, setError] = useState(''), [size, setSize] = useState('11'), [composing, setComposing] = useState(false);
  const paint = (doc: RichText) => {
    const root = area.current; if (!root || typeof document === 'undefined') return;
    root.replaceChildren(...doc.blocks.map(block => {
      const element = document.createElement(block.code ? 'pre' : 'div'); Object.assign(element.style, blockStyle(block));
      if (block.indent) element.setAttribute('data-indent', String(block.indent)); if (block.code) element.setAttribute('data-code', 'true');
      if (!block.runs.length) element.append(document.createElement('br'));
      for (const run of block.runs) { const span = document.createElement('span'); Object.assign(span.style, runStyle(run)); span.textContent = run.text; element.append(span); }
      return element;
    }));
  };
  // A new value from outside (another document, a reload) is drawn; the editor's own changes are already on the screen.
  useEffect(() => { const next = value ?? emptyRichText(); if (JSON.stringify(next) === JSON.stringify(current.current) && area.current?.childNodes.length) return; current.current = next; paint(next); }, [value, disabled]);
  const commit = (next: RichText, record = true) => {
    let checked: RichText | null; try { checked = normalizeRichText(next); } catch { checked = null; }
    if (!checked) { setError('O texto passou do limite (20.000 caracteres e 200 linhas) ou tem um formato não aceito. A última alteração não foi aplicada.'); paint(current.current); return false; }
    if (record) { history.current = { past: [...history.current.past, current.current].slice(-HISTORY), future: [] }; }
    current.current = checked; setError(''); onChange(checked); return true;
  };
  const read = (map?: RichTextMap) => area.current ? richFromDom(area.current as unknown as RichNode, map) : current.current;
  // Caret ↔ positions of the structure (the text nodes of the area as read by richFromDom).
  const positions = (): [RichPosition, RichPosition] | null => {
    const root = area.current, selection = typeof document !== 'undefined' ? document.getSelection() : null;
    if (!root || !selection || !selection.rangeCount) return null;
    const map: RichTextMap = new Map(); read(map);
    const texts: Text[] = []; const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
    const at = (node: Node, offset: number): RichPosition | null => {
      if (!root.contains(node)) return null;
      let text: Text | undefined, inner = offset;
      if (node.nodeType === 3) text = node as Text;
      else { const after = texts.find(t => (node.childNodes[offset] ?? null) && (node.childNodes[offset] === t || node.childNodes[offset]!.contains(t)));
        if (after) { text = after; inner = 0; } else { const before = [...texts].reverse().find(t => node.contains(t) || (node.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_PRECEDING)); if (before) { text = before; inner = before.data.length; } } }
      const base = text ? map.get(text as unknown as RichNode) : undefined;
      return base ? { block: base.block, offset: base.offset + Math.min(inner, text!.data.length) } : { block: 0, offset: 0 };
    };
    const range = selection.getRangeAt(0), start = at(range.startContainer, range.startOffset), end = at(range.endContainer, range.endOffset);
    return start && end ? [start, end] : null;
  };
  const restore = ([start, end]: [RichPosition, RichPosition]) => {
    const root = area.current, selection = document.getSelection(); if (!root || !selection) return;
    const point = (position: RichPosition): [Node, number] => {
      const block = root.childNodes[Math.min(position.block, root.childNodes.length - 1)]; if (!block) return [root, 0];
      let left = position.offset;
      for (const span of Array.from(block.childNodes)) { const text = span.firstChild; if (text && text.nodeType === 3) { const len = (text as Text).data.length; if (left <= len) return [text, left]; left -= len; } }
      return [block, block.childNodes.length];
    };
    const range = document.createRange(); range.setStart(...point(start)); range.setEnd(...point(end)); selection.removeAllRanges(); selection.addRange(range);
  };
  const apply = (change: (doc: RichText, a: RichPosition, b: RichPosition) => RichText) => {
    if (disabled) return; const picked = positions(); const doc = read();
    if (!picked) { setError('Selecione o texto no editor para formatar.'); return; }
    const next = change(doc, picked[0], picked[1]); if (!commit(next)) return; paint(next); restore(picked); area.current?.focus();
  };
  const format = (patch: Partial<RunFormat>) => apply((doc, a, b) => formatRange(doc, a, b, patch));
  const blocks = (patch: Parameters<typeof formatBlocks>[3]) => apply((doc, a, b) => formatBlocks(doc, a, b, patch));
  const undo = () => { const past = history.current.past.at(-1); if (!past || disabled) return; history.current = { past: history.current.past.slice(0, -1), future: [current.current, ...history.current.future] }; if (commit(past, false)) paint(past); };
  const redo = () => { const [next, ...rest] = history.current.future; if (!next || disabled) return; history.current = { past: [...history.current.past, current.current], future: rest }; if (commit(next, false)) paint(next); };
  const keep = (event: MouseEvent) => event.preventDefault(); // the toolbar never takes the selection away from the text
  const paste = (event: ClipboardEvent<HTMLDivElement>) => { event.preventDefault(); const text = event.clipboardData.getData('text/plain'); if (text) document.execCommand('insertText', false, text); };
  // Dropping keeps only the text too: the browser would otherwise insert the dragged HTML (images, links) into the editable area.
  const drop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); const text = event.dataTransfer?.getData('text/plain') ?? ''; if (!text || typeof document === 'undefined') return;
    const point = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(event.clientX, event.clientY);
    if (point) { const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(point); }
    document.execCommand('insertText', false, text); };
  if (disabled) return <div className="rich-text-editor is-disabled"><span className="rich-text-label" id={`${id}-label`}>{label}</span><RichTextView value={value} label={label} /></div>;
  // Text formatting tools use compact labels with accessible titles.
  const button = (title: string, glyph: ReactNode, run: () => void) => <button type="button" className="rich-text-tool" title={title} aria-label={title} onMouseDown={keep} onClick={run}>{glyph}</button>;
  const ALIGN: [RichAlign, string, string][] = [['left', 'Alinhar à esquerda', 'Esq.'], ['center', 'Centralizar', 'Centro'], ['right', 'Alinhar à direita', 'Dir.'], ['justify', 'Justificar', 'Just.']];
  return <div className="rich-text-editor">
    <span className="rich-text-label" id={`${id}-label`}>{label}</span>
    <div className="rich-text-toolbar" role="toolbar" aria-label={`Formatação: ${label}`}>
      {button('Negrito', <strong>B</strong>, () => format({ bold: true }))}{button('Itálico', <em>I</em>, () => format({ italic: true }))}{button('Sublinhado', <u>U</u>, () => format({ underline: true }))}
      {ALIGN.map(([align, title, icon]) => <span key={align}>{button(title, icon, () => blocks({ align }))}</span>)}
      <label className="rich-text-size">Tamanho<select aria-label="Tamanho da fonte" value={size} onMouseDown={event => event.stopPropagation()} onChange={event => { setSize(event.target.value); format({ size: Number(event.target.value) === 11 ? null : Number(event.target.value) }); }}>{RICH_SIZES.map(value => <option key={value} value={value}>{value}pt</option>)}</select></label>
      <label className="rich-text-color" title="Cor do texto">Cor do texto<input type="color" aria-label="Cor do texto" defaultValue="#000000" onChange={event => format({ color: event.target.value.toLowerCase() })} /></label>
      <label className="rich-text-color" title="Cor de fundo">Cor de fundo<input type="color" aria-label="Cor de fundo" defaultValue="#ffff00" onChange={event => format({ background: event.target.value.toLowerCase() })} /></label>
      {button('Diminuir recuo', '⇤', () => blocks({ indent: -1 }))}{button('Aumentar recuo', '⇥', () => blocks({ indent: 1 }))}{button('Código', '</>', () => blocks({ code: 'toggle' }))}
      {button('Desfazer', <Icon name="rotate-left" size={12} />, undo)}{button('Refazer', <Icon name="rotate-right" size={12} />, redo)}
    </div>
    <div id={id} ref={area} className="rich-text-area" role="textbox" aria-multiline="true" aria-labelledby={`${id}-label`} contentEditable suppressContentEditableWarning spellCheck
      onInput={() => { if (!composing) commit(read()); }} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => { setComposing(false); commit(read()); }} onPaste={paste} onDrop={drop} />
    {error && <small className="real-alert" role="alert">{error}</small>}
  </div>;
}
