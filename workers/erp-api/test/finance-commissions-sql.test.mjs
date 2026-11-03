import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { financeParityDb } from './helpers/finance-parity-db.mjs';
import { parseFinanceRoute, executeFinanceRoute } from '../src/finance.mjs';

// Synthetic data only. 171: Comissões (razão do vendedor, liberação pelas regras, pagamentos, outros lançamentos e
// comissão manual), with the documents and the sellers read only.
let env; let db; let users; let scalar; let rpc; let caixa; let cliente; let vendedora; let seller; let despesa;
const code = expected => error => error.code === expected;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const thisMonth = `${today.slice(0, 7)}-01`;
const execute = (action, data, user = users.financeiro, command = randomUUID()) => rpc('erp_finance_commission_execute', { p_user_id: user, p_command_id: command, p_action: action, p_data: data });
const page = (args = {}, user = users.consulta) => rpc('erp_finance_commission_page', { p_user_id: user, p_month: thisMonth, ...args });
const statement = (month = thisMonth, user = users.consulta, id = seller) => rpc('erp_finance_commission_statement', { p_user_id: user, p_seller: id, p_month: month });
const finance = (action, data) => rpc('erp_finance_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: action, p_data: data });
const worker = async (path, init = {}, user = users.financeiro) => executeFinanceRoute(await parseFinanceRoute(new Request(`https://api.example.test${path}`, init.body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {})), { userId: user, rpc: (name, args) => rpc(name, args) });
const commercial = sellerId => ({ introduction: null, attention_to: null, seller_reference: sellerId ? { system: 'origin', source_id: sellerId, label: 'Vendedora Origin' } : null, store_reference: null, business_unit_reference: null, transport: null });

async function salesOrder({ sellerSource = '9001', items, installments, discount }) {
  const body = { date: today, contact_id: cliente.id, items, installments, commercial: commercial(sellerSource), ...(discount ? { discount_mode: 'amount', discount_value: discount } : {}) };
  let document = (await rpc('erp_document_save', { p_user_id: users.admin, p_kind: 'sales_orders', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: body })).document;
  for (const status of document.status === 'draft' ? ['open', 'verified'] : ['verified']) document = (await rpc('erp_document_transition', { p_user_id: users.admin, p_kind: 'sales_orders', p_id: document.id, p_expected_version: document.version, p_command_id: randomUUID(), p_status: status, p_reason: 'Teste sintético' })).document;
  const scope = { p_user_id: users.admin, p_kind: 'sales_orders', p_document_id: document.id, p_expected_version: document.version };
  const preview = await rpc('erp_document_finance_preview', scope);
  const posted = await rpc('erp_document_finance_post', { ...scope, p_command_id: randomUUID(), p_preview_hash: preview.preview.preview_hash });
  return { document, posted, titles: posted.titles };
}
const savePreferences = async (pageId, changes) => {
  const current = await rpc('erp_preferences_page', { p_user_id: users.admin, p_page: pageId });
  return rpc('erp_preferences_save', { p_user_id: users.admin, p_command_id: randomUUID(), p_page: pageId, p_changes: JSON.stringify(Object.entries(changes).map(([key, value]) => ({ key, expected_version: current.items.find(item => item.key === key).version, value }))) });
};

before(async () => {
  env = await financeParityDb({});
  ({ db, users, scalar, rpc } = env);
  // Supabase Auth e-mail read by the contacts lane (absent from the shared bootstrap stub).
  await db.exec('ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text');
  await env.addUsers();
  cliente = await env.contact({ name: 'Cliente Sintético' });
  vendedora = await env.contact({ name: 'Vendedora Sintética' });
  seller = (await rpc('erp_catalog_seller_from_contact', { p_user_id: users.admin, p_command_id: randomUUID(), p_contact_id: vendedora.id })).seller.id;
  await db.query("UPDATE erp_catalog.seller SET commission_rule='parcial',commission_mode='fixa',commission_rate=5 WHERE id=$1", [seller]);
  // The Origin seller 9001 points to the Origin contact 5001, which is the Brufap contact of the seller.
  await db.query("INSERT INTO origin_sync.resource_state(resource) VALUES('commission_test') ON CONFLICT DO NOTHING");
  await db.query("INSERT INTO origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) VALUES('sellers','commission_test','9001',$1::jsonb,repeat('a',64)),('contacts','commission_test','5001','{}',repeat('b',64))", [JSON.stringify({ id: 9001, contato: { id: '5001', nome: 'Vendedora Sintética' } })]);
  await db.query("INSERT INTO erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links) SELECT entity,source_id,version_hash,version,payload,document_links FROM origin_sync.raw_record WHERE entity='contacts' AND source_id='5001'");
  await db.query("INSERT INTO erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state) VALUES('contacts','5001',$1,repeat('b',64),repeat('b',64),'synced')", [vendedora.id]);
  caixa = (await rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: { account_type: 'cash', name: 'Caixa sintético', start_on: '2020-01-01', opening_cents: '100000' } })).record;
  despesa = (await rpc('erp_finance_category_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'category_create', p_data: { kind: 'payable', name: 'Comissões sintéticas' } })).record;
});
after(async () => db?.close());

test('171 RPCs are service-only security definer functions; the ledger tables are closed; consulta reads and cannot write', async () => {
  const names = ['erp_finance_commission_page', 'erp_finance_commission_statement', 'erp_finance_commission_execute'];
  const fns = (await db.query("SELECT p.prosecdef,p.proconfig,p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname = ANY($1)", [names])).rows;
  assert.equal(fns.length, 3);
  for (const fn of fns) {
    assert.deepEqual([fn.prosecdef, fn.proconfig], [true, ['search_path=pg_catalog']]);
    for (const role of ['public', 'anon', 'authenticated']) assert.equal(await scalar("SELECT has_function_privilege($2,$1,'EXECUTE') AS value", [fn.signature, role === 'public' ? 'anon' : role]), false);
    assert.equal(await scalar("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS value", [fn.signature]), true);
  }
  for (const table of ['erp_finance.commission', 'erp_finance.commission_entry']) for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar("SELECT has_table_privilege($1,$2,'SELECT') AS value", [role, table]), false);
  await assert.rejects(() => execute('commission_entry', { seller_id: seller, month: thisMonth, posted_on: today, amount_cents: '100', kind: 'credit', description: 'x' }, users.consulta), code('42501'));
  for (const role of ['vendas', 'estoque', 'inactive']) await assert.rejects(() => page({}, users[role]), code('42501'));
  await assert.rejects(() => page({ p_month: `${today.slice(0, 7)}-02` }), code('22023'));
  await assert.rejects(() => statement(thisMonth, users.consulta, randomUUID()), code('P0002'));
});

