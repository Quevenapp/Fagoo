import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AccessError, type AccessController } from '../lib/real-access';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { natureRecord, natureSummary, normalizeNatureInput, normalizeRuleInput, type NatureRecord, type NatureRule, type NatureSummary, type Tax } from '../../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { FiscalSpecError, UFS, DEFAULT_CODES } from '../../../../packages/erp-domain/src/fiscal-invoice-dto.mjs';
import * as T from '../../../../packages/fiscal-core/src/tax-tables.mjs';
import { FISCAL_BASE } from '../lib/fiscal-invoice-list-model';
import type { CatalogPage, CatalogRecord } from '../lib/catalog-model';
import { taxonomyItems } from '../lib/product-form-model';
import { AppliedChips, OriginListHeader, OriginPagination, ListControls, RowMenu, ToolButton } from './OriginList';
import { BatchDialog } from './BatchDialog';
import { planBatch, type BatchItem, type BatchResult } from '../lib/origin-batch';
import { natureReviewText, type NatureReview } from '../lib/fiscal-invoice-list-model';
import { Modal } from './Modal';
import { Icon } from './Icon';
import FiscalTaxSettings from './FiscalTaxSettings';
import './fiscal-invoices.css';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const known = (error: unknown) => error instanceof AccessError && [400, 403, 404, 409].includes(error.status);
const actorOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.user_id ?? null;
const roleOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.role ?? '';
const failure = (error: unknown) => error instanceof AccessError ? error.status === 409 ? 'A natureza mudou em outra tela ou já está nesse estado. Recarregue e confira.'
  : error.status === 403 ? 'Seu perfil não altera naturezas de operação.' : error.status === 400 ? 'O servidor recusou os dados. Confira as regras e os campos.' : 'Não foi possível concluir a operação.' : 'Não foi possível concluir a operação.';
type Command = { id: string; actor: string | null; body: Record<string, unknown>; uncertain: boolean; verify: (value: unknown) => NatureRecord; done: (n: NatureRecord) => void };

/** Shared command loop of this screen: one command id, repeated as is with "Conferir resultado". */
function useNatureCommand(controller: AccessController) {
  const command = useRef<Command | null>(null), inflight = useRef<AbortController | null>(null), life = useRef(new AbortController());
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState('');
  useEffect(() => { const current = life.current; return () => { current.abort(); inflight.current?.abort(); }; }, []);
  const send = async () => {
    const op = command.current; if (!op || inflight.current) return;
    if (actorOf(controller) !== op.actor || !['admin', 'fiscal'].includes(roleOf(controller))) { command.current = null; setUncertain(false); setError('A sessão ou o perfil mudou. Recarregue antes de repetir.'); return; }
    const request = new AbortController(); inflight.current = request; setBusy(true); setError('');
    try {
      const value = await controller.fiscalInvoices(`${FISCAL_BASE}/naturezas`, { method: 'POST', body: { ...op.body, command_id: op.id }, signal: AbortSignal.any([request.signal, life.current.signal]) });
      if (request.signal.aborted) return;
      const nature = op.verify(value); command.current = null; setUncertain(false); op.done(nature);
    } catch (problem) {
      if (request.signal.aborted || aborted(problem)) return;
      if (!op.uncertain && known(problem)) { command.current = null; setError(failure(problem)); }
      else { op.uncertain = true; setUncertain(true); setError('Não foi possível confirmar o resultado. Use "Conferir resultado" para repetir a mesma operação sem duplicar.'); }
    } finally { if (inflight.current === request) inflight.current = null; if (!request.signal.aborted) setBusy(false); }
  };
  const start = (body: Record<string, unknown>, verify: Command['verify'], done: Command['done']) => { if (command.current || inflight.current) return; command.current = { id: crypto.randomUUID(), actor: actorOf(controller), body, uncertain: false, verify, done }; void send(); };
  return { busy, uncertain, error, setError, start, retry: () => void send() };
}
const resultNature = (value: unknown) => natureRecord((value as { nature: unknown })?.nature);
type NatureDeleteItem = BatchItem & { nature: NatureSummary };
const natureDeletePlan = (rows: NatureSummary[]) => planBatch<NatureDeleteItem>(rows.map(n => ({ id: n.id, label: n.description, nature: n })), () => null);

