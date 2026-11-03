import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { categoryTreeResponse, chooseCategory } from './helpers/finance-category-tree-fixture.mjs';
import { runBatch } from '../src/lib/origin-batch.ts';
import { todaySP } from '../src/lib/real-finance-model.ts';
import { defaultTitlePeriod } from '../src/lib/finance-list-route.ts';

// Synthetic data only. 094 Origin list of contas: numbered page, filters, ⋮, selection with batches and "Salvar e dar baixa".
globalThis.document = { activeElement: null };
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = '40000000-0000-4000-8000-000000000001', other = '40000000-0000-4000-8000-000000000002', category = '20000000-0000-4000-8000-000000000001', doc = '30000000-0000-4000-8000-000000000001';
const TODAY = todaySP(), PERIOD = defaultTitlePeriod(TODAY), WINDOW = `&option=open&from=${PERIOD.from}&to=${PERIOD.to}`;
const title = (n, extra = {}) => ({ id: id(n), kind: 'receivable', version: 1, group_id: id(9000), installment: 1, installments: 1, contact_id: id(8000), contact_name: `Cliente ${n}`, category_id: null, category_name: null, description: `Conta ${n}`, source_reference: null, issued_on: PERIOD.from, due_on: TODAY, amount_cents: String(1000 + n), settled_cents: '0', balance_cents: String(1000 + n), cancelled: false, status: 'open', overdue: false, document_linked: false, origin: null,
  competence_on: PERIOD.from, account_id: null, account_name: null, bank_number: null, interest_month_bp: 0, penalty_bp: 0, original_due_on: TODAY, deleted_at: null, remittance: null, imported: false, payments: { settled_on: null, fee_cents: '0', interest_cents: '0', penalty_cents: '0', discount_cents: '0', settled_by_return: false }, ...extra });
const child = (view, name) => view.nodes().find(node => typeof node.type === 'function' && node.type.name === name);
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const field = (view, label) => view.input(view.find(node => node.type === 'label' && text(node) === label).props.htmlFor);
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const buttons = (view, label) => view.nodes().filter(node => node.type === 'button' && text(node) === label);

function pageOf(url, data) {
  const params = url.searchParams, kind = params.get('kind'), number = Number(params.get('page')), order = params.get('order') ?? 'due_asc', option = params.get('option') ?? 'issued';
  const inOption = item => option === 'issued' || (option === 'settled' ? item.payments.settled_on !== null : !item.cancelled && BigInt(item.balance_cents) > 0n && (option === 'open' || item.overdue));
  const rows = data.filter(item => item.kind === kind && inOption(item)), sorted = order === 'due_asc' ? rows : [...rows].reverse();
  const sum = key => rows.reduce((total, item) => total + BigInt(item[key]), 0n).toString();
  return { entity: 'titles', data_mode: 'erp_native', kind, option, page: number, limit: 100, order, total: rows.length, totals: { count: rows.length, amount_cents: sum('amount_cents'), balance_cents: sum('balance_cents'), fee_cents: '0' }, items: structuredClone(sorted.slice((number - 1) * 100, number * 100)) };
}
function server({ count = 3, write = true, data = Array.from({ length: count }, (_, index) => title(index + 1)), before, post, read } = {}) {
  const calls = [], state = { session: { phase: 'ready', membership: { user_id: actor, role: write ? 'financeiro' : 'consulta' } } }, listeners = new Set();
  const controller = {
    getSnapshot: () => state.session, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, retry() {},
    async financialImportOrigin(path) { return { data_mode: 'erp_native', read_only: true, title_id: path.split('/')[4], origin: null }; },
    async finance(path, options = {}) {
      const call = { path, ...options, body: options.body ? structuredClone(options.body) : undefined }; calls.push(call);
      const injected = await before?.(call); if (injected !== undefined) return injected;
      if (path === '/v1/financeiro') return { read: true, write, data_mode: 'erp_native' };
      if (options.method === 'POST') return post ? post(call) : { record: title(1), data_mode: 'erp_native' };
      const url = new URL(path, 'https://synthetic.invalid');
      if (url.pathname === '/v1/financeiro/titles' && url.searchParams.has('page')) return pageOf(url, data);
      if (url.pathname === '/v1/financeiro/accounts') return { entity: 'accounts', data_mode: 'erp_native', limit: 100, has_more: false, next_cursor: null, items: [{ id: id(7700), name: 'Banco sintético', kind: 'bank', active: true, version: 1 }] };
      if (url.pathname === '/v1/financeiro/categorias-arvore') return categoryTreeResponse(url.searchParams.get('kind'), [{ id: category, name: 'Categoria sintética', kind: 'receivable' }]);
      if (url.pathname === '/v1/financeiro/settlements') return { entity: 'settlements', data_mode: 'erp_native', limit: 25, items: [], has_more: false, next_cursor: null };
      const found = data.find(item => url.pathname === `/v1/financeiro/titles/${item.id}`);
      if (found) { const record = read ? read(found) : structuredClone(found); const { origin, ...rest } = record; return { entity: 'titles', data_mode: 'erp_native', record: rest, origin }; }
      throw new Error(`Unexpected ${path}`);
    },
  };
  return { calls, controller, data, setSession(next) { state.session = next; for (const listener of listeners) listener(); }, lists: () => calls.filter(call => call.path.startsWith('/v1/financeiro/titles?')), posts: () => calls.filter(call => call.method === 'POST') };
}
const mount = (source, location = '/financeiro-empresa?area=receivable', expand = ['NativeListLayout', 'Field', 'OriginPagination', 'CategoryTreeFilter', 'TreeList']) => mountComponent('RealFinance.tsx', { controller: source.controller }, { location, expandChildren: expand });

