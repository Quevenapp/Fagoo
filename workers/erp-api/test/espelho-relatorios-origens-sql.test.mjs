import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { espelhoHFixture, fails } from './helpers/espelho-h-fixture.mjs';
import { parseFinanceRoute, executeFinanceRoute } from '../src/finance.mjs';
import { stockOperation, stockResponse, stockRoute } from '../src/stock.mjs';

// Leva H, lane espelho on PGlite with synthetic data only:
// 363 (FIN-156) letras de origem do extrato for the contas imported from the Origin (origem declared in the mirror payload);
// 364 (EST-072) Tipo de Origem "Origem excluída" in the extrato de estoque, keeping the historical identification and the balance.
let f, caixa, receita, despesa, alfa;
const titleCreate = async (kind, description, command = randomUUID()) => ({ command, title: (await f.rpc('erp_finance_title_execute', { p_user_id: f.users.financeiro, p_command_id: command, p_action: 'title_create',
  p_data: { kind, contact_id: alfa.id, category_id: kind === 'receivable' ? receita.id : despesa.id, description, issued_on: '2026-04-01', competence_on: '2026-04-01', total_cents: '1000', installments: [{ amount_cents: '1000', due_on: '2026-04-20' }] } })).items[0] });
const settle = (title, kind) => f.rpc('erp_finance_bordero_execute', { p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_action: 'settle_batch', p_data: { kind, grouped: false,
  items: [{ id: title.id, expected_version: title.version, account_id: caixa.id, category_id: null, posted_on: '2026-04-20', principal_cents: '1000', interest_cents: '0', penalty_cents: '0', discount_cents: '0', fee_cents: '0' }] } });
/** The provenance row the 039 import keeps, as a conta imported from the Origin has it, plus the mirror payload of that conta. */
const fromOrigin = async ({ title, command }, entity, sourceId, origem) => {
  await f.mirror(entity, sourceId, { id: Number(sourceId), valor: 10, situacao: 1, ...(origem === undefined ? {} : { origem }) }, { resource: entity });
  await f.db.query("insert into erp_finance.origin_import_origin(entity,source_id,title_id,command_id,evidence) values($1,$2,$3,$4,'{}')", [entity, sourceId, title.id, command]);
};
const financeWorker = async (path, user = f.users.consulta) => executeFinanceRoute(await parseFinanceRoute(new Request(`https://api.example.test${path}`)), { userId: user, rpc: (name, args) => f.rpc(name, args) });

before(async () => {
  f = await espelhoHFixture();
  alfa = await f.catalog('contacts', { name: 'Alfa Sintética' });
  caixa = (await f.rpc('erp_finance_account_execute', { p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: { account_type: 'cash', name: 'Caixa sintético', start_on: '2026-01-01', opening_cents: '0' } })).record;
  const category = data => f.rpc('erp_finance_category_execute', { p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_action: 'category_create', p_data: data });
  receita = (await category({ kind: 'receivable', name: 'Vendas' })).record; despesa = (await category({ kind: 'payable', name: 'Compras' })).record;
});
after(() => f?.close());

