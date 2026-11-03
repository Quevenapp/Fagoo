import { useEffect, useRef, useState } from 'react';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { AccessError, type AccessController } from '../lib/real-access';
import { quantityText } from '../lib/stock-model';
import { componentOptionsPath, parseComponentOptions, type ComponentOption } from '../lib/stock-composition-model';
import { KIT_COMPONENTS_PATH, KIT_REASON_TEXT, kitBody, kitKey, kitRows, kitTotal, parseKitComponents, type KitComponentsView, type KitReason, type KitRow } from '../lib/document-kit-components-model';
import { useStockCommand } from './StockMovementPanel';
import { Modal } from './Modal';
import { Icon } from './Icon';

// Estoque lane, onda F (280): Origin "Editar componentes do produto" of an item of a pedido de venda or OS: the modal "Componentes do
// item (kit)" (Componente, Qtde Un, Estoque, Qtde Total, "Remover componente", "Adicionar outro componente"). The components of this
// item replace the structure of the composition when the pedido posts or reserves its stock; the cadastro does not change.
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const failure = (error: unknown) => error instanceof AccessError ? error.status === 409 ? 'O pedido ou os componentes mudaram em outra operação (ou o estoque foi lançado). Feche, atualize o pedido e confira de novo.'
  : error.status === 400 ? 'Confira os componentes: produtos simples e ativos, sem repetir e sem a própria composição, com Qtde Un positiva de até 6 casas decimais.'
    : error.status === 403 ? 'Seu perfil não altera este documento.' : error.status === 404 ? 'O item não está mais no pedido.' : 'Não foi possível concluir. Tente novamente.' : 'Não foi possível concluir. Tente novamente.';

