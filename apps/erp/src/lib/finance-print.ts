// Impressões do financeiro no padrão Origin: recibo (receber), comprovante de pagamento (pagar) e a listagem simples ou
// agrupada por cliente/fornecedor. Valores em centavos exatos e valor por extenso sem ponto flutuante.
import type { FinanceKind, FinanceTitleRow } from './real-finance-model.ts';

const UNITS = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'catorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const TENS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const HUNDREDS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];
const SCALES = [['', ''], ['mil', 'mil'], ['milhão', 'milhões'], ['bilhão', 'bilhões'], ['trilhão', 'trilhões']] as const;
function group(value: number): string {
  if (value === 100) return 'cem';
  const parts: string[] = [], hundreds = Math.floor(value / 100), rest = value % 100;
  if (hundreds) parts.push(HUNDREDS[hundreds]);
  if (rest >= 20) parts.push(rest % 10 ? `${TENS[Math.floor(rest / 10)]} e ${UNITS[rest % 10]}` : TENS[Math.floor(rest / 10)]);
  else if (rest > 0) parts.push(UNITS[rest]);
  return parts.join(' e ');
}
/** Whole number in Portuguese words (up to trilhões). */
export function numberInWords(value: bigint): string {
  if (value < 0n || value >= 1_000_000_000_000_000n) throw new Error('PRINT_AMOUNT_INVALID');
  if (value === 0n) return 'zero';
  const groups: number[] = []; let rest = value;
  while (rest > 0n) { groups.push(Number(rest % 1000n)); rest /= 1000n; }
  const words: { text: string; value: number }[] = [];
  for (let index = groups.length - 1; index >= 0; index--) {
    const amount = groups[index]; if (!amount) continue;
    const scale = SCALES[index], text = index === 1 && amount === 1 ? 'mil' : index === 0 ? group(amount) : `${group(amount)} ${amount === 1 ? scale[0] : scale[1]}`;
    words.push({ text, value: amount });
  }
  // "e" before the last group when it is below 100 or a round hundred: "mil e cem", "dois mil e vinte".
  return words.map((word, index) => index === 0 ? word.text : `${index === words.length - 1 && (word.value < 100 || word.value % 100 === 0) ? 'e ' : ''}${word.text}`).join(' ');
}
/** Valor por extenso em reais: "mil e duzentos reais e cinco centavos", "um milhão de reais". */
export function moneyInWords(cents: string): string {
  if (!/^\d{1,15}$/.test(cents)) throw new Error('PRINT_AMOUNT_INVALID');
  const value = BigInt(cents), reais = value / 100n, centavos = value % 100n, parts: string[] = [];
  if (reais > 0n) {
    const words = numberInWords(reais), round = reais % 1_000_000n === 0n && reais >= 1_000_000n;
    parts.push(`${words} ${round ? 'de ' : ''}${reais === 1n ? 'real' : 'reais'}`);
  }
  if (centavos > 0n) parts.push(`${numberInWords(centavos)} ${centavos === 1n ? 'centavo' : 'centavos'}`);
  return parts.length ? parts.join(' e ') : 'zero real';
}
/** Value of a recibo/comprovante: what was paid in the effective baixas, or the valor when nothing was paid yet. */
export function paidValue(row: Pick<FinanceTitleRow, 'settled_cents' | 'amount_cents' | 'payments'>): string {
  if (row.settled_cents === '0') return row.amount_cents;
  const value = BigInt(row.settled_cents) + BigInt(row.payments.interest_cents) + BigInt(row.payments.penalty_cents) - BigInt(row.payments.discount_cents);
  return (value > 0n ? value : 0n).toString();
}
/**
 * Contas that may carry a recibo/comprovante: never a cancelled (or excluded) conta, and in contas a pagar only one
 * with a baixa, as the ⋮ "Imprimir comprovante". The others are counted so the preview can say they were left out.
 */
