import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { financeParityDb } from './helpers/finance-parity-db.mjs';

// Synthetic data only. 108: Origin drawer of contas (competência, conta financeira, nº no banco, juros e multa,
// vencimento original) and logical exclusion, through public.erp_finance_title_execute.
let db; let users; let scalar; let rpc; let alfa; let beta; let category; let account; let archived;
const code = expected => error => error.code === expected;
const legacy = (action, data, user = users.financeiro) => rpc('erp_finance_execute', { p_user_id: user, p_command_id: randomUUID(), p_action: action, p_data: data });
const drawer = (action, data, user = users.financeiro, command = randomUUID()) => rpc('erp_finance_title_execute', { p_user_id: user, p_command_id: command, p_action: action, p_data: data });
const detail = (id, user = users.consulta) => rpc('erp_finance_title_detail', { p_user_id: user, p_id: id });
const base = extra => ({ kind: 'receivable', contact_id: alfa.id, description: 'Mensalidade sintética', issued_on: '2026-01-05', competence_on: '2025-12-01', total_cents: '10000', installments: [{ amount_cents: '10000', due_on: '2026-02-10' }], ...extra });

before(async () => {
  const env = await financeParityDb({ through: '202610190101_origin_sync_freshness.sql' });
  ({ db, users, scalar, rpc } = env); await env.addUsers(); const contact = env.contact;
  alfa = await contact({ name: 'Alfa Comércio Sintético' }); beta = await contact({ name: 'Beta Serviços Sintéticos' });
  category = (await legacy('category_save', { expected_version: 0, name: 'Receita sintética', kind: 'receivable' })).record;
  account = (await legacy('account_save', { expected_version: 0, name: 'Banco sintético', kind: 'bank' })).record;
  archived = (await legacy('account_save', { expected_version: 0, name: 'Conta arquivada', kind: 'cash', active: false })).record;
  // A title created before 108 keeps the 010 shape; the migration fills competência and vencimento original.
  await legacy('title_create_group', { kind: 'receivable', contact_id: alfa.id, description: 'Antes da 108', issued_on: '2025-01-02', total_cents: '500', installments: [{ amount_cents: '500', due_on: '2025-03-04' }] });
  await env.load('202610200108_finance_title_drawer.sql');
});
after(async () => db?.close());

test('108 drawer writes are service-only security definer RPCs; helpers stay closed and roles are rechecked in SQL', async () => {
  const fns = (await db.query("SELECT p.proname,p.prosecdef,p.proconfig,p.provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('erp_finance_title_execute','erp_finance_title_detail') ORDER BY 1")).rows;
  assert.deepEqual(fns.map(fn => [fn.proname, fn.prosecdef, fn.proconfig, fn.provolatile]), [['erp_finance_title_detail', true, ['search_path=pg_catalog'], 's'], ['erp_finance_title_execute', true, ['search_path=pg_catalog'], 'v']]);
  for (const signature of ['public.erp_finance_title_execute(uuid,uuid,text,jsonb)', 'public.erp_finance_title_detail(uuid,uuid)']) {
    for (const role of ['anon', 'authenticated']) assert.equal(await scalar("SELECT has_function_privilege($1,$2,'EXECUTE') AS value", [role, signature]), false);
    assert.equal(await scalar("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS value", [signature]), true);
  }
  for (const helper of ['erp_finance.bp(jsonb,text)', 'erp_finance.bank_number(jsonb)', 'erp_finance.active_account(uuid)', 'erp_finance.active_category(uuid,text)', 'erp_finance.title_billing(uuid)', 'erp_finance.title_defaults()', 'erp_finance.title_history_guard()'])
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar("SELECT has_function_privilege($1,$2,'EXECUTE') AS value", [role, helper]), false, `${role} ${helper}`);
  for (const role of ['consulta', 'vendas', 'inactive']) await assert.rejects(() => drawer('title_create', base(), users[role]), code('42501'));
  await assert.rejects(() => drawer('title_create', base(), randomUUID()), code('42501'));
  for (const role of ['vendas', 'inactive']) await assert.rejects(() => detail(randomUUID(), users[role]), code('42501'));
  await assert.rejects(() => drawer('title_update', base()), code('22023'), 'only the drawer actions are accepted');
});

