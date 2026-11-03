import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createNetCreditFixture } from './helpers/itau-net-credit-fixture.mjs';
import {parseItauNetCreditRoute,executeItauNetCreditRoute} from '../src/itau-net-credit.mjs';
import {netCreditPreview as uiPreview,netCreditBody,netCreditAck,netCreditReadback} from '../../../apps/erp/src/lib/itau-net-credit-model.ts';

// Independent SQL-only review. Every account, return and reversal is synthetic.
let f;
before(async () => { f = await createNetCreditFixture(); });
after(async () => { await f?.close(); });
const state = code => error => error.code === code;
const settle = body => f.rpc('erp_cnab_itau_net_credit_settle', body);
const read = command => f.rpc('erp_cnab_itau_net_credit_command', {
  p_user_id: f.users.financeiro, p_command_id: command,
});
async function prepared() {
  const source = await f.prepare();
  const imported = await f.importFile(source, f.source(source, { paid: '12245', fee: '100' }));
  const category = await f.category();
  const preview = await f.netPreview(imported, category);
  assert.equal(preview.context.settlement.allowed, true);
  return { source, imported, category, preview, body: f.netCommand(imported, category, preview) };
}
async function positions(title, account) {
  return {
    title: (await f.current(title)).record,
    account: (await f.rpc('erp_finance_get', { p_user_id: f.users.financeiro, p_entity: 'accounts', p_id: account })).record,
    settlements: (await f.db.query('select id,kind,reverses_id from erp_finance.settlement where title_id=$1 order by id', [title])).rows,
    movements: (await f.db.query('select id,kind,delta_cents::text from erp_finance.movement where account_id=$1 order by id', [account])).rows,
  };
}
async function failFee(kind, action) {
  assert.ok(['bank_fee', 'bank_fee_reversal'].includes(kind));
  await f.db.exec(`create function public.test058_fail_fee() returns trigger language plpgsql as $$
    begin if new.kind='${kind}' then raise exception 'SYNTHETIC_SECOND_LEG_FAILURE'; end if; return new; end $$;
    create trigger test058_fail_fee before insert on erp_finance.movement for each row execute function public.test058_fail_fee()`);
  try { await action(); }
  finally { await f.db.exec('drop trigger test058_fail_fee on erp_finance.movement; drop function public.test058_fail_fee()'); }
}

test('058 payment failure on the fee leg rolls back principal, versions, plan, command and dedupe', async () => {
  const p = await prepared();
  const before = await positions(p.source.title.id, p.source.account.id);
  await failFee('bank_fee', async () => {
    await assert.rejects(() => settle(p.body), /SYNTHETIC_SECOND_LEG_FAILURE/);
    assert.deepEqual(await positions(p.source.title.id, p.source.account.id), before);
    for (const [table, column] of [['erp_finance.command', 'id'], ['erp_finance.cnab_cash_plan', 'command_id'], ['erp_cnab.operational_settlement', 'command_id']]) {
      assert.equal(await f.scalar(`select count(*)::int v from ${table} where ${column}=$1`, [p.body.p_command_id]), 0);
    }
  });
  const ack = await settle(p.body);
  assert.equal(ack.replayed, false);
  assert.equal((await read(p.body.p_command_id)).current_account.balance_cents, '12245');
});

test('058 generic reversal is atomic on its second leg and a retry keeps one reversal', async () => {
  const p = await prepared(), ack = await settle(p.body);
  const command = randomUUID();
  const body = { id: p.source.title.id, expected_version: 2, settlement_id: ack.receipt.settlement_id, posted_on: f.today, note: 'ESTORNO SINTETICO ATOMICO' };
  const before = await positions(p.source.title.id, p.source.account.id);
  await failFee('bank_fee_reversal', async () => {
    await assert.rejects(() => f.native('reverse', body, command), /SYNTHETIC_SECOND_LEG_FAILURE/);
    assert.deepEqual(await positions(p.source.title.id, p.source.account.id), before);
    assert.equal(await f.scalar('select count(*)::int v from erp_finance.command where id=$1', [command]), 0);
  });
  const reversed = await f.native('reverse', body, command);
  assert.equal(reversed.account.balance_cents, '0');
  assert.equal((await f.native('reverse', body, command)).replayed, true);
  assert.equal(await f.scalar('select count(*)::int v from erp_finance.settlement where reverses_id=$1', [ack.receipt.settlement_id]), 1);
  assert.equal(await f.scalar('select count(*)::int v from erp_finance.movement where settlement_id=$1', [reversed.settlement.id]), 2);
  assert.deepEqual((await read(p.body.p_command_id)).receipt, ack.receipt);
});

