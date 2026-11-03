import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { useUnsavedForm } from '../hooks/useUnsavedChanges';
import { AccessError, type AccessController } from '../lib/real-access';
import { quantityText } from '../lib/stock-model';
import { EMPTY_LOT, LOT_STATUS_LABELS, NEW_LOT, expiryText, lotBody, lotDay, lotNote, lotOption, parseLotDetail, parseLotSave, parseLotStatus, parseLots,
  type LotDetail, type LotDraft, type LotRow, type LotsPage, type LotSettings, type LotStatus } from '../lib/stock-lots-model';
import { StockSidePanel, useStockCommand } from './StockMovementPanel';
import { Modal } from './Modal';
import { Icon } from './Icon';

// Estoque lane (258): Controle de lotes like Origin. The extrato tab "Lotes e validades", "Detalhes de lotes", the lot grid of the
// product form and the Lote field of the Novo Lançamento and of the transfers. The server keeps the rules (lot never negative,
// required dates of Preferências › Cadastros › Controle de lotes, code unique per product); the screens only explain them first.
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const ORIGIN_TEXT: Record<string, string> = { sales: 'Venda', purchases: 'Compra', services: 'Ordem de serviço', transfers: 'Transferência', invoices: 'Nota fiscal', none: 'Sem origem' };
const lotFailure = (error: unknown) => error instanceof AccessError ? error.status === 409 ? 'O lote foi alterado por outra operação. Atualize e confira antes de salvar.'
  : error.status === 400 ? 'Confira os dados do lote: o código não pode se repetir no produto, as datas obrigatórias de Preferências › Cadastros › Controle de lotes precisam estar preenchidas e um lote com saldo não pode ser excluído.'
    : error.status === 403 ? 'Seu perfil não permite gravar lotes.' : error.status === 404 ? 'O lote ou o produto não está mais disponível.' : 'Não foi possível concluir. Tente novamente.' : 'Não foi possível concluir. Tente novamente.';
const ExpiryBadge = ({ lot, today }: { lot: Pick<LotRow, 'expiry_state' | 'expires_on'>; today: string }) => {
  const text = expiryText(lot, today);
  return text ? <span className={`status-badge ${lot.expiry_state === 'expired' ? 'status-danger' : 'status-warning'} stock-lot-expiry`}>{text}</span> : null;
};

/** Lots of a product (one warehouse or the considered ones), read again on each key; a late answer of another key is ignored. */
export function useStockLots(controller: Pick<AccessController, 'stock'>, productId: string | null, warehouseId: string | null, status: LotStatus, reload: number, offset = 0) {
  const key = productId ? `${productId}:${warehouseId ?? ''}:${status}:${offset}:${reload}` : '';
  const [state, setState] = useState<{ key: string; page: LotsPage | null; error: boolean }>({ key: '', page: null, error: false });
  useEffect(() => {
    if (!productId) return;
    const request = new AbortController(), query = new URLSearchParams({ product_id: productId, situacao: status, ...(warehouseId ? { warehouse_id: warehouseId } : {}), ...(offset ? { offset: String(offset) } : {}) });
    void Promise.resolve().then(() => controller.stock(`/v1/estoque/lotes?${query}`, { signal: request.signal })).then(raw => { if (!request.signal.aborted) setState({ key, page: parseLots(raw, productId, warehouseId, status), error: false }); })
      .catch(problem => { if (!request.signal.aborted && !aborted(problem)) setState({ key, page: null, error: true }); });
    return () => request.abort();
  }, [controller, key]);
  return state.key === key ? { loading: false, page: state.page, error: state.error } : { loading: Boolean(productId), page: null, error: false };
}

