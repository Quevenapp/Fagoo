import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { CatalogValidationError } from '../lib/catalog-base';
import { planBatch, summarizeBatch, batchSummaryText, type BatchResult, type BatchStep } from '../lib/origin-batch';
import { badgeClass, selectRange } from '../lib/origin-list';
import {
  APPLICABLE, APPLICABLE_FILTER, CARD_BRANDS, CARD_INTEGRATIONS, DESTINATIONS, DESTINATION_LABEL, FEE_TYPES, PAYMENT_DEFAULT_LABELS, PAYMENT_TYPES, TYPE_HELP, TYPE_LABEL, defaultMenu, paymentForm, paymentPayload, sectionsOf,
  type Account, type PaymentDefaultAction, type PaymentForm, type PaymentMethod,
} from '../lib/payment-method-model';
import { useUnsavedForm } from '../hooks/useUnsavedChanges';
import NativeListLayout from './NativeListLayout';
import { AppliedChips, OriginPagination, ListControls, RowMenu, ToolButton } from './OriginList';
import { BatchDialog } from './BatchDialog';
import { Icon } from './Icon';
import { CONFLICT_TEXT, aborted, errorText, knownFailure } from './catalog-shared';
import { contactRefusalText } from './contact-errors';
import './contacts.css';

// Formas de pagamento usadas pelos documentos e títulos. Máquinas POS dependem de integração externa.
type Page = { items: PaymentMethod[]; page: number; size: number; total: number; can_write: boolean; accounts: Account[] };
const NO_SELECTION: ReadonlySet<string> = new Set();
const PAYMENT_USAGE = 'As formas cadastradas ficam disponíveis nos documentos e títulos, conforme sua aplicação e situação. A seleção não confirma recebimento nem executa uma transação bancária.';

