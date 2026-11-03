// Cadastros > Contas Financeiras e Categorias Financeiras do Origin (SQL 135): rótulos, rotas, leitura conferida das
// respostas e a árvore de categorias. Valores em centavos inteiros (texto), nunca em ponto flutuante.
import type { FinanceKind } from './real-finance-model.ts';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message: string): never => { throw new Error(message); };

export type AccountType = 'checking' | 'savings' | 'cash' | 'receiving' | 'other' | 'integration';
export const ACCOUNT_TYPES: readonly AccountType[] = ['checking', 'savings', 'cash', 'receiving', 'other', 'integration'];
/** "Tipo de Conta" do filtro e da coluna, nos termos do Origin. */
export const ACCOUNT_TYPE_LABEL: Readonly<Record<AccountType, string>> = { checking: 'Conta Corrente', savings: 'Conta Poupança', cash: 'Caixa', receiving: 'Conta Recebimento', other: 'Outros', integration: 'Integração de Pagamento' };
/** Cards do assistente "Tipo de Conta". */
export const ACCOUNT_TYPE_CARDS: readonly { type: Exclude<AccountType, 'integration'>; label: string }[] = [
  { type: 'checking', label: 'Conta Corrente' }, { type: 'savings', label: 'Poupança ou Investimento' }, { type: 'cash', label: 'Caixa' },
  { type: 'receiving', label: 'Conta de Recebimento (ex. Mercado Pago, Vindi)' }, { type: 'other', label: 'Outros' }];
export const needsInstitution = (type: AccountType) => type === 'checking' || type === 'savings' || type === 'receiving';
export const isBankType = (type: AccountType) => type === 'checking' || type === 'savings';
export const BOLETO_LABEL = { default: 'Padrão boleto', active: 'Ativo', none: 'Sem integração' } as const;

export interface FinancialAccount {
  id: string; name: string; kind: 'bank' | 'cash' | 'other'; account_type: AccountType; institution_code: string | null; institution_name: string | null;
  agency: string | null; account_number: string | null; account_digit: string | null; start_on: string | null; active: boolean;
  default_movements: boolean; default_boleto: boolean; boleto: keyof typeof BOLETO_LABEL; opening_recorded: boolean; opening_cents: string | null;
  balance_cents: string; first_movement_on: string | null; in_use: boolean; cnab: { bank: string | null; agency: string | null; account: string | null; account_digit: string | null } | null;
  version: number; created_at: string; updated_at: string;
}
export interface AccountPage { items: FinancialAccount[]; page: number; limit: number; total: number }
export type AccountSituation = 'ativo' | 'inativo' | 'todos';
export interface AccountsRoute { q: string; situacao: AccountSituation; tipos: AccountType[]; page: number }
export const ACCOUNTS_PAGE_SIZE = 100;
const text = (value: unknown, max: number, nullable = false) => (nullable && value === null) || (typeof value === 'string' && value.length <= max);
const day = (value: unknown, nullable = false) => (nullable && value === null) || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value));
const cents = (value: unknown, signed = false) => typeof value === 'string' && (signed ? /^-?\d{1,30}$/ : /^\d{1,30}$/).test(value);