/** Lote of the Novo Lançamento / Transferência (Origin: optional, "Sem lote" or a lot; "Novo lote" in Entrada and Balanço). */
export function LotPicker({ page, error, kind, unit, choice, draft, onChoice, onDraft, disabled, id = 'stock-lot' }: {
  page: LotsPage | null; error: boolean; kind: 'receipt' | 'issue' | 'balance' | 'transfer'; unit: string; choice: string; draft: LotDraft;
  onChoice: (value: string) => void; onDraft: (value: LotDraft) => void; disabled?: boolean; id?: string;
}) {
  if (error) return <p className="real-alert real-field-wide" role="alert">Não foi possível consultar os lotes do produto. Feche o painel e use “Atualizar saldos”.</p>;
  if (!page) return <p className="real-field-wide" role="status">Consultando os lotes…</p>;
  // A lot leaves only with stock in the warehouse; Entrada and Balanço also accept an active lot without stock.
  const options = page.items.filter(lot => lot.active && (kind === 'receipt' || kind === 'balance' || lot.quantity !== '0.000000'));
  const fresh = kind === 'receipt' || kind === 'balance', set = (patch: Partial<LotDraft>) => onDraft({ ...draft, ...patch });
  return <>
    <div className="form-field real-field-wide"><label htmlFor={id}>Lote</label><select id={id} value={choice} disabled={disabled} onChange={event => onChoice(event.target.value)}>
      <option value="">Sem lote</option>{options.map(lot => <option key={lot.id} value={lot.id}>{lotOption(lot, unit)}</option>)}{fresh && <option value={NEW_LOT}>Novo lote</option>}</select>
      <small>{kind === 'balance' && choice ? 'Com lote, a quantidade é o novo saldo do lote neste depósito; a diferença entra no saldo do depósito.' : choice ? 'O lote acompanha a quantidade lançada.' : 'Sem lote, a quantidade fica no saldo sem lote do depósito.'}</small></div>
    {choice === NEW_LOT && <>
      <div className="form-field"><label htmlFor={`${id}-code`}>Código do Lote *</label><input id={`${id}-code`} maxLength={60} value={draft.code} disabled={disabled} onChange={event => set({ code: event.target.value })} /></div>
      <div className="form-field"><label htmlFor={`${id}-made`}>Data de fabricação{page.settings.require_manufacture ? ' *' : ''}</label><input id={`${id}-made`} type="date" min="1900-01-01" max="2100-12-31" value={draft.manufactured_on} disabled={disabled} onChange={event => set({ manufactured_on: event.target.value })} /></div>
      <div className="form-field"><label htmlFor={`${id}-expires`}>Data de validade{page.settings.require_expiry ? ' *' : ''}</label><input id={`${id}-expires`} type="date" min="1900-01-01" max="2100-12-31" value={draft.expires_on} disabled={disabled} onChange={event => set({ expires_on: event.target.value })} /></div>
    </>}
  </>;
}

