// Conciliação bancária do Origin (SQL 137): rota da aba, leitura conferida da fila e dos candidatos, leitura do .OFX
// no navegador (o conteúdo vai ao Worker, que o interpreta) e as somas da conciliação em centavos exatos.
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message: string): never => { throw new Error(message); };

export type ReconciliationState = 'pending' | 'reconciled' | 'hidden';
export const RECONCILIATION_STATES: readonly { value: ReconciliationState; param: string; label: string }[] = [{ value: 'pending', param: 'pendentes', label: 'Pendentes' }, { value: 'reconciled', param: 'conciliados', label: 'Conciliados' }, { value: 'hidden', param: 'ocultos', label: 'Ocultos' }];
export interface ReconciliationRoute { conta: string; situacao: ReconciliationState; valor: string }
export function reconciliationRoute(params: URLSearchParams): ReconciliationRoute {
  const conta = params.get('conta') ?? '', situacao = params.get('situacao') ?? 'pendentes', valor = params.get('valor') ?? '';
  const state = RECONCILIATION_STATES.find(item => item.param === situacao);
  if ((conta && !UUID.test(conta)) || !state || (valor && !/^[1-9]\d{0,14}$/.test(valor))) fail('Filtros inválidos no endereço.');
  return { conta, situacao: state!.value, valor };
}
export function reconciliationParams(route: ReconciliationRoute) {
  const params = new URLSearchParams({ area: 'conciliacao' }); if (route.conta) params.set('conta', route.conta);
  const state = RECONCILIATION_STATES.find(item => item.value === route.situacao)!; if (state.value !== 'pending') params.set('situacao', state.param); if (route.valor) params.set('valor', route.valor);
  return params;
}
export const RECONCILIATION_PAGE = 50;
export const reconciliationApiPath = (route: ReconciliationRoute, page: number) => `/v1/financeiro/conciliacao?${new URLSearchParams({ account: route.conta, state: route.situacao, ...(route.valor ? { amount_cents: route.valor } : {}), page: String(page), limit: String(RECONCILIATION_PAGE) })}`;

export interface Candidate { kind: 'entry' | 'movement'; id: string; line_kind: 'entry' | 'transfer' | 'settlement'; posted_on: string; amount_cents: string; note: string | null; contact_name: string | null; category_name?: string | null; entry_origin?: string | null; title_kind?: string | null; link_id?: string }
export interface BankLine { id: string; statement_id: string; account_id: string; fitid: string; posted_on: string; amount_cents: string; memo: string | null; trntype: string | null; state: ReconciliationState; version: number; links: Candidate[]; suggestion: Candidate | null }
export interface BankStatementFile { id: string; file_name: string; created_at: string; period_from: string; period_to: string; lines: number; reconciled: number }
export interface ReconciliationPage { items: BankLine[]; total: number; page: number; counts: Record<ReconciliationState, number>; statements: BankStatementFile[] }
export interface TitleCandidate { id: string; kind: 'receivable' | 'payable'; version: number; contact_name: string; description: string; due_on: string; balance_cents: string; installment: number; installments: number;
  /** SQL 175: the Forma de pagamento of the conta. */
  payment_method_name?: string | null }
export function reconciliationPage(value: unknown, route: ReconciliationRoute, page: number): ReconciliationPage {
  const failure = 'Não foi possível conferir a conciliação.';
  if (!object(value) || value.entity !== 'reconciliation' || value.account_id !== route.conta || value.state !== route.situacao || value.page !== page || value.limit !== RECONCILIATION_PAGE || !Number.isSafeInteger(value.total)
    || !Array.isArray(value.items) || !object(value.counts) || !Array.isArray(value.statements)) fail(failure);
  const raw = value as unknown as ReconciliationPage;
  for (const line of raw.items) {
    if (!object(line) || !UUID.test(String(line.id)) || line.state !== route.situacao || typeof line.amount_cents !== 'string' || !/^-?[1-9]\d{0,14}$/.test(line.amount_cents) || !Array.isArray(line.links)
      || (route.valor && line.amount_cents.replace('-', '') !== route.valor)) fail(failure);
    if (line.state === 'reconciled' && sumCents(line.links) !== line.amount_cents) fail(failure);
  }
  return { items: raw.items, total: raw.total, page, counts: raw.counts, statements: raw.statements };
}
export const sumCents = (items: readonly { amount_cents: string }[]) => items.reduce((sum, item) => sum + BigInt(item.amount_cents), 0n).toString();
/** "Para conciliar": what is left between the line of the bank and the lançamentos chosen. */
export const toReconcile = (line: Pick<BankLine, 'amount_cents'>, chosen: readonly { amount_cents: string }[]) => (BigInt(line.amount_cents) - BigInt(sumCents(chosen))).toString();
export const CANDIDATE_TYPE: Readonly<Record<Candidate['line_kind'], string>> = { entry: 'Caixas e banco', transfer: 'Transferência', settlement: 'Pagamento/recebimento' };
/** The .OFX text in its declared charset (OFX 1.x often declares CHARSET:1252). */
export function decodeOfx(bytes: Uint8Array): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 600));
  const latin = /CHARSET:\s*(1252|ISO-8859-1|NONE)/i.test(head) || /encoding="(windows-1252|iso-8859-1)"/i.test(head);
  if (!latin) { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* falls back to windows-1252 */ } }
  return new TextDecoder('windows-1252').decode(bytes);
}
