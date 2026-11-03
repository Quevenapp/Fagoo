import { useEffect, useId, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { EMPTY_MIRROR_FILTERS, parseStockMirrorPage, stockMirrorIssue, stockMirrorNegative, stockMirrorQuantity, stockMirrorQuery, type StockMirrorFilters, type StockMirrorPage } from '../lib/stock-origin-mirror-model';
import './stock-origin-mirror.css';

type Controller = Pick<AccessController, 'stock' | 'getSnapshot' | 'subscribe'>;
const readers = new Set(['admin', 'estoque', 'vendas', 'fiscal', 'consulta']);
const sessionKey = (controller: Controller) => { const state = controller.getSnapshot(); return `${state.phase}:${state.membership?.user_id ?? ''}:${state.membership?.role ?? ''}`; };
const allowed = (controller: Controller) => { const state = controller.getSnapshot(); return state.phase === 'ready' && Boolean(state.membership?.user_id) && readers.has(state.membership?.role ?? ''); };
const moment = (value: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
const readFailure = (error: unknown) => error instanceof AccessError && error.status === 403 ? 'Seu perfil não permite consultar o espelho de estoque.' : 'Não foi possível consultar o estoque observado no Origin. Tente novamente.';

/** Only GETs the stock mirror. Neither balances nor the informational difference produce native effects. */
export default function StockOriginMirror({ controller, productId = null }: { controller: Controller; productId?: string | null }) {
  const uid = useId(), request = useRef<AbortController | null>(null), live = useRef({ controller, productId }); live.current = { controller, productId };
  const [session, setSession] = useState(() => sessionKey(controller));
  const [draft, setDraft] = useState<StockMirrorFilters>(EMPTY_MIRROR_FILTERS), [filters, setFilters] = useState<StockMirrorFilters>(EMPTY_MIRROR_FILTERS);
  const [cursors, setCursors] = useState<(number | null)[]>([null]), [reload, setReload] = useState(0), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [result, setResult] = useState<{ controller: Controller; key: string; value: StockMirrorPage } | null>(null);
  const after = cursors[cursors.length - 1], query = stockMirrorQuery(filters, productId, after), key = `${session}:${query}:${reload}`;
  const authorizedResult = result?.controller === controller && sessionKey(controller) === session && result.key.startsWith(`${session}:`) ? result : null;
  const current = authorizedResult?.key === key ? authorizedResult.value : null;
  useEffect(() => {
    const update = () => { const next = sessionKey(controller); if (next === session) return; request.current?.abort(); setResult(null); setError(''); setSession(next); setCursors([null]); };
    update(); return controller.subscribe(update);
  }, [controller, session]);
  useEffect(() => { setCursors([null]); }, [productId]);
  useEffect(() => {
    const pending = new AbortController(); request.current = pending; setError('');
    if (!allowed(controller)) { setLoading(false); return () => pending.abort(); }
    const valid = () => !pending.signal.aborted && request.current === pending && live.current.controller === controller && live.current.productId === productId && sessionKey(controller) === session && allowed(controller);
    setLoading(true);
    void controller.stock(query, { method: 'GET', signal: pending.signal }).then(raw => {
      if (!valid()) return;
      const value = parseStockMirrorPage(raw, productId, after);
      if (valid()) setResult({ controller, key, value });
    }).catch(problem => { if (valid()) setError(readFailure(problem)); }).finally(() => { if (valid()) setLoading(false); });
    return () => pending.abort();
  }, [controller, key, productId]);
  const apply = () => { if (!allowed(controller)) return; setCursors([null]); setFilters({ ...draft, query: draft.query.trim() }); setReload(value => value + 1); };
  if (!allowed(controller)) return <p className="real-help">Consulta do espelho de estoque indisponível nesta sessão.</p>;
  return <section className="stock-origin-mirror real-records" aria-labelledby={`${uid}-title`} aria-busy={loading}>
    <header className="stock-mirror-heading"><div><span className="stock-source-badge is-origin">Origem Origin</span><h2 id={`${uid}-title`}>Estoque observado no Origin</h2></div><span className="real-mode">Somente leitura</span></header>
    <p className="real-help">Cada linha é uma posição de produto e depósito no horário da observação, em São Paulo. Os saldos não são somados entre depósitos. Confira no Origin antes de decidir sobre venda ou disponibilidade.</p>
    {productId && <p className="real-help">Espelho filtrado pelo vínculo do produto selecionado. Produtos sem vínculo aparecem na consulta geral.</p>}
    <form className="stock-mirror-filters" onSubmit={event => { event.preventDefault(); apply(); }}>
      <label htmlFor={`${uid}-query`}>Buscar produto ou ID Origin<input id={`${uid}-query`} type="search" maxLength={120} value={draft.query} onChange={event => setDraft(previous => ({ ...previous, query: event.target.value }))} /></label>
      <label htmlFor={`${uid}-warehouse`}>Depósito do Origin<select id={`${uid}-warehouse`} value={draft.warehouse} onChange={event => setDraft(previous => ({ ...previous, warehouse: event.target.value }))}><option value="">Todos os depósitos</option>{authorizedResult?.value.warehouses.map(warehouse => <option key={warehouse.source_id} value={warehouse.source_id}>{warehouse.name} · ID {warehouse.source_id}</option>)}</select></label>
      <label htmlFor={`${uid}-state`}>Conferência<select id={`${uid}-state`} value={draft.state} onChange={event => setDraft(previous => ({ ...previous, state: event.target.value as StockMirrorFilters['state'] }))}><option value="">Todas as posições</option><option value="negative">Saldos negativos</option><option value="pending">Com pendências</option><option value="deleted">Excluídos na fonte</option></select></label>
      <button type="submit" className="secondary-button" disabled={loading}>Consultar espelho</button>
      <button type="button" className="text-button" disabled={loading} onClick={() => { setDraft(EMPTY_MIRROR_FILTERS); setFilters(EMPTY_MIRROR_FILTERS); setCursors([null]); setReload(value => value + 1); }}>Limpar filtros</button>
    </form>
    {loading && <p role="status">Consultando posições do Origin…</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    {current && <>
      <p className={current.coverage.partial ? 'real-notice' : 'real-help'}><strong>{current.coverage.partial ? 'Cobertura parcial.' : 'Cobertura da projeção.'}</strong> {current.coverage.products} de {current.coverage.raw_products} produtos coletados têm posição no espelho; {current.coverage.pending_products} produto(s) aguardando projeção. Valores ausentes, nulos ou inválidos permanecem sem saldo informado; nunca equivalem a zero.</p>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Posições de estoque observadas no Origin"><table className="data-table real-table stock-mirror-table"><thead><tr><th>Produto</th><th>Depósito</th><th className="numeric">Físico</th><th className="numeric">Virtual</th><th className="numeric">Físico − virtual</th><th>Observado em</th><th>Pendências</th></tr></thead><tbody>{current.items.map(item => <tr key={item.id}>
        <td><strong>{item.product_name}</strong>{item.product_code && <small>Código: {item.product_code}</small>}<small>Origem Origin · Produto ID {item.product_source_id}</small>{item.unit && <small>Unidade: {item.unit}</small>}{item.source_deleted && <small>Excluído no Origin</small>}</td>
        <td>{item.warehouse_name}<small>{item.warehouse_source_id ? `Depósito ID ${item.warehouse_source_id}` : 'Depósito não informado'}</small></td>
        <td className={`numeric${stockMirrorNegative(item.physical) ? ' is-negative' : ''}`}>{stockMirrorQuantity(item.physical, item.physical_state)}</td>
        <td className={`numeric${stockMirrorNegative(item.virtual) ? ' is-negative' : ''}`}>{stockMirrorQuantity(item.virtual, item.virtual_state)}</td>
        <td className={`numeric${stockMirrorNegative(item.reserved) ? ' is-negative' : ''}`}>{stockMirrorQuantity(item.reserved)}<small>Informativo</small></td>
        <td><time dateTime={item.observed_at}>{moment(item.observed_at)}</time><small>Versão {item.source_version}</small></td>
        <td>{item.physical_state !== 'value' || item.virtual_state !== 'value' ? <small>Cobertura parcial desta posição</small> : null}{item.issues.length ? <ul>{item.issues.map((issue, index) => <li key={`${issue}:${index}`}>{stockMirrorIssue(issue)}</li>)}</ul> : 'Sem pendências informadas'}</td>
      </tr>)}</tbody></table></div>
      {!current.items.length && <p className="empty-state">Nenhuma posição observada para estes filtros. A ausência de uma posição não significa saldo zero.</p>}
      <nav className="stock-mirror-pagination" aria-label="Páginas do espelho"><button type="button" className="secondary-button" disabled={cursors.length === 1} onClick={() => setCursors(previous => previous.slice(0, -1))}>Página anterior</button><span>Página {cursors.length} · {current.items.length} posições</span><button type="button" className="secondary-button" disabled={!current.has_more} onClick={() => { if (current.next_after !== null) setCursors(previous => [...previous, current.next_after]); }}>Próxima página</button></nav>
      <p className="real-help">Físico − virtual é uma diferença informativa observada no Origin. Não cria reserva nem representa disponibilidade nativa no FAGOO.</p>
    </>}
    <div className="stock-mirror-readonly" aria-describedby={`${uid}-readonly`}><div><button type="button" className="secondary-button" disabled>Lançar saldo do espelho</button><button type="button" className="secondary-button" disabled>Reservar saldo do espelho</button><button type="button" className="secondary-button" disabled>Transferir saldo do espelho</button></div><p id={`${uid}-readonly`} className="real-help">Estas ações estão indisponíveis: o espelho só consulta dados do Origin e não lança, estorna, reserva, transfere ou abre saldo no estoque nativo. Os lançamentos de origem FAGOO ficam na área separada abaixo.</p></div>
  </section>;
}