/** Estoque > Lançamentos de estoque > aba "Lotes e validades": Data | Data de fabricação | Data de validade | Lote | Quantidade. */
export function StockLotsTab({ controller, productId, unit, warehouseId, warehouseLabel, writable, reload, frozen, onChanged }: {
  controller: Pick<AccessController, 'stock'>; productId: string; unit: string; warehouseId: string; warehouseLabel: string; writable: boolean; reload: number; frozen: boolean; onChanged: (message: string) => void;
}) {
  const [status, setStatus] = useState<LotStatus>('todos'), [offset, setOffset] = useState(0), [open, setOpen] = useState<string | null>(null), [removing, setRemoving] = useState<LotRow | null>(null), [local, setLocal] = useState(0);
  const lots = useStockLots(controller, productId, warehouseId || null, status, reload + local, offset);
  useEffect(() => { setOffset(0); setOpen(null); setRemoving(null); }, [productId, warehouseId, status]);
  const page = lots.page, busy = frozen || open !== null || removing !== null;
  const changed = (message: string) => { setOpen(null); setRemoving(null); setLocal(value => value + 1); onChanged(message); };
  const rowKey = (event: KeyboardEvent<HTMLTableRowElement>, lot: LotRow) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!busy) setOpen(lot.id); } };
  return <section className="stock-lots" aria-label="Lotes e validades">
    <div className="stock-lots-toolbar"><label htmlFor="stock-lots-status">Situação<select id="stock-lots-status" value={status} disabled={busy} onChange={event => setStatus(event.target.value as LotStatus)}>{(Object.keys(LOT_STATUS_LABELS) as LotStatus[]).map(value => <option key={value} value={value}>{LOT_STATUS_LABELS[value]}</option>)}</select></label>
      <span className="real-help">Quantidades {warehouseId ? `em ${warehouseLabel}` : 'da soma dos depósitos considerados'}.</span></div>
    {lots.error ? <p className="real-alert" role="alert">Não foi possível consultar os lotes. Use “Atualizar saldos”.</p> : !page ? <p role="status">Consultando os lotes…</p> : <>
      {!page.product.lot_control && <p className="real-help">O Controle de lote está desativado no cadastro do produto: os lotes abaixo ficam só para consulta e novos lançamentos não pedem lote.</p>}
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Lotes do produto"><table className="data-table real-table stock-lots-table"><thead><tr><th>Data</th><th>Data de fabricação</th><th>Data de validade</th><th>Lote</th><th className="numeric">Quantidade</th><th><span className="real-sr-only">Situação</span></th></tr></thead>
        <tbody>{page.items.map(lot => <tr key={lot.id} className={`stock-row${lot.active ? '' : ' is-inactive'}`} tabIndex={0} aria-label={`Abrir o lote ${lot.code}`} onClick={() => { if (!busy) setOpen(lot.id); }} onKeyDown={event => rowKey(event, lot)}>
          <td>{lotDay(lot.created_on)}</td><td>{lotDay(lot.manufactured_on)}</td><td>{lotDay(lot.expires_on)}<ExpiryBadge lot={lot} today={page.today} /></td><td>{lot.code}{lot.note && <small className="stock-reference">{lot.note}</small>}</td>
          <td className="numeric">{quantityText(lot.quantity)} <small className="stock-unit">{unit}</small></td>
          <td>{lot.active ? writable && lot.quantity === '0.000000' && warehouseId === '' ? <button type="button" className="icon-button" aria-label={`Excluir lote ${lot.code}`} title="Excluir lote" disabled={busy} onClick={event => { event.stopPropagation(); setRemoving(lot); }}><Icon name="trash-can" size={12} /></button> : null : <span className="status-badge status-neutral">Inativo</span>}</td></tr>)}
          {status !== 'inativos' && <tr className="stock-balances-all"><td colSpan={4}>Sem lote</td><td className="numeric"><span className={page.unassigned.startsWith('-') ? 'is-negative' : undefined}>{quantityText(page.unassigned)}</span> <small className="stock-unit">{unit}</small></td><td /></tr>}</tbody></table></div>
      {!page.items.length && <p className="empty-state">{status === 'todos' ? 'Nenhum lote cadastrado.' : 'Nenhum lote nesta situação.'}</p>}
      {page.total > page.items.length && <p className="real-help">Mostrando {offset + 1} a {offset + page.items.length} de {page.total} lotes. <button type="button" className="text-button" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>Anteriores</button> <button type="button" className="text-button" disabled={busy || offset + page.items.length >= page.total} onClick={() => setOffset(offset + 100)}>Próximos</button></p>}
      <p className="real-help">Sem lote é o saldo do depósito que não está em nenhum lote (lançamentos sem lote, pedidos, ordens de serviço, notas e a conferência de estoque lançam sem lote). {page.settings.warning_days > 0 ? `Lotes com saldo que vencem em até ${page.settings.warning_days} dias ficam marcados (Preferências › Cadastros › Controle de lotes).` : 'Defina em Preferências › Cadastros › Controle de lotes quantos dias antes da validade os lotes ficam marcados.'} “Excluir lote” vale para o lote sem saldo em todos os depósitos: ele fica inativo e o histórico é mantido.</p>
    </>}
    {open && <LotDetailsPanel controller={controller} lotId={open} unit={unit} writable={writable} onClose={() => setOpen(null)} onSaved={message => changed(message)} />}
    {removing && <LotRemoveDialog controller={controller} lot={removing} onClose={() => setRemoving(null)} onDone={() => changed(`Lote ${removing.code} excluído: ele fica inativo e o histórico é mantido.`)} />}
  </section>;
}

