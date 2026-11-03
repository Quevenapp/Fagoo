import { originHistoryAvailable } from '../lib/integration-capabilities';
import StockAvailability from './StockAvailability';
import StockOriginMirror from './StockOriginMirror';
import StockProductSearch from './StockProductSearch';
import StockTransferPanel from './StockTransferPanel';
import { StockEditPanel, StockLaunchPanel, StockReversalForm, type LaunchSuggestion } from './StockMovementPanel';
// 278: Informar lotes de produtos of a recorded line.
import { MovementLotsPanel } from './StockMovementLots';
// 222: compositions in the extrato (structure, saldo virtual, the composition lançamento and its joint reversal).
import { CompositionLaunchPanel, CompositionReversalPanel, StockCompositionBox, compositionLaunch, useStockComposition, type CompositionLaunch } from './StockComposition';
// 258: Controle de lotes (aba "Lotes e validades" and the Lote of the lançamentos and transfers).
import { StockLotsTab, useStockLots } from './StockLots';
// 260: "Exibir localização no controle de estoque" (Preferências › Cadastros › Configurações de produtos).
import { useProductLocation, useStockLocationSettings } from '../lib/stock-location-model';
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChanges';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AccessError, type AccessController } from '../lib/real-access';
import type { CatalogRecord } from '../lib/catalog-model';
import { EMPTY_LEDGER_FILTERS, STOCK_DIRECTION_LABELS, STOCK_LEDGER_SIZE, STOCK_ORIGIN_LABELS, ledgerMoment, ledgerPageCount, ledgerQuery, originHref, originLabel, originReadable, quantityText, stockDate, stockLedgerPage, validLedgerFilters, type StockBalance, type StockDirection, type StockLedgerFilters, type StockLedgerMovement, type StockLedgerPage, type StockOriginType } from '../lib/stock-model';
import { COST_BASIS_LABELS, IGNORED_TITLE, SELECT_PRODUCT_TOAST, TRANSFER_MINIMUM, consideredTotal, contextSuggestion, ledgerNote, linePrices, moneyText, parseLaunchContext, parseReservationPolicy, parseReservations, parseStockTotals, priceDraft, reservedDisplay, stockLevel, type LaunchContext, type ReservationPolicy, type StockReservation, type StockTotals } from '../lib/stock-launch-model';
import { statusLabel } from '../lib/document-list-model';
import { CHECKIN_READERS } from '../lib/receipt-checkin-model';
import { opensInNewTab, periodLabel } from '../lib/origin-list';
import { AppliedChips, OriginFilterPanel, OriginPagination, OriginSelector, PeriodPicker } from './OriginList';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { parseStockPolicy } from '../../../../packages/erp-domain/src/stock-opening-dto.mjs';
import './stock.css';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALL_WAREHOUSES = 'Todos os depósitos';
const readFailure = (error: unknown) => error instanceof AccessError ? error.status === 403 ? 'Seu perfil não permite consultar o estoque.' : error.status === 400 ? 'Confira os filtros dos lançamentos e consulte novamente.' : error.status === 404 ? 'O produto ou o depósito filtrado não está disponível. Limpe os filtros e consulte novamente.' : 'Não foi possível consultar os lançamentos. Tente novamente.' : 'Não foi possível consultar os lançamentos. Tente novamente.';
const safeLedgerQuery = (product: CatalogRecord | null, filters: StockLedgerFilters, page: number) => { if (!product) return ''; try { return ledgerQuery(product.id, filters, page); } catch { return null; } };
const ORIGIN_ICONS: Record<StockOriginType, string | null> = { invoices: 'file-invoice', sales: 'cart-shopping', purchases: 'bag-shopping', services: 'screwdriver-wrench', transfers: 'shuffle', none: null, deleted: 'trash-can' };
type Panel = { type: 'launch' } | { type: 'transfer' } | { type: 'edit'; row: StockLedgerMovement } | { type: 'reverse'; row: StockLedgerMovement } | { type: 'lots'; row: StockLedgerMovement; warehouseId: string }
  | { type: 'composition-launch' } | { type: 'composition-reverse'; launch: CompositionLaunch };

/** Estoque > Lançamentos de estoque like Origin: depósito selector (default warehouse first), product search, extrato with
 * Entrada/Saída/Balanço and prices, side panels for a new lançamento, its edition and transfers. */
