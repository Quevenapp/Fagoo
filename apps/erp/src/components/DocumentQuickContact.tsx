import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useReferenceOptions } from '../hooks/useReferenceOptions';
import type { PlatformPort } from '../lib/platform-model';
import { AccessError, type AccessController } from '../lib/real-access';
import { CatalogValidationError, type CatalogRecord } from '../lib/catalog-model';
import type { DocumentKind } from '../lib/real-documents-model';
import { DOCUMENT_LIST_UFS } from '../lib/document-list-model';
import { CONTACT_WRITER_ROLES, QUICK_CONTACT_ERROR, QUICK_CONTACT_PERSON_TYPES, QUICK_CONTACT_ROLES, QUICK_CONTACT_TITLE, quickContactDocumentLabel, quickContactRecord, quickContactRole, type QuickContactPersonType, type QuickContactRole, type QuickContactValues } from '../lib/document-editor-pickers';
// Contatos (onda C): the full Origin “Contato rápido”, saved by the Clientes e fornecedores route with the Preferências.
import { QUICK_SITUATIONS, QUICK_TAXPAYERS, quickContactFullPayload, quickRequired } from '../lib/contact-quick-model';
import { useContactRequiredFields } from './contact-required';
import { COUNTRY_SUGGESTIONS } from '../lib/contact-form-model';
import { contactRefusalText, refusalField } from './contact-errors';
import { Modal } from './Modal';
import './document-pickers.css';

type Controller = Pick<AccessController, 'catalog' | 'getSnapshot'>;
export interface QuickContactState { busy: boolean; dirty: boolean; uncertain: boolean }
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const knownText = (error: AccessError) => contactRefusalText(error) ?? (error.status === 403 ? 'Seu perfil não permite cadastrar contatos.'
  : error.status === 400 ? `${QUICK_CONTACT_ERROR} Confira o tamanho e o formato dos dados.` : 'Não foi possível cadastrar o contato. Confira os dados e tente novamente.');
// Same order as Origin's “Contato rápido”: Celular before Fone.
const FIELDS = [['mobile', 'Celular', 40], ['phone', 'Fone', 40]] as const;
// Origin order of the address block of “Contato rápido”.
const ADDRESS = [['postal_code', 'CEP', 9], ['city', 'Cidade', 100], ['district', 'Bairro', 100], ['street', 'Endereço', 200], ['number', 'Número', 30], ['complement', 'Complemento', 200]] as const;

/**
 * “Contato rápido” no padrão Origin: cria o cliente ou fornecedor pelo POST de Clientes e fornecedores
 * (/v1/cadastros/contatos, com as Preferências e a carteira do vendedor), com command_id e “Conferir resultado”,
 * e devolve o contato lido de novo para o documento.
 * O formulário do documento não é remontado nem alterado aqui.
 */
