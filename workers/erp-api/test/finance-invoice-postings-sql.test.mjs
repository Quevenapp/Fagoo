import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { financeParityDb } from './helpers/finance-parity-db.mjs';

// Synthetic data only. 247: contas lançadas pelas notas fiscais do Brufap (saída e entrada), one effect per sale, the locks of
// the note and of its contas, the automation of the entry note, the origin of the conta and the Faturamento agrupado with notes.
let env; let db; let users; let scalar; let rpc; let contact; let supplier; let product; let saleNature; let buyNature; let seller; let receita; let boleto; let itau;
const code = expected => error => error.code === expected;
const named = (expected, errcode) => error => error.message === expected && (!errcode || error.code === errcode);
const catalog = async (entity, data) => (await rpc('erp_catalog_save', { p_user_id: users.admin, p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data })).record;
// Notes Emitidas por terceiros (T) carry their number; own notes (N) get theirs only when sent in homologation.
let next = 4100;
const note = (over = {}) => ({ model: '55', direction: '1', issue_type: 'T', number: String(next++), series: '1', nature_id: saleNature.id, issue_date: '2026-10-10', crt: '1', purpose: '1', presence: '1', final_consumer: false,
  recipient: { contact_id: contact.id, name: 'Cliente nota sintético', person_type: 'J', document: '12345678000190', state: 'SP' },
  items: [{ product_id: product.id, description: 'Peça nota sintética', quantity: '2', unit_price: '50' }],
  payment: { installments: [{ date: '2026-11-10', amount: '40.00', method: '15', payment_method_id: boleto }, { date: '2026-12-10', amount: '60.00', method: '15' }] }, ...over });
const create = async (data, orders = [], user = users.admin) => (await rpc('erp_fiscal_invoice_execute', { p_user_id: user, p_command_id: randomUUID(), p_action: 'create', p_data: { invoice: data, orders } })).invoice;
const update = async (invoice, data, orders = [], user = users.admin) => (await rpc('erp_fiscal_invoice_execute', { p_user_id: user, p_command_id: randomUUID(), p_action: 'update', p_data: { id: invoice.id, expected_version: invoice.version, invoice: data, orders } })).invoice;
const finance = (invoice, user = users.financeiro) => rpc('erp_finance_invoice_finance_get', { p_user_id: user, p_invoice_id: invoice.id });
const preview = (invoice, extra = {}, user = users.financeiro) => rpc('erp_finance_invoice_finance_preview', { p_user_id: user, p_invoice_id: invoice.id, p_expected_version: invoice.version, p_category_id: null, p_account_id: null, ...extra });
async function post(invoice, { category = null, account = null, user = users.financeiro, command = randomUUID() } = {}) {
  const shown = (await preview(invoice, { p_category_id: category, p_account_id: account }, user)).preview;
  return rpc('erp_finance_invoice_finance_post', { p_user_id: user, p_command_id: command, p_data: { invoice_id: invoice.id, expected_version: invoice.version, preview_hash: shown.preview_hash, category_id: category, account_id: account } });
}
const reverse = (invoice, posted, user = users.financeiro, command = randomUUID()) => rpc('erp_finance_invoice_finance_reverse', { p_user_id: user, p_command_id: command,
  p_data: { invoice_id: invoice.id, posting_id: posted.posting.id, expected_version: posted.posting.version, titles: posted.titles.map(t => ({ id: t.id, version: t.version })), reason: 'Estorno sintético da nota' } });

before(async () => {
  env = await financeParityDb({});
  ({ db, users, scalar, rpc } = env);
  await db.exec('ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text');
  await env.addUsers();
  await db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,$1::jsonb,$2)", [JSON.stringify({ state: 'SP', cnpj: '11.222.333/0001-81' }), users.admin]);
  await db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1)", [users.admin]);
  product = await catalog('products', { name: 'Peça nota sintética', code: 'P-247', unit: 'UN', kind: 'P', format: 'S', price: '50', ncm: '84714900' });
  contact = await env.contact({ name: 'Cliente nota sintético', person_type: 'J', document: '12345678000190', state: 'SP' });
  supplier = await env.contact({ name: 'Fornecedor nota sintético', person_type: 'J', document: '22333444000155', state: 'SP' });
  const nature = async data => (await rpc('erp_fiscal_nature_execute', { p_user_id: users.admin, p_command_id: randomUUID(), p_action: 'create', p_data: { nature: data } })).nature;
  saleNature = await nature({ description: 'Venda 247', direction: '1', crt: '1' }); buyNature = await nature({ description: 'Compra 247', direction: '0', crt: '1', presence: '9' });
  const vendedora = await env.contact({ name: 'Vendedora nota sintética' });
  seller = (await rpc('erp_catalog_seller_from_contact', { p_user_id: users.admin, p_command_id: randomUUID(), p_contact_id: vendedora.id })).seller.id;
  receita = (await rpc('erp_finance_category_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'category_create', p_data: { kind: 'receivable', name: 'Vendas por nota' } })).record;
  itau = (await rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: { account_type: 'checking', institution_code: '341', institution_name: 'Itaú Unibanco', name: 'Itaú nota', agency: '1', account_number: '2', account_digit: '3', start_on: '2020-01-01', opening_cents: '0' } })).record;
  boleto = (await db.query(`INSERT INTO erp_catalog.payment_method(description,payment_type,destination,applicable,fee_type,account_id,created_by,updated_by) VALUES('Boleto nota','15','contas','ambos','aliquota',$1,$2,$2) RETURNING id`, [itau.id, users.admin])).rows[0].id;
});
after(async () => db?.close());

