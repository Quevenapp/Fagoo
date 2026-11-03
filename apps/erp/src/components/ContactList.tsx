import { originIntegrationEnabled } from '../lib/integration-capabilities';
import { useEffect, useRef, useState, type ComponentType, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AccessError } from '../lib/real-access';
import { UF_OPTIONS, type CatalogRecord } from '../lib/catalog-model';
import { opensInNewTab, selectRange } from '../lib/origin-list';
import { planBatch, summarizeBatch, batchSummaryText, type BatchResult, type BatchStep } from '../lib/origin-batch';
import { stockDate } from '../lib/stock-model';
import {
  CONTACTS_BASE, CONTACT_LIST_ID, COLUMN_LABELS, CUSTOM_COLUMNS, DEFAULT_COLUMNS, EMPTY_LIST_FILTERS, EMPTY_LIST_PERIOD, FIXED_COLUMN, PERSON_FILTERS, SALE_STATUS_OPTIONS, SITUATION_FILTERS,
  appliedListFilters, columnText, contactPageQuery, typeFromParam, typeLabels, typeParam, typeSelectorOptions, visibleColumns,
  type ContactListFilters, type ContactListItem, type ContactListPeriod, type ContactPage, type ContactTypes, type SituationFilter,
} from '../lib/contact-list-model';
import type { ContactSituation } from '../lib/contact-form-model';
import { useListPreferences } from '../hooks/useListPreferences';
import NativeListLayout from './NativeListLayout';
import { Icon } from './Icon';
import { AppliedChips, OriginPagination, OriginSelector, ListControls, RowMenu, ToolButton, ViewToggle, type RowMenuItem } from './OriginList';
import { BatchDialog } from './BatchDialog';
import { ListColumnsPanel } from './ListColumnsPanel';
import { ContactPeriodPicker, periodChip } from './ContactPeriodPicker';
import { SellerPicker, type SellerOption } from './SellerPicker';
import { ContactComments } from './ContactComments';
import { ContactExportDialog } from './ContactExportDialog';
import { ContactListPrint, type PrintRequest } from './ContactListPrint';
import { ContactMarkers, ContactTagFilters, ContactTagsBatch, contactTagChips, useContactMarkers, useContactTagOptions } from './ContactTags';
import { ContactLabelsPrint } from './ContactLabelsPrint';
import { contactRefusalText } from './contact-errors';
import type { CatalogEditorProps } from './CatalogEditor';
import type { CatalogList } from './CatalogList';
import { LIST_TITLE, aborted, errorText, knownFailure } from './catalog-shared';
import './contacts.css';

// Listagem de Clientes e fornecedores no padrão do Origin (lane contatos). It owns its filters, page, selection and batch
// actions; the shared catalog hook keeps permissions, the entity selector and the open record (?registro=).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_SELECTION: ReadonlySet<string> = new Set();
const SITUATION_CHIPS: Partial<Record<SituationFilter, string>> = { A: 'Situação: Ativos', I: 'Situação: Inativos', S: 'Situação: Sem movimento', E: 'Cadastros: Excluídos' };
const fromControl = (target: unknown) => Boolean((target as { closest?: (selector: string) => unknown } | null)?.closest?.('a, button, input, select, textarea, label'));
// Ficha financeira (Financeiro › Ficha financeira): the profiles of the Financeiro menu read it.
const FINANCE_READERS = ['admin', 'consulta', 'financeiro'];
const itemFailure = (error: unknown) => contactRefusalText(error) ?? (error instanceof AccessError && error.status === 409 ? 'O cadastro foi alterado por outra operação. Atualize a listagem e tente de novo.'
  : error instanceof AccessError && error.status === 404 ? 'O cadastro não foi encontrado.' : errorText(error));
type BatchItem = { id: string; label: string; version: number; situation: ContactSituation; seller_id: string | null };
type Batch = { kind: 'situation'; target: ContactSituation; choosable: boolean; items: BatchItem[]; locked: boolean } | { kind: 'seller'; seller: SellerOption | null; items: BatchItem[]; locked: boolean };
type SellerCommand = { contact: ContactListItem; commandId: string; uncertain: boolean; busy: boolean };