/** Preferências › Naturezas de operação: lista, formulário com regras por imposto e Configurações globais de impostos. */
export default function RealOperationNatures({ controller }: { controller: AccessController }) {
  const location = useLocation(), navigate = useNavigate();
  const params = new URLSearchParams(location.search), opened = params.get('natureza'), settingsView = params.get('tela') === 'impostos';
  const writable = ['admin', 'fiscal'].includes(roleOf(controller));
  const [active, setActive] = useState(true), [query, setQuery] = useState(''), [applied, setApplied] = useState(''), [page, setPage] = useState(1), [reload, setReload] = useState(0);
  const [items, setItems] = useState<NatureSummary[]>([]), [total, setTotal] = useState(0), [loading, setLoading] = useState(false), [error, setError] = useState(''), [menu, setMenu] = useState<string | null>(null), [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set()), [deleting, setDeleting] = useState<NatureSummary[] | null>(null), [review, setReview] = useState<NatureReview | null>(null);
  const cmd = useNatureCommand(controller), reviewCmd = useRef<{ id: string; actor: string | null; expected: number } | null>(null), batchActor = useRef<string | null>(null), life = useRef(new AbortController());
  const [reviewBusy, setReviewBusy] = useState(false), [reviewUncertain, setReviewUncertain] = useState(false), [reviewError, setReviewError] = useState('');
  useEffect(() => { const current = life.current; return () => current.abort(); }, []);
  const go = (changes: Record<string, string | null>) => { const next = new URLSearchParams(location.search); for (const [k, v] of Object.entries(changes)) v === null ? next.delete(k) : next.set(k, v); navigate(`${location.pathname}?${next}`); };
  useEffect(() => {
    if (opened || settingsView) return;
    const request = new AbortController(); setLoading(true); setError('');
    const search = new URLSearchParams({ active: String(active), page: String(page) }); if (applied) search.set('q', applied);
    void Promise.resolve().then(() => controller.fiscalInvoices(`${FISCAL_BASE}/naturezas?${search}`, { signal: request.signal })).then(value => {
      if (request.signal.aborted) return;
      const v = value as { items: unknown[]; total_count: number; page: number; review: NatureReview };
      if (!Array.isArray(v?.items) || v.page !== page || !Number.isInteger(v.total_count) || typeof v.review?.confirmed !== 'boolean' || !Number.isInteger(v.review?.version)) throw new AccessError(502);
      setItems(v.items.map(natureSummary)); setTotal(v.total_count); setReview(v.review); setSelected(new Set()); setLoading(false);
    }).catch(problem => { if (!request.signal.aborted && !aborted(problem)) { setLoading(false); setError(failure(problem)); } });
    return () => request.abort();
  }, [controller, active, applied, page, reload, opened, settingsView]);
  // "Confirmo que revisei e configurei as naturezas de operação": one command id, repeated as is with "Conferir resultado".
  const confirmReview = async () => {
    if (!review || reviewBusy) return;
    if (!reviewCmd.current) reviewCmd.current = { id: crypto.randomUUID(), actor: actorOf(controller), expected: review.version };
    const op = reviewCmd.current;
    if (actorOf(controller) !== op.actor || !['admin', 'fiscal'].includes(roleOf(controller))) { reviewCmd.current = null; setReviewUncertain(false); setReviewError('A sessão ou o perfil mudou. Recarregue antes de repetir.'); return; }
    setReviewBusy(true); setReviewError('');
    try {
      const value = await controller.fiscalInvoices(`${FISCAL_BASE}/naturezas/revisao`, { method: 'POST', body: { command_id: op.id, expected_version: op.expected }, signal: life.current.signal }) as { review: NatureReview };
      if (life.current.signal.aborted) return;
      if (!value?.review?.confirmed || !Number.isInteger(value.review.version)) throw new AccessError(502);
      reviewCmd.current = null; setReviewUncertain(false); setReview(value.review); setNotice('Revisão das naturezas de operação registrada.');
    } catch (problem) {
      if (life.current.signal.aborted || aborted(problem)) return;
      if (!reviewUncertain && known(problem)) { reviewCmd.current = null; setReviewError(failure(problem)); if (problem instanceof AccessError && problem.status === 409) setReload(n => n + 1); }
      else { setReviewUncertain(true); setReviewError('Não foi possível confirmar o registro da revisão. Use "Conferir resultado" para repetir o mesmo comando.'); }
    } finally { if (!life.current.signal.aborted) setReviewBusy(false); }
  };
  // ---- "Excluir as operações selecionadas": logical deletion, one command per nature ----
  const runDelete = async ({ nature }: NatureDeleteItem) => {
    if (life.current.signal.aborted || actorOf(controller) !== batchActor.current || !['admin', 'fiscal'].includes(roleOf(controller))) throw new Error('A sessão ou o perfil mudou. Esta natureza não foi excluída.');
    const body = { command_id: crypto.randomUUID(), action: 'delete', id: nature.id, expected_version: nature.version };
    const send = () => controller.fiscalInvoices(`${FISCAL_BASE}/naturezas`, { method: 'POST', body, signal: life.current.signal });
    const verify = (value: unknown) => { const out = resultNature(value); if (out.id !== nature.id || out.active || out.version !== nature.version + 1) throw new AccessError(502); };
    try { verify(await send()); return { message: 'Natureza excluída. As notas que a usaram continuam com a descrição.' }; }
    catch (first) {
      if (known(first)) throw new Error(failure(first));
      const unconfirmed = { uncertain: true, message: `Resultado não confirmado. Confira a natureza ${nature.description} antes de repetir.` };
      if (life.current.signal.aborted || actorOf(controller) !== batchActor.current) return unconfirmed;
      try { verify(await send()); return { message: 'Natureza excluída (confirmada ao repetir o mesmo comando).' }; } catch { return unconfirmed; }
    }
  };
  const closeDelete = (results: BatchResult[] | null) => { setDeleting(null); if (results?.some(r => r.outcome === 'ok' || r.outcome === 'uncertain')) setReload(n => n + 1); };
  const selectedItems = items.filter(n => selected.has(n.id));
  if (settingsView) return <FiscalTaxSettings controller={controller} onBack={() => go({ tela: null })} />;
  if (opened) return <OperationNatureForm key={opened} controller={controller} id={opened === 'nova' ? null : opened} writable={writable} onBack={() => { go({ natureza: null }); setReload(n => n + 1); }} onSaved={n => go({ natureza: n.id })} />;
  const actionsFor = (n: NatureSummary) => {
    const disabled = !writable || cmd.busy || cmd.uncertain;
    const clone = () => cmd.start({ action: 'clone', id: n.id, expected_version: n.version }, value => { const out = resultNature(value); if (out.id === n.id || out.version !== 1) throw new AccessError(502); return out; },
      out => { setNotice('Natureza clonada.'); go({ natureza: out.id }); });
    return [
      { label: 'Clonar Operação', disabled, onClick: clone },
      ...Object.entries(T.DEFAULT_LABELS).filter(([code]) => DEFAULT_CODES[code as keyof typeof DEFAULT_CODES] === n.direction && !n.defaults.includes(code)).map(([code, label]) => ({ label, disabled: disabled || !n.active,
        onClick: () => cmd.start({ action: 'set_default', id: n.id, expected_version: n.version, code }, value => { const out = resultNature(value); if (out.id !== n.id || !out.defaults.includes(code)) throw new AccessError(502); return out; }, () => { setNotice(`${label} definido.`); setReload(x => x + 1); }) })),
      n.active ? { label: 'Inativar', disabled, separatorBefore: true, onClick: () => cmd.start({ action: 'set_active', id: n.id, expected_version: n.version, active: false }, value => { const out = resultNature(value); if (out.id !== n.id || out.active) throw new AccessError(502); return out; }, () => { setNotice('Natureza inativada.'); setReload(x => x + 1); }) }
        : { label: 'Ativar', disabled, separatorBefore: true, onClick: () => cmd.start({ action: 'set_active', id: n.id, expected_version: n.version, active: true }, value => { const out = resultNature(value); if (out.id !== n.id || !out.active) throw new AccessError(502); return out; }, () => { setNotice('Natureza ativada.'); setReload(x => x + 1); }) },
    ].map(item => ({ ...item, title: !writable ? 'Seu perfil permite apenas consultar.' : undefined }));
  };
  return <section className="fiscal-natures">
    <OriginListHeader title="Naturezas de operação" primary={writable ? <button type="button" className="primary-button" onClick={() => go({ natureza: 'nova' })}><Icon name="plus" size={12} /> Incluir natureza</button> : undefined} />
    <div className="fiscal-natures-layout"><div>
      <form className="native-list-toolbar" onSubmit={event => { event.preventDefault(); setApplied(query.trim()); setPage(1); }}><div className="form-field"><label htmlFor="natures-search" className="sr-only">Pesquisar</label><input id="natures-search" type="search" maxLength={120} placeholder="Pesquisar" value={query} onChange={event => setQuery(event.target.value)} /></div>
        <button type="submit" className="secondary-button" aria-label="Pesquisar"><Icon name="search" size={16} /></button>
        <div className="form-field"><label htmlFor="natures-active">Situação</label><select id="natures-active" value={String(active)} onChange={event => { setActive(event.target.value === 'true'); setPage(1); }}><option value="true">Ativas</option><option value="false">Inativas</option></select></div></form>
      <AppliedChips chips={[{ label: `Situação: ${active ? 'Ativas' : 'Inativas'}`, onRemove: () => { setActive(true); setPage(1); } }, ...(applied ? [{ label: `Pesquisa: ${applied}`, onRemove: () => { setApplied(''); setQuery(''); } }] : [])]} onClear={() => { setActive(true); setApplied(''); setQuery(''); setPage(1); }} />
      {error && <p className="real-alert" role="alert">{error}</p>}{cmd.error && <p className="real-alert" role="alert">{cmd.error}{cmd.uncertain && <button type="button" className="text-button" disabled={cmd.busy} onClick={cmd.retry}>Conferir resultado</button>}</p>}
      {notice && <p className="real-success" role="status">{notice}</p>}
      <div className="native-list-toolbar"><ToolButton icon="trash-can" title="Excluir as operações selecionadas" disabled={!writable || !selectedItems.length || cmd.busy} onClick={() => { batchActor.current = actorOf(controller); setDeleting(selectedItems.slice()); }} /></div>
      <ListControls checked={items.length > 0 && items.every(n => selected.has(n.id))} onToggleAll={() => setSelected(items.every(n => selected.has(n.id)) ? new Set() : new Set(items.map(n => n.id)))} onRefresh={() => setReload(n => n + 1)} />
      <div className="real-result-status" role="status">{loading ? 'Carregando naturezas…' : `${total} natureza(s)`}</div>
      {items.length > 0 ? <table className="data-table origin-table"><thead><tr><th className="checkbox-cell"><span className="sr-only">Seleção</span></th><th>Descrição</th><th>Tipo</th><th>Natureza Padrão</th><th className="row-actions"><span className="sr-only">Ações</span></th></tr></thead>
        <tbody>{items.map(n => <tr key={n.id} className={`fiscal-row${selected.has(n.id) ? ' selected' : ''}`} onClick={() => go({ natureza: n.id })}>
          <td className="checkbox-cell" onClick={event => event.stopPropagation?.()}><input type="checkbox" aria-label={`Selecionar natureza ${n.description}`} checked={selected.has(n.id)} onChange={event => { const on = event.target.checked; setSelected(s => { const next = new Set(s); if (on) next.add(n.id); else next.delete(n.id); return next; }); }} /></td><td>{n.description}</td><td>{n.direction === '1' ? 'Saída' : 'Entrada'}</td><td>{n.defaults.map(code => T.DEFAULT_LABELS[code]).join(', ') || '—'}</td>
          <td className="row-actions" onClick={event => event.stopPropagation?.()}><RowMenu label={n.description} items={actionsFor(n)} open={menu === n.id} onToggle={() => setMenu(v => v === n.id ? null : n.id)} /></td></tr>)}</tbody></table>
        : !loading && <div className="empty-state"><h2>Nenhuma natureza encontrada</h2><p>{writable ? 'Inclua as naturezas de operação usadas nas notas.' : 'Aguarde o cadastro pela equipe fiscal.'}</p></div>}
      {total > 100 && <OriginPagination page={page} pages={Math.ceil(total / 100)} size={100} total={total} onPage={setPage} />}
    </div>
    <aside className="origin-actions-box fiscal-natures-panel">
      {writable && <button type="button" className="origin-action" onClick={() => go({ natureza: 'nova' })}><Icon name="plus" size={15} /><span>Incluir natureza</span></button>}
      <button type="button" className="origin-action" onClick={() => go({ tela: 'impostos' })}><Icon name="gear" size={15} /><span>Configurações globais</span></button>
      <section className="origin-info"><h2>Informações</h2><dl><div><dt>Quantidade de operações fiscais</dt><dd>{total}</dd></div></dl></section>
      <section className="origin-info fiscal-natures-review"><h2>Revisão</h2>
        <label htmlFor="natures-review"><input id="natures-review" type="checkbox" checked={Boolean(review?.confirmed) && !reviewUncertain} disabled={!writable || !review || reviewBusy || (review.confirmed && !reviewUncertain)} onChange={() => void confirmReview()} /> Confirmo que revisei e configurei as naturezas de operação</label>
        {review && <p className="real-help">{natureReviewText(review)}</p>}
        {review?.confirmed && writable && !reviewUncertain && <button type="button" className="text-button" disabled={reviewBusy} onClick={() => void confirmReview()}>Confirmar a revisão novamente</button>}
        {reviewError && <p className="real-alert" role="alert">{reviewError}{reviewUncertain && <button type="button" className="text-button" disabled={reviewBusy} onClick={() => void confirmReview()}>Conferir resultado</button>}</p>}</section>
      <section className="origin-support"><h2>Ferramentas de apoio</h2>{/* Leva H (NFE-222): the FAGOO guidance; official sources are linked from it. */}<button type="button" className="text-button" onClick={() => navigate('/ajuda/naturezas-operacao')}>Manual de operações fiscais</button><button type="button" className="text-button" onClick={() => navigate('/preferencias/notas-fiscais/nfe')}>Acesse os parâmetros de operações fiscais</button></section>
    </aside></div>
    {deleting && <BatchDialog title="Excluir as operações selecionadas" confirmLabel="Excluir" plan={natureDeletePlan(deleting)} run={runDelete} onClose={closeDelete}
      description={<p className="real-notice">As naturezas selecionadas deixam de aparecer na lista e nas notas novas. As notas que já as usaram continuam com a descrição, e o histórico fica preservado.</p>} />}
  </section>;
}

