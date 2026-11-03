import { originHistoryAvailable } from '../lib/integration-capabilities';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { useListPreferences, type ListPreferencesPort } from '../hooks/useListPreferences';
import { AccessError, decimalMoney } from '../lib/real-access';
import {
  EMPTY_PRODUCT_FILTERS, PRODUCT_PERIOD_FIELDS, PRODUCT_SITUATIONS, PRODUCT_TYPE_FILTERS, STOCK_FILTERS, clearedProductFilter, inlinePrice, priceInputValue, productFiltersFromSaved, productSavedFilters, stockCell,
  type CatalogEnvelope, type CatalogListItem, type ProductFilters,
} from '../lib/catalog-model';
import { ITEM_TYPE_OPTIONS, TAXONOMY_SLUG, cloneProductForm, fold, ofTagType, taxonomyItems, taxonomyPath, taxonomyTree, type TaxonomyItem, type TaxonomyKind } from '../lib/product-form-model';
import { DEFAULT_PRODUCT_SETTINGS, loadProductSettings, type ProductSettings } from '../lib/product-settings';
import { quantityText, type StockBalance } from '../lib/stock-model';
// 202610220008: the balance observed in Origin beside the native one (never added), with origin, kind and moment.
import { ORIGIN_STOCK_FILTERS, originStockCell, cubeStock, isOriginStockFilter, nativeStockLine, type ProductOriginStockPage } from '../lib/product-origin-stock-model';
import { stockWarehousePage, type WarehouseOption } from '../lib/stock-positions-model';
import { planBatch, summarizeBatch, batchSummaryText, type BatchResult, type BatchStep } from '../lib/origin-batch';
import { UNIT_PRICE_INPUT_LIMIT } from '../../../../packages/erp-domain/src/unit-price.mjs';
import { ToolButton, type RowMenuItem } from './OriginList';
import { ProductListPrint } from './ProductListPrint';
import { ProductLabels, type LabelProduct } from './ProductLabels';
import { SearchableSelect, type SearchOption } from './SearchableSelect';
import { BatchDialog } from './BatchDialog';
import { Icon } from './Icon';
import { Modal } from './Modal';
// Estoque lane (183): "Transferir estoque dos produtos selecionados" (stock writers only).
import { StockTransferBatchAction } from './StockTransferBatch';
import ListPreferencesBar, { systemPortOf } from './ListPreferencesBar';
import { TagsDrawer } from './TagsDrawer';
import { LinkToPriceList, PriceListWizard } from './PriceListWizard';
import { NewPriceCell, PriceAdjustmentBar, usePriceAdjustment } from './PriceAdjustmentBar';
import { fieldText, type CatalogEntityView, type CatalogList } from './CatalogList';
import { aborted, errorText, knownFailure } from './catalog-shared';
// Wave D (migration 191): filtro "Campos customizados" (categoria e filtros por campo).
import { ProductCustomFilter, useLazyCustomFields } from './ProductCustomFilter';
import { customFilterApi, customFilterDraft, customRowLabel } from '../lib/product-custom-filter-model';
import './product-registry.css';
// Documentos lane (202610200197): Sacola de vendas of the user (toolbar, Marcadores and the drawer).
import { SalesBagButton, SalesBagDrawer, SalesBagRowAdd, useSalesBag } from './SalesBag';
// Wave E (migration 234): "Componente" of the Tipo "Produtos com composição", searched with the Estrutura autocomplete of the estoque lane.
import { componentOptionsPath, parseComponentOptions, type ComponentOption } from '../lib/stock-composition-model';

// Listagem de Produtos no padrão do Origin (migração 120): Situação (Últimos Incluídos, Ativos, Inativos, Excluídos), filtros de
// Estoque/Depósito, Imagens, Tags, Categoria, NCM, Classificação, Tipo, Marca, Fornecedor e Cód fornecedor, colunas da listagem
// customizada (por usuário), Marcadores (cubo de estoque), copiar descrição e código, Excluir/Restaurar e as ações em lote
// "Incluir categorias/tags para selecionados", além do preço na linha, Clonar produto e Ver estoque.
const PRODUCT_LIST_LABELS = { add: 'Incluir cadastro', count: 'Quantidade de Produtos', search: 'Pesquisar produtos', searchHint: 'Pesquisar por código, descrição ou GTIN', situation: 'Mudar situação de produtos selecionados' };
type PriceEdit = { id: string; version: number; initial: string; value: string; busy: boolean; uncertain: boolean; error: string };
type BatchKind = 'delete' | 'restore' | 'category' | 'tags';
type ProductBatch = { kind: BatchKind; items: { id: string; label: string; version: number; deleted: boolean }[]; category: string; tags: string[]; locked: boolean };
const COLUMNS = [{ id: 'image', label: 'Imagem' }, { id: 'code', label: 'Código' }, { id: 'unit', label: 'Unidade' }, { id: 'price', label: 'Preço' }, { id: 'stock', label: 'Estoque' },
  { id: 'ncm', label: 'NCM' }, { id: 'brand', label: 'Marca' }, { id: 'stock_min', label: 'Estoque mínimo' }, { id: 'stock_max', label: 'Estoque máximo' }, { id: 'cost_price', label: 'Preço de Custo' }, { id: 'location', label: 'Localização' }] as const;
export const PRODUCT_LIST_ID = 'cadastros.produtos';
const DEFAULT_COLUMNS = ['image', 'code', 'unit', 'price', 'stock'];
const BATCH_TITLE: Record<BatchKind, string> = { delete: 'Excluir selecionados', restore: 'Restaurar selecionados', category: 'Atualizar categoria dos produtos selecionados', tags: 'Incluir tags para selecionados' };
const quantity = (value: string | null | undefined) => typeof value === 'string' && /^-?\d+\.\d+$/.test(value) ? value : null;
// Exact comparison at the larger scale of both texts (a Origin balance may carry up to 12 decimals).
const decimalLess = (a: string, b: string) => { const digits = Math.max(...[a, b].map(v => v.split('.')[1]?.length ?? 0)); const scale = (v: string) => { const [w, f = ''] = v.replace('-', '').split('.'); return (v.startsWith('-') ? -1n : 1n) * BigInt(w + f.padEnd(digits, '0')); }; return scale(a) <= scale(b); };
const noSubscribe = () => () => undefined;

/** "Ver estoque" (menu ⋮): saldo de cada depósito pela consulta de estoque existente; versão 0 é "sem lançamentos". */
function StockView({ item, balances, error, onClose }: { item: CatalogListItem; balances: StockBalance[] | null; error: string; onClose: () => void }) {
  return <Modal title={`Estoque — ${item.name}`} onClose={onClose} actions={<button type="button" className="primary-button" onClick={onClose}>Fechar</button>}>
    {error ? <p className="real-alert" role="alert">{error}</p> : !balances ? <p role="status">Consultando estoque…</p> : !balances.length ? <p>Nenhum depósito cadastrado.</p>
      : <table className="data-table catalog-stock-table"><thead><tr><th scope="col">Depósito</th><th scope="col" className="numeric">Saldo</th></tr></thead><tbody>{balances.map(balance => <tr key={balance.warehouse_id}>
        <td>{balance.warehouse_name}{balance.warehouse_active ? '' : ' (inativo)'}</td>
        <td className="numeric">{balance.version === 0 ? 'Sem lançamentos' : `${quantityText(balance.quantity)}${balance.unit ? ` ${balance.unit}` : ''}`}</td></tr>)}</tbody></table>}
    <p className="real-help">Somente consulta. Lançamentos e transferências ficam em Estoque.</p>
  </Modal>;
}

