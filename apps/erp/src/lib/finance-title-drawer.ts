// Gaveta "Conta a receber" / "Conta a pagar" no padrão Origin (SQL 108): abas, validação, montagem dos comandos
// title_create / title_edit e o Resumo (juros mensal pró-rata e multa) em centavos exatos com BigInt.
import { centsInput, moneyInput, validFinanceDate, type FinanceKind, type FinanceTitle, type FinanceTitleOrigin } from './real-finance-model.ts';

export type DrawerTab = 'cabecalho' | 'pagamento' | 'ocorrencia' | 'anexos';
export const DRAWER_TABS: readonly { id: DrawerTab; label: string }[] = [{ id: 'cabecalho', label: 'Cabeçalho' }, { id: 'pagamento', label: 'Pagamento' }, { id: 'ocorrencia', label: 'Ocorrência' }, { id: 'anexos', label: 'Anexos' }];
export type Occurrence = 'unica' | 'parcelada' | 'semanal' | 'quinzenal' | 'mensal' | 'bimestral' | 'trimestral' | 'semestral' | 'anual';
/** Origin's "Ocorrência" options: Única creates the conta; Parcelada (SQL 172) and the recurring ones create the recurrence (SQL 138) and the first conta. */
export const OCCURRENCES: readonly { id: Occurrence; label: string; available: boolean }[] = [
  { id: 'unica', label: 'Única', available: true }, { id: 'parcelada', label: 'Parcelada', available: true },
  { id: 'semanal', label: 'Semanal', available: true }, { id: 'quinzenal', label: 'Quinzenal', available: true }, { id: 'mensal', label: 'Mensal', available: true },
  { id: 'bimestral', label: 'Bimestral', available: true }, { id: 'trimestral', label: 'Trimestral', available: true }, { id: 'semestral', label: 'Semestral', available: true }, { id: 'anual', label: 'Anual', available: true },
];
export const RECURRENCE_UNAVAILABLE = 'Contas recorrentes ainda não são geradas pelo FAGOO.';
export const FREQUENCY: Readonly<Partial<Record<Occurrence, string>>> = { semanal: 'weekly', quinzenal: 'biweekly', mensal: 'monthly', bimestral: 'bimonthly', trimestral: 'quarterly', semestral: 'semiannual', anual: 'annual' };
export const isRecurring = (occurrence: Occurrence) => Boolean(FREQUENCY[occurrence]);
/** Parcelada (SQL 172) is a recurrence too: each parcela has the Valor and "Gerar contas" goes until the nº de parcelas. */
export const createsRecurrence = (occurrence: Occurrence) => isRecurring(occurrence) || occurrence === 'parcelada';
/** Origin's "Dia da semana" options (Semanal), in getUTCDay order. */
export const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'] as const;
export const END_ON_INFO = 'Define uma data limite para a geração de recorrências. Caso não preenchido, as contas serão geradas por um prazo indeterminado';
export const weekdayOf = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`).getUTCDay() : 0;
/**
 * Histórico of a conta: up to 2.000 characters, as in Origin (SQL 210); cobrança, retornos and documentos keep reading its first
 * 240. A recorrência (and the Parcelada) keeps the 240 of the recurrence, shared by every conta it generates.
 */
export const DESCRIPTION_LIMIT = 2000;
export const RECURRENCE_DESCRIPTION_LIMIT = 240;
export const descriptionLimit = (occurrence: Occurrence) => createsRecurrence(occurrence) ? RECURRENCE_DESCRIPTION_LIMIT : DESCRIPTION_LIMIT;
export const BANK_NUMBER_LIMIT = 60;
export const PERCENT_INFO = 'Este campo é preenchido automaticamente caso haja valores cadastrados na forma de pagamento ou boleto';

export interface TitleBilling { our_number: string | null; document_number: string; remittance_id: string; remittance_sequence: number; remittance_state: 'reserved' | 'ready'; file_generated: boolean }
export interface TitleOriginal { contact_name: string; due_on: string; amount_cents: string; description: string; created_at: string }
/** `history`: the whole Histórico when it passes the 240 characters of `record.description` (SQL 210), else null. */
export interface TitleDetail { record: FinanceTitle; origin: FinanceTitleOrigin | null; account: { id: string; name: string; active: boolean } | null; billing: TitleBilling | null; imported: boolean; settled_before: boolean; original: TitleOriginal | null; history: string | null }
/** The Histórico the gaveta edits: the long text once the detail is read, otherwise the description. */
export const titleHistory = (title: FinanceTitle, detail: TitleDetail | null) => detail?.history ?? title.description;
/** Prazo de recebimento of a forma (Cadastros > Formas de pagamento): vencimento = emissão + dias, on the next business day when asked. */
export function settlementDue(issuedOn: string, days: number | null | undefined, businessDays: boolean): string | null {
  if (days === null || days === undefined || !Number.isInteger(days) || days < 0 || days > 365 || !day(issuedOn)) return null;
  const due = shift(issuedOn, days); return businessDays ? nextBusinessDay(due) : due;
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const day = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const cents = (value: unknown): value is string => typeof value === 'string' && /^\d{1,15}$/.test(value);
function invalidDetail(): never { throw new Error('Não foi possível conferir os dados da conta. Feche e abra a conta novamente.'); }

/** GET /v1/financeiro/titles/{id}/detalhe bound to the requested conta and kind. */
export function titleDetail(value: unknown, id: string, kind: FinanceKind): TitleDetail {
  if (!object(value) || value.entity !== 'titles' || value.data_mode !== 'erp_native' || !object(value.record) || value.record.id !== id || value.record.kind !== kind
    || typeof value.imported !== 'boolean' || typeof value.settled_before !== 'boolean') invalidDetail();
  const record = value.record as unknown as FinanceTitle, account = value.account, billing = value.billing, original = value.original, origin = value.origin;
  if (account === null ? record.account_id ? true : false : !object(account) || account.id !== record.account_id || typeof account.name !== 'string' || typeof account.active !== 'boolean') invalidDetail();
  if (billing !== null && (!object(billing) || !uuid(billing.remittance_id) || !['reserved', 'ready'].includes(String(billing.remittance_state)) || billing.file_generated !== (billing.remittance_state === 'ready')
    || (billing.our_number !== null && typeof billing.our_number !== 'string') || typeof billing.document_number !== 'string' || !Number.isSafeInteger(billing.remittance_sequence))) invalidDetail();
  if (original !== null && (!object(original) || typeof original.contact_name !== 'string' || !day(original.due_on) || !cents(original.amount_cents) || typeof original.description !== 'string')) invalidDetail();
  if (origin !== null && (!object(origin) || !(origin.kind === 'fiscal_invoices' ? uuid(origin.invoice_id) : uuid(origin.document_id)) || record.document_linked !== true)) invalidDetail();
  if (origin === null && record.document_linked === true) invalidDetail();
  // SQL 210: the whole Histórico starts with the description every other reader keeps (older answers have none).
  const history = value.history === undefined ? null : value.history;
  if (history !== null && (typeof history !== 'string' || history.length > DESCRIPTION_LIMIT || !history.startsWith(record.description))) invalidDetail();
  return { history: history as string | null, record: { ...record, origin: origin as FinanceTitleOrigin | null }, origin: origin as FinanceTitleOrigin | null, account: account as TitleDetail['account'], billing: billing as TitleBilling | null, imported: value.imported, settled_before: value.settled_before, original: original as TitleOriginal | null };
}

/** "1,00" → 100 (centésimos de %); empty is zero. Up to 100,00%. */
export function percentInput(text: string): number {
  const input = text.trim();
  if (!input) return 0;
  if (!/^\d{1,3}(?:,\d{1,2})?$/.test(input)) throw new Error('Informe o percentual com vírgula e até duas casas, por exemplo 1,00.');
  const [whole, fraction = ''] = input.split(','), value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (value > 10000) throw new Error('O percentual não pode passar de 100,00%.');
  return value;
}
export function percentText(value: number | null | undefined): string {
  const bp = Number.isInteger(value) && (value as number) >= 0 ? value as number : 0;
  return `${Math.floor(bp / 100)},${String(bp % 100).padStart(2, '0')}`;
}

// ---- Dias úteis: sábado, domingo e feriados nacionais (com Carnaval, Sexta-feira Santa e Corpus Christi, sem expediente bancário) ----
function easter(year: number): [number, number] {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return [Math.floor((h + l - 7 * m + 114) / 31), ((h + l - 7 * m + 114) % 31) + 1];
}
const iso = (date: Date) => date.toISOString().slice(0, 10);
const shift = (value: string, days: number) => { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return iso(date); };
export function brazilHolidays(year: number): Set<string> {
  const [month, dayOfMonth] = easter(year), sunday = `${year}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;
  const fixed = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '12-25', ...(year >= 2024 ? ['11-20'] : [])].map(value => `${year}-${value}`);
  return new Set([...fixed, shift(sunday, -48), shift(sunday, -47), shift(sunday, -2), shift(sunday, 60)]);
}
export function isBusinessDay(value: string): boolean {
  const weekday = new Date(`${value}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !brazilHolidays(Number(value.slice(0, 4))).has(value);
}
/** The first date on or after the value that falls on the weekday (0 = domingo). */
export function nextWeekday(value: string, weekday: number): string { return shift(value, (weekday - weekdayOf(value) + 7) % 7); }
export function nextBusinessDay(value: string): string { let current = value; for (let guard = 0; guard < 15 && !isBusinessDay(current); guard++) current = shift(current, 1); return current; }

export interface DrawerValues {
  contact: { id: string; name: string } | null; amount: string; issued_on: string; competence_on: string; due_on: string; description: string;
  account_id: string; bank_number: string; category_id: string; source_reference: string; interest: string; penalty: string;
  occurrence: Occurrence; due_day: string; count: string; business_days: boolean;
  /** Recorrentes (SQL 138): Dia do 2º vencimento (Quinzenal), Dia da semana (Semanal) and Data limite. */
  second_day?: string; weekday?: string; end_on?: string;
  /** SQL 175: Forma de Pagamento of the conta ('' = Selecione). */
  payment_method_id?: string;
  /** SQL 210: Vendedor of a conta a receber (the effective one: the conta's own or the document's). */
  seller?: { id: string; name: string } | null;
}
export function drawerInitial(today: string, title?: FinanceTitle | null, clone?: FinanceTitle | null): DrawerValues {
  const base = title ?? clone ?? null;
  return {
    seller: base?.kind === 'receivable' && base.seller_id ? { id: base.seller_id, name: base.seller_name ?? 'Vendedor atual' } : null,
    contact: base ? { id: base.contact_id, name: base.contact_name } : null, amount: base ? centsInput(base.amount_cents) : '',
    issued_on: title ? title.issued_on : today, competence_on: title ? title.competence_on ?? title.issued_on : today, due_on: title ? title.due_on : clone ? today : today,
    description: base?.description ?? '', account_id: base?.account_id ?? '', bank_number: title?.bank_number ?? '', category_id: base?.category_id ?? '',
    source_reference: title ? title.source_reference ?? '' : '', interest: percentText(base?.interest_month_bp ?? 0), penalty: percentText(base?.penalty_bp ?? 0),
    occurrence: 'unica', due_day: String(Number((title?.due_on ?? today).slice(8, 10))), count: '2', business_days: false,
    second_day: '', weekday: String(weekdayOf(title?.due_on ?? today)), end_on: '', payment_method_id: base?.payment_method_id ?? '',
  };
}

/** Parcelas: the first on Vencimento, the next ones on "Dia de vencimento" of each following month (capped at the month's last day); each one has the Valor, as in Origin. */
export function drawerPlan(values: Pick<DrawerValues, 'amount' | 'due_on' | 'issued_on' | 'occurrence' | 'due_day' | 'count' | 'business_days'>): { amount_cents: string; due_on: string }[] {
  const total = BigInt(moneyInput(values.amount)); validFinanceDate(values.due_on); validFinanceDate(values.issued_on);
  if (total <= 0n) throw new DrawerError('Informe o valor da conta.', 'cabecalho');
  // "Considerar dias úteis" exists for every ocorrência except Única, as in Origin.
  if (values.occurrence === 'unica') return [{ amount_cents: total.toString(), due_on: values.due_on }];
  // A recurring conta starts with one conta on the vencimento; the next ones are generated by the recurrence.
  if (isRecurring(values.occurrence)) return [{ amount_cents: total.toString(), due_on: values.business_days ? nextBusinessDay(values.due_on) : values.due_on }];
  if (!/^\d{1,3}$/.test(values.count.trim()) || Number(values.count) < 2 || Number(values.count) > 120) throw new DrawerError('Informe de 2 a 120 parcelas.', 'ocorrencia');
  if (!/^\d{1,2}$/.test(values.due_day.trim()) || Number(values.due_day) < 1 || Number(values.due_day) > 31) throw new DrawerError('Informe o dia de vencimento entre 1 e 31.', 'ocorrencia');
  const count = BigInt(values.count.trim());
  const [year, month] = values.due_on.split('-').map(Number), wanted = Number(values.due_day);
  return Array.from({ length: Number(count) }, (_, index) => {
    let due = values.due_on;
    if (index > 0) { const start = new Date(Date.UTC(year, month - 1 + index, 1)), last = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate(); due = iso(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), Math.min(wanted, last)))); }
    if (values.business_days) due = nextBusinessDay(due);
    validFinanceDate(due);
    return { amount_cents: total.toString(), due_on: due };
  });
}

export class DrawerError extends Error { readonly tab: DrawerTab; constructor(message: string, tab: DrawerTab) { super(message); this.tab = tab; } }
/** What the 108 SQL keeps from the source: document, Origin import, boleto and baixas. */
export function drawerLocks(title: FinanceTitle | null, detail: TitleDetail | null) {
  if (!title) return { contact: false, amount: false, issued: false, reference: false, bank: false, occurrence: false };
  const source = title.document_linked || Boolean(detail?.imported), billed = Boolean(detail?.billing), settled = Boolean(detail?.settled_before) || title.settled_cents !== '0';
  // Faturamento agrupado (SQL 174): the cliente, the emissão and the valor stay with the faturamento (guard_grouped_title).
  const grouped = Boolean(title.grouped_billing_id);
  return { contact: source || billed || settled || grouped, amount: source || billed || settled || grouped, issued: source || settled || grouped, reference: source, bank: billed, occurrence: true };
}
function common(values: DrawerValues, kind: FinanceKind, limit: number = DESCRIPTION_LIMIT) {
  if (!values.contact) throw new DrawerError(kind === 'receivable' ? 'Selecione o cliente.' : 'Selecione o fornecedor.', 'cabecalho');
  for (const [key, label] of [['issued_on', 'a emissão'], ['competence_on', 'a competência'], ['due_on', 'o vencimento']] as const) {
    try { validFinanceDate(values[key]); } catch { throw new DrawerError(`Confira ${label}.`, 'cabecalho'); }
  }
  if (values.due_on < values.issued_on) throw new DrawerError('O vencimento não pode ser anterior à emissão.', 'cabecalho');
  const description = values.description.trim();
  if (!description) throw new DrawerError('Informe o histórico da conta.', 'cabecalho');
  if (description.length > limit) throw new DrawerError(`O histórico aceita até ${limit.toLocaleString('pt-BR')} caracteres${limit < DESCRIPTION_LIMIT ? ' nas contas recorrentes e parceladas' : ''}.`, 'cabecalho');
  const bank = values.bank_number.trim();
  if (bank.length > BANK_NUMBER_LIMIT || /[\x00-\x1f\x7f]/.test(bank)) throw new DrawerError('Confira o nº no banco.', 'pagamento');
  if (values.source_reference.trim().length > 200) throw new DrawerError('O nº documento aceita até 200 caracteres.', 'pagamento');
  let interest: number, penalty: number;
  try { interest = percentInput(values.interest); penalty = percentInput(values.penalty); } catch (error) { throw new DrawerError((error as Error).message, 'pagamento'); }
  return { description, bank: bank || null, reference: values.source_reference.trim() || null, interest, penalty };
}
export function drawerCreateData(kind: FinanceKind, values: DrawerValues): Record<string, unknown> {
  const checked = common(values, kind);
  let amount: string; try { amount = moneyInput(values.amount); } catch (error) { throw new DrawerError((error as Error).message, 'cabecalho'); }
  let installments: { amount_cents: string; due_on: string }[];
  try { installments = drawerPlan(values); } catch (error) { throw error instanceof DrawerError ? error : new DrawerError((error as Error).message, 'ocorrencia'); }
  if (installments.some(part => part.due_on < values.issued_on)) throw new DrawerError('O vencimento não pode ser anterior à emissão.', 'cabecalho');
  return { kind, contact_id: values.contact!.id, category_id: values.category_id || null, account_id: values.account_id || null, description: checked.description,
    source_reference: checked.reference, ...(kind === 'receivable' ? { bank_number: checked.bank } : {}), issued_on: values.issued_on, competence_on: values.competence_on,
    interest_month_bp: checked.interest, penalty_bp: checked.penalty, total_cents: amount, installments, ...(values.payment_method_id ? { payment_method_id: values.payment_method_id } : {}),
    ...(kind === 'receivable' && values.seller ? { seller_id: values.seller.id } : {}) };
}
/** recurrence_create (SQL 138): the first conta plus the schedule of the Ocorrência. */
export function recurrenceCreateData(kind: FinanceKind, values: DrawerValues): Record<string, unknown> {
  const checked = common(values, kind, RECURRENCE_DESCRIPTION_LIMIT), frequency = values.occurrence === 'parcelada' ? 'installments' : FREQUENCY[values.occurrence];
  if (!frequency) throw new DrawerError('Escolha uma ocorrência recorrente.', 'ocorrencia');
  let amount: string; try { amount = moneyInput(values.amount); } catch (error) { throw new DrawerError((error as Error).message, 'cabecalho'); }
  if (BigInt(amount) <= 0n) throw new DrawerError('Informe o valor da conta.', 'cabecalho');
  const dayNumber = (text: string | undefined, label: string) => { const value = (text ?? '').trim(); if (!/^\d{1,2}$/.test(value) || Number(value) < 1 || Number(value) > 31) throw new DrawerError(`Informe o ${label} entre 1 e 31.`, 'ocorrencia'); return Number(value); };
  const end = frequency === 'installments' ? '' : (values.end_on ?? '').trim();
  if (end) { try { validFinanceDate(end); } catch { throw new DrawerError('Confira a data limite.', 'ocorrencia'); } if (end < values.due_on) throw new DrawerError('A data limite não pode ser anterior ao vencimento.', 'ocorrencia'); }
  const schedule: Record<string, unknown> = { frequency, business_days: values.business_days, end_on: end || null };
  if (frequency === 'weekly') {
    const weekday = Number(values.weekday ?? weekdayOf(values.due_on));
    if (weekday !== weekdayOf(values.due_on)) throw new DrawerError(`O vencimento precisa cair no dia da semana escolhido (${WEEKDAYS[weekday] ?? 'inválido'}).`, 'ocorrencia');
    schedule.weekday = weekday;
  } else {
    schedule.due_day = dayNumber(values.due_day, 'dia de vencimento');
    if (frequency === 'biweekly') { schedule.second_day = dayNumber(values.second_day, 'dia do 2º vencimento'); if (schedule.second_day === schedule.due_day) throw new DrawerError('Os dois dias de vencimento devem ser diferentes.', 'ocorrencia'); }
    if (frequency === 'installments') {
      const count = values.count.trim(); if (!/^\d{1,3}$/.test(count) || Number(count) < 2 || Number(count) > 120) throw new DrawerError('Informe de 2 a 120 parcelas.', 'ocorrencia');
      schedule.installments = Number(count); delete schedule.end_on;
    }
  }
  return { kind, contact_id: values.contact!.id, category_id: values.category_id || null, account_id: values.account_id || null, description: checked.description, source_reference: checked.reference,
    ...(kind === 'receivable' ? { bank_number: checked.bank } : {}), issued_on: values.issued_on, competence_on: values.competence_on, due_on: values.due_on, amount_cents: amount,
    interest_month_bp: checked.interest, penalty_bp: checked.penalty, ...schedule,
    // The Forma de pagamento goes with the recurrence and with each conta it generates (SQL 172/175).
    ...(values.payment_method_id ? { payment_method_id: values.payment_method_id } : {}) };
}
/**
 * Fields of a title_edit that the "Alterar contas em aberto" of a recurring conta can carry to the other contas. A Histórico longer
 * than the 240 characters of the recurrence stays only on this conta.
 */
export function recurrenceChanges(data: Record<string, unknown>): Record<string, unknown> | null {
  const changes = Object.fromEntries(['description', 'amount_cents', 'category_id', 'account_id', 'interest_month_bp', 'penalty_bp'].filter(key => key in data && !(key === 'description' && String(data[key]).length > RECURRENCE_DESCRIPTION_LIMIT)).map(key => [key, data[key]]));
  return Object.keys(changes).length ? changes : null;
}
/** Only the fields the user changed, with the version shown in the drawer; `history` is the whole Histórico read with the conta (SQL 210). */
export function drawerEditData(title: FinanceTitle, values: DrawerValues, locks: ReturnType<typeof drawerLocks>, history: string = title.description): Record<string, unknown> | null {
  const checked = common(values, title.kind), data: Record<string, unknown> = { id: title.id, expected_version: title.version };
  let amount: string; try { amount = moneyInput(values.amount); } catch (error) { throw new DrawerError((error as Error).message, 'cabecalho'); }
  if (BigInt(amount) <= 0n) throw new DrawerError('Informe o valor da conta.', 'cabecalho');
  const set = (key: string, next: unknown, current: unknown, locked = false) => { if (next === current) return; if (locked) throw new DrawerError('Este campo fica com a origem da conta e não pode ser alterado.', key === 'source_reference' || key === 'bank_number' ? 'pagamento' : 'cabecalho'); data[key] = next; };
  set('contact_id', values.contact!.id, title.contact_id, locks.contact);
  set('amount_cents', amount, title.amount_cents, locks.amount);
  set('issued_on', values.issued_on, title.issued_on, locks.issued);
  set('competence_on', values.competence_on, title.competence_on ?? title.issued_on);
  set('due_on', values.due_on, title.due_on);
  set('description', checked.description, history);
  set('account_id', values.account_id || null, title.account_id ?? null);
  set('category_id', values.category_id || null, title.category_id);
  set('source_reference', checked.reference, title.source_reference, locks.reference);
  if (title.kind === 'receivable') set('bank_number', checked.bank, title.bank_number ?? null, locks.bank);
  set('interest_month_bp', checked.interest, title.interest_month_bp ?? 0);
  set('penalty_bp', checked.penalty, title.penalty_bp ?? 0);
  set('payment_method_id', values.payment_method_id || null, title.payment_method_id ?? null);
  if (title.kind === 'receivable') set('seller_id', values.seller?.id ?? null, title.seller_id ?? null);
  return Object.keys(data).length > 2 ? data : null;
}

/** Days from vencimento to "today" in São Paulo (0 when not overdue). */
export function overdueDays(dueOn: string, today: string): number {
  if (!day(dueOn) || !day(today) || today <= dueOn) return 0;
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueOn}T00:00:00Z`)) / 86400000);
}
const roundDiv = (numerator: bigint, denominator: bigint) => (numerator * 2n + denominator) / (denominator * 2n);
/** Resumo do Origin: juros mensais pró-rata pelos dias de atraso e multa sobre o saldo após o vencimento. */
export function titleCharges(balanceCents: string, dueOn: string, interestBp: number, penaltyBp: number, until: string) {
  const balance = BigInt(balanceCents), days = overdueDays(dueOn, until);
  const interest = days > 0 ? roundDiv(balance * BigInt(interestBp) * BigInt(days), 10000n * 30n) : 0n;
  const penalty = days > 0 ? roundDiv(balance * BigInt(penaltyBp), 10000n) : 0n;
  return { days, interest_cents: interest.toString(), penalty_cents: penalty.toString(), total_cents: (balance + interest + penalty).toString() };
}

