import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { produtosEFixture, fails } from './helpers/produtos-e-fixture.mjs';

// SQL of the produtos lane, wave E, part 2 (migration 235): the compositions follow their components in the price tools of the
// product list (Reajuste, preço na linha) and in the price formation of the entry note, and the Campos Customizados permissions
// of Sistema › Usuários. PGlite with every migration up to 233 (production) plus this lane. Synthetic data only.
const SETTINGS = { 'produtos.composicao_preco': true, 'produtos.composicao_peso': true, 'produtos.composicao_custo': true };
const priceOf = (f, id) => f.scalar('select price::numeric(28,2)::text v from erp_catalog.product where record_id=$1', [id]);
const costOf = (f, id) => f.scalar('select cost_price::numeric(28,2)::text v from erp_catalog.product_supplier where record_id=$1 and is_default', [id]);
async function kitScene(f) {
  const supplier = await f.contact({ name: 'Fornecedor sintético E' });
  const supplierOf = cost => [{ supplier_id: supplier.id, cost_price: cost, is_default: true }];
  const a = await f.product({ name: 'Componente A sintético', price: '10', net_weight: '1', gross_weight: '1.5', suppliers: supplierOf('4') });
  const b = await f.product({ name: 'Componente B sintético', price: '3', suppliers: supplierOf('1') });
  const kit = (await f.compose(null, [[a, '2'], [b, '1']], { data: { name: 'Kit sintético', suppliers: supplierOf('0') } })).record;
  return { supplier, a, b, kit };
}
const adjust = (f, items, rule, command = randomUUID()) => f.rpc('erp_catalog_product_price_adjust', { p_user_id: f.users.admin, p_command_id: command, p_rule: rule, p_items: items, p_filters: null });

