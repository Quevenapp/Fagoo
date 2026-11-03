import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { financeParityDb } from './helpers/finance-parity-db.mjs';
import { parseFinanceRoute, executeFinanceRoute } from '../src/finance.mjs';
import { parseOfx, ofxCents } from '../src/finance-ofx.mjs';

// Synthetic data only. 137: Conciliação bancária (OFX) — import, queue, conciliar, desvincular, novo a partir do extrato.
let env; let db; let users; let scalar; let rpc; let banco; let outra; let alfa;
const code = expected => error => error.code === expected;
// Worker-side refusals carry an HTTP status; SQL refusals reach the test as Postgres codes (index.mjs maps them to HTTP).
const SQL = { 400: ['22023'], 403: ['42501'], 404: ['P0002'], 409: ['40001', '23505', '55000'] };
const http = status => error => error.status === status || (SQL[status] ?? []).includes(error.code);
const ofx = (rows, extra = '') => `OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102\r\nCHARSET:1252\r\n\r\n<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</STATUS></SONRS></SIGNONMSGSRSV1><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL<BANKACCTFROM><BANKID>0341<ACCTID>12345</BANKACCTFROM><BANKTRANLIST><DTSTART>20260301000000[-3:BRT]<DTEND>20260331000000[-3:BRT]
${rows.map(row => `<STMTTRN>\r\n<TRNTYPE>${row.type ?? (row.amount.startsWith('-') ? 'DEBIT' : 'CREDIT')}\r\n<DTPOSTED>${row.date.replaceAll('-', '')}120000[-3:BRT]\r\n<TRNAMT>${row.amount}\r\n${row.fitid ? `<FITID>${row.fitid}\r\n` : ''}<MEMO>${row.memo}\r\n</STMTTRN>`).join('\r\n')}
</BANKTRANLIST>${extra}</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
const call = async (path, init = {}, user = users.financeiro) => executeFinanceRoute(await parseFinanceRoute(new Request(`https://api.example.test${path}`, init.body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {})), { userId: user, rpc: (name, args) => rpc(name, args) });
const act = (action, data, user = users.financeiro, command = randomUUID()) => call(`/v1/financeiro/actions/${action}`, { body: { command_id: command, data } }, user);
const queue = (state = 'pending', user = users.consulta) => call(`/v1/financeiro/conciliacao?account=${banco.id}&state=${state}`, {}, user);
const balance = async account => scalar('SELECT coalesce(sum(delta_cents),0)::text AS value FROM erp_finance.movement WHERE account_id=$1', [account]);

before(async () => {
  env = await financeParityDb({});
  ({ db, users, scalar, rpc } = env); await env.addUsers();
  alfa = await env.contact({ name: 'Alfa Sintética' });
  const account = data => rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: data });
  banco = (await account({ account_type: 'checking', institution_code: '341', institution_name: 'Itaú Unibanco', name: 'Itaú sintético', agency: '1', account_number: '2', account_digit: '3', start_on: '2026-02-01', opening_cents: '100000' })).record;
  outra = (await account({ account_type: 'cash', name: 'Caixa sintético', start_on: '2026-02-01', opening_cents: '0' })).record;
});
after(async () => db?.close());

test('137 OFX reader: SGML and XML, exact cents, FITID duplicates refused, missing FITID numbered deterministically', () => {
  const parsed = parseOfx(ofx([{ date: '2026-03-05', amount: '-150.00', fitid: 'A1', memo: 'TARIFA &amp; IOF' }, { date: '2026-03-06', amount: '1234,5', fitid: 'A2', memo: 'PIX RECEBIDO' }, { date: '2026-03-07', amount: '0.00', fitid: 'A3', memo: 'zero' }]));
  assert.deepEqual([parsed.period_from, parsed.period_to, parsed.bank, parsed.account], ['2026-03-01', '2026-03-31', '0341', '12345']);
  assert.deepEqual(parsed.lines.map(line => [line.fitid, line.posted_on, line.amount_cents, line.memo, line.trntype]), [['A1', '2026-03-05', '-15000', 'TARIFA & IOF', 'DEBIT'], ['A2', '2026-03-06', '123450', 'PIX RECEBIDO', 'CREDIT']]);
  const xml = '<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="211"?><OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST><DTSTART>20260301</DTSTART><DTEND>20260302</DTEND><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260302</DTPOSTED><TRNAMT>-10.5</TRNAMT><FITID>X9</FITID><NAME>Padaria</NAME></STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>';
  assert.deepEqual(parseOfx(xml).lines, [{ fitid: 'X9', posted_on: '2026-03-02', amount_cents: '-1050', memo: 'Padaria', trntype: 'DEBIT' }]);
  const twice = parseOfx(ofx([{ date: '2026-03-05', amount: '-1.00', memo: 'Cafe' }, { date: '2026-03-05', amount: '-1.00', memo: 'Cafe' }]));
  assert.deepEqual(twice.lines.map(line => line.fitid), ['sem-fitid:2026-03-05|-100|Cafe|1', 'sem-fitid:2026-03-05|-100|Cafe|2']);
  assert.throws(() => parseOfx(ofx([{ date: '2026-03-05', amount: '-1.00', fitid: 'D', memo: 'a' }, { date: '2026-03-06', amount: '-2.00', fitid: 'D', memo: 'b' }])), /repetido/);
  assert.throws(() => parseOfx(ofx([{ date: '2026-02-30', amount: '1.00', fitid: 'Z', memo: 'x' }])), /Data inválida/);
  assert.throws(() => parseOfx('nada'), /não é um extrato/);
  assert.equal(ofxCents('-0.10'), '-10'); assert.equal(ofxCents('+5'), '500'); assert.equal(ofxCents('1.230'), '123'); assert.throws(() => ofxCents('1.234'), /duas casas/); assert.throws(() => ofxCents('1e3'), /inválido/);
});