test('058 reversal uses the historical plan after category/account metadata change; replay does not charge again', async () => {
  const p = await prepared(), ack = await settle(p.body);
  await f.native('category_save', { id: p.category.id, expected_version: 1, name: 'CATEGORIA ALTERADA', kind: 'receivable', active: false });
  await f.native('account_save', { id: p.source.account.id, expected_version: 2, name: 'CONTA INATIVA', kind: 'bank', active: false });
  const reversal = await f.native('reverse', { id: p.source.title.id, expected_version: 2, settlement_id: ack.receipt.settlement_id, posted_on: f.today, note: 'ESTORNO SINTETICO APOS METADADOS' });
  assert.equal(reversal.account.balance_cents, '0');
  const rows = (await f.db.query('select s.kind settlement_kind,m.kind,m.delta_cents::text from erp_finance.settlement s join erp_finance.movement m on m.settlement_id=s.id where s.title_id=$1 order by s.kind,m.kind', [p.source.title.id])).rows;
  assert.deepEqual(rows, [
    { settlement_kind: 'payment', kind: 'bank_fee', delta_cents: '-100' },
    { settlement_kind: 'payment', kind: 'payment', delta_cents: '12345' },
    { settlement_kind: 'reversal', kind: 'bank_fee_reversal', delta_cents: '100' },
    { settlement_kind: 'reversal', kind: 'reversal', delta_cents: '-12345' },
  ]);
  const current = await read(p.body.p_command_id);
  assert.deepEqual(current.receipt, ack.receipt);
  assert.equal(current.current_settlement.reversed, true);
  assert.equal(current.current_title.settled_cents, '0');
  await f.native('account_save', { id: p.source.account.id, expected_version: 4, name: 'CONTA REATIVADA', kind: 'bank', active: true });
  assert.deepEqual((await settle(p.body)).receipt, ack.receipt);
  assert.equal((await read(p.body.p_command_id)).current_account.balance_cents, '0');
  assert.equal(await f.scalar('select count(*)::int v from erp_cnab.operational_settlement where title_id=$1', [p.source.title.id]), 1);
});

test('058 shares permanent event/title dedupe and command namespace with 043 in both directions', async () => {
  const p = await prepared(), ack = await settle(p.body), oldPreview = await f.preview(p.imported);
  assert.ok(oldPreview.context.settlement.issues.includes('OPERATIONAL_PAYMENT_ALREADY_APPLIED'));
  const oldCommand = f.command(p.imported, oldPreview);
  await assert.rejects(() => f.api(`/events/${p.imported.event.event_id}/settle`, { ...oldCommand, command_id: p.body.p_command_id }), state('40001'));
  await assert.rejects(() => f.api(`/events/${p.imported.event.event_id}/settle`, oldCommand), state('40001'));
  const copy = await f.importFile(p.source, f.source(p.source, { paid: '12245', fee: '100' }, '00002'));
  assert.equal(copy.event.event_id, p.imported.event.event_id);
  await f.native('reverse', { id: p.source.title.id, expected_version: 2, settlement_id: ack.receipt.settlement_id, posted_on: f.today, note: 'ESTORNO SINTETICO DEDUPE' });
  const after = await f.netPreview(copy, p.category);
  assert.ok(after.context.settlement.issues.includes('OPERATIONAL_PAYMENT_ALREADY_APPLIED'));
  await assert.rejects(() => settle(f.netCommand(copy, p.category, after)), state('40001'));

  const original = await f.prepare(), imported = await f.importFile(original), preview = await f.preview(imported);
  const body043 = f.command(imported, preview);
  await f.api(`/events/${imported.event.event_id}/settle`, body043);
  const category = await f.category(), preview058 = await f.netPreview(imported, category);
  assert.ok(preview058.context.settlement.issues.includes('OPERATIONAL_PAYMENT_ALREADY_APPLIED'));
  await assert.rejects(() => settle(f.netCommand(imported, category, preview058, body043.command_id)), state('40001'));
  await assert.rejects(() => settle(f.netCommand(imported, category, preview058)), state('40001'));
});

