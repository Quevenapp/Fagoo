import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { financeParityDb } from './helpers/finance-parity-db.mjs';
import { parseFinanceRoute, executeFinanceRoute } from '../src/finance.mjs';

// Synthetic data only. 210: Vendedor das contas a receber, filtros Tipo de pagamento / Forma de pagamento / Vendedor, Histórico de
// 2.000 caracteres, Categorização para DRE gravada nas baixas, prazo de recebimento das formas e comissão do vendedor nativo.
let env; let db; let users; let scalar; let rpc; let alfa; let caixa; let cartao; let boleto; let seller; let other; let receita; let juros; let multa; let taxas; let descontos;
const SQL = { 400: ['22023'], 403: ['42501'], 404: ['P0002'], 409: ['40001', '23505', '55000'] };
const http = status => error => error.status === status || (SQL[status] ?? []).includes(error.code);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const call = async (path, init = {}, user = users.financeiro) => executeFinanceRoute(await parseFinanceRoute(new Request(`https://api.example.test${path}`, init.body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {})), { userId: user, rpc: (name, args) => rpc(name, args) });
const act = (action, data, user = users.financeiro, command = randomUUID()) => call(`/v1/financeiro/actions/${action}`, { body: { command_id: command, data } }, user);
const method = async (description, values) => (await db.query(`INSERT INTO erp_catalog.payment_method(description,payment_type,destination,applicable,fee_type,settlement_days,business_days,created_by,updated_by)
  VALUES($1,$2,'contas',$3,'aliquota',$4,$5,$6,$6) RETURNING id`, [description, values.type, values.applicable ?? 'ambos', values.days ?? null, values.business ?? false, users.admin])).rows[0].id;
const receivable = (extra = {}) => ({ kind: 'receivable', contact_id: alfa.id, description: 'Venda sintética', issued_on: '2026-03-01', competence_on: '2026-03-01', total_cents: '10000', installments: [{ amount_cents: '10000', due_on: '2026-03-31' }], ...extra });
const category = async (kind, name) => (await rpc('erp_finance_category_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'category_create', p_data: { kind, name } })).record;
const listed = query => call(`/v1/financeiro/titles?page=1&kind=receivable&option=issued&${/(^|&)from=/.test(query) ? '' : 'from=2026-01-01&to=2026-12-31&'}${query}`, {}, users.consulta);

before(async () => {
  env = await financeParityDb({});
  ({ db, users, scalar, rpc } = env);
  await db.exec('ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text');
  await env.addUsers();
  alfa = await env.contact({ name: 'Alfa Sintética' });
  const vendedora = await env.contact({ name: 'Vendedora Sintética' }), vendedor = await env.contact({ name: 'Vendedor Sintético' });
  seller = (await rpc('erp_catalog_seller_from_contact', { p_user_id: users.admin, p_command_id: randomUUID(), p_contact_id: vendedora.id })).seller.id;
  other = (await rpc('erp_catalog_seller_from_contact', { p_user_id: users.admin, p_command_id: randomUUID(), p_contact_id: vendedor.id })).seller.id;
  caixa = (await rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: { account_type: 'cash', name: 'Caixa', start_on: '2020-01-01', opening_cents: '0' } })).record;
  cartao = await method('Cartão sintético', { type: '03', days: 30, business: true });
  boleto = await method('Boleto sintético', { type: '15', applicable: 'recebimentos' });
  receita = await category('receivable', 'Vendas sintéticas');
  juros = await category('receivable', 'Juros recebidos'); multa = await category('receivable', 'Acréscimos recebidos'); taxas = await category('payable', 'Taxas sintéticas');
  descontos = await category('receivable', 'Descontos obtidos');
});
after(async () => db?.close());

test('210 the new RPC signatures stay service-only and the helpers and the categorization table are closed', async () => {
  for (const signature of ['public.erp_finance_title_page_v2(uuid,text,integer,integer,text,text,text,text[],text,date,date,text,text[],text,bigint,text,text,uuid,uuid)',
    'public.erp_finance_title_execute(uuid,uuid,text,jsonb)', 'public.erp_finance_title_detail(uuid,uuid)', 'public.erp_finance_payment_methods(uuid,text)']) {
    for (const role of ['anon', 'authenticated']) assert.equal(await scalar("SELECT has_function_privilege($2,$1,'EXECUTE') AS value", [signature, role]), false, `${role} ${signature}`);
    assert.equal(await scalar("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS value", [signature]), true, signature);
    assert.deepEqual((await db.query("SELECT prosecdef,proconfig FROM pg_proc WHERE oid=to_regprocedure($1)", [signature])).rows[0], { prosecdef: true, proconfig: ['search_path=pg_catalog'] });
  }
  assert.equal(await scalar("SELECT to_regprocedure('public.erp_finance_title_page_v2(uuid,text,integer,integer,text,text,text,text[],text,date,date,text,text[],text,bigint,text)') IS NULL AS value"), true, 'the old signature is dropped');
  for (const helper of ['erp_finance.document_seller(erp_documents.document)', 'erp_finance.title_seller(uuid)', 'erp_finance.seller_for(uuid,text,uuid)', 'erp_finance.title_text(jsonb)', 'erp_finance.settlement_capture_categories()'])
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar("SELECT has_function_privilege($2,$1,'EXECUTE') AS value", [helper, role]), false, `${role} ${helper}`);
  for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar("SELECT has_table_privilege($1,'erp_finance.settlement_category','SELECT') AS value", [role]), false);
});