export function ContactCatalog({ list, Editor }: { list: CatalogList; Editor: ComponentType<CatalogEditorProps> }) {
  const { controller, permissions, writable, editing, record, clone, deepLinked, location, navigate, changeList } = list;
  const routeParams = new URLSearchParams(location.search);
  const [localType, setLocalType] = useState('');
  // On /cadastros-reais the contact type lives in the URL (?contato=fornecedor), so Estoque > Fornecedores opens suppliers only.
  const type = deepLinked ? typeFromParam(routeParams.get('contato')) : localType;
  const [types, setTypes] = useState<ContactTypes | null>(null);
  const [filters, setFilters] = useState<ContactListFilters>(EMPTY_LIST_FILTERS), [draft, setDraft] = useState<ContactListFilters>(EMPTY_LIST_FILTERS);
  const [query, setQuery] = useState(''), [queryDraft, setQueryDraft] = useState('');
  const [period, setPeriod] = useState<ContactListPeriod>(EMPTY_LIST_PERIOD);
  // Origin CL-24/CL-26/CL-27: the order follows the situation (Últimos incluídos by inclusion, the others by name), never the headers.
  const sort = filters.situation === 'latest' ? 'created_desc' as const : 'name_asc' as const;
  const filterKey = JSON.stringify([type, filters, query, period]);
  const [pageState, setPageState] = useState({ key: filterKey, number: 1 });
  if (pageState.key !== filterKey) setPageState({ key: filterKey, number: 1 });
  const pageNumber = pageState.key === filterKey ? pageState.number : 1;
  const [reload, setReload] = useState(0);
  const listKey = `${filterKey}:${pageNumber}:${reload}`;
  const [page, setPage] = useState<ContactPage | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [selection, setSelection] = useState<{ key: string; ids: ReadonlySet<string>; anchor: string | null }>({ key: listKey, ids: NO_SELECTION, anchor: null });
  if (selection.key !== listKey) setSelection({ key: listKey, ids: NO_SELECTION, anchor: null });
  const selected = selection.key === listKey ? selection.ids : NO_SELECTION;
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [comments, setComments] = useState<ContactListItem | null>(null), [exporting, setExporting] = useState(false), [printing, setPrinting] = useState<PrintRequest | null>(null);
  const [labelsFor, setLabelsFor] = useState<string[] | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false), [viewChoice, setViewChoice] = useState<'padrao' | 'customizada' | null>(null);
  const [sellerCommand, setSellerCommand] = useState<SellerCommand | null>(null);
  const batchRequest = useRef<AbortController | null>(null), batchActor = useRef<string | undefined>(undefined), alive = useRef(true), sellerRequest = useRef<AbortController | null>(null);
  const prefs = useListPreferences(controller, CONTACT_LIST_ID, { available: CUSTOM_COLUMNS, defaults: DEFAULT_COLUMNS });
  const savedView = prefs.filters?.listagem === 'customizada' ? 'customizada' as const : 'padrao' as const, view = viewChoice ?? savedView;
  const columns = visibleColumns(view, prefs.columns);
  // Produtos lane (migration 153): Tags and Lista de preço filters, Marcadores and "Incluir tags para selecionados".
  const tagOptions = useContactTagOptions(controller, Boolean(permissions?.read.includes('contacts')), Boolean(permissions?.read.includes('products')));
  const markers = useContactMarkers(controller, page?.items.map(item => item.id) ?? [], listKey);
  const [tagBatch, setTagBatch] = useState<{ id: string; label: string; excluded: boolean }[] | null>(null);
  const role = controller.getSnapshot().membership?.role;
  useEffect(() => { alive.current = true; return () => { alive.current = false; batchRequest.current?.abort(); sellerRequest.current?.abort(); }; }, []);
  useEffect(() => {
    if (!permissions?.read.includes('contacts')) return;
    const request = new AbortController();
    void controller.catalog('/v1/cadastros/tipos-contato', { signal: request.signal }).then(value => {
      if (request.signal.aborted) return; const result = value as ContactTypes;
      if (!Array.isArray(result.items)) throw new AccessError(502); setTypes(result);
    }).catch(() => { if (!request.signal.aborted) setTypes({ items: [], can_create: false, can_delete: false }); });
    return () => request.abort();
  }, [controller, permissions]);
  useEffect(() => {
    if (!permissions?.read.includes('contacts')) { if (permissions) setLoading(false); return; }
    const request = new AbortController(); setLoading(true); setError(''); setPage(null);
    const params = contactPageQuery({ page: pageNumber, sort, query, type, filters, period });
    void controller.catalog(`${CONTACTS_BASE}?${params}`, { signal: request.signal }).then(value => {
      if (request.signal.aborted) return;
      const result = value as ContactPage;
      if (result.entity !== 'contacts' || result.page !== pageNumber || !Array.isArray(result.items) || !Number.isSafeInteger(result.total)) throw new AccessError(502);
      if (!result.items.length && result.total > 0 && pageNumber > 1) { setPageState({ key: filterKey, number: Math.ceil(result.total / result.size) }); return; }
      setPage(result); setLoading(false);
    }).catch(failure => { if (!aborted(failure)) { setError(errorText(failure)); setLoading(false); } });
    return () => request.abort();
  }, [controller, permissions, filterKey, pageNumber, reload]);

  const ids = page?.items.map(item => item.id) ?? [];
  const selectedItems = page?.items.filter(item => selected.has(item.id)) ?? [];
  const allSelected = ids.length > 0 && ids.every(id => selected.has(id)), someSelected = ids.some(id => selected.has(id));
  const toggleRow = (id: string, shift: boolean) => { const result = selectRange(ids, selected, selection.key === listKey ? selection.anchor : null, id, shift); setSelection({ key: listKey, ids: result.selected, anchor: result.anchor }); };
  const clearSelection = () => setSelection({ key: listKey, ids: NO_SELECTION, anchor: null });
  const setType = (value: string) => changeList(() => {
    if (!deepLinked) { setLocalType(value); return; }
    const params = new URLSearchParams(location.search), param = typeParam(value); params.delete('registro');
    if (param) params.set('contato', param); else params.delete('contato');
    navigate(`${location.pathname}?${params}`);
  });
  const apply = (event: FormEvent) => { event.preventDefault(); changeList(() => { setQuery(queryDraft.trim()); setFilters(appliedListFilters(draft)); setNotice(''); }); };
  const removeFilter = (change: Partial<ContactListFilters>) => () => changeList(() => { setFilters(previous => ({ ...previous, ...change })); setDraft(previous => ({ ...previous, ...change })); });
  // "Limpar" (Origin CL-27): Situação Todos, alphabetical order, no chip: "Nenhum filtro aplicado", excluded rows included.
  const clear = () => changeList(() => {
    const cleared = { ...EMPTY_LIST_FILTERS, situation: 'all' as const }; setFilters(cleared); setDraft(cleared); setQuery(''); setQueryDraft(''); setPeriod(EMPTY_LIST_PERIOD);
    if (type) setType('');
  });
  const open = (item: ContactListItem) => list.open(item.id);
  const openRow = (item: ContactListItem, event: { ctrlKey?: boolean; metaKey?: boolean; button?: number }) => {
    if (deepLinked && opensInNewTab(event)) { window.open(list.recordPath(item.id, ''), '_blank', 'noopener'); return; }
    open(item);
  };
  const typeOptions = typeSelectorOptions(types?.items ?? []);
  const typeLabel = typeOptions.find(option => option.value === type)?.label ?? (type ? type : 'Todos');

  // ---- Lotes: Excluir / Restaurar selecionados, Mudar situação e Vincular a vendedor (um comando por contato) ----
  const startBatch = (next: Batch) => {
    setRowMenu(null); if (!writable || !next.items.length) return;
    changeList(() => { batchActor.current = controller.getSnapshot().membership?.user_id; batchRequest.current = new AbortController(); setBatch(next); });
  };
  const asBatch = (items: readonly ContactListItem[]) => items.map(item => ({ id: item.id, label: item.name, version: item.version, situation: item.situation, seller_id: item.seller_id }));
  const plan = batch ? planBatch(batch.items, item => batch.kind === 'situation'
    ? item.situation === batch.target ? `Já está ${({ A: 'ativo', I: 'inativo', S: 'sem movimento', E: 'excluído' } as const)[batch.target]}.` : null
    : batch.seller && item.seller_id === batch.seller.id ? 'Já está vinculado a este vendedor.' : null) : null;
  const runItem = (current: Batch) => async (item: BatchItem): Promise<BatchStep> => {
    setBatch(value => value && !value.locked ? { ...value, locked: true } : value);
    const snapshot = controller.getSnapshot(), signal = batchRequest.current?.signal;
    if (!alive.current || !signal || signal.aborted || snapshot.phase !== 'ready' || snapshot.membership?.user_id !== batchActor.current) throw new Error('A sessão mudou durante a operação. Este cadastro não foi enviado.');
    const path = current.kind === 'situation' ? `${CONTACTS_BASE}/${item.id}/situacao` : `${CONTACTS_BASE}/${item.id}/vendedor`;
    const body = { command_id: crypto.randomUUID(), expected_version: item.version, ...(current.kind === 'situation' ? { situation: current.target } : { seller_id: current.seller?.id ?? null }) };
    const send = async () => {
      const result = await controller.catalog(path, { method: 'PATCH', body, signal }) as { record?: { id?: string; situation?: string; seller_id?: string | null } };
      if (result.record?.id !== item.id || (current.kind === 'situation' ? result.record.situation !== current.target : result.record.seller_id !== (current.seller?.id ?? null))) throw new AccessError(502);
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
    const kind = batch?.kind; setBatch(null); batchRequest.current = null;
    if (results) { setNotice(`${kind === 'seller' ? 'Vincular a vendedor' : 'Mudança de situação'}: ${batchSummaryText(summarizeBatch(results))}.`); clearSelection(); setReload(value => value + 1); }
  };
  const excluded = filters.situation === 'E';
  const trash = () => startBatch({ kind: 'situation', target: excluded ? 'A' : 'E', choosable: false, items: asBatch(selectedItems), locked: false });

  // ---- Tornar vendedor (executa direto; um resultado incerto pode ser conferido com o mesmo comando) ----
  const makeSeller = async (command: SellerCommand) => {
    if (sellerRequest.current) return;
    const request = new AbortController(); sellerRequest.current = request; setSellerCommand({ ...command, busy: true }); setNotice('');
    try {
      const result = await controller.catalog('/v1/cadastros/vendedores/a-partir-do-contato', { method: 'POST', body: { command_id: command.commandId, contact_id: command.contact.id }, signal: request.signal }) as { contact?: { id?: string } };
      if (request.signal.aborted) return;
      if (result.contact?.id !== command.contact.id) throw new AccessError(502);
      setSellerCommand(null); setNotice(`${command.contact.name} agora é vendedor.`); setReload(value => value + 1);
    } catch (failure) {
      if (request.signal.aborted || aborted(failure)) return;
      if (!command.uncertain && failure instanceof AccessError && [400, 403, 404, 409].includes(failure.status)) {
        setSellerCommand(null); setNotice(contactRefusalText(failure) ?? (failure.status === 409 ? 'Este contato já é vendedor ou foi alterado. Atualize a listagem.' : errorText(failure)));
      } else setSellerCommand({ ...command, uncertain: true, busy: false });
    } finally { if (sellerRequest.current === request) sellerRequest.current = null; }
  };

  const rowItems = (item: ContactListItem): RowMenuItem[] => [
    { label: writable ? 'Editar' : 'Visualizar', icon: writable ? 'pen-to-square' : 'eye', onClick: () => open(item) },
    // The contact name never goes to the address (personal data): the ficha reads it by the id.
    { label: 'Ficha financeira', icon: 'file-invoice-dollar', disabled: !FINANCE_READERS.includes(role ?? ''), title: FINANCE_READERS.includes(role ?? '') ? undefined : 'Seu perfil não consulta o financeiro.',
      onClick: () => { setRowMenu(null); navigate(`/financeiro-empresa?${new URLSearchParams({ area: 'ficha', contato: item.id })}`); } },
    { label: 'Tornar vendedor', icon: 'user-tie', disabled: !writable || role !== 'admin' || item.is_seller || item.situation === 'E' || Boolean(sellerCommand),
      title: item.is_seller ? 'Este contato já é vendedor.' : role !== 'admin' ? 'Somente administradores cadastram vendedores.' : item.situation === 'E' ? 'Restaure o cadastro antes.' : undefined,
      onClick: () => void makeSeller({ contact: item, commandId: crypto.randomUUID(), uncertain: false, busy: false }) },
    { label: 'Comentários', icon: 'comments', onClick: () => setComments(item) },
    ...(writable && item.situation !== 'E' ? [{ label: item.active ? 'Inativar' : 'Ativar', icon: item.active ? 'ban' : 'check', separatorBefore: true, onClick: () => startBatch({ kind: 'situation', target: item.active ? 'I' : 'A', choosable: false, items: asBatch([item]), locked: false }) }] : []),
  ];
  const toggleView = (next: 'padrao' | 'customizada') => { if (next === view) return; setViewChoice(next); prefs.saveFilters(next === 'customizada' ? { listagem: 'customizada' } : null); };
  useEffect(() => { if (prefs.pending === 'none' && viewChoice && viewChoice === savedView) setViewChoice(null); }, [prefs.pending, savedView, viewChoice]);

  const chips = [
    ...(filters.situation === 'latest' ? [{ label: 'Exibindo pela ordem de inclusão', onRemove: removeFilter({ situation: 'all' }) }] : []),
    ...(SITUATION_CHIPS[filters.situation] ? [{ label: SITUATION_CHIPS[filters.situation]!, onRemove: removeFilter({ situation: 'all' }) }] : []),
    ...(query ? [{ label: `Pesquisa: ${query}`, onRemove: () => changeList(() => { setQuery(''); setQueryDraft(''); }) }] : []),
    ...(type ? [{ label: `Tipo de contato: ${typeLabel}`, onRemove: () => setType('') }] : []),
    ...(filters.person_type ? [{ label: `Tipo de Pessoa: ${PERSON_FILTERS.find(o => o.value === filters.person_type)?.label}`, onRemove: removeFilter({ person_type: '' }) }] : []),
    ...(filters.seller ? [{ label: `Vendedor: ${filters.seller.name}`, onRemove: removeFilter({ seller: null }) }] : []),
    ...(filters.phone ? [{ label: `Telefone / Celular: ${filters.phone}`, onRemove: removeFilter({ phone: '' }) }] : []),
    ...(filters.email ? [{ label: `E-mail: ${filters.email}`, onRemove: removeFilter({ email: '' }) }] : []),
    ...(filters.state ? [{ label: `Estado (UF): ${filters.state}`, onRemove: removeFilter({ state: '' }) }] : []),
    ...(filters.city ? [{ label: `Município: ${filters.city}`, onRemove: removeFilter({ city: '' }) }] : []),
    ...(period.from || period.to ? [{ label: periodChip(period), onRemove: () => changeList(() => setPeriod(EMPTY_LIST_PERIOD)) }] : []),
    ...(period.field === 'no_purchases' && (period.from || period.to) && filters.sale_statuses.length ? [{ label: `Situações de vendas: ${SALE_STATUS_OPTIONS.filter(o => filters.sale_statuses.includes(o.value)).map(o => o.label).join(', ')}`, onRemove: removeFilter({ sale_statuses: [] }) }] : []),
    ...contactTagChips(filters, tagOptions, removeFilter),
    ...(selectedItems.length ? [{ label: `Selecionados: ${selectedItems.length} ${selectedItems.length === 1 ? 'cadastro' : 'cadastros'}`, onRemove: clearSelection }] : []),
  ];
  const listState = { sort, query, type, filters, period };
  const today = stockDate();
  const cell = (item: ContactListItem, column: string) => {
    if (column === 'name') return <td key={column} className="contact-name-cell">{item.situation === 'E' && <span className="contact-excluded" title="Cadastro excluído" role="img" aria-label="Cadastro excluído"><Icon name="xmark" size={11} /></span>}
      {deepLinked ? <Link className="record-link" to={list.recordPath(item.id)} onClick={event => event.stopPropagation()}>{item.name}</Link> : <button type="button" className="text-button record-link" onClick={event => { event.stopPropagation?.(); openRow(item, event); }}>{item.name}</button>}</td>;
    return <td key={column} className={column === 'code' || column === 'document' ? 'contact-col-optional' : undefined}>{columnText(item, column)}</td>;
  };
  const loadingText = loading ? 'Carregando cadastros…' : page ? page.total === 1 ? '1 cadastro encontrado' : `${page.total} cadastros encontrados` : 'Nenhum cadastro disponível para seu perfil.';
  return <>
    <header className="real-heading catalog-heading"><div className="catalog-title"><h1>{LIST_TITLE.contacts}</h1>{!editing && <OriginSelector label="Tipo de contato" value={typeLabel} options={typeOptions.map(o => o.label)} onChange={label => setType(typeOptions.find(o => o.label === label)?.value ?? '')} />}</div>
      <div className="catalog-heading-actions">{permissions && !writable && <span className="real-mode">Somente consulta</span>}{writable && !editing && <button type="button" className="primary-button" title="Incluir um novo cadastro" onClick={list.create}><Icon name="plus" size={12} />Incluir cadastro</button>}</div></header>
    {notice && <p className="real-success" role="status">{notice}</p>}
    {sellerCommand?.uncertain && <p className="real-alert" role="alert">Não foi possível confirmar se {sellerCommand.contact.name} virou vendedor. <button type="button" className="text-button" disabled={sellerCommand.busy} onClick={() => void makeSeller(sellerCommand)}>Conferir resultado</button></p>}
    {(error || list.error) && <p className="real-alert" role="alert">{error || list.error}<button type="button" className="text-button" onClick={() => { if (permissions) setReload(value => value + 1); else controller.retry(); }}>Tentar novamente</button></p>}
    {list.detailError && <p className="real-alert" role="alert">{list.detailError}<button type="button" className="text-button" onClick={list.closeEditor}>Voltar à listagem</button></p>}
    {page?.scoped && !editing && <p className="real-help">Exibindo somente os contatos do seu vendedor (Preferências › Contato acessível somente ao vendedor vinculado).</p>}
    {editing ? <Editor key={`contacts:${clone ? 'clone' : record?.id || 'new'}:${record?.version || 0}:${list.editorEpoch}`} controller={controller} entity="contacts" record={record} writable={writable} initialValues={clone?.values} cloneOf={clone?.name} onClose={list.closeEditor} onSaved={(saved: CatalogRecord) => {
      setNotice('Cadastro salvo.'); setReload(value => value + 1);
      if (deepLinked && new URLSearchParams(location.search).get('registro') !== saved.id) { navigate(list.recordPath(saved.id)); return; }
      list.setClone(null); list.setRecord(saved); list.setEditorEpoch(value => value + 1);
    }} /> : <form onSubmit={apply} aria-label="Filtros dos cadastros">
      <NativeListLayout filters={<>
        <div className="form-field"><label htmlFor="contact-situation-filter">Situação</label><select id="contact-situation-filter" value={draft.situation} onChange={event => setDraft(previous => ({ ...previous, situation: event.target.value as SituationFilter }))}>{SITUATION_FILTERS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
        <div className="form-field"><label htmlFor="contact-person-filter">Tipo de Pessoa</label><select id="contact-person-filter" value={draft.person_type} onChange={event => setDraft(previous => ({ ...previous, person_type: event.target.value }))}><option value="">Todos</option>{PERSON_FILTERS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
        <SellerPicker controller={controller} id="contact-seller-filter" label="Vendedor" value={draft.seller} onChange={seller => setDraft(previous => ({ ...previous, seller }))} />
        <div className="form-field"><label htmlFor="contact-phone-filter">Telefone / Celular</label><input id="contact-phone-filter" inputMode="tel" maxLength={40} pattern=".*[0-9].*" title="Informe ao menos um dígito do telefone ou celular." value={draft.phone} onChange={event => setDraft(previous => ({ ...previous, phone: event.target.value }))} /></div>
        <div className="form-field"><label htmlFor="contact-email-filter">E-mail</label><input id="contact-email-filter" maxLength={254} value={draft.email} onChange={event => setDraft(previous => ({ ...previous, email: event.target.value }))} /></div>
        <div className="form-field"><label htmlFor="contact-state-filter">Estado</label><select id="contact-state-filter" value={draft.state} onChange={event => setDraft(previous => ({ ...previous, state: event.target.value }))}><option value="">UF ...</option>{UF_OPTIONS.map(uf => <option key={uf} value={uf}>{uf}</option>)}</select></div>
        <div className="form-field"><label htmlFor="contact-city-filter">Município</label><input id="contact-city-filter" maxLength={100} value={draft.city} onChange={event => setDraft(previous => ({ ...previous, city: event.target.value }))} /></div>
        <ContactTagFilters options={tagOptions} tag={draft.tag} priceList={draft.price_list_id} onTag={tag => setDraft(previous => ({ ...previous, tag }))} onPriceList={price_list_id => setDraft(previous => ({ ...previous, price_list_id }))} />
        {period.field === 'no_purchases' && <fieldset className="contact-sale-statuses"><legend>Situações de vendas consideradas no período</legend>{SALE_STATUS_OPTIONS.map(option => <label key={option.value}><input type="checkbox" id={`contact-sale-${option.value}`} checked={draft.sale_statuses.includes(option.value)} onChange={event => setDraft(previous => ({ ...previous, sale_statuses: event.target.checked ? [...previous.sale_statuses, option.value] : previous.sale_statuses.filter(value => value !== option.value) }))} />{option.label}</label>)}<small className="real-help">Sem nenhuma marcada, todas as situações contam.</small></fieldset>}
        <button type="submit" className="primary-button" disabled={loading || !permissions?.read.length}>Filtrar</button>
      </>} actions={<>
        <button type="button" className="action-button" disabled={!page?.total} title={page?.total ? undefined : 'Nenhum contato para exportar'} onClick={() => setExporting(true)}><Icon name="file-export" size={14} />Exportar para a planilha</button>
        <button type="button" className="action-button" disabled={!selectedItems.length} title={selectedItems.length ? 'Etiquetas dos contatos selecionados, com os modelos de Etiquetas customizadas' : 'Selecione os cadastros na listagem'} onClick={() => setLabelsFor(selectedItems.map(item => item.id))}><Icon name="print" size={14} />Imprimir etiquetas</button>
        {writable && <button type="button" className="action-button" disabled={!selectedItems.length} title={selectedItems.length ? undefined : 'Selecione os cadastros na listagem'} onClick={() => startBatch({ kind: 'seller', seller: null, items: asBatch(selectedItems), locked: false })}><Icon name="link" size={14} />Vincular a vendedor</button>}
        {writable && <button type="button" className="action-button" disabled={!selectedItems.length || !tagOptions.loaded || tagOptions.failed} title={selectedItems.length ? tagOptions.failed ? 'Não foi possível carregar as tags.' : undefined : 'Selecione os cadastros na listagem'} onClick={() => changeList(() => setTagBatch(selectedItems.map(item => ({ id: item.id, label: item.name, excluded: item.situation === 'E' }))))}><Icon name="tags" size={14} />Incluir tags para selecionados</button>}
        {writable && excluded && <button type="button" className="action-button" disabled title="O FAGOO preserva o histórico: um cadastro excluído pode ser restaurado, mas não é apagado."><Icon name="trash-alt" size={14} />Excluir definitivamente</button>}
        {writable && <button type="button" className="action-button" disabled={!selectedItems.length || excluded} title={selectedItems.length ? undefined : 'Selecione os cadastros na listagem'} onClick={() => startBatch({ kind: 'situation', target: selectedItems.every(item => item.situation === 'A') ? 'I' : 'A', choosable: true, items: asBatch(selectedItems), locked: false })}><Icon name="adjust" size={14} />Mudar situação de contatos selecionados</button>}
        <div className="contact-more"><h3>Mais ações</h3><h4>Imprimir</h4>
          <button type="button" className="text-button" disabled title="A impressão de contatos agrupados ainda não foi definida no FAGOO.">Contatos agrupados</button>
          <button type="button" className="text-button" disabled={selectedItems.length > 0} title={selectedItems.length ? 'Disponível sem seleção.' : undefined} onClick={() => setPrinting({ kind: 'birthdays', state: listState, columns })}>Aniversariantes</button></div>
        <div className="native-list-summary"><h3>Informações</h3><dl className="native-list-stat"><dt>Quantidade de contatos</dt><dd>{page ? page.total : '—'}</dd></dl>{selectedItems.length > 0 && <dl className="native-list-stat"><dt>Selecionados</dt><dd>{selectedItems.length}</dd></dl>}</div>
        <div className="contact-tools"><h3>Ferramentas do FAGOO</h3><Link to="/tipos-contatos-empresa">Tipos de contatos</Link><Link to="/vendedores-empresa">Vendedores</Link>{writable && <Link to="/importar-contatos">Importar contatos</Link>}</div>
        <p className="real-help">{originIntegrationEnabled(controller.getSnapshot().membership) ? 'Alterações feitas aqui são salvas no FAGOO e enviadas ao Origin pela sincronização; o que mudar no Origin também chega aqui.' : 'Os cadastros e as alterações desta tela são salvos no FAGOO.'}</p>
      </>}>
        <div className="native-list-type"><label htmlFor="catalog-entity">Cadastro</label><select id="catalog-entity" value="contacts" disabled={!permissions?.read.length} onChange={event => list.changeEntity(event.target.value as 'contacts')}>{permissions?.read.map(value => <option key={value} value={value}>{LIST_TITLE[value]}</option>)}</select></div>
        <div className="native-list-toolbar"><div className="form-field"><label htmlFor="catalog-search">Pesquisar cadastros</label><input id="catalog-search" type="search" maxLength={120} value={queryDraft} onChange={event => setQueryDraft(event.target.value)} placeholder="Pesquisar por nome, fantasia, e-mail, CPF ou CNPJ" /></div><button type="submit" className="secondary-button" title="Pesquisar" aria-label="Pesquisar" disabled={loading || !permissions?.read.length}><Icon name="magnifying-glass" size={14} /></button>
          <ContactPeriodPicker period={period} today={today} onApply={next => changeList(() => setPeriod(next))} />
          <ToolButton icon="print" title="Imprimir listagem de contatos" disabled={!page?.total} onClick={() => setPrinting({ kind: 'contacts', state: listState, columns })} />
          {writable && <span className={`contact-trash${selectedItems.length && !excluded ? ' is-armed' : ''}`}><ToolButton icon={excluded ? 'clock-rotate-left' : 'trash-can'} title={excluded ? 'Restaurar selecionados' : 'Excluir selecionados'} disabled={!selectedItems.length} onClick={trash} /></span>}</div>
        <AppliedChips chips={chips} onClear={clear} />
        <div className="catalog-list-controls">{writable && page ? <ListControls checked={allSelected} indeterminate={!allSelected && someSelected} onToggleAll={() => setSelection({ key: listKey, ids: allSelected ? NO_SELECTION : new Set(ids), anchor: null })} onRefresh={() => changeList(() => setReload(value => value + 1))}
            views={<><ViewToggle active={view} onChange={toggleView} />{view === 'customizada' && <button type="button" title="Colunas customizadas" aria-label="Colunas customizadas" disabled={prefs.loading || prefs.pending === 'saving'} onClick={() => setColumnsOpen(true)}><Icon name="sliders" size={13} /></button>}</>} />
          : <><button type="button" className="origin-refresh" title="Recarregar" aria-label="Recarregar" onClick={() => changeList(() => setReload(value => value + 1))} disabled={loading || !permissions?.read.length}><Icon name="rotate-right" size={12} /></button><div className="origin-views"><ViewToggle active={view} onChange={toggleView} />{view === 'customizada' && <button type="button" title="Colunas customizadas" aria-label="Colunas customizadas" disabled={prefs.loading || prefs.pending === 'saving'} onClick={() => setColumnsOpen(true)}><Icon name="sliders" size={13} /></button>}</div></>}
          <div className="real-result-status" role="status">{loadingText}</div></div>
        {(prefs.error || prefs.pending === 'uncertain' || prefs.pending === 'missing') && <p className="real-alert" role="alert">{prefs.error}{prefs.pending === 'uncertain' && <button type="button" className="text-button" onClick={prefs.check}>Conferir resultado</button>}{prefs.pending === 'missing' && <button type="button" className="text-button" onClick={prefs.resend}>Reenviar o mesmo comando</button>}</p>}
        {page && <><div className="table-scroll" tabIndex={0} role="region" aria-label="Cadastros da empresa"><table className="data-table real-table origin-table catalog-table contact-table"><thead><tr>
          {writable && <th scope="col" className="checkbox-cell"><span className="real-sr-only">Seleção</span></th>}
          {columns.map(column => <th scope="col" key={column} className={column === 'code' || column === 'document' ? 'contact-col-optional' : undefined}>{COLUMN_LABELS[column]}</th>)}
          <th scope="col">Marcadores</th><th scope="col" className="row-actions"><span className="real-sr-only">Ações</span></th></tr></thead>
          <tbody>{page.items.map(item => <tr key={item.id} className={`${selected.has(item.id) ? 'selected ' : ''}${item.situation === 'E' ? 'is-excluded' : ''}`.trim() || undefined} onClick={event => openRow(item, event)} onAuxClick={event => { if (event.button === 1 && !fromControl(event.target)) openRow(item, event); }}>
            {writable && <td className="checkbox-cell" onClick={event => event.stopPropagation()}><input type="checkbox" aria-label={`Selecionar ${item.name}`} checked={selected.has(item.id)} onClick={event => toggleRow(item.id, event.shiftKey)} onChange={() => undefined} /></td>}
            {columns.map(column => cell(item, column))}
            <td className="contact-markers"><ContactMarkers set={markers.sets.get(item.id)} failed={markers.failed} /></td>
            <td className="row-actions" onClick={event => event.stopPropagation()}><RowMenu label={item.name} items={rowItems(item)} open={rowMenu === item.id} onToggle={() => setRowMenu(rowMenu === item.id ? null : item.id)} /></td>
          </tr>)}</tbody></table></div>
          {!page.items.length && <div className="origin-empty"><span><Icon name="exclamation" size={22} /></span><h2>Nenhum cadastro encontrado</h2><p>{writable ? 'Inclua um cadastro ou ajuste a pesquisa.' : 'Ajuste a pesquisa ou aguarde o cadastro pela equipe autorizada.'}</p></div>}
          {page.total > 0 && <OriginPagination page={page.page} pages={Math.max(1, Math.ceil(page.total / page.size))} size={page.size} total={page.total} onPage={value => changeList(() => setPageState({ key: filterKey, number: value }))} />}</>}
      </NativeListLayout>
    </form>}
    {batch && plan && <BatchDialog title={batch.kind === 'seller' ? 'Vincular Contatos a Vendedor' : batch.choosable ? 'Mudar situação de contatos selecionados' : batch.target === 'E' ? 'Excluir selecionados' : batch.target === 'A' && batch.items.every(item => item.situation === 'E') ? 'Restaurar selecionados' : batch.target === 'A' ? 'Ativar cadastro' : 'Inativar cadastro'}
      plan={plan} confirmLabel={batch.kind === 'seller' ? 'Ok' : batch.target === 'E' ? 'Excluir' : batch.items.every(item => item.situation === 'E') ? 'Restaurar' : { A: 'Ativar', I: 'Inativar', S: 'Sem movimento', E: 'Excluir' }[batch.target]}
      canConfirm={batch.kind !== 'seller' || Boolean(batch.seller)} run={runItem(batch)} onClose={closeBatch}
      description={batch.kind === 'seller' ? <SellerPicker controller={controller} id="contact-batch-seller" label="Vendedor" value={batch.seller} disabled={batch.locked} onChange={seller => setBatch(current => current && current.kind === 'seller' && !current.locked ? { ...current, seller } : current)} />
        : batch.choosable ? <fieldset className="catalog-batch-target" disabled={batch.locked}><legend>Nova situação</legend>{(['A', 'I', 'S'] as const).map(value => <label key={value}><input type="radio" name="contact-batch-target" checked={batch.target === value} onChange={() => setBatch(current => current && current.kind === 'situation' && !current.locked ? { ...current, target: value } : current)} />{{ A: 'Ativo', I: 'Inativo', S: 'Sem movimento' }[value]}</label>)}</fieldset>
        : batch.target === 'E' ? <p>Os cadastros excluídos saem das listagens e dos seletores de documentos, mas o histórico é preservado e eles podem ser restaurados.</p> : undefined} />}
    {comments && <ContactComments controller={controller} contact={comments} onClose={() => setComments(null)} />}
    {tagBatch && <ContactTagsBatch controller={controller} items={tagBatch} options={tagOptions} writable={writable} onClose={results => { setTagBatch(null); if (results) { setNotice(`Incluir tags para selecionados: ${batchSummaryText(summarizeBatch(results))}.`); clearSelection(); setReload(value => value + 1); } }} />}
    {exporting && <ContactExportDialog controller={controller} state={listState} types={types?.items ?? []} total={page?.total ?? 0} onClose={() => setExporting(false)} />}
    {printing && <ContactListPrint controller={controller} request={printing} types={types?.items ?? []} onClose={() => setPrinting(null)} />}
    {labelsFor && <ContactLabelsPrint controller={controller} ids={labelsFor} onClose={() => setLabelsFor(null)} />}
    {columnsOpen && <ListColumnsPanel columns={CUSTOM_COLUMNS.map(id => ({ id, label: COLUMN_LABELS[id]! }))} selected={columns} fixed={FIXED_COLUMN} busy={prefs.pending === 'saving'} error={prefs.error}
      onCancel={() => setColumnsOpen(false)} onApply={next => { prefs.saveColumns(next); setColumnsOpen(false); }} />}
  </>;
}
