// Origin "Condição de pagamento" + "Gerar parcelas" (pedido, proposta e OS). Local form helper only: the plan becomes
// the document's planned installments when the user saves; no title, boleto or financial effect is created here.
import { calculateDocument, type DocumentInput, type InstallmentInput } from './real-documents-model.ts';
import { addDays, parseIso } from './origin-list.ts';

export const CONDITION_HELP = 'Forma de pagamento cadastrada ou número de parcelas ou prazos. Exemplo 30, 60, 3x ou 15 +2x.';
export const PROPOSAL_CONDITION_HELP = 'Exemplos: 30 (30 dias direto); 30 60 90 (vencimentos em 30,60 e 90 dias); 6x (6 parcelas iguais a cada 30 dias)';
const MAX_INSTALLMENTS = 120, MAX_DAYS = 3650;
const INVALID = 'Informe a condição como no Origin: 30, 30 60 90, 3x ou 15 +2x.';

/**
 * Days after the base date of each installment:
 * - "30" or "30 60 90" (also separated by "," "/" or ";"): one installment per term, in non-decreasing order;
 * - "3x": three installments every 30 days (30, 60, 90);
 * - "15 +2x": a first installment at 15 days plus two more every 30 days (15, 45, 75).
 */
export function conditionDays(text: string): number[] {
  const value = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!value || value.length > 200) throw new Error(INVALID);
  let days: number[];
  const entry = /^(\d{1,4}) ?\+ ?(\d{1,3}) ?x$/.exec(value), equal = /^(\d{1,3}) ?x$/.exec(value);
  if (entry) { const first = Number(entry[1]), count = Number(entry[2]); days = Array.from({ length: count + 1 }, (_, index) => first + index * 30); }
  else if (equal) { const count = Number(equal[1]); days = Array.from({ length: count }, (_, index) => (index + 1) * 30); }
  else if (/^\d{1,4}(?:(?: ?[,;/] ?| )\d{1,4})*$/.test(value)) days = value.split(/ ?[,;/] ?| /).map(Number);
  else throw new Error(INVALID);
  if (!days.length || days.length > MAX_INSTALLMENTS) throw new Error(`Informe de 1 a ${MAX_INSTALLMENTS} parcelas.`);
  if (days.some((day, index) => day > MAX_DAYS || (index > 0 && day < days[index - 1]!))) throw new Error(`Use prazos em ordem crescente, de 0 a ${MAX_DAYS} dias.`);
  return days;
}

/**
 * Equal installments in exact cents (the first ones absorb the remainder, as the finance planner does).
 * `baseLabel` names the Preferências base date ("Data para geração de parcelas") when it is not the document date;
 * `freightFirst` is "Cobrar frete na primeira parcela": the freight goes whole into the first installment.
 */
export function conditionInstallments(input: DocumentInput, text: string, baseDate: string, { baseLabel = null, freightFirst = false }: { baseLabel?: string | null; freightFirst?: boolean } = {}): InstallmentInput[] {
  const days = conditionDays(text);
  if (!parseIso(baseDate)) throw new Error(baseLabel ? `Preencha o campo ${baseLabel} antes de gerar as parcelas.` : 'Informe a data do documento antes de gerar as parcelas.');
  let total: string, freight: string;
  try { const totals = calculateDocument(input); total = totals.total; freight = totals.freight; } catch { throw new Error('Confira os itens, descontos, frete e despesas do documento antes de gerar as parcelas.'); }
  const first = freightFirst ? BigInt(freight.replace('.', '')) : 0n, cents = BigInt(total.replace('.', '')) - first, count = BigInt(days.length);
  if (cents < count) throw new Error('Cada parcela precisa ter pelo menos R$ 0,01. Confira o total ou a condição.');
  return days.map((day, index) => {
    const due = addDays(baseDate, day);
    if (due > '2099-12-31') throw new Error('Todos os vencimentos devem ficar até 31/12/2099.');
    const amount = cents / count + (BigInt(index) < cents % count ? 1n : 0n) + (index === 0 ? first : 0n);
    return { due_date: due, amount: `${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`, method: null, note: null, payment_reference: null };
  });
}

/** Parcelas "Dias" column: difference to the base date (negative when the due date is earlier). */
export function daysFrom(baseDate: string, due: string): string {
  const base = parseIso(baseDate), target = parseIso(due);
  if (!base || !target) return '';
  return String(Math.round((Date.UTC(target[0], target[1] - 1, target[2]) - Date.UTC(base[0], base[1] - 1, base[2])) / 86_400_000));
}
export function dueFromDays(baseDate: string, days: string): string | null {
  if (!/^\d{1,4}$/.test(days.trim()) || !parseIso(baseDate) || Number(days) > MAX_DAYS) return null;
  const due = addDays(baseDate, Number(days));
  return due <= '2099-12-31' ? due : null;
}