export default function RealStock({ controller, onPrepareWarehouses }: { controller: AccessController; onPrepareWarehouses?: () => void }) {
  const navigationGuard = useUnsavedChangesGuard(), navigate = useNavigate(), location = useLocation();
  const snapshot = controller.getSnapshot(), role = snapshot.membership?.role, actor = snapshot.membership?.user_id, writable = role === 'admin' || role === 'estoque';
  const navigationIdentity = useRef({ controller, actor }); navigationIdentity.current = { controller, actor };
  const prepareWarehouses = () => { const allowed = () => navigationIdentity.current.controller === controller && navigationIdentity.current.actor === actor && controller.getSnapshot().phase === 'ready' && controller.getSnapshot().membership?.role === 'admin' && controller.getSnapshot().membership?.user_id === actor; if (allowed() && onPrepareWarehouses) navigationGuard.confirmLeave(() => { if (allowed()) onPrepareWarehouses(); }); };
  // EST-067: /estoque-empresa?produto=<uuid> opens the extrato of that product (Origin estoque.php?buscaid=…).
  const productParam = (() => { const value = new URLSearchParams(location.search).get('produto'); return value && UUID.test(value) ? value.toLowerCase() : null; })();
  const [product, setProduct] = useState<CatalogRecord | null>(null), [productError, setProductError] = useState('');
  const [storedBalances, setBalances] = useState<StockBalance[]>([]), [storedPage, setPage] = useState<StockLedgerPage | null>(null), [storedReservation, setReservation] = useState<ReservationPolicy | null>(null);
  // 145: settings of Preferências > Suprimentos > Estoque and the suggested prices of the manual lançamento (writers only).
  const [launchContext, setLaunchContext] = useState<{ key: string; value: LaunchContext | null } | null>(null);
  const [filters, setFilters] = useState<StockLedgerFilters>(EMPTY_LEDGER_FILTERS), [draft, setDraft] = useState<StockLedgerFilters>(EMPTY_LEDGER_FILTERS), [pageNumber, setPageNumber] = useState(1);
  const [filterOpen, setFilterOpen] = useState(false), [showTotals, setShowTotals] = useState(true);
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [reload, setReload] = useState(0), [panel, setPanel] = useState<Panel | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null), [attention, setAttention] = useState(false);
  const [totals, setTotals] = useState<StockTotals | null>(null), [totalsKey, setTotalsKey] = useState(''), [warehouseChosen, setWarehouseChosen] = useState(false);
  const [reservations, setReservations] = useState<{ key: string; items: StockReservation[]; total: number; quantity: string } | null>(null), [reservationsOpen, setReservationsOpen] = useState(false), [reservationsError, setReservationsError] = useState('');
  // Optional, read-only: screens explain refusals with the company "Permitir estoque negativo" policy.
  const [negativeAllowed, setNegativeAllowed] = useState<boolean | null>(null);
  useEffect(() => { const read = (controller as { stockOpening?: (path: string, options?: { method?: 'GET'; signal?: AbortSignal }) => Promise<unknown> }).stockOpening; if (typeof read !== 'function') return;
    const request = new AbortController(); void Promise.resolve().then(() => read('/v1/politica-estoque', { method: 'GET', signal: request.signal })).then(raw => { if (!request.signal.aborted) setNegativeAllowed(parseStockPolicy(raw).policy.allow_negative); }).catch(() => {});
    return () => request.abort(); }, [controller]);
  // Another actor never inherits this actor's panel, filters or pending command.
  const lastActor = useRef(actor);
  useEffect(() => { if (lastActor.current === actor) return; lastActor.current = actor; setPanel(null); setNotice(''); setReservations(null); setReservationsOpen(false); setReload(value => value + 1); }, [actor]);

  // Warehouse options, the default warehouse and the totalizer without product (GET /v1/estoque/totais, migration 105).
  const totalsQuery = `${filters.warehouse_id}:${reload}:${actor ?? ''}`;
  useEffect(() => {
    const request = new AbortController(), warehouse = filters.warehouse_id || null;
    void Promise.resolve().then(() => controller.stock(`/v1/estoque/totais${warehouse ? `?warehouse_id=${warehouse}` : ''}`, { signal: request.signal })).then(raw => {
      if (request.signal.aborted) return;
      const value = parseStockTotals(raw, warehouse);
      setTotals(value); setTotalsKey(totalsQuery);
      if (!warehouseChosen) {
        // Origin opens the extrato in the depósito padrão.
        const standard = value.warehouses.find(item => item.is_default && item.active);
        if (standard) { setFilters(previous => ({ ...previous, warehouse_id: standard.id })); setDraft(previous => ({ ...previous, warehouse_id: standard.id })); }
        setWarehouseChosen(true);
      }
    }).catch(problem => { if (!request.signal.aborted && !aborted(problem)) { setTotals(null); if (!warehouseChosen) setWarehouseChosen(true); } });
    return () => request.abort();
  }, [controller, totalsQuery]);
  // The product comes from the URL: a search choice, a deep link or Back/Forward all read the same record.
  useEffect(() => {
    setProduct(previous => previous?.id === productParam ? previous : null); setProductError(''); setPanel(null); setPageNumber(1); setReservations(null); setReservationsOpen(false);
    if (!productParam) return;
    const request = new AbortController();
    void controller.catalog(`/v1/cadastros/products/${productParam}`, { signal: request.signal }).then(raw => {
      const record = (raw as { record?: CatalogRecord })?.record;
      if (request.signal.aborted) return;
      if (!record || record.id !== productParam) throw new AccessError(502);
      setProduct(record);
    }).catch(problem => { if (!request.signal.aborted && !aborted(problem)) setProductError(problem instanceof AccessError && problem.status === 404 ? 'Produto Inexistente.' : problem instanceof AccessError && problem.status === 403 ? 'Seu perfil não permite consultar este produto.' : 'Não foi possível abrir o produto. Tente novamente.'); });
    return () => request.abort();
  }, [controller, productParam]);
  const shownProduct = product && product.id === productParam ? product : null;
  const composition = useStockComposition(controller, shownProduct, reload);
  // 258: lots of a simple product; the tab appears with "Controle de lote" on or when the product already has lots.
  const lotInfo = useStockLots(controller, shownProduct?.format === 'S' ? shownProduct.id : null, null, 'todos', reload);
  const lotControl = lotInfo.page?.product.lot_control === true, lotTab = lotControl || (lotInfo.page?.total ?? 0) > 0;
  const locationSettings = useStockLocationSettings(controller), productLocation = useProductLocation(controller, shownProduct?.id ?? null, locationSettings.ledger);
  const [tab, setTab] = useState<'launches' | 'lots'>('launches');
  useEffect(() => { setTab('launches'); }, [productParam]);
  // A structure that could not be read blocks the lançamento with that reason, never with "informe a estrutura".
  const kitLaunch = shownProduct?.format === 'E' ? composition.error ? { block: 'Não foi possível consultar a estrutura da composição. Use “Atualizar saldos”.', mode: 'common' as const } : compositionLaunch(composition.view, composition.loading) : null;
  const query = warehouseChosen ? safeLedgerQuery(shownProduct, filters, pageNumber) : '';
  const readKey = shownProduct && query ? `${shownProduct.id}:${query}:${reload}` : null;
  const readReady = Boolean(readKey && readKey === loadedKey);
  const balances = readReady ? storedBalances : [], page = readReady ? storedPage : null;
  const reservation = readReady ? storedReservation : null;
  useEffect(() => {
    setLoadedKey(null); setBalances([]); setPage(null); if (!shownProduct || !warehouseChosen) { setLoading(false); return; }
    if (!query) { setLoading(false); setError('Confira os filtros dos lançamentos e consulte novamente.'); return; }
    const request = new AbortController(); setLoading(true); setError('');
    void Promise.all([controller.stock(`/v1/estoque/saldos?product_id=${shownProduct.id}`, { signal: request.signal }), controller.stock(`/v1/estoque/movimentos?${query}`, { signal: request.signal })]).then(([balanceResult, movementResult]) => {
      if (request.signal.aborted) return;
      const nextBalances = balanceResult as { product_id: string; items: StockBalance[]; reservation?: unknown; data_mode: string };
      if (nextBalances.product_id !== shownProduct.id || nextBalances.data_mode !== 'erp_native' || !Array.isArray(nextBalances.items)) throw new AccessError(502);
      let nextPage: StockLedgerPage, nextReservation: ReservationPolicy | null; try { nextPage = stockLedgerPage(movementResult, shownProduct.id, filters, pageNumber); nextReservation = parseReservationPolicy(nextBalances.reservation); } catch { throw new AccessError(502); }
      setBalances(nextBalances.items); setPage(nextPage); setReservation(nextReservation); setLoadedKey(readKey);
    }).catch(problem => { if (!request.signal.aborted && !aborted(problem)) setError(readFailure(problem)); }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [controller, shownProduct, query, reload, warehouseChosen]);

  // The context is read again for each product, actor and reload; a late answer of another product is ignored.
  const contextKey = writable && shownProduct ? `${shownProduct.id}:${actor ?? ''}:${reload}` : '';
  useEffect(() => {
    if (!contextKey || !shownProduct) return;
    const request = new AbortController(), product = shownProduct.id;
    void Promise.resolve().then(() => controller.stock(`/v1/estoque/sugestao?product_id=${product}`, { signal: request.signal })).then(raw => { if (!request.signal.aborted) setLaunchContext({ key: contextKey, value: parseLaunchContext(raw, product) }); })
      .catch(problem => { if (!request.signal.aborted && !aborted(problem)) setLaunchContext({ key: contextKey, value: null }); });
    return () => request.abort();
  }, [controller, contextKey]);
  const contextReady = !contextKey || launchContext?.key === contextKey, context = contextKey && launchContext?.key === contextKey ? launchContext.value : null;
  const editing = panel !== null;
  const chooseProduct = (record: CatalogRecord | null) => { if (editing) return; setNotice(''); navigate(record ? `/estoque-empresa?produto=${record.id}` : '/estoque-empresa'); };
  // Every filter change returns to page 1; an open panel keeps the list frozen (controls are disabled).
  const applyFilters = (patch: Partial<StockLedgerFilters>) => {
    if (editing) return;
    const next = { ...filters, ...patch };
    if (!validLedgerFilters(next)) { setError('Informe datas válidas para o período.'); return; }
    setFilters(next); setDraft(previous => ({ ...previous, direction: next.direction, origin: next.origin })); setPageNumber(1); setNotice('');
  };
  const today = stockDate();
  // Origin lists only active warehouses; an archived one appears only while it is the current filter.
  const options = useMemo(() => {
    const rows = (totals?.warehouses ?? []).filter(item => item.active || item.id === filters.warehouse_id);
    const labels = new Map<string, string>();
    for (const row of rows) { const base = `${row.name}${row.active ? '' : ' · inativo'}`; let label = base; for (let copy = 2; labels.has(label) || label === ALL_WAREHOUSES; copy++) label = `${base} (${copy})`; labels.set(label, row.id); }
    return labels;
  }, [totals, filters.warehouse_id]);
  const warehouseLabel = filters.warehouse_id ? [...options].find(([, id]) => id === filters.warehouse_id)?.[0] ?? 'Depósito selecionado' : ALL_WAREHOUSES;
  const chooseWarehouse = (label: string) => { const id = label === ALL_WAREHOUSES ? '' : options.get(label); if (id !== undefined && id !== filters.warehouse_id) applyFilters({ warehouse_id: id }); };
  const chips = [
    ...(filters.direction ? [{ label: `Tipo: ${STOCK_DIRECTION_LABELS[filters.direction]}`, onRemove: () => applyFilters({ direction: '' }) }] : []),
    ...(filters.origin ? [{ label: `Tipo de Origem: ${STOCK_ORIGIN_LABELS[filters.origin]}`, onRemove: () => applyFilters({ origin: '' }) }] : []),
    ...(filters.from || filters.to ? [{ label: `Período: ${periodLabel(filters.from, filters.to, today)}`, onRemove: () => applyFilters({ from: '', to: '' }) }] : []),
  ];
  // Plain click opens the source document here (after the unsaved-changes guard); Ctrl/Cmd/Shift or middle click keep the browser's new tab.
  const openOrigin = (event: MouseEvent<HTMLAnchorElement>, href: string) => { event.stopPropagation(); if (opensInNewTab(event) || event.shiftKey || event.altKey) return; event.preventDefault(); navigationGuard.confirmLeave(() => navigate(href)); };
  const productUnit = typeof shownProduct?.unit === 'string' ? shownProduct.unit : '';
  // Origin's product title: "<SKU> - <DESCRIÇÃO> - Unidade: <UN>".
  const productTitle = shownProduct ? [shownProduct.code, shownProduct.name, `Unidade: ${productUnit || 'não informada'}`].filter(Boolean).join(' - ') : '';
  const activeWarehouses = (totals?.warehouses ?? []).filter(item => item.active).length;
  const selectedBalance = filters.warehouse_id ? balances.find(item => item.warehouse_id === filters.warehouse_id) ?? null : null;
  const launchBlock = !shownProduct ? null : !shownProduct.active ? 'Produto inativo.' : shownProduct.kind !== 'P' ? 'Movimentações exigem cadastro do tipo produto.' : shownProduct.format === 'V' ? 'Produtos com variações não recebem novos lançamentos.' : !shownProduct.unit ? 'Informe a unidade do produto.' : kitLaunch?.block ?? null;
  // A Virtual composition has no stock of its own: Balanço and transferência belong to its components.
  const transferBlock = shownProduct?.format === 'E' && composition.view?.composition?.stock_type !== 'physical' ? 'A composição Virtual não tem estoque próprio: transfira os componentes.' : null;
  const startLaunch = () => {
    if (editing || loading || !contextReady) return;
    if (!shownProduct) { setNotice(''); setError(SELECT_PRODUCT_TOAST); return; }
    if (launchBlock || !selectedBalance?.warehouse_active) return;
    setNotice(''); setPanel({ type: kitLaunch?.mode === 'composition' ? 'composition-launch' : 'launch' });
  };
  const startTransfer = () => { if (editing || loading || !shownProduct || launchBlock || transferBlock || !contextReady) return; if (activeWarehouses < 2) { setAttention(true); return; } setPanel({ type: 'transfer' }); };
  const lastPriced = page?.items.find(row => row.price_source === 'detail' && (row.balance || row.items.some(line => !line.quantity.startsWith('-'))));
  // 145: the prices follow Preferências > Suprimentos > Estoque; without that answer the wave A suggestion (this extrato page) stays.
  const preferred = context ? contextSuggestion(context, shownProduct?.price) : null;
  const suggestion: LaunchSuggestion = preferred ? { sale: preferred.sale, purchase: preferred.purchase, cost: preferred.cost } : { sale: priceDraft(shownProduct?.price), purchase: priceDraft(lastPriced?.unit_price), cost: priceDraft(lastPriced?.unit_cost) };
  const warehouseName = (id: string) => balances.find(balance => balance.warehouse_id === id)?.warehouse_name ?? totals?.warehouses.find(item => item.id === id)?.name ?? 'Depósito';
  const allView = !filters.warehouse_id;
  const amount = (line: { unit: string }, value: string) => <>{quantityText(value)}{line.unit !== productUnit && <small> {line.unit}</small>}</>;
  const totalUnit = page?.totals.unit || productUnit;
  const backdated = Boolean(page?.items.some(item => ledgerMoment(item).backdated));
  // 227: a Virtual composition shows the saldo virtual of its components instead of a ledger of its own.
  const virtualBalance = balances.some(item => item.virtual) ? (filters.warehouse_id ? selectedBalance?.quantity ?? '0.000000' : consideredTotal(balances)) : null;
  const currentBalance = virtualBalance ?? page?.totals.current_balance ?? '0.000000';
  const level = page ? stockLevel(currentBalance, shownProduct?.stock_min, shownProduct?.stock_max) : null;
  // Reservado: the chosen warehouse, or the considered ones in "Todos" (an ignored warehouse's reservations stay out, as in Origin);
  // a reservation by sale situation that is not per warehouse counts for every considered warehouse.
  const reservedText = useMemo(() => reservedDisplay(balances, filters.warehouse_id, reservation), [balances, filters.warehouse_id, reservation]);
  const reservationKey = shownProduct ? `${shownProduct.id}:${filters.warehouse_id}:${readKey}` : '';
  const live = useRef({ reservationKey }); live.current = { reservationKey };
  const openReservations = () => {
    if (!shownProduct || !readReady) return;
    setReservationsOpen(value => !value);
    if (reservations?.key === reservationKey) return;
    const key = reservationKey, warehouse = filters.warehouse_id || null; setReservationsError('');
    void controller.stock(`/v1/estoque/reservas?product_id=${shownProduct.id}${warehouse ? `&warehouse_id=${warehouse}` : ''}`).then(raw => {
      if (key !== live.current.reservationKey) return;
      setReservations({ key, ...parseReservations(raw, shownProduct.id, warehouse) });
    }).catch(() => { if (key === live.current.reservationKey) setReservationsError('Não foi possível consultar as vendas com reserva.'); });
  };
  const closePanel = () => setPanel(null);
  const saved = (message: string) => { setPanel(null); setNotice(message); setPageNumber(1); setReload(value => value + 1); };
  const openRow = (row: StockLedgerMovement) => { if (!editing && readReady) setPanel({ type: 'edit', row }); };
  const rowKey = (event: KeyboardEvent<HTMLTableRowElement>, row: StockLedgerMovement) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openRow(row); } };
  // 222: a lançamento of a composition moves several positions; it is reversed as a whole from the composition's extrato.
  const reversalBlock = (row: StockLedgerMovement) => row.origin.type === 'invoices' ? 'Lançamento da nota fiscal: estorne pela nota (⋮ Estornar estoque).' : row.origin.document_id ? 'Estorne pelo documento de origem.' : row.reference?.startsWith('Composição ') && (row.other_items > 0 || row.items.some(line => line.product_id !== shownProduct?.id)) ? 'Lançamento de composição: estorne pelo extrato da composição (Lançamentos da composição).' : row.other_items > 0 || row.items.some(line => line.product_id !== shownProduct?.id) ? 'Este lançamento inclui outros produtos e precisa de estorno conjunto.' : null;
  const needsWrite = panel && panel.type !== 'edit';
  // The prices of a document lançamento are that document's data (105): only its readers edit them.
  // 259: the prices of a lançamento of a note are the note's items: read-only here.
  const priceEditable = (row: StockLedgerMovement) => row.origin.type !== 'invoices' && (!row.origin.document_kind || originReadable(row.origin, role));
  return <>{originHistoryAvailable(snapshot.membership)&&<StockOriginMirror controller={controller} productId={productParam} /> }
    <div className="stock-native-heading"><span className="stock-source-badge">Origem FAGOO</span><h2>Estoque nativo do FAGOO</h2><p className="real-help">Saldos, reservas e lançamentos registrados no FAGOO.</p></div>
    {role === 'admin' && onPrepareWarehouses && <p><button type="button" className="text-button" onClick={prepareWarehouses}>Preparar depósitos do Origin</button></p>}
    <header className="real-heading"><div className="stock-title"><h1>Estoque</h1><span className="origin-title-divider" aria-hidden="true" /><fieldset className="stock-inline-fieldset" disabled={editing}><legend className="real-sr-only">Depósito dos lançamentos</legend><OriginSelector label="Depósito" value={warehouseLabel} options={[ALL_WAREHOUSES, ...options.keys()]} onChange={chooseWarehouse} /></fieldset></div><span className="real-mode">{writable ? 'Edição autorizada' : 'Somente consulta'}</span></header>
    <p className="real-notice">Movimentos desta área atualizam o estoque do FAGOO e podem ser corrigidos por estorno, preservando o histórico.{negativeAllowed !== null && <> Estoque negativo: <strong>{negativeAllowed ? 'permitido' : 'não permitido'}</strong> pela política da empresa.</>}</p>
    {notice && <p className="real-success" role="status">{notice}</p>}{(error || productError) && <p className="real-alert" role="alert">{productError || error}</p>}
    <fieldset className="stock-ledger-controls" disabled={editing}><legend className="real-sr-only">Produto e filtros dos lançamentos</legend>
      <div className="origin-toolbar stock-ledger-toolbar"><button type="button" className={`origin-filter-toggle${filterOpen ? ' is-open' : ''}`} title="Abrir filtro" aria-label={filterOpen ? 'Minimizar filtros' : 'Abrir filtro'} aria-expanded={filterOpen} onClick={() => { setDraft(previous => ({ ...previous, direction: filters.direction, origin: filters.origin })); setFilterOpen(value => !value); }}><Icon name="filter" size={13} /></button>
        <StockProductSearch controller={controller} selected={shownProduct} disabled={editing} onSelect={chooseProduct} />
        <PeriodPicker from={filters.from} to={filters.to} today={today} onApply={range => applyFilters({ from: range.from, to: range.to })} /></div>
      <AppliedChips chips={chips} onClear={() => applyFilters({ direction: '', origin: '', from: '', to: '' })} />
      {filterOpen && <OriginFilterPanel open={filterOpen} onClose={() => setFilterOpen(false)} onApply={() => applyFilters({ direction: draft.direction, origin: draft.origin })}>
        <label htmlFor="stock-filter-direction">Tipo<select id="stock-filter-direction" value={draft.direction} onChange={event => setDraft(previous => ({ ...previous, direction: event.target.value as StockLedgerFilters['direction'] }))}><option value="">Todos</option>{(Object.keys(STOCK_DIRECTION_LABELS) as StockDirection[]).map(value => <option value={value} key={value}>{STOCK_DIRECTION_LABELS[value]}</option>)}</select></label>
        <label htmlFor="stock-filter-origin">Tipo de Origem<select id="stock-filter-origin" value={draft.origin} onChange={event => setDraft(previous => ({ ...previous, origin: event.target.value as StockLedgerFilters['origin'] }))}><option value="">Todos</option>{(Object.keys(STOCK_ORIGIN_LABELS) as StockOriginType[]).map(value => <option value={value} key={value}>{STOCK_ORIGIN_LABELS[value]}</option>)}</select></label>
        <p className="real-help">Transferências e estornos aparecem como Entrada ou Saída pelo sinal. Notas Fiscais são os lançamentos de estoque feitos pela nota do FAGOO (⋮ Lançar estoque e o Check-in de Recebimentos); documentos não são excluídos, por isso não há “Origem excluída”.</p>
      </OriginFilterPanel>}
    </fieldset>
    <div className="stock-workspace"><div className="stock-main">
      {!shownProduct ? <section className="real-records stock-empty"><div className="origin-empty"><span><Icon name="exclamation" size={22} /></span><h2>Informe um produto</h2><p>Para realizar a consulta de estoque você deve informar um produto.</p></div></section> : <>
      <section className="real-records stock-product"><div className="stock-product-heading"><h2>{productTitle}{productLocation && <small className="stock-product-location">Localização: {productLocation}</small>}</h2><div className="real-editor-actions"><button className="secondary-button" disabled={loading || editing} onClick={() => setReload(value => value + 1)}>Atualizar saldos</button></div></div>{loading && <p role="status">Consultando saldos…</p>}{readReady && <StockAvailability controller={controller} productId={shownProduct.id} warehouses={balances} basis={readKey!} blocked={editing} />}{launchBlock && <p className="real-help">{launchBlock} O histórico e os estornos permanecem disponíveis.</p>}
        {shownProduct.format === 'E' && <StockCompositionBox view={composition.view} error={composition.error} launches={composition.launches} writable={writable} onReverse={launch => { if (!editing) setPanel({ type: 'composition-reverse', launch }); }} />}</section>
      <section className="real-records stock-launches"><div className="stock-tabs">{lotTab ? <div className="origin-list-tabs stock-ledger-tabs" role="tablist" aria-label="Lançamentos e lotes">
          <button type="button" role="tab" aria-selected={tab === 'launches'} disabled={editing} onClick={() => setTab('launches')}>Lançamentos</button>
          <button type="button" role="tab" aria-selected={tab === 'lots'} disabled={editing} onClick={() => setTab('lots')}>Lotes e validades</button></div> : <h2>Lançamentos</h2>}</div>
        {lotTab && tab === 'lots' && <StockLotsTab controller={controller} productId={shownProduct.id} unit={productUnit} warehouseId={filters.warehouse_id} warehouseLabel={warehouseLabel} writable={writable} reload={reload} frozen={editing} onChanged={message => { setNotice(message); setReload(value => value + 1); }} />}
        {page && !(lotTab && tab === 'lots') && <>{backdated && <p className="real-help stock-backdated-help">Lançamentos com data retroativa aparecem na data informada e mostram quando foram registrados; o saldo de cada linha é o do depósito no momento do registro.</p>}<div className="table-scroll" tabIndex={0} role="region" aria-label="Lançamentos de estoque"><table className="data-table real-table stock-launches-table"><thead><tr><th>Data</th>{allView && <th>Depósito</th>}<th className="numeric">Entrada</th><th className="numeric">Saída</th><th className="numeric">Preço de Venda</th><th className="numeric">Preço de Compra</th><th className="numeric">Preço de Custo <span className="stock-info" title="Preço de compra + impostos + frete + outras despesas" aria-label="Preço de compra + impostos + frete + outras despesas"><Icon name="circle-info" size={10} /></span></th><th>Observação</th><th>Origem</th></tr></thead><tbody>{page.items.map(item => {
          const lines = item.items.filter(line => line.product_id === shownProduct.id && (!filters.warehouse_id || line.warehouse_id === filters.warehouse_id));
          const moment = ledgerMoment(item), href = originReadable(item.origin, role) ? originHref(item.origin) : null, icon = ORIGIN_ICONS[item.origin.type];
          const status = item.reversed_by ? 'Estornado' : item.kind === 'reversal' ? 'Estorno' : null;
          return <tr key={item.id} className={`stock-row${item.balance ? ' is-balance' : ''}`} tabIndex={0} aria-label={`Abrir lançamento de ${moment.date}`} onClick={() => openRow(item)} onKeyDown={event => rowKey(event, item)}>
            <td className="stock-date">{moment.backdated ? <>{moment.date}<small className="stock-recorded">Registrado em {moment.recorded}</small></> : <>{moment.date} {moment.time}</>}</td>
            {allView && <td>{lines.map((line, index) => <div className="stock-line" key={index}>{warehouseName(line.warehouse_id)}</div>)}</td>}
            <td className="numeric">{lines.map((line, index) => <div className="stock-line" key={index}>{item.balance ? amount(line, item.balance.counted) : line.quantity.startsWith('-') ? '' : amount(line, line.quantity)}</div>)}</td>
            <td className="numeric">{lines.map((line, index) => <div className="stock-line" key={index}>{item.balance ? '-' : line.quantity.startsWith('-') ? amount(line, line.quantity.slice(1)) : ''}</div>)}</td>
            {(['sale', 'purchase', 'cost'] as const).map(column => <td className="numeric" key={column}>{lines.map((line, index) => <div className="stock-line" key={index}>{linePrices(item, line)[column]}</div>)}</td>)}
            <td>{ledgerNote(item)}{item.reference && !item.origin.document_id && <small className="stock-reference">{item.reference}</small>}{status && <small className="stock-reference">{status}</small>}</td>
            <td className="stock-origin">{item.balance ? <strong>Balanço</strong> : <>{icon && <Icon name={icon} size={11} />}{href ? <a href={href} onClick={event => openOrigin(event, href)}>{originLabel(item.origin)}</a> : item.origin.document_id ? <span title={item.origin.type === 'deleted' ? 'O documento de origem foi excluído; o lançamento continua no saldo.' : 'Seu perfil não permite abrir este tipo de documento.'}>{originLabel(item.origin)}</span> : <span className="stock-origin-none">{originLabel(item.origin)}</span>}{item.origin.via === 'purchase_receipt' && <small className="stock-reference">Recebimento de compra</small>}</>}</td>
          </tr>; })}</tbody></table></div>{!page.items.length && <p className="empty-state">{chips.length ? 'Nenhum lançamento encontrado com os filtros aplicados.' : 'Nenhum lançamento registrado para este produto.'}</p>}{page.total > 0 && <fieldset className="stock-inline-fieldset stock-pagination" disabled={editing}><legend className="real-sr-only">Páginas dos lançamentos</legend><OriginPagination page={pageNumber} pages={ledgerPageCount(page.total)} size={STOCK_LEDGER_SIZE} total={page.total} onPage={target => { if (!editing && target !== pageNumber) setPageNumber(target); }} /></fieldset>}</>}
      </section></>}
    </div><aside className="stock-aside" aria-label="Ações e totais do estoque">
      {writable && filters.warehouse_id && <button type="button" className="primary-button stock-include" disabled={editing || loading || !contextReady || (shownProduct !== null && (Boolean(launchBlock) || !selectedBalance?.warehouse_active))} title={launchBlock ?? undefined} onClick={startLaunch}><Icon name="plus" size={12} />Incluir lançamento</button>}
      {shownProduct && <a className="action-button" href={`/cadastros-reais?cadastro=products&registro=${shownProduct.id}`} onClick={event => { if (opensInNewTab(event) || event.shiftKey) return; event.preventDefault(); navigationGuard.confirmLeave(() => navigate(`/cadastros-reais?cadastro=products&registro=${shownProduct.id}`)); }}><Icon name="external-link-alt" size={14} />Gerenciar produtos</a>}
      {writable && shownProduct && <button type="button" className="action-button" disabled={editing || loading || Boolean(launchBlock) || Boolean(transferBlock) || !readReady || !contextReady} title={transferBlock ?? undefined} onClick={startTransfer}><Icon name="shuffle" size={14} />Transferência entre depósitos</button>}
      {/* 147: the menu entry Estoque > Compras > Check-in de Recebimentos waits for the home shortcut catalog (preferências lane). */}
      {CHECKIN_READERS.includes(role ?? '') && <a className="action-button" href="/checkin-recebimentos" onClick={event => { if (opensInNewTab(event) || event.shiftKey) return; event.preventDefault(); navigationGuard.confirmLeave(() => navigate('/checkin-recebimentos')); }}><Icon name="clipboard-list" size={14} />Check-in de Recebimentos</a>}
      {/* 146: "Ver relatórios de compras e estoque" (menu footer) waits for the same catalog. */}
      <a className="action-button" href="/relatorios-estoque" onClick={event => { if (opensInNewTab(event) || event.shiftKey) return; event.preventDefault(); navigationGuard.confirmLeave(() => navigate('/relatorios-estoque')); }}><Icon name="chart-column" size={14} />Ver relatórios de compras e estoque</a>
      <button type="button" className="action-button" aria-expanded={showTotals} aria-controls="stock-ledger-totals" onClick={() => setShowTotals(value => !value)}><Icon name={showTotals ? 'eye-slash' : 'eye'} size={14} />{showTotals ? 'Esconder totalizador do estoque' : 'Mostrar totalizador estoque'}</button>
      {showTotals && !shownProduct && totals && totalsKey === totalsQuery && <><dl id="stock-ledger-totals" className="stock-totals" aria-label="Totalizador estoque"><div><dt>Quantidade de Itens em Estoque</dt><dd className={totals.quantity.startsWith('-') ? 'is-negative' : undefined}>{quantityText(totals.quantity)}</dd></div><div><dt>Valor de Custo do Estoque</dt>{totals.cost_visible && totals.cost_value !== null ? <dd>{moneyText(totals.cost_value)}</dd> : <dd title="O custo médio vem dos preços de compra, que seu perfil não consulta.">Indisponível</dd>}</div><div><dt>Valor de Venda do Estoque</dt><dd>{moneyText(totals.sale_value)}</dd></div></dl>
        <p className="real-help">{filters.warehouse_id ? `Saldo registrado em ${warehouseLabel}.` : `Soma dos depósitos considerados${totals.ignored_warehouses ? `; ${totals.ignored_warehouses} depósito(s) com saldo desconsiderado ficam de fora` : ''}.`} O valor de venda usa o preço de venda do cadastro{totals.unpriced_products ? `; ${totals.unpriced_products} produto(s) sem preço não entram` : ''}. {totals.cost_visible ? `O valor de custo usa o custo médio de cada produto, calculado pelo ${COST_BASIS_LABELS[totals.cost_basis]} dos lançamentos de entrada (Preferências › Suprimentos › Estoque)${totals.uncosted_products ? `; ${totals.uncosted_products} produto(s) sem custo médio não entram` : ''}.` : 'O valor de custo usa preços de compra, que seu perfil não consulta.'}</p></>}
      {showTotals && shownProduct && page && level && <><dl id="stock-ledger-totals" className="stock-totals" aria-label="Totalizador estoque"><div className="stock-total-entries"><dt>Entradas</dt><dd>{quantityText(page.totals.entries)} <small>{totalUnit}</small></dd></div><div><dt>Saídas</dt><dd>{quantityText(page.totals.exits)} <small>{totalUnit}</small></dd></div><div><dt><span className={`stock-level is-${level.tone}`} title={level.title} aria-label={level.title} role="img"><Icon name="cube" size={12} /></span>Saldo atual</dt><dd className={currentBalance.startsWith('-') ? 'is-negative' : undefined}>{quantityText(currentBalance)} <small>{totalUnit}</small>{virtualBalance !== null && <small className="stock-reference">Estoque virtual (componentes)</small>}</dd></div>
          <div><dt>Reservado <button type="button" className="text-button stock-reserved-toggle" aria-expanded={reservationsOpen} disabled={!readReady} onClick={openReservations}><Icon name="circle-info" size={11} />Visualizar vendas</button></dt><dd>{quantityText(reservedText)} <small>{totalUnit}</small></dd></div></dl>
        {reservationsOpen && <div className="stock-reservations" role="region" aria-label="Vendas com reserva">{reservationsError ? <p className="real-alert" role="alert">{reservationsError}</p> : reservations?.key !== reservationKey ? <p role="status">Consultando vendas…</p> : reservations.items.length === 0 ? <p className="real-help">Nenhuma venda com reserva ativa.</p>
          : <table className="stock-balances"><thead><tr><th>Número do pedido</th><th>Cliente</th><th>Situação</th><th className="numeric">Qtd. reservada</th></tr></thead><tbody>{reservations.items.map(item => <tr key={item.reservation_id ?? `${item.document_id}:${item.warehouse_id ?? 'todos'}`} className={item.warehouse_ignored ? 'is-ignored' : undefined}><td><a href={`/documentos-empresa?tipo=sales_orders&documento=${item.document_id}`} onClick={event => openOrigin(event, `/documentos-empresa?tipo=sales_orders&documento=${item.document_id}`)}>{item.document_number}</a></td><td>{item.contact_name ?? '—'}</td><td>{item.situation_name ?? statusLabel('sales_orders', item.status)}{item.source === 'situation' && <small className="stock-reference">Reserva pela situação{item.warehouse_id ? '' : ' · todos os depósitos'}</small>}{item.warehouse_ignored && <small className="stock-reference">{IGNORED_TITLE}</small>}</td><td className="numeric">{quantityText(item.quantity)}</td></tr>)}</tbody></table>}
          {reservations && reservations.total > reservations.items.length && <p className="real-help">Mostrando {reservations.items.length} de {reservations.total} vendas.</p>}</div>}
        <p className="real-help">Entradas e saídas somam todos os lançamentos filtrados, em todas as páginas, sem os balanços. Saldo atual: {filters.warehouse_id ? `registrado em ${warehouseLabel}` : 'soma dos depósitos considerados'}.{reservation?.by_situation ? ` Reservado inclui os pedidos de venda nas situações marcadas em Preferências › Suprimentos › Estoque, sem estoque lançado${reservation.by_warehouse ? ', no depósito do pedido (ou no depósito padrão)' : ', valendo para todos os depósitos considerados'}. Essa reserva não impede lançamentos.` : ''}</p></>}
      {shownProduct && <><h3>Saldos por depósito</h3>{balances.length > 0 && <table className="stock-balances"><thead><tr><th>Depósito</th><th className="numeric">Saldo</th></tr></thead><tbody>{balances.filter(item => item.warehouse_active || item.version > 0).map(item => <tr key={item.warehouse_id} className={item.warehouse_ignored ? 'is-ignored' : undefined} title={item.warehouse_ignored ? IGNORED_TITLE : undefined}><td>{item.warehouse_name}{item.warehouse_active ? '' : ' · inativo'}{item.warehouse_ignored && <small>{IGNORED_TITLE}</small>}</td><td className="numeric">{item.virtual ? <>{quantityText(item.quantity)} <small className="stock-unit">{item.unit}</small><small>virtual</small></> : item.version === 0 ? <>Sem lançamentos<small>Abertura a conferir</small></> : <span className={item.quantity.startsWith('-') ? 'is-negative' : undefined}>{quantityText(item.quantity)} <small className="stock-unit">{item.unit}</small></span>}</td></tr>)}
        <tr className="stock-balances-all"><td>Todos</td><td className="numeric"><span className={consideredTotal(balances).startsWith('-') ? 'is-negative' : undefined}>{quantityText(consideredTotal(balances))} <small className="stock-unit">{productUnit}</small></span></td></tr></tbody></table>}
        {readReady && !balances.length && <p className="real-help">Cadastre um depósito em Preferências › Suprimentos › Depósitos para iniciar o controle.</p>}</>}
    </aside></div>
    {attention && <Modal title="Atenção" onClose={() => setAttention(false)} actions={<button type="button" className="primary-button" onClick={() => setAttention(false)}>Ok</button>}><p>{TRANSFER_MINIMUM}</p></Modal>}
    {panel && shownProduct && <div hidden={Boolean(needsWrite && !writable)} inert={Boolean(needsWrite && !writable)} aria-hidden={Boolean(needsWrite && !writable)}>
      {panel.type === 'launch' && <StockLaunchPanel controller={controller} product={shownProduct} warehouse={selectedBalance} readReady={readReady} suggestion={suggestion} negativeAllowed={negativeAllowed} showPrice={preferred?.showPrice ?? true} priceHelp={preferred?.help ?? null} lotControl={lotControl} entryDecimals={context?.price_decimals.entry ?? 10} onClose={closePanel} onRefresh={() => setReload(value => value + 1)} onSaved={result => saved(result.replayed ? 'O lançamento já tinha sido registrado; nada foi lançado de novo.' : `${result.kind === 'balance' ? 'Balanço registrado' : 'Lançamento registrado'}${result.lot ? ` no lote ${result.lot.code}${result.lot.created ? ' (lote novo)' : ''}` : ''}.`)} />}
      {panel.type === 'composition-launch' && composition.view && <CompositionLaunchPanel controller={controller} product={shownProduct} view={composition.view} warehouse={selectedBalance} readReady={readReady} negativeAllowed={negativeAllowed} onClose={closePanel} onRefresh={() => setReload(value => value + 1)} onSaved={result => saved(result.replayed ? 'O lançamento já tinha sido registrado; nada foi lançado de novo.' : result.kind === 'balance' ? 'Balanço registrado.' : 'Lançamento da composição registrado.')} />}
      {panel.type === 'composition-reverse' && <CompositionReversalPanel controller={controller} launch={panel.launch} negativeAllowed={negativeAllowed} onClose={closePanel} onSaved={() => saved('Estorno registrado em todas as posições do lançamento da composição.')} />}
      {panel.type === 'transfer' && <StockTransferPanel controller={controller} product={shownProduct} balances={balances} readReady={readReady} initialSource={filters.warehouse_id || totals?.warehouses.find(item => item.is_default)?.id || ''} suggestion={suggestion} negativeAllowed={negativeAllowed} showPrice={preferred?.showPrice ?? true} lotControl={lotControl} onClose={closePanel} onRefresh={() => setReload(value => value + 1)} onSaved={() => { setNotice('Transferência registrada.'); setReload(value => value + 1); }} />}
      {panel.type === 'lots' && <MovementLotsPanel controller={controller} movementId={panel.row.id} productId={shownProduct.id} warehouseId={panel.warehouseId} onClose={closePanel} onSaved={() => saved('Lotes informados no lançamento.')} />}
      {panel.type === 'edit' && <StockEditPanel controller={controller} product={shownProduct} row={panel.row} entryDecimals={context?.price_decimals.entry ?? 10} onLots={lotTab ? warehouseId => setPanel({ type: 'lots', row: panel.row, warehouseId }) : undefined} warehouseName={warehouseName} writable={writable && priceEditable(panel.row)} readOnlyReason={writable && !priceEditable(panel.row) ? panel.row.origin.type === 'invoices' ? 'Os preços deste lançamento são os dos itens da nota fiscal e não mudam aqui.' : 'Os preços deste lançamento pertencem ao documento de origem, que seu perfil não pode consultar.' : null} reversalBlock={reversalBlock(panel.row)} onClose={closePanel} onSaved={() => saved('Lançamento atualizado.')} onReverse={() => setPanel({ type: 'reverse', row: panel.row })} />}
      {panel.type === 'reverse' && <StockReversalForm controller={controller} product={shownProduct} balances={balances} readReady={readReady} reversal={panel.row} negativeAllowed={negativeAllowed} onClose={closePanel} onRefresh={() => setReload(value => value + 1)} onSaved={result => saved(result.balanceKept ? 'Estorno registrado. O saldo atual foi mantido porque há balanço depois do lançamento original (Preferências › Suprimentos › Estoque).' : 'Estorno registrado. O movimento original foi preservado.')} />}
    </div>}
    {panel && needsWrite && !writable && <p className="real-notice" role="status">Seu perfil atual não permite lançar estoque. O lançamento em andamento fica preservado e volta a aparecer se a permissão for restabelecida.</p>}
  </>;
}