function LotRemoveDialog({ controller, lot, onClose, onDone }: { controller: Pick<AccessController, 'stock'>; lot: LotRow; onClose: () => void; onDone: () => void }) {
  const command = useStockCommand(controller), frozen = command.busy || command.uncertain;
  const confirm = () => void command.run(`/v1/estoque/lotes/${lot.id}/situacao`, 'POST', command.uncertain ? null : { expected_version: lot.version, active: false }, value => parseLotStatus(value, lot.id, false), onDone, lotFailure);
  return <Modal title="Excluir lote" onClose={() => { if (!frozen) onClose(); }} actions={<><button type="button" className="secondary-button" disabled={frozen} onClick={onClose}>Não</button><button type="button" className="primary-button" disabled={command.busy} onClick={confirm}>{command.busy ? 'Excluindo…' : command.uncertain ? 'Conferir resultado' : 'Sim'}</button></>}>
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
    <p>Confirma a exclusão do lote <strong>{lot.code}</strong>? No FAGOO o lote fica inativo, sem novos lançamentos, e o histórico é mantido.</p>
  </Modal>;
}

/** "Detalhes de lotes": Data, Código do Lote, Data de Fabricação, Obs. (editável), Quantidade, Data de Validade and the lançamentos. */
export function LotDetailsPanel({ controller, lotId, unit, writable, onClose, onSaved }: { controller: Pick<AccessController, 'stock'>; lotId: string; unit: string; writable: boolean; onClose: () => void; onSaved: (message: string) => void }) {
  const [detail, setDetail] = useState<LotDetail | null>(null), [readError, setReadError] = useState(false);
  useEffect(() => {
    const request = new AbortController(); setDetail(null); setReadError(false);
    void Promise.resolve().then(() => controller.stock(`/v1/estoque/lotes/${lotId}?limit=50`, { signal: request.signal })).then(raw => { if (!request.signal.aborted) setDetail(parseLotDetail(raw, lotId)); })
      .catch(problem => { if (!request.signal.aborted && !aborted(problem)) setReadError(true); });
    return () => request.abort();
  }, [controller, lotId]);
  if (readError) return <StockSidePanel title="Detalhes de lotes" wide labelledBy="stock-lot-title" onClose={onClose} footer={<button type="button" className="secondary-button" onClick={onClose}>Fechar</button>}><p className="real-alert" role="alert">Não foi possível consultar o lote.</p></StockSidePanel>;
  if (!detail) return <StockSidePanel title="Detalhes de lotes" wide labelledBy="stock-lot-title" onClose={onClose} footer={<button type="button" className="secondary-button" onClick={onClose}>Fechar</button>}><p role="status">Consultando o lote…</p></StockSidePanel>;
  return <LotDetailsForm key={detail.lot.version} controller={controller} detail={detail} unit={unit} writable={writable} onClose={onClose} onSaved={onSaved} />;
}

