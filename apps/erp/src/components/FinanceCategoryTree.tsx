import { useLocation, useNavigate } from 'react-router-dom';
import { financePermitted } from '../lib/real-finance-model';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { financeLinkActor } from '../lib/document-finance-link';
import { useUnsavedChanges, useUnsavedForm } from '../hooks/useUnsavedChanges';
import type { FinanceAccess, FinanceKind } from '../lib/real-finance-model';
import { CATEGORY_SHEET_HEADERS, DRE_DEFAULTS, DRE_GROUPS, MENU_DEFAULTS, ROOT_LABEL, TAB_LABEL, categoryImportRows, categoryPathName, descendants, categorySheet, defaultPill, maxDepth, treeRows, type CategoryImportRow, type CategoryNode, type CategoryTree, type DefaultKey, type DreGroup } from '../lib/finance-registry-model';
import { readSheet, sheetRecords } from '../lib/finance-sheet-import';
import { XLSX_TYPE, downloadFile, textCell, toXlsx } from '../lib/spreadsheet-export';
import { batchSummaryText, planBatch, summarizeBatch, type BatchItem, type BatchPlan, type BatchResult } from '../lib/origin-batch';
import { badgeClass } from '../lib/origin-list';
import { useCategoryTree, CategoryTreePicker } from './FinanceCategoryTreeSelect';
import NativeListLayout from './NativeListLayout';
import { AppliedChips, RowMenu, ToolButton, type RowMenuItem } from './OriginList';
import { BatchDialog } from './BatchDialog';
import { Icon } from './Icon';
import './real-finance.css';
import './finance-title-drawer.css';
import './finance-registry.css';

const noSubscription = () => () => {}, noSnapshot = () => null;
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const failureText = (failure: unknown) => failure instanceof AccessError ? failure.status === 409 ? 'A categoria mudou, está em uso ou já existe com este nome no mesmo nível. Atualize a árvore.' : failure.status === 400 ? 'A operação não foi aceita. Confira o nome, a categoria pai e o grupo de DRE.' : failure.status === 403 ? 'Seu acesso a esta operação foi alterado.' : failure.status === 404 ? 'A categoria não foi encontrada. Atualize a árvore.' : 'Não foi possível confirmar o resultado.' : failure instanceof Error ? failure.message : 'Não foi possível concluir a operação.';
const definitive = (failure: unknown) => failure instanceof AccessError && [400, 403, 404, 409].includes(failure.status);
type Command = { id: string; path: string; body: { data: Record<string, unknown> } };
type Send = (command: Command) => Promise<unknown>;
function BusyGuard() { useUnsavedChanges(false, true); return null; }
function Field({ label, children, hint }: { label: string; children: (id: string) => ReactNode; hint?: ReactNode }) { const id = useId(); return <div className="form-field finance-drawer-wide"><label htmlFor={id}>{label}</label>{children(id)}{hint}</div>; }
const kindWord = (kind: FinanceKind) => kind === 'receivable' ? 'receita' : 'despesa';
const plural = (kind: FinanceKind) => kind === 'receivable' ? 'receitas' : 'despesas';

/** One command with "Conferir resultado": the same command id and body are sent again until a definitive answer. */
function useCommand(send: Send, mayWrite: () => boolean) {
  const [state, setState] = useState<{ busy: boolean; uncertain: boolean; error: string }>({ busy: false, uncertain: false, error: '' }), pending = useRef<Command | null>(null);
  const run = async (build: () => Command, onDone: (value: unknown) => void) => {
    if (state.busy) return; if (!mayWrite()) { setState({ ...state, error: 'Seu acesso a esta operação foi alterado.' }); return; }
    if (!pending.current) { try { pending.current = build(); } catch (failure) { setState({ ...state, error: (failure as Error).message }); return; } }
    const command = pending.current; setState({ busy: true, uncertain: state.uncertain, error: '' });
    try { const value = await send(command); pending.current = null; setState({ busy: false, uncertain: false, error: '' }); onDone(value); }
    catch (failure) {
      if (definitive(failure) && !state.uncertain) { pending.current = null; setState({ busy: false, uncertain: false, error: failureText(failure) }); }
      else setState({ busy: false, uncertain: true, error: definitive(failure) ? `${failureText(failure)} O envio anterior continua sem confirmação.` : 'Não foi possível confirmar o resultado. Use “Conferir resultado” para repetir a mesma operação; ela não será duplicada.' });
    }
  };
  return { ...state, run };
}
function Drawer({ title, onClose, children, footer, busy }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode; busy: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <div className="finance-drawer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }} onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); } }}>
    <section className="finance-drawer finance-category-drawer" role="dialog" aria-modal="true" aria-label={title}>
      <header className="finance-drawer-head"><div className="finance-drawer-title"><h2 ref={heading} tabIndex={-1}>{title}</h2></div><button type="button" className="icon-button" aria-label="Fechar" disabled={busy} onClick={onClose}><Icon name="xmark" size={16} /></button></header>
      {children}<div className="finance-drawer-actions">{footer}</div></section></div>;
}

