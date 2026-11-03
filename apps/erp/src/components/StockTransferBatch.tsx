import { useEffect, useMemo, useRef, useState } from 'react';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { AccessError, type AccessController } from '../lib/real-access';
import type { CatalogRecord } from '../lib/catalog-model';
import { quantityText } from '../lib/stock-model';
import { TRANSFER_COST_INFO, priceText } from '../lib/stock-launch-model';
import { TRANSFER_INELIGIBLE, parseTransferPositions, priceField, parseTransferReceipt, selectableWarehouses, transferAvailable, transferPositionsPath, transferPrice, transferQuantity,
  type TransferPositions, type TransferReceipt } from '../lib/stock-supply-model';
import { HIDDEN_PRICE_HELP, StockSidePanel, useStockCommand } from './StockMovementPanel';
import { useStockWarehouseOptions } from './StockSupplierPicker';
import StockProductSearch from './StockProductSearch';
import StockPrintPreview from './StockPrintPreview';
import { Icon } from './Icon';
import './stock.css';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const MAX_PRODUCTS = 50;
const STOCK_WRITERS = ['admin', 'estoque'];
type Product = { id: string; name: string; code: string | null };
type Line = { quantity: string; price: string; cost: string; lot: string };
const failure = (error: unknown) => error instanceof AccessError ? error.status === 409 ? 'Os saldos mudaram em outra operação. A grade foi atualizada: confira as quantidades e salve de novo.'
  : error.status === 400 ? 'Confira os depósitos, as quantidades, os lotes e os preços. O saldo da origem não pode ficar abaixo do reservado nem negativo sem a política "Permitir estoque negativo" e o lote não pode ficar sem saldo; produtos inativos, com composição ou sem unidade não são transferidos.'
  : error.status === 403 ? 'Seu perfil não permite lançar estoque.' : error.status === 404 ? 'Um produto ou depósito não está mais disponível. Atualize a grade.' : 'Não foi possível concluir. Tente novamente.' : 'Não foi possível concluir. Tente novamente.';
const localMoment = (value: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));

/** Cadastros > Produtos > Mais ações > Edição: "Transferir estoque dos produtos selecionados" (stock writers only). */
export function StockTransferBatchAction({ controller, items }: { controller: AccessController; items: readonly Pick<CatalogRecord, 'id' | 'name' | 'code'>[] }) {
  const role = controller.getSnapshot().membership?.role, [open, setOpen] = useState<Product[] | null>(null);
  if (!STOCK_WRITERS.includes(role ?? '')) return null;
  const tooMany = items.length > MAX_PRODUCTS;
  return <>
    <button type="button" className="action-button" disabled={!items.length || tooMany} title={!items.length ? 'Selecione os produtos na listagem' : tooMany ? `Selecione até ${MAX_PRODUCTS} produtos` : undefined}
      onClick={() => setOpen(items.map(item => ({ id: item.id, name: item.name, code: typeof item.code === 'string' ? item.code : null })))}><Icon name="right-left" size={14} />Transferir estoque dos produtos selecionados</button>
    {open && <StockTransferBatch controller={controller} products={open} onClose={() => setOpen(null)} />}
  </>;
}

/** The Origin modal of the batch transfer: Depósito de origem, Depósito de destino, Observações, Adicionar produto and the grid
 * Descrição | Código | Estoque | Estoque Reservado | Quantidade* | Preço Un.* | Custo Un. One command transfers every product. */
