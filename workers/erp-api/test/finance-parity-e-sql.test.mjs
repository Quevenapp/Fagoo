import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { financeParityDb } from './helpers/finance-parity-db.mjs';
import { parseFinanceRoute, executeFinanceRoute } from '../src/finance.mjs';

// Synthetic data only. 246: "sem vendedor", banco da forma na listagem, Nº Retorno e a trava da exclusão de retornos, atrasadas
// do Fluxo de caixa previsto até hoje, Situação Cancelados do extrato e as permissões de Finanças aplicadas no banco.
let env; let db; let users; let scalar; let rpc; let alfa; let seller; let caixa; let itau; let boleto;
const SQL = { 400: ['22023'], 403: ['42501'], 404: ['P0002'], 409: ['40001', '23505', '55000'] };
const http = status => error => error.status === status || (SQL[status] ?? []).includes(error.code);
const sha = text => createHash('sha256').update(text).digest('hex');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const shift = (day, days) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const call = async (path, init = {}, user = users.financeiro) => executeFinanceRoute(await parseFinanceRoute(new Request(`https://api.example.test${path}`, init.body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {})), { userId: user, rpc: (name, args) => rpc(name, args) });
const act = (action, data, user = users.financeiro, command = randomUUID()) => call(`/v1/financeiro/actions/${action}`, { body: { command_id: command, data } }, user);
const receivable = (extra = {}) => ({ kind: 'receivable', contact_id: alfa.id, description: 'Venda sintética', issued_on: '2026-03-01', competence_on: '2026-03-01', total_cents: '10000', installments: [{ amount_cents: '10000', due_on: '2026-03-31' }], ...extra });
const listed = (query, user = users.consulta) => call(`/v1/financeiro/titles?page=1&kind=receivable&option=issued&from=2026-01-01&to=2099-12-31&${query}`, {}, user);
// A user restricted to a set of keys of Sistema > Usuários > Permissões (229), without changing the profile.
async function restrict(role, keys) {
  const id = randomUUID(); await db.query('INSERT INTO auth.users(id) VALUES($1)', [id]);
  await db.query('INSERT INTO erp_access.membership(user_id,role,active) VALUES($1,$2,true)', [id, role]);
  await db.query('INSERT INTO erp_access.user_control(user_id,permissions,version,updated_at,updated_by) VALUES($1,$2,1,now(),$3)', [id, keys, users.admin]);
  return id;
}

before(async () => {
  env = await financeParityDb({});
  ({ db, users, scalar, rpc } = env);
  await db.exec('ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text');
  await env.addUsers();
  alfa = await env.contact({ name: 'Alfa Sintética' });
  const vendedora = await env.contact({ name: 'Vendedora Sintética' });
  seller = (await rpc('erp_catalog_seller_from_contact', { p_user_id: users.admin, p_command_id: randomUUID(), p_contact_id: vendedora.id })).seller.id;
  caixa = (await rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: { account_type: 'cash', name: 'Caixa', start_on: '2020-01-01', opening_cents: '0' } })).record;
  itau = (await rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: { account_type: 'checking', institution_code: '341', institution_name: 'Itaú Unibanco', name: 'Itaú sintético', agency: '1', account_number: '2', account_digit: '3', start_on: '2020-01-01', opening_cents: '0' } })).record;
  boleto = (await db.query(`INSERT INTO erp_catalog.payment_method(description,payment_type,destination,applicable,fee_type,account_id,created_by,updated_by) VALUES('Boleto Itaú sintético','15','contas','recebimentos','aliquota',$1,$2,$2) RETURNING id`, [itau.id, users.admin])).rows[0].id;
});
after(async () => db?.close());

