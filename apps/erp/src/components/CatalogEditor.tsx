import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useUnsavedForm } from '../hooks/useUnsavedChanges';
import { AccessError, type AccessController } from '../lib/real-access';
import { CATALOG_FIELDS, CatalogValidationError, catalogData, catalogWarnings, needsWarningCheck, warningText, type CatalogEntity, type CatalogEnvelope, type CatalogField, type CatalogRecord, type CatalogWarning } from '../lib/catalog-model';
import { badgeClass } from '../lib/origin-list';
import { CONFLICT_TEXT, LIST_TITLE, aborted, errorText, situation } from './catalog-shared';

// Save machinery and layout shared by ProductEditor, ContactEditor and WarehouseEditor: command_id with
// "Conferir resultado", expected_version, server warnings confirmed with "Salvar mesmo assim" and the unsaved guard.
export type CatalogEditorProps = { controller: AccessController; entity: CatalogEntity; record: CatalogRecord | null; writable: boolean; onClose: () => void; onSaved: (record: CatalogRecord) => void; initialValues?: Record<string, string>; cloneOf?: string };
type OriginLabels = Record<string, Partial<Pick<CatalogField, 'label' | 'options'>>>;
/** The model fields with the Origin labels of the screen. */
export const originFields = (fields: CatalogField[], labels: OriginLabels) => fields.map(field => ({ ...field, ...labels[field.key] }));
const changedAt = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }).replace(',', '') : '';

export function Field({ field, values, invalid = false, onChange }: { field: CatalogField; values: Record<string, string>; invalid?: boolean; onChange: (key: string, value: string) => void }) {
  const id = `catalog-${field.key}`;
  const dimension = ['width', 'height', 'depth'].includes(field.key);
  const dimensionUnit = { m: 'metros (m)', cm: 'centímetros (cm)', mm: 'milímetros (mm)' }[values.dimension_unit];
  const help = field.help || (dimension ? dimensionUnit ? `Medida em ${dimensionUnit}.` : 'Unidade das dimensões não informada.' : undefined);
  const describedBy = [help ? `${id}-help` : null, invalid ? 'catalog-validation-error' : null].filter(Boolean).join(' ') || undefined;
  const common = { id, value: values[field.key] || '', 'aria-invalid': invalid || undefined, 'aria-describedby': describedBy, onChange: (event: { target: { value: string } }) => onChange(field.key, event.target.value) };
  return <div className={`form-field ${field.type === 'textarea' ? 'real-field-wide' : ''}`}>
    <label htmlFor={id}>{field.label}{field.key === 'name' ? ' *' : ''}</label>
    {field.type === 'textarea' ? <textarea {...common} rows={3} maxLength={field.max} /> : field.type === 'select' ? <select {...common}><option value="">Não informado</option>{field.options?.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}</select> : <input {...common} type={field.type === 'email' ? 'email' : 'text'} inputMode={field.decimal ? 'decimal' : field.integer ? 'numeric' : undefined} autoComplete="off" required={field.key === 'name'} maxLength={field.max} />}
    {help && <small id={`${id}-help`}>{help}</small>}
  </div>;
}

type Pending = { path: string; method: 'POST' | 'PATCH'; body: Record<string, unknown> };
const NO_ROLES: string[] = [];

/**
 * Form state and save flow of one catalog record. `roles` (contacts) is part of the payload and of the unsaved guard;
 * `focusKey` re-runs the focus of an invalid field when the visible section changes; `onInvalid` lets the entity
 * reveal the section of the field that failed validation. Products (migration 119) also pass `savePath` (the complete product
 * route), `extra` (lists kept outside the field values, part of the unsaved guard) and `buildExtra` (their payload).
 */
