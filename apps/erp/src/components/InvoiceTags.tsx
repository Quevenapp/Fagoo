import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AccessError, type AccessController } from '../lib/real-access';
import { TAXONOMY_SLUG, ofTagType, taxonomyItems, type TaxonomyItem } from '../lib/product-form-model';
import { invoiceTagKey, invoiceTagSavePath, invoiceTagsQuery, parseInvoiceTagSave, parseInvoiceTagSets, type InvoiceTagOrigin, type InvoiceTagSet } from '../lib/invoice-tags-model';
import { SearchableSelect, type SearchOption } from './SearchableSelect';
import { TagsDrawer } from './TagsDrawer';
import { Icon } from './Icon';
import { Modal } from './Modal';
import './product-registry.css';

// Marcadores (tags) das notas fiscais (migração 202610200236, área de produtos): as tags da página na coluna Marcadores, "Editar
// tags" de uma nota (gaveta Tags com o Tipo Notas fiscais, um comando com a versão do conjunto de tags e "Conferir resultado") e
// o filtro Tags da listagem. As tags ficam só no Brufap: não vão para o Origin e as do Origin não são espelhadas.
type Row = { origin: string; id: string };
type Pending = { id: string; label: string; body: { command_id: string; expected_version: number; tag_ids: string[] }; actor: string | null; busy: boolean; uncertain: boolean };
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const actorOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.user_id ?? null;
const NO_TAXONOMY: { tags: TaxonomyItem[]; groups: TaxonomyItem[] } = { tags: [], groups: [] };
const listsOf = (taxonomy: { tags: TaxonomyItem[]; groups: TaxonomyItem[] } | null | 'error') => taxonomy && taxonomy !== 'error' ? taxonomy : NO_TAXONOMY;

