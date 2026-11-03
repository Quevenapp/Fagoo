import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { emptyFinanceRoute, financeListRoute, financeListParams, financeListApiPath, financeTitlePageApiPath, financeTitlePage, financeDetailRecord, statusParam, routeStatuses, FINANCE_TITLE_PAGE_SIZE } from '../src/lib/finance-list-route.ts';
import { titleChips, titleOptions, panelFields, panelActions, standardColumns, customColumns, titleIdentification, titleNet, titleRowActions, titleAllows, planTitleBatch, batchBalance, titleBatchCommand, savedTitleId, originPath, originText, dateFieldLabel, dateFieldFromLabel, titleSearchPlaceholder, titleStatusLabel, categoryOptionsPage } from '../src/lib/finance-title-list.ts';
import { parseFinanceRoute } from '../../../workers/erp-api/src/finance.mjs';

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const doc = '30000000-0000-4000-8000-000000000001', category = '20000000-0000-4000-8000-000000000001';
const title = (n, extra = {}) => ({ id: id(n), kind: 'receivable', version: 3, group_id: id(900), installment: 1, installments: 1, contact_id: id(800), contact_name: 'Contato sintético', category_id: null, category_name: null, description: `Conta ${n}`, source_reference: null, issued_on: '2026-01-01', due_on: '2026-02-01', amount_cents: '1000', settled_cents: '0', balance_cents: '1000', cancelled: false, status: 'open', overdue: false, document_linked: false, origin: null, ...extra });

const ACCOUNT = '40000000-0000-4000-8000-000000000001';
const payments = { settled_on: null, fee_cents: '0', interest_cents: '0', penalty_cents: '0', discount_cents: '0', settled_by_return: false };
const row = (n, extra = {}) => ({ ...title(n), competence_on: '2026-01-01', account_id: null, account_name: null, bank_number: null, interest_month_bp: 0, penalty_bp: 0, original_due_on: '2026-02-01', deleted_at: null, remittance: null, imported: false, payments, ...extra });
const page = (route, items, total = items.length) => ({ entity: 'titles', data_mode: 'erp_native', kind: route.area, option: route.option, page: route.page, limit: 100, order: route.order, total, totals: { count: total, amount_cents: '3000', balance_cents: '2000', fee_cents: '0' }, items });

test('109 URL state: Opção and Origin filters round-trip canonically and invalid values never become an unfiltered list', () => {
  const route = financeListRoute(new URLSearchParams(`area=payable&q=Fornecedor&opcao=issued&status=paid,cancelled&from=2026-01-01&to=2026-01-31&date=competence&conta=${ACCOUNT}&category=${category},none&valor=250000&doc=NF%2010&order=due_desc&page=3`));
  assert.deepEqual(route, { area: 'payable', q: 'Fornecedor', option: 'issued', status: 'cancelled,paid', from: '2026-01-01', to: '2026-01-31', date: 'competence', account: ACCOUNT, category: `none,${category}`, remittance: '', value: '250000', doc: 'NF 10', order: 'due_desc', page: 3 });
  assert.deepEqual(financeListRoute(financeListParams(route)), route);
  assert.equal(financeListParams(emptyFinanceRoute('receivable')).toString(), 'area=receivable');
  assert.equal(financeListParams({ ...emptyFinanceRoute('receivable'), option: 'settled', date: 'settled' }).toString(), 'area=receivable&opcao=settled', 'the date of Recebidas is implied');
  assert.deepEqual(routeStatuses(route), ['cancelled', 'paid']); assert.equal(statusParam(['paid', 'open']), 'open,paid'); assert.equal(statusParam([]), '');
  assert.equal(financeListRoute(new URLSearchParams('area=receivable&opcao=open&remessa=yes')).remittance, 'yes');
  assert.equal(financeListRoute(new URLSearchParams('area=receivable&conta=none')).account, 'none');
  for (const params of ['area=receivable&opcao=all', 'area=receivable&status=open', 'area=receivable&opcao=issued&status=open,open', 'area=receivable&opcao=issued&status=overdue', 'area=receivable&date=issued', 'area=receivable&opcao=settled&date=due',
    'area=receivable&order=name', 'area=receivable&page=0', 'area=receivable&page=100001', 'area=receivable&page=1.5', 'area=receivable&category=abc', 'area=receivable&category=none,none',
    'area=receivable&valor=1,00', 'area=receivable&valor=010', 'area=receivable&valor=0', 'area=receivable&valor=1000000000000000', 'area=receivable&conta=x', 'area=receivable&remessa=sim', 'area=receivable&opcao=overdue&remessa=yes', 'area=payable&remessa=yes',
    'area=receivable&doc=NF', `area=payable&doc=${'x'.repeat(61)}`, 'area=payable&doc=a%0Ab', 'area=accounts&page=2', 'area=categories&order=due_desc', 'area=accounts&opcao=issued', 'area=accounts&conta=none',
    'area=accounts&category=none', 'area=accounts&valor=1', 'area=receivable&page=1&page=2', 'area=receivable&sort=valor', 'area=receivable&min=1'])
    assert.throws(() => financeListRoute(new URLSearchParams(params)), /Confira os filtros/, params);
});

