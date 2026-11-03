import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { runBatch } from '../src/lib/origin-batch.ts';
import { categoryTreeResponse, chooseCategory } from './helpers/finance-category-tree-fixture.mjs';
import { todaySP } from '../src/lib/real-finance-model.ts';

// Synthetic data only. 135: Cadastros > Contas Financeiras (list, ⋮, assistente) and Categorias Financeiras (tree, drawers, import, lixeira).
globalThis.document = { activeElement: null };
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = '40000000-0000-4000-8000-000000000001', TODAY = todaySP();
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const child = (view, name) => view.nodes().find(node => typeof node.type === 'function' && node.type.name === name);
const children = (view, name) => view.nodes().filter(node => typeof node.type === 'function' && node.type.name === name);
const buttons = (view, label) => view.nodes().filter(node => node.type === 'button' && text(node) === label);
const modalButton = async (view, label) => { const modal = child(view, 'Modal'); const found = [modal.props.actions].flat().flatMap(node => node?.props?.children !== undefined && node.type !== 'button' ? [node.props.children].flat() : [node]).find(node => node?.type === 'button' && text(node) === label); assert.ok(found, `modal button ${label}`); assert.equal(Boolean(found.props.disabled), false, `${label} enabled`); found.props.onClick(); await view.flush(); };
const switchOf = (view, label) => view.find(node => node.type === 'label' && text(node) === label).props.children.find(item => item?.type === 'input');
const menuOf = (view, label) => children(view, 'RowMenu').find(menu => menu.props.label === label);
const field = (view, label) => view.input(view.find(node => node.type === 'label' && text(node).replace(/\s+$/, '') === label).props.htmlFor);
const account = (n, extra = {}) => ({ id: id(n), name: `Conta ${n}`, kind: 'bank', account_type: 'checking', institution_code: '341', institution_name: 'Itaú Unibanco', agency: '1234', account_number: '5678', account_digit: '9', start_on: '2026-01-01', active: true,
  default_movements: false, default_boleto: false, boleto: 'none', opening_recorded: true, opening_cents: '1000', balance_cents: '1000', first_movement_on: '2026-01-01', in_use: true, cnab: null, version: 3, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z', ...extra });
const ROWS = [account(1, { default_boleto: true, boleto: 'default', cnab: { bank: '341', agency: '1234', account: '5678', account_digit: '9' } }), account(2, { account_type: 'cash', kind: 'cash', name: 'Caixa da loja', institution_code: null, institution_name: null, agency: null, account_number: null, account_digit: null }),
  account(3, { account_type: 'integration', kind: 'other', name: 'Integração', institution_code: null, institution_name: null, agency: null, account_number: null, account_digit: null }), account(4, { name: 'Sem uso', in_use: false, boleto: 'none' })];

function server({ role = 'financeiro', rows = ROWS, post = () => ({}), before, tree = {}, permitted } = {}) {
  const calls = [], listeners = new Set(), state = { session: { phase: 'ready', membership: { user_id: actor, role } } };
  const controller = {
    getSnapshot: () => state.session, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, retry() {},
    async finance(path, options = {}) {
      const call = { path, ...options, body: options.body ? structuredClone(options.body) : undefined }; calls.push(call);
      const injected = await before?.(call); if (injected !== undefined) return injected;
      if (path === '/v1/financeiro') return { read: true, write: role !== 'consulta', ...(permitted ? { permitted } : {}), data_mode: 'erp_native' };
      if (options.method === 'POST') return post(call);
      const url = new URL(path, 'https://synthetic.invalid');
      if (url.pathname === '/v1/financeiro/contas-financeiras') { const situation = url.searchParams.get('situacao'), types = url.searchParams.get('tipos')?.split(','); const items = rows.filter(row => (!situation || row.active === (situation === 'ativo')) && (!types || types.includes(row.account_type))); return { entity: 'financial_accounts', page: Number(url.searchParams.get('page')), limit: 100, total: items.length, items: structuredClone(items), data_mode: 'erp_native' }; }
      const detail = /^\/v1\/financeiro\/contas-financeiras\/(.+)$/.exec(url.pathname); if (detail) return { entity: 'financial_accounts', record: structuredClone(rows.find(row => row.id === detail[1])), data_mode: 'erp_native' };
      if (url.pathname === '/v1/financeiro/categorias-arvore') { const kind = url.searchParams.get('kind'); return categoryTreeResponse(kind, tree[kind] ?? [], tree.defaults); }
      throw new Error(`Unexpected ${path}`);
    },
  };
  return { calls, controller, posts: () => calls.filter(call => call.method === 'POST'), setSession(next) { state.session = next; for (const listener of listeners) listener(); } };
}
const mountAccounts = (source, location = '/financeiro-empresa?area=contas-financeiras') => mountComponent('FinanceAccountsRegistry.tsx', { controller: source.controller }, { location, expandChildren: ['NativeListLayout', 'Field', 'FinanceAccountEditor', 'BusyGuard'] });
const mountTree = (source, location = '/financeiro-empresa?area=categories') => mountComponent('FinanceCategoryTree.tsx', { controller: source.controller }, { location, expandChildren: ['NativeListLayout', 'Field', 'BusyGuard', 'Drawer', 'CategoryDrawer', 'DreDrawer', 'MoveDrawer', 'ImportDrawer', 'CategoryTreePicker', 'TreeList'] });

test('135 Contas Financeiras lists Situação Ativo by default with the Origin columns, badges, Informações and the ⋮ by type', async () => {
  const source = server(), view = await mountAccounts(source);
  try {
    assert.equal(source.calls.find(call => call.path.startsWith('/v1/financeiro/contas-financeiras')).path, '/v1/financeiro/contas-financeiras?page=1&limit=100&situacao=ativo');
    assert.deepEqual(view.nodes().filter(node => node.type === 'th').map(text).slice(0, 6), ['Instituição', 'Descrição', 'Tipo', 'Situação', 'Emissão de boleto', 'Tipo de conta']);
    assert.match(view.text(), /Quantidade de contas financeiras4/); assert.match(view.text(), /Padrão boleto/); assert.match(view.text(), /Sem integração/); assert.match(view.text(), /Integração de Pagamento/);
    assert.deepEqual(child(view, 'AppliedChips').props.chips.map(chip => chip.label), ['Situação: Ativo']);
    assert.deepEqual(menuOf(view, 'Conta 1').props.items.map(item => item.label), ['Editar', 'Inativar', 'Desmarcar padrão boleto', 'Tornar padrão movimentações', 'Excluir']);
    assert.equal(menuOf(view, 'Conta 1').props.items.at(-1).disabled, true, 'an account in use cannot be excluded');
    assert.deepEqual(menuOf(view, 'Caixa da loja').props.items.map(item => item.label), ['Tornar padrão movimentações']);
    assert.equal(menuOf(view, 'Integração'), undefined, 'an integration account has no ⋮');
    assert.equal(menuOf(view, 'Sem uso').props.items.find(item => item.label === 'Excluir').disabled, false);
    assert.equal(menuOf(view, 'Sem uso').props.items.some(item => /boleto/.test(item.label)), false, 'boleto items need the cobrança bancária');
    // Filtrar: Situação Inativo and Tipo de Conta go to the URL, the API and the chips.
    await view.change('account-situation-inativo', true); await view.change('account-type-filter-savings', true); await view.submit();
    assert.equal(view.location().search, '?area=contas-financeiras&situacao=inativo&tipos=savings');
    assert.equal(source.calls.at(-1).path, '/v1/financeiro/contas-financeiras?page=1&limit=100&situacao=inativo&tipos=savings');
    assert.deepEqual(child(view, 'AppliedChips').props.chips.map(chip => chip.label), ['Situação: Inativo', 'Tipo de Conta: Conta Poupança']);
    assert.ok(source.calls.every(call => !call.method), 'reading never writes');
  } finally { view.unmount(); }
});

test('135 ⋮ Tornar padrão movimentações confirms, sends one versioned command and recovers an uncertain result with the same command', async () => {
  let fail = 1; const source = server({ post: () => { if (fail-- > 0) throw new AccessError(503); return { action: 'account_set_default', replayed: false, entity: 'financial_accounts', record: account(4), data_mode: 'erp_native' }; } }), view = await mountAccounts(source);
  try {
    menuOf(view, 'Sem uso').props.items.find(item => item.label === 'Tornar padrão movimentações').onClick(); await view.flush();
    assert.match(view.text(), /Tornar “Sem uso” a conta padrão de movimentações\? A conta padrão atual deixa de ser\./);
    await modalButton(view, 'Confirmar');
    const first = source.posts()[0];
    assert.equal(first.path, '/v1/financeiro/actions/account_set_default');
    assert.deepEqual(first.body.data, { id: id(4), expected_version: 3, target: 'movements', value: true });
    assert.equal(view.guard().busy, true, 'an unconfirmed result keeps the leave guard');
    await modalButton(view, 'Conferir depois'); assert.match(view.text(), /sem resultado confirmado/);
    menuOf(view, 'Conta 1').props.items.find(item => item.label === 'Inativar').onClick(); await view.flush();
    assert.equal(child(view, 'Modal'), undefined, 'another action waits for the unconfirmed one');
    await view.click('Conferir resultado'); await modalButton(view, 'Conferir resultado');
    assert.equal(source.posts().length, 2); assert.equal(source.posts()[1].body.command_id, first.body.command_id); assert.deepEqual(source.posts()[1].body.data, first.body.data);
    assert.match(view.text(), /Conta padrão de movimentações: Sem uso\./);
  } finally { view.unmount(); }
});

test('135 assistente "Incluir conta financeira": tipo em cards, instituição, dados bancários e saldo inicial; Adicionar Conta with recovery', async () => {
  let fail = 1; const created = account(9, { name: 'Itaú principal' });
  const source = server({ post: () => { if (fail-- > 0) throw new AccessError(502); return { action: 'account_create', replayed: false, entity: 'financial_accounts', record: created, data_mode: 'erp_native' }; } }), view = await mountAccounts(source);
  try {
    await view.click('Incluir conta financeira'); assert.equal(view.location().search, '?area=contas-financeiras&incluir=1');
    assert.deepEqual(view.nodes().filter(node => node.type === 'nav').flatMap(nav => view.nodes().filter(node => node.type === 'button' && ['Tipo de Conta', 'Dados da Conta', 'Emissão de Boleto'].includes(text(node)))).map(text), ['Tipo de Conta', 'Dados da Conta', 'Emissão de Boleto']);
    await view.submit(); assert.match(view.text(), /Informe a descrição da conta/); assert.equal(source.posts().length, 0);
    await view.change(field(view, 'Descrição *').props.id, 'Itaú principal'); assert.match(view.text(), /14\/50/);
    await view.submit(); assert.match(view.text(), /Busque e selecione a instituição/);
    await view.change(field(view, 'Busque pela instituição *').props.id, 'itau'); await view.click('341 - Itaú Unibanco');
    await view.submit(); assert.match(view.text(), /agência, a conta e o DV/);
    await view.change(field(view, 'Agência *').props.id, '1234'); await view.change(field(view, 'Conta *').props.id, '56789'); await view.change(field(view, 'DV *').props.id, '0');
    await view.change(field(view, 'Saldo inicial da conta (R$) *').props.id, '-1.000,00'); await view.submit(); assert.match(view.text(), /vírgula/);
    await view.change(field(view, 'Saldo inicial da conta (R$) *').props.id, '-1000,50');
    switchOf(view, 'Tornar conta padrão de movimentações').props.onChange({ target: { checked: true } });
    await view.flush(); await view.submit();
    const first = source.posts()[0];
    assert.equal(first.path, '/v1/financeiro/actions/account_create');
    assert.deepEqual(first.body.data, { account_type: 'checking', institution_code: '341', institution_name: 'Itaú Unibanco', name: 'Itaú principal', agency: '1234', account_number: '56789', account_digit: '0', start_on: TODAY, default_movements: true, opening_cents: '-100050' });
    assert.match(view.text(), /Conferir resultado/); assert.equal(view.find(node => node.type === 'fieldset' && node.props.className === 'finance-account-fieldset').props.disabled, true, 'the form is locked while unconfirmed');
    assert.equal(buttons(view, 'Conferir resultado')[0].props.type, 'submit'); await view.submit();
    assert.equal(source.posts()[1].body.command_id, first.body.command_id); assert.deepEqual(source.posts()[1].body.data, first.body.data);
    assert.equal(view.location().search, '?area=contas-financeiras'); assert.match(view.text(), /Conta financeira “Itaú principal” incluída\./);
  } finally { view.unmount(); }
  // Caixa e Outros vão direto para Dados da conta: no instituição and no bank fields.
  const cash = server({ post: call => ({ action: 'account_create', replayed: false, entity: 'financial_accounts', record: account(8, { account_type: 'cash', kind: 'cash', name: call.body.data.name }), data_mode: 'erp_native' }) }), other = await mountAccounts(cash, '/financeiro-empresa?area=contas-financeiras&incluir=1');
  try {
    await other.change('account-type-cash', true);
    assert.equal(other.nodes().some(node => node.type === 'label' && /instituição|Agência/.test(text(node))), false);
    await other.change(field(other, 'Descrição *').props.id, 'Caixa'); await other.submit();
    assert.deepEqual(cash.posts()[0].body.data, { account_type: 'cash', institution_code: null, institution_name: null, name: 'Caixa', agency: null, account_number: null, account_digit: null, start_on: TODAY, default_movements: false, opening_cents: '0' });
  } finally { other.unmount(); }
});

test('135 Editar reads the account again; consulta sees it read-only; a role change sends nothing', async () => {
  const source = server({ role: 'consulta' }), view = await mountAccounts(source, `/financeiro-empresa?area=contas-financeiras&editar=${id(1)}`);
  try {
    assert.ok(source.calls.some(call => call.path === `/v1/financeiro/contas-financeiras/${id(1)}`));
    assert.equal(buttons(view, 'Atualizar Conta').length, 0); assert.match(view.text(), /consulta a conta, sem alterar/);
    assert.equal(view.find(node => node.type === 'fieldset' && node.props.className === 'finance-account-fieldset').props.disabled, true);
    assert.match(view.text(), /Cobrança bancária configurada: banco 341, agência 1234, conta 5678-9/);
  } finally { view.unmount(); }
  const writer = server(), edit = await mountAccounts(writer, `/financeiro-empresa?area=contas-financeiras&editar=${id(1)}`);
  try {
    assert.equal(field(edit, 'Saldo inicial da conta (R$) *').props.readOnly, true, 'the recorded opening is not edited here');
    await edit.change(field(edit, 'Descrição *').props.id, 'Conta 1 editada');
    writer.setSession({ phase: 'ready', membership: { user_id: actor, role: 'consulta' } }); await edit.flush();
    assert.equal(writer.posts().length, 0);
  } finally { edit.unmount(); }
  const list = server(), rows = await mountAccounts(list);
  try {
    menuOf(rows, 'Sem uso').props.items.find(item => item.label === 'Excluir').onClick(); await rows.flush();
    list.setSession({ phase: 'ready', membership: { user_id: actor, role: 'consulta' } }); await rows.flush();
    assert.equal(list.posts().length, 0, 'nothing is sent after the role change');
  } finally { rows.unmount(); }
});

const RECEITAS = [{ id: id(10), name: 'Vendas', dre_group: 'gross_revenue' }, { id: id(11), name: 'Vendas de produtos', parent_id: id(10), defaults: ['sale'] }, { id: id(12), name: 'Receitas financeiras', in_use: true }];
const DESPESAS = [{ id: id(20), name: 'Despesas administrativas' }, { id: id(21), name: 'Aluguel', parent_id: id(20) }, { id: id(22), name: 'Tarifa bancária', defaults: ['receipt_fees'] }];

test('135 Categorias Financeiras: tabs, root group, expandable tree, default pills and the ⋮ of each level', async () => {
  const source = server({ tree: { receivable: RECEITAS, payable: DESPESAS } }), view = await mountTree(source);
  try {
    assert.match(view.text(), /1\. RECEITAS/); assert.match(view.text(), /Receitas financeiras/); assert.doesNotMatch(view.text(), /Vendas de produtos/, 'collapsed');
    assert.deepEqual(menuOf(view, '1. RECEITAS').props.items.map(item => item.label), ['+ Incluir categoria de Receitas']);
    assert.deepEqual(menuOf(view, 'Vendas').props.items.map(item => item.label), ['+ Incluir subcategoria', 'Editar', 'Inativar', 'Excluir']);
    view.find(node => node.type === 'button' && node.props['aria-label'] === 'Expandir Vendas').props.onClick(); await view.flush();
    assert.match(view.text(), /Vendas de produtosPadrão venda/);
    assert.deepEqual(menuOf(view, 'Vendas de produtos').props.items.map(item => item.label), ['Padrão venda', 'Padrão serviço', 'Padrão transferência recebida', 'Editar', 'Inativar', 'Excluir']);
    assert.equal(menuOf(view, 'Vendas de produtos').props.items[0].disabled, true, 'already the default');
    assert.match(view.text(), /Incluir categoria de receitas/);
    await view.click('Despesas'); assert.equal(view.location().search, '?area=categories&tipo=despesas');
    assert.match(view.text(), /2\. DESPESAS/); assert.match(view.text(), /Tarifa bancáriaPadrão para taxas no recebimento/);
    view.find(node => node.type === 'button' && node.props['aria-label'] === 'Expandir Despesas administrativas').props.onClick(); await view.flush();
    assert.deepEqual(menuOf(view, 'Aluguel').props.items.map(item => item.label), ['+ Incluir subcategoria', 'Padrão compra', 'Editar', 'Inativar', 'Excluir']);
    // Search shows matches with their ancestors; Situação Ativo hides inactive categories.
    await view.change('category-search', 'alug'); await view.submit();
    assert.match(view.text(), /Despesas administrativas/); assert.doesNotMatch(view.text(), /Tarifa bancária/);
  } finally { view.unmount(); }
});

test('135 "+ Incluir subcategoria" opens Nova categoria with the parent; Categorização para DRE saves each key and recovers', async () => {
  let fail = 0;
  const source = server({ tree: { receivable: RECEITAS, payable: DESPESAS }, post: call => { if (call.path.endsWith('category_set_default') && call.body.data.key === 'receipt_fees' && fail-- > 0) throw new AccessError(503); return { action: call.path.split('/').at(-1), replayed: false, entity: 'categories_tree', record: { id: id(99), parent_id: id(10), name: call.body.data.name ?? 'x', kind: 'receivable', dre_group: null, active: true, depth: 2, defaults: [], children: 0, in_use: false, version: 1, updated_at: 'x' }, data_mode: 'erp_native' }; } });
  const view = await mountTree(source);
  try {
    menuOf(view, 'Vendas').props.items[0].onClick(); await view.flush();
    assert.match(view.text(), /Nova categoria/); assert.equal(view.input('category-type-sub').props.checked, true);
    await view.change(field(view, 'Nome da subcategoria *').props.id, 'Vendas de serviços'); await view.click('Criar subcategoria de receita');
    assert.deepEqual(source.posts()[0].body.data, { kind: 'receivable', name: 'Vendas de serviços', parent_id: id(10) });
    assert.match(view.text(), /Categoria “Vendas de serviços” incluída\./);
    fail = 1; await view.click('Categorização para DRE'); assert.match(view.text(), /Operações de Recebimento/); assert.match(view.text(), /Operações de Pagamento/);
    await chooseCategory(view, field(view, 'Juros (Receita)').props.id, 'Receitas financeiras');
    await chooseCategory(view, field(view, 'Taxas (Despesa)').props.id, 'Despesas administrativas');
    await view.click('Salvar alterações');
    const defaults = source.posts().filter(call => call.path.endsWith('category_set_default'));
    assert.deepEqual(defaults.map(call => [call.body.data.key, call.body.data.category_id, call.body.data.expected_version]), [['receipt_interest', id(12), 1], ['receipt_fees', id(20), 1]]);
    assert.match(view.text(), /Conferir resultado/);
    await view.click('Conferir resultado');
    const again = source.posts().filter(call => call.path.endsWith('category_set_default'));
    assert.equal(again.length, 3); assert.equal(again[2].body.command_id, again[1].body.command_id, 'the uncertain key is sent again with the same command');
    assert.match(view.text(), /Categorização para DRE salva\./);
  } finally { view.unmount(); }
});

test('135 Mover categorias needs the confirmation; Importar categorias previews the sheet and sends one command; the lixeira skips what is in use', async () => {
  const source = server({ tree: { receivable: RECEITAS, payable: DESPESAS }, post: call => call.path.endsWith('category_import') ? { action: 'category_import', replayed: false, entity: 'categories_tree', created: [id(50), id(51)], skipped: 1, data_mode: 'erp_native' }
    : call.path.endsWith('category_move') ? { action: 'category_move', replayed: false, entity: 'categories_tree', record: { id: id(12), parent_id: null, name: 'Receitas financeiras', kind: 'receivable', dre_group: null, active: true, depth: 1, defaults: [], children: 0, in_use: false, version: 2, updated_at: 'x' }, target: { id: id(10), parent_id: null, name: 'Vendas', kind: 'receivable', dre_group: null, active: true, depth: 1, defaults: [], children: 1, in_use: true, version: 1, updated_at: 'x' }, moved: { titles: 3, borderos: 0, settlements: 1, movements: 0 }, data_mode: 'erp_native' }
    : { action: 'category_delete', replayed: false, entity: 'categories_tree', record: { id: call.body.data.id, deleted: true }, data_mode: 'erp_native' } });
  const view = await mountTree(source);
  try {
    await view.click('Mover categorias');
    await chooseCategory(view, field(view, 'Mover essa categoria *').props.id, 'Receitas financeiras');
    await chooseCategory(view, field(view, 'Para essa categoria *').props.id, 'Vendas');
    await view.click('Mover subcategorias'); assert.match(view.text(), /Confirme que deseja alterar/); assert.equal(source.posts().length, 0);
    await view.change('category-move-confirm', true); await view.click('Mover subcategorias');
    assert.deepEqual(source.posts()[0].body.data, { id: id(12), expected_version: 1, target_id: id(10), confirmed: true });
    assert.match(view.text(), /Lançamentos movidos: 4\./);
    await view.click('Importar categorias');
    const file = { name: 'categorias.csv', arrayBuffer: async () => new TextEncoder().encode('Nome da categoria;Categoria pai;Grupo de DRE\nVendas;;\nOutras receitas;;Outras Receitas\nJuros recebidos;Outras receitas;\n').buffer };
    await view.find(node => node.type === 'input' && node.props.type === 'file').props.onChange({ target: { files: [file], value: '' } }); await view.flush(); await new Promise(resolve => setTimeout(resolve, 20)); await view.flush();
    assert.match(view.text(), /categorias\.csv · 3 categorias/);
    await buttons(view, 'Importar categorias').at(-1).props.onClick(); await view.flush();
    assert.deepEqual(source.posts()[1].body.data, { kind: 'receivable', rows: [{ name: 'Vendas' }, { name: 'Outras receitas', dre_group: 'other_revenue' }, { name: 'Juros recebidos', parent: 'Outras receitas' }] });
    assert.match(view.text(), /Categorias importadas: 2; 1 já existiam\./);
    // Lixeira: categories with lançamentos, subcategorias or a padrão are skipped with the reason.
    for (const label of ['Selecionar Vendas', 'Selecionar Receitas financeiras']) { view.find(item => item.type === 'input' && item.props['aria-label'] === label).props.onChange({ target: { checked: true } }); await view.flush(); }
    view.find(node => typeof node.type === 'function' && node.type.name === 'ToolButton' && node.props.title === 'Excluir selecionadas').props.onClick(); await view.flush();
    const dialog = child(view, 'BatchDialog');
    assert.ok(dialog.props.plan.skipped.some(item => item.message === 'Tem subcategorias: exclua-as antes ou inative a categoria.'));
    assert.ok(dialog.props.plan.skipped.some(item => item.message === 'Tem lançamentos: inative a categoria.'));
    assert.equal(dialog.props.plan.eligible.length, 0);
  } finally { view.unmount(); }
});

test('246 Contas Financeiras follow Sistema › Usuários › Permissões: Caixas e Bancos incluir/editar for every change, excluir to delete', async () => {
  const editor = server({ permitted: ['financas.caixas_bancos', 'financas.caixas_bancos.ie'] }), view = await mountAccounts(editor);
  try {
    assert.deepEqual(menuOf(view, 'Sem uso').props.items.map(item => item.label), ['Editar', 'Inativar', 'Tornar padrão movimentações'], 'without Excluir the ⋮ does not offer it');
    assert.equal(buttons(view, 'Incluir conta financeira').length, 1);
  } finally { view.unmount(); }
  const reader = server({ permitted: ['financas.caixas_bancos'] }), readOnly = await mountAccounts(reader);
  try {
    assert.equal(menuOf(readOnly, 'Sem uso'), undefined, 'without incluir/editar no change of a conta is offered');
    assert.equal(menuOf(readOnly, 'Caixa da loja'), undefined);
    assert.equal(buttons(readOnly, 'Incluir conta financeira').length, 0);
  } finally { readOnly.unmount(); }
  const creating = await mountAccounts(server({ permitted: ['financas.caixas_bancos'] }), '/financeiro-empresa?area=contas-financeiras&incluir=1');
  try { assert.match(creating.text(), /Inclusão não liberada/); } finally { creating.unmount(); }
});
