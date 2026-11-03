// Relatórios de Notas Fiscais of the Relatórios de vendas (leva H, SQL 362): ICMS DIFAL (VND-265) and por Operação, por Cliente,
// por Produto and Evolução do Faturamento (VND-266), over the real notes (imported XMLs and the Origin mirror). The Worker checks
// every field; this file builds the query, pairs the answer with the request and formats coverage, origin and the chart.
// A value the notes do not bring is null and is shown as "Indisponível", never as zero.
import { addDays } from './origin-list.ts';

export type FiscalReportId = 'nf-difal' | 'nf-operacao' | 'nf-cliente' | 'nf-produto' | 'nf-evolucao';
type Server = 'difal' | 'operation' | 'contact' | 'product' | 'billing';
const PATHS: Record<FiscalReportId, { segment: string; report: Server }> = {
  'nf-difal': { segment: 'difal', report: 'difal' }, 'nf-operacao': { segment: 'operacao', report: 'operation' }, 'nf-cliente': { segment: 'cliente', report: 'contact' },
  'nf-produto': { segment: 'produto', report: 'product' }, 'nf-evolucao': { segment: 'evolucao', report: 'billing' },
};
export const FISCAL_REPORT_TITLES: Record<FiscalReportId, string> = { 'nf-difal': 'Notas Fiscais ICMS DIFAL', 'nf-operacao': 'Notas Fiscais por Operação', 'nf-cliente': 'Notas Fiscais por Cliente', 'nf-produto': 'Notas Fiscais por Produto', 'nf-evolucao': 'Evolução do Faturamento' };
export const isFiscalReport = (value: string | null): value is FiscalReportId => value !== null && Object.hasOwn(PATHS, value);
/** What the coverage of each report counts. */
export const COVERAGE_LABELS: Record<FiscalReportId, string> = { 'nf-difal': 'notas com detalhamento do DIFAL (XML autorizado)', 'nf-operacao': 'notas com natureza de operação identificada',
  'nf-cliente': 'notas com cliente identificado', 'nf-produto': 'notas com itens', 'nf-evolucao': 'notas com valor' };
export const GROUP_HEADERS: Record<Exclude<FiscalReportId, 'nf-difal'>, string> = { 'nf-operacao': 'Natureza de operação', 'nf-cliente': 'Cliente', 'nf-produto': 'Produto', 'nf-evolucao': 'Mês' };
export const EMPTY_LABELS: Record<Exclude<FiscalReportId, 'nf-difal'>, string> = { 'nf-operacao': 'Sem natureza informada', 'nf-cliente': 'Cliente não identificado', 'nf-produto': 'Item sem descrição', 'nf-evolucao': '' };
export const FISCAL_UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'EX', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'] as const;
export interface FiscalReportParams { from: string; to: string; state: string; model: '' | '55' | '65' }
const DATE = /^(19|20)\d{2}-\d{2}-\d{2}$/;
const validDay = (value: string) => DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export const maxDays = (id: FiscalReportId) => id === 'nf-evolucao' ? 731 : 366;
/** The Evolução opens on the last 12 months; the other reports on the month of `today`. */
export function defaultFiscalParams(id: FiscalReportId, today: string): FiscalReportParams {
  const [year, month] = today.split('-').map(Number) as [number, number];
  const first = `${year}-${String(month).padStart(2, '0')}-01`, next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const yearAgo = `${month === 12 ? year : year - 1}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-01`;
  return { from: id === 'nf-evolucao' ? yearAgo : first, to: id === 'nf-evolucao' ? today : addDays(next, -1), state: '', model: '' };
}
/** GET /v1/documentos/sales_orders/notas-fiscais/<relatório>; throws a user message for an invalid choice. */
export function fiscalReportPath(id: FiscalReportId, params: FiscalReportParams): string {
  if (!validDay(params.from) || !validDay(params.to)) throw new Error('Informe o período do relatório.');
  if (params.from > params.to) throw new Error('A data inicial deve ser anterior ou igual à data final.');
  if ((Date.parse(`${params.to}T00:00:00Z`) - Date.parse(`${params.from}T00:00:00Z`)) / 86_400_000 > maxDays(id)) throw new Error(id === 'nf-evolucao' ? 'Escolha um período de até dois anos.' : 'Escolha um período de até um ano.');
  const query = new URLSearchParams({ from: params.from, to: params.to });
  if (id === 'nf-difal') { if (params.state) { if (params.state !== 'SEM' && !(FISCAL_UFS as readonly string[]).includes(params.state)) throw new Error('Escolha uma UF.'); query.set('state', params.state); } }
  else if (params.model) query.set('model', params.model);
  return `/v1/documentos/sales_orders/notas-fiscais/${PATHS[id].segment}?${query}`;
}
export interface FiscalReportSources { xml_notes: number; origin_notes: number; xml_imported_at: string | null; origin_synced_at: string | null }
export interface FiscalCoverage { notes: number; covered: number }
export interface DifalGroup { state: string | null; notes: number; detailed: number; without_detail: number; amount: string | null; dest: string | null; remet: string | null; fcp: string | null }
export interface DifalRow { origin: 'xml' | 'origin'; ref: string; number: number | null; series: number | null; issue_date: string; contact_name: string | null; state: string | null; amount: string | null; detail: boolean; dest: string | null; remet: string | null; fcp: string | null }
export interface DifalReport { report: 'difal'; from: string; to: string; state: string | null; groups: DifalGroup[]; group_count: number; rows: DifalRow[]; row_count: number; truncated: boolean;
  totals: { notes: number; detailed: number; amount: string | null; dest: string | null; remet: string | null; fcp: string | null }; coverage: FiscalCoverage; sources: FiscalReportSources }
