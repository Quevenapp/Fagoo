import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AccessController } from '../lib/real-access';
import {
  COMPONENT_PROBLEMS, MIRROR_NOTICE, NEW_STRUCTURE, POST_MODE_LABELS, STOCK_TYPE_HELP, STOCK_TYPE_LABELS, componentOptionsPath, lineTotal, parseComponentOptions, parseComposition,
  structureDraft, structureKey, structurePayload, sumTotals, totalText, type ComponentOption, type CompositionPostMode, type CompositionStockType, type CompositionView, type StructureDraft, type StructureRow,
} from '../lib/stock-composition-model';
import { quantityText } from '../lib/stock-model';
import { Icon } from './Icon';
import './stock-composition.css';

// Estoque lane (222): aba "Estrutura" do formulário do produto ("Com composição"), no padrão do Origin. A estrutura é gravada com o
// produto, no mesmo comando de "Salvar produto" (data.composition), com versão esperada e "Conferir resultado" do formulário.
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
type State = { key: string; status: 'loading' | 'ready' | 'error'; view: CompositionView | null };

/** Reads the Estrutura of an existing product (also for a simple product: the compositions that use it and the Preferências). */
export function useProductComposition(controller: Pick<AccessController, 'stock'>, productId: string | null, version: number | null) {
  const key = productId ? `${productId}:${version ?? 0}` : 'new';
  const [state, setState] = useState<State>(() => ({ key, status: productId ? 'loading' : 'ready', view: null }));
  const [draft, setDraft] = useState<StructureDraft>(() => ({ ...NEW_STRUCTURE, rows: [] }));
  const [baseline, setBaseline] = useState(() => structureKey(NEW_STRUCTURE));
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!productId) { setState({ key, status: 'ready', view: null }); return; }
    const request = new AbortController(); setState({ key, status: 'loading', view: null });
    void Promise.resolve().then(() => controller.stock(`/v1/estoque/composicoes/${productId}`, { signal: request.signal })).then(raw => {
      if (request.signal.aborted) return;
      const view = parseComposition(raw, productId), next = structureDraft(view);
      setState({ key, status: 'ready', view }); setDraft(next); setBaseline(structureKey(next));
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) setState({ key, status: 'error', view: null }); });
    return () => request.abort();
  }, [controller, key, attempt]);
  const current = state.key === key ? state : { key, status: 'loading' as const, view: null };
  const shape = structureKey(draft), dirty = current.status === 'ready' && shape !== baseline;
  return { status: current.status, view: current.view, draft, setDraft, dirty, key: shape, retry: () => setAttempt(value => value + 1) };
}
export type ProductCompositionState = ReturnType<typeof useProductComposition>;

/**
 * What the product save carries for the composition: the structure of a "Com composição" product (always on inclusion, and on
 * edition when it changed) or, for a component used by compositions with an update option on, the composition update. Throws the
 * message to show.
 */
export function compositionSavePayload(state: ProductCompositionState, format: string, isNew: boolean): Record<string, unknown> {
  if (format === 'E') {
    // A structure that could not be read is never rewritten: the product is saved alone.
    if (state.status !== 'ready') return {};
    if (!isNew && !state.dirty) return {};
    return { composition: structurePayload(state.draft, state.view?.composition?.version ?? 0) };
  }
  const settings = state.view?.settings;
  if (!isNew && state.status === 'ready' && state.view && state.view.used_in > 0 && settings && (settings.update_cost || settings.update_price || settings.update_weight)) return { composition_sync: true };
  return {};
}