test('246 helpers and triggers stay closed; the RPCs it replaces stay service-only', async () => {
  for (const signature of ['public.erp_finance_access(uuid)', 'public.erp_finance_title_execute(uuid,uuid,text,jsonb)',
    'public.erp_finance_title_page_v2(uuid,text,integer,integer,text,text,text,text[],text,date,date,text,text[],text,bigint,text,text,uuid,uuid)',
    'public.erp_cnab_return_page(uuid,text,date,date,integer,integer)', 'public.erp_cnab_return_detail(uuid,uuid,text,integer,integer)', 'public.erp_cnab_return_exclude(uuid,uuid,jsonb)',
    'public.erp_cnab_remittance_page(uuid,text,date,date,integer,integer)', 'public.erp_cnab_remittance_detail(uuid,uuid)', 'public.erp_finance_report(uuid,text,date,date,uuid,text,integer,integer)',
    'public.erp_finance_statement_page(uuid,uuid,date,date,text,boolean,text[],bigint,text,text,integer,integer,text,boolean)']) {
    for (const role of ['anon', 'authenticated']) assert.equal(await scalar("SELECT has_function_privilege($2,$1,'EXECUTE') AS value", [signature, role]), false, `${role} ${signature}`);
    assert.equal(await scalar("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS value", [signature]), true, signature);
    assert.deepEqual((await db.query('SELECT prosecdef,proconfig FROM pg_proc WHERE oid=to_regprocedure($1)', [signature])).rows[0], { prosecdef: true, proconfig: ['search_path=pg_catalog'] });
  }
  assert.equal(await scalar("SELECT to_regprocedure('public.erp_finance_statement_page(uuid,uuid,date,date,text,boolean,text[],bigint,text,text,integer,integer,text)') IS NULL AS value"), true, 'the old extrato signature is dropped');
  for (const helper of ['erp_finance.require_permission(uuid,text)', 'erp_finance.permission_key(text,jsonb)', 'erp_finance.audit_permission()', 'erp_cnab.permission_key(text)', 'erp_cnab.audit_permission()',
    'erp_finance.title_inherited_seller(uuid)', 'erp_cnab.return_number(erp_cnab.return_file)', 'erp_finance.statement_line_cancelled(text,uuid)', 'erp_cnab.lock_operational_event(uuid,uuid,integer,integer)'])
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar("SELECT has_function_privilege($2,$1,'EXECUTE') AS value", [helper, role]), false, `${role} ${helper}`);
});

test('246 "sem vendedor": clearing the inherited Vendedor of a conta lançada by a pedido keeps it without seller until one is chosen', async () => {
  const body = { date: today, contact_id: alfa.id, seller_id: seller, items: [{ description: 'Peça sintética', unit: 'UN', quantity: '1', unit_price: '80', discount_percent: '0' }], installments: [{ due_date: '2099-02-10', amount: '80.00' }] };
  let document = (await rpc('erp_document_save', { p_user_id: users.admin, p_kind: 'sales_orders', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: body })).document;
  for (const status of document.status === 'draft' ? ['open', 'verified'] : ['verified']) document = (await rpc('erp_document_transition', { p_user_id: users.admin, p_kind: 'sales_orders', p_id: document.id, p_expected_version: document.version, p_command_id: randomUUID(), p_status: status, p_reason: 'Teste sintético' })).document;
  const scope = { p_user_id: users.admin, p_kind: 'sales_orders', p_document_id: document.id, p_expected_version: document.version };
  const preview = await rpc('erp_document_finance_preview', scope);
  const posted = await rpc('erp_document_finance_post', { ...scope, p_command_id: randomUUID(), p_preview_hash: preview.preview.preview_hash });
  const id = posted.titles[0].id;
  const inherited = (await call(`/v1/financeiro/titles/${id}`)).record;
  assert.deepEqual([inherited.seller_id, inherited.seller_source, inherited.seller_cleared], [seller, 'documento', false]);
  const cleared = await act('title_edit', { id, expected_version: inherited.version, seller_id: null });
  assert.deepEqual([cleared.record.seller_id, cleared.record.seller_name, cleared.record.seller_source, cleared.record.seller_cleared], [null, null, null, true]);
  assert.equal(await scalar('SELECT seller_none AS value FROM erp_finance.title WHERE id=$1', [id]), true);
  assert.ok(!(await listed(`seller=${seller}`)).items.some(item => item.id === id), 'the Vendedor filter follows "sem vendedor"');
  const detail = await call(`/v1/financeiro/titles/${id}/detalhe`);
  assert.equal(detail.record.seller_cleared, true);
  const again = await act('title_edit', { id, expected_version: cleared.record.version, seller_id: seller });
  assert.deepEqual([again.record.seller_id, again.record.seller_source, again.record.seller_cleared], [seller, 'conta', false]);
  assert.ok((await listed(`seller=${seller}`)).items.some(item => item.id === id));
  // A conta without a document seller simply has none: clearing does not mark "sem vendedor".
  const plain = (await act('title_create', receivable({ seller_id: seller, description: 'Conta sem pedido' }))).items[0];
  const none = await act('title_edit', { id: plain.id, expected_version: plain.version, seller_id: null });
  assert.deepEqual([none.record.seller_id, none.record.seller_cleared], [null, false]);
  await assert.rejects(() => db.query('UPDATE erp_finance.title SET seller_none=true,seller_id=$2 WHERE id=$1', [plain.id, seller]), /title_seller_none/);
});

