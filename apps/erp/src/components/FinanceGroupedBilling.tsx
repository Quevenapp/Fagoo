import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { financeLinkActor } from '../lib/document-finance-link';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { financeDate, financeMoney, todaySP, type FinanceAccess, financePermitted } from '../lib/real-finance-model';
import { conditionDays } from '../lib/document-payment-condition';
import { GROUPED_PAGE_SIZE, GROUPED_PERIODS, groupedApiPath, groupedCandidates, groupedDefaultChoice, groupedDocuments, groupedDocumentsPath, groupedItemLabel, groupedPage, groupedParams, groupedRange, groupedResult, groupedRoute, groupedToggle, sumCents,
  type GroupedBilling, type GroupedCandidate, type GroupedDocument, type GroupedRoute } from '../lib/finance-grouped-billing-model';
import { shiftMonth, monthLabel } from '../lib/finance-commissions-model';
import { definitiveFailure, useFinanceCommand } from '../lib/finance-command';
import { batchSummaryText, planBatch, summarizeBatch, type BatchPlan, type BatchResult, type BatchStep } from '../lib/origin-batch';
import { rangeLabel } from '../lib/origin-list';
import NativeListLayout from './NativeListLayout';
import { AppliedChips, OriginPagination, PeriodPicker, ToolButton } from './OriginList';
import { BatchDialog } from './BatchDialog';
import { Modal } from './Modal';
import { Icon } from './Icon';
import './real-finance.css';
import './finance-commissions.css';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const noSubscription = () => () => {}, noSnapshot = () => null;
const failureText = (error: unknown) => error instanceof AccessError ? error.status === 409 ? 'Algum pedido mudou, já foi faturado ou teve as contas lançadas. Atualize a listagem.' : error.status === 400 ? 'A operação não foi aceita. Confira a condição e os pedidos.'
  : error.status === 403 ? 'Seu acesso a esta operação foi alterado.' : error.status === 404 ? 'O faturamento não foi encontrado. Atualize a listagem.' : 'Não foi possível concluir a operação. Tente novamente.' : error instanceof Error ? error.message : 'Não foi possível concluir a operação.';
function BusyGuard() { useUnsavedChanges(false, true); return null; }
type Chosen = { items: GroupedDocument[]; total: number; chosen: string[] };
type DeleteItem = { id: string; label: string; record: GroupedBilling };

/**
 * Financeiro > Faturamento agrupado do Origin (SQL 174). Período (Do mês | Do dia | De um período) e Mês ‹ mm/aaaa ›; colunas ☐,
 * Cliente, Itens ("N Venda(s)", com a seleção dos pedidos), Valor Total e Condição; GERAR CONTAS cria as contas a receber de cada
 * cliente pela condição. "Listar Faturamentos Gerados" mostra os gerados, com Excluir selecionados. ?pedidos= vem de "Faturar
 * pedidos selecionados" da listagem de pedidos de venda.
 */