/** The tab itself: Tipo de estoque, Lançar estoque, the grid of components and the totals. */
export function ProductStructurePanel({ controller, state, productId, locked, invalid }: { controller: Pick<AccessController, 'stock'>; state: ProductCompositionState; productId: string | null; locked: boolean; invalid: boolean }) {
  const { draft, setDraft, view, status } = state;
  if (status === 'loading') return <p role="status">Carregando a estrutura…</p>;
  if (status === 'error') return <p className="real-alert" role="alert">Não foi possível carregar a estrutura desta composição. Nada será alterado nela ao salvar.<button type="button" className="text-button" onClick={state.retry}>Tentar novamente</button></p>;
  const change = (patch: Partial<StructureDraft>) => setDraft(current => ({ ...current, ...patch }));
  const setRow = (index: number, patch: Partial<StructureRow>) => setDraft(current => ({ ...current, rows: current.rows.map((row, i) => i === index ? { ...row, ...patch } : row) }));
  const chooseType = (value: CompositionStockType) => change({ stock_type: value, ...(value === 'virtual' ? { post_mode: 'components' as const } : {}) });
  const costs = draft.rows.map(row => lineTotal(row.cost_price, row.quantity)), sales = draft.rows.map(row => lineTotal(row.price, row.quantity));
  const settings = view?.settings, applied = settings ? [settings.update_price && 'preço de venda', settings.update_weight && 'peso', settings.update_cost && 'preço de custo'].filter(Boolean) as string[] : [];
  return <div className="product-structure">
    {productId && view && !view.composition && view.product.format === 'E' && <p className="real-notice" role="status">{MIRROR_NOTICE}</p>}
    <fieldset disabled={locked} className="real-editor-fields"><legend className="real-sr-only">Estrutura</legend>
      <div className="form-field"><label htmlFor="composition-stock-type">Tipo de estoque<span className="product-info" title={STOCK_TYPE_HELP}><Icon name="circle-info" size={11} /></span></label>
        <select id="composition-stock-type" value={draft.stock_type} onChange={event => chooseType(event.target.value as CompositionStockType)}>{(Object.keys(STOCK_TYPE_LABELS) as CompositionStockType[]).map(value => <option key={value} value={value}>{STOCK_TYPE_LABELS[value]}</option>)}</select>
        <small>{draft.stock_type === 'virtual' ? `O estoque da composição é o máximo de composições completas com os componentes de cada depósito.${productId ? ' Se este produto já tem saldo próprio, salve-o como Físico e zere esse saldo com um Balanço antes de mudar para Virtual.' : ''}` : 'A composição tem estoque próprio, lançado e conferido como o de um produto.'}</small></div>
      <div className="form-field"><label htmlFor="composition-post-mode">Lançar estoque</label>
        <select id="composition-post-mode" value={draft.post_mode} disabled={locked || draft.stock_type === 'virtual'} onChange={event => change({ post_mode: event.target.value as CompositionPostMode })}>{(Object.keys(POST_MODE_LABELS) as CompositionPostMode[]).map(value => <option key={value} value={value}>{POST_MODE_LABELS[value]}</option>)}</select>
        <small>{draft.stock_type === 'virtual' ? 'Com estoque Virtual, vendas e lançamentos movimentam os componentes.' : draft.post_mode === 'product' ? 'Vendas e lançamentos movimentam só a composição.' : draft.post_mode === 'components' ? 'Vendas e lançamentos movimentam só os componentes.' : 'Vendas e lançamentos movimentam a composição e os componentes.'}</small></div>
    </fieldset>
    <div className="product-grid"><table className="data-table"><thead><tr><th scope="col">nº</th><th scope="col">Componente</th><th scope="col">Código (SKU)</th><th scope="col" className="numeric">Qtde</th><th scope="col" className="numeric">Estoque</th>
      <th scope="col" className="numeric">Preço custo</th><th scope="col" className="numeric">Preço custo total</th><th scope="col" className="numeric">Preço venda</th><th scope="col" className="numeric">Preço venda total</th><th scope="col"><span className="real-sr-only">Ações</span></th></tr></thead>
      <tbody>{draft.rows.length ? draft.rows.map((row, index) => <tr key={`${index}:${row.component_id}`}>
        <td>{index + 1}</td>
        <td>{row.component_id ? <>{productId === null ? row.name : <Link to={`/cadastros-reais?cadastro=products&registro=${row.component_id}`}>{row.name}</Link>}{row.problem && <small className="is-error">{COMPONENT_PROBLEMS[row.problem] ?? 'Componente indisponível.'}</small>}</>
          : <ComponentSearch controller={controller} exclude={productId} taken={draft.rows.map(item => item.component_id)} disabled={locked} index={index} onPick={option => setRow(index, { component_id: option.id, name: option.name, code: option.code, unit: option.unit, price: option.price, cost_price: option.cost_price, stock: option.stock, problem: null })} />}</td>
        <td>{row.code ?? '—'}</td>
        <td className="numeric"><input aria-label={`Quantidade do componente da linha ${index + 1}`} value={row.quantity} inputMode="decimal" maxLength={19} disabled={locked} aria-invalid={invalid || undefined} id={index === 0 ? 'catalog-composition' : undefined} onChange={event => setRow(index, { quantity: event.target.value })} /></td>
        <td className="numeric">{row.stock === null ? '—' : <>{quantityText(row.stock)}{row.unit && <small> {row.unit}</small>}</>}</td>
        <td className="numeric">{totalText(row.cost_price === null ? null : lineTotal(row.cost_price, '1'))}</td><td className="numeric">{totalText(costs[index])}</td>
        <td className="numeric">{totalText(row.price === null ? null : lineTotal(row.price, '1'))}</td><td className="numeric">{totalText(sales[index])}</td>
        <td><button type="button" className="icon-button" aria-label={`Remover o componente da linha ${index + 1}`} title="Remover" disabled={locked} onClick={() => setDraft(current => ({ ...current, rows: current.rows.filter((_, i) => i !== index) }))}><Icon name="trash-can" size={12} /></button></td>
      </tr>) : <tr><td colSpan={10} className="real-help">Nenhum componente na estrutura.</td></tr>}</tbody></table>
      <button type="button" id={draft.rows.length ? undefined : 'catalog-composition'} className="text-button" disabled={locked || draft.rows.length >= 100 || draft.rows.some(row => !row.component_id)}
        onClick={() => setDraft(current => ({ ...current, rows: [...current.rows, { component_id: '', name: '', code: null, unit: null, quantity: '1', price: null, cost_price: null, stock: null, problem: null }] }))}><Icon name="plus" size={11} />Adicionar outro item</button></div>
    <dl className="product-structure-totals"><div><dt>Preço Total de Venda</dt><dd>{totalText(sumTotals(sales))}</dd></div><div><dt>Preço Total de Custo</dt><dd>{totalText(sumTotals(costs))}</dd></div></dl>
    {(sales.some(value => value === null) || costs.some(value => value === null)) && draft.rows.length > 0 && <p className="real-help">Componentes sem preço de venda ou sem preço de custo (fornecedor padrão) não entram nos totais.</p>}
    {view?.virtual && draft.stock_type === 'virtual' && <p className="real-help" role="status">Estoque virtual: <strong>{quantityText(view.virtual.quantity)}</strong> (soma dos depósitos considerados{view.virtual.warehouses.length ? `: ${view.virtual.warehouses.filter(w => !w.ignored).map(w => `${w.name} ${quantityText(w.quantity)}`).join(', ')}` : ''}). Calculado com a estrutura salva.</p>}
    <p className="real-help">{applied.length ? `Preferências › Cadastros › Configurações de produtos: ao salvar, o ${applied.join(', o ')} desta composição passa a ser calculado pelos componentes${settings?.update_cost && view && !view.product.default_supplier ? ' (o preço de custo precisa de um fornecedor padrão na aba Fornecedores)' : ''}.`
      : 'O preço de venda, o peso e o preço de custo desta composição não mudam com os componentes (Preferências › Cadastros › Configurações de produtos).'} A estrutura é gravada junto com o produto, em “Salvar produto”.</p>
  </div>;
}