export interface ReferenceOption { id: string; name: string; active: boolean; kind: string }
/** One page (limit 100) of the 010 cursor list of contas financeiras or categorias, for the drawer selects. */
export function referenceOptions(value: unknown, entity: 'accounts' | 'categories', after: string | null): { items: ReferenceOption[]; has_more: boolean; next_cursor: string | null } {
  const failure = new Error(entity === 'accounts' ? 'Não foi possível carregar as contas financeiras.' : 'Não foi possível carregar as categorias.');
  if (!object(value) || value.entity !== entity || value.data_mode !== 'erp_native' || value.limit !== 100 || !Array.isArray(value.items) || value.items.length > 100
    || typeof value.has_more !== 'boolean' || (value.has_more ? !uuid(value.next_cursor) || value.items.length !== 100 : value.next_cursor !== null)) throw failure;
  const kinds = entity === 'accounts' ? ['bank', 'cash', 'other'] : ['receivable', 'payable', 'both'];
  let previous = after ?? '';
  const items = (value.items as unknown[]).map(item => {
    if (!object(item) || !uuid(item.id) || item.id <= previous || typeof item.name !== 'string' || typeof item.active !== 'boolean' || typeof item.kind !== 'string' || (entity === 'categories' && !kinds.includes(item.kind))) throw failure;
    previous = item.id;
    return { id: item.id, name: item.name, active: item.active, kind: item.kind };
  });
  if (value.has_more && value.next_cursor !== previous) throw failure;
  return { items, has_more: value.has_more, next_cursor: value.next_cursor as string | null };
}

/** Up to five pages of 100 options of the 010 cursor list (contas financeiras or categorias). */
export async function loadReferenceOptions(finance: (path: string, options: { signal: AbortSignal }) => Promise<unknown>, entity: 'accounts' | 'categories', signal: AbortSignal): Promise<ReferenceOption[]> {
  const items: ReferenceOption[] = []; let next: string | null = null;
  for (let index = 0; index < 5; index++) {
    const params = new URLSearchParams({ limit: '100' }); if (next) params.set('after', next);
    const page = referenceOptions(await finance(`/v1/financeiro/${entity}?${params}`, { signal }), entity, next);
    items.push(...page.items); if (!page.has_more) break; next = page.next_cursor;
  }
  return items;
}
