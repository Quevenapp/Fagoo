import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { produtosFixture, fails } from './helpers/produtos-c-fixture.mjs';

// Campos customizados de produtos (migration 156): definições, Situação, exclusão recusada com valores, Agrupador por
// categoria (com subcategorias), valores no formulário do produto (mesmo comando, versão e auditoria) e a categoria com os
// campos aplicáveis. PGlite, dados sintéticos.
const RPCS = ['erp_catalog_custom_fields', 'erp_catalog_custom_field_save', 'erp_catalog_custom_field_delete', 'erp_catalog_product_save', 'erp_catalog_taxonomy_save'];

function tools(f) {
  const save = (data, { id = null, version = 0, user = f.users.admin, command = randomUUID() } = {}) => f.rpc('erp_catalog_custom_field_save', { p_user_id: user, p_id: id, p_expected_version: version, p_command_id: command, p_data: data });
  const remove = (field, { user = f.users.admin, command = randomUUID(), version = field.version } = {}) => f.rpc('erp_catalog_custom_field_delete', { p_user_id: user, p_id: field.id, p_expected_version: version, p_command_id: command });
  const list = (user = f.users.admin) => f.rpc('erp_catalog_custom_fields', { p_user_id: user, p_module: 'products' });
  const productSave = (record, data, { command = randomUUID() } = {}) => f.rpc('erp_catalog_product_save', { p_user_id: f.users.admin, p_id: record.id, p_expected_version: record.version, p_command_id: command, p_data: data, p_acknowledged: null });
  const category = async (name, parent = null) => (await f.taxonomySave('categories', { name, ...(parent ? { parent_id: parent } : {}) })).item;
  return { save, remove, list, productSave, category };
}

