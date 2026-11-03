import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useUnsavedChanges, useUnsavedChangesGuard } from '../hooks/useUnsavedChanges';
import { AccessError, type AccessController } from '../lib/real-access';
import { quantityText } from '../lib/stock-model';
import { priceText } from '../lib/stock-launch-model';
import { BATCH_TEXT, CHECKIN_READERS, EVENT_LABELS, FINISHED_TEXT, ISSUE_LABELS, ISSUE_QUANTITY_LABELS, ITEM_STATE_LABELS, LOAD_FAILURE, NOTES_INFO, NOTE_STATE_LABELS, NO_NOTE, NO_NOTE_HELP, RESTART_TEXT, WAITING_NOTE,
  addBox, checkinHref, checkinNoteParam, documentText, itemState, localDateTime, matchItems, notFound, supplierCodeOf, overNote, parseCheckin, parseCheckinCommand, parseCheckinNotes, priceDiffers, receivedInput, stepReceived, verified,
  type CheckinItem, type CheckinNote, type CheckinView, type IssueKind } from '../lib/receipt-checkin-model';
import { StockSidePanel, useStockCommand } from './StockMovementPanel';
import StockPrintPreview from './StockPrintPreview';
import BarcodeCamera, { cameraSupported } from './BarcodeCamera';
import { Modal } from './Modal';
import { Icon } from './Icon';
// 259: Finalizar with "Lançar estoque ao finalizar Check-in".
import { CheckinFinishModal } from './InvoiceStock';
import './stock.css';
import './receipt-checkin.css';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const BASE = '/v1/estoque/checkin/notas';
const SEGMENTS = { save: 'recebidos', issue: 'pendencias', batch: 'lote', restart: 'reinicio', finish: 'finalizacao' } as const;
type Action = keyof typeof SEGMENTS;
const READERS = CHECKIN_READERS, WRITERS = ['admin', 'estoque'];
const failure = (error: unknown) => error instanceof AccessError ? error.status === 409 ? 'O check-in ou a nota foi alterado em outra tela. Recarregue a nota e confira as quantidades.'
  : error.status === 403 ? 'Seu perfil não permite conferir recebimentos.' : error.status === 404 ? 'A nota ou o item não está mais disponível. Recarregue a nota.'
  : error.status === 400 ? 'Confira as quantidades e a pendência informadas.' : 'Não foi possível concluir. Tente novamente.' : 'Não foi possível concluir. Tente novamente.';
const DONE: Record<Action, string> = { save: 'Alterações salvas.', issue: 'Pendência registrada.', batch: 'Produtos marcados como verificados.', restart: 'Conferência reiniciada.', finish: FINISHED_TEXT };
const SKIP_KEY = (actor: string) => `brufap.checkin.batch.skip.${actor}`;
const readSkip = (actor: string) => { try { return globalThis.localStorage?.getItem(SKIP_KEY(actor)) === '1'; } catch { return false; } };
const writeSkip = (actor: string) => { try { globalThis.localStorage?.setItem(SKIP_KEY(actor), '1'); } catch { /* A per-browser convenience only. */ } };
const noteTitle = (note: CheckinNote) => `NFe ${note.number ?? '—'}`;

/** Estoque > Check-in de Recebimentos like Origin: the Notas column, the items of the selected entry note with Qtde Recebida, pendências,
 * check-in em lote, Resumo, Histórico, Reiniciar and Finalizar (259: optionally posting the Qtde Recebida to stock). The note is never changed. */