function LotDetailsForm({ controller, detail, unit, writable, onClose, onSaved }: { controller: Pick<AccessController, 'stock'>; detail: LotDetail; unit: string; writable: boolean; onClose: () => void; onSaved: (message: string) => void }) {
  const lot = detail.lot;
  const [draft, setDraft] = useState<LotDraft>({ code: lot.code, manufactured_on: lot.manufactured_on ?? '', expires_on: lot.expires_on ?? '', note: lot.note ?? '' });
  const command = useStockCommand(controller), guard = useUnsavedForm(draft, command.busy || command.uncertain), frozen = command.busy || command.uncertain;
  const [action, setAction] = useState<'save' | 'reactivate'>('save');
  const save = (event?: FormEvent) => {
    event?.preventDefault(); if (!writable || command.busy) return;
    let body: Record<string, unknown> | null = null;
    if (!command.uncertain) { try { body = lotBody(detail.product.id, draft, detail.settings, lot.version); } catch (problem) { command.setError((problem as Error).message); return; } setAction('save'); }
    void command.run(`/v1/estoque/lotes/${lot.id}`, 'PATCH', body, parseLotSave, result => onSaved(result.replayed ? 'O lote já tinha sido salvo; nada mudou de novo.' : `Lote ${result.code} salvo.`), lotFailure);
  };
  const reactivate = () => { if (!writable || command.busy) return; if (!command.uncertain) setAction('reactivate');
    void command.run(`/v1/estoque/lotes/${lot.id}/situacao`, 'POST', command.uncertain ? null : { expected_version: lot.version, active: true }, value => parseLotStatus(value, lot.id, true), () => onSaved(`Lote ${lot.code} reativado.`), lotFailure); };
  const close = () => { if (!frozen) guard.confirmLeave(onClose); };
  const set = (patch: Partial<LotDraft>) => setDraft(current => ({ ...current, ...patch }));
  const editable = writable && !frozen;
  return <StockSidePanel title="Detalhes de lotes" wide labelledBy="stock-lot-title" onClose={close} closeDisabled={frozen}
    footer={<>{writable && !lot.active && <button type="button" className="text-button stock-panel-reverse" disabled={command.busy || (command.uncertain && action !== 'reactivate')} onClick={reactivate}>{command.uncertain && action === 'reactivate' ? 'Conferir resultado' : 'Reativar lote'}</button>}
      <button type="button" className="secondary-button" disabled={frozen} onClick={close}>{writable ? 'Cancelar' : 'Fechar'}</button>
      {writable && <button type="button" className="primary-button" disabled={command.busy || (command.uncertain && action !== 'save')} onClick={() => save()}>{command.busy ? 'Salvando…' : command.uncertain && action === 'save' ? 'Conferir resultado' : 'Salvar'}</button>}</>}>
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
    <dl className="stock-edit-facts">
      <div><dt>Data</dt><dd>{lotDay(lot.created_on)}</dd></div>
      <div><dt>Código do Lote</dt><dd>{lot.code}{!lot.active && <span className="status-badge status-neutral">Inativo</span>}</dd></div>
      <div><dt>Quantidade</dt><dd>{quantityText(lot.quantity)} {unit}</dd></div>
    </dl>
    <form className="stock-panel-form" onSubmit={save}><fieldset disabled={!editable}><legend className="real-sr-only">Datas e observação do lote</legend>
      <div className="form-field"><label htmlFor="stock-lot-made">Data de Fabricação{detail.settings.require_manufacture ? ' *' : ''}</label><input id="stock-lot-made" type="date" min="1900-01-01" max="2100-12-31" value={draft.manufactured_on} onChange={event => set({ manufactured_on: event.target.value })} /></div>
      <div className="form-field"><label htmlFor="stock-lot-expires">Data de Validade{detail.settings.require_expiry ? ' *' : ''}</label><input id="stock-lot-expires" type="date" min="1900-01-01" max="2100-12-31" value={draft.expires_on} onChange={event => set({ expires_on: event.target.value })} /></div>
      <div className="form-field real-field-wide"><label htmlFor="stock-lot-note">Obs.</label><textarea id="stock-lot-note" maxLength={500} rows={2} value={draft.note} onChange={event => set({ note: event.target.value })} /></div>
    </fieldset></form>
    {detail.warehouses.length > 0 && <table className="stock-balances"><thead><tr><th>Depósito</th><th className="numeric">Quantidade</th></tr></thead><tbody>{detail.warehouses.map(w => <tr key={w.warehouse_id} className={w.ignored ? 'is-ignored' : undefined}><td>{w.name}{w.active ? '' : ' · inativo'}{w.ignored && <small> Saldo deste depósito não é considerado.</small>}</td><td className="numeric">{quantityText(w.quantity)}</td></tr>)}</tbody></table>}
    <h3>Lançamentos do lote</h3>
    {detail.movements.items.length ? <table className="stock-balances"><thead><tr><th>Data</th><th>Depósito</th><th className="numeric">Entrada</th><th className="numeric">Saída</th><th>Origem</th></tr></thead>
      <tbody>{detail.movements.items.map(m => <tr key={`${m.movement_id}:${m.warehouse_id}`}><td>{lotDay(m.occurred_on)}</td><td>{detail.warehouses.find(w => w.warehouse_id === m.warehouse_id)?.name ?? 'Depósito'}</td>
        <td className="numeric">{m.quantity.startsWith('-') ? '' : quantityText(m.quantity)}</td><td className="numeric">{m.quantity.startsWith('-') ? quantityText(m.quantity.slice(1)) : ''}</td>
        <td>{m.kind === 'reversal' ? 'Estorno' : m.origin.document_number ? `${ORIGIN_TEXT[m.origin.type] ?? 'Documento'} ${m.origin.document_number}` : ORIGIN_TEXT[m.origin.type] ?? 'Sem origem'}<small className="stock-reference">{m.reason}</small></td></tr>)}</tbody></table>
      : <p className="real-help">Nenhum lançamento com este lote.</p>}
    {detail.movements.total > detail.movements.items.length && <p className="real-help">Mostrando os {detail.movements.items.length} lançamentos mais recentes de {detail.movements.total}.</p>}
  </StockSidePanel>;
}

