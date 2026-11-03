// Listagem de documentos no padrão Origin (docs/integrations/document-list-origin.md): parâmetros validados,
// página/ordem, indicadores da linha, situações permitidas e plano do lote "Mudar situação".
import { STATES, TRANSITIONS, checkTransition, type DocumentKind, type DocumentSummary } from './real-documents-model.ts';
import { effectTransitionAllowed } from './document-effects-model.ts';
import { planBatch, type BatchItem, type BatchPlan } from './origin-batch.ts';
import { addDays } from './origin-list.ts';
import { actionsAllowed, baseOf, managed, permittedTargets, rowKey, situationName, situationTargets, transitionActions, type RowSituation, type SituationModel } from './document-situations-model.ts';
import type { DocumentPermissions } from './real-documents-model.ts';
import { DOCUMENT_MIRROR_READ_ONLY, isDocumentMirror } from './document-mirror-model.ts';
import type { DocumentOriginTotals } from './document-mirror-model.ts';
// 202610200289: "Lote (até 50 lotes separados por ;)" and "Busca customizada" (Adicionar filtros), the same rules as the Worker and the SQL.
import { lotCodes, searchConditions, type SearchCondition } from '../../../../packages/erp-domain/src/document-search.mjs';
export type { SearchCondition };

export const DOCUMENT_LIST_PAGE_SIZE = 100;
export type DocumentListOrder = 'date_desc' | 'date_asc' | 'number_desc' | 'number_asc';
export type DocumentDateType = 'date' | 'expected_date' | 'next_contact' | 'ship_date' | 'finish_date' | 'warranty_until';
export const DOCUMENT_LIST_ORDERS: readonly DocumentListOrder[] = ['date_desc', 'date_asc', 'number_desc', 'number_asc'];
export const DOCUMENT_LIST_UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'EX', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'] as const;

export interface DocumentListRow extends DocumentSummary {
  expected_date: string | null; next_contact: string | null; template: boolean;
  warehouse_id: string | null; warehouse_name: string | null; source_proposal_id: string | null; source_proposal_number: string | null;
  // reservation_active and warehouse_name come null for profiles that do not read stock (financeiro), like fiscal_draft outside admin/fiscal.
  finance_active: boolean; stock_active: boolean; receipt_active: boolean; origin_finance?: boolean; origin_invoice?: boolean; reservation_active: boolean | null; fiscal_draft: boolean | null; internal_notes: string | null;
  // 202610200102 columns (absent while the database is still on 095).
  customer_po_number?: string | null; ship_date?: string | null; contact_email?: string | null; contact_phone?: string | null; contact_document?: string | null;
  address?: string | null; carrier_name?: string | null; first_sale?: boolean;
  // 202610200131 (absent before it): nota fiscal de origem, pendências cadastrais and the OS generated from the pedido.
  invoice?: { model: '55' | '65'; number: string | null; series: string; issue_date: string; authorized: boolean } | null; pendencies?: boolean; service_order_number?: string | null; template_name?: string | null;
  // 202610200163 (absent before it): situação of the Gerenciador de transições and the "nota vinculada" flag of every profile.
  situation?: RowSituation | null; invoice_linked?: boolean;
  /** 202610200269 (absent before it): the version of a proposta ("123-2"), null for the first one. */
  version_label?: string | null;
}
export interface DocumentListPage {
  origin_totals?: DocumentOriginTotals;
  kind: DocumentKind; items: DocumentListRow[]; limit: number; page: number | null; order: DocumentListOrder; has_more: boolean; next_cursor: string | null;
  /** total_amount: null when Preferências "Exibir totais em listas" leaves this user without the sum of the list (202610200129). */
  total_count: number; total_amount: string | null; data_mode: 'erp_native'; operational_effects: false;
}
export type ListReference = { id: string; name: string };
export interface DocumentListFilters {
  origin?: 'all' | 'origin' | 'brufap';
  query: string; statuses: string[]; from: string; to: string; dateType: DocumentDateType;
  warehouse: ListReference | null; product: ListReference | null; city: string; state: string;
  technician: string; equipment: string; serialNumber: string; internalNote: string;
  postalCode: string; district: string; trackingCode: string; carrier: string; customerPo: string; contactEmail: string; template: boolean | null;
  /** 202610200164 native vendedor (pedidos, propostas and OS). */
  seller: ListReference | null;
  /** 202610200238 Origin "Componente" (pedidos de venda): a product of the pedido has it in its structure. */
  component?: ListReference | null;
  /** 202610200268 Origin "Serviço" (ordens de serviço): an item with that serviço; "Peça" is `product`. */
  service?: ListReference | null;
  /** 202610200289 Origin "Lote (até 50 lotes separados por ;)" (pedidos de venda and OS): an item informs the lote or its stock moved it. */
  lots?: string;
  /** 202610200289 Origin "Busca customizada" (Adicionar filtros): every condition must match (the campos customizados of the OS too). */
  search?: SearchCondition[];
}
/** The lists with the Lote filter. */
export const LOT_FILTER: Record<DocumentKind, boolean> = { sales_orders: true, sales_proposals: false, service_orders: true, purchase_orders: false };
export const EMPTY_LIST_FILTERS: DocumentListFilters = { query: '', statuses: [], from: '', to: '', dateType: 'date', warehouse: null, product: null, city: '', state: '', technician: '', equipment: '', serialNumber: '', internalNote: '',
  postalCode: '', district: '', trackingCode: '', carrier: '', customerPo: '', contactEmail: '', template: null, seller: null };

