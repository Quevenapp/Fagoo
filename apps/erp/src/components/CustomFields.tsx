import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { AccessError, type AccessController } from '../lib/real-access';
import type { CatalogAccess } from '../lib/catalog-model';
import { planBatch, summarizeBatch, batchSummaryText, type BatchResult, type BatchStep } from '../lib/origin-batch';
import { fold, taxonomyItems, taxonomyTree, type TaxonomyItem } from '../lib/product-form-model';
import {
  CUSTOM_FIELD_SIZE, CUSTOM_FIELD_TYPES, CUSTOM_FIELD_TYPE_LABELS, CUSTOM_FIELD_WIDTHS, CUSTOM_FIELD_WIDTH_LABELS, CUSTOM_FIELDS_LIMIT,
  customFieldData, customFieldDraft, customFieldItems, draftChanged, newOptionKey, type CustomField, type CustomFieldDraft, type CustomFieldType,
} from '../lib/custom-fields';
import { BatchDialog } from './BatchDialog';
import { AppliedChips, ListControls } from './OriginList';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { aborted, errorText, knownFailure } from './catalog-shared';
import './product-registry.css';
// Documentos lane (202610200288): the aba Ordem de Serviço (campos customizados da OS).
import DocumentCustomFieldsAdmin from './DocumentCustomFieldsAdmin';

// Preferências > Sistema > Campos customizados (Origin), aba Produtos (migração 156): pesquisa "Nome do campo...", filtros Tipo e
// Situação com "Limpar filtros", grade ☐ | Nome | Tipo | Situação (toggle) | Ações (editar, excluir), "+ Adicionar campo" e a gaveta
// "Adicionar campo" / "Editar Campo". Cada gravação é um comando (command_id) com versão esperada e "Conferir resultado"; um
// campo com valores gravados não é excluído (inative-o). As abas Ordem de Serviço e Clientes e Fornecedores ficam indisponíveis
// até essas áreas usarem campos customizados. Onda E (migração 235): a tela segue Sistema › Usuários › Permissões › Campos
// Customizados (ver: o módulo e Produtos; incluir, editar e a Situação: Inclusão e edição; excluir: Exclusão), conferido no banco.
type Situation = '' | 'active' | 'inactive';
type Toggle = { id: string; name: string; command: string; body: { command_id: string; expected_version: number; data: { active: boolean } }; uncertain: boolean };
const PERMISSION_DENIED = 'Seu usuário não tem a permissão Campos Customizados (Produtos) em Sistema › Usuários › Permissões › Preferências.';
const SAVE_REFUSED: Record<string, (products?: number) => string> = {
  duplicate_name: () => 'Já existe um campo customizado com este nome.',
  limit: () => `O FAGOO aceita até ${CUSTOM_FIELDS_LIMIT} campos customizados de produtos.`,
  option_in_use: products => `Não é possível remover opções usadas em ${products ?? 0} produto(s). Troque o valor desses produtos antes de remover a opção.`,
};

