import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AccessError, type AccessController } from '../lib/real-access';
import { CatalogValidationError } from '../lib/catalog-base';
import { planBatch, summarizeBatch, batchSummaryText, type BatchResult, type BatchStep } from '../lib/origin-batch';
import { selectRange } from '../lib/origin-list';
import { FORM_SITUATION_OPTIONS, PERSON_TYPE_OPTIONS, TAXPAYER_OPTIONS, UF_SELECT, contactFormValues, contactPayload, documentLabel, requiredApplies, requiredFields } from '../lib/contact-form-model';
import { SITUATION_FILTERS, type ContactListItem, type ContactTypes, type SituationFilter } from '../lib/contact-list-model';
import { COMMISSION_RULES, EMPTY_SETTINGS, SELLER_MODULES, WEEK_DAYS, WEEK_DAY_NAMES, sellerRequiredFields, sellerSettingsPayload, type SellerEnvelope } from '../lib/seller-model';
import { useUnsavedForm } from '../hooks/useUnsavedChanges';
import NativeListLayout from './NativeListLayout';
import { AppliedChips, OriginPagination, ListControls, RowMenu, ToolButton } from './OriginList';
import { BatchDialog } from './BatchDialog';
import { ContactTypeTags } from './ContactTypeTags';
import { contactNeedsCheck, warningMessage, type ContactWarning } from './ContactSave';
import { contactRefusalText } from './contact-errors';
import { Icon } from './Icon';
import { CONFLICT_TEXT, aborted, errorText, knownFailure } from './catalog-shared';
import './contacts.css';

// Cadastros > Vendedores (Origin VL-01 a VL-07 e VF-01 a VF-16). A listagem lê os vendedores (contatos com as
// configurações de vendedor); a lixeira exclui o contato do vendedor (situação Excluído, restaurável). O formulário grava
// o contato e o vendedor num comando só. Só o "Usuário do sistema" tem efeito hoje; o restante fica guardado.
type SellerItem = ContactListItem & { seller_id: string; seller_version: number };
type SellerPage = { items: SellerItem[]; page: number; size: number; total: number; can_write: boolean };
const NO_SELECTION: ReadonlySet<string> = new Set();
// Origin VL-04: Todos, the types (system first, no Padrao), Sem tipo definido last.
const TYPE_FILTER = (types: ContactTypes | null) => [{ value: '', label: 'Todos' }, ...(types?.items ?? []).filter(type => type.slug !== 'default').sort((a, b) => Number(b.system) - Number(a.system) || a.position - b.position).map(type => ({ value: type.slug, label: type.label })), { value: 'none', label: 'Sem tipo definido' }];
// The access data of the seller are applied by the documents (164), the access controls (229) and the per-request gate (241).
const ACCESS_APPLIED = 'Aplicado: sem “Permite incluir produtos não cadastrados” o pedido de venda recusa item livre; sem “Permite visualizar informações de estoque” pedidos, propostas e ordens de serviço não mostram o saldo; fora dos horários de acesso (horário de São Paulo) o usuário vinculado não entra nem usa o FAGOO, também em cada operação.';
// 202610200204-206: the Frente de caixa reads the Frente de Caixa module of the vendedor linked to the user (perfil vendas).
const PDV_APPLIED = 'Frente de Caixa: aplicado na frente de caixa ao usuário vinculado (registro de itens e de pagamento, fechamento da venda, preço unitário, exclusão de itens e forma das parcelas; sem o módulo, o vendedor não opera a frente de caixa). O Gerenciador de POS e os demais módulos ficam guardados: o FAGOO ainda não os aplica.';

