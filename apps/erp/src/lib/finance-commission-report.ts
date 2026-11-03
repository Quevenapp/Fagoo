// Vendas › Relatórios › Comissões: Relatório complementar de comissões (leva H, SQL 370). Operações confirmadas no período, com a
// regra, a base e o percentual congelados na confirmação comercial, e por vendedor: estimada, ajustada, elegível e paga.
// Valores sempre em centavos de texto; nenhuma conta passa por Number.
import { COMMISSION_RULE_LABELS, type CommissionOperation } from './document-commissions.ts';

export type CommissionReportState = 'all' | 'active' | 'cancelled';
export const COMMISSION_REPORT_STATES: readonly { id: CommissionReportState; label: string }[] = [{ id: 'all', label: 'Todas' }, { id: 'active', label: 'Ativas' }, { id: 'cancelled', label: 'Canceladas' }];
export type CommissionReportRoute = { de: string; ate: string; situacao: CommissionReportState; vendedor: string | null; page: number };
export type CommissionReportSums = { estimated_cents: string; adjusted_cents: string; eligible_cents: string; paid_cents: string };
export type CommissionReportItem = CommissionOperation & { kind: 'sales_orders' | 'service_orders'; seller_id: string; document_number: string; document_date: string | null; contact_name: string; seller_name: string };
export type CommissionReport = { total: number; items: CommissionReportItem[]; sellers: (CommissionReportSums & { seller_id: string; name: string; operations: number })[]; totals: CommissionReportSums };
export const COMMISSION_REPORT_PAGE = 100;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, DAY = /^\d{4}-\d{2}-\d{2}$/, UNSIGNED = /^\d{1,15}$/, SIGNED = /^-?\d{1,15}$/;
const broken = (): never => { throw new Error('Não foi possível conferir o relatório de comissões. Tente novamente.'); };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const validDay = (value: string) => DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/** URL: de e ate (padrão: o mês corrente até hoje), situacao, vendedor, pagina. Unknown or repeated keys are refused. */
export function commissionReportRoute(params: URLSearchParams, today: string): CommissionReportRoute {
  for (const key of params.keys()) if (!['area', 'de', 'ate', 'situacao', 'vendedor', 'pagina'].includes(key) || params.getAll(key).length !== 1) throw new Error('Filtros inválidos no endereço.');
  const de = params.get('de') ?? `${today.slice(0, 7)}-01`, ate = params.get('ate') ?? today, situacao = params.get('situacao') ?? 'all', vendedor = params.get('vendedor'), page = params.get('pagina') ?? '1';
  if (!validDay(de) || !validDay(ate) || de > ate || Date.parse(ate) - Date.parse(de) > 366 * 86400000) throw new Error('Informe um período de até um ano.');
  if (!COMMISSION_REPORT_STATES.some(item => item.id === situacao) || (vendedor !== null && !UUID.test(vendedor)) || !/^[1-9]\d{0,5}$/.test(page)) throw new Error('Filtros inválidos no endereço.');
  return { de, ate, situacao: situacao as CommissionReportState, vendedor, page: Number(page) };
}
export function commissionReportParams(route: CommissionReportRoute) {
  const params = new URLSearchParams({ area: 'comissoes-relatorio', de: route.de, ate: route.ate });
  if (route.situacao !== 'all') params.set('situacao', route.situacao);
  if (route.vendedor) params.set('vendedor', route.vendedor);
  if (route.page > 1) params.set('pagina', String(route.page));
  return params;
}
export function commissionReportPath(route: CommissionReportRoute) {
  const params = new URLSearchParams({ from: route.de, to: route.ate });
  if (route.vendedor) params.set('vendedor', route.vendedor);
  if (route.situacao !== 'all') params.set('state', route.situacao);
  if (route.page > 1) params.set('page', String(route.page));
  params.set('limit', String(COMMISSION_REPORT_PAGE));
  return `/v1/financeiro/comissoes-relatorio?${params}`;
}
const sums = (value: unknown): CommissionReportSums => {
  if (!object(value) || !UNSIGNED.test(String(value.estimated_cents)) || !SIGNED.test(String(value.adjusted_cents)) || !UNSIGNED.test(String(value.eligible_cents)) || !UNSIGNED.test(String(value.paid_cents))) broken();
  const v = value as CommissionReportSums;
  return { estimated_cents: v.estimated_cents, adjusted_cents: v.adjusted_cents, eligible_cents: v.eligible_cents, paid_cents: v.paid_cents };
};
export function commissionReport(value: unknown, route: CommissionReportRoute): CommissionReport {
  if (!object(value) || value.entity !== 'commission_report' || value.from !== route.de || value.to !== route.ate || !Number.isSafeInteger(value.total) || !Array.isArray(value.items) || !Array.isArray(value.sellers)) broken();
  const v = value as unknown as CommissionReport;
  const items = v.items.map(item => {
    if (!object(item) || !UUID.test(String(item.id)) || !(item.rule in COMMISSION_RULE_LABELS) || !['active', 'cancelled'].includes(item.state) || !/^\d{1,3}\.\d{4}$/.test(String(item.rate))
      || !UNSIGNED.test(String(item.base_cents)) || !UNSIGNED.test(String(item.estimated_cents)) || !SIGNED.test(String(item.adjusted_cents)) || !UNSIGNED.test(String(item.eligible_cents))
      || !UNSIGNED.test(String(item.received_cents)) || !UNSIGNED.test(String(item.total_cents)) || !/^[1-9]\d{0,9}$/.test(String(item.document_number)) || typeof item.seller_name !== 'string') broken();
    return item;
  });
  return { total: v.total, items, sellers: v.sellers.map(item => { if (!object(item) || !UUID.test(String(item.seller_id)) || typeof item.name !== 'string') broken(); return { ...sums(item), seller_id: item.seller_id, name: item.name, operations: item.operations }; }), totals: sums(v.totals) };
}
