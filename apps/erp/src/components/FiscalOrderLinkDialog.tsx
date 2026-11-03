import { DOCUMENT_MIRROR_READ_ONLY, isDocumentMirror } from '../lib/document-mirror-model';
import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { invoiceRecord, type InvoiceRecord } from '../../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { FISCAL_BASE, invoiceNumber, type ListRow } from '../lib/fiscal-invoice-list-model';
import { compatible, defaultLinkLines, linkLineItems, linkLineProblems, linkSummary, orderItemsState, qty, qtyText, type LinkLine, type OrderItemsState } from '../lib/fiscal-order-item-links';
import { EMPTY_LIST_FILTERS, documentListQuery, readDocumentListPage } from '../lib/document-list-model';
import type { DocumentEnvelope, DocumentRecord, DocumentSummary } from '../lib/real-documents-model';
import { Modal } from './Modal';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const actorOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.user_id ?? null;
const roleOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.role ?? '';
type Body = { expected_version: number; action: 'link' | 'unlink'; document_id: string; items?: { position: number; document_item_id: string; quantity: string }[] };
type Command = { id: string; actor: string | null; body: Body; uncertain: boolean };
const refusal = (problem: AccessError) => problem.field === 'link_item_exceeds' ? 'As quantidades passam do que falta vincular no pedido ou da quantidade do item da nota (outra nota pode ter vinculado antes). Recarregue e confira.'
  : problem.field === 'link_item_product' ? 'Um item da nota é de outro produto que o item do pedido.'
    : problem.status === 409 ? 'A nota mudou, já tem este vínculo ou está travada pelo pedido de venda. Recarregue e confira.' : problem.status === 403 ? 'Seu perfil não altera notas fiscais.' : 'O servidor recusou o vínculo.';

/**
 * "Vincular à pedido de compra" / "Desvincular pedido compra" (Origin Mais ações): one note, one order per command. Wave F (202610200275):
 * the link is item a item — which item of the note fulfils which item of the pedido and how much — with the summary of the items linked
 * and still to link; without quantities the whole pedido is linked, as before. Reading the order uses the documents API of its own lane.
 */
