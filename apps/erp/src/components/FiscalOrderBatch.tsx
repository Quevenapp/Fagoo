import { useMemo, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { planBatch, type BatchItem, type BatchStep } from '../lib/origin-batch';
import { OrderBatchRefusal, loadBatchBasis, orderInvoiceBody, saveOrderInvoice, type BatchBasis } from '../lib/fiscal-order-batch';
import { BatchDialog } from './BatchDialog';

export type OrderBatchRow = { id: string; number: string; status: string; contact_name?: string | null; invoice?: unknown; invoice_linked?: boolean };
type Item = BatchItem & { row: OrderBatchRow };
const MAX = 100;
const actorOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.user_id ?? null;
const roleOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.role ?? '';
/** Profiles that write notes (admin e fiscal) and therefore generate them from the pedidos. */
export const ORDER_BATCH_ROLES = ['admin', 'fiscal'];
/**
 * Why "Gerar nota fiscal agrupando" cannot group the selected ordens de serviço, or null: only the administrador reads OS and writes
 * notes; 2 to 20 OS of the same cliente, none cancelled or already with a note.
 */
export function groupedInvoiceReason(role: string, rows: readonly (OrderBatchRow & { contact_id?: string | null })[]): string | null {
  if (role !== 'admin') return 'A nota das ordens de serviço é gerada pelo administrador (o perfil fiscal não lê ordens de serviço).';
  if (rows.length < 2) return 'Selecione duas ou mais ordens de serviço do mesmo cliente.';
  if (rows.length > 20) return 'Agrupe até 20 ordens de serviço por nota.';
  if (new Set(rows.map(r => r.contact_id ?? '')).size > 1) return 'As ordens de serviço agrupadas precisam ser do mesmo cliente.';
  if (rows.some(r => r.status === 'cancelled')) return 'Há ordem de serviço cancelada na seleção.';
  if (rows.some(r => r.invoice || r.invoice_linked)) return 'Há ordem de serviço que já tem nota fiscal.';
  return null;
}
// One command id per pedido and model while the page lives: a result not confirmed is repeated with the same id, never duplicated.
const SHARED = new Map<string, string>();
const commandFor = (commands: Map<string, string>, documentId: string, model: string) => { const key = `${model}:${documentId}`; let id = commands.get(key); if (!id) { id = crypto.randomUUID(); commands.set(key, id); } return id; };

/**
 * Origin "Gerar NF-e dos pedidos selecionados" (painel) e "Mais ações › Gerar: NFC-es selecionadas": uma nota de homologação por pedido,
 * como "Gerar nota fiscal" do menu ⋮, com o relatório Número | Motivo. A emissão automática depois do lote fica desligada.
 */
export default function FiscalOrderBatch({ controller, model, rows, today, onClose, commands = SHARED }: { controller: AccessController; model: '55' | '65'; rows: readonly OrderBatchRow[]; today: string; onClose: (changed: boolean) => void; commands?: Map<string, string> }) {
  const actor = useRef(actorOf(controller)), basis = useRef<Promise<BatchBasis> | null>(null), changed = useRef(false);
  // Origin "Tentar novamente": a new round with the pedidos that failed or were not confirmed (same command ids, never duplicated).
  const [round, setRound] = useState<{ count: number; ids: readonly string[] | null }>({ count: 0, ids: null });
  const plan = useMemo(() => planBatch<Item>(rows.filter(row => !round.ids || round.ids.includes(row.id)).map(row => ({ id: row.id, label: `Pedido nº ${row.number}${row.contact_name ? ` · ${row.contact_name}` : ''}`, row })), item => {
    const index = rows.findIndex(r => r.id === item.id);
    if (index >= MAX) return `No máximo ${MAX} pedidos por lote.`;
    if (item.row.status === 'cancelled') return 'O pedido está cancelado.';
    if (item.row.invoice || item.row.invoice_linked) return 'O pedido já tem nota fiscal.';
    return null;
  }), [rows, round]);
  const fetch = (path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }) => controller.fiscalInvoices(path, options as Parameters<AccessController['fiscalInvoices']>[1]);
  const run = async (item: Item): Promise<BatchStep> => {
    if (actorOf(controller) !== actor.current || !ORDER_BATCH_ROLES.includes(roleOf(controller))) throw new Error('A sessão ou o perfil mudou. Nada mais foi gravado.');
    basis.current ??= loadBatchBasis(fetch, model);
    let body: Awaited<ReturnType<typeof orderInvoiceBody>>;
    try { body = await orderInvoiceBody(fetch, await basis.current, item.id, model, today); }
    catch (problem) {
      if (problem instanceof OrderBatchRefusal) throw new Error(`Motivo: ${problem.message}`);
      if (problem instanceof AccessError && problem.status === 404) throw new Error('Pedido não encontrado.');
      if (problem instanceof AccessError && problem.status === 403) throw new Error('Seu perfil não gera notas deste pedido.');
      basis.current = null; throw new Error('Não foi possível montar a nota do pedido. Nada foi gravado.');
    }
    const command = commandFor(commands, item.id, model);
    try {
      const saved = await saveOrderInvoice(fetch, body, command);
      commands.delete(`${model}:${item.id}`); changed.current = true;
      return { message: `Nota salva em homologação (sem número, sem envio)${body.services ? `; ${body.services} serviço(s) da OS ficaram fora` : ''}. Versão ${saved.version}.` };
    } catch (problem) {
      if (problem instanceof AccessError && problem.status === 409) { commands.delete(`${model}:${item.id}`); throw new Error('Motivo: O pedido já tem nota fiscal (gerada em outra aba ou por outro usuário).'); }
      if (problem instanceof AccessError && [400, 403].includes(problem.status)) { commands.delete(`${model}:${item.id}`); throw new Error(problem.status === 403 ? 'Seu perfil não grava notas fiscais.' : 'O servidor recusou a nota montada a partir do pedido. Gere-a pelo menu ⋮ para conferir os campos.'); }
      return { uncertain: true, message: 'Resultado não confirmado. Use "Tentar novamente": o mesmo comando é repetido e a nota não se duplica.' };
    }
  };
  const kind = model === '65' ? 'NFC-e' : 'nota(s)';
  return <BatchDialog key={round.count} title={model === '65' ? 'Gerar NFC-es' : 'Gerar notas fiscais'} confirmLabel="Gerar" plan={plan} run={run} onClose={() => onClose(changed.current)}
    onRetry={ids => setRound(current => ({ count: current.count + 1, ids }))}
    progressLabel={(current, count) => `Gerando notas fiscais… ${current} de ${count}`}
    description={<><p>Deseja realmente gerar {kind} de {plan.eligible.length} venda(s) selecionada(s)?</p>
      <p className="real-help">Cada nota é montada como "Gerar nota fiscal" do pedido, com o cálculo automático dos impostos, e fica em Testes de homologação do FAGOO, sem número e sem envio à SEFAZ.
        A emissão automática depois da geração em lote fica desligada. Nenhum estoque ou conta é lançado.</p></>} />;
}
