import { lazy, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { MODULES } from './modules';
import { DEMO_REFERENCE_DATE } from './demo-data';
import { Icon } from './components/Icon';
import OriginTopBar from './components/OriginTopBar';
import { AppliedChips, OriginActionsPanel, OriginFilterPanel, OriginListHeader, OriginPagination, OriginSelector, OriginToolbar, IndicatorLetter, ListControls, PeriodPicker, RowMenu, ToolButton, ViewToggle } from './components/OriginList';
import { badgeClass, opensInNewTab, selectRange } from './lib/origin-list';
import PreferencesPage from './components/PreferencesPage';
import { DailySummary, FavoritesPanel, HomeTabs } from './components/OriginHome';
import DemoPdv from './components/DemoPdv';
import ReportsCatalog from './components/ReportsCatalog';
import { DEMO_PREFERENCES, resolveMenu } from './lib/origin-menu';
import { useTheme } from './hooks/useTheme';
import { Modal } from './components/Modal';
import { RecordFields } from './components/RecordFields';
import { LineItemsEditor, money } from './components/LineItemsEditor';
import NativeModuleBoundary from './components/NativeModuleBoundary';
import { documentTotal as calculateDocumentTotal, validDemoItems, validateDemoForm } from './lib/document-model';
import { moduleListHref, useListState } from './hooks/useListState';
import { newDemoId, nextDemoNumber, useDemoStore } from './hooks/useDemoStore';
import { csvForRecords, effectiveDateField, filterAndSortRecords, localCalendarDate, normalized, proposalToOrder } from './lib/demo-model';
import type { ColumnDefinition, DemoLineItem, DemoRecord, ModuleDefinition, NavigationGroup } from './types';

const today = localCalendarDate;
const RealAccess = lazy(() => import('./components/RealAccess'));
type Notify = (message: string) => void;

function display(value: unknown, column: ColumnDefinition) {
  if (value === undefined || value === '') return '—';
  if (column.type === 'money') return money(value);
  if (column.type === 'date' && /^\d{4}-\d{2}-\d{2}/.test(String(value))) return String(value).slice(0, 10).split('-').reverse().join('/');
  if (column.type === 'number') return Number(value).toLocaleString('pt-BR');
  return String(value);
}

function statusClass(value: unknown) {
  const label = normalized(value);
  if (/cancel|rejeit|atras|inativ|recus|nao aprov|sem conserto/.test(label)) return 'status-danger';
  if (/atendid|aprova|conclu|recebid|pago|paga|autoriza|ativo|ativa|registrad/.test(label)) return 'status-success';
  if (/andamento|parcial|pendente|aguard|hoje/.test(label)) return 'status-warning';
  return 'status-neutral';
}

function PageHeading({ module, suffix }: { module: ModuleDefinition; suffix?: string }) {
  return <header className="page-heading">
    <div><nav className="breadcrumb" aria-label="Localização"><Link to="/inicio">Início</Link><span>›</span><span>{module.group}</span>{suffix && <><span>›</span><Link to={moduleListHref(module.id)}>{module.title}</Link></>}</nav>
    <h1 className="page-title">{suffix || module.title}</h1>{!suffix && <p className="page-description">{module.description?.split(' Ambiente de demonstração')[0]}</p>}</div>
  </header>;
}

const DEMO_GROUPS = resolveMenu('demo');

function Navigation({ theme, onTheme }: { theme: 'light' | 'dark'; onTheme: () => void }) {
  const location = useLocation();
  const segment = location.pathname.split('/')[1];
  const active = location.pathname === '/inicio' ? 'Meu Negócio' : DEMO_GROUPS.find(group => group.columns.some(column => column.items.some(item => item.to && item.to.split('?')[0].split('/')[1] === segment)))?.name;
  return <OriginTopBar groups={DEMO_GROUPS} activeGroup={active} homeTo="/inicio" preferencesTo="/configuracoes" user={{ name: 'Demonstração', company: 'Empresa de demonstração', detail: 'Dados fictícios' }}
    theme={theme} onTheme={onTheme} userLinks={[{ label: 'Acessar empresa', to: '/acesso', icon: 'building' }]} />;
}

const INDICATORS: Record<string, { letter?: { text: string; color: string }; icon?: string; className?: string; title: string }> = {
  P: { letter: { text: 'P', color: 'red' }, title: 'Proposta comercial de origem' },
  C: { letter: { text: 'C', color: 'green' }, title: 'Contas lançadas' },
  E: { letter: { text: 'E', color: 'blue' }, title: 'Estoque lançado - Depósito: Geral' },
  ER: { letter: { text: 'E', color: 'darkred' }, title: 'NF-e com erros' },
  V: { letter: { text: 'V', color: 'orange' }, title: 'Pedido de venda vinculado' },
  N: { letter: { text: 'N', color: 'darkred' }, title: 'Nota fiscal' },
  NE: { letter: { text: 'N', color: 'deepgreen' }, title: 'Não enviado' },
  O: { letter: { text: 'O', color: 'midgreen' }, title: 'Ordem de serviço' },
  M: { icon: 'envelope', className: 'is-mail', title: 'Enviado por e-mail' },
  OBS: { icon: 'comment', className: 'is-comment', title: 'Observação interna' },
  ALERT: { icon: 'triangle-exclamation', className: 'is-warning', title: 'Contém pendências' },
  R: { icon: 'retweet', className: 'is-mail', title: 'Conta recorrente' },
};

function Indicators({ value }: { value: unknown }) {
  const codes = String(value || '').split(',').map(code => code.trim()).filter(code => INDICATORS[code]);
  if (!codes.length) return null;
  return <span className="origin-indicators">{codes.map(code => { const item = INDICATORS[code]!; return item.letter ? <IndicatorLetter key={code} text={item.letter.text} color={item.letter.color} title={item.title} /> : <span key={code} className={item.className} title={item.title} role="img" aria-label={item.title}><Icon name={item.icon!} size={13} /></span>; })}</span>;
}

const PANEL_KEY = 'brufap.erp.demo.panels.';
function readPanels(moduleId: string, defaults: { filters: boolean; actions: boolean }) {
  const phone = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 760px)').matches;
  try { const value = JSON.parse(localStorage.getItem(PANEL_KEY + moduleId) || 'null'); if (value && typeof value.filters === 'boolean' && typeof value.actions === 'boolean') return phone ? { ...value, filters: false } as { filters: boolean; actions: boolean } : value as { filters: boolean; actions: boolean }; } catch { /* Defaults apply. */ }
  return phone ? { ...defaults, filters: false } : defaults;
}