test('246 Forma de pagamento column: the bank of the conta financeira of the forma (else of the conta)', async () => {
  const withMethod = (await act('title_create', receivable({ payment_method_id: boleto, description: 'Conta com boleto Itaú' }))).items[0];
  const withAccount = (await act('title_create', receivable({ account_id: itau.id, description: 'Conta só com conta Itaú' }))).items[0];
  const page = await listed('q=Itaú');
  const row = page.items.find(item => item.id === withMethod.id);
  assert.deepEqual(row.payment_bank, { code: '341', name: 'Itaú Unibanco' });
  assert.equal(Object.hasOwn(page.items.find(item => item.id === withAccount.id), 'payment_bank'), false, 'without a forma the column has no bank');
  await db.query('UPDATE erp_catalog.payment_method SET account_id=NULL WHERE id=$1', [boleto]);
  const later = (await listed('q=Itaú')).items.find(item => item.id === withMethod.id);
  assert.equal(Object.hasOwn(later, 'payment_bank'), false, 'a forma without conta and a conta without conta financeira show no bank');
  await db.query('UPDATE erp_catalog.payment_method SET account_id=$2 WHERE id=$1', [boleto, itau.id]);
});

test('246 Fluxo de caixa previsto: atrasadas are the contas em aberto vencidas antes de hoje, whatever the period', async () => {
  const before = await call(`/v1/financeiro/relatorios?report=forecast&from=${shift(today, 10)}&to=${shift(today, 40)}`, {}, users.consulta);
  const overdue = (await act('title_create', receivable({ issued_on: shift(today, -30), competence_on: shift(today, -30), total_cents: '1100', installments: [{ amount_cents: '1100', due_on: shift(today, -2) }], description: 'Atrasada sintética' }))).items[0];
  const soon = (await act('title_create', receivable({ issued_on: today, competence_on: today, total_cents: '2200', installments: [{ amount_cents: '2200', due_on: shift(today, 3) }], description: 'A vencer antes do De' }))).items[0];
  const report = await call(`/v1/financeiro/relatorios?report=forecast&from=${shift(today, 10)}&to=${shift(today, 40)}`, {}, users.consulta);
  assert.equal(BigInt(report.summary.overdue_receivable_cents) - BigInt(before.summary.overdue_receivable_cents), 1100n, 'only the conta vencida antes de hoje is atrasada; the one due before "De" is not');
  assert.equal(report.summary.receivable_cents, before.summary.receivable_cents, 'neither falls in the period');
  for (const title of [overdue, soon]) await act('title_delete', { id: title.id, expected_version: title.version });
});

test('246 extrato Situação Cancelados: the baixa estornada and its estorno, outside the saldos', async () => {
  const title = (await act('title_create', receivable({ description: 'Conta estornada sintética', total_cents: '3000', installments: [{ amount_cents: '3000', due_on: '2026-03-31' }] }))).items[0];
  const settled = await act('settle', { id: title.id, expected_version: title.version, account_id: caixa.id, posted_on: '2026-03-10', principal_cents: '3000' });
  const reversed = await act('reverse', { id: title.id, expected_version: settled.record.version, settlement_id: settled.settlement.id, posted_on: '2026-03-12', note: 'Estorno sintético' });
  assert.ok(reversed.record);
  const kept = (await act('title_create', receivable({ description: 'Conta paga sintética', total_cents: '500', installments: [{ amount_cents: '500', due_on: '2026-03-31' }] }))).items[0];
  await act('settle', { id: kept.id, expected_version: kept.version, account_id: caixa.id, posted_on: '2026-03-11', principal_cents: '500' });
  const base = `/v1/financeiro/extrato?account=${caixa.id}&from=2026-03-01&to=2026-03-31`;
  const registered = await call(base, {}, users.consulta);
  assert.equal(registered.items.filter(line => line.line_kind === 'settlement').length, 3, 'Registrados keeps the baixa, the estorno and the other baixa');
  const cancelled = await call(`${base}&cancelled=true`, {}, users.consulta);
  assert.equal(cancelled.cancelled, true);
  assert.deepEqual(cancelled.items.map(line => line.amount_cents).sort(), ['-3000', '3000']);
  assert.deepEqual(cancelled.day_balances, {});
  await assert.rejects(() => call(`${base}&cancelled=true&deleted=true`, {}, users.consulta), http(400));
  await assert.rejects(() => call(`${base}&cancelled=false`, {}, users.consulta), http(400));
});

