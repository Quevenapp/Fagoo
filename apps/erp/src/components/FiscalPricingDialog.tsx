import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { invoicePreferences, invoiceRecord, type InvoiceRecord } from '../../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { FISCAL_BASE, invoiceNumber, type ListRow } from '../lib/fiscal-invoice-list-model';
import { brUnit, pricingLines, pricingRecord, validMarkup, type PricingRecord } from '../lib/fiscal-invoice-pricing';
import { Modal } from './Modal';
import { UpdatePricesButton } from './ProductPriceUpdate';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const known = (error: unknown) => error instanceof AccessError && [400, 403, 404, 409].includes(error.status);
type Mark = { command: string; busy: boolean; uncertain: boolean };

/**
 * ⋮ Formação de preços (nota de entrada do Brufap): custo unitário pela nota e preço de venda sugerido pelo markup das
 * Preferências › Configurações de NF-e. "Atualizar preços" grava no cadastro de produtos (produtos lane, ProductPriceUpdate.tsx):
 * preço de venda e preço de custo no fornecedor da nota, com a versão de cada produto e "Conferir resultado".
 * Onda E (202610200252): enquanto a gravação espera ou pede "Conferir resultado", a janela não fecha (Fechar, X, Esc e o fundo);
 * a gravação confirmada fica registrada na nota (letra P "Preços atualizados" da lista), com o próprio "Conferir resultado".
 */
