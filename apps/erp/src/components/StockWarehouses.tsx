import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChanges';
import { useUnsavedForm } from '../hooks/useUnsavedChanges';
import { AccessError, type AccessController } from '../lib/real-access';
import { DEFAULT_LABEL, IGNORE_INFO, IGNORE_LABEL, WAREHOUSE_PAGE_SIZE, WAREHOUSE_SEARCH, parseWarehousePage, parseWarehouseSave, warehouseSaveBody, warehousesPath, type StockWarehouse, type StockWarehouseFilters, type StockWarehousePage } from '../lib/stock-warehouses-model';
import { planBatch, type BatchItem } from '../lib/origin-batch';
import { AppliedChips, OriginActionsPanel, OriginFilterPanel, OriginListHeader, OriginPagination, OriginToolbar, RowMenu } from './OriginList';
import { BatchDialog } from './BatchDialog';
import { StockSidePanel, useStockCommand } from './StockMovementPanel';
import { Icon } from './Icon';
import './stock.css';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const readError = (error: unknown) => error instanceof AccessError && error.status === 403 ? 'Seu perfil não permite consultar os depósitos.' : 'Não foi possível consultar os depósitos. Tente novamente.';
const saveError = (error: unknown) => error instanceof AccessError ? error.status === 409 ? 'Erro ao salvar: o depósito foi alterado por outra operação. Feche o painel e abra de novo.' : error.status === 404 ? 'Depósito não encontrado.' : error.status === 403 ? 'Erro ao salvar: seu perfil não permite alterar depósitos.' : 'Erro ao salvar: confira a descrição.' : 'Erro ao salvar.';
const defaultError = (error: unknown) => error instanceof AccessError ? error.status === 409 ? 'Erro ao tornar depósito padrão: os depósitos foram alterados por outra operação. Recarregue a lista.' : error.status === 404 ? 'Depósito não encontrado.' : error.status === 400 ? 'Erro ao tornar depósito padrão: somente um depósito ativo pode ser o padrão.' : 'Erro ao tornar depósito padrão.' : 'Erro ao tornar depósito padrão.';

/** "Incluir depósito" / "Editar depósito": Descrição and the Desconsiderar saldo toggle, saved in one audited command. */
export function StockWarehousePanel({ controller, warehouse, writable, onClose, onSaved }: { controller: Pick<AccessController, 'stock'>; warehouse: StockWarehouse | null; writable: boolean; onClose: () => void; onSaved: (saved: StockWarehouse) => void }) {
  const [name, setName] = useState(warehouse?.name ?? ''), [ignore, setIgnore] = useState(warehouse?.ignore_balance ?? false);
  const command = useStockCommand(controller), guard = useUnsavedForm({ name, ignore }, command.busy || command.uncertain);
  const frozen = command.busy || command.uncertain, close = () => { if (!frozen) guard.confirmLeave(onClose); };
  const save = () => {
    if (command.busy || !writable) return;
    let body: Record<string, unknown> | null = null;
    if (!command.uncertain) { try { body = warehouseSaveBody(name, ignore, warehouse); } catch (problem) { command.setError((problem as Error).message); return; } }
    void command.run(warehouse ? `/v1/estoque/depositos/${warehouse.id}` : '/v1/estoque/depositos', warehouse ? 'PATCH' : 'POST', body, (value, sent) => parseWarehouseSave(value, sent, 'save'), result => onSaved(result.warehouse), saveError);
  };
  return <StockSidePanel title={warehouse ? 'Editar depósito' : 'Incluir depósito'} labelledBy="stock-warehouse-title" onClose={close} closeDisabled={frozen}
    footer={<><button type="button" className="secondary-button" disabled={frozen} onClick={close}>{writable ? 'Cancelar' : 'Fechar'}</button>{writable && <button type="button" className="primary-button" disabled={command.busy} onClick={save}>{command.busy ? 'Salvando…' : command.uncertain ? 'Conferir resultado' : 'Salvar'}</button>}</>}>
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
    <form className="stock-panel-form" onSubmit={event => { event.preventDefault(); save(); }}><fieldset disabled={frozen || !writable}><legend className="real-sr-only">Dados do depósito</legend>
      <div className="form-field real-field-wide"><label htmlFor="stock-warehouse-name">Descrição</label><input id="stock-warehouse-name" required maxLength={200} value={name} onChange={event => setName(event.target.value)} /></div>
      <div className="form-field real-field-wide stock-toggle-field"><label htmlFor="stock-warehouse-ignore"><input id="stock-warehouse-ignore" type="checkbox" role="switch" checked={ignore} onChange={event => setIgnore(event.target.checked)} />{IGNORE_LABEL} <span className="stock-info" title={IGNORE_INFO} aria-label={IGNORE_INFO}><Icon name="circle-info" size={11} /></span></label><small>{ignore ? 'Ativado' : 'Desativado'}</small></div>
    </fieldset></form>
    {warehouse?.is_default && <p className="real-help">Este é o depósito padrão: o extrato de estoque abre nele.</p>}
  </StockSidePanel>;
}

