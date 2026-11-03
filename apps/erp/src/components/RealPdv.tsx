import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import type { AccessController } from '../lib/real-access';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { useFinanceCommand, type FinanceCommand } from '../lib/finance-command';
import { ORIGIN_MENU } from '../lib/origin-menu';
import { preferencePage, preferencePageHref } from '../../../../packages/erp-domain/src/preferences/catalog.mjs';
import { INVOICE_STATUS } from '../../../../packages/erp-domain/src/fiscal-invoice-dto.mjs';
import { productListPrice } from '../lib/document-price-list-model';
import { EMPTY_POSITION_FILTERS, positionParams, stockPositionPage } from '../lib/stock-positions-model';
import { decimal, format } from '../../../../packages/erp-domain/src/index.mjs';
import { quickContactInitial, type QuickContactValues } from '../lib/document-editor-pickers';
import type { CatalogRecord } from '../lib/catalog-model';
import {
  addToCart, cartTotals, cashChange, dateTimeSP, decimalInput, EFFECT_LABELS, effectReasonText, finishNotice, generatePayments, itemDiscountPercent, lineTotals, money, moneyCents, paymentsTotal, pdvContext, pdvFailure,
  pdvFavorites, pdvReturnMessage, pdvSale, pdvSalesPage, pixCents, priceInput, quantityInput, quantityText, removeOneByCode, SALE_STATES, saleDocument, totalCents, dueDate, centsText, unitMoney,
  type CartItem, type Named, type PaymentRow, type PdvContext, type PdvFavorite, type PdvSale, type PdvSaleSummary, type PdvSession,
} from '../lib/pdv-model';
import { isMac, pdvActionFor, pdvShortcuts, shortcutHint, type PdvAction } from '../lib/pdv-shortcuts';
import { pixPayload } from '../lib/pix-static';
import { CatalogPicker } from './DocumentCatalogPicker';
import DocumentQuickContact from './DocumentQuickContact';
import DocumentContactSearch from './DocumentContactSearch';
import ProductAdvancedSearch from './ProductAdvancedSearch';
import DocumentSellerPicker, { type SellerOption } from './DocumentSellerPicker';
import DocumentCategoryPicker from './DocumentCategoryPicker';
import DocumentPriceList from './DocumentPriceList';
import FinanceContactOpenTitles from './FinanceContactOpenTitles';
import PdvReceiptPrint, { type PdvPrintJob } from './PdvReceiptPrint';
import { PdvCancelDialog, PdvCloseDialog, PdvGtinDialog, PdvMoveDialog, PdvPixDialog, PdvReturnDialog, PdvSettingsDialog, PdvShortcutsDialog, PdvStoreDialog, PdvTableDialog } from './PdvDialogs';
import { Icon } from './Icon';
import './pdv.css';
import './real-pdv.css';

type Tab = 'produto' | 'cliente' | 'pagamento';
type Contact = { id: string; name: string; document: string | null; person_type: string | null; code: string | null; trade_name: string | null; state: string | null };
interface Draft {
  saleId: string | null; version: number; number: string | null; record: PdvSale | null; kind: 'balcao' | 'mesa'; table: number | null; savedItems: Record<string, string>;
  cart: CartItem[]; contact: Contact | null; priceList: Named | null; discountMode: 'amount' | 'percent'; discountValue: string; freight: string; other: string;
  payments: PaymentRow[]; autoPayment: boolean; received: string; destination: string; category: Named | null; seller: SellerOption | null; expected: string; warehouse: string; notes: string; internalNotes: string;
}
interface ProductForm { record: (CatalogRecord & { gtin?: unknown }) | null; quantity: string; discount: string; discountMode: 'amount' | 'percent'; price: string; listPrice: string | null; comment: string }
type Dialog = { kind: 'store' } | { kind: 'move'; move: 'withdrawal' | 'supply' } | { kind: 'close' } | { kind: 'settings' } | { kind: 'table'; mode: 'new' | 'transfer' } | { kind: 'cancel'; sale: PdvSale }
  | { kind: 'return'; sale: PdvSale } | { kind: 'shortcuts' } | { kind: 'gtin' } | { kind: 'pix'; payload: string; amount: string | null; confirm: boolean } | { kind: 'contact'; initial: QuickContactValues } | { kind: 'contact_search'; query: string }
  // Pesquisa avançada (Alt+A) of the product.
  | { kind: 'product_search' };
const noSubscription = () => () => {}, noSnapshot = () => null;
const STORE_KEY = 'brufap.pdv.loja';
const readStore = () => { try { return globalThis.localStorage?.getItem(STORE_KEY) ?? null; } catch { return null; } };
const writeStore = (id: string) => { try { globalThis.localStorage?.setItem(STORE_KEY, id); } catch { /* Per-viewer convenience only. */ } };
const newKey = () => globalThis.crypto.randomUUID();
const emptyProduct = (percent: boolean): ProductForm => ({ record: null, quantity: '1', discount: '', discountMode: percent ? 'percent' : 'amount', price: '', listPrice: null, comment: '' });
const emptyDraft = (context: PdvContext | null, kind: 'balcao' | 'mesa' = 'balcao', table: number | null = null): Draft => ({ saleId: null, version: 0, number: null, record: null, kind, table, savedItems: {}, cart: [], contact: null, priceList: null,
  discountMode: context?.settings.percent_discount ? 'percent' : 'amount', discountValue: '', freight: '', other: '', payments: [], autoPayment: true, received: '', destination: '', category: null,
  seller: context?.seller ? { id: context.seller.id, name: context.seller.name } : null, expected: '', warehouse: context?.default_warehouse?.id ?? context?.warehouses[0]?.id ?? '', notes: '', internalNotes: '' });
const text = (value: unknown) => typeof value === 'string' ? value : null;
// The contacts picker brings the CPF/CNPJ but not the Tipo: 11 digits are a pessoa física, 14 a pessoa jurídica.
const personType = (document: string | null) => { const digits = document?.replace(/\D/g, '') ?? ''; return digits.length === 11 ? 'F' : digits.length === 14 ? 'J' : null; };
const contactOf = (record: CatalogRecord): Contact => ({ id: record.id, name: record.name, document: text(record.document), person_type: text(record.person_type) ?? personType(text(record.document)), code: record.code, trade_name: text(record.trade_name), state: text(record.state) });
const PERSON_TYPES: Record<string, string> = { J: 'Pessoa jurídica', F: 'Pessoa física', E: 'Estrangeiro' };