/** Product row state. Called on every render of the catalog, whatever the entity, so the hook order never changes. */
export function useProductList(list: CatalogList) {
  const { controller } = list;
  const salesBag = useSalesBag(controller, list.entity === 'products'), navigateTo = useNavigate();
  const generateFromBag = () => { salesBag.setOpen(false); navigateTo('/documentos-empresa?tipo=sales_orders&acao=sacola'); };
  const [priceEdit, setPriceEdit] = useState<PriceEdit | null>(null);
  const [stockView, setStockView] = useState<{ item: CatalogListItem; balances: StockBalance[] | null; error: string } | null>(null);
  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([]);
  const [taxonomies, setTaxonomies] = useState<Partial<Record<TaxonomyKind, TaxonomyItem[]>>>({});
  const [settings, setSettings] = useState<ProductSettings>(DEFAULT_PRODUCT_SETTINGS);
  const [batch, setBatch] = useState<ProductBatch | null>(null), [tagsFor, setTagsFor] = useState<ProductBatch['items'] | null>(null);
  const [supplierSearch, setSupplierSearch] = useState<{ query: string; options: { id: string; name: string }[] }>({ query: '', options: [] });
  const [componentSearch, setComponentSearch] = useState<{ query: string; options: ComponentOption[]; state: 'idle' | 'busy' | 'error' }>({ query: '', options: [], state: 'idle' });
  // Mais ações > Listas de Preços: "Criar lista de preço" (assistente, com os selecionados) e "Vincular a uma lista".
  const [priceList, setPriceList] = useState<null | { kind: 'create' | 'link'; products: { id: string; name: string }[] }>(null);
  // Edição > "Reajuste e sincronização de preços" (migration 155): the bar, the "Novo Preço" preview and the apply command.
  // Toolbar "Imprimir": every page of the current filters, with the visible columns.
  const [printing, setPrinting] = useState<null | 'list' | 'prices'>(null);
  // "Imprimir etiquetas" (row) and "Imprimir etiquetas selecionadas" (panel).
  const [labels, setLabels] = useState<LabelProduct[] | null>(null);
  const adjust = usePriceAdjustment(controller, list.entity === 'products' ? (list.page?.items ?? []) : [], list.entity === 'products');
  // Campos customizados of the filter panel: read when the filter is first used.
  const customFields = useLazyCustomFields(controller);
  // Whether this profile may read stock, as answered by the last product page; kept while the next page loads.
  const [stockAccess, setStockAccess] = useState(false);
  const stockRequest = useRef<AbortController | null>(null), priceRequest = useRef<AbortController | null>(null), batchRequest = useRef<AbortController | null>(null), batchActor = useRef<string | undefined>(undefined);
  const priceCommand = useRef<{ id: string; itemId: string; body: Record<string, unknown> } | null>(null);
  const discardPrice = () => { priceRequest.current?.abort(); priceRequest.current = null; priceCommand.current = null; setPriceEdit(null); };
  // Every list change discards the inline price; every product page says whether stock is visible.
  list.rows.current.products = { discard: discardPrice, loaded: page => { if (page.entity === 'products') setStockAccess(page.stock_visible === true); } };
  useEffect(() => () => { stockRequest.current?.abort(); priceRequest.current?.abort(); batchRequest.current?.abort(); }, [controller]);
  const isProducts = list.entity === 'products';
  const stockVisible = isProducts && stockAccess;
  useEffect(() => {
    if (!stockVisible) return;
    const request = new AbortController();
    void controller.stockPositions('/v1/posicoes-estoque/depositos?limit=100', { signal: request.signal }).then(value => { if (!request.signal.aborted) setWarehouses(stockWarehousePage(value).items); })
      .catch(() => { /* The Depósito filter keeps only "Todos depósitos"; the list itself is unaffected. */ });
    return () => request.abort();
  }, [controller, stockVisible]);
  // Categorias e tags (filtros, gaveta Tags e lote) e a preferência "Exibir localização na tela de produtos".
  useEffect(() => {
    if (!isProducts) return;
    const request = new AbortController();
    for (const kind of ['categories', 'tag_groups', 'tags'] as const)
      void Promise.resolve().then(() => controller.catalog(`/v1/cadastros/taxonomias/${TAXONOMY_SLUG[kind]}`, { signal: request.signal })).then(value => { if (!request.signal.aborted) setTaxonomies(current => ({ ...current, [kind]: taxonomyItems(value, kind) })); })
        .catch(() => { /* The filter offers only Todos/Sem categoria/Sem Tag; saved products keep their links. */ });
    void Promise.resolve().then(() => loadProductSettings(controller, request.signal)).then(value => { if (!request.signal.aborted) setSettings(value); }).catch(() => { /* FAGOO defaults. */ });
    return () => request.abort();
  }, [controller, isProducts, list.listKey.split(':').at(-1)]);
  const port = useMemo<ListPreferencesPort>(() => ({ getSnapshot: controller.getSnapshot, subscribe: typeof controller.subscribe === 'function' ? controller.subscribe : noSubscribe,
    listPreferences: (path, options) => typeof controller.listPreferences === 'function' ? controller.listPreferences(path, options) : Promise.reject(new AccessError(404)) }), [controller]);
  const available: string[] = COLUMNS.filter(column => column.id !== 'location' || settings.showLocation).map(column => column.id);
  const prefs = useListPreferences(port, PRODUCT_LIST_ID, { available, defaults: DEFAULT_COLUMNS });
  // "Tornar padrão": the user's default filters are applied once per user, when they arrive and the list is still unfiltered.
  const defaultsFor = useRef<string | null>(null);
  useEffect(() => {
    const actor = controller.getSnapshot().membership?.user_id ?? null;
    if (!isProducts || prefs.loading || !actor || defaultsFor.current === actor) return;
    defaultsFor.current = actor;
    if (!prefs.filters || list.query || list.draft || JSON.stringify(list.productFilters) !== JSON.stringify(EMPTY_PRODUCT_FILTERS)) return;
    const { filters, query } = productFiltersFromSaved(prefs.filters);
    list.setProductFilters(filters); list.setProductFilterDraft(filters); list.setQuery(query); list.setDraft(query);
  }, [controller, isProducts, prefs.loading, prefs.filters]);
  // Fornecedor (filtro): contatos ativos pelo seletor de contatos (carteira do vendedor, contatos onda C). Sem filtro de
  // papel: os contatos espelhados do Origin ainda não têm Tipo de contato, e "Fornecedor" esconderia todos eles.
  useEffect(() => {
    const query = supplierSearch.query.trim();
    if (!isProducts || !query) return;
    const request = new AbortController();
    const timer = setTimeout(() => void controller.catalog(`/v1/cadastros/contatos/opcoes?${new URLSearchParams({ limit: '10', q: query })}`, { signal: request.signal }).then(value => {
      const items = (value as { items?: { id: string; name: string }[] }).items;
      if (!request.signal.aborted && Array.isArray(items)) setSupplierSearch(current => current.query.trim() === query ? { ...current, options: items.filter(item => typeof item?.id === 'string' && typeof item.name === 'string').map(item => ({ id: item.id, name: item.name })) } : current);
    }).catch(() => { /* Nothing found; the filter stays as it is. */ }), 250);
    return () => { clearTimeout(timer); request.abort(); };
  }, [controller, isProducts, supplierSearch.query]);
  // Componente (Origin "Digite o nome ou código"): simple active products, with a debounce; an answer for an older text is ignored.
  // Nothing is searched once a product is picked (the field shows its name) or while the Tipo is not "Produtos com composição".
  const componentPicked = Boolean(list.productFilterDraft.component_id), componentShown = list.productFilterDraft.type === 'composition';
  useEffect(() => {
    const query = componentSearch.query.trim();
    if (!isProducts || !query || componentPicked || !componentShown) return;
    const request = new AbortController();
    const timer = setTimeout(() => {
      setComponentSearch(current => current.query.trim() === query ? { ...current, state: 'busy' } : current);
      void Promise.resolve().then(() => controller.stock(componentOptionsPath(query, null), { signal: request.signal })).then(value => {
        if (!request.signal.aborted) setComponentSearch(current => current.query.trim() === query ? { ...current, options: parseComponentOptions(value, query).slice(0, 10), state: 'idle' } : current);
      }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) setComponentSearch(current => current.query.trim() === query ? { ...current, options: [], state: 'error' } : current); });
    }, 250);
    return () => { clearTimeout(timer); request.abort(); };
  }, [controller, isProducts, componentSearch.query, componentPicked, componentShown]);
  // Inline price edit: an unsaved value or an unconfirmed save is protected like a form.
  useUnsavedChanges(Boolean(priceEdit && (priceEdit.value !== priceEdit.initial || priceEdit.uncertain)), Boolean(priceEdit?.busy || priceEdit?.uncertain));
  const startClone = (id: string) => list.changeList(() => void cloneFrom(id));
  const cloneFrom = async (id: string) => {
    if (!list.writable || list.entity !== 'products') return;
    list.detailRequest.current?.abort(); const request = new AbortController(); list.detailRequest.current = request; list.setError(''); list.setNotice('');
    try {
      const value = await controller.catalog(`/v1/cadastros/products/${id}/completo`, { signal: request.signal }) as CatalogEnvelope;
      if (request.signal.aborted) return;
      if (value.record?.id?.toLowerCase() !== id.toLowerCase() || value.record.entity !== 'products') throw new AccessError(502);
      list.openClone(cloneProductForm(value.record), value.record.name);
    } catch (failure) { if (!request.signal.aborted && !aborted(failure)) list.setError(errorText(failure)); }
  };
  const showStock = async (item: CatalogListItem) => {
    list.setRowMenu(null); stockRequest.current?.abort(); const request = new AbortController(); stockRequest.current = request;
    setStockView({ item, balances: null, error: '' });
    try {
      const value = await controller.stock(`/v1/estoque/saldos?product_id=${item.id}`, { signal: request.signal }) as { product_id: string; items: StockBalance[]; data_mode: string };
      if (request.signal.aborted) return;
      if (value.product_id !== item.id || value.data_mode !== 'erp_native' || !Array.isArray(value.items)) throw new AccessError(502);
      setStockView({ item, balances: value.items, error: '' });
    } catch (failure) { if (!request.signal.aborted && !aborted(failure)) setStockView({ item, balances: null, error: failure instanceof AccessError && failure.status === 403 ? 'Seu perfil não permite consultar o estoque.' : 'Não foi possível consultar o estoque deste produto. Tente novamente.' }); }
  };
  const closeStock = () => { stockRequest.current?.abort(); setStockView(null); };
  const startPrice = (item: CatalogListItem) => {
    if (!list.writable || !item.active || item.deleted === true || priceEdit?.busy || priceEdit?.uncertain) return;
    // An unsaved price on another row asks before it is replaced.
    list.changeList(() => { const initial = priceInputValue(item.price); setPriceEdit({ id: item.id, version: item.version, initial, value: initial, busy: false, uncertain: false, error: '' }); });
  };
  const savePrice = async () => {
    const edit = priceEdit; if (!edit || edit.busy || priceRequest.current) return;
    if (!edit.uncertain) {
      let price: string;
      try { price = inlinePrice(edit.value); } catch (failure) { setPriceEdit({ ...edit, error: (failure as Error).message }); return; }
      if (price === list.page?.items.find(item => item.id === edit.id)?.price) { setPriceEdit(null); return; }
      priceCommand.current = { id: crypto.randomUUID(), itemId: edit.id, body: { expected_version: edit.version, data: { price } } };
    }
    const operation = priceCommand.current; if (!operation || operation.itemId !== edit.id) return;
    const request = new AbortController(); priceRequest.current = request; setPriceEdit({ ...edit, busy: true, error: '' });
    try {
      const result = await controller.catalog(`/v1/cadastros/${list.entity}/${edit.id}`, { method: 'PATCH', body: { ...operation.body, command_id: operation.id }, signal: request.signal }) as CatalogEnvelope;
      if (request.signal.aborted) return;
      if (result.record?.id !== edit.id || typeof result.record.price !== 'string') throw new AccessError(502);
      priceCommand.current = null; setPriceEdit(null); list.setNotice(result.replayed ? 'Preço confirmado.' : 'Preço atualizado.');
      list.setPage(current => current && { ...current, items: current.items.map(item => item.id === edit.id ? { ...item, price: result.record.price, version: result.record.version, updated_at: result.record.updated_at } : item) });
    } catch (failure) {
      if (request.signal.aborted) return;
      // Session changes abort requests inside the controller: the save may have reached the server.
      const known = !edit.uncertain && !aborted(failure) && knownFailure(failure);
      if (known) priceCommand.current = null;
      setPriceEdit({ ...edit, busy: false, uncertain: !known, error: !known ? 'Não foi possível confirmar o novo preço. Use “Conferir resultado” para repetir a mesma operação sem duplicar a alteração.'
        : (failure as AccessError).status === 409 ? 'O produto foi alterado por outra operação. Atualize a listagem antes de editar o preço.' : errorText(failure) });
    } finally { if (priceRequest.current === request) priceRequest.current = null; }
  };
  // Lotes (Excluir, Restaurar, Incluir categoria, Incluir tags): um comando e uma versão por produto, pelo BatchDialog.
  const openBatch = (kind: BatchKind, items: CatalogListItem[], tags: string[] = []) => {
    list.setRowMenu(null); if (!list.writable || !items.length) return;
    list.changeList(() => {
      batchActor.current = controller.getSnapshot().membership?.user_id; batchRequest.current = new AbortController();
      setBatch({ kind, items: items.map(item => ({ id: item.id, label: item.name, version: item.version, deleted: item.deleted === true })), category: '', tags, locked: false });
    });
  };
  const batchPlan = batch ? planBatch(batch.items, item => batch.kind === 'restore' ? item.deleted ? null : 'Não está excluído.' : item.deleted ? 'Produto excluído; restaure-o antes.' : null) : null;
  const runBatch = (current: ProductBatch) => async (item: ProductBatch['items'][number]): Promise<BatchStep> => {
    setBatch(value => value && !value.locked ? { ...value, locked: true } : value);
    const snapshot = controller.getSnapshot(), signal = batchRequest.current?.signal;
    if (!signal || signal.aborted || snapshot.phase !== 'ready' || snapshot.membership?.user_id !== batchActor.current) throw new Error('A sessão mudou durante a operação. Este cadastro não foi enviado.');
    let body: Record<string, unknown>, path: string;
    if (current.kind === 'delete' || current.kind === 'restore') { path = `/v1/cadastros/products/${item.id}/deleted`; body = { command_id: crypto.randomUUID(), expected_version: item.version, deleted: current.kind === 'delete' }; }
    else if (current.kind === 'category') { path = `/v1/cadastros/products/${item.id}/completo`; body = { command_id: crypto.randomUUID(), expected_version: item.version, data: { category_id: current.category || null } }; }
    else {
      // Tags are added to the ones the product already has: read the current product first, then save the union with its version.
      const read = await controller.catalog(`/v1/cadastros/products/${item.id}/completo`, { signal }) as CatalogEnvelope;
      const existing = Array.isArray(read.record?.tag_ids) ? read.record.tag_ids as string[] : [];
      if (read.record?.id !== item.id) throw new Error('Não foi possível ler o produto.');
      const union = [...new Set([...existing, ...current.tags])];
      if (union.length === existing.length) return { message: 'Já tinha as tags marcadas.' };
      path = `/v1/cadastros/products/${item.id}/completo`; body = { command_id: crypto.randomUUID(), expected_version: read.record.version, data: { tag_ids: union } };
    }
    const send = async () => { const result = await controller.catalog(path, { method: 'PATCH', body, signal }) as CatalogEnvelope; if (result.record?.id !== item.id) throw new AccessError(502); };
    try { await send(); return; }
    catch (failure) {
      if (!aborted(failure) && knownFailure(failure)) throw new Error(failure instanceof AccessError && failure.status === 409 ? 'O produto foi alterado por outra operação ou está excluído. Atualize a listagem e tente de novo.' : errorText(failure));
      try { if (!signal.aborted) { await send(); return { message: 'Confirmado ao repetir a mesma operação.' }; } } catch { /* Still unknown. */ }
      return { uncertain: true, message: 'Não foi possível confirmar o resultado. Atualize a listagem e confira o cadastro antes de repetir.' };
    }
  };
  const closeBatch = (results: BatchResult[] | null) => {
    const kind = batch?.kind; setBatch(null); batchRequest.current = null;
    if (results && kind) { list.setNotice(`${BATCH_TITLE[kind]}: ${batchSummaryText(summarizeBatch(results))}.`); list.setSelection({ key: '', ids: new Set(), anchor: null }); list.setReload(value => value + 1); }
  };
  const copy = (text: string, what: string) => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard) { list.setNotice(`Não foi possível copiar ${what} neste navegador.`); return; }
    void clipboard.writeText(text).then(() => list.setNotice(`${what[0].toUpperCase()}${what.slice(1)} copiado.`), () => list.setNotice(`Não foi possível copiar ${what} neste navegador.`));
  };
  return { salesBag, generateFromBag, priceEdit, setPriceEdit, stockView, closeStock, warehouses, stockVisible, discardPrice, startClone, showStock, startPrice, savePrice, taxonomies, settings, prefs, available,
    batch, setBatch, batchPlan, runBatch, closeBatch, openBatch, tagsFor, setTagsFor, supplierSearch, setSupplierSearch, componentSearch, setComponentSearch, copy, priceList, setPriceList, adjust, printing, setPrinting, labels, setLabels, customFields };
}
export type ProductListState = ReturnType<typeof useProductList>;

