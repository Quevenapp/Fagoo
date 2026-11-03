import { isDocumentMirror } from '../lib/document-mirror-model';
import FiscalDraftReview from './FiscalDraftReview';
import FiscalItemPreparation from './FiscalItemPreparation';
import FiscalTaxPreparation from './FiscalTaxPreparation';
import FiscalBusinessCompletion from './FiscalBusinessCompletion';
import FiscalUnsignedPreview from './FiscalUnsignedPreview';
import FiscalPreparationGuide from './FiscalPreparationGuide';
import FiscalDraftStatus from './FiscalDraftStatus';
import {fiscalDraftStatusCanRead,type FiscalDraftStatusController} from '../lib/fiscal-draft-status-model';
import {hasFiscalPreparationPorts,fiscalCopyPending} from '../lib/fiscal-preparation-guide-model';
import type {FiscalUnsignedController} from '../lib/fiscal-unsigned-model';
import type {FiscalCompletionController} from '../lib/fiscal-completion-model';
import type {FiscalTaxController} from '../lib/fiscal-tax-model';
import type { FiscalItemController } from '../lib/fiscal-item-model';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AccessError } from '../lib/real-access';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { documentListParams, EMPTY_DOCUMENT_FILTERS, STATES, type DocumentPage, type DocumentSummary } from '../lib/real-documents-model';
import { CRT_LABELS } from '../lib/company-model';
import {
  FISCAL_MODEL_LABELS, FISCAL_STATUS_LABELS, FISCAL_PENDING_LABELS, fiscalListParams, fiscalModelSearch, fiscalDraftPage, fiscalDraftEnvelope, fiscalRevisionPage,
  fiscalPreparation, fiscalCreateInput, fiscalUpdateInput, fiscalRefreshInput, fiscalArchiveInput, fiscalDecimal,fiscalUnitPrice, fiscalDate, fiscalMoment,
  type FiscalDraftController, type FiscalDraftEnvelope, type FiscalDraftPage, type FiscalRevisionPage, type FiscalModel, type FiscalFilters,
} from '../lib/fiscal-drafts-model';
import NativeListLayout from './NativeListLayout';
import './fiscal-drafts.css';

const BASE = '/v1/rascunhos-fiscais';
const aborted = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';
const errorText = (e: unknown) => e instanceof AccessError
  ? e.status === 409 ? 'A versão mudou ou já existe um rascunho em preparação para este pedido. Recarregue e confira a situação atual antes de continuar.'
    : e.status === 403 ? 'Seu perfil não permite esta operação.' : e.status === 400 ? 'Confira os campos e as confirmações antes de salvar.'
      : e.status === 404 ? 'O rascunho ou pedido não está disponível.' : 'Não foi possível confirmar o resultado. Repita a mesma confirmação para consultar ou concluir a operação com segurança.'
  : e instanceof Error ? e.message : 'Não foi possível concluir a operação.';
const plain = (value: string | null | undefined) => value || 'Não informado';