type Situation = { item: StockWarehouse & BatchItem; active: boolean };
/** Preferências > Suprimentos > Depósitos like Origin: Descrição with "Depósito padrão", ⋮ Inativar/Reativar/Tornar padrão. */
export default function StockWarehouses({ controller, onPrepareWarehouses }: { controller: AccessController; onPrepareWarehouses?: () => void }) {
  const snapshot = controller.getSnapshot(), role = snapshot.membership?.role, actor = snapshot.membership?.user_id;
  // 086 "Importar depósitos do Origin" stays here for administrador, with the same leave guard and role recheck as before.
  const navigationGuard = useUnsavedChangesGuard(), identity = useRef({ controller, actor }); identity.current = { controller, actor };
  const prepareWarehouses = () => { const allowed = () => identity.current.controller === controller && identity.current.actor === actor && controller.getSnapshot().phase === 'ready' && controller.getSnapshot().membership?.role === 'admin' && controller.getSnapshot().membership?.user_id === actor; if (allowed() && onPrepareWarehouses) navigationGuard.confirmLeave(() => { if (allowed()) onPrepareWarehouses(); }); };
  const [filters, setFilters] = useState<StockWarehouseFilters>({ query: '', situation: 'ativos' }), [draft, setDraft] = useState(''), [situationDraft, setSituationDraft] = useState<StockWarehouseFilters['situation']>('ativos');
  const [page, setPage] = useState(1), [data, setData] = useState<StockWarehousePage | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [reload, setReload] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false), [menu, setMenu] = useState(''), [panel, setPanel] = useState<{ warehouse: StockWarehouse | null } | null>(null), [situation, setSituation] = useState<Situation | null>(null), [collapsed, setCollapsed] = useState(false);
  const standard = useStockCommand(controller), pendingDefault = useRef<string | null>(null);
  const writable = Boolean(data?.can_manage) && (role === 'admin' || role === 'estoque');
  // Another actor never inherits this actor's panel or pending command.
  const lastActor = useRef(actor);
  useEffect(() => { if (lastActor.current === actor) return; lastActor.current = actor; setPanel(null); setSituation(null); setNotice(''); setReload(value => value + 1); }, [actor]);
  const path = (() => { try { return warehousesPath(filters, page); } catch { return null; } })();
  useEffect(() => {
    if (!path) return; const request = new AbortController(); setLoading(true); setError('');
    void controller.stock(path, { signal: request.signal }).then(raw => { if (request.signal.aborted) return; setData(parseWarehousePage(raw, filters, page)); })
      .catch(problem => { if (!request.signal.aborted && !aborted(problem)) { setData(null); setError(readError(problem)); } }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [controller, path, reload, actor]);
  const busy = Boolean(panel || situation) || standard.busy;
  const apply = (next: Partial<StockWarehouseFilters>) => { if (busy) return; setFilters(previous => ({ ...previous, ...next })); setPage(1); setNotice(''); };
  const chips = [
    ...(filters.situation ? [{ label: `Situação: ${filters.situation === 'ativos' ? 'Ativos' : 'Inativos'}`, onRemove: () => { setSituationDraft(''); apply({ situation: '' }); } }] : []),
    ...(filters.query ? [{ label: `Pesquisa: ${filters.query}`, onRemove: () => { setDraft(''); apply({ query: '' }); } }] : []),
  ];
  const makeDefault = (item: StockWarehouse) => {
    if (!writable || !data || (standard.pending() && pendingDefault.current !== item.id)) return;
    pendingDefault.current = item.id; setNotice('');
    void standard.run(`/v1/estoque/depositos/${item.id}/padrao`, 'POST', standard.uncertain ? null : { expected_version: data.default.version }, (value, sent) => parseWarehouseSave(value, sent, 'default'),
      result => { pendingDefault.current = null; setNotice(`${result.warehouse.name} é o depósito padrão.`); setReload(value => value + 1); }, defaultError);
  };
  // Inativar/Reativar is the audited catalog command (006); the default warehouse is refused by the database (105).
  const runSituation = async (target: Situation) => {
    let result: { record?: { id?: string; active?: boolean } };
    try { result = await controller.catalog(`/v1/cadastros/warehouses/${target.item.id}/active`, { method: 'PATCH', body: { command_id: crypto.randomUUID(), expected_version: target.item.version, active: target.active } }) as typeof result; }
    catch (problem) {
      if (problem instanceof AccessError && [400, 403, 404, 409].includes(problem.status)) throw new Error(problem.status === 409 ? 'O depósito foi alterado por outra operação. Recarregue a lista.' : problem.status === 400 ? 'Torne outro depósito padrão antes de inativar este.' : problem.status === 404 ? 'Depósito não encontrado.' : 'Seu perfil não permite alterar depósitos.');
      return { uncertain: true, message: 'Resultado não confirmado. Recarregue a lista antes de repetir.' };
    }
    if (result?.record?.id !== target.item.id || result.record.active !== target.active) return { uncertain: true };
  };
  const openRow = (item: StockWarehouse) => { if (!busy) setPanel({ warehouse: item }); };
  const rowKey = (event: KeyboardEvent<HTMLTableRowElement>, item: StockWarehouse) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openRow(item); } };
  return <section className="stock-warehouses">
    <nav className="stock-crumbs" aria-label="Caminho"><Link to="/preferencias">Preferências</Link><Icon name="chevron-right" size={9} /><span>Suprimentos</span><Icon name="chevron-right" size={9} /><span aria-current="page">Depósitos</span></nav>
    <OriginListHeader title="Depósitos" />
    {role === 'admin' && onPrepareWarehouses && <p><button type="button" className="text-button" onClick={prepareWarehouses}>Importar depósitos do Origin</button></p>}
    {notice && <p className="real-success" role="status">{notice}</p>}{(error || standard.error) && <p className="real-alert" role="alert">{error || standard.error}{standard.uncertain && pendingDefault.current && data && <button type="button" className="text-button" disabled={standard.busy} onClick={() => { const item = data.items.find(row => row.id === pendingDefault.current); if (item) makeDefault(item); }}>Conferir resultado</button>}</p>}
    <div className="stock-warehouses-layout"><div className="stock-warehouses-main">
      <fieldset className="stock-ledger-controls" disabled={busy}><legend className="real-sr-only">Filtros dos depósitos</legend>
        <OriginToolbar filterOpen={filterOpen} onToggleFilter={() => { setSituationDraft(filters.situation); setFilterOpen(value => !value); }} searchValue={draft} searchPlaceholder={WAREHOUSE_SEARCH} onSearchChange={setDraft} onSearch={() => apply({ query: draft.trim() })}
          tools={<button type="button" className="origin-refresh" title="Recarregar" aria-label="Recarregar" onClick={() => setReload(value => value + 1)}><Icon name="rotate-right" size={12} /></button>} />
        <AppliedChips chips={chips} onClear={() => { setDraft(''); setSituationDraft(''); apply({ query: '', situation: '' }); }} />
        {filterOpen && <OriginFilterPanel open onClose={() => setFilterOpen(false)} onApply={() => apply({ situation: situationDraft })}>
          <label htmlFor="stock-warehouse-situation">Situação<select id="stock-warehouse-situation" value={situationDraft} onChange={event => setSituationDraft(event.target.value as StockWarehouseFilters['situation'])}><option value="">Todos</option><option value="ativos">Ativos</option><option value="inativos">Inativos</option></select></label>
        </OriginFilterPanel>}
      </fieldset>
      {loading && <p role="status">Consultando depósitos…</p>}
      {data && <><div className="table-scroll" tabIndex={0} role="region" aria-label="Depósitos"><table className="data-table real-table stock-warehouses-table"><thead><tr><th>Descrição</th><th><span className="real-sr-only">Depósito padrão</span></th><th><span className="real-sr-only">Ações</span></th></tr></thead><tbody>
        {data.items.map(item => <tr key={item.id} className="stock-row" tabIndex={0} aria-label={`Editar depósito ${item.name}`} onClick={() => openRow(item)} onKeyDown={event => rowKey(event, item)}>
          <td>{item.name}{!item.active && <small className="stock-reference">Inativo</small>}{item.ignore_balance && <small className="stock-reference">Saldo desconsiderado</small>}</td>
          <td>{item.is_default && <strong className="stock-default">{DEFAULT_LABEL}</strong>}</td>
          <td onClick={event => event.stopPropagation()}>{writable && <RowMenu label={item.name} open={menu === item.id} onToggle={() => setMenu(value => value === item.id ? '' : item.id)} items={[
            ...(item.active ? [{ label: 'Inativar depósito', icon: 'ban', disabled: item.is_default || busy, title: item.is_default ? 'Torne outro depósito padrão antes de inativar este.' : undefined, onClick: () => setSituation({ item: { ...item, label: item.name }, active: false }) }]
              : [{ label: 'Reativar depósito', icon: 'check', disabled: busy, onClick: () => setSituation({ item: { ...item, label: item.name }, active: true }) }]),
            ...(item.active && !item.is_default ? [{ label: 'Tornar depósito padrão', icon: 'star', disabled: busy || (standard.pending() && pendingDefault.current !== item.id), onClick: () => makeDefault(item) }] : []),
          ]} />}</td></tr>)}
      </tbody></table></div>{!data.items.length && <p className="empty-state">{chips.length ? 'Nenhum depósito encontrado com os filtros aplicados.' : 'Nenhum depósito cadastrado.'}</p>}
        {data.total > 0 && <OriginPagination page={page} pages={Math.max(1, Math.ceil(data.total / WAREHOUSE_PAGE_SIZE))} size={WAREHOUSE_PAGE_SIZE} total={data.total} onPage={target => { if (!busy) setPage(target); }} />}</>}
    </div>
    <OriginActionsPanel collapsed={collapsed} onCollapse={() => setCollapsed(value => !value)} primary={writable ? <button type="button" className="primary-button" disabled={busy} onClick={() => setPanel({ warehouse: null })}><Icon name="plus" size={12} />Incluir depósito</button> : undefined}
      info={data ? [{ label: 'Quantidade de Depósitos', value: String(data.total) }] : []} />
    </div>
    {panel && <StockWarehousePanel controller={controller} warehouse={panel.warehouse} writable={writable} onClose={() => setPanel(null)} onSaved={saved => { setPanel(null); setNotice(`Depósito ${saved.name} salvo.`); setReload(value => value + 1); }} />}
    {situation && <BatchDialog title={situation.active ? 'Reativar depósito' : 'Inativar depósito'} confirmLabel={situation.active ? 'Reativar depósito' : 'Inativar depósito'}
      plan={planBatch([situation.item], item => !situation.active && item.is_default ? 'Torne outro depósito padrão antes de inativar este.' : null)}
      description={<p>{situation.active ? 'O depósito volta a aceitar lançamentos e aparece no extrato.' : 'O depósito deixa de aceitar novos lançamentos; o histórico e os saldos continuam visíveis.'}</p>}
      run={item => runSituation({ item, active: situation.active })}
      onClose={results => { setSituation(null); if (results) setReload(value => value + 1); }} />}
  </section>;
}
