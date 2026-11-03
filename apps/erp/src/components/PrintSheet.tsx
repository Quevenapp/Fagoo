import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './document-print.css';

// Prévia A4 de uma listagem para "Imprimir" (produtos e listas de preços): cabeçalho com a empresa, o título, os filtros e a
// data de emissão (horário de São Paulo); o botão Imprimir abre a impressão do navegador. Os dados chegam já lidos (ou ainda
// em leitura, com o progresso); a prévia nunca grava nada.
export const printedAt = () => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date());
export type PrintColumn = { key: string; label: string; numeric?: boolean };
export function PrintSheet({ title, subtitle, filters, columns, rows, progress, error, onClose, children }: {
  title: string; subtitle?: string; filters?: string; columns: readonly PrintColumn[]; rows: readonly Record<string, string>[] | null; progress?: string; error?: string; onClose: () => void; children?: ReactNode;
}) {
  const [stamp] = useState(printedAt), onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [portal] = useState(() => { const node = document.createElement('div'); node.className = 'document-print-root'; return node; });
  useEffect(() => {
    document.body.append(portal); document.body.classList.add('document-print-open');
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); } };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); document.body.classList.remove('document-print-open'); portal.remove(); };
  }, [portal]);
  return createPortal(<div className="document-print-dialog" role="dialog" aria-modal="true" aria-labelledby="print-sheet-title">
    <header className="document-print-controls"><div><h2 id="print-sheet-title">{title}{rows ? ` · ${rows.length} ${rows.length === 1 ? 'registro' : 'registros'}` : ''}</h2>{subtitle && <p>{subtitle}</p>}</div>
      <div className="contact-print-actions">{children}
        <button type="button" className="primary-button" disabled={!rows} onClick={() => window.print()}>Imprimir</button>
        <button type="button" className="secondary-button" onClick={onClose}>Fechar</button></div></header>
    {progress && <p role="status" className="document-print-error">{progress}</p>}
    {error && <p className="document-print-error" role="alert">{error}</p>}
    <div className="document-print-scroll" tabIndex={0} aria-label={`${title} para impressão`}>
      {rows && <article className="commercial-sheet document-list-sheet" aria-label={title}>
        <header className="commercial-heading"><div><p className="commercial-brand">FAGOO</p><h2>{title}</h2>
          <p className="commercial-footnote">{filters ? `${filters} · ` : ''}Emitido em {stamp}</p></div></header>
        {rows.length ? <table><thead><tr>{columns.map(column => <th scope="col" key={column.key} className={column.numeric ? 'numeric' : undefined}>{column.label}</th>)}</tr></thead>
          <tbody>{rows.map((row, index) => <tr key={index}>{columns.map(column => <td key={column.key} className={column.numeric ? 'numeric' : undefined}>{row[column.key] || '—'}</td>)}</tr>)}</tbody></table>
          : <p>Nenhum registro no filtro aplicado.</p>}
      </article>}
    </div>
  </div>, portal);
}