export default function RealPaymentMethods({ controller }: { controller: AccessController }) {
  const [editing, setEditing] = useState<{ item: PaymentMethod | null; copy?: PaymentForm } | null>(null), [notice, setNotice] = useState('');
  const [filters, setFilters] = useState({ applicable: '', account: '', situation: 'active' }), [draft, setDraft] = useState(filters), [query, setQuery] = useState(''), [queryDraft, setQueryDraft] = useState('');
  const [pageNumber, setPageNumber] = useState(1), [reload, setReload] = useState(0), [page, setPage] = useState<Page | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [selection, setSelection] = useState<{ ids: ReadonlySet<string>; anchor: string | null }>({ ids: NO_SELECTION, anchor: null }), [rowMenu, setRowMenu] = useState<string | null>(null);
  const [batch, setBatch] = useState<{ action: 'delete' | PaymentDefaultAction | 'activate' | 'inactivate'; items: PaymentMethod[] } | null>(null);
  const batchSignal = useRef<AbortController | null>(null), actor = useRef(controller.getSnapshot().membership?.user_id);
  const key = JSON.stringify([filters, query]);
  useEffect(() => { setPageNumber(1); }, [key]);
  useEffect(() => {
    if (editing) return;
    const request = new AbortController(); setLoading(true); setError(''); setSelection({ ids: NO_SELECTION, anchor: null });
    const params = new URLSearchParams({ page: String(pageNumber), size: '100' });
    if (filters.applicable) params.set('applicable', filters.applicable); if (filters.account) params.set('account_id', filters.account); if (filters.situation !== 'active') params.set('situation', filters.situation); if (query) params.set('q', query);
    void controller.catalog(`/v1/cadastros/formas-pagamento?${params}`, { signal: request.signal }).then(value => {
      if (request.signal.aborted) return; const result = value as Page;
      if (!Array.isArray(result.items) || result.page !== pageNumber) throw new AccessError(502); setPage(result); setLoading(false);
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) { setError(errorText(failure)); setLoading(false); } });
    return () => request.abort();
  }, [controller, key, pageNumber, reload, editing]);
  useEffect(() => () => batchSignal.current?.abort(), []);
  const writable = Boolean(page?.can_write), ids = page?.items.map(item => item.id) ?? [], selectedItems = page?.items.filter(item => selection.ids.has(item.id)) ?? [];
  const all = ids.length > 0 && ids.every(id => selection.ids.has(id));
  const start = (action: 'delete' | PaymentDefaultAction | 'activate' | 'inactivate', items: PaymentMethod[]) => { setRowMenu(null); batchSignal.current = new AbortController(); setBatch({ action, items }); };
  const run = async (item: PaymentMethod): Promise<BatchStep> => {
    const signal = batchSignal.current?.signal;
    if (!signal || signal.aborted || controller.getSnapshot().membership?.user_id !== actor.current) throw new Error('A sessão mudou durante a operação. Esta forma não foi enviada.');
    const body = { command_id: crypto.randomUUID(), expected_version: item.version, action: batch!.action };
    const send = async () => { const result = await controller.catalog(`/v1/cadastros/formas-pagamento/${item.id}/acao`, { method: 'POST', body, signal }) as { id?: string }; if (result.id !== item.id) throw new AccessError(502); };
    try { await send(); return; } catch (failure) {
      if (!aborted(failure) && knownFailure(failure)) throw new Error(contactRefusalText(failure) ?? errorText(failure));
      try { if (!signal.aborted) { await send(); return { message: 'Confirmado ao repetir a mesma operação.' }; } } catch { /* Still unknown. */ }
      return { uncertain: true, message: 'Não foi possível confirmar o resultado. Atualize a listagem antes de repetir.' };
    }
  };
  if (editing) return <PaymentMethodEditor key={`${editing.item?.id ?? 'new'}:${editing.item?.version ?? 0}`} controller={controller} item={editing.item} copy={editing.copy} accounts={page?.accounts ?? []} writable={writable || !page} onClose={() => setEditing(null)} onSaved={saved => { setNotice('Forma de pagamento salva.'); setEditing({ item: saved }); setReload(n => n + 1); }} />;
  const chips = [...(filters.situation !== 'all' ? [{ label: `Situação: ${filters.situation === 'active' ? 'Ativa' : 'Inativa'}`, onRemove: () => { setFilters(f => ({ ...f, situation: 'all' })); setDraft(f => ({ ...f, situation: 'all' })); } }] : []),
    ...(filters.applicable ? [{ label: `Método aplicável: ${APPLICABLE_FILTER.find(([v]) => v === filters.applicable)?.[1]}`, onRemove: () => { setFilters(f => ({ ...f, applicable: '' })); setDraft(f => ({ ...f, applicable: '' })); } }] : []),
    ...(filters.account ? [{ label: `Conta financeira: ${page?.accounts.find(a => a.id === filters.account)?.name ?? ''}`, onRemove: () => { setFilters(f => ({ ...f, account: '' })); setDraft(f => ({ ...f, account: '' })); } }] : []),
    ...(query ? [{ label: `Pesquisa: ${query}`, onRemove: () => { setQuery(''); setQueryDraft(''); } }] : [])];
  const apply = (event: FormEvent) => { event.preventDefault(); setFilters(draft); setQuery(queryDraft.trim()); };
  const label = { delete: 'Excluir formas de pagamento selecionadas', ...PAYMENT_DEFAULT_LABELS, activate: 'Ativar', inactivate: 'Inativar' } as const;
  return <section className="contact-aux">
    <header className="real-heading catalog-heading"><div className="catalog-title"><h1>Formas de pagamento</h1></div>
      <div className="catalog-heading-actions">{page && !writable && <span className="real-mode">Somente consulta</span>}{writable && <button type="button" className="primary-button" onClick={() => setEditing({ item: null })}><Icon name="plus" size={12} />Incluir forma</button>}</div></header>
    <div className="contact-tabs" role="tablist"><button type="button" role="tab" aria-selected>Formas de Pagamento</button><button type="button" role="tab" aria-selected={false} disabled title="Máquinas POS dependem de integração com a credenciadora, que o FAGOO ainda não tem.">Máquinas POS</button></div>
    <p className="real-help">{PAYMENT_USAGE}</p>
    {notice && <p className="real-success" role="status">{notice}</p>}
    {error && <p className="real-alert" role="alert">{error}<button type="button" className="text-button" onClick={() => setReload(n => n + 1)}>Tentar novamente</button></p>}
    <form onSubmit={apply} aria-label="Filtros das formas de pagamento"><NativeListLayout filters={<>
      <div className="form-field"><label htmlFor="payment-applicable-filter">Método aplicável</label><select id="payment-applicable-filter" value={draft.applicable} onChange={event => setDraft(f => ({ ...f, applicable: event.target.value }))}>{APPLICABLE_FILTER.map(([v, l]) => <option key={v || 'all'} value={v}>{l}</option>)}</select></div>
      <div className="form-field"><label htmlFor="payment-account-filter">Conta financeira</label><select id="payment-account-filter" value={draft.account} onChange={event => setDraft(f => ({ ...f, account: event.target.value }))}><option value="">Todas</option>{(page?.accounts ?? []).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
      <div className="form-field"><label htmlFor="payment-situation-filter">Situação</label><select id="payment-situation-filter" value={draft.situation} onChange={event => setDraft(f => ({ ...f, situation: event.target.value }))}><option value="active">Ativa</option><option value="inactive">Inativa</option><option value="all">Todas</option></select></div>
      <button type="submit" className="primary-button">Filtrar</button></>} actions={<div className="native-list-summary"><h3>Informações</h3><dl className="native-list-stat"><dt>Quantidade de formas de pagamento</dt><dd>{page ? page.total : '—'}</dd></dl></div>}>
      <div className="native-list-toolbar"><div className="form-field"><label htmlFor="payment-search">Pesquisar</label><input id="payment-search" type="search" maxLength={120} placeholder="Pesquisar" value={queryDraft} onChange={event => setQueryDraft(event.target.value)} /></div>
        <button type="submit" className="secondary-button" title="Pesquisar" aria-label="Pesquisar"><Icon name="magnifying-glass" size={14} /></button>
        {writable && <span className={`contact-trash${selectedItems.length ? ' is-armed' : ''}`}><ToolButton icon="trash-can" title="Excluir formas de pagamento selecionadas" disabled={!selectedItems.length} onClick={() => start('delete', selectedItems)} /></span>}</div>
      <AppliedChips chips={chips} onClear={() => { const cleared = { applicable: '', account: '', situation: 'all' }; setFilters(cleared); setDraft(cleared); setQuery(''); setQueryDraft(''); }} />
      <div className="catalog-list-controls">{writable ? <ListControls checked={all} indeterminate={!all && selectedItems.length > 0} onToggleAll={() => setSelection({ ids: all ? NO_SELECTION : new Set(ids), anchor: null })} onRefresh={() => setReload(n => n + 1)} />
        : <button type="button" className="origin-refresh" title="Recarregar" aria-label="Recarregar" onClick={() => setReload(n => n + 1)}><Icon name="rotate-right" size={12} /></button>}
        <div className="real-result-status" role="status">{loading ? 'Carregando formas de pagamento…' : ''}</div></div>
      {page && <><div className="table-scroll"><table className="data-table real-table origin-table contact-aux-table"><thead><tr>{writable && <th scope="col" className="checkbox-cell"><span className="real-sr-only">Seleção</span></th>}
        <th scope="col">Descrição</th><th scope="col">Tipo de pagamento</th><th scope="col">Destino</th><th scope="col">Conta financeira</th><th scope="col">Aplicável à</th><th scope="col">Situação</th><th scope="col"><span className="real-sr-only">Marcador</span></th><th scope="col" className="row-actions"><span className="real-sr-only">Ações</span></th></tr></thead>
        <tbody>{page.items.map(item => <tr key={item.id} onClick={() => setEditing({ item })}>
          {writable && <td className="checkbox-cell" onClick={event => event.stopPropagation()}><input type="checkbox" aria-label={`Selecionar ${item.description}`} checked={selection.ids.has(item.id)} onClick={event => { const result = selectRange(ids, selection.ids, selection.anchor, item.id, event.shiftKey); setSelection({ ids: result.selected, anchor: result.anchor }); }} onChange={() => undefined} /></td>}
          <td><button type="button" className="text-button record-link" onClick={event => { event.stopPropagation?.(); setEditing({ item }); }}>{item.description}</button></td><td>{TYPE_LABEL[item.payment_type] ?? item.payment_type}</td><td>{DESTINATION_LABEL[item.destination]}</td>
          <td>{item.destination === 'ficha' ? '-' : item.account_name ?? '—'}</td>
          <td><span className="contact-badges">{item.applicable !== 'recebimentos' && <span className="contact-dollar-pay" title="Pagamento" role="img" aria-label="Pagamento"><Icon name="dollar-sign" size={12} /></span>}{item.applicable !== 'pagamentos' && <span className="contact-dollar-receive" title="Recebimento" role="img" aria-label="Recebimento"><Icon name="dollar-sign" size={12} /></span>}</span></td>
          <td><span className={badgeClass(item.active ? 'Ativa' : 'Inativa')}>{item.active ? 'Ativa' : 'Inativa'}</span></td>
          {/* 371: the default of each purpose; the devolução indicator only when it is set. */}
          <td><span className="contact-badges">{item.default_receipt && <span title="Forma padrão de recebimentos" role="img" aria-label="Forma padrão de recebimentos"><Icon name="check" size={12} /></span>}
            {item.default_payment && <span title="Forma padrão de pagamentos" role="img" aria-label="Forma padrão de pagamentos" className="contact-dollar-pay"><Icon name="check" size={12} /></span>}
            {item.default_return && <span title="Forma padrão devolução" role="img" aria-label="Forma padrão devolução"><Icon name="hand-holding-dollar" size={12} /></span>}</span></td>
          <td className="row-actions" onClick={event => event.stopPropagation()}><RowMenu label={item.description} open={rowMenu === item.id} onToggle={() => setRowMenu(rowMenu === item.id ? null : item.id)} items={writable ? [
            ...defaultMenu(item).map(entry => ({ ...entry, onClick: () => start(entry.action, [item]) })),
            { label: 'Duplicar', icon: 'copy', onClick: () => setEditing({ item: null, copy: paymentForm(item) }) },
            { label: item.active ? 'Inativar' : 'Ativar', icon: item.active ? 'ban' : 'check', onClick: () => start(item.active ? 'inactivate' : 'activate', [item]) }] : [{ label: 'Visualizar', icon: 'eye', onClick: () => setEditing({ item }) }]} /></td></tr>)}</tbody></table></div>
        {!page.items.length && <div className="origin-empty"><span><Icon name="exclamation" size={22} /></span><h2>Nenhuma forma de pagamento encontrada</h2><p>{writable ? 'Inclua uma forma de pagamento ou ajuste os filtros.' : 'Ajuste os filtros.'}</p></div>}
        {page.total > 0 && <OriginPagination page={page.page} pages={Math.max(1, Math.ceil(page.total / page.size))} size={page.size} total={page.total} onPage={setPageNumber} />}</>}
    </NativeListLayout></form>
    {batch && <BatchDialog title={label[batch.action]} plan={planBatch(batch.items.map(item => ({ ...item, label: item.description })), item => batch.action === 'activate' && item.active ? 'Já está ativa.' : batch.action === 'inactivate' && !item.active ? 'Já está inativa.' : null)}
      confirmLabel={batch.action === 'delete' ? 'Excluir' : batch.action.startsWith('default') ? 'Tornar padrão' : batch.action === 'clear_devolucoes' ? 'Remover' : label[batch.action]} run={run}
      description={batch.action === 'delete' ? <p>As formas excluídas saem das listagens; o registro fica na auditoria.</p> : batch.action.startsWith('default') ? <p>A forma padrão anterior desta finalidade deixa de ser padrão na mesma operação.</p> : undefined}
      onClose={(results: BatchResult[] | null) => { setBatch(null); batchSignal.current = null; if (results) { setNotice(`${label[batch.action]}: ${batchSummaryText(summarizeBatch(results))}.`); setReload(n => n + 1); } }} />}
  </section>;
}