/** Gaveta "Nova categoria" e "Editar categoria de Receita/Despesa". */
function CategoryDrawer({ kind, items, node, parent, send, mayWrite, onClose, onSaved }: { kind: FinanceKind; items: readonly CategoryNode[]; node: CategoryNode | null; parent: string | null; send: Send; mayWrite: () => boolean; onClose: () => void; onSaved: (text: string) => void }) {
  const [values, setValues] = useState({ type: node ? (node.parent_id ? 'sub' : 'main') : parent ? 'sub' : 'main', name: node?.name ?? '', parent: node?.parent_id ?? parent ?? '', dre: (node?.dre_group ?? 'none') as DreGroup });
  const command = useCommand(send, mayWrite), guard = useUnsavedForm(values, command.busy || command.uncertain);
  const parents = items.filter(item => item.depth < maxDepth(kind) && item.active);
  const sub = values.type === 'sub', title = node ? `Editar categoria de ${kind === 'receivable' ? 'Receita' : 'Despesa'}` : 'Nova categoria';
  const save = () => void command.run(() => {
    const name = values.name.trim(); if (!name) throw new Error('Informe o nome da categoria.'); if (name.length > 100) throw new Error('O nome tem no máximo 100 caracteres.');
    if (!node && sub && !values.parent) throw new Error('Selecione a categoria pai.');
    const main = node ? !node.parent_id : !sub;
    const data: Record<string, unknown> = node ? { id: node.id, expected_version: node.version, name, ...(main ? { dre_group: values.dre } : {}) } : { kind, name, ...(sub ? { parent_id: values.parent } : { dre_group: values.dre }) };
    return { id: crypto.randomUUID(), path: `/v1/financeiro/actions/${node ? 'category_update' : 'category_create'}`, body: { data } };
  }, () => onSaved(node ? `Categoria “${values.name.trim()}” atualizada.` : `Categoria “${values.name.trim()}” incluída.`));
  const createLabel = `Criar ${sub ? 'subcategoria' : 'categoria'} de ${kindWord(kind)}`;
  return <Drawer title={title} busy={command.busy} onClose={() => guard.confirmLeave(onClose)} footer={<><button type="button" className="text-button" disabled={command.busy} onClick={() => guard.confirmLeave(onClose)}>Cancelar</button><button type="button" className="primary-button" disabled={command.busy} onClick={save}>{command.busy ? 'Salvando…' : command.uncertain ? 'Conferir resultado' : node ? 'Salvar alterações' : createLabel}</button></>}>
    <form className="finance-drawer-form" onSubmit={event => { event.preventDefault(); save(); }}><fieldset className="finance-drawer-fields" disabled={command.busy || command.uncertain}><legend className="real-sr-only">{title}</legend>
      {!node && <fieldset className="finance-option-filter finance-drawer-wide"><legend>Tipo</legend>{([['main', 'Categoria principal'], ['sub', 'Subcategoria']] as const).map(([value, label]) => <label key={value} htmlFor={`category-type-${value}`}><input id={`category-type-${value}`} type="radio" name="category-type" checked={values.type === value} disabled={value === 'sub' && !parents.length} onChange={() => setValues(previous => ({ ...previous, type: value }))} />{label}</label>)}</fieldset>}
      <Field label={sub ? 'Nome da subcategoria *' : 'Nome da categoria *'}>{id => <input id={id} required maxLength={100} value={values.name} onChange={event => { const name = event.target.value; setValues(previous => ({ ...previous, name })); }} />}</Field>
      {!node && sub && <Field label="Categoria pai *">{id => <select id={id} required value={values.parent} onChange={event => { const value = event.target.value; setValues(previous => ({ ...previous, parent: value })); }}><option value="">Selecione</option>{parents.map(item => <option key={item.id} value={item.id}>{categoryPathName(items, item.id)}</option>)}</select>}</Field>}
      {(node ? !node.parent_id : !sub) && <Field label="Grupo de DRE">{id => <select id={id} value={values.dre} onChange={event => { const dre = event.target.value as DreGroup; setValues(previous => ({ ...previous, dre })); }}>{DRE_GROUPS[kind].map(group => <option key={group.value} value={group.value}>{group.label}</option>)}</select>}</Field>}
    </fieldset>{command.error && <p className="real-alert" role="alert">{command.error}</p>}</form>
  </Drawer>;
}

