import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fixture } from '../../../tools/migration/helpers/stock-reservation-fixture.mjs';

// 114 on PGlite with synthetic data: event requests stay queued in homologation and never transmit.
const migration = async name => readFile(new URL(`../../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
const code = expected => error => error.code === expected;
let f, nature;
const execute = (action, data, { user = f.users.fiscal, command = randomUUID() } = {}) => f.rpc('erp_fiscal_event_execute', { p_user_id: user, p_command_id: command, p_action: action, p_data: data });
const KEY = number => { const digits = `3526101122233300018155002${String(number).padStart(9, '0')}112345678`.slice(0, 43); let sum = 0, weight = 2; for (let i = 42; i >= 0; i--) { sum += Number(digits[i]) * weight; weight = weight === 9 ? 2 : weight + 1; } const dv = 11 - (sum % 11); return digits + (dv >= 10 ? 0 : dv); };
async function note({ model = '55', authorized = true, number = 10 } = {}) {
  const invoice = { model, direction: '1', issue_type: model === '65' ? 'C' : 'N', series: '2', nature_id: nature.id, issue_date: '2026-10-20', crt: '1', purpose: '1', presence: '1', final_consumer: model === '65',
    recipient: model === '65' ? {} : { name: 'Cliente sintético', person_type: 'F', document: '98765432100' }, items: [{ description: 'Item sintético', quantity: '1', unit_price: '10' }] };
  const created = (await f.rpc('erp_fiscal_invoice_execute', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: 'create', p_data: { invoice } })).invoice;
  if (!authorized) return created;
  // The test plays the future transmitter as superuser; no RPC can do this.
  await f.db.query("alter table erp_fiscal_invoices.invoice disable trigger guard_invoice");
  await f.db.query("update erp_fiscal_invoices.invoice set status=6,number=$2,access_key=$3,protocol='135260000000001',authorized_at=now(),version=version+1 where id=$1", [created.id, number, KEY(number)]);
  await f.db.query("alter table erp_fiscal_invoices.invoice enable trigger guard_invoice");
  return { ...created, version: 2, number };
}

before(async () => {
  f = await fixture({ apply: false });
  for (const name of ['202610160016_company', '202610160022_fiscal_drafts', '202610160035_fiscal_item_preparation', '202610160040_fiscal_tax_preparation', '202610160046_fiscal_numbering',
    '202610200111_fiscal_operation_natures', '202610200112_fiscal_invoice_core', '202610200114_fiscal_invoice_events']) await f.db.exec(await migration(name));
  nature = (await f.rpc('erp_fiscal_nature_execute', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: 'create', p_data: { nature: { description: 'Venda sintética', direction: '1', crt: '1' } } })).nature;
});
after(() => f?.close());

test('114 entry points: service_role only, admin and fiscal only, immutable requests', async () => {
  for (const signature of ['public.erp_fiscal_event_execute(uuid,uuid,text,jsonb)', 'public.erp_fiscal_event_list(uuid,text,text,date,date,integer,integer)']) {
    for (const role of ['anon', 'authenticated', 'public']) assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') value`, [signature]), false);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') value", [signature]), true);
    assert.equal(await f.scalar('select prosecdef value from pg_proc where oid=$1::regprocedure', [signature]), true);
  }
  for (const user of [f.users.consulta, f.users.vendas, randomUUID()]) {
    await assert.rejects(() => f.rpc('erp_fiscal_event_list', { p_user_id: user, p_kind: 'inutilization' }), code('42501'));
    await assert.rejects(() => execute('inutilization', { model: '55', series: '2', number_from: '1', number_to: '1', justification: 'Justificativa sintética longa' }, { user }), code('42501'));
  }
  assert.match(await f.scalar("select pg_get_constraintdef(oid) value from pg_constraint where conrelid='erp_fiscal_invoices.event_request'::regclass and pg_get_constraintdef(oid) like '%environment%'"), /'2'/);
});

