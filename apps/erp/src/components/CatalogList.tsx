import { Link, useLocation, useNavigate } from 'react-router-dom';
import { OriginProductDeletions } from './OriginCatalogSync';
import { useEffect, useRef, useState, type ComponentType, type FormEvent, type ReactNode } from 'react';
import NativeListLayout from './NativeListLayout';
import { Icon } from './Icon';
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChanges';
import { AccessError, type AccessController } from '../lib/real-access';
import {
  EMPTY_CONTACT_FILTERS, EMPTY_PERIOD, EMPTY_PRODUCT_FILTERS, PERIOD_FIELDS, appliedContactFilters, appliedProductFilters, ariaSort, catalogPageParams, contactRoleFromParam, contactRoleParam,
  nextSort, sortLabel, type CatalogAccess, type CatalogPeriodField, type CatalogEntity, type CatalogEnvelope, type CatalogListItem, type CatalogListPage, type CatalogPeriod, type CatalogRecord, type CatalogSort, type ContactRoleFilter,
} from '../lib/catalog-model';
import { badgeClass, brDate, opensInNewTab, selectRange } from '../lib/origin-list';
import { planBatch, summarizeBatch, batchSummaryText, type BatchResult, type BatchStep } from '../lib/origin-batch';
import { stockDate } from '../lib/stock-model';
import { AppliedChips, OriginPagination, ListControls, PeriodPicker, RowMenu, type RowMenuItem } from './OriginList';
import { BatchDialog } from './BatchDialog';
import type { CatalogEditorProps } from './CatalogEditor';
import { LIST_TITLE, aborted, errorText, knownFailure, situation } from './catalog-shared';

// Listing machinery shared by ProductList, ContactList and WarehouseList: permissions, pages of 100, order, search,
// period, the URL of the open record, selection, the situation batch and the frame of the Origin list.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_SELECTION: ReadonlySet<string> = new Set();
// A middle click on the name link already opens it natively; the other controls of a row keep their own behavior.
const fromControl = (target: unknown) => Boolean((target as { closest?: (selector: string) => unknown } | null)?.closest?.('a, button, input, select, textarea, label'));
const itemFailure = (error: unknown) => error instanceof AccessError && error.status === 409 ? 'O cadastro foi alterado por outra operação. Atualize a listagem e tente de novo.'
  : error instanceof AccessError && error.status === 404 ? 'O cadastro não foi encontrado.' : errorText(error);
export const fieldText = (item: CatalogRecord, key: string) => typeof item[key] === 'string' && item[key] ? item[key] as string : '—';

type SituationItem = { id: string; label: string; version: number; active: boolean };
type SituationBatch = { items: SituationItem[]; target: boolean; choosable: boolean; locked: boolean };
/** Row state owned by an entity list (the inline price of products): discarded on every list change, told about every page. */
export type CatalogRowState = { discard: () => void; loaded: (page: CatalogListPage) => void };

