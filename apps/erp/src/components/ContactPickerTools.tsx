import {nativeReportCoverageText,type NativeReportCoverage} from '../lib/document-reports-model';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AccessController } from '../lib/real-access';
import type { CatalogRecord } from '../lib/catalog-base';
import {
  HISTORY_STATUS, contactHistory, contactHistoryPath, contactOptionsPath, contactRecordPath, contactSummary, historyMoney, pickerOptions,
  type ContactSummary, type HistoryItem, type HistoryKind, type PickerOption, type PickerRole,
} from '../lib/contact-picker-model';
import { contactRefusalText } from './contact-errors';
import { Modal } from './Modal';
import { Icon } from './Icon';
import './contacts.css';

// Ferramentas do campo de contato dos documentos e do financeiro (Origin, contatos onda C): lupa "Pesquisar" (também com
// ENTER) com a busca avançada por nome, fantasia, CPF/CNPJ e cidade; olho "Visualizar pessoas de contato"; lápis
// "Editar Contato" (o formulário do contato numa nova aba); "Visualizar histórico" dos pedidos do contato; e o card azul
// com as Observações do cadastro. Só lê: nada aqui grava.
type Controller = Pick<AccessController, 'catalog' | 'getSnapshot'>;
export type ContactTools = { history?: HistoryKind; role?: PickerRole };
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const brDate = (value: string | null) => value ? value.split('-').reverse().join('/') : '—';
// Some screens hand a controller without the session snapshot (isolated tests): then there is no actor to compare.
const actorOf = (controller: Controller) => typeof controller.getSnapshot === 'function' ? controller.getSnapshot().membership?.user_id ?? null : null;

export function ContactPickerTools({ controller, contact, tools, disabled, searchOpen, searchText = '', onSearch, onSearchClose, onSelect }: {
  controller: Controller; contact: { id: string; name: string } | null | undefined; tools: ContactTools; disabled?: boolean; searchText?: string;
  searchOpen: boolean; onSearch: () => void; onSearchClose: () => void; onSelect: (record: CatalogRecord) => void;
}) {
  const [summary, setSummary] = useState<{ id: string; value: ContactSummary | null } | null>(null), [open, setOpen] = useState<'persons' | 'history' | null>(null);
  const [history, setHistory] = useState<NativeReportCoverage & { id: string; visible: boolean; items: HistoryItem[]; error: string } | null>(null);
  const actor = useRef(actorOf(controller)), contactId = contact?.id ?? null;
  const same = () => actorOf(controller) === actor.current;
  useEffect(() => {
    setOpen(null); setHistory(null);
    // Isolated screens (QA readers) may hand a controller without the catalog port: then there is nothing to read.
    if (!contactId || typeof controller.catalog !== 'function') { setSummary(null); return; }
    const request = new AbortController();
    void controller.catalog(`/v1/cadastros/contatos/${contactId}/resumo`, { signal: request.signal }).then(value => {
      if (!request.signal.aborted && same()) setSummary({ id: contactId, value: contactSummary(value, contactId) });
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) setSummary({ id: contactId, value: null }); });
    return () => request.abort();
  }, [controller, contactId]);
  useEffect(() => {
    if (open !== 'history' || !contactId || !tools.history || history?.id === contactId) return;
    const request = new AbortController(), kind = tools.history;
    void controller.catalog(contactHistoryPath(contactId, kind), { signal: request.signal }).then(value => {
      if (request.signal.aborted || !same()) return; const parsed = contactHistory(value, contactId, kind);
      setHistory(parsed ? { id: contactId, ...parsed, error: '' } : { id: contactId, visible: true, items: [], error: 'Não foi possível consultar o histórico.' });
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) setHistory({ id: contactId, visible: true, items: [], error: contactRefusalText(failure) ?? 'Não foi possível consultar o histórico.' }); });
    return () => request.abort();
  }, [controller, open, contactId]);
  const current = summary?.id === contactId ? summary.value : null, persons = current?.persons ?? [];
  // Origin shows "Visualizar histórico do cliente" on the Fornecedor field of the pedido de compra too (capture EST-034).
  const historyTitle = 'Visualizar histórico do cliente';
  const shownHistory = history?.id === contactId ? history : null;
  return <div className="contact-picker-tools">
    <div className="contact-picker-icons">
      <button type="button" className="icon-button" title="Pesquisar" aria-label="Pesquisar" disabled={disabled} onClick={onSearch}><Icon name="magnifying-glass" size={12} /></button>
      {contactId && <>
        <button type="button" className="icon-button" title="Visualizar pessoas de contato" aria-label="Visualizar pessoas de contato" aria-expanded={open === 'persons'} disabled={!persons.length}
          onClick={() => setOpen(open === 'persons' ? null : 'persons')}><Icon name="eye" size={12} /></button>
        <a className="icon-button" href={contactRecordPath(contactId)} target="_blank" rel="noopener noreferrer" title="Editar Contato" aria-label="Editar Contato"><Icon name="pen-to-square" size={12} /></a>
        {tools.history && <button type="button" className="icon-button" title={historyTitle} aria-label={historyTitle} aria-expanded={open === 'history'} onClick={() => setOpen(open === 'history' ? null : 'history')}><Icon name="clock-rotate-left" size={12} /></button>}
      </>}
    </div>
    {open === 'persons' && persons.length > 0 && <div className="contact-picker-popover" role="region" aria-label="Pessoas de contato"><h4>Pessoas de contato</h4><ul>{persons.map(person => <li key={person.id}><strong>{person.name}</strong>
      {person.visible ? [person.phone, person.mobile, person.email].filter(Boolean).map(value => <span key={value}>{value}</span>) : <span>Fora da carteira do seu vendedor</span>}</li>)}</ul></div>}
    {open === 'history' && <div className="contact-picker-popover" role="region" aria-label="Últimos registros deste contato"><h4>Últimos registros deste {tools.history === 'purchase_orders' ? 'fornecedor' : 'cliente'}</h4>
      {shownHistory?.visible&&nativeReportCoverageText(shownHistory)&&<p className="real-notice" role="note">{nativeReportCoverageText(shownHistory)}</p>}
      {!shownHistory ? <p role="status">Consultando…</p> : shownHistory.error ? <p role="alert">{shownHistory.error}</p> : !shownHistory.visible ? <p>Seu perfil não consulta estes pedidos.</p>
        : shownHistory.items.length ? <table><thead><tr><th scope="col">Número</th><th scope="col">Data</th><th scope="col">Situação</th><th scope="col">Total</th></tr></thead>
          <tbody>{shownHistory.items.map(item => <tr key={item.id}><td>{item.number}</td><td>{brDate(item.date)}</td><td>{HISTORY_STATUS[item.status] ?? item.status}</td><td>{historyMoney(item.total)}</td></tr>)}</tbody></table>
          : <p>{tools.history === 'purchase_orders' ? 'Não existem compras deste fornecedor.' : 'Não existem vendas para este cliente.'}</p>}</div>}
    {current?.notes && <div className="contact-notes-card" role="note" aria-label="Observações do contato">{current.notes}</div>}
    {searchOpen && <ContactSearchDialog controller={controller} role={tools.role ?? null} initial={searchText} onClose={onSearchClose} onSelect={record => { onSelect(record); onSearchClose(); }} />}
  </div>;
}

