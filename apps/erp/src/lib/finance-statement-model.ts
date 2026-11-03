// Caixas e bancos (extrato) e Ficha financeira do Origin (SQL 136): rotas, leitura conferida das respostas, linhas de
// saldo intercaladas, planos dos lotes e exportação. Centavos sempre como texto e BigInt, nunca ponto flutuante.
import { financeDate, financeMoney } from './real-finance-model.ts';
import { presetRange } from './origin-list.ts';
import { planBatch, type BatchItem, type BatchPlan } from './origin-batch.ts';
import type { SheetCell } from './spreadsheet-export.ts';
import { numberCell, textCell } from './spreadsheet-export.ts';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message: string): never => { throw new Error(message); };

export type StatementTab = 'movimentacoes' | 'entradas' | 'saidas';
export const STATEMENT_TABS: readonly { id: StatementTab | 'conciliacao'; label: string }[] = [{ id: 'movimentacoes', label: 'Movimentações' }, { id: 'entradas', label: 'Entradas' }, { id: 'saidas', label: 'Saídas' }, { id: 'conciliacao', label: 'Conciliação' }];
export const API_TAB: Readonly<Record<StatementTab, 'all' | 'in' | 'out'>> = { movimentacoes: 'all', entradas: 'in', saidas: 'out' };
export type ReconciliationFilter = '' | 'conciliados' | 'nao-conciliados';
export interface StatementRoute { conta: string; from: string; to: string; aba: StatementTab; situacao: 'registrados' | 'excluidos' | 'cancelados'; conciliacao: ReconciliationFilter; categoria: string[]; valor: string; q: string; ordem: 'asc' | 'desc'; pagina: number }
export const STATEMENT_PAGE_SIZE = 100;
const validDay = (value: string) => DAY.test(value) && value >= '1900-01-01' && value <= '2100-12-31' && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/** URL of Caixas e bancos: Todas contas, período padrão Este mês, aba Movimentações, Situação Registrados. */
export function statementRoute(params: URLSearchParams, today: string): StatementRoute {
  const month = presetRange('este-mes', today), bad = () => fail('Filtros inválidos no endereço.');
  const conta = params.get('conta') ?? '', from = params.get('from') ?? month.from, to = params.get('to') ?? month.to, aba = params.get('aba') ?? 'movimentacoes';
  const situacao = params.get('situacao') ?? 'registrados', conciliacao = params.get('conciliacao') ?? '', categoria = params.get('categoria'), valor = params.get('valor') ?? '', q = params.get('q') ?? '', ordem = params.get('ordem') ?? 'asc', pagina = params.get('pagina') ?? '1';
  if ((conta && !UUID.test(conta)) || !validDay(from) || !validDay(to) || from > to || !['movimentacoes', 'entradas', 'saidas'].includes(aba) || !['registrados', 'excluidos', 'cancelados'].includes(situacao)
    || !['', 'conciliados', 'nao-conciliados'].includes(conciliacao) || (conciliacao && situacao !== 'registrados') || (valor && !/^[1-9]\d{0,14}$/.test(valor)) || q.length > 120 || /[\x00-\x1f\x7f]/.test(q) || !['asc', 'desc'].includes(ordem) || !/^[1-9]\d{0,5}$/.test(pagina)) bad();
  const categories = categoria ? categoria.split(',') : [];
  if (categories.length > 200 || categories.some(value => value !== 'none' && !UUID.test(value)) || new Set(categories).size !== categories.length) bad();
  return { conta, from, to, aba: aba as StatementTab, situacao: situacao as StatementRoute['situacao'], conciliacao: conciliacao as ReconciliationFilter, categoria: categories, valor, q, ordem: ordem as 'asc' | 'desc', pagina: Number(pagina) };
}
export function statementParams(route: StatementRoute, today: string): URLSearchParams {
  const month = presetRange('este-mes', today), params = new URLSearchParams({ area: 'accounts' });
  if (route.conta) params.set('conta', route.conta); if (route.from !== month.from || route.to !== month.to) { params.set('from', route.from); params.set('to', route.to); }
  if (route.aba !== 'movimentacoes') params.set('aba', route.aba); if (route.situacao !== 'registrados') params.set('situacao', route.situacao); if (route.conciliacao) params.set('conciliacao', route.conciliacao);
  if (route.categoria.length) params.set('categoria', route.categoria.join(',')); if (route.valor) params.set('valor', route.valor); if (route.q) params.set('q', route.q);
  if (route.ordem !== 'asc') params.set('ordem', route.ordem); if (route.pagina > 1) params.set('pagina', String(route.pagina));
  return params;
}
export function statementApiPath(route: StatementRoute, limit = STATEMENT_PAGE_SIZE, page = route.pagina): string {
  const params = new URLSearchParams();
  if (route.conta) params.set('account', route.conta); params.set('from', route.from); params.set('to', route.to); params.set('tab', API_TAB[route.aba]);
  params.set('deleted', String(route.situacao === 'excluidos')); if (route.categoria.length) params.set('category', route.categoria.join(','));
  // SQL 246: Cancelados (baixas estornadas and their estornos), sent only when chosen.
  if (route.situacao === 'cancelados') params.set('cancelled', 'true');
  if (route.valor) params.set('amount_cents', route.valor); if (route.q.trim()) params.set('q', route.q.trim()); params.set('order', route.ordem); params.set('page', String(page)); params.set('limit', String(limit));
  if (route.conciliacao) params.set('reconciliation', route.conciliacao === 'conciliados' ? 'reconciled' : 'unreconciled');
  return `/v1/financeiro/extrato?${params}`;
}

