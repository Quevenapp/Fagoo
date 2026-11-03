import test from 'node:test'; import assert from 'node:assert/strict'; import { randomUUID } from 'node:crypto';
import { financeiroHFixture, fails } from './helpers/financeiro-h-fixture.mjs';

// Leva H, lane financeiro (373: CTT-050, PRF-299): general and billing addresses kept apart with the explicit "use the general address"
// choice, the e-mail de cobrança of the contact, and the verified badge only for an address confirmed by an explicit flow.
// Synthetic data only.
test('H 373: billing address and e-mail of the contact; the badge needs an explicit confirmation, never the login', async () => {
  const f = await financeiroHFixture(); try {
    const id = (await f.catalog('contacts', { name: 'Cliente Sintético', email: 'contato@sintetico.test', street: 'Rua Geral', number: '10', city: 'Piracicaba', state: 'SP', postal_code: '13400-000' })).id;
    const get = async (user = f.users.consulta) => (await f.rpc('erp_contact_billing_get', { p_user_id: user, p_contact_id: id })).item;
    const save = async (version, data, user = f.users.vendas, command = randomUUID()) => f.rpc('erp_contact_billing_save', { p_user_id: user, p_contact_id: id, p_expected_version: version, p_command_id: command, p_data: data });
    let item = await get();
    assert.deepEqual([item.same_as_general, item.billing_email, item.email_verified, item.billing_email_verified, item.verification_available, item.version], [false, null, false, false, false, 0]);
    assert.deepEqual([item.address.source, item.address.street], ['geral', 'Rua Geral'], 'without a billing address the general one is used');
    // A billing address on the profile (124) becomes the effective one; "use the general address" chooses the general again.
    const profiled = await f.db.query("update erp_catalog.contact_profile set billing_street='Rua Cobrança',billing_number='20',billing_city='Campinas',billing_state='SP',billing_postal_code='13000-000' where record_id=$1", [id]);
    if (!profiled.affectedRows) await f.db.query("insert into erp_catalog.contact_profile(record_id,billing_street,billing_number,billing_city,billing_state,billing_postal_code) values($1,'Rua Cobrança','20','Campinas','SP','13000-000')", [id]);
    assert.deepEqual([(await get()).address.source, (await get()).address.street], ['cobranca', 'Rua Cobrança']);
    const command = randomUUID();
    item = (await save(0, { same_as_general: true, billing_email: 'financeiro@sintetico.test' }, f.users.vendas, command)).item;
    assert.deepEqual([item.same_as_general, item.billing_email, item.address.source, item.version], [true, 'financeiro@sintetico.test', 'geral', 1]);
    assert.equal((await save(0, { same_as_general: true, billing_email: 'financeiro@sintetico.test' }, f.users.vendas, command)).replayed, true, 'same command, same answer');
    await fails(assert, () => save(0, { same_as_general: false, billing_email: null }), '40001');
    await fails(assert, () => save(1, { same_as_general: false, billing_email: 'não é e-mail' }), '22023');
    await fails(assert, () => save(1, { same_as_general: false, billing_email: null }, f.users.consulta), '42501');
    // A confirmed login of a user never verifies the contact; only an explicit confirmation does.
    await f.db.query("update auth.users set email='financeiro@sintetico.test',email_confirmed_at=now() where id=$1", [f.users.financeiro]);
    assert.equal((await get()).billing_email_verified, false);
    await f.db.query("insert into erp_catalog.contact_email_verification(contact_id,email,purpose,confirmed_at,method) values($1,'financeiro@sintetico.test','cobranca',now(),'link_transacional')", [id]);
    assert.deepEqual([(await get()).billing_email_verified, (await get()).email_verified], [true, false], 'only the confirmed address and purpose');
    assert.equal(await f.scalar('select count(*)::int v from erp_catalog.contact_billing_audit where contact_id=$1', [id]), 1);
    // The Worker.
    const http = await f.call(`/v1/cadastros/contatos/${id}/cobranca`, 'GET', undefined, f.users.consulta);
    assert.deepEqual([http.status, http.value.item.billing_email, http.value.item.address.source], [200, 'financeiro@sintetico.test', 'geral']);
    const saved = await f.call(`/v1/cadastros/contatos/${id}/cobranca`, 'POST', { command_id: randomUUID(), expected_version: 1, data: { same_as_general: false, billing_email: null } }, f.users.vendas);
    assert.deepEqual([saved.status, saved.value.item.address.source, saved.value.item.version], [200, 'cobranca', 2]);
    assert.equal((await f.call(`/v1/cadastros/contatos/${id}/cobranca`, 'POST', { command_id: randomUUID(), expected_version: 2, data: { same_as_general: false } }, f.users.vendas)).status, 400);
  } finally { await f.close(); }
});
