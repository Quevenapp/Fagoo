import { calculateDocument, type DocumentInput, type InstallmentInput } from './real-documents-model.ts';
import { installmentPlan } from './real-finance-model.ts';

export type DocumentMonthlyPlan = {
  basis: string;
  count: string;
  firstDue: string;
  total: string;
  installments: InstallmentInput[];
};

// This is a local form snapshot, never a persisted command or a financial title.
export const documentPlanBasis = (source: string, input: DocumentInput): string => JSON.stringify([source, input]);

export function monthlyDocumentPlan(source: string, input: DocumentInput, count: string, firstDue: string): DocumentMonthlyPlan {
  if (!/^(?:[1-9]\d?|1[01]\d|120)$/.test(count)) throw new Error('Informe uma quantidade de 1 a 120 parcelas.');
  let total: string;
  try { total = calculateDocument(input).total; }
  catch { throw new Error('Confira os itens, descontos, frete e despesas do documento antes de gerar as parcelas.'); }
  if (!/^\d+\.\d{2}$/.test(total) || !/^(19|20)\d{2}-\d{2}-\d{2}$/.test(input.date)) throw new Error('Confira a data e o total do documento.');
  const cents = BigInt(total.replace('.', ''));
  if (cents < BigInt(count)) throw new Error('Cada parcela precisa ter pelo menos R$ 0,01. Reduza a quantidade ou confira o total.');
  let plan;
  try { plan = installmentPlan(cents.toString(), count, firstDue, input.date); }
  catch { throw new Error('Informe um primeiro vencimento válido, igual ou posterior à data do documento.'); }
  if (plan.some(row => row.due_on > '2099-12-31')) throw new Error('Todos os vencimentos devem ficar até 31/12/2099.');
  return {
    basis: documentPlanBasis(source, input), count, firstDue, total,
    installments: plan.map(row => {
      const amount = BigInt(row.amount_cents);
      return { due_date: row.due_on, amount: `${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`, method: null, note: null, payment_reference: null };
    }),
  };
}

export function applyMonthlyDocumentPlan(source: string, input: DocumentInput, reviewed: DocumentMonthlyPlan): InstallmentInput[] {
  if (reviewed.basis !== documentPlanBasis(source, input)) throw new Error('O documento mudou. Confira novamente as parcelas.');
  // Recompute from the current form; a retained handler cannot apply an old total.
  return monthlyDocumentPlan(source, input, reviewed.count, reviewed.firstDue).installments;
}