test('247 RPCs are service-only SECURITY DEFINER, helpers and tables stay closed', async () => {
  for (const signature of ['public.erp_finance_invoice_finance_get(uuid,uuid)', 'public.erp_finance_invoice_finance_preview(uuid,uuid,integer,uuid,uuid)', 'public.erp_finance_invoice_finance_post(uuid,uuid,jsonb)',
    'public.erp_finance_invoice_finance_reverse(uuid,uuid,jsonb)', 'public.erp_finance_invoice_finance_flags(uuid,uuid[])', 'public.erp_finance_grouped_billing_execute(uuid,uuid,text,jsonb)']) {
    for (const role of ['anon', 'authenticated']) assert.equal(await scalar("SELECT has_function_privilege($2,$1,'EXECUTE') AS value", [signature, role]), false, `${role} ${signature}`);
    assert.equal(await scalar("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS value", [signature]), true, signature);
    assert.deepEqual((await db.query('SELECT prosecdef,proconfig FROM pg_proc WHERE oid=to_regprocedure($1)', [signature])).rows[0], { prosecdef: true, proconfig: ['search_path=pg_catalog'] });
  }
  for (const helper of ['erp_finance.invoice_preview_data(erp_fiscal_invoices.invoice,uuid,uuid)', 'erp_finance.invoice_post(uuid,uuid,jsonb,text)', 'erp_finance.invoice_lock(uuid)', 'erp_finance.guard_finance_invoice()', 'erp_finance.invoice_auto_finance()'])
    assert.equal(await scalar("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS value", [helper]), false, helper);
  for (const table of ['erp_finance.invoice_posting', 'erp_finance.invoice_title', 'erp_finance.grouped_billing_invoice'])
    assert.equal(await scalar("SELECT has_table_privilege('service_role',$1,'SELECT') AS value", [table]), false, table);
});