export type LineKind = 'entry' | 'transfer' | 'settlement' | 'opening';
export interface StatementLine { line_id: string; line_kind: LineKind; posted_on: string; competence_on: string | null; account_id: string; account_name: string; amount_cents: string; category_id: string | null; category_name: string | null;
  contact_id: string | null; contact_name: string | null; note: string | null; title_id: string | null; title_kind: 'receivable' | 'payable' | null; document: { kind: string; number: string; source?: 'origin' } | null; transfer_id: string | null;
  entry_id: string | null; entry_version: number | null; entry_origin: string | null; reconciled?: boolean }
export interface StatementPage { items: StatementLine[]; total: number; page: number; day_balances: Record<string, string>; summary: { before_cents: string; previous_cents: string; in_cents: string; out_cents: string; closing_cents: string; current_cents: string; reconciled_lines?: number } }
const SIGNED = /^-?\d{1,30}$/;
export function statementPage(value: unknown, route: StatementRoute, page = route.pagina, limit = STATEMENT_PAGE_SIZE): StatementPage {
  const failure = 'Não foi possível conferir o extrato.';
  if (!object(value) || value.entity !== 'statement' || value.account_id !== (route.conta || null) || value.from !== route.from || value.to !== route.to || value.tab !== API_TAB[route.aba]
    || value.deleted !== (route.situacao === 'excluidos') || (value.cancelled ?? false) !== (route.situacao === 'cancelados') || value.page !== page || value.limit !== limit || !Number.isSafeInteger(value.total) || !Array.isArray(value.items) || !object(value.day_balances) || !object(value.summary)) fail(failure);
  const raw = value as { items: unknown[]; total: number; day_balances: Record<string, unknown>; summary: Record<string, unknown> };
  for (const key of ['before_cents', 'previous_cents', 'in_cents', 'out_cents', 'closing_cents', 'current_cents']) if (typeof raw.summary[key] !== 'string' || !SIGNED.test(raw.summary[key] as string)) fail(failure);
  const items = raw.items.map(item => {
    if (!object(item) || !UUID.test(String(item.line_id)) || !['entry', 'transfer', 'settlement', 'opening'].includes(String(item.line_kind)) || typeof item.posted_on !== 'string' || item.posted_on < route.from || item.posted_on > route.to
      || typeof item.amount_cents !== 'string' || !SIGNED.test(item.amount_cents) || (route.conta && item.account_id !== route.conta)
      || (route.aba === 'entradas' && item.amount_cents.startsWith('-')) || (route.aba === 'saidas' && !item.amount_cents.startsWith('-'))
      || (route.conciliacao && item.reconciled !== (route.conciliacao === 'conciliados')) || (route.situacao === 'cancelados' && item.line_kind !== 'settlement')) fail(failure);
    return item as unknown as StatementLine;
  });
  for (const cents of Object.values(raw.day_balances)) if (typeof cents !== 'string' || !SIGNED.test(cents)) fail(failure);
  return { items, total: raw.total, page, day_balances: raw.day_balances as Record<string, string>, summary: raw.summary as StatementPage['summary'] };
}
export type StatementRow = { type: 'line'; line: StatementLine } | { type: 'balance'; key: string; day: string; cents: string; label: string };
/**
 * Lines with the Origin "Saldo em dd/mm/aaaa" rows: in ascending order the balance before the period opens the first page and
 * each day closes with its balance; in descending order each day starts with its balance and the earlier balance closes the
 * last page. Excluded lines have no balances.
 */
