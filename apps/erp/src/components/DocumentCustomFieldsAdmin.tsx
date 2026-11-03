import { useEffect, useRef, useState } from 'react';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { AccessError, type AccessController } from '../lib/real-access';
import { CUSTOM_FIELD_SIZE, CUSTOM_FIELD_TYPES, CUSTOM_FIELD_TYPE_LABELS, CUSTOM_FIELD_WIDTHS, CUSTOM_FIELD_WIDTH_LABELS, type CustomFieldType, type CustomFieldWidth } from '../lib/custom-fields';
import { DOCUMENT_CUSTOM_FIELDS_PATH, readDocumentCustomFields, type DocumentCustomField } from '../lib/document-custom-fields';
import { Icon } from './Icon';
import { Modal } from './Modal';
import './document-wave-g.css';

// 202610200288 Preferências › Sistema › Campos customizados, aba "Ordem de Serviço" (Origin): the fields of the OS form, with the same
// drawer as the produtos (Tipo fixed after creation, Nome, Dica, Informação, Obrigatório, Tamanhos, Opções da lista, Largura, Situação).
// Only the administrador saves; each save is a command with the version read and "Conferir resultado"; a field with values in an OS is
// not deleted (inactivate it) and a used option is not removed.
export const DOCUMENT_CUSTOM_FIELDS_LIMIT = 60;
interface Draft { field_type: CustomFieldType; name: string; hint: string; info: string; required: boolean; min_length: string; max_length: string; width: CustomFieldWidth; options: { id: string | null; label: string; key: string }[]; active: boolean }
let keys = 0;
const optionKey = () => `option-${++keys}`;
const draftOf = (field: DocumentCustomField | null): Draft => field ? { field_type: field.field_type, name: field.name, hint: field.hint ?? '', info: field.info ?? '', required: field.required, min_length: field.min_length === null ? '' : String(field.min_length),
  max_length: field.max_length === null ? '' : String(field.max_length), width: field.width, options: field.options.map(option => ({ ...option, key: optionKey() })), active: field.active }
  : { field_type: 'text', name: '', hint: '', info: '', required: false, min_length: '', max_length: '', width: 'medium', options: [], active: true };
/** The body of the save or the first problem, with the limits of erp_documents.custom_field_input. */
export function customFieldBody(draft: Draft): { data: Record<string, unknown> } | { error: string } {
  const sized = Object.hasOwn(CUSTOM_FIELD_SIZE, draft.field_type), size = CUSTOM_FIELD_SIZE[draft.field_type] ?? 0;
  const length = (text: string) => { if (!text.trim()) return null; return /^[1-9]\d{0,3}$/.test(text.trim()) ? Number(text.trim()) : NaN; };
  const min = sized ? length(draft.min_length) : null, max = sized ? length(draft.max_length) : null;
  if (!draft.name.trim() || draft.name.trim().length > 60) return { error: 'Informe o nome do campo, com até 60 caracteres.' };
  if ([min, max].some(value => value !== null && (Number.isNaN(value) || value > size))) return { error: `Os tamanhos aceitam de 1 a ${size} caracteres.` };
  if (min !== null && max !== null && min > max) return { error: 'O tamanho mínimo não pode passar do máximo.' };
  const options = draft.field_type === 'list' ? draft.options.map(option => ({ id: option.id, label: option.label.trim() })) : [];
  if (draft.field_type === 'list' && (!options.length || options.length > 50 || options.some(option => !option.label || option.label.length > 60))) return { error: 'A lista precisa de 1 a 50 opções, cada uma com até 60 caracteres.' };
  if (new Set(options.map(option => option.label.toLowerCase())).size !== options.length) return { error: 'As opções da lista não podem se repetir.' };
  return { data: { field_type: draft.field_type, name: draft.name.trim(), hint: draft.hint.trim() || null, info: draft.info.trim() || null, required: draft.required,
    min_length: min, max_length: max, width: draft.width, options, active: draft.active } };
}
const refusal = (failure: unknown) => failure instanceof AccessError ? failure.code === 'ERP_DOCUMENT_CUSTOM_FIELD_DUPLICATE' ? 'Já existe um campo customizado da OS com este nome.'
  : failure.code === 'ERP_DOCUMENT_CUSTOM_FIELD_OPTION_IN_USE' ? 'Uma opção removida é usada em ordens de serviço: troque o valor dessas OS antes de remover a opção.'
    : failure.code === 'ERP_DOCUMENT_CUSTOM_FIELD_IN_USE' ? 'O campo tem valores gravados em ordens de serviço e não pode ser excluído; inative-o.'
      : failure.code === 'ERP_DOCUMENT_CUSTOM_FIELD_LIMIT' ? `O FAGOO aceita até ${DOCUMENT_CUSTOM_FIELDS_LIMIT} campos customizados da OS.`
        : failure.status === 403 ? 'Somente o administrador altera os campos customizados.' : failure.status === 409 ? 'O campo mudou em outra tela. Atualize a lista e tente de novo.'
          : failure.status === 400 ? 'Confira os dados do campo.' : 'Não foi possível concluir. Tente de novo.' : 'Não foi possível concluir. Tente de novo.';
