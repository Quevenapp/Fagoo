import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fiscalWaveFFixture } from './helpers/fiscal-wave-f-fixture.mjs';
import { fiscalInvoicesRefusal } from '../src/fiscal-invoices.mjs';

// Wave F of the notas fiscais lane (synthetic data only): the refusal of deleting a note whose stock (259) or contas (247) were
// posted by it reaches the screen as the field of the error, never the SQL message itself.
let f, sale, buy, product, depot, category, account;
let numbers = 610000;
before(async () => {
  f = await fiscalWaveFFixture();
  await f.company();
  sale = await f.nature({ description: 'Venda F', direction: '1', crt: '1' });
  buy = await f.nature({ description: 'Compra F', direction: '0', crt: '1', presence: '9' });
  product = await f.catalog('products', { name: 'Peça F', code: 'PF-1', unit: 'UN', kind: 'P', format: 'S', price: '10' });
  depot = await f.warehouse('Depósito F');
  category = (await f.rpc('erp_finance_category_execute', { p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_action: 'category_create', p_data: { kind: 'receivable', name: 'Vendas F' } })).record;
  account = (await f.rpc('erp_finance_account_execute', { p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: { account_type: 'checking', institution_code: '341', institution_name: 'Itaú Unibanco', name: 'Conta F', agency: '1', account_number: '2', account_digit: '3', start_on: '2020-01-01', opening_cents: '0' } })).record;
});
after(() => f?.close());
const contact = async () => f.catalog('contacts', { name: `Cliente F ${numbers}`, person_type: 'J', document: '12345678000190', state: 'SP' });
const note = async (direction, contactId) => f.invoice({ model: '55', direction, issue_type: 'T', number: String(++numbers), series: '1', nature_id: direction === '1' ? sale.id : buy.id, issue_date: '2026-10-20', crt: '1', purpose: '1',
  presence: direction === '1' ? '1' : '9', final_consumer: false, recipient: { contact_id: contactId, name: 'Contato F', person_type: 'J', document: '12345678000190', state: 'SP' },
  items: [{ product_id: product.id, description: 'Peça F', code: 'PF-1', unit: 'UN', quantity: '3', unit_price: '10' }], payment: { installments: [{ date: '2026-11-20', amount: '30.00' }] } });
const remove = (invoice, user = f.users.fiscal) => f.call(`/v1/notas-fiscais/${invoice.id}/excluir`, 'POST', { command_id: randomUUID(), expected_version: invoice.version, reason: 'Exclusão sintética F' }, user);

test('the allow-list maps only the two refusals of the lançamentos', () => {
  assert.equal(fiscalInvoicesRefusal('erp_fiscal_invoice_active_finance'), 'finance_posted');
  assert.equal(fiscalInvoicesRefusal('erp_invoice_stock_posted_delete'), 'stock_posted');
  for (const other of ['erp_fiscal_invoice_version_conflict', '', null, undefined, 'toString', '__proto__']) assert.equal(fiscalInvoicesRefusal(other), null, String(other));
});

test('a note with stock posted by it answers 409 with field stock_posted, and is deleted after Estornar estoque', async () => {
  const entry = await note('0', (await contact()).id);
  const preview = await f.rpc('erp_stock_invoice_preview', { p_user_id: f.users.estoque, p_invoice_id: entry.id, p_expected_version: entry.version, p_warehouse_id: depot.id });
  const posted = await f.rpc('erp_stock_invoice_post', { p_user_id: f.users.estoque, p_command_id: randomUUID(), p_invoice_id: entry.id, p_expected_version: entry.version, p_warehouse_id: depot.id, p_preview_hash: preview.preview.preview_hash });
  assert.equal(posted.flag.flag, 'S');
  const refused = await remove(entry);
  assert.equal(refused.status, 409); assert.deepEqual(Object.keys(refused.value.error).sort(), ['code', 'field', 'request_id']);
  assert.deepEqual([refused.value.error.code, refused.value.error.field], ['ERP_CONFLICT', 'stock_posted']);
  assert.ok(!JSON.stringify(refused.value).includes('erp_invoice_stock'), 'the SQL message never leaves the Worker');
  const back = await f.rpc('erp_stock_invoice_reverse_preview', { p_user_id: f.users.estoque, p_invoice_id: entry.id, p_posting_id: posted.posting.id, p_posting_version: 1 });
  await f.rpc('erp_stock_invoice_reverse', { p_user_id: f.users.estoque, p_command_id: randomUUID(), p_invoice_id: entry.id, p_posting_id: posted.posting.id, p_posting_version: 1, p_preview_hash: back.preview.preview_hash });
  const deleted = await remove(entry);
  assert.equal(deleted.status, 200); assert.ok(deleted.value.invoice.deleted_at);
});

test('a note with contas posted by it answers 409 with field finance_posted; other conflicts keep the plain answer', async () => {
  const exit = await note('1', (await contact()).id);
  const shown = (await f.rpc('erp_finance_invoice_finance_preview', { p_user_id: f.users.financeiro, p_invoice_id: exit.id, p_expected_version: exit.version, p_category_id: category.id, p_account_id: account.id })).preview;
  await f.rpc('erp_finance_invoice_finance_post', { p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_data: { invoice_id: exit.id, expected_version: exit.version, preview_hash: shown.preview_hash, category_id: category.id, account_id: account.id } });
  const refused = await remove(exit);
  assert.deepEqual([refused.status, refused.value.error.code, refused.value.error.field], [409, 'ERP_CONFLICT', 'finance_posted']);
  const stale = await f.call(`/v1/notas-fiscais/${exit.id}/excluir`, 'POST', { command_id: randomUUID(), expected_version: exit.version + 5, reason: 'Exclusão sintética F' }, f.users.fiscal);
  assert.equal(stale.status, 409); assert.equal(Object.hasOwn(stale.value.error, 'field'), false, 'a version conflict carries no field');
});
