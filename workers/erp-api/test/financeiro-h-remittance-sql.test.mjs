import test from 'node:test'; import assert from 'node:assert/strict'; import { randomUUID } from 'node:crypto';
import { financeiroHFixture, fails } from './helpers/financeiro-h-fixture.mjs';

// Leva H, lane financeiro (372: FIN-176, FIN-180, FIN-182): the contas a receber a new remessa may include, read-only, with the
// Forma de pagamento and Conta financeira filters. No remessa, number or bank operation is touched. Synthetic data only.
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

test('H 372: candidates are the open contas in no remessa, filtered by forma and conta, without Origin imports; read-only', async () => {
  const f = await financeiroHFixture(); try {
    const contact = (await f.catalog('contacts', { name: 'Pagador Sintético', person_type: 'J' })).id;
    const create = async (description, cents = '1000', due = '2099-01-10') => (await f.rpc('erp_finance_execute', { p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_action: 'title_create_group',
      p_data: { kind: 'receivable', contact_id: contact, description, issued_on: today, total_cents: cents, installments: [{ amount_cents: cents, due_on: due }] } })).items[0];
    const account = (await f.rpc('erp_finance_account_execute', { p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: { account_type: 'cash', name: 'Caixa sintético', start_on: '2020-01-01', opening_cents: '0' } })).record;
    const pix = (await f.db.query("insert into erp_catalog.payment_method(description,payment_type,destination,applicable,fee_type,created_by,updated_by) values('Pix sintético','17','contas','recebimentos','aliquota',$1,$1) returning id", [f.users.admin])).rows[0].id;
    const old = (await f.db.query("insert into erp_catalog.payment_method(description,payment_type,destination,applicable,fee_type,active,account_id,created_by,updated_by) values('Boleto antigo','15','contas','ambos','aliquota',false,$2,$1,$1) returning id", [f.users.admin, account.id])).rows[0].id;
    const a = await create('Conta A'), b = await create('Conta B'), c = await create('Conta C'), paid = await create('Conta paga'), late = await create('Conta vencida'), imported = await create('Conta do Origin');
    await f.db.query('update erp_finance.title set account_id=$2,payment_method_id=$3 where id=$1', [a.id, account.id, pix]);
    await f.db.query('update erp_finance.title set payment_method_id=$2 where id=$1', [b.id, pix]);
    await f.db.query('update erp_finance.title set settled_cents=amount_cents where id=$1', [paid.id]);
    await f.db.query("update erp_finance.title set issued_on='2000-01-01',due_on='2000-01-02' where id=$1", [late.id]);
    await f.db.query("insert into erp_finance.origin_import_origin(entity,source_id,title_id,command_id,evidence) values('receivables','9001',$1,(select id from erp_finance.command limit 1),'{}')", [imported.id]);
    const list = async (args = {}, user = f.users.financeiro) => f.rpc('erp_cnab_remittance_candidates', { p_user_id: user, p_payment_method_id: null, p_account_id: null, p_without_account: true, p_query: null, p_after: null, p_limit: 15, ...args });
    const names = page => page.items.map(i => i.description).sort();
    let page = await list();
    assert.deepEqual(names(page), ['Conta A', 'Conta B', 'Conta C'], 'not the paid, the overdue nor the imported conta');
    assert.deepEqual([page.eligible_total, page.remittance_limit, page.operational_effects], [3, 30, false]);
    assert.deepEqual(page.payment_methods.map(m => [m.description, m.active]), [['Pix sintético', true], ['Boleto antigo', false]], 'inactive formas are listed and marked');
    assert.deepEqual(names(await list({ p_payment_method_id: pix })), ['Conta A', 'Conta B']);
    assert.deepEqual(names(await list({ p_account_id: account.id, p_without_account: false })), ['Conta A']);
    assert.deepEqual(names(await list({ p_account_id: account.id })), ['Conta A', 'Conta B', 'Conta C'], 'Incluir títulos sem conta financeira');
    assert.equal((await list({ p_account_id: account.id })).payment_methods[0].description, 'Boleto antigo', 'the formas linked to the conta come first');
    assert.deepEqual(names(await list({ p_without_account: false })), ['Conta A']);
    assert.deepEqual(names(await list({ p_query: 'conta b' })), ['Conta B']);
    // Cursor of the editor.
    const first = await list({ p_limit: 2 }), second = await list({ p_limit: 2, p_after: first.next_cursor });
    assert.deepEqual([first.items.length, first.has_more, second.items.length, second.has_more], [2, true, 1, false]);
    assert.equal(new Set([...first.items, ...second.items].map(i => i.id)).size, 3);
    // Nothing was written: no remessa, no billing title.
    assert.equal(await f.scalar('select count(*)::int v from erp_cnab.billing_title'), 0);
    assert.equal(await f.scalar('select count(*)::int v from erp_cnab.remittance'), 0);
    await fails(assert, () => list({}, f.users.estoque), '42501');
    await fails(assert, () => list({ p_limit: 16 }), '22023');
    await fails(assert, () => list({ p_payment_method_id: randomUUID() }), '22023');
    // The Worker checks and projects the answer.
    const http = await f.call(`/v1/financeiro/remessa-candidatos?forma=${pix}&sem_conta=true`, 'GET', undefined, f.users.financeiro);
    assert.equal(http.status, 200);
    assert.deepEqual(http.value.items.map(i => [i.description, i.payment_method_name]).sort(), [['Conta A', 'Pix sintético'], ['Conta B', 'Pix sintético']]);
    assert.equal((await f.call('/v1/financeiro/remessa-candidatos?limit=50', 'GET', undefined, f.users.financeiro)).status, 400);
    void late; void c;
  } finally { await f.close(); }
});
