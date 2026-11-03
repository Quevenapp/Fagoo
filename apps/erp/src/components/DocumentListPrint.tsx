import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LIST_TITLES, listColumns, listCountLabel, printMoneyText, type ListSnapshot } from '../lib/document-list-export';
import './document-print.css';
import DocumentOriginTotals from './DocumentOriginTotals';

const stamp = () => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date());

/** "Imprimir listagem": every row of the filtered set read page by page, on A4, with the filtered totals. */
export default function DocumentListPrint({ snapshot, filters, onClose }: { snapshot: ListSnapshot; filters: readonly string[]; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null), close = useRef<HTMLButtonElement>(null), onCloseRef = useRef(onClose);
  const [printError, setPrintError] = useState(false);
  const [printedAt] = useState(stamp);
  onCloseRef.current = onClose;
  const [portal] = useState(() => { const node = document.createElement('div'); node.className = 'document-print-root'; return node; });
  const baseColumns = listColumns(snapshot.kind, printMoneyText);
  const columns = baseColumns.filter(column => !['source_id', 'observed_at', 'coverage'].includes(column.key)).map(column => column.key === 'origin' ? { ...column, value: (row: ListSnapshot['rows'][number]) => baseColumns.filter(item => ['origin', 'source_id', 'observed_at', 'coverage'].includes(item.key)).map(item => { const value = item.value(row); return value && (item.key === 'source_id' ? `ID ${value}` : item.key === 'observed_at' ? `Observado em ${value}` : value); }).filter(Boolean).join(' · ') } : column);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow, siorigins = Array.from(document.body.children).filter((element): element is HTMLElement => element instanceof HTMLElement && element !== portal).map(element => ({ element, inert: element.inert }));
    document.body.append(portal); document.body.style.overflow = 'hidden'; document.body.classList.add('document-print-open');
    for (const { element } of siorigins) element.inert = true;
    close.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== 'Tab') return;
      const fields = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),[tabindex="0"]') || []), first = fields[0], last = fields.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); for (const { element, inert } of siorigins) element.inert = inert; document.body.style.overflow = overflow; document.body.classList.remove('document-print-open'); portal.remove(); if (previous?.isConnected) previous.focus(); };
  }, [portal]);
  return createPortal(<div className="document-print-dialog" role="dialog" aria-modal="true" aria-labelledby="document-list-print-title" ref={dialog}>
    <header className="document-print-controls"><div><h2 id="document-list-print-title">Prévia da listagem · {snapshot.total_count.toLocaleString('pt-BR')} {snapshot.total_count === 1 ? 'registro' : 'registros'}</h2><p>Todas as páginas do filtro aplicado, lidas uma a uma. Observações internas não são impressas.</p></div><div><button type="button" className="secondary-button" ref={close} onClick={onClose}>Fechar prévia</button><button type="button" className="primary-button" onClick={() => { setPrintError(false); try { window.print(); } catch { setPrintError(true); } }}>Imprimir listagem</button></div></header>
    {printError && <p className="document-print-error" role="alert">Não foi possível abrir a impressão. Confira as permissões do navegador e tente novamente.</p>}
    <div className="document-print-scroll" tabIndex={0} aria-label="Listagem para impressão">
      <article className="commercial-sheet document-list-sheet" aria-label={LIST_TITLES[snapshot.kind]}>
        <header className="commercial-heading"><div><p className="commercial-brand">FAGOO</p><h2>{LIST_TITLES[snapshot.kind]}</h2><p className="commercial-footnote">{filters.length ? `Filtros: ${filters.join(' · ')}` : 'Nenhum filtro aplicado'}</p></div><div className="commercial-identity"><span>Emitida em {printedAt}</span></div></header>
        {snapshot.rows.length ? <table><thead><tr>{columns.map(column => <th scope="col" key={column.key} className={column.numeric ? 'commercial-numeric' : undefined}>{column.label}</th>)}</tr></thead>
          <tbody>{snapshot.rows.map(row => <tr key={row.id}>{columns.map(column => <td key={column.key} className={column.numeric ? 'commercial-numeric' : undefined}>{column.value(row)}</td>)}</tr>)}</tbody></table> : <p>Nenhum registro no filtro aplicado.</p>}
        <section className="commercial-totals" aria-label="Totais da listagem"><dl><div><dt>{listCountLabel(snapshot.kind)}</dt><dd>{snapshot.total_count.toLocaleString('pt-BR')}</dd></div>{snapshot.total_amount !== null && !snapshot.origin_totals && <div className="commercial-grand-total"><dt>Valor total</dt><dd>{printMoneyText(snapshot.total_amount)}</dd></div>}</dl>{snapshot.origin_totals && <DocumentOriginTotals totals={snapshot.origin_totals} />}</section>
      </article>
    </div>
  </div>, portal);
}
