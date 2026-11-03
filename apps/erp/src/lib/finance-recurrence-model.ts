// Contas recorrentes do Origin (SQL 138): leitura estrita da listagem e da recorrência, a rota ?area=recorrentes e o que
// "Gerar contas" pode fazer com cada uma. A agenda (próximo vencimento, dias úteis, data limite) é sempre a do servidor.
import type { FinanceKind } from './real-finance-model.ts';

// SQL 172: Parcelada ('installments') generates until the nº de parcelas, as in Origin.
export type Frequency = 'weekly' | 'biweekly' | 'monthly' | 'bimonthly' | 'quarterly' | 'semiannual' | 'annual' | 'installments';
export const FREQUENCY_LABEL: Readonly<Record<Frequency, string>> = { weekly: 'Semanal', biweekly: 'Quinzenal', monthly: 'Mensal', bimonthly: 'Bimestral', quarterly: 'Trimestral', semiannual: 'Semestral', annual: 'Anual', installments: 'Parcelada' };
const WEEKDAY_NAMES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
export const RECURRENCE_PAGE_SIZE = 100;
export type RecurrenceSituation = 'ativas' | 'inativas' | 'todas';
export const RECURRENCE_SITUATIONS: readonly { id: RecurrenceSituation; label: string }[] = [{ id: 'todas', label: 'Todas' }, { id: 'ativas', label: 'Ativas' }, { id: 'inativas', label: 'Inativas' }];
export interface Recurrence {
  id: string; kind: FinanceKind; contact_id: string; contact_name: string; category_id: string | null; category_name: string | null; account_id: string | null; description: string;
  amount_cents: string; frequency: Frequency; due_day: number | null; second_day: number | null; weekday: number | null; business_days: boolean; end_on: string | null; next_on: string | null;
  generated: number; active: boolean; open_titles: number; version: number; created_at: string;
  /** Parcelada: o nº de parcelas (null for the other frequencies and for readers before SQL 172). */
  installments: number | null;
}
export interface RecurrencePage { kind: FinanceKind; active: boolean | null; page: number; limit: number; total: number; items: Recurrence[] }
export interface RecurrenceRoute { kind: FinanceKind; situacao: RecurrenceSituation; q: string; page: number }

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (): never => { throw new Error('Não foi possível conferir as contas recorrentes. Atualize a página.'); };
const routeFail = (): never => { throw new Error('O endereço tem filtros de contas recorrentes inválidos.'); };
const integer = (value: unknown, min: number, max: number) => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const nullable = <T>(value: unknown, check: (item: unknown) => boolean): value is T | null => value === null || check(value);

/** ?area=recorrentes&tipo=R|P&situacao=…&q=…&pagina=… (Origin: contas.recorrentes.php?receberpagar=P). */
export function recurrenceRoute(params: URLSearchParams): RecurrenceRoute {
  for (const key of params.keys()) if (!['area', 'tipo', 'situacao', 'q', 'pagina'].includes(key) || params.getAll(key).length !== 1) routeFail();
  const tipo = params.get('tipo') ?? 'R', situacao = params.get('situacao') ?? 'ativas', q = params.get('q') ?? '', page = params.get('pagina') ?? '1';
  if (!['R', 'P'].includes(tipo) || !RECURRENCE_SITUATIONS.some(item => item.id === situacao) || q.length > 120 || /[\x00-\x1f\x7f]/.test(q) || !/^[1-9]\d{0,5}$/.test(page)) routeFail();
  return { kind: tipo === 'P' ? 'payable' : 'receivable', situacao: situacao as RecurrenceSituation, q: q.trim(), page: Number(page) };
}
export function recurrenceParams(route: RecurrenceRoute): URLSearchParams {
  const params = new URLSearchParams({ area: 'recorrentes', tipo: route.kind === 'payable' ? 'P' : 'R' });
  if (route.situacao !== 'ativas') params.set('situacao', route.situacao);
  if (route.q) params.set('q', route.q);
  if (route.page > 1) params.set('pagina', String(route.page));
  return params;
}
export const recurrencePath = (kind: FinanceKind) => `/financeiro-empresa?${recurrenceParams({ kind, situacao: 'ativas', q: '', page: 1 })}`;
export function recurrenceApiPath(route: RecurrenceRoute): string {
  const params = new URLSearchParams({ kind: route.kind, situacao: route.situacao, page: String(route.page), limit: String(RECURRENCE_PAGE_SIZE) });
  if (route.q) params.set('q', route.q);
  return `/v1/financeiro/recorrentes?${params}`;
}