export default function CustomFields({ controller }: { controller: AccessController }) {
  const [tab, setTab] = useState<'products' | 'service_orders'>('products');
  const [fields, setFields] = useState<CustomField[] | null>(null), [categories, setCategories] = useState<TaxonomyItem[] | null | 'error'>(null);
  const [writable, setWritable] = useState(false), [deletable, setDeletable] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [reload, setReload] = useState(0);
  const [query, setQuery] = useState(''), [type, setType] = useState<'' | CustomFieldType>(''), [situation, setSituation] = useState<Situation>('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set()), [drawer, setDrawer] = useState<{ field: CustomField | null } | null>(null);
  const [toggle, setToggle] = useState<Toggle | null>(null), [toggleBusy, setToggleBusy] = useState(false), [batch, setBatch] = useState<CustomField[] | null>(null);
  const request = useRef<AbortController | null>(null), toggleRequest = useRef<AbortController | null>(null), batchRequest = useRef<AbortController | null>(null), actor = useRef<string | undefined>(undefined);
  useEffect(() => () => { request.current?.abort(); toggleRequest.current?.abort(); batchRequest.current?.abort(); }, []);
  useEffect(() => {
    const signal = new AbortController(); request.current?.abort(); request.current = signal; setError('');
    void (async () => {
      try {
        const access = await controller.catalog('/v1/cadastros', { signal: signal.signal }) as CatalogAccess;
        if (signal.signal.aborted) return;
        if (!(Array.isArray(access?.read) ? access.read : []).includes('products')) { setFields([]); setError('Seu perfil não permite consultar os campos customizados de produtos.'); return; }
        // The screen answer carries what this user may do (profile and Permissões); a refusal of the screen itself is the permission.
        let screen: unknown;
        try { screen = await controller.catalog('/v1/cadastros/campos-customizados?tela=produtos', { signal: signal.signal }); }
        catch (failure) { if (!signal.signal.aborted && failure instanceof AccessError && failure.status === 403) { setFields([]); setWritable(false); setDeletable(false); setError(PERMISSION_DENIED); return; } throw failure; }
        const list = customFieldItems(screen), permissions = (screen as { permissions?: { insert_edit?: unknown; delete?: unknown } }).permissions;
        if (signal.signal.aborted) return;
        if (typeof permissions?.insert_edit !== 'boolean' || typeof permissions.delete !== 'boolean') throw new AccessError(502);
        setWritable(permissions.insert_edit); setDeletable(permissions.delete); setFields(list); setSelected(new Set());
        try { const items = taxonomyItems(await controller.catalog('/v1/cadastros/taxonomias/categorias-produtos', { signal: signal.signal }), 'categories'); if (!signal.signal.aborted) setCategories(items); }
        catch (failure) { if (!signal.signal.aborted && !aborted(failure)) setCategories('error'); }
      } catch (failure) { if (!signal.signal.aborted && !aborted(failure)) { setFields(current => current ?? []); setError(errorText(failure)); } }
    })();
    return () => signal.abort();
  }, [controller, reload]);
  const all = fields ?? [];
  const visible = all.filter(field => (!query.trim() || fold(field.name).includes(fold(query.trim()))) && (!type || field.field_type === type) && (!situation || field.active === (situation === 'active')));
  const ids = visible.map(field => field.id), allSelected = ids.length > 0 && ids.every(id => selected.has(id));
  const replace = (field: CustomField) => setFields(current => current && (current.some(item => item.id === field.id) ? current.map(item => item.id === field.id ? field : item) : [...current, field].sort((a, b) => fold(a.name).localeCompare(fold(b.name)))));
  // Situação (toggle): one command; an unknown result keeps it to be checked with the same command.
  const sendToggle = async (current: Toggle) => {
    if (toggleBusy) return;
    const signal = new AbortController(); toggleRequest.current = signal; setToggleBusy(true); setToggle(current); setError('');
    try {
      const result = await controller.catalog(`/v1/cadastros/campos-customizados/${current.id}`, { method: 'PATCH', body: current.body, signal: signal.signal }) as { saved?: boolean; field?: CustomField };
      if (signal.signal.aborted) return;
      if (!result.saved || !result.field) throw new AccessError(409);
      replace(result.field); setToggle(null); setNotice(`Campo “${result.field.name}” ${result.field.active ? 'ativado' : 'inativado'}.`);
    } catch (failure) {
      if (signal.signal.aborted) return;
      if (!current.uncertain && !aborted(failure) && knownFailure(failure)) { setToggle(null); setError((failure as AccessError).status === 409 ? 'O campo foi alterado por outra operação. A lista foi atualizada.' : errorText(failure)); if ((failure as AccessError).status === 409) setReload(value => value + 1); }
      else setToggle({ ...current, uncertain: true });
    } finally { if (toggleRequest.current === signal) { toggleRequest.current = null; setToggleBusy(false); } }
  };
  const startToggle = (field: CustomField) => { if (toggle || toggleBusy) return; const command = crypto.randomUUID(); void sendToggle({ id: field.id, name: field.name, command, body: { command_id: command, expected_version: field.version, data: { active: !field.active } }, uncertain: false }); };
  // Exclusão (lixeira da linha ou dos selecionados): um comando por campo; um campo com valores é recusado.
  const startDelete = (list: CustomField[]) => { if (!deletable || !list.length) return; actor.current = controller.getSnapshot().membership?.user_id; batchRequest.current = new AbortController(); setBatch(list); };
  const plan = batch ? planBatch(batch.map(field => ({ ...field, label: field.name })), field => field.products > 0 ? `Tem valores em ${field.products} produto(s); inative o campo em vez de excluir.` : null) : null;
  const runDelete = async (field: CustomField & { label: string }): Promise<BatchStep> => {
    const snapshot = controller.getSnapshot(), signal = batchRequest.current?.signal;
    if (!signal || signal.aborted || snapshot.phase !== 'ready' || snapshot.membership?.user_id !== actor.current) throw new Error('A sessão mudou durante a operação. Este campo não foi enviado.');
    const body = { command_id: crypto.randomUUID(), expected_version: field.version };
    const send = async () => {
      const result = await controller.catalog(`/v1/cadastros/campos-customizados/${field.id}/excluir`, { method: 'POST', body, signal }) as { deleted?: boolean; products?: number };
      if (!result.deleted) throw new Error(`Tem valores em ${result.products ?? 0} produto(s); inative o campo em vez de excluir.`);
    };
    try { await send(); }
    catch (failure) {
      if (failure instanceof Error && !(failure instanceof AccessError) && !aborted(failure)) throw failure;
      if (!aborted(failure) && knownFailure(failure)) throw new Error((failure as AccessError).status === 409 ? 'Foi alterado por outra operação. Atualize a lista.' : errorText(failure));
      try { if (!signal.aborted) { await send(); return; } } catch { /* Still unknown. */ }
      return { uncertain: true, message: 'Não foi possível confirmar o resultado. Atualize a lista antes de repetir.' };
    }
  };
  const closeBatch = (results: BatchResult[] | null) => { setBatch(null); batchRequest.current = null; if (results) { setNotice(`Exclusão: ${batchSummaryText(summarizeBatch(results))}.`); setReload(value => value + 1); } };
  const chips = [...(query.trim() ? [{ label: `Pesquisa: ${query.trim()}`, onRemove: () => setQuery('') }] : []), ...(type ? [{ label: `Tipo: ${CUSTOM_FIELD_TYPE_LABELS[type]}`, onRemove: () => setType('') }] : []),
    ...(situation ? [{ label: `Situação: ${situation === 'active' ? 'Ativo' : 'Inativo'}`, onRemove: () => setSituation('') }] : [])];
  const clear = () => { setQuery(''); setType(''); setSituation(''); };
  return <section className="real-section custom-fields-screen" aria-labelledby="custom-fields-title">
    <header className="real-heading catalog-heading"><div className="catalog-title"><h1 id="custom-fields-title">Campos Customizados</h1></div>
      <div className="catalog-heading-actions">{!writable && !deletable && fields && !error && <span className="real-mode">Somente consulta</span>}
        {writable && tab === 'products' && <button type="button" className="primary-button" disabled={all.length >= CUSTOM_FIELDS_LIMIT} title={all.length >= CUSTOM_FIELDS_LIMIT ? `Limite de ${CUSTOM_FIELDS_LIMIT} campos` : undefined} onClick={() => setDrawer({ field: null })}><Icon name="plus" size={12} />Adicionar campo</button>}</div></header>
    <div className="product-tabs" role="tablist" aria-label="Módulos dos campos customizados">
      <button type="button" role="tab" id="custom-fields-tab-products" aria-selected={tab === 'products'} aria-controls="custom-fields-panel" onClick={() => setTab('products')}>Produtos</button>
      <button type="button" role="tab" id="custom-fields-tab-os" aria-selected={tab === 'service_orders'} aria-controls="custom-fields-panel-os" onClick={() => setTab('service_orders')}>Ordem de Serviço</button>
      <button type="button" role="tab" aria-selected="false" disabled title="Os clientes e fornecedores ainda não usam campos customizados no FAGOO.">Clientes e Fornecedores</button></div>
    {tab === 'service_orders' && <div id="custom-fields-panel-os" role="tabpanel" aria-labelledby="custom-fields-tab-os"><DocumentCustomFieldsAdmin controller={controller} /></div>}
    {tab === 'products' && <>
    {notice && <p className="real-success" role="status">{notice}</p>}
    {error && <p className="real-alert" role="alert">{error}<button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>Tentar novamente</button></p>}
    {toggle?.uncertain && <p className="real-alert" role="alert">Não foi possível confirmar a situação do campo “{toggle.name}”. <button type="button" className="text-button" disabled={toggleBusy} onClick={() => void sendToggle(toggle)}>{toggleBusy ? 'Conferindo…' : 'Conferir resultado'}</button></p>}
    <div id="custom-fields-panel" role="tabpanel" aria-labelledby="custom-fields-tab-products">
      <div className="native-list-toolbar">
        <div className="form-field"><label htmlFor="custom-fields-search">Pesquisar</label><input id="custom-fields-search" type="search" maxLength={60} value={query} placeholder="Nome do campo..." onChange={event => setQuery(event.target.value)} /></div>
        <div className="form-field"><label htmlFor="custom-fields-type">Tipo</label><select id="custom-fields-type" value={type} onChange={event => setType(event.target.value as '' | CustomFieldType)}><option value="">Todos os tipos</option>{CUSTOM_FIELD_TYPES.map(item => <option key={item} value={item}>{CUSTOM_FIELD_TYPE_LABELS[item]}</option>)}</select></div>
        <div className="form-field"><label htmlFor="custom-fields-situation">Situação</label><select id="custom-fields-situation" value={situation} onChange={event => setSituation(event.target.value as Situation)}><option value="">Todas as situações</option><option value="active">Ativo</option><option value="inactive">Inativo</option></select></div>
        <button type="button" className="text-button" disabled={!chips.length} onClick={clear}>Limpar filtros</button>
        {deletable && <button type="button" className={`secondary-button${selected.size ? ' is-danger' : ''}`} title="Excluir selecionados" aria-label="Excluir selecionados" disabled={!selected.size} onClick={() => startDelete(all.filter(field => selected.has(field.id)))}><Icon name="trash-can" size={13} /></button>}
      </div>
      <AppliedChips chips={chips} onClear={clear} />
      <div className="catalog-list-controls">{deletable ? <ListControls checked={allSelected} indeterminate={!allSelected && ids.some(id => selected.has(id))} onToggleAll={() => setSelected(allSelected ? new Set() : new Set(ids))} onRefresh={() => setReload(value => value + 1)} />
        : <button type="button" className="origin-refresh" title="Recarregar" aria-label="Recarregar" onClick={() => setReload(value => value + 1)}><Icon name="rotate-right" size={12} /></button>}
        <div className="native-list-summary"><dl className="native-list-stat"><dt>Quantidade de campos</dt><dd>{fields ? visible.length : '—'}</dd></dl></div></div>
      {fields === null ? <p role="status">Carregando…</p> : <div className="table-scroll" tabIndex={0} role="region" aria-label="Campos customizados de produtos"><table className="data-table real-table origin-table"><thead><tr>
        {deletable && <th scope="col" className="checkbox-cell"><span className="real-sr-only">Seleção</span></th>}<th scope="col">Nome</th><th scope="col">Tipo</th><th scope="col">Situação</th><th scope="col" className="row-actions">Ações</th></tr></thead>
        <tbody>{visible.map(field => <tr key={field.id} className={selected.has(field.id) ? 'selected' : undefined}>
          {deletable && <td className="checkbox-cell"><input type="checkbox" aria-label={`Selecionar ${field.name}`} checked={selected.has(field.id)} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(field.id); else next.delete(field.id); return next; })} /></td>}
          <td><button type="button" className="text-button record-link" onClick={() => setDrawer({ field })}>{field.name}</button>{field.required && <span className="real-help"> (obrigatório)</span>}</td>
          <td>{CUSTOM_FIELD_TYPE_LABELS[field.field_type]}</td>
          <td><label className="product-switch"><input type="checkbox" role="switch" aria-label={`Situação de ${field.name}`} checked={field.active} disabled={!writable || toggleBusy || Boolean(toggle)} onChange={() => startToggle(field)} /><span>{field.active ? 'Ativo' : 'Inativo'}</span></label></td>
          <td className="row-actions product-row-actions"><button type="button" className="icon-button" title={writable ? 'Editar' : 'Visualizar'} aria-label={`${writable ? 'Editar' : 'Visualizar'} ${field.name}`} onClick={() => setDrawer({ field })}><Icon name={writable ? 'pen-to-square' : 'eye'} size={12} /></button>
            {deletable && <button type="button" className="icon-button" title="Excluir" aria-label={`Excluir ${field.name}`} onClick={() => startDelete([field])}><Icon name="trash-can" size={12} /></button>}</td></tr>)}</tbody></table>
        {!visible.length && !error && <div className="origin-empty"><span><Icon name="exclamation" size={22} /></span><h2>{chips.length ? 'Nenhum resultado encontrado.' : 'Nenhum campo customizado cadastrado.'}</h2><p>{chips.length ? 'Verifique os filtros ou busque por outros termos.' : writable ? 'Crie campos para guardar informações próprias dos seus produtos.' : ''}</p>
          {!chips.length && writable && <button type="button" className="primary-button" onClick={() => setDrawer({ field: null })}><Icon name="plus" size={12} />Adicionar campo</button>}</div>}</div>}
    </div>
    <p className="real-help">Os campos aparecem no cadastro do produto (aba Características), de acordo com a categoria do produto quando o Agrupador está ligado. Um campo com valores gravados não pode ser excluído: inative-o para que deixe de aparecer. <Link to="/categorias-produtos">Categorias de produtos</Link></p></>}
    {drawer && <CustomFieldDrawer controller={controller} field={drawer.field} writable={writable} categories={categories} onClose={() => setDrawer(null)}
      onSaved={field => { replace(field); setDrawer(null); setNotice(drawer.field ? 'Campo salvo.' : 'Campo incluído.'); }} />}
    {batch && plan && <BatchDialog title="Excluir campos customizados" plan={plan} confirmLabel="Excluir" run={runDelete} onClose={closeBatch}
      description={<p>As opções e o agrupador do campo também são excluídos. Um campo com valores gravados em produtos não é excluído.</p>} />}
  </section>;
}

