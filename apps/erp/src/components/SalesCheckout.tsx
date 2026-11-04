import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { AccessError, type AccessController } from '../lib/real-access';
import { STATES } from '../lib/real-documents-model';
import { applyRead, checkoutPath, complete, orderedLines, pickingLine, readCheckout, readsBody, readsOf, savedStatus, shown, units, type CheckoutView, type Reads } from '../lib/sales-checkout-model';
import { autoFinanceMessage } from '../lib/document-pricing-model';
import { Icon } from './Icon';
import './document-wave-g.css';

type Controller = Pick<AccessController, 'documents' | 'getSnapshot'>;
const sameReads = (a: Reads, b: Reads) => JSON.stringify(Object.entries(a).filter(([, v]) => v > 0n).map(([k, v]) => [k, String(v)]).sort()) === JSON.stringify(Object.entries(b).filter(([, v]) => v > 0n).map(([k, v]) => [k, String(v)]).sort());
const failureText = (failure: unknown) => failure instanceof AccessError ? failure.code === 'ERP_DOCUMENT_CHECKOUT_UNAVAILABLE' ? 'O checkout vale só para pedidos Em aberto ou Checkout parcial.'
  : failure.code === 'ERP_DOCUMENT_CHECKOUT_AMBIGUOUS' ? 'Há mais de um pedido com esse número. Confira a numeração na listagem antes de continuar.'
  : failure.code === 'ERP_DOCUMENT_CHECKOUT_EXCEEDS' ? 'Uma quantidade lida passa da quantidade do pedido. Corrija a leitura.' : failure.status === 409 ? 'O pedido mudou em outra tela. Leia o pedido de novo.'
    : failure.status === 403 ? 'Seu perfil não faz o checkout de pedidos.' : failure.status === 404 ? 'Pedido não encontrado.' : 'Não foi possível concluir. Tente de novo.' : 'Não foi possível concluir. Tente de novo.';

/**
 * Origin Vendas › Logística › "Checkout de pedidos": ler o número do pedido, ler cada produto (GTIN, GTIN tributário ou código, com o
 * leitor de código de barras: Enter lê), conferir as quantidades, corrigir a leitura e Salvar. Tudo conferido: o pedido vai para
 * Verificado; parte: Checkout parcial; nada: Em aberto. As opções de Preferências › Vendas › Checkout de Pedidos valem aqui.
 */
