import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { financeParityDb } from './helpers/finance-parity-db.mjs';
import { parseFinanceRoute, executeFinanceRoute } from '../src/finance.mjs';

// Leva H, lane financeiro (375: VND-313, VND-131, EST-053, FIN-103): the contas policy of a sale. Saving a note never lança contas;
// reprocessing the same sale keeps one conta per expected effect; a note from a pedido references the contas of the pedido;
// Destino Caixa only chooses the conta prevista; a grouped baixa keeps one allocation per conta. Synthetic data only.
let env; let db; let users; let scalar; let rpc; let contact; let product; let saleNature; let caixa;
const named = (expected, errcode) => error => error.message === expected && (!errcode || error.code === errcode);
let next = 9100;
const note = () => ({ model: '55', direction: '1', issue_type: 'T', number: String(next++), series: '1', nature_id: saleNature.id, issue_date: '2026-10-10', crt: '1', purpose: '1', presence: '1', final_consumer: false,
  recipient: { contact_id: contact.id, name: 'Cliente política sintético', person_type: 'J', document: '12345678000190', state: 'SP' },
  items: [{ product_id: product.id, description: 'Peça política', quantity: '2', unit_price: '50' }], payment: { installments: [{ date: '2026-11-10', amount: '100.00', method: '15' }] } });
const createNote = async (orders = []) => (await rpc('erp_fiscal_invoice_execute', { p_user_id: users.admin, p_command_id: randomUUID(), p_action: 'create', p_data: { invoice: note(), orders } })).invoice;
const transition = async (d, status) => (await rpc('erp_document_transition', { p_user_id: users.admin, p_kind: d.kind, p_id: d.id, p_expected_version: d.version, p_command_id: randomUUID(), p_status: status, p_reason: 'Teste sintético' })).document;
const fresh = async d => ({ ...d, version: Number(await scalar('select version as value from erp_documents.document where id=$1', [d.id])) });
async function order(kind = 'sales_orders', body = {}) {
  let d = (await rpc('erp_document_save', { p_user_id: users.admin, p_kind: kind, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: { date: '2026-10-10', contact_id: contact.id,
    items: [{ product_id: product.id, description: 'Peça política', unit: 'UN', quantity: '2', unit_price: '50', discount_percent: '0' }],
    installments: [{ due_date: '2026-11-10', amount: '60.00' }, { due_date: '2026-12-10', amount: '40.00' }], ...body } })).document;
  if (kind === 'sales_orders') for (const status of d.status === 'draft' ? ['open', 'verified'] : ['verified']) d = await transition(d, status);
  return d;
}
const preview = d => rpc('erp_document_finance_preview', { p_user_id: users.admin, p_kind: d.kind, p_document_id: d.id, p_expected_version: d.version });
const postOrder = async (d, command = randomUUID()) => rpc('erp_document_finance_post', { p_user_id: users.admin, p_kind: d.kind, p_document_id: d.id, p_expected_version: d.version, p_command_id: command, p_preview_hash: (await preview(d)).preview.preview_hash });
const titlesOf = d => scalar("select count(*)::int as value from erp_finance.document_title l join erp_finance.document_posting p on p.id=l.posting_id where p.document_id=$1 and p.state='active'", [d.id]);

before(async () => {
  env = await financeParityDb({});
  ({ db, users, scalar, rpc } = env);
  await db.exec('ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text');
  await env.addUsers();
  await db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,$1::jsonb,$2)", [JSON.stringify({ state: 'SP', cnpj: '11.222.333/0001-81' }), users.admin]);
  await db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1)", [users.admin]);
  product = (await rpc('erp_catalog_save', { p_user_id: users.admin, p_entity: 'products', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: 'Peça política', code: 'P-375', unit: 'UN', kind: 'P', format: 'S', price: '50', ncm: '84714900' } })).record;
  contact = await env.contact({ name: 'Cliente política sintético', person_type: 'J', document: '12345678000190', state: 'SP' });
  saleNature = (await rpc('erp_fiscal_nature_execute', { p_user_id: users.admin, p_command_id: randomUUID(), p_action: 'create', p_data: { nature: { description: 'Venda 375', direction: '1', crt: '1' } } })).nature;
  caixa = (await rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: { account_type: 'cash', name: 'Caixa sintético', start_on: '2020-01-01', opening_cents: '0' } })).record;
});
after(async () => db?.close());

test('375 saving a NF-e draft never lança contas, even with "Lançamento automático de contas em Notas Fiscais" on', async () => {
  const page = await rpc('erp_preferences_page', { p_user_id: users.admin, p_page: 'vendas-vendas' });
  const pref = page.items.find(item => item.key === 'vendas.contas_automaticas_nota');
  await rpc('erp_preferences_save', { p_user_id: users.admin, p_command_id: randomUUID(), p_page: 'vendas-vendas', p_changes: JSON.stringify([{ key: pref.key, expected_version: pref.version, value: true }]) });
  const before = Number(await scalar('select count(*) as value from erp_finance.title'));
  const draft = await createNote();
  assert.equal(Number(await scalar('select count(*) as value from erp_finance.title')), before);
  assert.equal(await scalar('select count(*)::int as value from erp_finance.invoice_posting where invoice_id=$1', [draft.id]), 0);
  assert.equal((await rpc('erp_finance_invoice_order_titles', { p_user_id: users.consulta, p_invoice_id: draft.id })).owner, null, 'nobody lançou contas for this sale yet');
});