export default function FinanceGroupedBilling({ controller }: { controller: AccessController }) {
  const location = useLocation(), navigate = useNavigate(), today = todaySP();
  let parsed: { route: GroupedRoute; error: string };
  try { parsed = { route: groupedRoute(new URLSearchParams(location.search), today), error: '' }; } catch (failure) { parsed = { route: { periodo: 'mes', mes: today.slice(0, 7), dia: today, from: today, to: today, q: '', page: 1, pedidos: null, aba: 'agrupar' }, error: (failure as Error).message }; }
  const route = parsed.route;
  const tracked = typeof controller.getSnapshot === 'function', session = useSyncExternalStore(controller.subscribe ?? noSubscription, controller.getSnapshot ?? noSnapshot);
  const actor = financeLinkActor(session), allowed = !tracked || actor !== null, scope = tracked ? `${actor ?? ''}:${session?.phase ?? ''}:${session?.membership?.role ?? ''}` : 'isolated';
  const routeKey = `${location.key}:${location.search}:${scope}`, current = useRef(routeKey); current.current = routeKey;
  const mayRead = () => allowed && current.current === routeKey && (!tracked || financeLinkActor(controller.getSnapshot()) === actor);
  const [permissions, setPermissions] = useState<{ scope: string; value: FinanceAccess } | null>(null), access = permissions?.scope === scope ? permissions.value : null;
  const mayWrite = () => mayRead() && Boolean(access?.write) && (!tracked || ['admin', 'financeiro'].includes(controller.getSnapshot()?.membership?.role ?? ''));
  const [reload, setReload] = useState(0), listKey = `${routeKey}:${reload}`;
  const [data, setData] = useState<{ key: string; candidates: { total: number; items: GroupedCandidate[] } | null; generated: { total: number; items: GroupedBilling[] } | null; error: string }>({ key: '', candidates: null, generated: null, error: '' });
  const candidates = data.key === listKey ? data.candidates : null, generated = data.key === listKey ? data.generated : null, loading = !parsed.error && (data.key !== listKey || (!data.candidates && !data.generated && !data.error));
  const [query, setQuery] = useState(route.q), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [selection, setSelection] = useState<{ key: string; ids: string[] }>({ key: '', ids: [] }), selected = selection.key === listKey ? selection.ids : [];
  const [conditions, setConditions] = useState<{ key: string; values: Record<string, string> }>({ key: '', values: {} }), condition = conditions.key === listKey ? conditions.values : {};
  const [documents, setDocuments] = useState<{ key: string; values: Record<string, Chosen> }>({ key: '', values: {} }), chosenDocs = documents.key === listKey ? documents.values : {};
  const [modal, setModal] = useState<{ key: string; contact: GroupedCandidate } | null>(null), [removal, setRemoval] = useState<{ plan: BatchPlan<DeleteItem>; recovery: boolean } | null>(null);
  const sent = useRef(new Map<string, { id: string; data: Record<string, unknown> }>());
  // Sistema › Usuários › Permissões › Finanças (SQL 246): the server refuses without the key; the screen does not offer it.
  const writable = Boolean(access?.write) && financePermitted(access, 'financas.faturamento_agrupado');
  // A Condição typed and not generated yet is guarded like an unsaved form.
  useUnsavedChanges(Object.values(condition).some(text => text.trim() !== ''), false);
  const command = useFinanceCommand(next => controller.finance(next.path, { method: 'POST', body: { command_id: next.id, data: structuredClone(next.data) } } as never), mayWrite, failureText);
  useEffect(() => { setQuery(route.q); setError(''); setModal(null); }, [location.search]);
  useEffect(() => {
    if (!allowed) return; const request = new AbortController();
    void controller.finance('/v1/financeiro', { signal: request.signal }).then(value => { const result = value as FinanceAccess; if (!request.signal.aborted && mayRead() && result.data_mode === 'erp_native' && result.read === true && typeof result.write === 'boolean') setPermissions({ scope, value: result }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setError(failureText(failure)); });
    return () => request.abort();
  }, [controller, scope]);
  useEffect(() => {
    if (!access || parsed.error || !mayRead()) return; const request = new AbortController();
    void controller.finance(groupedApiPath(route), { signal: request.signal }).then(value => {
      if (request.signal.aborted || !mayRead()) return;
      setData(route.aba === 'gerados' ? { key: listKey, candidates: null, generated: groupedPage(value, route), error: '' } : { key: listKey, candidates: groupedCandidates(value, route), generated: null, error: '' });
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure) && mayRead()) setData({ key: listKey, candidates: null, generated: null, error: failureText(failure) }); });
    return () => request.abort();
  }, [controller, access, listKey]);
  const go = (next: Partial<GroupedRoute>) => navigate(`${location.pathname}?${groupedParams({ ...route, page: 1, ...next }, today)}`);
  const search = (event?: FormEvent) => { event?.preventDefault(); go({ q: query.trim() }); };
  const loadDocuments = async (contact: GroupedCandidate): Promise<Chosen> => {
    const known = chosenDocs[contact.contact_id]; if (known) return known;
    const value = groupedDocuments(await controller.finance(groupedDocumentsPath(route, contact.contact_id)), contact.contact_id);
    const chosen = { items: value.items, total: value.total, chosen: groupedDefaultChoice(value.items) };
    if (mayRead()) setDocuments(previous => ({ key: listKey, values: { ...(previous.key === listKey ? previous.values : {}), [contact.contact_id]: chosen } }));
    return chosen;
  };
  const prepareAndGenerate = async () => {
    if (!mayWrite() || command.busy) return; setNotice('');
    // Conferir resultado: the pending command is sent again as is (useFinanceCommand keeps its id and body).
    if (command.uncertain) { void command.run(() => { throw new Error('Repita a operação.'); }, done); return; }
    const rows = (candidates?.items ?? []).filter(row => selected.includes(row.contact_id));
    if (!rows.length) { setError('Nenhum cliente foi selecionado.'); return; }
    const items: Record<string, unknown>[] = [];
    try {
      for (const row of rows) {
        const text = (condition[row.contact_id] ?? '').trim(); if (!text) throw new Error(`Informe a condição de pagamento de ${row.contact_name}.`);
        let days: number[]; try { days = conditionDays(text); } catch (failure) { throw new Error(`${row.contact_name}: ${(failure as Error).message}`); }
        const docs = await loadDocuments(row); const chosen = docs.items.filter(item => docs.chosen.includes(item.id));
        if (!chosen.length) throw new Error(`Selecione ao menos uma venda ou nota fiscal de ${row.contact_name}.`);
        const total = sumCents(chosen.map(item => item.total_cents)); if (BigInt(total) < BigInt(days.length)) throw new Error(`${row.contact_name}: cada conta precisa ter pelo menos R$ 0,01.`);
        // SQL 247: the notas fiscais go apart (invoice_ids), only when chosen, so an older API keeps receiving the pedidos alone.
        const notes = chosen.filter(item => item.kind === 'fiscal_invoices').map(item => item.id);
        items.push({ contact_id: row.contact_id, document_ids: chosen.filter(item => item.kind !== 'fiscal_invoices').map(item => item.id), ...(notes.length ? { invoice_ids: notes } : {}), total_cents: total, condition: text, days });
      }
    } catch (failure) { if (mayRead()) setError((failure as Error).message); return; }
    if (!mayRead()) return; setError('');
    void command.run(() => ({ id: crypto.randomUUID(), path: '/v1/financeiro/actions/grouped_billing_generate', data: { items } }), done);
  };
  const done = (value: unknown) => {
    const result = groupedResult(value, 'grouped_billing_generate'), count = Array.isArray(result.items) ? result.items.length : 0;
    if (!mayRead()) return; setNotice(`Contas geradas para ${count === 1 ? '1 cliente' : `${count} clientes`}.`); setSelection({ key: '', ids: [] }); setReload(previous => previous + 1);
  };
  const sendDelete = async (item: DeleteItem): Promise<BatchStep> => {
    const replay = sent.current.get(item.id), next = replay ?? { id: crypto.randomUUID(), data: { id: item.record.id, expected_version: item.record.version } };
    if (!mayWrite()) { if (replay) return { uncertain: true, message: 'Seu acesso a esta operação foi alterado. O envio anterior continua sem confirmação.' }; throw new Error('Seu acesso a esta operação foi alterado. Este faturamento não foi enviado.'); }
    sent.current.set(item.id, next);
    try { groupedResult(await controller.finance('/v1/financeiro/actions/grouped_billing_delete', { method: 'POST', body: { command_id: next.id, data: structuredClone(next.data) } } as never), 'grouped_billing_delete'); sent.current.delete(item.id); return { message: 'Faturamento excluído; os pedidos voltaram a ser faturáveis.' }; }
    catch (failure) { if (definitiveFailure(failure) && !replay) { sent.current.delete(item.id); throw new Error(failureText(failure)); } return { uncertain: true, message: 'Resultado não confirmado. Use “Conferir resultado” para repetir a mesma exclusão.' }; }
  };
  const finishDelete = (results: BatchResult[] | null) => { setRemoval(null); if (results === null) return; setSelection({ key: '', ids: [] }); setNotice(`Excluir selecionados: ${batchSummaryText(summarizeBatch(results))}.`); setReload(previous => previous + 1); };
  const toggle = (id: string) => setSelection(previous => { const ids = previous.key === listKey ? previous.ids : []; return { key: listKey, ids: ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id] }; });
  if (!allowed) return <section className="real-state-panel"><h1>Consulta financeira indisponível</h1><p>Confirme sua sessão e seu acesso ao financeiro para continuar.</p></section>;
  const errorBox = data.key === listKey && data.error ? <p className="real-alert" role="alert">{data.error} <button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>Tentar novamente</button></p> : null;
  const range = groupedRange(route), modalVisible = modal && modal.key === listKey ? modal : null;
  const chips = [...(route.q ? [{ label: `Pesquisa: ${route.q}`, onRemove: () => go({ q: '' }) }] : []), ...(route.pedidos ? [{ label: `Pedidos selecionados: ${route.pedidos.length}`, onRemove: () => go({ pedidos: null }) }] : [])];
  const rows = route.aba === 'gerados' ? generated?.items ?? [] : candidates?.items ?? [], total = route.aba === 'gerados' ? generated?.total ?? 0 : candidates?.total ?? 0, pages = Math.max(1, Math.ceil(total / GROUPED_PAGE_SIZE));
  return <>{(command.uncertain || removal?.recovery) && <BusyGuard />}
    <header className="real-heading"><h1>{route.aba === 'gerados' ? 'Faturamentos agrupados' : 'Faturamento agrupado'}</h1>{access && !access.write && <span className="real-mode">Somente consulta</span>}</header>
    {notice && <p className="real-success" role="status">{notice}</p>}{error && <p className="real-alert" role="alert">{error}</p>}{command.error && <p className="real-alert" role="alert">{command.error}</p>}
    {parsed.error ? <section className="real-state-panel"><p role="alert">{parsed.error}</p><button type="button" className="secondary-button" onClick={() => navigate(`${location.pathname}?area=faturamento-agrupado`)}>Limpar filtros da URL</button></section> :
    <form onSubmit={search} aria-label="Filtros do faturamento agrupado"><NativeListLayout filters={route.aba === 'agrupar' && !route.pedidos ? <>
      <fieldset className="finance-option-filter"><legend>Período</legend>{GROUPED_PERIODS.map(option => <label key={option.id} htmlFor={`grouped-period-${option.id}`}><input id={`grouped-period-${option.id}`} type="radio" name="grouped-period" checked={route.periodo === option.id} onChange={() => go({ periodo: option.id })} />{option.label}</label>)}</fieldset>
    </> : null} actions={<>
      {route.aba === 'agrupar' && writable && <button type="button" className="primary-button" disabled={command.busy || loading} onClick={() => void prepareAndGenerate()}>{command.busy ? 'Gerando…' : command.uncertain ? 'Conferir resultado' : 'GERAR CONTAS'}</button>}
      {route.aba === 'gerados' && writable && <button type="button" className="danger-button" disabled={!selected.length || Boolean(removal)} onClick={() => { if (!mayWrite()) return; sent.current = new Map(); const items = (generated?.items ?? []).filter(item => selected.includes(item.id)).map(record => ({ id: record.id, label: `${record.contact_name} · ${financeMoney(record.total_cents)}`, record }));
        setRemoval({ plan: planBatch(items, item => item.record.deletable ? null : 'Tem conta com baixa ou boleto: estorne ou desvincule antes.'), recovery: false }); }}>Excluir selecionados</button>}
      <div className="native-list-summary"><h3>Outras ações</h3>{route.aba === 'agrupar' ? <button type="button" className="text-button" onClick={() => go({ aba: 'gerados', pedidos: null, q: '' })}>Listar Faturamentos Gerados</button> : <button type="button" className="text-button" onClick={() => go({ aba: 'agrupar', q: '' })}>Voltar ao faturamento agrupado</button>}</div>
      <div className="finance-support"><h3>Ferramentas de apoio</h3><Link to="/financeiro-empresa?area=receivable">Contas a receber</Link><Link to="/documentos-empresa?tipo=sales_orders">Pedidos de venda</Link></div>
    </>}>
      <div className="native-list-toolbar"><div className="form-field"><label htmlFor="grouped-search">Pesquisar na listagem</label><input id="grouped-search" type="search" maxLength={120} placeholder="Pesquisar" value={query} onChange={event => setQuery(event.target.value)} /></div><button type="submit" className="secondary-button" disabled={loading || !access}>Pesquisar</button>
        {route.aba === 'agrupar' && !route.pedidos && route.periodo === 'mes' && <div className="finance-month-nav" role="group" aria-label="Mês"><button type="button" className="icon-button" aria-label="Mês anterior" onClick={() => go({ mes: shiftMonth(route.mes, -1) })}><Icon name="chevron-left" size={12} /></button><strong>{monthLabel(route.mes)}</strong><button type="button" className="icon-button" aria-label="Próximo mês" onClick={() => go({ mes: shiftMonth(route.mes, 1) })}><Icon name="chevron-right" size={12} /></button></div>}
        {route.aba === 'agrupar' && !route.pedidos && route.periodo === 'dia' && <div className="form-field"><label htmlFor="grouped-day">Dia</label><input id="grouped-day" type="date" min="1900-01-01" max="2100-12-31" value={route.dia} onChange={event => { if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) go({ dia: event.target.value }); }} /></div>}
        {route.aba === 'agrupar' && !route.pedidos && route.periodo === 'periodo' && <PeriodPicker from={route.from} to={route.to} today={today} onApply={next => { if (next.from && next.to) go({ from: next.from, to: next.to }); }} />}
        <div className="origin-toolbar-tools"><ToolButton icon="rotate-right" title="Recarregar" disabled={loading || !access} onClick={() => setReload(value => value + 1)} /></div></div>
      <AppliedChips chips={chips} onClear={() => go({ q: '', pedidos: null })} />
      <div className="real-result-status" role="status">{loading ? 'Carregando…' : rangeLabel(route.page, GROUPED_PAGE_SIZE, total)}{route.aba === 'agrupar' && !route.pedidos && !loading ? ` · pedidos de ${financeDate(range.from)} a ${financeDate(range.to)}` : ''}</div>
      {errorBox}
      {route.aba === 'agrupar' && candidates && <><div className="table-scroll" tabIndex={0} role="region" aria-label="Clientes a faturar"><table className="data-table finance-table"><thead><tr>{writable && <th className="checkbox-cell"><span className="real-sr-only">Seleção</span></th>}<th>Cliente</th><th>Itens</th><th className="numeric">Valor Total</th><th>Condição</th></tr></thead>
        <tbody>{candidates.items.map(row => { const docs = chosenDocs[row.contact_id], chosen = docs ? docs.items.filter(item => docs.chosen.includes(item.id)) : null;
          return <tr key={row.contact_id}>{writable && <td className="checkbox-cell"><input type="checkbox" aria-label={`Selecionar ${row.contact_name}`} checked={selected.includes(row.contact_id)} disabled={command.locked} onChange={() => toggle(row.contact_id)} /></td>}
            <td>{row.contact_name}</td><td><button type="button" className="text-button" onClick={() => setModal({ key: listKey, contact: row })}>{itemsLabel(row, chosen)}</button></td>
            <td className="numeric">{financeMoney(chosen ? sumCents(chosen.map(item => item.total_cents)) : row.total_cents)}</td>
            <td><label className="real-sr-only" htmlFor={`grouped-condition-${row.contact_id}`}>Condição de {row.contact_name}</label><input id={`grouped-condition-${row.contact_id}`} className="finance-grouped-condition" placeholder="30, 60, 90" maxLength={200} disabled={!writable || command.locked} value={condition[row.contact_id] ?? ''}
              onChange={event => { const text = event.target.value; setConditions(previous => ({ key: listKey, values: { ...(previous.key === listKey ? previous.values : {}), [row.contact_id]: text } })); }} /></td></tr>; })}</tbody></table></div>
        {!candidates.items.length && <div className="empty-state"><h2>Ainda não existem Faturamentos a serem agrupados</h2><p>Os pedidos de venda verificados e as NF-e de saída do FAGOO, sem contas lançadas, aparecem aqui agrupados por cliente.</p></div>}
        <p className="real-help">GERAR CONTAS cria uma conta a receber por prazo da condição (em dias a partir de hoje), com a soma das vendas e notas fiscais escolhidas. Pedidos e notas ficam travados como os que têm contas lançadas; uma nota e o pedido de origem dela nunca entram juntos (a nota representa a venda). As NF-e de saída entram pelo período; os pedidos escolhidos na listagem de pedidos entram sozinhos.</p></>}
      {route.aba === 'gerados' && generated && <><div className="table-scroll" tabIndex={0} role="region" aria-label="Faturamentos gerados"><table className="data-table finance-table"><thead><tr>{writable && <th className="checkbox-cell"><span className="real-sr-only">Seleção</span></th>}<th>Cliente</th><th>Data</th><th>Itens</th><th>Condição</th><th>Contas</th><th className="numeric">Valor Total</th></tr></thead>
        <tbody>{generated.items.map(item => <tr key={item.id}>{writable && <td className="checkbox-cell"><input type="checkbox" aria-label={`Selecionar ${item.contact_name}`} checked={selected.includes(item.id)} disabled={Boolean(removal)} onChange={() => toggle(item.id)} /></td>}
          <td>{item.contact_name}</td><td>{financeDate(item.issued_on)}</td><td>{[...item.documents.map(document => `Venda nº ${document.number}`), ...(item.invoices ?? []).map(invoice => invoice.number ? `Nota Fiscal nº ${invoice.number}` : 'Nota Fiscal (sem número)')].join(', ')}</td><td>{item.condition}</td>
          <td>{item.titles.map(title => `${title.position}/${item.titles.length} ${financeDate(title.due_on)}`).join(' · ')}</td><td className="numeric">{financeMoney(item.total_cents)}</td></tr>)}</tbody></table></div>
        {!generated.items.length && <div className="empty-state"><h2>Ainda não existem Faturamentos agrupados</h2></div>}</>}
      {(candidates || generated) && total > GROUPED_PAGE_SIZE && <footer className="table-footer real-pagination finance-pagination"><OriginPagination page={Math.min(route.page, pages)} pages={pages} size={GROUPED_PAGE_SIZE} total={total} onPage={target => { if (!loading && target !== route.page) go({ page: target, q: route.q }); }} /></footer>}
    </NativeListLayout></form>}
    {modalVisible && <DocumentsModal contact={modalVisible.contact} load={() => loadDocuments(modalVisible.contact)} initial={chosenDocs[modalVisible.contact.contact_id] ?? null} onClose={() => setModal(null)}
      onOk={chosen => { setDocuments(previous => ({ key: listKey, values: { ...(previous.key === listKey ? previous.values : {}), [modalVisible.contact.contact_id]: chosen } })); setModal(null); }} />}
    {removal && <BatchDialog title={removal.recovery ? 'Conferir resultado' : 'Excluir selecionados'} description={<p className="real-help">Cada faturamento sem baixa nem boleto tem as contas canceladas e os pedidos voltam a ser faturáveis.</p>} plan={removal.plan}
      confirmLabel={removal.recovery ? 'Conferir resultado' : 'Excluir'} canConfirm={writable} run={sendDelete} onClose={finishDelete} progressLabel={(at, count) => `Excluindo, ${at} de ${count}…`} />}
  </>;
}