const TAX_LABELS: Record<Tax, string> = { icms: 'ICMS', ipi: 'IPI', pis: 'PIS', cofins: 'COFINS', ii: 'II' };
type RuleDraft = NatureRule & { products?: { id: string; name: string; code: string | null }[]; groups?: { id: string; name: string }[] };
const emptyNature = () => ({ description: '', series: '', direction: '1' as '0' | '1', crt: '1' as '1' | '2' | '3' | '4', presence: '1', invoiced: true, final_consumer: false, return_operation: false,
  update_last_purchase_price: false, include_freight_ipi_base: false, others: {} as Record<string, string | boolean>, retentions: {} as Record<string, string | boolean>, additional_info: '', fiscal_info: '', rules: [] as RuleDraft[] });
type NatureDraft = ReturnType<typeof emptyNature>;
const toDraft = (n: NatureRecord): NatureDraft => ({ description: n.description, series: n.series === null ? '' : String(n.series), direction: n.direction, crt: n.crt, presence: n.presence, invoiced: n.invoiced,
  final_consumer: n.final_consumer, return_operation: n.return_operation, update_last_purchase_price: n.update_last_purchase_price, include_freight_ipi_base: n.include_freight_ipi_base,
  others: { ...n.others }, retentions: { ...n.retentions }, additional_info: n.additional_info ?? '', fiscal_info: n.fiscal_info ?? '',
  rules: n.rules.map(({ position, ...rule }) => ({ ...rule, products: rule.products.map(p => ({ ...p })), ...(rule.groups ? { groups: rule.groups.map(g => ({ ...g })) } : {}) })) });
