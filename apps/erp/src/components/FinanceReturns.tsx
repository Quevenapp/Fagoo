import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { financeLinkActor } from '../lib/document-finance-link';
import { financeDate, financeMoney, type FinanceAccess, financePermitted } from '../lib/real-finance-model';
// The import moment is a timestamp: its day is the São Paulo one, never the UTC prefix.
import { attachmentDay as saoPauloDay } from '../lib/attachment-model';
import { CNAB_LIST_PAGE, RETURN_GROUP_PAGE, cnabListApiPath, cnabListParams, cnabListRoute, occurrenceLabel, returnDetail, returnNumberLabel, returnPage, type CnabListPage, type CnabListRoute, type ReturnDetail, type ReturnGroup, type ReturnRow } from '../lib/finance-cnab-lists-model';
import { planBatch, type BatchItem, type BatchResult } from '../lib/origin-batch';
import NativeListLayout from './NativeListLayout';
import { BatchDialog } from './BatchDialog';
import { ToolButton } from './OriginList';
import StockPrintPreview from './StockPrintPreview';
import { Icon } from './Icon';
import './real-finance.css';
import './finance-reports.css';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const noSubscription = () => () => {}, noSnapshot = () => null;
const failureText = (error: unknown) => error instanceof AccessError ? error.status === 403 ? 'Seu perfil não consulta a cobrança.' : error.status === 404 ? 'O retorno não foi encontrado. Atualize a listagem.'
  : error.status === 409 ? 'O retorno tem ocorrência aplicada (vínculo ou baixa) e continua na listagem.' : error.status === 400 ? 'Confira a pesquisa e o período.' : 'Não foi possível consultar os retornos. Tente novamente.' : error instanceof Error ? error.message : 'Não foi possível consultar os retornos.';
const GROUPS: readonly { id: ReturnGroup; label: string }[] = [{ id: 'entradas', label: 'Detalhe das entradas' }, { id: 'baixas', label: 'Detalhe das baixas' }, { id: 'outras', label: 'Outras ocorrências' }];
const optionalDate = (value: string | null) => value ? financeDate(value) : '—';
type Item = BatchItem & { row: ReturnRow };

