import { useEffect, useRef, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import { customFieldItems, visibleCustomFields, type CustomField } from '../lib/custom-fields';
import { CUSTOM_FILTER_MAX, customFilterDraft, customFilterRow, customFilterText, customRowProblem, type CustomFilterRow } from '../lib/product-custom-filter-model';
import { taxonomyTree, type TaxonomyItem } from '../lib/product-form-model';
import { SearchableSelect, type SearchOption } from './SearchableSelect';
import { Icon } from './Icon';
import { aborted } from './catalog-shared';

/** The Produtos tab of Campos customizados, read only when the filter needs it (the list does not pay for it otherwise). */
export function useLazyCustomFields(controller: Pick<AccessController, 'catalog'>) {
  const [fields, setFields] = useState<CustomField[] | null | 'idle' | 'error'>('idle');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), [controller]);
  const load = () => {
    if (fields !== 'idle' && fields !== 'error') return;
    request.current?.abort(); const current = new AbortController(); request.current = current; setFields(null);
    void Promise.resolve().then(() => controller.catalog('/v1/cadastros/campos-customizados', { signal: current.signal }))
      .then(value => { if (!current.signal.aborted) setFields(customFieldItems(value)); })
      .catch(failure => { if (!current.signal.aborted && !aborted(failure)) setFields('error'); });
  };
  return { fields, load };
}

// Origin: "Campos customizados" no painel de filtros da listagem de produtos — "Selecione uma categoria" e "Adicionar filtros",
// com um filtro por campo da categoria: Texto contém, Inteiro/Decimal e Data de–até, Lista igual à opção e Lógico Sim/Não.
// Nada é aplicado até "Filtrar"; linhas incompletas ficam de fora do filtro aplicado.
export function ProductCustomFilter({ value, onChange, fields, onLoad, categories }: {
  value: string; onChange: (text: string) => void; fields: CustomField[] | null | 'idle' | 'error'; onLoad: () => void; categories: readonly TaxonomyItem[];
}) {
  const draft = customFilterDraft(value);
  const set = (next: { category?: string; rows?: CustomFilterRow[] }) => onChange(customFilterText({ ...draft, ...next }));
  // A filter already chosen (applied or restored) shows its fields; the definitions are read once.
  useEffect(() => { if (draft.category || draft.rows.length) onLoad(); }, [draft.category, draft.rows.length]);
  const options: SearchOption[] = [{ value: '', label: 'Selecione uma categoria' }, ...taxonomyTree(categories).map(({ item, depth }) => ({ value: item.id, label: item.name, depth }))];
  const available = Array.isArray(fields) && draft.category ? visibleCustomFields(fields, draft.category, categories) : [];
  const fieldOf = (id: string) => Array.isArray(fields) ? fields.find(field => field.id === id) : undefined;
  const change = (index: number, patch: Partial<CustomFilterRow>) => set({ rows: draft.rows.map((row, i) => i === index ? { ...row, ...patch } : row) });
  const add = () => { const first = available.find(field => !draft.rows.some(row => row.field_id === field.id)) ?? available[0]; if (first) set({ rows: [...draft.rows, customFilterRow(first)] }); };
  return <fieldset className="form-field real-field-wide product-custom-filter"><legend>Campos customizados</legend>
    <div className="product-inline">
      <label className="real-sr-only" htmlFor="catalog-custom-category">Categoria dos campos customizados</label>
      <SearchableSelect id="catalog-custom-category" value={draft.category} options={options} onChange={event => { onLoad(); set({ category: event.target.value }); }} />
      <button type="button" className="text-button" disabled={!draft.category || !available.length || draft.rows.length >= CUSTOM_FILTER_MAX} onClick={add}><Icon name="plus" size={11} />Adicionar filtros</button>
    </div>
    {fields === null && <small role="status">Carregando os campos customizados…</small>}
    {fields === 'error' && <small role="alert">Não foi possível carregar os campos customizados. <button type="button" className="text-button" onClick={onLoad}>Tentar novamente</button></small>}
    {Array.isArray(fields) && draft.category && !available.length && <small>Nenhum campo customizado ativo se aplica a esta categoria.</small>}
    {draft.rows.map((row, index) => {
      const id = `catalog-custom-filter-${index}`, field = fieldOf(row.field_id), problem = customRowProblem(row);
      const touched = Boolean(row.value || row.from || row.to);
      const choices = [...available, ...(field && !available.includes(field) ? [field] : [])];
      return <div key={index} className="product-custom-filter-row" role="group" aria-label={`Filtro ${index + 1}: ${row.name}`}>
        <label className="real-sr-only" htmlFor={`${id}-field`}>Campo do filtro {index + 1}</label>
        <select id={`${id}-field`} value={row.field_id} onChange={event => { const next = fieldOf(event.target.value); if (next) change(index, customFilterRow(next)); }}>
          {!field && <option value={row.field_id}>{row.name || 'Campo excluído'}</option>}
          {choices.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        {row.type === 'text' || row.type === 'long_text' ? <><span className="product-custom-filter-op">contém</span>
          <input id={`${id}-value`} aria-label={`Texto de ${row.name}`} value={row.value} maxLength={255} autoComplete="off" aria-invalid={touched && problem ? true : undefined} onChange={event => change(index, { value: event.target.value })} /></>
          : row.type === 'list' ? <select id={`${id}-value`} aria-label={`Opção de ${row.name}`} value={row.value} onChange={event => change(index, { value: event.target.value, option: field?.options.find(option => option.id === event.target.value)?.label })}>
            <option value="">Selecione</option>{field?.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
          : row.type === 'boolean' ? <select id={`${id}-value`} aria-label={`Valor de ${row.name}`} value={row.value} onChange={event => change(index, { value: event.target.value })}><option value="">Selecione</option><option value="true">Sim</option><option value="false">Não</option></select>
          : <><span className="product-custom-filter-op">de</span>
            <input id={`${id}-from`} aria-label={`${row.name}: de`} type={row.type === 'date' ? 'date' : 'text'} inputMode={row.type === 'date' ? undefined : 'decimal'} min={row.type === 'date' ? '1900-01-01' : undefined} max={row.type === 'date' ? '2100-12-31' : undefined} maxLength={row.type === 'date' ? undefined : 26}
              value={row.from} aria-invalid={touched && problem ? true : undefined} onChange={event => change(index, { from: event.target.value })} />
            <span className="product-custom-filter-op">até</span>
            <input id={`${id}-to`} aria-label={`${row.name}: até`} type={row.type === 'date' ? 'date' : 'text'} inputMode={row.type === 'date' ? undefined : 'decimal'} min={row.type === 'date' ? '1900-01-01' : undefined} max={row.type === 'date' ? '2100-12-31' : undefined} maxLength={row.type === 'date' ? undefined : 26}
              value={row.to} aria-invalid={touched && problem ? true : undefined} onChange={event => change(index, { to: event.target.value })} /></>}
        <button type="button" className="icon-button" aria-label={`Remover o filtro de ${row.name}`} title="Remover filtro" onClick={() => set({ rows: draft.rows.filter((_, i) => i !== index) })}><Icon name="xmark" size={11} /></button>
        {touched && problem && <small className="product-custom-filter-problem">{problem} Este filtro fica de fora até ser corrigido.</small>}
      </div>;
    })}
  </fieldset>;
}