test('109 page request carries every filter and the effective period to the strict Worker parser', async () => {
  const route = financeListRoute(new URLSearchParams(`area=receivable&q=12.345.678/0001-90&opcao=issued&status=open,partial&from=2026-01-01&to=2026-01-31&date=issued&conta=none&category=none&valor=100&order=due_desc&page=2`));
  const path = financeTitlePageApiPath(route, '2026-10-20');
  assert.equal(path, '/v1/financeiro/titles?page=2&limit=100&kind=receivable&option=issued&order=due_desc&q=12.345.678%2F0001-90&status=open%2Cpartial&date=issued&from=2026-01-01&to=2026-01-31&account=none&category=none&amount_cents=100');
  const parsed = await parseFinanceRoute(new Request(`https://synthetic.invalid${path}`));
  assert.deepEqual(parsed.args, { p_kind: 'receivable', p_page: 2, p_limit: 100, p_order: 'due_desc', p_query: '12.345.678/0001-90', p_option: 'issued', p_statuses: ['open', 'partial'], p_date_field: 'issued', p_from: '2026-01-01', p_to: '2026-01-31', p_account: 'none', p_categories: ['none'], p_remittance: null, p_amount_cents: '100', p_document: null });
  const plain = await parseFinanceRoute(new Request(`https://synthetic.invalid${financeTitlePageApiPath(emptyFinanceRoute('payable'), '2026-10-20')}`));
  assert.deepEqual(plain.args, { p_kind: 'payable', p_page: 1, p_limit: 100, p_order: 'due_asc', p_query: null, p_option: 'open', p_statuses: null, p_date_field: 'due', p_from: '2026-09-01', p_to: '2026-11-30', p_account: null, p_categories: null, p_remittance: null, p_amount_cents: null, p_document: null });
  assert.equal(plain.rpc, 'erp_finance_title_page_v2');
  const remittance = await parseFinanceRoute(new Request(`https://synthetic.invalid${financeTitlePageApiPath(financeListRoute(new URLSearchParams('area=receivable&remessa=no')), '2026-10-20')}`));
  assert.equal(remittance.args.p_remittance, 'no');
  const settled = await parseFinanceRoute(new Request(`https://synthetic.invalid${financeTitlePageApiPath(financeListRoute(new URLSearchParams('area=payable&opcao=settled&doc=NF')), '2026-10-20')}`));
  assert.deepEqual([settled.args.p_option, settled.args.p_date_field, settled.args.p_document], ['settled', 'settled', 'NF']);
  assert.throws(() => financeTitlePageApiPath(emptyFinanceRoute('accounts'), '2026-10-20'));
  assert.throws(() => financeListApiPath(route, null), 'contas use the numbered page');
  assert.match(financeListApiPath(emptyFinanceRoute('accounts'), null), /^\/v1\/financeiro\/accounts\?limit=25$/);
  assert.equal((await parseFinanceRoute(new Request('https://synthetic.invalid/v1/financeiro/titles?kind=receivable&status=open&limit=15&q=x'))).rpc, 'erp_finance_list', 'CNAB cursor reads are unchanged');
});