/** Gaveta "Categorização para DRE": categorias padrão dos valores adicionais das baixas (recebimentos e pagamentos). */
function DreDrawer({ trees, send, mayWrite, onClose, onSaved }: { trees: Record<FinanceKind, CategoryTree>; send: Send; mayWrite: () => boolean; onClose: () => void; onSaved: (text: string) => void }) {
  const defaults = trees.receivable.defaults, [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(DRE_DEFAULTS.map(item => [item.key, defaults[item.key].category_id ?? ''])));
  const [command, setCommand] = useState<{ busy: boolean; uncertain: boolean; error: string }>({ busy: false, uncertain: false, error: '' }), guard = useUnsavedForm(values, command.busy || command.uncertain);
  const done = useRef(new Set<string>()), pending = useRef<Command | null>(null);
  const changed = DRE_DEFAULTS.filter(item => (values[item.key] || null) !== defaults[item.key].category_id);
  // One command per changed key, in order; an uncertain one is repeated as is ("Conferir resultado") before the next ones.
  const save = async () => {
    if (command.busy) return; if (!mayWrite()) { setCommand({ ...command, error: 'Seu acesso a esta operação foi alterado.' }); return; }
    let replay = command.uncertain; setCommand({ busy: true, uncertain: replay, error: '' });
    for (const item of changed) {
      if (done.current.has(item.key)) continue;
      const next = pending.current ?? { id: crypto.randomUUID(), path: '/v1/financeiro/actions/category_set_default', body: { data: { key: item.key, category_id: values[item.key] || null, expected_version: defaults[item.key].version } } };
      pending.current = next;
      try { await send(next); pending.current = null; done.current.add(item.key); replay = false; }
      catch (failure) {
        if (definitive(failure) && !replay) { pending.current = null; setCommand({ busy: false, uncertain: false, error: `${item.label}: ${failureText(failure)}` }); return; }
        setCommand({ busy: false, uncertain: true, error: 'Não foi possível confirmar o resultado. Use “Conferir resultado” para repetir a mesma gravação; ela não será duplicada.' }); return;
      }
    }
    onSaved('Categorização para DRE salva.');
  };
  return <Drawer title="Categorização para DRE" busy={command.busy} onClose={() => guard.confirmLeave(onClose)} footer={<><button type="button" className="text-button" disabled={command.busy} onClick={() => guard.confirmLeave(onClose)}>Cancelar</button><button type="button" className="primary-button" disabled={command.busy || !changed.length} onClick={() => void save()}>{command.busy ? 'Salvando…' : command.uncertain ? 'Conferir resultado' : 'Salvar alterações'}</button></>}>
    <p className="real-help">Os valores adicionais das baixas (acréscimos, juros, descontos e taxas) são classificados nestas categorias nos relatórios financeiros. Cada baixa guarda as categorias do momento em que foi feita: uma mudança aqui vale para as próximas baixas. Sem categoria definida, o valor fica na categoria da conta. Taxas do Marketplace não se aplicam ao FAGOO.</p>
    {(['Operações de Recebimento', 'Operações de Pagamento'] as const).map(section => <fieldset key={section} className="finance-drawer-fields" disabled={command.busy || command.uncertain}><legend>{section}</legend>
      {DRE_DEFAULTS.filter(item => item.section === section).map(item => <Field key={item.key} label={`${item.label} (${item.kind === 'receivable' ? 'Receita' : 'Despesa'})`}>{id => <CategoryTreePicker id={id} items={trees[item.kind].items} value={values[item.key]} onChange={next => setValues(previous => ({ ...previous, [item.key]: next }))} />}</Field>)}</fieldset>)}
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
  </Drawer>;
}

/** Gaveta "Mover categorias": todos os lançamentos de uma categoria (e das subcategorias) passam para outra da mesma aba. */
function MoveDrawer({ kind, items, send, mayWrite, onClose, onSaved }: { kind: FinanceKind; items: readonly CategoryNode[]; send: Send; mayWrite: () => boolean; onClose: () => void; onSaved: (text: string) => void }) {
  const [values, setValues] = useState({ from: '', to: '', confirmed: false }), command = useCommand(send, mayWrite), guard = useUnsavedForm(values, command.busy || command.uncertain);
  const save = () => void command.run(() => {
    const from = items.find(item => item.id === values.from); if (!from) throw new Error('Selecione a categoria a mover.'); if (!values.to) throw new Error('Selecione a categoria de destino.');
    if (!values.confirmed) throw new Error('Confirme que deseja alterar a categoria dos itens selecionados.');
    return { id: crypto.randomUUID(), path: '/v1/financeiro/actions/category_move', body: { data: { id: from.id, expected_version: from.version, target_id: values.to, confirmed: true } } };
  }, value => { const moved = (value as { moved?: { titles: number; settlements: number; movements: number } })?.moved; onSaved(`Lançamentos movidos: ${moved ? moved.titles + moved.settlements + moved.movements : 0}.`); });
  const fromSubtree = new Set(values.from ? [values.from, ...descendants(items, values.from)] : []);
  return <Drawer title="Mover categorias" busy={command.busy} onClose={() => guard.confirmLeave(onClose)} footer={<><button type="button" className="text-button" disabled={command.busy} onClick={() => guard.confirmLeave(onClose)}>Cancelar</button><button type="button" className="primary-button" disabled={command.busy} onClick={save}>{command.busy ? 'Movendo…' : command.uncertain ? 'Conferir resultado' : 'Mover subcategorias'}</button></>}>
    <fieldset className="finance-drawer-fields" disabled={command.busy || command.uncertain}><legend className="real-sr-only">Mover categorias</legend>
      <Field label="Mover essa categoria *">{id => <CategoryTreePicker id={id} items={items} value={values.from} allowNone={false} onChange={from => setValues(previous => ({ ...previous, from, to: previous.to === from ? '' : previous.to }))} />}</Field>
      <Field label="Para essa categoria *">{id => <CategoryTreePicker id={id} items={items.filter(item => !fromSubtree.has(item.id))} value={values.to} allowNone={false} onChange={to => setValues(previous => ({ ...previous, to }))} />}</Field>
      <label className="finance-drawer-switch finance-drawer-wide" htmlFor="category-move-confirm"><input id="category-move-confirm" type="checkbox" checked={values.confirmed} onChange={event => { const confirmed = event.target.checked; setValues(previous => ({ ...previous, confirmed })); }} />Confirmo que desejo alterar a categoria dos itens selecionados</label>
      <p className="real-notice finance-drawer-wide">A alteração vale para todas as contas, baixas e lançamentos de caixa da categoria e das subcategorias e aparece nos relatórios. Contas excluídas continuam com a categoria original. Esta é uma aba de {plural(kind)}.</p>
    </fieldset>{command.error && <p className="real-alert" role="alert">{command.error}</p>}
  </Drawer>;
}

