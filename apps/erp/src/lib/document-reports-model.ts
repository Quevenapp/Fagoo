// Relatórios de vendas e de serviço (202610200130): Origin catalog, parameters and the read-only answers of the Worker.
import { addDays } from './origin-list.ts';
import { STATES, type DocumentKind } from './real-documents-model.ts';
import { FISCAL_REPORT_TITLES, type FiscalReportId } from './fiscal-reports-model.ts';

// Leva H (362): the Relatórios de Notas Fiscais over the real notes (imported XMLs and the Origin mirror).
export type ReportId = 'vendas' | 'bairro' | 'curva-abc' | 'os' | 'ocorrencias' | 'romaneio' | FiscalReportId;
export interface ReportCard { id: ReportId | null; title: string; description: string; reason?: string }
export interface ReportGroup { title: string; cards: ReportCard[] }
/** Origin "Relatórios de vendas" (relatorios.php?id=3) and "Relatórios de serviço" (id=6), in the Origin order. */
export const REPORT_CATALOG: Record<'sales_orders' | 'service_orders', ReportGroup[]> = {
  sales_orders: [
    { title: 'Checkout de Pedidos de Venda', cards: [{ id: null, title: 'Relatório de Separação (Picking)', description: 'Itens a separar dos pedidos.', reason: 'Depende do checkout de pedidos, que ainda não existe no FAGOO.' }] },
    { title: 'Comissões', cards: [{ id: null, title: 'Relatório Complementar de Comissões', description: 'Comissões dos vendedores.', reason: 'O relatório ainda não existe no FAGOO; as comissões de cada vendedor estão em Financeiro > Comissões.' }] },
    { title: 'Notas Fiscais', cards: [{ id: 'nf-difal', title: 'Notas Fiscais ICMS DIFAL', description: 'Diferencial de alíquota das notas autorizadas, por UF de destino, com a cobertura do detalhamento.' }] },
    { title: 'Relatórios de Notas Fiscais', cards: [
      { id: 'nf-operacao', title: 'Notas Fiscais por Operação', description: 'Faturamento das notas autorizadas por natureza de operação.' },
      { id: 'nf-cliente', title: 'Notas Fiscais por Cliente', description: 'Faturamento das notas autorizadas por cliente.' },
      { id: 'nf-produto', title: 'Notas Fiscais por Produto', description: 'Itens das notas autorizadas por produto.' },
      { id: 'nf-evolucao', title: 'Evolução do Faturamento', description: 'Faturamento mês a mês das notas autorizadas (gráfico).' }] },
    { title: 'Relatórios de Vendas', cards: [
      { id: 'romaneio', title: 'Relatório de Romaneio', description: 'Romaneio de entrega dos pedidos: endereço, transportador, volumes, peso e itens.' },
      { id: 'vendas', title: 'Relatório de Vendas', description: 'Vendas agrupadas por cliente, produto ou vendedor.' },
      { id: 'bairro', title: 'Relatório de Vendas Agrupado por bairro', description: 'Vendas agrupadas pelo bairro de entrega ou do cliente.' }] },
    { title: 'Pedidos de Venda', cards: [{ id: 'curva-abc', title: 'Relatório de curva ABC de itens de vendas (últimos 30 dias)', description: 'Itens mais vendidos e a classificação A, B e C.' }] },
  ],
  service_orders: [
    { title: 'Contratos', cards: [{ id: null, title: 'Relatório de Início e Término de Contratos', description: 'Contratos por período.', reason: 'Os contratos ainda não existem no FAGOO.' }, { id: null, title: 'Relatório de Início e Término de Contratos Agrupados por Mês', description: 'Contratos agrupados por mês.', reason: 'Os contratos ainda não existem no FAGOO.' }] },
    { title: 'Customizáveis', cards: [
      { id: null, title: 'Relatório de Contratos (Visão de Contratos)', description: 'Visão de contratos.', reason: 'Os contratos ainda não existem no FAGOO.' },
      { id: null, title: 'Relatório de Nota Serviço Parcela', description: 'Parcelas das notas de serviço.', reason: 'A NFS-e está fora do escopo do FAGOO.' },
      { id: null, title: 'Relatório de NFS-e', description: 'Notas fiscais de serviço.', reason: 'A NFS-e está fora do escopo do FAGOO.' },
      { id: 'ocorrencias', title: 'Relatório de Ocorrências por Ordem de Serviço (Visão de Ocorrências)', description: 'Ocorrências das ordens de serviço no período.' },
      { id: 'os', title: 'Relatório de Ordem de Serviço (Visão de Ordem de Serviço)', description: 'Ordens de serviço com peças, serviços e total.' }] },
  ],
};
export const REPORT_TITLES: Record<ReportId, string> = { ...FISCAL_REPORT_TITLES, romaneio: 'Relatório de Romaneio', vendas: 'Relatório de Vendas', bairro: 'Relatório de Vendas Agrupado por bairro', 'curva-abc': 'Relatório de curva ABC de itens de vendas', os: 'Relatório de Ordem de Serviço', ocorrencias: 'Relatório de Ocorrências por Ordem de Serviço' };
export const reportKind = (id: ReportId): 'sales_orders' | 'service_orders' => id === 'os' || id === 'ocorrencias' ? 'service_orders' : 'sales_orders';
export const isReportId = (value: string | null): value is ReportId => value !== null && Object.hasOwn(REPORT_TITLES, value);