test('108 fills competência and vencimento original for existing titles and for the old writers', async () => {
  const old = (await db.query("SELECT competence_on::text c, original_due_on::text o, interest_month_bp i, penalty_bp p, account_id, bank_number FROM erp_finance.title WHERE description='Antes da 108'")).rows[0];
  assert.deepEqual(old, { c: '2025-01-02', o: '2025-03-04', i: 0, p: 0, account_id: null, bank_number: null });
  const created = await legacy('title_create_group', { kind: 'payable', contact_id: beta.id, description: 'Escritor 010', issued_on: '2026-03-01', total_cents: '700', installments: [{ amount_cents: '700', due_on: '2026-04-01' }] });
  assert.equal(created.items[0].competence_on, '2026-03-01'); assert.equal(created.items[0].original_due_on, '2026-04-01');
  assert.equal(created.items[0].deleted_at, null);
});

test('108 title_create keeps the Origin drawer fields, validates every one and replays the same command', async () => {
  const command = randomUUID();
  const data = base({ category_id: category.id, account_id: account.id, bank_number: '00012345', source_reference: 'Contrato 7', interest_month_bp: 100, penalty_bp: 200,
    total_cents: '10001', installments: [{ amount_cents: '5001', due_on: '2026-02-10' }, { amount_cents: '5000', due_on: '2026-03-10' }] });
  const first = await drawer('title_create', data, users.financeiro, command);
  assert.equal(first.replayed, false); assert.equal(first.action, 'title_create'); assert.equal(first.items.length, 2);
  for (const [index, item] of first.items.entries()) {
    assert.deepEqual([item.installment, item.installments, item.account_id, item.bank_number, item.interest_month_bp, item.penalty_bp, item.competence_on, item.original_due_on, item.category_id],
      [index + 1, 2, account.id, '00012345', 100, 200, '2025-12-01', data.installments[index].due_on, category.id]);
  }
  const again = await drawer('title_create', data, users.financeiro, command);
  assert.equal(again.replayed, true); assert.deepEqual(again.items.map(item => item.id), first.items.map(item => item.id));
  await assert.rejects(() => drawer('title_create', { ...data, penalty_bp: 300 }, users.financeiro, command), code('40001'), 'same command with another body');
  await assert.rejects(() => drawer('title_create', data, users.admin, command), code('40001'), 'another actor cannot replay');
  const invalid = [
    { interest_month_bp: 10001 }, { interest_month_bp: '100' }, { penalty_bp: 1.5 }, { penalty_bp: -1 }, { bank_number: '12' }, { bank_number: 'x'.repeat(61) },
    { account_id: archived.id }, { account_id: randomUUID() }, { competence_on: '2026-02-30' }, { competence_on: null }, { description: 'x'.repeat(241) },
    { total_cents: '9999' }, { installments: [{ amount_cents: '10000', due_on: '2026-01-04' }] }, { kind: 'both' }, { unknown: true },
  ];
  for (const extra of invalid) await assert.rejects(() => drawer('title_create', base(extra)), error => ['22023', 'P0002'].includes(error.code), JSON.stringify(extra));
  const audit = (await db.query("SELECT action,before_data FROM erp_finance.audit WHERE command_id=$1", [command])).rows;
  assert.deepEqual(audit.map(row => [row.action, row.before_data]), [['title_create', null]]);
});

test('108 title_edit changes contato, emissão, competência, valor, conta and percentuais of a free title, with CAS', async () => {
  const [title] = (await drawer('title_create', base())).items;
  await assert.rejects(() => drawer('title_edit', { id: title.id, expected_version: 2, description: 'x' }), code('40001'));
  const edited = await drawer('title_edit', { id: title.id, expected_version: 1, contact_id: beta.id, issued_on: '2026-01-06', competence_on: '2026-01-01', due_on: '2026-02-20',
    amount_cents: '12345', account_id: account.id, bank_number: 'Linha 1', interest_month_bp: 150, penalty_bp: 0, description: 'Editada', category_id: category.id });
  const record = edited.record;
  assert.deepEqual([record.contact_id, record.contact_name, record.issued_on, record.competence_on, record.due_on, record.original_due_on, record.amount_cents, record.balance_cents, record.account_id, record.bank_number, record.interest_month_bp, record.version],
    [beta.id, 'Beta Serviços Sintéticos', '2026-01-06', '2026-01-01', '2026-02-20', '2026-02-10', '12345', '12345', account.id, 'Linha 1', 150, 2]);
  const partial = await drawer('title_edit', { id: title.id, expected_version: 2, account_id: null });
  assert.equal(partial.record.account_id, null); assert.equal(partial.record.interest_month_bp, 150, 'absent keys keep their value');
  await assert.rejects(() => drawer('title_edit', { id: title.id, expected_version: 3, due_on: '2026-01-05' }), code('22023'), 'vencimento before emissão');
  await assert.rejects(() => drawer('title_edit', { id: title.id, expected_version: 3, account_id: archived.id }), code('22023'));
  await assert.rejects(() => db.query("UPDATE erp_finance.title SET original_due_on='2020-01-01' WHERE id=$1", [title.id]), /erp_finance_original_due_locked/);
  // After a baixa, contato, emissão and valor stay with the payment.
  await legacy('settle', { id: title.id, expected_version: 3, account_id: account.id, posted_on: '2026-02-01', principal_cents: '100' });
  for (const change of [{ contact_id: alfa.id }, { issued_on: '2026-01-05' }, { amount_cents: '20000' }])
    await assert.rejects(() => drawer('title_edit', { id: title.id, expected_version: 4, ...change }), code('40001'), JSON.stringify(change));
  const still = await drawer('title_edit', { id: title.id, expected_version: 4, due_on: '2026-03-01', penalty_bp: 200 });
  assert.equal(still.record.due_on, '2026-03-01'); assert.equal(still.record.penalty_bp, 200);
  // A parcela of a group without baixa may change its own value, as in Origin.
  const group = (await drawer('title_create', base({ total_cents: '3000', installments: [{ amount_cents: '1500', due_on: '2026-02-10' }, { amount_cents: '1500', due_on: '2026-03-10' }] }))).items;
  assert.equal((await drawer('title_edit', { id: group[1].id, expected_version: 1, amount_cents: '1700' })).record.amount_cents, '1700');
});