export default function RealSellers({ controller }: { controller: AccessController }) {
  const [editing, setEditing] = useState<{ id: string | null } | null>(null), [notice, setNotice] = useState('');
  const [types, setTypes] = useState<ContactTypes | null>(null);
  const [situation, setSituation] = useState<SituationFilter>('latest'), [situationDraft, setSituationDraft] = useState<SituationFilter>('latest');
  const [type, setType] = useState(''), [typeDraft, setTypeDraft] = useState(''), [query, setQuery] = useState(''), [queryDraft, setQueryDraft] = useState('');
  const [pageNumber, setPageNumber] = useState(1), [reload, setReload] = useState(0);
  const [page, setPage] = useState<SellerPage | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [selection, setSelection] = useState<{ ids: ReadonlySet<string>; anchor: string | null }>({ ids: NO_SELECTION, anchor: null }), [rowMenu, setRowMenu] = useState<string | null>(null);
  const [batch, setBatch] = useState<{ target: 'E' | 'A'; items: { id: string; label: string; version: number; situation: string }[] } | null>(null);
  const batchSignal = useRef<AbortController | null>(null), actor = useRef(controller.getSnapshot().membership?.user_id);
  const key = JSON.stringify([situation, type, query]);
  useEffect(() => { setPageNumber(1); }, [key]);
  useEffect(() => {
    const request = new AbortController();
    void controller.catalog('/v1/cadastros/tipos-contato', { signal: request.signal }).then(value => { if (!request.signal.aborted && Array.isArray((value as ContactTypes).items)) setTypes(value as ContactTypes); }).catch(() => undefined);
    return () => request.abort();
  }, [controller]);
  useEffect(() => {
    if (editing) return;
    const request = new AbortController(); setLoading(true); setError(''); setSelection({ ids: NO_SELECTION, anchor: null });
    const params = new URLSearchParams({ page: String(pageNumber), size: '100' });
    if (situation !== 'latest') { params.set('situation', situation); params.set('sort', 'name_asc'); }
    if (type) params.set('type', type); if (query) params.set('q', query);
    void controller.catalog(`/v1/cadastros/vendedores?${params}`, { signal: request.signal }).then(value => {
      if (request.signal.aborted) return; const result = value as SellerPage;
      if (!Array.isArray(result.items) || result.page !== pageNumber) throw new AccessError(502);
      setPage(result); setLoading(false);
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) { setError(errorText(failure)); setLoading(false); } });
    return () => request.abort();
  }, [controller, key, pageNumber, reload, editing]);
  useEffect(() => () => batchSignal.current?.abort(), []);
  const writable = Boolean(page?.can_write), excluded = situation === 'E';
  const ids = page?.items.map(item => item.id) ?? [], selectedItems = page?.items.filter(item => selection.ids.has(item.id)) ?? [];
  const all = ids.length > 0 && ids.every(id => selection.ids.has(id));
  const run = async (item: { id: string; version: number }): Promise<BatchStep> => {
    const signal = batchSignal.current?.signal;
    if (!signal || signal.aborted || controller.getSnapshot().membership?.user_id !== actor.current) throw new Error('A sessão mudou durante a operação. Este vendedor não foi enviado.');
    const body = { command_id: crypto.randomUUID(), expected_version: item.version, situation: batch!.target };
    const send = async () => { const result = await controller.catalog(`/v1/cadastros/contatos/${item.id}/situacao`, { method: 'PATCH', body, signal }) as { record?: { id?: string } }; if (result.record?.id !== item.id) throw new AccessError(502); };
    try { await send(); return; } catch (failure) {
      if (!aborted(failure) && knownFailure(failure)) throw new Error(contactRefusalText(failure) ?? errorText(failure));
      try { if (!signal.aborted) { await send(); return { message: 'Confirmado ao repetir a mesma operação.' }; } } catch { /* Still unknown. */ }
      return { uncertain: true, message: 'Não foi possível confirmar o resultado. Atualize a listagem antes de repetir.' };
    }
  };
  if (editing) return <SellerEditor controller={controller} id={editing.id} types={types} onTypes={setTypes} onClose={() => setEditing(null)} onSaved={() => { setNotice('Vendedor salvo.'); setReload(n => n + 1); }} />;
  const chips = [...(situation === 'latest' ? [{ label: 'Exibindo pela ordem de inclusão', onRemove: () => { setSituation('all'); setSituationDraft('all'); } }] : []),
    ...(situation === 'E' ? [{ label: 'Cadastros: Excluídos', onRemove: () => { setSituation('all'); setSituationDraft('all'); } }] : situation !== 'latest' && situation !== 'all' ? [{ label: `Situação: ${SITUATION_FILTERS.find(o => o.value === situation)?.label}`, onRemove: () => { setSituation('all'); setSituationDraft('all'); } }] : []),
    ...(type ? [{ label: `Tipo de cadastro: ${TYPE_FILTER(types).find(o => o.value === type)?.label ?? type}`, onRemove: () => { setType(''); setTypeDraft(''); } }] : []),
    ...(query ? [{ label: `Pesquisa: ${query}`, onRemove: () => { setQuery(''); setQueryDraft(''); } }] : [])];
  const apply = (event: FormEvent) => { event.preventDefault(); setSituation(situationDraft); setType(typeDraft); setQuery(queryDraft.trim()); };
  return <section className="contact-aux">
    <header className="real-heading catalog-heading"><div className="catalog-title"><h1>Vendedores</h1></div>
      <div className="catalog-heading-actions">{page && !writable && <span className="real-mode">Somente consulta</span>}{writable && <button type="button" className="primary-button" onClick={() => setEditing({ id: null })}><Icon name="plus" size={12} />Incluir um Vendedor</button>}</div></header>
    {notice && <p className="real-success" role="status">{notice}</p>}
    {error && <p className="real-alert" role="alert">{error}<button type="button" className="text-button" onClick={() => setReload(n => n + 1)}>Tentar novamente</button></p>}
    <form onSubmit={apply} aria-label="Filtros dos vendedores"><NativeListLayout filters={<>
      <div className="form-field"><label htmlFor="seller-situation-filter">Situação</label><select id="seller-situation-filter" value={situationDraft} onChange={event => setSituationDraft(event.target.value as SituationFilter)}>{SITUATION_FILTERS.map(o => <option key={o.value} value={o.value}>{o.value === 'S' ? 'Sem movimentos' : o.label}</option>)}</select></div>
      <div className="form-field"><label htmlFor="seller-type-filter">Tipo de cadastro</label><select id="seller-type-filter" value={typeDraft} onChange={event => setTypeDraft(event.target.value)}>{TYPE_FILTER(types).map(o => <option key={o.value || 'all'} value={o.value}>{o.label}</option>)}</select></div>
      <button type="submit" className="primary-button">Filtrar</button></>} actions={<>
      <div className="native-list-summary"><h3>Informações</h3><dl className="native-list-stat"><dt>Quantidade de vendedores</dt><dd>{page ? page.total : '—'}</dd></dl>{selectedItems.length > 0 && <dl className="native-list-stat"><dt>Selecionados</dt><dd>{selectedItems.length}</dd></dl>}</div>
      <p className="real-help">Os vendedores são contatos do tipo Vendedor. As configurações de comissão, descontos, módulos e horários ficam guardadas para quando pedidos, propostas e comissões as consultarem.</p></>}>
      <div className="native-list-toolbar"><div className="form-field"><label htmlFor="seller-search">Pesquisar</label><input id="seller-search" type="search" maxLength={120} placeholder="Pesquisar" value={queryDraft} onChange={event => setQueryDraft(event.target.value)} /></div>
        <button type="submit" className="secondary-button" title="Pesquisar" aria-label="Pesquisar"><Icon name="magnifying-glass" size={14} /></button>
        {writable && <span className={`contact-trash${selectedItems.length && !excluded ? ' is-armed' : ''}`}><ToolButton icon={excluded ? 'clock-rotate-left' : 'trash-can'} title={excluded ? 'Restaurar selecionados' : 'Excluir selecionados'} disabled={!selectedItems.length}
          onClick={() => { batchSignal.current = new AbortController(); setBatch({ target: excluded ? 'A' : 'E', items: selectedItems.map(item => ({ id: item.id, label: item.name, version: item.version, situation: item.situation })) }); }} /></span>}</div>
      <AppliedChips chips={chips} onClear={() => { setSituation('all'); setSituationDraft('all'); setType(''); setTypeDraft(''); setQuery(''); setQueryDraft(''); }} />
      <div className="catalog-list-controls">{writable ? <ListControls checked={all} indeterminate={!all && selectedItems.length > 0} onToggleAll={() => setSelection({ ids: all ? NO_SELECTION : new Set(ids), anchor: null })} onRefresh={() => setReload(n => n + 1)} />
        : <button type="button" className="origin-refresh" title="Recarregar" aria-label="Recarregar" onClick={() => setReload(n => n + 1)}><Icon name="rotate-right" size={12} /></button>}
        <div className="real-result-status" role="status">{loading ? 'Carregando vendedores…' : page ? `${page.total} ${page.total === 1 ? 'vendedor' : 'vendedores'}` : ''}</div></div>
      {page && <><div className="table-scroll"><table className="data-table real-table origin-table contact-aux-table"><thead><tr>{writable && <th scope="col" className="checkbox-cell"><span className="real-sr-only">Seleção</span></th>}<th scope="col">Nome</th><th scope="col">Cidade</th><th scope="col">Estado</th><th scope="col" className="row-actions"><span className="real-sr-only">Ações</span></th></tr></thead>
        <tbody>{page.items.map(item => <tr key={item.id} className={item.situation === 'E' ? 'is-excluded' : undefined} onClick={() => setEditing({ id: item.seller_id })}>
          {writable && <td className="checkbox-cell" onClick={event => event.stopPropagation()}><input type="checkbox" aria-label={`Selecionar ${item.name}`} checked={selection.ids.has(item.id)} onClick={event => { const result = selectRange(ids, selection.ids, selection.anchor, item.id, event.shiftKey); setSelection({ ids: result.selected, anchor: result.anchor }); }} onChange={() => undefined} /></td>}
          <td>{item.situation === 'E' && <span className="contact-excluded" title="Cadastro excluído" role="img" aria-label="Cadastro excluído"><Icon name="xmark" size={11} /></span>}<button type="button" className="text-button record-link" onClick={event => { event.stopPropagation?.(); setEditing({ id: item.seller_id }); }}>{item.name}</button></td>
          <td>{item.city || '—'}</td><td>{item.state || '—'}</td>
          <td className="row-actions" onClick={event => event.stopPropagation()}><RowMenu label={item.name} open={rowMenu === item.id} onToggle={() => setRowMenu(rowMenu === item.id ? null : item.id)}
            items={[{ label: writable ? 'Editar' : 'Visualizar', icon: writable ? 'pen-to-square' : 'eye', onClick: () => setEditing({ id: item.seller_id }) }, (['admin', 'consulta', 'financeiro'].includes(controller.getSnapshot().membership?.role ?? '') ? { label: 'Ver Comissões', icon: 'hand-holding-dollar', to: `/financeiro-empresa?area=comissoes&vendedor=${item.seller_id}` } : { label: 'Ver Comissões', icon: 'hand-holding-dollar', disabled: true, title: 'As comissões ficam no Financeiro, que o seu perfil não acessa.' })]} /></td></tr>)}</tbody></table></div>
        {!page.items.length && <div className="origin-empty"><span><Icon name="exclamation" size={22} /></span><h2>Nenhum vendedor encontrado</h2><p>{writable ? 'Inclua um vendedor ou use “Tornar vendedor” na listagem de contatos.' : 'Ajuste a pesquisa.'}</p></div>}
        {page.total > 0 && <OriginPagination page={page.page} pages={Math.max(1, Math.ceil(page.total / page.size))} size={page.size} total={page.total} onPage={setPageNumber} />}</>}
    </NativeListLayout></form>
    {batch && <BatchDialog title={batch.target === 'E' ? 'Excluir selecionados' : 'Restaurar selecionados'} plan={planBatch(batch.items, item => item.situation === batch.target ? 'Já está nessa situação.' : null)} confirmLabel={batch.target === 'E' ? 'Excluir' : 'Restaurar'} run={run}
      onClose={(results: BatchResult[] | null) => { setBatch(null); batchSignal.current = null; if (results) { setNotice(`Vendedores: ${batchSummaryText(summarizeBatch(results))}.`); setReload(n => n + 1); } }} />}
  </section>;
}