export default function DocumentQuickContact({ controller, kind, initial, onCreated, onClose, onState }: {
  controller: Controller; kind: DocumentKind; initial: QuickContactValues;
  onCreated: (record: CatalogRecord) => void; onClose: (uncertain: boolean) => void; onState?: (state: QuickContactState) => void;
}) {
  const [values, setValues] = useState<QuickContactValues>(initial);
  const [error, setError] = useState(''), [invalid, setInvalid] = useState<string | null>(null), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  // `created`: the contact exists but was not selected (session or status changed); saving again would duplicate it.
  const [created, setCreated] = useState(false), [discarding, setDiscarding] = useState(false);
  const actor = useRef(controller.getSnapshot().membership?.user_id ?? null), mounted = useRef(true), pending = useRef<AbortController | null>(null), done = useRef(false);
  const command = useRef<{ id: string; body: { data: Record<string, unknown> }; savedId: string | null; uncertain: boolean } | null>(null);
  const report = useRef(onState); report.current = onState;
  const role = quickContactRole(kind), dirty = !created && JSON.stringify(values) !== JSON.stringify(initial);
  // Preferências › Campos obrigatórios: marked with * here and checked before sending (the server checks every field).
  const required = useContactRequiredFields(controller as Parameters<typeof useContactRequiredFields>[0]), star = (key: string) => quickRequired(required, key, values.person_type) ? ' *' : '';
  const countries = useReferenceOptions(controller as Partial<PlatformPort>, 'paises', String(values.country ?? ''), { enabled: values.person_type === 'E', minLength: 1 });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.abort(); }; }, []);
  useEffect(() => { report.current?.({ busy, dirty, uncertain }); }, [busy, dirty, uncertain]);
  const allowed = () => { const snapshot = controller.getSnapshot(), member = snapshot.membership; return mounted.current && snapshot.phase === 'ready' && Boolean(actor.current && member?.user_id === actor.current && CONTACT_WRITER_ROLES.includes(member.role)); };
  const execute = async () => {
    const operation = command.current; if (!operation || pending.current) return;
    if (!allowed()) { setError('A sessão ou o perfil mudou. Nenhum contato foi selecionado no documento.'); return; }
    const request = new AbortController(); pending.current = request; setBusy(true); setError(''); setInvalid(null);
    try {
      if (!operation.savedId) {
        const result = await controller.catalog('/v1/cadastros/contatos', { method: 'POST', body: { ...operation.body, command_id: operation.id }, signal: request.signal });
        if (request.signal.aborted) return;
        let created: CatalogRecord; try { created = quickContactRecord(result); } catch { throw new AccessError(502); }
        // Situação "Inativo" creates an inactive contact on purpose: it is saved (never retried) and the fresh read
        // below says it cannot be chosen in the document.
        operation.savedId = created.id;
      }
      // Replays acknowledge the original command; only a fresh read is the current contact.
      const latest = await controller.catalog(`/v1/cadastros/contatos/${operation.savedId}`, { signal: request.signal });
      if (request.signal.aborted) return;
      let current: CatalogRecord; try { current = quickContactRecord(latest, operation.savedId); } catch { throw new AccessError(502); }
      command.current = null; done.current = true; setUncertain(false);
      if (!allowed()) { setCreated(true); setError('O contato foi cadastrado, mas a sessão ou o perfil mudou. Ele não foi selecionado no documento.'); return; }
      if (!current.active) { setCreated(true); setError(operation.body.data.situation === 'I' ? 'O contato foi cadastrado com a situação Inativo e por isso não foi selecionado no documento.' : 'O contato foi cadastrado, mas já está inativo e não pode ser usado no documento.'); return; }
      onCreated(current);
    } catch (failure) {
      if (!request.signal.aborted && !aborted(failure) && mounted.current) {
        const known = !operation.uncertain && !operation.savedId && failure instanceof AccessError && [400, 403, 404, 409].includes(failure.status);
        if (known) command.current = null; else operation.uncertain = true;
        setUncertain(!known); if (known) setInvalid(refusalField(failure));
        setError(known ? knownText(failure as AccessError) : operation.savedId ? 'O contato foi cadastrado, mas a versão atual não pôde ser consultada. Use “Conferir resultado” para selecioná-lo.' : 'Não foi possível confirmar o cadastro. Use “Conferir resultado” para repetir a mesma operação sem duplicar o contato.');
      }
    } finally { if (pending.current === request) pending.current = null; if (mounted.current && !request.signal.aborted) setBusy(false); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault(); event.stopPropagation?.();
    if (busy || uncertain || pending.current || command.current || done.current) return;
    setDiscarding(false);
    if (!allowed()) { setError('Seu perfil não permite cadastrar contatos.'); return; }
    let body: { data: Record<string, unknown> };
    try { body = quickContactFullPayload(kind, values, undefined, required); } catch (failure) { setError(`${QUICK_CONTACT_ERROR} ${(failure as Error).message}`); setInvalid(failure instanceof CatalogValidationError ? failure.field : null); return; }
    command.current = { id: crypto.randomUUID(), body: structuredClone(body), savedId: null, uncertain: false }; void execute();
  };
  // Escape, a click outside or Cancelar never drop typed data silently: the first request asks, the second discards.
  const close = () => { if (busy || pending.current) return; if (dirty && !uncertain && !discarding) { setDiscarding(true); return; } onClose(uncertain); };
  const text = (key: keyof QuickContactValues) => typeof values[key] === 'string' ? values[key] as string : '';
  const change = <K extends keyof QuickContactValues>(key: K, value: QuickContactValues[K]) => { if (busy || uncertain || done.current) return; setDiscarding(false); setValues(previous => ({ ...previous, [key]: value })); if (invalid === key) { setInvalid(null); setError(''); } };
  const toggle = (value: QuickContactRole, checked: boolean) => { if (value === role) return; change('roles', checked ? [...values.roles.filter(item => item !== value), value] : values.roles.filter(item => item !== value)); };
  const frozen = busy || uncertain || created, described = (key: string) => invalid === key ? { 'aria-invalid': true as const, 'aria-describedby': 'quick-contact-error' } : {};
  const actions = <>
    <button type="button" className="secondary-button" disabled={busy} onClick={close}>{created ? 'Fechar' : 'Cancelar'}</button>
    {uncertain ? <button type="button" className="primary-button" disabled={busy} onClick={() => void execute()}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button>
      : !created && <button type="submit" form="quick-contact-form" className="primary-button" disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</button>}
  </>;
  return <Modal title={QUICK_CONTACT_TITLE} onClose={close} actions={actions}>
    <form id="quick-contact-form" className="quick-contact" onSubmit={submit} aria-busy={busy} noValidate>
      {discarding && !frozen && <div className="real-notice" role="alert"><p>Os dados digitados no contato rápido ainda não foram salvos.</p><button type="button" className="secondary-button" onClick={() => setDiscarding(false)}>Continuar no cadastro</button> <button type="button" className="secondary-button" onClick={() => { if (!busy && !pending.current) onClose(false); }}>Descartar</button></div>}
      {error && <p className="real-alert" role="alert" id="quick-contact-error">{error}</p>}
      <fieldset disabled={frozen} className="quick-contact-fields">
        <legend className="real-sr-only">Dados do contato</legend>
        <fieldset className="quick-contact-roles quick-contact-wide"><legend>Situação do cadastro</legend>{QUICK_SITUATIONS.map(option => <label key={option.value}><input id={`quick-contact-situation-${option.value}`} type="radio" name="quick-contact-situation" checked={(values.situation ?? 'A') === option.value} onChange={() => change('situation', option.value)} />{option.label}</label>)}</fieldset>
        <h3>Dados</h3>
        <div className="form-field"><label htmlFor="quick-contact-code">Código</label><input id="quick-contact-code" maxLength={100} autoComplete="off" value={text('code')} {...described('code')} onChange={event => change('code', event.target.value)} /></div>
        <div className="form-field quick-contact-wide"><label htmlFor="quick-contact-name">Nome *</label><input id="quick-contact-name" maxLength={200} autoComplete="off" required value={values.name} {...described('name')} onChange={event => change('name', event.target.value)} /></div>
        <div className="form-field quick-contact-wide"><label htmlFor="quick-contact-trade-name">Fantasia{star('trade_name')}</label><input id="quick-contact-trade-name" maxLength={200} autoComplete="off" value={text('trade_name')} {...described('trade_name')} onChange={event => change('trade_name', event.target.value)} /></div>
        <div className="form-field"><label htmlFor="quick-contact-person-type">Tipo da Pessoa</label><select id="quick-contact-person-type" value={values.person_type} {...described('person_type')} onChange={event => change('person_type', event.target.value as QuickContactPersonType)}>{QUICK_CONTACT_PERSON_TYPES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
        <div className="form-field"><label htmlFor="quick-contact-document">{quickContactDocumentLabel(values.person_type)}{star('document')}</label><input id="quick-contact-document" maxLength={30} autoComplete="off" value={values.document} {...described('document')} onChange={event => change('document', event.target.value)} /></div>
        <div className="form-field"><label htmlFor="quick-contact-ie">Inscrição Estadual{star('ie')}</label><input id="quick-contact-ie" maxLength={30} autoComplete="off" value={text('ie')} {...described('ie')} onChange={event => change('ie', event.target.value)} /></div>
        <div className="form-field quick-contact-wide"><label htmlFor="quick-contact-taxpayer">Contribuinte</label><select id="quick-contact-taxpayer" value={values.taxpayer ?? '9'} {...described('taxpayer')} onChange={event => change('taxpayer', event.target.value)}>{QUICK_TAXPAYERS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
        {values.person_type === 'E' && <div className="form-field"><label htmlFor="quick-contact-country">País{star('country')}</label><input id="quick-contact-country" maxLength={60} autoComplete="off" list="quick-contact-countries" value={text('country')} {...described('country')} onChange={event => change('country', event.target.value)} />
          {/* Leva H (CTT-045): official NF-e country names and cPais codes; the fixed list only without the API. */}
          <datalist id="quick-contact-countries">{countries.items.length ? countries.items.map(item => <option key={`${item.code}-${item.label}`} value={item.label}>{item.detail}</option>)
            : typeof (controller as Partial<PlatformPort>).platform === 'function' ? null : COUNTRY_SUGGESTIONS.map(country => <option key={country} value={country} />)}</datalist></div>}
        {values.person_type === 'F' && <><div className="form-field"><label htmlFor="quick-contact-birth-date">Data Nascimento{star('birth_date')}</label><input id="quick-contact-birth-date" type="date" min="1900-01-01" max="2100-12-31" value={text('birth_date')} {...described('birth_date')} onChange={event => change('birth_date', event.target.value)} /></div>
          <div className="form-field"><label htmlFor="quick-contact-rg">RG{star('rg')}</label><input id="quick-contact-rg" maxLength={20} autoComplete="off" value={text('rg')} {...described('rg')} onChange={event => change('rg', event.target.value)} /></div></>}
        <h3>Endereço</h3>
        <div className="form-field"><label htmlFor="quick-contact-state">UF</label><select id="quick-contact-state" value={text('state')} {...described('state')} onChange={event => change('state', event.target.value)}><option value="">UF</option>{DOCUMENT_LIST_UFS.map(uf => <option key={uf} value={uf}>{uf}</option>)}</select></div>
        {ADDRESS.map(([key, label, max]) => <div className={`form-field${key === 'street' ? ' quick-contact-wide' : ''}`} key={key}><label htmlFor={`quick-contact-${key}`}>{label}{star(key)}</label><input id={`quick-contact-${key}`} maxLength={max} autoComplete="off" value={text(key)} {...described(key)} onChange={event => change(key, event.target.value)} /></div>)}
        <h3>Contato</h3>
        <div className="form-field quick-contact-wide"><label htmlFor="quick-contact-email">E-mail{star('email')}</label><input id="quick-contact-email" type="email" maxLength={254} autoComplete="off" value={values.email} {...described('email')} onChange={event => change('email', event.target.value)} /></div>
        <div className="form-field quick-contact-wide"><label htmlFor="quick-contact-nfe-email">E-Mail para envio da NFe{star('nfe_email')}</label><input id="quick-contact-nfe-email" type="email" maxLength={60} autoComplete="off" value={text('nfe_email')} {...described('nfe_email')} onChange={event => change('nfe_email', event.target.value)} /></div>
        {FIELDS.map(([key, label, max]) => <div className="form-field" key={key}><label htmlFor={`quick-contact-${key}`}>{label}{star(key)}</label><input id={`quick-contact-${key}`} type="tel" maxLength={max} autoComplete="off" value={values[key]} {...described(key)} onChange={event => change(key, event.target.value)} /></div>)}
        <fieldset className="quick-contact-roles quick-contact-wide" {...(invalid === 'roles' ? { 'aria-describedby': 'quick-contact-error' } : {})}><legend>Tipo de contato</legend>{QUICK_CONTACT_ROLES.map(option => <label key={option.value}><input id={`quick-contact-role-${option.value}`} type="checkbox" checked={values.roles.includes(option.value)} disabled={option.value === role} onChange={event => toggle(option.value, event.target.checked)} />{option.label}</label>)}</fieldset>
        <div className="form-field quick-contact-wide"><label htmlFor="quick-contact-info">Informações do contato{star('contact_info')}</label><input id="quick-contact-info" maxLength={400} autoComplete="off" value={text('contact_info')} {...described('contact_info')} onChange={event => change('contact_info', event.target.value)} /></div>
        <div className="form-field quick-contact-wide"><label htmlFor="quick-contact-notes">Observações{star('notes')}</label><textarea id="quick-contact-notes" rows={3} maxLength={4000} value={text('notes')} {...described('notes')} onChange={event => change('notes', event.target.value)} /></div>
      </fieldset>
      <p className="real-help">O contato é salvo em Clientes e fornecedores com as regras das Preferências (código sequencial, CPF / CNPJ duplicado e campos obrigatórios) e selecionado neste documento quando estiver Ativo ou Sem movimento.</p>
    </form>
  </Modal>;
}