function PaymentMethodEditor({ controller, item, copy, accounts, writable, onClose, onSaved }: { controller: AccessController; item: PaymentMethod | null; copy?: PaymentForm; accounts: readonly Account[]; writable: boolean; onClose: () => void; onSaved: (item: PaymentMethod) => void }) {
  const [form, setForm] = useState<PaymentForm>(() => copy ?? paymentForm(item)), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(''), [invalid, setInvalid] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null), command = useRef<{ id: string; body: Record<string, unknown>; uncertain: boolean } | null>(null), actor = useRef(controller.getSnapshot().membership?.user_id);
  const guard = useUnsavedForm(form, busy || uncertain);
  useEffect(() => () => pending.current?.abort(), []);
  const sections = sectionsOf(form.payment_type), locked = !writable || busy || uncertain;
  const set = <K extends keyof PaymentForm>(key: K, value: PaymentForm[K]) => { setForm(current => ({ ...current, [key]: value })); if (key === invalid) { setInvalid(null); setError(''); } };
  const execute = async () => {
    if (!command.current || pending.current) return;
    const current = command.current, request = new AbortController(); pending.current = request; setBusy(true); setError('');
    try {
      const result = await controller.catalog(`/v1/cadastros/formas-pagamento${item ? `/${item.id}` : ''}`, { method: item ? 'PATCH' : 'POST', body: { ...current.body, command_id: current.id }, signal: request.signal }) as { item?: PaymentMethod };
      if (request.signal.aborted || controller.getSnapshot().membership?.user_id !== actor.current) return;
      if (!result.item?.id) throw new AccessError(502);
      command.current = null; setUncertain(false); onSaved(result.item);
    } catch (failure) {
      if (request.signal.aborted || aborted(failure)) return;
      const known = !current.uncertain && failure instanceof AccessError && [400, 403, 404, 409].includes(failure.status);
      if (!known) current.uncertain = true; else command.current = null;
      setUncertain(!known); setError(known ? contactRefusalText(failure) ?? ((failure as AccessError).status === 409 ? CONFLICT_TEXT : errorText(failure)) : 'Não foi possível confirmar o resultado. Use “Conferir resultado” para repetir a mesma operação sem duplicar a forma.');
    } finally { if (pending.current === request) { pending.current = null; setBusy(false); } }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault(); if (locked) return;
    try { const data = paymentPayload(form); command.current = { id: crypto.randomUUID(), body: { data, ...(item ? { expected_version: item.version } : {}) }, uncertain: false }; void execute(); }
    catch (failure) { if (failure instanceof CatalogValidationError) { setInvalid(failure.field); setError(failure.message); } else throw failure; }
  };
  const text = (key: keyof PaymentForm, label: string, max: number, extra: { hint?: string; inputMode?: 'decimal' | 'numeric' } = {}) => <div className="form-field" key={key}><label htmlFor={`payment-${key}`}>{label}</label>
    <input id={`payment-${key}`} maxLength={max} inputMode={extra.inputMode} value={form[key] as string} title={extra.hint} aria-invalid={invalid === key || undefined} onChange={event => set(key, event.target.value as never)} />{extra.hint && <small>{extra.hint}</small>}</div>;
  return <section className="real-editor catalog-editor contact-editor" aria-labelledby="payment-title">
    <header className="real-editor-heading catalog-editor-heading"><div className="catalog-editor-title"><h2 id="payment-title">Forma de pagamento</h2>{item && <span className={badgeClass(item.active ? 'Ativa' : 'Inativa')}>{item.active ? 'Ativa' : 'Inativa'}</span>}{!writable && <span className="real-mode">Somente consulta</span>}</div>
      <div className="catalog-editor-buttons"><button type="button" className="secondary-button" disabled={busy} onClick={() => guard.confirmLeave(onClose)}>{writable ? 'Cancelar' : 'Voltar'}</button>{writable && <button type="submit" form="payment-form" className="primary-button" disabled={locked}>{busy ? 'Salvando…' : 'Salvar'}</button>}</div></header>
    <p className="real-help">{PAYMENT_USAGE}</p>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {uncertain && <div className="real-editor-actions"><button type="button" className="primary-button" disabled={busy} onClick={() => void execute()}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button></div>}
    <form id="payment-form" onSubmit={submit}><fieldset disabled={locked} className="contact-form">
      <section className="contact-section"><h3 className="catalog-group-title">Informações gerais</h3><div className="contact-grid">
        {text('description', 'Descrição', 100)}
        <div className="form-field"><label htmlFor="payment-payment_type">Tipo de pagamento<span className="contact-hint" title={TYPE_HELP} aria-hidden="true"><Icon name="circle-info" size={10} /></span></label><select id="payment-payment_type" value={form.payment_type} onChange={event => set('payment_type', event.target.value)}>{PAYMENT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        {text('condition', 'Condição', 100, { hint: 'Número de parcelas ou prazos. Exemplo: 30 60 90 ou 3x ou 15 + 2x' })}
        <div className="form-field"><label htmlFor="payment-destination">Enviar para</label><select id="payment-destination" value={form.destination} onChange={event => set('destination', event.target.value)}>{DESTINATIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        {form.destination !== 'ficha' && <div className="form-field"><label htmlFor="payment-account_id">Conta financeira</label><select id="payment-account_id" title="Conta financeira do dinheiro" value={form.account_id} onChange={event => set('account_id', event.target.value)}><option value="">Selecione</option>
          {form.account_id && !accounts.some(a => a.id === form.account_id) && <option value={form.account_id}>{item?.account_name ?? 'Conta atual'}</option>}{accounts.filter(a => a.active || a.id === form.account_id).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>}
        <label className="contact-switch"><input type="checkbox" role="switch" checked={form.business_days} onChange={event => set('business_days', event.target.checked)} />Lançamento em dias úteis</label>
        <fieldset className="contact-radio real-field-wide"><legend>Aplicável à</legend>{APPLICABLE.map(([v, l]) => <label key={v}><input type="radio" name="payment-applicable" checked={form.applicable === v} onChange={() => set('applicable', v)} />{l}</label>)}</fieldset></div></section>
      {sections.boleto && <section className="contact-section"><h3 className="catalog-group-title">Juros e multas</h3><div className="contact-grid">
        {text('interest_rate', 'Juros mensal (%)', 9, { inputMode: 'decimal' })}{text('fine_rate', 'Multa (%)', 9, { inputMode: 'decimal' })}
        <p className="real-help real-field-wide">Juros e multas valem só para o cálculo automático de recebimentos; os de pagamentos são informados na conta a pagar.</p></div></section>}
      {sections.card && <section className="contact-section"><h3 className="catalog-group-title">Informações de cartão</h3><div className="contact-grid">
        <div className="form-field"><label htmlFor="payment-card_brand">Bandeira</label><select id="payment-card_brand" value={form.card_brand} onChange={event => set('card_brand', event.target.value)}><option value="">Selecione</option>{CARD_BRANDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        <div className="form-field"><label htmlFor="payment-card_integration">Tipo de integração</label><select id="payment-card_integration" value={form.card_integration} onChange={event => set('card_integration', event.target.value)}><option value="">Selecione</option>{CARD_INTEGRATIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        {text('card_cnpj', 'CNPJ credenciadora', 20)}
        <label className="contact-switch"><input type="checkbox" role="switch" checked={form.auto_settle} onChange={event => set('auto_settle', event.target.checked)} />Liquidação automática dos recebíveis</label>
        <p className="contact-not-applied real-field-wide">Guardado. A liquidação automática depende dos títulos com forma de pagamento (área financeiro) e ainda não baixa nada.</p></div></section>}
      {sections.pix && <section className="contact-section"><h3 className="catalog-group-title">Informações de PIX</h3><div className="contact-grid">
        <div className="form-field"><label htmlFor="payment-pix_integration">Tipo de integração</label><select id="payment-pix_integration" value="sem" disabled title="A integração de Pix com banco está fora do escopo do FAGOO."><option value="sem">Sem integração</option></select></div>
        {text('pix_cnpj', 'CNPJ da instituição de pagamento responsável', 20)}</div></section>}
      <section className="contact-section"><h3 className="catalog-group-title">Informações de taxas</h3><div className="contact-grid">
        <fieldset className="contact-radio real-field-wide"><legend>Tipo da taxa</legend>{FEE_TYPES.map(([v, l]) => <label key={v}><input type="radio" name="payment-fee-type" checked={form.fee_type === v} onChange={() => set('fee_type', v)} />{l}</label>)}</fieldset>
        {form.fee_type !== 'fixa' && text('fee_rate', 'Valor alíquota (%)', 9, { inputMode: 'decimal', hint: 'Alíquota sobre o valor da parcela' })}
        {form.fee_type !== 'aliquota' && text('fee_fixed', 'Valor fixo (R$)', 20, { inputMode: 'decimal' })}
        {text('settlement_days', 'Prazo de recebimento (dias)', 3, { inputMode: 'numeric', hint: 'Dias em que o dinheiro fica retido antes de ficar disponível' })}
        <p className="real-help real-field-wide"><a href="/financeiro-empresa?area=categories" target="_blank" rel="noopener noreferrer">Categorização dos valores de taxas</a></p>
        <p className="real-help real-field-wide">As taxas não se aplicam a baixas por leitura de retorno nem a baixas por integração.</p></div></section>
    </fieldset></form>
  </section>;
}