/** Gaveta "Importar categorias": modelo de planilha, anexo .xlsx (ou .csv) por arrastar e soltar, prévia e gravação em um comando. */
function ImportDrawer({ kind, items, send, mayWrite, onClose, onSaved }: { kind: FinanceKind; items: readonly CategoryNode[]; send: Send; mayWrite: () => boolean; onClose: () => void; onSaved: (text: string) => void }) {
  const [file, setFile] = useState<{ name: string; rows: CategoryImportRow[]; errors: string[] } | null>(null), [reading, setReading] = useState(false), [readError, setReadError] = useState('');
  const command = useCommand(send, mayWrite), input = useId(), guard = useUnsavedForm(file?.name ?? null, command.busy || command.uncertain || reading);
  const template = () => downloadFile(`modelo-categorias-${plural(kind)}.xlsx`, toXlsx('Categorias', [CATEGORY_SHEET_HEADERS.map(textCell)]) as unknown as BlobPart, XLSX_TYPE);
  const attach = async (picked: File | undefined | null) => {
    if (!picked || command.uncertain) return; setReading(true); setReadError(''); setFile(null);
    try { const rows = await readSheet(picked.name, new Uint8Array(await picked.arrayBuffer())); const checked = categoryImportRows(sheetRecords(rows, CATEGORY_SHEET_HEADERS), kind, items); if (!checked.rows.length && !checked.errors.length) throw new Error('A planilha não tem categorias.'); setFile({ name: picked.name, ...checked }); }
    catch (failure) { setReadError((failure as Error).message || 'Não foi possível ler a planilha.'); } finally { setReading(false); }
  };
  const save = () => void command.run(() => {
    if (!file || file.errors.length || !file.rows.length) throw new Error('Anexe uma planilha sem erros.');
    return { id: crypto.randomUUID(), path: '/v1/financeiro/actions/category_import', body: { data: { kind, rows: file.rows.map(row => ({ name: row.name, ...(row.parent ? { parent: row.parent } : {}), ...(row.dre_group ? { dre_group: row.dre_group } : {}) })) } } };
  }, value => { const result = value as { created?: unknown[]; skipped?: number }; onSaved(`Categorias importadas: ${result?.created?.length ?? 0}${result?.skipped ? `; ${result.skipped} já existiam` : ''}.`); });
  return <Drawer title="Importar categorias" busy={command.busy} onClose={() => guard.confirmLeave(onClose)} footer={<><button type="button" className="text-button" disabled={command.busy} onClick={() => guard.confirmLeave(onClose)}>Cancelar</button><button type="button" className="primary-button" disabled={command.busy || reading || !file || file.errors.length > 0} onClick={save}>{command.busy ? 'Importando…' : command.uncertain ? 'Conferir resultado' : 'Importar categorias'}</button></>}>
    <p>Baixe o modelo, preencha uma linha por categoria (a categoria pai antes das subcategorias) e anexe o arquivo. Categorias que já existem no mesmo nível são mantidas.</p>
    <button type="button" className="secondary-button" onClick={template}><Icon name="download" size={14} />Baixar modelo de planilha</button>
    <label htmlFor={input} className={`finance-dropzone${command.uncertain ? ' disabled' : ''}`} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void attach(event.dataTransfer?.files?.[0]); }}>
      <Icon name="file-upload" size={20} /><span>{reading ? 'Lendo a planilha…' : 'Solte seu arquivo aqui ou clique para anexar (.xlsx)'}</span>
      <input id={input} type="file" accept=".xlsx,.csv" className="real-sr-only" disabled={command.busy || command.uncertain} onChange={event => { void attach(event.target.files?.[0]); event.target.value = ''; }} /></label>
    {readError && <p className="real-alert" role="alert">{readError}</p>}
    {file && <div className="finance-import-preview"><p><strong>{file.name}</strong> · {file.rows.length === 1 ? '1 categoria' : `${file.rows.length} categorias`}</p>
      {file.errors.length > 0 && <ul className="real-alert" role="alert">{file.errors.slice(0, 20).map(text => <li key={text}>{text}</li>)}{file.errors.length > 20 && <li>E mais {file.errors.length - 20} linha(s).</li>}</ul>}
      <ul className="finance-import-rows">{file.rows.slice(0, 50).map(row => <li key={row.line}>{row.parent ? `${row.parent} > ` : ''}<strong>{row.name}</strong>{row.dre_group ? ` · ${DRE_GROUPS[kind].find(group => group.value === row.dre_group)!.label}` : ''}</li>)}</ul></div>}
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
  </Drawer>;
}

