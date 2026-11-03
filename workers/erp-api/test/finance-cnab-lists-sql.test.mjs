import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { financeParityDb } from './helpers/finance-parity-db.mjs';
import { parseFinanceRoute, executeFinanceRoute } from '../src/finance.mjs';

// Synthetic data only. 213: Remessas e Retornos (CNAB) no padrão Origin — listagens, detalhes e exclusões, with bank operations off.
let env; let db; let users; let scalar; let rpc; let profile; let alfa; let titles = []; const remittances = {}; let returned; let applied;
const SQL = { 400: ['22023'], 403: ['42501'], 404: ['P0002'], 409: ['40001', '23505', '55000'] };
const http = status => error => error.status === status || (SQL[status] ?? []).includes(error.code);
const sha = text => createHash('sha256').update(text).digest('hex');
const call = async (path, init = {}, user = users.financeiro) => executeFinanceRoute(await parseFinanceRoute(new Request(`https://api.example.test${path}`, init.body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {})), { userId: user, rpc: (name, args) => rpc(name, args) });
const act = (action, data, user = users.financeiro, command = randomUUID()) => call(`/v1/financeiro/actions/${action}`, { body: { command_id: command, data } }, user);
async function remittance(sequence, state, generatedOn, items) {
  const ready = state === 'ready', hash = ready ? sha(`rem-${sequence}`) : null;
  const id = (await db.query(`INSERT INTO erp_cnab.remittance(profile_id,sequence,generated_on,state,snapshot,object_path,file_hash,byte_size,actor,purpose) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,'operational') RETURNING id`,
    [profile, sequence, generatedOn, state, JSON.stringify({ profile: { bank: '341', wallet: '109' }, titles: [], encoding_profile: 'itau109-no-charges-v1' }), ready ? `profiles/${profile}/remittances/${hash}.rem` : null, hash, ready ? 1200 : null, users.admin])).rows[0].id;
  for (const [index, item] of items.entries()) {
    const doc = `${sequence}${index}`;
    await db.query(`INSERT INTO erp_cnab.billing_title(title_id,profile_id,remittance_id,control,document_number,our_number_base,our_number,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [item.id, profile, id, `C${doc}`, doc, `${sequence}000${index}`, ready ? `${sequence}000${index}1` : null, JSON.stringify({ title: { amountCents: item.amount_cents, issuedOn: item.issued_on, dueOn: item.due_on, payer: { name: 'Alfa Pagadora' }, documentNumber: doc } })]);
  }
  return id;
}

before(async () => {
  env = await financeParityDb({});
  ({ db, users, scalar, rpc } = env); await env.addUsers();
  alfa = await env.contact({ name: 'Alfa Sintética' });
  const account = (await rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: { account_type: 'checking', institution_code: '341', institution_name: 'Itaú Unibanco', name: 'Itaú cobrança sintética', agency: '1', account_number: '2', account_digit: '3', start_on: '2020-01-01', opening_cents: '0' } })).record;
  profile = (await db.query(`INSERT INTO erp_cnab.profile(account_id,identity,settings,account_scope,next_sequence) VALUES($1,$2::jsonb,'{}'::jsonb,'synthetic-scope',4) RETURNING id`,
    [account.id, JSON.stringify({ bank: '341', layout: 'cnab400', agency: '1500', account: '12345', accountDigit: '6', wallet: '109', cnpj: '00000000000191' })])).rows[0].id;
  for (const [n, cents, due] of [[1, '10000', '2026-03-10'], [2, '25000', '2026-03-15'], [3, '5000', '2026-04-10'], [4, '7000', '2026-04-11']])
    titles.push((await rpc('erp_finance_title_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'title_create', p_data: { kind: 'receivable', contact_id: alfa.id, description: `Boleto sintético ${n}`, issued_on: '2026-03-01', competence_on: '2026-03-01', total_cents: cents, installments: [{ amount_cents: cents, due_on: due }] } })).items[0]);
  remittances.first = await remittance(1, 'ready', '2026-03-02', [titles[0], titles[1]]);
  remittances.second = await remittance(2, 'ready', '2026-03-20', []);
  remittances.reserved = await remittance(3, 'reserved', '2026-04-01', [titles[2], titles[3]]);
  // One operational retorno with an entrada, a liquidação and a baixa; another whose liquidação is already applied (vínculo).
  const file = async (hash, generatedOn, events) => {
    const id = (await db.query(`INSERT INTO erp_cnab.return_file(profile_id,file_hash,object_path,byte_size,generated_on,century,record_count,warnings,evidence,actor,purpose) VALUES($1,$2,$3,800,$4,2000,$5,'[]','{}',$6,'operational') RETURNING id`,
      [profile, hash, `profiles/${profile}/returns/${hash}.ret`, generatedOn, events.length + 2, users.admin])).rows[0].id;
    for (const [index, event] of events.entries()) {
      const eventId = (await db.query(`INSERT INTO erp_cnab.return_event(profile_id,event_hash,payload,billing_title_id,proposed_action,reason,purpose) VALUES($1,$2,$3::jsonb,(SELECT id FROM erp_cnab.billing_title WHERE title_id=$4),'review','synthetic','operational') RETURNING id`,
        [profile, sha(`${hash}-${index}`), JSON.stringify(event.payload), event.title ?? null])).rows[0].id;
      await db.query('INSERT INTO erp_cnab.return_occurrence(file_id,line,event_id,line_hash,duplicate) VALUES($1,$2,$3,$4,false)', [id, index + 2, eventId, sha(`${hash}-line-${index}`)]);
      event.id = eventId;
    }
    return id;
  };
  const payload = (kind, occurrence, extra) => ({ kind, occurrence, documentNumber: extra.doc, ourNumber: extra.our, occurrenceDate: extra.on, creditDate: extra.credit ?? null, dueDate: extra.due, amountCents: extra.amount, paidCents: extra.paid ?? '0',
    adjustments: { fee: extra.fee ?? '0', iof: '0', abatement: '0', discount: extra.discount ?? '0', interest: extra.interest ?? '0', otherCredits: '0' } });
  const events = [{ payload: payload('REGISTERED', '02', { doc: '10', our: '100001', on: '2026-03-03', due: '2026-03-10', amount: '10000' }), title: titles[0].id },
    { payload: payload('PAID', '06', { doc: '11', our: '100011', on: '2026-03-15', credit: '2026-03-16', due: '2026-03-15', amount: '25000', paid: '25150', interest: '250', fee: '100' }), title: titles[1].id },
    { payload: payload('CANCELLED', '09', { doc: '10', our: '100001', on: '2026-03-18', due: '2026-03-10', amount: '10000' }), title: titles[0].id }];
  returned = await file(sha('ret-1'), '2026-03-18', events);
  const second = [{ payload: payload('PAID', '06', { doc: '11', our: '100011', on: '2026-03-21', due: '2026-03-15', amount: '25000', paid: '25000' }), title: titles[1].id }];
  applied = await file(sha('ret-2'), '2026-03-21', second);
  await db.query(`INSERT INTO erp_cnab.operational_binding(event_id,billing_title_id,profile_id,our_number,file_id,line,context_hash,command_id,actor) VALUES($1,(SELECT id FROM erp_cnab.billing_title WHERE title_id=$2),$3,'10001100000',$4,2,$5,$6,$7)`,
    [second[0].id, titles[1].id, profile, applied, sha('context'), randomUUID(), users.admin]);
});
after(async () => db?.close());

test('213 RPCs are service-only security definer functions and the exclusion tables are closed', async () => {
  for (const fn of ['erp_cnab_remittance_page(uuid,text,date,date,integer,integer)', 'erp_cnab_remittance_detail(uuid,uuid)', 'erp_cnab_remittance_exclude(uuid,uuid,jsonb)', 'erp_cnab_return_page(uuid,text,date,date,integer,integer)',
    'erp_cnab_return_detail(uuid,uuid,text,integer,integer)', 'erp_cnab_return_exclude(uuid,uuid,jsonb)']) {
    assert.equal(await scalar("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS value", ['public.' + fn]), true, fn);
    for (const role of ['anon', 'authenticated']) assert.equal(await scalar("SELECT has_function_privilege($2,$1,'EXECUTE') AS value", ['public.' + fn, role]), false, fn);
    assert.deepEqual((await db.query('SELECT prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure', ['public.' + fn])).rows[0], { prosecdef: true, proconfig: ['search_path=pg_catalog'] });
  }
  for (const table of ['erp_cnab.remittance_exclusion', 'erp_cnab.return_exclusion']) assert.equal(await scalar("SELECT has_table_privilege('service_role',$1,'SELECT') AS value", [table]), false);
  for (const role of ['vendas', 'estoque', 'inactive']) await assert.rejects(() => call('/v1/financeiro/remessas', {}, users[role]), http(403), role);
  for (const bad of ['/v1/financeiro/remessas?page=0', '/v1/financeiro/remessas?limit=101', '/v1/financeiro/remessas?from=2026-04-01&to=2026-03-01', '/v1/financeiro/remessas?x=1', `/v1/financeiro/retornos/${randomUUID()}?grupo=todas`])
    await assert.rejects(() => call(bad, {}, users.consulta), http(400), bad);
});

test('213 Remessas: Nro Títulos and Valor Títulos, Pesquisar, period, Quantidade and the detail with Dados da Conta', async () => {
  const all = await call('/v1/financeiro/remessas', {}, users.consulta);
  assert.deepEqual(all.items.map(item => [item.sequence, item.filename, item.bank_name, item.titles, item.total_cents, item.state, item.excludable]),
    [['3', 'ITAU_COBRANCA_0000003.REM', 'Itaú', 2, '12000', 'reserved', true], ['2', 'ITAU_COBRANCA_0000002.REM', 'Itaú', 0, '0', 'ready', false], ['1', 'ITAU_COBRANCA_0000001.REM', 'Itaú', 2, '35000', 'ready', false]]);
  assert.equal(all.total, 3);
  assert.deepEqual((await call('/v1/financeiro/remessas?q=0000002', {}, users.consulta)).items.map(item => item.sequence), ['2']);
  assert.deepEqual((await call('/v1/financeiro/remessas?from=2026-03-01&to=2026-03-31', {}, users.consulta)).items.map(item => item.sequence), ['2', '1']);
  const page = await call('/v1/financeiro/remessas?limit=1&page=2', {}, users.consulta); assert.deepEqual([page.total, page.items.map(item => item.sequence)], [3, ['2']]);
  const detail = await call(`/v1/financeiro/remessas/${remittances.first}`, {}, users.consulta);
  assert.deepEqual(detail.account, { bank: '341', bank_name: 'Itaú', agency: '1500', account: '12345', account_digit: '6', wallet: '109', name: 'Itaú cobrança sintética' });
  assert.deepEqual(detail.titles.map(item => [item.contact_name, item.our_number, item.document_number, item.issued_on, item.due_on, item.description, item.amount_cents]),
    [['Alfa Pagadora', '100001', '10', '2026-03-01', '2026-03-10', 'Boleto sintético 1', '10000'], ['Alfa Pagadora', '100011', '11', '2026-03-01', '2026-03-15', 'Boleto sintético 2', '25000']]);
  assert.deepEqual([detail.titles_total, detail.total_cents], [2, '35000']);
  await assert.rejects(() => call(`/v1/financeiro/remessas/${randomUUID()}`, {}, users.consulta), http(404));
});

test('213 Excluir as remessas selecionadas: only the reservation without file, the títulos are free and the last number comes back', async () => {
  await assert.rejects(() => act('remittance_exclude', { id: remittances.first, sequence: '1' }), http(409), 'a remessa with file stays');
  await assert.rejects(() => act('remittance_exclude', { id: remittances.reserved, sequence: '3' }, users.consulta), http(403));
  await assert.rejects(() => act('remittance_exclude', { id: remittances.reserved, sequence: '9' }), http(409), 'the number seen in the list must be the current one');
  await assert.rejects(() => act('remittance_exclude', { id: remittances.reserved }), http(400));
  const command = randomUUID(), done = await act('remittance_exclude', { id: remittances.reserved, sequence: '3' }, users.financeiro, command);
  assert.deepEqual(done.record, { id: remittances.reserved, sequence: '3', titles: 2, released_sequence: true });
  assert.equal((await act('remittance_exclude', { id: remittances.reserved, sequence: '3' }, users.financeiro, command)).replayed, true);
  assert.equal(await scalar('SELECT next_sequence::int AS value FROM erp_cnab.profile WHERE id=$1', [profile]), 3);
  assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_cnab.billing_title WHERE title_id=ANY($1::uuid[])', [[titles[2].id, titles[3].id]]), 0, 'the títulos left the remessa');
  const page = await call(`/v1/financeiro/titles?page=1&kind=receivable&option=open&from=2026-04-01&to=2026-04-30&remittance=no`, {}, users.consulta);
  assert.deepEqual(page.items.map(item => item.id).sort(), [titles[2].id, titles[3].id].sort());
  assert.equal(await scalar("SELECT jsonb_array_length(titles)::int AS value FROM erp_cnab.remittance_exclusion WHERE remittance_id=$1", [remittances.reserved]), 2, 'the reservation stays as evidence');
  assert.equal(await scalar("SELECT count(*)::int AS value FROM erp_cnab.audit WHERE action='remittance_exclude'"), 1);
  await assert.rejects(() => db.query('DELETE FROM erp_cnab.remittance_exclusion'), /immutable/);
});

test('213 Retornos: list, detail by group with the Resumo do processamento, and Excluir only without ocorrência aplicada', async () => {
  const all = await call('/v1/financeiro/retornos', {}, users.consulta);
  assert.deepEqual(all.items.map(item => [item.id, item.titles, item.total_cents, item.excludable]), [[applied, 1, '25000', false], [returned, 3, '45000', true]]);
  const detail = await call(`/v1/financeiro/retornos/${returned}`, {}, users.consulta);
  assert.deepEqual(detail.summary, { titles: 3, amount_cents: '45000', amount_with_additions_cents: '45250', entries: 1, entries_cents: '10000', settlements: 1, settlements_cents: '25150', others: 1, interest_cents: '250', discount_cents: '0', fee_cents: '100' });
  assert.deepEqual(detail.items.map(item => [item.kind, item.document_number, item.our_number, item.occurrence_date, item.credit_date, item.contact_name, item.fee_cents, item.interest_cents, item.amount_cents, item.paid_cents]),
    [['PAID', '11', '100011', '2026-03-15', '2026-03-16', 'Alfa Pagadora', '100', '250', '25000', '25150']]);
  assert.deepEqual((await call(`/v1/financeiro/retornos/${returned}?grupo=entradas`, {}, users.consulta)).items.map(item => item.kind), ['REGISTERED']);
  assert.deepEqual((await call(`/v1/financeiro/retornos/${returned}?grupo=outras`, {}, users.consulta)).items.map(item => item.kind), ['CANCELLED']);
  await assert.rejects(() => act('return_exclude', { id: applied }), http(409), 'a retorno with an applied ocorrência stays');
  await assert.rejects(() => act('return_exclude', { id: returned }, users.consulta), http(403));
  const removal = randomUUID(), done = await act('return_exclude', { id: returned }, users.financeiro, removal);
  assert.deepEqual(done.record, { id: returned, excluded: true });
  assert.equal((await act('return_exclude', { id: returned }, users.financeiro, removal)).replayed, true);
  assert.deepEqual((await call('/v1/financeiro/retornos', {}, users.consulta)).items.map(item => item.id), [applied]);
  await assert.rejects(() => call(`/v1/financeiro/retornos/${returned}`, {}, users.consulta), http(404));
  assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_cnab.return_occurrence WHERE file_id=$1', [returned]), 3, 'the file and its events stay as evidence');
});