test('094 contas list reads the numbered page by vencimento and shows totals of the whole filtered set', async () => {
  const source = server({ count: 250 }), view = await mount(source);
  try {
    assert.equal(source.lists()[0].path, `/v1/financeiro/titles?page=1&limit=100&kind=receivable${WINDOW}`, 'Em aberto in the Origin default period');
    const all = source.data.reduce((sum, item) => sum + BigInt(item.amount_cents), 0n);
    assert.match(view.text(), /1 - 100 de 250/); assert.match(view.text(), /Quantidade de contas a receber250/);
    assert.match(view.text(), new RegExp(`Valor totalR\\$ ${(all / 100n).toLocaleString('pt-BR').replace(/\./g, '\\.')},${String(all % 100n).padStart(2, '0')}`));
    assert.match(view.text(), /Saldo em aberto/); assert.match(view.text(), /Informações baseadas nos filtros aplicados na listagem/);
    assert.equal(view.input('finance-search').props.placeholder, 'Pesquise por nome, e-mail, CPF/CNPJ, número ou histórico');
    await view.click('Última'); assert.equal(view.location().search, '?area=receivable&page=3');
    assert.equal(source.lists().at(-1).path, `/v1/financeiro/titles?page=3&limit=100&kind=receivable${WINDOW}`); assert.match(view.text(), /201 - 250 de 250/); assert.match(view.text(), /Conta 250/);
    assert.equal(buttons(view, 'Próxima')[0].disabled, true); assert.equal(buttons(view, 'Última')[0].disabled, true);
    await view.click('Primeira'); assert.equal(view.location().search, '?area=receivable'); assert.match(view.text(), /1 - 100 de 250/);
    await view.click('Vencimento'); assert.equal(view.location().search, '?area=receivable&order=due_desc');
    assert.equal(source.lists().at(-1).path, `/v1/financeiro/titles?page=1&limit=100&kind=receivable&option=open&order=due_desc&from=${PERIOD.from}&to=${PERIOD.to}`);
    const rows = view.nodes().filter(node => node.type === 'tr' && node.props.className?.startsWith('finance-row'));
    assert.equal(text(rows[0]).includes('Conta 250'), true, 'descending vencimento puts the last conta first');
    await view.click('2'); assert.equal(view.location().search, '?area=receivable&order=due_desc&page=2', 'paging keeps the order');
    assert.ok(source.calls.every(call => !call.method), 'reading the list never writes');
  } finally { view.unmount(); }
});

test('109 Filtrar panel follows the Opção being chosen and sends the Origin filters to the API; invalid values stay local and Limpar resets', async () => {
  const source = server(), view = await mount(source);
  try {
    assert.equal(view.nodes().find(node => node.props.id === 'finance-option-open').props.checked, true, 'Em aberto is the default Opção');
    assert.ok(field(view, 'Em remessa')); assert.throws(() => field(view, 'Filtrar por')); assert.throws(() => view.input('finance-status-open'));
    // SQL 210: Tipo de pagamento, Forma de pagamento and Vendedor are real filters.
    assert.equal(field(view, 'Tipo de pagamento').disabled, false); assert.equal(field(view, 'Forma de pagamento').disabled, false); assert.equal(field(view, 'Vendedor').disabled, false);
    assert.deepEqual(buttons(view, 'Cancelar selecionadas').length, 1);
    await view.change('finance-option-settled', true);
    assert.throws(() => field(view, 'Em remessa'), 'Em remessa is only for Em aberto'); assert.equal(buttons(view, 'Cancelar selecionadas').length, 0, 'the panel actions follow the Opção before applying');
    await view.change('finance-option-issued', true);
    await view.change(field(view, 'Filtrar por').props.id, 'competence');
    await view.change('finance-status-cancelled', true); await view.change('finance-status-open', true);
    view.find(node => node.props.className === 'finance-category-lazy').props.onFocus(); await view.flush();
    await view.change('finance-category-none', true); await view.change(`finance-category-${category}`, true);
    await view.change(field(view, 'Valor').props.id, 'abc'); await view.submit();
    assert.equal(view.location().search, '?area=receivable'); assert.match(view.text(), /Informe o valor em reais/);
    await view.change(field(view, 'Valor').props.id, '10,00'); await view.submit();
    assert.equal(view.location().search, `?area=receivable&opcao=issued&status=cancelled%2Copen&date=competence&category=none%2C${category}&valor=1000`);
    assert.equal(source.lists().at(-1).path, `/v1/financeiro/titles?page=1&limit=100&kind=receivable&option=issued&status=cancelled%2Copen&date=competence&from=${PERIOD.from}&to=${PERIOD.to}&category=none%2C${category}&amount_cents=1000`);
    const chips = () => child(view, 'AppliedChips').props.chips;
    assert.deepEqual(chips().map(chip => chip.label), ['Opção: Emitidas', 'Situação: Cancelada, Em aberto', 'Filtrar por: Data de Competência', 'Categoria: Sem categoria, Categoria sintética', 'Valor: R$ 10,00']);
    assert.equal(field(view, 'Valor').props.value, '10,00', 'the panel shows the applied values');
    assert.equal(child(view, 'PeriodPicker').props.dateType, 'Data de Competência'); assert.deepEqual(child(view, 'PeriodPicker').props.dateTypes, ['Data de Emissão', 'Data de Vencimento', 'Data de Recebimento', 'Data de Competência']);
    assert.deepEqual([child(view, 'PeriodPicker').props.from, child(view, 'PeriodPicker').props.to], [PERIOD.from, PERIOD.to], 'the period chip shows the default period');
    chips()[4].onRemove(); await view.flush(); assert.doesNotMatch(view.location().search, /valor=/); assert.match(view.location().search, /status=/);
    child(view, 'PeriodPicker').props.onApply({ from: '2026-03-01', to: '2026-03-31', dateType: 'Data de Recebimento' }); await view.flush();
    assert.match(view.location().search, /from=2026-03-01&to=2026-03-31/); assert.match(view.location().search, /date=settled/);
    chips()[0].onRemove(); await view.flush();
    assert.equal(view.location().search, `?area=receivable&from=2026-03-01&to=2026-03-31&category=none%2C${category}`, 'back to Em aberto, without the fields of Emitidas');
    child(view, 'OriginSelector').props.onChange('Sem conta financeira'); await view.flush();
    assert.match(view.location().search, /conta=none/); assert.match(source.lists().at(-1).path, /account=none/);
    child(view, 'OriginSelector').props.onChange('Banco sintético'); await view.flush(); assert.match(view.location().search, new RegExp(`conta=${id(7700)}`));
    assert.deepEqual(child(view, 'OriginSelector').props.options, ['Todas as contas financeiras', 'Sem conta financeira', 'Banco sintético']);
    await view.click('Limpar filtros'); assert.equal(view.location().search, '?area=receivable');
    assert.equal(view.nodes().find(node => node.props.id === 'finance-option-open').props.checked, true);
  } finally { view.unmount(); }
});

