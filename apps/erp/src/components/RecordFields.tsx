import type { DemoRecord, FieldDefinition } from '../types';

export function RecordFields({ fields, values, onChange, readOnly = false }: {
  fields: FieldDefinition[]; values: DemoRecord; onChange: (key: string, value: string | number) => void; readOnly?: boolean;
}) {
  const sections = [...new Set(fields.map(field => field.section || 'Dados gerais'))];
  return <>{sections.map(section => <section className="form-section" key={section}>
    <h2>{section}</h2>
    <div className="form-grid">{fields.filter(field => (field.section || 'Dados gerais') === section).map(field => {
      const id = `field-${field.key}`;
      const props = { id, name: field.key, value: String(values[field.key] ?? ''), required: field.required, disabled: readOnly,
        onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
          const value = event.target.value;
          onChange(field.key, ['number', 'money'].includes(field.type || '') && value !== '' ? Number(value) : value);
        } };
      return <div className={`form-field ${field.type === 'textarea' ? 'full-width' : ''}`} key={field.key}>
        <label htmlFor={id}>{field.label}{field.required && <span aria-hidden="true"> *</span>}</label>
        {field.type === 'select' ? <select {...props}><option value="">Selecione</option>{field.options?.map(option => <option key={option}>{option}</option>)}</select>
          : field.type === 'textarea' ? <textarea {...props} rows={3} />
          : <input {...props} type={field.type === 'date' ? 'date' : ['number', 'money'].includes(field.type || '') ? 'number' : 'text'} step={field.type === 'money' ? '0.01' : field.type === 'number' ? 'any' : undefined} />}
      </div>;
    })}</div>
  </section>)}</>;
}