/** Gaveta "Adicionar campo" / "Editar Campo" (Características do campo). */
function CustomFieldDrawer({ controller, field, writable, categories, onClose, onSaved }: { controller: Pick<AccessController, 'catalog'>; field: CustomField | null; writable: boolean; categories: TaxonomyItem[] | null | 'error'; onClose: () => void; onSaved: (field: CustomField) => void }) {
  const [initial] = useState(() => customFieldDraft(field)), [draft, setDraft] = useState(initial);
  const [pending, setPending] = useState<{ path: string; method: 'POST' | 'PATCH'; body: Record<string, unknown> } | null>(null), [uncertain, setUncertain] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [invalid, setInvalid] = useState(''), [dragging, setDragging] = useState<number | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const guard = useUnsavedChanges(writable && (draftChanged(draft, initial) || uncertain), busy || uncertain);
  const set = <K extends keyof CustomFieldDraft>(key: K, value: CustomFieldDraft[K]) => { setDraft(current => ({ ...current, [key]: value })); setError(''); setInvalid(''); };
  const sized = Boolean(CUSTOM_FIELD_SIZE[draft.field_type]);
  const send = async (operation: { path: string; method: 'POST' | 'PATCH'; body: Record<string, unknown> }) => {
    if (busy) return;
    const signal = new AbortController(); request.current = signal; setBusy(true); setError(''); setPending(operation);
    try {
      const result = await controller.catalog(operation.path, { method: operation.method, body: operation.body, signal: signal.signal }) as { saved?: boolean; reason?: string; products?: number; field?: CustomField };
      if (signal.signal.aborted) return;
      setUncertain(false); setPending(null);
      if (!result.saved || !result.field) { setError(SAVE_REFUSED[result.reason ?? '']?.(result.products) ?? 'O campo não foi salvo.'); if (result.reason === 'duplicate_name') setInvalid('name'); if (result.reason === 'option_in_use') setInvalid('options'); return; }
      onSaved(result.field);
    } catch (failure) {
      if (signal.signal.aborted) return;
      const known = !uncertain && !aborted(failure) && knownFailure(failure);
      if (known) { setPending(null); setError((failure as AccessError).status === 409 ? 'O campo foi alterado por outra operação. Feche a gaveta e abra de novo.' : errorText(failure)); }
      else { setUncertain(true); setError('Não foi possível confirmar o resultado. Use “Conferir resultado” para repetir a mesma operação sem duplicar.'); }
    } finally { if (request.current === signal) { request.current = null; setBusy(false); } }
  };
  const save = () => {
    if (uncertain && pending) { void send(pending); return; }
    const checked = customFieldData(draft, field);
    if ('error' in checked) { setError(checked.error); setInvalid(checked.field); document.getElementById(`custom-field-${checked.field}`)?.focus(); return; }
    const command = crypto.randomUUID();
    void send(field ? { path: `/v1/cadastros/campos-customizados/${field.id}`, method: 'PATCH', body: { command_id: command, expected_version: field.version, data: checked.data } }
      : { path: '/v1/cadastros/campos-customizados', method: 'POST', body: { command_id: command, data: checked.data } });
  };
  const moveOption = (from: number, to: number) => { if (from === to || to < 0 || to >= draft.options.length) return; const next = [...draft.options]; const [item] = next.splice(from, 1); next.splice(to, 0, item); set('options', next); };
  const locked = !writable || busy || uncertain;
  const tree = Array.isArray(categories) ? taxonomyTree(categories) : [];
  return <Modal title={field ? 'Editar Campo' : 'Adicionar campo'} onClose={() => guard.confirmLeave(onClose)} actions={<><button type="button" className="secondary-button" disabled={busy} onClick={() => guard.confirmLeave(onClose)}>{writable ? 'Cancelar' : 'Fechar'}</button>
    {writable && <button type="button" className="primary-button" disabled={busy} onClick={save}>{busy ? 'Salvando…' : uncertain ? 'Conferir resultado' : 'Salvar'}</button>}</>}>
    <fieldset className="real-editor-fields custom-field-drawer" disabled={locked}><legend>Características do campo</legend>
      <div className="form-field"><label htmlFor="custom-field-type">Tipo do campo</label><select id="custom-field-type" value={draft.field_type} disabled={locked || Boolean(field)} onChange={event => { const next = event.target.value as CustomFieldType; setDraft(current => ({ ...current, field_type: next, ...(CUSTOM_FIELD_SIZE[next] ? {} : { min_length: '', max_length: '' }), options: next === 'list' ? current.options : [] })); setError(''); }}>
        {CUSTOM_FIELD_TYPES.map(item => <option key={item} value={item}>{CUSTOM_FIELD_TYPE_LABELS[item]}</option>)}</select>{field && <small>O tipo do campo não muda depois de criado.</small>}</div>
      <div className="form-field"><label htmlFor="custom-field-name">Nome do campo *</label><input id="custom-field-name" value={draft.name} maxLength={60} required aria-invalid={invalid === 'name' || undefined} autoComplete="off" onChange={event => set('name', event.target.value)} /></div>
      <div className="form-field"><label htmlFor="custom-field-hint">Dica de preenchimento<span className="product-info" title="Texto de exemplo exibido dentro do campo, no cadastro do produto"><Icon name="circle-question" size={11} /></span></label><input id="custom-field-hint" value={draft.hint} maxLength={100} aria-invalid={invalid === 'hint' || undefined} autoComplete="off" onChange={event => set('hint', event.target.value)} /></div>
      <div className="form-field real-field-wide"><label htmlFor="custom-field-info">Informação sobre o campo<span className="product-info" title="Aparece no balão de informação do campo, no cadastro do produto"><Icon name="circle-question" size={11} /></span></label><textarea id="custom-field-info" value={draft.info} rows={3} maxLength={300} aria-invalid={invalid === 'info' || undefined} onChange={event => set('info', event.target.value)} /></div>
      <div className="form-field"><span className="product-field-label">Campo obrigatório</span><label className="product-switch"><input type="checkbox" role="switch" id="custom-field-required" checked={draft.required} onChange={event => set('required', event.target.checked)} /><span>{draft.required ? 'Sim' : 'Não'}</span></label></div>
      {sized && <><div className="form-field"><label htmlFor="custom-field-min_length">Tamanho mínimo</label><input id="custom-field-min_length" value={draft.min_length} inputMode="numeric" maxLength={4} aria-invalid={invalid === 'min_length' || undefined} onChange={event => set('min_length', event.target.value.replace(/\D/g, ''))} /></div>
        <div className="form-field"><label htmlFor="custom-field-max_length">Tamanho máximo</label><input id="custom-field-max_length" value={draft.max_length} inputMode="numeric" maxLength={4} placeholder={String(CUSTOM_FIELD_SIZE[draft.field_type])} onChange={event => set('max_length', event.target.value.replace(/\D/g, ''))} /><small>Quantidade de caracteres do valor, até {CUSTOM_FIELD_SIZE[draft.field_type]}.</small></div></>}
      {draft.field_type === 'list' && <div className="form-field real-field-wide"><span className="product-field-label" id="custom-field-options-label">Lista de opções *</span>
        <ul className="custom-field-options" aria-labelledby="custom-field-options-label">{draft.options.map((option, index) => <li key={option.key} draggable={!locked} onDragStart={() => setDragging(index)} onDragOver={event => event.preventDefault()} onDrop={() => { if (dragging !== null && !locked) moveOption(dragging, index); setDragging(null); }}>
          <Icon name="grip-vertical" size={11} /><input aria-label={`Opção ${index + 1}`} value={option.label} maxLength={60} aria-invalid={invalid === 'options' || undefined} onChange={event => set('options', draft.options.map((item, i) => i === index ? { ...item, label: event.target.value } : item))} />
          <button type="button" className="icon-button" aria-label={`Mover a opção ${index + 1} para cima`} disabled={locked || index === 0} onClick={() => moveOption(index, index - 1)}><Icon name="arrow-up" size={10} /></button>
          <button type="button" className="icon-button" aria-label={`Mover a opção ${index + 1} para baixo`} disabled={locked || index === draft.options.length - 1} onClick={() => moveOption(index, index + 1)}><Icon name="arrow-down" size={10} /></button>
          <button type="button" className="icon-button" aria-label={`Remover a opção ${index + 1}`} title="Remover" onClick={() => set('options', draft.options.filter((_, i) => i !== index))}><Icon name="trash-can" size={11} /></button></li>)}</ul>
        <button type="button" id="custom-field-options" className="text-button" disabled={locked || draft.options.length >= 50} onClick={() => set('options', [...draft.options, { id: null, label: '', key: newOptionKey() }])}><Icon name="plus" size={11} />Adicionar opção</button></div>}
      <div className="form-field"><label htmlFor="custom-field-width">Largura do campo</label><select id="custom-field-width" value={draft.width} onChange={event => set('width', event.target.value as CustomFieldDraft['width'])}>{CUSTOM_FIELD_WIDTHS.map(item => <option key={item} value={item}>{CUSTOM_FIELD_WIDTH_LABELS[item]}</option>)}</select></div>
      <div className="form-field real-field-wide"><span className="product-field-label">Agrupador<span className="product-info" title="Ligado, o campo aparece só nos produtos das categorias marcadas (e das subcategorias delas)"><Icon name="circle-question" size={11} /></span></span>
        <label className="product-switch"><input type="checkbox" role="switch" id="custom-field-grouped" checked={draft.grouped} onChange={event => set('grouped', event.target.checked)} /><span>{draft.grouped ? 'Ligado' : 'Desligado: o campo aparece em todos os produtos'}</span></label>
        {draft.grouped && (categories === null ? <p role="status">Carregando as categorias…</p> : categories === 'error' ? <p className="real-help">Não foi possível carregar as categorias de produtos; as categorias já marcadas continuam no campo.</p>
          : !tree.length ? <p className="real-help">Nenhuma categoria de produtos cadastrada. <Link to="/categorias-produtos">Incluir categoria</Link></p>
          : <div className="custom-field-categories" role="group" aria-label="Categorias de produtos onde o campo aparece">{tree.map(({ item, depth }) => <label key={item.id} className="product-check" style={{ paddingLeft: `${depth * 18}px` }}><input type="checkbox" checked={draft.category_ids.includes(item.id)}
            onChange={event => set('category_ids', event.target.checked ? [...draft.category_ids, item.id].sort() : draft.category_ids.filter(id => id !== item.id))} />{item.name}</label>)}</div>)}</div>
    </fieldset>
    {field && field.products > 0 && <p className="real-help">{field.products} produto(s) têm valor neste campo.</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}
  </Modal>;
}