test('246 Nº Retorno is read from the evidence; the exclusion takes the operational locks and an excluded retorno is never applied', async () => {
  const account = (await rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: { account_type: 'checking', institution_code: '341', institution_name: 'Itaú Unibanco', name: 'Itaú cobrança 246', agency: '1', account_number: '2', account_digit: '4', start_on: '2020-01-01', opening_cents: '0' } })).record;
  const profile = (await db.query(`INSERT INTO erp_cnab.profile(account_id,identity,settings,account_scope,next_sequence) VALUES($1,$2::jsonb,'{}'::jsonb,'synthetic-246',1) RETURNING id`,
    [account.id, JSON.stringify({ bank: '341', layout: 'cnab400', agency: '1500', account: '12345', accountDigit: '6', wallet: '109', cnpj: '00000000000191' })])).rows[0].id;
  const file = async (hash, evidence) => (await db.query(`INSERT INTO erp_cnab.return_file(profile_id,file_hash,object_path,byte_size,generated_on,century,record_count,warnings,evidence,actor,purpose) VALUES($1,$2,$3,800,'2026-05-02',2000,3,'[]',$4::jsonb,$5,'operational') RETURNING id`,
    [profile, hash, `profiles/${profile}/returns/${hash}.ret`, JSON.stringify(evidence), users.admin])).rows[0].id;
  const numbered = await file(sha('ret-246-a'), { source: 'authenticated-bank-download', fileSequence: '00042' }), older = await file(sha('ret-246-b'), {});
  const eventId = (await db.query(`INSERT INTO erp_cnab.return_event(profile_id,event_hash,payload,proposed_action,reason,purpose) VALUES($1,$2,'{"kind":"PAID","occurrence":"06","amountCents":"100"}'::jsonb,'REVIEW','synthetic','operational') RETURNING id`, [profile, sha('ev-246')])).rows[0].id;
  await db.query('INSERT INTO erp_cnab.return_occurrence(file_id,line,event_id,line_hash,duplicate) VALUES($1,2,$2,$3,false)', [numbered, eventId, sha('line-246')]);
  const page = await call('/v1/financeiro/retornos?from=2026-05-01&to=2026-05-31', {}, users.consulta);
  assert.deepEqual(Object.fromEntries(page.items.map(item => [item.id, item.number])), { [numbered]: '00042', [older]: null });
  assert.deepEqual((await call('/v1/financeiro/retornos?q=42&from=2026-05-01&to=2026-05-31', {}, users.consulta)).items.map(item => item.id), [numbered], 'Pesquisar finds the Nº Retorno');
  const detail = await call(`/v1/financeiro/retornos/${numbered}`, {}, users.consulta);
  assert.equal(detail.record.number, '00042');
  const command = randomUUID();
  await act('return_exclude', { id: numbered }, users.financeiro, command);
  assert.equal((await act('return_exclude', { id: numbered }, users.financeiro, command)).replayed, true);
  await assert.rejects(() => db.query('SELECT erp_cnab.lock_operational_event($1,$2,2,1)', [eventId, numbered]), /erp_cnab_return_excluded/);
  const source = await scalar("SELECT prosrc AS value FROM pg_proc WHERE oid=to_regprocedure('public.erp_cnab_return_exclude(uuid,uuid,jsonb)')");
  assert.match(source, /pg_advisory_xact_lock\(174852920,1\)[\s\S]*erp_cnab\.profile where id=v_profile for update[\s\S]*return_file where id=v_id for update[\s\S]*return_applied/, 'same lock order as the vinculação and the baixa');
});