const RULE_MESSAGES: Record<string, string> = { FISCAL_RULE_SITUATION_REQUIRED: 'Uma situação tributária válida deve ser selecionada.', FISCAL_RULE_SITUATION_INVALID: 'A situação do IPI não combina com o tipo da natureza.',
  FISCAL_RULE_PRODUCT_INVALID: 'Escolha até 10 produtos ou NCMs válidos.', FISCAL_RULE_GROUP_INVALID: 'Escolha de 1 a 10 grupos de produtos.', FISCAL_RULE_DESTINATION_INVALID: 'Confira os estados de destino.', FISCAL_VALUE_REQUIRED: 'Informe a descrição.' };
const toInput = (d: NatureDraft) => ({ ...d, series: d.series.trim() || null, additional_info: d.additional_info, fiscal_info: d.fiscal_info,
  others: Object.fromEntries(Object.entries(d.others).filter(([, v]) => v !== '').map(([k, v]) => [k, typeof v === 'string' ? v.replace(',', '.') : v])),
  retentions: Object.fromEntries(Object.entries(d.retentions).filter(([, v]) => v !== '').map(([k, v]) => [k, typeof v === 'string' ? v.replace(',', '.') : v])),
  rules: d.rules.map(({ products, groups, ...rule }) => rule) });