type Pending = { id: string; path: string; body: Record<string, unknown>; label: string; uncertain: boolean };

export default function DocumentCustomFieldsAdmin({ controller }: { controller: Pick<AccessController, 'documents' | 'getSnapshot'> }) {
  const [fields, setFields] = useState<DocumentCustomField[] | null>(null), [canManage, setCanManage] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0), [drawer, setDrawer] = useState<{ field: DocumentCustomField | null; draft: Draft; problem: string } | null>(null), [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null), [remove, setRemove] = useState<DocumentCustomField | null>(null);
  const request = useRef<AbortController | null>(null);
  const dirty = Boolean(drawer && JSON.stringify(drawer.draft) !== JSON.stringify(draftOf(drawer.field)));
  useUnsavedChanges(dirty || Boolean(pending?.uncertain), busy);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    const signal = new AbortController(); setError('');
    void Promise.resolve().then(() => controller.documents(DOCUMENT_CUSTOM_FIELDS_PATH, { signal: signal.signal })).then(value => {
      if (signal.signal.aborted) return; const page = readDocumentCustomFields(value); setFields(page.items); setCanManage(page.can_manage);
    }).catch(failure => { if (!signal.signal.aborted) { setFields(current => current ?? []); setError(failure instanceof AccessError && failure.status === 403 ? 'Seu perfil não consulta as ordens de serviço.' : 'Não foi possível carregar os campos customizados da OS.'); } });
    return () => signal.abort();
  }, [controller, reload]);
  const send = async (command: Pending) => {
    if (busy) return; const signal = new AbortController(); request.current = signal; setBusy(true); setError('');
    try {
      await controller.documents(command.path, { method: 'POST', body: { ...command.body, command_id: command.id }, signal: signal.signal });
      if (signal.signal.aborted) return; setPending(null); setDrawer(null); setRemove(null); setNotice(command.label); setReload(value => value + 1);
    } catch (failure) {
      if (signal.signal.aborted) return;
      const known = failure instanceof AccessError && [400, 403, 404, 409].includes(failure.status);
      if (known) { setPending(null); setError(refusal(failure)); } else { setPending({ ...command, uncertain: true }); setError('Não foi possível confirmar o resultado. Use “Conferir resultado”: o mesmo comando não grava duas vezes.'); }
    } finally { if (request.current === signal) request.current = null; setBusy(false); }
  };
  const save = () => {
    if (!drawer || !canManage) return; const body = customFieldBody(drawer.draft);
    if ('error' in body) { setDrawer({ ...drawer, problem: body.error }); return; }
    const field = drawer.field;
    void send({ id: crypto.randomUUID(), path: field ? `${DOCUMENT_CUSTOM_FIELDS_PATH}/${field.id}` : DOCUMENT_CUSTOM_FIELDS_PATH, body: { expected_version: field?.version ?? 0, data: body.data },
      label: field ? `Campo “${body.data.name as string}” salvo.` : `Campo “${body.data.name as string}” incluído.`, uncertain: false });
  };
  const set = (patch: Partial<Draft>) => setDrawer(current => current && { ...current, draft: { ...current.draft, ...patch }, problem: '' });
  const all = fields ?? [], editing = drawer?.draft;
  return <div className="document-custom-fields-admin">
    <div className="native-list-toolbar"><p className="real-help">Campos exibidos na aba “Campos Customizados” das ordens de serviço e, se escolhido, na impressão da OS.</p>
      {canManage && <button type="button" className="primary-button" disabled={all.length >= DOCUMENT_CUSTOM_FIELDS_LIMIT || busy || Boolean(pending)} onClick={() => setDrawer({ field: null, draft: draftOf(null), problem: '' })}><Icon name="plus" size={12} />Adicionar campo</button>}</div>
    {notice && <p className="real-success" role="status">{notice}</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    {pending?.uncertain && <div className="real-editor-actions"><button type="button" className="primary-button" disabled={busy} onClick={() => void send(pending)}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button></div>}
    {fields === null ? <p role="status">Carregando…</p> : <div className="table-scroll" tabIndex={0} role="region" aria-label="Campos customizados da ordem de serviço"><table className="data-table real-table origin-table"><thead><tr><th scope="col">Nome</th><th scope="col">Tipo</th><th scope="col">Situação</th><th scope="col" className="row-actions">Ações</th></tr></thead>
      <tbody>{all.map(field => <tr key={field.id}><td><button type="button" className="text-button record-link" onClick={() => setDrawer({ field, draft: draftOf(field), problem: '' })}>{field.name}</button>{field.required && <span className="real-help"> (obrigatório)</span>}</td>
        <td>{CUSTOM_FIELD_TYPE_LABELS[field.field_type]}</td><td>{field.active ? 'Ativo' : 'Inativo'}</td>
        <td className="row-actions"><button type="button" className="icon-button" title={canManage ? 'Editar' : 'Visualizar'} aria-label={`${canManage ? 'Editar' : 'Visualizar'} ${field.name}`} onClick={() => setDrawer({ field, draft: draftOf(field), problem: '' })}><Icon name={canManage ? 'pen-to-square' : 'eye'} size={12} /></button>
          {canManage && <button type="button" className="icon-button" title={field.documents ? 'O campo tem valores em ordens de serviço: inative-o.' : 'Excluir'} aria-label={`Excluir ${field.name}`} disabled={Boolean(field.documents) || busy || Boolean(pending)} onClick={() => setRemove(field)}><Icon name="trash-can" size={12} /></button>}</td></tr>)}</tbody></table>
      {!all.length && !error && <div className="origin-empty"><span><Icon name="exclamation" size={22} /></span><h2>Nenhum campo customizado da ordem de serviço.</h2><p>{canManage ? 'Clique em “Adicionar campo” para incluir.' : 'Somente o administrador inclui campos.'}</p></div>}</div>}
    {drawer && editing && <Modal title={drawer.field ? 'Editar Campo' : 'Adicionar campo'} onClose={() => { if (!busy) setDrawer(null); }}
      actions={<>{canManage && <button type="button" className="primary-button" disabled={busy || Boolean(pending)} onClick={save}>{busy ? 'Salvando…' : 'Salvar'}</button>}<button type="button" className="secondary-button" disabled={busy} onClick={() => setDrawer(null)}>{canManage ? 'Cancelar' : 'Fechar'}</button></>}>
      <fieldset disabled={!canManage || busy} className="document-grid">
        <div className="form-field"><label htmlFor="os-field-type">Tipo do campo</label><select id="os-field-type" value={editing.field_type} disabled={Boolean(drawer.field)} title={drawer.field ? 'O tipo não muda depois de criado.' : undefined} onChange={event => set({ field_type: event.target.value as CustomFieldType, options: event.target.value === 'list' ? editing.options.length ? editing.options : [{ id: null, label: '', key: optionKey() }] : [], min_length: '', max_length: '' })}>{CUSTOM_FIELD_TYPES.map(type => <option key={type} value={type}>{CUSTOM_FIELD_TYPE_LABELS[type]}</option>)}</select></div>
        <div className="form-field"><label htmlFor="os-field-name">Nome do campo *</label><input id="os-field-name" maxLength={60} value={editing.name} onChange={event => set({ name: event.target.value })} /></div>
        <div className="form-field"><label htmlFor="os-field-hint">Dica de preenchimento</label><input id="os-field-hint" maxLength={100} value={editing.hint} onChange={event => set({ hint: event.target.value })} /></div>
        <div className="form-field document-wide"><label htmlFor="os-field-info">Informação sobre o campo</label><textarea id="os-field-info" rows={2} maxLength={300} value={editing.info} onChange={event => set({ info: event.target.value })} /></div>
        <label className="document-check"><input type="checkbox" checked={editing.required} onChange={event => set({ required: event.target.checked })} />Obrigatório</label>
        {Object.hasOwn(CUSTOM_FIELD_SIZE, editing.field_type) && <><div className="form-field"><label htmlFor="os-field-min">Tamanho mínimo</label><input id="os-field-min" inputMode="numeric" maxLength={4} value={editing.min_length} onChange={event => set({ min_length: event.target.value })} /></div>
          <div className="form-field"><label htmlFor="os-field-max">Tamanho máximo</label><input id="os-field-max" inputMode="numeric" maxLength={4} value={editing.max_length} onChange={event => set({ max_length: event.target.value })} /></div></>}
        <div className="form-field"><label htmlFor="os-field-width">Largura</label><select id="os-field-width" value={editing.width} onChange={event => set({ width: event.target.value as CustomFieldWidth })}>{CUSTOM_FIELD_WIDTHS.map(width => <option key={width} value={width}>{CUSTOM_FIELD_WIDTH_LABELS[width]}</option>)}</select></div>
        <label className="document-check"><input type="checkbox" role="switch" checked={editing.active} onChange={event => set({ active: event.target.checked })} />Ativo</label>
        {editing.field_type === 'list' && <div className="form-field document-wide"><span>Opções da lista</span>{editing.options.map((option, index) => <div className="document-custom-option" key={option.key}>
          <input aria-label={`Opção ${index + 1}`} maxLength={60} value={option.label} onChange={event => set({ options: editing.options.map(row => row.key === option.key ? { ...row, label: event.target.value } : row) })} />
          <button type="button" className="icon-button" aria-label={`Remover opção ${index + 1}`} disabled={editing.options.length === 1} onClick={() => set({ options: editing.options.filter(row => row.key !== option.key) })}><Icon name="trash-can" size={12} /></button></div>)}
          {editing.options.length < 50 && <button type="button" className="text-button" onClick={() => set({ options: [...editing.options, { id: null, label: '', key: optionKey() }] })}>+ Adicionar opção</button>}</div>}
      </fieldset>
      {drawer.problem && <p className="real-alert" role="alert">{drawer.problem}</p>}
    </Modal>}
    {remove && <Modal title="Excluir campo" onClose={() => { if (!busy) setRemove(null); }} actions={<><button type="button" className="primary-button" disabled={busy || Boolean(pending)} onClick={() => void send({ id: crypto.randomUUID(), path: `${DOCUMENT_CUSTOM_FIELDS_PATH}/${remove.id}/exclusao`, body: { expected_version: remove.version }, label: `Campo “${remove.name}” excluído.`, uncertain: false })}>{busy ? 'Excluindo…' : 'Excluir'}</button><button type="button" className="secondary-button" disabled={busy} onClick={() => setRemove(null)}>Cancelar</button></>}>
      <p>Excluir o campo “{remove.name}”? Campos com valores gravados em ordens de serviço não são excluídos.</p></Modal>}
  </div>;
}