type Draft = { values: Record<string, string>; types: string[]; settings: { user_id: string; allow_unregistered_products: boolean; view_stock: boolean; access_hours_enabled: boolean; windows: { start: string; end: string; days: number[] }[];
  modules: Record<string, boolean>; commission_rule: string; commission_mode: string; commission_rate: string; bands: { discount_up_to: string; rate: string }[]; discount_limit: string; notes: string } };
const draftOf = (envelope: SellerEnvelope | null): Draft => {
  const settings = envelope?.seller ?? EMPTY_SETTINGS;
  return { values: contactFormValues(envelope?.contact ?? null), types: envelope?.contact.types ?? ['seller'],
    settings: { user_id: settings.user_id ?? '', allow_unregistered_products: settings.allow_unregistered_products, view_stock: settings.view_stock, access_hours_enabled: settings.access_hours_enabled,
      windows: settings.access_windows.map(row => ({ ...row, days: [...row.days] })), modules: { ...settings.modules }, commission_rule: settings.commission_rule, commission_mode: settings.commission_mode,
      commission_rate: settings.commission_rate ? settings.commission_rate.replace(/\.?0+$/, '').replace('.', ',') : '', bands: settings.commission_bands.map(band => ({ discount_up_to: band.discount_up_to.replace(/\.?0+$/, '').replace('.', ','), rate: band.rate.replace(/\.?0+$/, '').replace('.', ',') })),
      discount_limit: settings.discount_limit.replace(/\.?0+$/, '').replace('.', ',') || '0', notes: settings.notes ?? '' } };
};

