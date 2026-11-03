import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { produtosDFixture, fails } from './helpers/produtos-d-fixture.mjs';

// Listas de preços, onda D (migration 192): vincular produtos pela planilha modelo (código e preço) e as listas aplicáveis a um
// documento (contato, UF, vendedor e forma de pagamento, vigência de São Paulo). PGlite, dados sintéticos.
const base = { name: 'Atacado', category: 'other', list_type: 'rates', factor: '10', factor_unit: 'percent', direction: 'discount', considers_datetime: false, starts_on: null, ends_on: null, start_time: null, end_time: null, contacts: [], regions: [] };

test('192 grants: SECURITY DEFINER, fixed search_path, service_role only', async () => {
  const f = await produtosDFixture();
  try {
    for (const name of ['erp_pricing_list_import', 'erp_pricing_applicable_lists']) {
      const rows = await f.rows(`select p.prosecdef d,p.proconfig c,has_function_privilege('anon',p.oid,'execute') a,has_function_privilege('authenticated',p.oid,'execute') u,has_function_privilege('service_role',p.oid,'execute') s
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [name]);
      assert.deepEqual([rows.length, rows[0].d, rows[0].c, rows[0].a, rows[0].u, rows[0].s], [1, true, ['search_path=pg_catalog'], false, false, true], name);
    }
  } finally { await f.close(); }
});

test('192 planilha modelo: codes link products, custom prices, the summary, replay, versions and refusals', async () => {
  const f = await produtosDFixture();
  const save = (data, user = f.users.admin) => f.rpc('erp_pricing_list_save', { p_user_id: user, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data });
  const sheet = (list, rows, { command = randomUUID(), version = list.version, user = f.users.admin } = {}) => f.rpc('erp_pricing_list_import', { p_user_id: user, p_id: list.id, p_expected_version: version, p_command_id: command, p_rows: rows });
  try {
    const a = await f.product({ name: 'Parafuso', code: 'PAR-1', price: '10' }), b = await f.product({ name: 'Porca', code: 'POR-1', price: '2' });
    await f.product({ name: 'Arruela A', code: 'ARR', price: '1' }); await f.product({ name: 'Arruela B', code: 'arr', price: '1' });
    const gone = await f.product({ name: 'Excluído', code: 'EXC', price: '1' });
    await f.rpc('erp_catalog_product_set_deleted', { p_user_id: f.users.admin, p_id: gone.id, p_expected_version: gone.version, p_command_id: randomUUID(), p_deleted: true });
    const rates = (await save(base)).list;
    const command = randomUUID();
    const result = await sheet(rates, [{ code: ' par-1 ' }, { code: 'POR-1' }, { code: 'PAR-1' }, { code: 'NAO-EXISTE' }, { code: 'ARR' }, { code: 'EXC' }], { command });
    assert.deepEqual([result.saved, result.added, result.updated, result.unchanged, result.duplicates, result.not_found, result.not_found_total, result.ambiguous, result.ambiguous_total, result.list.products, result.list.version],
      [true, 2, 0, 0, 1, ['NAO-EXISTE', 'EXC'], 2, ['ARR'], 1, 2, 2]);
    assert.deepEqual(await sheet(rates, [{ code: ' par-1 ' }, { code: 'POR-1' }, { code: 'PAR-1' }, { code: 'NAO-EXISTE' }, { code: 'ARR' }, { code: 'EXC' }], { command }), { ...result, replayed: true });
    await fails(assert, sheet(rates, [{ code: 'PAR-1' }], { command }), '40001');
    const detail = await f.rpc('erp_pricing_list_get', { p_user_id: f.users.admin, p_id: rates.id });
    assert.deepEqual(detail.items.map(item => [item.name, item.list_price]), [['Parafuso', '9.00'], ['Porca', '1.80']]);
    // Nothing new: no new version, no audit.
    const again = await sheet(result.list, [{ code: 'PAR-1' }]);
    assert.deepEqual([again.added, again.unchanged, again.list.version], [0, 1, 2]);
    assert.equal(await f.scalar("select count(*)::int v from erp_pricing.audit where list_id=$1 and action='items'", [rates.id]), 1);
    await fails(assert, sheet(result.list, [{ code: 'PAR-1', price: '5' }]), '22023', 'a price only belongs to a customized list');
    await fails(assert, sheet(rates, [{ code: 'PAR-1' }]), '40001', 'expected version');
    // Customized list: the price of the line is the product price in the list.
    const custom = (await save({ ...base, name: 'Especial', list_type: 'custom', factor: null })).list;
    const priced = await sheet(custom, [{ code: 'PAR-1', price: '7.5' }, { code: 'POR-1', price: '' }]);
    assert.deepEqual([priced.added, priced.updated], [2, 0]);
    const repriced = await sheet(priced.list, [{ code: 'PAR-1', price: '8' }, { code: 'POR-1' }]);
    assert.deepEqual([repriced.added, repriced.updated, repriced.unchanged], [0, 1, 1]);
    const items = (await f.rpc('erp_pricing_list_get', { p_user_id: f.users.admin, p_id: custom.id })).items;
    assert.deepEqual(items.map(item => [item.name, item.custom_price, item.list_price]), [['Parafuso', '8.0000', '8.00'], ['Porca', null, '2.00']]);
    for (const bad of [[], [{}], [{ code: '' }], [{ code: 'x'.repeat(101) }], [{ code: 'A', extra: 1 }], [{ code: 1 }], [{ code: 'A', price: 1 }], [{ code: 'A\tB' }], Array.from({ length: 501 }, () => ({ code: 'A' }))])
      await fails(assert, sheet(repriced.list, bad), '22023');
    await fails(assert, sheet(repriced.list, [{ code: 'PAR-1', price: '1,5' }]), '22023');
    await fails(assert, sheet(repriced.list, [{ code: 'PAR-1' }], { user: f.users.vendas }), '42501');
    await fails(assert, sheet({ id: randomUUID(), version: 1 }, [{ code: 'PAR-1' }]), 'P0002');
    assert.ok(a.id && b.id);
  } finally { await f.close(); }
});

test('192 applicable lists: Outra, Contato, Região by the contact UF, Vendedor and Forma de pagamento, only while valid', async () => {
  const f = await produtosDFixture();
  const save = data => f.rpc('erp_pricing_list_save', { p_user_id: f.users.admin, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data }).then(value => value.list);
  try {
    const customer = await f.contact({ name: 'Cliente SP', state: 'sp' }), other = await f.contact({ name: 'Outro cliente', state: 'RJ' });
    const sellerContact = await f.contact({ name: 'Vendedora' });
    const seller = await f.scalar('insert into erp_catalog.seller(contact_id,created_by,updated_by) values($1,$2,$2) returning id v', [sellerContact.id, f.users.admin]);
    const method = await f.scalar(`insert into erp_catalog.payment_method(description,payment_type,destination,applicable,created_by,updated_by) values('Pix sintético','17','contas','recebimentos',$1,$1) returning id v`, [f.users.admin]);
    await save({ ...base, name: 'Geral' });
    await save({ ...base, name: 'Do cliente', category: 'contact', contacts: [customer.id] });
    await save({ ...base, name: 'Paulista', category: 'region', regions: ['SP'] });
    await save({ ...base, name: 'Da vendedora', category: 'seller', sellers: [seller] });
    await save({ ...base, name: 'No Pix', category: 'payment_method', payment_methods: [method] });
    await save({ ...base, name: 'Vencida', list_type: 'period', starts_on: '2020-01-01', ends_on: '2020-12-31' });
    const names = async args => (await f.rpc('erp_pricing_applicable_lists', { p_user_id: f.users.vendas, ...args })).items.map(item => item.name);
    assert.deepEqual(await names({}), ['Geral']);
    assert.deepEqual(await names({ p_contact_id: customer.id }), ['Do cliente', 'Geral', 'Paulista'], 'the UF of the contact');
    assert.deepEqual(await names({ p_contact_id: other.id }), ['Geral']);
    assert.deepEqual(await names({ p_contact_id: other.id, p_state: 'SP' }), ['Geral', 'Paulista'], 'the UF of the document wins');
    assert.deepEqual(await names({ p_seller_id: seller, p_payment_method_id: method }), ['Da vendedora', 'Geral', 'No Pix']);
    const answer = await f.rpc('erp_pricing_applicable_lists', { p_user_id: f.users.vendas, p_contact_id: customer.id });
    assert.deepEqual([answer.state, answer.contact_id, Object.hasOwn(answer.items[0], 'contacts'), typeof answer.items[0].rule], ['SP', customer.id, false, 'string']);
    await fails(assert, f.rpc('erp_pricing_applicable_lists', { p_user_id: f.users.vendas, p_state: 'XX' }), '22023');
    await fails(assert, f.rpc('erp_pricing_applicable_lists', { p_user_id: f.users.financeiro }), '42501');
  } finally { await f.close(); }
});