export function receiptRows(kind: FinanceKind, rows: readonly FinanceTitleRow[]): { rows: FinanceTitleRow[]; skipped: number } {
  const eligible = rows.filter(row => !row.cancelled && !row.deleted_at && (kind === 'receivable' || row.settled_cents !== '0'));
  return { rows: eligible, skipped: rows.length - eligible.length };
}
export interface ReceiptGroup { contact_id: string; contact_name: string; settled_on: string | null; lines: { id: string; description: string; installment: string; due_on: string; value_cents: string }[]; total_cents: string }
/** One recibo per contato (Origin "Gerar recibos": recibos agrupados por contato), in the order of the list. */
export function receiptGroups(rows: readonly FinanceTitleRow[]): ReceiptGroup[] {
  const groups = new Map<string, ReceiptGroup>();
  for (const row of rows) {
    const value = paidValue(row), current = groups.get(row.contact_id) ?? { contact_id: row.contact_id, contact_name: row.contact_name, settled_on: null, lines: [], total_cents: '0' };
    current.lines.push({ id: row.id, description: row.description, installment: `${row.installment}/${row.installments}`, due_on: row.due_on, value_cents: value });
    current.total_cents = (BigInt(current.total_cents) + BigInt(value)).toString();
    if (row.payments.settled_on && (!current.settled_on || row.payments.settled_on > current.settled_on)) current.settled_on = row.payments.settled_on;
    groups.set(row.contact_id, current);
  }
  return [...groups.values()];
}
export interface ListingGroup { name: string | null; rows: FinanceTitleRow[]; amount_cents: string; balance_cents: string }
/** Listagem simples (one group) or agrupada por cliente/fornecedor, with subtotals and the total. */
export function listingGroups(rows: readonly FinanceTitleRow[], grouped: boolean): { groups: ListingGroup[]; amount_cents: string; balance_cents: string; count: number } {
  const groups = new Map<string, ListingGroup>(), add = (a: string, b: string) => (BigInt(a) + BigInt(b)).toString();
  for (const row of rows) {
    const key = grouped ? row.contact_id : '', current = groups.get(key) ?? { name: grouped ? row.contact_name : null, rows: [], amount_cents: '0', balance_cents: '0' };
    current.rows.push(row); current.amount_cents = add(current.amount_cents, row.amount_cents); current.balance_cents = add(current.balance_cents, row.cancelled ? '0' : row.balance_cents);
    groups.set(key, current);
  }
  const list = grouped ? [...groups.values()].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'pt-BR')) : [...groups.values()];
  return { groups: list, amount_cents: list.reduce((sum, item) => add(sum, item.amount_cents), '0'), balance_cents: list.reduce((sum, item) => add(sum, item.balance_cents), '0'), count: rows.length };
}
export const receiptTitle = (kind: FinanceKind) => kind === 'receivable' ? 'Recibo' : 'Comprovante de pagamento';
export const PRINT_PAGE_LIMIT = 50;
/** "Imprimir observação do contato": the Observações of up to this many contatos are read for one listagem. */
export const PRINT_NOTES_LIMIT = 200;
/** Observações of the contact register (Cadastros, 124): the record of that contato, text up to 4.000 characters or none. */
export function contactNotes(value: unknown, id: string): string {
  const v = value as { entity?: unknown; record?: { id?: unknown; notes?: unknown } } | null, r = v?.record;
  if (v?.entity !== 'contacts' || !r || r.id !== id || (r.notes !== null && r.notes !== undefined && (typeof r.notes !== 'string' || r.notes.length > 4000))) throw new Error('PRINT_CONTACT_INVALID');
  return typeof r.notes === 'string' ? r.notes.trim() : '';
}

/** Preferências > Finanças > Contas a receber "Habilitar tipo de título de crédito para impressão". */
export type CreditModel = 'duplicata' | 'nota_promissoria';
export const CREDIT_LABEL: Readonly<Record<CreditModel, string>> = { duplicata: 'Duplicata', nota_promissoria: 'Nota promissória' };
export function creditModels(preference: unknown): CreditModel[] {
  return preference === 'nota_promissoria' ? ['nota_promissoria'] : preference === 'ambos' ? ['duplicata', 'nota_promissoria'] : ['duplicata'];
}
/** A duplicata or nota promissória is printed for a conta a receber that is neither cancelled nor excluded. */
export function creditRows(rows: readonly FinanceTitleRow[]): { rows: FinanceTitleRow[]; skipped: number } {
  const eligible = rows.filter(row => row.kind === 'receivable' && !row.cancelled && !row.deleted_at);
  return { rows: eligible, skipped: rows.length - eligible.length };
}
/** Nº of the título: the nº documento (or the conta id) with the parcela when the conta has more than one. */
export function creditNumber(row: Pick<FinanceTitleRow, 'id' | 'source_reference' | 'installment' | 'installments'>): string {
  const base = row.source_reference?.trim() || row.id.slice(0, 8).toUpperCase();
  return row.installments > 1 ? `${base}/${row.installment}` : base;
}
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
/** "dez de novembro de dois mil e vinte e seis" (dia 1 = "primeiro"), as written in a nota promissória. */
export function dateInWords(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value); if (!match) throw new Error('PRINT_DATE_INVALID');
  const day = Number(match[3]), month = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error('PRINT_DATE_INVALID');
  return `${day === 1 ? 'primeiro' : numberInWords(BigInt(day))} de ${MONTHS[month - 1]} de ${numberInWords(BigInt(match[1]))}`;
}
