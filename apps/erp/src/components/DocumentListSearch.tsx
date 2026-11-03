import { useEffect } from 'react';
import type { AccessController } from '../lib/real-access';
import type { DocumentKind } from '../lib/real-documents-model';
import type { SearchCondition } from '../lib/document-list-model';
import type { DocumentCustomField } from '../lib/document-custom-fields';
import { SEARCH_FIELDS, SEARCH_MAX, SEARCH_OPERATORS, SEARCH_OPERATOR_LABELS, type SearchOperator, type SearchType } from '../../../../packages/erp-domain/src/document-search.mjs';
import { useDocumentCustomFields } from './DocumentCustomFieldsSection';
import { Icon } from './Icon';
import './document-wave-g.css';

type Controller = Pick<AccessController, 'documents' | 'getSnapshot'>;
type SearchField = { key: string; label: string; type: SearchType; options?: readonly { id: string; label: string }[] };
const EMPTY_OPS: readonly SearchOperator[] = ['empty', 'not_empty'];
/** The type of a campo customizado of the OS in the Busca customizada (the same mapping as the SQL of 202610200289). */
export const customSearchType = (field: Pick<DocumentCustomField, 'field_type'>): SearchType =>
  field.field_type === 'integer' || field.field_type === 'decimal' ? 'number' : field.field_type === 'date' ? 'date' : field.field_type === 'boolean' ? 'boolean' : field.field_type === 'list' ? 'option' : 'text';
/** The operators offered for a field ("Número" has no "está vazio"). */
export const searchOperators = (field: Pick<SearchField, 'key' | 'type'>): readonly SearchOperator[] =>
  SEARCH_OPERATORS[field.type].filter(op => field.key !== 'number' || !EMPTY_OPS.includes(op));
/** The fields of Adicionar filtros: those of the list and, in the OS, the campos customizados (an inactive one only while it is used). */
export function searchFields(kind: DocumentKind, custom: readonly DocumentCustomField[] | null, rows: readonly SearchCondition[] = []): SearchField[] {
  const own: SearchField[] = SEARCH_FIELDS[kind].map(([key, label, type]) => ({ key, label, type }));
  if (kind !== 'service_orders' || !custom) return own;
  return [...own, ...custom.filter(field => field.active || rows.some(row => row.field === `custom:${field.id}`))
    .map(field => ({ key: `custom:${field.id}`, label: field.name, type: customSearchType(field), options: field.options }))];
}
/** The conditions as applied: text trimmed, a decimal comma as point ("10,5" → "10.5"), "está vazio" without value. */
export function canonicalSearch(kind: DocumentKind, rows: readonly SearchCondition[], custom: readonly DocumentCustomField[] | null): SearchCondition[] {
  const fields = searchFields(kind, custom, rows);
  return rows.map(row => {
    if (EMPTY_OPS.includes(row.op)) return { field: row.field, op: row.op, value: null };
    const type = fields.find(field => field.key === row.field)?.type, value = (row.value ?? '').trim();
    return { field: row.field, op: row.op, value: (type === 'number' || type === 'money') && /^-?[0-9]+,[0-9]+$/.test(value) ? value.replace(',', '.') : value };
  });
}

/**
 * Origin "Busca customizada" of the lists (Adicionar filtros): up to 10 conditions campo · condição · valor, all of them must match.
 * The campos customizados of the OS are read only once a filter is added. The list validates the conditions again on Filtrar.
 */
export default function DocumentListSearch({ controller, kind, rows, disabled, onChange, onFields }: {
  controller: Controller; kind: DocumentKind; rows: readonly SearchCondition[]; disabled: boolean; onChange: (rows: SearchCondition[]) => void;
  /** The campos customizados read (null while unknown), for the canonical values of Filtrar. */
  onFields?: (fields: DocumentCustomField[] | null) => void;
}) {
  const loaded = useDocumentCustomFields(controller, kind === 'service_orders' && rows.length > 0);
  const custom = Array.isArray(loaded) ? loaded : null;
  useEffect(() => { onFields?.(custom); }, [custom]);
  const fields = searchFields(kind, custom, rows);
  const first = fields[0]!;
  const fresh = (field: SearchField): SearchCondition => { const op = searchOperators(field)[0]!; return { field: field.key, op, value: EMPTY_OPS.includes(op) ? null : '' }; };
  const change = (index: number, next: SearchCondition) => onChange(rows.map((row, position) => position === index ? next : row));
  return <fieldset className="documents-custom-search" disabled={disabled}>
    <legend>Busca customizada</legend>
    {rows.map((row, index) => {
      const field = fields.find(item => item.key === row.field) ?? { key: row.field, label: row.field.startsWith('custom:') ? 'Campo customizado' : row.field, type: 'text' as SearchType };
      const ops = searchOperators(field), n = index + 1, valueId = `documents-search-value-${n}`;
      return <div className="documents-custom-search-row" key={index}>
        <select aria-label={`Campo do filtro ${n}`} value={row.field} onChange={event => { const next = fields.find(item => item.key === event.target.value); if (next) change(index, fresh(next)); }}>
          {!fields.some(item => item.key === row.field) && <option value={row.field}>{field.label}</option>}
          {fields.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select>
        <select aria-label={`Condição do filtro ${n}`} value={row.op} onChange={event => { const op = event.target.value as SearchOperator; change(index, { ...row, op, value: EMPTY_OPS.includes(op) ? null : row.value ?? '' }); }}>
          {ops.map(op => <option key={op} value={op}>{SEARCH_OPERATOR_LABELS[op]}</option>)}</select>
        {!EMPTY_OPS.includes(row.op) && (field.type === 'boolean' ? <select id={valueId} aria-label={`Valor do filtro ${n}`} value={row.value ?? ''} onChange={event => change(index, { ...row, value: event.target.value })}><option value="">Selecione</option><option value="true">Sim</option><option value="false">Não</option></select>
          : field.type === 'option' ? <select id={valueId} aria-label={`Valor do filtro ${n}`} value={row.value ?? ''} onChange={event => change(index, { ...row, value: event.target.value })}><option value="">Selecione</option>{(field.options ?? []).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
          : <input id={valueId} aria-label={`Valor do filtro ${n}`} type={field.type === 'date' ? 'date' : 'text'} inputMode={field.type === 'number' || field.type === 'money' ? 'decimal' : undefined} maxLength={120} min={field.type === 'date' ? '1900-01-01' : undefined} max={field.type === 'date' ? '2099-12-31' : undefined}
            value={row.value ?? ''} onChange={event => change(index, { ...row, value: event.target.value })} />)}
        <button type="button" className="icon-button" title="Remover filtro" aria-label={`Remover filtro ${n}`} onClick={() => onChange(rows.filter((_, position) => position !== index))}><Icon name="xmark" size={12} /></button>
      </div>;
    })}
    {kind === 'service_orders' && rows.length > 0 && loaded === 'error' && <p className="real-help" role="status">Não foi possível ler os campos customizados; os demais campos continuam disponíveis.</p>}
    <button type="button" className="text-button" disabled={rows.length >= SEARCH_MAX} title={rows.length >= SEARCH_MAX ? `Até ${SEARCH_MAX} filtros.` : undefined} onClick={() => onChange([...rows, fresh(first)])}><Icon name="plus" size={12} /><span>Adicionar filtros</span></button>
  </fieldset>;
}
