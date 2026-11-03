import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { AccessError, type AccessController } from '../lib/real-access';
import { TAXONOMY_SLUG, ofTagType, taxonomyItems, type TaxonomyItem } from '../lib/product-form-model';
import { planBatch, type BatchResult, type BatchStep } from '../lib/origin-batch';
import { BatchDialog } from './BatchDialog';
import { TagsDrawer } from './TagsDrawer';
import { Icon } from './Icon';
import { aborted, errorText, knownFailure } from './catalog-shared';
import './product-registry.css';

// Tags de Contatos (produtos lane, migração 153) na listagem e no formulário de Clientes e fornecedores: filtro Tags (Todos |
// Sem Tag | tags por grupo, com a engrenagem da tela Tags) e Lista de preço, a coluna Marcadores, "Incluir tags para
// selecionados" (acrescenta, um comando por contato) e "Editar tags" no formulário (substitui, com a versão das tags do
// contato). As tags do contato têm versão própria: gravá-las não muda a versão do cadastro aberto no formulário.
export type ContactTag = { id: string; name: string; group_id: string | null; group_name: string | null };
export type ContactTagSet = { contact_id: string; version: number; tag_ids: string[]; tags: ContactTag[] };
export type PriceListOption = { id: string; name: string };
export interface ContactTagOptions { tags: TaxonomyItem[]; groups: TaxonomyItem[]; loaded: boolean; failed: boolean; lists: PriceListOption[] | null; listsState: 'loading' | 'ready' | 'forbidden' | 'failed' }
const BASE = '/v1/cadastros/contatos';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Controller = Pick<AccessController, 'catalog' | 'getSnapshot'>;

/** One contact's tags as the API answers them, checked again on the screen. */
export function tagSet(value: unknown, id?: string): ContactTagSet {
  const set = value as ContactTagSet | null;
  if (!set || typeof set !== 'object' || !UUID.test(set.contact_id) || (id && set.contact_id !== id) || !Number.isInteger(set.version) || set.version < 0 || !Array.isArray(set.tag_ids)
    || !Array.isArray(set.tags) || set.tags.some(tag => !tag || typeof tag !== 'object' || !UUID.test(tag.id) || typeof tag.name !== 'string')) throw new AccessError(502);
  return { contact_id: set.contact_id, version: set.version, tag_ids: [...set.tag_ids], tags: set.tags.map(tag => ({ id: tag.id, name: tag.name, group_id: tag.group_id ?? null, group_name: tag.group_name ?? null })) };
}

/** Contatos tags and groups (for the filter, the drawer and the batch) and the price lists (only with the products permission). */
export function useContactTagOptions(controller: Controller, enabled: boolean, priceLists: boolean): ContactTagOptions {
  const [state, setState] = useState<ContactTagOptions>({ tags: [], groups: [], loaded: false, failed: false, lists: null, listsState: 'loading' });
  useEffect(() => {
    if (!enabled) return;
    const request = new AbortController();
    void Promise.all((['tags', 'tag_groups'] as const).map(kind => Promise.resolve().then(() => controller.catalog(`/v1/cadastros/taxonomias/${TAXONOMY_SLUG[kind]}`, { signal: request.signal })).then(value => ofTagType(taxonomyItems(value, kind), 'contacts'))))
      .then(([tags, groups]) => { if (!request.signal.aborted) setState(current => ({ ...current, tags, groups, loaded: true, failed: false })); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setState(current => ({ ...current, loaded: true, failed: true })); });
    if (!priceLists) setState(current => ({ ...current, lists: null, listsState: 'forbidden' }));
    else void Promise.resolve().then(() => controller.catalog('/v1/cadastros/listas-precos', { signal: request.signal })).then(value => {
      const items = (value as { items?: { id?: unknown; name?: unknown }[] }).items;
      if (request.signal.aborted) return;
      if (!Array.isArray(items) || items.some(item => typeof item?.id !== 'string' || typeof item.name !== 'string')) throw new AccessError(502);
      setState(current => ({ ...current, lists: items.map(item => ({ id: item.id as string, name: item.name as string })), listsState: 'ready' }));
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) setState(current => ({ ...current, lists: null, listsState: failure instanceof AccessError && failure.status === 403 ? 'forbidden' : 'failed' })); });
    return () => request.abort();
  }, [controller, enabled, priceLists]);
  return state;
}