test('137 RPCs are service-only security definer functions; tables are closed; consulta reads the queue and cannot write', async () => {
  const names = ['erp_finance_reconciliation_page', 'erp_finance_reconciliation_candidates', 'erp_finance_reconciliation_execute', 'erp_finance_statement_page'];
  const fns = (await db.query("SELECT p.proname,p.prosecdef,p.proconfig,p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname = ANY($1)", [names])).rows;
  assert.equal(fns.length, 4, 'the 136 statement page was replaced, not overloaded');
  for (const fn of fns) {
    assert.deepEqual([fn.prosecdef, fn.proconfig], [true, ['search_path=pg_catalog']]);
    for (const role of ['anon', 'authenticated']) assert.equal(await scalar("SELECT has_function_privilege($2,$1,'EXECUTE') AS value", [fn.signature, role]), false);
    assert.equal(await scalar("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS value", [fn.signature]), true);
  }
  for (const table of ['erp_finance.bank_statement', 'erp_finance.bank_statement_line', 'erp_finance.reconciliation_link']) for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar("SELECT has_table_privilege($1,$2,'SELECT') AS value", [role, table]), false);
  await assert.rejects(() => act('statement_import', { account_id: banco.id, file_name: 'extrato.ofx', content: ofx([{ date: '2026-03-05', amount: '1.00', fitid: 'R', memo: 'x' }]) }, users.consulta), http(403));
  for (const role of ['vendas', 'inactive']) await assert.rejects(() => queue('pending', users[role]), http(403));
});

test('137 importar extrato: lines by FITID, the same file refused, an overlapping file adds only new lines; Excluir extrato frees them', async () => {
  const file = ofx([{ date: '2026-03-05', amount: '-150.00', fitid: 'F1', memo: 'TARIFA PACOTE' }, { date: '2026-03-10', amount: '300.00', fitid: 'F2', memo: 'PIX ALFA' }, { date: '2026-03-12', amount: '-50.00', fitid: 'F3', memo: 'TED CAIXA' }]);
  const imported = await act('statement_import', { account_id: banco.id, file_name: 'marco.ofx', content: file });
  assert.deepEqual([imported.record.bank_lines, imported.record.new_lines, imported.record.period_from, imported.record.period_to], [3, 3, '2026-03-01', '2026-03-31']);
  await assert.rejects(() => act('statement_import', { account_id: banco.id, file_name: 'marco-de-novo.ofx', content: file }), http(409));
  const overlap = await act('statement_import', { account_id: banco.id, file_name: 'marco2.ofx', content: ofx([{ date: '2026-03-10', amount: '300.00', fitid: 'F2', memo: 'PIX ALFA' }, { date: '2026-03-20', amount: '-80.00', fitid: 'F4', memo: 'BOLETO FORNECEDOR' }]) });
  assert.deepEqual([overlap.record.bank_lines, overlap.record.new_lines], [2, 1]);
  const pending = await queue();
  assert.deepEqual(pending.items.map(line => [line.fitid, line.amount_cents, line.memo]), [['F1', '-15000', 'TARIFA PACOTE'], ['F2', '30000', 'PIX ALFA'], ['F3', '-5000', 'TED CAIXA'], ['F4', '-8000', 'BOLETO FORNECEDOR']]);
  assert.deepEqual(pending.statements.map(item => [item.file_name, item.lines, item.reconciled]), [['marco2.ofx', 1, 0], ['marco.ofx', 3, 0]]);
  await assert.rejects(() => act('statement_import', { account_id: banco.id, file_name: 'x.txt', content: file }), http(400));
  await assert.rejects(() => act('statement_import', { account_id: banco.id, file_name: 'x.ofx', content: 'sem ofx' }), http(422));
  const removed = await act('statement_delete', { id: overlap.record.id });
  assert.equal(removed.record.deleted, true); assert.equal((await queue()).total, 3);
  const again = await act('statement_import', { account_id: banco.id, file_name: 'marco2.ofx', content: ofx([{ date: '2026-03-20', amount: '-80.00', fitid: 'F4', memo: 'BOLETO FORNECEDOR' }]) });
  assert.equal(again.record.new_lines, 1, 'the FITID of an excluded extrato is free again');
});