/** The screen protects an unconfirmed save (pending.uncertain) with its own unsaved-changes guard. */
export function useInvoiceTags(controller: AccessController, origin: InvoiceTagOrigin, model: '55' | '65', rows: readonly Row[], writable: boolean) {
  const [sets, setSets] = useState<{ scope: string; items: Map<string, InvoiceTagSet> } | null>(null), [failed, setFailed] = useState(false);
  const [taxonomy, setTaxonomy] = useState<{ tags: TaxonomyItem[]; groups: TaxonomyItem[] } | null | 'error'>(null);
  const [editing, setEditing] = useState<{ id: string; label: string; set: InvoiceTagSet } | null>(null), [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState<{ kind: 'notice' | 'error'; text: string } | null>(null), [reload, setReload] = useState(0);
  const saveRequest = useRef<AbortController | null>(null);
  const scope = `${origin}:${model}`, ids = rows.filter(row => row.origin === origin && invoiceTagKey(origin, row.id)).map(row => row.id), idsKey = ids.join(',');
  useEffect(() => () => saveRequest.current?.abort(), []);
  // The tags of the listed notes (one read per page); a late answer of another page or origin is ignored.
  useEffect(() => {
    setFailed(false);
    if (!ids.length) { setSets({ scope, items: new Map() }); return; }
    const request = new AbortController();
    void Promise.resolve().then(() => controller.catalog(invoiceTagsQuery(origin, model, ids), { signal: request.signal })).then(value => {
      if (request.signal.aborted) return;
      setSets({ scope, items: new Map(parseInvoiceTagSets(value, origin, model, ids).map(set => [set.invoice_id, set])) });
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) { setSets(null); setFailed(true); } });
    return () => request.abort();
  }, [controller, scope, idsKey, reload]);
  // Tags and groups of Notas fiscais, for the filter and the drawer.
  useEffect(() => {
    const request = new AbortController();
    void Promise.all((['tags', 'tag_groups'] as const).map(kind => Promise.resolve().then(() => controller.catalog(`/v1/cadastros/taxonomias/${TAXONOMY_SLUG[kind]}`, { signal: request.signal }))
      .then(value => ofTagType(taxonomyItems(value, kind), 'invoices')))).then(([tags, groups]) => { if (!request.signal.aborted) setTaxonomy({ tags: tags!, groups: groups! }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setTaxonomy('error'); });
    return () => request.abort();
  }, [controller]);
  // A profile that stops writing (or another origin) closes the drawer; an unconfirmed command stays to be checked.
  useEffect(() => { if (!writable) setEditing(null); }, [writable]);
  useEffect(() => { setEditing(null); setMessage(null); }, [scope]);
  const current = sets?.scope === scope ? sets.items : null;
  const send = async (operation: Pending) => {
    if (saveRequest.current) return;
    // Another user in this session: nothing is sent (the command belongs to the user who started it).
    if (actorOf(controller) !== operation.actor) { setPending(null); setEditing(null); setMessage({ kind: 'error', text: 'A sessão mudou. As tags não foram enviadas.' }); return; }
    const request = new AbortController(); saveRequest.current = request; setPending({ ...operation, busy: true }); setMessage(null);
    try {
      const result = parseInvoiceTagSave(await controller.catalog(invoiceTagSavePath(origin, model, operation.id), { method: 'PATCH', body: operation.body, signal: request.signal }), origin, model, operation.id);
      if (request.signal.aborted) return;
      setSets(value => value && value.scope === scope ? { scope, items: new Map(value.items).set(operation.id, result.set) } : value);
      setPending(null); setEditing(null);
      setMessage({ kind: 'notice', text: result.replayed ? `Tags da nota ${operation.label} confirmadas.` : result.changed ? `Tags da nota ${operation.label} salvas.` : `As tags da nota ${operation.label} não mudaram.` });
    } catch (failure) {
      if (request.signal.aborted) return;
      // A refusal is definitive even when repeating: a command already applied answers with its stored result, not a refusal.
      const known = !aborted(failure) && failure instanceof AccessError && [400, 403, 404, 409].includes(failure.status);
      if (known) {
        setPending(null); setEditing(null); setReload(value => value + 1);
        setMessage({ kind: 'error', text: (failure as AccessError).status === 409 ? `As tags da nota ${operation.label} foram alteradas por outra operação. A coluna Marcadores foi atualizada; abra “Editar tags” de novo.`
          : (failure as AccessError).status === 403 ? 'Seu perfil não permite alterar as tags das notas.' : (failure as AccessError).status === 404 ? 'Nota não encontrada. Recarregue a listagem.' : 'O servidor recusou as tags informadas.' });
      } else setPending({ ...operation, busy: false, uncertain: true });
    } finally { if (saveRequest.current === request) saveRequest.current = null; }
  };
  const edit = (id: string, label: string) => { const set = current?.get(id); if (!writable || !set || pending || !taxonomy || taxonomy === 'error') return; setMessage(null); setEditing({ id, label, set }); };
  const apply = (tagIds: string[]) => {
    if (!editing) return;
    const same = tagIds.length === editing.set.tag_ids.length && tagIds.every(id => editing.set.tag_ids.includes(id));
    if (same) { setEditing(null); return; }
    void send({ id: editing.id, label: editing.label, body: { command_id: crypto.randomUUID(), expected_version: editing.set.version, tag_ids: [...tagIds].sort() }, actor: actorOf(controller), busy: false, uncertain: false });
  };
  return { origin, model, writable, sets: current, failed, taxonomy, editing, pending, message, edit, apply, send, setEditing, setPending, setMessage };
}
export type InvoiceTagsState = ReturnType<typeof useInvoiceTags>;

/** Marcadores of one note: its tags and, for the profiles that write notes, "Editar tags". */
export function InvoiceTagCell({ state, row, label }: { state: InvoiceTagsState; row: Row; label: string }) {
  const set = state.sets?.get(row.id);
  if (row.origin !== state.origin) return null;
  return <span className="invoice-tags" onClick={event => event.stopPropagation?.()}>
    {set?.tags.map(tag => <span key={tag.id} className="product-tag" title={tag.group_name ? `${tag.group_name} › ${tag.name}` : tag.name}>{tag.name}</span>)}
    {state.writable && <button type="button" className="icon-button" title={state.failed ? 'Não foi possível ler as tags desta página.' : 'Editar tags'} aria-label={`Editar tags da nota ${label}`}
      disabled={!set || Boolean(state.pending) || !state.taxonomy || state.taxonomy === 'error'} onClick={() => state.edit(row.id, label)}><Icon name="tags" size={11} /></button>}
  </span>;
}

/** Filtro Tags (Todos | Sem Tag | as tags de Notas fiscais por grupo). */
export function InvoiceTagFilter({ state, value, onChange }: { state: InvoiceTagsState; value: { id: string; name: string } | null; onChange: (value: { id: string; name: string } | null) => void }) {
  const { tags, groups } = listsOf(state.taxonomy);
  const options: SearchOption[] = [{ value: '', label: 'Todos' }, { value: 'none', label: 'Sem Tag' },
    ...tags.filter(tag => !groups.some(group => group.id === tag.parent_id)).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')).map(tag => ({ value: tag.id, label: tag.name })),
    ...[...groups].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')).flatMap(group => tags.filter(tag => tag.parent_id === group.id).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')).map(tag => ({ value: tag.id, label: tag.name, group: group.name }))),
    ...(value && value.id !== 'none' && !tags.some(tag => tag.id === value.id) ? [{ value: value.id, label: value.name }] : [])];
  return <div className="form-field"><label htmlFor="fiscal-tag-filter">Tags<Link className="catalog-copy" to="/tags?tipo=notas" title="Gerenciar tags" aria-label="Gerenciar tags"><Icon name="gear" size={11} /></Link></label>
    <SearchableSelect id="fiscal-tag-filter" value={value?.id ?? ''} options={options} onChange={event => { const id = event.target.value; onChange(id ? { id, name: options.find(option => option.value === id)?.label ?? 'Tag' } : null); }} />
    {state.taxonomy === 'error' && <small className="real-help">Não foi possível carregar as tags; o filtro oferece só Todos e Sem Tag.</small>}</div>;
}

