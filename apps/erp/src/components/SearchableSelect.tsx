import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { fold } from '../lib/product-form-model';
import { Icon } from './Icon';
import './product-registry.css';

// Select pesquisável do Origin (Tags, Categoria, Grupo de Produtos): botão com a opção atual e, aberto, a busca "Pesquisar" e a
// lista filtrada sem acento, com grupos e níveis da árvore; setas, Enter e Esc no teclado. O onChange recebe o mesmo evento
// de um <select> ({ target: { value } }), então a tela troca o controle sem mudar o estado.
export type SearchOption = { value: string; label: string; group?: string; depth?: number };
export function SearchableSelect({ id, value, options, onChange, disabled, title, invalid, placeholder = 'Pesquisar' }: {
  id: string; value: string; options: readonly SearchOption[]; onChange: (event: { target: { value: string } }) => void; disabled?: boolean; title?: string; invalid?: boolean; placeholder?: string;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [active, setActive] = useState(0);
  const list = useId(), root = useRef<HTMLSpanElement | null>(null), input = useRef<HTMLInputElement | null>(null);
  const shown = query.trim() ? options.filter(option => fold(option.label).includes(fold(query.trim())) || fold(option.group ?? '').includes(fold(query.trim()))) : options;
  const current = options.find(option => option.value === value);
  useEffect(() => { if (open) { setActive(Math.max(0, shown.findIndex(option => option.value === value))); input.current?.focus?.(); } }, [open]);
  const choose = (option: SearchOption | undefined) => { if (!option) return; onChange({ target: { value: option.value } }); setOpen(false); setQuery(''); };
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(shown.length - 1, index + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, index - 1)); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(shown[active]); }
    else if (event.key === 'Escape') { event.preventDefault(); setOpen(false); setQuery(''); }
  };
  let lastGroup: string | undefined;
  return <span className="searchable-select" ref={root}>
    <button type="button" id={id} className="searchable-select-button" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={list} aria-invalid={invalid || undefined} disabled={disabled} title={title}
      onClick={() => setOpen(!open)}><span>{current?.label ?? 'Selecione'}</span><Icon name="chevron-down" size={10} /></button>
    {open && <><button type="button" className="origin-click-catcher" tabIndex={-1} aria-label="Fechar a lista" onClick={() => { setOpen(false); setQuery(''); }} />
      <div className="searchable-select-panel">
        <input ref={input} aria-label={placeholder} placeholder={placeholder} value={query} maxLength={60} aria-controls={list} aria-activedescendant={shown[active] ? `${list}-${active}` : undefined}
          onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={keys} />
        <ul id={list} role="listbox" aria-label="Opções">{shown.length ? shown.map((option, index) => {
          const header = option.group && option.group !== lastGroup ? <li key={`group:${option.group}`} role="presentation" className="searchable-select-group">{option.group}</li> : null;
          lastGroup = option.group;
          return [header, <li key={option.value} id={`${list}-${index}`} role="option" aria-selected={option.value === value} className={index === active ? 'is-active' : undefined}
            style={option.depth ? { paddingLeft: `${8 + option.depth * 14}px` } : undefined} onMouseDown={event => event.preventDefault()} onClick={() => choose(option)}>{option.depth ? '└ ' : ''}{option.label}</li>];
        }) : <li role="presentation" className="real-help">Nenhuma opção encontrada.</li>}</ul>
      </div></>}
  </span>;
}