/** Sale adjustments typed in the screen ("10,00" or "10%"): the pedido keeps the mode and the exact decimal. */
function adjustments(draft: Draft) {
  const value = draft.discountValue.trim();
  const discount = !value ? '0' : draft.discountMode === 'percent' ? decimalInput(value, 4, 3, 'Informe o desconto da venda em % com até quatro casas.') : (BigInt(moneyCents(value)) / 100n).toString() + '.' + String(BigInt(moneyCents(value)) % 100n).padStart(2, '0');
  const amount = (input: string, label: string) => { if (!input.trim()) return '0'; try { const cents = BigInt(moneyCents(input)); return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`; } catch { throw new Error(`Informe ${label} em reais, com até duas casas.`); } };
  return { discount_mode: draft.discountMode, discount_value: discount, freight: amount(draft.freight, 'o frete'), other_expenses: amount(draft.other, 'as outras despesas') };
}

/**
 * Vendas › Frente de caixa (Origin pdv.php) com dados reais: tela cheia, abas Produto (Alt+Z), Cliente (Alt+C) e Pagamento (Alt+B),
 * coluna dos pedidos do caixa, Operações (Abrir caixa, Sangria, Suprimento, Fechar caixa, Imprimir, Reimprimir última operação,
 * Gerar devolução, QR code fixo) e os atalhos configurados em Preferências. A venda finalizada é um pedido de venda Atendido; a
 * NFC-e é preparada pela tela de notas fiscais (homologação), a partir do pedido.
 */
export default function RealPdv({ controller }: { controller: AccessController }) {
  const tracked = typeof controller.getSnapshot === 'function';
  const snapshot = useSyncExternalStore(controller.subscribe ?? noSubscription, controller.getSnapshot ?? noSnapshot);
  const scopeOf = (s: ReturnType<AccessController['getSnapshot']> | null) => s?.phase === 'ready' && s.membership ? `${s.membership.user_id}:${s.membership.role}` : '';
  const scope = tracked ? scopeOf(snapshot) : 'isolated', current = useRef(scope); current.current = scope;
  const role = tracked ? snapshot?.membership?.role ?? '' : 'admin';
  const mayRead = () => current.current === scope && (!tracked || scopeOf(controller.getSnapshot()) === scope);
  const [loaded, setLoaded] = useState<{ scope: string; value: PdvContext | null; error: string }>({ scope: '', value: null, error: '' });
  const context = loaded.scope === scope ? loaded.value : null;
  const mayWrite = () => mayRead() && ['admin', 'vendas'].includes(role) && Boolean(context?.permissions.operate);
  const mayCash = () => mayRead() && ['admin', 'financeiro'].includes(role);
  const [reload, setReload] = useState(0), [salesReload, setSalesReload] = useState(0);
  const [store, setStore] = useState<{ store: Named; session: PdvSession | null } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null), [tab, setTab] = useState<Tab>('produto');
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(null)), [product, setProduct] = useState<ProductForm>(() => emptyProduct(false));
  const [barcode, setBarcode] = useState(false), [favoritesOpen, setFavoritesOpen] = useState(false), [favoritesGrid, setFavoritesGrid] = useState(true);
  const [favorites, setFavorites] = useState<{ key: string; items: PdvFavorite[] | null; error: string }>({ key: '', items: null, error: '' });
  const [sales, setSales] = useState<{ key: string; items: PdvSaleSummary[]; open: PdvSaleSummary[]; error: string } | null>(null), [query, setQuery] = useState(''), [search, setSearch] = useState('');
  const [selected, setSelected] = useState<{ id: string; record: PdvSale | null; error: string } | null>(null), [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false), [opsOpen, setOpsOpen] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [print, setPrint] = useState<PdvPrintJob | null>(null), [last, setLast] = useState<PdvPrintJob | null>(null), [pixConfirmed, setPixConfirmed] = useState(false);
  const [condition, setCondition] = useState(''), [method, setMethod] = useState('');
  const salesSearch = useRef<HTMLInputElement>(null);
  const mac = isMac(globalThis.navigator?.platform || '');
  const shortcuts = useMemo(() => pdvShortcuts(context?.settings.shortcuts), [context]);
  const hint = (action: PdvAction) => shortcutHint(shortcuts.find(item => item.action === action)?.key ?? '', mac);
  const sendPos = (command: FinanceCommand) => { if (!mayWrite()) return Promise.reject(new Error('Seu acesso a esta operação foi alterado.')); return controller.pos(command.path, { method: 'POST', body: { command_id: command.id, data: structuredClone(command.data) } }); };
  const sendFinance = (command: FinanceCommand) => { if (!mayCash()) return Promise.reject(new Error('Somente administrador e financeiro operam o caixa.')); return controller.finance(command.path, { method: 'POST', body: { command_id: command.id, data: structuredClone(command.data) } } as never); };
  const sale = useFinanceCommand(sendPos, mayWrite, pdvFailure), favorite = useFinanceCommand(sendPos, mayWrite, pdvFailure), tableCommand = useFinanceCommand(sendPos, mayWrite, pdvFailure);
  const dirty = draft.cart.length > 0 || Boolean(draft.contact) || draft.payments.length > 0;
  const guard = useUnsavedChanges(dirty, sale.locked || tableCommand.locked);

  // ---------------------------------------------------------------- Leituras
  useEffect(() => {
    if (tracked && !scope) return; const request = new AbortController(), key = scope;
    void controller.pos('/v1/frente-caixa', { signal: request.signal }).then(value => { if (!request.signal.aborted && mayRead()) setLoaded({ scope: key, value: pdvContext(value), error: '' }); })
      .catch(failure => { if (!request.signal.aborted && mayRead()) setLoaded({ scope: key, value: null, error: pdvFailure(failure) }); });
    return () => request.abort();
  }, [controller, scope, reload]);
  // The loja (per-viewer convenience) and its caixa: with "Utilizar controle de caixa" the screen asks for the loja and the caixa.
  useEffect(() => {
    if (!context) return;
    setDraft(previous => previous.cart.length || previous.saleId ? previous : emptyDraft(context, previous.kind, previous.table));
    setProduct(previous => previous.record ? previous : emptyProduct(context.settings.percent_discount));
    const id = store?.store.id ?? readStore(), found = context.stores.find(item => item.id === id) ?? (context.stores.length === 1 ? context.stores[0]! : null);
    const asks = context.permissions.operate || context.effects.cash;
    if (!found) { setStore(null); if (context.stores.length && asks) setDialog(current => current ?? { kind: 'store' }); return; }
    const session = context.cash_sessions.find(item => item.account_id === found.id && item.own) ?? context.cash_sessions.find(item => item.account_id === found.id) ?? null;
    setStore({ store: found, session });
    if (context.settings.cash_control && !session && !store && asks) setDialog(current => current ?? { kind: 'store' });
  }, [context]);
  const salesKey = `${scope}:${store?.store.id ?? ''}:${store?.session?.id ?? ''}:${search}:${salesReload}`;
  useEffect(() => {
    if (!context) return; const request = new AbortController(), key = salesKey;
    const params = new URLSearchParams({ state: 'all', limit: '50' });
    if (store?.session) params.set('caixa', store.session.id); else { params.set('from', context.today); params.set('to', context.today); }
    if (search) params.set('q', search);
    void Promise.all([controller.pos(`/v1/frente-caixa/vendas?${params}`, { signal: request.signal }), controller.pos('/v1/frente-caixa/vendas?state=open&limit=50', { signal: request.signal })]).then(([page, open]) => {
      if (!request.signal.aborted && mayRead()) setSales({ key, items: pdvSalesPage(page).items, open: pdvSalesPage(open).items, error: '' });
    }).catch(failure => { if (!request.signal.aborted && mayRead()) setSales({ key, items: [], open: [], error: pdvFailure(failure) }); });
    return () => request.abort();
  }, [controller, context, salesKey]);
  useEffect(() => {
    if (!selected || selected.record || selected.error) return; const request = new AbortController(), id = selected.id;
    void controller.pos(`/v1/frente-caixa/vendas/${id}`, { signal: request.signal }).then(value => { if (!request.signal.aborted && mayRead()) setSelected(previous => previous?.id === id ? { id, record: pdvSale(value), error: '' } : previous); })
      .catch(failure => { if (!request.signal.aborted && mayRead()) setSelected(previous => previous?.id === id ? { id, record: null, error: pdvFailure(failure) } : previous); });
    return () => request.abort();
  }, [controller, selected?.id, selected?.record, selected?.error]);
  const favoritesKey = `${scope}:${draft.warehouse}:${favoritesOpen}:${salesReload}`;
  useEffect(() => {
    if (!favoritesOpen || !context) return; const request = new AbortController(), key = favoritesKey;
    void controller.pos(`/v1/frente-caixa/favoritos${draft.warehouse ? `?warehouse=${draft.warehouse}` : ''}`, { signal: request.signal }).then(value => { if (!request.signal.aborted && mayRead()) setFavorites({ key, items: pdvFavorites(value), error: '' }); })
      .catch(failure => { if (!request.signal.aborted && mayRead()) setFavorites({ key, items: null, error: pdvFailure(failure) }); });
    return () => request.abort();
  }, [controller, context, favoritesKey]);

  // ---------------------------------------------------------------- Totais e pagamento
  let totals: ReturnType<typeof cartTotals> | null = null, totalsError = '';
  try { totals = cartTotals(draft.cart, adjustments(draft)); } catch (failure) { totalsError = failure instanceof Error && !/^DOCUMENT_/.test(failure.message) ? failure.message : 'Confira descontos, frete e outras despesas da venda.'; }
  const total = totals ? totalCents(totals) : '0';
  const methods = context?.methods ?? [];
  // "Método de pagamento padrão: PIX - QR Code impresso" starts the payment in Pix (with the company key); otherwise the forma padrão, Dinheiro or the first one.
  const defaultMethod = (context?.settings.default_method === 'pix_qrcode_impresso' && context.pix ? methods.find(item => ['17', '20'].includes(item.payment_type)) : undefined)
    ?? methods.find(item => item.is_default) ?? methods.find(item => item.payment_type === '01') ?? methods[0] ?? null;
  // One à vista parcel follows the total until the operator generates or edits the parcelas.
  useEffect(() => {
    if (!context || !draft.autoPayment) return;
    // Without "Registro de Pagamento" (vendedor) the pré-venda goes without parcelas: the caixa registers the payment.
    const wanted = total !== '0' && defaultMethod && context.permissions.payments ? [{ key: draft.payments[0]?.key ?? newKey(), payment_method_id: draft.payments[0]?.payment_method_id ?? defaultMethod.id, days: 0, amount_cents: total, note: '' }] : [];
    if (JSON.stringify(wanted.map(row => [row.payment_method_id, row.amount_cents])) !== JSON.stringify(draft.payments.map(row => [row.payment_method_id, row.amount_cents])) || wanted.length !== draft.payments.length) setDraft(previous => ({ ...previous, payments: wanted }));
  }, [context, total, draft.autoPayment, defaultMethod?.id]);
  let received: string | null = null, receivedError = '';
  try { received = draft.received.trim() ? moneyCents(draft.received) : null; } catch (failure) { receivedError = (failure as Error).message; }
  const change = cashChange(draft.payments, methods, received);
  const paid = paymentsTotal(draft.payments), mismatch = draft.payments.length > 0 && paid !== BigInt(total);

  // ---------------------------------------------------------------- Ações da venda
  const say = (message: string) => { if (mayRead()) { setNotice(message); setError(''); } };
  const fail = (message: string) => { if (mayRead()) { setError(message); setNotice(''); } };
  const newSale = (kind: 'balcao' | 'mesa' = 'balcao', table: number | null = null) => guard.confirmLeave(() => { setDraft(emptyDraft(context, kind, table)); setProduct(emptyProduct(Boolean(context?.settings.percent_discount))); setTab('produto'); setPixConfirmed(false); setCondition(''); setError(''); });
  const selectProduct = async (record: CatalogRecord | null) => {
    if (!record) { setProduct(previous => ({ ...previous, record: null, price: '', listPrice: null })); return; }
    const cadastro = text(record.price) ?? '0';
    setProduct(previous => ({ ...previous, record, price: cadastro, listPrice: null, quantity: previous.quantity || '1' }));
    if (!draft.priceList) return;
    try {
      const list = productListPrice(await controller.catalog(`/v1/cadastros/products/${record.id}/listas-precos`), record.id, draft.priceList.id);
      if (mayRead()) setProduct(previous => previous.record?.id === record.id ? { ...previous, price: list ?? cadastro, listPrice: list } : previous);
    } catch { /* Without the list price the cadastro price stays. */ }
  };
  /** Saldo físico do produto no depósito da venda (null quando não dá para conferir aqui; o banco confere de novo ao gravar). */
  const stockOf = async (record: CatalogRecord): Promise<bigint | null> => {
    if (!draft.warehouse || text(record.kind) !== 'P') return null;
    try {
      const filters = { ...EMPTY_POSITION_FILTERS, q: (record.code ?? record.name).slice(0, 120), active: 'true' as const, warehouse_id: draft.warehouse };
      const row = stockPositionPage(await controller.stockPositions(`/v1/posicoes-estoque?${positionParams(filters)}`), filters).items.find(item => item.product.id === record.id);
      if (!row?.selected_position) return null;
      const quantity = row.selected_position.quantity;
      return row.selected_position.state === 'no_movements' ? 0n : quantity === null ? null : decimal(quantity.replace('-', ''), 6, 12) * (quantity.startsWith('-') ? -1n : 1n);
    } catch { return null; }
  };
  const insert = async (form: ProductForm = product): Promise<string | null> => {
    if (!context?.permissions.items) return 'Seu vendedor não pode registrar itens na frente de caixa.';
    if (!form.record) return 'Escolha um produto para inserir.';
    if (form.record.active !== true) return `O produto ${form.record.name} está inativo e não pode ser incluído.`;
    let line: CartItem;
    try {
      const quantity = quantityInput(form.quantity || '1'), price = priceInput(form.price || '0');
      const discount = context.settings.item_discount ? itemDiscountPercent(quantity, price, form.discountMode, form.discount) : '0';
      line = { id: newKey(), product_id: form.record.id, description: form.record.name.slice(0, 200), code: form.record.code, unit: text(form.record.unit) ?? 'UN', quantity, unit_price: price,
        discount_percent: discount, comment: form.comment.trim() || null, list_price: form.listPrice, kind: text(form.record.kind), gtin: text(form.record.gtin) };
      lineTotals(line);
    } catch (failure) { return failure instanceof Error && !/^DOCUMENT_/.test(failure.message) ? failure.message : 'Confira a quantidade, o valor unitário e o desconto do item.'; }
    // Preferências › Frente de caixa: "Bloquear vendas com quantidade zero" e "Permite incluir produtos com estoque negativo".
    if (context.settings.block_zero || !context.settings.negative_stock) {
      const stock = await stockOf(form.record);
      if (!mayRead()) return null;
      if (stock !== null) {
        const wanted = draft.cart.filter(item => item.product_id === line.product_id).reduce((sum, item) => sum + decimal(item.quantity, 6, 9), decimal(line.quantity, 6, 9));
        if (context.settings.block_zero && stock <= 0n) return `O produto ${line.description} está com estoque zero no depósito da venda.`;
        if (!context.settings.negative_stock && wanted > stock) return `Estoque insuficiente de ${line.description} no depósito da venda (saldo ${quantityText(format(stock < 0n ? 0n : stock, 6))}).`;
      }
    }
    setDraft(previous => ({ ...previous, cart: addToCart(previous.cart, line, context.settings.group_items) }));
    setProduct(emptyProduct(context.settings.percent_discount)); return null;
  };
  const priceOf = async (record: CatalogRecord): Promise<{ price: string; list: string | null }> => {
    const cadastro = text(record.price) ?? '0';
    if (!draft.priceList) return { price: cadastro, list: null };
    try { const list = productListPrice(await controller.catalog(`/v1/cadastros/products/${record.id}/listas-precos`), record.id, draft.priceList.id); return { price: list ?? cadastro, list }; }
    catch { return { price: cadastro, list: null }; }
  };
  // Leitor de código de barras ligado: o código ou GTIN exato inclui o produto direto, com a quantidade do campo.
  const onCode = (record: CatalogRecord) => {
    if (!barcode) { void selectProduct(record); return `Produto ${record.name} selecionado.`; }
    const quantity = product.quantity || '1';
    void (async () => { const { price, list } = await priceOf(record); if (!mayRead()) return; const message = await insert({ ...emptyProduct(Boolean(context?.settings.percent_discount)), record, quantity, price, listPrice: list }); if (message) fail(message); })();
    return `Produto ${record.name} incluído.`;
  };
  const removeLine = (id: string) => { if (draft.savedItems[id] !== undefined && !context?.permissions.remove_items) { fail('Seu vendedor não pode excluir itens da venda.'); return; } setDraft(previous => ({ ...previous, cart: previous.cart.filter(item => item.id !== id) })); };
  const removeByCode = (code: string): string | null => {
    if (!code.trim()) return 'Informe o código ou GTIN.';
    const removed = removeOneByCode(draft.cart, code);
    if (!removed) return `Nenhum item da venda tem o código ou GTIN ${code.trim().slice(0, 40)}.`;
    if (draft.savedItems[removed.item.id] !== undefined && !context?.permissions.remove_items) return 'Seu vendedor não pode excluir itens da venda.';
    setDraft(previous => ({ ...previous, cart: removeOneByCode(previous.cart, code)?.cart ?? previous.cart }));
    say(`Uma unidade de ${removed.item.description} foi removida.`); return null;
  };
  // "Aplicar a lista aos itens": the lines of products in the list take its price; the others keep theirs.
  const [repricing, setRepricing] = useState('');
  const applyList = async () => {
    const list = draft.priceList; if (!list) return;
    setRepricing('Aplicando a lista aos itens…');
    try {
      const prices = new Map<string, string | null>();
      for (const id of [...new Set(draft.cart.flatMap(item => item.product_id ? [item.product_id] : []))]) prices.set(id, productListPrice(await controller.catalog(`/v1/cadastros/products/${id}/listas-precos`), id, list.id));
      if (!mayRead()) return;
      setDraft(previous => previous.priceList?.id !== list.id ? previous : ({ ...previous, cart: previous.cart.map(item => { const price = item.product_id ? prices.get(item.product_id) : null; return price ? { ...item, unit_price: price, list_price: price } : item; }) }));
      say(`Lista ${list.name} aplicada aos itens.`);
    } catch { fail('Não foi possível consultar a lista de preços. Os preços dos itens não mudaram.'); }
    finally { if (mayRead()) setRepricing(''); }
  };
  const generate = () => {
    try {
      const chosen = method || defaultMethod?.id || '', rows = generatePayments(total, condition || '0', chosen);
      setDraft(previous => ({ ...previous, payments: rows, autoPayment: false }));
    } catch (failure) { fail((failure as Error).message); }
  };
  const saleData = (finishing: boolean) => {
    if (!context) throw new Error('Aguarde a leitura da frente de caixa.');
    if (!draft.cart.length) throw new Error('Inclua ao menos um produto antes de finalizar.');
    if (totalsError) throw new Error(totalsError);
    if (finishing && !draft.payments.length) throw new Error('Registre o pagamento da venda antes de finalizar.');
    if (context.permissions.payments && draft.payments.length && mismatch) throw new Error('A soma das parcelas precisa ser igual ao total da venda. Gere as parcelas novamente.');
    if (receivedError) throw new Error(receivedError);
    if (context.permissions.payments && received !== null && BigInt(received) < change.cash) throw new Error('O valor recebido em dinheiro precisa cobrir as parcelas à vista em dinheiro ou cheque.');
    if (context.settings.cash_control && finishing && !store?.session) throw new Error('Para habilitar as funcionalidades do frente de caixa, o caixa deve ser aberto.');
    if (draft.destination === 'ficha' && !draft.contact) throw new Error('O destino Ficha Financeira precisa do cliente identificado.');
    if (!draft.contact && !context.consumer) throw new Error('Informe o cliente ou defina o cliente padrão (Consumidor final) nas configurações da frente de caixa.');
    // document_version: the pedido as the screen read it; a change in Pedidos de venda meanwhile is refused (the sale is reopened).
    return { sale_id: draft.saleId, expected_version: draft.version, document_version: draft.saleId ? draft.record?.document_version ?? null : null, kind: draft.kind, table_number: draft.table, account_id: store?.store.id ?? null, cash_session_id: store?.session?.id ?? null,
      contact_id: draft.contact?.id ?? null, price_list_id: draft.priceList?.id ?? null,
      document: saleDocument(draft.cart, adjustments(draft), { date: context.today, warehouse_id: draft.warehouse || null, expected_date: draft.expected || null, notes: draft.notes, internal_notes: draft.internalNotes,
        seller_id: draft.seller?.id ?? null, category_id: draft.category?.id ?? null }),
      payments: context.permissions.payments ? draft.payments.map(row => ({ payment_method_id: row.payment_method_id, days: row.days, amount_cents: row.amount_cents, note: row.note.trim() || null })) : [],
      destination_account_id: draft.destination && draft.destination !== 'ficha' ? draft.destination : null, to_ledger: draft.destination === 'ficha', cash_received_cents: context.permissions.payments && received !== null && change.cash > 0n ? received : null };
  };
  const pixFor = (record: PdvSale) => {
    if (!context?.pix || context.settings.default_method !== 'pix_qrcode_impresso') return null;
    const cents = record.payments.filter(row => row.days === 0 && ['17', '20'].includes(row.payment_type)).reduce((sum, row) => sum + BigInt(row.amount_cents), 0n);
    if (!cents) return null;
    try { return { payload: pixPayload({ keyType: context.pix.key_type, key: context.pix.key, merchantName: context.pix.merchant_name, merchantCity: context.pix.merchant_city, amountCents: cents.toString(), reference: `PDV${record.number}` }), amount_cents: cents.toString() }; } catch { return null; }
  };
  const afterSale = (record: PdvSale, finishing: boolean) => {
    const job: PdvPrintJob = { kind: 'sale', sale: record, pix: pixFor(record) };
    setLast(job); setDraft(emptyDraft(context)); setProduct(emptyProduct(Boolean(context?.settings.percent_discount))); setTab('produto'); setPixConfirmed(false); setCondition('');
    setSelected({ id: record.id, record, error: '' }); setSalesReload(value => value + 1);
    if (!finishing) { say(record.kind === 'mesa' ? `Comanda da mesa ${record.table_number} guardada (pedido nº ${record.number}).` : `Pré-venda nº ${record.number} enviada para o caixa.`); return; }
    // 202610200267: a refused Lançar estoque / Lançar contas / baixa à vista no longer refuses the sale; the message says why it stayed pending.
    say(`Venda nº ${record.number} finalizada.${record.effects ? finishNotice(record.effects) : ''}`);
    const operation = context?.settings.default_operation;
    if (operation === 'comprovante') setPrint(job);
    if ((operation === 'gerar_nfce' || operation === 'nfe_simplificada') && context?.effects.fiscal) { try { globalThis.window?.open(fiscalHref(record, operation === 'gerar_nfce' ? '65' : '55'), '_blank', 'noopener'); } catch { /* The link stays in the pedido panel. */ } }
  };
  const fiscalHref = (record: PdvSaleSummary, model: '55' | '65') => `/historico-fiscal?${new URLSearchParams({ modelo: model, origem: 'brufap', nota: 'nova', pedido: record.document_id })}`;
  const submit = (requested: 'finish' | 'save') => {
    if (!context) return;
    const mode = requested === 'finish' && (context.settings.default_operation === 'pre_venda' || !context.permissions.finish || !context.permissions.payments) ? 'save' : requested;
    if (mode === 'finish' && !sale.uncertain && context.pix && context.settings.default_method === 'pix_qrcode_impresso' && !pixConfirmed) {
      const cents = pixCents(draft.payments, methods);
      if (cents > 0n) { try { setDialog({ kind: 'pix', payload: pixPayload({ keyType: context.pix.key_type, key: context.pix.key, merchantName: context.pix.merchant_name, merchantCity: context.pix.merchant_city, amountCents: cents.toString(), reference: 'PDV' }), amount: cents.toString(), confirm: true }); return; } catch { /* Without a valid key the sale goes on. */ } }
    }
    void sale.run(() => ({ id: newKey(), path: `/v1/frente-caixa/actions/${mode === 'finish' ? 'sale_finish' : 'sale_save'}`, data: saleData(mode === 'finish') }), value => { if (mayRead()) afterSale(pdvSale(value), mode === 'finish'); });
  };
  const loadSale = (record: PdvSale) => guard.confirmLeave(() => {
    setDraft({ ...emptyDraft(context, record.kind, record.table_number), saleId: record.id, version: record.version, number: record.number, record,
      savedItems: Object.fromEntries(record.items.map(item => [item.id, item.quantity])),
      cart: record.items.map(item => ({ id: item.id, product_id: item.product_id, description: item.description, code: item.code, unit: item.unit, quantity: item.quantity.replace(/\.?0+$/, ''), unit_price: item.unit_price,
        discount_percent: item.discount_percent.replace(/\.?0+$/, '') || '0', comment: item.comment, list_price: null, kind: null })),
      contact: record.customer_identified ? { id: record.contact_id, name: record.contact_name, document: record.contact_document || null, person_type: null, code: null, trade_name: null, state: null } : null,
      discountMode: record.discount_mode, discountValue: record.discount_value === '0.00' || /^0+(\.0+)?$/.test(record.discount_value) ? '' : record.discount_value.replace('.', ','),
      freight: record.freight === '0.00' ? '' : record.freight.replace('.', ','), other: record.other_expenses === '0.00' ? '' : record.other_expenses.replace('.', ','),
      payments: record.payments.map(row => ({ key: newKey(), payment_method_id: row.payment_method_id, days: row.days, amount_cents: row.amount_cents, note: row.note ?? '' })), autoPayment: !record.payments.length,
      seller: record.seller_id ? { id: record.seller_id, name: record.seller_name ?? 'Vendedor' } : null, category: record.category_id ? { id: record.category_id, name: 'Categoria da venda' } : null,
      warehouse: record.warehouse_id ?? '', expected: record.expected_date ?? '', notes: record.notes ?? '', internalNotes: record.internal_notes ?? '', destination: record.to_ledger ? 'ficha' : record.destination_account_id ?? '' });
    setTab('produto'); say(record.kind === 'mesa' ? `Mesa ${record.table_number} aberta na venda.` : `Pré-venda nº ${record.number} aberta na venda.`);
  });
  const transferTable = (table: number) => {
    const target = draft; if (!target.saleId) { setDraft(previous => ({ ...previous, table })); setDialog(null); return; }
    void tableCommand.run(() => ({ id: newKey(), path: '/v1/frente-caixa/actions/sale_transfer', data: { sale_id: target.saleId, expected_version: target.version, table_number: table } }),
      value => { const record = pdvSale(value); setDraft(previous => ({ ...previous, table: record.table_number, version: record.version, record })); setDialog(null); setSalesReload(n => n + 1); say(`Comanda transferida para a mesa ${record.table_number}.`); });
  };
  const openCashDialog = (kind: 'move' | 'close', move: 'withdrawal' | 'supply' = 'withdrawal') => {
    if (!store?.session) { fail('Para habilitar as funcionalidades do frente de caixa, o caixa deve ser aberto.'); return; }
    if (!context?.effects.cash) { fail('Somente administrador e financeiro movimentam e fecham o caixa.'); return; }
    setDialog(kind === 'close' ? { kind: 'close' } : { kind: 'move', move });
  };
  const fixedQr = () => {
    if (!context?.pix) { fail(context?.effects.settings ? 'Cadastre a chave Pix em Configurações da frente de caixa.' : 'A chave Pix da empresa ainda não foi cadastrada pelo administrador.'); return; }
    try { setDialog({ kind: 'pix', payload: pixPayload({ keyType: context.pix.key_type, key: context.pix.key, merchantName: context.pix.merchant_name, merchantCity: context.pix.merchant_city }), amount: null, confirm: false }); } catch { fail('A chave Pix cadastrada não é válida.'); }
  };
  const printCurrent = () => { const job = selected?.record ? { kind: 'sale' as const, sale: selected.record, pix: pixFor(selected.record) } : last; if (job) setPrint(job); else fail('Nenhuma operação para imprimir.'); };
  const run = (action: PdvAction) => {
    setOpsOpen(false); setMenuOpen(false);
    if (action === 'produto') setTab('produto');
    // Origin Alt+A: the Pesquisa avançada of the product (the Produto tab opens behind it).
    else if (action === 'pesquisa') { setTab('produto'); if (!sale.locked && context?.permissions.operate) setDialog({ kind: 'product_search' }); }
    else if (action === 'cliente') setTab('cliente');
    else if (action === 'pagamento') setTab('pagamento');
    else if (action === 'buscar') { setCollapsed(false); salesSearch.current?.focus(); }
    else if (action === 'excluir') { if (draft.record) setDialog({ kind: 'cancel', sale: { ...draft.record, version: draft.version } }); else newSale(); }
    else if (action === 'fechar') openCashDialog('close');
    else if (action === 'finalizar') submit('finish');
    else if (action === 'imprimir') printCurrent();
    else if (action === 'nova' || action === 'balcao') newSale();
    else if (action === 'favoritos') { setTab('produto'); setFavoritesOpen(value => !value); }
    else if (action === 'remover-gtin') setDialog({ kind: 'gtin' });
    else if (action === 'sangria') openCashDialog('move', 'withdrawal');
    else if (action === 'suprimento') openCashDialog('move', 'supply');
    else if (action === 'trocar-loja') { if ((context?.stores.length ?? 0) > 1) setDialog({ kind: 'store' }); }
    else if (action === 'mesa') { if (context?.settings.tables) setDialog({ kind: 'table', mode: 'new' }); else fail('O controle de mesas está desligado em Preferências › Vendas › Frente de caixa.'); }
  };
  const live = useRef(run); live.current = run;
  useEffect(() => {
    const target = globalThis.window; if (!target?.addEventListener) return;
    const onKey = (event: KeyboardEvent) => { const action = pdvActionFor(event, mac, shortcuts); if (action && !dialog && !print) { event.preventDefault(); live.current(action); } else if (event.key === 'Escape') { setOpsOpen(false); setMenuOpen(false); setFavoritesOpen(false); } };
    target.addEventListener('keydown', onKey); return () => target.removeEventListener('keydown', onKey);
  }, [shortcuts, dialog, print, mac]);

  // ---------------------------------------------------------------- Tela
  if (tracked && !['admin', 'vendas', 'consulta', 'financeiro'].includes(role)) return <section className="real-state-panel"><h1>Frente de caixa não liberada</h1><p>Seu perfil não possui acesso à frente de caixa.</p></section>;
  if (!context) return <section className="real-state-panel" role={loaded.error ? 'alert' : 'status'}><h1>Frente de caixa</h1><p>{loaded.scope === scope && loaded.error ? loaded.error : 'Carregando a frente de caixa…'}</p>
    {loaded.scope === scope && loaded.error && <button type="button" className="primary-button" onClick={() => setReload(value => value + 1)}>Tentar novamente</button>}</section>;
  const operate = context.permissions.operate, cashNeeded = context.settings.cash_control && !store?.session, locked = sale.locked || !operate;
  const finishLabel = operate && (context.settings.default_operation === 'pre_venda' || !context.permissions.finish || !context.permissions.payments) ? 'Enviar pré-venda' : 'Finalizar venda';
  const menu = ORIGIN_MENU.flatMap(group => group.columns.flatMap(column => column.items)).filter(item => item.real && (!item.real.roles || item.real.roles.includes(role as never)));
  const pdvPage = preferencePage('vendas-frente-caixa');
  const subtotal = (item: CartItem) => { try { return money(lineTotals(item).total.replace('.', '')); } catch { return '—'; } };
  const productSubtotal = (() => { try { if (!product.record) return ''; const quantity = quantityInput(product.quantity || '1'), price = priceInput(product.price || '0');
    return money(lineTotals({ quantity, unit_price: price, discount_percent: context.settings.item_discount ? itemDiscountPercent(quantity, price, product.discountMode, product.discount) : '0' }).total.replace('.', '')); } catch { return '—'; } })();
  const salesState = sales?.key === salesKey ? sales : null;
  const detail = selected?.record ?? null;
  const tabButton = (id: Tab, label: string, action: PdvAction) => <button type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label} ({hint(action)})</button>;
  return <div className="pdv-workspace real-pdv">
    <header className="pdv-topbar">
      <button type="button" className="pdv-menu-button" aria-label="Abrir menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><Icon name="bars" size={15} /></button>
      <span className="pdv-store"><span className="pdv-store-avatar" aria-hidden="true">{(store?.store.name ?? 'B').slice(0, 1).toUpperCase()}</span>{store?.store.name ?? 'Frente de caixa'}</span>
      {store?.session ? <span className="pdv-cash-state">Caixa aberto · {store.session.operator_name} · {dateTimeSP(store.session.opened_at)}</span>
        : context.effects.cash && context.stores.length ? <button type="button" className="pdv-open-cash" onClick={() => setDialog({ kind: 'store' })}><Icon name="cash-register" size={11} />Abrir caixa</button> : null}
      {cashNeeded && <span className="pdv-warning" role="status"><Icon name="triangle-exclamation" size={12} />Para habilitar as funcionalidades do frente de caixa, o caixa deve ser aberto.</span>}
      {context.certificate !== 'valid' && <span className="pdv-warning pdv-certificate" role="status" title="O certificado A1 não está configurado ou venceu: a NFC-e não pode ser autorizada."><Icon name="certificate" size={12} />Certificado inválido</span>}
      {!operate && <span className="pdv-warning" role="status"><Icon name="circle-info" size={12} />{context.role === 'vendas' ? 'Seu vendedor não tem o módulo Frente de Caixa.' : 'Somente consulta.'}</span>}
      <button type="button" className="pdv-info" title="Teclas de atalho" aria-label="Teclas de atalho" onClick={() => setDialog({ kind: 'shortcuts' })}><Icon name="keyboard" size={15} /></button>
    </header>
    {menuOpen && <><button type="button" className="origin-drawer-backdrop" aria-label="Fechar menu" onClick={() => setMenuOpen(false)} /><nav className="origin-drawer" aria-label="Menu">
      <Link to="/acesso"><Icon name="house" size={13} />Início</Link>{menu.map(item => <Link key={`${item.label}:${item.real!.to}`} to={item.real!.to}>{item.label}</Link>)}
      {pdvPage && pdvPage.readRoles.includes(role as never) && <Link to={preferencePageHref(pdvPage)}><Icon name="gear" size={13} />Preferências › Frente de caixa</Link>}</nav></>}
    {(notice || error || sale.error) && <p className={sale.error || error ? 'real-alert pdv-message' : 'real-success pdv-message'} role={sale.error || error ? 'alert' : 'status'}>{sale.error || error || notice}</p>}
    <div className={`pdv-body${collapsed ? ' is-collapsed' : ''}`}>
      <section className="pdv-sale" aria-label="Venda">
        <header className="pdv-sale-header"><h1>Venda{draft.number ? ` nº ${draft.number}` : ''}{draft.kind === 'mesa' ? ` · Mesa ${draft.table}` : ''}</h1>
          <form role="search" onSubmit={event => { event.preventDefault(); setSearch(query.trim().slice(0, 120)); setCollapsed(false); }}><input ref={salesSearch} type="search" aria-label="Buscar venda" placeholder={`Buscar venda - (${hint('buscar')})`} maxLength={120} value={query} onChange={event => setQuery(event.target.value)} /></form>
          <button type="button" className="pdv-new" disabled={sale.locked} onClick={() => run('nova')}>Nova venda ({hint('nova')})</button>
          <span className="pdv-ops"><button type="button" aria-label="Operações" title="Operações" aria-expanded={opsOpen} onClick={() => setOpsOpen(!opsOpen)}><Icon name="ellipsis-h" size={14} /></button>
            {opsOpen && <span className="pdv-ops-menu is-open" role="menu">
              {context.pix && <button type="button" role="menuitem" onClick={() => { setOpsOpen(false); fixedQr(); }}>Imprimir QR code fixo</button>}
              {context.effects.cash && !store?.session && <button type="button" role="menuitem" onClick={() => { setOpsOpen(false); setDialog({ kind: 'store' }); }}>Abrir caixa</button>}
              <button type="button" role="menuitem" disabled={!store?.session || !context.effects.cash} onClick={() => run('sangria')}>Sangria ({hint('sangria')})</button>
              <button type="button" role="menuitem" disabled={!store?.session || !context.effects.cash} onClick={() => run('suprimento')}>Suprimento ({hint('suprimento')})</button>
              <button type="button" role="menuitem" disabled={!store?.session || !context.effects.cash} onClick={() => run('fechar')}>Fechar caixa ({hint('fechar')})</button>
              <button type="button" role="menuitem" onClick={() => run('imprimir')}>Imprimir ({hint('imprimir')})</button>
              <button type="button" role="menuitem" disabled={!last} onClick={() => { setOpsOpen(false); if (last) setPrint(last); }}>Reimprimir última operação</button>
              <button type="button" role="menuitem" disabled={!detail || detail.state !== 'finished' || !context.permissions.finish} title={detail?.state === 'finished' ? undefined : 'Selecione uma venda finalizada na coluna Pedidos.'}
                onClick={() => { setOpsOpen(false); if (detail) setDialog({ kind: 'return', sale: detail }); }}>Gerar devolução</button>
              {context.settings.tables && <button type="button" role="menuitem" onClick={() => run('mesa')}>Nova venda mesa ({hint('mesa')})</button>}
              {context.stores.length > 1 && <button type="button" role="menuitem" onClick={() => run('trocar-loja')}>Trocar loja ({hint('trocar-loja')})</button>}
              {context.effects.settings && <button type="button" role="menuitem" onClick={() => { setOpsOpen(false); setDialog({ kind: 'settings' }); }}>Configurações da frente de caixa</button>}
            </span>}</span>
        </header>
        <nav className="pdv-steps" role="tablist" aria-label="Etapas da venda">{tabButton('produto', 'Produto', 'produto')}{tabButton('cliente', 'Cliente', 'cliente')}{tabButton('pagamento', 'Pagamento', 'pagamento')}</nav>
        <div className="pdv-columns">
          <fieldset className="pdv-form" disabled={locked}><legend className="real-sr-only">Venda</legend>
            {tab === 'produto' && <>
              {/* 202610200282 (PRD-149): the lists of the Vendedor and of the formas de pagamento of the venda apply here too. */}
              <DocumentPriceList controller={controller} contact={draft.contact ? { id: draft.contact.id, state: draft.contact.state } : null} seller={draft.seller?.id ?? null}
                paymentMethods={draft.payments.map(row => row.payment_method_id)} selected={draft.priceList} disabled={locked} busy={repricing} applicable={draft.cart.filter(item => item.product_id).length}
                onSelect={(list, reason) => { setDraft(previous => ({ ...previous, priceList: list })); if (reason) say(reason); }} onApply={() => void applyList()} />
              <label className="pdv-toggle"><input type="checkbox" role="switch" checked={barcode} onChange={event => setBarcode(event.target.checked)} />Leitor de código de barras</label>
              <CatalogPicker controller={controller} entity="products" label="Pesquise por código, descrição ou GTIN" selected={product.record ? { id: product.record.id, name: product.record.name } : null} onSelect={record => { void selectProduct(record); }} onCode={onCode}
                stockWarehouse={draft.warehouse || null} />
              <span className="pdv-favorite-tools"><button type="button" className="pdv-favorites-button" onClick={() => run('pesquisa')}><Icon name="magnifying-glass" size={11} />Pesquisa avançada ({hint('pesquisa')})</button>
                <button type="button" className="pdv-favorites-button" onClick={() => run('favoritos')}><Icon name="star" size={11} />Ver favoritos ({hint('favoritos')})</button>
                {product.record && <button type="button" className="text-button" disabled={favorite.busy} onClick={() => { const chosen = product.record!; void favorite.run(() => ({ id: newKey(), path: '/v1/frente-caixa/actions/favorite_add', data: { product_id: chosen.id } }), () => { say(`${chosen.name} incluído nos favoritos.`); setSalesReload(n => n + 1); }); }}>{favorite.uncertain ? 'Conferir resultado' : 'Incluir nos favoritos'}</button>}{favorite.error && <small className="real-alert" role="alert">{favorite.error}</small>}</span>
              {favoritesOpen && <section className="pdv-favorites-panel" aria-label="Favoritos"><header><h2>Favoritos</h2><button type="button" className="icon-button" aria-pressed={favoritesGrid} title="Grade" aria-label="Grade" onClick={() => setFavoritesGrid(true)}><Icon name="grip" size={12} /></button>
                <button type="button" className="icon-button" aria-pressed={!favoritesGrid} title="Lista" aria-label="Lista" onClick={() => setFavoritesGrid(false)}><Icon name="list" size={12} /></button></header>
                {favorites.key !== favoritesKey ? <p role="status">Carregando favoritos…</p> : favorites.error ? <p className="real-alert" role="alert">{favorites.error}</p> : !favorites.items?.length ? <p className="real-help">Nenhum favorito localizado</p>
                  : favoritesGrid ? <div className="pdv-favorites">{favorites.items.map(item => <button type="button" key={item.product_id} disabled={!item.active} onClick={() => { void selectProduct({ id: item.product_id, entity: 'products', version: 1, active: item.active, name: item.name, code: item.code, unit: item.unit, price: item.price, kind: item.kind, gtin: item.gtin, created_at: '', updated_at: '', source: null }); setFavoritesOpen(false); }}>{item.name}<small>{item.stock === null ? 'Sem lançamentos' : `Estoque: ${quantityText(item.stock)}`}</small></button>)}</div>
                  : <table className="data-table"><thead><tr><th>Descrição</th><th>Código</th><th>Unidade</th><th className="numeric">Estoque</th><th><span className="real-sr-only">Remover</span></th></tr></thead><tbody>{favorites.items.map(item => <tr key={item.product_id}>
                    <td><button type="button" className="text-button" disabled={!item.active} onClick={() => { void selectProduct({ id: item.product_id, entity: 'products', version: 1, active: item.active, name: item.name, code: item.code, unit: item.unit, price: item.price, kind: item.kind, gtin: item.gtin, created_at: '', updated_at: '', source: null }); setFavoritesOpen(false); }}>{item.name}</button></td>
                    <td>{item.code ?? '—'}</td><td>{item.unit ?? '—'}</td><td className="numeric">{item.stock === null ? '—' : quantityText(item.stock)}</td>
                    <td><button type="button" className="icon-button" aria-label={`Remover ${item.name} dos favoritos`} disabled={favorite.locked} onClick={() => void favorite.run(() => ({ id: newKey(), path: '/v1/frente-caixa/actions/favorite_remove', data: { product_id: item.product_id } }), () => setSalesReload(n => n + 1))}><Icon name="trash-can" size={12} /></button></td></tr>)}</tbody></table>}
              </section>}
              <div className="pdv-product"><div className="pdv-image" aria-hidden="true"><Icon name="image" size={64} /></div>
                <div className="pdv-product-fields"><p className="pdv-list-value">Valor da lista aplicado: <strong>{product.record ? unitMoney(product.listPrice ?? text(product.record.price)) : money('0')}</strong>{draft.priceList && product.record && !product.listPrice && <small> (fora da lista {draft.priceList.name})</small>}</p>
                  <label htmlFor="pdv-quantity">Quantidade<span className="pdv-qty"><button type="button" aria-label="Diminuir quantidade" onClick={() => setProduct(previous => { try { const value = BigInt(quantityInput(previous.quantity || '1').split('.')[0]!); return value > 1n ? { ...previous, quantity: String(value - 1n) } : previous; } catch { return previous; } })}>-</button>
                    <input id="pdv-quantity" inputMode="decimal" maxLength={16} value={product.quantity} onChange={event => { const quantity = event.target.value; setProduct(previous => ({ ...previous, quantity })); }} />
                    <button type="button" aria-label="Aumentar quantidade" onClick={() => setProduct(previous => { try { const [whole, fraction] = quantityInput(previous.quantity || '0').split('.'); return { ...previous, quantity: `${BigInt(whole!) + 1n}${fraction ? `.${fraction}` : ''}` }; } catch { return { ...previous, quantity: '1' }; } })}>+</button></span></label>
                  {context.settings.item_discount && <label htmlFor="pdv-item-discount">Desconto<span className="pdv-discount"><input id="pdv-item-discount" inputMode="decimal" maxLength={16} placeholder={product.discountMode === 'percent' ? '0%' : '0,00'} value={product.discount} onChange={event => { const discount = event.target.value; setProduct(previous => ({ ...previous, discount })); }} />
                    <button type="button" className="secondary-button" aria-label="Alternar desconto entre R$ e %" onClick={() => setProduct(previous => ({ ...previous, discountMode: previous.discountMode === 'percent' ? 'amount' : 'percent' }))}>{product.discountMode === 'percent' ? '%' : 'R$'}</button></span></label>}
                  <label htmlFor="pdv-unit-price">Valor unitário<input id="pdv-unit-price" inputMode="decimal" maxLength={24} readOnly={!context.permissions.edit_price} title={context.permissions.edit_price ? undefined : 'Seu vendedor não pode editar o preço unitário.'} value={product.price.replace('.', ',')} onChange={event => { const price = event.target.value.replace(',', '.'); setProduct(previous => ({ ...previous, price })); }} /></label>
                  <label htmlFor="pdv-subtotal">Sub total<input id="pdv-subtotal" readOnly value={productSubtotal} /></label>
                  <label className="pdv-wide" htmlFor="pdv-comment">Comentário<textarea id="pdv-comment" rows={2} maxLength={4000} value={product.comment} onChange={event => { const comment = event.target.value; setProduct(previous => ({ ...previous, comment })); }} /></label>
                  <button type="button" className="primary-button" disabled={!product.record || !context.permissions.items} onClick={() => void insert().then(message => { if (message) fail(message); else if (mayRead()) setError(''); })}>Inserir</button></div></div>
            </>}
            {tab === 'cliente' && <div className="pdv-client">
              <CatalogPicker controller={controller} entity="contacts" label="Nome *" selected={draft.contact ? { id: draft.contact.id, name: draft.contact.name } : null}
                onSelect={record => setDraft(previous => ({ ...previous, contact: record ? contactOf(record) : null }))} onCreate={context.effects.contacts ? query => setDialog({ kind: 'contact', initial: quickContactInitial('sales_orders', query) }) : undefined} />
              <span className="pdv-client-tools"><button type="button" className="secondary-button" onClick={() => setDialog({ kind: 'contact_search', query: '' })}><Icon name="magnifying-glass" size={11} />Pesquisa avançada</button>
                {context.effects.contacts && <button type="button" className="secondary-button" onClick={() => setDialog({ kind: 'contact', initial: quickContactInitial('sales_orders', '') })}><Icon name="plus" size={11} />Contato rápido</button>}
                {draft.contact && <button type="button" className="text-button" onClick={() => setDraft(previous => ({ ...previous, contact: null }))}>Consumidor não identificado</button>}</span>
              {draft.contact ? <dl className="pdv-client-data"><div><dt>Nome</dt><dd>{draft.contact.name}</dd></div><div><dt>Tipo</dt><dd>{PERSON_TYPES[draft.contact.person_type ?? ''] ?? '—'}</dd></div><div><dt>CNPJ/CPF</dt><dd>{draft.contact.document ?? '—'}</dd></div>
                <div><dt>Código</dt><dd>{draft.contact.code ?? '—'}</dd></div><div><dt>Fantasia</dt><dd>{draft.contact.trade_name ?? '—'}</dd></div></dl>
                : <p className="real-help">{context.consumer ? `Sem cliente identificado, a venda sai para ${context.consumer.name}.` : 'Informe o cliente: o cliente padrão (Consumidor final) ainda não foi definido nas configurações da frente de caixa.'}</p>}
              {/* "Histórico financeiro": contas a receber em aberto do cliente (o servidor decide quem lê, pela preferência de Vendas). */}
              {draft.contact && <FinanceContactOpenTitles key={`${draft.contact.id}:${scope}`} controller={controller} contactId={draft.contact.id} kind="receivable" />}
              <p className="real-help">Opções avançadas (inscrição estadual, contribuinte, endereço, e-mail e telefones) ficam no Contato rápido e no cadastro do cliente.</p>
            </div>}
            {tab === 'pagamento' && <div className="pdv-payment">
              <dl className="pdv-pay-totals"><div><dt>Sub total</dt><dd>{totals ? money(totals.subtotal.replace('.', '')) : '—'}</dd></div>
                <div><dt><label htmlFor="pdv-sale-discount">Desconto</label></dt><dd><span className="pdv-discount"><input id="pdv-sale-discount" inputMode="decimal" maxLength={16} placeholder={draft.discountMode === 'percent' ? '0%' : '0,00'} value={draft.discountValue} onChange={event => { const discountValue = event.target.value; setDraft(previous => ({ ...previous, discountValue })); }} />
                  <button type="button" className="secondary-button" aria-label="Alternar desconto da venda entre R$ e %" onClick={() => setDraft(previous => ({ ...previous, discountMode: previous.discountMode === 'percent' ? 'amount' : 'percent', discountValue: '' }))}>{draft.discountMode === 'percent' ? '%' : 'R$'}</button></span></dd></div>
                <div><dt><label htmlFor="pdv-other">Outras despesas</label></dt><dd><input id="pdv-other" inputMode="decimal" maxLength={17} placeholder="0,00" value={draft.other} onChange={event => { const other = event.target.value; setDraft(previous => ({ ...previous, other })); }} /></dd></div>
                <div><dt><label htmlFor="pdv-received">Total recebido em dinheiro</label></dt><dd><input id="pdv-received" inputMode="decimal" maxLength={17} placeholder="0,00" value={draft.received} onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, received: value })); }} /></dd></div>
                <div><dt title="Calculado das parcelas à vista em Dinheiro ou Cheque.">Troco em dinheiro</dt><dd>{received !== null && change.change >= 0n ? money(change.change) : money('0')}</dd></div>
                <div className="is-total"><dt>Total da venda</dt><dd>{money(total)}</dd></div></dl>
              {totalsError && <p className="real-alert" role="alert">{totalsError}</p>}{receivedError && <p className="real-alert" role="alert">{receivedError}</p>}
              {received !== null && change.change < 0n && <p className="real-alert" role="alert">O valor recebido não cobre as parcelas em dinheiro ou cheque ({money(change.cash)}).</p>}
              <div className="pdv-grid">
                <label htmlFor="pdv-method">Forma de pagamento<select id="pdv-method" value={method || defaultMethod?.id || ''} disabled={!context.permissions.payments} onChange={event => { const value = event.target.value; setMethod(value); const chosen = methods.find(item => item.id === value); if (chosen?.condition) setCondition(chosen.condition); }}>
                  {!methods.length && <option value="">Cadastre as formas de pagamento</option>}{methods.map(item => <option key={item.id} value={item.id}>{item.description}</option>)}</select></label>
                <label htmlFor="pdv-condition">Condição<span className="pdv-condition"><input id="pdv-condition" maxLength={200} placeholder="0" title="Número de parcelas ou prazos. Exemplo 30, 60, 3x ou 15 +2x" value={condition} onChange={event => setCondition(event.target.value)} />
                  <button type="button" className="secondary-button" disabled={!context.permissions.payments} onClick={generate}>Gerar parcelas</button></span></label>
                <div className="form-field"><label htmlFor="pdv-category">Categoria</label><DocumentCategoryPicker controller={controller} kind="sales_orders" id="pdv-category" selected={draft.category} disabled={locked} onSelect={category => setDraft(previous => ({ ...previous, category }))} /></div>
                <label htmlFor="pdv-destination">Destino<select id="pdv-destination" value={draft.destination} onChange={event => { const destination = event.target.value; setDraft(previous => ({ ...previous, destination })); }}>
                  <option value="">Caixa{store ? ` (${store.store.name})` : ''}</option>{context.accounts.filter(item => item.id !== store?.store.id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}<option value="ficha" disabled={!draft.contact} title={draft.contact ? undefined : 'Identifique o cliente para lançar na Ficha Financeira.'}>Ficha Financeira</option></select></label>
              </div>
              {!methods.length && <p className="real-alert" role="alert">Não será possível utilizar esta seção pois você não possui forma de pagamentos cadastradas nesta conta. <Link to="/formas-pagamento-empresa">Configurar formas</Link></p>}
              <table className="data-table pdv-installments"><thead><tr><th>Dias</th><th>Data</th><th className="numeric">Valor</th><th>Forma</th><th>Observação</th><th><span className="real-sr-only">Remover</span></th></tr></thead>
                <tbody>{draft.payments.map((row, index) => <tr key={row.key}>
                  <td><label className="real-sr-only" htmlFor={`pdv-days-${index}`}>Dias da parcela {index + 1}</label><input id={`pdv-days-${index}`} inputMode="numeric" maxLength={4} value={String(row.days)} disabled={!context.permissions.payments} onChange={event => { const days = /^\d{0,4}$/.test(event.target.value) ? Number(event.target.value || '0') : row.days; setDraft(previous => ({ ...previous, autoPayment: false, payments: previous.payments.map((item, i) => i === index ? { ...item, days } : item) })); }} /></td>
                  <td>{(() => { try { return dueDate(context.today, row.days).split('-').reverse().join('/'); } catch { return '—'; } })()}</td>
                  <td className="numeric"><label className="real-sr-only" htmlFor={`pdv-amount-${index}`}>Valor da parcela {index + 1}</label><input id={`pdv-amount-${index}`} inputMode="decimal" maxLength={17} disabled={!context.permissions.payments} value={row.amount_text ?? centsText(row.amount_cents)} onChange={event => { const typed = event.target.value; let amount: string | null = null; try { amount = moneyCents(typed || '0'); } catch { amount = null; } setDraft(previous => ({ ...previous, autoPayment: false, payments: previous.payments.map((item, i) => i === index ? { ...item, amount_text: typed, amount_cents: amount ?? item.amount_cents } : item) })); }} onBlur={() => setDraft(previous => ({ ...previous, payments: previous.payments.map((item, i) => i === index ? { ...item, amount_text: undefined } : item) }))} /></td>
                  <td><label className="real-sr-only" htmlFor={`pdv-row-method-${index}`}>Forma da parcela {index + 1}</label><select id={`pdv-row-method-${index}`} value={row.payment_method_id} disabled={!context.permissions.payments || !context.permissions.change_method} title={context.permissions.change_method ? undefined : 'Seu vendedor não pode alterar a forma de pagamento das parcelas.'}
                    onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, autoPayment: false, payments: previous.payments.map((item, i) => i === index ? { ...item, payment_method_id: value } : item) })); }}>{methods.map(item => <option key={item.id} value={item.id}>{item.description}</option>)}</select></td>
                  <td><label className="real-sr-only" htmlFor={`pdv-note-${index}`}>Observação da parcela {index + 1}</label><input id={`pdv-note-${index}`} maxLength={2000} value={row.note} onChange={event => { const note = event.target.value; setDraft(previous => ({ ...previous, payments: previous.payments.map((item, i) => i === index ? { ...item, note } : item) })); }} /></td>
                  <td><button type="button" className="icon-button" aria-label={`Remover parcela ${index + 1}`} disabled={!context.permissions.payments} onClick={() => setDraft(previous => ({ ...previous, autoPayment: false, payments: previous.payments.filter((_, i) => i !== index) }))}><Icon name="trash-can" size={12} /></button></td></tr>)}</tbody>
                <tfoot><tr><td colSpan={2}>Total das parcelas</td><td className="numeric">{money(paid)}</td><td colSpan={3}>{mismatch && <span className="real-alert">Diferente do total da venda.</span>}</td></tr></tfoot></table>
              {!context.effects.stock || !context.effects.finance ? <p className="real-help">Seu perfil grava a venda e o pedido; o estoque e as contas ficam para o lançamento no pedido pelos perfis de estoque e financeiro.</p> : null}
              {context.pix && <p className="pdv-pix-tools"><button type="button" className="secondary-button" disabled={!pixCents(draft.payments, methods)} title={pixCents(draft.payments, methods) ? undefined : 'Inclua uma parcela à vista com forma Pix.'} onClick={() => { try { const cents = pixCents(draft.payments, methods).toString(); setDialog({ kind: 'pix', payload: pixPayload({ keyType: context.pix!.key_type, key: context.pix!.key, merchantName: context.pix!.merchant_name, merchantCity: context.pix!.merchant_city, amountCents: cents, reference: 'PDV' }), amount: cents, confirm: false }); } catch { fail('A chave Pix cadastrada não é válida.'); } }}><Icon name="qrcode" size={12} />Pix - QR Code Impresso (QR estático)</button>
                <small className="real-help">{context.settings.default_method === 'pix_qrcode_impresso' ? 'Ao finalizar, as parcelas à vista em Pix mostram o QR estático; confira o recebimento no banco.' : 'Mostra o QR estático das parcelas à vista em Pix; confira o recebimento no banco.'}</small></p>}
              <section className="pdv-other" aria-label="Outras Informações"><h3>Outras Informações</h3><div className="pdv-grid">
                <div className="form-field"><label htmlFor="pdv-seller">Vendedor{context.settings.seller_required ? ' *' : ''}</label><DocumentSellerPicker controller={controller} id="pdv-seller" label="Vendedor" selected={draft.seller} disabled={locked} required={context.settings.seller_required} onSelect={seller => setDraft(previous => ({ ...previous, seller }))} /></div>
                <label htmlFor="pdv-expected">Data Prevista<input id="pdv-expected" type="date" min={context.today} max="2099-12-31" value={draft.expected} onChange={event => { const expected = event.target.value; setDraft(previous => ({ ...previous, expected })); }} /></label>
                <label htmlFor="pdv-warehouse">Depósito para lançamento<select id="pdv-warehouse" value={draft.warehouse} onChange={event => { const warehouse = event.target.value; setDraft(previous => ({ ...previous, warehouse })); }}><option value="">Sem depósito</option>{context.warehouses.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                <label htmlFor="pdv-freight">Frete<input id="pdv-freight" inputMode="decimal" maxLength={17} placeholder="0,00" value={draft.freight} onChange={event => { const freight = event.target.value; setDraft(previous => ({ ...previous, freight })); }} /></label>
                <label className="pdv-wide" htmlFor="pdv-notes">Observações<textarea id="pdv-notes" rows={2} maxLength={4000} value={draft.notes} onChange={event => { const notes = event.target.value; setDraft(previous => ({ ...previous, notes })); }} /></label>
                <label className="pdv-wide" htmlFor="pdv-internal">Observações internas<textarea id="pdv-internal" rows={2} maxLength={4000} value={draft.internalNotes} onChange={event => { const internalNotes = event.target.value; setDraft(previous => ({ ...previous, internalNotes })); }} /></label></div></section>
            </div>}
          </fieldset>
          <div className="pdv-items" aria-label="Itens da venda">{draft.cart.length === 0 ? <div className="pdv-empty"><Icon name="cash-register" size={72} /></div> : <table className="data-table"><thead><tr><th>#</th><th>Produto</th><th className="numeric">Qtde</th><th className="numeric">Valor</th><th><span className="real-sr-only">Remover</span></th></tr></thead>
            <tbody>{draft.cart.map((item, index) => <tr key={item.id}><td>{index + 1}</td><td>{item.description}{item.code && <small>Cód: {item.code}</small>}{item.comment && <small>{item.comment}</small>}{item.discount_percent !== '0' && <small>Desconto: {item.discount_percent.replace('.', ',')}%</small>}</td>
              <td className="numeric">{quantityText(item.quantity)} {item.unit}</td><td className="numeric">{subtotal(item)}</td>
              <td><button type="button" className="origin-kebab" aria-label={`Remover ${item.description}`} disabled={locked || (draft.savedItems[item.id] !== undefined && !context.permissions.remove_items)} onClick={() => removeLine(item.id)}><Icon name="trash-can" size={12} /></button></td></tr>)}</tbody></table>}</div>
        </div>
        <footer className="pdv-footer">
          <button type="button" className="secondary-button" disabled={sale.locked} onClick={() => run('excluir')}>Excluir venda ({hint('excluir')})</button>
          {draft.kind === 'mesa' && <><button type="button" className="secondary-button" disabled={sale.locked || !operate} onClick={() => submit('save')}>Salvar comanda</button>
            <button type="button" className="secondary-button" disabled={sale.locked || !operate} onClick={() => setDialog({ kind: 'table', mode: 'transfer' })}>Transferir mesa</button></>}
          <button type="button" className="primary-button" disabled={sale.busy || !operate || (!sale.uncertain && (!draft.cart.length || Boolean(totalsError)))} onClick={() => submit('finish')}>{sale.busy ? 'Aguarde…' : sale.uncertain ? 'Conferir resultado' : `${finishLabel} (${hint('finalizar')})`}</button>
          <span className="pdv-total">Total <strong>{money(total)}</strong></span>
        </footer>
      </section>
      <aside className="pdv-orders" aria-label="Pedidos do caixa">
        <h2><Icon name="cash-register" size={13} />Pedidos<button type="button" className="icon-button" aria-label={collapsed ? 'Mostrar pedidos' : 'Recolher pedidos'} onClick={() => setCollapsed(!collapsed)}><Icon name={collapsed ? 'chevron-left' : 'chevron-right'} size={11} /></button></h2>
        {!collapsed && <>{!salesState ? <p role="status">Carregando…</p> : salesState.error ? <p className="real-alert" role="alert">{salesState.error}</p> : <>
          {salesState.open.length > 0 && <section aria-label="Pré-vendas e mesas"><h3>Pré-vendas e mesas</h3><ul>{salesState.open.map(row => <li key={row.id}><button type="button" className={selected?.id === row.id ? 'is-selected' : ''} onClick={() => setSelected({ id: row.id, record: null, error: '' })}>
            <strong>{row.kind === 'mesa' ? `Mesa ${row.table_number}` : `Pré-venda ${row.number}`}</strong><span>{row.contact_name}</span><span>{money(row.total_cents)}</span></button></li>)}</ul></section>}
          {!salesState.items.length ? <p>Nenhum pedido cadastrado</p> : <ul>{salesState.items.map(row => <li key={row.id}><button type="button" className={selected?.id === row.id ? 'is-selected' : ''} onClick={() => setSelected({ id: row.id, record: null, error: '' })}>
            <strong>{row.number}</strong><span>{row.contact_name}</span><span>{money(row.total_cents)} · {SALE_STATES[row.state]}</span></button></li>)}</ul>}</>}
          <section className="pdv-order-detail" aria-label="Detalhes do pedido">{!selected ? <p className="real-help">Selecione um pedido ao lado para ver mais detalhes.</p> : selected.error ? <p className="real-alert" role="alert">{selected.error}</p> : !detail ? <p role="status">Carregando o pedido…</p> : <>
            <h3>Venda nº {detail.number}{detail.kind === 'mesa' ? ` · Mesa ${detail.table_number}` : ''}</h3>
            <dl><dt>Situação</dt><dd>{SALE_STATES[detail.state]}</dd><dt>Data</dt><dd>{dateTimeSP(detail.finished_at ?? detail.created_at)}</dd><dt>Cliente</dt><dd>{detail.contact_name}</dd><dt>Operador</dt><dd>{detail.operator_name}</dd>
              <dt>Total</dt><dd>{money(detail.total_cents)}</dd>{'stock' in detail.effects && <><dt>Estoque</dt><dd>{EFFECT_LABELS[detail.effects.stock]}{detail.effects.stock_reason ? ` — ${effectReasonText(detail.effects.stock_reason)}` : ''}</dd>
                <dt>Contas</dt><dd>{EFFECT_LABELS[detail.effects.finance]}{detail.effects.finance_reason ? ` — ${effectReasonText(detail.effects.finance_reason)}` : ''}{detail.effects.settle_reason ? ` (baixa à vista não feita: ${effectReasonText(detail.effects.settle_reason)})` : ''}</dd></>}
              {detail.invoice && <><dt>{detail.invoice.model === '65' ? 'NFC-e' : 'NF-e'}</dt><dd>{detail.invoice.number ? `nº ${detail.invoice.number} · ` : ''}{INVOICE_STATUS[detail.invoice.status as keyof typeof INVOICE_STATUS] ?? `Situação ${detail.invoice.status}`}</dd></>}</dl>
            <ul className="pdv-detail-payments">{detail.payments.map(row => <li key={row.position}>{row.method_name}{row.days ? ` (${row.days} dias)` : ''}: {money(row.amount_cents)}</li>)}</ul>
            {detail.returns && detail.returns.length > 0 && <p className="real-help">Devoluções: {detail.returns.map(row => `${money(row.value_cents)}${row.refund_cents !== '0' ? ` (${money(row.refund_cents)} em dinheiro)` : ''} em ${dateTimeSP(row.created_at)}`).join('; ')}</p>}
            <div className="pdv-detail-actions">
              {detail.state === 'open' && operate && <button type="button" className="primary-button" disabled={sale.locked} onClick={() => loadSale(detail)}>Abrir na venda</button>}
              {detail.state !== 'open' && <button type="button" className="secondary-button" onClick={() => setPrint({ kind: 'sale', sale: detail, pix: pixFor(detail) })}><Icon name="print" size={12} />Imprimir</button>}
              {detail.state === 'finished' && !detail.invoice && context.effects.fiscal && <a className="secondary-button" href={fiscalHref(detail, '65')} target="_blank" rel="noopener">Gerar NFC-e</a>}
              {detail.state === 'finished' && !detail.invoice && !context.effects.fiscal && <button type="button" className="secondary-button" disabled title="Somente administrador e fiscal preparam a NFC-e.">Gerar NFC-e</button>}
              {detail.state !== 'cancelled' && operate && <button type="button" className="secondary-button" disabled={sale.locked || Boolean(detail.invoice) || Boolean(detail.returns?.length) || (detail.state === 'finished' && !context.permissions.finish)} title={detail.invoice ? 'A venda tem nota fiscal vinculada.' : detail.returns?.length ? 'A venda tem devolução registrada.' : undefined} onClick={() => setDialog({ kind: 'cancel', sale: detail })}>Cancelar venda</button>}
              {detail.state === 'finished' && operate && <button type="button" className="secondary-button" disabled={sale.locked || !context.permissions.finish} onClick={() => setDialog({ kind: 'return', sale: detail })}>Gerar devolução</button>}
              <Link className="text-button" to={`/documentos-empresa?${new URLSearchParams({ tipo: 'sales_orders', documento: detail.document_id })}`}>Abrir pedido nº {detail.number}</Link>
            </div></>}</section></>}
      </aside>
    </div>
    {dialog?.kind === 'store' && <PdvStoreDialog context={context} current={store?.store.id ?? null} sendFinance={sendFinance} mayWrite={mayCash} onCancel={() => setDialog(null)}
      onSelect={(chosen, session) => { writeStore(chosen.id); setStore({ store: chosen, session }); setDialog(null); setReload(value => value + 1); setSalesReload(value => value + 1); say(session ? `Caixa de ${chosen.name} em uso.` : `Loja ${chosen.name} escolhida.`); }} />}
    {dialog?.kind === 'move' && store?.session && <PdvMoveDialog controller={controller} session={store.session} move={dialog.move} sendFinance={sendFinance} mayWrite={mayCash} onClose={() => setDialog(null)}
      onDone={(amount, note) => { const job: PdvPrintJob = { kind: 'move', move: dialog.move, store: store.store.name, operator: store.session!.operator_name, amount_cents: amount, note, at: new Date().toISOString() }; setLast(job); setDialog(null); setReload(value => value + 1); say(dialog.move === 'supply' ? 'Suprimento registrado no caixa.' : 'Sangria registrada no caixa.'); }} />}
    {dialog?.kind === 'close' && store?.session && <PdvCloseDialog controller={controller} context={context} session={store.session} sendFinance={sendFinance} mayWrite={mayCash} onClose={() => setDialog(null)}
      onDone={() => { setStore(previous => previous ? { ...previous, session: null } : previous); setDialog(null); setReload(value => value + 1); say('Caixa fechado.'); }} />}
    {dialog?.kind === 'settings' && <PdvSettingsDialog controller={controller} context={context} sendPos={sendPos} mayWrite={() => mayWrite() && role === 'admin'} onClose={() => setDialog(null)} onDone={() => { setDialog(null); setReload(value => value + 1); say('Configurações da frente de caixa salvas.'); }} />}
    {dialog?.kind === 'table' && <PdvTableDialog mode={dialog.mode} open={(salesState?.open ?? []).filter(row => row.kind === 'mesa')} onClose={() => setDialog(null)}
      onOpen={id => { setDialog(null); setSelected({ id, record: null, error: '' }); setCollapsed(false); }} onPick={table => { if (dialog.mode === 'new') { setDialog(null); newSale('mesa', table); } else transferTable(table); }} />}
    {dialog?.kind === 'cancel' && <PdvCancelDialog sale={dialog.sale} sendPos={sendPos} mayWrite={mayWrite} onClose={() => setDialog(null)} onDone={record => { setDialog(null); setSelected({ id: record.id, record, error: '' }); if (draft.saleId === record.id) setDraft(emptyDraft(context)); setSalesReload(value => value + 1); say(`Venda nº ${record.number} cancelada.`); }} />}
    {dialog?.kind === 'return' && <PdvReturnDialog sale={dialog.sale} session={store?.session ?? null} sendPos={sendPos} mayWrite={mayWrite} onClose={() => setDialog(null)} onDone={(record, result) => { setDialog(null); setSelected({ id: record.id, record, error: '' }); setReload(value => value + 1);
      say(pdvReturnMessage(result, money)); }} />}
    {dialog?.kind === 'shortcuts' && <PdvShortcutsDialog shortcuts={shortcuts.filter(item => item.action !== 'trocar-loja' || context.stores.length > 1).filter(item => item.action !== 'mesa' || context.settings.tables)} mac={mac} onClose={() => setDialog(null)} />}
    {dialog?.kind === 'gtin' && <PdvGtinDialog onRemove={removeByCode} onClose={() => setDialog(null)} />}
    {dialog?.kind === 'pix' && <PdvPixDialog payload={dialog.payload} amount={dialog.amount} confirm={dialog.confirm} onClose={() => setDialog(null)} onPrint={() => setPrint({ kind: 'pix', payload: dialog.payload, amount_cents: dialog.amount, label: dialog.amount ? 'Pix' : 'QR code fixo' })}
      onConfirm={() => { setDialog(null); setPixConfirmed(true); void sale.run(() => ({ id: newKey(), path: '/v1/frente-caixa/actions/sale_finish', data: saleData(true) }), value => { if (mayRead()) afterSale(pdvSale(value), true); }); }} />}
    {dialog?.kind === 'contact' && <DocumentQuickContact controller={controller} kind="sales_orders" initial={dialog.initial} onClose={() => setDialog(null)} onCreated={record => { setDraft(previous => ({ ...previous, contact: contactOf(record) })); setDialog(null); }} />}
    {dialog?.kind === 'product_search' && <ProductAdvancedSearch controller={controller} initialQuery="" onClose={() => setDialog(null)} onSelect={record => { setDialog(null); void selectProduct(record); }} />}
    {dialog?.kind === 'contact_search' && <DocumentContactSearch controller={controller} label="Cliente" initialQuery={dialog.query} onClose={() => setDialog(null)} onSelect={row => { setDraft(previous => ({ ...previous, contact: { id: row.id, name: row.name, document: row.document, person_type: row.person_type ?? personType(row.document), code: row.code, trade_name: row.trade_name, state: row.state } })); setDialog(null); }} />}
    {print && <PdvReceiptPrint controller={controller} job={print} receipt={context.receipt} order={context.settings.receipt_order} onClose={() => setPrint(null)} />}
  </div>;
}