/** "Componente" autocomplete (Origin: "Digite o nome ou código"): simple active products, read with a debounce; late answers are ignored. */
function ComponentSearch({ controller, exclude, taken, disabled, index, onPick }: { controller: Pick<AccessController, 'stock'>; exclude: string | null; taken: string[]; disabled: boolean; index: number; onPick: (option: ComponentOption) => void }) {
  const [query, setQuery] = useState(''), [options, setOptions] = useState<ComponentOption[]>([]), [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    const text = query.trim(); request.current?.abort();
    if (!text) { setOptions([]); setState('idle'); return; }
    const timer = setTimeout(() => {
      const signal = new AbortController(); request.current = signal; setState('busy');
      void Promise.resolve().then(() => controller.stock(componentOptionsPath(text, exclude), { signal: signal.signal })).then(raw => {
        if (signal.signal.aborted) return; setOptions(parseComponentOptions(raw, text)); setState('idle');
      }).catch(failure => { if (!signal.signal.aborted && !aborted(failure)) { setOptions([]); setState('error'); } });
    }, 250);
    return () => clearTimeout(timer);
  }, [controller, query, exclude]);
  const shown = options.filter(option => !taken.includes(option.id));
  return <div className="product-component-search">
    <input aria-label={`Componente da linha ${index + 1}`} value={query} placeholder="Digite o nome ou código" maxLength={120} disabled={disabled} autoComplete="off" onChange={event => setQuery(event.target.value)} />
    {state === 'busy' && <small role="status">Pesquisando…</small>}{state === 'error' && <small className="is-error">Não foi possível pesquisar os produtos.</small>}
    {query.trim() && state === 'idle' && !shown.length && <small>Nenhum produto simples ativo encontrado.</small>}
    {shown.length > 0 && <ul className="product-options" role="listbox" aria-label="Produtos encontrados">{shown.map(option => <li key={option.id}><button type="button" role="option" aria-selected="false" onClick={() => { onPick(option); setQuery(''); setOptions([]); }}>{option.name}{option.code ? ` (${option.code})` : ''}</button></li>)}</ul>}
  </div>;
}