/** Marcadores: o cubo de estoque do Origin (verde normal, amarelo no mínimo, vermelho vazio/negativo, cinza com ✕ excluído). */
// 202610220008: with the Origin summary, the cube follows the balance the cell shows first (Origin físico observado, else the native
// ledger) and its title names that origin; without it (an API before 008) the cube reads the native ledger as before.
function StockCube({ item, visible, origin, byWarehouse }: { item: CatalogListItem; visible: boolean; origin?: ProductOriginStockPage | null; byWarehouse: boolean }) {
  if (item.deleted === true) return <span className="catalog-cube is-deleted" title="Item Excluído"><Icon name="cube" size={14} /></span>;
  const source = visible && origin !== undefined ? cubeStock(item.stock, item.origin_stock, origin, byWarehouse) : null;
  const current = source ? (source.quantity === null ? null : quantity(source.quantity) ?? (/^-?\d+$/.test(source.quantity) ? source.quantity : null)) : visible && item.stock?.state === 'recorded' ? quantity(item.stock.quantity) : null;
  if (current === null) return <span className="catalog-cube" style={{ color: 'var(--muted)' }} title={!visible ? 'Estoque não disponível para o seu perfil' : source ? source.reason : 'Estoque sem posição conferida'}><Icon name="cube" size={14} /></span>;
  const originLabel = source?.origin === 'origin' ? 'Estoque Origin (físico observado)' : source?.origin === 'brufap' ? 'Estoque nativo do FAGOO' : 'Estoque';
  const min = typeof item.stock_min === 'string' ? item.stock_min : null, max = typeof item.stock_max === 'string' ? item.stock_max : null;
  const negative = current.startsWith('-') && !/^-0(?:\.0+)?$/.test(current), empty = /^-?0(?:\.0+)?$/.test(current);
  const state = negative || empty ? 'is-empty' : min !== null && decimalLess(current, min) ? 'is-low' : '';
  const title = `${source ? `${originLabel}: ` : ''}${negative ? 'Estoque do produto negativo' : empty ? 'Estoque do produto vazio'
    : `Estoque atual: ${quantityText(current)} / Estoque mínimo: ${min === null ? '—' : quantityText(min)} / Estoque máximo: ${max === null ? '—' : quantityText(max)}`}`;
  return <span className={`catalog-cube ${state}`} title={title} aria-label={title}><Icon name="cube" size={14} /></span>;
}

