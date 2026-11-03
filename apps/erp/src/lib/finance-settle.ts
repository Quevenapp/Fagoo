// "Baixa de lançamentos" do Origin (SQL 110): uma ou várias contas, lançamento agrupado, categoria única, data de
// vencimento, juros e multa calculados pelos percentuais da conta e o "Valor recebido/pago" informado pelo usuário.
// Tudo em centavos exatos com BigInt; o servidor repete cada validação.
import { centsInput, moneyInput, validFinanceDate, type FinanceKind, type FinanceTitle } from './real-finance-model.ts';
import { titleCharges } from './finance-title-drawer.ts';

export interface SettleRow { id: string; account_id: string; category_id: string; interest: string; penalty: string; discount: string; fee: string; value: string; valueTouched: boolean; chargesTouched: boolean }
export interface SettleState { grouped: boolean; singleCategory: boolean; useDueDate: boolean; destination: string; category: string; postedOn: string; note: string; rows: SettleRow[] }
/** SQL 249: the Histórico of the baixa takes 2,000 characters, as in Origin (borderô and movimento keep the first 500). */
export const SETTLE_NOTE_LIMIT = 2000;
export const SETTLE_NOTE_LABEL = SETTLE_NOTE_LIMIT.toLocaleString('pt-BR');
export const settleLabels = (kind: FinanceKind) => kind === 'receivable'
  ? { date: 'Data do recebimento', value: 'Valor recebido', contact: 'Cliente' } : { date: 'Data do pagamento', value: 'Valor pago', contact: 'Fornecedor' };
const zero = (value: string) => value.trim() ? value : '0';
const money = (value: string) => moneyInput(zero(value));