test('137 conciliar: suggestion by value and date, the sum must match, the extrato shows it; a reconciled lançamento is locked', async () => {
  const entry = await act('entry_save', { expected_version: 0, account_id: banco.id, kind: 'out', amount_cents: '15000', posted_on: '2026-03-04', competence_on: '2026-03-04', note: 'Tarifa do pacote' });
  const pending = await queue(), tarifa = pending.items.find(line => line.fitid === 'F1');
  assert.deepEqual([tarifa.suggestion.kind, tarifa.suggestion.id, tarifa.suggestion.amount_cents], ['entry', entry.record.id, '-15000']);
  const pix = pending.items.find(line => line.fitid === 'F2');
  await assert.rejects(() => act('line_reconcile', { line_id: pix.id, expected_version: pix.version, links: [{ kind: 'entry', id: entry.record.id }] }), http(400), 'the values must match');
  const reconciled = await act('line_reconcile', { line_id: tarifa.id, expected_version: tarifa.version, links: [{ kind: 'entry', id: entry.record.id }] });
  assert.equal(reconciled.record.state, 'reconciled'); assert.equal(reconciled.record.links[0].id, entry.record.id);
  await assert.rejects(() => act('line_reconcile', { line_id: tarifa.id, expected_version: tarifa.version, links: [{ kind: 'entry', id: entry.record.id }] }), http(409));
  const statement = await call(`/v1/financeiro/extrato?account=${banco.id}&from=2026-03-01&to=2026-03-31&reconciliation=reconciled`, {}, users.consulta);
  assert.deepEqual(statement.items.map(line => [line.entry_id, line.reconciled]), [[entry.record.id, true]]);
  assert.equal(statement.summary.reconciled_lines, 1);
  await assert.rejects(() => act('entry_save', { id: entry.record.id, expected_version: entry.record.version, account_id: banco.id, kind: 'out', amount_cents: '16000', posted_on: '2026-03-04', competence_on: '2026-03-04', note: 'Tarifa' }), http(409));
  await assert.rejects(() => act('entry_delete', { id: entry.record.id, expected_version: entry.record.version }), http(409));
  // Desvincular (sem estorno): the line goes back to Pendentes and the lançamento may change again.
  const undone = await act('line_unreconcile', { line_id: tarifa.id, expected_version: reconciled.record.version });
  assert.deepEqual([undone.record.state, undone.record.links.length], ['pending', 0]);
  await act('entry_save', { id: entry.record.id, expected_version: entry.record.version, account_id: banco.id, kind: 'out', amount_cents: '15000', posted_on: '2026-03-04', competence_on: '2026-03-04', note: 'Tarifa do pacote de serviços' });
});