test('171 a posted pedido gives each parcela its commission (base and value add up to the document) and parcial releases a parcela when it is received', async () => {
  // 60,00 + 40,00 with 10% item discount = 96,00; 5% fixed → 4,80 in three parcelas of 1,60.
  const { titles, document } = await salesOrder({ items: [{ description: 'Peça A', unit: 'UN', quantity: '1', unit_price: '60', discount_percent: '0' }, { description: 'Peça B', unit: 'UN', quantity: '1', unit_price: '40', discount_percent: '10' }],
    installments: [{ due_date: '2099-01-10', amount: '32.00' }, { due_date: '2099-02-10', amount: '32.00' }, { due_date: '2099-03-10', amount: '32.00' }] });
  const rows = (await db.query('SELECT position,parcel_cents::text parcel,base_cents::text base,rate::text rate,commission_cents::text commission,rule,description FROM erp_finance.commission WHERE document_id=$1 ORDER BY position', [document.id])).rows;
  assert.deepEqual(rows.map(row => [row.position, row.parcel, row.base, row.rate, row.commission, row.rule]), [[1, '3200', '3200', '5.000000', '160', 'parcial'], [2, '3200', '3200', '5.000000', '160', 'parcial'], [3, '3200', '3200', '5.000000', '160', 'parcial']]);
  assert.match(rows[0].description, new RegExp(`^Pedido de venda nº ${document.number} · parcela 1/3$`));
  let current = await statement();
  assert.deepEqual([current.commissions.total, current.pending.total, current.pending.commission_cents, current.summary.balance_cents], [0, 3, '480', '0'], 'nothing is released before a parcela is received');
  assert.equal(current.seller.rule, 'parcial'); assert.equal(current.pending.items[0].situation, 'upcoming');
  const account = (await rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: { account_type: 'checking', institution_code: '341', institution_name: 'Itaú Unibanco', name: 'Banco sintético', agency: '1', account_number: '2', account_digit: '3', start_on: '2020-01-01', opening_cents: '0' } })).record;
  const settled = await finance('settle', { id: titles[0].id, expected_version: 1, account_id: account.id, posted_on: today, principal_cents: '3200' });
  current = await statement();
  assert.deepEqual([current.commissions.total, current.commissions.commission_cents, current.commissions.parcel_cents, current.pending.commission_cents, current.summary.commission_cents, current.summary.balance_cents], [1, '160', '3200', '320', '160', '160']);
  assert.deepEqual([current.commissions.items[0].rate, current.commissions.items[0].day, current.commissions.items[0].document.number], ['5.00', today, String(document.number)]);
  const listed = await page();
  assert.deepEqual(listed.items.map(item => [item.name, item.billed_cents, item.commission_cents, item.pending_cents, item.balance_cents]), [['Vendedora Sintética', '3200', '160', '320', '160']]);
  assert.deepEqual([listed.totals.commission_cents, listed.total], ['160', 1]);
  // Estorno of the baixa takes the commission back to pending.
  await finance('reverse', { id: titles[0].id, expected_version: 2, settlement_id: settled.settlement.id, posted_on: today, note: 'Estorno sintético' });
  current = await statement();
  assert.deepEqual([current.commissions.total, current.pending.commission_cents], [0, '480']);
  // A pedido without the Origin seller, or with a seller not linked to a Brufap seller, has no commission.
  const none = await salesOrder({ sellerSource: '9999', items: [{ description: 'Peça C', unit: 'UN', quantity: '1', unit_price: '10', discount_percent: '0' }], installments: [{ due_date: '2099-01-10', amount: '10.00' }] });
  assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_finance.commission WHERE document_id=$1', [none.document.id]), 0);
  // Reversing the posting (017) voids the commissions of its contas.
  await db.query("UPDATE erp_finance.title SET cancelled=true WHERE id=$1", [titles[2].id]);
  assert.equal((await statement()).pending.commission_cents, '320');
  await db.query("UPDATE erp_finance.title SET cancelled=false WHERE id=$1", [titles[2].id]);
});