test('156 grants: SECURITY DEFINER, fixed search_path, service_role only', async () => {
  const f = await produtosFixture();
  try {
    for (const name of RPCS) {
      const rows = await f.rows(`select p.prosecdef d,p.proconfig c,has_function_privilege('anon',p.oid,'execute') a,has_function_privilege('authenticated',p.oid,'execute') u,has_function_privilege('service_role',p.oid,'execute') s
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [name]);
      assert.deepEqual([rows.length, rows[0].d, rows[0].c, rows[0].a, rows[0].u, rows[0].s], [1, true, ['search_path=pg_catalog'], false, false, true], name);
    }
    for (const table of ['custom_field', 'custom_field_option', 'custom_field_category', 'product_custom_value', 'custom_field_audit'])
      assert.equal(await f.scalar(`select has_table_privilege('service_role','erp_catalog.${table}','select') v`), false, table);
  } finally { await f.close(); }
});

test('156 definitions: create, list, duplicate name, fixed type, limits, permissions, replay, Situação and delete', async () => {
  const f = await produtosFixture(); const t = tools(f);
  try {
    const command = randomUUID();
    const created = await t.save({ field_type: 'integer', name: ' Voltagem ', hint: 'Ex.: 220', info: 'Tensão de trabalho', required: false, min_length: 1, max_length: 4, width: 'small' }, { command });
    assert.equal(created.saved, true);
    const field = created.field;
    assert.deepEqual([field.name, field.field_type, field.hint, field.info, field.min_length, field.max_length, field.width, field.grouped, field.active, field.version, field.options, field.category_ids, field.products],
      ['Voltagem', 'integer', 'Ex.: 220', 'Tensão de trabalho', 1, 4, 'small', false, true, 1, [], [], 0]);
    assert.equal((await t.save({ field_type: 'integer', name: ' Voltagem ', hint: 'Ex.: 220', info: 'Tensão de trabalho', required: false, min_length: 1, max_length: 4, width: 'small' }, { command })).replayed, true);
    await fails(assert, t.save({ field_type: 'integer', name: 'Outro' }, { command }), '40001');
    assert.deepEqual(await t.save({ field_type: 'text', name: 'VOLTÁGEM' }), { saved: false, reason: 'duplicate_name', replayed: false, data_mode: 'erp_native' });
    await fails(assert, t.save({ field_type: 'decimal' }, { id: field.id, version: 1 }), '22023');
    await fails(assert, t.save({ field_type: 'boolean', name: 'Lógico', min_length: 2 }), '22023');
    await fails(assert, t.save({ field_type: 'text', name: 'Faixa', min_length: 10, max_length: 5 }), '22023');
    await fails(assert, t.save({ field_type: 'text', name: 'Grande', max_length: 256 }), '22023');
    await fails(assert, t.save({ field_type: 'text', name: 'Opções', options: [{ label: 'A' }] }), '22023');
    await fails(assert, t.save({ field_type: 'list', name: 'Sem opções', options: [] }), '22023');
    await fails(assert, t.save({ field_type: 'list', name: 'Repetida', options: [{ label: 'Azul' }, { label: 'azul' }] }), '22023');
    await fails(assert, t.save({ field_type: 'text', name: 'Desconhecida', color: 'x' }), '22023');
    await fails(assert, t.save({ field_type: 'text', name: 'Consulta' }, { user: f.users.consulta }), '42501');
    assert.equal((await t.list(f.users.consulta)).items.length, 1, 'consulta reads the definitions');
    await fails(assert, f.rpc('erp_catalog_custom_fields', { p_user_id: f.users.admin, p_module: 'contacts' }), '22023');
    await fails(assert, t.save({ name: 'Velha' }, { id: field.id, version: 9 }), '40001');
    const inactive = await t.save({ active: false }, { id: field.id, version: 1 });
    assert.deepEqual([inactive.field.active, inactive.field.version], [false, 2]);
    const same = await t.save({ active: false, name: 'Voltagem' }, { id: field.id, version: 2 });
    assert.equal(same.field.version, 2, 'nothing changed: same version');
    assert.deepEqual((await f.rows('select action from erp_catalog.custom_field_audit where field_id=$1 order by id', [field.id])).map(row => row.action), ['create', 'update']);
    for (let i = 1; i < 60; i++) assert.equal((await t.save({ field_type: 'text', name: `Campo ${i}` })).saved, true);
    assert.deepEqual(await t.save({ field_type: 'text', name: 'Campo 61' }), { saved: false, reason: 'limit', replayed: false, data_mode: 'erp_native' });
    const deleted = await t.remove({ id: field.id, version: 2 });
    assert.deepEqual([deleted.deleted, deleted.products], [true, 0]);
    assert.equal(await f.scalar('select count(*)::int v from erp_catalog.custom_field where id=$1', [field.id]), 0);
    await fails(assert, t.remove({ id: field.id, version: 2 }), 'P0002');
  } finally { await f.close(); }
});

test('156 product values: canonical values by type, lengths, list options by id, required, inactive and in-use refusals', async () => {
  const f = await produtosFixture(); const t = tools(f);
  try {
    const integer = (await t.save({ field_type: 'integer', name: 'Garantia', min_length: 1, max_length: 3 })).field;
    const decimal = (await t.save({ field_type: 'decimal', name: 'Fator' })).field;
    const text = (await t.save({ field_type: 'text', name: 'Material', min_length: 3 })).field;
    const long = (await t.save({ field_type: 'long_text', name: 'Montagem' })).field;
    const flag = (await t.save({ field_type: 'boolean', name: 'Importado' })).field;
    const date = (await t.save({ field_type: 'date', name: 'Lançamento' })).field;
    const list = (await t.save({ field_type: 'list', name: 'Cor', options: [{ label: 'Azul' }, { label: 'Verde' }] })).field;
    const [azul, verde] = list.options;
    let product = await f.product({ name: 'Mesa' });
    const command = randomUUID();
    let saved = await t.productSave(product, { custom_values: { [integer.id]: '12', [decimal.id]: '1.50', [text.id]: '  Aço  ', [long.id]: 'Linha 1\nLinha 2', [flag.id]: 'true', [date.id]: '2026-10-20', [list.id]: azul.id.toUpperCase() } }, { command });
    assert.deepEqual(saved.record.custom_values, { [integer.id]: '12', [decimal.id]: '1.5', [text.id]: 'Aço', [long.id]: 'Linha 1\nLinha 2', [flag.id]: 'true', [date.id]: '2026-10-20', [list.id]: azul.id });
    assert.equal(saved.record.version, product.version + 1);
    assert.equal((await t.productSave(product, { custom_values: { [integer.id]: '12', [decimal.id]: '1.50', [text.id]: '  Aço  ', [long.id]: 'Linha 1\nLinha 2', [flag.id]: 'true', [date.id]: '2026-10-20', [list.id]: azul.id.toUpperCase() } }, { command })).replayed, true);
    product = saved.record;
    const audit = await f.rows("select before_data->'custom_values' b,after_data->'custom_values' a from erp_catalog.audit where record_id=$1 and action='update' order by id desc limit 1", [product.id]);
    assert.deepEqual([audit[0].b, audit[0].a[integer.id]], [{}, '12']);
    for (const [field, value] of [[integer, '1234'], [integer, '-0'], [integer, '1.5'], [decimal, '1,5'], [decimal, '1.1234567'], [text, 'ab'], [text, 'a\tb c'], [flag, 'sim'], [date, '2026-02-30'], [list, randomUUID()]])
      await fails(assert, t.productSave(product, { custom_values: { [field.id]: value } }), '22023');
    await fails(assert, t.productSave(product, { custom_values: { [randomUUID()]: '1' } }), '22023');
    await fails(assert, t.productSave(product, { custom_values: [] }), '22023');
    const unchanged = await t.productSave(product, { custom_values: { [decimal.id]: '1.5000' } });
    assert.equal(unchanged.record.version, product.version, 'the same canonical value changes nothing');
    saved = await t.productSave(product, { custom_values: { [text.id]: '', [flag.id]: null } });
    assert.deepEqual([Object.hasOwn(saved.record.custom_values, text.id), Object.hasOwn(saved.record.custom_values, flag.id), saved.record.custom_values[integer.id]], [false, false, '12'], 'empty and null clear; absent keys stay');
    product = saved.record;
    // Renaming and reordering options keeps the stored id; removing an option in use is refused.
    const renamed = await t.save({ options: [{ id: verde.id, label: 'Verde-musgo' }, { id: azul.id, label: 'Azul-marinho' }, { label: 'Branco' }] }, { id: list.id, version: list.version });
    assert.deepEqual(renamed.field.options.map(option => option.label), ['Verde-musgo', 'Azul-marinho', 'Branco']);
    assert.equal(renamed.field.options[1].id, azul.id);
    assert.deepEqual(await t.save({ options: [{ id: verde.id, label: 'Verde' }] }, { id: list.id, version: renamed.field.version }), { saved: false, reason: 'option_in_use', products: 1, replayed: false, data_mode: 'erp_native' });
    await fails(assert, t.save({ options: [{ id: randomUUID(), label: 'Outra' }] }, { id: list.id, version: renamed.field.version }), '22023');
    // In use: the field cannot be deleted; inactive, an unchanged value is kept and a new one is refused.
    assert.deepEqual(await t.remove(renamed.field), { id: list.id, deleted: false, reason: 'in_use', products: 1, replayed: false, data_mode: 'erp_native' });
    const off = (await t.save({ active: false }, { id: integer.id, version: integer.version })).field;
    assert.equal((await t.productSave(product, { custom_values: { [integer.id]: '12' } })).record.version, product.version);
    await fails(assert, t.productSave(product, { custom_values: { [integer.id]: '13' } }), '22023');
    saved = await t.productSave(product, { custom_values: { [integer.id]: null } });
    assert.equal(Object.hasOwn(saved.record.custom_values, integer.id), false, 'an inactive value can still be cleared');
    product = saved.record;
    assert.equal((await t.remove(off)).deleted, true, 'no value left: deleted');
    // Required: enforced when the form sends custom_values, not on other saves.
    const required = (await t.save({ field_type: 'text', name: 'Modelo', required: true })).field;
    await fails(assert, t.productSave(product, { custom_values: {} }), '22023');
    assert.equal((await t.productSave(product, { name: 'Mesa grande' })).record.name, 'Mesa grande');
    product = (await f.rpc('erp_catalog_product_get', { p_user_id: f.users.admin, p_id: product.id })).record;
    assert.equal((await t.productSave(product, { custom_values: { [required.id]: 'M-1' } })).record.custom_values[required.id], 'M-1');
    await fails(assert, f.rpc('erp_catalog_product_save', { p_user_id: f.users.admin, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: 'Nova', kind: 'P', format: 'S', unit: 'UN', custom_values: {} }, p_acknowledged: null }), '22023');
    const created = await f.rpc('erp_catalog_product_save', { p_user_id: f.users.admin, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: 'Nova', kind: 'P', format: 'S', unit: 'UN', custom_values: { [required.id]: 'N-1' } }, p_acknowledged: null });
    assert.deepEqual(created.record.custom_values, { [required.id]: 'N-1' });
    const exported = await f.rpc('erp_catalog_product_export', { p_user_id: f.users.consulta, p_offset: 0, p_limit: 10 });
    assert.deepEqual(exported.items.find(item => item.id === created.record.id).custom_values, { [required.id]: 'N-1' });
  } finally { await f.close(); }
});

test('156 Agrupador: grouped fields follow the category and its subcategories; a category change removes them; the category form links fields', async () => {
  const f = await produtosFixture(); const t = tools(f);
  try {
    const tools_ = await t.category('Ferramentas'), drills = await t.category('Furadeiras', tools_.id), food = await t.category('Alimentos');
    const power = (await t.save({ field_type: 'integer', name: 'Potência', grouped: true, category_ids: [tools_.id] })).field;
    const common = (await t.save({ field_type: 'text', name: 'Origem do lote' })).field;
    assert.deepEqual(power.category_ids, [tools_.id]);
    await fails(assert, t.save({ field_type: 'text', name: 'Solto', grouped: false, category_ids: [tools_.id] }), '22023');
    await fails(assert, t.save({ field_type: 'text', name: 'Tag', grouped: true, category_ids: [(await f.taxonomySave('tag_groups', { name: 'Grupo' })).item.id] }), '22023');
    let product = await f.product({ name: 'Furadeira 500W' });
    await fails(assert, t.productSave(product, { category_id: food.id, custom_values: { [power.id]: '500' } }), '22023');
    let saved = await t.productSave(product, { category_id: drills.id, custom_values: { [power.id]: '500', [common.id]: 'Lote A' } });
    assert.deepEqual(saved.record.custom_values, { [power.id]: '500', [common.id]: 'Lote A' }, 'a subcategory inherits the grouped field');
    product = saved.record;
    saved = await t.productSave(product, { category_id: food.id });
    assert.deepEqual(saved.record.custom_values, { [common.id]: 'Lote A' }, 'changing the category removes the grouped values that no longer apply');
    assert.equal(saved.record.version, product.version + 1);
    product = saved.record;
    // Category form: "Campos customizáveis aplicáveis nesta categoria" in the same command as the category.
    const command = randomUUID();
    const linked = await f.taxonomySave('categories', { name: 'Alimentos', custom_field_ids: [power.id, common.id] }, { id: food.id, version: food.version, command });
    assert.equal(linked.saved, true);
    assert.equal((await f.taxonomySave('categories', { name: 'Alimentos', custom_field_ids: [power.id, common.id] }, { id: food.id, version: food.version, command })).replayed, true);
    let fields = (await t.list()).items;
    const byId = id => fields.find(item => item.id === id);
    assert.deepEqual([byId(power.id).category_ids.sort(), byId(power.id).version], [[tools_.id, food.id].sort(), power.version + 1]);
    assert.deepEqual([byId(common.id).grouped, byId(common.id).category_ids], [true, [food.id]], 'a field without Agrupador becomes grouped in the linked categories');
    assert.deepEqual((await f.rows("select action from erp_catalog.custom_field_audit where field_id=$1 order by id", [power.id])).map(row => row.action), ['create', 'categories']);
    assert.equal((await t.productSave(product, { custom_values: { [power.id]: '200' } })).record.custom_values[power.id], '200');
    // The links are part of the category form: a change gives the category a new version, so a form opened before conflicts.
    assert.equal(linked.item.version, food.version + 1);
    await fails(assert, f.taxonomySave('categories', { name: 'Alimentos', custom_field_ids: [common.id] }, { id: food.id, version: food.version }), '40001');
    let current = (await f.taxonomySave('categories', { name: 'Alimentos', custom_field_ids: [common.id] }, { id: food.id, version: linked.item.version })).item;
    fields = (await t.list()).items;
    assert.deepEqual(byId(power.id).category_ids, [tools_.id]);
    await fails(assert, f.taxonomySave('categories', { name: 'Alimentos', custom_field_ids: [randomUUID()] }, { id: food.id, version: current.version }), '22023');
    // The field drawer changing the Agrupador also gives the categories gained or lost a new version (with audit).
    const categoryVersions = async () => Object.fromEntries((await f.taxonomy('categories')).items.map(item => [item.id, item.version]));
    const before = await categoryVersions();
    assert.equal(before[tools_.id], tools_.version + 1, 'creating a grouped field also versions its categories');
    const regrouped = (await t.save({ grouped: true, category_ids: [tools_.id, food.id] }, { id: power.id, version: byId(power.id).version })).field;
    const versions = await categoryVersions();
    assert.deepEqual([versions[food.id], versions[tools_.id]], [current.version + 1, before[tools_.id]], 'only the category that gained the field changes');
    await fails(assert, f.taxonomySave('categories', { name: 'Alimentos', custom_field_ids: [common.id] }, { id: food.id, version: current.version }), '40001');
    assert.deepEqual(regrouped.category_ids.sort(), [tools_.id, food.id].sort(), 'the stale category form did not undo the drawer');
    current = (await f.taxonomySave('categories', { name: 'Alimentos', custom_field_ids: [common.id] }, { id: food.id, version: versions[food.id] })).item;
    assert.equal(current.version, versions[food.id] + 1);
    assert.equal(await f.scalar("select count(*)::int v from erp_catalog.taxonomy_audit where item_id=$1 and action='update'", [food.id]), 4, 'one audit row per command that changed the links');
    await fails(assert, f.taxonomySave('tags', { name: 'Promo', custom_field_ids: [] }), '22023');
    const created = await f.taxonomySave('categories', { name: 'Bebidas', custom_field_ids: [power.id] });
    fields = (await t.list()).items;
    assert.equal(byId(power.id).category_ids.includes(created.item.id), true, 'a new category links fields in its own command');
    // Deleting a category removes it from the Agrupador of the fields.
    await f.taxonomyDelete('categories', created.item.id, created.item.version);
    fields = (await t.list()).items;
    assert.equal(byId(power.id).category_ids.includes(created.item.id), false);
  } finally { await f.close(); }
});