test('210 Vendedor of a conta a receber: chosen in the gaveta, refused on contas a pagar, kept when inactivated, and the list filters by it', async () => {
  await assert.rejects(() => act('title_create', receivable({ seller_id: randomUUID() })), http(400), 'unknown seller');
  await assert.rejects(() => act('title_create', receivable({ kind: 'payable', seller_id: seller })), http(400), 'contas a pagar have no Vendedor');
  await assert.rejects(() => call(`/v1/financeiro/titles?page=1&kind=payable&seller=${seller}`), http(400), 'the Vendedor filter is only for contas a receber');
  const created = (await act('title_create', receivable({ seller_id: seller, description: 'Venda com vendedora' }))).items[0];
  assert.deepEqual([created.seller_id, created.seller_name, created.seller_source], [seller, 'Vendedora Sintética', 'conta']);
  const plain = (await act('title_create', receivable({ description: 'Venda sem vendedor' }))).items[0];
  assert.deepEqual([plain.seller_id, plain.seller_name, plain.seller_source], [null, null, null]);
  await db.query('UPDATE erp_catalog.record SET active=false WHERE id=(SELECT contact_id FROM erp_catalog.seller WHERE id=$1)', [seller]);
  const kept = await act('title_edit', { id: created.id, expected_version: created.version, due_on: '2026-04-30' });
  assert.equal(kept.record.seller_id, seller, 'an inactivated seller stays on the conta that has it');
  await assert.rejects(() => act('title_edit', { id: plain.id, expected_version: plain.version, seller_id: seller }), http(400), 'but it is not chosen again');
  await db.query('UPDATE erp_catalog.record SET active=true WHERE id=(SELECT contact_id FROM erp_catalog.seller WHERE id=$1)', [seller]);
  const moved = await act('title_edit', { id: plain.id, expected_version: plain.version, seller_id: other });
  assert.equal(moved.record.seller_name, 'Vendedor Sintético');
  assert.deepEqual((await listed(`seller=${seller}`)).items.map(item => item.id), [created.id]);
  assert.deepEqual((await listed(`seller=${other}`)).items.map(item => item.id), [plain.id]);
  const cleared = await act('title_edit', { id: plain.id, expected_version: moved.record.version, seller_id: null });
  assert.equal(cleared.record.seller_id, null);
});

test('210 a conta lançada by a pedido takes the native seller of the pedido, which also earns its commission', async () => {
  await db.query("UPDATE erp_catalog.seller SET commission_rule='faturamento',commission_mode='fixa',commission_rate=10 WHERE id=$1", [other]);
  const body = { date: today, contact_id: alfa.id, seller_id: other, items: [{ description: 'Peça sintética', unit: 'UN', quantity: '1', unit_price: '50', discount_percent: '0' }], installments: [{ due_date: '2099-01-10', amount: '50.00' }] };
  let document = (await rpc('erp_document_save', { p_user_id: users.admin, p_kind: 'sales_orders', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: body })).document;
  for (const status of document.status === 'draft' ? ['open', 'verified'] : ['verified']) document = (await rpc('erp_document_transition', { p_user_id: users.admin, p_kind: 'sales_orders', p_id: document.id, p_expected_version: document.version, p_command_id: randomUUID(), p_status: status, p_reason: 'Teste sintético' })).document;
  const scope = { p_user_id: users.admin, p_kind: 'sales_orders', p_document_id: document.id, p_expected_version: document.version };
  const preview = await rpc('erp_document_finance_preview', scope);
  const posted = await rpc('erp_document_finance_post', { ...scope, p_command_id: randomUUID(), p_preview_hash: preview.preview.preview_hash });
  const title = (await call(`/v1/financeiro/titles/${posted.titles[0].id}`, {}, users.consulta)).record;
  assert.deepEqual([title.seller_id, title.seller_source], [other, 'documento']);
  assert.equal(await scalar("SELECT commission_cents::text AS value FROM erp_finance.commission WHERE title_id=$1", [title.id]), '500');
  const page = await call(`/v1/financeiro/titles?page=1&kind=receivable&option=open&from=2099-01-01&to=2099-01-31&seller=${other}`, {}, users.consulta);
  assert.deepEqual(page.items.map(item => item.id), [title.id], 'the document seller filters the list while the conta has none');
  // The conta may take its own seller; the document keeps its own.
  const own = await act('title_edit', { id: title.id, expected_version: title.version, seller_id: seller });
  assert.deepEqual([own.record.seller_id, own.record.seller_source], [seller, 'conta']);
});

