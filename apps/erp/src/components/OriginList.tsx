import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CALENDAR_NEXT, CALENDAR_PREVIOUS, CALENDAR_STEP, CALENDAR_UP, MONTHS, PERIOD_PRESETS, WEEKDAYS, brDate, calendarCells, calendarHeading, monthGrid, monthRange, pageWindow, parseBrDate, parseIso, periodLabel, presetRange, rangeLabel, type CalendarCell, type CalendarLevel, type IsoDate, type PeriodPreset } from '../lib/origin-list';
import { Icon } from './Icon';
import './origin-list.css';

// Building blocks of the Origin list screen (docs/references/origin-interface.md, "Pedidos de venda").

export function OriginListHeader({ title, selector, primary }: { title: string; selector?: ReactNode; primary?: ReactNode }) {
  return <header className="origin-list-header">
    <div className="origin-list-title"><span className="origin-crumb" aria-hidden="true">...<Icon name="chevron-right" size={10} /></span><h1>{title}</h1>{selector && <span className="origin-title-divider" aria-hidden="true" />}{selector}</div>
    {primary && <div className="origin-list-primary">{primary}</div>}
  </header>;
}

// Green inline selector with search, like "Todas as lojas ▾" / "Todas as contas financeiras ▾".
export function OriginSelector({ label, value, options, onChange }: { label: string; value: string; options: readonly string[]; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const id = useId();
  const shown = options.filter(option => option.toLowerCase().includes(query.trim().toLowerCase()));
  return <span className="origin-selector">
    <button type="button" aria-haspopup="listbox" aria-expanded={open} aria-controls={id} aria-label={`${label}: ${value}`} onClick={() => { setOpen(!open); setQuery(''); }}>{value}<Icon name="caret-down" size={10} /></button>
    {open && <><button type="button" className="origin-click-catcher" tabIndex={-1} aria-label="Fechar seleção" onClick={() => setOpen(false)} /><div className="origin-selector-menu" id={id}>
      <input type="search" aria-label={`Pesquisar ${label.toLowerCase()}`} value={query} onChange={event => setQuery(event.target.value)} autoFocus />
      <ul role="listbox" aria-label={label}>{shown.map(option => <li key={option} role="option" aria-selected={option === value}><button type="button" onClick={() => { onChange(option); setOpen(false); }}>{option}</button></li>)}</ul>
    </div></>}
  </span>;
}

export function OriginToolbar({ filterOpen, onToggleFilter, searchValue, searchPlaceholder, onSearchChange, onSearch, period, tools }: {
  filterOpen?: boolean; onToggleFilter?: () => void; searchValue: string; searchPlaceholder: string; onSearchChange: (value: string) => void; onSearch: () => void; period?: ReactNode; tools?: ReactNode;
}) {
  const submit = (event: FormEvent) => { event.preventDefault(); onSearch(); };
  return <div className="origin-toolbar">
    {onToggleFilter && <button type="button" className={`origin-filter-toggle${filterOpen ? ' is-open' : ''}`} title="Abrir filtro" aria-label={filterOpen ? 'Minimizar filtros' : 'Abrir filtro'} aria-expanded={filterOpen} onClick={onToggleFilter}><Icon name="filter" size={13} /></button>}
    <form className="origin-search" role="search" onSubmit={submit}>
      <input type="search" aria-label="Pesquisar na listagem" placeholder={searchPlaceholder} value={searchValue} onChange={event => onSearchChange(event.target.value)} />
      <button type="submit" title="Pesquisar" aria-label="Pesquisar"><Icon name="magnifying-glass" size={14} /></button>
    </form>
    {period}
    {tools && <div className="origin-toolbar-tools">{tools}</div>}
  </div>;
}

export function ToolButton({ icon, title, onClick, disabled }: { icon: string; title: string; onClick?: () => void; disabled?: boolean }) {
  return <button type="button" className="origin-tool-square" title={title} aria-label={title} onClick={onClick} disabled={disabled}><Icon name={icon} size={14} /></button>;
}

export function AppliedChips({ chips, onClear }: { chips: readonly { label: string; onRemove: () => void }[]; onClear: () => void }) {
  return <div className="origin-chips" aria-label="Filtros aplicados">{chips.length === 0 ? <span className="origin-chip-empty">Nenhum filtro aplicado</span> : <>
    {chips.map(chip => <span className="origin-chip" key={chip.label}>{chip.label}<button type="button" aria-label={`Remover filtro ${chip.label}`} onClick={chip.onRemove}><Icon name="xmark" size={10} /></button></span>)}
    <button type="button" className="origin-chip-clear" onClick={onClear}>Limpar</button></>}
  </div>;
}

export function ListControls({ checked, indeterminate, onToggleAll, onRefresh, selections, views }: {
  checked: boolean; indeterminate?: boolean; onToggleAll: () => void; onRefresh?: () => void; selections?: readonly { label: string; onSelect: () => void }[]; views?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return <div className="origin-list-controls">
    <span className="origin-select-all"><input type="checkbox" aria-label="Selecionar todos" title="Selecionar todos" checked={checked} aria-checked={indeterminate ? 'mixed' : checked} onChange={onToggleAll} />
      {selections && <><button type="button" className="origin-select-caret" title="Abrir seleções customizadas" aria-label="Abrir seleções customizadas" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="caret-down" size={9} /></button>
        {open && <><button type="button" className="origin-click-catcher" tabIndex={-1} aria-label="Fechar seleções" onClick={() => setOpen(false)} /><div className="origin-dropdown origin-dropdown-left">{selections.map(item => <button type="button" key={item.label} onClick={() => { item.onSelect(); setOpen(false); }}>{item.label}</button>)}</div></>}</>}
    </span>
    {onRefresh && <button type="button" className="origin-refresh" title="Recarregar" aria-label="Recarregar" onClick={onRefresh}><Icon name="rotate-right" size={12} /></button>}
    {views && <div className="origin-views">{views}</div>}
  </div>;
}

export function ViewToggle({ active, onChange }: { active: 'padrao' | 'customizada'; onChange: (view: 'padrao' | 'customizada') => void }) {
  return <>
    <button type="button" className={active === 'padrao' ? 'active' : ''} title="Visualizar listagem padrão" aria-label="Visualizar listagem padrão" aria-pressed={active === 'padrao'} onClick={() => onChange('padrao')}><Icon name="list" size={14} /></button>
    <button type="button" className={active === 'customizada' ? 'active' : ''} title="Visualizar listagem customizada" aria-label="Visualizar listagem customizada" aria-pressed={active === 'customizada'} onClick={() => onChange('customizada')}><Icon name="table-columns" size={14} /></button>
  </>;
}

// Origin datepicker: the title switches day → month → year → decade → century views; each calendar has Hoje and Limpar.
// `max` (Origin home charts): days after it are disabled.
export function CalendarMonth({ title, value, from, to, today, max, onPick, onClear }: { title: string; value: IsoDate | ''; from: IsoDate | ''; to: IsoDate | ''; today?: IsoDate; max?: IsoDate; onPick: (date: IsoDate) => void; onClear?: () => void }) {
  const fallback = today && parseIso(today) ? today : new Date().toISOString().slice(0, 10);
  const base = parseIso(value || from || to || '') ?? parseIso(fallback)!;
  const [view, setView] = useState<[number, number]>([base[0], base[1]]);
  const [level, setLevel] = useState<CalendarLevel>('days');
  const [year, month] = view;
  const move = (delta: number) => { const step = CALENDAR_STEP[level]; const index = year * 12 + (month - 1) + delta * step; setView([Math.floor(index / 12), (index % 12) + 1]); };
  const choose = (cell: CalendarCell) => { setView([cell.year, cell.month ?? month]); setLevel(cell.level); };
  const pickToday = () => { const parts = parseIso(fallback)!; setView([parts[0], parts[1]]); setLevel('days'); onPick(fallback); };
  return <div className="origin-calendar" aria-label={title}>
    <div className="origin-calendar-head"><button type="button" aria-label={CALENDAR_PREVIOUS[level]} onClick={() => move(-1)}>«</button><button type="button" className="origin-calendar-title" aria-label={`${calendarHeading(level, year, month)}: alternar visão`} disabled={level === 'centuries'} onClick={() => setLevel(CALENDAR_UP[level])}><strong>{calendarHeading(level, year, month)}</strong></button><button type="button" aria-label={CALENDAR_NEXT[level]} onClick={() => move(1)}>»</button></div>
    {level === 'days' ? <div className="origin-calendar-grid" role="grid">{WEEKDAYS.map(day => <span key={day} className="origin-weekday" role="columnheader">{day}</span>)}
      {monthGrid(year, month).map(cell => { const inRange = from && to && cell.date >= from && cell.date <= to; const edge = cell.date === from || cell.date === to;
        return <button type="button" role="gridcell" key={cell.date} className={`${cell.inMonth ? '' : 'is-outside '}${inRange ? 'in-range ' : ''}${edge ? 'is-edge' : ''}`.trim() || undefined} aria-selected={edge} aria-label={brDate(cell.date)} disabled={Boolean(max && cell.date > max)} onClick={() => onPick(cell.date)}>{cell.day}</button>; })}
    </div> : <div className="origin-calendar-grid origin-calendar-wide" role="grid">{calendarCells(level, year, month).map(cell => <button type="button" role="gridcell" key={cell.label} className={cell.outside ? 'is-outside' : cell.current ? 'is-edge' : undefined} aria-selected={cell.current} onClick={() => choose(cell)}>{cell.label}</button>)}</div>}
    {(today || onClear) && <div className="origin-calendar-foot"><button type="button" className="text-button" onClick={pickToday}>Hoje</button>{onClear && <button type="button" className="text-button" onClick={onClear}>Limpar</button>}</div>}
  </div>;
}

// Origin period popover: date type, two calendars (início/fim), presets column, Cancelar/Filtrar.
export function PeriodPicker({ from, to, today, dateType, dateTypes, prefixLabel, iconOnly, typeTabs, noFuture, onApply }: {
  from: IsoDate | ''; to: IsoDate | ''; today: IsoDate; dateType?: string; dateTypes?: readonly string[]; prefixLabel?: boolean; /** Origin OS: calendar button without text. */ iconOnly?: boolean;
  /** Origin Produtos: the date types as tabs ('Alterado em' | 'Data de validade') instead of a select. */ typeTabs?: boolean;
  /** Origin home charts: days after today are disabled and never applied. */ noFuture?: boolean; onApply: (range: { from: IsoDate | ''; to: IsoDate | ''; dateType?: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftType, setDraftType] = useState(dateType);
  const [draftFrom, setDraftFrom] = useState<IsoDate | ''>(from);
  const [draftTo, setDraftTo] = useState<IsoDate | ''>(to);
  const [fromText, setFromText] = useState(from ? brDate(from) : '');
  const [toText, setToText] = useState(to ? brDate(to) : '');
  const [mode, setMode] = useState<string>('customizado');
  const [monthPick, setMonthPick] = useState<[number, number]>(() => { const parts = parseIso(today)!; return [parts[0], parts[1]]; });
  const typeId = useId();
  useEffect(() => { if (!open) return; setDraftType(dateType); setDraftFrom(from); setDraftTo(to); setFromText(from ? brDate(from) : ''); setToText(to ? brDate(to) : ''); }, [open]);
  const cap = (date: IsoDate | '') => (noFuture && date && date > today ? today : date);
  const setRange = (first: IsoDate | '', last: IsoDate | '') => { const start = cap(first), end = cap(last); setDraftFrom(start); setDraftTo(end); setFromText(start ? brDate(start) : ''); setToText(end ? brDate(end) : ''); };
  const apply = (first = draftFrom, last = draftTo) => { const start = cap(first), end = cap(last); const [a, b] = start && end && start > end ? [end, start] : [start, end]; onApply({ from: a, to: b, dateType: draftType }); setOpen(false); };
  const pickPreset = (id: string) => { setMode(id); if (id !== 'customizado' && id !== 'selecionar-mes') { const range = presetRange(id as PeriodPreset, today); setRange(range.from, range.to); } if (id === 'selecionar-mes') { const range = monthRange(monthPick[0], monthPick[1]); setRange(range.from, range.to); } };
  const pickMonth = (next: [number, number]) => { setMonthPick(next); const range = monthRange(next[0], next[1]); setRange(range.from, range.to); };
  const typed = (text: string, which: 'from' | 'to') => { const typedDate = parseBrDate(text), parsed = cap(typedDate || ''); which === 'from' ? setFromText(parsed && parsed !== typedDate ? brDate(parsed) : text) : setToText(parsed && parsed !== typedDate ? brDate(parsed) : text); if (parsed) which === 'from' ? setDraftFrom(parsed) : setDraftTo(parsed); if (!text.trim()) which === 'from' ? setDraftFrom('') : setDraftTo(''); setMode('customizado'); };
  const label = periodLabel(from, to, today, prefixLabel && dateType ? dateType : undefined);
  return <span className="origin-period">
    <button type="button" className={`origin-period-chip${iconOnly ? ' is-icon-only' : ''}`} title="Abrir períodos" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="calendar-days" size={12} /><span className={iconOnly ? 'sr-only' : undefined}>{label}</span></button>
    {open && <><button type="button" className="origin-click-catcher" tabIndex={-1} aria-label="Fechar períodos" onClick={() => setOpen(false)} /><div className="origin-period-popover" role="dialog" aria-label="Período">
      {dateTypes && dateTypes.length > 0 && (typeTabs ? <div className="origin-period-type origin-period-tabs" role="tablist" aria-label="Tipo de data">{dateTypes.map(type => <button key={type} type="button" role="tab" aria-selected={draftType === type} className={draftType === type ? 'active' : undefined} onClick={() => setDraftType(type)}>{type}</button>)}</div>
        : <div className="origin-period-type"><label htmlFor={typeId} className="sr-only">Tipo de data</label><select id={typeId} value={draftType} onChange={event => setDraftType(event.target.value)}>{dateTypes.map(type => <option key={type}>{type}</option>)}</select></div>)}
      <div className="origin-period-body">
        <div className="origin-period-side"><label>Início do período<input inputMode="numeric" placeholder="dd/mm/aaaa" value={fromText} onChange={event => typed(event.target.value, 'from')} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); const start = parseBrDate(fromText) || ''; const end = draftTo || start; setRange(start, end); apply(start, end); } }} /></label><CalendarMonth title="Início do período" value={draftFrom} from={draftFrom} to={draftTo} today={today} max={noFuture ? today : undefined} onPick={date => { setMode('customizado'); setRange(date, draftTo && draftTo < date ? date : draftTo); }} onClear={() => { setMode('customizado'); setRange('', draftTo); }} /></div>
        <div className="origin-period-side"><label>Fim do período<input inputMode="numeric" placeholder="dd/mm/aaaa" value={toText} onChange={event => typed(event.target.value, 'to')} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); apply(); } }} /></label><CalendarMonth title="Fim do período" value={draftTo} from={draftFrom} to={draftTo} today={today} max={noFuture ? today : undefined} onPick={date => { setMode('customizado'); setRange(draftFrom && draftFrom > date ? date : draftFrom, date); }} onClear={() => { setMode('customizado'); setRange(draftFrom, ''); }} /></div>
        <ul className="origin-period-presets">{PERIOD_PRESETS.map(preset => <li key={preset.id}><button type="button" className={mode === preset.id ? 'active' : ''} aria-pressed={mode === preset.id} onClick={() => pickPreset(preset.id)}>{preset.label}</button>
          {preset.id === 'selecionar-mes' && mode === 'selecionar-mes' && <span className="origin-month-pick" role="group" aria-label="Selecionar mês">
            {/* Origin: a Jan..Dez grid with ‹ ano › navigation. */}
            <span className="origin-month-year"><button type="button" aria-label="Ano anterior" disabled={monthPick[0] <= 1900} onClick={() => pickMonth([monthPick[0] - 1, monthPick[1]])}>‹</button><strong>{monthPick[0]}</strong><button type="button" aria-label="Próximo ano" disabled={monthPick[0] >= 2100} onClick={() => pickMonth([monthPick[0] + 1, monthPick[1]])}>›</button></span>
            <span className="origin-month-grid">{MONTHS.map((name, index) => <button type="button" key={name} aria-label={`${name} de ${monthPick[0]}`} aria-pressed={monthPick[1] === index + 1} className={monthPick[1] === index + 1 ? 'active' : undefined} onClick={() => pickMonth([monthPick[0], index + 1])}>{name.slice(0, 3)}</button>)}</span>
          </span>}</li>)}</ul>
      </div>
      <div className="origin-period-actions"><button type="button" className="secondary-button" onClick={() => setOpen(false)}>Cancelar</button><button type="button" className="primary-button" onClick={() => apply()}>Filtrar</button><button type="button" className="text-button" onClick={() => { setRange('', ''); }}>Limpar período</button></div>
    </div></>}
  </span>;
}