function SellerEditor({ controller, id, types, onTypes, onClose, onSaved }: { controller: AccessController; id: string | null; types: ContactTypes | null; onTypes: (types: ContactTypes) => void; onClose: () => void; onSaved: () => void }) {
  const [envelope, setEnvelope] = useState<SellerEnvelope | null>(null), [users, setUsers] = useState<{ user_id: string; name: string | null }[]>([]), [loadError, setLoadError] = useState(''), [savedNote, setSavedNote] = useState('');
  const load = (sellerId: string, signal: AbortSignal) => controller.catalog(`/v1/cadastros/vendedores/${sellerId}`, { signal }).then(value => {
    const result = value as SellerEnvelope; if (signal.aborted) return; if (result.seller?.id !== sellerId) throw new AccessError(502);
    setEnvelope(result); setUsers(result.users ?? []);
  });
  useEffect(() => {
    const request = new AbortController();
    if (id) void load(id, request.signal).catch(failure => { if (!request.signal.aborted && !aborted(failure)) setLoadError(errorText(failure)); });
    else void controller.catalog('/v1/cadastros/vendedores/opcoes', { signal: request.signal }).then(value => { if (!request.signal.aborted) setUsers((value as { users?: { user_id: string; name: string | null }[] }).users ?? []); }).catch(() => undefined);
    return () => request.abort();
  }, [controller, id]);
  // Preferências › Campos obrigatórios: the server demands those this form shows, so the form marks and checks them first.
  const [required, setRequired] = useState<string[]>([]);
  useEffect(() => {
    const request = new AbortController();
    void Promise.resolve().then(() => controller.preferences('/v1/preferencias/cadastros-contatos', { signal: request.signal })).then(value => {
      if (request.signal.aborted) return; const options = (value as { items?: { key: string; value: unknown }[] }).items?.find(item => item.key === 'contatos.campos_obrigatorios')?.value;
      setRequired(Array.isArray(options) ? sellerRequiredFields(requiredFields(options.filter((option): option is string => typeof option === 'string'))) : []);
    }).catch(() => undefined);
    return () => request.abort();
  }, [controller]);
  if (id && !envelope) return <section className="real-editor"><h2>Vendedor</h2>{loadError ? <p className="real-alert" role="alert">{loadError}<button type="button" className="text-button" onClick={onClose}>Voltar à listagem</button></p> : <p role="status">Carregando vendedor…</p>}</section>;
  // Each saved version remounts the form, so its unsaved-changes baseline is what the server returned.
  return <SellerForm key={envelope ? `${envelope.seller.id}:${envelope.seller.version}:${envelope.contact.version}` : 'new'} controller={controller} envelope={envelope} users={users} types={types} onTypes={onTypes} onClose={onClose} savedNote={savedNote} required={required}
    onSaved={sellerId => { setSavedNote('Vendedor salvo.'); onSaved(); const request = new AbortController(); void load(sellerId, request.signal).catch(failure => { if (!aborted(failure)) setLoadError(errorText(failure)); }); }} />;
}