test('109 Recebidas show Liquidação, Valor taxa and Taxa total; the customizada view shows the columns chosen by the user', async () => {
  const paid = { settled_cents: '1001', balance_cents: '0', status: 'paid', payments: { settled_on: TODAY, fee_cents: '290', interest_cents: '150', penalty_cents: '400', discount_cents: '50', settled_by_return: true } };
  const source = server({ data: [title(1, paid), title(2, { ...paid, payments: { ...paid.payments, fee_cents: '0', settled_by_return: false } })] });
  const view = await mount(source, '/financeiro-empresa?area=receivable&opcao=settled', ['NativeListLayout', 'Field', 'ToolButton', 'ViewToggle']);
  try {
    const headers = () => view.nodes().filter(node => node.type === 'th').map(text);
    assert.deepEqual(headers().slice(1), ['Cliente', 'Histórico', 'Forma de pagamento', 'Vencimento', 'Liquidação', 'Valor taxa', 'Valor', 'Situação', 'Ações']);
    assert.match(view.text(), /Conta 1, Baixa de conta por retorno/); assert.match(view.text(), /R\$ 2,90/); assert.match(view.text(), /Recebida/);
    assert.ok(view.nodes().some(node => node.type === 'td' && text(node) === '-'), 'a zero taxa shows a dash');
    assert.match(view.text(), /Taxa total/);
    assert.equal(source.lists().at(-1).path, `/v1/financeiro/titles?page=1&limit=100&kind=receivable&option=settled&from=${PERIOD.from}&to=${PERIOD.to}`);
    view.find(node => node.type === 'button' && node.props['aria-label'] === 'Visualizar listagem customizada').props.onClick(); await view.flush();
    assert.deepEqual(headers().slice(1), ['Cliente', 'Histórico', 'Vencimento', 'Valor', 'Situação', 'Ações'], 'customizada starts with Histórico and Vencimento');
    view.find(node => node.type === 'button' && node.props.title === 'Colunas customizadas').props.onClick(); await view.flush();
    const dialog = child(view, 'ColumnsDialog'); assert.ok(dialog); dialog.props.onApply(['history', 'net', 'interest', 'additions', 'discounts', 'balance']); await view.flush();
    assert.deepEqual(headers().slice(1), ['Cliente', 'Histórico', 'Líquido', 'Juros', 'Acréscimos', 'Descontos', 'Saldo', 'Valor', 'Situação', 'Ações']);
    assert.match(view.text(), /R\$ 7,11/, 'líquido = valor menos tarifas'); assert.match(view.text(), /R\$ 1,50R\$ 4,00R\$ 0,50/);
  } finally { view.unmount(); }
});

test('094 Shift + clique selects a range; Alterar categorias runs one versioned command per conta and recovers the uncertain one', async () => {
  const commands = [];
  const source = server({ count: 5, post: call => { commands.push(call); const target = call.body.data.id; const tries = commands.filter(item => item.body.data.id === target).length;
    if (target === id(2)) throw new AccessError(409); if (target === id(3) && tries === 1) throw new AccessError(503); return { record: title(Number(target.slice(-4))), data_mode: 'erp_native' }; } });
  const view = await mount(source);
  try {
    assert.equal(buttons(view, 'Alterar categorias')[0].disabled, true);
    const box = n => view.find(node => node.type === 'input' && node.props['aria-label'] === `Selecionar Conta ${n}`);
    box(1).props.onClick({ shiftKey: false }); await view.flush(); box(3).props.onClick({ shiftKey: true }); await view.flush();
    assert.deepEqual([1, 2, 3, 4].map(n => box(n).props.checked), [true, true, true, false]);
    assert.equal(source.calls.some(call => /\/titles\/1/.test(call.path)), false, 'selecting does not open the row');
    assert.match(view.text(), /3 contas selecionadas nesta página/);
    await view.click('Alterar categorias'); assert.ok(child(view, 'FinanceBatchParams'));
    child(view, 'FinanceBatchParams').props.onContinue({ categoryId: category, categoryName: 'Categoria sintética' }); await view.flush();
    const dialog = child(view, 'BatchDialog'); assert.equal(dialog.props.plan.eligible.length, 3); assert.equal(dialog.props.confirmLabel, 'Alterar categorias');
    const results = await runBatch(dialog.props.plan, dialog.props.run);
    assert.deepEqual(results.map(result => result.outcome), ['ok', 'failed', 'uncertain']);
    assert.deepEqual(commands.map(call => [call.path, call.body.data]), [1, 2, 3].map(n => ['/v1/financeiro/actions/title_update', { id: id(n), expected_version: 1, category_id: category }]));
    assert.equal(new Set(commands.map(call => call.body.command_id)).size, 3);
    const listsBefore = source.lists().length; dialog.props.onClose(results); await view.flush();
    assert.match(view.text(), /Alterar categorias: 1 concluído · 1 com falha · 1 a conferir\./); assert.equal(source.lists().length, listsBefore + 1);
    assert.match(view.text(), /1 conta de “Alterar categorias” sem resultado confirmado/); assert.equal(child(view, 'BatchGuard').props.busy, true);
    assert.equal(box(1).props.checked, false, 'selection clears after the batch');
    box(4).props.onClick({ shiftKey: false }); await view.flush(); assert.equal(buttons(view, 'Alterar categorias')[0].disabled, true, 'no new batch while a result is unconfirmed');
    await view.click('Conferir resultado'); const recovery = child(view, 'BatchDialog');
    assert.equal(recovery.props.confirmLabel, 'Conferir resultado'); assert.deepEqual(recovery.props.plan.eligible.map(item => item.id), [id(3)]);
    const again = await runBatch(recovery.props.plan, recovery.props.run); assert.deepEqual(again.map(result => result.outcome), ['ok']);
    assert.deepEqual(commands.at(-1).body, commands[2].body, 'the same command_id and body are replayed');
    recovery.props.onClose(again); await view.flush();
    assert.doesNotMatch(view.text(), /sem resultado confirmado/); assert.equal(child(view, 'BatchGuard'), undefined); assert.match(view.text(), /Conferir resultado: 1 concluído\./);
  } finally { view.unmount(); }
});