test('247 Lançar contas of a NF-e de saída: prévia, parcelas, forma and conta, idempotent command, locks, flags and Estornar contas', async () => {
  let invoice = await create(note({ seller_id: seller }));
  const before = await finance(invoice);
  assert.deepEqual([before.blocked_reason, before.active_posting, before.writable], [null, null, true]);
  assert.equal((await finance(invoice, users.fiscal)).writable, false, 'fiscal reads, the financeiro posts');
  await assert.rejects(() => preview(invoice, {}, users.fiscal), code('42501'));
  await assert.rejects(() => finance(invoice, users.vendas), code('42501'));
  const shown = (await preview(invoice, { p_category_id: receita.id })).preview;
  assert.deepEqual([shown.direction, shown.total_cents, shown.category_id, shown.seller_id], ['receivable', '10000', receita.id, seller]);
  assert.deepEqual(shown.installments.map(p => [p.position, p.amount_cents, p.due_on, p.payment_method_id, p.account_id]), [[1, '4000', '2026-11-10', boleto, itau.id], [2, '6000', '2026-12-10', null, null]]);
  await assert.rejects(() => rpc('erp_finance_invoice_finance_post', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_data: { invoice_id: invoice.id, expected_version: invoice.version, preview_hash: 'a'.repeat(64), category_id: receita.id } }), named('erp_finance_invoice_preview_conflict', '40001'));
  const command = randomUUID(), posted = await post(invoice, { category: receita.id, command });
  assert.equal(posted.cash_movement_performed, false);
  assert.equal(posted.titles.length, 2);
  const again = await rpc('erp_finance_invoice_finance_post', { p_user_id: users.financeiro, p_command_id: command, p_data: { invoice_id: invoice.id, expected_version: invoice.version, preview_hash: shown.preview_hash, category_id: receita.id, account_id: null } });
  assert.deepEqual([again.replayed, again.posting.id], [true, posted.posting.id], 'the same command replays');
  const title = (await rpc('erp_finance_get', { p_user_id: users.consulta, p_entity: 'titles', p_id: posted.titles[0].id })).record;
  assert.deepEqual([title.kind, title.description, title.source_reference, title.document_linked, title.category_id, title.account_id, title.payment_method_id, title.seller_id, title.seller_source],
    ['receivable', `Nota fiscal nº ${invoice.number}`, String(invoice.number), true, receita.id, itau.id, boleto, seller, 'documento']);
  const detail = await rpc('erp_finance_title_detail', { p_user_id: users.consulta, p_id: title.id });
  assert.deepEqual(detail.origin, { invoice_id: invoice.id, kind: 'fiscal_invoices', model: '55', direction: '1', number: String(invoice.number) });
  const flags = await rpc('erp_finance_invoice_finance_flags', { p_user_id: users.fiscal, p_ids: [invoice.id] });
  assert.deepEqual(flags.items, [{ invoice_id: invoice.id, posted: true, grouped: false, category_ids: [receita.id] }]);
  assert.equal((await finance(invoice)).blocked_reason, 'erp_finance_invoice_already_posted');
  // The note keeps what the contas were made from; other fields still change.
  await assert.rejects(() => update(invoice, note({ seller_id: seller, payment: { installments: [{ date: '2026-11-10', amount: '100.00' }] } })), named('erp_fiscal_invoice_active_finance', '40001'));
  invoice = await update(invoice, note({ seller_id: seller, additional_info: 'Informação sintética alterada' }));
  await assert.rejects(() => rpc('erp_fiscal_invoice_execute', { p_user_id: users.admin, p_command_id: randomUUID(), p_action: 'delete', p_data: { id: invoice.id, expected_version: invoice.version, reason: 'Exclusão sintética' } }), named('erp_fiscal_invoice_active_finance', '40001'));
  // The contas keep cliente, valor and emissão and are not cancelled or excluded outside Estornar contas.
  await assert.rejects(() => rpc('erp_finance_title_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'title_delete', p_data: { id: title.id, expected_version: title.version } }), code('40001'));
  await assert.rejects(() => rpc('erp_finance_title_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'title_edit', p_data: { id: title.id, expected_version: title.version, amount_cents: '1' } }), code('40001'));
  const moved = await rpc('erp_finance_title_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'title_edit', p_data: { id: title.id, expected_version: title.version, due_on: '2026-11-20' } });
  assert.equal(moved.record.due_on, '2026-11-20', 'the vencimento still changes');
  await assert.rejects(() => reverse(invoice, posted), named('erp_finance_invoice_title_version_conflict', '40001'), 'the version of each conta is the CAS');
  const current = await finance(invoice);
  const back = await reverse(invoice, { posting: current.active_posting, titles: current.titles });
  assert.equal(back.posting.state, 'reversed');
  assert.ok(back.titles.every(t => t.cancelled));
  assert.equal((await finance(invoice)).blocked_reason, null, 'the note may lançar contas again');
  assert.equal(await scalar("SELECT count(*)::integer AS value FROM erp_finance.audit WHERE action IN ('invoice_post','invoice_reverse')"), 2);
});

test('247 one effect per sale: the pedido that lançou contas blocks its note, and the note that lançou blocks its pedido', async () => {
  const body = { date: '2026-10-10', contact_id: contact.id, items: [{ product_id: product.id, description: 'Peça nota sintética', unit: 'UN', quantity: '2', unit_price: '50', discount_percent: '0' }], installments: [{ due_date: '2026-11-10', amount: '100.00' }] };
  const order = async () => { let d = (await rpc('erp_document_save', { p_user_id: users.admin, p_kind: 'sales_orders', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: body })).document;
    for (const status of d.status === 'draft' ? ['open', 'verified'] : ['verified']) d = (await rpc('erp_document_transition', { p_user_id: users.admin, p_kind: 'sales_orders', p_id: d.id, p_expected_version: d.version, p_command_id: randomUUID(), p_status: status, p_reason: 'Teste sintético' })).document;
    return d; };
  const postOrder = async d => { const scope = { p_user_id: users.admin, p_kind: 'sales_orders', p_document_id: d.id, p_expected_version: d.version };
    return rpc('erp_document_finance_post', { ...scope, p_command_id: randomUUID(), p_preview_hash: (await rpc('erp_document_finance_preview', scope)).preview.preview_hash }); };
  const first = await order(); await postOrder(first);
  const fromOrder = await create(note(), [first.id]);
  const blocked = await finance(fromOrder);
  assert.equal(blocked.blocked_reason, 'erp_finance_invoice_order_posted');
  assert.equal(blocked.orders_posted[0].document_id, first.id);
  await assert.rejects(() => preview(fromOrder), named('erp_finance_invoice_order_posted', '40001'));
  const second = await order(), noted = await create(note(), [second.id]);
  await post(noted);
  const fresh = (await rpc('erp_documents_get', { p_user_id: users.admin, p_kind: 'sales_orders', p_id: second.id }).catch(() => null))?.document ?? second;
  await assert.rejects(() => rpc('erp_document_finance_preview', { p_user_id: users.admin, p_kind: 'sales_orders', p_document_id: second.id, p_expected_version: fresh.version }), named('erp_document_finance_invoice_posted', '40001'));
});

test('247 NF de entrada: contas a pagar pelas duplicatas, and the automation of Preferências when a new entry note is created', async () => {
  const entry = over => note({ direction: '0', nature_id: buyNature.id, presence: '9', recipient: { contact_id: supplier.id, name: 'Fornecedor nota sintético', person_type: 'J', document: '22333444000155', state: 'SP' },
    payment: { installments: [{ date: '2026-11-15', amount: '100.00', method: '15' }] }, ...over });
  const manual = await create(entry());
  const posted = await post(manual);
  assert.deepEqual([posted.posting.direction, posted.titles.length], ['payable', 1]);
  assert.equal((await rpc('erp_finance_get', { p_user_id: users.consulta, p_entity: 'titles', p_id: posted.titles[0].id })).record.kind, 'payable');
  // Without the preference nothing is posted by itself.
  const plain = await create(entry());
  assert.equal((await finance(plain)).active_posting, null);
  const page = await rpc('erp_preferences_page', { p_user_id: users.admin, p_page: 'notas-nfe' });
  const key = page.items.find(item => item.key === 'nfe.contas_pagar_entrada');
  await rpc('erp_preferences_save', { p_user_id: users.admin, p_command_id: randomUUID(), p_page: 'notas-nfe', p_changes: JSON.stringify([{ key: 'nfe.contas_pagar_entrada', expected_version: key.version, value: true }]) });
  const automatic = await create(entry(), [], users.admin);
  const read = await finance(automatic);
  assert.deepEqual([read.active_posting?.origin, read.titles.length], ['automatic', 1], 'the entry note created by the administrador lançou its contas a pagar');
  const byFiscal = await create(entry(), [], users.fiscal);
  assert.equal((await finance(byFiscal)).active_posting, null, 'a profile without contas saves the note without contas');
  const unbalanced = await create(entry({ payment: { installments: [{ date: '2026-11-15', amount: '10.00' }] } }), [], users.admin).catch(error => error);
  if (!(unbalanced instanceof Error)) assert.equal((await finance(unbalanced)).active_posting, null, 'a refusal (parcelas) keeps the note without contas');
  const sale = await create(note(), [], users.admin);
  assert.equal((await finance(sale)).active_posting, null, 'the automation is only for entry notes');
});

test('247 cancelled or denied notes do not lançar contas; the extrato shows N and the Ficha financeira the note', async () => {
  const invoice = await create(note({ payment: { installments: [{ date: '2026-10-20', amount: '100.00' }] } }));
  await db.query('ALTER TABLE erp_fiscal_invoices.invoice DISABLE TRIGGER guard_invoice');
  await db.query('UPDATE erp_fiscal_invoices.invoice SET status=3 WHERE id=$1', [invoice.id]);
  await db.query('ALTER TABLE erp_fiscal_invoices.invoice ENABLE TRIGGER guard_invoice');
  assert.equal((await finance(invoice)).blocked_reason, 'erp_finance_invoice_ineligible_state');
  await db.query('ALTER TABLE erp_fiscal_invoices.invoice DISABLE TRIGGER guard_invoice');
  await db.query('UPDATE erp_fiscal_invoices.invoice SET status=8 WHERE id=$1', [invoice.id]);
  await db.query('ALTER TABLE erp_fiscal_invoices.invoice ENABLE TRIGGER guard_invoice');
  const posted = await post(invoice);
  const caixa = (await rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: { account_type: 'cash', name: 'Caixa nota', start_on: '2020-01-01', opening_cents: '0' } })).record;
  const paid = await rpc('erp_finance_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'settle', p_data: { id: posted.titles[0].id, expected_version: posted.titles[0].version, account_id: caixa.id, posted_on: '2026-10-20', principal_cents: '10000' } });
  await assert.rejects(() => reverse(invoice, posted), code('40001'), 'a conta with baixa blocks Estornar contas');
  // A baixa already estornada leaves the conta em aberto: Estornar contas goes on, as for the pedido (017) and as the screen offers.
  await rpc('erp_finance_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'reverse', p_data: { id: posted.titles[0].id, expected_version: paid.record.version, settlement_id: paid.settlement.id, posted_on: '2026-10-20', note: 'Estorno sintético da baixa' } });
  const open = await finance(invoice);
  assert.equal((await reverse(invoice, { posting: open.active_posting, titles: open.titles })).posting.state, 'reversed');
  const statement = await rpc('erp_finance_statement_page', { p_user_id: users.consulta, p_account: caixa.id, p_from: '2026-10-01', p_to: '2026-10-31' });
  assert.deepEqual(statement.items[0].document, { kind: 'fiscal_invoices', number: String(invoice.number) });
  const ledger = await rpc('erp_finance_contact_ledger_page', { p_user_id: users.consulta, p_contact: contact.id, p_from: '2026-10-01', p_to: '2026-10-31' });
  const line = ledger.items.find(item => item.ref_id === posted.titles[0].id);
  assert.deepEqual(line.origin, { kind: 'fiscal_invoices', number: String(invoice.number) });
});

test('247 Faturamento agrupado with NF-e de saída: candidates, the selection, one sale never twice, GERAR CONTAS and Excluir', async () => {
  // An own note not sent yet has no number ("(sem número)"); a note of terceiros has its number.
  const a = await create(note({ issue_type: 'N', number: undefined, issue_date: '2026-09-15', payment: { installments: [] } })), b = await create(note({ issue_date: '2026-09-15', payment: { installments: [] } }));
  assert.deepEqual([a.number, typeof b.number], [null, 'number']);
  const candidates = await rpc('erp_finance_grouped_billing_candidates', { p_user_id: users.financeiro, p_from: '2026-09-01', p_to: '2026-09-30' });
  const client = candidates.items.find(item => item.contact_id === contact.id);
  assert.deepEqual([client.documents, client.invoices, client.total_cents], [0, 2, '20000']);
  const listed = await rpc('erp_finance_grouped_billing_documents', { p_user_id: users.financeiro, p_contact: contact.id, p_from: '2026-09-01', p_to: '2026-09-30' });
  assert.deepEqual(listed.items.map(item => [item.kind, item.total_cents]), [['fiscal_invoices', '10000'], ['fiscal_invoices', '10000']]);
  const generated = await rpc('erp_finance_grouped_billing_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'grouped_billing_generate',
    p_data: { items: [{ contact_id: contact.id, document_ids: [], invoice_ids: [a.id, b.id], total_cents: '20000', condition: '30 60', days: [30, 60] }] } });
  const billing = generated.items[0];
  assert.deepEqual([billing.invoices.length, billing.documents.length, billing.titles.length], [2, 0, 2]);
  assert.equal((await rpc('erp_finance_get', { p_user_id: users.consulta, p_entity: 'titles', p_id: billing.titles[0].id })).record.description, `Faturamento agrupado: notas nº ${b.number}, (sem número)`);
  assert.deepEqual(billing.invoices.map(item => item.number), [String(b.number), null]);
  const flags = await rpc('erp_finance_invoice_finance_flags', { p_user_id: users.consulta, p_ids: [a.id] });
  assert.equal(flags.items[0].grouped, true);
  assert.equal((await finance({ id: a.id })).blocked_reason, 'erp_finance_invoice_grouped');
  await assert.rejects(() => db.query('UPDATE erp_fiscal_invoices.invoice SET totals=totals,payment=$2::jsonb,version=version+1 WHERE id=$1', [a.id, JSON.stringify({ condition: null, installments: [{ date: '2026-12-01', amount: '100.00' }] })]), /erp_fiscal_invoice_active_finance/);
  await rpc('erp_finance_grouped_billing_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'grouped_billing_delete', p_data: { id: billing.id, expected_version: billing.version } });
  assert.equal((await finance({ id: a.id })).blocked_reason, null, 'Excluir frees the notes');
  // A note and its pedido are one sale.
  const body = { date: '2026-09-20', contact_id: contact.id, items: [{ product_id: product.id, description: 'Peça nota sintética', unit: 'UN', quantity: '1', unit_price: '30', discount_percent: '0' }] };
  let order = (await rpc('erp_document_save', { p_user_id: users.admin, p_kind: 'sales_orders', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: body })).document;
  for (const status of order.status === 'draft' ? ['open', 'verified'] : ['verified']) order = (await rpc('erp_document_transition', { p_user_id: users.admin, p_kind: 'sales_orders', p_id: order.id, p_expected_version: order.version, p_command_id: randomUUID(), p_status: status, p_reason: 'Teste sintético' })).document;
  const linked = await create(note({ issue_date: '2026-09-21', items: [{ product_id: product.id, description: 'Peça nota sintética', quantity: '1', unit_price: '30' }], payment: { installments: [] } }), [order.id]);
  const counted = (await rpc('erp_finance_grouped_billing_candidates', { p_user_id: users.financeiro, p_from: '2026-09-01', p_to: '2026-09-30' })).items.find(item => item.contact_id === contact.id);
  assert.deepEqual([counted.documents, counted.invoices, counted.total_cents], [1, 3, '23000'], 'the pedido of a listed note is that one sale: the Valor Total counts it once (as the selection chooses)');
  const both = (await rpc('erp_finance_grouped_billing_documents', { p_user_id: users.financeiro, p_contact: contact.id, p_from: '2026-09-01', p_to: '2026-09-30' })).items;
  const noteItem = both.find(item => item.id === linked.id);
  assert.deepEqual(noteItem.orders, [order.id], 'the note says its pedido');
  await assert.rejects(() => rpc('erp_finance_grouped_billing_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'grouped_billing_generate',
    p_data: { items: [{ contact_id: contact.id, document_ids: [order.id], invoice_ids: [linked.id], total_cents: '6000', condition: '30', days: [30] }] } }), named('erp_finance_grouped_billing_duplicate', '22023'));
  const onlyNote = await rpc('erp_finance_grouped_billing_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'grouped_billing_generate',
    p_data: { items: [{ contact_id: contact.id, invoice_ids: [linked.id], total_cents: '3000', condition: '30', days: [30] }] } });
  assert.equal(onlyNote.items[0].invoices.length, 1);
  assert.ok(!(await rpc('erp_finance_grouped_billing_documents', { p_user_id: users.financeiro, p_contact: contact.id, p_from: '2026-09-01', p_to: '2026-09-30' })).items.some(item => item.id === order.id),
    'the pedido of a faturada note is no longer eligible');
});

test('247 Worker routes: strict parameters and bodies, the answers checked, and the grouped billing with notes', async () => {
  const { parseFinanceRoute, executeFinanceRoute } = await import('../src/finance.mjs');
  const call = async (path, init = {}, user = users.financeiro) => executeFinanceRoute(await parseFinanceRoute(new Request(`https://api.example.test${path}`, init.body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {})), { userId: user, rpc: (name, args) => rpc(name, args) });
  const bad = async (path, init) => assert.rejects(async () => parseFinanceRoute(new Request(`https://api.example.test${path}`, init ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init) } : {})), error => error.status === 400 || error.status === 404, path);
  const invoice = await create(note({ payment: { installments: [{ date: '2026-11-30', amount: '100.00' }] } }));
  const read = await call(`/v1/financeiro/notas/${invoice.id}/contas`);
  assert.deepEqual([read.invoice.kind, read.blocked_reason, read.active_posting, read.writable], ['receivable', null, null, true]);
  const shown = await call(`/v1/financeiro/notas/${invoice.id}/contas/previa?versao=${invoice.version}&categoria=${receita.id}&conta=${itau.id}`);
  assert.deepEqual([shown.preview.category_id, shown.preview.account_id, shown.preview.installments.length], [receita.id, itau.id, 1]);
  for (const path of [`/v1/financeiro/notas/${invoice.id}/contas?x=1`, `/v1/financeiro/notas/${invoice.id}/contas/previa`, `/v1/financeiro/notas/${invoice.id}/contas/previa?versao=0`,
    `/v1/financeiro/notas/${invoice.id}/contas/previa?versao=1&categoria=x`, '/v1/financeiro/notas-contas?ids=x', `/v1/financeiro/notas-contas?ids=${invoice.id},${invoice.id}`, '/v1/financeiro/notas/x/contas']) await bad(path);
  for (const body of [{ command_id: randomUUID(), data: { invoice_id: invoice.id, expected_version: invoice.version } }, { command_id: randomUUID(), data: { invoice_id: invoice.id, expected_version: invoice.version, preview_hash: 'x' } },
    { command_id: 'x', data: {} }, { command_id: randomUUID(), data: { invoice_id: invoice.id, expected_version: invoice.version, preview_hash: shown.preview.preview_hash, extra: 1 } }]) await bad('/v1/financeiro/actions/invoice_finance_post', body);
  await bad('/v1/financeiro/actions/invoice_finance_reverse', { command_id: randomUUID(), data: { invoice_id: invoice.id, posting_id: invoice.id, expected_version: 1, titles: [], reason: 'Motivo' } });
  const command = randomUUID(), data = { invoice_id: invoice.id, expected_version: invoice.version, preview_hash: shown.preview.preview_hash, category_id: receita.id, account_id: itau.id };
  const posted = await call('/v1/financeiro/actions/invoice_finance_post', { body: { command_id: command, data } });
  assert.deepEqual([posted.action, posted.replayed, posted.posting.state, posted.titles.length, posted.cash_movement_performed], ['invoice_finance_post', false, 'active', 1, false]);
  assert.equal((await call('/v1/financeiro/actions/invoice_finance_post', { body: { command_id: command, data } })).replayed, true);
  const flags = await call(`/v1/financeiro/notas-contas?ids=${invoice.id}`, {}, users.fiscal);
  assert.deepEqual(flags.items, [{ invoice_id: invoice.id, posted: true, grouped: false, category_ids: [receita.id] }]);
  const page = await call(`/v1/financeiro/titles?page=1&kind=receivable&option=issued&from=2026-01-01&to=2026-12-31&q=${encodeURIComponent(`Nota fiscal nº ${invoice.number}`)}`, {}, users.consulta);
  assert.deepEqual(page.items.find(item => item.id === posted.titles[0].id).origin, { invoice_id: invoice.id, kind: 'fiscal_invoices', model: '55', direction: '1', number: String(invoice.number) });
  const current = await call(`/v1/financeiro/notas/${invoice.id}/contas`);
  const back = await call('/v1/financeiro/actions/invoice_finance_reverse', { body: { command_id: randomUUID(), data: { invoice_id: invoice.id, posting_id: current.active_posting.id, expected_version: current.active_posting.version,
    titles: current.titles.map(item => ({ id: item.id, version: item.version })), reason: 'Estorno sintético pela API' } } });
  assert.deepEqual([back.action, back.posting.state, back.titles.every(item => item.cancelled)], ['invoice_finance_reverse', 'reversed', true]);
  // Faturamento agrupado: candidates, documents and GERAR CONTAS through the Worker with a note.
  const grouped = await create(note({ issue_date: '2026-08-10', payment: { installments: [] } }));
  const candidates = await call('/v1/financeiro/faturamento-agrupado?from=2026-08-01&to=2026-08-31');
  assert.deepEqual(candidates.items.map(item => [item.contact_id, item.documents, item.invoices]), [[contact.id, 0, 1]]);
  const documents = await call(`/v1/financeiro/faturamento-agrupado/documentos?contact=${contact.id}&from=2026-08-01&to=2026-08-31`);
  assert.deepEqual(documents.items.map(item => [item.id, item.kind, item.number, item.orders]), [[grouped.id, 'fiscal_invoices', String(grouped.number), []]]);
  const generated = await call('/v1/financeiro/actions/grouped_billing_generate', { body: { command_id: randomUUID(), data: { items: [{ contact_id: contact.id, document_ids: [], invoice_ids: [grouped.id], total_cents: '10000', condition: '30', days: [30] }] } } });
  assert.deepEqual([generated.items[0].documents.length, generated.items[0].invoices.map(item => item.id)], [0, [grouped.id]]);
  const list = await call('/v1/financeiro/faturamento-agrupado/gerados');
  assert.ok(list.items.some(item => item.invoices.some(entry => entry.id === grouped.id)));
});

