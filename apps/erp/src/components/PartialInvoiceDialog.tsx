import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { OrderBatchRefusal, loadBatchBasis } from '../lib/fiscal-order-batch';
import { partialInvoiceBody, picksProblem, type PartialPick } from '../lib/partial-invoice';
import { parseInvoiceBalance, type InvoiceBalance } from '../../../../packages/erp-domain/src/sales-invoice-balance.mjs';
import { Modal } from './Modal';

const show = (q: string) => q.replace(/\.?0+$/, '').replace('.', ',');
const REFUSED: Record<string, string> = {
  partial_exceeds: 'Outra nota faturou parte deste saldo enquanto você escolhia. Confira o resumo atualizado.',
  has_invoice: 'O pedido já tem uma nota fiscal completa; não há saldo para nota parcial.',
  partial_status: 'O pedido precisa estar fora de Em digitação e não cancelado.',
  partial_mismatch: 'Os itens da nota não conferem com as quantidades escolhidas.', partial_item: 'Um item escolhido não pertence mais ao pedido.',
};

/**
 * Leva H (VND-047, VND-083, VND-085) "Gerar nota fiscal parcial": Resumo de faturamento do pedido (pedido, faturado, saldo por item)
 * e as quantidades desta nota. Grava uma NF-e de homologação com só essas quantidades; nada é transmitido nem lançado. Um resultado
 * não confirmado é reenviado com o mesmo comando, nunca duplicado.
 */
export default function PartialInvoiceDialog({ controller, documentId, number, today, onClose }: { controller: AccessController; documentId: string; number: string; today: string; onClose: (changed: boolean) => void }) {
  const fetch = (path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }) => controller.fiscalInvoices(path, options as Parameters<AccessController['fiscalInvoices']>[1]);
  const [balance, setBalance] = useState<InvoiceBalance | null>(null), [draft, setDraft] = useState<Record<number, string>>({});
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [saved, setSaved] = useState<{ id: string } | null>(null), [reload, setReload] = useState(0);
  const pending = useRef<Record<string, unknown> | null>(null), changed = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const request = new AbortController(); setError('');
    void fetch(`/v1/notas-fiscais/pedido/${documentId}/saldo`, { signal: request.signal }).then(raw => {
      if (request.signal.aborted) return; const value = parseInvoiceBalance(raw, documentId); setBalance(value);
      setDraft(current => Object.keys(current).length ? current : Object.fromEntries(value.items.filter(i => i.remaining !== '0.0000').map(i => [i.position, show(i.remaining)])));
    }).catch(failure => { if (!request.signal.aborted && !(failure instanceof DOMException)) setError(failure instanceof AccessError && failure.status === 403 ? 'Seu perfil não consulta este pedido.' : 'Não foi possível consultar o resumo de faturamento.'); });
    return () => request.abort();
  }, [documentId, reload]);
  const picks = (): PartialPick[] => Object.entries(draft).map(([position, quantity]) => ({ position: Number(position), quantity: quantity.trim().replace(/\./g, '').replace(',', '.') })).filter(p => p.quantity !== '' && !/^0+([.,]0*)?$/.test(p.quantity));
  const submit = async () => {
    if (!balance || busy) return;
    setBusy(true); setError('');
    try {
      if (!pending.current) {
        const problem = picksProblem(balance, picks()); if (problem) { setError(problem); return; }
        pending.current = await partialInvoiceBody(fetch, await loadBatchBasis(fetch, '55'), balance, picks(), '55', today);
      }
      const value = await fetch('/v1/notas-fiscais/parcial', { method: 'POST', body: pending.current }) as { invoice?: { id?: string } };
      pending.current = null; changed.current = true;
      if (mounted.current) { setSaved({ id: String(value.invoice?.id ?? '') }); setDraft({}); setReload(n => n + 1); }
    } catch (failure) {
      // Only an unconfirmed answer keeps the same command; a refusal starts over with the updated balance.
      const uncertain = !(failure instanceof AccessError) || failure.status >= 500 || failure.status === 408;
      if (!uncertain || failure instanceof OrderBatchRefusal) pending.current = null;
      if (mounted.current) setError(failure instanceof OrderBatchRefusal ? failure.message : failure instanceof AccessError && failure.field && REFUSED[failure.field] ? REFUSED[failure.field]!
        : failure instanceof AccessError && failure.status === 403 ? 'Notas fiscais restritas aos perfis administrador e fiscal.'
          : uncertain ? 'Não foi possível confirmar a gravação. Clique em Gerar de novo: o mesmo comando é reenviado, sem duplicar a nota.' : 'A nota não foi gravada. Confira as quantidades.');
      if (failure instanceof AccessError && failure.status === 409) setReload(n => n + 1);
    } finally { if (mounted.current) setBusy(false); }
  };
  const open = balance?.items.some(i => i.remaining !== '0.0000') && !balance.full_invoice_id;
  return <Modal title={`Gerar nota fiscal parcial · Pedido nº ${number}`} onClose={() => onClose(changed.current)}
    actions={<><button type="button" className="secondary-button" disabled={busy} onClick={() => onClose(changed.current)}>Fechar</button>
      {open && <button type="button" className="primary-button" disabled={busy} onClick={() => void submit()}>{busy ? 'Gerando…' : pending.current ? 'Gerar de novo (mesmo comando)' : 'Gerar NF-e parcial'}</button>}</>}>
    <p className="real-help">A nota é gravada em homologação com as quantidades abaixo. As contas continuam sendo as do pedido; cada nota aponta para elas.</p>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {saved && <p className="real-success" role="status">Nota parcial gravada. {saved.id && <a href={`/historico-fiscal?${new URLSearchParams({ modelo: '55', origem: 'brufap', nota: saved.id })}`} target="_blank" rel="noopener">Abrir a nota</a>}</p>}
    {!balance && !error && <p role="status">Consultando o resumo de faturamento…</p>}
    {balance && <>
      {balance.full_invoice_id && <p className="real-notice">O pedido já tem uma nota fiscal completa.</p>}
      <table className="data-table"><caption className="real-help">Resumo de faturamento</caption>
        <thead><tr><th scope="col">Item</th><th scope="col" className="numeric">Pedido</th><th scope="col" className="numeric">Faturado</th><th scope="col" className="numeric">Saldo</th><th scope="col" className="numeric">Faturar agora</th></tr></thead>
        <tbody>{balance.items.map(item => <tr key={item.document_item_id}><td>{item.position}. {item.description ?? '—'}</td><td className="numeric">{show(item.ordered)} {item.unit ?? ''}</td>
          <td className="numeric">{show(item.invoiced)}</td><td className="numeric">{show(item.remaining)}</td>
          <td className="numeric">{item.remaining === '0.0000' ? '—' : <input aria-label={`Quantidade a faturar do item ${item.position}`} inputMode="decimal" maxLength={16} value={draft[item.position] ?? ''} disabled={busy || Boolean(pending.current)}
            onChange={event => setDraft(current => ({ ...current, [item.position]: event.target.value }))} />}</td></tr>)}</tbody></table>
      {balance.invoices.length > 0 && <p className="real-help">Notas do pedido: {balance.invoices.map(n => `${n.number ? `nº ${n.number}` : 'rascunho'}${n.partial ? ' (parcial)' : ''}${n.counts ? '' : ' — não conta no saldo'}`).join(' · ')}.</p>}
    </>}
  </Modal>;
}