/** Tags: Todos | Sem Tag | tags by group (gear: the Tags screen of Contatos) and Lista de preço: Todas | lists. */
export function ContactTagFilters({ options, tag, priceList, onTag, onPriceList }: { options: ContactTagOptions; tag: string; priceList: string; onTag: (value: string) => void; onPriceList: (value: string) => void }) {
  const ungrouped = options.tags.filter(item => !item.parent_id || !options.groups.some(group => group.id === item.parent_id));
  const byName = (a: TaxonomyItem, b: TaxonomyItem) => a.name.localeCompare(b.name, 'pt-BR');
  const listTitle = options.listsState === 'forbidden' ? 'Seu perfil não consulta as listas de preços.' : options.listsState === 'failed' ? 'Não foi possível carregar as listas de preços.' : undefined;
  return <>
    <div className="form-field"><label htmlFor="contact-tag-filter">Tags<Link className="catalog-copy" to="/tags?tipo=contatos" title="Gerenciar tags" aria-label="Gerenciar tags"><Icon name="gear" size={11} /></Link></label>
      <select id="contact-tag-filter" value={tag} disabled={options.failed} title={options.failed ? 'Não foi possível carregar as tags.' : undefined} onChange={event => onTag(event.target.value)}>
        <option value="">Todos</option><option value="none">Sem Tag</option>
        {[...ungrouped].sort(byName).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        {[...options.groups].sort(byName).map(group => { const items = options.tags.filter(item => item.parent_id === group.id).sort(byName);
          return items.length ? <optgroup key={group.id} label={group.name}>{items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup> : null; })}
        {tag && tag !== 'none' && !options.tags.some(item => item.id === tag) && <option value={tag}>Tag selecionada</option>}</select></div>
    <div className="form-field"><label htmlFor="contact-price-list-filter">Lista de preço</label>
      <select id="contact-price-list-filter" value={priceList} disabled={!options.lists} title={listTitle} onChange={event => onPriceList(event.target.value)}><option value="">Todas</option>
        {(options.lists ?? []).map(list => <option key={list.id} value={list.id}>{list.name}</option>)}
        {priceList && !(options.lists ?? []).some(list => list.id === priceList) && <option value={priceList}>Lista selecionada</option>}</select>
      {options.listsState === 'ready' && <small className="real-help">Contatos vinculados à lista (categoria Contato) ou da UF da lista (categoria Região).</small>}</div>
  </>;
}
export function contactTagChips(filters: { tag: string; price_list_id: string }, options: ContactTagOptions, remove: (change: { tag?: string; price_list_id?: string }) => () => void) {
  return [
    ...(filters.tag ? [{ label: `Tags: ${filters.tag === 'none' ? 'Sem Tag' : options.tags.find(item => item.id === filters.tag)?.name ?? 'tag selecionada'}`, onRemove: remove({ tag: '' }) }] : []),
    ...(filters.price_list_id ? [{ label: `Lista de preço: ${options.lists?.find(list => list.id === filters.price_list_id)?.name ?? 'lista selecionada'}`, onRemove: remove({ price_list_id: '' }) }] : []),
  ];
}

/** Marcadores: the tags of the contacts on the page, read after the page (one request, up to 100 contacts). */
export function useContactMarkers(controller: Controller, ids: readonly string[], key: string) {
  const [state, setState] = useState<{ key: string; sets: Map<string, ContactTagSet>; failed: boolean }>({ key: '', sets: new Map(), failed: false });
  const joined = ids.join(',');
  useEffect(() => {
    if (!ids.length) return;
    const request = new AbortController();
    void Promise.resolve().then(() => controller.catalog(`${BASE}/tags?${new URLSearchParams({ ids: joined })}`, { signal: request.signal })).then(value => {
      const items = (value as { items?: unknown[] }).items;
      if (request.signal.aborted) return;
      if (!Array.isArray(items)) throw new AccessError(502);
      const sets = new Map(items.map(item => tagSet(item)).filter(set => ids.includes(set.contact_id)).map(set => [set.contact_id, set] as const));
      setState({ key: `${key}|${joined}`, sets, failed: false });
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) setState({ key: `${key}|${joined}`, sets: new Map(), failed: true }); });
    return () => request.abort();
  }, [controller, key, joined]);
  // A page that changed shows no markers until its own answer arrives (never the tags of another page).
  return state.key === `${key}|${joined}` ? state : { key: '', sets: new Map<string, ContactTagSet>(), failed: false };
}
export function ContactMarkers({ set, failed }: { set: ContactTagSet | undefined; failed: boolean }) {
  if (failed) return <span className="real-help" title="Não foi possível carregar as tags.">—</span>;
  if (!set?.tags.length) return null;
  return <span className="product-tags">{set.tags.map(tag => <span key={tag.id} className="product-tag" title={tag.group_name ? `Grupo: ${tag.group_name}` : undefined}>{tag.name}</span>)}</span>;
}

type BatchContact = { id: string; label: string; excluded: boolean };
/** "Incluir tags para selecionados": choose the tags, then one command per contact (mode add, the tags it has stay). */
export function ContactTagsBatch({ controller, items, options, writable, onClose }: { controller: Controller; items: readonly BatchContact[]; options: ContactTagOptions; writable: boolean; onClose: (results: BatchResult[] | null) => void }) {
  const [tags, setTags] = useState<string[] | null>(null);
  const request = useRef<AbortController | null>(null), actor = useRef(controller.getSnapshot().membership?.user_id);
  useEffect(() => () => request.current?.abort(), []);
  if (!tags) return <TagsDrawer controller={controller} writable={writable} tags={options.tags} groups={options.groups} selected={[]} title="Incluir tags para selecionados" applyLabel="Incluir tags" tagType="contacts" subject="aos contatos"
    onCancel={() => onClose(null)} onApply={ids => { if (!ids.length) { onClose(null); return; } request.current = new AbortController(); setTags(ids); }} />;
  const plan = planBatch([...items], item => item.excluded ? 'Cadastro excluído; restaure-o antes.' : null);
  const run = async (item: BatchContact): Promise<BatchStep> => {
    const snapshot = controller.getSnapshot(), signal = request.current?.signal;
    if (!signal || signal.aborted || snapshot.phase !== 'ready' || snapshot.membership?.user_id !== actor.current) throw new Error('A sessão mudou durante a operação. Este cadastro não foi enviado.');
    const body = { command_id: crypto.randomUUID(), mode: 'add', tag_ids: tags };
    const send = async () => {
      const result = await controller.catalog(`${BASE}/${item.id}/tags`, { method: 'PATCH', body, signal }) as { contact?: unknown; changed?: boolean };
      const set = tagSet(result.contact, item.id); if (tags.some(id => !set.tag_ids.includes(id))) throw new AccessError(502);
      return result.changed === false ? { message: 'Já tinha as tags marcadas.' } : undefined;
    };
    try { return await send(); }
    catch (failure) {
      if (!aborted(failure) && knownFailure(failure)) throw new Error(failure instanceof AccessError && failure.status === 404 ? 'O cadastro não foi encontrado.' : errorText(failure));
      // Unknown outcome: the same command once more; a replay confirms it without adding twice.
      try { if (!signal.aborted) { await send(); return { message: 'Confirmado ao repetir a mesma operação.' }; } } catch { /* Still unknown. */ }
      return { uncertain: true, message: 'Não foi possível confirmar o resultado. Atualize a listagem e confira o cadastro antes de repetir.' };
    }
  };
  return <BatchDialog title="Incluir tags para selecionados" plan={plan} confirmLabel="Incluir tags" run={run} onClose={results => { request.current = null; onClose(results); }}
    description={<p>Tags incluídas: {tags.map(id => options.tags.find(item => item.id === id)?.name ?? '').filter(Boolean).join(', ')}. As tags que o contato já tem continuam.</p>} />;
}

type Pending = { command: string; tags: string[]; expected: number; uncertain: boolean };
/** Tags in the contact form ("Editar tags"): saved on their own (button "Salvar tags"), with the version of the contact's tags. */
export function ContactTagsField({ controller, record, writable }: { controller: Controller; record: { id: string; situation?: string } | null; writable: boolean }) {
  const [set, setSet] = useState<ContactTagSet | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [reload, setReload] = useState(0);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [pending, setPending] = useState<Pending | null>(null);
  const options = useContactTagOptions(controller, Boolean(record) && open, false);
  const request = useRef<AbortController | null>(null), save = useRef<AbortController | null>(null);
  useUnsavedChanges(Boolean(pending?.uncertain), busy || Boolean(pending?.uncertain));
  useEffect(() => () => { request.current?.abort(); save.current?.abort(); }, []);
  useEffect(() => {
    if (!record) return;
    const signal = new AbortController(); request.current?.abort(); request.current = signal;
    void Promise.resolve().then(() => controller.catalog(`${BASE}/${record.id}/tags`, { signal: signal.signal })).then(value => {
      if (signal.signal.aborted) return; setSet(tagSet((value as { contact?: unknown }).contact, record.id)); setError('');
    }).catch(failure => { if (!signal.signal.aborted && !aborted(failure)) setError('Não foi possível carregar as tags deste contato.'); });
    return () => signal.abort();
  }, [controller, record?.id, reload]);
  const send = async (operation: Pending) => {
    if (!record || save.current) return;
    const signal = new AbortController(); save.current = signal; setBusy(true); setError(''); setNotice('');
    try {
      const result = await controller.catalog(`${BASE}/${record.id}/tags`, { method: 'PATCH', body: { command_id: operation.command, expected_version: operation.expected, mode: 'replace', tag_ids: operation.tags }, signal: signal.signal }) as { contact?: unknown; replayed?: boolean };
      if (signal.signal.aborted) return;
      const next = tagSet(result.contact, record.id);
      setPending(null); setOpen(false); setSet(next); setNotice(result.replayed ? 'Tags confirmadas.' : 'Tags salvas.');
    } catch (failure) {
      if (signal.signal.aborted) return;
      const known = !operation.uncertain && !aborted(failure) && knownFailure(failure);
      if (known) { setPending(null); setOpen(false); setError(failure instanceof AccessError && failure.status === 409 ? 'As tags deste contato foram alteradas por outra operação. Confira as tags atuais e edite de novo.' : errorText(failure)); setReload(value => value + 1); }
      else { setPending({ ...operation, uncertain: true }); setError('Não foi possível confirmar as tags. Use “Conferir resultado” para repetir a mesma operação sem duplicar.'); }
    } finally { if (save.current === signal) { save.current = null; setBusy(false); } }
  };
  const excluded = record?.situation === 'E';
  const reason = !record ? 'Salve o cadastro para incluir as tags.' : excluded ? 'Cadastro excluído: restaure-o para editar as tags.' : !writable ? 'Seu perfil não altera os contatos.' : !set ? 'Carregando as tags…' : undefined;
  return <div className="form-field real-field-wide contact-tags-field"><span className="product-field-label">Tags</span>
    <div className="product-tags">{set?.tags.length ? set.tags.map(tag => <span key={tag.id} className="product-tag" title={tag.group_name ? `Grupo: ${tag.group_name}` : undefined}>{tag.name}</span>) : <span className="real-help">Nenhuma tag</span>}
      <button type="button" id="contact-tag_ids" className="text-button" disabled={Boolean(reason) || busy || Boolean(pending?.uncertain)} title={reason} onClick={() => { setNotice(''); setOpen(true); }}><Icon name="tags" size={11} />Editar tags</button>
      <Link className="catalog-copy" to="/tags?tipo=contatos" title="Gerenciar tags" aria-label="Gerenciar tags"><Icon name="gear" size={11} /></Link></div>
    <small className="real-help">As tags são gravadas ao clicar em “Salvar tags”, separadas dos demais dados do cadastro.</small>
    {notice && <small role="status">{notice}</small>}
    {error && <p className="real-alert" role="alert">{error}{pending?.uncertain && <button type="button" className="text-button" disabled={busy} onClick={() => void send(pending)}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button>}</p>}
    {open && set && record && (options.failed ? <p className="real-alert" role="alert">Não foi possível carregar as tags de Contatos.<button type="button" className="text-button" onClick={() => setOpen(false)}>Fechar</button></p>
      : !options.loaded ? <p role="status">Carregando as tags…</p> : <TagsDrawer controller={controller} writable={writable} tags={options.tags} groups={options.groups} selected={set.tag_ids} title="Tags" applyLabel="Salvar tags" tagType="contacts" subject="ao contato" busy={busy}
        onCancel={() => { if (!busy) setOpen(false); }} onApply={ids => void send({ command: crypto.randomUUID(), tags: ids, expected: set.version, uncertain: false })} />)}
  </div>;
}
