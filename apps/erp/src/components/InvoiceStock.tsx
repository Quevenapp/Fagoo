import { useEffect, useMemo, useRef, useState } from 'react';
import { useUnsavedForm } from '../hooks/useUnsavedChanges';
import { AccessError, type AccessController } from '../lib/real-access';
import { quantityText } from '../lib/stock-model';
import { BLOCK_TEXT, IGNORED_REASONS, INVOICE_STOCK_BASE, invoiceFlagsPath, parseInvoiceFlags, parseInvoiceStockPreview, parseInvoiceStockResult, parseInvoiceStockState,
  conversionText, factorInput, invoiceUnitsPath, parseInvoiceUnits, parseInvoiceUnitSave, unitRuleText,
  type InvoiceStockFlag, type InvoiceStockPreview, type InvoiceStockResult, type InvoiceStockState, type InvoiceUnits } from '../lib/invoice-stock-model';
import { StockSidePanel, useStockCommand } from './StockMovementPanel';
import { useStockWarehouseOptions } from './StockSupplierPicker';
import { Modal } from './Modal';

// Estoque lane (259): ⋮ Lançar estoque / Estornar estoque of a Brufap note (NF-e de saída, NFC-e e NF-e de entrada) and the letter E of
// the list. The server checks everything again (letter, versions, policy of negative stock, reservations); the screen explains first.
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const brDay = (value: string) => value.split('-').reverse().join('/');
const failure = (error: unknown) => error instanceof AccessError ? error.status === 409 ? 'A nota ou os saldos mudaram em outra operação. Confira de novo antes de confirmar.'
  : error.status === 400 ? 'O estoque não pode ser lançado: confira o depósito, as unidades dos itens (a do produto ou, na nota de entrada, com o fator de conversão do fornecedor ou a unidade tributária) e os saldos. A política da empresa pode não permitir estoque negativo e reservas ativas continuam protegidas.'
    : error.status === 403 ? 'Seu perfil não lança estoque (administrador e estoque).' : error.status === 404 ? 'A nota não está mais disponível.' : 'Não foi possível concluir. Tente novamente.' : 'Não foi possível concluir. Tente novamente.';

// 295: the "Fator de conversão" of an item of an entry note (Conversão de unidades).
const factorFailure = (error: unknown) => error instanceof AccessError ? error.status === 409 ? 'O fator de conversão mudou em outra operação. A conversão foi consultada de novo; confira antes de gravar.'
  : error.status === 400 ? 'O fator não pode ser gravado: informe um valor maior que zero com até 6 casas decimais, para um item com produto do cadastro em outra unidade, numa nota de entrada com fornecedor do cadastro.'
    : error.status === 403 ? 'Seu perfil não grava o fator de conversão (administrador e estoque).' : error.status === 404 ? 'O item não está mais na nota.' : 'Não foi possível gravar o fator. Tente novamente.' : 'Não foi possível gravar o fator. Tente novamente.';

/** Letter E of the notes of a page (only the Brufap notes); a late answer of another page is ignored. */
export function useInvoiceStockFlags(controller: Pick<AccessController, 'stock'>, ids: readonly string[], reload: number) {
  const key = ids.length ? `${ids.join(',')}:${reload}` : '';
  const [state, setState] = useState<{ key: string; flags: Map<string, InvoiceStockFlag> | null; error: boolean }>({ key: '', flags: null, error: false });
  useEffect(() => {
    if (!key || typeof controller.stock !== 'function') return;
    const request = new AbortController(), asked = [...ids];
    void Promise.resolve().then(() => controller.stock(invoiceFlagsPath(asked), { signal: request.signal })).then(raw => { if (!request.signal.aborted) setState({ key, flags: parseInvoiceFlags(raw, asked), error: false }); })
      .catch(problem => { if (!request.signal.aborted && !aborted(problem)) setState({ key, flags: null, error: true }); });
    return () => request.abort();
  }, [controller, key]);
  return state.key === key ? state : { key, flags: null, error: false };
}

