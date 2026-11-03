import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { financeParityDb } from './helpers/finance-parity-db.mjs';
import { parseFinanceRoute, executeFinanceRoute } from '../src/finance.mjs';

// Synthetic data only. Review of 135 to 138: invariants kept by the legacy writers, lock and date rules of the
// conciliação, reconciliation entries after Desvincular, uses of a recurrence and the import prévia.
let env; let db; let users; let scalar; let rpc; let alfa; let banco; let caixa; let receita; let despesa;
const SQL = { 400: ['22023'], 403: ['42501'], 404: ['P0002'], 409: ['40001', '23505', '55000'] };
const http = status => error => error.status === status || (SQL[status] ?? []).includes(error.code);
const call = async (path, init = {}, user = users.financeiro) => executeFinanceRoute(await parseFinanceRoute(new Request(`https://api.example.test${path}`, init.body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {})), { userId: user, rpc: (name, args) => rpc(name, args) });
const act = (action, data, user = users.financeiro, command = randomUUID()) => call(`/v1/financeiro/actions/${action}`, { body: { command_id: command, data } }, user);
const legacy = (action, data) => rpc('erp_finance_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: action, p_data: data });
const ofx = rows => `OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102\r\n\r\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
${rows.map(row => `<STMTTRN>\r\n<TRNTYPE>${row.amount.startsWith('-') ? 'DEBIT' : 'CREDIT'}\r\n<DTPOSTED>${row.date.replaceAll('-', '')}\r\n<TRNAMT>${row.amount}\r\n<FITID>${row.fitid}\r\n<MEMO>${row.memo}\r\n</STMTTRN>`).join('\r\n')}
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
const line = async (account, fitid) => (await call(`/v1/financeiro/conciliacao?account=${account}&state=pending`, {}, users.consulta)).items.find(item => item.fitid === fitid);
const account = data => rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: data });
// Moves the Data de início before the saldo inicial (allowed: it is not after the first movement).
const earlierStart = async (record, start_on) => rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_update', p_data: {
  id: record.id, expected_version: record.version, account_type: record.account_type, institution_code: record.institution_code, institution_name: record.institution_name, name: record.name,
  agency: record.agency, account_number: record.account_number, account_digit: record.account_digit, start_on } });

before(async () => {
  env = await financeParityDb({});
  ({ db, users, scalar, rpc } = env); await env.addUsers();
  alfa = await env.contact({ name: 'Alfa Sintética' });
  banco = (await account({ account_type: 'checking', institution_code: '341', institution_name: 'Itaú Unibanco', name: 'Banco sintético', agency: '1', account_number: '2', account_digit: '3', start_on: '2026-02-01', opening_cents: '100000' })).record;
  caixa = (await account({ account_type: 'cash', name: 'Caixa sintético', start_on: '2026-02-01', opening_cents: '0' })).record;
  receita = (await rpc('erp_finance_category_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'category_create', p_data: { kind: 'receivable', name: 'Receitas diversas' } })).record;
  despesa = (await rpc('erp_finance_category_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'category_create', p_data: { kind: 'payable', name: 'Despesas diversas' } })).record;
});
after(async () => db?.close());

test('135 the 010 writer cannot move a category in use to the other tab; the import refuses an inactive parent; long legacy names are read', async () => {
  // A lançamento de caixa uses the receita: its tipo stays.
  await act('entry_save', { expected_version: 0, account_id: caixa.id, kind: 'in', amount_cents: '500', posted_on: '2026-03-01', competence_on: '2026-03-01', category_id: receita.id, note: 'Venda balcão' });
  const current = (await rpc('erp_finance_category_tree', { p_user_id: users.consulta, p_kind: 'receivable' })).items.find(item => item.id === receita.id);
  await assert.rejects(() => legacy('category_save', { id: receita.id, expected_version: current.version, name: current.name, kind: 'payable' }), http(409));
  // A default of the other tipo also keeps its tipo.
  const free = (await legacy('category_save', { expected_version: 0, name: 'Taxas sintéticas', kind: 'payable' })).record;
  const defaults = (await rpc('erp_finance_category_tree', { p_user_id: users.consulta, p_kind: 'payable' })).defaults;
  await rpc('erp_finance_category_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'category_set_default', p_data: { key: 'receipt_fees', category_id: free.id, expected_version: defaults.receipt_fees.version } });
  await assert.rejects(() => legacy('category_save', { id: free.id, expected_version: free.version, name: free.name, kind: 'receivable' }), http(409));
  // Importar: a subcategoria under an inactive parent is refused, as in Nova categoria.
  const parent = (await rpc('erp_finance_category_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'category_create', p_data: { kind: 'payable', name: 'Inativa sintética' } })).record;
  await rpc('erp_finance_category_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'category_set_active', p_data: { id: parent.id, expected_version: parent.version, active: false } });
  await assert.rejects(() => act('category_import', { kind: 'payable', rows: [{ name: 'Filha', parent: 'Inativa sintética' }] }), http(409));
  // Names written by the 010 writer may have up to 200 characters: the tree and the extrato still read them.
  const long = (await legacy('category_save', { expected_version: 0, name: `Categoria antiga ${'x'.repeat(150)}`, kind: 'payable' })).record;
  await act('entry_save', { expected_version: 0, account_id: caixa.id, kind: 'out', amount_cents: '100', posted_on: '2026-03-02', competence_on: '2026-03-02', category_id: long.id, note: 'Com nome longo' });
  const tree = await call('/v1/financeiro/categorias-arvore?kind=payable', {}, users.consulta);
  assert.equal(tree.items.find(item => item.id === long.id).name.length, 167);
  const statement = await call(`/v1/financeiro/extrato?account=${caixa.id}&from=2026-03-01&to=2026-03-31`, {}, users.consulta);
  assert.equal(statement.items.find(item => item.category_id === long.id).category_name, long.name);
});

test('136 Alterar categorias refuses the tarifa of a retorno: its category belongs to the immutable plan', async () => {
  const title = (await rpc('erp_finance_title_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'title_create', p_data: { kind: 'receivable', contact_id: alfa.id, description: 'Boleto sintético', issued_on: '2026-03-01', competence_on: '2026-03-01', total_cents: '10000', installments: [{ amount_cents: '10000', due_on: '2026-03-10' }] } })).items[0];
  const settled = await legacy('settle', { id: title.id, expected_version: 1, account_id: banco.id, posted_on: '2026-03-10', principal_cents: '10000' });
  // A bank_fee leg is only written by the Itaú net credit (058); here it exists inside a transaction that is rolled back.
  await db.exec('BEGIN');
  try {
    const fee = (await db.query(`INSERT INTO erp_finance.movement(account_id,settlement_id,kind,delta_cents,posted_on,note,actor,command_id) VALUES($1,$2,'bank_fee',-150,'2026-03-10',NULL,$3,$4) RETURNING id`, [banco.id, settled.settlement.id, users.financeiro, randomUUID()])).rows[0].id;
    await assert.rejects(() => db.query(`SELECT public.erp_finance_cash_execute($1,$2,'line_categorize',$3::jsonb)`, [users.financeiro, randomUUID(), JSON.stringify({ line_kind: 'settlement', line_id: fee, expected_category_id: null, category_id: receita.id })]), error => error.code === '22023');
  } finally { await db.exec('ROLLBACK'); }
  // The baixa itself is still reclassified.
  const movement = await scalar("SELECT id::text AS value FROM erp_finance.movement WHERE settlement_id=$1 AND kind='payment'", [settled.settlement.id]);
  const changed = await act('line_categorize', { line_kind: 'settlement', line_id: movement, expected_category_id: null, category_id: receita.id });
  assert.equal(changed.record.category_id, receita.id);
});

test('137 a Registro de Caixa created by the conciliação is a lançamento like the others once unlinked', async () => {
  await act('statement_import', { account_id: banco.id, file_name: 'abril.ofx', content: ofx([{ date: '2026-04-02', amount: '-30.00', fitid: 'R1', memo: 'TARIFA AVULSA' }, { date: '2026-04-03', amount: '-40.00', fitid: 'R2', memo: 'TARIFA DOC' }]) });
  const first = await line(banco.id, 'R1');
  const created = await act('line_create_entry', { line_id: first.id, expected_version: first.version, category_id: despesa.id });
  const entryId = created.record.links[0].id;
  const entry = async () => (await call(`/v1/financeiro/lancamentos/${entryId}`, {}, users.consulta)).record;
  // While reconciled: the note and the category may change; the value and the exclusion wait for Desvincular.
  const linked = await entry();
  const renamed = await act('entry_save', { id: entryId, expected_version: linked.version, account_id: banco.id, kind: 'out', amount_cents: '3000', posted_on: '2026-04-02', competence_on: '2026-04-02', category_id: despesa.id, note: 'Tarifa avulsa conferida' });
  assert.equal(renamed.record.note, 'Tarifa avulsa conferida');
  await assert.rejects(() => act('entry_save', { id: entryId, expected_version: renamed.record.version, account_id: banco.id, kind: 'out', amount_cents: '3100', posted_on: '2026-04-02', competence_on: '2026-04-02', note: 'Outro valor' }), http(409));
  await assert.rejects(() => act('entry_delete', { id: entryId, expected_version: renamed.record.version }), http(409));
  // After Desvincular without estorno: Ajustar valor and Excluir work.
  const reconciled = (await call(`/v1/financeiro/conciliacao?account=${banco.id}&state=reconciled`, {}, users.consulta)).items.find(item => item.fitid === 'R1');
  await act('line_unreconcile', { line_id: reconciled.id, expected_version: reconciled.version });
  const adjusted = await act('entry_save', { id: entryId, expected_version: renamed.record.version, account_id: banco.id, kind: 'out', amount_cents: '4000', posted_on: '2026-04-02', competence_on: '2026-04-02', category_id: despesa.id, note: 'Tarifa avulsa conferida' });
  assert.equal(adjusted.record.amount_cents, '4000');
  const removed = await act('entry_delete', { id: entryId, expected_version: adjusted.record.version });
  assert.equal(removed.record.deleted, true);
});

test('137 baixa and transferência from the extrato follow the saldo inicial and the date rules of every baixa', async () => {
  // Accounts whose Data de início was moved before the saldo inicial: the saldo inicial still comes first.
  const early = (await account({ account_type: 'checking', institution_code: '001', institution_name: 'Banco do Brasil', name: 'Banco anterior', agency: '9', account_number: '8', account_digit: '7', start_on: '2026-05-10', opening_cents: '5000' })).record;
  const moved = (await earlierStart(early, '2026-05-01')).record;
  const other = (await account({ account_type: 'cash', name: 'Caixa anterior', start_on: '2026-05-10', opening_cents: '0' })).record;
  await earlierStart(other, '2026-05-01');
  await act('statement_import', { account_id: moved.id, file_name: 'maio.ofx', content: ofx([{ date: '2026-05-05', amount: '20.00', fitid: 'M1', memo: 'PIX ANTES' }, { date: '2026-05-06', amount: '-20.00', fitid: 'M2', memo: 'TED ANTES' }, { date: '2099-01-10', amount: '20.00', fitid: 'M3', memo: 'PIX FUTURO' }]) });
  const title = (await rpc('erp_finance_title_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'title_create', p_data: { kind: 'receivable', contact_id: alfa.id, description: 'Venda anterior', issued_on: '2026-05-01', competence_on: '2026-05-01', total_cents: '2000', installments: [{ amount_cents: '2000', due_on: '2026-05-05' }] } })).items[0];
  const before = await line(moved.id, 'M1'), future = await line(moved.id, 'M3'), ted = await line(moved.id, 'M2');
  await assert.rejects(() => act('line_settle_titles', { line_id: before.id, expected_version: before.version, items: [{ id: title.id, expected_version: 1, principal_cents: '2000' }] }), http(400), 'before the saldo inicial');
  await assert.rejects(() => act('line_settle_titles', { line_id: future.id, expected_version: future.version, items: [{ id: title.id, expected_version: 1, principal_cents: '2000' }] }), http(400), 'a baixa in the future');
  await assert.rejects(() => act('line_create_transfer', { line_id: ted.id, expected_version: ted.version, other_account_id: other.id }), http(400), 'before the saldo inicial');
  assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_finance.movement WHERE account_id=$1 AND posted_on<$2', [moved.id, '2026-05-10']), 0);
  assert.equal(await scalar('SELECT settled_cents::text AS value FROM erp_finance.title WHERE id=$1', [title.id]), '0');
});

test('138 a recurrence is a use of its categoria and conta financeira; the import prévia shows the repeated lines', async () => {
  const category = (await rpc('erp_finance_category_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'category_create', p_data: { kind: 'receivable', name: 'Assinaturas sintéticas' } })).record;
  // An account of the 010 writer has no saldo inicial, so nothing else uses it.
  const target = (await legacy('account_save', { expected_version: 0, name: 'Conta da recorrência', kind: 'other' })).record;
  const created = await act('recurrence_create', { kind: 'receivable', contact_id: alfa.id, description: 'Assinatura sintética', issued_on: '2026-06-01', competence_on: '2026-06-01', due_on: '2026-06-10', amount_cents: '900', frequency: 'monthly', due_day: 10 });
  // "Alterar lançamentos de contas futuras" only: the next contas will take the categoria and the conta; no conta has them yet.
  await act('recurrence_update', { id: created.record.id, expected_version: created.record.version, from_title_id: created.title.id, scope: 'none', future: true, changes: { category_id: category.id, account_id: target.id } });
  const node = (await rpc('erp_finance_category_tree', { p_user_id: users.consulta, p_kind: 'receivable' })).items.find(item => item.id === category.id);
  assert.equal(node.in_use, true);
  await assert.rejects(() => act('category_delete', { id: category.id, expected_version: node.version }), http(409));
  const detail = (await rpc('erp_finance_account_detail', { p_user_id: users.consulta, p_id: target.id })).record;
  assert.equal(detail.in_use, true);
  await assert.rejects(() => act('account_delete', { id: target.id, expected_version: detail.version }), http(409));
  // Prévia: the second equal line of the file is already "imported" (the import keeps one).
  const row = line => ({ line, issued_on: '2026-06-02', amount_cents: '1500', side: 'out', description: 'Café do escritório', account: 'Caixa sintético' });
  const preview = await act('records_import_preview', { kind: 'cash', file_name: 'caixa.csv', rows: [row(2), row(3), { ...row(4), description: 'Água' }] });
  assert.deepEqual(preview.rows.map(item => item.status), ['new', 'duplicate', 'new']);
  const imported = await act('records_import', { kind: 'cash', file_name: 'caixa.csv', rows: [row(2), { ...row(4), description: 'Água' }] });
  assert.deepEqual([imported.created, imported.skipped], [2, 0]);
  assert.deepEqual((await act('records_import_preview', { kind: 'cash', file_name: 'caixa.csv', rows: [row(2)] })).rows.map(item => item.status), ['duplicate']);
});
