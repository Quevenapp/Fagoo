import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { TAXONOMY_SLUG, fold, ofTagType, type TagType, type TaxonomyItem } from '../lib/product-form-model';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { aborted, errorText } from './catalog-shared';
import { PERMISSIONS_PATH } from '../lib/system-model';
import { allowedBy, parseMyPermissions } from '../../../../packages/erp-domain/src/user-permissions.mjs';
import './product-registry.css';

type Controller = Pick<AccessController, 'catalog'> & Partial<Pick<AccessController, 'system'>>;
/** Gaveta "Tags" do Origin (produto ou contato): tags por grupo com pesquisa, "Adicionar tag" e "Adicionar grupo" do mesmo Tipo.
 * Uma inclusão é um comando (command_id) com "Conferir resultado"; marcar as tags não grava nada até quem abriu a gaveta aplicar. */
export function TagsDrawer({ controller, writable, tags, groups, selected, onCancel, onApply, title = 'Tags', applyLabel = 'Ok', tagType = 'products', subject = 'ao produto', busy: applying = false }: {
  controller: Controller; writable: boolean; tags: TaxonomyItem[]; groups: TaxonomyItem[]; selected: string[]; onCancel: () => void; onApply: (ids: string[]) => void;
  title?: string; applyLabel?: string; tagType?: TagType; subject?: string; busy?: boolean;
}) {
  const [checked, setChecked] = useState(() => new Set(selected));
  const [all, setAll] = useState(() => ({ tags: ofTagType(tags, tagType), groups: ofTagType(groups, tagType) }));
  const [adding, setAdding] = useState<null | { kind: 'tags' | 'tag_groups'; name: string; group: string; command: string; uncertain: boolean }>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [filter, setFilter] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  // 202610200282: "Adicionar tag" needs "Cadastro de tags" and "Adicionar grupo" needs "Cadastro de grupos de tags" (Sistema › Usuários ›
  // Permissões › Outros); marking tags keeps the permission of the record. Unreadable permissions keep the buttons (the server decides).
  const [screens, setScreens] = useState<{ tags: boolean; groups: boolean }>({ tags: true, groups: true });
  useEffect(() => {
    if (!writable || typeof controller.system !== 'function') return;
    const signal = new AbortController();
    void Promise.resolve().then(() => controller.system!(PERMISSIONS_PATH, { method: 'GET', signal: signal.signal })).then(raw => {
      if (signal.signal.aborted) return;
      const view = parseMyPermissions(raw);setScreens({ tags: allowedBy(view, 'outros.tags'), groups: allowedBy(view, 'outros.grupos_tags') });
    }).catch(() => { /* The server still decides. */ });
    return () => signal.abort();
  }, [controller, writable]);
  const save = async () => {
    if (!adding || busy) return;
    const name = adding.name.trim();
    if (!name || name.length > 60) { setError('Informe o nome com até 60 caracteres.'); return; }
    const signal = new AbortController(); request.current = signal; setBusy(true); setError('');
    try {
      const result = await controller.catalog(`/v1/cadastros/taxonomias/${TAXONOMY_SLUG[adding.kind]}`, { method: 'POST', body: { command_id: adding.command, data: { name, tag_type: tagType, ...(adding.kind === 'tags' && adding.group ? { parent_id: adding.group } : {}) } }, signal: signal.signal }) as { saved?: boolean; reason?: string; item?: TaxonomyItem };
      if (signal.signal.aborted) return;
      if (!result.saved || !result.item) { setError('Já existe um registro com este nome.'); setAdding(current => current && { ...current, command: crypto.randomUUID(), uncertain: false }); return; }
      const item = result.item;
      setAll(current => adding.kind === 'tags' ? { ...current, tags: [...current.tags, item] } : { ...current, groups: [...current.groups, item] });
      if (adding.kind === 'tags') setChecked(current => new Set(current).add(item.id));
      setAdding(null);
    } catch (failure) {
      if (signal.signal.aborted || aborted(failure)) return;
      const known = failure instanceof AccessError && [400, 403, 409].includes(failure.status);
      setAdding(current => current && { ...current, uncertain: !known, command: known ? crypto.randomUUID() : current.command });
      setError(known ? errorText(failure) : 'Não foi possível confirmar a inclusão. Use “Conferir resultado” para repetir o mesmo comando sem duplicar.');
    } finally { if (request.current === signal) { request.current = null; setBusy(false); } }
  };
  const visible = all.tags.filter(tag => !filter.trim() || fold(tag.name).includes(fold(filter.trim())));
  const byGroup = [{ id: null as string | null, name: 'Sem grupo' }, ...[...all.groups].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))].map(group => ({ group, items: visible.filter(tag => (tag.parent_id ?? null) === group.id).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')) })).filter(entry => entry.items.length);
  const locked = busy || applying;
  return <Modal title={title} onClose={() => { if (!locked && !adding?.uncertain) onCancel(); }} actions={<><button type="button" className="secondary-button" disabled={locked} onClick={() => setChecked(new Set())}>Desmarcar todos</button><button type="button" className="secondary-button" disabled={locked || Boolean(adding?.uncertain)} onClick={onCancel}>Cancelar</button><button type="button" className="primary-button" disabled={locked || Boolean(adding)} onClick={() => onApply([...checked].filter(id => all.tags.some(tag => tag.id === id)))}>{applyLabel}</button></>}>
    <p>Marque as tags relacionadas {subject}</p>
    <input aria-label="Pesquisar tags" placeholder="Pesquisar por nome" value={filter} maxLength={60} onChange={event => setFilter(event.target.value)} />
    <div className="product-tag-groups">{byGroup.length ? byGroup.map(({ group, items }) => <details key={group.id ?? 'none'} open><summary>{group.name}</summary>
      {items.map(tag => <label key={tag.id} className="product-check"><input type="checkbox" checked={checked.has(tag.id)} disabled={applying} onChange={event => setChecked(current => { const next = new Set(current); if (event.target.checked) next.add(tag.id); else next.delete(tag.id); return next; })} />{tag.name}</label>)}</details>)
      : <p className="real-help">Nenhuma tag cadastrada.</p>}</div>
    {writable && !adding && (screens.tags || screens.groups) && <div className="product-inline">{screens.tags && <button type="button" className="text-button" disabled={applying} onClick={() => setAdding({ kind: 'tags', name: '', group: '', command: crypto.randomUUID(), uncertain: false })}><Icon name="plus" size={11} />Adicionar tag</button>}
      {screens.groups && <button type="button" className="text-button" disabled={applying} onClick={() => setAdding({ kind: 'tag_groups', name: '', group: '', command: crypto.randomUUID(), uncertain: false })}><Icon name="plus" size={11} />Adicionar grupo</button>}</div>}
    {adding && <div className="product-inline product-adding"><label className="real-sr-only" htmlFor="product-new-tag">{adding.kind === 'tags' ? 'Nome da tag' : 'Nome do grupo'}</label><input id="product-new-tag" placeholder={adding.kind === 'tags' ? 'Nome da tag' : 'Nome do grupo de tags'} value={adding.name} maxLength={60} disabled={busy || adding.uncertain} onChange={event => setAdding({ ...adding, name: event.target.value })} />
      {adding.kind === 'tags' && <select aria-label="Grupo da tag" value={adding.group} disabled={busy || adding.uncertain} onChange={event => setAdding({ ...adding, group: event.target.value })}><option value="">Selecione uma opção</option>{all.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select>}
      <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>{adding.uncertain ? 'Conferir resultado' : 'Salvar'}</button>{!adding.uncertain && <button type="button" className="text-button" disabled={busy} onClick={() => { setAdding(null); setError(''); }}>Cancelar</button>}</div>}
    {error && <p className="real-alert" role="alert">{error}</p>}
  </Modal>;
}
