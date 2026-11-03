import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { financeLinkActor } from '../lib/document-finance-link';
import { financeDate, financeMoney, type FinanceAccess, financePermitted } from '../lib/real-finance-model';
import { cnabFileBytes, cnabHash } from '../lib/real-cnab-model';
import { CNAB_LIST_PAGE, cnabListApiPath, cnabListParams, cnabListRoute, remittanceDetail, remittancePage, type CnabListPage, type CnabListRoute, type RemittanceDetail, type RemittanceRow } from '../lib/finance-cnab-lists-model';
import { planBatch, type BatchItem, type BatchResult } from '../lib/origin-batch';
import { badgeClass } from '../lib/origin-list';
import NativeListLayout from './NativeListLayout';
import { BatchDialog } from './BatchDialog';
import { ToolButton } from './OriginList';
import StockPrintPreview from './StockPrintPreview';
import { Icon } from './Icon';
import './real-finance.css';
import './finance-reports.css';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const noSubscription = () => () => {}, noSnapshot = () => null;
const failureText = (error: unknown) => error instanceof AccessError ? error.status === 403 ? 'Seu perfil não consulta a cobrança.' : error.status === 404 ? 'A remessa não foi encontrada. Atualize a listagem.'
  : error.status === 409 ? 'A remessa mudou, já tem arquivo ou já foi excluída. Atualize a listagem.' : error.status === 400 ? 'Confira a pesquisa e o período.' : 'Não foi possível consultar as remessas. Tente novamente.' : error instanceof Error ? error.message : 'Não foi possível consultar as remessas.';
const stateLabel = (row: Pick<RemittanceRow, 'state'>) => row.state === 'ready' ? 'Gerada' : 'Em preparação';
type Item = BatchItem & { row: RemittanceRow };

function TitlesTable({ detail }: { detail: RemittanceDetail }) {
  return <table className="data-table finance-report-table"><thead><tr><th>Cliente</th><th>Nro. no Banco</th><th>Nro. documento</th><th>Emissão</th><th>Vencimento</th><th>Histórico</th><th className="numeric">Valor</th></tr></thead>
    <tbody>{detail.titles.map(item => <tr key={item.billing_title_id}><td>{item.contact_name}</td><td>{item.our_number ?? '—'}</td><td>{item.document_number}</td><td>{financeDate(item.issued_on)}</td><td>{financeDate(item.due_on)}</td><td>{item.description}</td><td className="numeric">{financeMoney(item.amount_cents)}</td></tr>)}</tbody></table>;
}

/**
 * Financeiro > Remessas (Origin remessas.php): Data, Nome (arquivo), Banco, Nº Remessa, Nro Títulos e Valor Títulos, Pesquisar e período,
 * Quantidade de remessas, o detalhe com os Títulos da remessa, Dados da Conta e Informações, Imprimir lista de títulos da remessa e
 * "Excluir as remessas selecionadas" (só reservas sem arquivo). A geração e o envio continuam na cobrança Itaú, sem contato com o banco.
 */
