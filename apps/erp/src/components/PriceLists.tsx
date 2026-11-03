import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { AccessError, decimalMoney, type AccessController } from '../lib/real-access';
import type { CatalogAccess } from '../lib/catalog-model';
import { planBatch, summarizeBatch, batchSummaryText, type BatchResult, type BatchStep } from '../lib/origin-batch';
import { brDate as brIsoDate, type IsoDate } from '../lib/origin-list';
import { stockDate } from '../lib/stock-model';
import { CSV_TYPE, XLSX_TYPE, downloadFile, toCsv, toXlsx } from '../lib/spreadsheet-export';
import { CATEGORY, EMPTY, EXPORT_LIST_LIMIT, EXPORT_LIST_PAGE, SHEET_LIMIT, TYPE, decimalComma, draftOf, hours, listSheetRows, parsePriceListSheet, priceListData, sheetResultText, sheetTemplate, validity,
  type Draft, type ListCategory, type ListType, type PriceList, type PriceListItem, type SheetResult, type SheetRow } from '../lib/price-list-model';
import { normalizeUnitPrice } from '../../../../packages/erp-domain/src/unit-price.mjs';
import { BatchDialog } from './BatchDialog';
import { AppliedChips, PeriodPicker, RowMenu, ToolButton, type RowMenuItem } from './OriginList';
import { PriceListLinks, PriceListWizard } from './PriceListWizard';
import { PrintSheet } from './PrintSheet';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { aborted, errorText, knownFailure } from './catalog-shared';
import './product-registry.css';

// Cadastros > Listas de preços no padrão do Origin (migrações 121 e 154): abas Todas listas | Taxas | Por período | Customizada,
// busca pelo nome, filtro (Categoria e Produto), período "Cadastrada em", Imprimir, excluir e clonar, "Exportar dados para
// planilha" das listas selecionadas e o assistente "Lista de preços" na inclusão; Dados gerais com fator em % ou R$, acréscimo
// ou desconto, validade e vínculos (contatos, vendedores e formas de pagamento até 30 cada, UFs); os produtos da lista com
// carga incremental de 100 em 100, o preço de venda e o preço da lista (customizada: preço por produto e reajuste em massa).
// Cada gravação é um comando com versão esperada e "Conferir resultado".
export type { PriceList } from '../lib/price-list-model';
export { priceListData } from '../lib/price-list-model';
const TABS: { value: '' | ListType; label: string }[] = [{ value: '', label: 'Todas listas' }, { value: 'rates', label: 'Taxas' }, { value: 'period', label: 'Por período' }, { value: 'custom', label: 'Customizada' }];
type Pending = { path: string; method: 'POST' | 'PATCH'; body: Record<string, unknown>; uncertain: boolean };
type Filters = { category: '' | ListCategory; product: { id: string; name: string } | null; from: IsoDate | ''; to: IsoDate | '' };
const NO_FILTERS: Filters = { category: '', product: null, from: '', to: '' };

/** Reads every product of the chosen lists (100 per request, up to 15.000 per list), for the spreadsheet. */
async function readListItems(controller: AccessController, list: PriceList, signal: AbortSignal, progress: (text: string) => void) {
  const items: PriceListItem[] = []; let total = Infinity;
  for (let offset = 0; offset < Math.min(total, EXPORT_LIST_LIMIT); offset += EXPORT_LIST_PAGE) {
    const value = await controller.catalog(`/v1/cadastros/listas-precos/${list.id}?${new URLSearchParams({ offset: String(offset), limit: String(EXPORT_LIST_PAGE) })}`, { signal }) as { list?: PriceList; items?: PriceListItem[]; total?: number };
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (value.list?.id !== list.id || !Array.isArray(value.items) || !Number.isSafeInteger(value.total)) throw new AccessError(502);
    total = value.total as number; items.push(...value.items); progress(`Lendo “${list.name}”: ${items.length} de ${Math.min(total, EXPORT_LIST_LIMIT)}`);
    if (!value.items.length) break;
  }
  return { list, items };
}
function ExportLists({ controller, lists, onClose }: { controller: AccessController; lists: PriceList[]; onClose: () => void }) {
  const [format, setFormat] = useState<'csv' | 'xlsx'>('csv'), [busy, setBusy] = useState(false), [progress, setProgress] = useState(''), [error, setError] = useState(''), [done, setDone] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const run = async () => {
    const signal = new AbortController(); request.current = signal; setBusy(true); setError(''); setDone(false);
    try {
      const entries = [];
      for (const list of lists) entries.push(await readListItems(controller, list, signal.signal, setProgress));
      const rows = listSheetRows(entries), name = `listas-precos-${stockDate()}`;
      if (format === 'csv') downloadFile(`${name}.csv`, toCsv(rows), CSV_TYPE); else downloadFile(`${name}.xlsx`, toXlsx('Listas de preços', rows) as unknown as BlobPart, XLSX_TYPE);
      setDone(true);
    } catch (failure) { if (!signal.signal.aborted && !aborted(failure)) setError(errorText(failure)); }
    finally { if (request.current === signal) { request.current = null; setBusy(false); setProgress(''); } }
  };
  return <Modal title="Exportar dados para planilha" onClose={() => { if (!busy) onClose(); }} actions={<><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Fechar</button><button type="button" className="primary-button" disabled={busy} onClick={() => void run()}>{busy ? 'Gerando…' : 'Exportar'}</button></>}>
    <p>{lists.length} lista(s) selecionada(s): {lists.map(list => list.name).join(', ')}. Cada linha da planilha é um produto da lista, com o preço de venda e o preço da lista.</p>
    <div className="form-field"><label htmlFor="price-list-export-format">Formato de arquivo</label><select id="price-list-export-format" value={format} disabled={busy} onChange={event => setFormat(event.target.value as 'csv' | 'xlsx')}><option value="csv">CSV</option><option value="xlsx">XLS</option></select>
      <small className="real-help">XLS gera uma planilha do Excel (.xlsx); CSV usa ponto e vírgula.</small></div>
    {progress && <p role="status">{progress}</p>}{done && <p className="real-success" role="status">Planilha gerada.</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}
  </Modal>;
}