export function statementRows(page: StatementPage, route: StatementRoute, pages: number): StatementRow[] {
  // Excluídos and Cancelados are outside the saldos: their lines have no balance rows.
  if (route.situacao !== 'registrados') return page.items.map(line => ({ type: 'line', line }));
  const rows: StatementRow[] = [], before = { type: 'balance' as const, key: 'before', day: route.from, cents: page.summary.before_cents, label: 'Saldo anterior' };
  const days = [...new Set(page.items.map(line => line.posted_on))];
  if (route.ordem === 'asc') {
    if (page.page === 1) rows.push(before);
    for (const day of days) { for (const line of page.items.filter(item => item.posted_on === day)) rows.push({ type: 'line', line }); rows.push({ type: 'balance', key: `day:${day}`, day, cents: page.day_balances[day] ?? '0', label: `Saldo em ${financeDate(day)}` }); }
  } else {
    for (const day of days) { rows.push({ type: 'balance', key: `day:${day}`, day, cents: page.day_balances[day] ?? '0', label: `Saldo em ${financeDate(day)}` }); for (const line of page.items.filter(item => item.posted_on === day)) rows.push({ type: 'line', line }); }
    if (page.page === pages) rows.push(before);
  }
  return rows;
}
/** Imprimir saldos (FIN-147): the whole period is read in pages of 100, up to 5.000 lines per print. */
export const STATEMENT_PRINT_PAGES = 50;
/** The pages of the period merged into one, so statementRows opens (or closes) with the Saldo anterior and keeps each Saldo em dd/mm/aaaa. */
export function statementPrintPage(pages: readonly StatementPage[]): StatementPage {
  if (!pages.length) fail('Não foi possível conferir o extrato.');
  const items = pages.flatMap(page => page.items), day_balances: Record<string, string> = {};
  for (const page of pages) Object.assign(day_balances, page.day_balances);
  if (items.length !== pages[0].total || new Set(items.map(item => item.line_id)).size !== items.length) fail('O extrato mudou durante a leitura. Feche a prévia e imprima novamente.');
  return { items, total: pages[0].total, page: 1, day_balances, summary: pages[0].summary };
}
/** Badge de origem: N = Nota fiscal, V = Pedido de venda, P (vermelho) = Pagamento, R = Recebimento. */
export function originBadge(line: StatementLine): { text: string; color: string; title: string } | null {
  if (line.line_kind !== 'settlement') return null;
  // SQL 363: a conta imported from the Origin shows the origin the Origin declares (number of the Origin, not opened in the Brufap).
  const origin = line.document?.source === 'origin' ? ' no Origin' : '';
  if (line.document?.kind === 'sales_orders') return { text: 'V', color: '#3b7dd8', title: `Pedido de venda nº ${line.document.number}${origin}` };
  // SQL 247: N = Nota fiscal (the baixa of a conta lançada by a note).
  if (line.document?.kind === 'fiscal_invoices') return { text: 'N', color: '#7a5af8', title: `Nota fiscal nº ${line.document.number}${origin}` };
  return line.title_kind === 'payable' ? { text: 'P', color: '#d9534f', title: 'Pagamento' } : { text: 'R', color: '#2f9e6b', title: 'Recebimento' };
}
export const lineHistory = (line: StatementLine) => line.line_kind === 'opening' ? 'Saldo inicial da conta' : line.note ?? '—';
export const signedMoney = (cents: string) => cents.startsWith('-') ? `- ${financeMoney(cents.slice(1))}` : financeMoney(cents);