test('171 the other rules: faturamento releases on the lançamento, descontos uses the band of each item and the base follows "Adicionais da base de comissão"', async () => {
  await db.query("UPDATE erp_catalog.seller SET commission_rule='faturamento',commission_mode='descontos',commission_rate=null,commission_bands='[{\"discount_up_to\":\"5.0000\",\"rate\":\"10.0000\"},{\"discount_up_to\":\"20.0000\",\"rate\":\"4.0000\"}]' WHERE id=$1", [seller]);
  await savePreferences('vendas-vendas', { 'vendas.base_comissao': ['desconto', 'frete'] });
  // Items 100,00 (0%) → 10%; 50,00 with 10% → 45,00 at 4%; pedido discount 5,00 and freight 0 → base 140,00.
  const { document } = await salesOrder({ items: [{ description: 'Peça D', unit: 'UN', quantity: '1', unit_price: '100', discount_percent: '0' }, { description: 'Peça E', unit: 'UN', quantity: '1', unit_price: '50', discount_percent: '10' }],
    installments: [{ due_date: '2099-01-10', amount: '140.00' }], discount: '5.00' });
  const row = (await db.query('SELECT base_cents::text base,rate::text rate,commission_cents::text commission,rule FROM erp_finance.commission WHERE document_id=$1', [document.id])).rows[0];
  // Comissão média = (10000×10 + 4500×4)/14500 = 8,137931%; commission = 14000 × that = 1139,31 → 1139.
  assert.deepEqual(row, { base: '14000', rate: '8.137931', commission: '1139', rule: 'faturamento' });
  const current = await statement();
  assert.ok(current.commissions.items.some(item => item.commission_cents === '1139' && item.day === today), 'faturamento is released on the day the contas were lançadas');
  await savePreferences('vendas-vendas', { 'vendas.base_comissao': [] });
  await db.query("UPDATE erp_catalog.seller SET commission_rule='parcial',commission_mode='fixa',commission_rate=5,commission_bands='[]' WHERE id=$1", [seller]);
});