test('363 extrato: V and N from the origin a Origin conta declares, P/R otherwise; nothing is posted to show a letter', async () => {
  const native = await titleCreate('receivable', 'Conta nativa'), sale = await titleCreate('receivable', 'Conta Origin da venda'), note = await titleCreate('payable', 'Conta Origin da nota');
  const contract = await titleCreate('receivable', 'Conta Origin de contrato'), bare = await titleCreate('payable', 'Conta Origin sem origem');
  await fromOrigin(sale, 'receivables', '4001', { id: 15, tipoOrigem: 'venda', numero: '0015', url: 'https://private.invalid/x' });
  await fromOrigin(note, 'payables', '4002', { id: 16, tipoOrigem: 'nfe', numero: 321 });
  await fromOrigin(contract, 'receivables', '4003', { id: 17, tipoOrigem: 'contrato', numero: '9' });
  await fromOrigin(bare, 'payables', '4004', undefined);
  for (const [item, kind] of [[native, 'receivable'], [sale, 'receivable'], [note, 'payable'], [contract, 'receivable'], [bare, 'payable']]) await settle(item.title, kind);
  const before = await f.scalar('select (select count(*) from erp_finance.title)::text||\'/\'||(select count(*) from erp_finance.movement)::text v');
  const page = await f.rpc('erp_finance_statement_page', { p_user_id: f.users.consulta, p_from: '2026-04-01', p_to: '2026-04-30' });
  const doc = id => page.items.find(line => line.line_kind === 'settlement' && line.title_id === id).document;
  assert.equal(doc(native.title.id), null, 'R: a native conta without a document link');
  assert.deepEqual(doc(sale.title.id), { kind: 'sales_orders', number: '15', source: 'origin' });
  assert.deepEqual(doc(note.title.id), { kind: 'fiscal_invoices', number: '321', source: 'origin' });
  assert.equal(doc(contract.title.id), null, 'another tipo de origem keeps P/R'); assert.equal(doc(bare.title.id), null);
  assert.equal(await f.scalar('select (select count(*) from erp_finance.title)::text||\'/\'||(select count(*) from erp_finance.movement)::text v'), before, 'reading the extrato creates nothing');
  // Through the Worker contract: the Origin mark stays, any other source is refused.
  const projected = await financeWorker('/v1/financeiro/extrato?from=2026-04-01&to=2026-04-30');
  assert.deepEqual(projected.items.filter(line => line.document).map(line => [line.title_kind, line.document]).sort(),
    [['payable', { kind: 'fiscal_invoices', number: '321', source: 'origin' }], ['receivable', { kind: 'sales_orders', number: '15', source: 'origin' }]]);
  const { projectCashResult } = await import('../src/finance-cash.mjs');
  const route = { kind: 'statement', cash: true, rpc: 'erp_finance_statement_page', args: { p_account: null, p_from: '2026-04-01', p_to: '2026-04-30', p_tab: 'all', p_deleted: false, p_categories: null, p_amount_cents: null, p_query: null, p_order: 'asc', p_page: 1, p_limit: 100, p_reconciliation: null } };
  const raw = await f.rpc('erp_finance_statement_page', { p_user_id: f.users.consulta, ...route.args });
  assert.equal(projectCashResult(route, raw).items.length, raw.items.length);
  const tampered = structuredClone(raw); tampered.items.find(line => line.document).document.source = 'outro';
  assert.throws(() => projectCashResult(route, tampered), error => error.status === 502);
  const wrongKind = structuredClone(raw); Object.assign(wrongKind.items.find(line => line.document?.source === 'origin').document, { kind: 'service_orders' });
  assert.throws(() => projectCashResult(route, wrongKind), error => error.status === 502);
  // 363 is applied once: the previous definition is hash-checked.
  await assert.rejects(f.migrate('202610210363_finance_statement_origin_origin.sql'), e => e.code === '55000' && /finance_statement_363_previous_definition_changed/.test(e.message));
  await f.db.exec('rollback');
});

const warehouse = async name => (await f.rpc('erp_stock_warehouse_save', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_warehouse_id: null, p_expected_version: 0, p_expected_setting_version: 0, p_name: name, p_ignore_balance: false })).warehouse;
const version = async (item, target) => (await f.scalar('select coalesce((select version from erp_stock.balance where product_id=$1 and warehouse_id=$2),0) v', [item, target])) ?? 0;
const launch = async (item, target, kind, quantity) => f.rpc('erp_stock_launch', { p_user_id: f.users.estoque, p_command_id: randomUUID(), p_kind: kind, p_product_id: item, p_warehouse_id: target, p_quantity: quantity,
  p_expected_version: await version(item, target), p_unit_price: null, p_unit_cost: null, p_note: null, p_destination_id: null, p_destination_version: null });
const ledger = (product, origin = null, user = f.users.admin) => f.rpc('erp_stock_ledger', { p_user_id: user, p_product_id: product, p_warehouse_id: null, p_kind: null, p_origin: origin, p_date_from: null, p_date_to: null, p_limit: 100, p_offset: 0, p_direction: null });