export type LineBatchItem = BatchItem & { line: StatementLine };
const label = (line: StatementLine) => `${financeDate(line.posted_on)} · ${lineHistory(line)} · ${signedMoney(line.amount_cents)}`;
/**
 * Excluir selecionadas: lançamentos and transferências (one per transfer); baixas are undone in the conta or the borderô and
 * a reconciled line waits for Desvincular (SQL 137 refuses it).
 */
/** Lançamentos owned by another screen (onda C): pagamentos de comissão and sangrias/suprimentos are changed only there. */
export const OWNED_ORIGIN: Readonly<Record<string, string>> = { commission: 'Pagamento de comissão: exclua em Financeiro > Comissões.', cash_session: 'Sangria ou suprimento do Controle de caixa: exclua no próprio caixa.' };
export const ownedLine = (line: Pick<StatementLine, 'line_kind' | 'entry_origin'>) => line.line_kind === 'entry' && line.entry_origin !== null && Object.hasOwn(OWNED_ORIGIN, line.entry_origin);
export function deletePlan(lines: readonly StatementLine[]): BatchPlan<LineBatchItem> {
  const seen = new Set<string>(), unique = lines.filter(line => { if (line.line_kind !== 'transfer') return true; if (seen.has(line.transfer_id!)) return false; seen.add(line.transfer_id!); return true; });
  return planBatch(unique.map(line => ({ id: line.line_id, label: label(line), line })), ({ line }) => line.line_kind === 'settlement' ? 'Lançamento de baixa: desfaça pela conta ou pelo borderô.' : line.line_kind === 'opening' ? 'O saldo inicial é corrigido por “Ajustar saldos”.'
    : line.reconciled ? 'Lançamento conciliado: desvincule-o na aba Conciliação antes de excluir.' : ownedLine(line) ? OWNED_ORIGIN[line.entry_origin!] : null);
}
export function restorePlan(lines: readonly StatementLine[]): BatchPlan<LineBatchItem> {
  return planBatch(lines.map(line => ({ id: line.line_id, label: label(line), line })), ({ line }) => line.line_kind !== 'entry' ? 'Transferência excluída: inclua a transferência novamente.' : ownedLine(line) ? OWNED_ORIGIN[line.entry_origin!] : null);
}
/** Alterar categorias: a baixa only takes a categoria of the kind of its conta; the saldo inicial keeps none. */
export function categorizePlan(lines: readonly StatementLine[], target: { id: string | null; kind: 'receivable' | 'payable' | null }): BatchPlan<LineBatchItem> {
  return planBatch(lines.map(line => ({ id: line.line_id, label: label(line), line })), ({ line }) => line.line_kind === 'opening' ? 'O saldo inicial não tem categoria.'
    : line.category_id === target.id ? 'Já está nesta categoria.' : line.line_kind === 'settlement' && target.id && target.kind !== line.title_kind ? `A baixa de conta a ${line.title_kind === 'receivable' ? 'receber pede uma categoria de receita' : 'pagar pede uma categoria de despesa'}.` : null);
}
export const STATEMENT_EXPORT_HEADERS = ['Data', 'Conta financeira', 'Categoria', 'Histórico', 'Cliente/Fornecedor', 'Valor'];
export function statementSheet(lines: readonly StatementLine[]): SheetCell[][] {
  const decimal = (cents: string) => { const negative = cents.startsWith('-'), digits = cents.replace('-', '').padStart(3, '0'); return `${negative ? '-' : ''}${digits.slice(0, -2).replace(/^0+(?=\d)/, '')}.${digits.slice(-2)}`; };
  return [STATEMENT_EXPORT_HEADERS.map(textCell), ...lines.map(line => [textCell(financeDate(line.posted_on)), textCell(line.account_name), textCell(line.category_name ?? ''), textCell(lineHistory(line)), textCell(line.contact_name ?? ''), numberCell(decimal(line.amount_cents))])];
}

