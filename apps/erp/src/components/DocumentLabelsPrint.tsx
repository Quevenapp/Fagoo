import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LABEL_GRIDS, labelSheets, type AddressLabel } from '../lib/document-list-export';
import './document-print.css';

/** Origin "Etiquetas selecionadas": A4 address labels of the selected rows (entrega first, then the contact address). */
/** `heading` (202610200169+): the OS labels name the ordens and explain what the label identifies. */
export default function DocumentLabelsPrint({ labels, onClose, heading }: { labels: readonly AddressLabel[]; onClose: () => void; heading?: { noun: [string, string]; note: string } }) {
  const dialog = useRef<HTMLDivElement>(null), close = useRef<HTMLButtonElement>(null), onCloseRef = useRef(onClose);
  const [grid, setGrid] = useState<keyof typeof LABEL_GRIDS>('2x7'), [printError, setPrintError] = useState(false);
  onCloseRef.current = onClose;
  const [portal] = useState(() => { const node = document.createElement('div'); node.className = 'document-print-root'; return node; });
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow, siorigins = Array.from(document.body.children).filter((element): element is HTMLElement => element instanceof HTMLElement && element !== portal).map(element => ({ element, inert: element.inert }));
    document.body.append(portal); document.body.style.overflow = 'hidden'; document.body.classList.add('document-print-open');
    for (const { element } of siorigins) element.inert = true;
    close.current?.focus();
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); } };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); for (const { element, inert } of siorigins) element.inert = inert; document.body.style.overflow = overflow; document.body.classList.remove('document-print-open'); portal.remove(); if (previous?.isConnected) previous.focus(); };
  }, [portal]);
  const sheets = labelSheets(labels, grid), { columns } = LABEL_GRIDS[grid];
  return createPortal(<div className="document-print-dialog" role="dialog" aria-modal="true" aria-labelledby="document-labels-title" ref={dialog}>
    <header className="document-print-controls"><div><h2 id="document-labels-title">Etiquetas · {labels.length} {labels.length === 1 ? heading?.noun[0] ?? 'endereço' : heading?.noun[1] ?? 'endereços'}</h2><p>{heading?.note ?? 'O endereço de entrega tem prioridade; sem ele, vale o endereço do contato.'}</p></div>
      <div><label htmlFor="document-labels-grid" className="sr-only">Grade</label><select id="document-labels-grid" value={grid} onChange={event => setGrid(event.target.value as keyof typeof LABEL_GRIDS)}>{Object.entries(LABEL_GRIDS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select>
        <button type="button" className="secondary-button" ref={close} onClick={onClose}>Fechar prévia</button><button type="button" className="primary-button" disabled={!labels.length} onClick={() => { setPrintError(false); try { window.print(); } catch { setPrintError(true); } }}>Imprimir etiquetas</button></div></header>
    {printError && <p className="document-print-error" role="alert">Não foi possível abrir a impressão. Confira as permissões do navegador e tente novamente.</p>}
    <div className="document-print-scroll" tabIndex={0} aria-label="Etiquetas para impressão">{sheets.map((sheet, index) => <article key={index} className="commercial-sheet commercial-labels" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
      {sheet.map((label, position) => <div key={position} className="commercial-label">{label ? <><strong>{label.name}</strong><span>{label.address ?? 'Endereço não informado'}</span><small>{label.reference}</small></> : null}</div>)}
    </article>)}</div>
  </div>, portal);
}