/** Aba Estoque do produto, "Controle de lote" ativado: "Nenhum lote cadastrado" / "+ Adicionar lote" and the grid of lots. */
export function ProductLots({ controller, productId, lotOn, savedLotOn, writable, unit }: { controller: Pick<AccessController, 'stock'>; productId: string | null; lotOn: boolean; savedLotOn: boolean; writable: boolean; unit: string }) {
  const [reload, setReload] = useState(0), [adding, setAdding] = useState(false), [notice, setNotice] = useState('');
  const ready = Boolean(productId && savedLotOn);
  const lots = useStockLots(controller, ready ? productId : null, null, 'todos', reload);
  const actor = useRef(productId);
  useEffect(() => { if (actor.current !== productId) { actor.current = productId; setAdding(false); setNotice(''); } }, [productId]);
  if (!lotOn && !savedLotOn) return null;
  if (!productId) return <p className="real-help real-field-wide">Salve o produto com o Controle de lote ativado para cadastrar os lotes.</p>;
  if (!savedLotOn) return <p className="real-help real-field-wide">Salve o produto para gravar o Controle de lote; depois cadastre os lotes aqui.</p>;
  const page = lots.page;
  return <section className="stock-product-lots real-field-wide" aria-label="Lotes do produto">
    {notice && <p className="real-success" role="status">{notice}</p>}
    {lots.error ? <p className="real-alert" role="alert">Não foi possível consultar os lotes do produto.</p> : !page ? <p role="status">Consultando os lotes…</p> : <>
      {page.items.length ? <table className="data-table"><thead><tr><th scope="col">Lote</th><th scope="col">Data de fabricação</th><th scope="col">Data de validade</th><th scope="col" className="numeric">Quantidade</th><th scope="col"><span className="real-sr-only">Situação</span></th></tr></thead>
        <tbody>{page.items.map(lot => <tr key={lot.id}><td>{lot.code}</td><td>{lotDay(lot.manufactured_on)}</td><td>{lotDay(lot.expires_on)}<ExpiryBadge lot={lot} today={page.today} /></td><td className="numeric">{quantityText(lot.quantity)} {unit}</td><td>{lot.active ? '' : <span className="status-badge status-neutral">Inativo</span>}</td></tr>)}</tbody></table>
        : <p className="empty-state">Nenhum lote cadastrado</p>}
      {page.total > page.items.length && <p className="real-help">Mostrando {page.items.length} de {page.total} lotes. Veja todos em <Link to={`/estoque-empresa?produto=${productId}`}>Lotes e validades</Link>.</p>}
      {adding ? <ProductLotForm controller={controller} productId={productId} settings={page.settings} onCancel={() => setAdding(false)} onSaved={code => { setAdding(false); setNotice(`Lote ${code} cadastrado.`); setReload(value => value + 1); }} />
        : writable && <button type="button" className="text-button" onClick={() => { setNotice(''); setAdding(true); }}><Icon name="plus" size={11} />Adicionar lote</button>}
      <p className="real-help">As quantidades entram pelos lançamentos de estoque com o lote (Estoque › <Link to={`/estoque-empresa?produto=${productId}`}>Lançamentos de estoque</Link>), somando os depósitos considerados.</p>
    </>}
  </section>;
}