export function useCatalogEditor({ controller, entity, record, writable, initialValues, onSaved }: CatalogEditorProps, { roles = NO_ROLES, focusKey, onInvalid, savePath, extra, buildExtra }: { roles?: string[]; focusKey?: unknown; onInvalid?: (field: string) => void; savePath?: (id: string | null) => string; extra?: unknown; buildExtra?: (values: Record<string, string>) => Record<string, unknown> } = {}) {
  const [values, setValues] = useState<Record<string, string>>(() => initialValues ? { ...initialValues } : Object.fromEntries(CATALOG_FIELDS[entity].map(field => [field.key, typeof record?.[field.key] === 'string' ? record[field.key] as string : ''])));
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [invalidKey, setInvalidKey] = useState<string | null>(null), [invalidField, setInvalidField] = useState<string | null>(null);
  // Server warnings waiting for an explicit "Salvar mesmo assim"; they belong to the exact data that was checked.
  const [warnings, setWarnings] = useState<(Pending & { items: CatalogWarning[] }) | null>(null);
  const guard = useUnsavedForm(extra === undefined ? { values, roles: [...roles].sort() } : { values, roles: [...roles].sort(), extra }, busy || uncertain);
  const pending = useRef<AbortController | null>(null);
  const command = useRef<{ id: string; path: string; method: 'POST' | 'PATCH'; body: Record<string, unknown>; savedId: string | null; uncertain: boolean } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); return () => pending.current?.abort(); }, []);
  useEffect(() => { if (invalidKey) { document.getElementById(`catalog-${invalidKey}`)?.focus(); setInvalidKey(null); } }, [invalidKey, focusKey]);
  const execute = async () => {
    if (!command.current || pending.current) return;
    const operation = command.current;
    const request = new AbortController(); pending.current = request; setBusy(true); setError(''); setInvalidField(null);
    let recheck: string[] | null = null;
    try {
      if (!operation.savedId) {
        const { path, method, body, id } = operation;
        const result = await controller.catalog(path, { method, body: { ...body, command_id: id }, signal: request.signal }) as CatalogEnvelope;
        if (request.signal.aborted) return;
        operation.savedId = result.record.id;
      }
      const latest = await controller.catalog(`/v1/cadastros/${entity}/${operation.savedId}`, { signal: request.signal }) as CatalogEnvelope;
      if (!request.signal.aborted) { command.current = null; setUncertain(false); onSaved(latest.record); }
    } catch (failure) {
      if (!request.signal.aborted && !aborted(failure)) {
        const known = !operation.uncertain && !operation.savedId && failure instanceof AccessError && [400, 403, 404, 409].includes(failure.status);
        if (!known) operation.uncertain = true;
        setUncertain(!known);
        setError(known ? errorText(failure) : operation.savedId ? 'O cadastro foi salvo, mas a versão atual não pôde ser consultada. Use “Conferir resultado” antes de editar novamente.' : 'Não foi possível confirmar o resultado. Use “Conferir resultado” para repetir a mesma operação sem duplicar o cadastro.');
        if (known) {
          command.current = null;
          // A confirmed save may be refused because a new warning appeared meanwhile: check again before reporting a version conflict.
          if ((failure as AccessError).status === 409 && Array.isArray(operation.body.acknowledged_warnings)) recheck = operation.body.acknowledged_warnings as string[];
        }
      }
    } finally { if (!request.signal.aborted) { pending.current = null; setBusy(false); } }
    if (recheck && !request.signal.aborted) { const body = { ...operation.body }; delete body.acknowledged_warnings; void verify({ path: operation.path, method: operation.method, body }, recheck); }
  };
  const start = ({ path, method, body }: Pending) => {
    if (pending.current) return;
    command.current = { id: crypto.randomUUID(), path, method, body, savedId: null, uncertain: false }; void execute();
  };
  const run = (operation: Pending) => { if (busy || uncertain || pending.current) return; start(operation); };
  // Read-only server check (duplicate code/GTIN/CPF/CNPJ and check digits). Nothing is written until the user confirms.
  const verify = async (operation: Pending, acknowledged: string[] | null = null) => {
    if (pending.current) return;
    const request = new AbortController(); pending.current = request; setBusy(true); setWarnings(null); if (!acknowledged) setError('');
    let found: CatalogWarning[] | null = null;
    // Estoque lane (183/222): the "Saldo inicial" and the "Estrutura" travel with the save only; they are not fields of the duplicate check.
    const checked = Object.fromEntries(Object.entries(operation.body.data as Record<string, unknown>).filter(([key]) => !['initial_balance', 'composition', 'composition_sync'].includes(key)));
    try { found = catalogWarnings(await controller.catalog(`/v1/cadastros/${entity}/check`, { method: 'POST', body: { id: record?.id ?? null, data: checked }, signal: request.signal })); }
    catch (failure) {
      if (!request.signal.aborted && !aborted(failure)) setError(failure instanceof AccessError && [400, 403, 404].includes(failure.status) ? errorText(failure) : 'Não foi possível conferir os avisos do cadastro. Nada foi gravado; tente novamente.');
    } finally { if (!request.signal.aborted) { pending.current = null; setBusy(false); } }
    if (request.signal.aborted || !found) return;
    if (acknowledged) {
      if (found.every(item => acknowledged.includes(item.code))) { setError(CONFLICT_TEXT); return; }
      setError('Surgiu um novo aviso desde a conferência. Revise-o antes de salvar.');
    }
    if (found.length) { setWarnings({ ...operation, items: found }); return; }
    start({ ...operation, body: { ...operation.body, acknowledged_warnings: [] } });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault(); if (!writable || busy || uncertain) return;
    let data;
    try { data = catalogData(entity, values, roles, record); if (buildExtra) data = { ...data, ...buildExtra(values) }; } catch (failure) { setError((failure as Error).message); if (failure instanceof CatalogValidationError) { onInvalid?.(failure.field); setInvalidField(failure.field); setInvalidKey(failure.field); } return; }
    const operation: Pending = { path: savePath ? savePath(record?.id ?? null) : `/v1/cadastros/${entity}${record ? `/${record.id}` : ''}`, method: record ? 'PATCH' : 'POST', body: { data, ...(record ? { expected_version: record.version } : {}) } };
    setWarnings(null);
    if (needsWarningCheck(entity, data, record)) void verify(operation); else run(operation);
  };
  const confirmWarnings = () => { if (!warnings || busy || uncertain) return; const { items, ...operation } = warnings; setWarnings(null); run({ ...operation, body: { ...operation.body, acknowledged_warnings: items.map(item => item.code) } }); };
  const changeField = (key: string, value: string) => { setValues(previous => ({ ...previous, [key]: value })); setWarnings(null); if (key === invalidField) { setInvalidField(null); setError(''); } };
  return { values, error, busy, uncertain, invalidField, warnings, setWarnings, guard, heading, execute, run, submit, confirmWarnings, changeField };
}
export type CatalogEditorState = ReturnType<typeof useCatalogEditor>;