test('248 Comissões of the contas lançadas by a note: the Vendedor of the note, the base of Preferências and the estorno that anula it', async () => {
  const month = `${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()).slice(0, 7)}-01`;
  await db.query("UPDATE erp_catalog.seller SET commission_rule='faturamento',commission_mode='fixa',commission_rate=10,commission_bands='[]' WHERE id=$1", [seller]);
  const invoice = await create(note({ seller_id: seller, freight: '20.00', payment: { installments: [{ date: '2026-11-10', amount: '48.00' }, { date: '2026-12-10', amount: '72.00' }] } }));
  assert.equal(invoice.totals?.total ?? (await db.query("SELECT totals->>'total' t FROM erp_fiscal_invoices.invoice WHERE id=$1", [invoice.id])).rows[0].t, '120.00');
  const posted = await post(invoice);
  const rows = (await db.query("SELECT origin,invoice_id,position,parcel_cents::text,base_cents::text,commission_cents::text,rule FROM erp_finance.commission WHERE invoice_posting_id=$1 ORDER BY position", [posted.posting.id])).rows;
  assert.deepEqual(rows.map(r => [r.origin, r.position, r.parcel_cents, r.base_cents, r.commission_cents, r.rule]), [['invoice', 1, '4800', '4000', '400', 'faturamento'], ['invoice', 2, '7200', '6000', '600', 'faturamento']],
    'the base is the products (100,00) without the frete, split by the parcelas');
  const statement = await rpc('erp_finance_commission_statement', { p_user_id: users.consulta, p_seller: seller, p_month: month });
  const lines = statement.commissions.items.filter(item => item.document?.id === invoice.id);
  assert.deepEqual(lines.map(item => [item.origin, item.document.kind, item.document.number, item.commission_cents]), [['invoice', 'fiscal_invoices', String(invoice.number), '400'], ['invoice', 'fiscal_invoices', String(invoice.number), '600']]);
  const { parseFinanceRoute, executeFinanceRoute } = await import('../src/finance.mjs');
  const routed = await executeFinanceRoute(await parseFinanceRoute(new Request(`https://api.example.test/v1/financeiro/comissoes/${seller}?month=${month.slice(0, 7)}`)), { userId: users.consulta, rpc: (name, args) => rpc(name, args) });
  assert.ok(routed.commissions.items.some(item => item.origin === 'invoice' && item.document.kind === 'fiscal_invoices'), 'the Worker reads the commissions of the notes');
  // "Considerar total da nota como base de comissão": the base is the total of the note (120,00).
  const page = await rpc('erp_preferences_page', { p_user_id: users.admin, p_page: 'notas-nfe' });
  const key = page.items.find(item => item.key === 'nfe.base_comissao_total');
  await rpc('erp_preferences_save', { p_user_id: users.admin, p_command_id: randomUUID(), p_page: 'notas-nfe', p_changes: JSON.stringify([{ key: 'nfe.base_comissao_total', expected_version: key.version, value: true }]) });
  const total = await create(note({ seller_id: seller, freight: '20.00', payment: { installments: [{ date: '2026-11-10', amount: '120.00' }] } }));
  const second = await post(total);
  assert.deepEqual((await db.query("SELECT base_cents::text b,commission_cents::text c FROM erp_finance.commission WHERE invoice_posting_id=$1", [second.posting.id])).rows, [{ b: '12000', c: '1200' }]);
  // Estornar contas anula the commissions of the note.
  const current = await finance(total);
  await reverse(total, { posting: current.active_posting, titles: current.titles });
  const after = await rpc('erp_finance_commission_statement', { p_user_id: users.consulta, p_seller: seller, p_month: month });
  assert.ok(!after.commissions.items.some(item => item.document?.id === total.id), 'the anulada commission leaves the extrato');
  await assert.rejects(() => db.query("INSERT INTO erp_finance.commission(seller_id,origin,invoice_posting_id,title_id,position,positions,rule,parcel_cents,base_cents,rate,commission_cents,due_on,description,actor,command_id) VALUES($1,'invoice',$2,$3,1,1,'faturamento',1,1,1,1,'2026-11-10','x',$4,$5)",
    [seller, second.posting.id, second.titles[0].id, users.admin, randomUUID()]), /commission_origin_shape|duplicate key/, 'an invoice commission needs its note');
});