function OperationNatureForm({ controller, id, writable, onBack, onSaved }: { controller: AccessController; id: string | null; writable: boolean; onBack: () => void; onSaved: (n: NatureRecord) => void }) {
  const [record, setRecord] = useState<NatureRecord | null>(null), [draft, setDraft] = useState<NatureDraft | null>(id ? null : emptyNature()), [baseline, setBaseline] = useState(JSON.stringify(emptyNature()));
  const [tab, setTab] = useState('dados'), [rule, setRule] = useState<{ index: number | null; tax: Tax; value: RuleDraft } | null>(null), [variables, setVariables] = useState(false), [loadError, setLoadError] = useState(''), [notice, setNotice] = useState('');
  const cmd = useNatureCommand(controller);
  const dirty = draft !== null && JSON.stringify(draft) !== baseline;
  const guard = useUnsavedChanges(dirty || cmd.uncertain, cmd.busy);
  useEffect(() => {
    if (!id) return;
    const request = new AbortController();
    void Promise.resolve().then(() => controller.fiscalInvoices(`${FISCAL_BASE}/naturezas/${id}`, { signal: request.signal })).then(value => {
      if (request.signal.aborted) return;
      const n = resultNature(value); if (n.id !== id) throw new AccessError(502);
      const next = toDraft(n); setRecord(n); setDraft(next); setBaseline(JSON.stringify(next));
    }).catch(problem => { if (!request.signal.aborted && !aborted(problem)) setLoadError(problem instanceof AccessError && problem.status === 404 ? 'Natureza não encontrada.' : 'Não foi possível carregar a natureza.'); });
    return () => request.abort();
  }, [controller, id]);
  if (loadError) return <section className="real-state-panel"><h1>Natureza da operação</h1><p role="alert">{loadError}</p><button type="button" className="secondary-button" onClick={onBack}>Voltar</button></section>;
  if (!draft) return <section className="real-state-panel" role="status"><h1>Natureza da operação</h1><p>Carregando…</p></section>;
  const locked = !writable || cmd.busy || cmd.uncertain;
  const update = (patch: Partial<NatureDraft>) => { if (!locked) setDraft(d => d ? { ...d, ...patch } : d); };
  const save = () => {
    let nature;
    try { nature = normalizeNatureInput(toInput(draft)); } catch (problem) { cmd.setError(problem instanceof FiscalSpecError ? RULE_MESSAGES[problem.code] ?? `Confira o campo ${problem.field ?? ''}.` : 'Confira os campos.'); return; }
    const body = record ? { action: 'update', id: record.id, expected_version: record.version, nature } : { action: 'create', nature };
    cmd.start(body, value => { const out = resultNature(value); if (record ? out.id !== record.id || out.version !== record.version + 1 : out.version !== 1) throw new AccessError(502); return out; },
      out => { const next = toDraft(out); setRecord(out); setDraft(next); setBaseline(JSON.stringify(next)); setNotice('Natureza salva.'); if (!record) guard.store.runConfirmed(() => onSaved(out)); });
  };
  const field = (fid: string, label: string, control: ReactNode) => <div className="form-field"><label htmlFor={fid}>{label}</label>{control}</div>;
  const yesNo = (fid: string, value: boolean | undefined, onChange: (v: boolean) => void) => <select id={fid} disabled={locked} value={value ? 'true' : 'false'} onChange={event => onChange(event.target.value === 'true')}><option value="true">Sim</option><option value="false">Não</option></select>;
  const rate = (fid: string, value: unknown, onChange: (v: string) => void) => <input id={fid} inputMode="decimal" disabled={locked} value={typeof value === 'string' ? value : ''} onChange={event => onChange(event.target.value)} />;
  const setOther = (key: string, value: string | boolean) => update({ others: { ...draft.others, [key]: value } });
  const ruleRows = (tax: Tax) => draft.rules.map((r, index) => ({ r, index })).filter(({ r }) => r.tax === tax);
  const destinations = (r: RuleDraft) => r.destinations.length ? r.destinations.join(', ') : 'Qualquer estado';
  const productsText = (r: RuleDraft) => r.product_scope === 'any' ? 'Qualquer produto' : r.product_scope === 'ncm' ? `NCM ${r.ncms.join(', ')}`
    : r.product_scope === 'groups' ? `Grupo: ${(r.groups ?? []).map(g => g.name).join(', ') || `${r.group_ids?.length ?? 0} grupo(s)`}` : (r.products ?? []).map(p => p.name).join(', ') || `${r.product_ids.length} produto(s)`;
  const ruleTable = (tax: Tax) => <>
    {tax === 'ipi' && <div className="form-field"><label htmlFor="nature-freight-ipi"><input id="nature-freight-ipi" type="checkbox" disabled={locked} checked={draft.include_freight_ipi_base} onChange={event => update({ include_freight_ipi_base: event.target.checked })} /> Incluir frete na base do IPI</label></div>}
    <table className="data-table"><thead><tr><th>Destino(s)</th><th>Produto(s)</th>{tax === 'icms' ? <th>CFOP</th> : <><th>Alíq. %</th><th>Base %</th></>}<th>Situação tributária</th><th><span className="sr-only">Ações</span></th></tr></thead>
      <tbody>{ruleRows(tax).map(({ r, index }) => <tr key={index} className="fiscal-row" onClick={() => setRule({ index, tax, value: structuredClone(r) })}><td>{destinations(r)}</td><td>{productsText(r)}</td>
        {tax === 'icms' ? <td>{String(r.data.cfop ?? '—')}</td> : <><td>{String(r.data.rate ?? '—')}</td><td>{String(r.data.base_rate ?? '—')}</td></>}<td>{String(r.data.situation ?? '—')}</td>
        <td onClick={event => event.stopPropagation?.()}><button type="button" className="icon-button" aria-label="Remover regra" disabled={locked} onClick={() => update({ rules: draft.rules.filter((_, i) => i !== index) })}><Icon name="trash-can" size={12} /></button></td></tr>)}</tbody></table>
    {!ruleRows(tax).length && <p className="real-help">Nenhuma regra registrada</p>}
    <button type="button" className="secondary-button" disabled={locked} onClick={() => setRule({ index: null, tax, value: { tax, destinations: [], product_scope: 'any', ncms: [], product_ids: [], data: {}, additional_info: null, fiscal_info: null, products: [] } })}><Icon name="plus" size={10} /> Adicionar regra</button>
  </>;
  const tabs: [string, string][] = [['dados', 'Dados gerais'], ['icms', 'ICMS'], ['ipi', 'IPI'], ['pis', 'PIS'], ['cofins', 'COFINS'], ...(draft.direction === '0' ? [['ii', 'II'] as [string, string]] : []), ['outros', 'Outros'], ['retencoes', 'Retenções'], ['informacoes', 'Informações adicionais']];
  return <section className="fiscal-nature-form">
    <header className="real-heading"><div><h1>Natureza da operação{record ? ` - ${record.description}` : ''}</h1>{record && <p>{record.active ? 'Ativa' : 'Inativa'} · versão {record.version}</p>}</div>
      <div className="real-editor-actions"><button type="button" className="secondary-button" disabled={cmd.busy} onClick={() => guard.confirmLeave(onBack)}>Cancelar</button>
        {cmd.uncertain ? <button type="button" className="primary-button" disabled={cmd.busy} onClick={cmd.retry}>Conferir resultado</button> : <button type="button" className="primary-button" disabled={locked} onClick={save}>{cmd.busy ? 'Salvando…' : 'Salvar'}</button>}</div></header>
    {!writable && <p className="real-notice">Seu perfil permite apenas consultar as naturezas de operação.</p>}
    {cmd.error && <p className="real-alert" role="alert">{cmd.error}</p>}{notice && <p className="real-success" role="status">{notice}</p>}
    <nav className="origin-list-tabs" role="tablist" aria-label="Seções da natureza">{tabs.map(([value, label]) => <button type="button" role="tab" key={value} aria-selected={tab === value} onClick={() => setTab(value)}>{label}</button>)}</nav>
    {tab === 'dados' && <div className="document-grid">
      {field('nature-description', 'Descrição', <input id="nature-description" maxLength={60} disabled={locked} value={draft.description} onChange={event => update({ description: event.target.value })} />)}
      {field('nature-series', 'Série', <input id="nature-series" maxLength={3} inputMode="numeric" disabled={locked} value={draft.series} onChange={event => update({ series: event.target.value.replace(/\D/g, '') })} />)}
      {field('nature-direction', 'Tipo', <select id="nature-direction" disabled={locked || Boolean(record)} value={draft.direction} onChange={event => update({ direction: event.target.value as '0' | '1', rules: draft.rules.filter(r => r.tax !== 'ipi'), presence: event.target.value === '0' ? '9' : draft.presence, update_last_purchase_price: false })}><option value="1">Saída</option><option value="0">Entrada</option></select>)}
      {field('nature-crt', 'Código de regime tributário', <select id="nature-crt" disabled={locked} value={draft.crt} onChange={event => update({ crt: event.target.value as NatureDraft['crt'], rules: draft.rules.filter(r => r.tax !== 'icms') })}>{T.CRT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>)}
      <p className="real-help">Se o regime for diferente do da empresa, a natureza é salva, mas não aparece na emissão.</p>
      {field('nature-presence', 'Indicador de presença', <select id="nature-presence" disabled={locked} value={draft.presence} onChange={event => update({ presence: event.target.value })}>{T.PRESENCE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>)}
      {([['invoiced', 'Faturada'], ['final_consumer', 'Consumidor final'], ['return_operation', 'Operação de devolução'], ...(draft.direction === '0' ? [['update_last_purchase_price', 'Atualizar preço de última compra do produto'] as const] : [])] as const).map(([key, label]) =>
        <div className="form-field" key={key}><label htmlFor={`nature-${key}`}><input id={`nature-${key}`} type="checkbox" disabled={locked} checked={Boolean(draft[key])} onChange={event => update({ [key]: event.target.checked } as Partial<NatureDraft>)} /> {label}</label></div>)}
    </div>}
    {(['icms', 'ipi', 'pis', 'cofins', 'ii'] as Tax[]).includes(tab as Tax) && ruleTable(tab as Tax)}
    {tab === 'outros' && <div className="document-grid">
      {field('nature-presumed', 'Presumido no cálculo do PIS/COFINS', yesNo('nature-presumed', draft.others.presumed_pis_cofins as boolean, v => setOther('presumed_pis_cofins', v)))}
      {field('nature-add-icms', 'Somar ICMS', yesNo('nature-add-icms', draft.others.add_icms as boolean, v => setOther('add_icms', v)))}
      {field('nature-add-other', 'Somar outras despesas', yesNo('nature-add-other', draft.others.add_other_expenses as boolean, v => setOther('add_other_expenses', v)))}
      {field('nature-funrural', 'Alíquota funrural (%)', rate('nature-funrural', draft.others.funrural_rate, v => setOther('funrural_rate', v)))}
      {field('nature-rural', 'Compra de produtor rural', yesNo('nature-rural', draft.others.rural_producer_purchase as boolean, v => setOther('rural_producer_purchase', v)))}
      {field('nature-deduct-funrural', 'Descontar funrural do total faturado', yesNo('nature-deduct-funrural', draft.others.deduct_funrural as boolean, v => setOther('deduct_funrural', v)))}
      {field('nature-approx-type', 'Tipo % Aprox. Trib.', <select id="nature-approx-type" disabled={locked} value={String(draft.others.approx_tax_type ?? '')} onChange={event => setOther('approx_tax_type', event.target.value)}><option value="">Selecione</option>{T.APPROX_TAX_TYPE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>)}
      {draft.others.approx_tax_type === 'fixed' && field('nature-approx-rate', '% Aprox. Trib.', rate('nature-approx-rate', draft.others.approx_tax_rate, v => setOther('approx_tax_rate', v)))}
      {field('nature-discount-type', 'Tipo desconto', <select id="nature-discount-type" disabled={locked} value={String(draft.others.discount_type ?? '')} onChange={event => setOther('discount_type', event.target.value)}><option value="">Selecione</option>{T.DISCOUNT_TYPE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>)}
      {draft.crt !== '3' && field('nature-simples-credit', 'Crédito de ICMS do Simples %', rate('nature-simples-credit', draft.others.simples_credit_rate, v => setOther('simples_credit_rate', v)))}
    </div>}
    {tab === 'retencoes' && <div className="document-grid">
      {field('nature-csrf', 'Possui retenção de CSRF', yesNo('nature-csrf', draft.retentions.csrf as boolean, v => update({ retentions: { ...draft.retentions, csrf: v } })))}
      {field('nature-csrf-rate', 'Alíquota CSRF retido %', rate('nature-csrf-rate', draft.retentions.csrf_rate, v => update({ retentions: { ...draft.retentions, csrf_rate: v } })))}
      {field('nature-ir', 'Possui retenção de IR', yesNo('nature-ir', draft.retentions.ir as boolean, v => update({ retentions: { ...draft.retentions, ir: v } })))}
      {field('nature-ir-rate', 'Alíquota IR retido %', rate('nature-ir-rate', draft.retentions.ir_rate, v => update({ retentions: { ...draft.retentions, ir_rate: v } })))}
    </div>}
    {tab === 'informacoes' && <div className="document-grid">
      {draft.crt !== '3' && <div className="real-notice fiscal-wide"><strong>Crédito do ICMS</strong><p>Com CSOSN 101, 201 ou 900 e crédito informado, o FAGOO acrescenta a mensagem de aproveitamento do crédito do Simples Nacional (art. 23 da LC 123/2006).</p></div>}
      <div className="form-field fiscal-wide"><label htmlFor="nature-additional">Informações complementares</label><textarea id="nature-additional" rows={4} maxLength={5000} disabled={locked} value={draft.additional_info} onChange={event => update({ additional_info: event.target.value })} />
        <button type="button" className="text-button" onClick={() => setVariables(true)}>Ver variáveis</button></div>
      <div className="form-field fiscal-wide"><label htmlFor="nature-fiscal">Informações adicionais de interesse do fisco</label><textarea id="nature-fiscal" rows={3} maxLength={2000} disabled={locked} value={draft.fiscal_info} onChange={event => update({ fiscal_info: event.target.value })} /></div>
    </div>}
    {rule && <NatureRuleDialog controller={controller} rule={rule.value} crt={draft.crt} direction={draft.direction} readOnly={locked} onCancel={() => setRule(null)}
      onSave={value => { update({ rules: rule.index === null ? [...draft.rules, value] : draft.rules.map((r, i) => i === rule.index ? value : r) }); setRule(null); }} />}
    {variables && <Modal title="Variáveis das informações complementares" onClose={() => setVariables(false)} actions={<button type="button" className="secondary-button" onClick={() => setVariables(false)}>Fechar</button>}>
      <p className="real-help">Escreva a variável entre colchetes, por exemplo [VALOR_ICMS]. NOME_VENDEDOR vem do Vendedor da nota; NOME_CANAL_VENDA, NOME_LOJA, NOME_FANTASIA e NUMERO_CUPOM ficam vazias no FAGOO.</p>
      <h3>Impostos</h3><p className="fiscal-variables">{T.INFO_VARIABLES.impostos.join(' · ')}</p><h3>Outras</h3><p className="fiscal-variables">{T.INFO_VARIABLES.outras.join(' · ')}</p></Modal>}
  </section>;
}

type RuleField = [key: string, label: string, kind: 'select' | 'rate' | 'text' | 'check', options?: T.Table];
const ruleFields = (tax: Tax, crt: string, direction: '0' | '1'): RuleField[] => {
  if (tax === 'icms' && crt === '3') return [['situation', 'Situação tributária', 'select', T.ICMS_CST], ['cfop', 'CFOP', 'text'], ['rate', 'Alíquota %', 'rate'], ['base_rate', 'Base %', 'rate'], ['deferral_rate', 'Diferimento %', 'rate'],
    ['presumed_rate', 'Presumido %', 'rate'], ['taxation', 'Tributação', 'select', T.TAXATION], ['fcp_rate', '% FCP', 'rate'], ['bc_mode', 'Modalidade BC', 'select', T.BC_MODE], ['pauta_value', 'Valor pauta', 'rate'],
    ['benefit_code', 'Cód. benef. na UF', 'text'], ['presumed_credit_code', 'Cód. créd. presumido', 'text'], ['rbc_benefit_code', 'Cód. benef. RBC', 'text'], ['deson_reason', 'Motivo desoneração', 'select', T.DESON_REASON],
    ['deson_deduct', 'Dedução do ICMS desonerado', 'check'], ['st_bc_mode', 'ST: Modalidade BC', 'select', T.ST_BC_MODE], ['st_pauta_value', 'ST: Valor pauta', 'rate'], ['st_rate', 'ST: Alíq. ICMS %', 'rate'],
    ['st_base_rate', 'ST: Base %', 'rate'], ['st_mva', 'ST: MVA %', 'rate'], ['st_pis_rate', 'ST: PIS %', 'rate'], ['st_cofins_rate', 'ST: COFINS %', 'rate'], ['retained_rate', 'Alíquota ICMS Retido %', 'rate'],
    ['difal_type', 'Partilha: Tipo de tributação', 'select', T.DIFAL_TYPE], ['difal_base_rate', 'Partilha: Base de cálculo (%)', 'rate'], ['difal_internal_rate', 'Alíquota Interna UF de destino (%)', 'rate'], ['difal_fcp_rate', 'Alíquota do FCP (%)', 'rate']];
  if (tax === 'icms') return [['situation', 'Situação tributária', 'select', T.ICMS_CSOSN], ['cfop', 'CFOP', 'text'], ['bc_mode', 'Modalidade BC', 'select', T.BC_MODE], ['rate', 'Alíquota ICMS %', 'rate'], ['base_rate', 'Base ICMS %', 'rate'],
    ['deferral_rate', 'Diferimento %', 'rate'], ['reduction_reason', 'Motivo da redução', 'select', T.REDUCTION_REASON], ['taxation', 'Tributação', 'select', T.TAXATION], ['credit_rate', 'Alíquota aplicável de crédito', 'rate'],
    ['fcp_rate', '% FCP', 'rate'], ['benefit_code', 'Cód. benef. na UF', 'text'], ['presumed_credit_code', 'Cód. créd. presumido', 'text'], ['rbc_benefit_code', 'Cód. benef. RBC', 'text'], ['pauta_value', 'Valor pauta', 'rate'],
    ['st_bc_mode', 'ST: Modalidade BC', 'select', T.ST_BC_MODE], ['st_pauta_value', 'ST: Valor pauta', 'rate'], ['st_rate', 'ST: Alíq. ICMS ST', 'rate'], ['st_base_rate', 'ST: Base de Cálculo ICMS %', 'rate'],
    ['st_mva', 'ST: Margem Adic. ICMS %', 'rate'], ['retained_base_rate', 'Base do ICMS Retido %', 'rate'], ['retained_rate', 'Alíquota ICMS Retido %', 'rate'], ['difal_type', 'Partilha: Tipo de tributação', 'select', T.DIFAL_TYPE],
    ['difal_base_rate', 'Partilha: Base de cálculo (%)', 'rate'], ['difal_internal_rate', 'Alíquota Interna UF de destino (%)', 'rate'], ['difal_fcp_rate', 'Alíquota do FCP (%)', 'rate']];
  const situations = tax === 'ipi' ? T.IPI_CST.filter(([c]) => direction === '0' ? Number(c) < 50 : Number(c) >= 50) : tax === 'ii' ? T.II_SITUATION : T.PIS_CST;
  return [['situation', 'Situação tributária', 'select', situations], ['rate', 'Alíquota %', 'rate'], ['base_rate', 'Base %', 'rate'], ...(tax === 'ipi' ? [['framing_code', 'Cód. de enquadramento', 'text'] as RuleField] : []), ['taxation', 'Tributação', 'select', T.TAXATION]];
};

function NatureRuleDialog({ controller, rule, crt, direction, readOnly, onSave, onCancel }: { controller: AccessController; rule: RuleDraft; crt: string; direction: '0' | '1'; readOnly: boolean; onSave: (rule: RuleDraft) => void; onCancel: () => void }) {
  const [value, setValue] = useState<RuleDraft>(rule), [error, setError] = useState(''), [ncm, setNcm] = useState(''), [productQuery, setProductQuery] = useState(''), [products, setProducts] = useState<CatalogRecord[]>([]);
  // "Grupo de Produtos" (202610200216): the groups of the product cadastro, read once when that scope is chosen.
  const [groupList, setGroupList] = useState<{ id: string; name: string }[] | null>(null), [groupError, setGroupError] = useState('');
  useEffect(() => {
    if (value.product_scope !== 'groups' || groupList) return;
    const request = new AbortController();
    void controller.catalog('/v1/cadastros/taxonomias/grupos-produtos', { signal: request.signal }).then(v => { if (!request.signal.aborted) setGroupList(taxonomyItems(v, 'product_groups').map(g => ({ id: g.id, name: g.name }))); })
      .catch(() => { if (!request.signal.aborted) setGroupError('Não foi possível carregar os grupos de produtos.'); });
    return () => request.abort();
  }, [controller, value.product_scope, groupList]);
  useEffect(() => {
    const q = productQuery.trim(); if (q.length < 2) { setProducts([]); return; }
    const request = new AbortController();
    const timer = setTimeout(() => { void controller.catalog(`/v1/cadastros/products?${new URLSearchParams({ limit: '25', q })}`, { signal: request.signal }).then(v => { if (!request.signal.aborted) setProducts((v as CatalogPage).items ?? []); }).catch(() => undefined); }, 250);
    return () => { clearTimeout(timer); request.abort(); };
  }, [controller, productQuery]);
  const set = (key: string, v: string | boolean) => setValue(r => { const data = { ...r.data, [key]: typeof v === 'string' ? v.replace(',', '.') : v }; if (v === '' || v === false) delete data[key]; return { ...r, data }; });
  const save = () => { try { const { products: list, groups: names, ...rest } = value; normalizeRuleInput(rest, crt, direction); setError(''); onSave(value); } catch (problem) { setError(problem instanceof FiscalSpecError ? RULE_MESSAGES[problem.code] ?? `Confira o campo ${problem.field ?? ''}.` : 'Confira a regra.'); } };
  const anyState = value.destinations.length === 0;
  return <Modal title={`Regra de ${TAX_LABELS[value.tax]}`} onClose={onCancel} actions={<><button type="button" className="secondary-button" onClick={onCancel}>Cancelar</button><button type="button" className="primary-button" disabled={readOnly} onClick={save}>Salvar</button></>}>
    <fieldset className="fiscal-group"><legend>Quando for para</legend>
      <label htmlFor="rule-any-state"><input id="rule-any-state" type="checkbox" disabled={readOnly} checked={anyState} onChange={event => setValue(r => ({ ...r, destinations: event.target.checked ? [] : ['SP'] }))} /> Qualquer estado</label>
      {!anyState && <div className="fiscal-states">{[...UFS, 'EX'].map(uf => <label key={uf} htmlFor={`rule-state-${uf}`}><input id={`rule-state-${uf}`} type="checkbox" disabled={readOnly} checked={value.destinations.includes(uf)} onChange={event => setValue(r => ({ ...r, destinations: event.target.checked ? [...r.destinations, uf].sort() : r.destinations.filter(d => d !== uf) }))} />{uf}</label>)}</div>}</fieldset>
    <fieldset className="fiscal-group"><legend>Quando for</legend>
      <select id="rule-scope" aria-label="Quando for" disabled={readOnly} value={value.product_scope} onChange={event => { const scope = event.target.value as RuleDraft['product_scope']; setValue(r => { const { group_ids: _g, groups: _n, ...base } = r; return { ...base, product_scope: scope, ncms: [], product_ids: [], products: [], ...(scope === 'groups' ? { group_ids: [], groups: [] } : {}) }; }); }}>
        <option value="any">Qualquer produto ou NCM</option><option value="ncm">NCM</option><option value="products">Produto</option><option value="groups">Grupo de Produtos</option></select>
      {value.product_scope === 'groups' && <>{groupList ? <select id="rule-group" aria-label="Adicionar grupo de produtos" disabled={readOnly || (value.group_ids?.length ?? 0) >= 10} value="" onChange={event => { const found = groupList.find(g => g.id === event.target.value); if (found) setValue(r => ({ ...r, group_ids: [...new Set([...(r.group_ids ?? []), found.id])].sort(), groups: [...(r.groups ?? []).filter(g => g.id !== found.id), found] })); }}>
          <option value="">{groupList.length ? 'Selecione o grupo (máx. 10 grupos por regra)' : 'Nenhum grupo de produtos cadastrado'}</option>{groupList.filter(g => !(value.group_ids ?? []).includes(g.id)).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
          : groupError ? <p className="real-alert" role="alert">{groupError}</p> : <p className="real-help">Carregando os grupos de produtos…</p>}
        <p>{(value.group_ids ?? []).map(groupId => { const name = value.groups?.find(g => g.id === groupId)?.name ?? groupList?.find(g => g.id === groupId)?.name ?? 'Grupo excluído do cadastro'; return <span className="origin-chip" key={groupId}>{name}<button type="button" aria-label={`Remover grupo ${name}`} disabled={readOnly} onClick={() => setValue(r => ({ ...r, group_ids: (r.group_ids ?? []).filter(x => x !== groupId), groups: (r.groups ?? []).filter(x => x.id !== groupId) }))}><Icon name="xmark" size={9} /></button></span>; })}</p>
        <p className="real-help">Vale para os produtos do grupo (não inclui os subgrupos). Uma regra de produto listado vem antes; a de grupo vem antes da de NCM.</p></>}
      {value.product_scope === 'ncm' && <><span className="fiscal-inline-actions"><input id="rule-ncm" aria-label="NCM" maxLength={8} inputMode="numeric" disabled={readOnly} value={ncm} onChange={event => setNcm(event.target.value.replace(/\D/g, ''))} />
        <button type="button" className="secondary-button" disabled={readOnly || ncm.length < 2 || value.ncms.length >= 10} onClick={() => { setValue(r => ({ ...r, ncms: [...new Set([...r.ncms, ncm])].sort() })); setNcm(''); }}>Adicionar NCM</button></span>
        <p>{value.ncms.map(n => <span className="origin-chip" key={n}>{n}<button type="button" aria-label={`Remover NCM ${n}`} disabled={readOnly} onClick={() => setValue(r => ({ ...r, ncms: r.ncms.filter(x => x !== n) }))}><Icon name="xmark" size={9} /></button></span>)}</p></>}
      {value.product_scope === 'products' && <><input id="rule-product-search" type="search" aria-label="Pesquisar produto" placeholder="Pesquise o produto (máx. 10 produtos por regra)" disabled={readOnly || value.product_ids.length >= 10} value={productQuery} onChange={event => setProductQuery(event.target.value)} />
        {products.length > 0 && <ul className="fiscal-picker" role="listbox" aria-label="Produtos">{products.map(p => <li key={p.id}><button type="button" disabled={value.product_ids.includes(p.id)} onClick={() => { setValue(r => ({ ...r, product_ids: [...r.product_ids, p.id].sort(), products: [...(r.products ?? []), { id: p.id, name: p.name, code: p.code }] })); setProductQuery(''); setProducts([]); }}>{p.name}{p.code ? ` · ${p.code}` : ''}</button></li>)}</ul>}
        <p>{(value.products ?? []).map(p => <span className="origin-chip" key={p.id}>{p.name}<button type="button" aria-label={`Remover produto ${p.name}`} disabled={readOnly} onClick={() => setValue(r => ({ ...r, product_ids: r.product_ids.filter(x => x !== p.id), products: (r.products ?? []).filter(x => x.id !== p.id) }))}><Icon name="xmark" size={9} /></button></span>)}</p></>}
    </fieldset>
    <fieldset className="fiscal-group"><legend>Usar a seguinte regra de tributação</legend><div className="document-grid">{ruleFields(value.tax, crt, direction).map(([key, label, kind, options]) => <div className="form-field" key={key}>
      {kind === 'check' ? <label htmlFor={`rule-${key}`}><input id={`rule-${key}`} type="checkbox" disabled={readOnly} checked={value.data[key] === true} onChange={event => set(key, event.target.checked)} /> {label}</label>
        : <><label htmlFor={`rule-${key}`}>{label}</label>{kind === 'select' ? <select id={`rule-${key}`} disabled={readOnly} value={String(value.data[key] ?? '')} onChange={event => set(key, event.target.value)}><option value="">Selecione</option>{options!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          : <input id={`rule-${key}`} disabled={readOnly} inputMode={kind === 'rate' ? 'decimal' : undefined} maxLength={kind === 'text' ? 10 : 20} value={String(value.data[key] ?? '')} onChange={event => set(key, kind === 'text' ? event.target.value.toUpperCase() : event.target.value)} />}</>}</div>)}</div></fieldset>
    <div className="form-field"><label htmlFor="rule-additional">Informações complementares</label><textarea id="rule-additional" rows={2} maxLength={2000} disabled={readOnly} value={value.additional_info ?? ''} onChange={event => setValue(r => ({ ...r, additional_info: event.target.value || null }))} /></div>
    <div className="form-field"><label htmlFor="rule-fiscal">Informações adicionais de interesse do fisco</label><textarea id="rule-fiscal" rows={2} maxLength={2000} disabled={readOnly} value={value.fiscal_info ?? ''} onChange={event => setValue(r => ({ ...r, fiscal_info: event.target.value || null }))} /></div>
    {error && <p className="real-alert" role="alert">{error}</p>}
  </Modal>;
}