export default function PriceLists({ controller }: { controller: AccessController }) {
  const location = useLocation();
  const [tab, setTab] = useState<'' | ListType>(''), [query, setQuery] = useState(''), [draftQuery, setDraftQuery] = useState('');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS), [filterDraft, setFilterDraft] = useState<Filters>(NO_FILTERS), [filterOpen, setFilterOpen] = useState(false);
  const [productSearch, setProductSearch] = useState<{ query: string; options: { id: string; name: string; code: string | null }[] }>({ query: '', options: [] });
  const [lists, setLists] = useState<PriceList[] | null>(null), [writable, setWritable] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set()), [menu, setMenu] = useState<string | null>(null), [batch, setBatch] = useState<PriceList[] | null>(null);
  const [open, setOpen] = useState<{ id: string } | null>(null), [wizard, setWizard] = useState(() => new URLSearchParams(location.search).get('nova') === '1');
  const [printing, setPrinting] = useState(false), [exporting, setExporting] = useState<PriceList[] | null>(null);
  const request = useRef<AbortController | null>(null), batchRequest = useRef<AbortController | null>(null), cloneRequest = useRef<AbortController | null>(null), actor = useRef<string | undefined>(undefined);
  useEffect(() => () => { request.current?.abort(); batchRequest.current?.abort(); cloneRequest.current?.abort(); }, []);
  useEffect(() => {
    const signal = new AbortController(); request.current?.abort(); request.current = signal; setError('');
    void (async () => {
      try {
        const access = await controller.catalog('/v1/cadastros', { signal: signal.signal }) as CatalogAccess;
        if (signal.signal.aborted) return;
        if (!Array.isArray(access?.read) || !access.read.includes('products')) { setLists([]); setError('Seu perfil não permite consultar as listas de preços.'); return; }
        setWritable(Array.isArray(access.write) && access.write.includes('products'));
        const params = new URLSearchParams(Object.entries({ tipo: tab, q: query, categoria: filters.category, produto: filters.product?.id ?? '', from: filters.from, to: filters.to }).filter(([, value]) => value));
        const value = await controller.catalog(`/v1/cadastros/listas-precos${params.size ? `?${params}` : ''}`, { signal: signal.signal }) as { items?: PriceList[] };
        if (signal.signal.aborted) return;
        if (!Array.isArray(value.items)) throw new AccessError(502);
        setLists(value.items); setSelected(new Set());
      } catch (failure) { if (!signal.signal.aborted && !aborted(failure)) { setLists(current => current ?? []); setError(errorText(failure)); } }
    })();
    return () => signal.abort();
  }, [controller, tab, query, filters, reload]);
  // Produto (filtro): products searched as in the documents' picker.
  useEffect(() => {
    const text = productSearch.query.trim();
    if (!text || filterDraft.product) return;
    const signal = new AbortController();
    const timer = setTimeout(() => void Promise.resolve().then(() => controller.catalog(`/v1/cadastros/products?${new URLSearchParams({ limit: '10', q: text })}`, { signal: signal.signal })).then(value => {
      const found = (value as { items?: { id: string; name: string; code?: string | null }[] }).items;
      if (!signal.signal.aborted && Array.isArray(found)) setProductSearch(current => current.query.trim() === text ? { ...current, options: found.map(item => ({ id: item.id, name: item.name, code: item.code ?? null })) } : current);
    }).catch(() => undefined), 250);
    return () => { clearTimeout(timer); signal.abort(); };
  }, [controller, productSearch.query, filterDraft.product]);
  const startDelete = (items: PriceList[]) => { setMenu(null); if (!writable || !items.length) return; actor.current = controller.getSnapshot().membership?.user_id; batchRequest.current = new AbortController(); setBatch(items); };
  const plan = batch ? planBatch(batch.map(item => ({ ...item, label: item.name })), () => null) : null;
  const runDelete = async (item: PriceList & { label: string }): Promise<BatchStep> => {
    const snapshot = controller.getSnapshot(), signal = batchRequest.current?.signal;
    if (!signal || signal.aborted || snapshot.phase !== 'ready' || snapshot.membership?.user_id !== actor.current) throw new Error('A sessão mudou durante a operação. Esta lista não foi enviada.');
    const body = { command_id: crypto.randomUUID(), expected_version: item.version };
    const send = () => controller.catalog(`/v1/cadastros/listas-precos/${item.id}/excluir`, { method: 'POST', body, signal });
    try { await send(); return; } catch (failure) {
      if (!aborted(failure) && knownFailure(failure)) throw new Error((failure as AccessError).status === 409 ? 'A lista foi alterada por outra operação. Atualize e tente de novo.' : errorText(failure));
      try { if (!signal.aborted) { await send(); return { message: 'Confirmado ao repetir a mesma operação.' }; } } catch { /* Still unknown. */ }
      return { uncertain: true, message: 'Não foi possível confirmar o resultado. Atualize a listagem antes de repetir.' };
    }
  };
  const closeBatch = (results: BatchResult[] | null) => { setBatch(null); batchRequest.current = null; if (results) { setNotice(`Exclusão: ${batchSummaryText(summarizeBatch(results))}.`); setReload(value => value + 1); } };
  // One clone at a time, for the user who asked: a second click would only report the copy's name as taken.
  const cloning = useRef(false);
  const clone = async (list: PriceList) => {
    setMenu(null); if (!writable || cloning.current) return;
    const owner = controller.getSnapshot().membership?.user_id, body = { command_id: crypto.randomUUID(), name: `${list.name} (cópia)`.slice(0, 120) };
    const signal = new AbortController(); cloneRequest.current = signal; cloning.current = true; setError(''); setNotice('');
    try {
      const result = await controller.catalog(`/v1/cadastros/listas-precos/${list.id}/clonar`, { method: 'POST', body, signal: signal.signal }) as { saved?: boolean; reason?: string };
      if (signal.signal.aborted || controller.getSnapshot().membership?.user_id !== owner) return;
      setNotice(result.saved ? 'Lista clonada.' : result.reason === 'too_many_products' ? 'A lista tem mais de 15.000 produtos e não pode ser clonada.' : 'Já existe uma lista com o nome da cópia.'); setReload(value => value + 1);
    } catch (failure) { if (!signal.signal.aborted) setError(aborted(failure) ? '' : knownFailure(failure) ? errorText(failure) : 'Não foi possível confirmar a cópia. Atualize a listagem antes de clonar de novo.'); }
    finally { cloning.current = false; if (cloneRequest.current === signal) cloneRequest.current = null; }
  };
  if (open) return <PriceListEditor key={open.id} controller={controller} id={open.id} writable={writable} onClose={text => { setOpen(null); setReload(value => value + 1); if (text) setNotice(text); }} />;
  const rows = lists ?? [], allSelected = rows.length > 0 && rows.every(item => selected.has(item.id));
  const rowMenu = (list: PriceList): RowMenuItem[] => [{ label: writable ? 'Editar' : 'Visualizar', icon: writable ? 'pen-to-square' : 'eye', onClick: () => { setMenu(null); setOpen({ id: list.id }); } },
    ...(writable ? [{ label: 'Clonar lista', icon: 'clone', onClick: () => void clone(list) }, { label: 'Excluir', icon: 'trash-can', separatorBefore: true, onClick: () => startDelete([list]) }] : [])];
  const applyFilters = () => { setFilters(filterDraft); setFilterOpen(false); };
  const clearFilters = () => { setFilters(NO_FILTERS); setFilterDraft(NO_FILTERS); setQuery(''); setDraftQuery(''); setProductSearch({ query: '', options: [] }); };
  const periodText = filters.from || filters.to ? `Cadastrada em: ${filters.from ? brIsoDate(filters.from) : '…'} a ${filters.to ? brIsoDate(filters.to) : '…'}` : '';
  const chips = [
    ...(query ? [{ label: `Nome da lista: ${query}`, onRemove: () => { setQuery(''); setDraftQuery(''); } }] : []),
    ...(filters.category ? [{ label: `Categoria: ${CATEGORY[filters.category]}`, onRemove: () => { setFilters(current => ({ ...current, category: '' })); setFilterDraft(current => ({ ...current, category: '' })); } }] : []),
    ...(filters.product ? [{ label: `Produto: ${filters.product.name}`, onRemove: () => { setFilters(current => ({ ...current, product: null })); setFilterDraft(current => ({ ...current, product: null })); setProductSearch({ query: '', options: [] }); } }] : []),
    ...(periodText ? [{ label: periodText, onRemove: () => setFilters(current => ({ ...current, from: '', to: '' })) }] : []),
  ];
  const printRows = rows.map(list => ({ name: list.name, products: String(list.products), rule: list.rule, validity: validity(list), hours: hours(list), category: CATEGORY[list.category] }));
  return <section className="real-section" aria-labelledby="price-lists-title">
    <header className="real-heading catalog-heading"><div className="catalog-title"><h1 id="price-lists-title">Listas de preços</h1></div><div className="catalog-heading-actions">{!writable && lists && <span className="real-mode">Somente consulta</span>}{writable && <button type="button" className="primary-button" onClick={() => setWizard(true)}><Icon name="plus" size={12} />Incluir lista</button>}</div></header>
    {notice && <p className="real-success" role="status">{notice}</p>}
    {error && <p className="real-alert" role="alert">{error}<button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>Tentar novamente</button></p>}
    <div className="product-tabs" role="tablist" aria-label="Tipo de lista">{TABS.map(item => <button key={item.value} type="button" role="tab" aria-selected={tab === item.value} onClick={() => setTab(item.value)}>{item.label}</button>)}</div>
    <form className="native-list-toolbar" onSubmit={(event: FormEvent) => { event.preventDefault(); setQuery(draftQuery.trim()); }}>
      <button type="button" className="secondary-button" title="Abrir filtro" aria-label="Abrir filtro" aria-expanded={filterOpen} onClick={() => { setFilterDraft(filters); setFilterOpen(!filterOpen); }}><Icon name="filter" size={13} /></button>
      <div className="form-field"><label htmlFor="price-list-search">Nome da lista</label><input id="price-list-search" type="search" maxLength={120} value={draftQuery} placeholder="Nome da lista" onChange={event => setDraftQuery(event.target.value)} /></div>
      <button type="submit" className="secondary-button" aria-label="Pesquisar" title="Pesquisar"><Icon name="magnifying-glass" size={13} /></button>
      <PeriodPicker from={filters.from} to={filters.to} today={stockDate()} onApply={range => setFilters(current => ({ ...current, from: range.from, to: range.to }))} />
      <ToolButton icon="print" title="Imprimir" disabled={!rows.length} onClick={() => setPrinting(true)} />
      {writable && <button type="button" className={`secondary-button${selected.size ? ' is-danger' : ''}`} title="Excluir selecionadas" aria-label="Excluir selecionadas" disabled={!selected.size} onClick={() => startDelete(rows.filter(item => selected.has(item.id)))}><Icon name="trash-can" size={13} /></button>}
    </form>
    {filterOpen && <div className="real-editor-fields price-list-filters" role="region" aria-label="Filtros">
      <div className="form-field"><label htmlFor="price-list-category">Categoria</label><select id="price-list-category" value={filterDraft.category} onChange={event => setFilterDraft(current => ({ ...current, category: event.target.value as Filters['category'] }))}><option value="">Todas</option>{Object.entries(CATEGORY).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      <div className="form-field"><label htmlFor="price-list-product-filter">Produto</label><input id="price-list-product-filter" value={filterDraft.product ? filterDraft.product.name : productSearch.query} maxLength={120} autoComplete="off" placeholder="Digite o nome ou código"
        onChange={event => { setFilterDraft(current => ({ ...current, product: null })); setProductSearch({ query: event.target.value, options: [] }); }} />
        {!filterDraft.product && productSearch.options.length > 0 && <ul className="product-options" role="listbox" aria-label="Produtos encontrados">{productSearch.options.map(option => <li key={option.id}><button type="button" role="option" aria-selected={false} onClick={() => { setFilterDraft(current => ({ ...current, product: { id: option.id, name: option.name } })); setProductSearch({ query: option.name, options: [] }); }}>{option.name}{option.code ? ` (${option.code})` : ''}</button></li>)}</ul>}</div>
      <div className="real-editor-actions"><button type="button" className="primary-button" onClick={applyFilters}>Filtrar</button><button type="button" className="secondary-button" onClick={clearFilters}>Limpar filtros</button><button type="button" className="text-button" onClick={() => setFilterOpen(false)}>Minimizar filtros</button></div></div>}
    <AppliedChips chips={chips} onClear={clearFilters} />
    <div className="native-list-summary"><dl className="native-list-stat"><dt>Quantidade de registros</dt><dd>{lists ? rows.length : '—'}</dd></dl>
      <button type="button" className="action-button" disabled={!selected.size} title={selected.size ? undefined : 'Selecione as listas'} onClick={() => setExporting(rows.filter(item => selected.has(item.id)))}><Icon name="file-export" size={14} />Exportar dados para planilha</button></div>
    {lists === null ? <p role="status">Carregando…</p> : <div className="table-scroll" tabIndex={0} role="region" aria-label="Listas de preços"><table className="data-table real-table origin-table"><thead><tr>
      <th scope="col" className="checkbox-cell"><input type="checkbox" aria-label="Selecionar todas" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map(item => item.id)))} /></th>
      <th scope="col">Nome da lista</th><th scope="col" className="numeric">Quantidade de produtos</th><th scope="col">Regra da lista</th><th scope="col">Data de validade</th><th scope="col">Horário vigência</th><th scope="col" className="row-actions"><span className="real-sr-only">Ações</span></th></tr></thead>
      <tbody>{rows.map(list => <tr key={list.id}>
        <td className="checkbox-cell"><input type="checkbox" aria-label={`Selecionar ${list.name}`} checked={selected.has(list.id)} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(list.id); else next.delete(list.id); return next; })} /></td>
        <td><button type="button" className="text-button record-link" onClick={() => setOpen({ id: list.id })}>{list.name}</button></td><td className="numeric">{list.products}</td><td>{list.rule}</td><td>{validity(list)}</td><td>{hours(list)}</td>
        <td className="row-actions"><RowMenu label={list.name} items={rowMenu(list)} open={menu === list.id} onToggle={() => setMenu(menu === list.id ? null : list.id)} /></td></tr>)}</tbody></table>
      {!rows.length && <div className="origin-empty"><span><Icon name="exclamation" size={22} /></span><h2>{query || tab || chips.length ? 'Nenhum resultado encontrado.' : 'Nenhuma lista de preços cadastrada.'}</h2><p>{query ? 'Verifique se as palavras estão corretas ou busque por outros termos.' : ''}</p></div>}</div>}
    <p className="real-help">A categoria Loja não existe no FAGOO. Nos pedidos de venda e nas propostas, a lista de preço é escolhida no próprio documento. <Link to="/cadastros-reais?cadastro=products">Voltar aos produtos</Link></p>
    {batch && plan && <BatchDialog title="Excluir selecionadas" plan={plan} confirmLabel="Excluir" run={runDelete} onClose={closeBatch} description={<p>A exclusão da lista não altera o preço de venda dos produtos.</p>} />}
    {wizard && <PriceListWizard controller={controller} onClose={() => setWizard(false)} onSaved={list => { setWizard(false); setNotice('Lista salva.'); setOpen({ id: list.id }); }} />}
    {exporting && <ExportLists controller={controller} lists={exporting} onClose={() => setExporting(null)} />}
    {printing && <PrintSheet title="Listas de preços" subtitle="As listas da aba e dos filtros aplicados." filters={[TABS.find(item => item.value === tab)?.label, ...chips.map(chip => chip.label)].filter(Boolean).join(' · ')}
      columns={[{ key: 'name', label: 'Nome da lista' }, { key: 'category', label: 'Categoria' }, { key: 'products', label: 'Quantidade de produtos', numeric: true }, { key: 'rule', label: 'Regra da lista' }, { key: 'validity', label: 'Data de validade' }, { key: 'hours', label: 'Horário vigência' }]}
      rows={printRows} onClose={() => setPrinting(false)} />}
  </section>;
}