export default function FiscalOrderLinkDialog({ controller, row, mode, onClose }: { controller: AccessController; row: ListRow; mode: 'link' | 'unlink'; onClose: (changed: boolean) => void }) {
  const [record, setRecord] = useState<InvoiceRecord | null>(null), [query, setQuery] = useState(''), [orders, setOrders] = useState<DocumentSummary[]>([]), [order, setOrder] = useState<DocumentRecord | null>(null);
  const [lines, setLines] = useState<LinkLine[]>([]), [proposal, setProposal] = useState(''), [linkedItems, setLinkedItems] = useState<Record<string, OrderItemsState | null>>({});
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [changed, setChanged] = useState(false);
  const command = useRef<Command | null>(null), life = useRef(new AbortController()), search = useRef<AbortController | null>(null), picking = useRef<AbortController | null>(null), actor = useRef(actorOf(controller));
  useEffect(() => { const current = life.current; return () => { current.abort(); search.current?.abort(); picking.current?.abort(); }; }, []);
  const load = async () => {
    const value = await controller.fiscalInvoices(`${FISCAL_BASE}/${row.id}`, { signal: life.current.signal }) as { invoice: unknown };
    const loaded = invoiceRecord(value?.invoice); if (loaded.id !== row.id) throw new AccessError(502);
    if (!life.current.signal.aborted) setRecord(loaded);
  };
  useEffect(() => { void load().catch(problem => { if (!aborted(problem)) setError('Não foi possível carregar a nota. Feche e tente novamente.'); }); }, [controller, row.id]);
  const readItems = (documentId: string, signal: AbortSignal) => controller.fiscalInvoices(`${FISCAL_BASE}/${row.id}/pedidos/${documentId}`, { signal }).then(value => orderItemsState(value, row.id, documentId));
  // Desvincular: the item links of each linked pedido, for the summary (a pedido that cannot be read shows only its number).
  const linkedKey = record ? record.orders.map(o => o.id).join(',') : '';
  useEffect(() => {
    if (mode !== 'unlink' || !record || !record.orders.length) return;
    const request = new AbortController();
    void Promise.all(record.orders.map(o => readItems(o.id, request.signal).then(state => [o.id, state] as const).catch(() => [o.id, null] as const)))
      .then(entries => { if (!request.signal.aborted) setLinkedItems(Object.fromEntries(entries)); });
    return () => request.abort();
  }, [controller, mode, linkedKey]);
  const find = async () => {
    search.current?.abort(); const request = new AbortController(); search.current = request; setError('');
    try {
      const params = documentListQuery('purchase_orders', { ...EMPTY_LIST_FILTERS, query }, { page: 1 });
      params.set('origin', 'brufap');
      const page = readDocumentListPage(await controller.documents(`/v1/documentos/purchase_orders?${params}`, { signal: request.signal }), 'purchase_orders', 1, 'date_desc');
      if (!request.signal.aborted) setOrders(page.items.filter(item => !isDocumentMirror(item)).slice(0, 20));
    } catch (problem) {
      if (request.signal.aborted || aborted(problem)) return;
      setOrders([]); setError(problem instanceof AccessError && problem.status === 403 ? 'Seu perfil não consulta pedidos de compra.' : problem instanceof Error && !(problem instanceof AccessError) ? problem.message : 'Não foi possível pesquisar os pedidos de compra.');
    }
  };
  // Picking an order reads it and what the other notes already link of each of its items; a later pick drops an earlier answer.
  const pick = async (summary: DocumentSummary) => {
    if (!record || command.current) return;
    picking.current?.abort(); const request = new AbortController(); picking.current = request; setError(''); setNotice('');
    try {
      const value = await controller.documents(`/v1/documentos/purchase_orders/${summary.id}`, { signal: request.signal }) as DocumentEnvelope;
      if (value?.document?.id !== summary.id || !Array.isArray(value.document.items)) throw new AccessError(502);
      if (isDocumentMirror(value.document)) { setError(DOCUMENT_MIRROR_READ_ONLY); return; }
      const state = await readItems(summary.id, request.signal);
      if (request.signal.aborted) return;
      const next = defaultLinkLines(record.items, value.document.items, state.others);
      setOrder(value.document); setLines(next); setProposal(JSON.stringify(next.map(l => [l.position, l.quantity])));
    } catch (problem) { if (!request.signal.aborted && !aborted(problem)) setError('Não foi possível ler o pedido de compra.'); }
  };
  const send = async () => {
    const op = command.current; if (!op || busy) return;
    if (actorOf(controller) !== op.actor || !['admin', 'fiscal'].includes(roleOf(controller))) { command.current = null; setUncertain(false); setError('A sessão ou o perfil mudou. Nada foi enviado.'); return; }
    setBusy(true); setError('');
    try {
      const value = await controller.fiscalInvoices(`${FISCAL_BASE}/${row.id}/pedidos`, { method: 'POST', body: { ...op.body, command_id: op.id }, signal: life.current.signal }) as { invoice: unknown; items?: unknown; removed_items?: unknown };
      if (life.current.signal.aborted) return;
      const saved = invoiceRecord(value?.invoice);
      if (saved.id !== row.id || saved.version !== op.body.expected_version + 1 || saved.orders.some(o => o.id === op.body.document_id) !== (op.body.action === 'link')) throw new AccessError(502);
      const items = Array.isArray(value.items) ? value.items.length : 0, removed = Number.isInteger(value.removed_items) ? value.removed_items as number : 0;
      if (op.body.items && items !== op.body.items.length) throw new AccessError(502);
      command.current = null; setUncertain(false); setRecord(saved); setChanged(true); setOrder(null); setLines([]); setProposal('');
      setNotice(op.body.action === 'link' ? (items ? `Nota vinculada ao pedido de compra, ${items} item(ns) vinculado(s).` : 'Nota vinculada ao pedido de compra inteiro.')
        : `Pedido de compra desvinculado da nota${removed ? ` (${removed} item(ns) vinculado(s) removido(s))` : ''}.`);
    } catch (problem) {
      if (life.current.signal.aborted || aborted(problem)) return;
      if (!op.uncertain && problem instanceof AccessError && [400, 403, 404, 409].includes(problem.status)) { command.current = null; setError(refusal(problem)); }
      else { op.uncertain = true; setUncertain(true); setError('Não foi possível confirmar o resultado. Use "Conferir resultado" para repetir o mesmo comando.'); }
    } finally { if (!life.current.signal.aborted) setBusy(false); }
  };
  const problems = record && order ? linkLineProblems(lines, record.items) : [];
  const start = (action: 'link' | 'unlink', documentId: string) => {
    if (!record || command.current || (action === 'link' && problems.length)) return;
    const items = action === 'link' ? linkLineItems(lines) : [];
    command.current = { id: crypto.randomUUID(), actor: actor.current, body: { expected_version: record.version, action, document_id: documentId, ...(items.length ? { items } : {}) }, uncertain: false }; void send();
  };
  const linked = record?.orders ?? [];
  const summary = linkSummary(lines);
  const edited = Boolean(order) && JSON.stringify(lines.map(l => [l.position, l.quantity])) !== proposal;
  // Changed quantities or a link whose outcome is unknown ask before leaving.
  const guard = useUnsavedChanges(uncertain || edited, busy);
  const close = () => { if (!busy) guard.confirmLeave(() => onClose(changed)); };
  const setLine = (index: number, change: Partial<LinkLine>) => setLines(current => current.map((l, i) => i === index ? { ...l, ...change } : l));
  return <Modal title={mode === 'link' ? 'Vincular à pedido de compra' : 'Desvincular pedido compra'} onClose={close}
    actions={<>{uncertain ? <button type="button" className="primary-button" disabled={busy} onClick={() => void send()}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button>
      : mode === 'link' && order && <button type="button" className="primary-button" disabled={busy || !record || linked.some(o => o.id === order.id) || problems.length > 0} onClick={() => start('link', order.id)}>{busy ? 'Vinculando…' : 'Vincular'}</button>}
      <button type="button" className="secondary-button" disabled={busy} onClick={close}>Fechar</button></>}>
    <div className="fiscal-order-link">
      <p>Nota {invoiceNumber(row)} · {row.name ?? 'Sem nome'}</p>
      {error && <p className="real-alert" role="alert">{error}</p>}
      {notice && <p className="real-success" role="status">{notice}</p>}
      {!record && !error && <p role="status">Carregando a nota…</p>}
      {record && <section aria-label="Pedidos vinculados"><h3>Pedidos de compra vinculados</h3>
        {linked.length ? <ul className="fiscal-linked-orders">{linked.map(o => { const state = linkedItems[o.id];
          return <li key={o.id}>Pedido {o.number}{o.contact_name ? ` · ${o.contact_name}` : ''}
            {mode === 'unlink' && state && <span className="real-help"> · {state.items.length ? `${state.items.filter(i => i.valid).length} item(ns) vinculado(s)${state.items.some(i => !i.valid) ? `, ${state.items.filter(i => !i.valid).length} sem valer (item mudou)` : ''}` : 'pedido inteiro'} · {state.state === 'linked' ? 'Vinculado' : state.state === 'partial' ? 'Parcial' : 'Não vinculado'}</span>}
            {mode === 'unlink' && <button type="button" className="text-button" disabled={busy || Boolean(command.current)} onClick={() => start('unlink', o.id)}>Desvincular</button>}</li>; })}</ul>
          : <p className="real-help">Não vinculado</p>}</section>}
      {record && mode === 'link' && <section aria-label="Pedido de compra"><h3>Pedido de compra</h3>
        <form className="native-list-toolbar" onSubmit={event => { event.preventDefault(); void find(); }}><div className="form-field"><label htmlFor="fiscal-link-search">Pesquisar pedido de compra</label>
          <input id="fiscal-link-search" type="search" maxLength={120} placeholder="Número ou fornecedor" value={query} onChange={event => setQuery(event.target.value)} /></div>
          <button type="submit" className="secondary-button">Pesquisar</button></form>
        {orders.length > 0 && <ul className="fiscal-picker" role="listbox" aria-label="Pedidos de compra">{orders.map(o => <li key={o.id}><button type="button" disabled={busy || Boolean(command.current)} onClick={() => void pick(o)}>Pedido {o.number} · {o.contact_name} · {o.date?.split('-').reverse().join('/') ?? 'Não informada'}</button></li>)}</ul>}
        {order && <>
          <p role="status">Itens vinculados: {summary.linked} de {summary.total} · a vincular: {summary.open}</p>
          <table className="data-table fiscal-link-summary"><caption>Itens do pedido {order.number} e da nota</caption>
            <thead><tr><th>Item do pedido</th><th className="numeric">Qtde no pedido</th><th className="numeric">Vinculada em outras notas</th><th>Item da nota</th><th className="numeric">A vincular</th></tr></thead>
            <tbody>{lines.map((line, index) => <tr key={line.document_item_id}><td>{line.description}</td><td className="numeric">{qtyText(line.ordered)}</td><td className="numeric">{qtyText(line.others)}</td>
              <td><select aria-label={`Item da nota para ${line.description}`} value={line.position === null ? '' : String(line.position)} disabled={busy || Boolean(command.current)}
                onChange={event => setLine(index, { position: event.target.value ? Number(event.target.value) : null })}><option value="">—</option>
                {record.items.map((item, i) => compatible(item, line) && <option key={i} value={String(i + 1)}>{i + 1} · {item.description} ({qtyText(qty(item.quantity))})</option>)}</select></td>
              <td className="numeric"><input aria-label={`Quantidade a vincular de ${line.description}`} inputMode="decimal" maxLength={17} value={line.quantity} disabled={busy || Boolean(command.current)}
                onChange={event => setLine(index, { quantity: event.target.value })} /></td></tr>)}</tbody></table>
          {problems.length > 0 && <ul className="real-alert" role="alert">{problems.map(text => <li key={text}>{text}</li>)}</ul>}
          <p className="real-help">Cada item do pedido recebe a quantidade do item da nota escolhido (total ou parcial). Sem quantidades, o pedido é vinculado inteiro, como antes. Lançar estoque e contas continua no pedido de compra ou na nota.</p></>}
      </section>}
    </div>
  </Modal>;
}