test('cancelamento: only an authorized Brufap homologation note, justification of 15 to 255 characters, once', async () => {
  const pending = await note({ authorized: false });
  await assert.rejects(() => execute('cancel', { invoice_id: pending.id, expected_version: 1, justification: 'Cancelamento sintético de teste' }), code('40001'), 'Pendente cannot be cancelled');
  const authorized = await note({ number: 11 });
  await assert.rejects(() => execute('cancel', { invoice_id: authorized.id, expected_version: 2, justification: 'curta demais' }), code('22023'));
  await assert.rejects(() => execute('cancel', { invoice_id: authorized.id, expected_version: 2, justification: 'x'.repeat(256) }), code('22023'));
  await assert.rejects(() => execute('cancel', { invoice_id: authorized.id, expected_version: 1, justification: 'Cancelamento sintético de teste' }), code('40001'), 'stale version');
  const command = randomUUID();
  const out = await execute('cancel', { invoice_id: authorized.id, expected_version: 2, justification: 'Cancelamento sintético de teste' }, { command });
  assert.deepEqual([out.event.kind, out.event.state, out.event.environment, out.event.number_from, out.transmission_enabled], ['cancel', 'pending', '2', 11, false]);
  assert.equal((await execute('cancel', { invoice_id: authorized.id, expected_version: 2, justification: 'Cancelamento sintético de teste' }, { command })).replayed, true);
  await assert.rejects(() => execute('cancel', { invoice_id: authorized.id, expected_version: 2, justification: 'Outro cancelamento sintético' }), code('40001'), 'one cancellation request');
  assert.equal(await f.scalar('select status::int value from erp_fiscal_invoices.invoice where id=$1', [authorized.id]), 6, 'the note keeps its situation until a transmitter exists');
  await assert.rejects(() => f.db.query("update erp_fiscal_invoices.event_request set text='Alterado sintético longo' where invoice_id=$1", [authorized.id]), code('42501'));
});

test('carta de correção: NF-e only, 15 to 1000 characters, sequence 1..20 per note', async () => {
  const authorized = await note({ number: 12 });
  const first = await execute('correction', { invoice_id: authorized.id, expected_version: 2, correction: 'Correção sintética do endereço\nlinha 2' });
  const second = await execute('correction', { invoice_id: authorized.id, expected_version: 2, correction: 'Segunda correção sintética' });
  assert.deepEqual([first.event.sequence, second.event.sequence], [1, 2]);
  await assert.rejects(() => execute('correction', { invoice_id: authorized.id, expected_version: 2, correction: 'curta' }), code('22023'));
  const nfce = await note({ model: '65', number: 13 });
  await assert.rejects(() => execute('correction', { invoice_id: nfce.id, expected_version: 2, correction: 'Correção sintética de NFC-e' }), code('40001'), 'CC-e is only for model 55');
  const list = await f.rpc('erp_fiscal_event_list', { p_user_id: f.users.admin, p_kind: 'correction' });
  assert.deepEqual(list.items.map(i => i.sequence), [2, 1]); assert.equal(list.total_count, 2); assert.equal(list.items[0].access_key, KEY(12));
  assert.deepEqual((await f.rpc('erp_fiscal_event_list', { p_user_id: f.users.admin, p_kind: 'correction', p_query: 'endereço' })).items.map(i => i.sequence), [1]);
});

test('inutilização: homologation range without used numbers or overlaps', async () => {
  await note({ number: 30 });
  await assert.rejects(() => execute('inutilization', { model: '55', series: '2', number_from: '25', number_to: '35', justification: 'Faixa sintética pulada na numeração' }), code('40001'), 'number 30 is used');
  await assert.rejects(() => execute('inutilization', { model: '55', series: '2', number_from: '40', number_to: '39', justification: 'Faixa sintética pulada na numeração' }), code('22023'));
  await assert.rejects(() => execute('inutilization', { model: '55', series: '2', number_from: '1', number_to: '10001', justification: 'Faixa sintética pulada na numeração' }), code('22023'));
  const out = await execute('inutilization', { model: '55', series: '2', number_from: '40', number_to: '45', justification: 'Faixa sintética pulada na numeração' });
  assert.deepEqual([out.event.number_from, out.event.number_to, out.event.invoice_id, out.event.state], [40, 45, null, 'pending']);
  await assert.rejects(() => execute('inutilization', { model: '55', series: '2', number_from: '45', number_to: '50', justification: 'Faixa sintética sobreposta à anterior' }), code('40001'));
  assert.ok(await execute('inutilization', { model: '65', series: '2', number_from: '45', number_to: '50', justification: 'Mesma faixa em outro modelo sintético' }));
  const page = await f.rpc('erp_fiscal_event_list', { p_user_id: f.users.fiscal, p_kind: 'inutilization', p_query: '42' });
  assert.deepEqual(page.items.map(i => [i.model, i.number_from, i.number_to]), [['55', 40, 45]]);
  for (const args of [{ p_kind: 'x' }, { p_limit: 101 }, { p_date_from: '2026-10-02', p_date_to: '2026-10-01' }]) await assert.rejects(() => f.rpc('erp_fiscal_event_list', { p_user_id: f.users.fiscal, p_kind: 'inutilization', ...args }), code('22023'));
});