export function OriginFilterPanel({ open, onClose, onApply, children }: { open: boolean; onClose: () => void; onApply: () => void; children: ReactNode }) {
  if (!open) return null;
  return <aside className="origin-filter-panel" aria-label="Filtros">
    <div className="origin-filter-head"><h2><Icon name="filter" size={12} />Filtrar</h2><button type="button" title="Minimizar filtros" aria-label="Minimizar filtros" onClick={onClose}><Icon name="xmark" size={13} /></button></div>
    <div className="origin-filter-fields">{children}</div>
    <div className="origin-filter-foot"><button type="button" className="secondary-button" onClick={onApply}>Filtrar</button></div>
  </aside>;
}

export type PanelAction = { label: string; icon: string; title?: string; onClick?: () => void; disabled?: boolean; disabledReason?: string };
export type PanelLink = { label: string; to?: string };

export function OriginActionsPanel({ primary, actions = [], more = [], info = [], support = [], notice, collapsed, onCollapse }: {
  primary?: ReactNode; actions?: readonly PanelAction[]; more?: readonly { title: string; items: readonly PanelAction[] }[]; info?: readonly { label: string; value: string }[];
  support?: readonly PanelLink[]; notice?: ReactNode; collapsed: boolean; onCollapse: () => void;
}) {
  const [moreOpen, setMoreOpen] = useState(true);
  if (collapsed) return <aside className="origin-actions-panel is-collapsed" aria-label="Ações"><button type="button" className="origin-collapse" title="Expandir barra de ações" aria-label="Expandir barra de ações" onClick={onCollapse}><Icon name="chevron-left" size={12} /></button></aside>;
  return <aside className="origin-actions-panel" aria-label="Ações">
    {primary && <div className="origin-actions-primary">{primary}</div>}
    <div className="origin-actions-box">
      {actions.map(action => <button type="button" className="origin-action" key={action.label} title={action.disabled ? action.disabledReason : action.title || action.label} disabled={action.disabled} onClick={action.onClick}><Icon name={action.icon} size={15} /><span>{action.label}</span></button>)}
      {more.length > 0 && <div className="origin-more"><button type="button" className="origin-more-toggle" aria-expanded={moreOpen} title="Mais ações" onClick={() => setMoreOpen(!moreOpen)}><Icon name={moreOpen ? 'square-minus' : 'square-plus'} size={13} />Mais ações</button>
        {moreOpen && more.map(group => <div className="origin-more-group" key={group.title}><h3>{group.title}</h3>{group.items.map(item => <button type="button" key={item.label} disabled={item.disabled} title={item.disabled ? item.disabledReason : item.label} onClick={item.onClick}>{item.label}</button>)}</div>)}</div>}
      {info.length > 0 && <section className="origin-info"><h2>Informações</h2><dl>{info.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl></section>}
      {support.length > 0 && <section className="origin-support"><h2>Ferramentas de apoio</h2>{support.map(link => link.to ? <Link key={link.label} to={link.to}>{link.label}</Link> : <span key={link.label} title="Ainda não disponível no FAGOO">{link.label}</span>)}</section>}
      {notice}
    </div>
    <button type="button" className="origin-collapse" title="Minimizar barra de ações" aria-label="Minimizar barra de ações" onClick={onCollapse}><Icon name="chevron-right" size={12} /></button>
  </aside>;
}

export type RowMenuItem = { label: string; icon?: string; letter?: { text: string; color: string; struck?: boolean }; onClick?: () => void; to?: string; disabled?: boolean; separatorBefore?: boolean; title?: string };

// `struck` draws the letter crossed out, as Origin does for the Estornar actions.
export function IndicatorLetter({ text, color, title, struck }: { text: string; color: string; title: string; struck?: boolean }) {
  return <span className={`origin-letter origin-letter-${color}${struck ? ' is-struck' : ''}`} title={title} aria-label={title} role="img">{text}</span>;
}

export function RowMenu({ label, items, open, onToggle }: { label: string; items: readonly RowMenuItem[]; open: boolean; onToggle: () => void }) {
  const [anchor, setAnchor] = useState<{ top: number; right: number; maxHeight: number } | null>(null);
  const place = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const viewportHeight = globalThis.window?.innerHeight ?? 800, viewportWidth = globalThis.window?.innerWidth ?? 1200;
    const top = Math.max(8, Math.min(rect.top, viewportHeight - 240));
    setAnchor({ top, right: Math.max(8, viewportWidth - rect.left + 4), maxHeight: Math.max(160, viewportHeight - top - 12) });
  };
  const content = (item: RowMenuItem) => <>{item.letter ? <IndicatorLetter text={item.letter.text} color={item.letter.color} title={item.label} struck={item.letter.struck} /> : item.icon ? <Icon name={item.icon} size={13} /> : <span className="origin-icon-gap" />}{item.label}</>;
  return <span className="origin-row-menu">
    <button type="button" className="origin-kebab" aria-label={`Ações de ${label}`} aria-haspopup="menu" aria-expanded={open} onClick={event => { event.stopPropagation(); if (!open) place(event.currentTarget); onToggle(); }}><Icon name="ellipsis-vertical" size={13} /></button>
    {open && <><button type="button" className="origin-click-catcher" tabIndex={-1} aria-label="Fechar ações" onClick={event => { event.stopPropagation(); onToggle(); }} /><div className="origin-dropdown origin-dropdown-floating" role="menu" style={anchor ? { top: anchor.top, right: anchor.right, maxHeight: anchor.maxHeight } : undefined} onClick={event => event.stopPropagation()}>{items.map(item => <div key={item.label} className={item.separatorBefore ? 'with-separator' : undefined}>
      {item.to && !item.disabled ? <Link role="menuitem" to={item.to} onClick={onToggle}>{content(item)}</Link>
        : <button type="button" role="menuitem" disabled={item.disabled} title={item.disabled ? item.title ?? 'Disponível quando a operação real estiver habilitada' : item.title} onClick={() => { item.onClick?.(); onToggle(); }}>{content(item)}</button>}
    </div>)}</div></>}
  </span>;
}

export function OriginPagination({ page, pages, size, total, onPage, pageSelect }: { page: number; pages: number; size: number; total: number; onPage: (page: number) => void;
  /** Origin Produtos: a select with every page between Anterior and Próxima (up to 2.000 pages) instead of the page numbers. */ pageSelect?: boolean }) {
  const numbers = pageWindow(page, pages).slice().reverse();
  return <nav className="origin-pagination" aria-label="Paginação">
    <button type="button" disabled={page <= 1} onClick={() => onPage(1)}>Primeira</button>
    <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>Anterior</button>
    {pageSelect && pages <= 2000 ? <select aria-label="Página" value={page} onChange={event => onPage(Number(event.target.value))}>{Array.from({ length: pages }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}</select>
      : numbers.map(number => <button type="button" key={number} aria-current={number === page ? 'page' : undefined} onClick={() => onPage(number)}>{number}</button>)}
    <button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)}>Próxima</button>
    <button type="button" disabled={page >= pages} onClick={() => onPage(pages)}>Última</button>
    <span className="origin-range">{rangeLabel(page, size, total)}</span>
  </nav>;
}