export default function StockTransferBatch({ controller, products: initial, onClose }: { controller: AccessController; products: Product[]; onClose: () => void }) {
  const warehouses = useStockWarehouseOptions(controller);
  const [products, setProducts] = useState<Product[]>(initial), [source, setSource] = useState(''), [destination, setDestination] = useState(''), [note, setNote] = useState('Transferência');
  const [lines, setLines] = useState<Record<string, Line>>({}), [positions, setPositions] = useState<TransferPositions | null>(null), [loadError, setLoadError] = useState(''), [reload, setReload] = useState(0);
  const [adding, setAdding] = useState(false), [done, setDone] = useState<{ receipt: TransferReceipt; replayed: boolean } | null>(null), [printing, setPrinting] = useState(false);
  const command = useStockCommand(controller, 'Não foi possível confirmar se a transferência foi registrada. Use “Conferir resultado” para repetir a mesma operação sem transferir de novo.');
  const frozen = command.busy || command.uncertain;
  // Only what the user changes counts as unsaved: the default warehouses and the suggested prices filled after opening do not.
  const [touched, setTouched] = useState(false);
  const guard = useUnsavedChanges(touched && !done, frozen);
  const active = warehouses.options.filter(item => item.active);
  // Defaults like the single transfer: origem = depósito padrão, destino = the first other active warehouse.
  useEffect(() => {
    if (!warehouses.loaded || source) return;
    const start = active.find(item => item.is_default)?.id ?? active[0]?.id ?? '';
    setSource(start); setDestination(active.find(item => item.id !== start)?.id ?? '');
  }, [warehouses.loaded]);
  const ids = useMemo(() => products.map(item => item.id), [products]), sequence = useRef(0);
  useEffect(() => {
    if (!source || !ids.length || done) return;
    const request = new AbortController(), current = ++sequence.current; setLoadError('');
    void Promise.resolve().then(() => controller.stock(transferPositionsPath(source, destination, ids), { signal: request.signal })).then(raw => {
      if (request.signal.aborted || current !== sequence.current) return;
      const value = parseTransferPositions(raw, source, destination, ids); setPositions(value);
      // New products get the suggested price and cost; typed lines are kept.
      // A lot of another source warehouse is cleared (the lots are the source's).
      setLines(previous => Object.fromEntries(value.items.map(item => { const kept = previous[item.product_id];
        return [item.product_id, kept ? { ...kept, lot: item.lots.some(lot => lot.id === kept.lot) ? kept.lot : '' } : { quantity: '', price: priceField(item.suggested_price), cost: priceField(item.suggested_cost), lot: '' }]; })));
    }).catch(problem => { if (!request.signal.aborted && !aborted(problem) && current === sequence.current) { setPositions(null); setLoadError('Não foi possível consultar os saldos dos produtos. Tente novamente.'); } });
    return () => request.abort();
  }, [controller, source, destination, ids, reload]);
  const ready = positions !== null && positions.source.id === source && (positions.destination?.id ?? '') === destination;
  const showPrice = positions?.show_unit_price ?? false;
  const eligible = ready ? positions!.items.filter(item => item.eligibility === 'eligible') : [];
  const changeSource = (id: string) => { setTouched(true); setSource(id); if (!destination || destination === id) setDestination(active.find(item => item.id !== id)?.id ?? ''); };
  const setLine = (id: string, patch: Partial<Line>) => { setTouched(true); setLines(previous => ({ ...previous, [id]: { ...(previous[id] ?? { quantity: '', price: '', cost: '', lot: '' }), ...patch } })); };
  const anyLot = ready && positions!.items.some(item => item.lot_control);
  const add = (record: CatalogRecord | null) => { if (!record) return; setAdding(false); setTouched(true); if (products.some(item => item.id === record.id) || products.length >= MAX_PRODUCTS) return;
    setProducts(previous => [...previous, { id: record.id, name: record.name, code: typeof record.code === 'string' ? record.code : null }]); };
  const remove = (id: string) => { setTouched(true); setProducts(previous => previous.filter(item => item.id !== id)); setLines(previous => { const next = { ...previous }; delete next[id]; return next; }); };
  const save = () => {
    if (command.busy || done) return;
    let body: Record<string, unknown> | null = null;
    if (!command.uncertain) {
      try {
        if (!source || !destination || source === destination) throw new Error('Selecione depósitos de origem e de destino diferentes.');
        if (!ready) throw new Error('Aguarde a consulta dos saldos.');
        const items = eligible.filter(item => (lines[item.product_id]?.quantity ?? '').trim()).map(item => { const line = lines[item.product_id]!;
          const quantity = transferQuantity(line.quantity), lot = item.lot_control && line.lot ? item.lots.find(row => row.id === line.lot) : undefined;
          if (lot) { const [w, f = ''] = quantity.split('.'), [lw, lf = ''] = lot.quantity.split('.'); if (BigInt(w + f.padEnd(6, '0')) > BigInt(lw + lf.padEnd(6, '0'))) throw new Error(`O lote ${lot.code} de ${item.name} não tem saldo suficiente na origem.`); }
          return { product_id: item.product_id, quantity, source_version: item.source.version, destination_version: item.destination!.version,
            ...(showPrice ? { unit_price: transferPrice(line.price, true, 'Preço Un.'), unit_cost: transferPrice(line.cost, false, 'Custo Un.') } : {}), ...(lot ? { lot_id: lot.id } : {}) }; });
        if (!items.length) throw new Error('Informe a quantidade de ao menos um produto.');
        body = { source_id: source, destination_id: destination, note: note.trim() || null, items };
      } catch (problem) { command.setError((problem as Error).message); return; }
    }
    void command.run('/v1/estoque/transferencias', 'POST', body, (value, sent) => parseTransferReceipt(value, sent as { command_id: string; items: { product_id: string }[] }), result => setDone(result),
      problem => { if (problem instanceof AccessError && problem.status === 409) setReload(value => value + 1); return failure(problem); });
  };
  const close = () => { if (!frozen) done ? onClose() : guard.confirmLeave(onClose); };
  if (done) {
    const r = done.receipt;
    return <StockSidePanel title="Transferir estoque" labelledBy="stock-batch-title" wide onClose={onClose}
      footer={<><button type="button" className="secondary-button" onClick={onClose}>Fechar</button><button type="button" className="primary-button" onClick={() => setPrinting(true)}><Icon name="print" size={13} />IMPRIMIR COMPROVANTE TRANSFERÊNCIA</button></>}>
      <p className="real-success" role="status">Transferência registrada para {r.items.length} produto(s).{done.replayed ? ' O resultado já tinha sido registrado; nada foi transferido de novo.' : ''}</p>
      <dl className="stock-edit-facts"><div><dt>Depósito de origem</dt><dd>{r.source.name}</dd></div><div><dt>Depósito de destino</dt><dd>{r.destination.name}</dd></div><div><dt>Observações</dt><dd>{r.note}</dd></div></dl>
      <table className="data-table real-table"><thead><tr><th>Descrição</th><th>Código</th><th>Lote</th><th className="numeric">Quantidade</th><th className="numeric">Saldo na origem</th><th className="numeric">Saldo no destino</th></tr></thead>
        <tbody>{r.items.map(item => <tr key={item.product_id}><td>{item.name}</td><td>{item.code ?? ''}</td><td>{item.lot_code ?? ''}</td><td className="numeric">{quantityText(item.quantity)} {item.unit}</td><td className="numeric">{quantityText(item.source_balance_after)}</td><td className="numeric">{quantityText(item.destination_balance_after)}</td></tr>)}</tbody></table>
      {printing && <StockPrintPreview title="Comprovante de transferência" onClose={() => setPrinting(false)}>
        <h1>Comprovante de transferência entre depósitos</h1>
        <dl><div><dt>Depósito de origem</dt><dd>{r.source.name}</dd></div><div><dt>Depósito de destino</dt><dd>{r.destination.name}</dd></div>
          <div><dt>Data</dt><dd>{r.occurred_on.split('-').reverse().join('/')}</dd></div><div><dt>Observações</dt><dd>{r.note}</dd></div></dl>
        <table><thead><tr><th>Produto</th><th className="numeric">Quantidade</th><th className="numeric">Preço un.</th><th className="numeric">Custo Un.</th></tr></thead>
          <tbody>{r.items.map(item => <tr key={item.product_id}><td>{[item.code, item.name].filter(Boolean).join(' - ')}{item.lot_code ? ` · Lote ${item.lot_code}` : ''}</td><td className="numeric">{quantityText(item.quantity)} {item.unit}</td><td className="numeric">{priceText(item.unit_price)}</td><td className="numeric">{priceText(item.unit_cost)}</td></tr>)}</tbody></table>
        <div className="stock-print-signatures"><span>Responsável pela saída</span><span>Responsável pela entrada</span></div>
        <p className="stock-print-foot">Comando {r.command_id} · registrado em {localMoment(r.saved_at)} (horário de São Paulo).</p>
      </StockPrintPreview>}
    </StockSidePanel>;
  }
  return <StockSidePanel title="Transferir estoque" labelledBy="stock-batch-title" wide onClose={close} closeDisabled={frozen}
    footer={<><button type="button" className="secondary-button" disabled={frozen} onClick={close}>Cancelar</button><button type="button" className="primary-button" disabled={command.busy || !ready || !eligible.length} onClick={save}>{command.busy ? 'Salvando…' : command.uncertain ? 'Conferir resultado' : 'Salvar'}</button></>}>
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
    {loadError && <p className="real-alert" role="alert">{loadError}<button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>Tentar novamente</button></p>}
    {warehouses.error && <p className="real-alert" role="alert">{warehouses.error}</p>}
    <p className="real-help">(*) Campos obrigatórios</p>
    <fieldset className="stock-panel-form" disabled={frozen}><legend className="real-sr-only">Depósitos e observações</legend>
      <div className="form-field"><label htmlFor="stock-batch-source">Depósito de origem *</label><select id="stock-batch-source" value={source} onChange={event => changeSource(event.target.value)}><option value="">Selecione</option>{selectableWarehouses(warehouses.options, source).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
      <div className="form-field"><label htmlFor="stock-batch-destination">Depósito de destino *</label><select id="stock-batch-destination" value={destination} onChange={event => { setTouched(true); setDestination(event.target.value); }}><option value="">Selecione</option>{selectableWarehouses(warehouses.options, destination).filter(item => item.id !== source).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
      <div className="form-field real-field-wide"><label htmlFor="stock-batch-note">Observações</label><input id="stock-batch-note" maxLength={500} value={note} onChange={event => { setTouched(true); setNote(event.target.value); }} /></div>
    </fieldset>
    {warehouses.loaded && active.length < 2 && <p className="real-notice">É necessário ter ao menos dois depósitos ativos para transferir estoque.</p>}
    {!showPrice && ready && <p className="real-help">{HIDDEN_PRICE_HELP}</p>}
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Produtos da transferência"><table className="data-table real-table stock-transfer-grid"><thead><tr><th>Descrição</th><th>Código</th><th className="numeric">Estoque</th><th className="numeric">Estoque Reservado</th>{anyLot && <th>Lote</th>}<th>Quantidade *</th>
      {showPrice && <><th>Preço Un. *</th><th>Custo Un. <span className="stock-info" title={TRANSFER_COST_INFO} aria-label={TRANSFER_COST_INFO}><Icon name="circle-info" size={10} /></span></th></>}<th><span className="real-sr-only">Remover</span></th></tr></thead>
      <tbody>{products.map(product => { const item = ready ? positions!.items.find(row => row.product_id === product.id) : undefined, line = lines[product.id];
        const ok = item?.eligibility === 'eligible', over = ok && line?.quantity.trim() && (() => { try { const q = transferQuantity(line.quantity); const [w, f = ''] = q.split('.'); return BigInt(w + f.padEnd(6, '0')) > transferAvailable(item!); } catch { return false; } })();
        return <tr key={product.id}><td>{product.name}{item && !ok && <small className="stock-reference">{TRANSFER_INELIGIBLE[item.eligibility as keyof typeof TRANSFER_INELIGIBLE]}</small>}{over && <small className="stock-reference is-negative">Acima do disponível (estoque − reservado).</small>}</td><td>{product.code ?? ''}</td>
          <td className="numeric">{item ? quantityText(item.source.quantity) : '…'}</td><td className="numeric">{item ? quantityText(item.source.reserved) : '…'}</td>
          {anyLot && <td>{item?.lot_control ? <select id={`stock-batch-lot-${product.id}`} aria-label={`Lote de ${product.name}`} disabled={frozen || !ok} value={line?.lot ?? ''} onChange={event => setLine(product.id, { lot: event.target.value })}><option value="">Sem lote</option>{item.lots.map(lot => <option key={lot.id} value={lot.id}>{lot.code} · saldo {quantityText(lot.quantity)}</option>)}</select> : null}</td>}
          <td className={ok ? undefined : 'is-ineligible'}><input id={`stock-batch-quantity-${product.id}`} aria-label={`Quantidade de ${product.name}`} inputMode="decimal" maxLength={20} disabled={frozen || !ok} value={line?.quantity ?? ''} onChange={event => setLine(product.id, { quantity: event.target.value })} /></td>
          {showPrice && <><td><input id={`stock-batch-price-${product.id}`} aria-label={`Preço Un. de ${product.name}`} inputMode="decimal" maxLength={26} disabled={frozen || !ok} value={line?.price ?? ''} onChange={event => setLine(product.id, { price: event.target.value })} /></td>
            <td><input id={`stock-batch-cost-${product.id}`} aria-label={`Custo Un. de ${product.name}`} inputMode="decimal" maxLength={26} disabled={frozen || !ok} value={line?.cost ?? ''} onChange={event => setLine(product.id, { cost: event.target.value })} /></td></>}
          <td><button type="button" className="icon-button" aria-label={`Remover ${product.name}`} title="Remover" disabled={frozen || products.length === 1} onClick={() => remove(product.id)}><Icon name="trash-can" size={12} /></button></td></tr>; })}</tbody></table></div>
    {adding ? <StockProductSearch controller={controller} selected={null} disabled={frozen} onSelect={add} />
      : <button type="button" className="text-button" disabled={frozen || products.length >= MAX_PRODUCTS} onClick={() => setAdding(true)}><Icon name="plus" size={11} />Adicionar produto</button>}
    <p className="real-help">Cada produto vira uma transferência no extrato, todas no mesmo comando: ou todas são registradas, ou nenhuma. Produtos sem quantidade ficam de fora. A coluna Lote aparece para os produtos com Controle de lote: o lote escolhido sai da origem e entra no destino; sem lote, a quantidade fica no saldo sem lote.</p>
  </StockSidePanel>;
}