/** Holds an uncertain command unchanged; retries never allocate another command ID. */
function useFiscalMutation(controller: FiscalDraftController, onSaved: (value: FiscalDraftEnvelope) => void) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(false), [conflict, setConflict] = useState(false);
  const request = useRef<AbortController | null>(null), saved = useRef<{ id: string; version: number } | null>(null), uncertain = useRef(false);
  const command = useRef<{ path: string; method: 'POST' | 'PATCH'; body: Record<string, unknown> } | null>(null);
  const callback = useRef(onSaved); callback.current = onSaved;
  useEffect(() => () => request.current?.abort(), []);
  const execute = async () => {
    if (request.current || !command.current) return;
    const priorUncertain = uncertain.current;
    const pending = new AbortController(); request.current = pending; setBusy(true); setError(''); setRetry(false);
    try {
      if (!saved.current) {
        const { path, method, body } = command.current;
        const response = fiscalDraftEnvelope(await controller.fiscalDraft(path, { method, body, signal: pending.signal }));
        if (pending.signal.aborted) return;
        saved.current = { id: response.record.id, version: response.record.version };
      }
      const latest = fiscalDraftEnvelope(await controller.fiscalDraft(`${BASE}/${saved.current.id}`, { signal: pending.signal }), saved.current.id);
      if (pending.signal.aborted) return;
      if (latest.record.version !== latest.current.version || latest.record.version < saved.current.version) throw new Error('Não foi possível conferir a versão atual. Consulte novamente o rascunho salvo.');
      command.current = null; saved.current = null; uncertain.current = false; setConflict(false); callback.current(latest);
    } catch (e) {
      if (!pending.signal.aborted && !aborted(e)) {
        // A later rejection cannot establish whether an earlier attempt committed.
        const known = e instanceof AccessError && [400, 403, 404, 409].includes(e.status) && !saved.current && !priorUncertain;
        uncertain.current = !known;
        setRetry(!known); setConflict(known && e.status === 409);
        setError(saved.current ? 'A alteração foi registrada, mas a versão atual não pôde ser consultada. Consulte o rascunho salvo antes de continuar.' : known ? errorText(e) : 'O resultado desta tentativa permanece incerto. Os campos foram preservados; repita a mesma confirmação para conferir o resultado.');
        if (known) command.current = null;
      }
    } finally { if (!pending.signal.aborted) { request.current = null; setBusy(false); } }
  };
  const run = (path: string, method: 'POST' | 'PATCH', body: Record<string, unknown>) => {
    if (request.current || command.current || uncertain.current || busy || retry || conflict) return;
    command.current = { path, method, body: { ...structuredClone(body), command_id: crypto.randomUUID() } }; saved.current = null; void execute();
  };
  const canReset = () => !request.current && !command.current && !saved.current && !uncertain.current;
  return { busy, error, retry, conflict, locked: busy || retry || conflict, run, repeat: () => void execute(), setError,
    canReset, clear: () => { if (!canReset()) return false; setConflict(false); setRetry(false); setError(''); return true; },
    retryLabel: saved.current ? 'Consultar rascunho salvo' : 'Repetir a mesma confirmação' };
}
type Task = ReturnType<typeof useFiscalMutation>;
function TaskMessage({ task }: { task: Task }) {
  return <>{task.error && <p className="real-alert" role="alert">{task.error}</p>}{task.retry && <button type="button" className="primary-button" disabled={task.busy} onClick={task.repeat}>{task.retryLabel}</button>}</>;
}
function PreparationFields({ prefix, nature, notes, disabled, onNature, onNotes }: { prefix: string; nature: string; notes: string; disabled: boolean; onNature: (s: string) => void; onNotes: (s: string) => void }) {
  return <fieldset className="fiscal-preparation-fields" disabled={disabled}><legend>Dados de preparação</legend>
    <div className="form-field"><label htmlFor={`${prefix}-nature`}>Natureza da operação</label><input id={`${prefix}-nature`} maxLength={60} value={nature} onChange={e => onNature(e.target.value)} placeholder="Informe após a conferência fiscal" autoComplete="off" /><small>Texto de preparação; os tributos e CFOPs ainda precisam de revisão.</small></div>
    <div className="form-field"><label htmlFor={`${prefix}-notes`}>Observações de preparação</label><textarea id={`${prefix}-notes`} rows={3} maxLength={4000} value={notes} onChange={e => onNotes(e.target.value)} /><small>{notes.length.toLocaleString('pt-BR')} / 4.000 caracteres</small></div>
  </fieldset>;
}
function OrderPicker({ controller, selected, disabled, onSelect }: { controller: FiscalDraftController; selected: DocumentSummary | null; disabled: boolean; onSelect: (s: DocumentSummary) => void }) {
  const uid = useId(), [query, setQuery] = useState(''), [search, setSearch] = useState(''), [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [page, setPage] = useState<DocumentPage | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [reload, setReload] = useState(0);
  const cursor = cursors.at(-1) ?? null;
  useEffect(() => {
    const request = new AbortController(); setLoading(true); setError(''); setPage(null);
    void (async () => {
      const params = documentListParams('sales_orders', { ...EMPTY_DOCUMENT_FILTERS, query: search }, cursor);
      params.set('origin', 'brufap');
      const value = await controller.documents(`/v1/documentos/sales_orders?${params}`, { signal: request.signal }) as DocumentPage;
      if (value.kind !== 'sales_orders' || value.data_mode !== 'erp_native' || !Array.isArray(value.items) || value.items.length > 25) throw new Error('Não foi possível conferir a lista de pedidos.');
      if (!request.signal.aborted) setPage({ ...value, items: value.items.filter(item => !isDocumentMirror(item)) });
    })().catch(e => { if (!request.signal.aborted) setError(errorText(e)); }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [controller, cursor, search, reload]);
  return <section className="fiscal-order-picker" aria-label="Selecionar pedido de venda"><h3>Pedido de venda de origem</h3>
    <p className="real-help">Selecione um pedido salvo. Seus itens, destinatário e valores serão preservados em uma cópia; somente a criação confirmada grava o rascunho.</p>
    <form className="fiscal-order-search" onSubmit={e => { e.preventDefault(); setSearch(query.trim()); setCursors([null]); }}><div className="form-field"><label htmlFor={`${uid}-search`}>Pesquisar pedido ou cliente</label><input id={`${uid}-search`} type="search" maxLength={120} value={query} disabled={disabled} onChange={e => setQuery(e.target.value)} /></div><button className="secondary-button" disabled={disabled || loading}>Pesquisar</button></form>
    {selected && <p className="real-notice">Selecionado: pedido nº <strong>{selected.number}</strong> · {selected.contact_name} · versão {selected.version} · {selected.total === null ? 'Não informado' : fiscalDecimal(selected.total, true)}</p>}
    {error && <p role="alert" className="real-alert">{error} <button type="button" className="text-button" disabled={disabled} onClick={() => setReload(v => v + 1)}>Tentar novamente</button></p>}
    {loading && <p role="status">Consultando pedidos…</p>}
    {page && <><div className="table-scroll"><table className="data-table"><caption>Pedidos salvos; cancelados indisponíveis para preparação fiscal</caption><thead><tr><th>Pedido</th><th>Cliente</th><th>Data</th><th>Situação</th><th className="numeric">Total</th><th>Selecionar</th></tr></thead><tbody>{page.items.map(order => <tr key={order.id} className={order.id === selected?.id ? 'fiscal-selected-row' : ''}>
      <th scope="row">{order.number}<small>Versão {order.version}</small></th><td>{order.contact_name}</td><td>{order.date === null ? 'Não informada' : fiscalDate(order.date)}</td><td>{STATES.sales_orders[order.status] || 'Não reconhecida'}</td><td className="numeric">{order.total === null ? 'Não informado' : fiscalDecimal(order.total, true)}</td><td><button type="button" className="text-button" disabled={disabled || order.status === 'cancelled'} aria-pressed={order.id === selected?.id} onClick={() => onSelect(order)}>{order.id === selected?.id ? 'Selecionado' : order.status === 'cancelled' ? 'Cancelado' : `Selecionar ${order.number}`}</button></td>
    </tr>)}</tbody></table></div>{!page.items.length && <p className="empty-state">Nenhum pedido encontrado.</p>}
      <div className="table-footer"><span>Página {cursors.length}</span><div className="button-group"><button type="button" className="secondary-button" disabled={disabled || loading || cursors.length === 1} onClick={() => setCursors(v => v.slice(0, -1))}>Anterior</button><button type="button" className="secondary-button" disabled={disabled || loading || !page.has_more} onClick={() => setCursors(v => [...v, page.next_cursor])}>Próxima</button></div></div></>}
  </section>;
}
/** The pedido of "?pedido=<id>" (the old "Gerar nota fiscal" links) as the picker summary; null when it cannot be prepared. */
async function preselectedOrder(controller: FiscalDraftController, id: string, signal: AbortSignal): Promise<DocumentSummary | null> {
  const value = await controller.documents(`/v1/documentos/sales_orders/${id}`, { signal }) as { document?: Record<string, unknown> } | null;
  if (value?.document?.origin === 'origin' || value?.document?.authority === 'origin') return null;
  const d = value?.document as { id?: unknown; kind?: unknown; number?: unknown; version?: unknown; status?: unknown; date?: unknown; totals?: { total?: unknown }; contact_id?: unknown; contact_snapshot?: { name?: unknown }; created_at?: unknown; updated_at?: unknown } | undefined;
  if (!d || d.id !== id || d.kind !== 'sales_orders' || typeof d.number !== 'string' || typeof d.version !== 'number' || typeof d.status !== 'string' || typeof d.date !== 'string'
    || typeof d.totals?.total !== 'string' || typeof d.contact_id !== 'string' || typeof d.contact_snapshot?.name !== 'string') return null;
  return { id, kind: 'sales_orders', number: d.number, version: d.version, status: d.status, date: d.date, total: d.totals.total, contact_id: d.contact_id, contact_name: d.contact_snapshot.name,
    created_at: String(d.created_at ?? ''), updated_at: String(d.updated_at ?? '') };
}
function CreateDraft({ controller, initialModel, initialOrderId = null, onSaved, onClose }: { controller: FiscalDraftController; initialModel?: FiscalModel; initialOrderId?: string | null; onSaved: (id: string) => void; onClose: () => void }) {
  const uid = useId(), [order, setOrder] = useState<DocumentSummary | null>(null), [model, setModel] = useState<FiscalModel | ''>(initialModel ?? '');
  const [nature, setNature] = useState(''), [notes, setNotes] = useState(''), [confirmed, setConfirmed] = useState(false), [preselection, setPreselection] = useState(initialOrderId ? 'Consultando o pedido indicado…' : '');
  const preselected = useRef<string | null>(null);
  const task = useFiscalMutation(controller, value => onSaved(value.record.id));
  // A pedido preselected by the link is not a change of the user: leaving without touching anything does not ask.
  const dirty = Boolean((order && order.id !== preselected.current) || nature || notes || confirmed || model !== (initialModel ?? '')), guard = useUnsavedChanges(dirty, task.busy || task.retry);
  useEffect(() => {
    if (!initialOrderId) return;
    const request = new AbortController();
    void preselectedOrder(controller, initialOrderId, request.signal).then(value => {
      if (request.signal.aborted) return;
      if (!value) { setPreselection('O pedido indicado não pôde ser conferido. Selecione-o na lista abaixo.'); return; }
      if (value.status === 'cancelled') { setPreselection(`Pedido nº ${value.number} cancelado: não pode gerar rascunho fiscal.`); return; }
      preselected.current = value.id; setOrder(current => current ?? value); setPreselection('');
    }).catch(() => { if (!request.signal.aborted) setPreselection('O pedido indicado não pôde ser consultado. Selecione-o na lista abaixo.'); });
    return () => request.abort();
  }, [controller, initialOrderId]);
  const create = () => { try { task.run(BASE, 'POST', fiscalCreateInput(order, model, fiscalPreparation(nature, notes), confirmed)); } catch (e) { task.setError(errorText(e)); } };
  return <section className="real-editor fiscal-draft-editor"><header className="real-editor-heading"><div><h2>Novo rascunho de NF-e/NFC-e</h2><p>Cópia versionada de um pedido de venda. Ambiente de homologação.</p></div><button type="button" className="secondary-button" disabled={task.busy || task.retry} onClick={() => { if (task.canReset()) guard.confirmLeave(() => { if (task.canReset()) onClose(); }); }}>Voltar à listagem</button></header>
    <TaskMessage task={task} />
    <fieldset className="fiscal-model-choice" disabled={task.locked}><legend>Modelo do rascunho *</legend>{(['55', '65'] as const).map(value => <label key={value}><input type="radio" name={`${uid}-model`} value={value} checked={model === value} onChange={() => { setModel(value); setConfirmed(false); }} />{FISCAL_MODEL_LABELS[value]}</label>)}</fieldset>
    {preselection && <p className="real-notice" role="status">{preselection}</p>}
    <OrderPicker controller={controller} selected={order} disabled={task.locked} onSelect={value => { setOrder(value); setConfirmed(false); }} />
    <PreparationFields prefix={uid} nature={nature} notes={notes} disabled={task.locked} onNature={setNature} onNotes={setNotes} />
    <p className="real-help">Um pedido pode ter apenas um rascunho em preparação, independentemente do modelo. O rascunho não movimenta estoque nem financeiro.</p>
    <label className="fiscal-check"><input type="checkbox" checked={confirmed} disabled={task.locked || !order || !model} onChange={e => setConfirmed(e.target.checked)} />Conferi o pedido{order ? ` nº ${order.number}, versão ${order.version},` : ''} e o modelo{model ? ` ${model}` : ''} para preparar esta cópia sem numeração ou emissão.</label>
    <div className="real-editor-actions"><button type="button" className="primary-button" disabled={task.locked || !confirmed || !order || !model} onClick={create}>{task.busy ? 'Confirmando…' : 'Criar rascunho confirmado'}</button></div>
  </section>;
}

function SnapshotReview({ value }: { value: FiscalDraftEnvelope }) {
  const s = value.record.snapshot, company = s.company, contact = s.contact;
  return <div className="fiscal-snapshot-review"><section className="fiscal-review-section"><h3>Pedido e destinatário preservados</h3><dl className="fiscal-detail-grid">
    <div><dt>Pedido de venda</dt><dd>Nº {s.number} · versão {s.document_version}</dd></div><div><dt>Data do pedido</dt><dd>{fiscalDate(s.date)}</dd></div><div><dt>Situação na cópia</dt><dd>{STATES.sales_orders[s.status]}</dd></div>
    <div><dt>Destinatário</dt><dd>{contact.name}</dd></div><div><dt>Documento / inscrição estadual</dt><dd>{plain(contact.document)} / {plain(contact.ie)}</dd></div><div><dt>Cadastro preservado</dt><dd>Versão {contact.version}</dd></div>
    <div className="fiscal-wide"><dt>Endereço</dt><dd>{[contact.street, contact.number, contact.complement, contact.district, contact.city, contact.state, contact.postal_code].filter(Boolean).join(' · ') || 'Não informado'}</dd></div>
  </dl><p className="real-help">Os dados de cliente e produto pertencem à versão salva do pedido. Esta conferência não atesta a situação cadastral nem determina os tributos.</p></section>
    <section className="fiscal-review-section"><h3>Itens do pedido</h3><div className="table-scroll" tabIndex={0} aria-label="Itens preservados no rascunho"><table className="data-table"><thead><tr><th>Item / produto</th><th>Un.</th><th className="numeric">Quantidade</th><th className="numeric">Preço unitário</th><th className="numeric">Desconto</th><th className="numeric">Total</th><th>NCM / GTIN</th></tr></thead><tbody>{s.items.map(item => <tr key={item.id}><td><strong>{item.position}. {item.description}</strong><small>{item.product ? `${item.code || 'Sem código'} · cadastro v${item.product.version}` : 'Item sem produto vinculado'}</small></td><td>{item.unit}</td><td className="numeric">{fiscalDecimal(item.quantity)}</td><td className="numeric">{fiscalUnitPrice(item.unit_price)}</td><td className="numeric">{fiscalDecimal(item.discount, true)}</td><td className="numeric">{fiscalDecimal(item.total, true)}</td><td>{plain(item.product?.ncm)}<small>{plain(item.product?.gtin)}</small></td></tr>)}</tbody></table></div>
      <dl className="fiscal-totals"><div><dt>Produtos (bruto)</dt><dd>{fiscalDecimal(s.totals.gross, true)}</dd></div><div><dt>Desconto nos itens</dt><dd>{fiscalDecimal(s.totals.line_discount, true)}</dd></div><div><dt>Desconto do pedido</dt><dd>{fiscalDecimal(s.totals.discount, true)}</dd></div><div><dt>Frete</dt><dd>{fiscalDecimal(s.totals.freight, true)}</dd></div><div><dt>Outras despesas</dt><dd>{fiscalDecimal(s.totals.other_expenses, true)}</dd></div>
        {s.totals.ipi !== undefined && <><div><dt>Total do IPI</dt><dd>{fiscalDecimal(s.totals.ipi, true)}</dd></div><div><dt>Total ICMS ST</dt><dd>{fiscalDecimal(s.totals.icms_st ?? '0.00', true)}</dd></div></>}
        {s.legacy_taxes !== undefined && <div><dt>IPI e ICMS ST (cópia anterior, sem separação)</dt><dd>{fiscalDecimal(s.legacy_taxes, true)}</dd></div>}
        <div><dt>Total comercial</dt><dd><strong>{fiscalDecimal(s.totals.total, true)}</strong></dd></div></dl><p className="real-help">Valores comerciais do pedido, ainda sem apuração ou totalização fiscal.</p>
    </section>
    <section className="fiscal-review-section"><h3>Empresa preservada nesta revisão</h3>{company ? <dl className="fiscal-detail-grid"><div><dt>Razão social</dt><dd>{company.identity.legal_name}</dd></div><div><dt>CNPJ / inscrição estadual</dt><dd>{company.identity.cnpj} / {plain(company.identity.ie)}</dd></div><div><dt>Regime informado</dt><dd>{company.regime_confirmed && company.crt ? CRT_LABELS[company.crt] || `CRT ${company.crt}` : 'A confirmar'}</dd></div><div className="fiscal-wide"><dt>Endereço</dt><dd>{[company.identity.street, company.identity.number, company.identity.complement, company.identity.district, company.identity.city, company.identity.state, company.identity.postal_code].filter(Boolean).join(' · ')}</dd></div><div><dt>Versões preservadas</dt><dd>Identidade {company.identity_version} · Fiscal {company.fiscal_version ?? 'não configurada'}</dd></div></dl> : <p className="real-notice">A identidade da empresa não estava configurada na captura desta revisão.</p>}</section>
    <section className="fiscal-review-section"><h3>Parcelas e observações do pedido</h3>{s.installments.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Parcela</th><th>Vencimento</th><th>Forma informada</th><th className="numeric">Valor</th></tr></thead><tbody>{s.installments.map(row => <tr key={row.position}><td>{row.position}</td><td>{fiscalDate(row.due_date)}</td><td>{plain(row.method)}</td><td className="numeric">{fiscalDecimal(row.amount, true)}</td></tr>)}</tbody></table></div> : <p>Sem parcelas informadas no pedido.</p>}
      <dl className="fiscal-detail-grid"><div><dt>Condições de pagamento</dt><dd>{plain(s.payment_terms)}</dd></div><div><dt>Condições de entrega</dt><dd>{plain(s.delivery_terms)}</dd></div><div className="fiscal-wide"><dt>Observações comerciais</dt><dd className="fiscal-multiline">{plain(s.notes)}</dd></div></dl>
    </section></div>;
}
function RevisionHistory({ controller, id, selectedVersion, tick, disabled, onSelect }: { controller: FiscalDraftController; id: string; selectedVersion: number; tick: number; disabled: boolean; onSelect: (version: number) => void }) {
  const [page, setPage] = useState<FiscalRevisionPage | null>(null), [cursors, setCursors] = useState<(number | null)[]>([null]), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const cursor = cursors.at(-1) ?? null;
  useEffect(() => {
    const request = new AbortController(); setLoading(true); setError(''); setPage(null);
    const params = new URLSearchParams({ limit: '25' }); if (cursor) params.set('after', String(cursor));
    void controller.fiscalDraft(`${BASE}/${id}/revisions?${params}`, { signal: request.signal }).then(value => { if (!request.signal.aborted) setPage(fiscalRevisionPage(value, id)); }).catch(e => { if (!request.signal.aborted) setError(errorText(e)); }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [controller, id, cursor, tick]);
  return <section className="fiscal-review-section"><h3>Histórico de revisões</h3><p className="real-help">Revisões anteriores permanecem disponíveis para consulta, em ordem de criação.</p>{error && <p role="alert" className="real-alert">{error}</p>}{loading && <p role="status">Consultando revisões…</p>}
    {page && <><div className="table-scroll"><table className="data-table"><thead><tr><th>Revisão</th><th>Registrada em (São Paulo)</th><th>Versão do pedido</th><th>Situação</th><th>Consultar</th></tr></thead><tbody>{page.items.map(row => <tr key={row.version}><th scope="row">{row.version}</th><td>{fiscalMoment(row.updated_at)}</td><td>{row.source_document_version}</td><td>{FISCAL_STATUS_LABELS[row.status]}</td><td><button type="button" className="text-button" disabled={disabled || row.version === selectedVersion} onClick={() => onSelect(row.version)}>{row.version === selectedVersion ? 'Exibida' : `Abrir revisão ${row.version}`}</button></td></tr>)}</tbody></table></div><div className="table-footer"><span>Página {cursors.length}</span><div className="button-group"><button type="button" className="secondary-button" disabled={disabled || loading || cursors.length === 1} onClick={() => setCursors(v => v.slice(0, -1))}>Anterior</button><button type="button" className="secondary-button" disabled={disabled || loading || !page.has_more} onClick={() => setCursors(v => [...v, page.next_cursor])}>Próxima</button></div></div></>}
  </section>;
}
function DraftEditor({ controller, id, onClose }: { controller: FiscalDraftController; id: string; onClose: () => void }) {
  const uid = useId(), [value, setValue] = useState<FiscalDraftEnvelope | null>(null), [revision, setRevision] = useState<number | null>(null), [reload, setReload] = useState(0), [historyTick, setHistoryTick] = useState(0);
  const [nature, setNature] = useState(''), [notes, setNotes] = useState(''), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [panel, setPanel] = useState<'refresh' | 'archive' | null>(null), [confirmed, setConfirmed] = useState(false), [reason, setReason] = useState('');
  const [itemBusy,setItemBusy]=useState(false),[itemDirty,setItemDirty]=useState(false),itemState=useRef({busy:false,dirty:false});
  const [taxBusy,setTaxBusy]=useState(false),[taxDirty,setTaxDirty]=useState(false),[itemTick,setItemTick]=useState(0),taxState=useRef({busy:false,dirty:false});
  const [completionBusy,setCompletionBusy]=useState(false),[completionDirty,setCompletionDirty]=useState(false),[completionTick,setCompletionTick]=useState(0),completionState=useRef({busy:false,dirty:false});
  const [unsignedBusy,setUnsignedBusy]=useState(false),[unsignedDirty,setUnsignedDirty]=useState(false),[unsignedTick,setUnsignedTick]=useState(0),unsignedState=useRef({busy:false,dirty:false});
  const unsignedCallbacks=useMemo(()=>({busy:(busy:boolean)=>{unsignedState.current.busy=busy;setUnsignedBusy(busy);},dirty:(dirty:boolean)=>{unsignedState.current.dirty=dirty;setUnsignedDirty(dirty);},changed:()=>setUnsignedTick(v=>v+1)}),[]);
  const completionCallbacks=useMemo(()=>({busy:(busy:boolean)=>{completionState.current.busy=busy;setCompletionBusy(busy);},dirty:(dirty:boolean)=>{completionState.current.dirty=dirty;setCompletionDirty(dirty);},changed:()=>{setCompletionTick(v=>v+1);setUnsignedTick(v=>v+1);}}),[]);
  const taxCallbacks=useMemo(()=>({busy:(busy:boolean)=>{taxState.current.busy=busy;setTaxBusy(busy);},dirty:(dirty:boolean)=>{taxState.current.dirty=dirty;setTaxDirty(dirty);},itemChanged:()=>{setItemTick(v=>v+1);setCompletionTick(v=>v+1);setUnsignedTick(v=>v+1);}}),[]);
  const itemCallbacks=useMemo(()=>({busy:(busy:boolean)=>{itemState.current.busy=busy;setItemBusy(busy);},dirty:(dirty:boolean)=>{itemState.current.dirty=dirty;setItemDirty(dirty);}}),[]);
  const accept = (next: FiscalDraftEnvelope) => { setValue(next); setNature(next.record.preparation.operation_nature || ''); setNotes(next.record.preparation.notes || ''); setPanel(null); setConfirmed(false); setReason(''); };
  const task = useFiscalMutation(controller, next => { accept(next); setRevision(null); setHistoryTick(v => v + 1); setNotice('Rascunho salvo. A versão atual está exibida abaixo.'); });
  const preparationDirty = Boolean(value && (nature !== (value.record.preparation.operation_nature || '') || notes !== (value.record.preparation.notes || '')));
  const dirty = preparationDirty || Boolean(reason || confirmed) || itemDirty || taxDirty || completionDirty || unsignedDirty, guard = useUnsavedChanges(dirty, task.busy || task.retry || itemBusy || taxBusy || completionBusy || unsignedBusy);
  useEffect(() => {
    const request = new AbortController(); setLoading(true); setError(''); setValue(null);
    void controller.fiscalDraft(`${BASE}/${id}${revision ? `/revisions/${revision}` : ''}`, { signal: request.signal }).then(response => {
      if (request.signal.aborted) return;
      const next = fiscalDraftEnvelope(response, id, revision ?? undefined);
      if (!revision && next.record.version !== next.current.version) throw new Error('Atualize para conferir a versão atual do rascunho.');
      accept(next);
    }).catch(e => { if (!request.signal.aborted) setError(errorText(e)); }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [controller, id, revision, reload]);
  const reset = (action: () => void) => { if (task.canReset()&&!itemState.current.busy&&!taxState.current.busy&&!completionState.current.busy&&!unsignedState.current.busy) guard.confirmLeave(() => { if (task.canReset()&&!itemState.current.busy&&!taxState.current.busy&&!completionState.current.busy&&!unsignedState.current.busy) action(); }); };
  const show = (selected: number | null) => { if((itemState.current.dirty||taxState.current.dirty||completionState.current.dirty||unsignedState.current.dirty))return;reset(() => { if ((itemState.current.dirty||taxState.current.dirty||completionState.current.dirty||unsignedState.current.dirty)||!task.clear()) return; setNotice(''); setPanel(null); setConfirmed(false); setReason(''); setRevision(selected); setReload(v => v + 1); }); };
  const historical = Boolean(value && value.record.version !== value.current.version), editable = Boolean(value && !historical && value.current.status === 'draft');
  const save = (event: FormEvent) => { event.preventDefault(); if (!value||(itemState.current.busy||taxState.current.busy||completionState.current.busy||unsignedState.current.busy)||(itemState.current.dirty||taxState.current.dirty||completionState.current.dirty||unsignedState.current.dirty)) return; try { task.run(`${BASE}/${id}`, 'PATCH', fiscalUpdateInput(value, fiscalPreparation(nature, notes))); } catch (e) { task.setError(errorText(e)); } };
  const confirm = () => { if (!value || !panel||(itemState.current.busy||taxState.current.busy||completionState.current.busy||unsignedState.current.busy)||(itemState.current.dirty||taxState.current.dirty||completionState.current.dirty||unsignedState.current.dirty)) return; try { const body = panel === 'refresh' ? fiscalRefreshInput(value, confirmed) : fiscalArchiveInput(value, reason, confirmed); task.run(`${BASE}/${id}/${panel}`, 'POST', body); } catch (e) { task.setError(errorText(e)); } };
  return <section className="real-editor fiscal-draft-editor" aria-busy={loading || task.busy}><header className="real-editor-heading"><div><h2>{value ? `${FISCAL_MODEL_LABELS[value.record.model]} · pedido nº ${value.record.snapshot.number}` : 'Consultar rascunho fiscal'}</h2>{value && <p>Revisão {value.record.version} · {FISCAL_STATUS_LABELS[value.record.status]} · Preparação em homologação</p>}</div><button type="button" className="secondary-button" disabled={task.busy || task.retry || itemBusy || taxBusy || completionBusy || unsignedBusy} onClick={() => reset(onClose)}>Voltar à listagem</button></header>
    {loading && <p role="status">Consultando rascunho…</p>}{error && <p className="real-alert" role="alert">{error}</p>}<TaskMessage task={task} />{notice && <p className="real-success" role="status">{notice}</p>}
    <div className="fiscal-editor-toolbar"><button type="button" className="secondary-button" disabled={loading || task.busy || task.retry || itemBusy || taxBusy || completionBusy || unsignedBusy || itemDirty || taxDirty || completionDirty || unsignedDirty} onClick={() => show(null)}>{historical ? 'Voltar à versão atual' : 'Recarregar versão atual'}</button>{value && <span className="real-help">Atualizado em {fiscalMoment(value.record.updated_at)} · São Paulo</span>}</div>
    {value && !loading && <>{historical && <p className="real-notice"><strong>Consulta histórica da revisão {value.record.version}.</strong> A versão atual é {value.current.version}, {FISCAL_STATUS_LABELS[value.current.status].toLowerCase()}. As pendências abaixo também comparam esta cópia com a situação atual do pedido e da empresa.</p>}
      {(value.current.source_changed || value.current.company_changed) && <p className="real-notice">Esta cópia difere dos dados atuais: {value.current.source_changed ? `pedido na versão ${value.current.source_document_version}` : ''}{value.current.source_changed && value.current.company_changed ? ' e ' : ''}{value.current.company_changed ? 'configuração da empresa alterada' : ''}. Conferir ou atualizar o rascunho não altera o pedido.</p>}
      {value.record.status === 'archived' && <p className="real-notice"><strong>Arquivado em {fiscalMoment(value.record.archived_at!)}.</strong> Motivo: {value.record.archive_reason}. O histórico é preservado; um novo rascunho pode ser criado para o pedido.</p>}
      {(itemDirty||taxDirty||completionDirty||unsignedDirty)&&<p className="real-help">Salve ou descarte as escolhas fiscais antes de alterar os dados gerais ou atualizar a cópia.</p>}
      <form onSubmit={save}><PreparationFields prefix={uid} nature={nature} notes={notes} disabled={!editable || task.locked || Boolean(panel) || itemBusy || taxBusy || completionBusy || unsignedBusy || itemDirty || taxDirty || completionDirty || unsignedDirty} onNature={setNature} onNotes={setNotes} />{editable && <div className="real-editor-actions"><button className="primary-button" disabled={task.locked || !preparationDirty || Boolean(panel) || itemBusy || taxBusy || completionBusy || unsignedBusy || itemDirty || taxDirty || completionDirty || unsignedDirty}>{task.busy ? 'Confirmando…' : 'Salvar preparação'}</button><button type="button" className="secondary-button" disabled={task.locked || !preparationDirty || itemBusy || taxBusy || completionBusy || unsignedBusy || itemDirty || taxDirty || completionDirty || unsignedDirty} onClick={() => reset(() => accept(value))}>Descartar alterações</button></div>}</form>
      {editable && <section className="fiscal-revision-actions"><h3>Revisão da origem</h3><p className="real-help">Atualizar copia novamente o pedido salvo e a configuração da empresa, preservando as revisões anteriores. O modelo {value.record.model} e as observações de preparação permanecem.</p>{preparationDirty && <p className="real-help">Salve ou descarte as alterações de preparação antes de atualizar a cópia ou arquivar.</p>}
        {!panel ? <div className="button-group"><button type="button" className="secondary-button" disabled={task.locked || preparationDirty || itemBusy || taxBusy || completionBusy || unsignedBusy || itemDirty || taxDirty || completionDirty || unsignedDirty || value.current.source_status === 'cancelled'} onClick={() => { if((itemState.current.busy||taxState.current.busy||completionState.current.busy||unsignedState.current.busy)||(itemState.current.dirty||taxState.current.dirty||completionState.current.dirty||unsignedState.current.dirty))return;setPanel('refresh'); setConfirmed(false); }}>Conferir atualização da cópia</button><button type="button" className="secondary-button" disabled={task.locked || preparationDirty || itemBusy || taxBusy || completionBusy || unsignedBusy || itemDirty || taxDirty || completionDirty || unsignedDirty} onClick={() => { if((itemState.current.busy||taxState.current.busy||completionState.current.busy||unsignedState.current.busy)||(itemState.current.dirty||taxState.current.dirty||completionState.current.dirty||unsignedState.current.dirty))return;setPanel('archive'); setConfirmed(false); }}>Arquivar rascunho</button></div> : <div className="fiscal-confirm-panel"><h4>{panel === 'refresh' ? 'Atualizar a cópia do pedido e da empresa' : 'Arquivar definitivamente este rascunho'}</h4>
          <p>{panel === 'refresh' ? `A revisão ${value.record.version} usa o pedido na versão ${value.record.source_document_version}. A atualização usará a versão ${value.current.source_document_version} consultada agora. Se ela mudar, será necessária nova conferência.` : `O rascunho ${FISCAL_MODEL_LABELS[value.record.model]} do pedido nº ${value.record.snapshot.number} ficará somente para consulta. Não existe ação de desarquivar.`}</p>
          {panel === 'archive' && <div className="form-field"><label htmlFor={`${uid}-reason`}>Motivo do arquivamento *</label><input id={`${uid}-reason`} minLength={3} maxLength={1000} value={reason} disabled={task.locked} onChange={e => setReason(e.target.value)} /></div>}
          <label className="fiscal-check"><input type="checkbox" checked={confirmed} disabled={task.locked} onChange={e => setConfirmed(e.target.checked)} />{panel === 'refresh' ? 'Conferi a origem e autorizo criar uma nova revisão desta cópia.' : 'Confirmo o arquivamento definitivo, com preservação do histórico.'}</label><div className="button-group"><button type="button" className="primary-button" disabled={task.locked || !confirmed || (panel === 'archive' && reason.trim().length < 3)} onClick={confirm}>{panel === 'refresh' ? 'Atualizar cópia confirmada' : 'Confirmar arquivamento'}</button><button type="button" className="secondary-button" disabled={task.busy || task.retry} onClick={() => reset(() => { setPanel(null); setReason(''); setConfirmed(false); })}>Voltar sem confirmar</button></div>
        </div>}
      </section>}
      <section className="fiscal-pending" aria-labelledby={`${uid}-pending`}><h3 id={`${uid}-pending`}>Conferências da cópia do pedido</h3><p>Esta lista descreve a revisão comercial preservada, não o resultado das etapas fiscais posteriores. Salvar o rascunho não habilita a emissão.</p><ul>{fiscalCopyPending(value.pending).map(code => <li key={code}>{FISCAL_PENDING_LABELS[code]}</li>)}</ul><p>Continue nos painéis de itens, tributos e complemento. Para saber se há número reservado, XML validado, assinatura ou tentativa de envio, consulte os resultados desses painéis; a cópia do pedido não confirma nem descarta esses registros.</p></section>
      <SnapshotReview value={value} />{controller.fiscalItem&&<FiscalItemPreparation key={`items:${id}:${value.record.version}:${value.record.snapshot_hash}`} controller={controller as FiscalItemController} value={value} blocked={preparationDirty||Boolean(panel)||task.locked||taxBusy||taxDirty||completionBusy||unsignedBusy||completionDirty||unsignedDirty} onBusy={itemCallbacks.busy} onDraft={itemCallbacks.dirty} onChanged={taxCallbacks.itemChanged}/>}
      {controller.fiscalTax&&controller.fiscalItem&&<FiscalTaxPreparation key={`tax:${id}:${value.record.version}:${value.record.snapshot_hash}`} controller={controller as FiscalTaxController} value={value} refreshKey={itemTick} blocked={preparationDirty||Boolean(panel)||task.locked||itemBusy||itemDirty||completionBusy||unsignedBusy||completionDirty||unsignedDirty} onBusy={taxCallbacks.busy} onDraft={taxCallbacks.dirty} onChanged={completionCallbacks.changed}/>}
      {controller.fiscalCompletion&&controller.fiscalTax&&controller.fiscalItem&&<FiscalBusinessCompletion key={`completion:${id}:${value.record.version}:${value.record.snapshot_hash}`} controller={controller as FiscalCompletionController} value={value} refreshKey={completionTick} blocked={preparationDirty||Boolean(panel)||task.locked||itemBusy||itemDirty||taxBusy||taxDirty||unsignedBusy||unsignedDirty} onBusy={completionCallbacks.busy} onDraft={completionCallbacks.dirty} onChanged={unsignedCallbacks.changed}/>}
      {controller.getSnapshot&&controller.fiscalUnsigned&&controller.fiscalNumbering&&controller.fiscalCompletion&&<FiscalUnsignedPreview key={`unsigned:${id}:${value.record.version}:${value.record.snapshot_hash}`} controller={controller as FiscalUnsignedController} value={value} refreshKey={unsignedTick} blocked={preparationDirty||Boolean(panel)||task.locked||itemBusy||itemDirty||taxBusy||taxDirty||completionBusy||completionDirty} onBusy={unsignedCallbacks.busy} onDraft={unsignedCallbacks.dirty}/>}<FiscalDraftReview key={`${id}:${value.record.version}`} controller={controller} draftId={id} revision={value.record.version} snapshotHash={value.record.snapshot_hash}/><RevisionHistory controller={controller} id={id} selectedVersion={value.record.version} tick={historyTick} disabled={task.busy || task.retry || itemBusy || taxBusy || completionBusy || unsignedBusy || itemDirty || taxDirty || completionDirty || unsignedDirty} onSelect={selected => show(selected)} />
    </>}
  </section>;
}

export default function RealFiscalDrafts({ controller, initialModel }: { controller: FiscalDraftController; initialModel?: FiscalModel }) {
  const location = useLocation(), navigate = useNavigate();
  const summaryController=typeof controller.fiscalDraftStatus==='function'&&typeof controller.getSnapshot==='function'&&typeof controller.subscribe==='function'?controller as FiscalDraftController&FiscalDraftStatusController:null;
  const summaryActor=useRef(summaryController?.getSnapshot().membership?.user_id??null);
  const uid = useId(), [filters, setFilters] = useState<FiscalFilters>({ model: initialModel ?? '', status: '' }), [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [page, setPage] = useState<FiscalDraftPage | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [reload, setReload] = useState(0);
  // "?pedido=<id>" (links from the pedidos list before the note form existed) opens the creation with that pedido preselected.
  const linkedOrder = useMemo(() => { const value = new URLSearchParams(location.search).get('pedido'); return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null; }, []);
  const [editor, setEditor] = useState<string | null>(null), [creating, setCreating] = useState(Boolean(linkedOrder)), cursor = cursors.at(-1) ?? null;
  useEffect(() => {
    if (editor || creating || summaryController) return;
    const request = new AbortController(); setLoading(true); setError(''); setPage(null);
    void controller.fiscalDraft(`${BASE}?${fiscalListParams(filters, cursor)}`, { signal: request.signal }).then(value => { if (!request.signal.aborted) setPage(fiscalDraftPage(value, filters)); }).catch(e => { if (!request.signal.aborted) setError(errorText(e)); }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [controller, filters, cursor, reload, editor, creating, summaryController]);
  const mayOpenSummary=()=>{const s=summaryController?.getSnapshot();return Boolean(s&&fiscalDraftStatusCanRead(s)&&s.membership?.user_id===summaryActor.current&&!editor&&!creating);};
  const close = () => { setEditor(null); setCreating(false); setReload(v => v + 1); };
  const changeModel = (model: FiscalFilters['model'], clear = false) => {
    setFilters(v => ({ model, status: clear ? '' : v.status })); setCursors([null]);
    if (location.pathname === '/emissor-fiscal') navigate({ pathname: location.pathname, search: fiscalModelSearch(location.search, model), hash: location.hash });
  };
  return <div className="fiscal-drafts-page"><header className="real-heading"><div><h1>Rascunhos de NF-e/NFC-e</h1><p>Preparação e revisão de documentos fiscais de produtos a partir dos pedidos de venda.</p></div><span className="real-mode">Homologação · sem valor fiscal</span></header><p className="real-notice">O rascunho preserva uma cópia do pedido. A reserva de número, a geração do XML e a assinatura têm confirmações separadas. A disponibilidade do envio de teste é conferida na etapa de autorização.</p>
    {!creating&&!editor&&hasFiscalPreparationPorts(controller)&&<FiscalPreparationGuide controller={controller} model={filters.model}/>}
    {creating ? <CreateDraft controller={controller} initialModel={filters.model || undefined} initialOrderId={linkedOrder} onSaved={id => { setCreating(false); setEditor(id); }} onClose={close} />
      : editor ? <DraftEditor key={editor} controller={controller} id={editor} onClose={close} />
        : summaryController ? <FiscalDraftStatus controller={summaryController} initialModel={initialModel} refreshKey={reload}
          onModelChange={model=>{if(mayOpenSummary())changeModel(model);}}
          onCreateDraft={model=>{if(mayOpenSummary()){setFilters(v=>({...v,model}));setCreating(true);}}}
          onOpenDraft={row=>{if(mayOpenSummary())setEditor(row.id);}}/>
        : <NativeListLayout filters={<><div className="form-field"><label htmlFor={`${uid}-model`}>Modelo</label><select id={`${uid}-model`} value={filters.model} onChange={e => changeModel(e.target.value as FiscalFilters['model'])}><option value="">NF-e e NFC-e</option>{(['55', '65'] as const).map(model => <option key={model} value={model}>{FISCAL_MODEL_LABELS[model]}</option>)}</select></div><div className="form-field"><label htmlFor={`${uid}-status`}>Situação</label><select id={`${uid}-status`} value={filters.status} onChange={e => { setFilters(v => ({ ...v, status: e.target.value as FiscalFilters['status'] })); setCursors([null]); }}><option value="">Todas</option><option value="draft">Em preparação</option><option value="archived">Arquivado</option></select></div><button type="button" className="text-button" onClick={() => changeModel('', true)}>Limpar filtros</button></>}
          actions={<><button type="button" className="primary-button" disabled={loading || Boolean(error)} onClick={() => setCreating(true)}>Incluir rascunho</button><button type="button" className="secondary-button" disabled={loading} onClick={() => setReload(v => v + 1)}>Atualizar listagem</button><p className="real-help">Use o histórico para rever as cópias anteriores. O arquivamento preserva as revisões.</p></>}>
          <section className="real-records"><div className="table-toolbar"><h2>Rascunhos fiscais</h2><span role="status">{loading ? 'Consultando…' : `${page?.items.length ?? 0} nesta página`}</span></div>{error && <p role="alert" className="real-alert">{error}</p>}
            {page && <><div className="table-scroll"><table className="data-table"><caption>Rascunhos fiscais</caption><thead><tr><th>Modelo / pedido</th><th>Destinatário</th><th>Situação</th><th>Revisão</th><th>Atualizado em</th><th className="numeric">Total comercial</th><th>Consultar</th></tr></thead><tbody>{page.items.map(row => <tr key={row.id}><th scope="row">{row.model === '55' ? 'NF-e' : 'NFC-e'}<small>Pedido {row.order_number}</small></th><td>{row.contact_name}</td><td><span className={`status-badge ${row.status === 'draft' ? 'status-warning' : 'status-neutral'}`}>{FISCAL_STATUS_LABELS[row.status]}</span></td><td>{row.version}<small>Pedido v{row.source_document_version}</small></td><td>{fiscalMoment(row.updated_at)}</td><td className="numeric">{fiscalDecimal(row.total, true)}</td><td><button type="button" className="text-button" onClick={() => setEditor(row.id)} aria-label={`Abrir ${row.model === '55' ? 'NF-e' : 'NFC-e'} do pedido ${row.order_number}`}>Abrir</button></td></tr>)}</tbody></table></div>{!page.items.length && <p className="empty-state">Nenhum rascunho encontrado. Use “Incluir rascunho” para selecionar um pedido salvo.</p>}
              <div className="table-footer"><span>Página {cursors.length} · até 25 registros · horários de São Paulo</span><div className="button-group"><button type="button" className="secondary-button" disabled={loading || cursors.length === 1} onClick={() => setCursors(v => v.slice(0, -1))}>Anterior</button><button type="button" className="secondary-button" disabled={loading || !page.has_more} onClick={() => setCursors(v => [...v, page.next_cursor])}>Próxima</button></div></div></>}
          </section>
        </NativeListLayout>}
  </div>;
}