test('110 Baixar selecionados opens the Baixa de lançamentos with one line per selected conta and reloads after it', async () => {
  const source = server({ count: 3 }), view = await mount(source);
  try {
    assert.equal(buttons(view, 'Baixar selecionados')[0].disabled, true);
    view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar todos').props.onChange(); await view.flush();
    await view.click('Baixar selecionados');
    assert.equal(child(view, 'FinanceBatchParams'), undefined, 'no per-conta batch: one settle_batch command');
    const drawer = child(view, 'FinanceSettleDrawer');
    assert.deepEqual(drawer.props.titles.map(title => [title.id, title.version]), [1, 2, 3].map(n => [id(n), 1])); assert.equal(drawer.props.kind, 'receivable'); assert.equal(drawer.props.partial, false);
    assert.ok(view.nodes().some(node => node.type === 'table'), 'the list stays under the SlideIn');
    const lists = source.lists().length; drawer.props.onSaved({ items: 3, borderos: 1 }); await view.flush();
    assert.equal(child(view, 'FinanceSettleDrawer'), undefined); assert.match(view.text(), /Baixa registrada: 3 contas em 1 borderô\./);
    assert.equal(source.lists().length, lists + 1, 'the list is read again');
    assert.equal(view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar Conta 1').props.checked, false, 'the selection clears');
    view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar Conta 2').props.onClick({ shiftKey: false }); await view.flush();
    await view.click('Baixar selecionados'); child(view, 'FinanceSettleDrawer').props.onClose(); await view.flush();
    assert.equal(child(view, 'FinanceSettleDrawer'), undefined); assert.equal(source.posts().length, 0, 'the SlideIn sends by itself; closing sends nothing');
  } finally { view.unmount(); }
});

test('094 read-only access keeps totals and origin links but offers no selection, batch or write action', async () => {
  const linked = title(2, { document_linked: true, origin: { document_id: doc, kind: 'sales_orders', number: '4242' } });
  const source = server({ write: false, data: [title(1), linked] }), view = await mount(source, undefined, ['NativeListLayout', 'Field']);
  try {
    assert.throws(() => view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar todos'));
    assert.equal(buttons(view, 'Alterar categorias').length + buttons(view, 'Baixar selecionados').length + buttons(view, 'Cancelar selecionadas').length, 0);
    const menus = view.nodes().filter(node => typeof node.type === 'function' && node.type.name === 'RowMenu');
    // Consulta keeps only reading actions: printing the recibo and opening the origin.
    assert.equal(menus.length, 2); assert.deepEqual(menus[0].props.items.map(item => [item.label, item.to]), [['Imprimir recibo', undefined], ['Imprimir duplicata', undefined]], 'consulta also prints the recibo and the duplicata');
    assert.deepEqual(menus[1].props.items.map(item => [item.label, item.to]), [['Imprimir recibo', undefined], ['Imprimir duplicata', undefined], ['Abrir pedido de origem', `/documentos-empresa?tipo=sales_orders&documento=${doc}`]]);
    const link = view.find(node => node.type === 'test-router-link' && node.props.className === 'finance-origin');
    assert.equal(text(link), 'Ref. ao pedido de venda nº 4242'); assert.equal(link.props.to, `/documentos-empresa?tipo=sales_orders&documento=${doc}`);
    let stopped = 0; link.props.onAuxClick({ stopPropagation: () => stopped++ }); link.props.onMouseDown({ stopPropagation: () => stopped++ });
    assert.equal(stopped, 2, 'middle click on the origin does not also open the conta');
    assert.match(view.text(), /Quantidade de contas a receber2/);
  } finally { view.unmount(); }
});

test('094 row ⋮ reads the conta again and opens the matching editor; a changed conta falls back to its consulta', async () => {
  let cancelled = false;
  const source = server({ count: 3, data: [title(1), title(2, { settled_cents: '500', balance_cents: '502', status: 'partial' }), title(3)], read: found => ({ ...structuredClone(found), version: 9, ...(cancelled && found.id === id(3) ? { cancelled: true, status: 'cancelled' } : {}) }) });
  const view = await mount(source, undefined, ['NativeListLayout', 'Field', 'RowMenu']);
  const openMenu = async n => { const kebab = view.find(node => node.type === 'button' && node.props['aria-label'] === `Ações de Conta ${n}`); kebab.props.onClick({ stopPropagation() {}, currentTarget: { getBoundingClientRect: () => ({ top: 10, left: 10 }) } }); await view.flush(); };
  try {
    await openMenu(1); assert.deepEqual(['Editar', 'Baixa total do recebimento', 'Baixa parcial do recebimento', 'Cancelar conta a receber', 'Clonar', 'Excluir'].map(label => buttons(view, label).length), [1, 1, 1, 1, 1, 1]);
    await view.click('Baixa parcial do recebimento');
    assert.equal(source.calls.at(-1).path, `/v1/financeiro/titles/${id(1)}`);
    const settle = child(view, 'FinanceSettleDrawer'); assert.equal(settle.props.partial, true); assert.equal(settle.props.titles[0].version, 9, 'the baixa starts from the conta read again');
    assert.equal(child(view, 'FinanceEditor'), undefined); settle.props.onClose(); await view.flush(); assert.equal(child(view, 'FinanceSettleDrawer'), undefined);
    await openMenu(2); assert.equal(buttons(view, 'Cancelar conta a receber').length, 0); assert.equal(buttons(view, 'Excluir').length, 0, 'a conta with baixa is not excluded'); await view.click('Estornar baixa');
    // The drawer lists the baixas with "Estornar" (Origin's Gerenciar recebimentos), over the list.
    assert.equal(child(view, 'FinanceEditor'), undefined); let drawer = child(view, 'FinanceTitleDrawer'); assert.equal(drawer.props.title.id, id(2)); assert.equal(drawer.props.mode, 'edit');
    assert.ok(drawer.props.history, 'the drawer carries the history of baixas'); assert.ok(view.nodes().some(node => node.type === 'table'), 'the list stays mounted under the drawer');
    drawer.props.onClose(); await view.flush(); assert.equal(child(view, 'FinanceTitleDrawer'), undefined);
    await openMenu(1); await view.click('Editar'); drawer = child(view, 'FinanceTitleDrawer'); assert.equal(drawer.props.mode, 'edit'); assert.equal(drawer.props.title.version, 9); drawer.props.onClose(); await view.flush();
    await openMenu(1); await view.click('Clonar'); drawer = child(view, 'FinanceTitleDrawer');
    assert.deepEqual([drawer.props.mode, drawer.props.title, drawer.props.clone.id], ['create', null, id(1)], 'Clonar opens a new conta prefilled from the one read again'); drawer.props.onClose(); await view.flush();
    cancelled = true; await openMenu(3); await view.click('Cancelar conta a receber');
    assert.equal(child(view, 'FinanceEditor'), undefined, 'a conta cancelled meanwhile is shown, not edited');
    drawer = child(view, 'FinanceTitleDrawer'); assert.equal(drawer.props.mode, 'view'); assert.equal(drawer.props.title.cancelled, true);
    assert.equal(source.posts().length, 0);
  } finally { view.unmount(); }
});

test('094 a late page cannot replace the next page', async () => {
  const late = deferred(), source = server({ count: 150, before: call => call.path.includes('page=1&') && source.lists().length === 1 ? late.promise : undefined }), view = await mount(source);
  try {
    const old = source.lists()[0]; await view.navigate('/financeiro-empresa?area=receivable&page=2'); assert.equal(old.signal.aborted, true);
    late.resolve(pageOf(new URL(old.path, 'https://synthetic.invalid'), source.data)); await view.flush();
    const descriptions = view.nodes().filter(node => node.type === 'button' && node.props.className === 'text-button finance-open').map(text);
    assert.match(view.text(), /101 - 150 de 150/); assert.equal(descriptions[0], 'Conta 101'); assert.equal(descriptions.length, 50);
  } finally { view.unmount(); }
});

test('094 a page beyond the last one moves to the current last page', async () => {
  const source = server({ count: 120 }), view = await mount(source, '/financeiro-empresa?area=receivable&page=5');
  try {
    assert.equal(view.location().search, '?area=receivable&page=2'); assert.match(view.text(), /101 - 120 de 120/);
    assert.deepEqual(view.navigations().at(-1), { search: '?area=receivable&page=2', replace: true }, 'Back does not return to the empty page and bounce forward');
  } finally { view.unmount(); }
});

test('094 changing the order, a filter or the period from a later page returns to the first page', async () => {
  const source = server({ count: 150 }), view = await mount(source, '/financeiro-empresa?area=receivable&page=2');
  try {
    assert.match(view.text(), /101 - 150 de 150/);
    await view.click('Vencimento'); assert.equal(view.location().search, '?area=receivable&order=due_desc');
    await view.navigate('/financeiro-empresa?area=receivable&order=due_desc&page=2');
    await view.change('finance-option-overdue', true); await view.submit();
    assert.equal(view.location().search, '?area=receivable&opcao=overdue&order=due_desc', 'Filtrar keeps the order and goes back to page 1');
    await view.navigate('/financeiro-empresa?area=receivable&opcao=issued&page=2');
    child(view, 'PeriodPicker').props.onApply({ from: '2026-01-01', to: '2026-12-31', dateType: 'Data de Vencimento' }); await view.flush();
    assert.equal(view.location().search, '?area=receivable&opcao=issued&from=2026-01-01&to=2026-12-31');
    assert.match(source.lists().at(-1).path, /^\/v1\/financeiro\/titles\?page=1&/);
    assert.ok(view.navigations().every(entry => !entry.replace), 'user navigation keeps the browser history');
  } finally { view.unmount(); }
});

test('094 a replay refused after an unconfirmed send stays "a conferir", like the single editor', async () => {
  let tries = 0;
  const source = server({ count: 2, post: () => { tries++; throw new AccessError(tries === 1 ? 503 : 403); } }), view = await mount(source);
  try {
    view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar Conta 1').props.onClick({ shiftKey: false }); await view.flush();
    await view.click('Cancelar selecionadas'); child(view, 'FinanceBatchParams').props.onContinue({ note: 'Motivo sintético' }); await view.flush();
    const dialog = child(view, 'BatchDialog'), first = await runBatch(dialog.props.plan, dialog.props.run);
    assert.deepEqual(first.map(result => result.outcome), ['uncertain']); dialog.props.onClose(first); await view.flush();
    await view.click('Conferir resultado'); const recovery = child(view, 'BatchDialog'), again = await runBatch(recovery.props.plan, recovery.props.run);
    assert.deepEqual(again.map(result => result.outcome), ['uncertain'], 'a 403 on the replay does not prove the first send failed');
    assert.match(again[0].message, /O envio anterior continua sem confirmação/);
    assert.deepEqual(source.posts().map(call => call.body), [source.posts()[0].body, source.posts()[0].body], 'the same command is replayed');
    recovery.props.onClose(again); await view.flush();
    assert.match(view.text(), /1 conta de “Cancelar selecionadas” sem resultado confirmado/); assert.equal(child(view, 'BatchGuard').props.busy, true);
    await view.click('Conferir resultado'); const third = child(view, 'BatchDialog');
    source.setSession({ phase: 'ready', membership: { user_id: actor, role: 'consulta' } }); await view.flush();
    const step = await third.props.run(third.props.plan.eligible[0]);
    assert.equal(step.uncertain, true); assert.match(step.message, /não foi reenviada/); assert.equal(source.posts().length, 2, 'nothing is sent after the role change');
  } finally { view.unmount(); }
});

test('094 opening the Categoria filter again retries a failed load', async () => {
  let failures = 1;
  const source = server({ before: call => { if (call.path.startsWith('/v1/financeiro/categorias-arvore') && failures-- > 0) throw new AccessError(503); } }), view = await mount(source);
  const loads = () => source.calls.filter(call => call.path.startsWith('/v1/financeiro/categorias-arvore')).length;
  try {
    const box = () => view.find(node => node.props.className === 'finance-category-lazy');
    box().props.onFocus(); await view.flush();
    assert.equal(loads(), 1); assert.match(view.text(), /Não foi possível carregar as categorias/);
    box().props.onMouseDown(); await view.flush();
    assert.equal(loads(), 2); assert.doesNotMatch(view.text(), /Não foi possível carregar as categorias/);
    assert.ok(view.nodes().some(node => node.type === 'label' && text(node) === 'Categoria sintética'));
    await view.change('finance-category-search', 'outra'); assert.ok(!view.nodes().some(node => node.type === 'label' && text(node) === 'Categoria sintética'), 'the categoria search filters the options');
    box().props.onFocus(); await view.flush(); assert.equal(loads(), 2, 'loaded options are not fetched again');
  } finally { view.unmount(); }
});

test('094 "Salvar e dar baixa" saves, then the list opens the baixa of the saved conta read again', async () => {
  const source = server({ count: 2 }), view = await mount(source, undefined, ['NativeListLayout', 'Field']);
  try {
    await view.click('Incluir conta'); assert.equal(child(view, 'FinanceTitleDrawer').props.mode, 'create'); const before = source.calls.length; child(view, 'FinanceTitleDrawer').props.onSaved({ settleId: id(2) }); await view.flush();
    assert.deepEqual(source.calls.slice(before).map(call => call.path).filter(path => !path.includes('?')), [`/v1/financeiro/titles/${id(2)}`], 'the saved conta is read again before the baixa');
    const editor = child(view, 'FinanceSettleDrawer'); assert.deepEqual(editor.props.titles.map(item => item.id), [id(2)]); assert.equal(editor.props.partial, false);
    assert.match(view.text(), /Conta salva\. Confira a conta financeira e os valores para registrar a baixa\./);
    editor.props.onClose(); await view.flush(); await view.click('Incluir conta'); child(view, 'FinanceTitleDrawer').props.onSaved({ settleId: null }); await view.flush();
    assert.equal(child(view, 'FinanceTitleDrawer'), undefined); assert.match(view.text(), /Conta salva\. Abra a conta na listagem para registrar a baixa\./);
  } finally { view.unmount(); }
});

test('094 drawer "Salvar e dar baixa" confirms the save with recovery and hands over the saved conta', async () => {
  const saved = [], writes = [], record = title(1, { version: 4 });
  const controller = { async financialImportOrigin() { return { data_mode: 'erp_native', read_only: true, title_id: record.id, origin: null }; },
    async finance(path, options) { writes.push({ path, ...options }); if (writes.length === 1) throw new AccessError(503); return { entity: 'titles', record: { ...record, version: 5 }, data_mode: 'erp_native', replayed: true }; } };
  const view = await mountComponent('RealFinance.tsx', { controller, mode: 'title_update', record, kind: 'receivable', onClose() {}, onSaved: value => saved.push(value) }, { componentName: 'FinanceEditor', expandChildren: ['Field', 'Confirmation', 'TitleOriginNotice'] });
  try {
    await view.change(field(view, 'Histórico *').props.id, 'Conta revisada'); await view.click('Salvar e dar baixa');
    assert.match(view.text(), /Salvar e dar baixa\?/); assert.match(view.text(), /Em seguida/);
    const confirm = () => buttons(view, 'Salvar e dar baixa').at(-1) ?? buttons(view, 'Conferir resultado')[0];
    confirm().props.onClick(); await view.flush();
    assert.equal(saved.length, 0); assert.equal(view.guard().busy, true);
    await view.click('Conferir resultado'); assert.equal(writes.length, 2); assert.deepEqual(writes[0].body, writes[1].body);
    assert.equal(writes[0].path, '/v1/financeiro/actions/title_update'); assert.equal(writes[0].body.data.description, 'Conta revisada');
    assert.deepEqual(saved, [{ settleId: record.id }]);
  } finally { view.unmount(); }
  const create = await mountComponent('RealFinance.tsx', { controller, mode: 'title_create_group', record: null, kind: 'payable', onClose() {}, onSaved() {} }, { componentName: 'FinanceEditor', expandChildren: ['Field'] });
  try {
    assert.equal(buttons(create, 'Salvar e dar baixa')[0].disabled, false);
    await create.change(field(create, 'Parcelas *').props.id, '2'); assert.equal(buttons(create, 'Salvar e dar baixa')[0].disabled, true, 'only a single parcela opens the baixa');
  } finally { create.unmount(); }
  const paid = await mountComponent('RealFinance.tsx', { controller, mode: 'title_update', record: title(3, { settled_cents: '1003', balance_cents: '0', status: 'paid' }), kind: 'receivable', onClose() {}, onSaved() {} }, { componentName: 'FinanceEditor', expandChildren: ['Field'] });
  try { assert.equal(buttons(paid, 'Salvar e dar baixa').length, 0, 'a paid conta has nothing to settle'); } finally { paid.unmount(); }
});

test('108 Excluir selecionados and ⋮ Excluir confirm, skip what the server refuses and send one versioned title_delete per conta', async () => {
  const source = server({ count: 4, data: [title(1), title(2, { settled_cents: '500', balance_cents: '502', status: 'partial' }), title(3, { version: 7 }), title(4, { imported: true })], post: call => ({ entity: 'titles', data_mode: 'erp_native', action: 'title_delete', replayed: false, record: { ...title(Number(call.body.data.id.slice(-4))), cancelled: true, status: 'cancelled', deleted_at: '2026-10-20T10:00:00Z' } }) });
  const view = await mount(source, undefined, ['NativeListLayout', 'Field', 'RowMenu', 'ToolButton']);
  const trash = () => view.find(node => node.type === 'button' && node.props.title === 'Excluir selecionados');
  try {
    assert.equal(trash().disabled, true, 'the toolbar trash waits for a selection');
    view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar todos').props.onChange(); await view.flush();
    trash().props.onClick(); await view.flush();
    assert.equal(child(view, 'FinanceBatchParams'), undefined, 'Excluir has no parameters step');
    let dialog = child(view, 'BatchDialog'); assert.equal(dialog.props.title, 'Excluir selecionados');
    assert.match(text(dialog.props.description), /Deseja mesmo excluir as contas selecionadas\?/);
    assert.deepEqual(dialog.props.plan.eligible.map(item => item.id), [id(1), id(3)]); assert.deepEqual(dialog.props.plan.skipped.map(item => [item.id, item.message]), [[id(2), 'Possui baixa registrada. Estorne a baixa antes de excluir.'], [id(4), 'Conta importada do Origin. Exclua a conta no Origin.']]);
    const results = await runBatch(dialog.props.plan, dialog.props.run);
    assert.deepEqual(results.map(result => result.outcome).sort(), ['ok', 'ok', 'skipped', 'skipped']);
    assert.deepEqual(source.posts().map(call => [call.path, call.body.data]), [['/v1/financeiro/actions/title_delete', { id: id(1), expected_version: 1 }], ['/v1/financeiro/actions/title_delete', { id: id(3), expected_version: 7 }]]);
    dialog.props.onClose(results); await view.flush(); assert.match(view.text(), /Excluir selecionados: 2 concluídos · 2 ignorados\./);
    const kebab = view.find(node => node.type === 'button' && node.props['aria-label'] === 'Ações de Conta 1'); kebab.props.onClick({ stopPropagation() {}, currentTarget: { getBoundingClientRect: () => ({ top: 10, left: 10 }) } }); await view.flush();
    await view.click('Excluir'); dialog = child(view, 'BatchDialog');
    assert.match(text(dialog.props.description), /Deseja mesmo excluir esta conta\?/); assert.deepEqual(dialog.props.plan.eligible.map(item => item.id), [id(1)]);
    dialog.props.onClose(null); await view.flush(); assert.equal(source.posts().length, 2, 'cancelling the confirmation sends nothing');
    view.find(node => node.type === 'button' && node.props['aria-label'] === 'Ações de Conta 4').props.onClick({ stopPropagation() {}, currentTarget: { getBoundingClientRect: () => ({ top: 10, left: 10 }) } }); await view.flush();
    assert.equal(buttons(view, 'Clonar').length, 1); assert.equal(buttons(view, 'Excluir').length, 0, 'a conta adopted from Origin is excluded only in Origin');
  } finally { view.unmount(); }
});

test('110 ⋮ Gerenciar recebimentos follows the borderôs of a conta with baixa; Ferramentas de apoio opens Gerenciar recebimentos', async () => {
  const source = server({ data: [title(1, { settled_cents: '500', balance_cents: '501', status: 'partial' }), title(2)] }), view = await mount(source, undefined, ['NativeListLayout', 'Field']);
  try {
    const menus = view.nodes().filter(node => typeof node.type === 'function' && node.type.name === 'RowMenu');
    assert.deepEqual(menus[0].props.items[0], { label: 'Gerenciar recebimentos', icon: 'eye', to: `/financeiro-empresa?area=borderos&tipo=R&titulo=${id(1)}` });
    assert.equal(menus[1].props.items.some(item => item.label === 'Gerenciar recebimentos'), false, 'a conta without baixa has no borderô');
    assert.ok(view.nodes().some(node => node.type === 'test-router-link' && node.props.to === '/financeiro-empresa?area=borderos&tipo=R' && text(node) === 'Gerenciar recebimentos'));
  } finally { view.unmount(); }
});

test('Imprimir offers Listagem simples and Agrupado por cliente of the filter; ⋮ Imprimir recibo and Gerar recibos print the chosen contas', async () => {
  const source = server({ data: [title(1), title(2), title(3), title(4, { cancelled: true, status: 'cancelled' })] }), view = await mount(source, '/financeiro-empresa?area=receivable&opcao=issued', ['NativeListLayout', 'Field', 'ToolButton', 'RowMenu']);
  try {
    view.find(node => node.type === 'button' && node.props.title === 'Imprimir').props.onClick(); await view.flush();
    assert.equal(view.input('finance-print-notes').props.checked, false, 'Imprimir observação do contato starts off');
    await view.change('finance-print-notes', true);
    await view.click('Agrupado por cliente');
    let preview = child(view, 'FinancePrintPreview');
    assert.deepEqual([preview.props.print.mode, preview.props.print.grouped, preview.props.print.notes, preview.props.print.source.kind, preview.props.print.source.route.option, preview.props.print.source.route.page], ['listing', true, true, 'route', 'issued', 1]);
    preview.props.onClose(); await view.flush(); assert.equal(child(view, 'FinancePrintPreview'), undefined);
    const kebab = view.find(node => node.type === 'button' && node.props['aria-label'] === 'Ações de Conta 2'); kebab.props.onClick({ stopPropagation() {}, currentTarget: { getBoundingClientRect: () => ({ top: 10, left: 10 }) } }); await view.flush();
    await view.click('Imprimir recibo'); preview = child(view, 'FinancePrintPreview');
    assert.deepEqual([preview.props.print.mode, preview.props.print.source.rows.map(item => item.id)], ['receipts', [id(2)]]); preview.props.onClose(); await view.flush();
    view.find(node => node.type === 'button' && node.props['aria-label'] === 'Ações de Conta 4').props.onClick({ stopPropagation() {}, currentTarget: { getBoundingClientRect: () => ({ top: 10, left: 10 }) } }); await view.flush();
    assert.equal(buttons(view, 'Clonar').length, 1); assert.equal(buttons(view, 'Imprimir recibo').length, 0, 'a cancelled conta has no recibo');
    assert.equal(buttons(view, 'Gerar recibos')[0].disabled, true);
    view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar todos').props.onChange(); await view.flush();
    await view.click('Gerar recibos'); preview = child(view, 'FinancePrintPreview');
    assert.deepEqual(preview.props.print.source.rows.map(item => item.id), [id(1), id(2), id(3), id(4)], 'the preview itself leaves the cancelled conta out'); assert.equal(source.posts().length, 0, 'printing never writes');
  } finally { view.unmount(); }
});

test('⋮ Enviar por whatsapp appears for open contas with boleto and opens wa.me with the celular of the contato', async () => {
  const boleto = { id: id(70), sequence: 3, state: 'ready', our_number: '12345678' };
  // Leva H (FIN-044): only a cobrança with the remessa file generated; a reserved one is not shared yet.
  const source = server({ data: [title(1, { remittance: boleto }), title(2), title(3, { remittance: { ...boleto, id: id(71), state: 'reserved' } })] }), opened = [];
  source.controller.catalog = async path => path === `/v1/cadastros/contacts/${id(8000)}` ? { entity: 'contacts', record: { id: id(8000), name: 'Cliente 1', mobile: '(11) 98888-7777', phone: null } } : null;
  globalThis.window = { open: (...args) => opened.push(args) };
  const view = await mount(source, undefined, ['NativeListLayout', 'Field', 'FinanceWhatsappShare']);
  try {
    const menus = view.nodes().filter(node => typeof node.type === 'function' && node.type.name === 'RowMenu');
    assert.equal(menus[1].props.items.some(item => item.label === 'Enviar por whatsapp'), false, 'without boleto, as in Origin');
    assert.equal(menus[2].props.items.some(item => item.label === 'Enviar por whatsapp'), false, 'a reserved remessa is not a valid cobrança yet');
    assert.deepEqual(menus[0].props.items.filter(item => ['Cancelar boleto', 'Retirar da remessa'].includes(item.label)).map(item => [item.disabled, /desligada/.test(item.title)]), [[true, true], [true, true]]);
    menus[0].props.items.find(item => item.label === 'Enviar por whatsapp').onClick(); await view.flush();
    assert.equal(opened.length, 0, 'the recipient and the text are reviewed first');
    const modal = view.nodes().find(node => typeof node.type === 'function' && node.type.name === 'Modal');
    assert.equal(modal.props.title, 'Enviar por whatsapp');
    modal.props.actions.props.children.find(button => button.props.children === 'Abrir o WhatsApp').props.onClick(); await view.flush();
    assert.equal(opened.length, 1); assert.equal(opened[0][1], '_blank'); assert.equal(opened[0][2], 'noopener');
    const url = new URL(opened[0][0]); assert.equal(url.origin + url.pathname, 'https://wa.me/5511988887777');
    assert.match(url.searchParams.get('text'), /Lembrete da conta "Conta 1" no valor de R\$ 10,01.*nosso número 12345678/);
    assert.equal(source.posts().length, 0);
  } finally { view.unmount(); delete globalThis.window; }
});

test('108 "Estornar" inside the drawer goes through the leave guard before replacing the drawer and its draft', async () => {
  const held = [], source = server({ data: [title(1, { settled_cents: '500', balance_cents: '501', status: 'partial' })] });
  const view = await mountComponent('RealFinance.tsx', { controller: source.controller }, { location: '/financeiro-empresa?area=receivable', expandChildren: ['NativeListLayout', 'Field'],
    ports: { useUnsavedChangesGuard: () => ({ confirmLeave: action => held.push(action) }) } });
  try {
    await view.click('Conta 1'); const drawer = child(view, 'FinanceTitleDrawer'); assert.equal(drawer.props.mode, 'edit');
    const payment = { id: id(600), title_id: id(1), account_id: id(7700), kind: 'payment', reverses_id: null, posted_on: TODAY, principal_cents: '500', interest_cents: '0', penalty_cents: '0', discount_cents: '0', fee_cents: '0', net_cash_cents: '500', note: null, reversed: false };
    drawer.props.history.props.onReverse(payment); await view.flush();
    assert.equal(held.length, 1, 'the guard is asked first'); assert.ok(child(view, 'FinanceTitleDrawer'), 'the drawer stays until the guard allows leaving'); assert.equal(child(view, 'FinanceEditor'), undefined);
    held[0](); await view.flush();
    assert.equal(child(view, 'FinanceTitleDrawer'), undefined); assert.equal(child(view, 'FinanceEditor').props.mode, 'reverse'); assert.equal(source.posts().length, 0);
  } finally { view.unmount(); }
});

test('Preferências > Finanças: ⋮ Imprimir duplicata prints the título de crédito chosen and the recibo follows the cabeçalho toggle', async () => {
  const { storedPreferencePage } = await import('../../../packages/erp-domain/src/preferences/catalog.mjs'), { storedFields } = await import('../../../packages/erp-domain/src/preferences/core.mjs');
  const values = { 'financas.receber_titulo_credito': 'nota_promissoria', 'financas.receber_cabecalho_recibo': true }, reads = [];
  const source = server();
  source.controller.preferences = async path => { reads.push(path); const page = storedPreferencePage('financas-receber');
    return { scope: 'preferences_page', data_mode: 'erp_native', page: page.id, owner: page.scope, role: 'financeiro', can_manage: false, directory: null,
      items: storedFields(page).map(field => Object.hasOwn(values, field.key) ? { key: field.key, value: values[field.key], version: 1, updated_at: '2026-10-20T12:00:00Z' } : { key: field.key, value: structuredClone(field.default), version: 0, updated_at: null }) }; };
  const view = await mount(source, '/financeiro-empresa?area=receivable', ['NativeListLayout', 'Field', 'ToolButton', 'RowMenu']);
  try {
    for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); }
    assert.deepEqual(reads, ['/v1/preferencias/financas-receber']);
    view.find(node => node.type === 'button' && node.props['aria-label'] === 'Ações de Conta 2').props.onClick({ stopPropagation() {}, currentTarget: { getBoundingClientRect: () => ({ top: 10, left: 10 }) } }); await view.flush();
    await view.click('Imprimir duplicata'); let preview = child(view, 'FinancePrintPreview');
    assert.deepEqual([preview.props.print.mode, preview.props.print.models, preview.props.print.source.rows.map(item => item.id), preview.props.receiptHeader], ['credit', ['nota_promissoria'], [id(2)], true]);
    preview.props.onClose(); await view.flush();
    view.find(node => node.type === 'button' && node.props['aria-label'] === 'Ações de Conta 1').props.onClick({ stopPropagation() {}, currentTarget: { getBoundingClientRect: () => ({ top: 10, left: 10 }) } }); await view.flush();
    await view.click('Imprimir recibo'); preview = child(view, 'FinancePrintPreview'); assert.equal(preview.props.receiptHeader, true); assert.equal(source.posts().length, 0, 'printing never writes');
  } finally { view.unmount(); }
});