test('210 Tipo de pagamento and Forma de pagamento filter the contas by the forma, with the tPag of the forma on each row', async () => {
  const card = (await act('title_create', receivable({ payment_method_id: cartao, description: 'Venda no cartão', issued_on: '2026-05-01', competence_on: '2026-05-01', installments: [{ amount_cents: '10000', due_on: '2026-05-31' }] }))).items[0];
  const slip = (await act('title_create', receivable({ payment_method_id: boleto, description: 'Venda no boleto', issued_on: '2026-05-01', competence_on: '2026-05-01', installments: [{ amount_cents: '10000', due_on: '2026-05-30' }] }))).items[0];
  assert.deepEqual([card.payment_type, slip.payment_type], ['03', '15']);
  const window = 'from=2026-05-01&to=2026-05-31';
  assert.deepEqual((await listed(`${window}&payment_type=03`)).items.map(item => item.id), [card.id]);
  assert.deepEqual((await listed(`${window}&payment_method=${boleto}`)).items.map(item => item.id), [slip.id]);
  assert.deepEqual((await listed(`${window}&payment_type=03&payment_method=${boleto}`)).items, []);
  for (const bad of ['payment_type=3', 'payment_type=abc', 'payment_method=x', 'payment_type=03&payment_type=15']) await assert.rejects(() => listed(`${window}&${bad}`), http(400), bad);
  // Prazo de recebimento of the forma (dias, úteis) goes to the gaveta.
  const offered = await call('/v1/financeiro/formas-pagamento?kind=receivable', {}, users.consulta);
  assert.deepEqual(offered.items.map(item => [item.description, item.settlement_days, item.business_days]).sort(), [['Boleto sintético', null, false], ['Cartão sintético', 30, true]]);
});

test('210 Histórico of up to 2.000 characters: the gaveta reads the whole text, lists and other readers keep the first 240', async () => {
  const long = `${'Histórico longo sintético. '.repeat(30)}fim`.trim();
  assert.ok(long.length > 800 && long.length <= 2000);
  const created = (await act('title_create', receivable({ description: long, issued_on: '2026-06-01', competence_on: '2026-06-01', installments: [{ amount_cents: '10000', due_on: '2026-06-30' }] }))).items[0];
  assert.equal(created.description, long.slice(0, 240).trimEnd()); assert.equal(created.long_history, true); assert.equal(created.history, undefined);
  const detail = await call(`/v1/financeiro/titles/${created.id}/detalhe`, {}, users.consulta);
  assert.equal(detail.history, long);
  const page = await listed('from=2026-06-01&to=2026-06-30');
  assert.equal(page.items[0].history, undefined, 'the list never carries the long text');
  await assert.rejects(() => act('title_create', receivable({ description: 'x'.repeat(2001) })), http(400));
  // Another writer that changes only the short description drops the long text, so both never diverge.
  await db.query("UPDATE erp_finance.title SET description='Curto' WHERE id=$1", [created.id]);
  assert.equal(await scalar('SELECT history AS value FROM erp_finance.title WHERE id=$1', [created.id]), null);
  const again = await act('title_edit', { id: created.id, expected_version: created.version, description: long });
  assert.equal(again.record.long_history, true);
  const short = await act('title_edit', { id: created.id, expected_version: again.record.version, description: 'Histórico curto' });
  assert.deepEqual([short.record.description, short.record.long_history], ['Histórico curto', false]);
  assert.equal((await call(`/v1/financeiro/titles/${created.id}/detalhe`, {}, users.consulta)).history, null);
  await assert.rejects(() => db.query("UPDATE erp_finance.title SET history=$2 WHERE id=$1", [created.id, `Outro ${long}`]), /title_history_check/, 'the short description must be the beginning of the long text');
});

