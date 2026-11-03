import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { quantityText, stockDate } from '../lib/stock-model';
import type { StockWarehouseOption } from '../lib/stock-launch-model';
import { parseWarehouseOptions } from '../lib/stock-supply-model';
import { COUNT_AWARE, COUNT_DONE, COUNT_EMPTY_TEXT, COUNT_EMPTY_TITLE, COUNT_NO_READING, COUNT_REJECTIONS, COUNT_RESTART, COUNT_SAVED_INFO, COUNT_SCOPE_ALL, COUNT_SCOPE_COUNTED, COUNT_SINGLE_WAREHOUSE, COUNT_SKIP_REASONS,
  countDeleteQuestion, countMultiplier, logLine, parseCount, parseCountBalance, type CountBalanceResult, type CountItem, type CountRejection, type StockCountState } from '../lib/stock-count-model';
import { StockSidePanel, useStockCommand } from './StockMovementPanel';
import StockPrintPreview from './StockPrintPreview';
import BarcodeCamera, { cameraSupported } from './BarcodeCamera';
import { Modal } from './Modal';
import { Icon } from './Icon';
import './stock.css';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const BASE = '/v1/estoque/conferencias';
const ALL = '';
const fail = (error: unknown) => error instanceof AccessError ? error.status === 409 ? 'A conferência foi alterada em outra tela. Recarregue a conferência e confira as leituras.' : error.status === 403 ? 'Seu perfil não permite conferir o estoque.' : error.status === 404 ? 'A conferência ou a leitura não está mais disponível. Recarregue a conferência.' : error.status === 400 ? 'Confira o depósito, as leituras e a quantidade.' : 'Não foi possível concluir. Tente novamente.' : 'Não foi possível concluir. Tente novamente.';
type ReadAnswer = { outcome: 'read' | 'rejected'; reason?: CountRejection; replayed: boolean; count: StockCountState | null };
const parseRead = (value: unknown): ReadAnswer => {
  const raw = value as { outcome?: unknown; reason?: unknown; replayed?: unknown; count?: unknown };
  if (!raw || (raw.outcome !== 'read' && raw.outcome !== 'rejected') || typeof raw.replayed !== 'boolean') throw new Error('INVALID_COUNT');
  if (raw.outcome === 'rejected' && !Object.hasOwn(COUNT_REJECTIONS, String(raw.reason))) throw new Error('INVALID_COUNT');
  return { outcome: raw.outcome, reason: raw.reason as CountRejection | undefined, replayed: raw.replayed, count: raw.count === undefined ? null : parseCount(raw.count) };
};
const parseMutation = (value: unknown) => { const raw = value as { replayed?: unknown; count?: unknown }; if (!raw || typeof raw.replayed !== 'boolean') throw new Error('INVALID_COUNT'); return { replayed: raw.replayed, count: raw.count === undefined || raw.count === null ? null : parseCount(raw.count) }; };