function ListPage({ module, notify, onConvert }: { module: ModuleDefinition; notify: Notify; onConvert: (row: DemoRecord) => void }) {
  const { records, save } = useDemoStore();
  const navigate = useNavigate();
  const { params, update, clear } = useListState(module.id);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [panels, setPanels] = useState(() => readPanels(module.id, { filters: Boolean(module.filterPanelOpen), actions: true }));
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [search, setSearch] = useState(params.get('q') || '');
  const [view, setView] = useState<'padrao' | 'customizada'>('padrao');
  const [visibleKeys, setVisibleKeys] = useState<string[]>(() => {
    try { const values = JSON.parse(localStorage.getItem(`brufap.erp.demo.columns.${module.id}`) || 'null'); if (Array.isArray(values) && values.some(key => module.columns.some(column => column.key === key))) return values; } catch { /* Use module defaults. */ }
    return module.columns.map(column => column.key);
  });
  const serialized = params.toString();
  const query = params.get('q') || '';
  const rows = records[module.id] || [];
  const awaitingProduct = module.id === 'estoque' && !query.trim() && !params.get('filter.product');
  // A default (e.g. "Situação: Em aberto") applies until the user removes it; removal stores "*" (all).
  const effectiveParams = useMemo(() => { const next = new URLSearchParams(serialized); for (const [key, value] of Object.entries(module.defaultFilters || {})) { const current = next.get(`filter.${key}`); if (current === null) next.set(`filter.${key}`, value); else if (current === '*') next.delete(`filter.${key}`); } return next; }, [serialized, module]);
  const filtered = useMemo(() => filterAndSortRecords(rows, module, effectiveParams, DEMO_REFERENCE_DATE), [rows, module, effectiveParams]);
  const columns = view === 'customizada' ? module.columns.filter(column => visibleKeys.includes(column.key)) : module.columns;
  const size = 100;
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(params.get('page')) || 1)));
  const paged = filtered.slice((page - 1) * size, page * size);
  const ids = paged.map(row => row.id);
  const allSelected = paged.length > 0 && paged.every(row => selected.has(row.id));
  const someSelected = paged.some(row => selected.has(row.id));
  const selectedRows = rows.filter(row => selected.has(row.id));
  const dateTypes = module.periodTypes;
  const dateType = params.get('dt') || dateTypes?.[0];
  const totalColumn = module.columns.find(column => column.type === 'money' && ['total', 'balance', 'value', 'amount'].includes(column.key));
  const total = totalColumn ? filtered.reduce((sum, row) => sum + Math.round(Number(row[totalColumn.key] || 0) * 100), 0) / 100 : null;
  const removeFilter = (key: string) => update({ [`filter.${key}`]: module.defaultFilters?.[key] ? '*' : '' });
  const chips = [
    ...(query ? [{ label: `Pesquisa: ${query}`, onRemove: () => { setSearch(''); update({ q: '' }); } }] : []),
    ...[...effectiveParams].filter(([key, value]) => value && key.startsWith('filter.')).map(([key, value]) => { const filterKey = key.slice(7); const filter = module.filters?.find(item => item.key === filterKey); return { label: `${filter?.label || filterKey}: ${value.split('|').join(', ')}`, onRemove: () => removeFilter(filterKey) }; }),
  ];
  const href = (row: DemoRecord) => `/${module.id}/${encodeURIComponent(row.id)}`;
  const persistPanels = (next: { filters: boolean; actions: boolean }) => { setPanels(next); try { localStorage.setItem(PANEL_KEY + module.id, JSON.stringify(next)); } catch { /* Preference stays for this visit. */ } };
  useEffect(() => { setSelected(new Set()); setAnchor(null); setRowMenu(null); }, [serialized]);
  useEffect(() => { setSearch(query); }, [query]);
  useEffect(() => { if (panels.filters) setDraft(Object.fromEntries((module.filters || []).map(filter => [filter.key, effectiveParams.get(`filter.${filter.key}`) || '']))); }, [panels.filters, serialized]);
  const toggleRow = (id: string, shift: boolean) => { const result = selectRange(ids, selected, anchor, id, shift); setSelected(result.selected); setAnchor(result.anchor); };
  const togglePage = () => setSelected(previous => { const next = new Set(previous); paged.forEach(row => allSelected ? next.delete(row.id) : next.add(row.id)); return next; });
  const exportRows = (values: DemoRecord[]) => {
    const url = URL.createObjectURL(new Blob([csvForRecords(values, columns)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `brufap-demonstracao-${module.id}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('Arquivo de demonstração exportado.');
  };
  const applyFilters = () => update(Object.fromEntries((module.filters || []).filter(filter => !filter.hidden).map(filter => [`filter.${filter.key}`, draft[filter.key] || (module.defaultFilters?.[filter.key] ? '*' : '')])));
  const openRow = (row: DemoRecord, event: { ctrlKey?: boolean; metaKey?: boolean; button?: number }) => { if (opensInNewTab(event)) window.open(href(row), '_blank', 'noopener'); else navigate(href(row)); };
  const statusOptions = module.fields.find(field => field.key === 'status')?.options || module.filters?.find(filter => filter.key === 'status')?.options || [];
  const runRowAction = (row: DemoRecord, label: string) => {
    if (statusOptions.includes(label)) { save(module.id, { ...row, status: label }); notify(`Situação alterada para ${label} nesta demonstração.`); return; }
    if (/^Clonar/.test(label)) { const copy = { ...row, id: newDemoId(), number: nextDemoNumber(rows), status: statusOptions[0] || row.status }; save(module.id, copy); notify('Cópia criada nesta demonstração.'); navigate(href(copy)); return; }
    if (/^Gerar (venda|pedido)/.test(label) && module.id === 'propostas') { onConvert(row); return; }
    if (label === 'Imprimir') window.print();
  };
  const rowItems = (row: DemoRecord) => (module.rowMenu || []).filter(item => !(statusOptions.includes(item.label) && item.label === row.status)).map(item => {
    const supported = statusOptions.includes(item.label) || /^Clonar/.test(item.label) || (/^Gerar (venda|pedido)/.test(item.label) && module.id === 'propostas') || item.label === 'Imprimir';
    return { ...item, disabled: !supported, onClick: () => runRowAction(row, item.label) };
  });
  const panelAction = (label: string): { onClick?: () => void; disabled?: boolean; disabledReason?: string } => {
    if (/planilha/i.test(label)) return { onClick: () => exportRows(selectedRows.length ? selectedRows : filtered) };
    if (/^Imprimir (listagem|selecionad)/.test(label)) return { onClick: () => window.print() };
    if (/^Mudar situação/.test(label)) return { disabled: true, disabledReason: 'Nesta demonstração, mude a situação pelo menu ⋮ de cada linha' };
    return { disabled: true, disabledReason: 'Disponível quando a operação real estiver habilitada' };
  };
  const counted = module.info?.count || `Quantidade de ${module.title.toLowerCase()}`;
  const tabsValue = module.listTabs ? (params.get(`tab.${module.listTabs.key}`) || module.listTabs.options[0]) : '';
  const recordLabel = (row: DemoRecord) => String(row.number || row.name || row.description || row.id);

  return <div className="origin-list-page">
    <OriginListHeader title={module.title} selector={module.selector ? <OriginSelector label={module.selector.label} value={(module.selector.filterKey ? params.get(`filter.${module.selector.filterKey}`) : params.get('sel')) || module.selector.options[0]!} options={module.selector.options} onChange={value => { const cleared = value === module.selector!.options[0] ? '' : value; update(module.selector!.filterKey ? { [`filter.${module.selector!.filterKey}`]: cleared } : { sel: cleared }); }} /> : undefined}
      primary={!module.readOnly ? <Link className="primary-button" to={`/${module.id}/novo`}><Icon name="plus" size={12} />{module.primaryAction || 'Incluir'}</Link> : undefined} />
    <div className={`origin-list-workspace${panels.filters ? ' has-filters' : ''}${panels.actions ? '' : ' actions-collapsed'}`}>
      <OriginFilterPanel open={panels.filters} onClose={() => persistPanels({ ...panels, filters: false })} onApply={applyFilters}>
        {(module.filters || []).filter(filter => !filter.hidden).map(filter => <div className="origin-field" key={filter.key}><label htmlFor={`filter-${module.id}-${filter.key}`}>{filter.label}{filter.info && <span title={filter.info}> <Icon name="circle-info" size={11} /></span>}</label>
          {filter.kind === 'text' ? <input id={`filter-${module.id}-${filter.key}`} value={draft[filter.key] || ''} onChange={event => setDraft({ ...draft, [filter.key]: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); applyFilters(); } }} />
            : <select id={`filter-${module.id}-${filter.key}`} value={(draft[filter.key] || '').split('|')[0] || ''} onChange={event => setDraft({ ...draft, [filter.key]: event.target.value })}><option value="">{filter.kind === 'multi' ? 'Selecione uma opção' : 'Todos'}</option>{filter.options.map(option => <option key={option}>{option}</option>)}</select>}
        </div>)}
      </OriginFilterPanel>
      <section className="origin-list-main" id="main-content">
        <OriginToolbar filterOpen={panels.filters} onToggleFilter={() => persistPanels({ ...panels, filters: !panels.filters })} searchValue={search} searchPlaceholder={module.searchPlaceholder || 'Pesquisar'} onSearchChange={setSearch} onSearch={() => update({ q: search.trim() })}
          period={module.dateField ? <PeriodPicker from={params.get('from') || ''} to={params.get('to') || ''} today={DEMO_REFERENCE_DATE} dateType={dateType} dateTypes={dateTypes} prefixLabel={module.periodPrefix} onApply={range => update({ from: range.from, to: range.to, dt: range.dateType && range.dateType !== dateTypes?.[0] ? range.dateType : '' })} /> : undefined}
          tools={<><ToolButton icon="print" title={`Imprimir listagem de ${module.title.toLowerCase()}`} onClick={() => window.print()} />{!module.readOnly && <ToolButton icon="trash-can" title="Excluir selecionados" disabled={!selected.size} onClick={() => notify('A exclusão não está disponível na demonstração.')} />}</>} />
        <AppliedChips chips={chips} onClear={() => { setSearch(''); const next: Record<string, string> = { q: '', from: '', to: '', dt: '' }; for (const [key] of params) if (key.startsWith('filter.')) next[key] = ''; for (const key of Object.keys(module.defaultFilters || {})) next[`filter.${key}`] = '*'; update(next); }} />
        {module.listTabs && <nav className="origin-list-tabs" role="tablist" aria-label="Tipos">{module.listTabs.options.map(option => <button type="button" role="tab" key={option} aria-selected={tabsValue === option} onClick={() => update({ [`tab.${module.listTabs!.key}`]: option === module.listTabs!.options[0] ? '' : option })}>{option}</button>)}</nav>}
        <ListControls checked={allSelected} indeterminate={!allSelected && someSelected} onToggleAll={togglePage} onRefresh={() => notify('Listagem atualizada.')}
          selections={module.selections?.map(label => ({ label, onSelect: () => setSelected(label === 'Nenhum' ? new Set() : label === 'Todos' ? new Set(ids) : new Set(paged.filter(row => normalized(row.productType).startsWith(normalized(label).slice(0, 6))).map(row => row.id))) }))}
          views={<ViewToggle active={view} onChange={setView} />} />
        {view === 'customizada' && <div className="origin-columns-chooser" aria-label="Colunas visíveis">{module.columns.map(column => <label key={column.key}><input type="checkbox" checked={visibleKeys.includes(column.key)} disabled={visibleKeys.length === 1 && visibleKeys.includes(column.key)} onChange={() => { const next = visibleKeys.includes(column.key) ? visibleKeys.filter(key => key !== column.key) : [...visibleKeys, column.key]; setVisibleKeys(next); try { localStorage.setItem(`brufap.erp.demo.columns.${module.id}`, JSON.stringify(next)); } catch { /* Visit only. */ } }} />{column.label}</label>)}</div>}
        {awaitingProduct ? <div className="origin-empty"><span><Icon name="exclamation" size={22} /></span><h2>Informe um produto</h2><p>Para realizar a consulta de estoque você deve informar um produto.</p></div>
          : filtered.length === 0 ? <div className="origin-empty"><span><Icon name="exclamation" size={22} /></span><h2>Nenhum registro encontrado</h2><p>Altere a pesquisa ou os filtros para ver outros registros de demonstração.</p></div>
          : <div className="table-scroll"><table className="data-table origin-table"><thead><tr><th className="checkbox-cell"><span className="sr-only">Seleção</span></th>{columns.map(column => <th key={column.key} className={['money', 'number'].includes(column.type || '') ? 'numeric' : ''} aria-sort={params.get('sort') === column.key ? params.get('direction') === 'desc' ? 'descending' : 'ascending' : undefined}><button type="button" title={column.label} onClick={() => update({ sort: column.key, direction: params.get('sort') === column.key && params.get('direction') !== 'desc' ? 'desc' : 'asc' })}>{column.label}{params.get('sort') === column.key && <Icon name={params.get('direction') === 'desc' ? 'arrow-down' : 'arrow-up'} size={9} />}</button></th>)}{module.indicatorKey && <th><span className="sr-only">Indicadores</span></th>}<th className="row-actions"><span className="sr-only">Ações</span></th></tr></thead>
            <tbody>{paged.map(row => <tr key={row.id} className={selected.has(row.id) ? 'selected' : ''} onClick={event => openRow(row, event)} onAuxClick={event => { if (event.button === 1) openRow(row, event); }}>
              <td className="checkbox-cell" onClick={event => event.stopPropagation()}><input type="checkbox" aria-label={`Selecionar ${recordLabel(row)}`} checked={selected.has(row.id)} onClick={event => toggleRow(row.id, event.shiftKey)} onChange={() => undefined} /></td>
              {columns.map((column, index) => <td key={column.key} className={['money', 'number'].includes(column.type || '') ? 'numeric' : ''}>{column.type === 'status'
                ? module.situationStyle === 'dot' ? <span className="situation-cell"><span className={badgeClass(row[column.key]).replace('status-badge ', 'dot-status ')} title={String(row[column.key] || '')}><span className="sr-only">{display(row[column.key], column)}</span></span><span title="Visualizar ocorrências"><Icon name="clock" size={12} /></span></span>
                  : <span className="situation-cell"><span title="Visualizar ocorrências"><Icon name="clock" size={12} /></span><span className={badgeClass(row[column.key])}>{display(row[column.key], column)}</span></span>
                : index === 0 ? <Link className="record-link" to={href(row)} onClick={event => event.stopPropagation()}>{display(row[column.key], column)}</Link> : column.signed ? <span className={Number(row[column.key]) < 0 ? 'negative-value' : 'positive-value'}>{Number(row[column.key]) < 0 ? '- ' : ''}{display(Math.abs(Number(row[column.key])), column)}</span> : display(row[column.key], column)}</td>)}
              {module.indicatorKey && <td><Indicators value={row[module.indicatorKey]} /></td>}
              <td className="row-actions" onClick={event => event.stopPropagation()}>{module.rowMenu?.length ? <RowMenu label={recordLabel(row)} items={rowItems(row)} open={rowMenu === row.id} onToggle={() => setRowMenu(rowMenu === row.id ? null : row.id)} /> : null}</td>
            </tr>)}</tbody></table></div>}
        {filtered.length > 0 && <OriginPagination page={page} pages={pages} size={size} total={filtered.length} onPage={value => update({ page: value === 1 ? '' : String(value) }, false)} />}
      </section>
      <OriginActionsPanel collapsed={!panels.actions} onCollapse={() => persistPanels({ ...panels, actions: !panels.actions })}
        actions={(module.panelActions || []).map(action => ({ ...action, ...panelAction(action.label) }))}
        more={(module.moreActions || []).map(group => ({ title: group.title, items: group.items.map(label => ({ label, icon: 'circle', ...panelAction(label) })) }))}
        info={[{ label: counted, value: filtered.length.toLocaleString('pt-BR') }, ...(module.info?.total !== false && total !== null ? [{ label: 'Valor total', value: money(total).replace('R$', '').trim() }] : [])]}
        support={module.supportLinks}
        notice={<p className="origin-notice"><Icon name="circle-info" size={14} /><span>Demonstração com dados fictícios. Inclusões e alterações ficam apenas neste navegador; emissões, baixas e envios estão indisponíveis.</span></p>} />
    </div>
  </div>;
}

const ITEM_MODULES = new Set(['propostas', 'vendas', 'compras', 'ordens-servico']);

function FormPage({ module, recordId, notify, onConvert, drawer = false }: { module: ModuleDefinition; recordId?: string; notify: Notify; onConvert: (row: DemoRecord) => void; drawer?: boolean }) {
  const { records, save, persistent } = useDemoStore();
  const navigate = useNavigate();
  const original = recordId ? records[module.id]?.find(row => row.id === recordId) : undefined;
  const [values, setValues] = useState<DemoRecord>(() => original ? { ...original } : {
    id: newDemoId(), number: nextDemoNumber(records[module.id] || []),
    ...Object.fromEntries(module.fields.filter(field => field.type === 'date').map(field => [field.key, today()])),
    status: module.fields.find(field => field.key === 'status')?.options?.[0] || '',
  });
  const [items, setItems] = useState<DemoLineItem[]>(() => {
    try { const existing = JSON.parse(String(original?._items || 'null')); if (validDemoItems(existing)) return existing; } catch { /* Older fixtures have a single synthetic item. */ }
    return original && ITEM_MODULES.has(module.id) ? [{ id: newDemoId(), description: String(original.product || original.description || 'Item de demonstração'), quantity: Number(original.quantity || 1), unit: String(original.unit || 'UN'), unitPrice: Number(original.unitPrice ?? original.total ?? 0), discount: 0 }] : [];
  });
  const [activeTab, setActiveTab] = useState('dados');
  const listHref = moduleListHref(module.id);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') navigate(listHref); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [drawer, listHref]);
  if (recordId && !original) return <MissingPage />;
  const hasItems = ITEM_MODULES.has(module.id) && !module.readOnly;
  const fields = hasItems ? module.fields.filter(field => !['product', 'sku', 'quantity', 'unit', 'unitPrice', 'total'].includes(field.key)) : module.fields;
  const afterItemSections = new Set(['Outros itens', 'Totais', 'Pagamento', 'Entrega', 'Endereço de entrega', 'Observações', 'Observações internas', 'Condições gerais', 'Condições comerciais', 'Transporte', 'Transportador', 'Assinatura', 'Anexos']);
  const leadingFields = hasItems ? fields.filter(field => !afterItemSections.has(field.section || '')) : fields;
  const trailingFields = hasItems ? fields.filter(field => afterItemSections.has(field.section || '')) : [];
  const documentTotal = hasItems ? calculateDocumentTotal(items, values) : Number(values.total || 0);
  const update = (key: string, value: string | number) => setValues(previous => ({ ...previous, [key]: value }));
  const persist = (settle: boolean) => {
    if (module.readOnly) return;
    const error = validateDemoForm(fields, values, hasItems ? items : undefined);
    if (error) { notify(error); return; }
    const settled = settle ? { status: module.id === 'contas-pagar' ? 'Pago' : 'Recebido', balance: 0 } : {};
    save(module.id, { ...values, ...settled, ...(hasItems ? { total: documentTotal, _items: JSON.stringify(items) } : {}) });
    notify(persistent ? 'Demonstração salva neste navegador.' : 'Demonstração salva nesta sessão.');
    navigate(listHref);
  };
  const submit = (event: FormEvent) => { event.preventDefault(); persist(false); };
  const name = module.formTitle || module.title;
  const title = recordId ? `${name}${values.number ? ` - ${values.number}` : values.name ? ` - ${values.name}` : ''}` : name;
  const status = <span className={badgeClass(values.status || 'Rascunho')}>{String(values.status || 'Rascunho')}</span>;
  const sections = <>
    <RecordFields fields={leadingFields} values={values} onChange={update} readOnly={module.readOnly} />
    {hasItems && <LineItemsEditor items={items} onChange={setItems} products={(records.produtos || []).map(row => String(row.name || row.description || row.code || '')).filter(Boolean)} />}
    {hasItems && <><RecordFields fields={trailingFields} values={values} onChange={update} /><section className="form-section"><div className="document-total"><span>Total do documento</span><strong>{money(documentTotal)}</strong></div></section></>}
    {!fields.some(field => field.key === 'notes') && <section className="form-section"><h2>Observações</h2><div className="form-field full-width"><label htmlFor="record-notes">Observações do registro</label><textarea id="record-notes" rows={3} value={String(values.notes || '')} onChange={event => update('notes', event.target.value)} disabled={module.readOnly} /></div></section>}
  </>;
  if (drawer) return <><button type="button" className="origin-slidein-backdrop" aria-label="Fechar" onClick={() => navigate(listHref)} />
    <aside className="origin-slidein" role="dialog" aria-label={title}><form onSubmit={submit}>
      <header className="origin-slidein-header"><h1>{name}</h1>{recordId && status}<Link className="origin-slidein-close" to={listHref} aria-label="Fechar"><Icon name="xmark" size={16} /></Link></header>
      <div className="origin-slidein-body"><p className="origin-notice"><Icon name="circle-info" size={14} /><span>Formulário de demonstração. Não informe dados reais.</span></p>{sections}</div>
      <footer className="origin-slidein-footer"><Link className="text-button" to={listHref}>Cancelar</Link>{!module.readOnly && <><button type="button" className="secondary-button" onClick={() => persist(true)}>Salvar e dar baixa</button><button type="submit" className="primary-button">Salvar</button></>}</footer>
    </form></aside></>;
  return <main className="origin-form-page" id="main-content"><form onSubmit={submit}>
    <header className="origin-form-header"><div className="origin-form-title"><h1>{title}</h1>{recordId && status}</div>
      <div className="origin-form-buttons"><Link className="secondary-button" to={listHref}>{module.readOnly ? 'Voltar' : 'Cancelar'}</Link>{!module.readOnly && <button type="submit" className="primary-button">Salvar</button>}</div>
      {!module.readOnly && <p className="origin-required"><span>(*)</span> Campos obrigatórios</p>}</header>
    <p className="origin-notice"><Icon name="circle-info" size={14} /><span>Formulário de demonstração. Não informe dados reais. Salvar altera somente esta prévia.</span></p>
    <div className="origin-form-tabs" role="tablist" aria-label="Seções do registro"><button type="button" role="tab" aria-selected={activeTab === 'dados'} onClick={() => setActiveTab('dados')}>Dados do registro</button><button type="button" role="tab" aria-selected={activeTab === 'historico'} onClick={() => setActiveTab('historico')}>Vínculos e histórico</button></div>
    {activeTab === 'dados' ? <>{sections}{module.id === 'propostas' && original && <div className="form-actions"><button type="button" className="secondary-button" onClick={() => { const error = validateDemoForm(fields, values, hasItems ? items : undefined); if (error) { notify(error); return; } onConvert({ ...values, ...(hasItems ? { total: documentTotal, _items: JSON.stringify(items) } : {}) }); }}>Gerar venda</button></div>}</>
      : <section className="form-section"><h2>Documentos relacionados</h2>{values.originModule && values.originId ? <Link className="related-link" to={`/${String(values.originModule)}/${encodeURIComponent(String(values.originId))}`}>{String(values.originLabel || 'Documento de origem')}<Icon name="arrow" size={16} /></Link> : <p className="muted">Nenhum documento de origem nesta demonstração.</p>}{module.id === 'propostas' && (records.vendas || []).filter(row => row.originId === values.id && row.originModule === 'propostas').map(order => <Link className="related-link" key={order.id} to={`/vendas/${order.id}`}>Pedido {order.number} · demonstração<Icon name="arrow" size={16} /></Link>)}<h2>Efeitos da operação</h2><div className="summary-grid"><div className="summary-card"><span>Estoque</span><strong>Não movimentado</strong></div><div className="summary-card"><span>Contas</span><strong>Não lançadas</strong></div><div className="summary-card"><span>Fiscal</span><strong>Não emitido</strong></div></div><p className="muted">Esta prévia não executa operações financeiras, bancárias ou fiscais.</p></section>}
  </form></main>;
}

function ModuleRoute({ edit = false, create = false, notify, onConvert }: { edit?: boolean; create?: boolean; notify: Notify; onConvert: (row: DemoRecord) => void }) {
  const { moduleId, recordId } = useParams();
  const module = MODULES.find(value => value.id === moduleId);
  if (!module) return <MissingPage />;
  if (create && module.readOnly) return <Navigate to={moduleListHref(module.id)} replace />;
  if ((edit || create) && module.formStyle === 'drawer') return <><ListPage key={module.id} module={module} notify={notify} onConvert={onConvert} /><FormPage key={`${module.id}:${recordId || 'new'}`} module={module} recordId={recordId} notify={notify} onConvert={onConvert} drawer /></>;
  return edit || create ? <FormPage key={`${module.id}:${recordId || 'new'}`} module={module} recordId={recordId} notify={notify} onConvert={onConvert} /> : <ListPage key={module.id} module={module} notify={notify} onConvert={onConvert} />;
}

function MissingPage() {
  return <main className="empty-state" id="main-content"><h1>Registro não encontrado</h1><p>Escolha uma tela no menu para continuar conhecendo o FAGOO.</p><Link className="primary-button" to="/vendas">Ir para pedidos de venda</Link></main>;
}

function Overview({ onReset }: { onReset: () => void }) {
  const { records } = useDemoStore();
  const [tab, setTab] = useState('visao-geral');
  const sales = records.vendas || [];
  const count = (rows: DemoRecord[], status: string) => rows.filter(row => row.status === status).length;
  const open = (rows: DemoRecord[]) => rows.filter(row => Number(row.balance) > 0);
  const sum = (rows: DemoRecord[]) => money(rows.reduce((total, row) => total + Math.round(Number(row.balance || 0) * 100), 0) / 100);
  const receivable = open(records['contas-receber'] || []), payable = open(records['contas-pagar'] || []);
  const cards = [
    { title: 'Pedidos de venda', to: moduleListHref('vendas'), lines: [{ label: 'Total de vendas', value: String(sales.length), dot: 'gray' as const }, { label: 'Novos', value: String(count(sales, 'Em aberto')), dot: 'green' as const }, { label: 'Em andamento', value: String(count(sales, 'Em andamento')), dot: 'blue' as const }, { label: 'Cancelados', value: String(count(sales, 'Cancelado')), dot: 'red' as const }] },
    { title: 'Contas a receber', to: moduleListHref('contas-receber'), count: String(receivable.length), arrow: 'down' as const, lines: [{ label: 'Total', value: sum(receivable) }, { label: 'Taxas', value: money(0), muted: true }], footer: { label: 'Líquido', value: sum(receivable) } },
    { title: 'Contas a pagar', to: moduleListHref('contas-pagar'), count: String(payable.length), arrow: 'up' as const, lines: [{ label: 'Valor total a pagar', value: sum(payable) }] },
    { title: 'Notas Fiscais', to: moduleListHref('notas-saida'), lines: [{ label: 'Novas NF-es', value: String(count(records['notas-saida'] || [], 'Pendente')), dot: 'green' as const }] },
  ];
  return <main className="origin-home" id="main-content">
    <FavoritesPanel user="Demonstração" detail="Empresa de demonstração" groups={DEMO_GROUPS} storageKey="brufap.erp.demo.favorites" defaults={[{ label: 'Pedidos de venda', to: '/vendas' }, { label: 'Notas fiscais', to: '/notas-saida' }, { label: 'Listagem de produtos', to: '/produtos' }, { label: 'Clientes e fornecedores', to: '/contatos' }]} />
    <div className="origin-home-main">
      <div className="origin-alert"><Icon name="circle-info" size={20} /><div><strong>Você está na demonstração do layout</strong><p>Todos os nomes, valores e documentos são fictícios. Conheça as telas e os fluxos do FAGOO neste ambiente de demonstração.</p></div></div>
      <HomeTabs tabs={[{ id: 'visao-geral', label: 'Visão geral', icon: 'house' }, { id: 'eventos', label: 'Eventos', icon: 'calendar' }]} active={tab} onChange={setTab} />
      {tab === 'visao-geral' ? <DailySummary cards={cards} updatedAt={`Referência ${DEMO_REFERENCE_DATE.split('-').reverse().join('/')}`} /> : <div className="origin-empty"><span><Icon name="calendar" size={20} /></span><h2>Nenhum evento</h2><p>Os eventos da operação aparecerão aqui.</p></div>}
      <p className="muted">Todos os dados desta prévia são fictícios. <button type="button" className="text-button" onClick={onReset}>Restaurar dados de demonstração</button></p>
    </div>
  </main>;
}

function DemoApp() {
  const { records, save, reset, persistent } = useDemoStore();
  const navigate = useNavigate();
  const { theme, toggle: toggleTheme } = useTheme();
  const fullScreen = useLocation().pathname === '/frente-caixa';
  const [message, setMessage] = useState('');
  const [conversion, setConversion] = useState<DemoRecord | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  useEffect(() => { if (!message) return; const timeout = setTimeout(() => setMessage(''), 5500); return () => clearTimeout(timeout); }, [message]);
  const convert = () => {
    if (!conversion) return;
    let result;
    try { result = proposalToOrder(conversion, records.vendas || [], newDemoId(), today()); }
    catch { setMessage('Confira o total da proposta antes de gerar o pedido.'); setConversion(null); return; }
    const { record, created } = result;
    if (created) { save('propostas', conversion); save('vendas', record); }
    setConversion(null); setMessage(created ? 'Pedido de demonstração criado. Nenhum estoque ou conta foi movimentado.' : 'Esta proposta já possui um pedido de demonstração.');
    navigate(`/vendas/${record.id}`);
  };
  return <div className="app-shell"><a className="skip-link" href="#main-content">Ir para o conteúdo</a>{!fullScreen && <Navigation theme={theme} onTheme={toggleTheme} />}{!fullScreen && <div className="preview-banner"><span className="preview-dot" /><span>Prévia de layout · dados de demonstração</span>{!persistent && <span> · alterações apenas nesta sessão</span>}</div>}
    <Routes><Route path="/" element={<Navigate to="/vendas" replace />} /><Route path="/inicio" element={<Overview onReset={() => setResetOpen(true)} />} /><Route path="/configuracoes" element={<PreferencesPage categories={DEMO_PREFERENCES} homeTo="/inicio" />} /><Route path="/frente-caixa" element={<DemoPdv notify={setMessage} />} /><Route path="/relatorios" element={<ReportsCatalog />} /><Route path="/:moduleId" element={<ModuleRoute notify={setMessage} onConvert={setConversion} />} /><Route path="/:moduleId/novo" element={<ModuleRoute create notify={setMessage} onConvert={setConversion} />} /><Route path="/:moduleId/:recordId" element={<ModuleRoute edit notify={setMessage} onConvert={setConversion} />} /><Route path="*" element={<MissingPage />} /></Routes>
    {message && <div className="toast" role="status" aria-live="polite"><Icon name="check" /><span>{message}</span><button className="icon-button" aria-label="Fechar mensagem" onClick={() => setMessage('')}><Icon name="close" size={16} /></button></div>}
    {conversion && <Modal title="Gerar pedido de demonstração" onClose={() => setConversion(null)} actions={<><button className="secondary-button" onClick={() => setConversion(null)}>Cancelar</button><button className="primary-button" onClick={convert}>Gerar pedido</button></>}><p>A proposta <strong>{String(conversion.number || '')}</strong> de <strong>{String(conversion.customer || 'cliente de demonstração')}</strong> será vinculada a um pedido neste navegador.</p><div className="document-total"><span>Total da proposta</span><strong>{money(conversion.total)}</strong></div><p className="muted">Essa ação não emite nota, não lança contas e não movimenta estoque. Se o pedido já existir, ele será aberto.</p></Modal>}
    {resetOpen && <Modal title="Restaurar demonstração" onClose={() => setResetOpen(false)} actions={<><button className="secondary-button" onClick={() => setResetOpen(false)}>Cancelar</button><button className="primary-button" onClick={() => { reset(); setResetOpen(false); setMessage('Dados fictícios restaurados.'); navigate('/inicio'); }}>Restaurar</button></>}><p>As inclusões e alterações desta demonstração serão substituídas pelos exemplos iniciais. Nenhum dado real da empresa é afetado.</p></Modal>}
  </div>;
}

export default function App() {
  const { pathname } = useLocation();
  if (pathname === '/') return <Navigate to="/acesso" replace />;
  return ['/acesso', '/preferencias', '/dados-origin', '/cadastros-reais', '/historico-fiscal', '/documentos-empresa', '/estoque-empresa', '/financeiro-empresa', '/importar-cadastros', '/importar-orcamentos', '/conferir-compras-origin', '/conferir-vendas-origin', '/historico-vendas-origin', '/cobrancas-legadas-itau', '/cobranca-empresa', '/cobranca-operacional', '/retornos-operacionais', '/notas-recebidas', '/numeracao-fiscal', '/certificado-a1', '/conexao-sefaz', '/empresa-configuracoes','/preparacao-virada/depositos/estoque','/preparacao-virada/depositos','/preparacao-virada','/estoque-abertura','/emissor-fiscal','/relatorio-vencimentos','/xmls-sincronizados','/integracao-origin','/painel-produtos-empresa','/conferencia-estoque-empresa','/checkin-recebimentos','/relatorios-estoque',
    '/notas-entrada','/naturezas-operacao','/inutilizacoes-nfe','/cartas-correcao',
    '/categorias-produtos','/grupos-produtos','/tags','/grupos-tags','/exportacao-produtos','/listas-precos','/campos-customizados',
    '/tipos-contatos-empresa','/vendedores-empresa','/formas-pagamento-empresa','/funcionarios-empresa','/importar-contatos','/numeracao-contatos',
    '/meu-negocio','/frente-caixa-empresa'].includes(pathname) || pathname.startsWith('/preferencias/') || pathname === '/ajuda' || pathname.startsWith('/ajuda/')
    ? <NativeModuleBoundary resetKey="company-access" label="Carregando acesso…"><RealAccess /></NativeModuleBoundary>
    : <DemoApp />;
}