/** The date a row is settled on: the vencimento with "Utilizar data de vencimento", otherwise the date of the form. */
export const rowDate = (state: Pick<SettleState, 'useDueDate' | 'postedOn'>, title: FinanceTitle) => state.useDueDate ? title.due_on : state.postedOn;
/** Juros e multa pelos percentuais da conta até a data da baixa (Origin calcula sozinho quando a conta os tem). */
export function rowCharges(title: FinanceTitle, until: string) {
  const charges = titleCharges(title.balance_cents, title.due_on, title.interest_month_bp ?? 0, title.penalty_bp ?? 0, until);
  return { interest: centsInput(charges.interest_cents), penalty: centsInput(charges.penalty_cents) };
}
/** Valor recebido/pago sugerido: saldo + juros + multa − desconto, menos a tarifa ao receber e mais ao pagar. */
export function suggestedValue(kind: FinanceKind, title: FinanceTitle, row: Pick<SettleRow, 'interest' | 'penalty' | 'discount' | 'fee'>): string {
  try {
    const value = BigInt(title.balance_cents) + BigInt(money(row.interest)) + BigInt(money(row.penalty)) - BigInt(money(row.discount)) + (kind === 'payable' ? 1n : -1n) * BigInt(money(row.fee));
    return value > 0n ? centsInput(value.toString()) : '';
  } catch { return ''; }
}
export function settleInitial(kind: FinanceKind, titles: readonly FinanceTitle[], today: string, partial = false): SettleState {
  const rows = titles.map(title => {
    // SQL 175: the first full recebimento suggests the taxa of the forma de pagamento as tarifa (Origin "Informações de taxas").
    const fee = kind === 'receivable' && !partial && title.settled_cents === '0' && title.payment_fee_cents ? centsInput(title.payment_fee_cents) : '0,00';
    const charges = rowCharges(title, today), base = { id: title.id, account_id: title.account_id ?? '', category_id: title.category_id ?? '', ...charges, discount: '0,00', fee, valueTouched: partial, chargesTouched: false };
    return { ...base, value: partial ? '' : suggestedValue(kind, title, base) };
  });
  return { grouped: false, singleCategory: false, useDueDate: false, destination: commonAccount(titles), category: '', postedOn: today, note: titles.length === 1 ? titles[0].description : '', rows };
}
/** Leva H (CTT-161): the conta financeira of the contas themselves when they all share one; else the company default fills it at the baixa. */
export function commonAccount(titles: readonly Pick<FinanceTitle, 'account_id'>[]): string {
  const first = titles[0]?.account_id ?? null;
  return first && titles.every(title => title.account_id === first) ? first : '';
}
/** The account a row of the baixa uses: the conta's own account first, then the company default; never chosen by settling. */
export const settleAccount = (own: string | null | undefined, companyDefault: string) => own || companyDefault;
/** Recomputes the automatic juros, multa and valor of the rows the user did not edit, for a new date. */
export function refreshRows(kind: FinanceKind, state: SettleState, titles: readonly FinanceTitle[]): SettleState {
  return { ...state, rows: state.rows.map(row => {
    const title = titles.find(item => item.id === row.id)!, charges = row.chargesTouched ? { interest: row.interest, penalty: row.penalty } : rowCharges(title, rowDate(state, title));
    const next = { ...row, ...charges };
    return row.valueTouched ? next : { ...next, value: suggestedValue(kind, title, next) };
  }) };
}
/** Principal = valor − juros − multa + desconto ± tarifa (ao receber, a tarifa sai do valor recebido). */
export function rowAmounts(kind: FinanceKind, title: FinanceTitle, row: SettleRow) {
  const [value, interest, penalty, discount, fee] = [row.value, row.interest, row.penalty, row.discount, row.fee].map(money).map(BigInt);
  const principal = value - interest - penalty + discount + (kind === 'receivable' ? fee : -fee), balance = BigInt(title.balance_cents);
  if (value <= 0n) throw new Error(`Informe o ${settleLabels(kind).value.toLowerCase()} de ${title.contact_name}.`);
  if (principal <= 0n) throw new Error(`Os juros, a multa e a tarifa superam o ${settleLabels(kind).value.toLowerCase()} de ${title.contact_name}.`);
  if (principal > balance) throw new Error(`O ${settleLabels(kind).value.toLowerCase()} de ${title.contact_name} supera o saldo da conta com os acréscimos informados.`);
  return { principal_cents: principal.toString(), interest_cents: interest.toString(), penalty_cents: penalty.toString(), discount_cents: discount.toString(), fee_cents: fee.toString(), remaining_cents: (balance - principal).toString() };
}
export function settleTotal(state: SettleState): string {
  return state.rows.reduce((sum, row) => { try { return sum + BigInt(money(row.value)); } catch { return sum; } }, 0n).toString();
}
/** Body of settle_batch, with the version each conta had when the baixa was opened. */
export function settleBatchData(kind: FinanceKind, state: SettleState, titles: readonly FinanceTitle[], today: string): Record<string, unknown> {
  if (!state.rows.length || state.rows.length > 100) throw new Error('Selecione de 1 a 100 contas.');
  if (state.grouped && state.rows.length < 2) throw new Error('O lançamento agrupado precisa de duas ou mais contas.');
  if (state.grouped && !state.destination) throw new Error('Selecione o destino do lançamento agrupado.');
  if (state.singleCategory && !state.category) throw new Error('Selecione a categoria única para todos os registros.');
  const note = state.note.trim();
  if (note.length > SETTLE_NOTE_LIMIT) throw new Error(`O histórico aceita até ${SETTLE_NOTE_LABEL} caracteres.`);
  const items = state.rows.map(row => {
    const title = titles.find(item => item.id === row.id);
    if (!title) throw new Error('Feche a baixa e abra as contas novamente.');
    const day = rowDate(state, title);
    try { validFinanceDate(day); } catch { throw new Error(`Confira a data da baixa de ${title.contact_name}.`); }
    if (day > today) throw new Error(`A data da baixa de ${title.contact_name} não pode ser futura.`);
    if (day < title.issued_on) throw new Error(`A data da baixa de ${title.contact_name} não pode ser anterior à emissão.`);
    const account = state.grouped ? state.destination : row.account_id;
    if (!account) throw new Error(`Selecione a conta financeira de ${title.contact_name}.`);
    const { remaining_cents: _, ...amounts } = rowAmounts(kind, title, row);
    return { id: title.id, expected_version: title.version, account_id: account, category_id: (state.singleCategory ? state.category : row.category_id) || null, posted_on: day, ...amounts };
  });
  if (state.grouped && new Set(items.map(item => item.posted_on)).size > 1) throw new Error('No lançamento agrupado todas as contas são baixadas na mesma data.');
  return { kind, grouped: state.grouped, ...(state.grouped ? { account_id: state.destination, category_id: (state.singleCategory ? state.category : '') || null } : {}), note: note || null, items };
}
