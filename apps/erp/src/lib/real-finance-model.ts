/** UI contract for the company's native financial ledger. Amounts never pass through Number. */
export type FinanceKind = 'receivable' | 'payable';
export type FinanceEntity = 'accounts' | 'categories' | 'titles' | 'settlements' | 'movements';
/** permitted: SQL 246, the keys of Sistema > Usuários > Permissões the user has in the financeiro (absent: every key of the profile). */
export interface FinanceAccess { read: true; write: boolean; permitted?: string[]; data_mode: 'erp_native' }
/** A finance permission key (Sistema > Usuários > Permissões > Finanças): the SQL is the authority; this only hides what it refuses. */
export function financePermitted(access: Pick<FinanceAccess, 'permitted'> | null | undefined, key: string): boolean {
  if (!access?.permitted) return true;
  const parent = key.split('.').length > 2 ? key.split('.').slice(0, 2).join('.') : null;
  return access.permitted.includes(key) && (!parent || access.permitted.includes(parent));
}
/** Key prefix of the contas of a kind: financas.contas_receber or financas.contas_pagar. */
export const titlePermission = (kind: FinanceKind, action?: 'ie' | 'ex' | 'cancelar' | 'baixar' | 'relatorio') => `financas.${kind === 'receivable' ? 'contas_receber' : 'contas_pagar'}${action ? `.${action}` : ''}`;
export interface FinanceAccount { id: string; name: string; kind: 'bank' | 'cash' | 'other'; active: boolean; opening_recorded: boolean; version: number; balance_cents: string }
export interface FinanceCategory { id: string; name: string; kind: FinanceKind | 'both'; active: boolean; version: number }
export interface FinanceTitle { id: string; group_id: string; installment: number; installments: number; kind: FinanceKind; contact_id: string; contact_name: string; category_id: string | null; category_name: string | null; description: string; source_reference: string | null; issued_on: string; due_on: string; amount_cents: string; settled_cents: string; balance_cents: string; cancelled: boolean; version: number; status: 'open' | 'partial' | 'paid' | 'cancelled'; overdue: boolean; document_linked: boolean; origin?: FinanceTitleOrigin | null;
  /** SQL 108 drawer fields; null when the reader predates them. Percentuais are integer hundredths (1,00% = 100). */
  competence_on?: string | null; account_id?: string | null; bank_number?: string | null; interest_month_bp?: number | null; penalty_bp?: number | null; original_due_on?: string | null; deleted_at?: string | null;
  /** Conta gerada por uma recorrência (SQL 138). */
  recurrence_id?: string | null;
  /** SQL 175: Forma de pagamento, the taxa it takes from the valor, and the Faturamento agrupado (174) of the conta. */
  payment_method_id?: string | null; payment_method_name?: string | null; payment_fee_cents?: string | null; grouped_billing_id?: string | null;
  /** SQL 210: tPag of the forma, the effective Vendedor (own or of the document) and whether the Histórico passes 240 characters. */
  payment_type?: string | null; seller_id?: string | null; seller_name?: string | null; seller_source?: 'conta' | 'documento' | null; long_history?: boolean | null;
  /** SQL 246: "sem vendedor" chosen in the gaveta over the seller of the document. */
  seller_cleared?: boolean | null;
  /** SQL 281: Situação Devolvido (the conta is cancelled and marked by a devolução); null when the database predates it. */
  returned?: boolean | null }
/** Document that generated the title (SQL 094): only its id, kind and number. */
export interface FinanceDocumentOrigin { document_id: string; kind: 'sales_orders' | 'service_orders' | 'purchase_orders'; number: string }
/** SQL 247: the nota fiscal that lançou the conta (saída: contas a receber; entrada: contas a pagar); an own note not sent has no number. */
export interface FinanceInvoiceOrigin { invoice_id: string; kind: 'fiscal_invoices'; model: '55' | '65'; direction: '0' | '1'; number: string | null }
export type FinanceTitleOrigin = FinanceDocumentOrigin | FinanceInvoiceOrigin;
/** Sums of the effective (not reversed) baixas of a conta (SQL 109). */
export interface FinanceTitlePayments { settled_on: string | null; fee_cents: string; interest_cents: string; penalty_cents: string; discount_cents: string; settled_by_return: boolean }
export interface FinanceTitleRow extends FinanceTitle { origin: FinanceTitleOrigin | null; account_name: string | null; remittance: { id: string; sequence: number; state: 'reserved' | 'ready'; our_number: string | null } | null; payments: FinanceTitlePayments;
  /** Adopted from Origin (039): the conta stays with Origin and is never excluded in the Brufap. */
  imported: boolean;
  /** SQL 246: bank of the conta financeira of the forma (else of the conta), for the column Forma de pagamento. */
  payment_bank?: { code: string; name: string } | null }
/** Numbered Origin-style page (SQL 109): 100 per page, vencimento order, the Opção and totals of the whole filtered set in exact cents. */
export interface FinanceTitlePage { entity: 'titles'; kind: FinanceKind; option: 'open' | 'overdue' | 'issued' | 'settled'; items: FinanceTitleRow[]; page: number; limit: number; order: 'due_asc' | 'due_desc'; total: number; totals: { count: number; amount_cents: string; balance_cents: string; fee_cents: string }; data_mode: 'erp_native' }
export interface FinanceSettlement { id: string; title_id: string; account_id: string; kind: 'payment' | 'reversal'; reverses_id: string | null; posted_on: string; principal_cents: string; interest_cents: string; penalty_cents: string; discount_cents: string; fee_cents: string; net_cash_cents: string; note: string | null; reversed: boolean;
  /** SQL 249: the whole Histórico of the baixa when it passes 500 characters; note keeps its beginning. */
  history?: string | null }