export interface InvoiceGroup { key: string; label: string | null; document: string | null; notes: number; amount: string | null; quantity: string | null; xml_notes: number; origin_notes: number }
export interface InvoiceReport { report: Exclude<Server, 'difal'>; from: string; to: string; model: '55' | '65' | null; groups: InvoiceGroup[]; group_count: number; truncated: boolean;
  totals: { notes: number; amount: string | null }; coverage: FiscalCoverage; sources: FiscalReportSources }
export type FiscalReport = DifalReport | InvoiceReport;
/** Pairs the answer with the request it belongs to (the Worker has already checked each field). */
export function readFiscalReport(value: unknown, id: FiscalReportId, params: FiscalReportParams): FiscalReport {
  const result = value as FiscalReport | null;
  const ok = !!result && typeof result === 'object' && result.report === PATHS[id].report && result.from === params.from && result.to === params.to
    && Array.isArray(result.groups) && !!result.coverage && !!result.sources && !!result.totals
    && (result.report === 'difal' ? (result as DifalReport).state === (params.state || null) && Array.isArray((result as DifalReport).rows) : (result as InvoiceReport).model === (params.model || null));
  if (!ok) throw new Error('REPORT_INVALID');
  return result;
}
/** "3 de 5 notas (60%)". */
export function coverageText(coverage: FiscalCoverage): string {
  if (!coverage.notes) return 'Nenhuma nota no período.';
  const percent = Math.floor(coverage.covered * 1000 / coverage.notes) / 10;
  return `${coverage.covered.toLocaleString('pt-BR')} de ${coverage.notes.toLocaleString('pt-BR')} ${coverage.notes === 1 ? 'nota' : 'notas'} (${percent.toLocaleString('pt-BR')}%)`;
}
const moment = (value: string) => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; };
/** Origem: XML importado and espelho do Origin, with the last import and the last sync of the Origin notes. */
export function sourcesText(sources: FiscalReportSources): string[] {
  return [`${sources.xml_notes.toLocaleString('pt-BR')} ${sources.xml_notes === 1 ? 'nota' : 'notas'} de XML importado${sources.xml_imported_at ? ` (última importação em ${moment(sources.xml_imported_at)})` : ''}`,
    `${sources.origin_notes.toLocaleString('pt-BR')} ${sources.origin_notes === 1 ? 'nota' : 'notas'} do espelho do Origin${sources.origin_synced_at ? ` (sincronizado em ${moment(sources.origin_synced_at)})` : ' (sem sincronização registrada)'}`];
}
/** Bar widths (0 to 100) of the Evolução, by exact cents; a month without value has no bar. */
export function barWidths(groups: readonly InvoiceGroup[]): (number | null)[] {
  const cents = groups.map(group => group.amount === null ? null : BigInt(group.amount.replace('.', '').replace(/^-/, '')));
  const max = cents.reduce<bigint>((top, value) => value !== null && value > top ? value : top, 0n);
  return cents.map(value => value === null ? null : max === 0n ? 0 : Number(value * 1000n / max) / 10);
}
export const originLabel = (origin: 'xml' | 'origin') => origin === 'xml' ? 'XML importado' : 'Espelho do Origin';