test('058 does not reinterpret manual010 fees: receivable and payable retain a single net leg', async () => {
  for (const kind of ['receivable', 'payable']) {
    const account = (await f.native('account_save', { expected_version: 0, name: 'CONTA MANUAL SINTETICA', kind: 'bank' })).record;
    const title = (await f.native('title_create_group', { kind, contact_id: f.contact.id, description: 'TITULO MANUAL SINTETICO', issued_on: f.today, total_cents: '12345', installments: [{ amount_cents: '12345', due_on: f.today }] })).items[0];
    const payment = await f.native('settle', { id: title.id, expected_version: 1, account_id: account.id, posted_on: f.today, principal_cents: '12345', fee_cents: '100' });
    const expected = kind === 'receivable' ? '12245' : '-12445';
    assert.equal(payment.account.balance_cents, expected);
    assert.deepEqual((await f.db.query('select kind,delta_cents::text from erp_finance.movement where settlement_id=$1', [payment.settlement.id])).rows, [{ kind: 'payment', delta_cents: expected }]);
    const reversed = await f.native('reverse', { id: title.id, expected_version: 2, settlement_id: payment.settlement.id, posted_on: f.today, note: 'ESTORNO MANUAL SINTETICO' });
    assert.equal(reversed.account.balance_cents, '0');
    assert.equal(await f.scalar('select count(*)::int v from erp_finance.movement where settlement_id=$1', [reversed.settlement.id]), 1);
  }
});

test('058 rejects an incomplete two-leg write at commit even when a trigger silently drops the fee', async () => {
  const p = await prepared();
  await f.db.exec("create function public.test058_skip_fee() returns trigger language plpgsql as $$begin if new.kind='bank_fee' then return null; end if; return new; end $$; create trigger test058_skip_fee before insert on erp_finance.movement for each row execute function public.test058_skip_fee()");
  try {
    await assert.rejects(() => settle(p.body), state('22023'));
    assert.equal((await f.current(p.source.title.id)).record.version, 1);
    assert.equal(await f.scalar('select count(*)::int v from erp_finance.movement where account_id=$1', [p.source.account.id]), 0);
    assert.equal(await f.scalar('select count(*)::int v from erp_finance.cnab_cash_plan where command_id=$1', [p.body.p_command_id]), 0);
  } finally { await f.db.exec('drop trigger test058_skip_fee on erp_finance.movement; drop function public.test058_skip_fee()'); }
  assert.equal((await settle(p.body)).replayed, false);
});

test('058 real SQL→HTTP→UI preview, ACK, current readback and reversal retain exact legs and historical category',async()=>{
 const p=await prepared(),selection={event_id:p.imported.event.event_id,file_id:p.imported.ack.id,line:p.imported.event.line},chosen={file_id:selection.file_id,line:selection.line,fee_category_id:p.category.id,expected_fee_category_version:p.category.version};
 const api=async(path,body)=>{const request=new Request('https://test.invalid/v1/retornos-itau109'+path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});return(await executeItauNetCreditRoute(await parseItauNetCreditRoute(request),f.ports())).body;};
 const preview=uiPreview(await api(`/events/${selection.event_id}/preview`,chosen),selection,chosen),body=netCreditBody(preview,true,randomUUID());
 assert.equal(preview.context.plan.posting.fee_cents,'100');
 const ack=netCreditAck(await api(`/events/${selection.event_id}/settle`,body),body,preview),current=netCreditReadback(await api(`/commands/${body.command_id}`),body.command_id,{body,preview,ack});
 assert.equal(current.current_account.balance_cents,'12245');assert.equal(current.receipt.movements.length,2);
 await f.native('category_save',{id:p.category.id,expected_version:1,name:'CATEGORIA ATUAL INATIVA',kind:'payable',active:false});
 await f.native('reverse',{id:p.source.title.id,expected_version:2,settlement_id:ack.settlement_id,posted_on:f.today,note:'ESTORNO SINTETICO INTEROP'});
 await f.native('title_update',{id:p.source.title.id,expected_version:3,due_on:'2100-12-31'});
 const reversed=netCreditReadback(await api(`/commands/${body.command_id}`),body.command_id,{body,preview,ack});assert.equal(reversed.current_settlement.reversed,true);assert.equal(reversed.current_title.due_on,'2100-12-31');assert.equal(reversed.current_account.balance_cents,'0');assert.equal(reversed.receipt.posting.fee_category.name,p.category.name);assert.deepEqual(reversed.receipt,ack);
});