export function productListView(list: CatalogList, product: ProductListState): CatalogEntityView {
  const { writable, changeList, productFilters, productFilterDraft, setProductFilterDraft, selectedItems } = list;
  const { priceEdit, setPriceEdit, stockVisible, warehouses, savePrice, discardPrice, taxonomies, prefs } = product;
  // undefined: an API before 202610220008 (native only, as before); null: this profile does not read stock.
  const originPage = originHistoryAvailable(list.controller.getSnapshot().membership) && list.page?.entity === 'products' ? list.page.origin_stock : undefined;
  const draft = (patch: Partial<ProductFilters>) => setProductFilterDraft(previous => ({ ...previous, ...patch }));
  const productFilter = (key: keyof ProductFilters) => () => changeList(() => { const clear = clearedProductFilter(key); list.setProductFilters(previous => ({ ...previous, ...clear })); setProductFilterDraft(previous => ({ ...previous, ...clear })); });
  const warehouseName = (id: string) => warehouses.find(item => item.id === id)?.name ?? 'depósito selecionado';
  // Produtos tags only (migration 153): the Contatos tags belong to the contacts list.
  const categories = taxonomies.categories ?? [], tags = ofTagType(taxonomies.tags ?? [], 'products'), tagGroups = ofTagType(taxonomies.tag_groups ?? [], 'products');
  const deletedView = productFilters.situation === 'deleted';
  // Tags e Categoria (Origin): select pesquisável; tags by group, categories in tree order.
  const tagOptions: SearchOption[] = [{ value: '', label: 'Todos' }, { value: 'none', label: 'Sem Tag' }, ...tags.filter(tag => !tagGroups.some(group => group.id === tag.parent_id)).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')).map(tag => ({ value: tag.id, label: tag.name })),
    ...[...tagGroups].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')).flatMap(group => tags.filter(tag => tag.parent_id === group.id).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')).map(tag => ({ value: tag.id, label: tag.name, group: group.name })))];
  const categoryOptions: SearchOption[] = [{ value: '', label: 'Todas' }, { value: 'none', label: 'Sem categoria' }, ...taxonomyTree(categories).map(({ item, depth }) => ({ value: item.id, label: item.name, depth }))];
  // The v2 list filters as the API names them: the export link and "Produtos filtrados" of the price adjust use the same set.
  const apiFilters: Record<string, string> = Object.fromEntries(Object.entries({ situation: productFilters.situation, q: list.query, type: productFilters.type, ncm_presence: productFilters.ncm_presence, ncm: productFilters.ncm, brand: productFilters.brand,
    stock: productFilters.stock, warehouse_id: productFilters.warehouse_id, images: productFilters.images, tag: productFilters.tag, category: productFilters.category, item_type: productFilters.item_type, supplier_id: productFilters.supplier_id,
    supplier_code: productFilters.supplier_code, component_id: productFilters.type === 'composition' ? productFilters.component_id : '',
    ...(list.period.from || list.period.to ? { period: list.period.field, from: list.period.from, to: list.period.to } : {}) }).filter(([, value]) => value));
  // Campos customizados: the page and the print send it as the `custom` parameter, the price adjust as a list; the export ignores
  // it, as the Origin export does.
  const customApi = customFilterApi(productFilters.custom), customRows = customFilterDraft(productFilters.custom).rows;
  if (customApi) apiFilters.custom = JSON.stringify(customApi);
  const exportFilters = Object.fromEntries(Object.entries(apiFilters).filter(([key]) => key !== 'custom'));
  const adjustFilters = customApi ? { ...exportFilters, custom: customApi } : exportFilters;
  const adjusting = product.adjust.open && !deletedView;
  const columns = prefs.columns.filter(id => product.available.includes(id) && (id !== 'stock' || stockVisible));
  const priceCell = (item: CatalogListItem) => {
    const edit = priceEdit?.id === item.id ? priceEdit : null;
    if (!edit) return <span className="catalog-price-value">{decimalMoney(typeof item.price === 'string' ? item.price : null)}{writable && item.active && item.deleted !== true && <button type="button" className="catalog-price-pencil" title="Clique para editar o preço do produto" aria-label={`Editar o preço de ${item.name}`} disabled={Boolean(priceEdit?.busy || priceEdit?.uncertain)} onClick={event => { event.stopPropagation(); product.startPrice(item); }}><Icon name="pen-to-square" size={11} /></button>}</span>;
    return <span className="catalog-price-edit" onClick={event => event.stopPropagation()}>
      <input id="catalog-inline-price" aria-label={`Preço de venda de ${item.name}`} value={edit.value} inputMode="decimal" autoComplete="off" maxLength={UNIT_PRICE_INPUT_LIMIT} disabled={edit.busy || edit.uncertain} aria-invalid={edit.error && !edit.uncertain ? true : undefined}
        onChange={event => setPriceEdit({ ...edit, value: event.target.value, error: '' })} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void savePrice(); } if (event.key === 'Escape' && !edit.busy && !edit.uncertain) { event.preventDefault(); discardPrice(); } }} autoFocus />
      {edit.uncertain ? <button type="button" className="secondary-button" disabled={edit.busy} onClick={() => void savePrice()}>{edit.busy ? 'Conferindo…' : 'Conferir resultado'}</button>
        : <><button type="button" className="icon-button" title="Salvar preço" aria-label="Salvar preço" disabled={edit.busy} onClick={() => void savePrice()}><Icon name="check" size={12} /></button><button type="button" className="icon-button" title="Cancelar" aria-label="Cancelar edição do preço" disabled={edit.busy} onClick={discardPrice}><Icon name="xmark" size={12} /></button></>}
      {edit.error && <small role="alert">{edit.error}</small>}
    </span>;
  };
  const copyButton = (text: string | null, what: string, name: string) => text ? <button type="button" className="icon-button catalog-copy" title={`Copiar ${what}`} aria-label={`Copiar ${what} de ${name}`} onClick={event => { event.stopPropagation(); product.copy(text, what); }}><Icon name="copy" size={11} /></button> : null;
  const rowItems = (item: CatalogListItem): RowMenuItem[] => item.deleted === true ? [list.editItem(item), ...(writable ? [{ label: 'Restaurar', icon: 'rotate-left', onClick: () => product.openBatch('restore', [item]) }] : [])] : [
    { label: 'Imprimir etiquetas', icon: 'print', onClick: () => product.setLabels([labelOf(item)]) },
    list.editItem(item),
    ...(writable ? [{ label: 'Clonar produto', icon: 'clone', onClick: () => void product.startClone(item.id) }] : []),
    ...list.situationItems(item),
    ...(stockVisible ? [{ label: 'Ver estoque', icon: 'cube', separatorBefore: true, onClick: () => void product.showStock(item) }] : []),
  ];
  const labelOf = (item: CatalogListItem): LabelProduct => ({ id: item.id, name: item.name, code: item.code ?? null, price: typeof item.price === 'string' ? item.price : null, gtin: typeof item.gtin === 'string' ? item.gtin : null });
  const label = (options: readonly { value: string; label: string }[], value: string) => options.find(option => option.value === value)?.label ?? value;
  const tagLabel = (id: string) => id === 'none' ? 'Sem Tag' : tags.find(tag => tag.id === id)?.name ?? 'tag selecionada';
  const categoryLabel = (id: string) => id === 'none' ? 'Sem categoria' : taxonomyPath(categories, id) || 'categoria selecionada';
  const selectedLabel = selectedItems.length === 1 ? '1 cadastro' : `${selectedItems.length} cadastros`;
  const header = (id: string) => id === 'code' ? list.sortHeader('code', 'Código') : <th key={id} scope="col" className={['price', 'stock', 'stock_min', 'stock_max', 'cost_price'].includes(id) ? 'numeric' : undefined}>{COLUMNS.find(column => column.id === id)?.label}</th>;
  const cell = (item: CatalogListItem, id: string) => {
    if (id === 'image') return <td key={id}>{typeof item.thumbnail === 'string' ? <img className="catalog-thumb" src={item.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="catalog-thumb-empty" aria-label="Sem imagem"><Icon name="image" size={14} /></span>}</td>;
    if (id === 'code') return <td key={id}>{item.code || '—'}{copyButton(item.code, 'o código', item.name)}</td>;
    if (id === 'price') return <td key={id} className="numeric catalog-price">{priceCell(item)}</td>;
    // 234: the total leaves out the warehouses with "Desconsiderar saldo deste depósito", as the stock screens do.
    if (id === 'stock') {
      const byWarehouse = Boolean(productFilters.warehouse_id), nativeTitle = byWarehouse ? `Depósito: ${warehouseName(productFilters.warehouse_id)}` : 'Soma dos depósitos, sem os que têm “Desconsiderar saldo deste depósito”';
      if (originPage === undefined) { const stock = stockCell(item.stock, byWarehouse); return <td key={id} className={`numeric catalog-stock${stock.state ? ` is-${stock.state}` : ''}`} title={nativeTitle}>{stock.text}</td>; }
      // 202610220008: two labelled lines, Origin (físico observado, virtual and moment) and Brufap (native ledger); never added.
      const origin = originStockCell(item.origin_stock, originPage), native = nativeStockLine(item.stock, byWarehouse);
      return <td key={id} className="numeric catalog-stock is-dual">
        <span className={`catalog-stock-line is-origin is-${origin.state}`} title={origin.title}><span className="catalog-stock-origin">Origin (físico)</span> <strong>{origin.text}</strong>{origin.detail && <small>{origin.detail}</small>}</span>
        <span className={`catalog-stock-line is-native${native.state ? ` is-${native.state}` : ''}`} title={`Estoque nativo do FAGOO. ${nativeTitle}`}><span className="catalog-stock-origin">FAGOO</span> {native.text}</span>
      </td>;
    }
    if (id === 'stock_min' || id === 'stock_max') return <td key={id} className="numeric">{quantity(item[id] as string) ? quantityText(item[id] as string) : '—'}</td>;
    if (id === 'cost_price') return <td key={id} className="numeric">{decimalMoney(typeof item.cost_price === 'string' ? item.cost_price : null)}</td>;
    return <td key={id}>{fieldText(item, id)}</td>;
  };
  const supplierOptions = product.supplierSearch.options, componentOptions = product.componentSearch.options;
  return {
    // Origin: "Mudar situação" lives in Mais ações > Edição (select Nova situação), the period types are tabs, the pagination has a page select.
    labels: PRODUCT_LIST_LABELS, ownSituation: true, sortChip: false, periodFields: PRODUCT_PERIOD_FIELDS, situationAction: false, situationSelect: true, periodTabs: true, pageSelect: true,
    filters: <>
      <div className="form-field"><label htmlFor="catalog-situation-filter">Situação</label><select id="catalog-situation-filter" value={productFilterDraft.situation} onChange={event => draft({ situation: event.target.value })}>{PRODUCT_SITUATIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
      {stockVisible && <><div className="form-field"><label htmlFor="catalog-stock-filter">Estoque</label><select id="catalog-stock-filter" value={productFilterDraft.stock} onChange={event => draft({ stock: event.target.value, ...(event.target.value ? {} : { warehouse_id: '' }) })}><option value="">Selecione uma opção</option>{originPage === undefined ? STOCK_FILTERS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)
        : <><optgroup label="Estoque nativo do FAGOO">{STOCK_FILTERS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup><optgroup label="Estoque Origin (físico observado)">{ORIGIN_STOCK_FILTERS.map(option => <option key={option.value} value={option.value}>{`Origin: ${option.label}`}</option>)}</optgroup></>}</select></div>
        {productFilterDraft.stock && <div className="form-field"><label htmlFor="catalog-warehouse-filter">Depósito</label><select id="catalog-warehouse-filter" value={productFilterDraft.warehouse_id} onChange={event => draft({ warehouse_id: event.target.value })}><option value="">Todos depósitos</option>{warehouses.map(option => <option key={option.id} value={option.id}>{option.name}{option.active ? '' : ' (inativo)'}</option>)}</select>
          {isOriginStockFilter(productFilterDraft.stock) && <small>O depósito só se relaciona ao Origin por vínculo de identidade comprovado, nunca pelo nome. Sem vínculo, o saldo Origin não é mostrado.</small>}</div>}</>}
      <div className="form-field"><label htmlFor="catalog-images-filter">Imagens</label><select id="catalog-images-filter" value={productFilterDraft.images} onChange={event => draft({ images: event.target.value })}><option value="">Selecione uma opção</option><option value="yes">Sim</option><option value="no">Não</option></select></div>
      <div className="form-field"><label htmlFor="catalog-tag-filter">Tags<Link className="catalog-copy" to="/tags?tipo=produtos" title="Gerenciar tags" aria-label="Gerenciar tags"><Icon name="gear" size={11} /></Link></label><SearchableSelect id="catalog-tag-filter" value={productFilterDraft.tag} options={tagOptions} onChange={event => draft({ tag: event.target.value })} /></div>
      <div className="form-field"><label htmlFor="catalog-category-filter">Categoria</label><SearchableSelect id="catalog-category-filter" value={productFilterDraft.category} options={categoryOptions} onChange={event => draft({ category: event.target.value })} /></div>
      <div className="form-field"><label htmlFor="catalog-ncm-filter">NCM</label><select id="catalog-ncm-filter" value={productFilterDraft.ncm_presence} onChange={event => draft({ ncm_presence: event.target.value })}><option value="">Selecione uma opção</option><option value="missing">Sem NCM</option><option value="present">Com NCM</option></select></div>
      {productFilterDraft.ncm_presence === 'present' && <div className="form-field"><label htmlFor="catalog-ncm-number-filter">Número NCM</label><input id="catalog-ncm-number-filter" inputMode="numeric" value={productFilterDraft.ncm} minLength={2} maxLength={8} pattern="[0-9]{2,8}" title="Informe de 2 a 8 dígitos do NCM." onChange={event => draft({ ncm: event.target.value.replace(/\D/g, '') })} /></div>}
      <div className="form-field"><label htmlFor="catalog-item-type-filter">Classificação</label><select id="catalog-item-type-filter" value={productFilterDraft.item_type} onChange={event => draft({ item_type: event.target.value })}><option value="">Todas</option>{ITEM_TYPE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label.slice(3)}</option>)}</select></div>
      <div className="form-field"><label htmlFor="catalog-type-filter">Tipo</label><select id="catalog-type-filter" value={productFilterDraft.type} onChange={event => draft({ type: event.target.value, ...(event.target.value === 'composition' ? {} : { component_id: '', component_name: '' }) })}><option value="">Todos</option>{PRODUCT_TYPE_FILTERS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
      {/* Origin: "Produtos com composição" reveals Componente; the compositions whose current Estrutura uses the product. */}
      {productFilterDraft.type === 'composition' && <div className="form-field"><label htmlFor="catalog-component-filter">Componente</label><input id="catalog-component-filter" value={productFilterDraft.component_id ? productFilterDraft.component_name : product.componentSearch.query} maxLength={120} autoComplete="off" placeholder="Digite o nome ou código"
        onChange={event => { draft({ component_id: '', component_name: '' }); product.setComponentSearch({ query: event.target.value, options: [], state: event.target.value.trim() ? 'busy' : 'idle' }); }} />
        {product.componentSearch.state === 'busy' && <small role="status">Pesquisando…</small>}{product.componentSearch.state === 'error' && <small className="is-error">Não foi possível pesquisar os produtos.</small>}
        {!productFilterDraft.component_id && product.componentSearch.query.trim() && product.componentSearch.state === 'idle' && !componentOptions.length && <small>Nenhum produto simples ativo encontrado.</small>}
        {!productFilterDraft.component_id && componentOptions.length > 0 && <ul className="product-options" role="listbox" aria-label="Componentes encontrados">{componentOptions.map(option => <li key={option.id}><button type="button" role="option" aria-selected={false} onClick={() => { draft({ component_id: option.id, component_name: option.name }); product.setComponentSearch({ query: option.name, options: [], state: 'idle' }); }}>{option.name}{option.code ? ` (${option.code})` : ''}</button></li>)}</ul>}
        <small className="real-help">Uma composição importada só entra neste filtro depois que a estrutura dela é informada no FAGOO.</small></div>}
      <div className="form-field"><label htmlFor="catalog-brand-filter">Marca</label><input id="catalog-brand-filter" value={productFilterDraft.brand} maxLength={100} onChange={event => draft({ brand: event.target.value })} /></div>
      <div className="form-field"><label htmlFor="catalog-supplier-filter">Fornecedor</label><input id="catalog-supplier-filter" value={productFilterDraft.supplier_id ? productFilterDraft.supplier_name : product.supplierSearch.query} maxLength={120} autoComplete="off" placeholder="Digite o nome do fornecedor"
        onChange={event => { draft({ supplier_id: '', supplier_name: '' }); product.setSupplierSearch({ query: event.target.value, options: [] }); }} />
        {!productFilterDraft.supplier_id && supplierOptions.length > 0 && <ul className="product-options" role="listbox" aria-label="Fornecedores encontrados">{supplierOptions.map(option => <li key={option.id}><button type="button" role="option" aria-selected={false} onClick={() => { draft({ supplier_id: option.id, supplier_name: option.name }); product.setSupplierSearch({ query: option.name, options: [] }); }}>{option.name}</button></li>)}</ul>}</div>
      <div className="form-field"><label htmlFor="catalog-supplier-code-filter">Cód fornecedor</label><input id="catalog-supplier-code-filter" value={productFilterDraft.supplier_code} maxLength={60} onChange={event => draft({ supplier_code: event.target.value })} /></div>
      <ProductCustomFilter value={productFilterDraft.custom} onChange={custom => draft({ custom })} fields={product.customFields.fields} onLoad={product.customFields.load} categories={categories} />
    </>,
    filterFooter: <button type="button" className="secondary-button" onClick={list.clear}>Limpar filtros</button>,
    chips: [
      { label: `Situação: ${label(PRODUCT_SITUATIONS, productFilters.situation)}`, onRemove: () => changeList(() => { list.setProductFilters(previous => ({ ...previous, situation: previous.situation === 'latest' ? 'active' : 'latest' })); setProductFilterDraft(previous => ({ ...previous, situation: previous.situation === 'latest' ? 'active' : 'latest' })); }) },
      ...(selectedItems.length ? [{ label: `Selecionados: ${selectedLabel}`, onRemove: () => list.setSelection({ key: list.listKey, ids: new Set(), anchor: null }) }] : []),
      ...(productFilters.stock ? [{ label: `${isOriginStockFilter(productFilters.stock) ? `Estoque Origin (físico): ${ORIGIN_STOCK_FILTERS.find(option => option.value === productFilters.stock)?.label}` : `Estoque: ${STOCK_FILTERS.find(option => option.value === productFilters.stock)?.label}`}${productFilters.warehouse_id ? ` (${warehouseName(productFilters.warehouse_id)}${isOriginStockFilter(productFilters.stock) && originPage?.warehouse?.linked === false ? ', sem correspondência no Origin' : ''})` : ''}`, onRemove: productFilter('stock') }] : []),
      ...(productFilters.images ? [{ label: `Imagens: ${productFilters.images === 'yes' ? 'Sim' : 'Não'}`, onRemove: productFilter('images') }] : []),
      ...(productFilters.tag ? [{ label: `Tags: ${tagLabel(productFilters.tag)}`, onRemove: productFilter('tag') }] : []),
      ...(productFilters.category ? [{ label: `Categoria: ${categoryLabel(productFilters.category)}`, onRemove: productFilter('category') }] : []),
      ...(productFilters.ncm_presence ? [{ label: `NCM: ${productFilters.ncm_presence === 'present' ? 'Com NCM' : 'Sem NCM'}${productFilters.ncm ? ` ${productFilters.ncm}` : ''}`, onRemove: productFilter('ncm_presence') }] : []),
      ...(productFilters.item_type ? [{ label: `Classificação: ${label(ITEM_TYPE_OPTIONS, productFilters.item_type).slice(3)}`, onRemove: productFilter('item_type') }] : []),
      ...(productFilters.type ? [{ label: `Tipo: ${label(PRODUCT_TYPE_FILTERS, productFilters.type)}`, onRemove: productFilter('type') }] : []),
      ...(productFilters.type === 'composition' && productFilters.component_id ? [{ label: `Componente: ${productFilters.component_name}`, onRemove: productFilter('component_id') }] : []),
      ...(productFilters.brand ? [{ label: `Marca: ${productFilters.brand}`, onRemove: productFilter('brand') }] : []),
      ...(productFilters.supplier_id ? [{ label: `Fornecedor: ${productFilters.supplier_name}`, onRemove: productFilter('supplier_id') }] : []),
      ...(productFilters.supplier_code ? [{ label: `Cód fornecedor: ${productFilters.supplier_code}`, onRemove: productFilter('supplier_code') }] : []),
      ...(customRows.length ? [{ label: `Campos customizados: ${customRows.map(customRowLabel).join(' · ')}`, onRemove: productFilter('custom') }] : []),
    ],
    tools: <><SalesBagButton bag={product.salesBag} /><ToolButton icon="print" title="Imprimir" disabled={!list.page?.total} onClick={() => product.setPrinting('list')} />{writable ? deletedView
      ? <button type="button" className="secondary-button" title="Restaurar selecionados" aria-label="Restaurar selecionados" disabled={!selectedItems.length} onClick={() => product.openBatch('restore', selectedItems)}><Icon name="rotate-left" size={13} /></button>
      : <button type="button" className={`secondary-button${selectedItems.length ? ' is-danger' : ''}`} title="Excluir selecionados" aria-label="Excluir selecionados" disabled={!selectedItems.length} onClick={() => product.openBatch('delete', selectedItems)}><Icon name="trash-can" size={13} /></button> : null}</>,
    actions: <><button type="button" className="action-button" disabled={!selectedItems.length} title={selectedItems.length ? undefined : 'Selecione os produtos na listagem'} onClick={() => product.setLabels(selectedItems.map(labelOf))}><Icon name="print" size={14} />Imprimir etiquetas selecionadas</button>
    <details className="catalog-more" open><summary>Mais ações</summary>
      <h4>Planilhas</h4>
      <Link className="action-button" to={`/exportacao-produtos?${new URLSearchParams({ ...exportFilters, ...(list.sort === 'created_desc' ? {} : { sort: list.sort }) })}`}><Icon name="file-export" size={14} />Exportar dados para planilha</Link>
      {customApi && <small className="real-help">A exportação não usa o filtro Campos customizados.</small>}
      {/* Estoque lane (222): structures of the compositions (always, as in Origin). */}
      <Link className="action-button" to="/exportacao-produtos?tipo=estrutura"><Icon name="file-export" size={14} />Exportar dados de estrutura para planilha</Link>
      {writable && !deletedView && <><h4>Edição</h4>
        <button type="button" className="action-button" disabled={!selectedItems.length} title={selectedItems.length ? undefined : 'Selecione os produtos na listagem'} onClick={() => list.openSituation(selectedItems, !selectedItems.every(item => item.active), true)}><Icon name="adjust" size={14} />{PRODUCT_LIST_LABELS.situation}</button>
        <button type="button" className="action-button" disabled={!selectedItems.length} title={selectedItems.length ? undefined : 'Selecione os produtos na listagem'} onClick={() => product.openBatch('category', selectedItems)}><Icon name="sitemap" size={14} />Incluir categorias para selecionados</button>
        <button type="button" className="action-button" disabled={!selectedItems.length || !taxonomies.tags} title={selectedItems.length ? undefined : 'Selecione os produtos na listagem'} onClick={() => product.setTagsFor(selectedItems.map(item => ({ id: item.id, label: item.name, version: item.version, deleted: item.deleted === true })))}><Icon name="tags" size={14} />Incluir tags para selecionados</button>
        <button type="button" className="action-button" aria-pressed={product.adjust.open} onClick={() => { discardPrice(); product.adjust.setOpen(true); }}><Icon name="dollar-sign" size={14} />Reajuste e sincronização de preços</button>
        <StockTransferBatchAction controller={list.controller} items={selectedItems} /></>}
      <h4>Relatórios</h4>
      <button type="button" className="action-button" disabled={!list.page?.total} onClick={() => product.setPrinting('prices')}><Icon name="print" size={14} />Relatório de preço dos produtos</button>
      <h4>Listas de Preços</h4>
      {writable ? <><button type="button" className="action-button" onClick={() => list.changeList(() => product.setPriceList({ kind: 'create', products: deletedView ? [] : selectedItems.map(item => ({ id: item.id, name: item.name })) }))}><Icon name="plus" size={14} />Criar lista de preço</button>
        <button type="button" className="action-button" disabled={!selectedItems.length || deletedView} title={selectedItems.length ? deletedView ? 'Produtos excluídos não entram em listas de preços.' : undefined : 'Selecione os produtos na listagem'} onClick={() => list.changeList(() => product.setPriceList({ kind: 'link', products: selectedItems.map(item => ({ id: item.id, name: item.name })) }))}><Icon name="link" size={14} />Vincular a uma lista</button></>
        : <Link className="action-button" to="/listas-precos"><Icon name="list" size={14} />Listas de preços</Link>}
    </details></>,
    beforeTable: <ListPreferencesBar prefs={prefs} columns={COLUMNS.filter(column => product.available.includes(column.id)).map(column => ({ id: column.id, label: column.label }))} currentFilters={productSavedFilters(productFilters, list.query)}
      drawer={{ note: 'Descrição fica sempre visível.', system: systemPortOf(list.controller) }} />,
    empty: { title: 'Nenhum resultado encontrado.', text: 'Verifique se as palavras estão corretas ou busque por outros termos.' },
    selections: [{ label: 'Com variações', onSelect: () => list.selectWhere(item => item.format === 'V') }, { label: 'Simples', onSelect: () => list.selectWhere(item => item.format === 'S') }, { label: 'Serviços', onSelect: () => list.selectWhere(item => item.kind === 'S') }, { label: 'Todos', onSelect: () => list.selectWhere(() => true) }, { label: 'Nenhum', onSelect: () => list.selectWhere(() => false) }],
    headers: <>{columns.includes('image') && header('image')}{list.sortHeader('name', 'Descrição')}{columns.filter(id => id !== 'image').map(header)}{adjusting && <><th scope="col" aria-hidden="true">›</th><th scope="col" className="numeric">Novo Preço</th></>}<th scope="col">Marcadores</th></>,
    cells: item => <>{columns.includes('image') && cell(item, 'image')}<td className="catalog-name-cell">{list.nameCell(item).props.children}{copyButton(item.name, 'a descrição', item.name)}</td>{columns.filter(id => id !== 'image').map(id => cell(item, id))}{adjusting && <><td aria-hidden="true">›</td><td className="numeric catalog-new-price"><NewPriceCell entry={product.adjust.entries?.get(item.id)} /></td></>}<td><StockCube item={item} visible={stockVisible} origin={originPage} byWarehouse={Boolean(productFilters.warehouse_id)} /><SalesBagRowAdd bag={product.salesBag} product={{ id: item.id, name: item.name, active: item.active !== false && item.deleted !== true }} unit={typeof item.unit === 'string' ? item.unit : null} /></td></>,
    rowItems,
    overlay: <>
      <SalesBagDrawer bag={product.salesBag} onGenerate={() => list.changeList(product.generateFromBag)} />
      {product.stockView && <StockView item={product.stockView.item} balances={product.stockView.balances} error={product.stockView.error} onClose={product.closeStock} />}
      {product.tagsFor && <TagsDrawer controller={list.controller} writable={writable} tags={tags} groups={tagGroups} selected={[]} title="Incluir tags para selecionados" applyLabel="Incluir tags" onCancel={() => product.setTagsFor(null)}
        onApply={ids => { const items = product.tagsFor!; product.setTagsFor(null); if (ids.length) product.openBatch('tags', list.page?.items.filter(item => items.some(row => row.id === item.id)) ?? [], ids); }} />}
      {product.labels && <ProductLabels products={product.labels} onClose={() => product.setLabels(null)} />}
      {product.printing && <ProductListPrint key={product.printing} controller={list.controller} filters={{ ...apiFilters, ...(list.sort === 'created_desc' ? {} : { sort: list.sort }) }}
        // Relatório de preço dos produtos: Código, Unidade, Preço and, with the preference "Exibir estoque do produto no relatório de preço", Estoque.
        columns={product.printing === 'prices' ? ['code', 'unit', 'price', ...(product.settings.stockInPriceReport && stockVisible ? ['stock'] : [])] : columns.filter(id => id !== 'stock' || stockVisible)}
        title={product.printing === 'prices' ? 'Relatório de preço dos produtos' : 'Produtos'} subtitle={product.printing === 'prices' ? 'Preço de venda dos produtos dos filtros aplicados.' : undefined}
        filterText={[`Situação: ${label(PRODUCT_SITUATIONS, productFilters.situation)}`, ...(list.query ? [`Pesquisa: ${list.query}`] : []), ...(Object.keys(apiFilters).filter(key => !['situation', 'q'].includes(key)).length ? [`${Object.keys(apiFilters).filter(key => !['situation', 'q'].includes(key)).length} filtro(s) aplicado(s)`] : [])].join(' · ')} onClose={() => product.setPrinting(null)} />}
      {adjusting && <PriceAdjustmentBar adjust={product.adjust} selected={selectedItems.map(item => ({ id: item.id, version: item.version, name: item.name }))} filters={adjustFilters} total={list.page?.total ?? 0}
        onDone={text => { list.setNotice(text); list.setSelection({ key: '', ids: new Set(), anchor: null }); list.setReload(value => value + 1); }} />}
      {product.priceList?.kind === 'create' && <PriceListWizard controller={list.controller} products={product.priceList.products} onClose={() => product.setPriceList(null)}
        onSaved={saved => { product.setPriceList(null); list.setNotice(`Lista de preços “${saved.name}” criada${saved.products ? ` com ${saved.products} produto(s)` : ''}. Abra Listas de preços para conferir os preços.`); }} />}
      {product.priceList?.kind === 'link' && <LinkToPriceList controller={list.controller} products={product.priceList.products} onClose={() => product.setPriceList(null)}
        onDone={saved => { product.setPriceList(null); list.setNotice(`Produtos vinculados à lista “${saved.name}” (${saved.products} produto(s) na lista).`); }} />}
      {product.batch && product.batchPlan && <BatchDialog title={BATCH_TITLE[product.batch.kind]} plan={product.batchPlan} confirmLabel={product.batch.kind === 'delete' ? 'Excluir' : product.batch.kind === 'restore' ? 'Restaurar' : product.batch.kind === 'category' ? 'Incluir categoria aos produtos' : 'Incluir tags'}
        canConfirm={product.batch.kind !== 'category' || Boolean(product.batch.category)} run={product.runBatch(product.batch)} onClose={product.closeBatch}
        description={product.batch.kind === 'category' ? <div className="form-field"><label htmlFor="catalog-batch-category">Incluir categoria no cadastro do produto:<span className="product-info" title="Categoria referente aos campos customizados, sem vínculo com as integrações multiloja"><Icon name="circle-info" size={11} /></span></label>
          <select id="catalog-batch-category" value={product.batch.category} disabled={product.batch.locked} onChange={event => product.setBatch(current => current && !current.locked ? { ...current, category: event.target.value } : current)}><option value="">Selecione uma categoria</option>
            {taxonomyTree(categories).map(({ item, depth }) => <option key={item.id} value={item.id}>{`${'  '.repeat(depth)}${depth ? '└ ' : ''}${item.name}`}</option>)}</select></div>
          : product.batch.kind === 'tags' ? <p>Tags incluídas: {product.batch.tags.map(id => tags.find(tag => tag.id === id)?.name ?? '').filter(Boolean).join(', ')}. As tags que o produto já tem continuam.</p>
          : product.batch.kind === 'delete' ? <p>Os produtos excluídos ficam inativos, fora das situações padrão e dos seletores dos documentos, e podem ser restaurados na Situação “Excluídos”.</p> : undefined} />}
    </>,
  };
}
export { fold };
