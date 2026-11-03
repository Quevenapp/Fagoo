import { useState } from 'react';
import type { AccessController } from '../lib/real-access';
import type { ContactTypeItem } from '../lib/contact-list-model';
import { ContactTypeModal } from './ContactTypeModal';
import { Icon } from './Icon';

// "Tipo de Contato" em tags (Origin CF-31 e CQ-07): os tipos do sistema e os criados em Tipos de contatos; "+ incluir"
// abre "Cadastrar tipo de contato" e o tipo novo já fica marcado. `locked` mantém um tipo (Vendedor de um vendedor).
export function ContactTypeTags({ controller, id, types, selected, onChange, onCreated, disabled = false, canCreate = false, locked = [] }: {
  controller: AccessController; id: string; types: readonly ContactTypeItem[]; selected: readonly string[]; onChange: (slugs: string[]) => void; onCreated: (type: ContactTypeItem) => void;
  disabled?: boolean; canCreate?: boolean; locked?: readonly string[];
}) {
  const [modal, setModal] = useState(false);
  const ordered = [...types].sort((a, b) => a.position - b.position);
  const toggle = (slug: string, on: boolean) => { if (locked.includes(slug)) return; onChange(on ? [...selected.filter(value => value !== slug), slug] : selected.filter(value => value !== slug)); };
  return <fieldset className="contact-type-tags" id={id} disabled={disabled}><legend>Tipo de Contato</legend>
    <div className="contact-tags">{ordered.map(type => <label key={type.slug} className={selected.includes(type.slug) ? 'is-on' : undefined} title={locked.includes(type.slug) ? 'Este contato é vendedor; gerencie em Vendedores.' : undefined}>
      <input type="checkbox" checked={selected.includes(type.slug)} disabled={locked.includes(type.slug)} onChange={event => toggle(type.slug, event.target.checked)} />{type.label}</label>)}
      {selected.filter(slug => !types.some(type => type.slug === slug)).map(slug => <span key={slug} className="contact-tag-missing" title="Tipo excluído ou indisponível">{slug}</span>)}</div>
    {canCreate && !disabled && <button type="button" className="text-button" onClick={() => setModal(true)}><Icon name="plus" size={10} />incluir</button>}
    {modal && <ContactTypeModal controller={controller} onClose={() => setModal(false)} onCreated={type => { setModal(false); onCreated(type); onChange([...selected, type.slug]); }} />}
  </fieldset>;
}