/** URL of Cadastros > Contas Financeiras: Situação defaults to Ativo, as in Origin ("Situação: Ativo ×"). */
export function accountsRoute(params: URLSearchParams): AccountsRoute {
  const situacao = params.get('situacao') ?? 'ativo', tipos = params.get('tipos'), page = params.get('pagina') ?? '1', q = params.get('q') ?? '';
  if (!['ativo', 'inativo', 'todos'].includes(situacao) || !/^[1-9]\d{0,5}$/.test(page) || q.length > 120 || /[\x00-\x1f\x7f]/.test(q)) fail('Filtros inválidos no endereço.');
  const list = tipos ? tipos.split(',') : [];
  if (list.some(type => !ACCOUNT_TYPES.includes(type as AccountType)) || new Set(list).size !== list.length) fail('Filtros inválidos no endereço.');
  return { q, situacao: situacao as AccountSituation, tipos: list as AccountType[], page: Number(page) };
}
export function accountsParams(route: AccountsRoute): URLSearchParams {
  const params = new URLSearchParams({ area: 'contas-financeiras' });
  if (route.q) params.set('q', route.q); if (route.situacao !== 'ativo') params.set('situacao', route.situacao);
  if (route.tipos.length) params.set('tipos', route.tipos.join(',')); if (route.page > 1) params.set('pagina', String(route.page));
  return params;
}
export function accountsApiPath(route: AccountsRoute): string {
  const params = new URLSearchParams({ page: String(route.page), limit: String(ACCOUNTS_PAGE_SIZE) });
  if (route.q.trim()) params.set('q', route.q.trim()); if (route.situacao !== 'todos') params.set('situacao', route.situacao);
  if (route.tipos.length) params.set('tipos', route.tipos.join(','));
  return `/v1/financeiro/contas-financeiras?${params}`;
}
export function financialAccount(value: unknown): FinancialAccount {
  const failure = 'Não foi possível conferir a conta financeira.';
  if (!object(value) || !UUID.test(String(value.id)) || !text(value.name, 200) || !['bank', 'cash', 'other'].includes(String(value.kind)) || !ACCOUNT_TYPES.includes(value.account_type as AccountType)
    || !text(value.institution_code, 3, true) || !text(value.institution_name, 80, true) || !text(value.agency, 10, true) || !text(value.account_number, 20, true) || !text(value.account_digit, 2, true)
    || !day(value.start_on, true) || typeof value.active !== 'boolean' || typeof value.default_movements !== 'boolean' || typeof value.default_boleto !== 'boolean'
    || !Object.hasOwn(BOLETO_LABEL, String(value.boleto)) || typeof value.opening_recorded !== 'boolean' || (value.opening_cents !== null && !cents(value.opening_cents, true))
    || !cents(value.balance_cents, true) || !day(value.first_movement_on, true) || typeof value.in_use !== 'boolean' || !Number.isSafeInteger(value.version) || (value.version as number) < 1
    || (value.cnab !== null && !object(value.cnab))) fail(failure);
  return value as unknown as FinancialAccount;
}
export function accountPage(value: unknown, route: AccountsRoute): AccountPage {
  if (!object(value) || value.entity !== 'financial_accounts' || value.page !== route.page || value.limit !== ACCOUNTS_PAGE_SIZE || !Number.isSafeInteger(value.total) || (value.total as number) < 0 || !Array.isArray(value.items)) fail('Não foi possível conferir as contas financeiras.');
  const page = value as { items: unknown[]; total: number };
  const items = page.items.map(financialAccount);
  if (items.some(item => (route.situacao === 'ativo' && !item.active) || (route.situacao === 'inativo' && item.active) || (route.tipos.length && !route.tipos.includes(item.account_type)))) fail('Não foi possível conferir as contas financeiras.');
  return { items, page: route.page, limit: ACCOUNTS_PAGE_SIZE, total: page.total };
}
export const accountMenuShape = (account: FinancialAccount) => account.account_type === 'integration' ? 'none' : account.account_type === 'cash' ? 'cash' : 'full';
export const accountBankText = (account: Pick<FinancialAccount, 'agency' | 'account_number' | 'account_digit'>) => account.agency && account.account_number ? `Ag. ${account.agency} · C/C ${account.account_number}${account.account_digit ? `-${account.account_digit}` : ''}` : '';