function ProductLotForm({ controller, productId, settings, onCancel, onSaved }: { controller: Pick<AccessController, 'stock'>; productId: string; settings: LotSettings; onCancel: () => void; onSaved: (code: string) => void }) {
  const [draft, setDraft] = useState<LotDraft>(EMPTY_LOT);
  const command = useStockCommand(controller), guard = useUnsavedForm(draft, command.busy || command.uncertain), frozen = command.busy || command.uncertain;
  const set = (patch: Partial<LotDraft>) => setDraft(current => ({ ...current, ...patch }));
  const save = () => {
    if (command.busy) return;
    let body: Record<string, unknown> | null = null;
    if (!command.uncertain) { try { body = lotBody(productId, draft, settings); lotNote(draft.note); } catch (problem) { command.setError((problem as Error).message); return; } }
    void command.run('/v1/estoque/lotes', 'POST', body, parseLotSave, result => onSaved(result.code), lotFailure);
  };
  // The grid sits inside the product form: Enter saves the lot, never the product.
  return <fieldset className="stock-product-lot-form" disabled={command.busy} onKeyDown={event => { if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') { event.preventDefault(); save(); } }}><legend>Adicionar lote</legend>
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
    <div className="form-field"><label htmlFor="product-lot-code">Lote *</label><input id="product-lot-code" maxLength={60} value={draft.code} disabled={frozen} onChange={event => set({ code: event.target.value })} /></div>
    <div className="form-field"><label htmlFor="product-lot-made">Data de fabricação{settings.require_manufacture ? ' *' : ''}</label><input id="product-lot-made" type="date" min="1900-01-01" max="2100-12-31" value={draft.manufactured_on} disabled={frozen} onChange={event => set({ manufactured_on: event.target.value })} /></div>
    <div className="form-field"><label htmlFor="product-lot-expires">Data de validade{settings.require_expiry ? ' *' : ''}</label><input id="product-lot-expires" type="date" min="1900-01-01" max="2100-12-31" value={draft.expires_on} disabled={frozen} onChange={event => set({ expires_on: event.target.value })} /></div>
    <div className="form-field real-field-wide"><label htmlFor="product-lot-note">Obs.</label><input id="product-lot-note" maxLength={500} value={draft.note} disabled={frozen} onChange={event => set({ note: event.target.value })} /></div>
    <div className="real-editor-actions"><button type="button" className="secondary-button" disabled={frozen} onClick={() => guard.confirmLeave(onCancel)}>Cancelar</button><button type="button" className="primary-button" disabled={command.busy} onClick={save}>{command.busy ? 'Salvando…' : command.uncertain ? 'Conferir resultado' : 'Salvar lote'}</button></div>
  </fieldset>;
}