test('375 reprocessing the same sale keeps one conta per expected effect, and the note of the pedido references them', async () => {
  let d = await order();
  const command = randomUUID(), hash = (await preview(d)).preview.preview_hash;
  const args = { p_user_id: users.admin, p_kind: d.kind, p_document_id: d.id, p_expected_version: d.version, p_command_id: command, p_preview_hash: hash };
  const posted = await rpc('erp_document_finance_post', args);
  assert.equal(await titlesOf(d), 2);
  // The same command again: the same contas, no new one; the same command with another request is refused.
  const replay = await rpc('erp_document_finance_post', args);
  assert.deepEqual(replay.titles.map(t => t.id).sort(), posted.titles.map(t => t.id).sort());
  await assert.rejects(() => rpc('erp_document_finance_post', { ...args, p_preview_hash: 'f'.repeat(64) }), named('erp_document_finance_command_conflict'));
  assert.equal(await titlesOf(d), 2);
  d = await fresh(d);
  // Another command, a reprocessed confirmation, an automatic posting: still the same two contas.
  await assert.rejects(() => preview(d), named('erp_document_finance_already_posted'));
  d = await transition(await fresh(d), 'in_progress');
  assert.equal(await titlesOf(d), 2);
  assert.equal(await scalar("select count(*)::int as value from erp_finance.document_posting where document_id=$1 and state='active'", [d.id]), 1);
  assert.equal(await scalar('select count(*)::int as value from erp_finance.commission_operation where document_id=$1 and state=$2', [d.id, 'active']), 0, 'no seller, no commission');
  // The note generated from the pedido references the contas of the pedido and cannot lançar others.
  const derived = await createNote([d.id]);
  const refs = await rpc('erp_finance_invoice_order_titles', { p_user_id: users.consulta, p_invoice_id: derived.id });
  assert.equal(refs.owner, 'orders');
  assert.deepEqual(refs.orders.map(o => [o.document_id, o.effect.owner, o.effect.titles.map(t => t.amount_cents)]), [[d.id, 'document', ['6000', '4000']]]);
  assert.deepEqual(refs.orders[0].effect.titles.map(t => t.id).sort(), posted.titles.map(t => t.id).sort());
  await assert.rejects(() => rpc('erp_finance_invoice_finance_preview', { p_user_id: users.financeiro, p_invoice_id: derived.id, p_expected_version: derived.version, p_category_id: null, p_account_id: null }), named('erp_finance_invoice_order_posted', '40001'));
  // The owner of the effect of the sale, the policy the faturamento parcial (lane documentos) uses for each note of a pedido.
  const effect = await scalar('select erp_finance.sale_effect($1) as value', [d.id]);
  assert.deepEqual([effect.owner, effect.id, effect.titles.length], ['document', posted.posting.id, 2]);
  // The Worker route.
  const route = await parseFinanceRoute(new Request(`https://api.example.test/v1/financeiro/notas/${derived.id}/contas-pedido`));
  const http = await executeFinanceRoute(route, { userId: users.consulta, rpc: (name, args) => rpc(name, args) });
  assert.deepEqual([http.owner, http.orders[0].number, http.orders[0].effect.titles.length], ['orders', String(d.number), 2]);
});

test('375 Destino Caixa only chooses the conta prevista: the contas stay open, no baixa and no movement (VND-131, EST-053)', async () => {
  for (const kind of ['sales_orders', 'purchase_orders']) {
    const d = await order(kind, { payment_account_id: caixa.id });
    const posted = await postOrder(await fresh(d));
    const rows = (await db.query('select t.account_id,t.settled_cents::text s,t.kind from erp_finance.title t where t.id = any($1::uuid[])', [posted.titles.map(t => t.id)])).rows;
    assert.deepEqual(rows.map(r => [r.account_id, r.s]), [[caixa.id, '0'], [caixa.id, '0']], kind);
    assert.equal(await scalar('select count(*)::int as value from erp_finance.settlement where title_id = any($1::uuid[])', [posted.titles.map(t => t.id)]), 0);
    assert.equal(await scalar('select count(*)::int as value from erp_finance.movement where account_id=$1 and settlement_id is not null', [caixa.id]), 0);
    assert.equal(posted.cash_movement_performed ?? false, false);
  }
});

test('375 a grouped baixa keeps one allocation (baixa and movement) per conta, with juros, desconto and tarifa identified (FIN-103)', async () => {
  const d = await order('sales_orders');
  const posted = await postOrder(await fresh(d));
  const items = posted.titles.map((t, i) => ({ id: t.id, expected_version: 1, account_id: caixa.id, category_id: null, posted_on: '2026-10-20',
    principal_cents: i ? '4000' : '6000', interest_cents: i ? '0' : '150', penalty_cents: '0', discount_cents: i ? '200' : '0', fee_cents: i ? '0' : '90' }));
  const result = await rpc('erp_finance_bordero_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'settle_batch', p_data: { kind: 'receivable', grouped: true, account_id: caixa.id, category_id: null, note: 'Recebimento agrupado sintético', items } });
  assert.equal(result.borderos.length, 1);
  const rows = (await db.query('select s.title_id,s.principal_cents::text p,s.interest_cents::text i,s.discount_cents::text d,s.fee_cents::text f,(select count(*)::int from erp_finance.movement m where m.settlement_id=s.id) moves from erp_finance.settlement s where s.title_id = any($1::uuid[]) order by s.principal_cents desc', [posted.titles.map(t => t.id)])).rows;
  assert.deepEqual(rows.map(r => [r.p, r.i, r.d, r.f, r.moves]), [['6000', '150', '0', '90', 1], ['4000', '0', '200', '0', 1]]);
  assert.equal(await scalar('select count(distinct b.bordero_id)::int as value from erp_finance.bordero_item b join erp_finance.settlement s on s.id=b.settlement_id where s.title_id = any($1::uuid[])', [posted.titles.map(t => t.id)]), 1);
});