export default function FinanceRemittances({ controller }: { controller: AccessController }) {
  const location = useLocation(), navigate = useNavigate();
  let parsed: { route: CnabListRoute; error: string };
  try { parsed = { route: cnabListRoute('remessas', new URLSearchParams(location.search)), error: '' }; } catch (failure) { parsed = { route: { q: '', from: '', to: '', page: 1, id: null, group: 'baixas' }, error: (failure as Error).message }; }
  const route = parsed.route;
  const tracked = typeof controller.getSnapshot === 'function', session = useSyncExternalStore(controller.subscribe ?? noSubscription, controller.getSnapshot ?? noSnapshot);
  const actor = financeLinkActor(session), allowed = !tracked || actor !== null, scope = tracked ? `${actor ?? ''}:${session?.phase ?? ''}:${session?.membership?.role ?? ''}` : 'isolated';
  const key = `${location.search}:${scope}`, current = useRef(key); current.current = key;
  const [access, setAccess] = useState<{ scope: string; value: FinanceAccess } | null>(null), writable = access?.scope === scope && access.value.write && financePermitted(access.value, 'financas.remessas.ex');
  // Sistema › Usuários › Permissões › Finanças (SQL 246): the server refuses without the key; the screen does not offer it.
  const includable = access?.scope === scope && access.value.write && financePermitted(access.value, 'financas.remessas.ie');
  const [reload, setReload] = useState(0), loadKey = `${key}:${reload}`;
  const [data, setData] = useState<{ key: string; page: CnabListPage<RemittanceRow> | null; detail: RemittanceDetail | null; error: string }>({ key: '', page: null, detail: null, error: '' });
  const page = data.key === loadKey ? data.page : null, detail = data.key === loadKey ? data.detail : null, error = data.key === loadKey ? data.error : '', loading = !parsed.error && allowed && data.key !== loadKey;
  const [draft, setDraft] = useState({ q: route.q, from: route.from, to: route.to }), [selected, setSelected] = useState<string[]>([]), [notice, setNotice] = useState(''), [printing, setPrinting] = useState(false), [busy, setBusy] = useState('');
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
    void controller.finance(cnabListApiPath('remessas', route), { signal: request.signal }).then(value => {
      if (request.signal.aborted || current.current !== key) return;
      setData(route.id ? { key: mine, page: null, detail: remittanceDetail(value, route.id), error: '' } : { key: mine, page: remittancePage(value), detail: null, error: '' });
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure) && current.current === key) setData({ key: mine, page: null, detail: null, error: failureText(failure) }); });
    return () => request.abort();
  }, [controller, loadKey]);
  const go = (next: CnabListRoute) => { try { const search = `?${cnabListParams('remessas', next)}`; if (search === location.search) setReload(value => value + 1); else navigate(`${location.pathname}${search}`); } catch (failure) { setNotice((failure as Error).message); } };
  const apply = (event: FormEvent) => { event.preventDefault(); go({ ...route, q: draft.q.trim(), from: draft.from, to: draft.to, page: 1, id: null }); };
  const download = async (row: Pick<RemittanceRow, 'id' | 'state' | 'purpose' | 'encoding_profile' | 'file_hash' | 'byte_size' | 'filename'>) => {
    if (busy || row.state !== 'ready' || row.purpose !== 'operational' || !row.file_hash) return; setBusy('Baixando arquivo…'); setNotice('');
    try {
      const blob = row.encoding_profile === null ? await controller.cnabOperationalDownload(`/v1/cobranca-operacional/files/remittance/${row.id}`) : await controller.cnabOperationalV2Download(`/v1/cobranca-operacional-v2/files/remittance/${row.id}`);
      const bytes = await cnabFileBytes(blob);
      if (bytes.length !== row.byte_size || await cnabHash(bytes) !== row.file_hash) throw new Error('O arquivo recebido difere da remessa listada. Atualize a consulta.');
      if (current.current !== key) return;
      const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = row.filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { if (current.current === key) setNotice(failureText(failure)); }
    finally { setBusy(''); }
  };
  const startExclusion = (rows: RemittanceRow[]) => { if (!mayWrite() || !rows.length) return; setNotice(''); setBatch({ key: loadKey, items: rows.map(row => ({ id: row.id, label: `${row.filename} · ${row.titles} título(s)`, row })) }); };
  const runExclusion = async (item: Item) => {
    if (!mayWrite()) throw new Error('Seu acesso a esta operação foi alterado.');
    let command = commands.current.get(item.id); if (!command) { command = crypto.randomUUID(); commands.current.set(item.id, command); }
    try { await controller.finance('/v1/financeiro/actions/remittance_exclude', { method: 'POST', body: { command_id: command, data: { id: item.row.id, sequence: item.row.sequence } } }); commands.current.delete(item.id); }
    catch (failure) {
      if (failure instanceof AccessError && [400, 403, 404, 409].includes(failure.status)) { commands.current.delete(item.id); throw new Error(failureText(failure)); }
      return { uncertain: true, message: 'Resultado não confirmado. Abra a exclusão de novo para conferir com o mesmo comando.' };
    }
  };
  const finish = (results: BatchResult[] | null) => { setBatch(null); if (results) { setSelected([]); setReload(value => value + 1); if (detail && results.some(result => result.outcome === 'ok')) go({ ...route, id: null, page: 1 }); } };
  const batchVisible = batch && batch.key === loadKey ? batch : null;
  const plan = batchVisible ? planBatch(batchVisible.items, ({ row }) => row.excludable ? null : 'Remessa com arquivo gerado não é excluída: o banco pode tê-la registrado.') : null;
  const rows = page?.items ?? [], pages = page ? Math.max(1, Math.ceil(page.total / CNAB_LIST_PAGE)) : 1, allSelected = rows.length > 0 && rows.every(row => selected.includes(row.id));
  if (!allowed) return <section className="real-state-panel"><h1>Remessas indisponíveis</h1><p>Confirme sua sessão e seu acesso ao financeiro para continuar.</p></section>;
  const guide = <p className="real-help">O FAGOO prepara o arquivo para envio manual ao banco; não o transmite nem registra baixas.</p>;
  if (route.id) return <section className="finance-remittance-detail">
    <header className="real-heading"><div><h1>Remessa {detail ? `nº ${detail.record.sequence}` : ''}</h1>{guide}</div><div className="real-editor-actions">
      <button type="button" className="secondary-button" onClick={() => go({ ...route, id: null, page: 1 })}>Voltar</button>
      <button type="button" className="secondary-button" disabled={!detail} onClick={() => setPrinting(true)}><Icon name="print" size={14} />Imprimir lista de títulos da remessa</button>
      {detail?.record.state === 'ready' && detail.record.purpose === 'operational' && <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void download(detail.record)}><Icon name="download" size={14} />Baixar arquivo</button>}
      {writable && detail?.record.excludable && <button type="button" className="danger-button" onClick={() => startExclusion([{ ...detail.record, titles: detail.titles_total, total_cents: detail.total_cents }])}>Excluir</button>}</div></header>
    {(parsed.error || error || notice) && <p className="real-alert" role="alert">{parsed.error || error || notice}</p>}
    {loading ? <p role="status">Consultando a remessa…</p> : detail && <div className="finance-remittance-body">
      <dl className="finance-review"><div><dt>Data da remessa</dt><dd>{financeDate(detail.record.generated_on)}</dd></div><div><dt>Número da remessa</dt><dd>{detail.record.sequence}</dd></div><div><dt>Nome do arquivo</dt><dd>{detail.record.filename}</dd></div>
        <div><dt>Situação</dt><dd><span className={badgeClass(stateLabel(detail.record))}>{stateLabel(detail.record)}</span>{detail.record.purpose === 'homologation' ? ' · Homologação' : ''}</dd></div></dl>
      <aside className="finance-remittance-side" aria-label="Dados da conta e informações"><h2>Dados da Conta</h2><dl className="finance-review"><div><dt>Banco</dt><dd>{[detail.account.bank, detail.account.bank_name].filter(Boolean).join(' - ') || '—'}</dd></div><div><dt>Agência</dt><dd>{detail.account.agency ?? '—'}</dd></div>
        <div><dt>Conta</dt><dd>{detail.account.account ? `${detail.account.account}${detail.account.account_digit ? `-${detail.account.account_digit}` : ''}` : '—'}</dd></div>{detail.account.name && <div><dt>Conta financeira</dt><dd>{detail.account.name}</dd></div>}</dl>
        <h2>Informações da Remessa</h2><dl className="finance-review"><div><dt>Número de títulos</dt><dd>{detail.titles_total}</dd></div><div><dt>Valor total dos títulos</dt><dd>{financeMoney(detail.total_cents)}</dd></div></dl></aside>
      <h2>Títulos da remessa</h2>
      {detail.titles.length ? <div className="table-scroll" tabIndex={0} role="region" aria-label="Títulos da remessa"><TitlesTable detail={detail} /></div> : <p className="real-help">Nenhum título nesta remessa.</p>}
      {detail.titles_total > detail.titles.length && <p className="real-help">Mostrando {detail.titles.length} de {detail.titles_total} títulos.</p>}
    </div>}
    {printing && detail && <StockPrintPreview title="Títulos da remessa" onClose={() => setPrinting(false)}><h1>Remessa nº {detail.record.sequence} · {detail.record.filename}</h1>
      <p>{financeDate(detail.record.generated_on)} · {detail.account.bank_name ?? ''} agência {detail.account.agency ?? '—'} conta {detail.account.account ?? '—'}{detail.account.account_digit ? `-${detail.account.account_digit}` : ''} · {detail.titles_total} título(s) · {financeMoney(detail.total_cents)}</p><TitlesTable detail={detail} /></StockPrintPreview>}
    {batchVisible && plan && <BatchDialog title="Excluir remessa" description={<p>A reserva é excluída e os títulos voltam a ficar livres para outra remessa. O registro da reserva fica guardado.</p>} plan={plan} confirmLabel="Excluir" canConfirm={writable} run={runExclusion} onClose={finish} />}
  </section>;
  return <section className="finance-remittances">
    <header className="real-heading"><div><h1>Remessas</h1>{guide}</div></header>
    {(parsed.error || error || notice) && <p className="real-alert" role="alert">{parsed.error || error || notice}</p>}
    <NativeListLayout filters={<form onSubmit={apply} aria-label="Filtros das remessas">
      <div className="form-field"><label htmlFor="remittance-search">Pesquisar</label><input id="remittance-search" type="search" maxLength={120} placeholder="Pesquisar" value={draft.q} onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, q: value })); }} /></div>
      <div className="form-field"><label htmlFor="remittance-from">De</label><input id="remittance-from" type="date" min="1900-01-01" max="2100-12-31" value={draft.from} onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, from: value })); }} /></div>
      <div className="form-field"><label htmlFor="remittance-to">Até</label><input id="remittance-to" type="date" min="1900-01-01" max="2100-12-31" value={draft.to} onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, to: value })); }} /></div>
      <button type="submit" className="primary-button">Filtrar</button><button type="button" className="text-button" onClick={() => go({ q: '', from: '', to: '', page: 1, id: null, group: 'baixas' })}>Limpar filtros</button>
      <p className="real-help">O período usa a data da remessa.</p></form>}
      actions={<>
        {includable && <Link className="primary-button" to="/cobranca-operacional"><Icon name="plus" size={16} />Incluir Remessa</Link>}
        <Link className="action-button" to="/financeiro-empresa?area=retornos"><Icon name="circle-left" size={16} />Ver retornos</Link>
        <Link className="action-button" to="/financeiro-empresa?area=contas-financeiras"><Icon name="building-columns" size={16} />Configurar contas</Link>
        <hr /><div className="native-list-summary"><h3>Informações</h3><dl className="native-list-stat"><dt>Quantidade de remessas</dt><dd>{page ? page.total : '—'}</dd></dl></div>
        <p className="real-help">“Incluir Remessa” abre a cobrança Itaú, onde a remessa é reservada e o arquivo é gerado para envio manual.</p>
      </>}>
      <div className="cnab-toolbar finance-cnab-toolbar"><label htmlFor="remittance-all" className="finance-select-all"><input id="remittance-all" type="checkbox" checked={allSelected} disabled={!writable || !rows.length} onChange={event => setSelected(event.target.checked ? rows.map(row => row.id) : [])} />Selecionar todos</label>
        {writable && <button type="button" className="secondary-button" disabled={!selected.length || Boolean(batchVisible)} onClick={() => startExclusion(rows.filter(row => selected.includes(row.id)))}><Icon name="trash-can" size={14} />Excluir as remessas selecionadas</button>}
        <ToolButton icon="rotate-right" title="Recarregar" disabled={loading} onClick={() => setReload(value => value + 1)} />{busy && <span role="status">{busy}</span>}</div>
      {loading ? <p role="status">Consultando remessas…</p> : !rows.length ? <div className="empty-state"><h2>Nenhuma remessa</h2><p>Ajuste a pesquisa ou o período.</p></div>
        : <div className="table-scroll" tabIndex={0} role="region" aria-label="Remessas"><table className="data-table finance-report-table"><thead><tr><th><span className="real-sr-only">Selecionar</span></th><th>Data</th><th>Nome (arquivo)</th><th>Banco</th><th>Nº Remessa</th><th className="numeric">Nro Títulos</th><th className="numeric">Valor Títulos</th><th>Situação</th><th><span className="real-sr-only">Arquivo</span></th></tr></thead>
          <tbody>{rows.map(row => <tr key={row.id} className="finance-row" onClick={() => go({ ...route, id: row.id, page: 1 })}>
            <td onClick={event => event.stopPropagation()}><input type="checkbox" aria-label={`Selecionar ${row.filename}`} disabled={!writable} checked={selected.includes(row.id)} onChange={event => { const checked = event.target.checked; setSelected(previous => checked ? [...previous, row.id] : previous.filter(id => id !== row.id)); }} /></td>
            <td>{financeDate(row.generated_on)}</td><td>{row.filename}</td><td>{row.bank_name ?? row.bank ?? '—'}</td><td>{row.sequence}</td><td className="numeric">{row.titles}</td><td className="numeric">{financeMoney(row.total_cents)}</td>
            <td><span className={badgeClass(stateLabel(row))}>{stateLabel(row)}</span>{row.purpose === 'homologation' ? <small className="real-help"> · Homologação</small> : null}</td>
            <td onClick={event => event.stopPropagation()}>{row.state === 'ready' && row.purpose === 'operational' && <button type="button" className="icon-button" title="Remessa com arquivo gerado (baixar arquivo)" aria-label={`Baixar ${row.filename}`} disabled={Boolean(busy)} onClick={() => void download(row)}><Icon name="download" size={14} /></button>}</td>
          </tr>)}</tbody></table></div>}
      {page && pages > 1 && <footer className="table-footer real-pagination"><span>Página {route.page} de {pages} · {page.total} remessa(s)</span><div className="pagination">
        <button type="button" className="secondary-button" disabled={route.page <= 1} onClick={() => go({ ...route, page: route.page - 1 })}>Anterior</button>
        <button type="button" className="secondary-button" disabled={route.page >= pages} onClick={() => go({ ...route, page: route.page + 1 })}>Próxima</button></div></footer>}
    </NativeListLayout>
    {batchVisible && plan && <BatchDialog title="Excluir as remessas selecionadas" description={<p>Somente remessas reservadas, ainda sem arquivo, são excluídas: os títulos voltam a ficar livres para outra remessa e o registro da reserva fica guardado.</p>} plan={plan} confirmLabel="Excluir" canConfirm={writable} run={runExclusion} onClose={finish} />}
  </section>;
}