/** Itens of a cliente: "N Venda(s)" and "N Nota(s) Fiscal(is)" (SQL 247), with how many are chosen once the selection was read. */
function itemsLabel(row: GroupedCandidate, chosen: GroupedDocument[] | null): string {
  const notes = row.invoices ?? 0, sales = row.documents;
  const part = (count: number, one: string, many: string, picked: number | null) => `${picked === null ? count : `${picked} de ${count}`} ${count === 1 ? one : many}`;
  const pickedSales = chosen ? chosen.filter(item => item.kind !== 'fiscal_invoices').length : null, pickedNotes = chosen ? chosen.filter(item => item.kind === 'fiscal_invoices').length : null;
  return [...(sales ? [part(sales, 'Venda', 'Venda(s)', pickedSales)] : []), ...(notes ? [part(notes, 'Nota Fiscal', 'Nota(s) Fiscal(is)', pickedNotes)] : [])].join(' · ');
}
/** Seleção de notas fiscais e vendas: as vendas e as notas do cliente, ☐ todos, Item (Nota Fiscal nº / Venda nº) | Data | Valor e o rodapé N item(s) · Total. */
function DocumentsModal({ contact, load, initial, onClose, onOk }: { contact: GroupedCandidate; load: () => Promise<Chosen>; initial: Chosen | null; onClose: () => void; onOk: (chosen: Chosen) => void }) {
  const [state, setState] = useState<{ value: Chosen | null; error: string }>({ value: initial, error: '' });
  useEffect(() => { if (initial) return; let alive = true; void load().then(value => { if (alive) setState({ value, error: '' }); }).catch(failure => { if (alive) setState({ value: null, error: failureText(failure) }); }); return () => { alive = false; }; }, []);
  // ☐ todos picks every item but the pedidos whose note is listed (a note and its pedido are one sale).
  const value = state.value, chosen = value ? value.items.filter(item => value.chosen.includes(item.id)) : [], defaults = value ? groupedDefaultChoice(value.items) : [];
  const all = Boolean(value && defaults.length && chosen.length === defaults.length && defaults.every(id => value.chosen.includes(id)));
  const set = (ids: string[]) => setState(previous => previous.value ? { ...previous, value: { ...previous.value, chosen: ids } } : previous);
  const linked = value ? new Set(value.items.flatMap(item => item.kind === 'fiscal_invoices' ? item.orders ?? [] : [])) : new Set<string>();
  return <Modal title="Seleção de notas fiscais e vendas" onClose={onClose} actions={<button type="button" className="primary-button" disabled={!value} onClick={() => { if (value) onOk(value); }}>Ok</button>}>
    <p><strong>{contact.contact_name}</strong></p>
    {state.error ? <p className="real-alert" role="alert">{state.error}</p> : !value ? <p role="status">Carregando vendas e notas fiscais…</p> : <>
      <table className="data-table finance-table"><thead><tr><th className="checkbox-cell"><input type="checkbox" aria-label="Selecionar todos" checked={all} onChange={() => set(all ? [] : defaults)} /></th><th>Item</th><th>Data</th><th className="numeric">Valor</th></tr></thead>
        <tbody>{value.items.map(item => <tr key={item.id}><td className="checkbox-cell"><input type="checkbox" aria-label={`Selecionar ${groupedItemLabel(item).toLowerCase()}`} checked={value.chosen.includes(item.id)} onChange={() => set(groupedToggle(value.items, value.chosen, item.id))} /></td>
          <td>{groupedItemLabel(item)}{linked.has(item.id) ? <small className="real-help"> · tem nota fiscal na lista</small> : null}</td><td>{financeDate(item.date)}</td><td className="numeric">{financeMoney(item.total_cents)}</td></tr>)}</tbody></table>
      <p className="real-help">{chosen.length} item(s) · Total {financeMoney(sumCents(chosen.map(item => item.total_cents)))}{value.total > value.items.length ? ` · mostrando os ${value.items.length} primeiros de ${value.total}` : ''}</p></>}
  </Modal>;
}