type DeleteItem = BatchItem & { node: CategoryNode };
type Panel = { kind: 'create'; parent: string | null } | { kind: 'edit'; node: CategoryNode } | { kind: 'dre' } | { kind: 'move' } | { kind: 'import' };

/**
 * Cadastros > Categorias Financeiras do Origin (SQL 135): abas Receitas | Despesas, árvore com o grupo raiz, categorias e
 * subcategorias (despesas com mais um nível), pílulas das categorias padrão, menus ⋮ por nível, Situação (Todos | Ativo),
 * busca, Categorização para DRE, Mover categorias, Importar, Exportar e a lixeira com seleção.
 */
export default function FinanceCategoryTree({ controller }: { controller: AccessController }) {
  const location = useLocation(), navigate = useNavigate(), params = new URLSearchParams(location.search);
  const kind: FinanceKind = params.get('tipo') === 'despesas' ? 'payable' : 'receivable';
  const tracked = typeof controller.getSnapshot === 'function', session = useSyncExternalStore(controller.subscribe ?? noSubscription, controller.getSnapshot ?? noSnapshot);
  const actor = financeLinkActor(session), allowed = !tracked || actor !== null, scope = tracked ? `${actor ?? ''}:${session?.phase ?? ''}:${session?.membership?.role ?? ''}` : 'isolated';
  const routeKey = `${location.key}:${location.search}:${scope}`, current = useRef(routeKey); current.current = routeKey;
  const mayRead = () => allowed && current.current === routeKey && (!tracked || financeLinkActor(controller.getSnapshot()) === actor);
  const [permissions, setPermissions] = useState<{ scope: string; value: FinanceAccess } | null>(null), access = permissions?.scope === scope ? permissions.value : null;
  const mayWrite = () => mayRead() && Boolean(access?.write) && (!tracked || ['admin', 'financeiro'].includes(controller.getSnapshot()?.membership?.role ?? ''));
  const [reload, setReload] = useState(0);
  const finance = access ? (path: string, options?: { signal?: AbortSignal }) => controller.finance(path, options) : null;
  const receivable = useCategoryTree(finance, 'receivable', `${scope}:${reload}`), payable = useCategoryTree(finance, 'payable', `${scope}:${reload}`);
  const active = kind === 'receivable' ? receivable : payable, items = active.items;
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [onlyActive, setOnlyActive] = useState(false), [draftActive, setDraftActive] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set()), [menu, setMenu] = useState<string | null>(null), [selection, setSelection] = useState<{ key: string; ids: string[] }>({ key: '', ids: [] });
  const [panel, setPanel] = useState<(Panel & { key: string }) | null>(null), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [removal, setRemoval] = useState<{ key: string; plan: BatchPlan<DeleteItem>; recovery: boolean } | null>(null), [pending, setPending] = useState<DeleteItem[] | null>(null), [running, setRunning] = useState(false);
  const commands = useRef(new Map<string, Command>()), uncertain = useRef(new Set<string>());
  useEffect(() => { setMenu(null); setPanel(null); setSelection({ key: '', ids: [] }); setNotice(''); setError(''); if (params.get('categorizacao') === '1') setPanel({ kind: 'dre', key: routeKey }); }, [location.search]);
  useEffect(() => {
    if (!allowed) return; const request = new AbortController();
    void controller.finance('/v1/financeiro', { signal: request.signal }).then(value => { const result = value as FinanceAccess; if (!request.signal.aborted && mayRead() && result.data_mode === 'erp_native' && result.read === true && typeof result.write === 'boolean') setPermissions({ scope, value: result }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setError(failureText(failure)); });
    return () => request.abort();
  }, [controller, scope]);
  const send: Send = command => { if (!mayWrite()) return Promise.reject(new AccessError(403)); return controller.finance(command.path, { method: 'POST', body: { command_id: command.id, data: structuredClone(command.body.data) } } as never); };
  const tab = (next: FinanceKind) => { if (next === kind) return; const target = new URLSearchParams({ area: 'categories' }); if (next === 'payable') target.set('tipo', 'despesas'); navigate(`${location.pathname}?${target}`); };
  const saved = (text: string) => { if (!mayRead()) return; setPanel(null); setNotice(text); setReload(value => value + 1); };
  const open = (next: Panel) => { setMenu(null); if (!mayWrite() || running) return; setNotice(''); setPanel({ ...next, key: routeKey }); };
  const panelVisible = panel && panel.key === routeKey ? panel : null;
  // Sistema › Usuários › Permissões › Finanças (SQL 246): the server refuses without the key; the screen does not offer it.
  const writable = Boolean(access?.write) && financePermitted(access, 'financas.categorias.ie');
  const rows = treeRows(items, { expanded, query: search, onlyActive });
  const selected = selection.key === `${routeKey}:${reload}` ? selection.ids : [], chosen = items.filter(item => selected.includes(item.id));
  const toggleExpand = (id: string) => setExpanded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const toggleSelect = (id: string, checked: boolean) => setSelection({ key: `${routeKey}:${reload}`, ids: checked ? [...selected.filter(value => value !== id), id] : selected.filter(value => value !== id) });
  // Menu ⋮ commands (padrões, inativar/ativar): one at a time; an uncertain one stays with "Conferir resultado".
  const [quick, setQuick] = useState<{ command: Command; done: string; busy: boolean; uncertain: boolean } | null>(null);
  const runQuick = async (state: { command: Command; done: string; uncertain: boolean }) => {
    if (!mayWrite()) { setError('Seu acesso a esta operação foi alterado.'); return; }
    setQuick({ ...state, busy: true }); setError('');
    try { await send(state.command); if (!mayRead()) return; setQuick(null); saved(state.done); }
    catch (failure) { if (!mayRead()) return; if (definitive(failure) && !state.uncertain) { setQuick(null); setError(failureText(failure)); } else setQuick({ ...state, busy: false, uncertain: true }); }
  };
  const startQuick = (command: Command, done: string) => { setMenu(null); if (quick || !mayWrite()) return; void runQuick({ command, done, uncertain: false }); };
  const setDefault = (node: CategoryNode, key: DefaultKey) => { const tree = (kind === 'receivable' ? receivable : payable).tree; if (!tree) return;
    startQuick({ id: crypto.randomUUID(), path: '/v1/financeiro/actions/category_set_default', body: { data: { key, category_id: node.id, expected_version: tree.defaults[key].version } } }, `${defaultPill(key)}: ${node.name}.`); };
  const toggleActive = (node: CategoryNode) => startQuick({ id: crypto.randomUUID(), path: '/v1/financeiro/actions/category_set_active', body: { data: { id: node.id, expected_version: node.version, active: !node.active } } },
    node.active ? `Categoria “${node.name}” inativada${node.children ? ', com as subcategorias' : ''}.` : `Categoria “${node.name}” ativada.`);
  const plan = (nodes: CategoryNode[]) => planBatch(nodes.map(node => ({ id: node.id, label: categoryPathName(items, node.id), node })), ({ node }) => node.children ? 'Tem subcategorias: exclua-as antes ou inative a categoria.' : node.in_use ? 'Tem lançamentos: inative a categoria.' : node.defaults.length ? 'É categoria padrão: troque o padrão antes.' : null);
  const remove = (nodes: CategoryNode[]) => { setMenu(null); if (!mayWrite() || pending || removal) return; commands.current = new Map(); uncertain.current = new Set(); setRemoval({ key: routeKey, plan: plan(nodes), recovery: false }); };
  const runDelete = async (item: DeleteItem) => {
    const replay = uncertain.current.has(item.id);
    if (!mayWrite()) { if (replay) return { uncertain: true, message: 'Seu acesso foi alterado. A exclusão não foi reenviada e o envio anterior continua sem confirmação.' }; throw new Error('Seu acesso a esta operação foi alterado.'); }
    let command = commands.current.get(item.id); if (!command) { command = { id: crypto.randomUUID(), path: '/v1/financeiro/actions/category_delete', body: { data: { id: item.node.id, expected_version: item.node.version } } }; commands.current.set(item.id, command); }
    setRunning(true);
    try { await send(command); uncertain.current.delete(item.id); commands.current.delete(item.id); }
    catch (failure) { if (definitive(failure) && !replay) { commands.current.delete(item.id); throw new Error(failureText(failure)); } uncertain.current.add(item.id); return { uncertain: true, message: 'Resultado não confirmado. Use “Conferir resultado” para repetir a mesma exclusão.' }; }
  };
  const finishDelete = (state: NonNullable<typeof removal>, results: BatchResult[] | null) => { setRemoval(null); setRunning(false); if (results === null) return; const left = state.plan.eligible.filter(item => uncertain.current.has(item.id)); setPending(left.length ? left : null); setSelection({ key: '', ids: [] }); setNotice(`Excluir categorias: ${batchSummaryText(summarizeBatch(results))}.`); setReload(value => value + 1); };
  const exportTree = () => downloadFile(`categorias-${plural(kind)}.xlsx`, toXlsx(TAB_LABEL[kind], categorySheet(items, kind).map(row => row.map(textCell))) as unknown as BlobPart, XLSX_TYPE);
  const menuItems = (node: CategoryNode): RowMenuItem[] => {
    if (!writable) return [];
    const list: RowMenuItem[] = [];
    if (node.depth < maxDepth(kind) && node.active) list.push({ label: '+ Incluir subcategoria', icon: 'plus', onClick: () => open({ kind: 'create', parent: node.id }) });
    if (node.depth > 1) for (const entry of MENU_DEFAULTS.filter(item => item.kind === kind)) list.push({ label: entry.label, icon: 'star', disabled: node.defaults.includes(entry.key) || !node.active, title: node.defaults.includes(entry.key) ? 'Esta já é a categoria padrão.' : undefined, onClick: () => setDefault(node, entry.key) });
    list.push({ label: 'Editar', icon: 'pen-to-square', onClick: () => open({ kind: 'edit', node }) });
    list.push({ label: node.active ? 'Inativar' : 'Ativar', icon: node.active ? 'ban' : 'check', onClick: () => toggleActive(node) });
    list.push({ label: 'Excluir', icon: 'trash-can', separatorBefore: true, onClick: () => remove([node]) });
    return list;
  };
  const trees = receivable.tree && payable.tree ? { receivable: receivable.tree, payable: payable.tree } : null;
  if (!allowed) return <section className="real-state-panel"><h1>Consulta financeira indisponível</h1><p>Confirme sua sessão e seu acesso ao financeiro para continuar.</p></section>;
  return <>{(running || pending || quick) && <BusyGuard />}
    <header className="real-heading"><h1>Categorias Financeiras</h1>{access && !access.write && <span className="real-mode">Somente consulta</span>}</header>
    {notice && <p className="real-success" role="status">{notice}</p>}{error && <p className="real-alert" role="alert">{error}</p>}
    <nav className="finance-tabs" aria-label="Tipo de categoria">{(['receivable', 'payable'] as const).map(value => <button key={value} type="button" aria-current={kind === value ? 'page' : undefined} onClick={() => tab(value)}>{TAB_LABEL[value]}</button>)}</nav>
    <form onSubmit={event => { event.preventDefault(); setSearch(query.trim()); }} aria-label="Filtros das categorias"><NativeListLayout filters={<>
      <fieldset className="finance-option-filter"><legend>Situação</legend>{([[false, 'Todos'], [true, 'Ativo']] as const).map(([value, label]) => <label key={label} htmlFor={`category-situation-${label}`}><input id={`category-situation-${label}`} type="radio" name="category-situation" checked={draftActive === value} onChange={() => setDraftActive(value)} />{label}</label>)}</fieldset>
      <button type="button" className="primary-button" onClick={() => setOnlyActive(draftActive)}>Filtrar</button><button type="button" className="text-button" onClick={() => { setDraftActive(false); setOnlyActive(false); setQuery(''); setSearch(''); }}>Limpar filtros</button>
    </>} actions={<>
      {writable && <button type="button" className="primary-button" onClick={() => open({ kind: 'create', parent: null })}><Icon name="plus" size={16} />Incluir categoria de {plural(kind)}</button>}
      {writable && <button type="button" className="action-button" disabled={!trees} onClick={() => open({ kind: 'dre' })}><Icon name="chart-column" size={15} />Categorização para DRE</button>}
      {writable && <button type="button" className="action-button" disabled={!items.length} onClick={() => open({ kind: 'move' })}><Icon name="right-left" size={15} />Mover categorias</button>}
      {writable && <button type="button" className="action-button" disabled={!active.tree} onClick={() => open({ kind: 'import' })}><Icon name="file-import" size={15} />Importar categorias</button>}
      <button type="button" className="action-button" disabled={!active.tree} onClick={exportTree}><Icon name="file-export" size={15} />Exportar</button>
      <div className="native-list-summary"><h3>Informações</h3><dl className="native-list-stat"><dt>Quantidade de categorias</dt><dd>{active.tree ? items.length.toLocaleString('pt-BR') : '—'}</dd></dl></div>
    </>}>
      <div className="native-list-toolbar"><div className="form-field"><label htmlFor="category-search">Pesquisar na listagem</label><input id="category-search" type="search" maxLength={120} placeholder="Pesquise por nome da categoria.." value={query} onChange={event => setQuery(event.target.value)} /></div><button type="submit" className="secondary-button" title="Pesquisar" aria-label="Pesquisar"><Icon name="search" size={16} /></button>
        <div className="origin-toolbar-tools">{writable && financePermitted(access, 'financas.categorias.ex') && <ToolButton icon="trash-can" title="Excluir selecionadas" disabled={!chosen.length || Boolean(pending) || Boolean(removal)} onClick={() => remove(chosen)} />}<ToolButton icon="rotate-right" title="Recarregar" disabled={active.loading} onClick={() => setReload(value => value + 1)} /></div></div>
      <AppliedChips chips={[...(search ? [{ label: `Pesquisa: ${search}`, onRemove: () => { setQuery(''); setSearch(''); } }] : []), ...(onlyActive ? [{ label: 'Situação: Ativo', onRemove: () => { setDraftActive(false); setOnlyActive(false); } }] : [])]} onClear={() => { setQuery(''); setSearch(''); setDraftActive(false); setOnlyActive(false); }} />
      {quick?.uncertain && <p className="real-alert" role="alert">Resultado não confirmado. <button type="button" className="text-button" disabled={quick.busy} onClick={() => void runQuick(quick)}>Conferir resultado</button></p>}
      {pending && <p className="real-alert" role="alert">{pending.length === 1 ? '1 categoria' : `${pending.length} categorias`} sem resultado confirmado. <button type="button" className="text-button" disabled={Boolean(removal)} onClick={() => { if (!mayWrite()) return; uncertain.current = new Set(pending.map(item => item.id)); setRemoval({ key: routeKey, plan: { eligible: pending, skipped: [] }, recovery: true }); setPending(null); }}>Conferir resultado</button></p>}
      {active.error && <p className="real-alert" role="alert">{active.error} <button type="button" className="text-button" onClick={active.retry}>Tentar novamente</button></p>}
      <div className="real-result-status" role="status">{active.loading || !access ? 'Carregando categorias…' : active.tree ? `${rows.length} de ${items.length} categoria(s)` : ''}</div>
      {active.tree && <div className="table-scroll" tabIndex={0} role="region" aria-label={`Categorias de ${plural(kind)}`}><table className="data-table finance-table finance-category-table"><thead><tr>{writable && <th className="checkbox-cell"><span className="real-sr-only">Selecionar</span></th>}<th>Categorias</th><th className="row-actions"><span className="real-sr-only">Ações</span></th></tr></thead><tbody>
        <tr className="finance-category-root">{writable && <td />}<td><strong>{ROOT_LABEL[kind]}</strong></td><td className="row-actions">{writable && <RowMenu label={ROOT_LABEL[kind]} items={[{ label: `+ Incluir categoria de ${kind === 'receivable' ? 'Receitas' : 'Despesas'}`, icon: 'plus', onClick: () => open({ kind: 'create', parent: null }) }]} open={menu === 'root'} onToggle={() => setMenu(menu === 'root' ? null : 'root')} />}</td></tr>
        {rows.map(row => { const node = row.node, entries = menuItems(node);
          return <tr key={node.id} className={`finance-category-row level-${row.level}${node.active ? '' : ' inactive'}`}>
            {writable && <td className="checkbox-cell"><input type="checkbox" aria-label={`Selecionar ${node.name}`} checked={selected.includes(node.id)} onChange={event => toggleSelect(node.id, event.target.checked)} /></td>}
            <td><span className="finance-category-cell" style={{ paddingLeft: `${(row.level - 1) * 22}px` }}>{row.hasChildren && !search ? <button type="button" className="finance-tree-toggle" aria-label={`${expanded.has(node.id) ? 'Recolher' : 'Expandir'} ${node.name}`} aria-expanded={expanded.has(node.id)} onClick={() => toggleExpand(node.id)}><Icon name={expanded.has(node.id) ? 'chevron-down' : 'chevron-right'} size={10} /></button> : <span className="finance-tree-spacer" />}
              <span className="finance-category-name">{node.name}</span>{!node.active && <span className={badgeClass('Inativo')}>Inativo</span>}{node.defaults.map(key => <span key={key} className="finance-pill">{defaultPill(key)}</span>)}
              {node.dre_group && node.dre_group !== 'none' && <small className="real-help"> · {DRE_GROUPS[kind].find(group => group.value === node.dre_group)?.label}</small>}</span></td>
            <td className="row-actions">{entries.length > 0 && <RowMenu label={node.name} items={entries} open={menu === node.id} onToggle={() => setMenu(menu === node.id ? null : node.id)} />}</td></tr>; })}
      </tbody></table>{!items.length && <div className="empty-state"><h2>Nenhuma categoria de {plural(kind)}</h2><p>{writable ? `Inclua uma categoria de ${plural(kind)} ou importe a planilha.` : 'As categorias aparecem aqui quando cadastradas.'}</p></div>}</div>}
    </NativeListLayout></form>
    {panelVisible?.kind === 'create' && <CategoryDrawer kind={kind} items={items} node={null} parent={panelVisible.parent} send={send} mayWrite={mayWrite} onClose={() => setPanel(null)} onSaved={saved} />}
    {panelVisible?.kind === 'edit' && <CategoryDrawer kind={kind} items={items} node={panelVisible.node} parent={null} send={send} mayWrite={mayWrite} onClose={() => setPanel(null)} onSaved={saved} />}
    {panelVisible?.kind === 'dre' && trees && <DreDrawer trees={trees} send={send} mayWrite={mayWrite} onClose={() => setPanel(null)} onSaved={saved} />}
    {panelVisible?.kind === 'move' && <MoveDrawer kind={kind} items={items} send={send} mayWrite={mayWrite} onClose={() => setPanel(null)} onSaved={saved} />}
    {panelVisible?.kind === 'import' && <ImportDrawer kind={kind} items={items} send={send} mayWrite={mayWrite} onClose={() => setPanel(null)} onSaved={saved} />}
    {removal && removal.key === routeKey && <BatchDialog title={removal.recovery ? 'Conferir resultado' : 'Excluir categorias'} description={<p>{removal.recovery ? 'Cada categoria é enviada de novo com o mesmo comando.' : 'Deseja mesmo excluir as categorias selecionadas? Categorias com lançamentos ou subcategorias ficam de fora; para elas use Inativar.'}</p>}
      plan={removal.plan} confirmLabel={removal.recovery ? 'Conferir resultado' : 'Excluir'} canConfirm={writable} run={runDelete} onClose={results => finishDelete(removal, results)} />}
  </>;
}