// ---------------------------------------------------------------- Categorias financeiras (árvore)
export type DreGroup = 'none' | 'gross_revenue' | 'financial_revenue' | 'other_revenue' | 'revenue_deductions' | 'operating_expenses' | 'financial_expenses' | 'other_expenses' | 'income_taxes';
export const DRE_GROUPS: Readonly<Record<FinanceKind, readonly { value: DreGroup; label: string }[]>> = {
  receivable: [{ value: 'none', label: 'Não Exibir no DRE' }, { value: 'gross_revenue', label: 'Receita Operacional Bruta' }, { value: 'financial_revenue', label: 'Receita Financeira' }, { value: 'other_revenue', label: 'Outras Receitas' }],
  payable: [{ value: 'none', label: 'Não Exibir no DRE' }, { value: 'revenue_deductions', label: 'Deduções da Receita Bruta' }, { value: 'operating_expenses', label: 'Despesas Operacionais' }, { value: 'financial_expenses', label: 'Despesa Financeira' }, { value: 'other_expenses', label: 'Outras Despesas' }, { value: 'income_taxes', label: 'IR e CSLL' }],
};
export type DefaultKey = 'receipt_additions' | 'receipt_interest' | 'receipt_discounts' | 'receipt_fees' | 'payment_additions' | 'payment_interest' | 'payment_discounts' | 'sale' | 'service' | 'transfer_in' | 'purchase';
/** Categorização para DRE: chave, rótulo do Origin e o tipo da categoria escolhida. */
export const DRE_DEFAULTS: readonly { section: 'Operações de Recebimento' | 'Operações de Pagamento'; key: DefaultKey; label: string; kind: FinanceKind; pill: string }[] = [
  { section: 'Operações de Recebimento', key: 'receipt_additions', label: 'Acréscimos de receita', kind: 'receivable', pill: 'Padrão para acréscimos no recebimento' },
  { section: 'Operações de Recebimento', key: 'receipt_interest', label: 'Juros', kind: 'receivable', pill: 'Padrão para juros no recebimento' },
  { section: 'Operações de Recebimento', key: 'receipt_discounts', label: 'Descontos', kind: 'payable', pill: 'Padrão para descontos no recebimento' },
  { section: 'Operações de Recebimento', key: 'receipt_fees', label: 'Taxas', kind: 'payable', pill: 'Padrão para taxas no recebimento' },
  { section: 'Operações de Pagamento', key: 'payment_additions', label: 'Acréscimos de despesa', kind: 'payable', pill: 'Padrão para acréscimos no pagamento' },
  { section: 'Operações de Pagamento', key: 'payment_interest', label: 'Juros', kind: 'payable', pill: 'Padrão para juros no pagamento' },
  { section: 'Operações de Pagamento', key: 'payment_discounts', label: 'Descontos', kind: 'receivable', pill: 'Padrão para descontos no pagamento' },
];
/** Padrões do menu ⋮ das subcategorias (Origin: Padrão venda | Padrão serviço | Padrão transferência recebida | Padrão compra). */
export const MENU_DEFAULTS: readonly { key: DefaultKey; label: string; kind: FinanceKind }[] = [
  { key: 'sale', label: 'Padrão venda', kind: 'receivable' }, { key: 'service', label: 'Padrão serviço', kind: 'receivable' },
  { key: 'transfer_in', label: 'Padrão transferência recebida', kind: 'receivable' }, { key: 'purchase', label: 'Padrão compra', kind: 'payable' }];
export const DEFAULT_KEYS: readonly DefaultKey[] = [...DRE_DEFAULTS.map(item => item.key), ...MENU_DEFAULTS.map(item => item.key)];
export const defaultPill = (key: DefaultKey) => DRE_DEFAULTS.find(item => item.key === key)?.pill ?? MENU_DEFAULTS.find(item => item.key === key)!.label;
export const ROOT_LABEL: Readonly<Record<FinanceKind, string>> = { receivable: '1. RECEITAS', payable: '2. DESPESAS' };
export const TAB_LABEL: Readonly<Record<FinanceKind, string>> = { receivable: 'Receitas', payable: 'Despesas' };
export const maxDepth = (kind: FinanceKind) => kind === 'payable' ? 3 : 2;

