import { useEffect, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import { CatalogValidationError } from '../lib/catalog-base';
import { COUNTRY_SUGGESTIONS, PERSON_TYPE_OPTIONS, TAXPAYER_OPTIONS, UF_SELECT, contactFormValues, contactPayload, documentLabel, type ContactRecord } from '../lib/contact-form-model';
import type { ContactTypeItem } from '../lib/contact-list-model';
import { useUnsavedForm } from '../hooks/useUnsavedChanges';
import { useContactSave, warningMessage } from './ContactSave';
import { ContactTypeTags } from './ContactTypeTags';
import { Icon } from './Icon';

// Gaveta "Adicionar cadastro" (Origin CQ-01 a CQ-08): painel à direita com X e Salvar, Situação do cadastro, Código,
// Nome, Fantasia, Tipo da Pessoa, CPF/CNPJ, IE, Contribuinte, Data Nascimento e RG (PF), endereço, e-mails, telefones,
// tipos de contato, Informações do contato e Observações. Aberta pelo "+" de Pessoas de contato: o contato salvo volta
// para o formulário como pessoa de contato. Usa a mesma gravação do formulário (avisos, comando e Conferir resultado).
const FIELDS: readonly [string, string, number, string?][] = [['code', 'Código', 100], ['name', 'Nome', 200], ['trade_name', 'Fantasia', 200]];
const ADDRESS: readonly [string, string, number][] = [['postal_code', 'CEP', 20], ['city', 'Cidade', 100], ['district', 'Bairro', 100], ['street', 'Endereço', 200], ['number', 'Número', 30], ['complement', 'Complemento', 200]];
const CONTACT: readonly [string, string, number][] = [['email', 'E-mail', 254], ['nfe_email', 'E-Mail para envio da NFe', 60], ['mobile', 'Celular', 40], ['phone', 'Fone', 40]];

export function ContactQuickDrawer({ controller, types, canCreateTypes, required, onTypeCreated, onClose, onCreated, initialValues, initialTypes, onState }: {
  controller: AccessController; types: readonly ContactTypeItem[]; canCreateTypes: boolean; required: readonly string[]; onTypeCreated: (type: ContactTypeItem) => void;
  onClose: () => void; onCreated: (contact: ContactRecord) => void;
  /** Documents ("Adicionar cadastro" of pedidos, propostas, OS and compras): the typed name or CPF/CNPJ and the type of the document. */
  initialValues?: Record<string, string>; initialTypes?: readonly string[];
  /** Reports busy, unsaved and uncertain to a parent form that guards its own changes. */
  onState?: (state: { busy: boolean; dirty: boolean; uncertain: boolean }) => void;
}) {
  const [baseline] = useState(() => JSON.stringify({ values: { ...contactFormValues(null), ...initialValues }, selectedTypes: [...(initialTypes ?? [])] }));
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...contactFormValues(null), ...initialValues })), [selectedTypes, setSelectedTypes] = useState<string[]>(() => [...(initialTypes ?? [])]), [invalid, setInvalid] = useState<string | null>(null);
  const saver = useContactSave(controller, null, onCreated);
  const guard = useUnsavedForm({ values, selectedTypes }, saver.busy || saver.uncertain);
  const dirty = JSON.stringify({ values, selectedTypes }) !== baseline;
  useEffect(() => { onState?.({ busy: saver.busy, dirty, uncertain: saver.uncertain }); }, [saver.busy, dirty, saver.uncertain]);
  const locked = saver.busy || saver.uncertain;
  const shown = invalid ?? saver.errorField;
  const change = (key: string, value: string) => { setValues(previous => ({ ...previous, [key]: value })); saver.setWarnings(null); if (key === invalid || key === saver.errorField) { setInvalid(null); saver.setError(''); } };
  const input = ([key, label, max]: readonly [string, string, number, string?]) => <div className="form-field" key={key}><label htmlFor={`quick-${key}`}>{label}{key === 'name' || required.includes(key) ? ' *' : ''}</label>
    <input id={`quick-${key}`} maxLength={max} value={values[key] ?? ''} aria-invalid={shown === key || undefined} onChange={event => change(key, event.target.value)} /></div>;
  const submit = () => {
    try { setInvalid(null); saver.save(contactPayload(values, selectedTypes, [], { required })); }
    catch (failure) { if (failure instanceof CatalogValidationError) { setInvalid(failure.field); saver.setError(failure.message); } else throw failure; }
  };
  const person = values.person_type;
  return <div className="contact-drawer-backdrop">
    <aside className="contact-drawer" role="dialog" aria-modal="true" aria-labelledby="contact-drawer-title">
      <header><h2 id="contact-drawer-title">Adicionar cadastro</h2><div><button type="button" className="primary-button" disabled={locked} onClick={submit}>{saver.busy ? 'Salvando…' : 'Salvar'}</button>
        <button type="button" className="icon-button" aria-label="Fechar" disabled={saver.busy} onClick={() => guard.confirmLeave(onClose)}><Icon name="xmark" size={14} /></button></div></header>
      {saver.error && <p className="real-alert" role="alert">{saver.error}</p>}
      {saver.uncertain && <p><button type="button" className="primary-button" disabled={saver.busy} onClick={() => void saver.execute()}>{saver.busy ? 'Conferindo…' : 'Conferir resultado'}</button></p>}
      {saver.warnings && <div className="catalog-warnings" role="alert"><h3>Confira antes de salvar</h3><ul>{saver.warnings.items.map(item => <li key={item.code}>{warningMessage(item)}</li>)}</ul>
        <div className="real-editor-actions"><button type="button" className="secondary-button" onClick={() => saver.setWarnings(null)}>Revisar</button>{!saver.warnings.items.some(item => item.blocked) && <button type="button" className="primary-button" onClick={saver.confirm}>Salvar mesmo assim</button>}</div></div>}
      <fieldset disabled={locked} className="contact-drawer-body">
        <fieldset className="contact-radio"><legend>Situação do cadastro</legend>{[['A', 'Ativo'], ['I', 'Inativo'], ['S', 'Sem movimento']].map(([value, label]) => <label key={value}><input type="radio" name="quick-situation" checked={values.situation === value} onChange={() => change('situation', value!)} />{label}</label>)}</fieldset>
        <h3>Dados</h3>
        {FIELDS.map(input)}
        <div className="form-field"><label htmlFor="quick-person_type">Tipo da Pessoa</label><select id="quick-person_type" value={person} onChange={event => change('person_type', event.target.value)}>{PERSON_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
        {input(['document', documentLabel(person ?? ''), 30])}
        {input(['ie', 'Inscrição Estadual', 30])}
        <div className="form-field"><label htmlFor="quick-taxpayer">Contribuinte</label><select id="quick-taxpayer" value={values.taxpayer} onChange={event => change('taxpayer', event.target.value)}>{TAXPAYER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.value}</option>)}</select></div>
        {person === 'E' && <div className="form-field"><label htmlFor="quick-country">País{required.includes('country') ? ' *' : ''}</label><input id="quick-country" maxLength={60} list="quick-countries" value={values.country ?? ''} aria-invalid={shown === 'country' || undefined} onChange={event => change('country', event.target.value)} />
          <datalist id="quick-countries">{COUNTRY_SUGGESTIONS.map(country => <option key={country} value={country} />)}</datalist></div>}
        {person === 'F' && <><div className="form-field"><label htmlFor="quick-birth_date">Data Nascimento</label><input id="quick-birth_date" type="date" value={values.birth_date ?? ''} onChange={event => change('birth_date', event.target.value)} /></div>{input(['rg', 'RG', 20])}</>}
        <h3>Endereço</h3>
        {input(ADDRESS[0]!)}
        <div className="form-field"><label htmlFor="quick-state">UF</label><select id="quick-state" value={values.state ?? ''} onChange={event => change('state', event.target.value)}>{UF_SELECT.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
        {ADDRESS.slice(1).map(input)}
        <h3>Contato</h3>
        {CONTACT.map(input)}
        <ContactTypeTags controller={controller} id="quick-types" types={types} selected={selectedTypes} onChange={setSelectedTypes} onCreated={onTypeCreated} canCreate={canCreateTypes} />
        {input(['contact_info', 'Informações do contato', 400])}
        <div className="form-field real-field-wide"><label htmlFor="quick-notes">Observações</label><textarea id="quick-notes" rows={3} maxLength={4000} value={values.notes ?? ''} onChange={event => change('notes', event.target.value)} /></div>
      </fieldset>
    </aside>
  </div>;
}