function SellerForm({ controller, envelope, users, types, onTypes, onClose, onSaved, savedNote, required }: { controller: AccessController; envelope: SellerEnvelope | null; users: { user_id: string; name: string | null }[]; types: ContactTypes | null;
  onTypes: (types: ContactTypes) => void; onClose: () => void; onSaved: (sellerId: string) => void; savedNote: string; required: readonly string[] }) {
  const canWrite = envelope ? Boolean(envelope.can_write) : true;
  const [draft, setDraft] = useState<Draft>(() => draftOf(envelope));
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(''), [warnings, setWarnings] = useState<ContactWarning[] | null>(null);
  const pending = useRef<AbortController | null>(null), command = useRef<{ id: string; body: Record<string, unknown>; path: string; method: 'POST' | 'PATCH'; uncertain: boolean } | null>(null), actor = useRef(controller.getSnapshot().membership?.user_id);
  const guard = useUnsavedForm(draft, busy || uncertain);
  useEffect(() => () => pending.current?.abort(), []);
  const values = draft.values, s = draft.settings, person = values.person_type ?? '', excluded = envelope?.contact.situation === 'E';
  const locked = !canWrite || busy || uncertain || excluded;
  const set = (change: (current: Draft) => Draft) => { setDraft(current => change(current)); setWarnings(null); setError(''); };
  const value = (key: string, next: string) => set(current => ({ ...current, values: { ...current.values, [key]: next } }));
  const setting = <K extends keyof Draft['settings']>(key: K, next: Draft['settings'][K]) => set(current => ({ ...current, settings: { ...current.settings, [key]: next } }));
  const isRequired = (key: string) => key === 'name' || (required.includes(key) && requiredApplies(key, values));
  const input = (key: string, label: string, max: number, extra: { type?: string; hint?: string } = {}) => <div className="form-field" key={key}><label htmlFor={`seller-${key}`}>{label}{isRequired(key) ? ' *' : ''}</label>
    <input id={`seller-${key}`} type={extra.type ?? 'text'} maxLength={max} value={values[key] ?? ''} placeholder={extra.hint} title={extra.hint} onChange={event => value(key, event.target.value)} /></div>;
  const execute = async () => {
    if (!command.current || pending.current) return;
    const current = command.current, request = new AbortController(); pending.current = request; setBusy(true); setError('');
    try {
      const result = await controller.catalog(current.path, { method: current.method, body: { ...current.body, command_id: current.id }, signal: request.signal }) as SellerEnvelope;
      if (request.signal.aborted || controller.getSnapshot().membership?.user_id !== actor.current) return;
      if (!result.seller?.id) throw new AccessError(502);
      command.current = null; setUncertain(false); onSaved(result.seller.id);
    } catch (failure) {
      if (request.signal.aborted || aborted(failure)) return;
      const known = !current.uncertain && failure instanceof AccessError && [400, 403, 404, 409].includes(failure.status);
      if (!known) current.uncertain = true; else command.current = null;
      setUncertain(!known); setError(known ? contactRefusalText(failure) ?? ((failure as AccessError).status === 409 ? CONFLICT_TEXT : errorText(failure)) : 'Não foi possível confirmar o resultado. Use “Conferir resultado” para repetir a mesma operação sem duplicar o vendedor.');
    } finally { if (pending.current === request) { pending.current = null; setBusy(false); } }
  };
  const submit = async (event?: FormEvent, acknowledged?: string[]) => {
    event?.preventDefault(); if (locked) return;
    let contact: Record<string, unknown>, settings;
    try {
      contact = contactPayload(values, draft.types, envelope?.contact.persons.map(p => p.id) ?? [], { previous: envelope?.contact ?? null, required });
      settings = sellerSettingsPayload({ ...s });
    } catch (failure) { if (failure instanceof CatalogValidationError) { setError(failure.message); return; } throw failure; }
    const body: Record<string, unknown> = { contact, settings, ...(envelope ? { expected_version: envelope.seller.version, contact_expected_version: envelope.contact.version } : {}), ...(acknowledged ? { acknowledged_warnings: acknowledged } : {}) };
    // A new or changed CPF/CNPJ, or a CPF/CNPJ whose Tipo da Pessoa changed, is checked first, as in the contact form.
    if (!acknowledged && contactNeedsCheck(contact, envelope?.contact ?? null)) {
      setBusy(true);
      try {
        const checked = await controller.catalog('/v1/cadastros/contatos/conferir', { method: 'POST', body: { id: envelope?.contact.id ?? null, data: contact } }) as { warnings?: ContactWarning[] };
        if (checked.warnings?.length) { setWarnings(checked.warnings); return; }
      } catch (failure) { setError(contactRefusalText(failure) ?? errorText(failure)); return; } finally { setBusy(false); }
      body.acknowledged_warnings = [];
    }
    command.current = { id: crypto.randomUUID(), body, path: `/v1/cadastros/vendedores${envelope ? `/${envelope.seller.id}` : ''}`, method: envelope ? 'PATCH' : 'POST', uncertain: false };
    void execute();
  };
  const moduleBox = (module: typeof SELLER_MODULES[number]) => <div className="contact-module-box" key={module.key}>
    <label><input type="checkbox" checked={Boolean(s.modules[module.key])} onChange={event => setting('modules', { ...s.modules, [module.key]: event.target.checked, ...Object.fromEntries((module.children ?? []).map(child => [child.key, event.target.checked && Boolean(s.modules[child.key])])) })} />{module.label}</label>
    {module.children && <div className="contact-sub">{module.children.map(child => <label key={child.key}><input type="checkbox" checked={Boolean(s.modules[child.key])} disabled={!s.modules[module.key]} onChange={event => setting('modules', { ...s.modules, [child.key]: event.target.checked })} />{child.label}</label>)}</div>}</div>;
  const allModules = SELLER_MODULES.every(module => s.modules[module.key] && (module.children ?? []).every(child => s.modules[child.key]));
  return <section className="real-editor catalog-editor contact-editor" aria-labelledby="seller-title">
    <header className="real-editor-heading catalog-editor-heading"><div className="catalog-editor-title"><h2 id="seller-title">Vendedor</h2>{!canWrite && <span className="real-mode">Somente consulta</span>}</div>
      <div className="catalog-editor-buttons"><button type="button" className="secondary-button" disabled={busy} onClick={() => guard.confirmLeave(onClose)}>{canWrite ? 'Cancelar' : 'Voltar'}</button>{canWrite && !excluded && <button type="submit" form="seller-form" className="primary-button" disabled={locked}>{busy ? 'Salvando…' : 'Salvar'}</button>}</div></header>
    {excluded && <p className="real-alert" role="status">Vendedor excluído. Restaure-o na listagem para editar.</p>}
    {savedNote && <p className="real-success" role="status">{savedNote}</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    {warnings && <div className="catalog-warnings" role="alert"><h3>Confira antes de salvar</h3><ul>{warnings.map(w => <li key={w.code}>{warningMessage(w)}</li>)}</ul><div className="real-editor-actions"><button type="button" className="secondary-button" onClick={() => setWarnings(null)}>Revisar</button>
      {!warnings.some(w => w.blocked) && <button type="button" className="primary-button" onClick={() => { const codes = warnings.map(w => w.code); setWarnings(null); void submit(undefined, codes); }}>Salvar mesmo assim</button>}</div></div>}
    {uncertain && <div className="real-editor-actions"><button type="button" className="primary-button" disabled={busy} onClick={() => void execute()}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button></div>}
    <form id="seller-form" onSubmit={event => void submit(event)}><fieldset disabled={locked} className="contact-form">
      <section className="contact-section"><h3 className="catalog-group-title">Dados do vendedor</h3><div className="contact-grid">
        {input('name', 'Nome', 200, { hint: 'Nome completo do vendedor' })}{input('code', 'Código', 100, { hint: 'Opcional' })}{input('trade_name', 'Fantasia', 200)}
        <div className="form-field"><label htmlFor="seller-person_type">Tipo da Pessoa</label><select id="seller-person_type" value={person} onChange={event => value('person_type', event.target.value)}>{PERSON_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label.replace('Pessoa ', '')}</option>)}</select></div>
        {input('document', documentLabel(person), 30)}
        <div className="form-field"><label htmlFor="seller-taxpayer">Contribuinte</label><select id="seller-taxpayer" value={values.taxpayer ?? '9'} onChange={event => value('taxpayer', event.target.value)}>{TAXPAYER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
        {input('ie', 'Inscrição Estadual', 30)}{person === 'F' && input('rg', 'RG', 20)}{person === 'F' && input('birth_date', 'Data Nascimento', 10, { type: 'date' })}{person === 'E' && input('country', 'País', 60)}
      </div></section>
      <section className="contact-section"><h3 className="catalog-group-title">Endereço</h3><div className="contact-grid">
        {input('postal_code', 'CEP', 20)}<div className="form-field"><label htmlFor="seller-state">UF</label><select id="seller-state" value={values.state ?? ''} onChange={event => value('state', event.target.value)}>{UF_SELECT.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
        {input('city', 'Cidade', 100)}{input('district', 'Bairro', 100)}{input('street', 'Endereço', 200)}{input('number', 'Número', 30)}{input('complement', 'Complemento', 200)}{input('phone', 'Fone', 40)}{input('mobile', 'Celular', 40)}{input('email', 'Email', 254)}
        <ContactTypeTags controller={controller} id="seller-types" types={types?.items ?? []} selected={draft.types} onChange={next => set(current => ({ ...current, types: next.includes('seller') ? next : [...next, 'seller'] }))} onCreated={type => types && onTypes({ ...types, items: [...types.items, type] })} canCreate={Boolean(types?.can_create)} disabled={locked} locked={['seller']} />
      </div></section>
      <section className="contact-section"><h3 className="catalog-group-title">Dados de acesso</h3><div className="contact-grid">
        <div className="form-field"><label htmlFor="seller-situation">Situação</label><select id="seller-situation" value={values.situation} onChange={event => value('situation', event.target.value)}>{FORM_SITUATION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select><small className="real-help">Para Excluído, use a lixeira da listagem.</small></div>
        <div className="form-field"><label htmlFor="seller-user">Usuário do sistema</label><select id="seller-user" value={s.user_id} onChange={event => setting('user_id', event.target.value)}><option value="">Nenhum</option>{s.user_id && !users.some(u => u.user_id === s.user_id) && <option value={s.user_id}>{envelope?.seller.user_name ?? 'Usuário atual'}</option>}{users.map(u => <option key={u.user_id} value={u.user_id}>{u.name ?? u.user_id}</option>)}</select>
          <small className="real-help">Com “Contato acessível somente ao vendedor vinculado” ligado em Preferências, este usuário vê só os contatos deste vendedor e os documentos deles. O login e a senha continuam em Sistema › Usuários.</small></div>
        <label className="contact-switch real-field-wide"><input type="checkbox" checked={s.allow_unregistered_products} onChange={event => setting('allow_unregistered_products', event.target.checked)} />Permite incluir produtos não cadastrados nos pedidos de venda</label>
        <label className="contact-switch real-field-wide"><input type="checkbox" checked={s.view_stock} onChange={event => setting('view_stock', event.target.checked)} />Permite visualizar informações de estoque nos pedidos de venda e ordens de serviço</label>
        <label className="contact-switch real-field-wide"><input type="checkbox" checked={s.access_hours_enabled} onChange={event => setting('access_hours_enabled', event.target.checked)} />Visualizar horários de acesso</label>
        {s.access_hours_enabled && <div className="real-field-wide"><h4>Horários de acesso</h4><table className="contact-windows"><thead><tr><th scope="col">nº</th><th scope="col">Início</th><th scope="col">Fim</th>{WEEK_DAYS.map((day, index) => <th scope="col" key={index} title={WEEK_DAY_NAMES[index]}>{day}</th>)}<th scope="col"><span className="real-sr-only">Excluir</span></th></tr></thead>
          <tbody>{s.windows.map((row, index) => <tr key={index}><td>{index + 1}</td><td><input type="time" aria-label={`Início do horário ${index + 1}`} value={row.start} onChange={event => setting('windows', s.windows.map((w, i) => i === index ? { ...w, start: event.target.value } : w))} /></td>
            <td><input type="time" aria-label={`Fim do horário ${index + 1}`} value={row.end} onChange={event => setting('windows', s.windows.map((w, i) => i === index ? { ...w, end: event.target.value } : w))} /></td>
            {WEEK_DAYS.map((_, day) => <td key={day}><input type="checkbox" aria-label={`${WEEK_DAY_NAMES[day]} no horário ${index + 1}`} checked={row.days.includes(day)} onChange={event => setting('windows', s.windows.map((w, i) => i === index ? { ...w, days: event.target.checked ? [...w.days, day] : w.days.filter(d => d !== day) } : w))} /></td>)}
            <td><button type="button" className="icon-button" aria-label={`Excluir horário ${index + 1}`} onClick={() => setting('windows', s.windows.filter((_, i) => i !== index))}><Icon name="trash-can" size={11} /></button></td></tr>)}</tbody></table>
          {s.windows.length < 20 && <button type="button" className="text-button" onClick={() => setting('windows', [...s.windows, { start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5] }])}><Icon name="plus" size={10} />Adicionar horário</button>}</div>}
        <p className="real-help real-field-wide">{ACCESS_APPLIED}</p>
      </div></section>
      <section className="contact-section"><h3 className="catalog-group-title">Módulos que podem ser acessados pelo vendedor</h3>
        <label className="contact-switch"><input type="checkbox" checked={allModules} onChange={event => setting('modules', event.target.checked ? Object.fromEntries(SELLER_MODULES.flatMap(m => [m.key, ...(m.children ?? []).map(c => c.key)]).map(k => [k, true])) : {})} />Selecionar todos</label>
        <div className="contact-module-grid">{SELLER_MODULES.map(moduleBox)}</div><p className="contact-not-applied">{PDV_APPLIED}</p></section>
      <section className="contact-section"><h3 className="catalog-group-title">Comissionamento</h3><div className="contact-grid">
        <div className="form-field real-field-wide"><label htmlFor="seller-commission_rule">Comissionamento</label><select id="seller-commission_rule" title="Regras para liberação de comissões" value={s.commission_rule} onChange={event => setting('commission_rule', event.target.value)}>{COMMISSION_RULES.map(rule => <option key={rule.value} value={rule.value}>{rule.label}</option>)}</select></div>
        <fieldset className="contact-radio real-field-wide"><legend>Tipo de alíquota</legend><label><input type="radio" name="seller-commission-mode" checked={s.commission_mode === 'fixa'} onChange={() => setting('commission_mode', 'fixa')} />Comissão com alíquota fixa</label>
          <label><input type="radio" name="seller-commission-mode" checked={s.commission_mode === 'descontos'} onChange={() => setting('commission_mode', 'descontos')} />Comissão com alíquota conforme descontos individuais dos itens</label></fieldset>
        {s.commission_mode === 'fixa' ? <div className="form-field"><label htmlFor="seller-commission_rate">Alíquota de comissão (%)</label><input id="seller-commission_rate" inputMode="decimal" maxLength={9} value={s.commission_rate} onChange={event => setting('commission_rate', event.target.value)} /></div>
          : <div className="real-field-wide"><table className="contact-windows"><thead><tr><th scope="col">Desconto de até (%)</th><th scope="col">% Comissão</th><th scope="col"><span className="real-sr-only">Excluir</span></th></tr></thead>
            <tbody>{s.bands.map((band, index) => <tr key={index}><td><input inputMode="decimal" aria-label={`Desconto de até da faixa ${index + 1}`} value={band.discount_up_to} onChange={event => setting('bands', s.bands.map((b, i) => i === index ? { ...b, discount_up_to: event.target.value } : b))} /></td>
              <td><input inputMode="decimal" aria-label={`Comissão da faixa ${index + 1}`} value={band.rate} onChange={event => setting('bands', s.bands.map((b, i) => i === index ? { ...b, rate: event.target.value } : b))} /></td>
              <td><button type="button" className="icon-button" aria-label={`Excluir faixa ${index + 1}`} onClick={() => setting('bands', s.bands.filter((_, i) => i !== index))}><Icon name="trash-can" size={11} /></button></td></tr>)}</tbody></table>
            {s.bands.length < 20 && <button type="button" className="text-button" onClick={() => setting('bands', [...s.bands, { discount_up_to: '', rate: '' }])}><Icon name="plus" size={10} />Adicionar outro desconto</button>}</div>}
        <p className="contact-not-applied real-field-wide">Aplicado em Financeiro &gt; Comissões: cada parcela lançada pelos pedidos e ordens de serviço deste vendedor gera a comissão com a regra, a alíquota e as faixas gravadas no momento do lançamento.</p></div></section>
      <section className="contact-section"><h3 className="catalog-group-title">Descontos</h3><div className="contact-grid">
        <div className="form-field"><label htmlFor="seller-discount_limit">Limite de desconto (%)</label><input id="seller-discount_limit" inputMode="decimal" maxLength={9} value={s.discount_limit} title="Percentagem máxima que este vendedor pode ceder como desconto, 0 para sem limite." onChange={event => setting('discount_limit', event.target.value)} />
          <small>Percentagem máxima que este vendedor pode ceder como desconto, 0 para sem limite.</small></div>
        <p className="contact-not-applied real-field-wide">Guardado. Pedidos, propostas e OS ainda não conferem este limite.</p></div></section>
      <section className="contact-section"><h3 className="catalog-group-title">Observações</h3><div className="form-field real-field-wide"><label htmlFor="seller-notes" className="real-sr-only">Observações</label><textarea id="seller-notes" rows={4} maxLength={4000} value={s.notes} onChange={event => setting('notes', event.target.value)} /></div></section>
    </fieldset></form>
    <p className="real-help">O contato do vendedor também aparece em <Link to="/cadastros-reais?cadastro=contacts&contato=vendedor">Clientes e fornecedores</Link>.</p>
  </section>;
}