export interface CategoryNode { id: string; parent_id: string | null; name: string; kind: FinanceKind; dre_group: DreGroup | null; active: boolean; depth: number; defaults: DefaultKey[]; children: number; in_use: boolean; version: number; updated_at: string }
export interface CategoryTree { kind: FinanceKind; items: CategoryNode[]; defaults: Record<DefaultKey, { category_id: string | null; version: number }> }
export function categoryTree(value: unknown, kind: FinanceKind): CategoryTree {
  const failure = 'Não foi possível conferir as categorias financeiras.';
  if (!object(value) || value.entity !== 'category_tree' || value.kind !== kind || !Array.isArray(value.items) || value.items.length > 2000 || !object(value.defaults)) fail(failure);
  const raw = value as { items: unknown[]; defaults: Record<string, unknown> };
  const items = raw.items.map(item => {
    if (!object(item) || !UUID.test(String(item.id)) || (item.parent_id !== null && !UUID.test(String(item.parent_id))) || !text(item.name, 200) || item.kind !== kind || typeof item.active !== 'boolean'
      || !Number.isSafeInteger(item.depth) || (item.depth as number) < 1 || (item.depth as number) > maxDepth(kind) || (item.depth === 1) !== (item.parent_id === null)
      || (item.dre_group !== null && !DRE_GROUPS[kind].some(group => group.value === item.dre_group)) || !Array.isArray(item.defaults) || item.defaults.some(key => !DEFAULT_KEYS.includes(key as DefaultKey))
      || !Number.isSafeInteger(item.children) || typeof item.in_use !== 'boolean' || !Number.isSafeInteger(item.version)) fail(failure);
    return item as unknown as CategoryNode;
  });
  const ids = new Set(items.map(item => item.id));
  if (ids.size !== items.length || items.some(item => item.parent_id !== null && !ids.has(item.parent_id))) fail(failure);
  const defaults = {} as CategoryTree['defaults'];
  for (const key of DEFAULT_KEYS) { const entry = raw.defaults[key]; if (!object(entry) || (entry.category_id !== null && !UUID.test(String(entry.category_id))) || !Number.isSafeInteger(entry.version)) fail(failure); defaults[key] = { category_id: (entry as { category_id: string | null }).category_id, version: (entry as { version: number }).version }; }
  return { kind, items, defaults };
}
export interface TreeRow { node: CategoryNode; level: number; hasChildren: boolean; path: string }
const byName = (a: CategoryNode, b: CategoryNode) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }) || a.id.localeCompare(b.id);
export const childrenOf = (items: readonly CategoryNode[], parent: string | null) => items.filter(item => item.parent_id === parent).sort(byName);
/** Every descendant id of a node (the node excluded). */
export function descendants(items: readonly CategoryNode[], id: string): string[] {
  const out: string[] = []; const walk = (parent: string) => { for (const child of items.filter(item => item.parent_id === parent)) { out.push(child.id); walk(child.id); } }; walk(id); return out;
}
export function ancestors(items: readonly CategoryNode[], id: string): string[] {
  const out: string[] = []; let current = items.find(item => item.id === id);
  while (current?.parent_id) { out.push(current.parent_id); current = items.find(item => item.id === current!.parent_id); }
  return out;
}
const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/**
 * Visible rows of the tree: alphabetical at every level, children under expanded parents; a search shows the matches and
 * their ancestors (expanded); Situação "Ativo" hides inactive categories.
 */
export function treeRows(items: readonly CategoryNode[], options: { expanded: ReadonlySet<string>; query?: string; onlyActive?: boolean }): TreeRow[] {
  const query = fold(options.query?.trim() ?? ''), pool = options.onlyActive ? items.filter(item => item.active) : [...items];
  const keep = new Set<string>(); const forced = new Set<string>();
  if (query) { for (const item of pool) if (fold(item.name).includes(query)) { keep.add(item.id); for (const up of ancestors(pool, item.id)) { keep.add(up); forced.add(up); } } }
  const rows: TreeRow[] = [];
  const walk = (parent: string | null, level: number, path: string) => {
    for (const node of childrenOf(pool, parent)) {
      if (query && !keep.has(node.id)) continue;
      const kids = childrenOf(pool, node.id).filter(child => !query || keep.has(child.id)), label = `${path}${node.name}`;
      rows.push({ node, level, hasChildren: kids.length > 0, path: label });
      if (options.expanded.has(node.id) || forced.has(node.id)) walk(node.id, level + 1, `${label} > `);
    }
  };
  walk(null, 1, '');
  return rows;
}
/** Tree multi-select: checking a category checks its subcategorias too, as in the Origin tree. */
export function toggleTreeSelection(items: readonly CategoryNode[], selected: readonly string[], id: string, checked: boolean): string[] {
  const affected = id === 'none' ? ['none'] : [id, ...descendants(items, id)];
  return checked ? [...selected.filter(value => !affected.includes(value)), ...affected] : selected.filter(value => !affected.includes(value));
}
export function categoryPathName(items: readonly CategoryNode[], id: string): string {
  const node = items.find(item => item.id === id); if (!node) return '';
  return [...ancestors(items, id).reverse().map(up => items.find(item => item.id === up)?.name ?? ''), node.name].join(' > ');
}