export function recurrence(value: unknown): Recurrence {
  if (!object(value) || typeof value.id !== 'string' || !UUID.test(value.id) || !['receivable', 'payable'].includes(String(value.kind)) || typeof value.contact_id !== 'string' || !UUID.test(value.contact_id)
    || typeof value.contact_name !== 'string' || !nullable(value.category_id, item => typeof item === 'string' && UUID.test(item)) || !nullable(value.category_name, item => typeof item === 'string')
    || !nullable(value.account_id, item => typeof item === 'string' && UUID.test(item)) || typeof value.description !== 'string' || typeof value.amount_cents !== 'string' || !/^[1-9]\d{0,14}$/.test(value.amount_cents)
    || !Object.hasOwn(FREQUENCY_LABEL, String(value.frequency)) || !nullable(value.due_day, item => integer(item, 1, 31)) || !nullable(value.second_day, item => integer(item, 1, 31)) || !nullable(value.weekday, item => integer(item, 0, 6))
    || typeof value.business_days !== 'boolean' || !nullable(value.end_on, item => typeof item === 'string' && DAY.test(item)) || !nullable(value.next_on, item => typeof item === 'string' && DAY.test(item))
    || !integer(value.generated, 1, Number.MAX_SAFE_INTEGER) || typeof value.active !== 'boolean' || !integer(value.open_titles, 0, Number.MAX_SAFE_INTEGER) || !integer(value.version, 1, 2147483647) || typeof value.created_at !== 'string'
    || (value.frequency === 'weekly') !== (value.weekday !== null) || (value.frequency === 'biweekly') !== (value.second_day !== null) || (!value.active && value.next_on !== null)
    || !nullable(value.installments ?? null, item => integer(item, 2, 120)) || (value.frequency === 'installments') !== Number.isInteger(value.installments)) fail();
  const v = value as Record<string, unknown>;
  return { id: v.id as string, kind: v.kind as FinanceKind, contact_id: v.contact_id as string, contact_name: v.contact_name as string, category_id: v.category_id as string | null, category_name: v.category_name as string | null,
    account_id: v.account_id as string | null, description: v.description as string, amount_cents: v.amount_cents as string, frequency: v.frequency as Frequency, due_day: v.due_day as number | null, second_day: v.second_day as number | null,
    weekday: v.weekday as number | null, business_days: v.business_days as boolean, end_on: v.end_on as string | null, next_on: v.next_on as string | null, generated: v.generated as number, active: v.active as boolean,
    open_titles: v.open_titles as number, version: v.version as number, created_at: v.created_at as string, installments: (v.installments as number | null | undefined) ?? null };
}
/** The numbered page must be the one requested, of the tab and the Situação chosen. */
export function recurrencePage(value: unknown, route: RecurrenceRoute): RecurrencePage {
  const active = route.situacao === 'todas' ? null : route.situacao === 'ativas';
  if (!object(value) || value.entity !== 'recurrences' || value.data_mode !== 'erp_native' || value.kind !== route.kind || value.active !== active || value.page !== route.page || value.limit !== RECURRENCE_PAGE_SIZE
    || !integer(value.total, 0, Number.MAX_SAFE_INTEGER) || !Array.isArray(value.items) || value.items.length !== Math.max(0, Math.min(RECURRENCE_PAGE_SIZE, (value.total as number) - (route.page - 1) * RECURRENCE_PAGE_SIZE))) fail();
  const seen = new Set<string>();
  const items = ((value as Record<string, unknown>).items as unknown[]).map(item => { const record = recurrence(item); if (seen.has(record.id) || record.kind !== route.kind || (active !== null && record.active !== active)) fail(); seen.add(record.id); return record; });
  return { kind: route.kind, active, page: route.page, limit: RECURRENCE_PAGE_SIZE, total: (value as Record<string, unknown>).total as number, items };
}
/** GET /v1/financeiro/recorrentes/{id}: the version an "Alterar contas em aberto" must send. */
export function recurrenceRead(value: unknown, id: string): Recurrence {
  if (!object(value) || value.entity !== 'recurrences' || value.data_mode !== 'erp_native') fail();
  const record = recurrence((value as Record<string, unknown>).record); if (record.id !== id) fail();
  return record;
}
/** Result of recurrence_generate / recurrence_set_active / recurrence_update for this recurrence. */
export function recurrenceResult(value: unknown, action: string, id: string): Recurrence {
  if (!object(value) || value.action !== action || value.entity !== 'recurrences' || typeof value.replayed !== 'boolean') fail();
  const record = recurrence((value as Record<string, unknown>).record); if (record.id !== id) fail();
  return record;
}

/** "Mensal · dia 10", "Quinzenal · dias 5 e 20", "Semanal · segunda", with "dias úteis" and the data limite. */
export function recurrenceSchedule(record: Pick<Recurrence, 'frequency' | 'due_day' | 'second_day' | 'weekday' | 'business_days' | 'end_on'> & { installments?: number | null; generated?: number }, date: (day: string) => string): string {
  if (record.frequency === 'installments') return [FREQUENCY_LABEL.installments, `dia ${record.due_day}`, record.generated ? `${record.generated} de ${record.installments} parcelas` : `${record.installments} parcelas`, record.business_days ? 'dias úteis' : null].filter(Boolean).join(' · ');
  const days = record.frequency === 'weekly' ? WEEKDAY_NAMES[record.weekday ?? 0] : record.frequency === 'biweekly' ? `dias ${Math.min(record.due_day!, record.second_day!)} e ${Math.max(record.due_day!, record.second_day!)}` : `dia ${record.due_day}`;
  return [FREQUENCY_LABEL[record.frequency], days, record.business_days ? 'dias úteis' : null, record.end_on ? `até ${date(record.end_on)}` : null].filter(Boolean).join(' · ');
}
/** Why "Gerar contas" skips a recurrence; null when the next conta can be generated. */
export function generateSkip(record: Pick<Recurrence, 'active' | 'next_on' | 'end_on'> & { frequency?: Frequency }): string | null {
  if (!record.active) return 'Recorrência inativa.';
  if (record.frequency === 'installments' && !record.next_on) return 'Todas as parcelas já foram geradas.';
  if (!record.next_on || (record.end_on && record.next_on > record.end_on)) return 'A data limite da recorrência foi atingida.';
  return null;
}
