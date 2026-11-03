import { useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { planBatch, type BatchItem, type BatchResult, type BatchStep } from '../lib/origin-batch';
import { rowLabel, type DocumentListRow } from '../lib/document-list-model';
import { reverseDocumentInput, type DocumentFinancePage, type PostingDetail, type PostingPreview, type ReversalPreview } from '../lib/document-finance-model';
import type { DocumentEnvelope, DocumentRecord } from '../lib/real-documents-model';
import { PURCHASE_RECEIPTS_BASE, purchaseReceiptIntent, purchaseReceiptPreview, purchaseReceiptResult, purchaseReceiptsPage } from '../lib/purchase-receipts-model';
import { selectableWarehouses } from '../lib/stock-supply-model';
import { pendingItems } from './PurchaseStockLaunch';
import { useStockWarehouseOptions } from './StockSupplierPicker';
import { BatchDialog } from './BatchDialog';
import { PURCHASE_EFFECT_LABELS, purchaseEffectSkip, type PurchaseEffectAction } from '../lib/purchase-effects-batch-model';
export { PURCHASE_EFFECT_LABELS, PURCHASE_EFFECT_ROLES, purchaseEffectSkip, type PurchaseEffectAction } from '../lib/purchase-effects-batch-model';

// Estoque lane, onda F (EST-024): Origin "Pedidos de compra" selection panel, the conditional actions Lançar estoque, Estornar estoque,
// Lançar contas and Estornar contas. Each pedido runs alone, with its own command and its own version, through the same routes as its
// ⋮ action (recebimento of the pending quantities, estorno of every recebimento, contas with the category and the parcelas of the
// pedido, estorno of its contas). An unknown outcome keeps the command: "Tentar novamente" repeats exactly the same one.
type Item = BatchItem & { row: DocumentListRow };
type Stored = { path: string; method: 'POST'; body: Record<string, unknown>; settle: (raw: unknown) => void; via: 'purchaseReceipts' | 'stock' | 'documentFinance' };
const UNCERTAIN = 'Resultado não confirmado: use “Tentar novamente” para repetir o mesmo comando (não lança de novo).';
const refused = (error: unknown, action: PurchaseEffectAction) => error instanceof AccessError ? error.status === 409 ? 'O pedido mudou em outra operação (ou o saldo não permite). Atualize a lista e confira o pedido.'
  : error.status === 403 ? 'Seu perfil não permite esta ação.' : error.status === 404 ? 'O pedido não está mais disponível.'
    : action.startsWith('stock') ? 'O estoque deste pedido não pode ser lançado ou estornado assim; confira o pedido.' : 'As contas deste pedido não podem ser lançadas ou estornadas assim; confira o pedido.'
  : error instanceof Error && error.message ? error.message : 'Não foi possível concluir.';
export default function PurchaseEffectsBatch({ controller, action, rows, onClose }: {
  controller: AccessController; action: PurchaseEffectAction; rows: readonly DocumentListRow[]; onClose: (changed: boolean) => void;
}) {
  const warehouses = useStockWarehouseOptions(controller);
  const [warehouse, setWarehouse] = useState(''), [round, setRound] = useState(0), [retry, setRetry] = useState<string[] | null>(null);
  const stored = useRef(new Map<string, Stored>()), changed = useRef(false);
  const fallback = warehouse || warehouses.options.find(option => option.is_default && option.active)?.id || '';
  const items: Item[] = rows.filter(row => !retry || retry.includes(row.id)).map(row => ({ id: row.id, label: rowLabel('purchase_orders', row), row }));
  const plan = planBatch(items, item => stored.current.has(item.id) ? null : purchaseEffectSkip(action, item.row));
  // One mutation: the stored command is sent again as it is when its first answer was lost.
  const send = async (id: string, command: Stored): Promise<BatchStep> => {
    stored.current.set(id, command);
    let raw: unknown;
    try { raw = await (controller[command.via] as (path: string, options: { method: 'POST'; body: unknown }) => Promise<unknown>)(command.path, { method: command.method, body: command.body }); }
    catch (error) {
      if (error instanceof AccessError && [400, 403, 404, 409].includes(error.status)) { stored.current.delete(id); throw new Error(refused(error, action)); }
      return { uncertain: true, message: UNCERTAIN };
    }
    try { command.settle(raw); } catch { return { uncertain: true, message: UNCERTAIN }; }
    stored.current.delete(id); changed.current = true; return;
  };
  const run = async ({ id, row }: Item): Promise<BatchStep> => {
    const again = stored.current.get(id);
    if (again) return send(id, again);
    try {
      if (action === 'stock-post') {
        const current = purchaseReceiptsPage(await controller.purchaseReceipts(`${PURCHASE_RECEIPTS_BASE}/${id}?limit=25`), id).current;
        if (current.document.mode === 'legacy_full') throw new Error('O estoque deste pedido foi lançado pelo documento inteiro.');
        if (!current.document.eligible) throw new Error('A situação do pedido não permite lançar o estoque.');
        const pending = pendingItems(current);
        if (!pending.items.length) throw new Error('Não há quantidade pendente para lançar neste pedido.');
        const fixed = current.document.warehouse_id;
        if (!fixed && !fallback) throw new Error('Escolha o depósito para os pedidos sem depósito.');
        // The date follows Preferências › Suprimentos › Estoque (277): the preview goes without one and the server dates it.
        const body = { expected_document_version: current.document.version, occurred_on: null, reason: `Lançamento de estoque do pedido de compra nº ${current.document.number}`, items: pending.items, ...(fixed ? {} : { warehouse_id: fallback }) };
        const preview = purchaseReceiptPreview(await controller.purchaseReceipts(`${PURCHASE_RECEIPTS_BASE}/${id}/preview`, { method: 'POST', body }), id, body, null);
        const intent = purchaseReceiptIntent(current.document, preview, crypto.randomUUID(), true);
        return send(id, { via: 'purchaseReceipts', path: intent.path, method: 'POST', body: intent.body as unknown as Record<string, unknown>, settle: raw => { purchaseReceiptResult(raw, intent); } });
      }
      if (action === 'stock-reverse') {
        return send(id, { via: 'stock', path: `/v1/estoque/compras/${id}/estorno`, method: 'POST', body: { command_id: crypto.randomUUID(), expected_version: row.version },
          settle: raw => { const value = raw as { document_id?: unknown; reversed?: unknown }; if (value?.document_id !== id || !Array.isArray(value.reversed)) throw new AccessError(502); } });
      }
      const record = ((await controller.documents(`/v1/documentos/purchase_orders/${id}`)) as DocumentEnvelope).document as DocumentRecord;
      if (record?.id !== id) throw new AccessError(502);
      const base = `/v1/documentos/purchase_orders/${id}/financeiro`;
      if (action === 'finance-post') {
        // Origin "Lançar contas" of the list: the category and the parcelas of the pedido (a pedido without parcelas is launched by itself).
        if (!record.installments.length) throw new Error('O pedido não tem parcelas; lance as contas pelo pedido.');
        const input = { expected_document_version: record.version, category_id: null, installments: null };
        const preview = ((await controller.documentFinance(`${base}/preview`, { method: 'POST', body: input })) as { preview: PostingPreview }).preview;
        if (preview?.document_id !== id || preview.document_version !== record.version || typeof preview.preview_hash !== 'string') throw new AccessError(502);
        return send(id, { via: 'documentFinance', path: `${base}/post`, method: 'POST', body: { ...input, preview_hash: preview.preview_hash, command_id: crypto.randomUUID() }, settle: () => undefined });
      }
      const page = (await controller.documentFinance(`${base}?limit=25`)) as DocumentFinancePage;
      if (!page?.active_posting) throw new Error('Não há contas lançadas neste pedido.');
      const detail = (await controller.documentFinance(`${base}/${page.active_posting.id}`)) as PostingDetail;
      const reversal = ((await controller.documentFinance(`${base}/${detail.posting.id}/reverse-preview`, { method: 'POST', body: { expected_document_version: record.version, expected_posting_version: detail.posting.version } })) as { preview: ReversalPreview }).preview;
      const input = reverseDocumentInput(record, reversal, `Estorno das contas do pedido de compra nº ${record.number}`);
      return send(id, { via: 'documentFinance', path: `${base}/${detail.posting.id}/reverse`, method: 'POST', body: { ...input, command_id: crypto.randomUUID() }, settle: () => undefined });
    } catch (error) { throw new Error(refused(error, action)); }
  };
  const close = (results: BatchResult[] | null) => { if (results === null || !results.some(result => result.outcome === 'uncertain')) onClose(changed.current); else onClose(true); };
  const help = { 'stock-post': 'Cada pedido recebe toda a quantidade pendente no depósito do pedido, com a data de Preferências › Suprimentos › Estoque, por um comando próprio.',
    'stock-reverse': 'Cada pedido estorna todos os recebimentos ativos, cada um no depósito em que foi recebido, com a data de hoje. Ou todos do pedido, ou nenhum.',
    'finance-post': 'Cada pedido lança as contas a pagar com a categoria e as parcelas do próprio pedido.',
    'finance-reverse': 'Cada pedido estorna as contas que lançou (contas liquidadas ou com cobrança CNAB não são estornadas).' }[action];
  return <BatchDialog key={round} title={`${PURCHASE_EFFECT_LABELS[action]} dos pedidos selecionados`} confirmLabel={PURCHASE_EFFECT_LABELS[action]} plan={plan} run={run} onClose={close}
    onRetry={ids => { setRetry(ids); setRound(value => value + 1); }}
    description={<div className="documents-batch-form">
      {action === 'stock-post' && plan.eligible.some(item => !item.row.warehouse_id) && <div className="form-field"><label htmlFor="purchase-batch-warehouse">Depósito (pedidos sem depósito)</label>
        <select id="purchase-batch-warehouse" value={fallback} onChange={event => setWarehouse(event.target.value)}><option value="">Selecione</option>
          {selectableWarehouses(warehouses.options, fallback).map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></div>}
      <p className="real-help">{help}</p></div>} />;
}