// Planilha de categorias (modelo, importar e exportar): Nome da categoria | Categoria pai | Grupo de DRE.
export const CATEGORY_SHEET_HEADERS = ['Nome da categoria', 'Categoria pai', 'Grupo de DRE'] as const;
export function categorySheet(items: readonly CategoryNode[], kind: FinanceKind): string[][] {
  const rows: string[][] = [[...CATEGORY_SHEET_HEADERS]];
  const walk = (parent: string | null) => { for (const node of childrenOf(items, parent)) { rows.push([node.name, parent ? items.find(item => item.id === parent)!.name : '', node.dre_group ? DRE_GROUPS[kind].find(group => group.value === node.dre_group)!.label : '']); walk(node.id); } };
  walk(null);
  return rows;
}
export interface CategoryImportRow { line: number; name: string; parent: string | null; dre_group: DreGroup | null }
/**
 * Lines of the attached sheet checked against the tab: names up to 100 characters, a parent known in the tab or earlier in the
 * file (parents first), the DRE group only on main categories, the depth of the tab. Lines that already exist are skipped by SQL.
 */
export function categoryImportRows(records: readonly { line: number; values: Record<string, string> }[], kind: FinanceKind, existing: readonly CategoryNode[]): { rows: CategoryImportRow[]; errors: string[] } {
  const errors: string[] = [], rows: CategoryImportRow[] = [];
  const depth = new Map<string, number>(); const count = new Map<string, number>();
  const remember = (name: string, level: number) => { const key = fold(name); count.set(key, (count.get(key) ?? 0) + 1); if (!depth.has(key)) depth.set(key, level); };
  for (const item of existing) remember(item.name, item.depth);
  // As in "Nova categoria" (and in SQL), a subcategoria is not created under an inactive parent.
  const inactive = new Set(existing.filter(item => !item.active).map(item => fold(item.name)));
  // A line equal to an existing category at the same level is skipped by SQL: it does not make its name ambiguous.
  const pairs = new Set(existing.map(item => `${fold(item.parent_id ? existing.find(up => up.id === item.parent_id)?.name ?? '' : '')}|${fold(item.name)}`));
  for (const record of records) {
    const name = record.values['Nome da categoria'] ?? '', parent = (record.values['Categoria pai'] ?? '') || null, group = record.values['Grupo de DRE'] ?? '';
    if (!name || name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) { errors.push(`Linha ${record.line}: informe o nome da categoria (até 100 caracteres).`); continue; }
    let dre: DreGroup | null = null;
    if (group) { const found = DRE_GROUPS[kind].find(item => fold(item.label) === fold(group)); if (!found) { errors.push(`Linha ${record.line}: grupo de DRE "${group}" não existe em ${TAB_LABEL[kind]}.`); continue; } if (parent) { errors.push(`Linha ${record.line}: o grupo de DRE vale só para a categoria principal.`); continue; } dre = found.value; }
    let level = 1;
    if (parent) {
      const key = fold(parent);
      if (!depth.has(key)) { errors.push(`Linha ${record.line}: a categoria pai "${parent}" não existe nesta aba nem nas linhas anteriores.`); continue; }
      if ((count.get(key) ?? 0) > 1) { errors.push(`Linha ${record.line}: há mais de uma categoria "${parent}"; renomeie antes de importar.`); continue; }
      if (inactive.has(key)) { errors.push(`Linha ${record.line}: a categoria pai "${parent}" está inativa; ative-a antes de importar.`); continue; }
      level = depth.get(key)! + 1;
      if (level > maxDepth(kind)) { errors.push(`Linha ${record.line}: ${TAB_LABEL[kind]} aceitam até ${maxDepth(kind)} níveis.`); continue; }
    }
    rows.push({ line: record.line, name, parent, dre_group: dre });
    const pair = `${fold(parent ?? '')}|${fold(name)}`; if (!pairs.has(pair)) { pairs.add(pair); remember(name, level); }
  }
  if (rows.length > 500) errors.push('Importe até 500 categorias por vez.');
  return { rows, errors };
}