export default function ReceiptCheckin({ controller }: { controller: AccessController }) {
  const navigate = useNavigate(), location = useLocation(), navigationGuard = useUnsavedChangesGuard();
  const snapshot = controller.getSnapshot(), role = snapshot.membership?.role ?? '', actor = snapshot.membership?.user_id ?? '';
  const readable = READERS.includes(role), writable = WRITERS.includes(role);
  const noteId = checkinNoteParam(location.search);
  // Notas column ("Chave de acesso ou Número da nota").
  const [queryDraft, setQueryDraft] = useState(''), [query, setQuery] = useState<string | null>(null), [offset, setOffset] = useState(0), [notesReload, setNotesReload] = useState(0);
  const [notes, setNotes] = useState<{ key: string; items: CheckinNote[]; total: number } | null>(null), [notesError, setNotesError] = useState('');
  const notesKey = `${query ?? ''}:${offset}:${notesReload}:${actor}`;
  useEffect(() => {
    if (!readable) return;
    const request = new AbortController(), key = notesKey; setNotesError('');
    const params = new URLSearchParams(); if (query) params.set('q', query); if (offset) params.set('offset', String(offset));
    void Promise.resolve().then(() => controller.stock(`${BASE}${params.size ? `?${params}` : ''}`, { signal: request.signal })).then(raw => {
      if (request.signal.aborted) return; const value = parseCheckinNotes(raw, query, offset); setNotes({ key, items: value.items, total: value.total }); })
      .catch(problem => { if (!request.signal.aborted && !aborted(problem)) { setNotes(null); setNotesError(problem instanceof AccessError && problem.status === 400 ? 'Informe a chave de acesso (44 dígitos) ou o número da nota.' : failure(problem)); } });
    return () => request.abort();
  }, [controller, notesKey, readable]);
  // The selected note: the URL drives it, a late answer of another note or actor is ignored.
  const [reload, setReload] = useState(0), viewKey = noteId ? `${noteId}:${reload}:${actor}` : '';
  const [stored, setStored] = useState<{ key: string; value: CheckinView } | null>(null), [loadError, setLoadError] = useState(''), [loading, setLoading] = useState(false);
  useEffect(() => {
    setLoadError(''); if (!noteId || !readable) { setLoading(false); return; }
    const request = new AbortController(), key = viewKey, id = noteId; setLoading(true);
    void Promise.resolve().then(() => controller.stock(`${BASE}/${id}`, { signal: request.signal })).then(raw => { if (!request.signal.aborted) setStored({ key, value: parseCheckin(raw, id) }); })
      .catch(problem => { if (!request.signal.aborted && !aborted(problem)) setLoadError(problem instanceof AccessError && problem.status === 404 ? 'Nota não encontrada ou indisponível para check-in.' : LOAD_FAILURE); })
      .finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [controller, viewKey, readable]);
  const view = stored && stored.key === viewKey ? stored.value : null;
  // Qtde Recebida typed or read on this screen, saved together with "Salvar alterações".
  const [drafts, setDrafts] = useState<Record<number, string>>({}), [draftsOf, setDraftsOf] = useState('');
  const draftScope = view ? `${view.note.invoice_id}:${view.version}` : '';
  if (draftsOf !== draftScope) { setDraftsOf(draftScope); setDrafts({}); }
  const command = useStockCommand(controller), [pending, setPending] = useState<Action | null>(null);
  const changed = Boolean(view && view.items.some(item => drafts[item.position] !== undefined && drafts[item.position] !== item.received));
  useUnsavedChanges(changed, command.busy || command.uncertain);
  const [selected, setSelected] = useState<number[]>([]), [search, setSearch] = useState(''), [message, setMessage] = useState(''), [notice, setNotice] = useState(''), [camera, setCamera] = useState(false);
  const [issueFor, setIssueFor] = useState<CheckinItem | null>(null), [issueKind, setIssueKind] = useState<IssueKind>('missing'), [issueQuantity, setIssueQuantity] = useState(''), [issueError, setIssueError] = useState('');
  const [modal, setModal] = useState<'batch' | 'restart' | 'finish' | null>(null), [skip, setSkip] = useState(false), [panel, setPanel] = useState<'summary' | 'history' | null>(null), [printing, setPrinting] = useState<'summary' | 'history' | null>(null);
  // Another actor never inherits this actor's drafts, selection or pending command (RealAccess also remounts per user).
  const lastActor = useRef(actor);
  useEffect(() => { if (lastActor.current === actor) return; lastActor.current = actor; setDrafts({}); setSelected([]); setIssueFor(null); setModal(null); setPanel(null); setNotice(''); setMessage(''); }, [actor]);
  const live = useRef({ noteId, viewKey }); live.current = { noteId, viewKey };
  const frozen = command.busy || command.uncertain;
  const finished = view?.checkin?.state === 'finished', stale = Boolean(view?.checkin?.stale);
  const editable = Boolean(view && writable && view.note.open && !finished && !stale && view.can_manage !== false);
  const current = (item: CheckinItem) => drafts[item.position] ?? item.received;
  const run = (action: Action, body: Record<string, unknown> | null) => {
    if (!noteId || command.busy) return;
    const id = noteId, key = viewKey; if (body) setPending(action);
    const kind = body ? action : pending ?? action;
    void command.run(`${BASE}/${id}/${SEGMENTS[kind]}`, 'POST', body, (value, sent) => parseCheckinCommand(value, id, sent, kind), result => {
      setPending(null); setModal(null); setIssueFor(null); setSelected([]);
      if (live.current.noteId !== id) return;
      setStored({ key, value: result }); setDrafts({}); setNotesReload(value => value + 1);
      setNotice(result.replayed ? 'Esta operação já tinha sido registrada; nada foi repetido.' : DONE[kind]);
    }, failure);
  };
  const choose = (note: CheckinNote) => { if (frozen || note.invoice_id === noteId) return; navigationGuard.confirmLeave(() => { setNotice(''); setMessage(''); setSearch(''); setSelected([]); navigate(checkinHref(note.invoice_id)); }); };
  const submitQuery = (event: FormEvent) => { event.preventDefault(); const value = queryDraft.trim(); setOffset(0); setQuery(value || null); };
  const setDraft = (item: CheckinItem, value: string) => setDrafts(previous => ({ ...previous, [item.position]: value }));
  const typed = (item: CheckinItem, text: string) => { try { setDraft(item, receivedInput(text)); setMessage(''); } catch { setMessage('Quantidade inválida!'); } };
  // A reading (scanner, camera or Enter) adds one unit to the item with that exact code; otherwise the text filters by name.
  const read = (code: string) => {
    if (!view) return; const value = code.trim(); if (!value) return;
    const { exact, box } = matchItems(view.items, value);
    // Not found: the whole grid stays visible for the quantity to be typed by hand (Origin).
    if (!exact) { setMessage(notFound(value)); setSearch(''); return; }
    if (!editable || exact.issue === 'refused') { setMessage('Este item não aceita novas quantidades.'); return; }
    // 181: a DUN (box GTIN of the cadastro) adds the units of the box.
    const next = box === null ? stepReceived(current(exact), 1) : addBox(current(exact), box);
    if (next === null) { setMessage('A quantidade por caixa deste DUN tem mais de 4 casas decimais. Insira manualmente a quantidade recebida.'); setSearch(''); return; }
    setDraft(exact, next); setSearch(''); setMessage(''); setNotice(`Leitura registrada: ${exact.description}${box === null ? '' : ` (caixa com ${quantityText(box)})`}. Salve as alterações para gravar.`);
  };
  const searchKey = (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') { event.preventDefault(); read(search); } };
  const save = () => { if (!view || !editable || !changed || frozen) return;
    run('save', { command_id: crypto.randomUUID(), expected_version: view.version, items: view.items.filter(item => drafts[item.position] !== undefined && drafts[item.position] !== item.received).map(item => ({ position: item.position, received: drafts[item.position] })) }); };
  const startBatch = () => { if (!view || !editable || !selected.length || changed || frozen) return; if (readSkip(actor)) run('batch', { command_id: crypto.randomUUID(), expected_version: view.version, positions: [...selected].sort((a, b) => a - b) }); else { setSkip(false); setModal('batch'); } };
  const confirmBatch = () => { if (!view) return; if (skip) writeSkip(actor); run('batch', { command_id: crypto.randomUUID(), expected_version: view.version, positions: [...selected].sort((a, b) => a - b) }); };
  const registerIssue = (event: FormEvent) => {
    event.preventDefault(); if (!view || !issueFor || frozen) return; setIssueError('');
    let quantity: string | null = null;
    if (issueKind !== 'refused') { try { quantity = receivedInput(issueQuantity); } catch { setIssueError('Quantidade inválida!'); return; }
      if (/^0\.0+$/.test(quantity) || BigInt(quantity.replace('.', '')) > BigInt(issueFor.quantity.replace('.', ''))) { setIssueError('Informe uma quantidade maior que zero e até a quantidade da nota.'); return; } }
    run('issue', { command_id: crypto.randomUUID(), expected_version: view.version, position: issueFor.position, kind: issueKind, quantity, action: 'none' });
  };
  const items = useMemo(() => view ? matchItems(view.items, search).filtered : [], [view, search]);
  const total = view?.items.length ?? 0, done = view ? verified(view.items, drafts) : 0;
  const copy = (value: string) => { try { void globalThis.navigator?.clipboard?.writeText(value).catch(() => {}); setNotice('Descrição copiada.'); } catch { /* Clipboard unavailable. */ } };
  if (!readable) return <section className="real-state-panel"><h1>Check-in não liberado</h1><p>Seu perfil não possui acesso ao check-in de recebimentos.</p></section>;
  const groups = view ? [
    { title: 'Conferidos sem pendências', rows: view.items.filter(item => item.state === 'complete') },
    { title: 'Conferidos com pendências', rows: view.items.filter(item => item.issue && item.issue !== 'refused') },
    { title: 'Recusados', rows: view.items.filter(item => item.issue === 'refused') },
    { title: 'Ainda não conferidos', rows: view.items.filter(item => item.state === 'pending' || item.state === 'in_progress') }] : [];
  const summaryBody = view && <><dl className="stock-edit-facts"><div><dt>Número da nota fiscal</dt><dd>{view.note.number ?? '—'}</dd></div><div><dt>Data da conferência</dt><dd>{view.checkin ? localDateTime(view.checkin.finished_at ?? view.checkin.updated_at) : '—'}</dd></div>
    <div><dt>Fornecedor</dt><dd>{view.note.supplier.name ?? '—'}</dd></div><div><dt>Usuário responsável</dt><dd>{view.responsible?.finished_by_name ?? view.responsible?.started_by_name ?? '—'}</dd></div><div><dt>Itens conferidos</dt><dd>{view.summary.complete}</dd></div><div><dt>Itens com pendência</dt><dd>{view.summary.issue}</dd></div>
    <div><dt>Itens recusados</dt><dd>{view.summary.refused}</dd></div><div><dt>Itens pendentes</dt><dd>{view.summary.pending}</dd></div></dl>
    {groups.map(group => <section key={group.title}><h3>{group.title}</h3>{group.rows.length ? <table className="stock-balances"><thead><tr><th>Descrição</th><th className="numeric">Quantidade</th><th>Pendência</th></tr></thead><tbody>{group.rows.map(item => <tr key={item.position}><td>{item.description}</td><td className="numeric">{quantityText(item.received)} / {quantityText(item.quantity)}</td><td>{item.issue ? `${ISSUE_LABELS[item.issue]}${item.issue_quantity ? `: ${quantityText(item.issue_quantity)}` : ''}` : '—'}</td></tr>)}</tbody></table> : <p className="real-help">Nenhum item.</p>}</section>)}</>;
  const historyBody = view && (view.events.length ? <table className="stock-balances"><thead><tr><th>Produto</th><th>Ação</th><th>Quando</th></tr></thead><tbody>{view.events.map(event => <tr key={event.id}><td>{event.description ?? '—'}</td><td>{EVENT_LABELS[event.action] ?? event.action}{event.action === 'received' && event.quantity ? `: ${quantityText(event.previous ?? '0')} → ${quantityText(event.quantity)}` : event.quantity && event.action !== 'batch' ? `: ${quantityText(event.quantity)}` : ''}</td><td>{localDateTime(event.at)}</td></tr>)}</tbody></table> : <p className="real-help">Nenhuma ação de conferência registrada.</p>);
  return <>
    <header className="real-heading"><div className="stock-title"><h1>Check-in de Recebimentos</h1></div><span className="real-mode">{writable ? 'Conferência autorizada' : 'Somente consulta'}</span></header>
    <p className="real-notice">A conferência fica registrada no FAGOO e não altera a nota. Ao finalizar, “Lançar estoque ao finalizar Check-in” lança a entrada da Qtde Recebida no depósito escolhido; contas, crédito e devolução não são gerados.</p>
    {notice && <p className="real-success" role="status">{notice}</p>}{message && <p className="real-alert" role="alert">{message}</p>}
    {command.error && <p className="real-alert" role="alert">{command.error}{command.uncertain ? <button type="button" className="text-button" disabled={command.busy} onClick={() => run(pending ?? 'save', null)}>Conferir resultado</button>
      : noteId && <button type="button" className="text-button" disabled={command.busy} onClick={() => { command.setError(''); setReload(value => value + 1); }}>Recarregar a nota</button>}</p>}
    <div className="checkin-layout">
      <aside className="checkin-notes" aria-label="Notas"><h2>Notas <span className="stock-info" title={NOTES_INFO} aria-label={NOTES_INFO}><Icon name="circle-info" size={11} /></span></h2>
        <form className="checkin-note-search" onSubmit={submitQuery}><label className="real-sr-only" htmlFor="checkin-note-query">Chave de acesso ou Número da nota</label>
          <input id="checkin-note-query" maxLength={60} placeholder="Chave de acesso ou Número da nota" value={queryDraft} disabled={frozen} onChange={event => setQueryDraft(event.target.value)} /><button type="submit" className="icon-button" aria-label="Buscar nota" disabled={frozen}><Icon name="magnifying-glass" size={12} /></button></form>
        {notesError && <p className="real-alert" role="alert">{notesError}</p>}
        {notes && notes.key === notesKey && <><ul className="checkin-note-list">{notes.items.map(note => <li key={note.invoice_id}><button type="button" className={`checkin-note-card${note.invoice_id === noteId ? ' is-selected' : ''}`} aria-current={note.invoice_id === noteId ? 'true' : undefined} disabled={frozen} onClick={() => choose(note)}>
          <strong>{noteTitle(note)}</strong><span className={`status-badge ${note.checkin_state === 'finished' ? 'status-success' : note.checkin_state === 'in_progress' ? 'status-warning' : 'status-neutral'}`}>{NOTE_STATE_LABELS[note.checkin_state]}</span>
          <small>{note.supplier.name ?? '—'} · {documentText(note.supplier.document)}</small><small>Incluída em {localDateTime(note.created_at)} · {note.items_count} {note.items_count === 1 ? 'item' : 'itens'}</small></button></li>)}</ul>
          {!notes.items.length && <p className="empty-state">Nenhuma nota de entrada para conferir.</p>}
          {notes.total > offset + notes.items.length && <button type="button" className="text-button" disabled={frozen} onClick={() => setOffset(offset + notes.items.length)}>Próximas notas</button>}
          {offset > 0 && <button type="button" className="text-button" disabled={frozen} onClick={() => setOffset(Math.max(0, offset - 50))}>Notas anteriores</button>}</>}
      </aside>
      <section className="checkin-main" aria-label="Itens da nota">
        {!noteId ? <div className="origin-empty"><span className="status-badge status-neutral">{WAITING_NOTE}</span><h2>{NO_NOTE}</h2><p>{NO_NOTE_HELP}</p></div>
          : loadError ? <p className="real-alert" role="alert">{loadError}<button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>Tentar novamente</button></p>
          : !view ? <p role="status">{loading ? 'Carregando a nota…' : ''}</p> : <>
          <dl className="checkin-note-facts"><div><dt>Fornecedor</dt><dd>{view.note.supplier.name ?? '—'}<small>{documentText(view.note.supplier.document)}</small></dd></div><div><dt>Nota fiscal</dt><dd>{view.note.number ?? '—'}<small>Série {view.note.series}</small></dd></div>
            <div><dt>Data de inclusão</dt><dd>{localDateTime(view.note.created_at)}</dd></div><div><dt>Quantidade de itens</dt><dd>{view.items.length}</dd></div></dl>
          {finished && <p className="real-success" role="status">{FINISHED_TEXT}</p>}
          {stale && !finished && <p className="real-notice">A nota foi alterada depois do início do check-in. Reinicie a conferência para usar os itens atuais da nota.</p>}
          {!view.note.open && <p className="real-notice">A nota foi excluída, cancelada ou denegada: o check-in fica apenas para consulta.</p>}
          <div className="checkin-item-search"><label htmlFor="checkin-item-search">Nome do produto, código no fornecedor, GTIN ou DUN</label><input id="checkin-item-search" maxLength={120} value={search} disabled={frozen} onChange={event => setSearch(event.target.value)} onKeyDown={searchKey} />
            {editable && cameraSupported() && <button type="button" className="secondary-button" disabled={frozen} onClick={() => setCamera(true)}><Icon name="barcode" size={12} />Câmera</button>}</div>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Itens da nota"><table className="data-table real-table checkin-table"><thead><tr><th><span className="real-sr-only">Selecionar</span></th><th>Descrição</th><th>Cod. fornecedor</th><th className="numeric">Preço</th><th>Un</th><th className="numeric">Qtde Nota</th><th className="numeric">Solicitado</th><th className="numeric">Qtde Recebida</th><th><span className="real-sr-only">Situação</span></th><th><span className="real-sr-only">Ações</span></th></tr></thead>
            <tbody>{items.map(item => { const value = current(item), state = itemState(item, value), locked = !editable || item.issue === 'refused' || frozen;
              return <tr key={item.position} className={`checkin-row is-${state}`}>
                <td><input type="checkbox" aria-label={`Selecionar ${item.description}`} checked={selected.includes(item.position)} disabled={locked} onChange={() => setSelected(previous => previous.includes(item.position) ? previous.filter(position => position !== item.position) : [...previous, item.position])} /></td>
                <td>{item.description}<button type="button" className="icon-button" aria-label={`Copiar ${item.description}`} onClick={() => copy(item.description)}><Icon name="copy" size={11} /></button>{priceDiffers(item) && <small className="status-badge status-warning">Preço diferente</small>}{overNote(item, value) && <small className="status-badge status-warning">Quantidade maior que a nota</small>}</td>
                <td title={item.catalog_supplier_code && item.supplier_code && item.catalog_supplier_code !== item.supplier_code ? `Código na nota: ${item.supplier_code}` : undefined}>{supplierCodeOf(item) ?? '—'}</td><td className="numeric">{priceText(item.unit_price)}</td><td>{item.unit ?? '—'}</td><td className="numeric">{quantityText(item.quantity)}</td><td className="numeric">{item.requested ? quantityText(item.requested.quantity) : '-'}</td>
                <td className="numeric"><span className="checkin-stepper"><button type="button" className="icon-button" aria-label={`Diminuir ${item.description}`} disabled={locked} onClick={() => setDraft(item, stepReceived(value, -1))}>−</button>
                  <input id={`checkin-received-${item.position}`} aria-label={`Qtde Recebida de ${item.description}`} inputMode="decimal" maxLength={16} value={quantityText(value)} disabled={locked} onChange={event => typed(item, event.target.value)} />
                  <button type="button" className="icon-button" aria-label={`Aumentar ${item.description}`} disabled={locked} onClick={() => setDraft(item, stepReceived(value, 1))}>+</button></span></td>
                <td><span className={`checkin-state is-${state}`} title={ITEM_STATE_LABELS[state]} aria-label={ITEM_STATE_LABELS[state]} role="img"><Icon name={state === 'complete' ? 'circle-check' : state === 'issue' ? 'triangle-exclamation' : 'circle'} size={12} /></span>{item.issue && <small>{ISSUE_LABELS[item.issue]}{item.issue_quantity ? `: ${quantityText(item.issue_quantity)}` : ''}</small>}</td>
                <td>{editable && item.issue !== 'refused' && <button type="button" className="icon-button" title="Registrar pendência do produto" aria-label={`Registrar pendência do produto ${item.description}`} disabled={frozen || changed} onClick={() => { setIssueFor(item); setIssueKind('missing'); setIssueQuantity(''); setIssueError(''); }}><Icon name="ellipsis-vertical" size={12} /></button>}</td>
              </tr>; })}</tbody></table></div>
          {!items.length && <p className="empty-state">{search ? 'Nenhum item encontrado com esta busca.' : 'A nota não tem itens.'}</p>}</>}
      </section>
      <aside className="checkin-actions" aria-label="Ações do check-in">
        <p className="checkin-progress"><span>Produtos verificados {done} / {total}</span><progress max={Math.max(total, 1)} value={done} aria-label={`Produtos verificados ${done} de ${total}`} /></p>
        {writable && <button type="button" className="secondary-button" disabled={!editable || !selected.length || changed || frozen} title={changed ? 'Salve as alterações antes.' : undefined} onClick={startBatch}>Check-in em lote</button>}
        <button type="button" className="action-button" disabled={!view} onClick={() => setPanel('summary')}><Icon name="list-check" size={14} />Resumo de conferências</button>
        <button type="button" className="action-button" disabled={!view} onClick={() => setPanel('history')}><Icon name="clock-rotate-left" size={14} />Histórico de ações</button>
        {writable && <button type="button" className="action-button" disabled={!view?.checkin || finished || !view.note.open || frozen || view.can_manage === false} onClick={() => setModal('restart')}><Icon name="rotate-left" size={14} />Reiniciar</button>}
        {writable && <button type="button" className="primary-button" disabled={!editable || !view?.checkin || changed || frozen} title={changed ? 'Salve as alterações antes.' : undefined} onClick={() => setModal('finish')}>Finalizar</button>}
        {writable && <button type="button" className="primary-button" disabled={!editable || !changed || frozen} onClick={save}>{command.busy && pending === 'save' ? 'Salvando…' : 'Salvar alterações'}</button>}
      </aside>
    </div>
    {camera && <BarcodeCamera onClose={() => setCamera(false)} onCode={read} />}
    {issueFor && view && editable && <Modal title="Produto com divergência" onClose={() => { if (!frozen) setIssueFor(null); }} actions={<><button type="button" className="secondary-button" disabled={frozen} onClick={() => setIssueFor(null)}>Cancelar</button><button type="submit" form="checkin-issue-form" className="primary-button" disabled={command.busy}>{command.uncertain ? 'Conferir resultado' : 'Registrar'}</button></>}>
      <form id="checkin-issue-form" onSubmit={event => { if (command.uncertain) { event.preventDefault(); run('issue', null); } else registerIssue(event); }}><p>{issueFor.description} — Qtde Nota {quantityText(issueFor.quantity)}</p>
        <fieldset disabled={frozen}><legend>Tipo</legend>{(['missing', 'damaged', 'incorrect', 'refused'] as IssueKind[]).map(kind => <label key={kind}><input type="radio" name="checkin-issue-kind" value={kind} checked={issueKind === kind} onChange={() => setIssueKind(kind)} />{ISSUE_LABELS[kind]}</label>)}</fieldset>
        {issueKind !== 'refused' && <div className="form-field"><label htmlFor="checkin-issue-quantity">{ISSUE_QUANTITY_LABELS[issueKind]}</label><input id="checkin-issue-quantity" inputMode="decimal" maxLength={16} value={issueQuantity} disabled={frozen} onChange={event => setIssueQuantity(event.target.value)} /></div>}
        <fieldset disabled={frozen}><legend>Ação para o item</legend>
          <label title="O FAGOO ainda não gera crédito para o fornecedor."><input type="radio" name="checkin-issue-action" disabled checked={false} onChange={() => {}} />Gerar crédito para o fornecedor</label>
          <label title="O FAGOO ainda não gera nota de devolução pelo check-in."><input type="radio" name="checkin-issue-action" disabled checked={false} onChange={() => {}} />Gerar nota de devolução</label>
          <label><input type="radio" name="checkin-issue-action" checked readOnly />Não aplicar nenhuma ação</label></fieldset>
        {issueError && <p className="real-alert" role="alert">{issueError}</p>}</form>
    </Modal>}
    {modal === 'batch' && view && <Modal title="Check-in lote" onClose={() => { if (!frozen) setModal(null); }} actions={<><button type="button" className="secondary-button" disabled={frozen} onClick={() => setModal(null)}>Cancelar</button><button type="button" className="primary-button" disabled={command.busy} onClick={() => command.uncertain ? run('batch', null) : confirmBatch()}>{command.uncertain ? 'Conferir resultado' : 'Confirmar'}</button></>}>
      <p>{BATCH_TEXT}</p><label><input type="checkbox" checked={skip} disabled={frozen} onChange={event => setSkip(event.target.checked)} />Não mostrar novamente</label></Modal>}
    {modal === 'restart' && view && <Modal title="Reiniciar conferência" onClose={() => { if (!frozen) setModal(null); }} actions={<><button type="button" className="secondary-button" disabled={frozen} onClick={() => setModal(null)}>Não</button><button type="button" className="primary-button" disabled={command.busy} onClick={() => command.uncertain ? run('restart', null) : run('restart', { command_id: crypto.randomUUID(), expected_version: view.version })}>{command.uncertain ? 'Conferir resultado' : 'Sim'}</button></>}><p>{RESTART_TEXT}</p></Modal>}
    {modal === 'finish' && view && <CheckinFinishModal controller={controller} invoiceId={view.note.invoice_id} version={view.version} summary={view.summary} plainBusy={command.busy} plainUncertain={command.uncertain}
      onFinish={() => command.uncertain ? run('finish', null) : run('finish', { command_id: crypto.randomUUID(), expected_version: view.version })} onClose={() => setModal(null)}
      onPosted={message => { setModal(null); setNotice(message); setDrafts({}); setNotesReload(value => value + 1); setReload(value => value + 1); }} />}
    {panel && view && <StockSidePanel title={panel === 'summary' ? 'Resumo da conferência' : 'Histórico de ações'} wide labelledBy="checkin-panel-title" onClose={() => setPanel(null)}
      footer={<><button type="button" className="secondary-button" onClick={() => setPrinting(panel)}><Icon name="print" size={12} />Imprimir</button><button type="button" className="primary-button" onClick={() => setPanel(null)}>Ok</button></>}>
      {panel === 'summary' ? summaryBody : historyBody}</StockSidePanel>}
    {printing && view && <StockPrintPreview title={printing === 'summary' ? 'Resumo da conferência' : 'Histórico de ações'} onClose={() => setPrinting(null)}><h1>{printing === 'summary' ? 'Resumo da conferência' : 'Histórico de ações'} · {noteTitle(view.note)}</h1>{printing === 'summary' ? summaryBody : historyBody}</StockPrintPreview>}
  </>;
}