export default function DocumentKitComponents({ controller, documentId, itemId, blocked = null, onClose, onSaved }: {
  controller: Pick<AccessController, 'stock'>; documentId: string; itemId: string; blocked?: string | null; onClose: () => void; onSaved: () => Promise<void> | void;
}) {
  const [view, setView] = useState<KitComponentsView | null>(null), [error, setError] = useState(''), [rows, setRows] = useState<KitRow[]>([]), [baseline, setBaseline] = useState('[]');
  const [query, setQuery] = useState(''), [options, setOptions] = useState<{ query: string; items: ComponentOption[] } | null>(null), [notice, setNotice] = useState('');
  const command = useStockCommand(controller, 'Não foi possível confirmar os componentes. Use “Conferir resultado” para repetir o mesmo comando.');
  const frozen = command.busy || command.uncertain, alive = useRef(true);
  const guard = useUnsavedChanges(kitKey(rows) !== baseline, frozen);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    const request = new AbortController();
    void Promise.resolve().then(() => controller.stock(`${KIT_COMPONENTS_PATH(itemId)}?documento=${documentId}`, { signal: request.signal })).then(raw => {
      if (request.signal.aborted) return; const value = parseKitComponents(raw, documentId, itemId); const first = kitRows(value);
      setView(value); setRows(first); setBaseline(kitKey(first));
    }).catch(problem => { if (!request.signal.aborted && !aborted(problem)) setError(problem instanceof AccessError && problem.status === 404 ? 'O item não está mais no pedido.' : 'Não foi possível consultar os componentes do item. Tente novamente.'); });
    return () => request.abort();
  }, [controller, documentId, itemId]);
  // "Adicionar": the simple active products of the cadastro ("Digite o nome ou código"); a late answer of another text is ignored.
  useEffect(() => {
    const text = query.trim(); if (!text || !view) { setOptions(null); return; }
    const request = new AbortController(), timer = setTimeout(() => {
      void Promise.resolve().then(() => controller.stock(componentOptionsPath(text, view.item.product_id), { signal: request.signal })).then(raw => {
        if (!request.signal.aborted) setOptions({ query: text, items: parseComponentOptions(raw, text) });
      }).catch(problem => { if (!request.signal.aborted && !aborted(problem)) setOptions({ query: text, items: [] }); });
    }, 250);
    return () => { clearTimeout(timer); request.abort(); };
  }, [controller, query, view]);
  const editable = Boolean(view?.editable) && !blocked;
  const add = (option: ComponentOption) => { if (frozen || !editable || rows.some(row => row.component_id === option.id)) return;
    setRows(current => [...current, { component_id: option.id, name: option.name, code: option.code, unit: option.unit, stock: option.stock, quantity: '1' }]); setQuery(''); setOptions(null); };
  const change = (id: string, quantity: string) => { if (!frozen && editable) setRows(current => current.map(row => row.component_id === id ? { ...row, quantity } : row)); };
  const remove = (id: string) => { if (!frozen && editable) setRows(current => current.filter(row => row.component_id !== id)); };
  const run = (restore: boolean) => {
    if (!view || command.busy) return;
    let body: Record<string, unknown> | null = null;
    if (!command.uncertain) { try { body = kitBody(view, restore ? null : rows); } catch (problem) { command.setError((problem as Error).message); return; } }
    void command.run(KIT_COMPONENTS_PATH(itemId), 'POST', body, value => parseKitComponents(value, documentId, itemId, 'stock_item_components_save'), saved => {
      const next = kitRows(saved); setView(saved); setRows(next); setBaseline(kitKey(next));
      void Promise.resolve().then(onSaved).then(() => { if (alive.current) onClose(); })
        .catch(() => { if (alive.current) setNotice('Os componentes foram gravados, mas o pedido precisa ser atualizado. Feche e abra o pedido de novo.'); });
    }, failure);
  };
  const close = () => { if (!frozen) guard.confirmLeave(onClose); };
  const unit = view?.item.unit ?? '';
  return <Modal title="Componentes do item (kit)" onClose={close}
    actions={<>{editable && view?.edited && !command.uncertain && <button type="button" className="text-button" disabled={frozen} onClick={() => run(true)}>Restaurar estrutura</button>}
      <button type="button" className="secondary-button" disabled={frozen} onClick={close}>{editable ? 'Cancelar' : 'Fechar'}</button>
      {editable && <button type="button" className="primary-button" disabled={command.busy} onClick={() => run(false)}>{command.busy ? 'Salvando…' : command.uncertain ? 'Conferir resultado' : 'Salvar'}</button>}</>}>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {!view && !error && <p role="status">Consultando os componentes do item…</p>}
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
    {notice && <p className="real-notice" role="status">{notice}</p>}
    {view && <>
      <p><strong>{view.product.name}</strong>{view.product.code ? ` · ${view.product.code}` : ''} · item {view.item.position} · {quantityText(view.item.quantity)} {unit}</p>
      {view.edited ? <p className="real-help">Componentes próprios deste item; o cadastro do produto continua com a estrutura.</p> : <p className="real-help">Componentes da estrutura do produto (cadastro).</p>}
      {!view.editable && view.reason_code && <p className="real-notice">{KIT_REASON_TEXT[view.reason_code as Exclude<KitReason, null>]}</p>}
      {view.editable && blocked && <p className="real-notice">{blocked}</p>}
      <div className="table-scroll"><table className="data-table"><thead><tr><th>Componente</th><th className="numeric">Qtde Un</th>{view.stock_visible && <th className="numeric">Estoque</th>}<th className="numeric">Qtde Total</th>{editable && <th><span className="sr-only">Remover</span></th>}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={row.component_id}><td>{row.name}{row.code ? <small> · {row.code}</small> : null}</td>
          <td className="numeric">{editable ? <><label className="sr-only" htmlFor={`kit-quantity-${index}`}>Qtde Un de {row.name}</label><input id={`kit-quantity-${index}`} inputMode="decimal" maxLength={20} value={row.quantity} disabled={frozen} onChange={event => change(row.component_id, event.target.value)} /></> : row.quantity}</td>
          {view.stock_visible && <td className="numeric">{row.stock === null ? '—' : `${quantityText(row.stock)} ${row.unit ?? ''}`}</td>}
          <td className="numeric">{kitTotal(row.quantity, view.item.quantity)} {row.unit ?? ''}</td>
          {editable && <td><button type="button" className="icon-button" aria-label={`Remover ${row.name}`} title="Remover componente" disabled={frozen} onClick={() => remove(row.component_id)}><Icon name="trash-can" size={12} /></button></td>}</tr>)}</tbody></table></div>
      {editable && <div className="form-field"><label htmlFor="kit-component-search">Adicionar outro componente</label><input id="kit-component-search" placeholder="Digite o nome ou código" maxLength={120} value={query} disabled={frozen} onChange={event => setQuery(event.target.value)} />
        {options && options.query === query.trim() && (options.items.length ? <ul className="fiscal-picker" role="listbox" aria-label="Componentes">{options.items.map(option => <li key={option.id}>
          <button type="button" disabled={rows.some(row => row.component_id === option.id)} onClick={() => add(option)}>{option.name}{option.code ? ` · ${option.code}` : ''}</button></li>)}</ul>
          : <small>Nenhum produto simples encontrado.</small>)}</div>}
    </>}
  </Modal>;
}