test('246 permissions of Finanças are enforced in the database: writes by the audit, screens by their keys', async () => {
  const keys = ['financas.contas_receber', 'financas.contas_receber.ie', 'financas.caixas_bancos'];
  const limited = await restrict('financeiro', keys);
  const access = await call('/v1/financeiro', {}, limited);
  assert.deepEqual(access.permitted, ['financas.caixas_bancos', 'financas.contas_receber', 'financas.contas_receber.ie'], 'the access lists the finance keys the user has, in the order of the catalog');
  assert.equal((await call('/v1/financeiro', {}, users.financeiro)).permitted.length > 40, true, 'without a saved set the profile has every key');
  const created = (await act('title_create', receivable({ description: 'Conta do usuário limitado' }), limited)).items[0];
  await assert.rejects(() => act('title_delete', { id: created.id, expected_version: created.version }, limited), http(403), 'Excluir needs financas.contas_receber.ex');
  await assert.rejects(() => act('settle', { id: created.id, expected_version: created.version, account_id: caixa.id, posted_on: '2026-03-10', principal_cents: '100' }, limited), http(403), 'Baixar needs .baixar');
  await assert.rejects(() => act('title_create', { ...receivable(), kind: 'payable' }, limited), http(403), 'Contas a pagar are another key');
  await assert.rejects(() => call('/v1/financeiro/titles?page=1&kind=payable&option=issued', {}, limited), http(403), 'the list of contas a pagar needs its key');
  assert.ok((await call('/v1/financeiro/titles?page=1&kind=receivable&option=issued', {}, limited)).items.length > 0);
  await assert.rejects(() => call('/v1/financeiro/relatorios?report=cash_flow&from=2026-03-01&to=2026-03-31', {}, limited), http(403), 'Fluxo needs financas.caixas_bancos.fluxo');
  await assert.rejects(() => call('/v1/financeiro/retornos', {}, limited), http(403));
  await assert.rejects(() => call('/v1/financeiro/remessas', {}, limited), http(403));
  assert.ok(await call('/v1/financeiro/extrato?from=2026-03-01&to=2026-03-31', {}, limited));
  await assert.rejects(() => rpc('erp_finance_category_execute', { p_user_id: limited, p_command_id: randomUUID(), p_action: 'category_create', p_data: { kind: 'receivable', name: 'Categoria negada' } }), http(403));
  assert.equal(await scalar("SELECT count(*)::integer AS value FROM erp_finance.category WHERE name='Categoria negada'"), 0, 'the refusal undoes the write');
  // The administrador always has every key, whatever was saved.
  const admin = await restrict('admin', ['financas.contas_receber']);
  assert.ok((await act('title_create', { ...receivable(), kind: 'payable', description: 'Conta do administrador' }, admin)).items[0]);
  // Mapping of the actions to the catalog (no key: configuration actions keep only the profile).
  const key = (action, after) => scalar('SELECT erp_finance.permission_key($1,$2::jsonb) AS value', [action, JSON.stringify(after)]);
  assert.equal(await key('reverse', { entity: 'titles', record: { kind: 'payable' } }), 'financas.contas_pagar.baixar');
  assert.equal(await key('bordero_settle', { entity: 'borderos', items: [{ title: { kind: 'receivable' } }] }), 'financas.contas_receber.baixar');
  assert.equal(await key('document_post', { posting: { kind: 'purchase_orders' } }), 'suprimentos.pedidos_compra.lancar_contas');
  assert.equal(await key('transfer_create', {}), 'financas.caixas_bancos.transferencia');
  assert.equal(await key('origin_import_batch', {}), null);
  assert.equal(await scalar("SELECT erp_cnab.permission_key('operational_finalize') AS value"), 'financas.remessas.gerar');
  assert.equal(await scalar("SELECT erp_cnab.permission_key('profile_save') AS value"), null);
});

