import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AccessController } from '../lib/real-access';
import { customFieldItems, customInputValue, type CustomField } from '../lib/custom-fields';
import { Icon } from './Icon';
import { aborted } from './catalog-shared';
import './product-registry.css';

/** The Produtos tab of Campos customizados (migration 156); null while loading, 'error' when it could not be read. */
export function useCustomFields(controller: Pick<AccessController, 'catalog'>): CustomField[] | null | 'error' {
  const [fields, setFields] = useState<CustomField[] | null | 'error'>(null);
  useEffect(() => {
    const request = new AbortController();
    void Promise.resolve().then(() => controller.catalog('/v1/cadastros/campos-customizados', { signal: request.signal })).then(value => { if (!request.signal.aborted) setFields(customFieldItems(value)); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setFields('error'); });
    return () => request.abort();
  }, [controller]);
  return fields;
}

// Bloco "Campos customizados" do formulário do produto (Origin): os campos ativos que se aplicam à categoria (Agrupador), com a dica
// de preenchimento, o balão "Informação sobre o campo", a obrigatoriedade, os tamanhos e a largura. Os valores vão no mesmo comando
// do produto (data.custom_values) e o banco repete toda a validação.
export function ProductCustomFields({ state, fields, values, locked, invalidField, onChange }: { state: CustomField[] | null | 'error'; fields: readonly CustomField[]; values: Readonly<Record<string, string>>; locked: boolean; invalidField: string | null; onChange: (id: string, value: string) => void }) {
  if (state === null) return <p className="real-help" role="status">Carregando os campos customizados…</p>;
  if (state === 'error') return <p className="real-help">Não foi possível carregar os campos customizados. Os valores gravados continuam no produto e não são alterados ao salvar.</p>;
  if (!fields.length) return state.length ? <p className="real-help">Nenhum campo customizado se aplica à categoria escolhida.</p> : null;
  return <fieldset disabled={locked} className="real-editor-fields product-custom-fields"><legend>Campos customizados</legend>
    {fields.map(field => {
      const id = `catalog-custom-${field.id}`, invalid = invalidField === `custom-${field.id}`, value = customInputValue(field, values[field.id]);
      const common = { id, disabled: locked, 'aria-invalid': invalid || undefined, 'aria-describedby': [field.info ? `${id}-info` : null, invalid ? 'catalog-validation-error' : null].filter(Boolean).join(' ') || undefined,
        onChange: (event: { target: { value: string } }) => onChange(field.id, event.target.value) };
      const max = field.max_length ?? (field.field_type === 'long_text' ? 4000 : field.field_type === 'text' ? 255 : field.field_type === 'decimal' ? 23 : 19);
      return <div key={field.id} className={`form-field custom-width-${field.width}${field.field_type === 'long_text' ? ' real-field-wide' : ''}`}>
        <label htmlFor={id}>{field.name}{field.required ? ' *' : ''}{field.info && <span className="product-info" title={field.info}><Icon name="circle-info" size={11} /></span>}</label>
        {field.field_type === 'long_text' ? <textarea {...common} value={value} rows={3} maxLength={max} placeholder={field.hint ?? undefined} />
          : field.field_type === 'list' ? <select {...common} value={value}><option value="">Selecione</option>{field.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
          : field.field_type === 'boolean' ? <select {...common} value={value}><option value="">Selecione</option><option value="true">Sim</option><option value="false">Não</option></select>
          : field.field_type === 'date' ? <input {...common} type="date" value={value} min="1900-01-01" max="2100-12-31" />
          : <input {...common} type="text" value={value} maxLength={max} inputMode={field.field_type === 'integer' ? 'numeric' : field.field_type === 'decimal' ? 'decimal' : undefined} placeholder={field.hint ?? undefined} autoComplete="off" />}
        {field.info && <small id={`${id}-info`} className="real-sr-only">{field.info}</small>}
      </div>;
    })}
    <p className="real-help real-field-wide">Os campos são definidos em <Link to="/campos-customizados">Preferências › Sistema › Campos customizados</Link>.</p>
  </fieldset>;
}