test('171 Pagamento by caixa posts the saída in the Conta origem (excluded only in Comissões); Outro lançamento and Comissão manual join the saldo', async () => {
  const before = await statement();
  const command = randomUUID(), data = { seller_id: seller, month: thisMonth, posted_on: today, category_id: despesa.id, account_id: caixa.id, amount_cents: '1000', description: 'Pagamento de comissões' };
  const paid = await execute('commission_payment', data, users.financeiro, command);
  assert.deepEqual([paid.record.kind, paid.record.source, paid.record.amount_cents, paid.record.account_name, paid.replayed], ['payment', 'cash', '1000', 'Caixa sintético', false]);
  assert.equal((await execute('commission_payment', data, users.financeiro, command)).replayed, true);
  await assert.rejects(() => execute('commission_payment', { ...data, amount_cents: '999' }, users.financeiro, command), code('40001'));
  const entry = (await db.query("SELECT id,kind,amount_cents::text amount,origin,contact_id,version FROM erp_finance.cash_entry WHERE source_key=$1", [`commission:${paid.record.id}`])).rows[0];
  assert.deepEqual([entry.kind, entry.amount, entry.origin, entry.contact_id], ['out', '1000', 'commission', vendedora.id]);
  assert.equal(await scalar("SELECT coalesce(sum(delta_cents),0)::text AS value FROM erp_finance.movement WHERE account_id=$1", [caixa.id]), '99000');
  // The extrato shows it but refuses to exclude or edit it.
  await assert.rejects(() => rpc('erp_finance_cash_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'entry_delete', p_data: { id: entry.id, expected_version: entry.version } }), code('40001'));
  await assert.rejects(() => rpc('erp_finance_cash_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'entry_save', p_data: { id: entry.id, expected_version: entry.version, account_id: caixa.id, kind: 'out', amount_cents: '1', posted_on: today, competence_on: today, note: 'x' } }), code('40001'));
  await execute('commission_entry', { seller_id: seller, month: thisMonth, posted_on: today, amount_cents: '500', kind: 'credit', description: 'Bônus sintético' });
  await execute('commission_entry', { seller_id: seller, month: thisMonth, posted_on: today, amount_cents: '200', kind: 'debit', description: 'Adiantamento sintético' });
  await assert.rejects(() => execute('commission_entry', { seller_id: seller, month: `${today.slice(0, 7)}-15`, posted_on: today, amount_cents: '1', kind: 'credit', description: 'x' }), code('22023'));
  await assert.rejects(() => execute('commission_manual', { seller_id: seller, due_on: today, credit_on: today, parcel_cents: '10', rate: '1' }), code('22023'), 'a commission below one cent is refused');
  const manual = await execute('commission_manual', { seller_id: seller, due_on: today, credit_on: today, parcel_cents: '10000' });
  assert.deepEqual([manual.record.commission_cents, manual.record.rate, manual.record.description], ['500', '5.00', 'Comissão manual']);
  const after = await statement();
  const delta = key => (BigInt(after.summary[key]) - BigInt(before.summary[key])).toString();
  assert.deepEqual([delta('payment_cents'), delta('credit_cents'), delta('debit_cents'), delta('commission_cents'), delta('balance_cents')], ['1000', '500', '200', '500', '-200']);
  assert.equal(BigInt(after.summary.balance_cents), BigInt(after.summary.previous_cents) + BigInt(after.summary.commission_cents) + BigInt(after.summary.credit_cents) - BigInt(after.summary.debit_cents) - BigInt(after.summary.payment_cents));
  // Next month: everything of this month is the Saldo anterior.
  const next = new Date(`${thisMonth}T12:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1);
  const following = await statement(next.toISOString().slice(0, 10));
  assert.equal(following.summary.previous_cents, after.summary.balance_cents);
  // Exclusão de pagamentos: the lançamento de caixa is undone on its date; the version is the CAS.
  await assert.rejects(() => execute('commission_delete', { target: 'entry', id: paid.record.id, expected_version: 9 }), code('40001'));
  const removed = await execute('commission_delete', { target: 'entry', id: paid.record.id, expected_version: 1 });
  assert.equal(removed.record.deleted, true);
  assert.equal(await scalar("SELECT coalesce(sum(delta_cents),0)::text AS value FROM erp_finance.movement WHERE account_id=$1", [caixa.id]), '100000');
  assert.equal(await scalar('SELECT (deleted_at IS NOT NULL) AS value FROM erp_finance.cash_entry WHERE id=$1', [entry.id]), true);
  assert.equal((await statement()).summary.payment_cents, before.summary.payment_cents);
  await execute('commission_delete', { target: 'commission', id: manual.record.id, expected_version: 1 });
  await assert.rejects(() => execute('commission_delete', { target: 'commission', id: manual.record.id, expected_version: 2 }), code('P0002'));
  const audited = await scalar("SELECT count(*)::int AS value FROM erp_finance.audit WHERE action LIKE 'commission_%'");
  assert.ok(audited >= 6);
});

test('171 "Gerenciar comissões através de contas à pagar" turns the Pagamento into a conta a pagar to the seller, excluded in Contas a pagar', async () => {
  await savePreferences('financas-pagar', { 'financas.comissoes_contas_pagar': true });
  try {
    const paid = await execute('commission_payment', { seller_id: seller, month: thisMonth, posted_on: today, category_id: despesa.id, account_id: null, amount_cents: '700', description: 'Pagamento de comissões' });
    assert.equal(paid.record.source, 'payable');
    const title = (await db.query('SELECT kind,contact_id,amount_cents::text amount,due_on::text due,category_id FROM erp_finance.title WHERE id=$1', [paid.record.title_id])).rows[0];
    assert.deepEqual(title, { kind: 'payable', contact_id: vendedora.id, amount: '700', due: today, category_id: despesa.id });
    assert.equal((await statement()).payable, true);
    await assert.rejects(() => execute('commission_delete', { target: 'entry', id: paid.record.id, expected_version: 1 }), code('40001'));
    const counted = (await statement()).payments.items.find(item => item.id === paid.record.id);
    assert.equal(counted.counts, true);
    await db.query('UPDATE erp_finance.title SET cancelled=true WHERE id=$1', [paid.record.title_id]);
    assert.equal((await statement()).payments.items.some(item => item.id === paid.record.id), false, 'a cancelled conta no longer counts as payment');
  } finally { await savePreferences('financas-pagar', { 'financas.comissoes_contas_pagar': false }); }
});

test('171 Worker routes validate strictly and project the list, the extrato and the commands', async () => {
  const month = thisMonth.slice(0, 7);
  const listed = await worker(`/v1/financeiro/comissoes?month=${month}&situation=A&idle=true`, {}, users.consulta);
  assert.equal(listed.entity, 'commissions'); assert.equal(listed.items[0].name, 'Vendedora Sintética');
  const read = await worker(`/v1/financeiro/comissoes/${seller}?month=${month}`, {}, users.consulta);
  assert.equal(read.entity, 'commission_statement'); assert.equal(read.seller.id, seller);
  for (const bad of ['/v1/financeiro/comissoes?month=2026-13', '/v1/financeiro/comissoes?month=2026-10&situation=X', '/v1/financeiro/comissoes?month=2026-10&extra=1', '/v1/financeiro/comissoes?month=2026-10&month=2026-11', `/v1/financeiro/comissoes/${seller}?month=2026-10&q=1`])
    await assert.rejects(() => parseFinanceRoute(new Request(`https://api.example.test${bad}`)), error => error.status === 400, bad);
  const posted = await worker('/v1/financeiro/actions/commission_entry', { body: { command_id: randomUUID(), data: { seller_id: seller, month: `${month}-01`, posted_on: today, amount_cents: '300', kind: 'credit', description: 'Crédito pela API' } } });
  assert.deepEqual([posted.action, posted.record.kind, posted.record.amount_cents], ['commission_entry', 'credit', '300']);
  for (const data of [{ seller_id: seller, month: `${month}-01`, posted_on: today, amount_cents: '1,00', kind: 'credit', description: 'x' }, { seller_id: seller, month: `${month}-01`, posted_on: today, amount_cents: '100', kind: 'credit', description: 'x', extra: 1 }, { seller_id: 'x', month: `${month}-01`, posted_on: today, amount_cents: '100', kind: 'credit', description: 'x' }])
    await assert.rejects(() => parseFinanceRoute(new Request('https://api.example.test/v1/financeiro/actions/commission_entry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command_id: randomUUID(), data }) })), error => error.status === 400);
  await worker('/v1/financeiro/actions/commission_delete', { body: { command_id: randomUUID(), data: { target: 'entry', id: posted.record.id, expected_version: 1 } } });
});
