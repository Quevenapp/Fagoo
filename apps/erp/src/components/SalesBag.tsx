import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { SALES_BAG_PATH, bagQuantity, quantityText, readSalesBag, type SalesBag, type SalesBagChange } from '../lib/sales-bag-model';
import { Modal } from './Modal';
import { Icon } from './Icon';
import './sales-bag.css';

type Controller = Pick<AccessController, 'getSnapshot'> & Partial<Pick<AccessController, 'documents'>>;
const actorOf = (controller: Controller) => controller.getSnapshot()?.membership?.user_id ?? null;
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const failure = (error: unknown) => error instanceof AccessError && error.status === 403 ? 'Seu perfil não usa a sacola de vendas.'
  : error instanceof AccessError && error.status === 400 ? 'Confira a quantidade: até nove dígitos inteiros e seis casas decimais, maior que zero; produtos inativos não entram na sacola (até 250 produtos).'
  : error instanceof AccessError && error.status === 409 ? 'Este comando já foi usado com outros dados. Atualize a sacola.' : 'Não foi possível atualizar a sacola de vendas.';

/**
 * Origin "Sacola de vendas" (202610200197): the bag of the user, kept on the server. Each change is one command; an answer that
 * did not arrive keeps the same command for "Conferir resultado". A late answer of another user or session is ignored.
 */
export function useSalesBag(controller: Controller, active = true) {
  const [bag, setBag] = useState<SalesBag | null>(null), [enabled, setEnabled] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [uncertain, setUncertain] = useState(false), [open, setOpen] = useState(false), [notice, setNotice] = useState('');
  const actor = actorOf(controller), pending = useRef<{ id: string; change: SalesBagChange; actor: string | null } | null>(null), alive = useRef(true), inflight = useRef(false);
  useEffect(() => {
    alive.current = true; const request = new AbortController(); setEnabled(false); setBag(null); setOpen(false); pending.current = null; setUncertain(false);
    // `active`: only the product list reads the bag (the catalog runs this hook for every entity).
    if (!active || typeof controller.documents !== 'function' || !actor) return () => { alive.current = false; };
    void Promise.resolve().then(() => controller.documents!(SALES_BAG_PATH, { signal: request.signal })).then(value => {
      if (request.signal.aborted || actorOf(controller) !== actor) return; setBag(readSalesBag(value)); setEnabled(true);
    }).catch(() => { /* Profiles without pedidos de venda (403) or a database before 197 do not show the bag. */ });
    return () => { alive.current = false; request.abort(); };
  }, [controller, actor, active]);
  const run = async () => {
    const command = pending.current; if (!command || inflight.current || typeof controller.documents !== 'function') return;
    if (actorOf(controller) !== command.actor) { pending.current = null; setUncertain(false); setError('A sessão mudou. Atualize a sacola antes de repetir.'); return; }
    inflight.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const value = readSalesBag(await controller.documents(SALES_BAG_PATH, { method: 'POST', body: { command_id: command.id, ...command.change } }));
      if (!alive.current || actorOf(controller) !== command.actor) return;
      pending.current = null; setUncertain(false); setBag(value);
      setNotice(command.change.action === 'add' ? 'Produto adicionado à sacola de vendas.' : command.change.action === 'clear' ? 'Sacola de vendas esvaziada.' : 'Sacola de vendas atualizada.');
    } catch (problem) {
      if (!alive.current || aborted(problem)) return;
      const definitive = !uncertain && problem instanceof AccessError && [400, 403, 404, 409].includes(problem.status);
      if (definitive) { pending.current = null; setUncertain(false); setError(failure(problem)); }
      else { setUncertain(true); setError('Não foi possível confirmar a alteração da sacola. Use “Conferir resultado” para repetir o mesmo comando.'); }
    } finally { inflight.current = false; if (alive.current) setBusy(false); }
  };
  const change = (next: SalesBagChange) => { if (pending.current || inflight.current || !enabled) return; pending.current = { id: crypto.randomUUID(), change: next, actor: actorOf(controller) }; void run(); };
  return { enabled, bag, busy, error, uncertain, open, setOpen, notice, change, retry: () => void run(), count: bag?.count ?? 0 };
}
export type SalesBagState = ReturnType<typeof useSalesBag>;

/** Toolbar icon (fa-shopping-bag) with the number of products in the bag. */
export function SalesBagButton({ bag }: { bag: SalesBagState }) {
  if (!bag.enabled) return null;
  return <button type="button" className="secondary-button sales-bag-button" title="Sacola de vendas" aria-label={`Sacola de vendas: ${bag.count} produto(s)`} onClick={() => bag.setOpen(true)}>
    <Icon name="bag-shopping" size={13} /><span className="sales-bag-count">{bag.count}</span></button>;
}

