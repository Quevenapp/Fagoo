import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { AccessError, type AccessController } from '../lib/real-access';
import type { CatalogAccess } from '../lib/catalog-model';
import { planBatch, summarizeBatch, batchSummaryText, type BatchResult, type BatchStep } from '../lib/origin-batch';
import { TAG_TYPE_LABELS, TAXONOMY_SLUG, fold, taxonomyItems, taxonomyTree, type TagType, type TaxonomyItem, type TaxonomyKind } from '../lib/product-form-model';
import { customFieldItems, type CustomField } from '../lib/custom-fields';
// Wave E (migration 235): "Inclusão e edição" of Campos Customizados (Sistema › Usuários › Permissões) for the linked fields.
import { PERMISSIONS_PATH } from '../lib/system-model';
import { allowedBy, parseMyPermissions } from '../../../../packages/erp-domain/src/user-permissions.mjs';
import { BatchDialog } from './BatchDialog';
import { SearchableSelect } from './SearchableSelect';
import { AppliedChips, ListControls, RowMenu, type RowMenuItem } from './OriginList';
import { Icon } from './Icon';
import { OriginCategorySync } from './OriginCatalogSync';
import { aborted, errorText, knownFailure } from './catalog-shared';
import './product-registry.css';

// Cadastros > Categorias de produtos, Grupos de produtos (Tributação), Tags e Grupos de tags no padrão do Origin (migrações 119 e
// 153): listagem em árvore com busca, seleção e lixeira, formulário com o pai fixo na subcategoria/subgrupo, clonar categoria e a
// dica de categorias. Tags e grupos de tags têm o Tipo do Origin (Produtos | Contatos | Notas fiscais, migração 236): filtro, coluna
// e campo na inclusão (fixo depois); cada perfil vê e grava os tipos que a sua permissão de produtos, de contatos ou das notas
// fiscais (administrador e fiscal gravam; consulta só lê) permite. Cada gravação é um comando
// (command_id) com versão esperada e "Conferir resultado"; a exclusão recusa categoria/grupo com subníveis e grupo em uso, e
// tira a categoria ou a tag dos produtos (ou dos contatos) com nova versão e auditoria.
const TEXT: Record<TaxonomyKind, { title: string; add: string; noun: string; count: string; search: string; column: string; parent: string; sub?: string; max: number; formTitle: string; empty: string }> = {
  categories: { title: 'Categorias de produtos', add: 'Incluir categoria', noun: 'categoria', count: 'Quantidade de categoria', search: 'Pesquisar por descrição', column: 'Nome da categoria', parent: 'Categoria (pai)', sub: 'Incluir subcategoria', max: 50, formTitle: 'Nova categoria', empty: 'Nenhuma categoria cadastrada.' },
  product_groups: { title: 'Grupos de produtos', add: 'Incluir grupo', noun: 'grupo', count: 'Quantidade de grupos de produtos', search: 'Pesquisar por nome', column: 'Nome', parent: 'Grupo (pai)', sub: 'Incluir subgrupo', max: 100, formTitle: 'Grupo de Produtos', empty: 'Nenhum grupo cadastrado.' },
  tags: { title: 'Tags', add: 'Incluir tag', noun: 'tag', count: 'Quantidade de tags', search: 'Pesquisar por nome', column: 'Nome', parent: 'Grupo', max: 60, formTitle: 'Inclusão de Tag', empty: 'Nenhum item registrado' },
  tag_groups: { title: 'Grupos de tags', add: 'Incluir grupo tag', noun: 'grupo de tags', count: 'Quantidade de grupos', search: 'Pesquisar por nome', column: 'Nome', parent: '', max: 60, formTitle: 'Inclusão de grupo tag', empty: 'Nenhum item registrado' },
};
const REFUSED: Record<string, string> = { has_children: 'Tem subníveis (ou tags, no grupo de tags); exclua-os antes.', in_use: 'Está em uso por produtos; troque o grupo desses produtos antes.' };
const TAG_TYPES: TagType[] = ['products', 'contacts', 'invoices'];
const TYPE_PARAM: Record<string, TagType> = { produtos: 'products', contatos: 'contacts', notas: 'invoices' };
// Tags of Notas fiscais are written by the profiles that write the notes (migration 236).
const INVOICE_TAG_WRITERS = ['admin', 'fiscal'];
type FormState = { id: string | null; version: number; parent: string | null; name: string; initial: string; command: string; uncertain: boolean; busy: boolean; error: string; group: string; initialGroup: string; type: TagType; initialType: TagType;
  fieldIds: string[]; initialFieldIds: string[]; fieldsRead?: boolean };