/** Busca avançada de contatos (ENTER ou lupa "Pesquisar"): nome, fantasia, CPF/CNPJ e cidade; só cadastros ativos. */
export function ContactSearchDialog({ controller, role, initial = '', onClose, onSelect }: { controller: Controller; role: PickerRole | null; initial?: string; onClose: () => void; onSelect: (record: CatalogRecord) => void }) {
  const [query, setQuery] = useState(initial.slice(0, 120)), [city, setCity] = useState(''), [rows, setRows] = useState<PickerOption[] | null>(null), [more, setMore] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const request = useRef<AbortController | null>(null), actor = useRef(actorOf(controller));
  const search = async () => {
    request.current?.abort(); const current = new AbortController(); request.current = current; setBusy(true); setError('');
    try {
      const value = await controller.catalog(contactOptionsPath({ q: query, city, role, limit: 50 }), { signal: current.signal });
      if (current.signal.aborted || actorOf(controller) !== actor.current) return;
      const parsed = pickerOptions(value); if (!parsed) { setError('Não foi possível pesquisar os contatos. Tente novamente.'); return; }
      setRows(parsed.items); setMore(parsed.has_more);
    } catch (failure) { if (!current.signal.aborted && !aborted(failure)) setError(contactRefusalText(failure) ?? 'Não foi possível pesquisar os contatos. Tente novamente.'); }
    finally { if (request.current === current) { request.current = null; setBusy(false); } }
  };
  // The text typed in the field before ENTER is searched right away (Origin busca avançada).
  useEffect(() => { if (query.trim()) void search(); return () => request.current?.abort(); }, []);
  // ENTER searches here and never submits the document behind the dialog.
  const enter = (event: KeyboardEvent<HTMLInputElement>) => { if (event.key !== 'Enter') return; event.preventDefault(); event.stopPropagation(); void search(); };
  return <Modal title="Pesquisar contato" onClose={onClose} actions={<button type="button" className="secondary-button" onClick={onClose}>Cancelar</button>}>
    <div className="contact-search-fields">
      <div className="form-field"><label htmlFor="contact-search-query">Nome, fantasia ou CPF/CNPJ</label><input id="contact-search-query" type="search" maxLength={120} autoComplete="off" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={enter} /></div>
      <div className="form-field"><label htmlFor="contact-search-city">Cidade</label><input id="contact-search-city" maxLength={100} autoComplete="off" value={city} onChange={event => setCity(event.target.value)} onKeyDown={enter} /></div>
      <button type="button" className="primary-button" disabled={busy} onClick={() => void search()}><Icon name="magnifying-glass" size={12} />{busy ? 'Pesquisando…' : 'Pesquisar'}</button>
    </div>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {rows && (rows.length ? <div className="table-scroll"><table className="data-table contact-search-results"><thead><tr><th scope="col">Nome</th><th scope="col">Fantasia</th><th scope="col">CPF/CNPJ</th><th scope="col">Cidade</th><th scope="col"><span className="real-sr-only">Selecionar</span></th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.id}><td>{row.name}{row.code ? ` (${row.code})` : ''}</td><td>{row.trade_name ?? ''}</td><td>{row.document ?? ''}</td><td>{[row.city, row.state].filter(Boolean).join('/')}</td>
        <td><button type="button" className="text-button" onClick={() => onSelect(row as unknown as CatalogRecord)}>Selecionar</button></td></tr>)}</tbody></table>
      {more && <p className="real-help">Mostrando os 50 primeiros contatos. Refine a pesquisa para encontrar outros.</p>}</div> : <p className="empty-state">Nenhum contato ativo encontrado.</p>)}
  </Modal>;
}