/** Origin sacola of the row (Marcadores): "Quantidade a adicionar:" and "Adicionar". */
export function SalesBagRowAdd({ bag, product, unit }: { bag: SalesBagState; product: { id: string; name: string; active: boolean }; unit: string | null }) {
  const [open, setOpen] = useState(false), [text, setText] = useState('1'), [error, setError] = useState('');
  if (!bag.enabled || !product.active) return null;
  const id = `sales-bag-quantity-${product.id}`;
  const add = () => { const quantity = bagQuantity(text); if (!quantity) { setError('Informe uma quantidade maior que zero, com até seis casas decimais.'); return; } setError(''); setOpen(false); bag.change({ action: 'add', product_id: product.id, quantity }); };
  return <span className="sales-bag-row">
    <button type="button" className="text-button" title="Sacola de vendas" aria-label={`Adicionar ${product.name} à sacola de vendas`} aria-expanded={open} disabled={bag.busy || bag.uncertain} onClick={event => { event.stopPropagation(); setOpen(value => !value); }}><Icon name="bag-shopping" size={13} /></button>
    {open && <span className="sales-bag-popover" role="dialog" aria-label="Quantidade a adicionar" onClick={event => event.stopPropagation()}>
      <label htmlFor={id}>Quantidade a adicionar:</label>
      <input id={id} inputMode="decimal" autoFocus value={text} aria-describedby={unit ? `${id}-unit` : undefined} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } if (event.key === 'Escape') setOpen(false); }} />
      {unit && <small id={`${id}-unit`}>{unit}</small>}
      <button type="button" className="primary-button" onClick={add}>Adicionar</button>
      {error && <small className="real-alert" role="alert">{error}</small>}
    </span>}
  </span>;
}

/** Gaveta "Sacola de vendas": quantidade editável, remover, limpar e "Gerar pedido de venda". */
export function SalesBagDrawer({ bag, onGenerate }: { bag: SalesBagState; onGenerate: () => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  if (!bag.open) return null;
  const items = bag.bag?.items ?? [], locked = bag.busy || bag.uncertain;
  const commit = (productId: string, current: string) => {
    const typed = drafts[productId]; if (typed === undefined) return;
    const quantity = bagQuantity(typed);
    setDrafts(previous => { const next = { ...previous }; delete next[productId]; return next; });
    if (quantity && quantity !== current.replace(/\.?0+$/, '')) bag.change({ action: 'set', product_id: productId, quantity });
  };
  return <Modal title="Sacola de vendas" onClose={() => { if (!bag.busy) bag.setOpen(false); }} actions={<>
    <button type="button" className="secondary-button" disabled={bag.busy} onClick={() => bag.setOpen(false)}>Fechar</button>
    {bag.uncertain ? <button type="button" className="primary-button" disabled={bag.busy} onClick={bag.retry}>{bag.busy ? 'Conferindo…' : 'Conferir resultado'}</button>
      : <button type="button" className="primary-button" disabled={locked || !items.some(item => item.active)} onClick={onGenerate}>Gerar pedido de venda</button>}</>}>
    {!items.length ? <p className="real-help">A sacola está vazia. Use a sacola da linha do produto para adicionar.</p>
      : <div className="table-scroll"><table className="data-table sales-bag-table"><thead><tr><th>Produto</th><th className="numeric">Quantidade</th><th>Ações</th></tr></thead><tbody>
        {items.map(item => <tr key={item.product_id} className={item.active ? undefined : 'is-inactive'}>
          <td>{item.name}{item.code && <small> · {item.code}</small>}{!item.active && <small> · inativo (não entra no pedido)</small>}</td>
          <td className="numeric"><input id={`sales-bag-set-${item.product_id}`} aria-label={`Quantidade de ${item.name}`} inputMode="decimal" disabled={locked} value={drafts[item.product_id] ?? quantityText(item.quantity)}
            onChange={event => setDrafts(previous => ({ ...previous, [item.product_id]: event.target.value }))} onBlur={() => commit(item.product_id, item.quantity)}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(item.product_id, item.quantity); } }} />{item.unit && <small> {item.unit}</small>}</td>
          <td><button type="button" className="text-button" aria-label={`Remover ${item.name} da sacola`} title="Remover" disabled={locked} onClick={() => bag.change({ action: 'remove', product_id: item.product_id })}><Icon name="trash-can" size={12} /></button></td>
        </tr>)}</tbody></table></div>}
    {items.length > 0 && <button type="button" className="text-button" disabled={locked} onClick={() => bag.change({ action: 'clear' })}>Limpar sacola</button>}
    {bag.notice && <p className="real-success" role="status">{bag.notice}</p>}
    {bag.error && <p className="real-alert" role="alert">{bag.error}</p>}
  </Modal>;
}
