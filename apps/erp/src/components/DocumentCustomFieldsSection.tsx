import { useEffect, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import { DOCUMENT_CUSTOM_FIELDS_PATH, documentCustomInput, documentCustomValue, formCustomFields, readDocumentCustomFields, type DocumentCustomField } from '../lib/document-custom-fields';
import './document-wave-g.css';

type Controller = Pick<AccessController, 'documents' | 'getSnapshot'>;
const actorOf = (controller: Controller) => controller.getSnapshot?.()?.membership?.user_id ?? null;

/** The campos customizados of the OS (Preferências › Sistema › Campos customizados › Ordem de Serviço); null while unknown. */
export function useDocumentCustomFields(controller: Controller, enabled: boolean): DocumentCustomField[] | null | 'error' {
  const [fields, setFields] = useState<DocumentCustomField[] | null | 'error'>(null);
  useEffect(() => {
    if (!enabled) { setFields([]); return; }
    setFields(null);
    const request = new AbortController(), actor = actorOf(controller);
    void Promise.resolve().then(() => controller.documents(DOCUMENT_CUSTOM_FIELDS_PATH, { signal: request.signal }))
      .then(value => { if (!request.signal.aborted && actorOf(controller) === actor) setFields(readDocumentCustomFields(value).items); })
      .catch(() => { if (!request.signal.aborted) setFields('error'); });
    return () => request.abort();
  }, [controller, enabled]);
  return fields;
}

/**
 * Origin aba "Campos Customizados" of the ordem de serviço: one input per active field (Inteiro, Decimal, Lista, Texto, Texto Longo,
 * Lógico, Data), the hint as placeholder and the information below. The value sent is the canonical text of the field (a decimal
 * with a point and no trailing zeros, the id of the option of a list); a field left empty is not saved. An inactive field shows only
 * the value the OS already keeps, read-only.
 */
export default function DocumentCustomFieldsSection({ fields, values, disabled, onChange, open = true, onOpen }: {
  fields: DocumentCustomField[] | null | 'error'; values: Readonly<Record<string, string>> | null | undefined; disabled: boolean;
  onChange: (values: Record<string, string>) => void;
  /** Origin aba "Campos Customizados": closed, only the tab shows and the fields are read when it is opened. */
  open?: boolean; onOpen?: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({}), [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  if (!open) {
    const filled = Object.values(values ?? {}).filter(Boolean).length;
    return <section className="document-section document-custom-fields" aria-label="Campos customizados"><button type="button" className="text-button document-custom-fields-open" aria-expanded={false} onClick={onOpen}>Campos Customizados</button>
      {filled > 0 && <small>{filled === 1 ? '1 campo preenchido' : `${filled} campos preenchidos`}</small>}</section>;
  }
  if (fields === null) return <section className="document-section" aria-label="Campos customizados"><h3>Campos Customizados</h3><p role="status">Carregando campos customizados…</p></section>;
  if (fields === 'error') return <section className="document-section" aria-label="Campos customizados"><h3>Campos Customizados</h3><p className="real-help">Não foi possível consultar os campos customizados da ordem de serviço.</p></section>;
  const shown = formCustomFields(fields, values);
  if (!shown.length) return <section className="document-section document-custom-fields" aria-label="Campos customizados"><h3>Campos Customizados</h3><p className="real-help">Nenhum campo customizado ativo para a ordem de serviço (Preferências › Sistema › Campos customizados › Ordem de Serviço).</p></section>;
  const text = (field: DocumentCustomField) => drafts[field.id] ?? documentCustomInput(field, values?.[field.id]);
  const change = (field: DocumentCustomField, raw: string) => {
    if (disabled || !field.active) return;
    setDrafts(current => ({ ...current, [field.id]: raw }));
    const result = documentCustomValue(field, raw), next: Record<string, string> = { ...(values ?? {}) };
    // A value with a problem stays as typed (the save refuses it and the message stays under the field).
    const value = 'error' in result ? raw.trim() || null : result.value;
    if (value) next[field.id] = value; else delete next[field.id];
    onChange(next);
  };
  const problem = (field: DocumentCustomField) => { if (!field.active || !touched.has(field.id)) return null; const result = documentCustomValue(field, text(field)); return 'error' in result ? result.error : null; };
  return <fieldset disabled={disabled} className="document-section document-custom-fields"><legend>Campos Customizados</legend><div className="document-grid">
    {shown.map(field => {
      const id = `doc-custom-${field.id}`, message = problem(field), common = { id, disabled: disabled || !field.active, 'aria-invalid': message ? true as const : undefined,
        'aria-describedby': message || field.info ? `${id}-help` : undefined, onBlur: () => setTouched(current => new Set(current).add(field.id)) };
      const label = `${field.name}${field.required && field.active ? ' *' : ''}${field.active ? '' : ' (inativo)'}`;
      const input = field.field_type === 'list' ? <select {...common} value={text(field)} onChange={event => change(field, event.target.value)}><option value="">Selecione</option>{field.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
        : field.field_type === 'boolean' ? <select {...common} value={text(field)} onChange={event => change(field, event.target.value)}><option value="">Selecione</option><option value="true">Sim</option><option value="false">Não</option></select>
          : field.field_type === 'long_text' ? <textarea {...common} rows={3} maxLength={field.max_length ?? 4000} placeholder={field.hint ?? undefined} value={text(field)} onChange={event => change(field, event.target.value)} />
            : field.field_type === 'date' ? <input {...common} type="date" min="1900-01-01" max="2100-12-31" value={text(field)} onChange={event => change(field, event.target.value)} />
              : <input {...common} inputMode={field.field_type === 'integer' || field.field_type === 'decimal' ? 'decimal' : undefined} maxLength={field.max_length ?? (field.field_type === 'text' ? 255 : 30)} placeholder={field.hint ?? undefined} value={text(field)} onChange={event => change(field, event.target.value)} />;
      return <div className={`form-field document-custom-${field.width}${field.field_type === 'long_text' ? ' document-wide' : ''}`} key={field.id}><label htmlFor={id}>{label}</label>{input}
        {(message || field.info) && <small id={`${id}-help`} className={message ? 'field-error' : 'real-help'}>{message ?? field.info}</small>}</div>;
    })}</div></fieldset>;
}