export type SalesGroup = 'contact' | 'product' | 'seller' | 'district';
/** Origin checkbox lists (Marcar/Desmarcar todas + "Sem vínculo" / "Incluir produtos sem classificação"): null while every box is checked (no filter). */
export interface Choice { ids: string[]; none: boolean }
// 202610200271: "Exibir lucro → Utilizar como base" (Origin order). 374 (leva H): Preço de custo até a data do pedido reads the cost
// history of the cadastro, and Custo aplicado na operação the cost frozen at the commercial confirmation (else the cost at the date).
export type ProfitBase = 'cost' | 'last_purchase' | 'last_purchase_until' | 'cost_until' | 'applied';
export const PROFIT_BASE_LABELS: Record<ProfitBase, string> = { cost: 'Preço de custo', last_purchase: 'Preço da última compra', last_purchase_until: 'Preço da última compra até a data do pedido', cost_until: 'Preço de custo até a data do pedido', applied: 'Custo aplicado na operação' };
export const PROFIT_BASE_NOTE = 'Preço de custo e Preço da última compra são os valores de hoje; para vendas antigas, use as bases até a data do pedido ou o custo aplicado na operação. O histórico do preço de custo começa na leva H.';
export interface SalesReportParams {
  from: string; to: string; dateType: 'date' | 'invoice' | 'expected_date'; group: SalesGroup; subgroup: 'none' | 'contact' | 'product' | 'seller'; order: 'name' | 'amount' | 'items' | 'sales';
  statuses: string[]; includeFreight: boolean; contact: { id: string; name: string } | null; product: { id: string; name: string } | null; city: string; state: string; withoutInvoice: boolean; firstPurchase: boolean;
  seller: string; supplier: { id: string; name: string } | null; warehouse: { id: string; name: string } | null; categories: string[]; contactTypes: Choice | null; tags: Choice | null;
  showProfit: boolean; profitBase: ProfitBase;
}
/** Checks or unchecks one box (or the "none" box) of a Origin checkbox list; every box checked again is no filter. */
export function toggleChoice(current: Choice | null, all: string[], id: string, checked: boolean, none = false): Choice | null {
  const base = current ?? { ids: [...all], none: true };
  const ids = none ? base.ids : checked ? [...new Set([...base.ids, id])] : base.ids.filter(value => value !== id), keep = none ? checked : base.none;
  return keep && all.every(value => ids.includes(value)) ? null : { ids: all.filter(value => ids.includes(value)), none: keep };
}
export const choiceAll = (checked: boolean): Choice | null => checked ? null : { ids: [], none: false };
export const choiceHas = (choice: Choice | null, id: string, none = false) => choice === null || (none ? choice.none : choice.ids.includes(id));
export const GROUP_LABELS: Record<Exclude<SalesGroup, 'district'>, string> = { contact: 'Cliente', product: 'Produto', seller: 'Vendedor' };
export const SUBGROUP_LABELS: Record<SalesReportParams['subgroup'], string> = { contact: 'Cliente', none: 'Nenhum', product: 'Produto', seller: 'Vendedor' };
export const ORDER_LABELS: Record<SalesReportParams['order'], string> = { name: 'Nome/Descrição', amount: 'Valor', items: 'Quantidade Itens', sales: 'Quantidade Vendas' };
/** First and last day of the month of `day` (Origin "Do mês" with the arrows). */
export function monthOf(day: string, shift = 0): { from: string; to: string } {
  const [year, month] = day.split('-').map(Number) as [number, number];
  const index = year * 12 + (month - 1) + shift, y = Math.floor(index / 12), m = index % 12 + 1;
  const from = `${y}-${String(m).padStart(2, '0')}-01`, next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { from, to: addDays(next, -1) };
}
export const defaultSalesParams = (today: string, group: SalesGroup = 'contact'): SalesReportParams => ({ ...monthOf(today), dateType: 'date', group, subgroup: 'none', order: 'name', statuses: [], includeFreight: true, contact: null, product: null, city: '', state: '', withoutInvoice: false, firstPurchase: false,
  seller: '', supplier: null, warehouse: null, categories: [], contactTypes: null, tags: null, showProfit: false, profitBase: 'cost' });