test('109 Listagem customizada keeps the chosen columns per user on the server, with the version read and the same command on retry', async () => {
  const calls = [], source = server(); let version = 1, columns = ['category', 'balance'], filters = null, failures = 1;
  const preference = () => ({ scope: 'list_preferences', data_mode: 'erp_native', list_id: 'financeiro.contas_receber', version, columns: [...columns], filters: filters && { ...filters }, updated_at: '2026-10-20T12:00:00Z' });
  source.controller.listPreferences = async (path, options = {}) => {
    calls.push({ path, method: options.method, body: options.body ? structuredClone(options.body) : undefined });
    if (options.method === 'POST') {
      // The padrão/customizada choice is saved first (filters.listagem, FIN-017); the columns save is the one that loses its answer once.
      if (options.body.columns?.[0] === 'account' && failures-- > 0) throw new AccessError(503);
      const body = options.body; version += 1; columns = [...body.columns]; filters = body.filters;
      return { scope: 'list_preferences_command', data_mode: 'erp_native', replayed: false, receipt: { command_id: body.command_id, list_id: 'financeiro.contas_receber', from_version: body.expected_version, to_version: body.expected_version + 1, changed_at: '2026-10-20T12:00:01Z' }, preference: preference() };
    }
    if (path.includes('/comandos/')) throw new AccessError(404);
    return preference();
  };
  const view = await mount(source, '/financeiro-empresa?area=receivable', ['NativeListLayout', 'Field', 'ToolButton', 'ViewToggle']);
  try {
    for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); }
    const headers = () => view.nodes().filter(node => node.type === 'th').map(text);
    assert.deepEqual(calls[0], { path: '/v1/preferencias-listas/financeiro.contas_receber', method: 'GET', body: undefined });
    view.find(node => node.type === 'button' && node.props['aria-label'] === 'Visualizar listagem customizada').props.onClick(); await view.flush();
    assert.deepEqual(headers().slice(1), ['Cliente', 'Categoria', 'Saldo', 'Valor', 'Situação', 'Ações'], 'the columns saved on the server for this user');
    view.find(node => node.type === 'button' && node.props.title === 'Colunas customizadas').props.onClick(); await view.flush();
    child(view, 'ColumnsDialog').props.onApply(['account', 'history']); for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); }
    const view_ = calls.find(call => call.method === 'POST');
    assert.deepEqual([view_.body.expected_version, view_.body.columns, view_.body.filters], [1, ['category', 'balance'], { listagem: 'customizada' }], 'the view choice goes to the server');
    const first = calls.find(call => call.method === 'POST' && call.body.columns[0] === 'account');
    assert.deepEqual([first.body.expected_version, first.body.columns, first.body.filters], [2, ['account', 'history'], { listagem: 'customizada' }], 'the order chosen goes to the server');
    assert.deepEqual(headers().slice(1), ['Cliente', 'Conta financeira', 'Histórico', 'Valor', 'Situação', 'Ações'], 'the new choice shows at once');
    assert.match(view.text(), /Não foi possível confirmar se a listagem foi salva/);
    await view.click('Conferir resultado'); for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); }
    assert.equal(calls.at(-1).path, `/v1/preferencias-listas/comandos/${first.body.command_id}`);
    await view.click('Reenviar a mesma listagem'); for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); }
    const posts = calls.filter(call => call.method === 'POST'); assert.equal(posts.length, 3); assert.deepEqual(posts[2].body, first.body, 'the same command_id and body');
    assert.equal(version, 3); assert.deepEqual(headers().slice(1), ['Cliente', 'Conta financeira', 'Histórico', 'Valor', 'Situação', 'Ações']); assert.doesNotMatch(view.text(), /Não foi possível confirmar/);
  } finally { view.unmount(); }
});