test('210 the short Histórico is cut by UTF-16 units, the unit every reader of description counts (an emoji counts 2)', async () => {
  const dated = (description, day) => receivable({ description, issued_on: `2026-08-${day}`, competence_on: `2026-08-${day}`, installments: [{ amount_cents: '10000', due_on: '2026-08-30' }] });
  // 243 characters and 253 UTF-16 units: the first 240 characters would already pass the 240 units of the list contract.
  const mixed = `${'Frete sintético '.repeat(14)}${'🚚'.repeat(10)} entregue`;
  // 130 characters and 260 UTF-16 units: short in characters, long for the API.
  const emoji = '📦'.repeat(130);
  for (const [text, day] of [[mixed, '01'], [emoji, '02']]) {
    assert.ok(text.length > 240 && [...text].length <= 243);
    const created = (await act('title_create', dated(text, day))).items[0];
    assert.ok(created.description.length <= 240 && text.startsWith(created.description), 'description stays within the 240 units of every reader');
    assert.equal(created.long_history, true);
    assert.equal((await call(`/v1/financeiro/titles/${created.id}/detalhe`, {}, users.consulta)).history, text);
  }
  const page = await listed('from=2026-08-30&to=2026-08-30');
  assert.equal(page.items.length, 2, 'the list still projects both contas');
  assert.equal(await scalar("SELECT erp_finance.utf16_length('a🚚ç') AS value"), 4);
  // 1.001 emoji are 2.002 units: refused even if a caller skips the API validation.
  await assert.rejects(() => rpc('erp_finance_title_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'title_create', p_data: dated('😀'.repeat(1001), '03') }), http(400));
});

test('210 every baixa with juros, multa, desconto or tarifa keeps the Categorização para DRE of that moment', async () => {
  const set = async (key, id) => { const version = await scalar('SELECT version AS value FROM erp_finance.category_default WHERE key=$1', [key]); return rpc('erp_finance_category_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'category_set_default', p_data: { key, category_id: id, expected_version: version } }); };
  await set('receipt_interest', juros.id); await set('receipt_additions', multa.id); await set('payment_additions', taxas.id); await set('payment_discounts', descontos.id);
  const income = (await act('title_create', receivable({ category_id: receita.id, description: 'Recebimento com juros', issued_on: '2026-07-01', competence_on: '2026-07-01', installments: [{ amount_cents: '10000', due_on: '2026-07-10' }] }))).items[0];
  const paid = await act('settle', { id: income.id, expected_version: income.version, account_id: caixa.id, posted_on: '2026-07-20', principal_cents: '10000', interest_cents: '150', penalty_cents: '200', discount_cents: '0', fee_cents: '90', note: null });
  const row = (await db.query('SELECT interest_category_id::text i,penalty_category_id::text p,discount_category_id::text d,fee_category_id::text f FROM erp_finance.settlement_category WHERE settlement_id=$1', [paid.settlement.id])).rows[0];
  assert.deepEqual(row, { i: juros.id, p: multa.id, d: null, f: null }, 'no Taxas default configured: the tarifa stays without DRE category');
  const expense = (await act('title_create', { ...receivable({ kind: 'payable', description: 'Pagamento com desconto', issued_on: '2026-07-01', competence_on: '2026-07-01', total_cents: '5000', installments: [{ amount_cents: '5000', due_on: '2026-07-10' }] }) })).items[0];
  const out = await act('settle', { id: expense.id, expected_version: expense.version, account_id: caixa.id, posted_on: '2026-07-20', principal_cents: '5000', interest_cents: '0', penalty_cents: '0', discount_cents: '300', fee_cents: '50', note: null });
  const spent = (await db.query('SELECT interest_category_id::text i,penalty_category_id::text p,discount_category_id::text d,fee_category_id::text f FROM erp_finance.settlement_category WHERE settlement_id=$1', [out.settlement.id])).rows[0];
  assert.deepEqual(spent, { i: null, p: null, d: descontos.id, f: taxas.id }, 'a tarifa of a pagamento goes to Acréscimos (pagamentos have no Taxas category)');
  // A later change of the defaults does not move what was already lançado.
  await set('receipt_interest', null);
  assert.equal(await scalar('SELECT interest_category_id::text AS value FROM erp_finance.settlement_category WHERE settlement_id=$1', [paid.settlement.id]), juros.id);
  await assert.rejects(() => db.query('UPDATE erp_finance.settlement_category SET interest_category_id=NULL WHERE settlement_id=$1', [paid.settlement.id]), /immutable/);
  const plain = (await act('title_create', receivable({ description: 'Sem adicionais', issued_on: '2026-07-01', competence_on: '2026-07-01', total_cents: '1000', installments: [{ amount_cents: '1000', due_on: '2026-07-10' }] }))).items[0];
  const simple = await act('settle', { id: plain.id, expected_version: plain.version, account_id: caixa.id, posted_on: '2026-07-20', principal_cents: '1000', interest_cents: '0', penalty_cents: '0', discount_cents: '0', fee_cents: '0', note: null });
  assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_finance.settlement_category WHERE settlement_id=$1', [simple.settlement.id]), 0);
});