test('109 page response is bound to the requested page, Opção, order and filters', () => {
  const route = financeListRoute(new URLSearchParams(`area=receivable&from=2026-01-01&to=2026-12-31&category=${category}&conta=${ACCOUNT}&page=2`));
  const items = [row(1, { category_id: category, account_id: ACCOUNT, account_name: 'Banco' }), row(2, { category_id: category, account_id: ACCOUNT, account_name: 'Banco', due_on: '2026-03-01', status: 'partial', overdue: true }),
    row(3, { category_id: category, account_id: ACCOUNT, account_name: 'Banco', due_on: '2026-03-01', document_linked: true, origin: { document_id: doc, kind: 'sales_orders', number: '4242' } })];
  const value = page(route, items, 103), checked = financeTitlePage(value, route, '2026-10-20');
  assert.equal(checked.items.length, 3); assert.deepEqual(checked.items[2].origin, { document_id: doc, kind: 'sales_orders', number: '4242' }); assert.notEqual(checked.items, value.items);
  assert.equal(FINANCE_TITLE_PAGE_SIZE, 100);
  for (const [label, mutate] of [['page', v => { v.page = 1; }], ['option', v => { v.option = 'issued'; }], ['limit', v => { v.limit = 25; }], ['order', v => { v.order = 'due_desc'; }], ['kind', v => { v.kind = 'payable'; }], ['count', v => { v.totals.count = 104; }],
    ['amount', v => { v.totals.amount_cents = 3000; }], ['fee', v => { v.totals.fee_cents = '1.5'; }], ['size', v => { v.total = 300; }], ['missing', v => { v.items.pop(); }], ['order of rows', v => { v.items.reverse(); }], ['duplicate', v => { v.items[1] = { ...v.items[0] }; }],
    ['date', v => { v.items[0].due_on = '2025-12-31'; }], ['paid in Em aberto', v => { v.items[0].status = 'paid'; v.items[0].balance_cents = '0'; }], ['cancelled in Em aberto', v => { v.items[0].cancelled = true; }], ['deleted', v => { v.items[0].deleted_at = '2026-10-20T10:00:00Z'; }],
    ['category', v => { v.items[0].category_id = null; }], ['account', v => { v.items[0].account_id = null; }], ['payments', v => { v.items[0].payments = { ...payments, fee_cents: 1 }; }], ['remittance', v => { v.items[0].remittance = { id: 'x' }; }], ['imported', v => { delete v.items[0].imported; }],
    ['origin without link', v => { v.items[0].origin = { document_id: doc, kind: 'sales_orders', number: '1' }; }], ['link without origin', v => { v.items[2].origin = null; }], ['payable origin', v => { v.items[2].origin.kind = 'purchase_orders'; }], ['number', v => { v.items[2].origin.number = 'PV-1'; }]]) {
    const bad = structuredClone(value); mutate(bad); assert.throws(() => financeTitlePage(bad, route, '2026-10-20'), /Confira os filtros/, label);
  }
  const last = financeListRoute(new URLSearchParams('area=receivable&page=3&from=2026-01-01&to=2026-12-31'));
  assert.equal(financeTitlePage(page(last, [row(1)], 201), last, '2026-10-20').items.length, 1, 'page 3 of 201 records has one row');
  assert.throws(() => financeTitlePage(page(last, [row(1)], 103), last, '2026-10-20'), 'page 3 of 103 records has exactly 3 rows');
  const fallback = emptyFinanceRoute('receivable');
  assert.throws(() => financeTitlePage(page(fallback, [row(1)]), fallback, '2026-10-20'), 'outside the default period');
  assert.equal(financeTitlePage(page(fallback, [row(1, { due_on: '2026-10-01' })]), fallback, '2026-10-20').items.length, 1);
  const issued = financeListRoute(new URLSearchParams('area=receivable&opcao=issued&date=issued&from=2026-01-01&to=2026-01-01&status=cancelled'));
  assert.equal(financeTitlePage(page(issued, [row(1, { due_on: '2027-01-01', cancelled: true, status: 'cancelled' })]), issued, '2026-10-20').items.length, 1, 'emissão filters issued_on, not due_on');
  const competence = financeListRoute(new URLSearchParams('area=receivable&opcao=issued&date=competence&from=2025-12-01&to=2025-12-31'));
  assert.throws(() => financeTitlePage(page(competence, [row(1)]), competence, '2026-10-20'), 'competência is checked');
  const settled = financeListRoute(new URLSearchParams('area=receivable&opcao=settled&from=2020-01-01&to=2020-01-01'));
  assert.throws(() => financeTitlePage(page(settled, [row(1)]), settled, '2026-10-20'), 'Recebidas need a liquidação');
  assert.equal(financeTitlePage(page(settled, [row(1, { payments: { ...payments, settled_on: '2026-03-01' } })]), settled, '2026-10-20').items.length, 1, 'the date of the baixa is checked by the server');
  const overdue = financeListRoute(new URLSearchParams('area=receivable&opcao=overdue&from=2026-01-01&to=2026-12-31'));
  assert.throws(() => financeTitlePage(page(overdue, [row(1)]), overdue, '2026-10-20'), 'Atrasadas are overdue');
  const remitted = financeListRoute(new URLSearchParams('area=receivable&remessa=yes&from=2026-01-01&to=2026-12-31'));
  assert.throws(() => financeTitlePage(page(remitted, [row(1)]), remitted, '2026-10-20'));
  assert.equal(financeTitlePage(page(remitted, [row(1, { remittance: { id: id(70), sequence: 1, state: 'ready', our_number: '1' } })]), remitted, '2026-10-20').items.length, 1);
  const record = title(4, { document_linked: true });
  assert.deepEqual(financeDetailRecord({ entity: 'titles', data_mode: 'erp_native', record, origin: { document_id: doc, kind: 'service_orders', number: '7' } }, 'titles', record.id, 'receivable').origin, { document_id: doc, kind: 'service_orders', number: '7' });
  assert.throws(() => financeDetailRecord({ entity: 'titles', data_mode: 'erp_native', record, origin: null }, 'titles', record.id, 'receivable'));
  assert.equal(financeDetailRecord({ entity: 'titles', data_mode: 'erp_native', record: title(5) }, 'titles', id(5), 'receivable').origin, null, 'older responses without origin keep working');
});