test('FIN-017 Informações visíveis reorders the optional columns with the alça or the setas; Cliente, Valor and Situação stay fixed', async () => {
  const source = server();
  const view = await mount(source, '/financeiro-empresa?area=receivable', ['NativeListLayout', 'Field', 'ToolButton', 'ViewToggle', 'ColumnsDialog', 'ListColumnsPanel']);
  try {
    const headers = () => view.nodes().filter(node => node.type === 'th').map(text);
    view.find(node => node.type === 'button' && node.props['aria-label'] === 'Visualizar listagem customizada').props.onClick(); await view.flush();
    view.find(node => node.type === 'button' && node.props.title === 'Colunas customizadas').props.onClick(); await view.flush();
    assert.match(view.text(), /Informações visíveis/); assert.match(view.text(), /Configurações por usuário/);
    view.find(node => node.type === 'button' && node.props['aria-label'] === 'Mover Vencimento para cima').props.onClick(); await view.flush();
    await view.change('list-column-balance', true);
    view.find(node => node.type === 'button' && text(node) === 'Aplicar').props.onClick(); await view.flush();
    assert.deepEqual(headers().slice(1), ['Cliente', 'Vencimento', 'Histórico', 'Saldo', 'Valor', 'Situação', 'Ações']);
    assert.equal(source.posts().length, 0, 'choosing columns never writes a conta');
  } finally { view.unmount(); }
});
