// Leva H, lane financeiro (SQL 372: FIN-176, FIN-180, FIN-182): as contas que uma nova remessa pode incluir, sem envio bancário real.
// A lista mostra só os títulos em aberto que não estão em outra remessa, com os filtros Forma de pagamento (inativas marcadas) e
// conta financeira da cobrança, com a opção explícita de incluir os títulos sem conta. Nada é incluído sozinho: o usuário escolhe e
// remove cada título, até 30 por remessa; os demais ficam para remessas adicionais.
import { operationalId, precedingUuid } from './cnab-operational-model.ts';
import { CNAB_V2_BASE } from './cnab-operational-v2-model.ts';

export const REMITTANCE_LIMIT = 30;
export interface RemittanceCandidateRow { payer_ready: boolean; account_id: string | null; account_name: string | null; payment_method_id: string | null; payment_method_name: string | null }
export interface RemittanceCandidates {
  eligible_total: number; payment_methods: { id: string; description: string; active: boolean; linked: boolean }[]; rows: Map<string, RemittanceCandidateRow>;
}
const invalid = (): never => { throw new Error('Não foi possível conferir os títulos disponíveis para a remessa.'); };
const nullableText = (value: unknown, max: number) => value === null || (typeof value === 'string' && value.length <= max);

export function remittanceCandidatesPath({ query, after, method, account, withoutAccount }: { query: string; after: string | null; method: string | null; account: string | null; withoutAccount: boolean }) {
  const params = new URLSearchParams({ limit: '15', sem_conta: String(withoutAccount) });
  if (query.trim()) params.set('q', query.trim());
  if (after) params.set('after', after);
  if (method) params.set('forma', method);
  if (account) params.set('conta', account);
  return `/v1/financeiro/remessa-candidatos?${params}`;
}
/** The extras of the candidates page (the rows themselves are read by operationalTitles). */
export function remittanceCandidates(value: unknown): RemittanceCandidates {
  const v = value as { eligible_total?: unknown; remittance_limit?: unknown; payment_methods?: unknown; items?: unknown } | null;
  if (!v || typeof v !== 'object' || !Number.isSafeInteger(v.eligible_total) || (v.eligible_total as number) < 0 || v.remittance_limit !== REMITTANCE_LIMIT || !Array.isArray(v.payment_methods) || !Array.isArray(v.items)) invalid();
  const methods = (v!.payment_methods as Record<string, unknown>[]).map(item => {
    if (!item || !operationalId(item.id) || typeof item.description !== 'string' || typeof item.active !== 'boolean' || typeof item.linked !== 'boolean') invalid();
    return { id: item.id as string, description: item.description as string, active: item.active as boolean, linked: item.linked as boolean };
  });
  const rows = new Map<string, RemittanceCandidateRow>();
  for (const row of v!.items as Record<string, unknown>[]) {
    if (!row || !operationalId(row.id) || typeof row.payer_ready !== 'boolean' || (row.account_id !== null && !operationalId(row.account_id)) || !nullableText(row.account_name, 200)
      || (row.payment_method_id !== null && !operationalId(row.payment_method_id)) || !nullableText(row.payment_method_name, 200)) invalid();
    rows.set(row.id as string, { payer_ready: row.payer_ready as boolean, account_id: row.account_id as string | null, account_name: row.account_name as string | null,
      payment_method_id: row.payment_method_id as string | null, payment_method_name: row.payment_method_name as string | null });
  }
  return { eligible_total: v!.eligible_total as number, payment_methods: methods, rows };
}
/** "N títulos disponíveis; esta remessa leva até 30" and how many remessas adicionais the rest needs. */
export function remittanceLimitText(eligible: number, selected: number) {
  if (eligible === 0) return 'Nenhum título em aberto disponível com estes filtros. Títulos já incluídos em outra remessa não aparecem.';
  const rest = Math.max(0, eligible - REMITTANCE_LIMIT), extra = Math.ceil(rest / REMITTANCE_LIMIT);
  return `${eligible} título(s) em aberto disponível(is), fora de outras remessas. Cada remessa leva até ${REMITTANCE_LIMIT}; ${selected} selecionado(s).`
    + (extra ? ` Os demais ficam para ${extra} remessa(s) adicional(is).` : '');
}
/** FIN-176: the remessa of a given id through the files list (ordered by id): the first file after the preceding id. */
export function remittanceByIdPath(id: string) {
  const after = precedingUuid(id), params = new URLSearchParams({ limit: '1' });
  if (after) params.set('after', after);
  return `${CNAB_V2_BASE}/remittances?${params}`;
}