/** Estoque > Conferência de estoque like Origin: readings saved on the server, Itens lidos with the difference, Gerar balanço. */
export default function StockCount({ controller }: { controller: AccessController }) {
  const snapshot = controller.getSnapshot(), role = snapshot.membership?.role, actor = snapshot.membership?.user_id, allowed = role === 'admin' || role === 'estoque';
  const [count, setCount] = useState<StockCountState | null>(null), [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(''), [reload, setReload] = useState(0);
  const [options, setOptions] = useState<StockWarehouseOption[]>([]), [localWarehouse, setLocalWarehouse] = useState<string | null>(null);
  const [multiplier, setMultiplier] = useState('1'), [code, setCode] = useState(''), [message, setMessage] = useState(''), [notice, setNotice] = useState(''), [queued, setQueued] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<CountItem | null>(null), [confirmRestart, setConfirmRestart] = useState(false), [camera, setCamera] = useState(false);
  const [balanceOpen, setBalanceOpen] = useState(false), [scope, setScope] = useState<'counted' | 'all_active'>('counted'), [aware, setAware] = useState(false), [printReport, setPrintReport] = useState(false);
  const [report, setReport] = useState<{ items: CountItem[]; warehouse: string; result: CountBalanceResult } | null>(null), [summary, setSummary] = useState<CountBalanceResult | null>(null);
  const [zoom, setZoom] = useState<CountItem | null>(null);
  const reader = useStockCommand(controller), mutation = useStockCommand(controller), balance = useStockCommand(controller);
  const queue = useRef<{ code: string; quantity: string }[]>([]), liveCount = useRef<StockCountState | null>(count), liveAllowed = useRef(allowed);
  liveCount.current = count; liveAllowed.current = allowed;
  // Another actor never inherits this actor's count, queue or pending command.
  const lastActor = useRef(actor);
  useEffect(() => { if (lastActor.current === actor) return; lastActor.current = actor; queue.current = []; setQueued(0); setCount(null); setReport(null); setSummary(null); setReload(value => value + 1); }, [actor]);
  useEffect(() => {
    if (!allowed) return;
    const request = new AbortController(); setLoading(true); setLoadError('');
    // 181: the Depósito selector reads the light warehouse list, not the totals of /totais.
    void Promise.all([controller.stock(`${BASE}/atual`, { signal: request.signal }), controller.stock('/v1/estoque/depositos/opcoes', { signal: request.signal })]).then(([raw, list]) => {
      if (request.signal.aborted) return;
      const current = parseCount((raw as { count?: unknown }).count ?? null), warehouses = parseWarehouseOptions(list).filter(item => item.active);
      setCount(current); liveCount.current = current; setOptions(warehouses);
      setLocalWarehouse(previous => previous ?? warehouses.find(item => item.is_default)?.id ?? ALL);
    }).catch(problem => { if (!request.signal.aborted && !aborted(problem)) setLoadError(fail(problem)); }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [controller, reload, actor, allowed]);
  const busy = reader.busy || mutation.busy || balance.busy;
  const warehouse = count ? count.session.warehouse_id ?? ALL : localWarehouse ?? ALL;
  const warehouseName = (id: string | null) => !id ? 'Todos' : options.find(item => item.id === id)?.name ?? count?.session.warehouse_name ?? 'Depósito';
  // Readings are sent one at a time, in order; an unknown result stops the queue until "Conferir resultado".
  const pump = () => {
    if (!liveAllowed.current || reader.pending()) return;
    const next = queue.current.shift(); setQueued(queue.current.length); if (!next) return;
    const current = liveCount.current;
    void reader.run(`${BASE}/leituras`, 'POST', { session_id: current?.session.id ?? null, code: next.code, quantity: next.quantity, warehouse_id: current ? current.session.warehouse_id : (localWarehouse || null) }, parseRead, answer => {
      if (answer.outcome === 'rejected') setMessage(`${COUNT_REJECTIONS[answer.reason!]} (${next.code})`); else setMessage('');
      if (answer.replayed) setReload(value => value + 1); else { setCount(answer.count); liveCount.current = answer.count; }
    }, fail).then(() => { if (!reader.pending()) pump(); });
  };
  const enqueue = (text: string) => {
    if (!allowed) return;
    const value = text.trim(); if (!value) return;
    let quantity: string; try { quantity = countMultiplier(multiplier); } catch (problem) { setMessage((problem as Error).message); return; }
    if (queue.current.length >= 20) { setMessage('Aguarde as leituras anteriores serem salvas.'); return; }
    queue.current.push({ code: value.slice(0, 100), quantity }); setQueued(queue.current.length); setCode(''); setNotice(''); setSummary(null); pump();
  };
  const submitRead = (event: FormEvent) => { event.preventDefault(); enqueue(code); };
  const retryRead = () => { void reader.run(`${BASE}/leituras`, 'POST', null, parseRead, answer => {
    if (answer.outcome === 'rejected') setMessage(COUNT_REJECTIONS[answer.reason!]); else setMessage('');
    if (answer.replayed) setReload(value => value + 1); else { setCount(answer.count); liveCount.current = answer.count; } }, fail).then(() => { if (!reader.pending()) pump(); }); };
  // Excluir leitura, Depósito and Reiniciar: one command at a time; an unknown result is retried with the same command.
  const retry = useRef<(() => void) | null>(null);
  const mutate = (path: string, body: Record<string, unknown>) => {
    if (!liveAllowed.current || mutation.pending()) return;
    const run = (payload: Record<string, unknown> | null) => void mutation.run(path, 'POST', payload, parseMutation, answer => { retry.current = null; setMessage(''); if (answer.count) { setCount(answer.count); liveCount.current = answer.count; } else setReload(value => value + 1); }, fail)
      .then(() => { if (!mutation.uncertain && !mutation.pending()) retry.current = null; });
    retry.current = () => { if (liveAllowed.current) run(null); }; run(body);
  };
  const changeWarehouse = (id: string) => {
    if (!allowed || busy) return;
    if (!count) { setLocalWarehouse(id); return; }
    mutate(`${BASE}/${count.session.id}/deposito`, { expected_version: count.session.version, warehouse_id: id || null });
  };
  const remove = (item: CountItem) => { if (!allowed || !count) return; setConfirmDelete(null); mutate(`${BASE}/${count.session.id}/exclusoes`, { product_id: item.product_id }); };
  const restart = () => { if (!allowed || !count) return; setConfirmRestart(false); setSummary(null); mutate(`${BASE}/${count.session.id}/reinicio`, { expected_version: count.session.version }); };
  const openBalance = () => {
    if (!allowed || busy) return; setMessage('');
    if (!warehouse) { setMessage(COUNT_SINGLE_WAREHOUSE); return; }
    if (!count || count.readings === 0) { setMessage(COUNT_NO_READING); return; }
    setScope('counted'); setAware(false); setPrintReport(false); setBalanceOpen(true);
  };
  const generate = () => {
    if (!allowed || !count || (scope === 'all_active' && !aware && !balance.uncertain)) return;
    const snapshotItems = count.items, name = warehouseName(count.session.warehouse_id), print = printReport;
    void balance.run(`${BASE}/${count.session.id}/balanco`, 'POST', balance.uncertain ? null : { expected_version: count.session.version, scope, confirmed: scope === 'all_active' ? aware : false }, parseCountBalance, result => {
      setBalanceOpen(false); setCount(null); liveCount.current = null; setSummary(result); setNotice(COUNT_DONE);
      if (print) setReport({ items: snapshotItems, warehouse: name, result });
    }, problem => problem instanceof AccessError && problem.status === 400 ? `${COUNT_SINGLE_WAREHOUSE} ${COUNT_NO_READING}` : fail(problem));
  };
  if (!allowed && !count && !reader.pending() && !mutation.pending() && !balance.pending()) return <section className="real-state-panel"><h1>Conferência de estoque não liberada</h1><p>Seu perfil não permite conferir o estoque.</p></section>;
  return <>
    {!allowed && <section className="real-state-panel"><h1>Conferência de estoque não liberada</h1><p>Seu perfil atual não permite conferir o estoque. A conferência em andamento fica preservada e volta a aparecer se a permissão for restabelecida.</p></section>}
    <section className="stock-count" hidden={!allowed} inert={!allowed} aria-hidden={!allowed}>
      <header className="real-heading stock-count-heading"><h1>Conferência de estoque</h1><div className="real-editor-actions">
        <button type="button" className="secondary-button" disabled={busy || !count} onClick={() => setConfirmRestart(true)}>Reiniciar</button>
        <button type="button" className="primary-button" disabled={busy} onClick={openBalance}>Gerar balanço</button></div></header>
      {loading && <p role="status">Carregando conferência, aguarde...</p>}
      {loadError && <p className="real-alert" role="alert">{loadError}<button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>Tentar novamente</button></p>}
      {notice && <p className="real-success" role="status">{notice}</p>}
      {summary && <p className="real-help">{summary.changed.length} produto(s) com balanço lançado, {summary.unchanged} sem diferença{summary.skipped.length ? `, ${summary.skipped.length} ignorado(s): ${summary.skipped.map(item => `${item.name} (${COUNT_SKIP_REASONS[item.reason] ?? item.reason})`).join('; ')}` : ''}.</p>}
      {(message || reader.error || mutation.error) && <p className="real-alert" role="alert">{message || reader.error || mutation.error}
        {reader.uncertain && <button type="button" className="text-button" disabled={reader.busy} onClick={retryRead}>Conferir resultado</button>}
        {mutation.uncertain && <button type="button" className="text-button" disabled={mutation.busy} onClick={() => retry.current?.()}>Conferir resultado</button>}</p>}
      <div className="stock-tabs"><h2>Leitura</h2></div>
      <form className="stock-count-reading" onSubmit={submitRead}><fieldset disabled={loading || Boolean(loadError)}><legend className="real-sr-only">Leitura de produtos</legend>
        <div className="form-field"><label htmlFor="stock-count-warehouse">Depósito</label><select id="stock-count-warehouse" value={warehouse} disabled={busy || reader.uncertain || mutation.uncertain} onChange={event => changeWarehouse(event.target.value)}><option value={ALL}>Todos</option>{options.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
        <div className="form-field"><label htmlFor="stock-count-total">Total lidos</label><input id="stock-count-total" readOnly value={quantityText(count?.total_read ?? '0.000000')} /></div>
        <div className="form-field"><label htmlFor="stock-count-multiplier">Quantidade a ser lida</label><input id="stock-count-multiplier" inputMode="decimal" maxLength={20} value={multiplier} onChange={event => setMultiplier(event.target.value)} /></div>
        <div className="form-field real-field-wide stock-count-code"><label htmlFor="stock-count-code">GTIN, GTIN tributário ou código (SKU) do produto</label>
          <span><input id="stock-count-code" autoComplete="off" maxLength={100} value={code} disabled={reader.uncertain} onChange={event => setCode(event.target.value)} /><button type="submit" className="primary-button" disabled={reader.uncertain} aria-label="Ler produto" title="Ler produto"><Icon name="barcode" size={14} /></button>
            {cameraSupported() && <button type="button" className="secondary-button" aria-label="Ler pela câmera" title="Ler pela câmera" disabled={reader.uncertain} onClick={() => setCamera(true)}><Icon name="qrcode" size={14} /></button>}</span>
          {queued > 0 && <small role="status">{queued} leitura(s) aguardando para salvar…</small>}</div>
        <div className="form-field real-field-wide"><label htmlFor="stock-count-log">Log de leituras <span className="stock-info" title={COUNT_SAVED_INFO} aria-label={COUNT_SAVED_INFO}><Icon name="circle-info" size={11} /></span></label>
          <textarea id="stock-count-log" readOnly rows={4} value={(count?.log ?? []).map(entry => logLine(entry, quantityText)).join('\n')} /></div>
      </fieldset></form>
      <section className="real-records"><h2 className="stock-count-subtitle">Itens lidos</h2>
        {count && count.items.length > 0 ? <><div className="table-scroll" tabIndex={0} role="region" aria-label="Itens lidos"><table className="data-table real-table stock-count-table"><thead><tr><th>#</th><th className="stock-count-image">Imagem</th><th>Produto</th><th className="stock-count-location">Localização</th><th className="numeric">Lidos</th><th className="numeric">Estoque físico atual</th><th className="numeric">Diferença</th><th><span className="real-sr-only">Excluir leitura</span></th></tr></thead>
          <tbody>{count.items.map((item, index) => <tr key={item.product_id}><td>{count.items.length - index}</td>
            <td className="stock-count-image">{item.image_url ? <button type="button" className="stock-count-thumb" aria-label={`Ampliar imagem de ${item.name}`} title="Clique para ampliar" onClick={() => setZoom(item)}><img src={item.image_url} alt="" loading="lazy" referrerPolicy="no-referrer" /></button> : <span className="stock-thumb-empty" aria-label="Sem imagem"><Icon name="image" size={14} /></span>}</td>
            <td>{item.code ? `${item.code} - ` : ''}{item.name}</td><td className="stock-count-location">{item.location ?? ''}</td><td className="numeric">{quantityText(item.counted)}</td>
            <td className={`numeric${item.physical.startsWith('-') ? ' is-negative' : ''}`}>{quantityText(item.physical)}</td><td className={`numeric${item.difference.startsWith('-') ? ' is-negative' : ''}`}>{quantityText(item.difference)}</td>
            <td><button type="button" className="icon-button" aria-label={`Excluir leitura ${item.name}`} title="Excluir leitura" disabled={busy || mutation.uncertain} onClick={() => setConfirmDelete(item)}><Icon name="trash-can" size={13} /></button></td></tr>)}</tbody></table></div>
          {count.items_total > count.items.length && <p className="real-help">Mostrando os {count.items.length} produtos lidos mais recentes de {count.items_total}; o balanço considera todas as leituras.</p>}</>
          : !loading && <div className="origin-empty"><span><Icon name="exclamation" size={22} /></span><h2>{COUNT_EMPTY_TITLE}</h2><p>{COUNT_EMPTY_TEXT}</p></div>}
      </section>
    </section>
    {confirmDelete && <Modal title="Excluir leitura" onClose={() => setConfirmDelete(null)} actions={<><button type="button" className="secondary-button" onClick={() => setConfirmDelete(null)}>Não</button><button type="button" className="primary-button" onClick={() => remove(confirmDelete)}>Sim</button></>}><p>{countDeleteQuestion(confirmDelete.name)}</p></Modal>}
    {confirmRestart && <Modal title="Reiniciar conferência" onClose={() => setConfirmRestart(false)} actions={<><button type="button" className="secondary-button" onClick={() => setConfirmRestart(false)}>Não</button><button type="button" className="primary-button" onClick={restart}>Sim</button></>}><p>{COUNT_RESTART}</p></Modal>}
    {camera && <BarcodeCamera onClose={() => setCamera(false)} onCode={enqueue} />}
    {zoom?.image_url && <Modal title={zoom.name} onClose={() => setZoom(null)} actions={<button type="button" className="secondary-button" onClick={() => setZoom(null)}>Fechar</button>}><img className="stock-count-zoom" src={zoom.image_url} alt={zoom.name} referrerPolicy="no-referrer" /></Modal>}
    {balanceOpen && count && <StockSidePanel title="Gerar balanço" labelledBy="stock-count-balance-title" onClose={() => { if (!balance.busy && !balance.uncertain) setBalanceOpen(false); }} closeDisabled={balance.busy || balance.uncertain}
      footer={<><button type="button" className="secondary-button" disabled={balance.busy || balance.uncertain} onClick={() => setBalanceOpen(false)}>Cancelar</button><button type="button" className="primary-button" disabled={balance.busy || (scope === 'all_active' && !aware && !balance.uncertain)} onClick={generate}>{balance.busy ? 'Gerando…' : balance.uncertain ? 'Conferir resultado' : 'Gerar balanço'}</button></>}>
      {balance.error && <p className="real-alert" role="alert">{balance.error}</p>}
      <fieldset className="stock-panel-form" disabled={balance.busy || balance.uncertain}><legend className="real-sr-only">Opções do balanço</legend>
        <div className="form-field real-field-wide"><label htmlFor="stock-count-scope">Gerar balanço para:</label><select id="stock-count-scope" value={scope} onChange={event => setScope(event.target.value === 'all_active' ? 'all_active' : 'counted')}><option value="counted">Apenas produtos conferidos</option><option value="all_active">Todos os produtos ativos cadastrados</option></select></div>
        <p className="real-help">{scope === 'counted' ? COUNT_SCOPE_COUNTED : COUNT_SCOPE_ALL} Depósito: {warehouseName(count.session.warehouse_id)}.</p>
        {scope === 'all_active' && <label className="stock-radio"><input type="checkbox" id="stock-count-aware" checked={aware} onChange={event => setAware(event.target.checked)} />{COUNT_AWARE}</label>}
        <label className="stock-radio"><input type="checkbox" id="stock-count-print" checked={printReport} onChange={event => setPrintReport(event.target.checked)} />Imprimir relatório de conferências</label>
      </fieldset>
    </StockSidePanel>}
    {report && <StockPrintPreview title="Relatório de conferências" onClose={() => setReport(null)}>
      <h1>Relatório de conferência de estoque</h1>
      <dl><div><dt>Depósito</dt><dd>{report.warehouse}</dd></div><div><dt>Data</dt><dd>{report.result.occurred_on.split('-').reverse().join('/')}</dd></div>
        <div><dt>Balanço para</dt><dd>{report.result.balance_scope === 'all_active' ? 'Todos os produtos ativos cadastrados' : 'Apenas produtos conferidos'}</dd></div><div><dt>Resultado</dt><dd>{report.result.changed.length} lançado(s), {report.result.unchanged} sem diferença, {report.result.skipped.length} ignorado(s)</dd></div></dl>
      <table><thead><tr><th>Produto</th><th>Localização</th><th className="numeric">Lidos</th><th className="numeric">Estoque físico</th><th className="numeric">Diferença</th></tr></thead>
        <tbody>{report.items.map(item => <tr key={item.product_id}><td>{item.code ? `${item.code} - ` : ''}{item.name}</td><td>{item.location ?? ''}</td><td className="numeric">{quantityText(item.counted)}</td><td className="numeric">{quantityText(item.physical)}</td><td className="numeric">{quantityText(item.difference)}</td></tr>)}</tbody></table>
      {report.result.skipped.length > 0 && <><h2>Produtos ignorados</h2><ul>{report.result.skipped.map(item => <li key={item.product_id}>{item.name}: {COUNT_SKIP_REASONS[item.reason] ?? item.reason}</li>)}</ul></>}
      <p className="stock-print-foot">Emitido em {stockDate().split('-').reverse().join('/')} (horário de São Paulo).</p>
    </StockPrintPreview>}
  </>;
}