const DATE = /^(19|20)\d{2}-\d{2}-\d{2}$/;
/** Query of GET /v1/documentos/sales_orders/relatorio-vendas; throws a user message for an invalid choice. */
export function salesReportQuery(params: SalesReportParams): URLSearchParams {
  if (!DATE.test(params.from) || !DATE.test(params.to)) throw new Error('Informe o período do relatório.');
  if (params.from > params.to) throw new Error('A data inicial deve ser anterior ou igual à data final.');
  if ((Date.parse(`${params.to}T00:00:00Z`) - Date.parse(`${params.from}T00:00:00Z`)) / 86_400_000 > 731) throw new Error('Escolha um período de até dois anos.');
  if (params.subgroup !== 'none' && params.subgroup === params.group) throw new Error('Escolha um sub agrupamento diferente do agrupamento.');
  if (params.city.length > 100 || /[\x00-\x1f\x7f]/.test(params.city)) throw new Error('Confira a cidade: até 100 caracteres.');
  const query = new URLSearchParams({ from: params.from, to: params.to, group: params.group, order: params.order, include_freight: String(params.includeFreight) });
  if (params.dateType !== 'date') query.set('date_type', params.dateType);
  if (params.subgroup !== 'none') query.set('subgroup', params.subgroup);
  if (params.statuses.length) query.set('status', params.statuses.join(','));
  if (params.contact) query.set('contact_id', params.contact.id);
  if (params.product) query.set('product_id', params.product.id);
  if (params.city.trim()) query.set('city', params.city.trim());
  if (params.state) query.set('state', params.state);
  if (params.withoutInvoice) query.set('without_invoice', 'true');
  if (params.firstPurchase) query.set('first_purchase', 'true');
  // 202610200271: Vendedor, Fornecedor, Depósito, Categorias, Tipo de contato, Tags and Exibir lucro.
  if (params.seller) query.set('seller_id', params.seller);
  if (params.supplier) query.set('supplier_id', params.supplier.id);
  if (params.warehouse) query.set('warehouse_id', params.warehouse.id);
  if (params.categories.length > 50) throw new Error('Escolha até 50 categorias.');
  if (params.categories.length) query.set('categories', params.categories.join(','));
  if (params.contactTypes) { if (!params.contactTypes.ids.length && !params.contactTypes.none) throw new Error('Marque ao menos um tipo de contato (ou Sem vínculo).'); query.set('contact_types', params.contactTypes.ids.join(',')); if (params.contactTypes.none) query.set('contact_untyped', 'true'); }
  if (params.tags) {
    if (!params.tags.ids.length && !params.tags.none) throw new Error('Marque ao menos uma tag (ou Incluir produtos sem classificação).');
    if (params.tags.ids.length > 100) throw new Error('Marque até 100 tags, ou todas.');
    query.set('tags', params.tags.ids.join(',')); if (params.tags.none) query.set('untagged', 'true');
  }
  if (params.showProfit) { query.set('show_profit', 'true'); query.set('profit_base', params.profitBase); }
  return query;
}
export interface SalesReportOptions { contact_types: { id: string; label: string }[]; tags: { id: string; name: string }[]; tag_count: number; sellers: { id: string; name: string }[]; seller_count: number; profit_visible: boolean; invoice_visible: boolean }
/** GET /v1/documentos/sales_orders/relatorio-vendas/opcoes (the Worker checks each field). */
export function readSalesOptions(value: unknown): SalesReportOptions {
  const page = value as (SalesReportOptions & { report?: unknown }) | null;
  const list = (items: unknown, key: string, max: number) => Array.isArray(items) && items.length <= max && items.every(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string' && typeof (item as Record<string, unknown>)[key] === 'string');
  if (!page || page.report !== 'sales_options' || !list(page.contact_types, 'label', 100) || !list(page.tags, 'name', 500) || !list(page.sellers, 'name', 500)
    || !Number.isInteger(page.tag_count) || !Number.isInteger(page.seller_count) || typeof page.profit_visible !== 'boolean' || typeof page.invoice_visible !== 'boolean') throw new Error('REPORT_INVALID');
  return { contact_types: page.contact_types, tags: page.tags, tag_count: page.tag_count, sellers: page.sellers, seller_count: page.seller_count, profit_visible: page.profit_visible, invoice_visible: page.invoice_visible };
}

// 202610200271 Relatório de Romaneio: pedidos to deliver in the period (data do pedido, prevista or de saída).
export type RomaneioDate = 'date' | 'expected_date' | 'ship_date';
export const ROMANEIO_DATES: Record<RomaneioDate, string> = { date: 'Data do pedido', expected_date: 'Data prevista', ship_date: 'Data saída' };
export interface RomaneioParams { from: string; to: string; dateType: RomaneioDate; status: string; carrier: { id: string; name: string } | null; contact: { id: string; name: string } | null }
export const defaultRomaneioParams = (today: string): RomaneioParams => ({ ...monthOf(today), dateType: 'date', status: '', carrier: null, contact: null });
export function romaneioQuery(params: RomaneioParams): URLSearchParams {
  if (!DATE.test(params.from) || !DATE.test(params.to)) throw new Error('Informe o período do romaneio.');
  if (params.from > params.to) throw new Error('A data inicial deve ser anterior ou igual à data final.');
  if ((Date.parse(`${params.to}T00:00:00Z`) - Date.parse(`${params.from}T00:00:00Z`)) / 86_400_000 > 366) throw new Error('Escolha um período de até um ano.');
  const query = new URLSearchParams({ from: params.from, to: params.to });
  if (params.dateType !== 'date') query.set('date_type', params.dateType);
  if (params.status) query.set('status', params.status);
  if (params.carrier) query.set('carrier_id', params.carrier.id);
  if (params.contact) query.set('contact_id', params.contact.id);
  return query;
}
export interface RomaneioAddress { source: 'delivery' | 'contact'; name: string | null; street: string | null; number: string | null; complement: string | null; district: string | null; city: string | null; state: string | null; postal_code: string | null }
export interface RomaneioRow { id: string; number: string; status: string; date: string; expected_date: string | null; ship_date: string | null; contact_name: string; phone: string | null; address: RomaneioAddress;
  carrier: string | null; freight_mode: string | null; volumes: string | null; gross_weight: string | null; items: { code: string | null; description: string; unit: string | null; quantity: string }[] }
export interface RomaneioReport extends NativeReportCoverage { report: 'romaneio'; from: string; to: string; date_type: RomaneioDate; rows: RomaneioRow[]; row_count: number; truncated: boolean; totals: { orders: number; volumes: string; gross_weight: string } }
/** "Rua, número, complemento · bairro · cidade/UF · CEP" (only the parts filled). */
export function romaneioAddressText(address: RomaneioAddress): string {
  const street = [address.street, address.number, address.complement].filter(Boolean).join(', ');
  const city = address.city ? `${address.city}${address.state ? `/${address.state}` : ''}` : address.state;
  return [street, address.district, city, address.postal_code ? `CEP ${address.postal_code}` : null].filter(Boolean).join(' · ') || 'Endereço não informado';
}
export interface SalesReportRow { key: string; label: string; sales: number; items: string; amount: string; cost?: string | null; profit?: string | null; subgroups?: SalesReportRow[] }
export interface SalesReport extends NativeReportCoverage { report: 'sales'; from: string; to: string; date_type?: SalesReportParams['dateType']; group: SalesGroup; subgroup: string | null; item_values: boolean; include_freight: boolean; show_profit?: boolean; profit_base?: ProfitBase | null;
  groups: SalesReportRow[]; group_count: number; truncated: boolean; totals: { sales: number; items: string; amount: string; cost?: string | null; profit?: string | null; items_without_cost?: number } }
export interface AbcRow { position: number; product_id: string | null; description: string; code: string | null; quantity: string; amount: string; percent: string; accumulated: string; class: 'A' | 'B' | 'C' }
export interface AbcReport extends NativeReportCoverage { report: 'abc'; from: string; to: string; items: AbcRow[]; item_count: number; truncated: boolean; total: string }
export interface ServiceReportRow { id: string; number: string; name: string; date: string; parts: string; services: string; total: string; status: string }
export interface ServiceReport extends NativeReportCoverage { report: 'service_orders'; rows: ServiceReportRow[]; row_count: number; truncated: boolean }
export interface ServiceOccurrenceRow { document_id: string; number: string; name: string; occurred_on: string; occurred_time: string; text: string | null; status_before: string; status_after: string | null; actor_name: string | null; actor_role: string }
export interface ServiceOccurrenceReport extends NativeReportCoverage { report: 'service_occurrences'; from: string; to: string; rows: ServiceOccurrenceRow[]; row_count: number; truncated: boolean }
/** The Worker validates every field; this pairs the answer with the request it belongs to (late answers are dropped). */
export function readReport<T extends { report: string }>(value: unknown, report: T['report'], check: (value: T) => boolean): T {
  const result = value as T;
  if (!result || typeof result !== 'object' || result.report !== report || !check(result)) throw new Error('REPORT_INVALID');
  return result;
}

export type ServiceColumn = 'number' | 'name' | 'date' | 'parts' | 'services' | 'total' | 'status';
export const SERVICE_COLUMNS: Record<ServiceColumn, string> = { number: 'Número', name: 'Nome', date: 'Data', parts: 'Total das peças', services: 'Total de serviços', total: 'Preço total', status: 'Situação' };
export interface ServiceCondition { column: ServiceColumn; value: string }
/** One "Coluna + Valor" condition as the server expects it (dates dd/mm/aaaa and amounts with comma are accepted). */
export function serviceCondition(column: ServiceColumn, raw: string): ServiceCondition {
  const text = raw.trim();
  if (!text) throw new Error('Informe o valor da condição.');
  if (column === 'number') { if (!/^[1-9]\d{0,9}$/.test(text)) throw new Error('Informe o número da OS, sem zeros à esquerda.'); return { column, value: text }; }
  if (column === 'date') { const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text); const iso = match ? `${match[3]}-${match[2]}-${match[1]}` : text; if (!DATE.test(iso) || new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) !== iso) throw new Error('Informe a data como dd/mm/aaaa.'); return { column, value: iso }; }
  if (column === 'status') { const found = Object.entries(STATES.service_orders).find(([code, label]) => code === text || label.toLocaleLowerCase('pt-BR') === text.toLocaleLowerCase('pt-BR')); if (!found) throw new Error('Escolha uma situação da OS.'); return { column, value: found[0] }; }
  if (column === 'name') { if (text.length > 120 || /[\x00-\x1f\x7f]/.test(text)) throw new Error('O nome deve ter até 120 caracteres.'); return { column, value: text }; }
  const amount = text.replace(/\./g, '').replace(',', '.');
  if (!/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(amount)) throw new Error('Informe o valor com até duas casas decimais, por exemplo 150,00.');
  return { column, value: amount };
}
export const conditionText = (condition: ServiceCondition) => `${SERVICE_COLUMNS[condition.column]}: ${condition.column === 'date' ? condition.value.split('-').reverse().join('/') : condition.column === 'status' ? STATES.service_orders[condition.value] ?? condition.value : condition.value}`;
export const lastDays = (today: string, count: number) => ({ from: addDays(today, -(count - 1)), to: today });
export const reportKindOf = (kind: DocumentKind) => kind === 'sales_orders' || kind === 'service_orders' ? kind : null;