/** Messages, the Tags drawer of one note and the check of an unconfirmed save. */
export function InvoiceTagsOverlay({ controller, state }: { controller: AccessController; state: InvoiceTagsState }) {
  const { tags, groups } = listsOf(state.taxonomy);
  return <>
    {state.message && <p className={state.message.kind === 'error' ? 'real-alert' : 'real-success'} role={state.message.kind === 'error' ? 'alert' : 'status'}>{state.message.text}</p>}
    {state.failed && <p className="real-help">Não foi possível ler as tags das notas desta página (coluna Marcadores).</p>}
    {state.editing && !state.pending?.uncertain && <TagsDrawer controller={controller} writable={state.writable} tags={tags} groups={groups} selected={state.editing.set.tag_ids} tagType="invoices" subject={`à nota ${state.editing.label}`}
      title="Tags" applyLabel={state.pending?.busy ? 'Salvando…' : 'Salvar tags'} busy={Boolean(state.pending?.busy)} onCancel={() => { if (!state.pending) state.setEditing(null); }} onApply={state.apply} />}
    {state.pending?.uncertain && <Modal title="Tags da nota" onClose={() => undefined} actions={<button type="button" className="primary-button" disabled={state.pending.busy} onClick={() => void state.send(state.pending!)}>{state.pending.busy ? 'Conferindo…' : 'Conferir resultado'}</button>}>
      <p role="alert">Não foi possível confirmar as tags da nota {state.pending.label}. Use “Conferir resultado” para repetir a mesma operação sem duplicar a alteração.</p></Modal>}
  </>;
}