// Origin wording per screen (docs/references/origin-interface.md). Only the date types the data has are offered.
export const DATE_TYPES: Record<DocumentKind, readonly { value: DocumentDateType; label: string }[]> = {
  sales_orders: [{ value: 'date', label: 'Data do pedido' }, { value: 'expected_date', label: 'Data prevista' }, { value: 'ship_date', label: 'Data de saída' }],
  sales_proposals: [{ value: 'date', label: 'Data' }, { value: 'next_contact', label: 'Próximo contato' }],
  service_orders: [{ value: 'date', label: 'Período' }, { value: 'expected_date', label: 'Previstos para' }, { value: 'finish_date', label: 'Concluídos para' }, { value: 'ship_date', label: 'Data de Saída' }, { value: 'warranty_until', label: 'Garantia' }],
  purchase_orders: [{ value: 'date', label: 'Período' }, { value: 'expected_date', label: 'Previstos para' }],
};
// Origin placeholders (202610200129 adds "ordem de compra" to the search of pedidos de compra). The search itself
// also matches fantasia, e-mail and CPF/CNPJ (with or without mask) on every screen.
export const SEARCH_HINTS: Record<DocumentKind, string> = {
  sales_proposals: 'Pesquisa por nome ou número da proposta',
  sales_orders: 'Pesquisar por nome, e-mail, CPF/CNPJ ou n° do pedido',
  purchase_orders: 'Pesquisa por nome, número do pedido ou ordem de compra',
  service_orders: 'Pesquisar por nome, e-mail, CEP, CPF/CNPJ ou n° da ordem',
};
export type TextFilter = 'city' | 'technician' | 'equipment' | 'serialNumber' | 'internalNote' | 'postalCode' | 'district' | 'trackingCode' | 'carrier' | 'customerPo' | 'contactEmail';
/** Origin order of the Filtrar panel; `afterState` fields come after the UF select. */
export const TEXT_FILTERS: Record<DocumentKind, readonly { key: TextFilter; label: string; max: number; afterState?: true }[]> = {
  sales_orders: [{ key: 'postalCode', label: 'CEP', max: 9 }, { key: 'district', label: 'Bairro', max: 100 }, { key: 'city', label: 'Cidade', max: 100 },
    { key: 'trackingCode', label: 'Código de rastreio', max: 200, afterState: true }, { key: 'carrier', label: 'Transportador', max: 200, afterState: true }, { key: 'customerPo', label: 'Nº do pedido de compra', max: 60, afterState: true }],
  sales_proposals: [{ key: 'city', label: 'Cidade', max: 100 }, { key: 'contactEmail', label: 'Email do Cliente', max: 254 }],
  service_orders: [{ key: 'technician', label: 'Técnico', max: 200 }, { key: 'equipment', label: 'Equipamento', max: 200 }, { key: 'serialNumber', label: 'Número de série do equipamento', max: 100 }],
  purchase_orders: [{ key: 'internalNote', label: 'Observação interna', max: 200 }],
};
/** Origin "Pedidos de compra": opens on Situação = Em aberto and the last 30 days; the other lists start without a filter of their own. */
export function defaultListFilters(kind: DocumentKind, today: string): DocumentListFilters {
  return kind === 'purchase_orders' ? { ...EMPTY_LIST_FILTERS, statuses: ['open'], from: addDays(today, -29), to: today } : EMPTY_LIST_FILTERS;
}
/** Origin single-choice Situação of the pedidos de compra ("Todas" is no status). Leva H (EST-005): Atendido parcialmente stays,
 * because a partial receipt really leaves the pedido in it, so the filter offers it too. */
export const PURCHASE_STATUS_OPTIONS = ['open', 'fulfilled', 'cancelled', 'in_progress', 'partially_fulfilled'] as const;
/** Origin single-choice Situação of the propostas: "Em aberto" groups the propostas not finished; Modelos are the templates. */
export const PROPOSAL_STATUS_OPTIONS: readonly { value: string; label: string; statuses: string[]; template: boolean | null }[] = [
  { value: '', label: 'Todas', statuses: [], template: null },
  { value: 'em-aberto', label: 'Em aberto', statuses: ['draft', 'open', 'pending', 'waiting'], template: null },
  ...(['draft', 'pending', 'waiting', 'approved', 'rejected', 'completed', 'cancelled'] as const).map(value => ({ value, label: STATES.sales_proposals[value]!, statuses: [value], template: null })),
  { value: 'modelos', label: 'Modelos', statuses: [], template: true },
];
export function proposalStatusOption(filters: Pick<DocumentListFilters, 'statuses' | 'template'>): string | null {
  const found = PROPOSAL_STATUS_OPTIONS.find(option => option.template === filters.template && JSON.stringify([...option.statuses].sort()) === JSON.stringify([...filters.statuses].sort()));
  return found ? found.value : null;
}
export const STATE_FILTER: Record<DocumentKind, boolean> = { sales_orders: true, sales_proposals: false, service_orders: false, purchase_orders: false };
const TEXT_PARAM: Record<TextFilter, string> = { city: 'city', technician: 'technician', equipment: 'equipment', serialNumber: 'serial_number', internalNote: 'internal_note',
  postalCode: 'postal_code', district: 'district', trackingCode: 'tracking_code', carrier: 'carrier', customerPo: 'customer_po_number', contactEmail: 'contact_email' };