export default function FiscalPricingDialog({ controller, row, onClose, onPriced }: { controller: AccessController; row: ListRow; onClose: () => void; onPriced?: (record: PricingRecord) => void }) {
  const [record, setRecord] = useState<InvoiceRecord | null>(null), [markup, setMarkup] = useState('0'), [markups, setMarkups] = useState<Record<number, string>>({}), [error, setError] = useState('');
  const [pending, setPending] = useState<'busy' | 'uncertain' | null>(null), [mark, setMark] = useState<Mark | null>(null), [markError, setMarkError] = useState(''), [markNotice, setMarkNotice] = useState(''), [held, setHeld] = useState('');
  const markRequest = useRef<AbortController | null>(null), actor = useRef(controller.getSnapshot().membership?.user_id), alive = useRef(true);
  useUnsavedChanges(Boolean(mark?.uncertain), Boolean(mark?.busy || mark?.uncertain));
  useEffect(() => () => { alive.current = false; markRequest.current?.abort(); }, []);
  useEffect(() => {
    const request = new AbortController();
    void (async () => {
      try {
        const [value, context] = await Promise.all([controller.fiscalInvoices(`${FISCAL_BASE}/${row.id}`, { signal: request.signal }) as Promise<{ invoice: unknown }>,
          controller.fiscalInvoices(`${FISCAL_BASE}/contexto?model=55`, { signal: request.signal }) as Promise<{ preferences: unknown }>]);
        if (request.signal.aborted) return;
        const loaded = invoiceRecord(value?.invoice); if (loaded.id !== row.id) throw new AccessError(502);
        setRecord(loaded); setMarkup(invoicePreferences(context?.preferences).markup);
      } catch (problem) { if (!request.signal.aborted && !aborted(problem)) setError('Não foi possível carregar a nota para a formação de preços.'); }
    })();
    return () => request.abort();
  }, [controller, row.id]);
  // The confirmed "Atualizar preços" command is recorded on the note (same command again never records twice).
  const record_mark = async (current: Mark) => {
    if (markRequest.current) return;
    const request = new AbortController(); markRequest.current = request; setMark({ ...current, busy: true }); setMarkError(''); setMarkNotice('');
    try {
      const value = await controller.fiscalInvoices(`${FISCAL_BASE}/${row.id}/precos`, { method: 'POST', body: { catalog_command_id: current.command }, signal: request.signal });
      if (request.signal.aborted || !alive.current || controller.getSnapshot().membership?.user_id !== actor.current) return;
      const checked = pricingRecord(value, row.id, current.command);
      setMark(null); setMarkNotice(`Preços atualizados registrados na nota${checked.replayed ? ' (já registrado)' : ''}: letra P na listagem.`); onPriced?.(checked);
    } catch (problem) {
      if (request.signal.aborted || !alive.current) return;
      const certain = !current.uncertain && !aborted(problem) && known(problem);
      setMark(certain ? null : { ...current, busy: false, uncertain: true });
      setMarkError(certain ? 'Os preços foram gravados no cadastro, mas a nota não registrou a marca P (a nota mudou ou não tem esses produtos).'
        : 'Os preços foram gravados no cadastro. Não foi possível confirmar a marca P da nota: use “Conferir resultado” para repetir o mesmo registro.');
    } finally { if (markRequest.current === request) markRequest.current = null; }
  };
  const lines = record ? pricingLines(record, markups, markup) : [];
  const waiting = pending !== null || Boolean(mark?.busy || mark?.uncertain);
  // Never close while a gravação waits or needs "Conferir resultado": the button would be unmounted and the result lost from view.
  const close = () => {
    if (!waiting) { onClose(); return; }
    setHeld(pending === 'busy' || mark?.busy ? 'Aguarde: a gravação dos preços ainda está em andamento.' : 'Use “Conferir resultado” antes de fechar: a gravação ainda não foi confirmada.');
  };
  return <Modal title="Formação de preços" onClose={close} actions={<><UpdatePricesButton controller={controller} supplierId={(record as { recipient?: { contact_id?: string | null } } | null)?.recipient?.contact_id ?? null} lines={lines}
      onPendingChange={state => { setPending(state); if (state === null) setHeld(''); }} onUpdated={command => { actor.current = controller.getSnapshot().membership?.user_id; void record_mark({ command, busy: false, uncertain: false }); }} />
    {mark?.uncertain && <button type="button" className="secondary-button" disabled={mark.busy} onClick={() => void record_mark(mark)}>{mark.busy ? 'Conferindo…' : 'Conferir resultado'}</button>}
    <button type="button" className="secondary-button" disabled={waiting} title={waiting ? 'Aguarde a confirmação da gravação.' : undefined} onClick={close}>Fechar</button></>}>
    <div className="fiscal-pricing">
      <p>Nota {invoiceNumber(row)} · {row.name ?? 'Sem nome'} · markup padrão {brUnit(/^\d+(\.\d+)?$/.test(markup) ? markup : '0')}% (Preferências › Configurações de NF-e)</p>
      {error && <p className="real-alert" role="alert">{error}</p>}
      {held && <p className="real-alert" role="alert">{held}</p>}
      {markError && <p className="real-alert" role="alert">{markError}</p>}
      {markNotice && <p className="real-success" role="status">{markNotice}</p>}
      {!record && !error && <p role="status">Carregando a nota…</p>}
      {record && <div className="table-scroll" tabIndex={0}><table className="data-table fiscal-pricing-table"><thead><tr><th>Produto</th><th className="numeric">Qtde</th><th className="numeric">Preço de compra</th><th className="numeric">IPI</th><th className="numeric">ICMS ST</th>
        <th className="numeric">Frete</th><th className="numeric">Outras despesas</th><th className="numeric">Desconto</th><th className="numeric">Custo unitário</th><th className="numeric">Markup (%)</th><th className="numeric">Preço de venda</th></tr></thead>
        <tbody>{lines.map(line => <tr key={line.position}><td>{line.description}{line.product_id ? '' : <small className="real-help"> · sem produto do cadastro</small>}</td><td className="numeric">{brUnit(line.quantity)}</td>
          <td className="numeric">{brUnit(line.purchase)}</td><td className="numeric">{brUnit(line.ipi)}</td><td className="numeric">{brUnit(line.st)}</td><td className="numeric">{brUnit(line.freight)}</td><td className="numeric">{brUnit(line.other)}</td>
          <td className="numeric">{brUnit(line.discount)}</td><td className="numeric">{brUnit(line.cost)}</td>
          <td className="numeric"><input aria-label={`Markup do item ${line.position}`} inputMode="decimal" maxLength={8} value={markups[line.position] ?? markup.replace('.', ',')} aria-invalid={!validMarkup(markups[line.position] ?? markup) || undefined}
            disabled={waiting} onChange={event => { const value = event.target.value; setMarkups(m => ({ ...m, [line.position]: value })); }} /></td><td className="numeric">{brUnit(line.sale)}</td></tr>)}</tbody></table></div>}
      <p className="real-help">Custo unitário = (valor do item + IPI + ICMS ST + frete e seguro + outras despesas − desconto) ÷ quantidade. Preço de venda = custo × (1 + markup). Só “Atualizar preços” grava: o preço de venda e o custo no fornecedor da nota, no cadastro dos produtos; a nota fica com a letra P “Preços atualizados”.</p>
    </div>
  </Modal>;
}