export function useCatalogList(controller: AccessController, initialEntity: CatalogEntity) {
  const location = useLocation(), navigate = useNavigate();
  const deepLinked = location.pathname === '/cadastros-reais', routeParams = new URLSearchParams(location.search);
  const [activeDraft, setActiveDraft] = useState('true');
  const [productFilters, setProductFilters] = useState(EMPTY_PRODUCT_FILTERS), [productFilterDraft, setProductFilterDraft] = useState(EMPTY_PRODUCT_FILTERS);
  const [contactFilters, setContactFilters] = useState(EMPTY_CONTACT_FILTERS), [contactFilterDraft, setContactFilterDraft] = useState(EMPTY_CONTACT_FILTERS);
  const [period, setPeriod] = useState<CatalogPeriod>(EMPTY_PERIOD), [sort, setSort] = useState<CatalogSort>('created_desc');
  const [localRole, setLocalRole] = useState<ContactRoleFilter>('');
  // On /cadastros-reais the contact type lives in the URL (?contato=fornecedor), so Estoque > Fornecedores opens suppliers only.
  const role: ContactRoleFilter = deepLinked ? contactRoleFromParam(routeParams.get('contato')) : localRole;
  const [permissions, setPermissions] = useState<CatalogAccess | null>(null);
  const [entity, setEntity] = useState<CatalogEntity>(initialEntity); const [query, setQuery] = useState(''); const [draft, setDraft] = useState('');
  const [active, setActive] = useState('true');
  const [page, setPage] = useState<CatalogListPage | null>(null); const [record, setRecord] = useState<CatalogRecord | null>(null); const [editing, setEditing] = useState(false);
  const [clone, setClone] = useState<{ values: Record<string, string>; name: string } | null>(null);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [detailError, setDetailError] = useState(''); const [notice, setNotice] = useState(''); const [reload, setReload] = useState(0);
  const filterKey = JSON.stringify([entity, query, active, productFilters, contactFilters, role, period, sort]);
  // Changing any filter or the order returns to page 1 in the same render, without a stale request.
  const [pageState, setPageState] = useState({ key: filterKey, number: 1 });
  if (pageState.key !== filterKey) setPageState({ key: filterKey, number: 1 });
  const pageNumber = pageState.key === filterKey ? pageState.number : 1;
  const listKey = `${filterKey}:${pageNumber}:${reload}`;
  // Like Origin, the selection belongs to the page on screen: another page, order, filter or reload clears it.
  const [selection, setSelection] = useState<{ key: string; ids: ReadonlySet<string>; anchor: string | null }>({ key: listKey, ids: NO_SELECTION, anchor: null });
  if (selection.key !== listKey) setSelection({ key: listKey, ids: NO_SELECTION, anchor: null });
  const selected = selection.key === listKey ? selection.ids : NO_SELECTION;
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [batch, setBatch] = useState<SituationBatch | null>(null);
  const detailRequest = useRef<AbortController | null>(null), batchRequest = useRef<AbortController | null>(null);
  const batchActor = useRef<string | undefined>(undefined), alive = useRef(true);
  // Each entity list registers its row state under its own entity on every render (see useProductList),
  // so a second list with row state never replaces the first one.
  const rows = useRef<Partial<Record<CatalogEntity, CatalogRowState>>>({});
  const eachRow = (run: (state: CatalogRowState) => void) => { for (const state of Object.values(rows.current)) if (state) run(state); };
  useEffect(() => {
    alive.current = true; const request = new AbortController();
    void controller.catalog('/v1/cadastros', { signal: request.signal }).then(value => {
      const access = value as CatalogAccess;
      if (access.data_mode !== 'erp_native' || !Array.isArray(access.read) || !Array.isArray(access.write)) throw new Error('Invalid response');
      setPermissions(access); setEntity(access.read.includes(initialEntity) ? initialEntity : access.read[0] || 'contacts'); if (!access.read.length) setLoading(false);
    }).catch(failure => { if (!aborted(failure)) { setError(errorText(failure)); setLoading(false); } });
    return () => { alive.current = false; request.abort(); detailRequest.current?.abort(); batchRequest.current?.abort(); };
  }, [controller]);
  useEffect(() => {
    // Clientes e fornecedores load their own page (ContactList.tsx, /v1/cadastros/contatos).
    if (!permissions?.read.includes(entity) || entity === 'contacts') return;
    const request = new AbortController(); setLoading(true); setError(''); setPage(null);
    const params = catalogPageParams(entity, { page: pageNumber, sort, query, active, role, contact: contactFilters, product: productFilters, period });
    void controller.catalog(`/v1/cadastros/${entity}?${params}`, { signal: request.signal }).then(value => {
      if (request.signal.aborted) return;
      const result = value as CatalogListPage;
      if (result.entity !== entity || result.page !== pageNumber || !Array.isArray(result.items) || !Number.isSafeInteger(result.total)) throw new AccessError(502);
      // A page emptied by another user's change (or a batch) falls back to the last page that still has records.
      if (!result.items.length && result.total > 0 && pageNumber > 1) { setPageState({ key: filterKey, number: Math.ceil(result.total / result.size) }); return; }
      eachRow(state => state.loaded(result));
      setPage(result); setLoading(false);
    }).catch(failure => { if (!aborted(failure)) { setError(errorText(failure)); setLoading(false); } });
    return () => request.abort();
  }, [controller, permissions, entity, filterKey, pageNumber, reload]);
  const load = async (id: string) => {
    detailRequest.current?.abort(); const request = new AbortController(); detailRequest.current = request; setError(''); setDetailError('');
    try {
      const value = await controller.catalog(`/v1/cadastros/${entity}/${id}`, { signal: request.signal }) as CatalogEnvelope;
      if (request.signal.aborted) return;
      if (value.record?.id?.toLowerCase() !== id.toLowerCase() || value.record.entity !== entity) throw new AccessError(502);
      setClone(null); setRecord(value.record); setEditing(true);
    } catch (failure) { if (!request.signal.aborted && !aborted(failure)) (deepLinked ? setDetailError : setError)(errorText(failure)); }
  };
  // On the company route the URL owns the open record (?registro=<id>): Back, reload and a new tab show the same cadastro.
  useEffect(() => {
    if (!deepLinked) return;
    // The router guard already confirmed this navigation (name link, Back): an inline price edit is discarded with it.
    eachRow(state => state.discard()); setRowMenu(null);
    detailRequest.current?.abort(); setClone(null); setRecord(null); setEditing(false); setDetailError('');
    const params = new URLSearchParams(location.search), id = params.get('registro');
    if (!params.has('registro')) return;
    if (!id || !UUID.test(id)) { setDetailError('O endereço contém um identificador de cadastro inválido. Volte à listagem.'); return; }
    if (!permissions) return;
    if (!permissions.read.includes(entity)) { setDetailError('Seu perfil não permite consultar este cadastro.'); return; }
    void load(id);
  }, [controller, permissions, entity, location.pathname, location.search]);
  const recordPath = (id: string, base = location.search) => { const params = new URLSearchParams(base); params.set('cadastro', entity); params.set('registro', id); return `/cadastros-reais?${params}`; };
  const open = (id: string) => changeList(() => { if (deepLinked) { navigate(recordPath(id)); return; } void load(id); });
  const openRow = (id: string, event: { ctrlKey?: boolean; metaKey?: boolean; button?: number }) => {
    if (deepLinked && opensInNewTab(event)) { window.open(recordPath(id, ''), '_blank', 'noopener'); return; }
    open(id);
  };
  const closeEditor = () => {
    detailRequest.current?.abort(); setEditing(false); setRecord(null); setClone(null); setDetailError('');
    if (deepLinked && new URLSearchParams(location.search).has('registro')) { const params = new URLSearchParams(location.search); params.delete('registro'); navigate(`${location.pathname}?${params}`, { replace: true }); }
  };
  const writable = Boolean(permissions?.write.includes(entity));
  const navigationGuard = useUnsavedChangesGuard();
  // Every change of page, order or filter discards transient row state; an open price edit asks first.
  const changeList = (change: () => void) => navigationGuard.confirmLeave(() => { eachRow(state => state.discard()); setRowMenu(null); setNotice(''); change(); });
  const create = () => changeList(() => { setRecord(null); setClone(null); setEditing(true); });
  /** Opens the new-record form prefilled (Clonar produto); nothing is saved until the user saves it. */
  const openClone = (values: Record<string, string>, name: string) => { setRecord(null); setClone({ values, name }); setEditorEpoch(epoch => epoch + 1); setEditing(true); };
  const openSituation = (items: CatalogListItem[], target: boolean, choosable: boolean) => {
    setRowMenu(null); if (!writable || !items.length) return;
    // The batch reloads the list afterwards, so an unsaved inline price asks first, like any other list change.
    changeList(() => {
      batchActor.current = controller.getSnapshot().membership?.user_id; batchRequest.current = new AbortController();
      setBatch({ items: items.map(item => ({ id: item.id, label: item.name, version: item.version, active: item.active })), target, choosable, locked: false });
    });
  };
  const batchPlan = batch ? planBatch(batch.items, item => item.active === batch.target ? (batch.target ? 'Já está ativo.' : 'Já está inativo.') : null) : null;
  // One request per record through the single-record endpoint, each with its own command and version.
  const runSituation = (target: boolean) => async (item: SituationItem): Promise<BatchStep> => {
    setBatch(current => current && !current.locked ? { ...current, locked: true } : current);
    const snapshot = controller.getSnapshot(), signal = batchRequest.current?.signal;
    if (!alive.current || !signal || signal.aborted || snapshot.phase !== 'ready' || snapshot.membership?.user_id !== batchActor.current) throw new Error('A sessão mudou durante a operação. Este cadastro não foi enviado.');
    const body = { command_id: crypto.randomUUID(), expected_version: item.version, active: target };
    const send = async () => {
      const result = await controller.catalog(`/v1/cadastros/${entity}/${item.id}/active`, { method: 'PATCH', body, signal }) as CatalogEnvelope;
      if (result.record?.id !== item.id || result.record.active !== target) throw new AccessError(502);
    };
    try { await send(); return; }
    catch (failure) {
      if (!aborted(failure) && knownFailure(failure)) throw new Error(itemFailure(failure));
      // Unknown outcome: repeat the same command once. A replay confirms it without applying it twice.
      try { if (!signal.aborted) { await send(); return { message: 'Confirmado ao repetir a mesma operação.' }; } } catch { /* Still unknown. */ }
      return { uncertain: true, message: 'Não foi possível confirmar o resultado. Atualize a listagem e confira o cadastro antes de repetir.' };
    }
  };
  const closeBatch = (results: BatchResult[] | null) => {
    setBatch(null); batchRequest.current = null;
    if (results) { setNotice(`Mudança de situação: ${batchSummaryText(summarizeBatch(results))}.`); setSelection({ key: '', ids: NO_SELECTION, anchor: null }); setReload(value => value + 1); }
  };
  const ids = page?.items.map(item => item.id) ?? [];
  const allSelected = ids.length > 0 && ids.every(id => selected.has(id)), someSelected = ids.some(id => selected.has(id));
  const toggleRow = (id: string, shift: boolean) => { const result = selectRange(ids, selected, selection.key === listKey ? selection.anchor : null, id, shift); setSelection({ key: listKey, ids: result.selected, anchor: result.anchor }); };
  const selectWhere = (predicate: (item: CatalogListItem) => boolean) => setSelection({ key: listKey, ids: new Set(page?.items.filter(predicate).map(item => item.id) ?? []), anchor: null });
  const selectedItems = page?.items.filter(item => selected.has(item.id)) ?? [];
  const setRole = (value: ContactRoleFilter) => changeList(() => {
    if (!deepLinked) { setLocalRole(value); return; }
    const params = new URLSearchParams(location.search), param = contactRoleParam(value); params.delete('registro');
    if (param) params.set('contato', param); else params.delete('contato');
    navigate(`${location.pathname}?${params}`);
  });
  const apply = (event: FormEvent) => {
    event.preventDefault();
    changeList(() => { setQuery(draft.trim()); setActive(activeDraft); setProductFilters(appliedProductFilters(productFilterDraft)); setContactFilters(appliedContactFilters(contactFilterDraft)); });
  };
  const clear = () => changeList(() => {
    setDraft(''); setQuery(''); setActive('true'); setActiveDraft('true'); setProductFilters(EMPTY_PRODUCT_FILTERS); setProductFilterDraft(EMPTY_PRODUCT_FILTERS);
    setContactFilters(EMPTY_CONTACT_FILTERS); setContactFilterDraft(EMPTY_CONTACT_FILTERS); setPeriod(EMPTY_PERIOD); setSort('created_desc');
    if (role) setRole('');
  });
  const changeEntity = (value: CatalogEntity) => {
    if (location.pathname === '/cadastros-reais') { const params = new URLSearchParams(location.search); params.set('cadastro', value); params.delete('registro'); params.delete('contato'); navigate(`${location.pathname}?${params}`); return; }
    changeList(() => { setEntity(value); setDraft(''); setQuery(''); setActive('true'); setActiveDraft('true'); setProductFilters(EMPTY_PRODUCT_FILTERS); setProductFilterDraft(EMPTY_PRODUCT_FILTERS); setContactFilters(EMPTY_CONTACT_FILTERS); setContactFilterDraft(EMPTY_CONTACT_FILTERS); setPeriod(EMPTY_PERIOD); setSort('created_desc'); setLocalRole(''); closeEditor(); });
  };
  // Cells and menu entries the entity lists compose into their columns.
  const sortHeader = (column: 'name' | 'code', label: string) => <th scope="col" aria-sort={ariaSort(sort, column)}><button type="button" className="catalog-sort" title={`Ordenar por ${label.toLowerCase()}`} onClick={() => changeList(() => setSort(nextSort(sort, column)))}>{label}{ariaSort(sort, column) && <Icon name={sort.endsWith('desc') ? 'arrow-down' : 'arrow-up'} size={9} />}</button></th>;
  const nameCell = (item: CatalogListItem) => <td>{deepLinked ? <Link className="record-link" to={recordPath(item.id)} onClick={event => event.stopPropagation()}>{item.name}</Link> : <button type="button" className="text-button record-link" onClick={event => { event.stopPropagation?.(); openRow(item.id, event); }}>{item.name}</button>}</td>;
  const editItem = (item: CatalogListItem): RowMenuItem => ({ label: writable ? 'Editar' : 'Visualizar', icon: writable ? 'pen-to-square' : 'eye', onClick: () => open(item.id) });
  const situationItems = (item: CatalogListItem): RowMenuItem[] => writable ? [{ label: item.active ? 'Inativar' : 'Ativar', icon: item.active ? 'ban' : 'check', onClick: () => openSituation([item], !item.active, false) }] : [];
  return {
    controller, location, navigate, deepLinked, entity, permissions, writable, loading, error, setError, detailError, notice, setNotice, page, setPage, record, editing, clone, editorEpoch,
    query, setQuery, draft, setDraft, active, setActive, activeDraft, setActiveDraft, period, setPeriod, sort, setSort, role, setRole,
    productFilters, setProductFilters, productFilterDraft, setProductFilterDraft, contactFilters, setContactFilters, contactFilterDraft, setContactFilterDraft,
    pageState, setPageState, filterKey, listKey, selection, setSelection, selected, selectedItems, ids, allSelected, someSelected, toggleRow, selectWhere,
    rowMenu, setRowMenu, batch, setBatch, batchPlan, runSituation, closeBatch, openSituation, setReload, rows, detailRequest, navigationGuard,
    load, recordPath, open, openRow, closeEditor, changeList, create, openClone, setRecord, setClone, setEditorEpoch, apply, clear, changeEntity,
    sortHeader, nameCell, editItem, situationItems,
  };
}
export type CatalogList = ReturnType<typeof useCatalogList>;