/**
 * Layout of every catalog editor: heading with the situation, Cancelar/Salvar, alerts, warnings, "Conferir resultado",
 * the entity form and Ativar/Inativar. `form` receives whether the fields are locked (read-only, busy, uncertain or inactive).
 */
export function catalogEditorView(editor: CatalogEditorState, { entity, record, writable, onClose }: CatalogEditorProps, { title, saveLabel, notice, form, editableInactive = false, readOnly = false, situationButton = true, aside }: { title: string; saveLabel: string; notice?: ReactNode; form: (locked: boolean) => ReactNode; editableInactive?: boolean; readOnly?: boolean; situationButton?: boolean; aside?: ReactNode }) {
  const { busy, uncertain, error, warnings, guard, heading, run } = editor;
  const editable = writable && !readOnly && (editableInactive || record?.active !== false), changed = changedAt(record?.updated_at);
  return <section className="real-editor catalog-editor" aria-labelledby="catalog-edit-title">
    <header className="real-editor-heading catalog-editor-heading"><div><div className="catalog-editor-title"><h2 id="catalog-edit-title" ref={heading} tabIndex={-1}>{title}</h2>{record && <span className={badgeClass(situation(record.active))}>{situation(record.active)}</span>}{!writable && <span className="real-mode">Somente consulta</span>}</div><p>{changed ? `Alterado em ${changed}` : record ? LIST_TITLE[entity] : 'Novo cadastro'}</p></div>
      <div className="catalog-editor-buttons"><button type="button" className="secondary-button" onClick={() => guard.confirmLeave(onClose)} disabled={busy}>{writable ? 'Cancelar' : 'Voltar'}</button>{editable && <button className="primary-button" disabled={busy || uncertain} type="submit" form="catalog-editor-form">{busy ? 'Salvando…' : saveLabel}</button>}</div>
      {editable && <p className="catalog-required"><span>(*)</span> Campos obrigatórios</p>}</header>
    {notice}
    {record?.source && <p className="real-help">Cadastro originado do Origin. As alterações desta tela pertencem ao FAGOO.</p>}
    {error && <p className="real-alert" role="alert" id="catalog-validation-error">{error}</p>}
    {warnings && <div className="catalog-warnings" role="alert" aria-labelledby="catalog-warnings-title"><h3 id="catalog-warnings-title">Confira antes de salvar</h3><ul>{warnings.items.map(item => <li key={item.code}>{warningText(item)}</li>)}</ul>
      <p>Existem cadastros antigos com duplicidade. Salve somente se tiver certeza; a confirmação fica registrada na auditoria do cadastro.</p>
      <div className="real-editor-actions"><button type="button" className="secondary-button" onClick={() => editor.setWarnings(null)}>Revisar</button><button type="button" className="primary-button" disabled={busy || uncertain} onClick={editor.confirmWarnings}>Salvar mesmo assim</button></div></div>}
    {uncertain && <div className="real-editor-actions"><button type="button" className="primary-button" disabled={busy} onClick={() => void editor.execute()}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button></div>}
    <form id="catalog-editor-form" onSubmit={editor.submit} aria-busy={busy}>
      {form(!editable || busy || uncertain)}
      {writable && !readOnly && situationButton && record && <div className="real-editor-actions"><button className="secondary-button" disabled={busy || uncertain} type="button" onClick={() => guard.confirmLeave(() => run({ path: `/v1/cadastros/${entity}/${record.id}/active`, method: 'PATCH', body: { expected_version: record.version, active: !record.active } }))}>{record.active ? 'Inativar cadastro' : 'Ativar cadastro'}</button></div>}
    </form>
    {aside}
    <p className="real-help">Inativar preserva o histórico do cadastro. Esta tela não altera estoque, contas ou documentos fiscais.</p>
  </section>;
}