test('094 Origin labels, chips, origin, ⋮ actions and "Salvar e dar baixa" target', () => {
  assert.equal(titleSearchPlaceholder('receivable'), 'Pesquise por nome, e-mail, CPF/CNPJ, número ou histórico');
  assert.equal(titleSearchPlaceholder('payable'), 'Pesquise por nome, e-mail, CPF/CNPJ ou histórico');
  assert.deepEqual(['receivable', 'payable'].map(kind => dateFieldLabel('settled', kind)), ['Data de Recebimento', 'Data de Pagamento']);
  assert.equal(dateFieldFromLabel('Data de Emissão', 'payable'), 'issued'); assert.equal(dateFieldFromLabel('Data de Competência', 'payable'), 'competence'); assert.equal(dateFieldFromLabel('Outra', 'payable'), 'due');
  assert.deepEqual(['paid', 'partial', 'cancelled'].map(status => titleStatusLabel(status, 'payable')), ['Paga', 'Parcialmente Paga', 'Cancelada']);
  assert.deepEqual(titleOptions('payable').map(option => option.label), ['Em aberto', 'Atrasadas', 'Emitidas', 'Pagas']);
  assert.deepEqual(titleOptions('receivable').map(option => option.label), ['Em aberto', 'Atrasadas', 'Emitidas', 'Recebidas']);
  const route = financeListRoute(new URLSearchParams(`area=payable&q=Alfa&opcao=issued&status=open,cancelled&date=issued&conta=none&category=none,${category}&valor=1050&doc=NF`));
  assert.deepEqual(titleChips(route, 'payable', { categories: new Map([[category, 'Vendas']]) }).map(chip => chip.label), ['Pesquisa: Alfa', 'Opção: Emitidas', 'Situação: Cancelada, Em aberto', 'Filtrar por: Data de Emissão', 'Conta financeira: Sem conta financeira', 'Categoria: Sem categoria, Vendas', 'Valor: R$ 10,50', 'N° documento: NF']);
  assert.deepEqual(titleChips(financeListRoute(new URLSearchParams('area=receivable&remessa=no')), 'receivable').map(chip => chip.label), ['Em remessa: Não incluídas em remessa']);
  assert.deepEqual(titleChips(emptyFinanceRoute('payable'), 'payable'), []);
  assert.deepEqual(panelFields('open', 'receivable'), { date: false, status: false, remittance: true, document: false, seller: true });
  assert.deepEqual(panelFields('issued', 'payable'), { date: true, status: true, remittance: false, document: true, seller: false });
  assert.deepEqual(panelActions('settled'), ['settle', 'category']); assert.deepEqual(panelActions('overdue'), ['settle', 'category', 'cancel']);
  // SQL 175: the Origin padrão of contas a receber has the Forma de pagamento between Histórico and Vencimento.
  assert.deepEqual(standardColumns('receivable', 'open'), ['history', 'payment_method', 'due']); assert.deepEqual(standardColumns('receivable', 'settled'), ['history', 'payment_method', 'due', 'settled_on', 'fee']);
  assert.deepEqual(standardColumns('payable', 'settled'), ['history', 'identification', 'document', 'due', 'settled_on']);
  assert.deepEqual(customColumns('payable', ['fee', 'balance', 'history', 'x', 'balance']), ['balance', 'history'], 'the order chosen by the user, kind-specific columns only');
  assert.equal(titleIdentification({ remittance: { our_number: '123' }, bank_number: 'B' }), '123'); assert.equal(titleIdentification({ remittance: null, bank_number: 'B' }), 'B');
  assert.equal(titleNet({ amount_cents: '10000', payments: { fee_cents: '290' } }), '9710');
  const origin = { document_id: doc, kind: 'sales_orders', number: '4242' };
  assert.equal(originPath(origin), `/documentos-empresa?tipo=sales_orders&documento=${doc}`);
  assert.deepEqual(originText(origin), { field: 'Pedido de origem', menu: 'Abrir pedido de origem', reference: 'Ref. ao pedido de venda nº' });
  assert.equal(originText({ ...origin, kind: 'purchase_orders' }).menu, 'Abrir pedido de compra de origem');
  assert.throws(() => originPath({ ...origin, document_id: '../x' }));
  const labels = value => titleRowActions(value, true).map(entry => entry.label);
  // 108: Origin wording ("Cancelar conta a receber" / "Cancelar"), Clonar, and Excluir only without baixa or document.
  assert.deepEqual(labels(title(1)), ['Editar', 'Baixa total do recebimento', 'Baixa parcial do recebimento', 'Cancelar conta a receber', 'Clonar', 'Excluir']);
  assert.deepEqual(labels(title(1, { kind: 'payable' })), ['Editar', 'Baixa total do pagamento', 'Baixa parcial do pagamento', 'Cancelar', 'Clonar', 'Excluir']);
  assert.deepEqual(labels(title(1, { kind: 'payable', settled_cents: '400', balance_cents: '600', status: 'partial' })), ['Editar', 'Baixa total do pagamento', 'Baixa parcial do pagamento', 'Estornar baixa', 'Clonar']);
  assert.deepEqual(labels(title(1, { settled_cents: '1000', balance_cents: '0', status: 'paid' })), ['Editar', 'Estornar baixa', 'Clonar']);
  assert.deepEqual(labels(title(1, { document_linked: true })), ['Editar', 'Baixa total do recebimento', 'Baixa parcial do recebimento', 'Cancelar conta a receber', 'Clonar']);
  assert.deepEqual(labels(title(1, { cancelled: true, status: 'cancelled' })), ['Clonar', 'Excluir']); assert.deepEqual(titleRowActions(title(1), false), []);
  assert.deepEqual(labels(title(1, { cancelled: true, status: 'cancelled', deleted_at: '2026-10-20T10:00:00Z' })), []);
  // The 108 SQL keeps contas adopted from Origin and contas in a remessa: Excluir is not offered and a batch skips them.
  assert.deepEqual(labels(row(1, { imported: true })), ['Editar', 'Baixa total do recebimento', 'Baixa parcial do recebimento', 'Cancelar conta a receber', 'Clonar']);
  assert.deepEqual(labels(row(1, { remittance: { id: id(70), sequence: 1, state: 'reserved', our_number: null } })), ['Editar', 'Baixa total do recebimento', 'Baixa parcial do recebimento', 'Cancelar conta a receber', 'Clonar']);
  assert.ok(labels(row(1)).includes('Excluir'));
  const removal = planTitleBatch('delete', [row(1), row(2, { imported: true }), row(3, { remittance: { id: id(70), sequence: 1, state: 'ready', our_number: '1' } }), row(4, { document_linked: true })], {});
  assert.deepEqual(removal.eligible.map(item => item.id), [id(1)]);
  assert.deepEqual(removal.skipped.map(item => item.message), ['Conta importada do Origin. Exclua a conta no Origin.', 'Conta incluída em remessa de cobrança.', 'Conta gerada por um documento. Desfaça o lançamento no documento de origem.']);
  assert.equal(savedTitleId({ items: [{ id: id(7), kind: 'receivable', installments: 1 }] }, 'title_create', 'receivable'), id(7));
  assert.equal(savedTitleId({ record: { id: id(9) } }, 'title_edit', 'receivable', id(9)), id(9));
  assert.equal(titleAllows(title(1), 'settle'), true); assert.equal(titleAllows(title(1, { balance_cents: '0' }), 'settle'), false);
  assert.equal(titleAllows(title(1, { settled_cents: '1' }), 'title_cancel'), false); assert.equal(titleAllows(title(1, { cancelled: true }), 'title_update'), false);
  assert.equal(savedTitleId({ items: [{ id: id(7), kind: 'receivable', installments: 1 }] }, 'title_create_group', 'receivable'), id(7));
  assert.equal(savedTitleId({ items: [{ id: id(7), kind: 'payable', installments: 1 }] }, 'title_create_group', 'receivable'), null);
  assert.equal(savedTitleId({ items: [{ id: id(7), kind: 'receivable', installments: 2 }, { id: id(8) }] }, 'title_create_group', 'receivable'), null);
  assert.equal(savedTitleId({ record: { id: id(9) } }, 'title_update', 'receivable', id(9)), id(9));
  assert.equal(savedTitleId({ record: { id: id(8) } }, 'title_update', 'receivable', id(9)), null); assert.equal(savedTitleId(null, 'title_update', 'receivable', id(9)), null);
});