test('246 every finance and cobrança write has the key of its screen; the extrato and the conciliação keep their own keys', async () => {
  const key = (action, after = {}) => scalar('SELECT erp_finance.permission_key($1,$2::jsonb) AS value', [action, JSON.stringify(after)]);
  const record = kind => ({ entity: 'titles', record: { kind } });
  const expected = {
    account_save: 'financas.caixas_bancos.ie', account_create: 'financas.caixas_bancos.ie', account_update: 'financas.caixas_bancos.ie', account_set_active: 'financas.caixas_bancos.ie',
    account_set_default: 'financas.caixas_bancos.ie', account_delete: 'financas.caixas_bancos.ex', opening: 'financas.caixas_bancos.ie', entry_save: 'financas.caixas_bancos.ie',
    entry_restore: 'financas.caixas_bancos.ie', balance_adjust: 'financas.caixas_bancos.ie', entry_delete: 'financas.caixas_bancos.ex',
    // The extrato of Caixas e bancos: Excluir of a transfer and Alterar categoria of its lines.
    transfer_delete: 'financas.caixas_bancos.ex', line_categorize: 'financas.caixas_bancos.ie',
    transfer_create: 'financas.caixas_bancos.transferencia', internal_transfer: 'financas.caixas_bancos.transferencia',
    // Conciliação Bancária: every action of a line, the transfer created from it included.
    statement_import: 'financas.conciliacao', statement_delete: 'financas.conciliacao', line_reconcile: 'financas.conciliacao', line_unreconcile: 'financas.conciliacao',
    line_hide: 'financas.conciliacao', line_show: 'financas.conciliacao', line_create_entry: 'financas.conciliacao', line_create_transfer: 'financas.conciliacao',
    line_settle_titles: 'financas.conciliacao', line_dismiss: 'financas.conciliacao',
    category_save: 'financas.categorias.ie', category_create: 'financas.categorias.ie', category_move: 'financas.categorias.ie', category_import: 'financas.categorias.ie', category_delete: 'financas.categorias.ex',
    grouped_billing_generate: 'financas.faturamento_agrupado', grouped_billing_delete: 'financas.faturamento_agrupado', commission_payment: 'vendas.comissoes', commission_delete: 'vendas.comissoes',
    session_open: 'vendas.controle_caixa.ie', session_move_delete: 'vendas.controle_caixa.ie', session_delete: 'vendas.controle_caixa.ex',
  };
  for (const [action, value] of Object.entries(expected)) assert.equal(await key(action), value, action);
  for (const [action, after, value] of [['title_create', { entity: 'titles', items: [{ kind: 'payable' }] }, 'financas.contas_pagar.ie'], ['title_edit', record('receivable'), 'financas.contas_receber.ie'],
    ['title_delete', record('payable'), 'financas.contas_pagar.ex'], ['title_cancel', record('receivable'), 'financas.contas_receber.cancelar'], ['settle', record('receivable'), 'financas.contas_receber.baixar'],
    ['settle_batch', { entity: 'borderos', items: [{ title: { kind: 'payable' } }] }, 'financas.contas_pagar.baixar'], ['recurrence_generate', { entity: 'recurrences', record: { kind: 'payable' } }, 'financas.contas_pagar.ie'],
    ['records_import', { entity: 'financial_import', kind: 'receivable' }, 'financas.contas_receber.ie'], ['records_import', { entity: 'financial_import', kind: 'cash' }, 'financas.caixas_bancos.ie'], ['invoice_post', { posting: { direction: 'payable' } }, 'suprimentos.notas_entrada.lancar_contas']])
    assert.equal(await key(action, after), value, action);
  // The v2 remessa (Incluir Remessa, Gerar remessa of Contas a receber and Emitir boletos of the notes) needs the keys of Remessas too.
  for (const [action, value] of [['operational_reserve_v2', 'financas.remessas.ie'], ['operational_finalize_v2', 'financas.remessas.gerar'], ['reserve', 'financas.remessas.ie'], ['return_exclude', 'financas.retornos.ex'],
    ['operational_return', 'financas.retornos.ie'], ['operational_approve_v2', null]]) assert.equal(await scalar('SELECT erp_cnab.permission_key($1) AS value', [action]), value, action);
  // A user with Caixas e Bancos incluir/editar (and not Conciliação) changes the categoria of a line of the extrato, as the screen offers.
  const extrato = await restrict('financeiro', ['financas.caixas_bancos', 'financas.caixas_bancos.ie']);
  const entry = await act('entry_save', { expected_version: 0, account_id: caixa.id, kind: 'in', amount_cents: '700', posted_on: '2026-03-15', competence_on: '2026-03-15', note: 'Entrada sintética 246' }, extrato);
  const category = (await rpc('erp_finance_category_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'category_create', p_data: { kind: 'receivable', name: 'Receita do extrato 246' } })).record;
  const changed = await act('line_categorize', { line_kind: 'entry', line_id: entry.record.id, expected_category_id: entry.record.category_id ?? null, category_id: category.id }, extrato);
  assert.equal(changed.record.category_id, category.id);
  const current = (await call(`/v1/financeiro/lancamentos/${entry.record.id}`, {}, extrato)).record;
  await assert.rejects(() => act('entry_delete', { id: entry.record.id, expected_version: current.version }, extrato), http(403), 'Excluir needs financas.caixas_bancos.ex');
});