/** "Lançar estoque" (choose the Depósito, review, confirm) or "Estornar estoque" (review, confirm) of one note. */
export default function InvoiceStockDialog({ controller, invoiceId, mode, onClose, onDone }: {
  controller: Pick<AccessController, 'stock'>; invoiceId: string; mode: 'post' | 'reverse'; onClose: () => void; onDone: (message: string, result: InvoiceStockResult) => void;
}) {
  const warehouses = useStockWarehouseOptions(controller, mode === 'post');
  const [state, setState] = useState<InvoiceStockState | null>(null), [readError, setReadError] = useState('');
  const [warehouse, setWarehouse] = useState(''), [preview, setPreview] = useState<InvoiceStockPreview | null>(null), [checking, setChecking] = useState(false);
  const command = useStockCommand(controller, 'Não foi possível confirmar o resultado. Use “Conferir resultado” para repetir a mesma operação sem lançar o estoque de novo.');
  // 295: Conversão de unidades of an entry note: the items in another unit, the rule of each one and the "Fator de conversão" editor.
  const factor = useStockCommand(controller, 'Não foi possível confirmar o fator de conversão. Use “Conferir resultado” para repetir a mesma gravação.');
  const [units, setUnits] = useState<InvoiceUnits | null>(null), [unitsError, setUnitsError] = useState(''), [unitsReload, setUnitsReload] = useState(0), [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<number | null>(null), [draft, setDraft] = useState(''), [draftStart, setDraftStart] = useState('');
  // The depósito padrão filled in on load is not a change of the user; another depósito is; so is a factor being typed.
  const frozen = command.busy || command.uncertain || factor.busy || factor.uncertain;
  const guard = useUnsavedForm({ warehouse: mode === 'post' && warehouse !== (state?.default_warehouse?.id ?? '') ? warehouse : '', factor: editing !== null && draft !== draftStart ? draft : '' }, frozen);
  useEffect(() => {
    const request = new AbortController();
    void Promise.resolve().then(() => controller.stock(`${INVOICE_STOCK_BASE}/${invoiceId}`, { signal: request.signal })).then(raw => {
      if (request.signal.aborted) return;
      const value = parseInvoiceStockState(raw, invoiceId); setState(value);
      if (mode === 'post' && value.default_warehouse) setWarehouse(current => current || value.default_warehouse!.id);
    }).catch(problem => { if (!request.signal.aborted && !aborted(problem)) setReadError(problem instanceof AccessError && problem.status === 403 ? 'Seu perfil não consulta o estoque das notas.' : 'Não foi possível consultar o estoque da nota.'); });
    return () => request.abort();
  }, [controller, invoiceId]);
  useEffect(() => {
    if (mode !== 'post' || !state || state.invoice.direction !== '0' || state.block) return;
    const request = new AbortController();
    void Promise.resolve().then(() => controller.stock(invoiceUnitsPath(invoiceId), { signal: request.signal })).then(raw => { if (!request.signal.aborted) { setUnits(parseInvoiceUnits(raw, invoiceId)); setUnitsError(''); } })
      .catch(problem => { if (!request.signal.aborted && !aborted(problem)) setUnitsError('Não foi possível consultar a conversão de unidades da nota.'); });
    return () => request.abort();
  }, [state, unitsReload]);
  const editItem = units?.items.find(item => item.position === editing) ?? null;
  const startEdit = (position: number) => {
    const item = units?.items.find(row => row.position === position); if (!item || frozen) return;
    const start = item.factor ? item.factor.factor.replace(/\.?0+$/, '').replace('.', ',') : '';
    factor.setError(''); setNotice(''); setEditing(position); setDraft(start); setDraftStart(start);
  };
  const stopEdit = () => { if (factor.busy || factor.uncertain) return; guard.confirmLeave(() => { setEditing(null); setDraft(''); setDraftStart(''); factor.setError(''); }); };
  const saveFactor = (remove: boolean) => {
    if (command.busy || command.uncertain || (!editItem && !factor.uncertain)) return;
    let body: Record<string, unknown> | null = null;
    if (!factor.uncertain) {
      try { body = { position: editItem!.position, expected_version: editItem!.factor?.version ?? 0, factor: remove ? null : factorInput(draft) }; }
      catch (problem) { factor.setError(problem instanceof Error ? problem.message : 'Fator inválido.'); return; }
    }
    void factor.run(invoiceUnitsPath(invoiceId), 'POST', body, (value, sent) => parseInvoiceUnitSave(value, invoiceId, sent), result => {
      setUnits(result.units); setEditing(null); setDraft(''); setDraftStart('');
      // The prévia depends on the factor (its hash changes): review again.
      setPreview(null);
      setNotice(result.replayed ? 'O fator já tinha sido gravado; nada foi repetido.' : result.after ? 'Fator de conversão gravado. Confira o lançamento de novo.' : 'Fator de conversão removido.');
    }, problem => { if (problem instanceof AccessError && problem.status === 409) setUnitsReload(value => value + 1); return factorFailure(problem); });
  };
  // A new warehouse invalidates the review (its positions and hash belong to the previous one).
  useEffect(() => { if (!command.pending()) setPreview(null); }, [warehouse]);
  const active = useMemo(() => warehouses.options.filter(item => item.active || item.id === warehouse), [warehouses.options, warehouse]);
  const review = async () => {
    if (!state || checking || frozen) return;
    command.setError(''); setChecking(true);
    try {
      const raw = mode === 'post'
        ? await controller.stock(`${INVOICE_STOCK_BASE}/${invoiceId}/previa`, { method: 'POST', body: { expected_version: state.invoice.version, warehouse_id: warehouse } })
        : await controller.stock(`${INVOICE_STOCK_BASE}/${invoiceId}/estorno/previa`, { method: 'POST', body: { posting_id: state.flag.posting_id, posting_version: state.flag.posting_version } });
      setPreview(parseInvoiceStockPreview(raw, invoiceId, mode === 'post' ? 'stock_invoice_preview' : 'stock_invoice_reverse_preview'));
    } catch (problem) { command.setError(problem instanceof AccessError ? failure(problem) : 'A prévia não pôde ser conferida. Tente novamente.'); }
    finally { setChecking(false); }
  };
  // Mode "post" reviews only after the Depósito is chosen; "reverse" reviews the posted lines right away.
  useEffect(() => { if (mode === 'reverse' && state?.flag.flag === 'S' && !preview && !command.pending()) void review(); }, [state]);
  const confirm = () => {
    if (!state || factor.busy || factor.uncertain || (!preview && !command.uncertain)) return;
    const body = command.uncertain ? null : mode === 'post' ? { expected_version: state.invoice.version, warehouse_id: warehouse, preview_hash: preview!.preview_hash }
      : { posting_id: state.flag.posting_id, posting_version: state.flag.posting_version, preview_hash: preview!.preview_hash };
    void command.run(`${INVOICE_STOCK_BASE}/${invoiceId}/${mode === 'post' ? 'lancamento' : 'estorno'}`, 'POST', body,
      value => parseInvoiceStockResult(value, invoiceId, mode === 'post' ? 'stock_invoice_post' : 'stock_invoice_reverse'),
      result => onDone(result.replayed ? 'O resultado já tinha sido registrado; nada foi lançado de novo.' : mode === 'post' ? `Estoque lançado no depósito ${result.flag.warehouse?.name ?? ''}.`
        : result.balanceKept ? 'Estoque estornado. O saldo atual foi mantido onde há balanço depois do lançamento (Preferências › Suprimentos › Estoque).' : 'Estoque estornado.', result), failure);
  };
  const close = () => { if (!frozen) guard.confirmLeave(onClose); };
  const title = mode === 'post' ? 'Lançar estoque' : 'Estornar estoque';
  const blocked = state && mode === 'post' && state.block ? BLOCK_TEXT[state.block] : state && mode === 'reverse' && state.flag.flag !== 'S' ? 'O estoque desta nota não está lançado pela nota.' : null;
  return <StockSidePanel title={title} wide labelledBy="invoice-stock-title" onClose={close} closeDisabled={frozen}
    footer={<><button type="button" className="secondary-button" disabled={frozen} onClick={close}>{blocked || !state ? 'Fechar' : 'Cancelar'}</button>
      {state && !blocked && state.can_manage && (preview || command.uncertain ? <button type="button" className="primary-button" disabled={command.busy || factor.busy || factor.uncertain} onClick={confirm}>{command.busy ? 'Registrando…' : command.uncertain ? 'Conferir resultado' : title}</button>
        : mode === 'post' && <button type="button" className="primary-button" disabled={checking || !warehouse || frozen} onClick={() => void review()}>{checking ? 'Conferindo…' : 'Conferir lançamento'}</button>)}</>}>
    {readError && <p className="real-alert" role="alert">{readError}</p>}
    {!state && !readError && <p role="status">Consultando o estoque da nota…</p>}
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
    {state && <>
      <p className="stock-panel-context"><span>Nota</span><strong>{state.invoice.label}</strong><small>{state.invoice.direction === '0' ? 'Entrada no estoque' : 'Saída do estoque'}</small></p>
      {blocked ? <p className="real-notice">{blocked}</p> : !state.can_manage ? <p className="real-notice">Seu perfil consulta o estoque da nota; o lançamento é de administrador e estoque.</p> : <>
        {mode === 'post' && <div className="form-field"><label htmlFor="invoice-stock-warehouse">Depósito</label><select id="invoice-stock-warehouse" value={warehouse} disabled={frozen || checking}
          onChange={event => setWarehouse(event.target.value)}><option value="">Selecione o depósito</option>{active.map(item => <option key={item.id} value={item.id}>{item.name}{item.is_default ? ' (padrão)' : ''}</option>)}</select>
          <small>Data do lançamento: {brDay(state.occurred_on)} ({state.date_mode === 'data_documento' ? 'data de saída/entrada da nota' : 'data atual'}, Preferências › Suprimentos › Estoque).</small></div>}
        {warehouses.error && mode === 'post' && <p className="real-alert" role="alert">{warehouses.error}</p>}
        {mode === 'post' && unitsError && <p className="real-alert" role="alert">{unitsError}</p>}
        {mode === 'post' && units && units.items.length > 0 && <section className="stock-unit-conversions" aria-label="Conversão de unidades">
          <h3>Conversão de unidades</h3>
          <p className="real-help">Itens da nota em outra unidade que a do produto. Entram no estoque pelo fator de conversão do fornecedor{units.supplier ? ` (${units.supplier.name})` : ''} ou pela unidade tributária da nota; sem regra, o item impede o lançamento.</p>
          {!units.supplier && <p className="real-notice">A nota não tem um fornecedor do cadastro: o fator de conversão não pode ser gravado e vale só a unidade tributária da nota.</p>}
          <table className="stock-balances"><thead><tr><th>Item</th><th className="numeric">Na nota</th><th className="numeric">No estoque</th><th>Regra</th>{units.can_manage && units.supplier && <th><span className="sr-only">Fator</span></th>}</tr></thead>
            <tbody>{units.items.map(item => <tr key={item.position}><td>{item.position} · {item.description || item.product.name}<small className="stock-reference">{item.product.name}</small></td>
              <td className="numeric">{quantityText(item.quantity)} <small className="stock-unit">{item.unit ?? '—'}</small></td>
              <td className="numeric">{item.converted_quantity ? <>{quantityText(item.converted_quantity)} <small className="stock-unit">{item.product.unit}</small></> : '—'}</td>
              <td>{unitRuleText(item, Boolean(units.supplier))}</td>
              {/* An item without a unit has no factor to save (the database refuses it): no button. */}
              {units.can_manage && units.supplier && <td>{editing !== item.position && item.unit?.trim() && <button type="button" className="text-button" disabled={frozen || editing !== null} onClick={() => startEdit(item.position)}>{item.factor ? 'Alterar fator' : 'Informar fator'}</button>}</td>}</tr>)}</tbody></table>
          {units.total > units.items.length && <p className="real-help">Mostrando os primeiros {units.items.length} de {units.total} itens em outra unidade.</p>}
          {(editItem || factor.uncertain) && <div className="form-field">
            {editItem && <><label htmlFor="invoice-stock-factor">Fator de conversão: 1 {editItem.unit ?? ''} =</label>
              <input id="invoice-stock-factor" inputMode="decimal" maxLength={14} value={draft} disabled={frozen} onChange={event => setDraft(event.target.value)} /> <span>{editItem.product.unit}</span>
              <small>Vale para {editItem.product.name} nas notas de entrada de {units.supplier?.name ?? 'fornecedor'} nesta unidade; o cadastro do produto e a nota não mudam.</small></>}
            <div className="real-editor-actions"><button type="button" className="primary-button" disabled={factor.busy || command.busy || command.uncertain} onClick={() => saveFactor(false)}>{factor.busy ? 'Gravando…' : factor.uncertain ? 'Conferir resultado' : 'Salvar fator'}</button>
              {editItem?.factor && !factor.uncertain && <button type="button" className="secondary-button" disabled={frozen} onClick={() => saveFactor(true)}>Remover fator</button>}
              {!factor.uncertain && <button type="button" className="secondary-button" disabled={factor.busy} onClick={stopEdit}>Cancelar</button>}</div></div>}
          {factor.error && <p className="real-alert" role="alert">{factor.error}</p>}
          {notice && <p className="real-help" role="status">{notice}</p>}
        </section>}
        {preview && <><table className="stock-balances"><thead><tr><th>Produto</th><th className="numeric">Quantidade</th><th className="numeric">Saldo atual</th><th className="numeric">Saldo depois</th></tr></thead>
          <tbody>{preview.positions.map(p => <tr key={`${p.product_id}`}><td>{p.product_name}{p.sources.some(s => s.kit_product_id) && <small className="stock-reference">Componente da composição do item {p.sources.filter(s => s.kit_product_id).map(s => s.position).join(', ')}</small>}
            {p.sources.map(s => conversionText(s, p.unit)).filter(Boolean).map(text => <small className="stock-reference" key={text}>{text}</small>)}</td>
            <td className="numeric">{quantityText(p.quantity)} <small className="stock-unit">{p.unit}</small></td><td className="numeric">{quantityText(p.balance_before)}</td>
            <td className="numeric">{p.balance_kept ? <small>Saldo mantido: há balanço depois do lançamento</small> : <span className={p.balance_after.startsWith('-') ? 'is-negative' : undefined}>{quantityText(p.balance_after)}</span>}</td></tr>)}</tbody></table>
          {preview.ignored.length > 0 && <p className="real-help">Ficam de fora: {preview.ignored.map(i => `item ${i.position} (${i.description || 'sem descrição'}: ${IGNORED_REASONS[i.reason]})`).join('; ')}.</p>}
          <p className="real-help">Depósito {preview.warehouse.name}, data {brDay(preview.occurred_on)}. {mode === 'post' ? 'Um único lançamento no extrato, com a origem Notas Fiscais; o estorno é feito pela nota.' : 'O movimento oposto, com a data de hoje; o histórico é preservado.'}</p></>}
      </>}
    </>}
  </StockSidePanel>;
}

/** Check-in de Recebimentos > Finalizar, with "Lançar estoque ao finalizar Check-in": the Qtde Recebida of each item (refused items out)
 * enters the chosen Depósito in the same command that finishes the check-in. Without the option, the plain Finalizar of 147 runs. */
export function CheckinFinishModal({ controller, invoiceId, version, summary, plainBusy, plainUncertain, onFinish, onClose, onPosted }: {
  controller: Pick<AccessController, 'stock'>; invoiceId: string; version: number; summary: { complete: number; issue: number; refused: number; pending: number };
  plainBusy: boolean; plainUncertain: boolean; onFinish: () => void; onClose: () => void; onPosted: (message: string) => void;
}) {
  const [withStock, setWithStock] = useState(false), [warehouse, setWarehouse] = useState(''), [preview, setPreview] = useState<InvoiceStockPreview | null>(null), [checking, setChecking] = useState(false);
  const [state, setState] = useState<InvoiceStockState | null>(null), [readError, setReadError] = useState(''), touched = useRef(false);
  const warehouses = useStockWarehouseOptions(controller, withStock);
  const command = useStockCommand(controller, 'Não foi possível confirmar o resultado. Use “Conferir resultado” para repetir a mesma operação sem lançar o estoque de novo.');
  const frozen = command.busy || command.uncertain || plainBusy || plainUncertain;
  // The stock state of the note is read on open: "Lançar estoque ao finalizar Check-in na NF de Entrada" (Preferências › Notas Fiscais ›
  // Configurações de NF-e) checks the option, as in Origin, unless the note cannot post or the user already chose.
  useEffect(() => {
    const request = new AbortController();
    void Promise.resolve().then(() => controller.stock(`${INVOICE_STOCK_BASE}/${invoiceId}`, { signal: request.signal })).then(raw => {
      if (request.signal.aborted) return; const value = parseInvoiceStockState(raw, invoiceId); setState(value);
      if (value.default_warehouse) setWarehouse(current => current || value.default_warehouse!.id);
      if (value.checkin_post && value.block === null && !touched.current) setWithStock(true);
    }).catch(problem => { if (!request.signal.aborted && !aborted(problem)) setReadError('Não foi possível consultar o estoque da nota.'); });
    return () => request.abort();
  }, [controller, invoiceId]);
  useEffect(() => { if (!command.pending()) setPreview(null); }, [warehouse, withStock]);
  const blocked = state?.block && state.block !== 'no_products' ? BLOCK_TEXT[state.block] : null;
  const review = async () => {
    if (checking || frozen || !warehouse) return;
    command.setError(''); setChecking(true);
    try { setPreview(parseInvoiceStockPreview(await controller.stock(`${INVOICE_STOCK_BASE}/${invoiceId}/checkin/previa`, { method: 'POST', body: { expected_version: version, warehouse_id: warehouse } }), invoiceId, 'stock_checkin_post_preview')); }
    catch (problem) { command.setError(problem instanceof AccessError ? problem.status === 400 ? 'Nenhum item com Qtde Recebida para lançar, ou a unidade de um item difere da unidade do produto sem fator de conversão do fornecedor nem unidade tributária (informe o fator no Lançar estoque da nota).' : failure(problem) : 'A prévia não pôde ser conferida. Tente novamente.'); }
    finally { setChecking(false); }
  };
  const post = () => {
    if (!preview && !command.uncertain) return;
    void command.run(`${INVOICE_STOCK_BASE}/${invoiceId}/checkin`, 'POST', command.uncertain ? null : { expected_version: version, warehouse_id: warehouse, preview_hash: preview!.preview_hash },
      value => parseInvoiceStockResult(value, invoiceId, 'stock_checkin_post'),
      result => onPosted(result.replayed ? 'O check-in já tinha sido finalizado com o lançamento; nada foi repetido.' : `O check-in foi finalizado e registrado no sistema. Estoque lançado no depósito ${result.flag.warehouse?.name ?? ''}.`), failure);
  };
  const choose = (value: string) => { if (!frozen) setWarehouse(value); };
  return <Modal title="Finalizar check-in" onClose={() => { if (!frozen) onClose(); }} actions={<><button type="button" className="secondary-button" disabled={frozen} onClick={onClose}>Não</button>
    {!withStock ? <button type="button" className="primary-button" disabled={plainBusy || command.busy} onClick={onFinish}>{plainUncertain ? 'Conferir resultado' : 'Sim'}</button>
      : preview || command.uncertain ? <button type="button" className="primary-button" disabled={command.busy || Boolean(blocked)} onClick={post}>{command.busy ? 'Finalizando…' : command.uncertain ? 'Conferir resultado' : 'Finalizar e lançar estoque'}</button>
        : <button type="button" className="primary-button" disabled={checking || !warehouse || Boolean(blocked) || !state} onClick={() => void review()}>{checking ? 'Conferindo…' : 'Conferir lançamento'}</button>}</>}>
    <p>Itens conferidos: {summary.complete} · com pendência: {summary.issue} · recusados: {summary.refused} · ainda não conferidos: {summary.pending}.</p>
    <p>Depois de finalizado, o check-in não pode ser alterado.</p>
    <label><input type="checkbox" checked={withStock} disabled={frozen} onChange={event => { touched.current = true; setWithStock(event.target.checked); }} />Lançar estoque ao finalizar Check-in</label>
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
    {withStock && <>{readError && <p className="real-alert" role="alert">{readError}</p>}{blocked && <p className="real-notice">{blocked}</p>}
      {!blocked && <div className="form-field"><label htmlFor="checkin-stock-warehouse">Depósito</label><select id="checkin-stock-warehouse" value={warehouse} disabled={frozen || checking} onChange={event => choose(event.target.value)}>
        <option value="">Selecione o depósito</option>{warehouses.options.filter(item => item.active || item.id === warehouse).map(item => <option key={item.id} value={item.id}>{item.name}{item.is_default ? ' (padrão)' : ''}</option>)}</select>
        <small>Entra no estoque a Qtde Recebida de cada item com produto; itens recusados e sem quantidade ficam de fora.</small></div>}
      {preview && <table className="stock-balances"><thead><tr><th>Produto</th><th className="numeric">Entrada</th><th className="numeric">Saldo depois</th></tr></thead>
        <tbody>{preview.positions.map(p => <tr key={p.product_id}><td>{p.product_name}{p.sources.map(s => conversionText(s, p.unit)).filter(Boolean).map(text => <small className="stock-reference" key={text}>{text}</small>)}</td>
          <td className="numeric">{quantityText(p.quantity)} <small className="stock-unit">{p.unit}</small></td><td className="numeric">{quantityText(p.balance_after)}</td></tr>)}</tbody></table>}
      {preview && preview.ignored.length > 0 && <p className="real-help">Ficam de fora: {preview.ignored.map(i => `item ${i.position} (${IGNORED_REASONS[i.reason]})`).join('; ')}.</p>}</>}
  </Modal>;
}