test('248 pedido de compra Em aberto lança contas and still moves on to Em andamento', async () => {
  const body = { date: '2026-10-10', contact_id: supplier.id, items: [{ product_id: product.id, description: 'Compra sintética', unit: 'UN', quantity: '2', unit_price: '25' }], installments: [{ due_date: '2026-11-10', amount: '50.00' }] };
  let order = (await rpc('erp_document_save', { p_user_id: users.admin, p_kind: 'purchase_orders', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: body })).document;
  assert.equal(order.status, 'open');
  const scope = { p_user_id: users.admin, p_kind: 'purchase_orders', p_document_id: order.id, p_expected_version: order.version };
  const shown = await rpc('erp_document_finance_preview', scope);
  assert.equal(shown.preview.direction, 'payable');
  const posted = await rpc('erp_document_finance_post', { ...scope, p_command_id: randomUUID(), p_preview_hash: shown.preview.preview_hash });
  assert.equal(posted.titles.length, 1);
  order = (await rpc('erp_document_transition', { p_user_id: users.admin, p_kind: 'purchase_orders', p_id: order.id, p_expected_version: posted.document_version, p_command_id: randomUUID(), p_status: 'in_progress', p_reason: 'Teste sintético' })).document;
  assert.equal(order.status, 'in_progress');
  await assert.rejects(() => rpc('erp_document_save', { p_user_id: users.admin, p_kind: 'purchase_orders', p_id: order.id, p_expected_version: order.version, p_command_id: randomUUID(), p_body: { ...body, installments: [{ due_date: '2026-11-20', amount: '50.00' }] } }), code('40001'), 'the pedido with contas keeps its parcelas');
});
