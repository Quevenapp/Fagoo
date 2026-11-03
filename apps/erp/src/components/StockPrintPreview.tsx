import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './stock-print.css';

/** A4 print preview of a stock receipt or report. Content is React text only; printing hides the rest of the page. */
export default function StockPrintPreview({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const [portal, setPortal] = useState<HTMLElement | null>(null), [printError, setPrintError] = useState(false);
  const close = useRef<HTMLButtonElement>(null), onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
    const node = document.createElement('div'); node.className = 'stock-print-root';
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.append(node); document.body.classList.add('stock-print-open'); setPortal(node);
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); } };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); document.body.classList.remove('stock-print-open'); node.remove(); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { close.current?.focus(); }, [portal]);
  const content = <div className="stock-print-dialog" role="dialog" aria-modal="true" aria-labelledby="stock-print-title">
    <header className="stock-print-controls"><h2 id="stock-print-title">{title}</h2><div>
      <button type="button" className="secondary-button" ref={close} onClick={onClose}>Fechar</button>
      <button type="button" className="primary-button" onClick={() => { setPrintError(false); try { window.print(); } catch { setPrintError(true); } }}>Imprimir</button></div></header>
    {printError && <p className="real-alert" role="alert">Não foi possível abrir a impressão. Confira as permissões do navegador e tente novamente.</p>}
    <div className="stock-print-scroll" tabIndex={0} aria-label={title}><article className="stock-print-sheet">{children}</article></div>
  </div>;
  return portal ? createPortal(content, portal) : content;
}