test('108 title_edit keeps the source of document, Origin import and boleto titles', async () => {
  const body = { date: '2026-10-16', contact_id: alfa.id, items: [{ description: 'Linha sintética', unit: 'UN', quantity: '1', unit_price: '40', discount_percent: '0' }], installments: [{ due_date: '2099-03-01', amount: '40.00' }] };
  let document = (await rpc('erp_document_save', { p_user_id: users.admin, p_kind: 'sales_orders', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: body })).document;
  for (const status of ['open', 'verified']) document = (await rpc('erp_document_transition', { p_user_id: users.admin, p_kind: 'sales_orders', p_id: document.id, p_expected_version: document.version, p_command_id: randomUUID(), p_status: status, p_reason: 'Teste sintético' })).document;
  const scope = { p_user_id: users.admin, p_kind: 'sales_orders', p_document_id: document.id, p_expected_version: document.version };
  const preview = await rpc('erp_document_finance_preview', scope);
  await rpc('erp_document_finance_post', { ...scope, p_command_id: randomUUID(), p_preview_hash: preview.preview.preview_hash });
  const linked = await scalar('SELECT erp_finance.dto(\'titles\',l.title_id) AS value FROM erp_finance.document_title l JOIN erp_finance.document_posting p ON p.id=l.posting_id WHERE p.document_id=$1', [document.id]);
  for (const change of [{ contact_id: beta.id }, { issued_on: '2026-10-17' }, { amount_cents: '4100' }, { source_reference: 'Outra' }])
    await assert.rejects(() => drawer('title_edit', { id: linked.id, expected_version: linked.version, ...change }), code('40001'), JSON.stringify(change));
  const kept = await drawer('title_edit', { id: linked.id, expected_version: linked.version, account_id: account.id, competence_on: '2026-10-01', description: 'Pedido sintético' });
  assert.equal(kept.record.account_id, account.id); assert.equal(kept.record.document_linked, true);
  await assert.rejects(() => drawer('title_delete', { id: linked.id, expected_version: kept.record.version }), code('40001'));
  // A conta adopted from Origin (039) keeps its original values.
  const [imported] = (await drawer('title_create', base())).items, receipt = randomUUID();
  await db.query("INSERT INTO erp_finance.command(id,actor,request_hash,result) VALUES($1,$2,'sintetico','{}')", [receipt, users.admin]);
  await db.query("INSERT INTO erp_finance.origin_import_origin(entity,source_id,title_id,command_id,evidence) VALUES('receivables','9001',$1,$2,'{}')", [imported.id, receipt]);
  for (const change of [{ contact_id: beta.id }, { amount_cents: '1' }, { issued_on: '2026-01-04' }, { source_reference: 'Outra' }])
    await assert.rejects(() => drawer('title_edit', { id: imported.id, expected_version: 1, ...change }), code('40001'), JSON.stringify(change));
  assert.equal((await drawer('title_edit', { id: imported.id, expected_version: 1, due_on: '2026-02-12' })).record.due_on, '2026-02-12');
  await assert.rejects(() => drawer('title_delete', { id: imported.id, expected_version: 2 }), code('40001'));
  assert.equal((await detail(imported.id)).imported, true);
  // A boleto reserved for the title: nº no banco, valor and contato follow the bank registration.
  const [billed] = (await drawer('title_create', base({ bank_number: 'Externo 1' }))).items;
  const profile = randomUUID(), remittance = randomUUID();
  await db.query("INSERT INTO erp_cnab.profile(id,account_id,identity,settings,account_scope,next_sequence) VALUES($1,$2,'{}','{}','sintetico-108',2)", [profile, account.id]);
  await db.query("INSERT INTO erp_cnab.remittance(id,profile_id,sequence,generated_on,snapshot,actor) VALUES($1,$2,1,'2026-01-10','{}',$3)", [remittance, profile, users.admin]);
  await db.query("INSERT INTO erp_cnab.billing_title(title_id,profile_id,remittance_id,control,document_number,our_number,snapshot) VALUES($1,$2,$3,'C1','D1','12345678','{}')", [billed.id, profile, remittance]);
  for (const change of [{ bank_number: 'Outro' }, { amount_cents: '1' }, { contact_id: beta.id }])
    await assert.rejects(() => drawer('title_edit', { id: billed.id, expected_version: 1, ...change }), code('40001'), JSON.stringify(change));
  assert.equal((await drawer('title_edit', { id: billed.id, expected_version: 1, due_on: '2026-02-11' })).record.due_on, '2026-02-11');
  await assert.rejects(() => drawer('title_delete', { id: billed.id, expected_version: 2 }), code('40001'), 'a title in a remessa is not excluded');
  const read = await detail(billed.id);
  assert.deepEqual(read.billing, { our_number: '12345678', document_number: 'D1', remittance_id: remittance, remittance_sequence: 1, remittance_state: 'reserved', file_generated: false });
  assert.equal(read.origin, null); assert.equal(read.imported, false); assert.equal(read.settled_before, false); assert.equal(read.account, null);
  assert.equal(read.original.due_on, '2026-02-10'); assert.equal(read.original.contact_name, 'Alfa Comércio Sintético');
});