/** What an entity list puts in the shared frame (labels, filters, chips, columns, row menu and its own dialogs). */
export interface CatalogEntityView {
  labels: { add: string; count: string; search: string; searchHint: string; situation: string };
  heading?: ReactNode; intro?: ReactNode; filters?: ReactNode; overlay?: ReactNode;
  chips: { label: string; onRemove: () => void }[];
  selections?: { label: string; onSelect: () => void }[];
  headers: ReactNode; cells: (item: CatalogListItem) => ReactNode; rowItems: (item: CatalogListItem) => RowMenuItem[];
  /** Products (migration 120): own Situação select and chip, no order chip, own period types, extra panel actions and toolbar tools,
   * a bar above the table, the filter footer and the Origin empty state. Every option is optional; the other cadastros keep the frame. */
  ownSituation?: boolean; sortChip?: boolean; periodFields?: readonly { value: CatalogPeriodField; label: string }[];
  actions?: ReactNode; tools?: ReactNode; beforeTable?: ReactNode; filterFooter?: ReactNode; empty?: { title: string; text: string };
  /** false hides the shared "Mudar situação" panel button (products in "Excluídos" are read-only; only Restaurar applies). */
  situationAction?: boolean;
  /** Products (Origin): "Nova situação" as a select, the period types as tabs and the page select of the pagination. */
  situationSelect?: boolean; periodTabs?: boolean; pageSelect?: boolean;
}