const sameIds = (a: readonly string[], b: readonly string[]) => [...a].sort().join() === [...b].sort().join();
const typeOf = (item: TaxonomyItem): TagType => item.tag_type ?? 'products';

export default function ProductTaxonomy({ controller, kind }: { controller: AccessController; kind: TaxonomyKind }) {
  const text = TEXT[kind], tagged = kind === 'tags' || kind === 'tag_groups';
  const location = useLocation();
  const [items, setItems] = useState<TaxonomyItem[] | null>(null), [groups, setGroups] = useState<TaxonomyItem[]>([]);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [reload, setReload] = useState(0);
  // Writable tag types (Produtos with the products permission, Contatos with the contacts one); categories and groups use 'products'.
  const [profileTypes, setWritableTypes] = useState<TagType[]>([]);
  // 202610200282: Sistema › Usuários › Permissões › Outros › "Cadastro de tags" / "Cadastro de grupos de tags" guard every write of
  // these two screens (null until read; unreadable permissions keep the profile, the server still decides).
  const [screenAllowed, setScreenAllowed] = useState<boolean | null>(null);
  const screenKey = kind === 'tags' ? 'outros.tags' : kind === 'tag_groups' ? 'outros.grupos_tags' : null;
  const writableTypes = screenKey && screenAllowed === false ? [] : profileTypes;
  const [typeFilter, setTypeFilter] = useState<'' | TagType>(() => tagged ? TYPE_PARAM[new URLSearchParams(location.search).get('tipo') ?? ''] ?? '' : '');
  const [query, setQuery] = useState(''), [selected, setSelected] = useState<ReadonlySet<string>>(new Set()), [menu, setMenu] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null), [batch, setBatch] = useState<TaxonomyItem[] | null>(null);
  const request = useRef<AbortController | null>(null), save = useRef<AbortController | null>(null), batchRequest = useRef<AbortController | null>(null), actor = useRef<string | undefined>(undefined);
  const guard = useUnsavedChanges(Boolean(form && (form.name !== form.initial || form.group !== form.initialGroup || form.type !== form.initialType || !sameIds(form.fieldIds, form.initialFieldIds) || form.uncertain)), Boolean(form?.busy || form?.uncertain));
  // Categorias: "Campos customizáveis aplicáveis nesta categoria" (migration 156), read with the list.
  const [customFields, setCustomFields] = useState<CustomField[] | null | 'error'>(null);
  useEffect(() => {
    if (kind !== 'categories') return;
    const signal = new AbortController();
    void Promise.resolve().then(() => controller.catalog('/v1/cadastros/campos-customizados', { signal: signal.signal })).then(value => { if (!signal.signal.aborted) setCustomFields(customFieldItems(value)); })
      .catch(failure => { if (!signal.signal.aborted && !aborted(failure)) setCustomFields('error'); });
    return () => signal.abort();
  }, [controller, kind, reload]);
  useEffect(() => () => { request.current?.abort(); save.current?.abort(); batchRequest.current?.abort(); }, []);
  // Campos Customizados › Inclusão e edição (Sistema › Usuários › Permissões): without it the linked fields are shown, not changed.
  // Unreadable permissions keep the control (the server decides).
  const [fieldsLocked, setFieldsLocked] = useState(false);
  useEffect(() => {
    if (kind !== 'categories' || typeof controller.system !== 'function') return;
    const signal = new AbortController(); setFieldsLocked(false);
    void Promise.resolve().then(() => controller.system(PERMISSIONS_PATH, { method: 'GET', signal: signal.signal })).then(raw => {
      if (signal.signal.aborted) return;
      const view = parseMyPermissions(raw);
      setFieldsLocked(!['preferencias.campos_customizados.ie', 'preferencias.campos_customizados.produtos'].every(key => allowedBy(view, key)));
    }).catch(() => { /* The server still decides. */ });
    return () => signal.abort();
  }, [controller, kind, reload]);
  useEffect(() => {
    if (!screenKey || typeof controller.system !== 'function') return;
    const signal = new AbortController(); setScreenAllowed(null);
    void Promise.resolve().then(() => controller.system(PERMISSIONS_PATH, { method: 'GET', signal: signal.signal })).then(raw => {
      if (!signal.signal.aborted) setScreenAllowed(allowedBy(parseMyPermissions(raw), screenKey));
    }).catch(() => { /* The server still decides. */ });
    return () => signal.abort();
  }, [controller, screenKey, reload]);
  useEffect(() => {
    const signal = new AbortController(); request.current?.abort(); request.current = signal; setError('');
    void (async () => {
      try {
        const access = await controller.catalog('/v1/cadastros', { signal: signal.signal }) as CatalogAccess;
        if (signal.signal.aborted) return;
        const read = Array.isArray(access?.read) ? access.read : [], write = Array.isArray(access?.write) ? access.write : [];
        if (!read.includes('products') && !(tagged && read.includes('contacts'))) { setItems([]); setError(tagged ? 'Seu perfil não permite consultar as tags.' : 'Seu perfil não permite consultar os cadastros de produtos.'); return; }
        const role = controller.getSnapshot().membership?.role ?? '';
        setWritableTypes(TAG_TYPES.filter(type => type === 'invoices' ? tagged && INVOICE_TAG_WRITERS.includes(role) : write.includes(type)));
        const list = taxonomyItems(await controller.catalog(`/v1/cadastros/taxonomias/${TAXONOMY_SLUG[kind]}`, { signal: signal.signal }), kind);
        const parents = kind === 'tags' ? taxonomyItems(await controller.catalog('/v1/cadastros/taxonomias/grupos-tags', { signal: signal.signal }), 'tag_groups') : [];
        if (signal.signal.aborted) return;
        setItems(list); setGroups(parents); setSelected(new Set());
      } catch (failure) { if (!signal.signal.aborted && !aborted(failure)) { setItems(current => current ?? []); setError(errorText(failure)); } }
    })();
    return () => signal.abort();
  }, [controller, kind, reload]);
  const writable = tagged ? writableTypes.length > 0 : writableTypes.includes('products');
  const canWrite = (item: TaxonomyItem) => tagged ? writableTypes.includes(typeOf(item)) : writable;
  const all = items ?? [];
  const typed = tagged && typeFilter ? all.filter(item => typeOf(item) === typeFilter) : all;
  const visible = query.trim() ? taxonomyTree(typed).filter(({ item }) => fold(item.name).includes(fold(query.trim()))) : taxonomyTree(typed);
  const parentName = (item: TaxonomyItem) => kind === 'tags' ? groups.find(group => group.id === item.parent_id)?.name ?? '—' : all.find(other => other.id === item.parent_id)?.name ?? '—';
  const defaultType = (): TagType => typeFilter && writableTypes.includes(typeFilter) ? typeFilter : writableTypes[0] ?? 'products';
  const open = (state: Partial<FormState>) => guard.confirmLeave(() => { const type = state.type ?? defaultType();
    setForm({ id: null, version: 0, parent: null, name: '', initial: '', command: crypto.randomUUID(), uncertain: false, busy: false, error: '', group: '', initialGroup: '', type, initialType: type, fieldIds: [], initialFieldIds: [], ...state }); });
  const linkedFields = (id: string) => Array.isArray(customFields) ? customFields.filter(field => field.category_ids.includes(id)).map(field => field.id) : [];
  const edit = (item: TaxonomyItem) => { const fieldIds = kind === 'categories' ? linkedFields(item.id) : [];
    open({ id: item.id, version: item.version, parent: item.parent_id, name: item.name, initial: item.name, group: item.parent_id ?? '', initialGroup: item.parent_id ?? '', type: typeOf(item), initialType: typeOf(item), fieldIds, initialFieldIds: fieldIds, fieldsRead: Array.isArray(customFields) }); };
  // A category opened before the custom fields were read gets its linked fields when they arrive (the control was hidden until then).
  useEffect(() => {
    if (kind !== 'categories' || !form?.id || form.fieldsRead || !Array.isArray(customFields)) return;
    const fieldIds = linkedFields(form.id);
    setForm(current => current && current.id === form.id ? { ...current, fieldIds, initialFieldIds: fieldIds, fieldsRead: true } : current);
  }, [customFields, form?.id, form?.fieldsRead]);
  const submit = async (event?: FormEvent) => {
    event?.preventDefault(); const current = form; if (!current || current.busy || save.current) return;
    const name = current.name.trim();
    if (!current.uncertain && (!name || name.length > text.max)) { setForm({ ...current, error: `Informe o nome com até ${text.max} caracteres.` }); return; }
    const parent = kind === 'tags' ? current.group || null : current.parent;
    // The linked custom fields go in the same command, only when they changed (and were read).
    const fields = kind === 'categories' && Array.isArray(customFields) && !fieldsLocked && !sameIds(current.fieldIds, current.initialFieldIds) ? { custom_field_ids: [...current.fieldIds] } : {};
    const body = current.id ? { command_id: current.command, expected_version: current.version, data: { name, ...fields } }
      : { command_id: current.command, data: { name, ...(parent ? { parent_id: parent } : {}), ...(tagged ? { tag_type: current.type } : {}), ...fields } };
    const signal = new AbortController(); save.current = signal; setForm({ ...current, busy: true, error: '' });
    try {
      const path = `/v1/cadastros/taxonomias/${TAXONOMY_SLUG[kind]}${current.id ? `/${current.id}` : ''}`;
      const result = await controller.catalog(path, { method: current.id ? 'PATCH' : 'POST', body, signal: signal.signal }) as { saved?: boolean; reason?: string; item?: TaxonomyItem };
      if (signal.signal.aborted) return;
      if (!result.saved) { setForm({ ...current, busy: false, uncertain: false, command: crypto.randomUUID(), error: `Já existe ${kind === 'categories' ? 'uma categoria' : kind === 'tags' ? 'uma tag' : 'um grupo'} com este nome${parent || kind === 'tags' ? ' neste nível' : ''}${tagged ? ` no tipo ${TAG_TYPE_LABELS[current.type]}` : ''}.` }); return; }
      setForm(null); setNotice(current.id ? 'Cadastro salvo.' : `${text.noun[0].toUpperCase()}${text.noun.slice(1)} incluíd${kind === 'categories' || kind === 'tags' ? 'a' : 'o'}.`); setReload(value => value + 1);
    } catch (failure) {
      if (signal.signal.aborted) return;
      const known = !current.uncertain && !aborted(failure) && knownFailure(failure);
      setForm({ ...current, busy: false, uncertain: !known, command: known ? crypto.randomUUID() : current.command,
        error: known ? (failure as AccessError).status === 409 ? 'O cadastro foi alterado por outra operação. Feche o formulário e abra de novo.' : errorText(failure) : 'Não foi possível confirmar o resultado. Use “Conferir resultado” para repetir a mesma operação sem duplicar.' });
    } finally { if (save.current === signal) save.current = null; }
  };
  const close = () => guard.confirmLeave(() => setForm(null));
  // Exclusão em lote: um comando por registro, filhos antes dos pais (a categoria fica sem subníveis quando chega a vez dela).
  const startDelete = (list: TaxonomyItem[]) => { setMenu(null); const allowed = list.filter(canWrite); if (!allowed.length) return; actor.current = controller.getSnapshot().membership?.user_id; batchRequest.current = new AbortController(); setBatch(allowed); };
  const plan = batch ? planBatch([...batch].sort((a, b) => depthOf(all, b) - depthOf(all, a)).map(item => ({ ...item, label: item.name })), () => null) : null;
  const runDelete = async (item: TaxonomyItem & { label: string }): Promise<BatchStep> => {
    const snapshot = controller.getSnapshot(), signal = batchRequest.current?.signal;
    if (!signal || signal.aborted || snapshot.phase !== 'ready' || snapshot.membership?.user_id !== actor.current) throw new Error('A sessão mudou durante a operação. Este cadastro não foi enviado.');
    const body = { command_id: crypto.randomUUID(), expected_version: item.version };
    const send = async () => {
      const result = await controller.catalog(`/v1/cadastros/taxonomias/${TAXONOMY_SLUG[kind]}/${item.id}/excluir`, { method: 'POST', body, signal }) as { deleted?: boolean; reason?: string; products?: number };
      if (!result.deleted) throw new Error(REFUSED[result.reason ?? ''] ?? 'Não foi excluído.');
      return result.products ? { message: `${result.products} ${typeOf(item) === 'contacts' ? 'contato(s)' : typeOf(item) === 'invoices' ? 'nota(s)' : 'produto(s)'} atualizado(s).` } : undefined;
    };
    try { return await send(); }
    catch (failure) {
      if (failure instanceof Error && !(failure instanceof AccessError) && !aborted(failure)) throw failure;
      if (!aborted(failure) && knownFailure(failure)) throw new Error((failure as AccessError).status === 409 ? 'Foi alterado por outra operação. Atualize a listagem.' : errorText(failure));
      try { if (!signal.aborted) return await send(); } catch { /* Still unknown. */ }
      return { uncertain: true, message: 'Não foi possível confirmar o resultado. Atualize a listagem antes de repetir.' };
    }
  };
  const closeBatch = (results: BatchResult[] | null) => { setBatch(null); batchRequest.current = null; if (results) { setNotice(`Exclusão: ${batchSummaryText(summarizeBatch(results))}.`); setReload(value => value + 1); } };
  const ids = visible.map(({ item }) => item.id), allSelected = ids.length > 0 && ids.every(id => selected.has(id));
  const rowMenu = (item: TaxonomyItem): RowMenuItem[] => [
    ...(text.sub && canWrite(item) ? [{ label: text.sub, icon: 'sitemap', onClick: () => open({ parent: item.id }) }] : []),
    { label: canWrite(item) ? 'Editar' : 'Visualizar', icon: canWrite(item) ? 'pen-to-square' : 'eye', onClick: () => edit(item) },
    ...(kind === 'categories' && canWrite(item) ? [{ label: 'Clonar categoria', icon: 'clone', onClick: () => open({ parent: item.parent_id, name: `${item.name} (cópia)`.slice(0, 50) }) }] : []),
    ...(canWrite(item) ? [{ label: 'Excluir', icon: 'trash-can', separatorBefore: true, onClick: () => startDelete([item]) }] : []),
  ];
  const parentOfForm = form?.parent ? all.find(item => item.id === form.parent) : null;
  const formEditable = form ? (tagged ? writableTypes.includes(form.type) : writable) : false;
  const formGroups = groups.filter(group => !form || typeOf(group) === form.type);
  const used = (item: TaxonomyItem) => kind === 'tags' && typeOf(item) === 'contacts' ? item.contacts ?? 0 : kind === 'tags' && typeOf(item) === 'invoices' ? item.invoices ?? 0 : item.products;
  return <section className="real-section taxonomy-screen" aria-labelledby="taxonomy-title">
    <header className="real-heading catalog-heading"><div className="catalog-title"><h1 id="taxonomy-title">{text.title}</h1></div>
      <div className="catalog-heading-actions">{!writable && items && <span className="real-mode" title={screenKey && screenAllowed === false && profileTypes.length ? `Seu usuário não tem a permissão “${kind === 'tags' ? 'Cadastro de tags' : 'Cadastro de grupos de tags'}” (Sistema › Usuários › Permissões › Outros).` : undefined}>Somente consulta</span>}{writable && <button type="button" className="primary-button" onClick={() => open({})}><Icon name="plus" size={12} />{text.add}</button>}
        {kind === 'categories' && writable && <button type="button" className="secondary-button" disabled={selected.size !== 1} title={selected.size === 1 ? undefined : 'Selecione uma categoria'} onClick={() => { const item = all.find(row => selected.has(row.id)); if (item) open({ parent: item.parent_id, name: `${item.name} (cópia)`.slice(0, 50) }); }}><Icon name="clone" size={12} />Clonar categoria</button>}</div></header>
    {/* Leva H (351): as categorias do Origin pelo id externo, sem duplicar a árvore. */}
    {kind === 'categories' && <OriginCategorySync controller={controller} onSynced={() => setReload(value => value + 1)} />}
    {notice && <p className="real-success" role="status">{notice}</p>}
    {error && <p className="real-alert" role="alert">{error}<button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>Tentar novamente</button></p>}
    {form && <form className="real-editor" onSubmit={event => void submit(event)} aria-labelledby="taxonomy-form-title">
      <h2 id="taxonomy-form-title">{form.id && tagged ? kind === 'tags' ? 'Tag' : 'Grupo de tags' : text.formTitle}</h2><p className="catalog-required"><span>(*)</span> Campos obrigatórios</p>
      <fieldset className="real-editor-fields" disabled={!formEditable || form.busy || form.uncertain}>
        {parentOfForm && <div className="form-field"><label htmlFor="taxonomy-parent">{kind === 'categories' ? 'Categoria *' : 'Grupo *'}</label><input id="taxonomy-parent" value={parentOfForm.name} readOnly /></div>}
        <div className="form-field"><label htmlFor="taxonomy-name">{kind === 'categories' ? 'Nome da categoria' : 'Nome'} *{kind === 'categories' && <span className="product-info" title="Nome da Categoria de Produtos"><Icon name="circle-info" size={11} /></span>}</label>
          <input id="taxonomy-name" value={form.name} maxLength={text.max} required autoFocus onChange={event => setForm({ ...form, name: event.target.value, error: '' })} /></div>
        {kind === 'categories' && <div className="form-field real-field-wide"><span className="product-field-label" id="taxonomy-fields-label">Campos customizáveis aplicáveis nesta categoria<span className="product-info" title="Campos customizados que estarão disponíveis a partir desta categoria"><Icon name="circle-info" size={11} /></span></span>
          {customFields === null ? <p role="status">Carregando os campos customizados…</p> : customFields === 'error' ? <p className="real-help">Não foi possível carregar os campos customizados; os vínculos desta categoria não mudam ao salvar.</p>
            : !customFields.length ? <p className="real-help">Nenhum campo customizado cadastrado. <Link to="/campos-customizados">Campos customizados</Link></p>
            : <><div className="product-tags" aria-labelledby="taxonomy-fields-label">{form.fieldIds.length ? form.fieldIds.map(id => { const field = customFields.find(item => item.id === id); return <span key={id} className="product-tag">{field?.name ?? 'Campo excluído'}
                {!fieldsLocked && <button type="button" className="icon-button" aria-label={`Remover o campo ${field?.name ?? ''}`} onClick={() => setForm({ ...form, fieldIds: form.fieldIds.filter(other => other !== id) })}><Icon name="xmark" size={10} /></button>}</span>; }) : <span className="real-help">Nenhum campo</span>}</div>
              {fieldsLocked ? <small>Seu usuário não tem a permissão Campos Customizados › Inclusão e edição (Sistema › Usuários › Permissões): os campos vinculados não mudam ao salvar.</small>
                : <><SearchableSelect id="taxonomy-fields" value="" placeholder="Pesquisar campo" options={[{ value: '', label: 'Adicionar campo' }, ...customFields.filter(field => !form.fieldIds.includes(field.id)).map(field => ({ value: field.id, label: field.active ? field.name : `${field.name} (inativo)` }))]}
                onChange={event => { if (event.target.value) setForm({ ...form, fieldIds: [...form.fieldIds, event.target.value] }); }} />
              <small>Um campo sem agrupador aparece em todos os produtos; escolhido aqui, ele passa a aparecer só nas categorias marcadas no agrupador do campo (e nas subcategorias delas).</small></>}</>}</div>}
        {tagged && <div className="form-field"><label htmlFor="taxonomy-type">Tipo</label><select id="taxonomy-type" value={form.type} disabled={Boolean(form.id)} onChange={event => setForm({ ...form, type: event.target.value as TagType, group: '' })}>
          {(form.id ? [form.type] : writableTypes).map(type => <option key={type} value={type}>{TAG_TYPE_LABELS[type]}</option>)}</select>
          {form.id && <small>O tipo é definido na inclusão.</small>}</div>}
        {kind === 'tags' && <div className="form-field"><label htmlFor="taxonomy-group">Grupo</label><select id="taxonomy-group" value={form.group} disabled={Boolean(form.id)} onChange={event => setForm({ ...form, group: event.target.value })}><option value="">Selecione uma opção</option>{formGroups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select>
          {form.id && <small>O grupo é definido na inclusão da tag.</small>}</div>}
      </fieldset>
      {form.error && <p className="real-alert" role="alert">{form.error}</p>}
      <div className="real-editor-actions"><button type="button" className="secondary-button" disabled={form.busy} onClick={close}>Cancelar</button>{formEditable && <button type="submit" className="primary-button" disabled={form.busy}>{form.busy ? 'Salvando…' : form.uncertain ? 'Conferir resultado' : 'Salvar'}</button>}</div>
    </form>}
    {kind === 'categories' && <aside className="taxonomy-tip"><h2>Dica — Criando suas categorias</h2><p>Pense nas categorias como as seções de uma vitrine: o cliente encontra o produto mais rápido quando ele está no lugar certo.</p>
      <ul><li>Crie primeiro a categoria-pai (por exemplo, “Ferragens”) e depois as subcategorias com “Incluir subcategoria”.</li><li>Use nomes curtos e claros; evite categorias genéricas como “Diversos”.</li><li>Os produtos recebem a categoria no formulário (aba Características) ou em lote pela listagem de produtos.</li></ul></aside>}
    <div className="native-list-toolbar"><div className="form-field"><label htmlFor="taxonomy-search">{text.search}</label><input id="taxonomy-search" type="search" maxLength={100} value={query} placeholder={text.search} onChange={event => setQuery(event.target.value)} /></div>
      {tagged && <div className="form-field"><label htmlFor="taxonomy-type-filter">Tipo</label><select id="taxonomy-type-filter" value={typeFilter} onChange={event => { setTypeFilter(event.target.value as '' | TagType); setSelected(new Set()); }}><option value="">Todos</option>{TAG_TYPES.map(type => <option key={type} value={type}>{TAG_TYPE_LABELS[type]}</option>)}</select></div>}
      {writable && <button type="button" className={`secondary-button${selected.size ? ' is-danger' : ''}`} title="Excluir selecionados" aria-label="Excluir selecionados" disabled={!selected.size} onClick={() => startDelete(all.filter(item => selected.has(item.id)))}><Icon name="trash-can" size={13} /></button>}</div>
    {tagged && <AppliedChips chips={[...(typeFilter ? [{ label: `Tipo: ${TAG_TYPE_LABELS[typeFilter]}`, onRemove: () => setTypeFilter('') }] : []), ...(query.trim() ? [{ label: `Pesquisa: ${query.trim()}`, onRemove: () => setQuery('') }] : [])]} onClear={() => { setTypeFilter(''); setQuery(''); }} />}
    <div className="catalog-list-controls">{writable ? <ListControls checked={allSelected} indeterminate={!allSelected && ids.some(id => selected.has(id))} onToggleAll={() => setSelected(allSelected ? new Set() : new Set(ids))} onRefresh={() => setReload(value => value + 1)} />
      : <button type="button" className="origin-refresh" title="Recarregar" aria-label="Recarregar" onClick={() => setReload(value => value + 1)}><Icon name="rotate-right" size={12} /></button>}
      <div className="native-list-summary"><dl className="native-list-stat"><dt>{text.count}</dt><dd>{items ? typed.length : '—'}</dd></dl></div></div>
    {items === null ? <p role="status">Carregando…</p> : <div className="table-scroll" tabIndex={0} role="region" aria-label={text.title}><table className="data-table real-table origin-table"><thead><tr>
      {writable && <th scope="col" className="checkbox-cell"><span className="real-sr-only">Seleção</span></th>}<th scope="col">{text.column}</th>{tagged && <th scope="col">Tipo</th>}{text.parent && <th scope="col">{text.parent}</th>}{kind !== 'tag_groups' && <th scope="col" className="numeric">{kind === 'tags' ? 'Cadastros' : 'Produtos'}</th>}<th scope="col" className="row-actions"><span className="real-sr-only">Ações</span></th></tr></thead>
      <tbody>{visible.map(({ item, depth }) => <tr key={item.id} className={selected.has(item.id) ? 'selected' : undefined}>
        {writable && <td className="checkbox-cell">{canWrite(item) && <input type="checkbox" aria-label={`Selecionar ${item.name}`} checked={selected.has(item.id)} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; })} />}</td>}
        <td><span className="taxonomy-name" style={{ paddingLeft: `${depth * 18}px` }}>{depth > 0 && <span className="taxonomy-connector" aria-hidden="true">└</span>}<button type="button" className="text-button record-link" onClick={() => edit(item)}>{item.name}</button></span></td>
        {tagged && <td>{TAG_TYPE_LABELS[typeOf(item)]}</td>}{text.parent && <td>{parentName(item)}</td>}{kind !== 'tag_groups' && <td className="numeric">{used(item)}</td>}
        <td className="row-actions"><RowMenu label={item.name} items={rowMenu(item)} open={menu === item.id} onToggle={() => setMenu(menu === item.id ? null : item.id)} /></td></tr>)}</tbody></table>
      {!visible.length && <div className="origin-empty"><span><Icon name="exclamation" size={22} /></span><h2>{query || typeFilter ? 'Nenhum resultado encontrado.' : text.empty}</h2><p>{query ? 'Verifique se as palavras estão corretas ou busque por outros termos.' : writable ? 'Ainda não existem cadastros no seu sistema, comece agora mesmo.' : ''}</p>
        {!query && writable && <button type="button" className="primary-button" onClick={() => open({})}><Icon name="plus" size={12} />{text.add}</button>}</div>}</div>}
    <p className="real-help">{kind === 'categories' ? 'Categorias do FAGOO; as categorias de produtos do Origin ainda não são espelhadas aqui.' : kind === 'product_groups' ? 'O grupo de produtos é escolhido na aba Tributação do produto.' : 'As tags de Produtos são marcadas no produto (Características > Editar tags) ou em lote pela listagem de produtos; as de Contatos, no cadastro do cliente ou fornecedor (Editar tags) ou em lote pela listagem de contatos; as de Notas fiscais, na coluna Marcadores das listagens de notas fiscais (ficam só no FAGOO, não vão para o Origin).'} {kind === 'tags' ? <Link to="/grupos-tags">Gerenciar grupos de tags</Link> : kind === 'tag_groups' ? <Link to="/tags">Gerenciar tags</Link> : <Link to="/cadastros-reais?cadastro=products">Voltar aos produtos</Link>}</p>
    {batch && plan && <BatchDialog title="Excluir selecionados" plan={plan} confirmLabel="Excluir" run={runDelete} onClose={closeBatch}
      description={<p>{kind === 'categories' ? 'Os produtos das categorias excluídas ficam “Sem categoria”.' : kind === 'tags' ? 'As tags excluídas saem dos produtos, dos contatos ou das notas fiscais que as tinham.' : 'Um grupo com subníveis ou em uso não é excluído.'} Nada é apagado dos cadastros além desse vínculo.</p>} />}
  </section>;
}
function depthOf(items: readonly TaxonomyItem[], item: TaxonomyItem) { let depth = 0, current: TaxonomyItem | undefined = item; while (current?.parent_id && depth < 50) { current = items.find(other => other.id === current!.parent_id); depth++; } return depth; }