/** These reports calculate native effects; mirrors remain visible in the commercial lists. */
export interface NativeReportCoverage { origin?: 'brufap'; mirror_excluded_count?: number; coverage?: { partial: boolean; reason: 'native_effects_only' } }
export function nativeReportCoverageText(report: NativeReportCoverage | null): string | null {
  return report?.origin === 'brufap' && (report.mirror_excluded_count ?? 0) > 0
    ? `Relatório de registros do FAGOO; ${report.mirror_excluded_count!.toLocaleString('pt-BR')} documentos Origin não entram neste cálculo. Consulte-os nas listas com origem Origin.` : null;
}
export const nativeIndicatorCoverageText = (report: NativeReportCoverage | null) => nativeReportCoverageText(report)?.replace('Relatório de registros do FAGOO', 'Indicadores operacionais do FAGOO') ?? null;
export function readNativeReportCoverage(value: Record<string, unknown>): NativeReportCoverage {
  if (value.origin !== 'brufap' || !Number.isSafeInteger(value.mirror_excluded_count) || (value.mirror_excluded_count as number) < 0) return {};
  return { origin: 'brufap', mirror_excluded_count: value.mirror_excluded_count as number, coverage: { partial: (value.mirror_excluded_count as number) > 0, reason: 'native_effects_only' } };
}