export interface FinanceMovement { id: string; account_id: string; settlement_id: string | null; transfer_id: string | null; kind: 'opening' | 'payment' | 'reversal' | 'transfer_out' | 'transfer_in' | 'bank_fee' | 'bank_fee_reversal' | 'entry' | 'entry_reversal'; delta_cents: string; posted_on: string; note: string | null }
export type FinanceRecord = FinanceAccount | FinanceCategory | FinanceTitle | FinanceSettlement | FinanceMovement;
export interface FinancePage<T = FinanceRecord> { entity: FinanceEntity; items: T[]; limit: number; has_more: boolean; next_cursor: string | null; data_mode: 'erp_native' }
export interface FinanceEnvelope<T = FinanceRecord> { entity: FinanceEntity; record: T; data_mode: 'erp_native' }
export const FINANCE_STATUS = { open: 'Em aberto', partial: 'Parcial', paid: 'Liquidado', cancelled: 'Cancelado' };
export const FINANCE_KIND: Record<string, string> = { entry: 'Lançamento de caixa', entry_reversal: 'Lançamento desfeito', receivable: 'A receber', payable: 'A pagar', both: 'Receitas e despesas', bank: 'Banco', cash: 'Caixa', other: 'Outra', opening: 'Saldo inicial', payment: 'Baixa', reversal: 'Estorno',transfer_out:'Transferência · saída',transfer_in:'Transferência · entrada',bank_fee:'Tarifa bancária',bank_fee_reversal:'Estorno de tarifa bancária' };
const MAX_CENTS = 999999999999999n;
export function moneyInput(value: string, signed = false): string {
  const input = value.trim();
  if (!(signed ? /^-?\d{1,13}(?:,\d{1,2})?$/ : /^\d{1,13}(?:,\d{1,2})?$/).test(input)) throw new Error('Informe o valor em reais, com vírgula e até duas casas, sem separador de milhar.');
  const negative = input.startsWith('-'); const [whole, fraction = ''] = input.replace(/^-/, '').split(',');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > MAX_CENTS) throw new Error('O valor excede o limite permitido.');
  return ((negative ? -1n : 1n) * cents).toString();
}
export function centsInput(value: string) {
  if (!/^-?\d+$/.test(value)) throw new Error('Valor monetário inválido.');
  const cents = BigInt(value); const absolute = cents < 0n ? -cents : cents;
  return `${cents < 0n ? '-' : ''}${absolute / 100n},${(absolute % 100n).toString().padStart(2, '0')}`;
}
export function financeMoney(value: string) { const [whole, fraction] = centsInput(value).split(','); return `R$ ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${fraction}`; }
export function financeDate(value: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.split('-').reverse().join('/') : '—'; }
export function todaySP(now = new Date()) { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now); return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key)!.value).join('-'); }
export function validFinanceDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2100-12-31' || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error('Informe uma data válida entre 1900 e 2100.');
  return value;
}
export function postingDate(value: string, minimum?: string) { validFinanceDate(value); if (value > todaySP() || (minimum && value < minimum)) throw new Error('Confira a data: ela não pode ser futura nem anterior à operação de origem.'); return value; }
export function installmentPlan(total: string, count: string, firstDue: string, issuedOn: string) {
  const cents = BigInt(total); validFinanceDate(firstDue); validFinanceDate(issuedOn);
  if (!/^\d{1,3}$/.test(count) || Number(count) < 1 || Number(count) > 120 || cents < BigInt(count) || cents > MAX_CENTS || firstDue < issuedOn) throw new Error('Confira o total, o vencimento e a quantidade de parcelas (1 a 120; mínimo de R$ 0,01 por parcela).');
  const quantity = Number(count); const [year, month, day] = firstDue.split('-').map(Number);
  return Array.from({ length: quantity }, (_, index) => {
    const start = new Date(Date.UTC(year, month - 1 + index, 1));
    const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
    const due = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), Math.min(day, lastDay))).toISOString().slice(0, 10);
    validFinanceDate(due);
    return { amount_cents: (cents / BigInt(quantity) + (BigInt(index) < cents % BigInt(quantity) ? 1n : 0n)).toString(), due_on: due };
  });
}
export function settlementAmounts(kind: FinanceKind, remaining: string, values: Record<string, string>) {
  const result = Object.fromEntries(['principal', 'interest', 'penalty', 'discount', 'fee'].map(key => [`${key}_cents`, moneyInput(values[key] || '0')]));
  const principal = BigInt(result.principal_cents); const gross = principal + BigInt(result.interest_cents) + BigInt(result.penalty_cents);
  const discount = BigInt(result.discount_cents); const fee = BigInt(result.fee_cents);
  const cash = gross - discount + (kind === 'payable' ? fee : -fee);
  if (principal <= 0n || principal > BigInt(remaining)) throw new Error('O principal da baixa deve ser maior que zero e não pode superar o saldo do título.');
  if (discount > gross || cash < 0n || cash > MAX_CENTS) throw new Error('Os ajustes produzem um valor de caixa inválido. Confira desconto e tarifa.');
  return { components: result, net_cash_cents: cash.toString(), remaining_cents: (BigInt(remaining) - principal).toString() };
}
/** Same body reuses its command UUID after uncertain network outcomes. */
export function financeCommand(previous: { fingerprint: string; id: string } | null, action: string, data: unknown, uuid = () => crypto.randomUUID()) { const fingerprint = JSON.stringify({ action, data }); return previous?.fingerprint === fingerprint ? previous : { fingerprint, id: uuid() }; }
