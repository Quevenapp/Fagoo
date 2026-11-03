// Financeiro > Controle de caixa (SQL 173): rota (?area=controle-caixa), caminhos do Worker e leitura conferida das respostas.
export const CASH_CONTROL_PAGE_SIZE = 100;
export type CashControlState = 'all' | 'open' | 'closed' | 'checked';
export const CASH_CONTROL_STATES: readonly { id: CashControlState; label: string }[] = [{ id: 'all', label: 'Todos' }, { id: 'open', label: 'Abertos' }, { id: 'closed', label: 'Fechados' }, { id: 'checked', label: 'Conferidos' }];
export type CashControlRoute = { situacao: CashControlState; todos: boolean; q: string; from: string; to: string; page: number; caixa: string | null };
export type CashSession = { id: string; account_id: string; account_name: string; operator_id: string; operator_name: string; opened_at: string; opened_on: string; previous_change_cents: string; change_cents: string;
  state: 'open' | 'closed'; closed_by_name: string | null; closed_at: string | null; checked: boolean; supply_cents: string; withdrawal_cents: string; expected_cash_cents: string; informed_cents: string; version: number; created_at: string;
  values?: { payment_method_id: string; payment_method_name: string; amount_cents: string }[]; methods?: { payment_method_id: string; name: string; registered_cents: string; informed_cents: string; difference_cents: string }[];
  moves?: { id: string; kind: 'withdrawal' | 'supply'; posted_on: string; note: string | null; amount_cents: string; created_at: string }[] };
export type CashSessionPage = { total: number; items: CashSession[] };

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, DAY = /^\d{4}-\d{2}-\d{2}$/, CENTS = /^\d{1,30}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const broken: () => never = () => { throw new Error('Não foi possível conferir o controle de caixa. Tente novamente.'); };

export function cashControlRoute(params: URLSearchParams): CashControlRoute {
  for (const key of params.keys()) if (!['area', 'situacao', 'todos', 'q', 'from', 'to', 'pagina', 'caixa'].includes(key) || params.getAll(key).length !== 1) throw new Error('Filtros inválidos no endereço.');
  const situacao = params.get('situacao') ?? 'all', todos = params.get('todos'), q = params.get('q') ?? '', from = params.get('from') ?? '', to = params.get('to') ?? '', page = params.get('pagina') ?? '1', caixa = params.get('caixa');
  if (!CASH_CONTROL_STATES.some(item => item.id === situacao) || (todos !== null && todos !== '1') || q.length > 120 || /[\x00-\x1f\x7f]/.test(q) || (from && !DAY.test(from)) || (to && !DAY.test(to)) || (from && to && from > to)
    || !/^[1-9]\d{0,5}$/.test(page) || (caixa !== null && !UUID.test(caixa))) throw new Error('Filtros inválidos no endereço.');
  return { situacao: situacao as CashControlState, todos: todos === '1', q, from, to, page: Number(page), caixa };
}
export function cashControlParams(route: CashControlRoute) {
  const params = new URLSearchParams({ area: 'controle-caixa' });
  if (route.situacao !== 'all') params.set('situacao', route.situacao); if (route.todos) params.set('todos', '1'); if (route.q) params.set('q', route.q);
  if (route.from) params.set('from', route.from); if (route.to) params.set('to', route.to); if (route.page > 1) params.set('pagina', String(route.page)); if (route.caixa) params.set('caixa', route.caixa);
  return params;
}
export function cashControlApiPath(route: CashControlRoute) {
  if (route.caixa) return `/v1/financeiro/controle-caixa/${route.caixa}`;
  const params = new URLSearchParams();
  if (route.situacao !== 'all') params.set('state', route.situacao); if (route.todos) params.set('all', 'true'); if (route.q) params.set('q', route.q);
  if (route.from) params.set('from', route.from); if (route.to) params.set('to', route.to); if (route.page > 1) params.set('page', String(route.page));
  return `/v1/financeiro/controle-caixa${params.size ? `?${params}` : ''}`;
}
export function cashSession(value: unknown, lines: boolean): CashSession {
  if (!object(value) || typeof value.id !== 'string' || !UUID.test(value.id) || typeof value.account_name !== 'string' || typeof value.operator_name !== 'string' || !['open', 'closed'].includes(value.state as string)
    || typeof value.change_cents !== 'string' || !CENTS.test(value.change_cents) || typeof value.expected_cash_cents !== 'string' || typeof value.informed_cents !== 'string' || typeof value.checked !== 'boolean' || !Number.isSafeInteger(value.version)) return broken();
  if (lines && (!Array.isArray(value.values) || !Array.isArray(value.methods) || !Array.isArray(value.moves))) return broken();
  return value as unknown as CashSession;
}
export function cashSessionPage(value: unknown, route: CashControlRoute): CashSessionPage {
  if (!object(value) || value.entity !== 'cash_sessions' || value.data_mode !== 'erp_native' || value.state !== route.situacao || value.all !== route.todos || value.page !== route.page || !Number.isSafeInteger(value.total)
    || !Array.isArray(value.items) || value.items.length !== Math.max(0, Math.min(CASH_CONTROL_PAGE_SIZE, (value.total as number) - (route.page - 1) * CASH_CONTROL_PAGE_SIZE))) return broken();
  return { total: value.total as number, items: (value.items as unknown[]).map(item => cashSession(item, false)) };
}
export function cashSessionRead(value: unknown, id: string): CashSession {
  if (!object(value) || value.entity !== 'cash_sessions' || value.data_mode !== 'erp_native') return broken();
  const record = cashSession(value.record, true); if (record.id !== id) return broken(); return record;
}
export function cashSessionResult(value: unknown, action: string): Record<string, unknown> {
  if (!object(value) || value.action !== action || value.entity !== 'cash_sessions' || value.data_mode !== 'erp_native' || typeof value.replayed !== 'boolean' || !object(value.record)) return broken();
  return value.record;
}