test('094 batches: preview skips what the API would refuse and each item is the existing single-title command', async () => {
  const titles = [title(1), title(2, { cancelled: true, status: 'cancelled' }), title(3, { category_id: category }), title(4, { settled_cents: '400', balance_cents: '600', status: 'partial' }), title(5, { settled_cents: '1000', balance_cents: '0', status: 'paid' }), title(6, { issued_on: '2026-10-20' })];
  const reasons = plan => plan.skipped.map(item => [item.id.slice(-1), item.message]);
  const category_plan = planTitleBatch('category', titles, { categoryId: category });
  assert.deepEqual(category_plan.eligible.map(item => item.id.slice(-1)), ['1', '4', '5', '6']); assert.deepEqual(reasons(category_plan), [['2', 'Conta cancelada.'], ['3', 'Já está nesta categoria.']]);
  const settle = planTitleBatch('settle', titles, { postedOn: '2026-10-19' });
  assert.deepEqual(settle.eligible.map(item => item.id.slice(-1)), ['1', '3', '4']); assert.deepEqual(reasons(settle), [['2', 'Conta cancelada.'], ['5', 'Sem saldo em aberto.'], ['6', 'Emissão posterior à data da baixa.']]);
  assert.equal(batchBalance(settle), '2600');
  const cancel = planTitleBatch('cancel', titles, {});
  assert.deepEqual(cancel.eligible.map(item => item.id.slice(-1)), ['1', '3', '6']); assert.equal(cancel.skipped.find(item => item.id === id(4)).message, 'Possui baixa registrada. Estorne a baixa antes de cancelar.');
  assert.match(settle.eligible[2].label, /Contato sintético · Conta 4 · 1\/1 · R\$ 6,00/);
  const account = id(55);
  for (const [action, params] of [['category', { categoryId: category }], ['settle', { accountId: account, postedOn: '2026-10-19', note: ' Lote ' }], ['cancel', { note: 'Motivo sintético' }]]) {
    const command = titleBatchCommand(action, titles[3], params);
    assert.equal(command.data.id, titles[3].id); assert.equal(command.data.expected_version, 3);
    const request = new Request(`https://synthetic.invalid/v1/financeiro/actions/${command.action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command_id: randomUUID(), data: command.data }) });
    const parsed = await parseFinanceRoute(request); assert.equal(parsed.action, command.action, action);
  }
  assert.deepEqual(titleBatchCommand('settle', titles[3], { accountId: account, postedOn: '2026-10-19' }).data, { id: titles[3].id, expected_version: 3, account_id: account, posted_on: '2026-10-19', principal_cents: '600', interest_cents: '0', penalty_cents: '0', discount_cents: '0', fee_cents: '0', note: null });
  assert.deepEqual(titleBatchCommand('category', titles[0], { categoryId: category }).data, { id: titles[0].id, expected_version: 3, category_id: category });
  assert.throws(() => titleBatchCommand('cancel', titles[0], { note: ' ' })); assert.throws(() => titleBatchCommand('settle', titles[0], { accountId: account }));
});

test('094 category filter options accept only a bound 010 category page', () => {
  const item = n => ({ id: id(n), name: `Categoria ${n}`, kind: 'receivable', active: true, version: 1 });
  const value = { entity: 'categories', data_mode: 'erp_native', limit: 100, items: [item(1), item(2)], has_more: false, next_cursor: null };
  assert.equal(categoryOptionsPage(value, null).items.length, 2);
  for (const mutate of [v => { v.entity = 'titles'; }, v => { v.limit = 25; }, v => { v.items.reverse(); }, v => { v.items[0].kind = 'bank'; }, v => { v.has_more = true; }, v => { v.items[0].active = 'yes'; }]) {
    const bad = structuredClone(value); mutate(bad); assert.throws(() => categoryOptionsPage(bad, null));
  }
  assert.throws(() => categoryOptionsPage(value, id(5)), 'items must follow the cursor');
});