test('364 extrato de estoque: Origem excluída keeps the note of the lançamento and its balance; Notas Fiscais while the note exists', async () => {
  await f.db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,'{\"state\":\"SP\",\"cnpj\":\"11222333000181\"}',$1) on conflict do nothing", [f.users.admin]);
  await f.db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1) on conflict do nothing", [f.users.admin]);
  const nature = (await f.rpc('erp_fiscal_nature_execute', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: 'create', p_data: { nature: { description: 'Compra sintética 364', direction: '0', crt: '1', presence: '9' } } })).nature;
  const depot = await warehouse('Depósito 364'), product = await f.catalog('products', { name: 'Peça 364', unit: 'UN', kind: 'P', format: 'S', price: '10' });
  await launch(product.id, depot.id, 'receipt', '5');
  const invoice = (await f.rpc('erp_fiscal_invoice_execute', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: 'create', p_data: { orders: [], invoice: { model: '55', direction: '0', issue_type: 'T', series: '1', number: '364001',
    nature_id: nature.id, issue_date: '2026-10-20', crt: '1', purpose: '1', presence: '9', final_consumer: false, recipient: { name: 'Fornecedor sintético 364', person_type: 'J', document: '12345678000190', state: 'SP' },
    items: [{ product_id: product.id, description: 'Peça 364', code: 'P-364', unit: 'UN', quantity: '3', unit_price: '10' }], payment: { installments: [{ date: '2026-11-20', amount: '30.00' }] } } } })).invoice;
  const current = async () => f.scalar('select version v from erp_fiscal_invoices.invoice where id=$1', [invoice.id]);
  const preview = (await f.rpc('erp_stock_invoice_preview', { p_user_id: f.users.estoque, p_invoice_id: invoice.id, p_expected_version: await current(), p_warehouse_id: depot.id })).preview;
  const posted = await f.rpc('erp_stock_invoice_post', { p_user_id: f.users.estoque, p_command_id: randomUUID(), p_invoice_id: invoice.id, p_expected_version: await current(), p_warehouse_id: depot.id, p_preview_hash: preview.preview_hash });
  assert.deepEqual((await ledger(product.id, 'invoices')).items.map(row => [row.id, row.origin.type, row.origin.document_id]), [[posted.movement.id, 'invoices', invoice.id]], 'Notas Fiscais with a real invoice link');
  // Estornar estoque, then Excluir the note: both lançamentos stay in the extrato and in the balance, as Origem excluída.
  const flag = (await f.rpc('erp_stock_invoice_get', { p_user_id: f.users.estoque, p_invoice_id: invoice.id })).flag;
  const reversePreview = (await f.rpc('erp_stock_invoice_reverse_preview', { p_user_id: f.users.estoque, p_invoice_id: invoice.id, p_posting_id: flag.posting_id, p_posting_version: flag.posting_version })).preview;
  const reversed = await f.rpc('erp_stock_invoice_reverse', { p_user_id: f.users.estoque, p_command_id: randomUUID(), p_invoice_id: invoice.id, p_posting_id: flag.posting_id, p_posting_version: flag.posting_version, p_preview_hash: reversePreview.preview_hash });
  await f.rpc('erp_fiscal_invoice_execute', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: 'delete', p_data: { id: invoice.id, expected_version: await current(), reason: 'Nota sintética excluída' } });
  assert.notEqual(await f.scalar('select deleted_at v from erp_fiscal_invoices.invoice where id=$1', [invoice.id]), null);
  const balanceBefore = (await ledger(product.id)).totals.current_balance;
  const deleted = await ledger(product.id, 'deleted');
  assert.deepEqual(deleted.items.map(row => [row.id, row.origin.type, row.origin.document_id, row.origin.document_kind, row.origin.via]).sort(),
    [[posted.movement.id, 'deleted', invoice.id, 'nfe_entrada', 'invoice_stock'], [reversed.movement.id, 'deleted', invoice.id, 'nfe_entrada', 'invoice_stock']].sort());
  assert.equal(deleted.items.find(row => row.id === posted.movement.id).origin.document_number, '364001', 'the number of the deleted note stays');
  assert.equal((await ledger(product.id, 'invoices')).total, 0, 'a deleted note is no longer Notas Fiscais');
  const all = await ledger(product.id);
  assert.deepEqual([all.total, all.totals.current_balance, balanceBefore], [3, '5.000000', '5.000000'], 'the lançamentos stay in the balance (5 + 3 − 3)');
  assert.equal(await f.scalar('select count(*)::int v from erp_stock.movement'), 3, 'nothing is posted to fill the filter');
  // The other screens keep the historical type of the origin (erp_stock.ledger_origin is unchanged).
  assert.equal(await f.scalar("select erp_stock.ledger_origin($1)->>'type' v", [posted.movement.id]), 'invoices');
  // Through the Worker: the filter Origem excluída, the strict origin shape and the hash check of 364.
  const route = stockRoute('/v1/estoque/movimentos');
  const params = new URLSearchParams({ product_id: product.id, origin: 'deleted', offset: '0' }), operation = await stockOperation(new Request(`https://api.example.test/v1/estoque/movimentos?${params}`), route, params);
  assert.equal(operation.args.p_origin, 'deleted');
  const raw = await f.rpc(operation.rpc, { p_user_id: f.users.admin, ...operation.args }), projected = stockResponse(raw, route, operation);
  assert.deepEqual(projected.items.map(row => row.origin.type), ['deleted', 'deleted']);
  const broken = structuredClone(raw); broken.items[0].origin.document_id = null;
  assert.throws(() => stockResponse(broken, route, operation), error => error.status === 502);
  const mixed = structuredClone(raw); mixed.items[0].origin.type = 'invoices';
  assert.throws(() => stockResponse(mixed, route, operation), error => error.status === 502, 'an answer of another Tipo de Origem');
  const bad = new URLSearchParams({ product_id: product.id, origin: 'excluida', offset: '0' });
  await assert.rejects(async () => stockOperation(new Request(`https://api.example.test/v1/estoque/movimentos?${bad}`), route, bad), error => error.status === 400);
  await fails(assert, () => ledger(product.id, 'excluida'), '22023');
  await assert.rejects(f.migrate('202610210364_stock_ledger_deleted_origin.sql'), e => e.code === '55000' && /stock_ledger_364_previous_definition_changed/.test(e.message));
  await f.db.exec('rollback');
});