export default function SalesCheckout({ controller, onClose }: { controller: Controller; onClose: () => void }) {
  const [number, setNumber] = useState(''), [view, setView] = useState<CheckoutView | null>(null), [reads, setReads] = useState<Record<string, bigint>>({}), [history, setHistory] = useState<Record<string, bigint>[]>([]);
  const [code, setCode] = useState(''), [quantity, setQuantity] = useState(''), [message, setMessage] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false), [pending, setPending] = useState<{ id: string; body: Record<string, unknown>; uncertain: boolean } | null>(null);
  const codeRef = useRef<HTMLInputElement>(null), request = useRef<AbortController | null>(null), autoSaved = useRef(false);
  const saved = view ? readsOf(view) : {};
  const dirty = Boolean(view && !sameReads(reads, saved));
  const guard = useUnsavedChanges(dirty || Boolean(pending?.uncertain), busy);
  useEffect(() => () => request.current?.abort(), []);
  const lines = view ? orderedLines(view.lines, view.settings) : [];
  const open = (next: CheckoutView) => { setView(next); setReads(readsOf(next)); setHistory([]); setMessage(''); autoSaved.current = false; setTimeout(() => codeRef.current?.focus(), 0); };
  const find = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return;
    const typed = number.trim();
    if (!/^[1-9]\d{0,9}$/.test(typed)) { setError('Informe o número do pedido de venda.'); return; }
    const signal = new AbortController(); request.current = signal; setBusy(true); setError(''); setNotice('');
    try {
      const row = await controller.documents(`/v1/documentos/sales_orders/checkout?${new URLSearchParams({ number: typed })}`, { signal: signal.signal }) as { id?: string; number?: string };
      if (!row || typeof row.id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(row.id) || row.number !== typed) throw new Error('Resposta inválida do checkout.');
      const next = readCheckout(await controller.documents(checkoutPath(row.id), { signal: signal.signal }), row.id);
      if (signal.signal.aborted) return; open(next);
    } catch (failure) { if (!signal.signal.aborted) setError(failureText(failure)); }
    finally { if (request.current === signal) request.current = null; setBusy(false); }
  };
  const save = async (command = pending ?? (view ? { id: crypto.randomUUID(), body: { expected_version: view.order.version, checkout_version: view.checkout_version, reads: readsBody(reads) }, uncertain: false } : null)) => {
    if (!view || !command || busy) return;
    const signal = new AbortController(); request.current = signal; setBusy(true); setError(''); setPending(command);
    try {
      const result = readCheckout(await controller.documents(checkoutPath(view.order.id), { method: 'POST', body: { ...command.body, command_id: command.id }, signal: signal.signal }), view.order.id);
      if (signal.signal.aborted) return;
      setPending(null);
      const fresh = readCheckout(await controller.documents(checkoutPath(view.order.id), { signal: signal.signal }), view.order.id);
      if (signal.signal.aborted) return; open(fresh);
      const auto = autoFinanceMessage(result.auto_finance, 'sales_orders');
      setNotice(`Checkout salvo. Pedido ${result.order.number}: ${STATES.sales_orders[result.order.status] ?? result.order.status}.${auto ? ` ${auto}` : ''}`);
    } catch (failure) {
      if (signal.signal.aborted) return;
      const known = failure instanceof AccessError && [400, 403, 404, 409].includes(failure.status);
      if (known) { setPending(null); setError(failureText(failure)); } else { setPending({ ...command, uncertain: true }); setError('Não foi possível confirmar o resultado. Use “Conferir resultado”: o mesmo comando não grava duas vezes.'); }
    } finally { if (request.current === signal) request.current = null; setBusy(false); }
  };
  const read = (event: FormEvent) => {
    event.preventDefault(); if (!view || !view.available || busy || pending) return;
    const result = applyRead(lines, reads, code, view.settings.quantity_input ? quantity : '1', view.settings.picking);
    setCode(''); setQuantity(''); codeRef.current?.focus();
    if (!result.ok) { setMessage(result.message); return; }
    setHistory(current => [...current, reads]); setReads(result.reads);
    setMessage(`${result.line.description}: ${shown(result.reads[result.line.key]!)} de ${shown(units(result.line.quantity) ?? 0n)}.`);
  };
  // Preferências "Salvar automaticamente ao ler todos itens".
  useEffect(() => { if (view?.settings.auto_save && view.available && dirty && complete(lines, reads) && !autoSaved.current && !busy && !pending) { autoSaved.current = true; void save(); } });
  const next = view?.settings.picking ? pickingLine(lines, reads) : null;
  const target = view ? savedStatus(lines, reads) : 'open';
  return <section className="real-section sales-checkout" aria-labelledby="sales-checkout-title">
    <header className="real-heading"><div><h1 id="sales-checkout-title">Checkout de pedidos</h1></div>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => guard.confirmLeave(onClose)}>Voltar à listagem</button></header>
    {notice && <p className="real-success" role="status">{notice}</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    {pending?.uncertain && <div className="real-editor-actions"><button type="button" className="primary-button" disabled={busy} onClick={() => void save(pending)}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button></div>}
    <form className="native-list-toolbar" onSubmit={event => { if (dirty) { event.preventDefault(); guard.confirmLeave(() => void find(event)); return; } void find(event); }}>
      <div className="form-field"><label htmlFor="checkout-number">Número do pedido</label><input id="checkout-number" inputMode="numeric" maxLength={10} autoFocus value={number} disabled={busy || Boolean(pending)} onChange={event => setNumber(event.target.value)} /></div>
      <button type="submit" className="secondary-button" disabled={busy || Boolean(pending)}>Buscar pedido</button></form>
    {view && <>
      <dl className="commercial-dates"><div><dt>Pedido</dt><dd>{view.order.number}</dd></div><div><dt>Cliente</dt><dd>{view.order.contact_name}</dd></div>
        <div><dt>Situação</dt><dd>{STATES.sales_orders[view.order.status] ?? view.order.status}</dd></div><div><dt>Data</dt><dd>{view.order.date.split('-').reverse().join('/')}</dd></div></dl>
      {!view.available && <p className="real-notice" role="note">O checkout vale só para pedidos Em aberto ou Checkout parcial.</p>}
      {view.available && <form className="native-list-toolbar sales-checkout-read" onSubmit={read}>
        <div className="form-field"><label htmlFor="checkout-code">Código de barras ou código</label><input id="checkout-code" ref={codeRef} maxLength={60} autoComplete="off" placeholder="Leia o GTIN ou digite o código e tecle Enter" value={code} disabled={busy || Boolean(pending)} onChange={event => setCode(event.target.value)} /></div>
        {view.settings.quantity_input && <div className="form-field"><label htmlFor="checkout-quantity">Quantidade</label><input id="checkout-quantity" inputMode="decimal" maxLength={20} placeholder="1" value={quantity} disabled={busy || Boolean(pending)} onChange={event => setQuantity(event.target.value)} /></div>}
        <button type="submit" className="secondary-button" disabled={busy || Boolean(pending) || !code.trim()}>Ler</button>
        <button type="button" className="text-button" disabled={!history.length || busy || Boolean(pending)} onClick={() => { setReads(history.at(-1)!); setHistory(current => current.slice(0, -1)); setMessage('Última leitura desfeita.'); codeRef.current?.focus(); }}>Desfazer última leitura</button></form>}
      {message && <p className="real-help" role="status" aria-live="polite">{message}</p>}
      {next && view.available && <p className="real-notice sales-checkout-next" role="note">Próximo item: <strong>{next.description}</strong>{next.location ? ` · Localização ${next.location}` : ''}{next.code ? ` · Código ${next.code}` : ''}</p>}
      <div className="table-scroll" tabIndex={0} aria-label="Itens do checkout"><table className="data-table"><thead><tr><th>#</th><th>Descrição</th><th>Código</th><th>GTIN</th><th>Localização</th><th>Quantidade</th><th>Conferido</th><th>Falta</th>{view.available && <th>Correção</th>}</tr></thead>
        <tbody>{lines.map(line => { const total = units(line.quantity) ?? 0n, done = reads[line.key] ?? 0n;
          return <tr key={line.key} className={done === total ? 'is-complete' : next?.key === line.key ? 'is-current' : undefined}><td>{line.position}</td><td>{line.description}{line.component_id ? <small> (componente)</small> : null}</td><td>{line.code ?? '—'}</td><td>{line.gtin ?? line.gtin_tax ?? '—'}</td><td>{line.location ?? '—'}</td>
            <td className="numeric">{shown(total)} {line.unit}</td><td className="numeric">{shown(done)}</td><td className="numeric">{shown(total - done)}</td>
            {view.available && <td><button type="button" className="icon-button" title="Corrigir leitura (zera o conferido do item)" aria-label={`Corrigir leitura de ${line.description}`} disabled={!done || busy || Boolean(pending)} onClick={() => { setHistory(current => [...current, reads]); setReads(current => ({ ...current, [line.key]: 0n })); setMessage(`Leitura de ${line.description} zerada.`); }}><Icon name="rotate-right" size={12} /></button></td>}</tr>; })}</tbody></table></div>
      {view.available && <div className="real-editor-actions"><p className="real-help">Ao salvar, o pedido fica {STATES.sales_orders[target]}.</p>
        <button type="button" className="primary-button" disabled={busy || Boolean(pending) || !dirty} onClick={() => void save()}>{busy ? 'Salvando…' : 'Salvar'}</button></div>}
    </>}
  </section>;
}