/** The Origin list frame of every catalog entity; `Editor` opens the entity form in place of the list. */
export function catalogListView(list: CatalogList, view: CatalogEntityView, Editor: ComponentType<CatalogEditorProps>) {
  const { controller, entity, permissions, writable, editing, record, clone, page, loading, notice, error, detailError, deepLinked, location, navigate, period, sort, query, active, selected, selectedItems, ids, allSelected, someSelected, listKey, batch, batchPlan, rowMenu, changeList } = list;
  const periodFields = view.periodFields ?? PERIOD_FIELDS;
  const periodLabel = (periodFields.find(item => item.value === period.field) ?? periodFields[0]).label;
  const chips = [
    ...(view.sortChip === false ? [] : [{ label: sortLabel(entity, sort), onRemove: () => changeList(() => list.setSort(sort === 'created_desc' ? 'name_asc' : 'created_desc')) }]),
    ...(active && !view.ownSituation ? [{ label: `Situação: ${active === 'true' ? 'Ativos' : 'Inativos'}`, onRemove: () => changeList(() => { list.setActive(''); list.setActiveDraft(''); }) }] : []),
    ...(query ? [{ label: `Pesquisa: ${query}`, onRemove: () => changeList(() => { list.setQuery(''); list.setDraft(''); }) }] : []),
    ...view.chips,
    ...(period.from || period.to ? [{ label: `${periodLabel}: ${period.from ? brDate(period.from) : '…'} até ${period.to ? brDate(period.to) : '…'}`, onRemove: () => changeList(() => list.setPeriod(EMPTY_PERIOD)) }] : []),
  ];
  const today = stockDate();
  return <>
    <header className="real-heading catalog-heading"><div className="catalog-title"><h1>{LIST_TITLE[entity]}</h1>{view.heading}</div><div className="catalog-heading-actions">{permissions && !writable && <span className="real-mode">Somente consulta</span>}{writable && !editing && <button type="button" className="primary-button" title="Incluir um novo cadastro" onClick={list.create}><Icon name="plus" size={12}/>{view.labels.add}</button>}</div></header>
    {view.intro}
    {/* Leva H (352): produtos excluídos ou restaurados no Origin, revisados pelo administrador. */}
    {entity === 'products' && permissions && <OriginProductDeletions controller={controller} onChanged={() => list.setReload(value => value + 1)} />}
    {notice && <p className="real-success" role="status">{notice}</p>}
    {error && <p className="real-alert" role="alert">{error}<button type="button" className="text-button" onClick={() => { if (permissions) list.setReload(value => value + 1); else controller.retry(); }}>Tentar novamente</button></p>}
    {detailError && <p className="real-alert" role="alert">{detailError}<button type="button" className="text-button" onClick={list.closeEditor}>Voltar à listagem</button></p>}
    {editing ? <Editor key={`${entity}:${clone ? 'clone' : record?.id || 'new'}:${record?.version || 0}:${list.editorEpoch}`} controller={controller} entity={entity} record={record} writable={writable} initialValues={clone?.values} cloneOf={clone?.name} onClose={list.closeEditor} onSaved={saved => {
      list.setNotice('Cadastro salvo.'); list.setReload(value => value + 1);
      if (deepLinked && new URLSearchParams(location.search).get('registro') !== saved.id) { navigate(list.recordPath(saved.id)); return; }
      list.setClone(null); list.setRecord(saved); list.setEditorEpoch(value => value + 1);
    }} /> : <form onSubmit={list.apply} aria-label="Filtros dos cadastros">
      <NativeListLayout filters={<>
        {!view.ownSituation && <div className="form-field"><label htmlFor="catalog-active">Situação</label><select id="catalog-active" value={list.activeDraft} onChange={event => list.setActiveDraft(event.target.value)}><option value="true">Ativos</option><option value="false">Inativos</option><option value="">Todos</option></select></div>}
        {view.filters}
        <button type="submit" className="primary-button" disabled={loading || !permissions?.read.length}>Filtrar</button>
        {view.filterFooter ?? <p className="real-help">Cadastros inativos continuam disponíveis para consulta.</p>}
      </>} actions={<>
        {writable && view.situationAction !== false && <button type="button" className="action-button" disabled={!selectedItems.length} title={selectedItems.length ? undefined : 'Selecione os cadastros na listagem'} onClick={() => list.openSituation(selectedItems, !selectedItems.every(item => item.active), true)}><Icon name="adjust" size={14}/>{view.labels.situation}</button>}
        {view.actions}
        <div className="native-list-summary"><h3>Informações</h3><dl className="native-list-stat"><dt>{view.labels.count}</dt><dd>{page ? page.total : '—'}</dd></dl>{selectedItems.length > 0 && <dl className="native-list-stat"><dt>Selecionados</dt><dd>{selectedItems.length}</dd></dl>}</div>
        <p className="real-help">Alterações feitas aqui são salvas no FAGOO e enviadas ao Origin pela sincronização; o que mudar no Origin também chega aqui.</p>
      </>}>
        <div className="native-list-type"><label htmlFor="catalog-entity">Cadastro</label><select id="catalog-entity" value={entity} disabled={!permissions?.read.length} onChange={event => list.changeEntity(event.target.value as CatalogEntity)}>{permissions?.read.map(value => <option key={value} value={value}>{LIST_TITLE[value]}</option>)}</select></div>
        <div className="native-list-toolbar"><div className="form-field"><label htmlFor="catalog-search">{view.labels.search}</label><input id="catalog-search" type="search" maxLength={120} value={list.draft} onChange={event => list.setDraft(event.target.value)} placeholder={view.labels.searchHint} /></div><button type="submit" className="secondary-button" title="Pesquisar" aria-label="Pesquisar" disabled={loading || !permissions?.read.length}><Icon name="magnifying-glass" size={14}/></button>
          <PeriodPicker from={period.from} to={period.to} today={today} dateType={periodLabel} dateTypes={periodFields.map(item => item.label)} prefixLabel typeTabs={view.periodTabs} onApply={range => changeList(() => list.setPeriod({ field: periodFields.find(item => item.label === range.dateType)?.value ?? periodFields[0].value, from: range.from, to: range.to }))} />{view.tools}</div>
        <AppliedChips chips={chips} onClear={list.clear} />
        {view.beforeTable}
        <div className="catalog-list-controls">{writable && page ? <ListControls checked={allSelected} indeterminate={!allSelected && someSelected} onToggleAll={() => list.setSelection({ key: listKey, ids: allSelected ? NO_SELECTION : new Set(ids), anchor: null })} onRefresh={() => changeList(() => list.setReload(value => value + 1))}
            selections={view.selections} />
          : <button type="button" className="origin-refresh" title="Recarregar" aria-label="Recarregar" onClick={() => changeList(() => list.setReload(value => value + 1))} disabled={loading || !permissions?.read.length}><Icon name="rotate-right" size={12}/></button>}
          <div className="real-result-status" role="status">{loading ? 'Carregando cadastros…' : page ? page.total === 1 ? '1 cadastro encontrado' : `${page.total} cadastros encontrados` : 'Nenhum cadastro disponível para seu perfil.'}</div></div>
        {page && <><div className="table-scroll" tabIndex={0} role="region" aria-label="Cadastros da empresa"><table className="data-table real-table origin-table catalog-table"><thead><tr>
          {writable && <th scope="col" className="checkbox-cell"><span className="real-sr-only">Seleção</span></th>}
          {view.headers}
          <th scope="col">Situação</th><th scope="col">Origem</th><th scope="col" className="row-actions"><span className="real-sr-only">Ações</span></th></tr></thead>
          <tbody>{page.items.map(item => <tr key={item.id} className={selected.has(item.id) ? 'selected' : undefined} onClick={event => list.openRow(item.id, event)} onAuxClick={event => { if (event.button === 1 && !fromControl(event.target)) list.openRow(item.id, event); }}>
            {writable && <td className="checkbox-cell" onClick={event => event.stopPropagation()}><input type="checkbox" aria-label={`Selecionar ${item.name}`} checked={selected.has(item.id)} onClick={event => list.toggleRow(item.id, event.shiftKey)} onChange={() => undefined} /></td>}
            {view.cells(item)}
            <td><span className={badgeClass(situation(item.active))}>{situation(item.active)}</span></td><td>{item.source ? 'Origin' : 'FAGOO'}</td>
            <td className="row-actions" onClick={event => event.stopPropagation()}><RowMenu label={item.name} items={view.rowItems(item)} open={rowMenu === item.id} onToggle={() => list.setRowMenu(rowMenu === item.id ? null : item.id)} /></td>
          </tr>)}</tbody></table></div>{!page.items.length && <div className="origin-empty"><span><Icon name="exclamation" size={22}/></span><h2>{view.empty?.title ?? 'Nenhum cadastro encontrado'}</h2><p>{view.empty?.text ?? (writable ? 'Inclua um cadastro ou ajuste a pesquisa.' : 'Ajuste a pesquisa ou aguarde o cadastro pela equipe autorizada.')}</p></div>}
          {page.total > 0 && <OriginPagination page={page.page} pages={Math.max(1, Math.ceil(page.total / page.size))} size={page.size} total={page.total} pageSelect={view.pageSelect} onPage={value => changeList(() => list.setPageState({ key: list.filterKey, number: value }))} />}</>}
      </NativeListLayout>
    </form>}
    {batch && batchPlan && <BatchDialog title={batch.choosable ? view.labels.situation : batch.target ? 'Ativar cadastro' : 'Inativar cadastro'} plan={batchPlan} confirmLabel={batch.target ? 'Ativar' : 'Inativar'} run={list.runSituation(batch.target)} onClose={list.closeBatch}
      description={batch.choosable && view.situationSelect ? <div className="form-field"><label htmlFor="catalog-batch-target-select">Nova situação</label><select id="catalog-batch-target-select" value={batch.target ? 'A' : 'I'} disabled={batch.locked} onChange={event => list.setBatch(current => current && !current.locked ? { ...current, target: event.target.value === 'A' } : current)}><option value="A">Ativo</option><option value="I">Inativo</option></select></div>
        : batch.choosable ? <fieldset className="catalog-batch-target" disabled={batch.locked}><legend>Nova situação</legend>{[true, false].map(value => <label key={String(value)}><input type="radio" name="catalog-batch-target" checked={batch.target === value} onChange={() => list.setBatch(current => current && !current.locked ? { ...current, target: value } : current)} />{value ? 'Ativo' : 'Inativo'}</label>)}</fieldset> : undefined} />}
    {view.overlay}
  </>;
}