test('137 novo a partir do extrato: Registro de Caixa, Transferência and baixa of contas, each reconciled in one command', async () => {
  const pending = await queue(), pix = pending.items.find(line => line.fitid === 'F2'), ted = pending.items.find(line => line.fitid === 'F3'), boleto = pending.items.find(line => line.fitid === 'F4');
  // Recebimento of an open conta a receber of Alfa.
  const title = (await rpc('erp_finance_title_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'title_create', p_data: { kind: 'receivable', contact_id: alfa.id, description: 'Venda sintética', issued_on: '2026-03-01', competence_on: '2026-03-01', total_cents: '30000', installments: [{ amount_cents: '30000', due_on: '2026-03-10' }] } })).items[0];
  const candidates = await call(`/v1/financeiro/conciliacao/candidatos?account=${banco.id}&from=2026-03-01&to=2026-03-31&amount_cents=30000`, {}, users.consulta);
  assert.deepEqual(candidates.titles.map(item => item.id), [title.id]);
  await assert.rejects(() => act('line_settle_titles', { line_id: pix.id, expected_version: pix.version, items: [{ id: title.id, expected_version: 1, principal_cents: '20000' }] }), http(400), 'divergence');
  const settled = await act('line_settle_titles', { line_id: pix.id, expected_version: pix.version, items: [{ id: title.id, expected_version: 1, principal_cents: '30000' }] });
  assert.deepEqual([settled.record.state, settled.record.links[0].line_kind], ['reconciled', 'settlement']);
  assert.equal(await scalar('SELECT settled_cents::text AS value FROM erp_finance.title WHERE id=$1', [title.id]), '30000');
  // The baixa reconciled cannot be reversed before Desvincular.
  const settlement = await scalar('SELECT id::text AS value FROM erp_finance.settlement WHERE title_id=$1', [title.id]);
  await assert.rejects(() => rpc('erp_finance_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'reverse', p_data: { id: title.id, expected_version: 2, settlement_id: settlement, posted_on: '2026-03-11', note: 'Estorno' } }), code('40001'));
  // Transferência: the TED out of the bank went to the caixa.
  const transfer = await act('line_create_transfer', { line_id: ted.id, expected_version: ted.version, other_account_id: outra.id });
  assert.equal(transfer.record.links[0].line_kind, 'transfer'); assert.equal(await balance(outra.id), '5000');
  // Registro de Caixa: the boleto paid, with "<memo> - Criado via conciliação".
  const before = await balance(banco.id);
  const created = await act('line_create_entry', { line_id: boleto.id, expected_version: boleto.version, category_id: null, contact_id: alfa.id });
  assert.equal(created.record.links[0].note, 'BOLETO FORNECEDOR - Criado via conciliação');
  assert.equal(BigInt(await balance(banco.id)) - BigInt(before), -8000n);
  // Reverter conciliação com estorno excludes the lançamento created by the conciliação; with a baixa (172) it estorna the baixa too.
  const reverted = await act('line_unreconcile', { line_id: boleto.id, expected_version: created.record.version, reverse: true });
  assert.equal(reverted.record.state, 'pending'); assert.equal(await balance(banco.id), before);
  const unsettled = await act('line_unreconcile', { line_id: pix.id, expected_version: settled.record.version, reverse: true });
  assert.equal(unsettled.record.state, 'pending'); assert.equal(await scalar('SELECT settled_cents::text AS value FROM erp_finance.title WHERE id=$1', [title.id]), '0');
  assert.equal(BigInt(await balance(banco.id)) - BigInt(before), -30000n, 'the estorno takes the baixa out of the account');
  // Ocultar / Exibir.
  const hidden = await act('line_hide', { line_id: boleto.id, expected_version: reverted.record.version });
  assert.equal(hidden.record.state, 'hidden'); assert.deepEqual((await queue('hidden')).items.map(line => line.id), [boleto.id]);
  await act('line_show', { line_id: boleto.id, expected_version: hidden.record.version });
  await assert.rejects(() => act('statement_delete', { id: pix.statement_id }), http(409), 'an extrato with reconciled lines stays');
});

test('137 Worker contract: strict queries and bodies; a tampered queue is refused', async () => {
  for (const path of [`/v1/financeiro/conciliacao`, `/v1/financeiro/conciliacao?account=${banco.id}&state=x`, `/v1/financeiro/conciliacao?account=${banco.id}&x=1`, `/v1/financeiro/conciliacao/candidatos?account=${banco.id}&from=2026-03-01`,
    `/v1/financeiro/extrato?account=${banco.id}&from=2026-03-01&to=2026-03-31&reconciliation=x`, `/v1/financeiro/extrato?account=${banco.id}&from=2026-03-01&to=2026-03-31&deleted=true&reconciliation=reconciled`]) {
    await assert.rejects(() => parseFinanceRoute(new Request(`https://api.example.test${path}`)), http(400), path);
  }
  for (const [action, data] of [['line_reconcile', { line_id: randomUUID(), expected_version: 1, links: [] }], ['line_reconcile', { line_id: randomUUID(), expected_version: 1, links: [{ kind: 'title', id: randomUUID() }] }],
    ['line_settle_titles', { line_id: randomUUID(), expected_version: 1, items: [{ id: randomUUID(), expected_version: 1, principal_cents: '0' }] }], ['line_unreconcile', { line_id: randomUUID(), expected_version: 1, reverse: 'sim' }]]) {
    await assert.rejects(() => parseFinanceRoute(new Request(`https://api.example.test/v1/financeiro/actions/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command_id: randomUUID(), data }) })), http(400), action);
  }
  const route = await parseFinanceRoute(new Request(`https://api.example.test/v1/financeiro/conciliacao?account=${banco.id}&state=reconciled`));
  const real = await rpc(route.rpc, { p_user_id: users.consulta, ...route.args });
  const tampered = structuredClone(real); tampered.items[0].links = [];
  await assert.rejects(() => executeFinanceRoute(route, { userId: users.consulta, rpc: async () => tampered }), http(502));
  const wrong = structuredClone(real); wrong.items[0].amount_cents = '1';
  await assert.rejects(() => executeFinanceRoute(route, { userId: users.consulta, rpc: async () => wrong }), http(502));
});