// ---------------------------------------------------------------- Ficha financeira
export interface LedgerLine { day: string; line_kind: 'title' | 'payment' | 'reversal' | 'entry'; ref_id: string; kind: 'receivable' | 'payable'; note: string; due_on: string | null; side: 'debit' | 'credit'; amount_cents: string; situation: string | null; origin: { kind: string; number: string } | null; version: number | null;
  /** SQL 175: the Forma de pagamento of the conta (contas and baixas). */
  payment_method?: string | null }
export interface Ledger { contact_id: string; contact_name: string; items: LedgerLine[]; totals: { debit_cents: string; credit_cents: string; balance_cents: string };
  /** SQL 172: the ficha is read 100 lines per page; the totals are always those of the whole period. */
  page: number; total: number }
export const LEDGER_PAGE_SIZE = 100;
export const LEDGER_SCOPES = [{ value: 'all', label: 'Todas as contas' }, { value: 'payable', label: 'Contas a pagar' }, { value: 'receivable', label: 'Contas a receber' }] as const;
export const LEDGER_SITUATION: Readonly<Record<string, string>> = { paid: 'Pago', cancelled: 'Cancelada', open: 'Em aberto', due_today: 'Vencendo hoje', overdue: 'Atrasada', partial: 'Parcial' };
export const LEDGER_ORIGIN: Readonly<Record<string, string>> = { sales_orders: 'Venda', service_orders: 'Ordem de serviço', purchase_orders: 'Pedido de compra', fiscal_invoices: 'Nota fiscal' };
export function contactLedger(value: unknown, contact: string, scope: string, from: string, to: string, page = 1): Ledger {
  const failure = 'Não foi possível conferir a ficha financeira.';
  if (!object(value) || value.entity !== 'contact_ledger' || value.contact_id !== contact || value.scope !== scope || value.from !== from || value.to !== to || !Array.isArray(value.items) || !object(value.totals)) fail(failure);
  const paged = value as Record<string, unknown> & { items: unknown[] };
  if (paged.page !== page || paged.limit !== LEDGER_PAGE_SIZE || !Number.isSafeInteger(paged.total) || (paged.total as number) < 0 || paged.items.length !== Math.max(0, Math.min(LEDGER_PAGE_SIZE, (paged.total as number) - (page - 1) * LEDGER_PAGE_SIZE))) fail(failure);
  const raw = value as unknown as Ledger;
  for (const key of ['debit_cents', 'credit_cents', 'balance_cents'] as const) if (typeof raw.totals[key] !== 'string' || !SIGNED.test(raw.totals[key])) fail(failure);
  if (BigInt(raw.totals.credit_cents) - BigInt(raw.totals.debit_cents) !== BigInt(raw.totals.balance_cents)) fail(failure);
  for (const item of raw.items) if (!object(item) || !UUID.test(String(item.ref_id)) || !['debit', 'credit'].includes(item.side) || typeof item.amount_cents !== 'string' || !/^\d{1,30}$/.test(item.amount_cents) || item.day < from || item.day > to || (scope !== 'all' && item.kind !== scope)) fail(failure);
  return raw;
}