test('108 title_delete hides the conta without erasing history; it refuses titles with an active baixa', async () => {
  const [free] = (await drawer('title_create', base({ account_id: account.id }))).items;
  const [paid] = (await drawer('title_create', base())).items;
  await legacy('settle', { id: paid.id, expected_version: 1, account_id: account.id, posted_on: '2026-02-01', principal_cents: '10000' });
  await assert.rejects(() => drawer('title_delete', { id: paid.id, expected_version: 2 }), code('40001'));
  await assert.rejects(() => drawer('title_delete', { id: free.id, expected_version: 1 }, users.consulta), code('42501'));
  const deleted = await drawer('title_delete', { id: free.id, expected_version: 1, note: 'Lançada em duplicidade' });
  assert.equal(deleted.record.cancelled, true); assert.equal(deleted.record.status, 'cancelled'); assert.match(deleted.record.deleted_at, /^\d{4}-/);
  assert.equal(deleted.note, 'Lançada em duplicidade');
  const row = (await db.query('SELECT deleted_by,deleted_note FROM erp_finance.title WHERE id=$1', [free.id])).rows[0];
  assert.deepEqual(row, { deleted_by: users.financeiro, deleted_note: 'Lançada em duplicidade' });
  await assert.rejects(() => drawer('title_edit', { id: free.id, expected_version: 2, description: 'Volta' }), code('40001'));
  await assert.rejects(() => drawer('title_delete', { id: free.id, expected_version: 2 }), code('40001'));
  await assert.rejects(() => legacy('title_update', { id: free.id, expected_version: 2, description: 'Volta' }), code('40001'));
  await assert.rejects(() => db.query("UPDATE erp_finance.title SET description='x' WHERE id=$1", [free.id]), /erp_finance_deleted_title/);
  assert.equal((await detail(free.id)).record.deleted_at, deleted.record.deleted_at, 'the record stays readable');
  // A cancelled conta may also be excluded.
  const [cancelled] = (await drawer('title_create', base())).items;
  await legacy('title_cancel', { id: cancelled.id, expected_version: 1, note: 'Cancelada' });
  assert.match((await drawer('title_delete', { id: cancelled.id, expected_version: 2 })).record.deleted_at, /^\d{4}-/);
  assert.equal(await scalar("SELECT count(*)::int AS value FROM erp_finance.audit WHERE action='title_delete'"), 2);
  await assert.rejects(() => detail(randomUUID()), code('P0002'));
});
