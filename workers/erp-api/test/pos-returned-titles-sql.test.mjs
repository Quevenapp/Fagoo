import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { posFixture, today } from './helpers/pos-fixture.mjs';

// Synthetic data only. 202610200292: the full return of a sale of the Frente de caixa marks its open contas a receber as Devolvido
// (erp_finance.titles_mark_returned, 281); the cash refund is what the sale received. Every call through the real Worker.
let f;
before(async () => {
  f = await posFixture(); await f.receive(f.product.id, '50');
  const version = Number(await f.scalar('select version v from erp_pos.settings'));
  const saved = await f.call('/v1/frente-caixa/actions/settings_save', 'POST', { command_id: randomUUID(), data: { expected_version: version, consumer_contact_id: f.consumer.id, pix_key_type: null, pix_key: null, pix_merchant_name: null, pix_merchant_city: null } });
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
});
after(async () => f?.close());
const item = (quantity = '2', price = '10') => ({ id: randomUUID(), product_id: f.product.id, description: f.product.name, code: f.product.code ?? null, unit: 'UN', quantity, unit_price: price, discount_percent: '0', detailed_description: null });
const sale = payments => ({ sale_id: null, expected_version: 0, document_version: null, kind: 'balcao', table_number: null, account_id: f.store.id, cash_session_id: null, contact_id: null, price_list_id: null,
  document: { date: today(), warehouse_id: f.warehouse.id, items: [item()], discount_mode: 'amount', discount_value: '0', freight: '0', other_expenses: '0', notes: null, internal_notes: null, seller_id: null, category_id: null },
  payments, destination_account_id: null, to_ledger: false, cash_received_cents: null });
const act = (action, data, user = f.users.admin, command = randomUUID()) => f.call(`/v1/frente-caixa/actions/${action}`, 'POST', { command_id: command, data }, user);
const ok = response => { assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value; };
const titles = async saleId => f.db.query(`select t.amount_cents::text amount,t.settled_cents::text settled,t.cancelled,(select r.source->>'kind' from erp_finance.title_return r where r.title_id=t.id) returned
  from erp_pos.sale s join erp_finance.document_posting p on p.document_id=s.document_id and p.state='active' join erp_finance.document_title l on l.posting_id=p.id join erp_finance.title t on t.id=l.title_id
  where s.id=$1 order by l.position`, [saleId]).then(r => r.rows);
const giveBack = (done, quantity, version = done.version, user = f.users.admin, command) => act('sale_return', { sale_id: done.id, expected_version: version, items: [{ item_id: done.items[0].id, quantity }], refund_account_id: null, cash_session_id: null, reason: 'Defeito de fábrica' }, user, command);

test('full return: the parcela in cash is refunded and the open parcela becomes Devolvido; replay keeps one mark', async () => {
  const done = ok(await act('sale_finish', sale([{ payment_method_id: f.methods.dinheiro, days: 0, amount_cents: '800', note: null }, { payment_method_id: f.methods.cartao, days: 30, amount_cents: '1200', note: null }]))).record;
  const store = await f.balance(f.store.id), command = randomUUID();
  const result = ok(await giveBack(done, '2', done.version, f.users.admin, command));
  assert.deepEqual([result.return.value_cents, result.return.refund_cents, result.return.refund, result.return.returned_titles], ['2000', '800', true, 1]);
  assert.equal(BigInt(await f.balance(f.store.id)), BigInt(store) - 800n);
  assert.deepEqual((await titles(done.id)).map(t => [t.amount, t.settled, t.cancelled, t.returned]), [['800', '800', false, null], ['1200', '0', true, 'pos_return']]);
  assert.equal((ok(await giveBack(done, '2', done.version, f.users.admin, command))).return.returned_titles, 1, 'Conferir resultado answers the same return');
  assert.equal(await f.scalar("select count(*)::int v from erp_finance.title_return r join erp_finance.document_title l on l.title_id=r.title_id join erp_finance.document_posting p on p.id=l.posting_id join erp_pos.sale s on s.document_id=p.document_id where s.id=$1", [done.id]), 1);
});

test('a partial return never marks the parcelas; the last return completes the sale and marks the open one', async () => {
  const done = ok(await act('sale_finish', sale([{ payment_method_id: f.methods.dinheiro, days: 0, amount_cents: '1000', note: null }, { payment_method_id: f.methods.cartao, days: 30, amount_cents: '1000', note: null }]))).record;
  const first = ok(await giveBack(done, '1'));
  assert.deepEqual([first.return.refund_cents, first.return.returned_titles], ['1000', 0]);
  assert.deepEqual((await titles(done.id)).map(t => t.cancelled), [false, false]);
  const last = ok(await giveBack(done, '1', first.record.version));
  assert.deepEqual([last.return.refund_cents, last.return.refund, last.return.returned_titles], ['0', false, 1]);
  assert.deepEqual((await titles(done.id)).map(t => [t.cancelled, t.returned]), [[false, null], [true, 'pos_return']]);
});

test('a parcela received in part blocks the full return until its baixa is reversed; profiles without finance are refused', async () => {
  const done = ok(await act('sale_finish', sale([{ payment_method_id: f.methods.cartao, days: 30, amount_cents: '2000', note: null }]))).record;
  const [open] = (await f.db.query("select t.id,t.version from erp_pos.sale s join erp_finance.document_posting p on p.document_id=s.document_id and p.state='active' join erp_finance.document_title l on l.posting_id=p.id join erp_finance.title t on t.id=l.title_id where s.id=$1", [done.id])).rows;
  await f.rpc('erp_finance_execute', { p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_action: 'settle', p_data: { id: open.id, expected_version: open.version, account_id: f.store.id, posted_on: today(), principal_cents: '500' } });
  assert.equal(await f.scalar('select settled_cents::text v from erp_finance.title where id=$1', [open.id]), '500');
  const refused = await giveBack(done, '2');
  assert.deepEqual([refused.status, refused.value.error?.field], [400, 'return_partial_title']);
  assert.doesNotMatch(JSON.stringify(refused.value), /erp_|SYNTHETIC_SQL/);
  assert.deepEqual((await titles(done.id)).map(t => [t.cancelled, t.returned]), [[false, null]], 'nothing changed');
  const other = ok(await act('sale_finish', sale([{ payment_method_id: f.methods.cartao, days: 30, amount_cents: '2000', note: null }]))).record;
  assert.equal((await giveBack(other, '2', other.version, f.users.estoque)).status, 403);
});