// Detalhe da lista (Origin): "Imprimir" com todos os produtos da lista (lidos de 100 em 100) e o resumo Tipo Lista | Baseado em | Fator.
function PriceListPrint({ controller, list, onClose }: { controller: AccessController; list: PriceList; onClose: () => void }) {
  const [rows, setRows] = useState<Record<string, string>[] | null>(null), [progress, setProgress] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    const signal = new AbortController();
    void readListItems(controller, list, signal.signal, setProgress).then(({ items }) => {
      if (signal.signal.aborted) return;
      setRows(items.map(item => ({ name: item.name, code: item.code ?? '—', gtin: item.gtin ?? '—', product_price: decimalMoney(item.product_price), factor: list.rule, list_price: decimalMoney(item.list_price) }))); setProgress('');
    }).catch(failure => { if (!signal.signal.aborted && !aborted(failure)) { setError(errorText(failure)); setProgress(''); } });
    return () => signal.abort();
  }, [controller, list.id, list.version]);
  const custom = list.list_type === 'custom';
  return <PrintSheet title={list.name} subtitle={`Tipo Lista: ${TYPE[list.list_type]} · Baseado em: Preço de venda · Fator a ser aplicado: ${list.rule}${list.starts_on || list.ends_on ? ` · Validade: ${validity(list)}` : ''}${hours(list) !== '—' ? ` · Horário: ${hours(list)}` : ''}`}
    columns={[{ key: 'name', label: 'Produto' }, { key: 'code', label: 'SKU' }, { key: 'gtin', label: 'EAN' }, { key: 'product_price', label: 'R$ Preço no FAGOO', numeric: true }, ...(custom ? [] : [{ key: 'factor', label: 'Fator' }]), { key: 'list_price', label: 'R$ Preço da lista', numeric: true }]}
    rows={rows} progress={progress} error={error} onClose={onClose} />;
}
type CommandState = { command: string; busy: boolean; uncertain: boolean; error: string };
const freshCommand = (): CommandState => ({ command: crypto.randomUUID(), busy: false, uncertain: false, error: '' });