test('235 functions keep the published permissions and run only for service_role', async () => {
  const f = await produtosEFixture();
  try {
    for (const signature of ['public.erp_catalog_product_price_adjust(uuid,uuid,jsonb,jsonb,jsonb)', 'public.erp_catalog_product_prices_update(uuid,uuid,uuid,jsonb)', 'public.erp_catalog_save(uuid,text,uuid,integer,uuid,jsonb)',
      'public.erp_catalog_custom_fields_screen(uuid)', 'public.erp_catalog_custom_field_save(uuid,uuid,integer,uuid,jsonb)', 'public.erp_catalog_custom_field_delete(uuid,uuid,integer,uuid)']) {
      for (const role of ['public', 'anon', 'authenticated']) assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`, [signature]), false, `${role} ${signature}`);
      assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [signature]), true);
      assert.deepEqual(await f.scalar("select jsonb_build_object('definer',prosecdef,'config',proconfig) v from pg_proc where oid=$1::regprocedure", [signature]), { definer: true, config: ['search_path=pg_catalog'] });
    }
    for (const internal of ['erp_catalog.composition_sync(uuid,uuid,uuid[])', 'erp_catalog.composition_kits(uuid[])', 'erp_catalog.custom_field_permitted(uuid,text)'])
      assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [internal]), false, internal);
  } finally { await f.close(); }
});

test('235 without the composition preferences nothing changes in the compositions', async () => {
  const f = await produtosEFixture();
  try {
    const { a, kit } = await kitScene(f);
    const before = { version: await f.version(kit.id), price: await priceOf(f, kit.id) };
    await adjust(f, [{ id: a.id, expected_version: await f.version(a.id) }], { action: 'fix', unit: 'amount', value: '20' });
    assert.deepEqual({ version: await f.version(kit.id), price: await priceOf(f, kit.id) }, before);
  } finally { await f.close(); }
});

test('235 Reajuste: the compositions of the adjusted components follow, with their version and audit; the replay applies nothing again', async () => {
  const f = await produtosEFixture();
  try {
    const { a, kit } = await kitScene(f);
    await f.preferences('cadastros-produtos', SETTINGS);
    const kitVersion = await f.version(kit.id), command = randomUUID(), items = [{ id: a.id, expected_version: await f.version(a.id) }];
    const result = await adjust(f, items, { action: 'fix', unit: 'amount', value: '20' }, command);
    assert.deepEqual([result.applied, result.replayed], [1, false]);
    assert.equal(await priceOf(f, a.id), '20.00');
    assert.equal(await priceOf(f, kit.id), '43.00', 'Kit = 2 × 20 + 1 × 3');
    assert.ok(await f.version(kit.id) > kitVersion);
    assert.equal(await f.scalar("select count(*)::int v from erp_catalog.audit where record_id=$1 and action='update' and after_data->>'price' is not null", [kit.id]) >= 1, true);
    const settled = await f.version(kit.id);
    const replay = await adjust(f, items, { action: 'fix', unit: 'amount', value: '20' }, command);
    assert.deepEqual([replay.replayed, replay.applied], [true, 1]);
    assert.equal(await f.version(kit.id), settled, 'a replay never recalculates again');
    // A composition adjusted by the same command keeps the value of the command.
    const both = await adjust(f, [{ id: a.id, expected_version: await f.version(a.id) }, { id: kit.id, expected_version: await f.version(kit.id) }], { action: 'fix', unit: 'amount', value: '99' });
    assert.equal(both.applied, 2);
    assert.deepEqual([await priceOf(f, a.id), await priceOf(f, kit.id)], ['99.00', '99.00']);
    // "Produtos filtrados" (the whole filtered set) follows the same rule.
    const filtered = await f.rpc('erp_catalog_product_price_adjust', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_rule: { action: 'fix', unit: 'amount', value: '5' }, p_items: null,
      p_filters: { situation: 'latest', query: 'Componente A' } });
    assert.equal(filtered.applied, 1);
    assert.equal(await priceOf(f, kit.id), '13.00', 'Kit = 2 × 5 + 1 × 3');
  } finally { await f.close(); }
});

test('235 Formação de preços da nota de entrada: the price and the supplier cost of a component recalculate its compositions', async () => {
  const f = await produtosEFixture();
  try {
    const { supplier, a, b, kit } = await kitScene(f);
    await f.preferences('cadastros-produtos', SETTINGS);
    const updated = await f.rpc('erp_catalog_product_prices_update', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_supplier_id: supplier.id,
      p_items: [{ product_id: a.id, expected_version: await f.version(a.id), price: '12', cost_price: '7' }] });
    assert.equal(updated.items[0].version, (await f.version(a.id)), 'the answer keeps the exact version of the product of the note');
    assert.equal(await priceOf(f, kit.id), '27.00', 'Kit price = 2 × 12 + 3');
    assert.equal(await costOf(f, kit.id), '15.00', 'Kit cost = 2 × 7 + 1 × 1 (default supplier)');
    // The composition itself in the note keeps the price of the note.
    await f.rpc('erp_catalog_product_prices_update', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_supplier_id: null,
      p_items: [{ product_id: b.id, expected_version: await f.version(b.id), price: '4' }, { product_id: kit.id, expected_version: await f.version(kit.id), price: '100' }] });
    assert.equal(await priceOf(f, kit.id), '100.00');
  } finally { await f.close(); }
});

test('235 preço na linha (erp_catalog_save): a component price recalculates its compositions; other entities and new products are untouched', async () => {
  const f = await produtosEFixture();
  try {
    const { a, kit } = await kitScene(f);
    await f.preferences('cadastros-produtos', SETTINGS);
    const command = randomUUID();
    const versionA = await f.version(a.id);
    const saved = await f.rpc('erp_catalog_save', { p_user_id: f.users.estoque, p_entity: 'products', p_id: a.id, p_expected_version: versionA, p_command_id: command, p_data: { price: '30' } });
    assert.equal(saved.replayed, false);
    assert.equal(await priceOf(f, kit.id), '63.00', 'Kit = 2 × 30 + 3');
    const settled = await f.version(kit.id);
    const replay = await f.rpc('erp_catalog_save', { p_user_id: f.users.estoque, p_entity: 'products', p_id: a.id, p_expected_version: versionA, p_command_id: command, p_data: { price: '30' } });
    assert.deepEqual([replay.replayed, await f.version(kit.id)], [true, settled]);
    // Vendas does not write products: refused before any lock or recalculation.
    await fails(assert, f.rpc('erp_catalog_save', { p_user_id: f.users.vendas, p_entity: 'products', p_id: a.id, p_expected_version: await f.version(a.id), p_command_id: randomUUID(), p_data: { price: '1' } }), '42501');
    const created = await f.rpc('erp_catalog_save', { p_user_id: f.users.admin, p_entity: 'products', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: 'Novo sintético', price: '1' } });
    assert.equal(created.replayed, false);
    assert.equal(await f.version(kit.id), settled);
  } finally { await f.close(); }
});

test('235 Campos Customizados: the screen, Inclusão e edição and Exclusão follow Sistema › Usuários › Permissões', async () => {
  const f = await produtosEFixture();
  try {
    const restrict = async (user, permissions) => {
      const current = (await f.scalar('select version v from erp_access.user_control where user_id=$1', [user])) ?? 0;
      return f.rpc('erp_access_user_controls_save', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_target: user, p_expected_version: current,
        p_data: { user_type: 'normal', schedule: { enabled: false, windows: [] }, permissions } });
    };
    const screen = user => f.rpc('erp_catalog_custom_fields_screen', { p_user_id: user });
    const save = (user, data, id = null, version = 0) => f.rpc('erp_catalog_custom_field_save', { p_user_id: user, p_id: id, p_expected_version: version, p_command_id: randomUUID(), p_data: data });
    // Without a saved set the profile decides: estoque writes products, consulta only reads.
    assert.deepEqual((await screen(f.users.estoque)).permissions, { insert_edit: true, delete: true });
    assert.deepEqual((await screen(f.users.consulta)).permissions, { insert_edit: false, delete: false });
    await fails(assert, screen(f.users.financeiro), '42501');
    const field = (await save(f.users.estoque, { field_type: 'text', name: 'Cor sintética' })).field;
    // Products only: no access to the screen, the writes are refused, the product form keeps reading the fields.
    await restrict(f.users.estoque, ['cadastros.produtos', 'cadastros.produtos.ie']);
    await fails(assert, screen(f.users.estoque), '42501');
    await fails(assert, save(f.users.estoque, { active: false }, field.id, field.version), '42501');
    await fails(assert, f.rpc('erp_catalog_custom_field_delete', { p_user_id: f.users.estoque, p_id: field.id, p_expected_version: field.version, p_command_id: randomUUID() }), '42501');
    assert.equal((await f.rpc('erp_catalog_custom_fields', { p_user_id: f.users.estoque, p_module: 'products' })).items.length, 1, 'the product form still reads the definitions');
    // The module and Produtos: the screen reads, nothing is written.
    await restrict(f.users.estoque, ['preferencias.campos_customizados', 'preferencias.campos_customizados.produtos']);
    assert.deepEqual((await screen(f.users.estoque)).permissions, { insert_edit: false, delete: false });
    await fails(assert, save(f.users.estoque, { active: false }, field.id, field.version), '42501');
    // "Inclusão e edição" without "Produtos" is still refused (the Produtos tab is the module of these fields).
    await restrict(f.users.estoque, ['preferencias.campos_customizados', 'preferencias.campos_customizados.ie']);
    await fails(assert, screen(f.users.estoque), '42501');
    await fails(assert, save(f.users.estoque, { active: false }, field.id, field.version), '42501');
    // Inclusão e edição: save works, delete does not.
    await restrict(f.users.estoque, ['preferencias.campos_customizados', 'preferencias.campos_customizados.ie', 'preferencias.campos_customizados.produtos']);
    assert.deepEqual((await screen(f.users.estoque)).permissions, { insert_edit: true, delete: false });
    const edited = (await save(f.users.estoque, { active: false }, field.id, field.version)).field;
    await fails(assert, f.rpc('erp_catalog_custom_field_delete', { p_user_id: f.users.estoque, p_id: field.id, p_expected_version: edited.version, p_command_id: randomUUID() }), '42501');
    // The category form links fields only with Inclusão e edição.
    const category = (await f.taxonomySave('categories', { name: 'Categoria sintética' }, { user: f.users.estoque })).item;
    await restrict(f.users.estoque, ['preferencias.campos_customizados', 'preferencias.campos_customizados.ex', 'preferencias.campos_customizados.produtos']);
    await fails(assert, f.taxonomySave('categories', { name: 'Categoria sintética', custom_field_ids: [field.id] }, { user: f.users.estoque, id: category.id, version: category.version }), '42501');
    assert.equal((await f.taxonomySave('categories', { name: 'Categoria renomeada sintética' }, { user: f.users.estoque, id: category.id, version: category.version })).saved, true, 'renaming needs no custom field permission');
    // Exclusão: delete works.
    const deleted = await f.rpc('erp_catalog_custom_field_delete', { p_user_id: f.users.estoque, p_id: field.id, p_expected_version: edited.version, p_command_id: randomUUID() });
    assert.equal(deleted.deleted, true);
    // The administrador always has everything; consulta never writes whatever the set says.
    assert.deepEqual((await screen(f.users.admin)).permissions, { insert_edit: true, delete: true });
  } finally { await f.close(); }
});
