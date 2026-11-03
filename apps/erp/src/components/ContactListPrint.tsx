import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AccessController } from '../lib/real-access';
import { COLUMN_LABELS, EXPORT_LIMIT, SITUATION_LABELS, birthday, typeLabels, type ContactListState, type ContactTypeItem } from '../lib/contact-list-model';
import { ExportTooLarge, fetchContactRows } from '../lib/contact-export-request';
import { isoDateValid, saoPauloToday, type ContactRecord } from '../lib/contact-form-model';
import { brDate, parseIso, daysInMonth, isoDate } from '../lib/origin-list';
import { aborted, errorText } from './catalog-shared';
import { contactRefusalText } from './contact-errors';
import './document-print.css';

// "Imprimir listagem de contatos" (Origin CL-04) e "Mais ações > Imprimir > Aniversariantes" (CL-23): todos os contatos do
// filtro (até 10.000), lidos em blocos, numa prévia A4; o botão Imprimir abre a impressão do navegador. A saída exata do
// Origin não foi capturada: a listagem usa as colunas da visão ativa e Aniversariantes mostra nome, aniversário e contato.
export type PrintRequest = { kind: 'contacts' | 'birthdays'; state: Omit<ContactListState, 'page'>; columns: readonly string[] };
const stamp = () => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date());
const value = (row: ContactRecord, column: string, types: readonly ContactTypeItem[]) => {
  const raw = column === 'seller' ? row.seller_name : column === 'situation' ? SITUATION_LABELS[row.situation] : column === 'types' ? typeLabels(row.types, types).join(', ') : row[column];
  return typeof raw === 'string' && raw ? raw : '—';
};
/** Aniversariantes accepts at most 366 days (one year, leap day included), like the server. */
export const BIRTHDAY_MAX_DAYS = 366;
export const birthdayPeriodDays = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const monthOf = (today: string) => { const [year, month] = parseIso(today)!; return { from: isoDate(year, month, 1), to: isoDate(year, month, daysInMonth(year, month)) }; };

export function ContactListPrint({ controller, request, types, onClose }: { controller: AccessController; request: PrintRequest; types: readonly ContactTypeItem[]; onClose: () => void }) {
  const birthdays = request.kind === 'birthdays';
  const [range, setRange] = useState(() => monthOf(saoPauloToday()));
  const [rows, setRows] = useState<ContactRecord[] | null>(null), [busy, setBusy] = useState(false), [progress, setProgress] = useState(''), [error, setError] = useState(''), [printedAt] = useState(stamp);
  const pending = useRef<AbortController | null>(null), onCloseRef = useRef(onClose), actor = useRef(controller.getSnapshot().membership?.user_id);
  onCloseRef.current = onClose;
  const [portal] = useState(() => { const node = document.createElement('div'); node.className = 'document-print-root'; return node; });
  const load = async () => {
    pending.current?.abort(); const current = new AbortController(); pending.current = current; setBusy(true); setError(''); setRows(null);
    try {
      const found = await fetchContactRows(controller, request.kind, request.state, { birthFrom: range.from, birthTo: range.to, signal: current.signal, onProgress: (done, total) => setProgress(`Lendo os contatos: ${done} de ${total}`) });
      if (!current.signal.aborted && controller.getSnapshot().membership?.user_id === actor.current) setRows(found);
    } catch (failure) {
      if (current.signal.aborted || aborted(failure)) return;
      setError(failure instanceof ExportTooLarge ? `A impressão é limitada a ${EXPORT_LIMIT.toLocaleString('pt-BR')} contatos. Refine os filtros.` : failure instanceof Error && failure.message === 'EXPORT_CHANGED' ? 'Os contatos mudaram durante a leitura. Tente de novo.' : contactRefusalText(failure) ?? errorText(failure));
    } finally { if (pending.current === current) { pending.current = null; setBusy(false); setProgress(''); } }
  };
  useEffect(() => {
    document.body.append(portal); document.body.classList.add('document-print-open');
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); } };
    document.addEventListener('keydown', keydown);
    if (!birthdays) void load();
    return () => { document.removeEventListener('keydown', keydown); document.body.classList.remove('document-print-open'); portal.remove(); pending.current?.abort(); };
  }, [portal]);
  const title = birthdays ? 'Aniversariantes' : 'Clientes e fornecedores';
  const rangeOk = Boolean(range.from && range.to) && isoDateValid(range.from) && isoDateValid(range.to) && range.from <= range.to;
  const tooLong = rangeOk && birthdayPeriodDays(range.from, range.to) > BIRTHDAY_MAX_DAYS;
  const columns = birthdays ? ['name', 'birth', 'phone', 'mobile', 'email'] : request.columns;
  const label = (column: string) => column === 'birth' ? 'Aniversário' : COLUMN_LABELS[column] ?? column;
  return createPortal(<div className="document-print-dialog" role="dialog" aria-modal="true" aria-labelledby="contact-print-title">
    <header className="document-print-controls"><div><h2 id="contact-print-title">{title}{rows ? ` · ${rows.length} ${rows.length === 1 ? 'contato' : 'contatos'}` : ''}</h2><p>{birthdays ? 'Contatos com Data Nascimento no período (qualquer ano).' : 'Todas as páginas do filtro atual.'}</p></div>
      <div className="contact-print-actions">
        {birthdays && <><label>Início do período<input type="date" id="contact-birth-from" value={range.from} onChange={event => setRange(current => ({ ...current, from: event.target.value }))} /></label>
          <label>Fim do período<input type="date" id="contact-birth-to" value={range.to} onChange={event => setRange(current => ({ ...current, to: event.target.value }))} /></label>
          <button type="button" className="secondary-button" disabled={busy || !rangeOk || tooLong} onClick={() => void load()}>Gerar</button></>}
        <button type="button" className="primary-button" disabled={!rows || busy} onClick={() => window.print()}>Imprimir</button>
        <button type="button" className="secondary-button" onClick={onClose}>Fechar</button></div></header>
    {birthdays && tooLong && <p className="document-print-error" role="alert">O período dos Aniversariantes pode ter no máximo {BIRTHDAY_MAX_DAYS} dias. Ajuste o início ou o fim do período.</p>}
    {birthdays && range.from && range.to && !rangeOk && <p className="document-print-error" role="alert">Informe um período válido: o fim não pode ser anterior ao início.</p>}
    {progress && <p role="status" className="document-print-error">{progress}</p>}
    {error && <p className="document-print-error" role="alert">{error}</p>}
    <div className="document-print-scroll" tabIndex={0} aria-label={`${title} para impressão`}>
      {rows && <article className="commercial-sheet document-list-sheet" aria-label={title}>
        <header className="commercial-heading"><div><p className="commercial-brand">FAGOO</p><h2>{title}</h2><p className="commercial-footnote">{birthdays ? `Período: ${brDate(range.from)} até ${brDate(range.to)}` : `${rows.length} ${rows.length === 1 ? 'contato' : 'contatos'}`} · Emitido em {printedAt}</p></div></header>
        {rows.length ? <table><thead><tr>{columns.map(column => <th scope="col" key={column}>{label(column)}</th>)}</tr></thead>
          <tbody>{rows.map(row => <tr key={row.id}>{columns.map(column => <td key={column}>{column === 'birth' ? birthday(row) : value(row, column, types)}</td>)}</tr>)}</tbody></table> : <p>Nenhum contato no filtro aplicado.</p>}
      </article>}
    </div>
  </div>, portal);
}