/** CEP filter: only the digits are sent (prefix match on the contact or delivery address). */
export const postalDigits = (value: string) => value.replace(/[\s.-]/g, '');
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const CONTROL = /[\x00-\x1f\x7f]/;
const validDate = (value: string) => { const date = new Date(`${value}T00:00:00.000Z`); return /^(19|20)\d{2}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; };

/** Query string for GET /v1/documentos/{kind}; throws a user-facing message for invalid filters. */
/** `situations`: the kind follows the Gerenciador de transições (202610200163); `statuses` then hold exact situação keys. */
/** Leva H (VND-015, VND-166, 392): the lixeira of the documents, listed through the status filter. */
export const TRASH_STATUS = 'deleted';
export const TRASH_REASONS: Record<string, string> = {
  not_found: 'não encontrado ou fora do seu acesso', stock_posted: 'tem estoque lançado (estorne antes ou cancele)', finance_posted: 'tem contas lançadas (estorne antes ou cancele)',
  invoice_linked: 'tem nota fiscal ligada (cancele em vez de excluir)', stock_reserved: 'tem estoque reservado', grouped_billing: 'está num faturamento agrupado',
  checkout: 'tem leituras de checkout', generated_document: 'gerou outro documento',
};
export function documentListQuery(kind: DocumentKind, filters: DocumentListFilters, { page = 1, order = 'date_desc', limit = DOCUMENT_LIST_PAGE_SIZE, situations = false }: { page?: number; order?: DocumentListOrder; limit?: number; situations?: boolean } = {}): URLSearchParams {
  if (filters.origin !== undefined && !['all', 'origin', 'brufap'].includes(filters.origin)) throw new Error('Escolha uma origem válida.');
  const query = filters.query.trim();
  if (filters.query.length > 120 || CONTROL.test(filters.query)) throw new Error('A pesquisa deve ter até 120 caracteres, sem quebras de linha.');
  for (const value of [filters.from, filters.to]) if (value && !validDate(value)) throw new Error('Informe datas válidas entre 1900 e 2099.');
  if (filters.from && filters.to && filters.from > filters.to) throw new Error('A data inicial deve ser anterior ou igual à data final.');
  // Leva H (392): "deleted" alone is the lixeira (Excluídos), always sent as the status filter.
  const trash = filters.statuses.length === 1 && filters.statuses[0] === TRASH_STATUS;
  if (trash) situations = false;
  const keyValid = (status: string) => trash || Object.hasOwn(STATES[kind], status) || (situations && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(status));
  if (filters.statuses.length > (situations ? 50 : 20) || new Set(filters.statuses).size !== filters.statuses.length || filters.statuses.some(status => !keyValid(status))) throw new Error('Escolha situações válidas para este documento.');
  if (!DATE_TYPES[kind].some(type => type.value === filters.dateType)) throw new Error('Escolha um tipo de data válido para este documento.');
  if (!Number.isInteger(page) || page < 1 || page > 100000 || !DOCUMENT_LIST_ORDERS.includes(order) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Atualize a listagem para reiniciar a paginação.');
  for (const reference of [filters.warehouse, filters.product]) if (reference && !UUID.test(reference.id)) throw new Error('Selecione novamente o cadastro do filtro.');
  const allowed = new Set(TEXT_FILTERS[kind].map(field => field.key));
  for (const field of Object.keys(TEXT_PARAM) as TextFilter[]) {
    const value = filters[field];
    if (!value) continue;
    const spec = TEXT_FILTERS[kind].find(item => item.key === field);
    if (!allowed.has(field) || !spec || value.length > spec.max || CONTROL.test(value) || !value.trim()) throw new Error(`Confira o filtro ${spec?.label ?? 'informado'}: até ${spec?.max ?? 0} caracteres, sem quebras de linha.`);
    if (field === 'postalCode' && !/^\d{1,8}$/.test(postalDigits(value))) throw new Error('Confira o filtro CEP: use até oito dígitos.');
  }
  if (filters.template !== null && kind !== 'sales_proposals') throw new Error('O filtro de modelos vale só para propostas.');
  if (filters.seller && (kind === 'purchase_orders' || !UUID.test(filters.seller.id))) throw new Error('Selecione novamente o vendedor do filtro.');
  if (filters.component && (kind !== 'sales_orders' || !UUID.test(filters.component.id))) throw new Error('Selecione novamente o componente do filtro.');
  if (filters.service && (kind !== 'service_orders' || !UUID.test(filters.service.id))) throw new Error('Selecione novamente o serviço do filtro.');
  if (filters.state && (!STATE_FILTER[kind] || !(DOCUMENT_LIST_UFS as readonly string[]).includes(filters.state))) throw new Error('Escolha uma UF válida.');
  let lots: string[] | null = null, search: SearchCondition[] | null = null;
  if (filters.lots?.trim()) {
    if (!LOT_FILTER[kind]) throw new Error('O filtro de lotes vale só para pedidos de venda e ordens de serviço.');
    try { lots = lotCodes(filters.lots); } catch { throw new Error('Confira o filtro Lote: até 50 lotes separados por ;, cada um com até 60 caracteres, sem quebras de linha.'); }
  }
  if (filters.search?.length) {
    try { search = searchConditions(kind, filters.search); }
    catch { throw new Error('Confira a Busca customizada: escolha o campo, a condição e um valor válido em cada filtro (até 10).'); }
  }
  const params = new URLSearchParams({ limit: String(limit), page: String(page) });
  if (order !== 'date_desc') params.set('order', order);
  if (filters.statuses.length) params.set(situations ? 'situation' : 'status', filters.statuses.join(','));
  if (query) params.set('q', query);
  if (filters.dateType !== 'date' && (filters.from || filters.to)) params.set('date_type', filters.dateType);
  if (filters.from) params.set('date_from', filters.from);
  if (filters.to) params.set('date_to', filters.to);
  if (filters.warehouse) params.set('warehouse_id', filters.warehouse.id);
  if (filters.product) params.set('product_id', filters.product.id);
  for (const field of Object.keys(TEXT_PARAM) as TextFilter[]) if (filters[field].trim()) params.set(TEXT_PARAM[field], field === 'postalCode' ? postalDigits(filters[field]) : filters[field].trim());
  if (filters.state) params.set('state', filters.state);
  if (filters.template !== null) params.set('template', String(filters.template));
  if (filters.seller) params.set('seller_id', filters.seller.id);
  if (filters.component) params.set('component_id', filters.component.id);
  if (filters.service) params.set('service_id', filters.service.id);
  if (lots) params.set('lote', lots.join(';'));
  if (search) params.set('busca', JSON.stringify(search));
  if (filters.origin && filters.origin !== 'all') params.set('origin', filters.origin);
  return params;
}

/** The worker already validates the payload strictly; this guards the page/order pairing against late or foreign responses. */
export function readDocumentListPage(value: unknown, kind: DocumentKind, page: number, order: DocumentListOrder): DocumentListPage {
  const result = value as DocumentListPage;
  if (!result || typeof result !== 'object' || result.kind !== kind || !Array.isArray(result.items) || result.page !== page || result.order !== order
    || !Number.isSafeInteger(result.total_count) || result.total_count < 0 || (result.total_amount !== null && (typeof result.total_amount !== 'string' || !/^(0|[1-9]\d{0,17})\.\d{2}$/.test(result.total_amount)))
    || result.items.some(row => !row || row.kind !== kind || !UUID.test(row.id))) throw new Error('DOCUMENT_LIST_INVALID');
  return result;
}

export const pageCount = (total: number, size = DOCUMENT_LIST_PAGE_SIZE) => Math.max(1, Math.ceil(total / size));
/** Column header click: Data and Número start newest first, a second click flips the direction. */
export function nextOrder(column: 'date' | 'number', current: DocumentListOrder): DocumentListOrder {
  if (column === 'date') return current === 'date_desc' ? 'date_asc' : 'date_desc';
  return current === 'number_desc' ? 'number_asc' : 'number_desc';
}
export const orderColumn = (order: DocumentListOrder) => order.startsWith('date') ? 'date' : 'number';

export type ListIndicator = { key: string; title: string; letter?: { text: string; color: string }; icon?: string; className?: string; badge?: string };
/** Origin row indicators computed only from the list projection (no effects are inferred). */
export function listIndicators(row: DocumentListRow): ListIndicator[] {
  if (isDocumentMirror(row)) return row.mirror?.partial ? [{ key: 'MIRROR_PARTIAL', badge: 'Parcial', className: 'is-pending', title: 'Cobertura parcial: há dados não informados ou pendências no espelho do Origin.' }] : [];
  const out: ListIndicator[] = [];
  if (row.source_proposal_number) out.push({ key: 'P', letter: { text: 'P', color: 'red' }, title: `Proposta comercial ${row.source_proposal_number}` });
  if (row.finance_active) out.push({ key: 'C', letter: { text: 'C', color: 'green' }, title: 'Contas lançadas' });
  // 018: contas lançadas in the Origin for a converted document (no Brufap posting).
  else if (row.origin_finance) out.push({ key: 'C', letter: { text: 'C', color: 'green' }, title: 'Contas lançadas no Origin' });
  if (row.stock_active || row.receipt_active) out.push({ key: 'E', letter: { text: 'E', color: 'blue' }, title: `Estoque lançado${row.warehouse_name ? ` - Depósito: ${row.warehouse_name}` : ''}` });
  // Origin "Origem NF <n> - Data: <data>" (NF-e dark red, NFC-e dark green); a draft without number keeps the emitter wording.
  if (row.invoice) out.push({ key: 'N', letter: { text: 'N', color: row.invoice.model === '65' ? 'darkgreen' : 'darkred' }, title: row.invoice.number ? `Origem ${row.invoice.model === '65' ? 'NFC-e' : 'NF'} ${row.invoice.number} - Data: ${brDay(row.invoice.issue_date)}` : `Nota fiscal vinculada (em preparação) - Data: ${brDay(row.invoice.issue_date)}` });
  else if (row.fiscal_draft === true) out.push({ key: 'N', letter: { text: 'N', color: 'darkred' }, title: 'Nota fiscal vinculada (rascunho no emissor)' });
  // 202610200163: the other profiles see that a nota exists; its number and date stay with administrador and fiscal (113).
  else if (row.invoice_linked === true) out.push({ key: 'N', letter: { text: 'N', color: 'darkred' }, title: row.kind === 'service_orders' ? 'Ordem de serviço com nota fiscal vinculada' : 'Pedido com nota fiscal vinculada' });
  else if (row.origin_invoice) out.push({ key: 'N', letter: { text: 'N', color: 'darkred' }, title: 'Nota fiscal gerada no Origin' });
  if (row.service_order_number) out.push({ key: 'O', letter: { text: 'O', color: 'midgreen' }, title: `Ordem de serviço ${row.service_order_number}` });
  if (row.pendencies === true) out.push({ key: 'PEND', icon: 'triangle-exclamation', className: 'is-pending', title: 'Este pedido contém pendências' });
  if (row.internal_notes) out.push({ key: 'OBS', icon: 'comment', className: 'is-comment', title: row.internal_notes });
  if (row.first_sale === true) out.push({ key: '1V', badge: '1ª venda', title: 'Primeiro pedido deste cliente', className: 'documents-first-sale' });
  return out;
}

export const effectsActive = (row: Pick<DocumentListRow, 'finance_active' | 'stock_active' | 'receipt_active' | 'reservation_active'>) => row.finance_active || row.stock_active || row.receipt_active || row.reservation_active === true;
/** Situações the server accepts from the current one; active effects keep only the forward moves the SQL guards allow. */
export function statusTargets(kind: DocumentKind, row: Pick<DocumentListRow, 'status' | 'template' | 'finance_active' | 'stock_active' | 'receipt_active' | 'reservation_active'> & { situation?: RowSituation | null }, model?: SituationModel | null): string[] {
  if (managed(model, kind)) return situationTargets(model, kind, row);
  const targets = TRANSITIONS[kind][row.status] ?? [];
  return targets.filter(target => (!effectsActive(row) || effectTransitionAllowed(kind, row.status, target, row.finance_active !== false)) && !(row.template && target === 'approved'));
}
/** `from`/`to` are situação keys; between situações of the same base no reason is needed (163). */
export function reasonRequired(kind: DocumentKind, from: string, to: string, model?: SituationModel | null) {
  const a = baseOf(model, kind, from), b = baseOf(model, kind, to);
  if (managed(model, kind) && a === b) return false;
  try { checkTransition(kind, a, b, null); return false; } catch (error) { return (error as { code?: string }).code === 'DOCUMENT_REASON_REQUIRED'; }
}
// The worker refuses any control character in the reason (tab and line breaks included).
export const validReason = (reason: string) => reason.trim().length >= 3 && reason.length <= 1000 && !/[\x00-\x1f\x7f]/.test(reason);

export type StatusBatchItem = BatchItem & { row: DocumentListRow };
const documentNoun: Record<DocumentKind, string> = { sales_proposals: 'Proposta', sales_orders: 'Pedido', purchase_orders: 'Pedido de compra', service_orders: 'Ordem de serviço' };
export const rowLabel = (kind: DocumentKind, row: Pick<DocumentListRow, 'number' | 'contact_name'>) => `${documentNoun[kind]} ${row.number} · ${row.contact_name}`;
/** Preview of "Mudar situação dos selecionados": every skipped row carries the reason, eligible rows run one by one. */
export function statusBatchPlan(kind: DocumentKind, rows: readonly DocumentListRow[], target: string, reason: string, model?: SituationModel | null, role = ''): BatchPlan<StatusBatchItem> {
  const items = rows.map(row => ({ id: row.id, label: rowLabel(kind, row), row }));
  return planBatch(items, ({ row }) => {
    if (isDocumentMirror(row)) return DOCUMENT_MIRROR_READ_ONLY;
    if (!target) return null; // Nothing runs until a situação is chosen (BatchDialog canConfirm).
    const current = managed(model, kind) ? rowKey(row) : row.status;
    if (current === target) return 'Já está nesta situação.';
    if (!statusTargets(kind, row, model).includes(target)) return effectsActive(row) && (managed(model, kind) ? statusTargets(kind, { ...row, finance_active: false, stock_active: false, receipt_active: false, reservation_active: false }, model) : TRANSITIONS[kind][row.status] ?? []).includes(target)
      ? 'Existe lançamento ou reserva ativa; estorne antes desta mudança.' : `Não é possível ir de ${statusLabel(kind, current, model)} para ${statusLabel(kind, target, model)}.`;
    if (managed(model, kind) && !actionsAllowed(transitionActions(model, kind, current, target), role)) return 'A transição lança ou estorna estoque ou contas, e seu perfil não faz esses lançamentos.';
    if (reasonRequired(kind, current, target, model) && !validReason(reason)) return 'Informe um motivo com pelo menos três caracteres.';
    return null;
  });
}
/** Name of a situação key (the custom ones come from the Gerenciador de transições). */
export const statusLabel = (kind: DocumentKind, status: string, model?: SituationModel | null) => status === TRASH_STATUS ? 'Excluídos' : situationName(model, kind, status);

export type RowActionKind = 'edit' | 'clone' | 'create_model' | 'clone_model' | 'convert_sale' | 'convert_service' | 'sales_to_service' | 'clear_warnings' | 'stock' | 'finance' | 'print' | 'print_receipt' | 'print_detailed' | 'print_carne' | 'print_production' | 'print_product_labels' | 'print_technician' | 'print_label' | 'fiscal55' | 'fiscal65' | 'fiscal_partial' | 'whatsapp' | 'status' | 'unavailable';
export interface RowAction { key: string; action: RowActionKind; label: string; letter?: { text: string; color: string; struck?: boolean }; icon?: string; enabled: boolean; title?: string; separatorBefore?: boolean; target?: string }
const soon = (what: string) => `${what} ainda não está disponível no FAGOO.`;
// Origin hides (instead of disaorigin) these actions for the seller profile; in the Brufap that is the vendas role.
const HIDDEN_FOR_SELLER: readonly RowActionKind[] = ['fiscal55', 'fiscal65', 'stock', 'finance'];
/**
 * The ⋮ menu of a row, in Origin's order. Only actions with a real endpoint are enabled; the server still checks
 * permission, version and effects. Effects (estoque/contas) open their own preview before anything is posted.
 */
export function documentRowActions(kind: DocumentKind, row: DocumentListRow, { role, writable, serviceWritable = false, situations = null, permissions = null }: { role: string; writable: boolean; serviceWritable?: boolean; situations?: SituationModel | null; permissions?: DocumentPermissions | null }): RowAction[] {
  const stockRole = role === 'admin' || role === 'estoque', financeRole = role === 'admin' || role === 'financeiro', fiscalRole = role === 'admin' || role === 'fiscal';
  const readOnly = 'Seu perfil permite apenas consultar este documento.';
  const unavailable = (label: string, title: string, extra: Partial<RowAction> = {}): RowAction => ({ key: label, action: 'unavailable', label, enabled: false, title, ...extra });
  const stockPosted = row.stock_active || row.receipt_active;
  // 202610200239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar estoque" / "Lançar contas".
  const osStock = kind === 'service_orders' && permissions && !permissions.service_orders.stock ? 'Seu usuário não tem a permissão “Lançar estoque” das ordens de serviço (Sistema › Usuários).' : '';
  const osFinance = kind === 'service_orders' && permissions && !permissions.service_orders.finance ? 'Seu usuário não tem a permissão “Lançar contas” das ordens de serviço (Sistema › Usuários).' : '';
  const stockBlocked = osStock ? osStock : !stockRole ? 'Lançamento de estoque restrito aos perfis administrador e estoque.' : kind === 'sales_orders' && row.reservation_active && !stockPosted ? 'Existe reserva ativa: consuma ou libere a reserva no pedido antes de lançar o estoque.' : '';
  // Estornar shows the letter struck through (Origin "ban" variant).
  const stock: RowAction = { key: 'stock', action: 'stock', label: stockPosted ? 'Estornar estoque' : 'Lançar estoque', letter: { text: 'E', color: 'blue', ...(stockPosted ? { struck: true } : {}) }, enabled: !stockBlocked, ...(stockBlocked ? { title: stockBlocked } : { title: 'Abre a conferência do estoque antes de confirmar.' }) };
  const finance: RowAction = { key: 'finance', action: 'finance', label: row.finance_active ? 'Estornar contas' : 'Lançar contas', letter: { text: 'C', color: 'green', ...(row.finance_active ? { struck: true } : {}) }, enabled: financeRole && !osFinance, title: osFinance || (financeRole ? 'Abre a conferência das contas antes de confirmar.' : 'Lançamento de contas restrito aos perfis administrador e financeiro.') };
  const clone = (label: string, separatorBefore = false): RowAction => ({ key: 'clone', action: 'clone', label, icon: 'clone', enabled: writable, separatorBefore, ...(writable ? { title: 'Abre uma cópia para conferir antes de salvar.' } : { title: readOnly }) });
  const print: RowAction = { key: 'print', action: 'print', label: 'Imprimir', icon: 'print', enabled: true, separatorBefore: true };
  // Origin print variants of the saved version: comprovante não fiscal (A4/80 mm), detalhado and carnê of the planned installments.
  const printVariant = (action: 'print_receipt' | 'print_detailed' | 'print_carne', label: string): RowAction => ({ key: action, action, label, icon: action === 'print_carne' ? 'receipt' : 'print', enabled: true });
  const whatsapp = (label: string): RowAction => ({ key: 'whatsapp', action: 'whatsapp', label, icon: 'whatsapp', enabled: true, title: `Abre o WhatsApp com o resumo da versão salva para o celular do ${kind === 'purchase_orders' ? 'fornecedor' : 'cliente'}.` });
  // 202610200176 (notas lane): opens a new note filled from the pedido in a new tab; nothing is saved until the note's Salvar.
  const fiscal = (action: 'fiscal55' | 'fiscal65', label: string, color: string): RowAction => ({ key: action, action, label, letter: { text: 'N', color }, enabled: fiscalRole, title: fiscalRole ? `Abre ${kind === 'purchase_orders' ? 'a nota fiscal de entrada' : action === 'fiscal55' ? 'a NF-e' : 'a NFC-e'} (homologação) preenchida com ${kind === 'service_orders' ? 'as peças desta ordem de serviço' : 'este pedido'}; a nota só é gravada no Salvar.` : 'Emissão restrita aos perfis administrador e fiscal.' });
  const out: RowAction[] = [{ key: 'edit', action: 'edit', label: writable ? 'Editar' : 'Visualizar', icon: writable ? 'pen-to-square' : 'eye', enabled: true }];
  if (kind === 'sales_orders') {
    out.push(fiscal('fiscal55', 'Gerar nota fiscal', 'darkred'),
      // Leva H (VND-047, 391): Gerar nota fiscal parcial — part of the quantities of each item, within the balance; several notes per pedido.
      { key: 'fiscal_partial', action: 'fiscal_partial', label: 'Gerar nota fiscal parcial', letter: { text: 'N', color: 'darkred' }, enabled: fiscalRole && !['cancelled', 'draft'].includes(row.status),
        title: !fiscalRole ? 'Notas fiscais restritas aos perfis administrador e fiscal.' : ['cancelled', 'draft'].includes(row.status) ? 'O pedido precisa estar fora de Em digitação e não cancelado.' : 'Escolhe as quantidades a faturar de cada item, até o saldo, e grava uma NF-e (homologação) só com elas.' },
      stock, finance, fiscal('fiscal65', 'Gerar NFC-e', 'darkgreen'),
      // 202610200131 "Gerar ordem serviço": once per pedido, only without nota fiscal; needs a profile that writes OS.
      { key: 'sales_to_service', action: 'sales_to_service', label: 'Gerar ordem serviço', letter: { text: 'O', color: 'midgreen' }, enabled: serviceWritable && !row.invoice && !row.invoice_linked && row.status !== 'partially_invoiced' && !row.service_order_number && row.status !== 'cancelled' && Object.hasOwn(row, 'pendencies'),
        title: !Object.hasOwn(row, 'pendencies') ? 'Disponível depois da atualização do banco de dados.' : !serviceWritable ? 'Seu perfil não inclui ordens de serviço.' : row.service_order_number ? `Ordem de serviço ${row.service_order_number} já gerada.` : row.invoice || row.invoice_linked || row.status === 'partially_invoiced' ? 'O pedido já tem nota fiscal.' : row.status === 'cancelled' ? 'Pedido cancelado.' : 'Abre a conferência da ordem de serviço antes de criar.' }, clone('Clonar venda'), print,
      printVariant('print_receipt', 'Imprimir comprovante'), printVariant('print_detailed', 'Imprimir c/ detalhes'), printVariant('print_carne', 'Imprimir carnê'),
      // 202610200240 Origin "Relatório de produção" (Preferências › Vendas › Configuração de Impressão do Relatório de Produção).
      { key: 'print_production', action: 'print_production', label: 'Relatório de produção', icon: 'list-check', enabled: true, title: 'Itens a separar ou produzir, sem valores, com as opções de Preferências › Vendas.' },
      unavailable('Enviar por e-mail', soon('O envio por e-mail'), { icon: 'paper-plane', separatorBefore: true }), whatsapp('Enviar por WhatsApp'), unavailable('Emitir boletos', soon('A emissão de boletos pelo pedido'), { icon: 'barcode' }));
    // Origin "Limpar avisos" (only with pendências): the pendências are checked again on every read.
    if (row.pendencies === true) out.push({ key: 'clear_warnings', action: 'clear_warnings', label: 'Limpar avisos', icon: 'rotate-right', enabled: true, title: 'Confere de novo as pendências cadastrais dos pedidos.' });
    // Origin: with a nota fiscal the pedido no longer offers Gerar nota fiscal, Gerar NFC-e or launching contas/estoque (estornos stay).
    // 202610200240: Origin "Emitir boletos" also leaves the menu when the pedido has a nota and its contas were not posted by the pedido.
    // 202610200245: Faturado parcialmente (the pedido already has a partial nota) hides them too, like the Origin rule.
    if (row.invoice || row.invoice_linked || row.status === 'partially_invoiced') for (let index = out.length - 1; index >= 0; index--) { const action = out[index]!; if (action.action === 'fiscal55' || action.action === 'fiscal65' || (action.action === 'stock' && !stockPosted) || (action.action === 'finance' && !row.finance_active) || (action.label === 'Emitir boletos' && !row.finance_active)) out.splice(index, 1); }
    // 202610200291: Origin also hides Gerar nota fiscal, Gerar NFC-e, Lançar estoque and Lançar contas in Checkout parcial (no rule of
    // the stock or the contas accepts it; the estornos stay).
    else if (row.status === 'checkout_partial') for (let index = out.length - 1; index >= 0; index--) { const action = out[index]!; if (action.action === 'fiscal55' || action.action === 'fiscal65' || (action.action === 'stock' && !stockPosted) || (action.action === 'finance' && !row.finance_active)) out.splice(index, 1); }
  } else if (kind === 'sales_proposals') {
    // Origin "Gerar venda" / "Gerar ordem de serviço": any proposta without a generated document, except cancelled ones (202610200129).
    const blocked = !writable ? readOnly : row.template ? 'Modelos de proposta não geram documentos.' : row.status === 'completed' ? 'A proposta já gerou um documento.' : row.status === 'cancelled' ? 'Proposta cancelada.' : '';
    out.push({ key: 'convert_sale', action: 'convert_sale', label: 'Gerar venda', letter: { text: 'V', color: 'orange' }, enabled: !blocked, ...(blocked ? { title: blocked } : {}) },
      { key: 'convert_service', action: 'convert_service', label: 'Gerar ordem de serviço', letter: { text: 'O', color: 'midgreen' }, enabled: !blocked, ...(blocked ? { title: blocked } : {}) },
      print, unavailable('Enviar por e-mail', soon('O envio por e-mail'), { icon: 'envelope' }), whatsapp('Enviar por whatsapp'));
  } else if (kind === 'service_orders') {
    out.push(finance, stock, fiscal('fiscal55', 'Gerar nota fiscal', 'darkred'), print,
      { key: 'print_technician', action: 'print_technician', label: 'Imprimir para técnico', icon: 'print', enabled: true, title: 'Impressão da OS para o técnico, com as opções de Preferências › Serviços (ocultar valores e dados do cliente).' },
      { key: 'print_label', action: 'print_label', label: 'Imprimir etiqueta', icon: 'note-sticky', enabled: true, title: 'Etiqueta de identificação da OS: cliente, equipamento e número de série.' }, printVariant('print_carne', 'Imprimir carnê'), unavailable('Enviar por e-mail', soon('O envio por e-mail'), { icon: 'paper-plane' }), whatsapp('Enviar por whatsapp'), clone('Clonar ordem'));
    // 202610200198 Origin: an OS with a nota fiscal no longer offers Gerar nota fiscal.
    if (row.invoice || row.invoice_linked) for (let index = out.length - 1; index >= 0; index--) if (out[index]!.action === 'fiscal55') out.splice(index, 1);
  } else {
    // Origin order, without Editar (the row opens the pedido).
    out.length = 0;
    out.push(stock, finance, fiscal('fiscal55', 'Gerar nota fiscal', 'darkred'), print,
      // 202610200240: the product labels of the items (Cadastros › Produtos), from the saved pedido.
      { key: 'print_product_labels', action: 'print_product_labels', label: 'Imprimir etiquetas', icon: 'note-sticky', enabled: true, title: 'Etiquetas dos produtos do pedido: nome, código, preço e código de barras do GTIN ou do código.' },
      unavailable('Enviar por e-mail', soon('O envio por e-mail'), { icon: 'paper-plane' }),
      whatsapp('Enviar por whatsapp'), clone('Clonar compra'));
  }
  // 202610200163: the targets and names follow the Gerenciador de transições; a transition with actions the profile cannot run stays disabled.
  if (writable) permittedTargets(kind, managed(situations, kind) ? rowKey(row) : row.status, statusTargets(kind, row, situations), permissions).forEach((target, index) => {
    const actions = managed(situations, kind) ? transitionActions(situations, kind, rowKey(row), target) : [], allowed = actionsAllowed(actions, role);
    out.push({ key: `status:${target}`, action: 'status', target, label: statusLabel(kind, target, situations), icon: 'arrow-right', enabled: allowed, separatorBefore: index === 0,
      title: !allowed ? 'A transição lança ou estorna estoque ou contas, e seu perfil não faz esses lançamentos.' : `Mudar a situação para ${statusLabel(kind, target, situations)}${actions.length ? ' (a transição também lança ou estorna estoque ou contas)' : ''}` });
  });
  // Origin: a proposta offers Clonar proposta and Criar modelo; a modelo offers Novo a partir deste and Clonar modelo (all reviewed before saving).
  const modelAction = (action: 'create_model' | 'clone_model', label: string): RowAction => ({ key: action, action, label, icon: 'clone', enabled: writable, ...(writable ? { title: action === 'create_model' ? 'Abre um modelo novo com os dados desta proposta para conferir antes de salvar.' : 'Abre uma cópia deste modelo para conferir antes de salvar.' } : { title: readOnly }) });
  if (kind === 'sales_proposals') out.push(...(row.template ? [clone('Novo a partir deste', true), modelAction('clone_model', 'Clonar modelo')] : [clone('Clonar proposta', true), modelAction('create_model', 'Criar modelo')]));
  // None of the hidden actions opens a group, so the separators stay where they are.
  const visible = role === 'vendas' ? out.filter(action => !HIDDEN_FOR_SELLER.includes(action.action)) : out;
  return isDocumentMirror(row) ? visible.map(action => action.action === 'edit'
    ? { ...action, label: 'Visualizar', icon: 'eye' }
    : ['print', 'print_detailed'].includes(action.action) ? { ...action, title: 'Imprime a consulta do espelho, com os valores informados pelo Origin.' }
      : { ...action, enabled: false, title: DOCUMENT_MIRROR_READ_ONLY }) : visible;
}
export const brDay = (value: string | null) => value ? value.split('-').reverse().join('/') : '';