function Summary({ detail }: { detail: ReturnDetail }) {
  const s = detail.summary, money = (key: string) => financeMoney(String(s[key] ?? '0'));
  return <dl className="native-list-stat finance-report-summary">{([['Total de títulos lidos', String(s.titles)], ['Valor total dos títulos lidos', money('amount_cents')], ['Valor total com acréscimos', money('amount_with_additions_cents')],
    ['Confirmações de entrada', String(s.entries)], ['Valor total das entradas', money('entries_cents')], ['Total de Baixas', String(s.settlements)], ['Valor total das baixas', money('settlements_cents')],
    ['Valor Total dos juros', money('interest_cents')], ['Valor Total dos descontos', money('discount_cents')], ['Valor Total das tarifas', money('fee_cents')]] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
function EventsTable({ detail, group }: { detail: ReturnDetail; group: ReturnGroup }) {
  return <table className="data-table finance-report-table"><thead><tr><th>Seu nº</th><th>Nosso número</th><th>Descrição</th><th>{group === 'baixas' ? 'Pagamento' : 'Emissão'}</th><th>Vencimento</th><th>{group === 'outras' ? 'Observações' : 'Cliente'}</th><th className="numeric">Tarifas</th><th className="numeric">Juros</th><th className="numeric">Valor Título</th></tr></thead>
    <tbody>{detail.items.map(item => <tr key={item.line}><td>{item.document_number ?? '—'}</td><td>{item.our_number ?? '—'}</td><td>{occurrenceLabel(item.kind)}{item.occurrence ? ` (${item.occurrence})` : ''}{item.duplicate ? ' · repetida' : ''}</td>
      <td>{optionalDate(item.occurrence_date)}</td><td>{optionalDate(item.due_date)}</td><td>{group === 'outras' ? `Linha ${item.line}${item.contact_name ? ` · ${item.contact_name}` : ''}` : item.contact_name ?? '—'}</td>
      <td className="numeric">{financeMoney(item.fee_cents)}</td><td className="numeric">{financeMoney(item.interest_cents)}</td><td className="numeric">{financeMoney(item.amount_cents)}</td></tr>)}</tbody></table>;
}

/**
 * Financeiro > Retornos (Origin retornos.php): Data, Nome (arquivo .RET), Banco, Nro Títulos e Valor Títulos, Pesquisar e período, Quantidade de
 * retornos, o detalhe com Dados do retorno, Resumo do processamento e as Entradas, Baixas e Outras ocorrências, e "Excluir selecionados"
 * (só retornos sem ocorrência aplicada; o arquivo fica como evidência). A leitura e a conferência continuam nos retornos operacionais.
 */
export default function FinanceReturns({ controller }: { controller: AccessController }) {
  const location = useLocation(), navigate = useNavigate();
  let parsed: { route: CnabListRoute; error: string };
  try { parsed = { route: cnabListRoute('retornos', new URLSearchParams(location.search)), error: '' }; } catch (failure) { parsed = { route: { q: '', from: '', to: '', page: 1, id: null, group: 'baixas' }, error: (failure as Error).message }; }
  const route = parsed.route;
  const tracked = typeof controller.getSnapshot === 'function', session = useSyncExternalStore(controller.subscribe ?? noSubscription, controller.getSnapshot ?? noSnapshot);
  const actor = financeLinkActor(session), allowed = !tracked || actor !== null, scope = tracked ? `${actor ?? ''}:${session?.phase ?? ''}:${session?.membership?.role ?? ''}` : 'isolated';
  const key = `${location.search}:${scope}`, current = useRef(key); current.current = key;
  const [access, setAccess] = useState<{ scope: string; value: FinanceAccess } | null>(null), writable = access?.scope === scope && access.value.write && financePermitted(access.value, 'financas.retornos.ex');
  // Sistema › Usuários › Permissões › Finanças (SQL 246): the server refuses without the key; the screen does not offer it.
  const includable = access?.scope === scope && access.value.write && financePermitted(access.value, 'financas.retornos.ie');
  const [reload, setReload] = useState(0), loadKey = `${key}:${reload}`;
  const [data, setData] = useState<{ key: string; page: CnabListPage<ReturnRow> | null; detail: ReturnDetail | null; error: string }>({ key: '', page: null, detail: null, error: '' });
  const page = data.key === loadKey ? data.page : null, detail = data.key === loadKey ? data.detail : null, error = data.key === loadKey ? data.error : '', loading = !parsed.error && allowed && data.key !== loadKey;
  const [draft, setDraft] = useState({ q: route.q, from: route.from, to: route.to }), [selected, setSelected] = useState<string[]>([]), [printing, setPrinting] = useState(false);
  const [batch, setBatch] = useState<{ key: string; items: Item[] } | null>(null), commands = useRef(new Map<string, string>());
  const mayWrite = () => allowed && current.current === key && writable && (!tracked || ['admin', 'financeiro'].includes(controller.getSnapshot()?.membership?.role ?? ''));
  useEffect(() => { setDraft({ q: route.q, from: route.from, to: route.to }); setSelected([]); setPrinting(false); setBatch(null); }, [location.search]);
  useEffect(() => {
    if (!allowed) return; const request = new AbortController();
    void controller.finance('/v1/financeiro', { signal: request.signal }).then(value => { if (!request.signal.aborted) setAccess({ scope, value: value as FinanceAccess }); }).catch(() => { /* Read only until confirmed. */ });
    return () => request.abort();
  }, [controller, scope]);
  useEffect(() => {
    if (parsed.error || !allowed) return; const request = new AbortController(), mine = loadKey;
    void controller.finance(cnabListApiPath('retornos', route), { signal: request.signal }).then(value => {
      if (request.signal.aborted || current.current !== key) return;
      setData(route.id ? { key: mine, page: null, detail: returnDetail(value, route.id), error: '' } : { key: mine, page: returnPage(value), detail: null, error: '' });
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure) && current.current === key) setData({ key: mine, page: null, detail: null, error: failureText(failure) }); });
    return () => request.abort();
  }, [controller, loadKey]);
  const go = (next: CnabListRoute) => { try { const search = `?${cnabListParams('retornos', next)}`; if (search === location.search) setReload(value => value + 1); else navigate(`${location.pathname}${search}`); } catch { /* The route stays as it is. */ } };
  const apply = (event: FormEvent) => { event.preventDefault(); go({ ...route, q: draft.q.trim(), from: draft.from, to: draft.to, page: 1, id: null }); };
  const startExclusion = (rows: ReturnRow[]) => { if (!mayWrite() || !rows.length) return; setBatch({ key: loadKey, items: rows.map(row => ({ id: row.id, label: `${row.filename} · ${financeDate(row.generated_on)}`, row })) }); };
  const runExclusion = async (item: Item) => {
    if (!mayWrite()) throw new Error('Seu acesso a esta operação foi alterado.');
    let command = commands.current.get(item.id); if (!command) { command = crypto.randomUUID(); commands.current.set(item.id, command); }
    try { await controller.finance('/v1/financeiro/actions/return_exclude', { method: 'POST', body: { command_id: command, data: { id: item.row.id } } }); commands.current.delete(item.id); }
    catch (failure) {
      if (failure instanceof AccessError && [400, 403, 404, 409].includes(failure.status)) { commands.current.delete(item.id); throw new Error(failureText(failure)); }
      return { uncertain: true, message: 'Resultado não confirmado. Abra a exclusão de novo para conferir com o mesmo comando.' };
    }
  };
  const finish = (results: BatchResult[] | null) => { setBatch(null); if (results) { setSelected([]); if (detail && results.some(result => result.outcome === 'ok')) go({ ...route, id: null, page: 1 }); else setReload(value => value + 1); } };
  const batchVisible = batch && batch.key === loadKey ? batch : null;
  const plan = batchVisible ? planBatch(batchVisible.items, ({ row }) => row.excludable ? null : 'Retorno com ocorrência aplicada (vínculo ou baixa) fica na listagem como evidência.') : null;
  const rows = page?.items ?? [], pages = page ? Math.max(1, Math.ceil(page.total / CNAB_LIST_PAGE)) : 1, allSelected = rows.length > 0 && rows.every(row => selected.includes(row.id));
  const exclusionDialog = batchVisible && plan && <BatchDialog title="Excluir retornos" description={<p>O retorno sai da listagem. O arquivo e as ocorrências ficam guardados como evidência; retornos com ocorrência aplicada não são excluídos.</p>} plan={plan} confirmLabel="Excluir" canConfirm={writable} run={runExclusion} onClose={finish} />;
  if (!allowed) return <section className="real-state-panel"><h1>Retornos indisponíveis</h1><p>Confirme sua sessão e seu acesso ao financeiro para continuar.</p></section>;
  if (route.id) {
    const groupPages = detail ? Math.max(1, Math.ceil(detail.total / RETURN_GROUP_PAGE)) : 1;
    return <section className="finance-return-detail">
      <header className="real-heading"><div><h1>Retorno</h1><p className="real-help">Somente consulta. A leitura e a conferência das ocorrências ficam nos retornos operacionais.</p></div><div className="real-editor-actions">
        <button type="button" className="secondary-button" onClick={() => go({ ...route, id: null, page: 1, group: 'baixas' })}>Voltar</button>
        <button type="button" className="secondary-button" disabled={!detail} onClick={() => setPrinting(true)}><Icon name="print" size={14} />Imprimir resumo do processamento do retorno</button>
        {writable && detail?.record.excludable && <button type="button" className="danger-button" onClick={() => startExclusion([{ ...detail.record, titles: Number(detail.summary.titles), total_cents: String(detail.summary.amount_cents) }])}>Excluir</button>}</div></header>
      {(parsed.error || error) && <p className="real-alert" role="alert">{parsed.error || error}</p>}
      {loading ? <p role="status">Consultando o retorno…</p> : detail && <>
        <h2>Dados do retorno</h2><dl className="finance-review"><div><dt>Banco</dt><dd>{[detail.record.bank, detail.record.bank_name].filter(Boolean).join(' - ') || '—'}</dd></div><div><dt>Arquivo</dt><dd>{detail.record.filename}</dd></div><div><dt>Número</dt><dd>{returnNumberLabel(detail.record.number)}</dd></div>
          <div><dt>Data do arquivo</dt><dd>{financeDate(detail.record.generated_on)}</dd></div><div><dt>Data de importação</dt><dd>{saoPauloDay(detail.record.created_at)}</dd></div></dl>
        <h2>Resumo do processamento</h2><Summary detail={detail} />
        <nav className="finance-report-tabs" aria-label="Ocorrências do retorno">{GROUPS.map(item => <button key={item.id} type="button" aria-current={route.group === item.id ? 'page' : undefined} onClick={() => go({ ...route, group: item.id, page: 1 })}>{item.label}</button>)}</nav>
        {detail.items.length ? <div className="table-scroll" tabIndex={0} role="region" aria-label={GROUPS.find(item => item.id === route.group)!.label}><EventsTable detail={detail} group={route.group} /></div> : <p className="real-help">Nenhuma ocorrência neste grupo.</p>}
        {groupPages > 1 && <footer className="table-footer real-pagination"><span>Página {route.page} de {groupPages}</span><div className="pagination">
          <button type="button" className="secondary-button" disabled={route.page <= 1} onClick={() => go({ ...route, page: route.page - 1 })}>Anterior</button>
          <button type="button" className="secondary-button" disabled={route.page >= groupPages} onClick={() => go({ ...route, page: route.page + 1 })}>Próxima</button></div></footer>}
      </>}
      {printing && detail && <StockPrintPreview title="Resumo do processamento do retorno" onClose={() => setPrinting(false)}><h1>Retorno · {detail.record.filename}</h1>
        <p>{detail.record.bank_name ?? ''} · arquivo de {financeDate(detail.record.generated_on)} · importado em {saoPauloDay(detail.record.created_at)}</p><Summary detail={detail} />
        <h2>{GROUPS.find(item => item.id === route.group)!.label}</h2><EventsTable detail={detail} group={route.group} /></StockPrintPreview>}
      {exclusionDialog}
    </section>;
  }
  return <section className="finance-returns">
    <header className="real-heading"><div><h1>Retornos</h1><p className="real-help">Arquivos .RET lidos pelo FAGOO. Nenhuma baixa é feita automaticamente: as ocorrências são conferidas nos retornos operacionais.</p></div></header>
    {(parsed.error || error) && <p className="real-alert" role="alert">{parsed.error || error}</p>}
    <NativeListLayout filters={<form onSubmit={apply} aria-label="Filtros dos retornos">
      <div className="form-field"><label htmlFor="return-search">Pesquisar</label><input id="return-search" type="search" maxLength={120} placeholder="Pesquisar" value={draft.q} onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, q: value })); }} /></div>
      <div className="form-field"><label htmlFor="return-from">De</label><input id="return-from" type="date" min="1900-01-01" max="2100-12-31" value={draft.from} onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, from: value })); }} /></div>
      <div className="form-field"><label htmlFor="return-to">Até</label><input id="return-to" type="date" min="1900-01-01" max="2100-12-31" value={draft.to} onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, to: value })); }} /></div>
      <button type="submit" className="primary-button">Filtrar</button><button type="button" className="text-button" onClick={() => go({ q: '', from: '', to: '', page: 1, id: null, group: 'baixas' })}>Limpar filtros</button>
      <p className="real-help">O período usa a data do arquivo.</p></form>}
      actions={<>
        {includable && <Link className="primary-button" to="/retornos-operacionais"><Icon name="plus" size={16} />Incluir Retorno</Link>}
        <Link className="action-button" to="/financeiro-empresa?area=remessas"><Icon name="circle-right" size={16} />Ver remessas</Link>
        <hr /><div className="native-list-summary"><h3>Informações</h3><dl className="native-list-stat"><dt>Quantidade de retornos</dt><dd>{page ? page.total : '—'}</dd></dl></div>
        <p className="real-help">“Incluir Retorno” abre os retornos operacionais, onde o arquivo do banco é lido e cada ocorrência é conferida.</p>
      </>}>
      <div className="cnab-toolbar finance-cnab-toolbar"><label htmlFor="return-all" className="finance-select-all"><input id="return-all" type="checkbox" checked={allSelected} disabled={!writable || !rows.length} onChange={event => setSelected(event.target.checked ? rows.map(row => row.id) : [])} />Selecionar todos</label>
        {writable && <button type="button" className="secondary-button" disabled={!selected.length || Boolean(batchVisible)} onClick={() => startExclusion(rows.filter(row => selected.includes(row.id)))}><Icon name="trash-can" size={14} />Excluir selecionados</button>}
        <ToolButton icon="rotate-right" title="Recarregar" disabled={loading} onClick={() => setReload(value => value + 1)} /></div>
      {loading ? <p role="status">Consultando retornos…</p> : !rows.length ? <div className="empty-state"><h2>Nenhum retorno</h2><p>Ajuste a pesquisa ou o período.</p></div>
        : <div className="table-scroll" tabIndex={0} role="region" aria-label="Retornos"><table className="data-table finance-report-table"><thead><tr><th><span className="real-sr-only">Selecionar</span></th><th>Data</th><th>Nome (arquivo .RET)</th><th>Banco</th><th className="numeric">Nº Retorno</th><th className="numeric">Nro Títulos</th><th className="numeric">Valor Títulos</th></tr></thead>
          <tbody>{rows.map(row => <tr key={row.id} className="finance-row" onClick={() => go({ ...route, id: row.id, page: 1, group: 'baixas' })}>
            <td onClick={event => event.stopPropagation()}><input type="checkbox" aria-label={`Selecionar ${row.filename}`} disabled={!writable} checked={selected.includes(row.id)} onChange={event => { const checked = event.target.checked; setSelected(previous => checked ? [...previous, row.id] : previous.filter(id => id !== row.id)); }} /></td>
            <td>{financeDate(row.generated_on)}</td><td>{row.filename}{row.purpose === 'homologation' ? <small className="real-help"> · Homologação</small> : null}</td><td>{row.bank_name ?? row.bank ?? '—'}</td><td className="numeric">{returnNumberLabel(row.number)}</td><td className="numeric">{row.titles}</td><td className="numeric">{financeMoney(row.total_cents)}</td>
          </tr>)}</tbody></table></div>}
      {page && pages > 1 && <footer className="table-footer real-pagination"><span>Página {route.page} de {pages} · {page.total} retorno(s)</span><div className="pagination">
        <button type="button" className="secondary-button" disabled={route.page <= 1} onClick={() => go({ ...route, page: route.page - 1 })}>Anterior</button>
        <button type="button" className="secondary-button" disabled={route.page >= pages} onClick={() => go({ ...route, page: route.page + 1 })}>Próxima</button></div></footer>}
    </NativeListLayout>
    {exclusionDialog}
  </section>;
}