function PriceListEditor({ controller, id, writable, onClose }: { controller: AccessController; id: string; writable: boolean; onClose: (notice?: string) => void }) {
  const [list, setList] = useState<PriceList | null>(null), [draft, setDraft] = useState<Draft>(EMPTY), [baseline, setBaseline] = useState<string>(JSON.stringify(EMPTY));
  const [items, setItems] = useState<PriceListItem[]>([]), [total, setTotal] = useState(0), [itemQuery, setItemQuery] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [pending, setPending] = useState<Pending | null>(null), [busy, setBusy] = useState(false), [reload, setReload] = useState(0), [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [prices, setPrices] = useState<Record<string, string>>({}), [adjust, setAdjust] = useState({ action: 'increase', unit: 'percent', value: '', target: 'all' });
  const [search, setSearch] = useState<{ query: string; options: { id: string; name: string; code?: string | null }[] } | null>(null), [more, setMore] = useState(false);
  const request = useRef<AbortController | null>(null), moreRequest = useRef<AbortController | null>(null);
  // Onda D (192): Imprimir, Excluir lista (lixeira) e a planilha modelo da gaveta "Inserir produtos".
  const [printing, setPrinting] = useState(false), [removal, setRemoval] = useState<CommandState | null>(null);
  const [sheet, setSheet] = useState<{ name: string; rows: SheetRow[]; problems: string[]; blocking: boolean } | null>(null), [linking, setLinking] = useState<CommandState | null>(null);
  const dirty = JSON.stringify(draft) !== baseline || Object.keys(prices).length > 0;
  const guard = useUnsavedChanges(dirty || Boolean(pending?.uncertain), busy || Boolean(pending?.uncertain));
  useEffect(() => () => { request.current?.abort(); moreRequest.current?.abort(); }, []);
  const path = (offset: number) => `/v1/cadastros/listas-precos/${id}?${new URLSearchParams(Object.entries({ q: itemQuery, offset: offset ? String(offset) : '', limit: '100' }).filter(([, value]) => value))}`;
  useEffect(() => {
    const signal = new AbortController(); request.current?.abort(); moreRequest.current?.abort(); request.current = signal; setMore(false);
    void controller.catalog(path(0), { signal: signal.signal }).then(value => {
      const result = value as { list?: PriceList; items?: PriceListItem[]; total?: number };
      if (signal.signal.aborted) return;
      if (!result.list || result.list.id !== id || !Array.isArray(result.items)) throw new AccessError(502);
      setList(result.list); setItems(result.items); setTotal(result.total ?? result.items.length); setPrices({}); setChosen(new Set());
      const next = draftOf(result.list); setDraft(next); setBaseline(JSON.stringify(next));
    }).catch(failure => { if (!signal.signal.aborted && !aborted(failure)) setError(errorText(failure)); });
    return () => signal.abort();
  }, [controller, id, reload, itemQuery]);
  // Carga incremental (Origin: rolagem): the next 100 products of the same search; a list changed meanwhile asks for a reload.
  const loadMore = async () => {
    if (moreRequest.current || !list) return;
    const signal = new AbortController(); moreRequest.current = signal; setMore(true);
    try {
      const result = await controller.catalog(path(items.length), { signal: signal.signal }) as { list?: PriceList; items?: PriceListItem[]; total?: number };
      if (signal.signal.aborted) return;
      if (result.list?.id !== id || !Array.isArray(result.items)) throw new AccessError(502);
      if (result.list.version !== list.version) { setNotice('A lista foi alterada por outra operação; ela foi recarregada.'); setReload(value => value + 1); return; }
      setItems(current => [...current, ...(result.items ?? []).filter(item => !current.some(row => row.product_id === item.product_id))]); setTotal(result.total ?? total);
    } catch (failure) { if (!signal.signal.aborted && !aborted(failure)) setError(errorText(failure)); }
    finally { if (moreRequest.current === signal) { moreRequest.current = null; setMore(false); } }
  };
  useEffect(() => {
    if (!search?.query.trim()) return;
    const signal = new AbortController();
    const timer = setTimeout(() => void controller.catalog(`/v1/cadastros/products?${new URLSearchParams({ limit: '10', q: search.query.trim(), active: 'true' })}`, { signal: signal.signal }).then(value => {
      const found = (value as { items?: { id: string; name: string; code?: string | null }[] }).items;
      if (!signal.signal.aborted && Array.isArray(found)) setSearch(current => current && current.query === search.query ? { ...current, options: found.map(item => ({ id: item.id, name: item.name, code: item.code ?? null })) } : current);
    }).catch(() => undefined), 250);
    return () => { clearTimeout(timer); signal.abort(); };
  }, [controller, search?.query]);
  const send = async (operation: Pending) => {
    if (busy) return;
    const signal = new AbortController(); request.current = signal; setBusy(true); setError(''); setPending({ ...operation, uncertain: false });
    try {
      const result = await controller.catalog(operation.path, { method: operation.method, body: operation.body, signal: signal.signal }) as { saved?: boolean; reason?: string; list?: PriceList };
      if (signal.signal.aborted) return;
      setPending(null);
      if (!result.saved || !result.list) { setError('Já existe uma lista de preços com este nome.'); return; }
      setNotice('Lista salva.'); setReload(value => value + 1);
    } catch (failure) {
      if (signal.signal.aborted) return;
      const known = !aborted(failure) && knownFailure(failure) && !operation.uncertain;
      setPending(known ? null : { ...operation, uncertain: true });
      setError(known ? (failure as AccessError).status === 409 ? 'A lista foi alterada por outra operação. Recarregue antes de salvar; suas alterações continuam na tela.' : errorText(failure)
        : 'Não foi possível confirmar o resultado. Use “Conferir resultado” para repetir a mesma operação sem duplicar.');
    } finally { if (request.current === signal) { request.current = null; setBusy(false); } }
  };
  const save = (event?: FormEvent) => {
    event?.preventDefault(); if (!writable || busy || pending?.uncertain || !list) return;
    const data = priceListData(draft); if (typeof data === 'string') { setError(data); return; }
    void send({ path: `/v1/cadastros/listas-precos/${id}`, method: 'PATCH', body: { command_id: crypto.randomUUID(), expected_version: list.version, data }, uncertain: false });
  };
  // Every change of the products reloads the list (and its Dados gerais): unsaved edits on the screen would be lost.
  const change = (patch: Record<string, unknown>) => {
    if (!list || busy || pending?.uncertain) return;
    if (JSON.stringify(draft) !== baseline || (!Object.hasOwn(patch, 'prices') && Object.keys(prices).length > 0)) {
      setError('Salve ou descarte as alterações da tela antes de alterar os produtos da lista.'); return;
    }
    void send({ path: `/v1/cadastros/listas-precos/${id}/itens`, method: 'POST', body: { command_id: crypto.randomUUID(), expected_version: list.version, change: patch }, uncertain: false });
  };
  const savePrices = () => {
    const entries = Object.entries(prices); const out: { product_id: string; custom_price: string | null }[] = [];
    for (const [productId, text] of entries) { const value = text.trim().replace(',', '.'); if (!value) { out.push({ product_id: productId, custom_price: null }); continue; }
      try { out.push({ product_id: productId, custom_price: normalizeUnitPrice(value, 14) }); } catch { setError('Informe os preços com até dez casas decimais, sem separador de milhares.'); return; } }
    change({ prices: out });
  };
  const runAdjust = () => {
    if (dirty) { setError('É necessário salvar as alterações antes de aplicar reajuste em massa.'); return; }
    const value = adjust.value.trim().replace(',', '.');
    if (!/^(0|[1-9]\d{0,10})(?:\.\d{1,4})?$/.test(value)) { setError('Informe o valor do reajuste com até quatro casas decimais.'); return; }
    change({ adjust: { action: adjust.action, unit: adjust.action === 'fix' ? 'amount' : adjust.unit, value, ...(adjust.target === 'selected' ? { products: [...chosen] } : {}) } });
  };
  // Excluir lista: one command; an unconfirmed answer keeps it for "Conferir resultado" (the same command never deletes twice).
  const removeList = async () => {
    if (!list || !removal || removal.busy) return;
    const current = removal, signal = new AbortController(); request.current = signal; setRemoval({ ...current, busy: true, error: '' });
    try {
      await controller.catalog(`/v1/cadastros/listas-precos/${id}/excluir`, { method: 'POST', body: { command_id: current.command, expected_version: list.version }, signal: signal.signal });
      if (!signal.signal.aborted) { setRemoval(null); onClose(`Lista “${list.name}” excluída.`); }
    } catch (failure) {
      if (signal.signal.aborted) return;
      const known = !aborted(failure) && knownFailure(failure) && !current.uncertain;
      setRemoval(known ? { ...freshCommand(), error: (failure as AccessError).status === 409 ? 'A lista foi alterada por outra operação. Feche e abra a lista antes de excluir.' : errorText(failure) }
        : { ...current, busy: false, uncertain: true, error: 'Não foi possível confirmar a exclusão. Use “Conferir resultado” para repetir a mesma operação.' });
    } finally { if (request.current === signal) request.current = null; }
  };
  const readSheet = async (file: File | undefined) => {
    if (!file || !list) return;
    if (file.size > 1048576) { setSheet({ name: file.name, rows: [], problems: ['A planilha passa de 1 MB.'], blocking: true }); return; }
    const parsed = parsePriceListSheet(await file.text(), list.list_type === 'custom');
    setSheet({ name: file.name, ...parsed }); setLinking(freshCommand());
  };
  // Vincular a planilha: the same rule as the other product changes (Dados gerais saved first), one command with the list version.
  const linkSheet = async () => {
    if (!list || !sheet || !linking || linking.busy || !sheet.rows.length) return;
    if (dirty) { setLinking({ ...linking, error: 'Salve ou descarte as alterações da tela antes de alterar os produtos da lista.' }); return; }
    const current = linking, signal = new AbortController(); request.current = signal; setLinking({ ...current, busy: true, error: '' });
    try {
      const result = await controller.catalog(`/v1/cadastros/listas-precos/${id}/importar`, { method: 'POST', body: { command_id: current.command, expected_version: list.version, rows: sheet.rows }, signal: signal.signal }) as SheetResult & { saved?: boolean };
      if (signal.signal.aborted) return;
      if (result.saved !== true) throw new AccessError(502);
      setLinking(null); setSheet(null); setSearch(null); setNotice(sheetResultText(result)); setReload(value => value + 1);
    } catch (failure) {
      if (signal.signal.aborted) return;
      const known = !aborted(failure) && knownFailure(failure) && !current.uncertain;
      setLinking(known ? { ...freshCommand(), error: (failure as AccessError).status === 409 ? 'A lista foi alterada por outra operação. Feche a gaveta e confira a lista antes de vincular a planilha.' : errorText(failure) }
        : { ...current, busy: false, uncertain: true, error: 'Não foi possível confirmar o resultado. Use “Conferir resultado” para repetir a mesma operação sem duplicar.' });
    } finally { if (request.current === signal) request.current = null; }
  };
  const closeInsert = () => { if (linking?.busy || linking?.uncertain) return; setSearch(null); setSheet(null); setLinking(null); };
  const locked = !writable || busy || Boolean(pending?.uncertain);
  if (!list) return <section className="real-editor"><p role="status">{error || 'Carregando a lista…'}</p><div className="real-editor-actions"><button type="button" className="secondary-button" onClick={() => onClose()}>Voltar</button></div></section>;
  const set = (patch: Partial<Draft>) => setDraft(current => ({ ...current, ...patch }));
  const custom = list.list_type === 'custom';
  return <section className="real-editor catalog-editor" aria-labelledby="price-list-title">
    <header className="real-editor-heading catalog-editor-heading"><div><div className="catalog-editor-title"><h2 id="price-list-title">{list.name}</h2>{!writable && <span className="real-mode">Somente consulta</span>}</div>
      <p>Tipo Lista: {TYPE[list.list_type]} · Baseado em: Preço de venda · Fator a ser aplicado: {list.rule}{list.starts_on || list.ends_on ? ` · Validade: ${validity(list)}` : ''}{hours(list) !== '—' ? ` · Horário: ${hours(list)}` : ''}</p></div>
      <div className="catalog-editor-buttons">{writable && <button type="button" className="secondary-button is-danger" title="Excluir lista" aria-label="Excluir lista" disabled={locked || Boolean(removal)} onClick={() => guard.confirmLeave(() => setRemoval(freshCommand()))}><Icon name="trash-can" size={13} /></button>}
        <ToolButton icon="print" title="Imprimir" onClick={() => setPrinting(true)} />
        <button type="button" className="secondary-button" disabled={busy} onClick={() => guard.confirmLeave(() => onClose())}>{writable ? 'Cancelar' : 'Voltar'}</button>{writable && <button type="submit" form="price-list-form" className="primary-button" disabled={busy || Boolean(pending?.uncertain) || JSON.stringify(draft) === baseline}>{busy ? 'Salvando…' : 'Salvar'}</button>}</div></header>
    {notice && <p className="real-success" role="status">{notice}</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    {pending?.uncertain && <div className="real-editor-actions"><button type="button" className="primary-button" disabled={busy} onClick={() => void send(pending)}>Conferir resultado</button></div>}
    <form id="price-list-form" onSubmit={save}><fieldset className="real-editor-fields" disabled={locked}><legend>Dados gerais</legend>
      <div className="form-field"><label htmlFor="price-list-name">Nome da lista *</label><input id="price-list-name" value={draft.name} maxLength={120} required onChange={event => set({ name: event.target.value })} /></div>
      <div className="form-field"><label htmlFor="price-list-category-field">Categoria</label><select id="price-list-category-field" value={draft.category} onChange={event => set({ category: event.target.value as ListCategory })}>{Object.entries(CATEGORY).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      <div className="form-field"><label htmlFor="price-list-type">Tipo de lista</label><select id="price-list-type" value={draft.list_type} disabled><option value={draft.list_type}>{TYPE[draft.list_type]}</option></select><small>O tipo é escolhido na inclusão da lista.</small></div>
      {!custom && <><div className="form-field"><label htmlFor="price-list-factor">Fator *</label><div className="product-inline"><input id="price-list-factor" value={draft.factor} inputMode="decimal" maxLength={17} onChange={event => set({ factor: event.target.value })} />
        <select aria-label="Unidade do fator" value={draft.factor_unit} onChange={event => set({ factor_unit: event.target.value as Draft['factor_unit'] })}><option value="amount">Valor em R$</option><option value="percent">Porcentagem %</option></select></div></div>
        <fieldset className="form-field"><legend>Lista de:</legend>{(['increase', 'discount'] as const).map(value => <label key={value} className="product-check"><input type="radio" name="price-list-direction" checked={draft.direction === value} onChange={() => set({ direction: value })} />{value === 'increase' ? 'Acréscimo' : 'Desconto'}</label>)}</fieldset></>}
      <div className="form-field real-field-wide"><label className="product-check"><input type="checkbox" checked={draft.considers_datetime} onChange={event => set({ considers_datetime: event.target.checked, ...(event.target.checked ? {} : { start_time: '', end_time: '' }) })} />Considerar data e hora na lista de preços</label></div>
      <div className="form-field"><label htmlFor="price-list-start">Data de início</label><input id="price-list-start" type="date" value={draft.starts_on} onChange={event => set({ starts_on: event.target.value })} /></div>
      <div className="form-field"><label htmlFor="price-list-end">Data de término</label><input id="price-list-end" type="date" value={draft.ends_on} onChange={event => set({ ends_on: event.target.value })} /></div>
      {draft.considers_datetime && <><div className="form-field"><label htmlFor="price-list-start-time">Hora de início</label><input id="price-list-start-time" type="time" value={draft.start_time} onChange={event => set({ start_time: event.target.value })} /></div>
        <div className="form-field"><label htmlFor="price-list-end-time">Hora de término</label><input id="price-list-end-time" type="time" value={draft.end_time} onChange={event => set({ end_time: event.target.value })} /></div></>}
      <PriceListLinks controller={controller} draft={draft} set={set} locked={locked} />
    </fieldset></form>
    {/* Gaveta "Inserir produtos" (Origin): a planilha modelo, a pesquisa de produtos e "Adicionar produto". */}
    {search && <Modal title="Inserir produtos" onClose={closeInsert} actions={<button type="button" className="secondary-button" disabled={Boolean(linking?.busy || linking?.uncertain)} onClick={closeInsert}>Fechar</button>}>
      <p>Acesse a planilha modelo <button type="button" className="text-button" onClick={() => downloadFile(`planilha-modelo-lista-${list.list_type === 'custom' ? 'customizada' : 'precos'}.csv`, sheetTemplate(list.list_type === 'custom'), CSV_TYPE)}>aqui</button> e vincule seus produtos à uma lista de preço.</p>
      <div className="form-field"><label htmlFor="price-list-sheet">Planilha preenchida (CSV)</label><input id="price-list-sheet" type="file" accept=".csv,text/csv" disabled={locked || Boolean(linking?.busy || linking?.uncertain)} onChange={event => void readSheet((event.target as HTMLInputElement).files?.[0])} />
        <small className="real-help">{list.list_type === 'custom' ? 'Colunas: Código (SKU) e Preço da lista (vazio: o preço de venda).' : 'Coluna: Código (SKU); o preço vem da regra da lista.'} Até {SHEET_LIMIT} linhas por planilha; o código precisa ser o de um único produto.</small></div>
      {sheet && <div className="price-list-sheet" role="status"><p><strong>{sheet.name}</strong>: {sheet.rows.length} linha(s) para vincular.</p>
        {sheet.problems.length > 0 && <ul className="real-help">{sheet.problems.slice(0, 10).map(problem => <li key={problem}>{problem}</li>)}{sheet.problems.length > 10 && <li>… e mais {sheet.problems.length - 10}.</li>}</ul>}
        {linking?.error && <p className="real-alert" role="alert">{linking.error}</p>}
        <button type="button" className="primary-button" disabled={locked || sheet.blocking || !sheet.rows.length || Boolean(linking?.busy)} onClick={() => void linkSheet()}>{linking?.busy ? 'Vinculando…' : linking?.uncertain ? 'Conferir resultado' : 'Vincular produtos da planilha'}</button></div>}
      <div className="form-field"><label htmlFor="price-list-picker">Pesquisa produtos</label><input id="price-list-picker" autoFocus value={search.query} maxLength={120} placeholder="Nome do produto ou SKU" disabled={locked} onChange={event => setSearch({ ...search, query: event.target.value, options: [] })} /></div>
      {search.options.length > 0 && <ul className="product-options" role="listbox" aria-label="Resultados">{search.options.map(option => <li key={option.id}><button type="button" role="option" aria-selected={false} disabled={locked} onClick={() => { setSearch(null); change({ add: [option.id] }); }}>{option.name}{option.code ? ` (${option.code})` : ''}<span className="real-sr-only">: Adicionar produto</span></button></li>)}</ul>}
    </Modal>}
    {printing && <PriceListPrint controller={controller} list={list} onClose={() => setPrinting(false)} />}
    {removal && <Modal title="Excluir lista" onClose={() => { if (!removal.busy && !removal.uncertain) setRemoval(null); }} actions={<><button type="button" className="secondary-button" disabled={removal.busy || removal.uncertain} onClick={() => setRemoval(null)}>Cancelar</button>
      <button type="button" className="primary-button is-danger" disabled={removal.busy} onClick={() => void removeList()}>{removal.busy ? 'Excluindo…' : removal.uncertain ? 'Conferir resultado' : 'Excluir lista'}</button></>}>
      <p>Excluir a lista “{list.name}” com {list.products} produto(s)? A exclusão não altera o preço de venda dos produtos e não pode ser desfeita.</p>
      {removal.error && <p className="real-alert" role="alert">{removal.error}</p>}</Modal>}
    <section aria-labelledby="price-list-products"><h3 id="price-list-products">Produtos da lista</h3>
      <div className="native-list-toolbar"><div className="form-field"><label htmlFor="price-list-items-search">Pesquisar produtos</label><input id="price-list-items-search" type="search" placeholder="Nome do produto ou SKU" maxLength={120} defaultValue={itemQuery} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); setItemQuery((event.target as HTMLInputElement).value.trim()); } }} /></div>
        {writable && <><button type="button" className="secondary-button" disabled={locked} onClick={() => setSearch({ query: '', options: [] })}><Icon name="plus" size={11} />Inserir produtos</button>
          <button type="button" className="secondary-button" disabled={locked || !chosen.size} onClick={() => change({ remove: [...chosen] })}><Icon name="trash-can" size={11} />Excluir itens</button></>}</div>
      {custom && writable && <div className="product-inline catalog-more"><strong>Regra</strong>
        <select aria-label="Ação" value={adjust.action} onChange={event => setAdjust({ ...adjust, action: event.target.value })}><option value="increase">Acrescer</option><option value="discount">Descontar</option><option value="fix">Fixar</option></select>
        <input aria-label="Valor" value={adjust.value} inputMode="decimal" maxLength={17} onChange={event => setAdjust({ ...adjust, value: event.target.value })} />
        {adjust.action !== 'fix' && <select aria-label="Unidade do valor" value={adjust.unit} onChange={event => setAdjust({ ...adjust, unit: event.target.value })}><option value="amount">R$</option><option value="percent">%</option></select>}
        <select aria-label="Aplicar para" value={adjust.target} onChange={event => setAdjust({ ...adjust, target: event.target.value })}><option value="all">Todos produtos da lista</option><option value="selected">Selecionados</option></select>
        <button type="button" className="secondary-button" disabled={locked || (adjust.target === 'selected' && !chosen.size)} onClick={runAdjust}>Atualizar</button></div>}
      <div className="table-scroll"><table className="data-table"><thead><tr>{writable && <th scope="col" className="checkbox-cell"><span className="real-sr-only">Seleção</span></th>}<th scope="col">Produto</th><th scope="col">SKU</th><th scope="col">EAN</th><th scope="col" className="numeric">R$ Preço no FAGOO</th>{!custom && <th scope="col">Fator</th>}<th scope="col" className="numeric">R$ Preço da lista</th></tr></thead>
        <tbody>{items.map(item => <tr key={item.product_id}>
          {writable && <td className="checkbox-cell"><input type="checkbox" aria-label={`Selecionar ${item.name}`} checked={chosen.has(item.product_id)} onChange={event => setChosen(current => { const next = new Set(current); if (event.target.checked) next.add(item.product_id); else next.delete(item.product_id); return next; })} /></td>}
          <td>{item.name}</td><td>{item.code ?? '—'}</td><td>{item.gtin ?? '—'}</td><td className="numeric">{decimalMoney(item.product_price)}</td>{!custom && <td>{list.rule}</td>}
          <td className="numeric">{custom && writable ? <input aria-label={`Preço da lista de ${item.name}`} inputMode="decimal" maxLength={80} disabled={locked} value={prices[item.product_id] ?? decimalComma(item.custom_price)} placeholder={item.list_price?.replace('.', ',') ?? ''} onChange={event => setPrices(current => ({ ...current, [item.product_id]: event.target.value }))} /> : decimalMoney(item.list_price)}</td></tr>)}</tbody></table></div>
      {!items.length && <p className="real-help">Nenhum produto na lista.</p>}
      {total > items.length && <div className="real-editor-actions"><span className="real-help">Exibindo {items.length} de {total} produtos.</span><button type="button" className="secondary-button" disabled={more || busy} onClick={() => void loadMore()}>{more ? 'Carregando…' : 'Carregar mais produtos'}</button></div>}
      {custom && writable && Object.keys(prices).length > 0 && <div className="real-editor-actions"><button type="button" className="primary-button" disabled={locked} onClick={savePrices}>Salvar preços</button><button type="button" className="text-button" onClick={() => setPrices({})}>Descartar</button></div>}
      <p className="real-help">Cadastrada em: {new Date(list.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }).replace(',', '')}</p>
    </section>
  </section>;
}
