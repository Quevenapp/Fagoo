import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { produtosFixture, fails } from './helpers/produtos-c-fixture.mjs';

// Tags no padrão do Origin (migration 153): Tipo Produtos | Contatos nos grupos de tags e nas tags, as tags dos contatos com
// versão própria e os filtros Tags e Lista de preço da listagem de contatos. PGlite, dados sintéticos.
const PUBLIC = ['erp_catalog_contact_tags', 'erp_catalog_contact_tags_save', 'erp_catalog_contact_page_tagged', 'erp_catalog_contact_export_tagged',
  'erp_catalog_taxonomy_list', 'erp_catalog_taxonomy_save', 'erp_catalog_taxonomy_delete'];

test('153 grants: SECURITY DEFINER with a fixed search_path, only service_role executes', async () => {
  const f = await produtosFixture();
  try {
    for (const name of PUBLIC) {
      const rows = await f.rows(`select p.prosecdef d,p.proconfig c,has_function_privilege('anon',p.oid,'execute') a,has_function_privilege('authenticated',p.oid,'execute') u,
        has_function_privilege('service_role',p.oid,'execute') s from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [name]);
      assert.equal(rows.length, 1, name);
      assert.deepEqual([rows[0].d, rows[0].c, rows[0].a, rows[0].u, rows[0].s], [true, ['search_path=pg_catalog'], false, false, true], name);
    }
    for (const table of ['contact_tag', 'contact_tag_state'])
      assert.equal(await f.scalar(`select has_table_privilege('service_role','erp_catalog.${table}','select') v`), false, table);
  } finally { await f.close(); }
});

test('153 tag types: existing tags are Produtos, the type is chosen on inclusion, follows the group and never changes', async () => {
  const f = await produtosFixture();
  try {
    const legacy = await f.taxonomySave('tags', { name: 'Promoção' });
    assert.equal(legacy.item.tag_type, 'products', 'a body without tag_type keeps the 119 behavior');
    const contactsGroup = (await f.taxonomySave('tag_groups', { name: 'Clientes', tag_type: 'contacts' })).item;
    const inherited = (await f.taxonomySave('tags', { name: 'VIP', parent_id: contactsGroup.id })).item;
    assert.equal(inherited.tag_type, 'contacts', 'the tag of a group has the type of the group');
    assert.equal((await f.taxonomySave('tags', { name: 'VIP', tag_type: 'products' })).saved, true, 'the same name lives in another type');
    assert.deepEqual(await f.taxonomySave('tags', { name: 'vip', parent_id: contactsGroup.id }), { kind: 'tags', saved: false, reason: 'duplicate_name', replayed: false, data_mode: 'erp_native' });
    await fails(assert, f.taxonomySave('tags', { name: 'Errado', parent_id: contactsGroup.id, tag_type: 'products' }), '22023');
    await fails(assert, f.taxonomySave('tags', { name: 'Outro', id: inherited.id }, { id: inherited.id, version: 1 }), '22023');
    await fails(assert, f.taxonomySave('tags', { name: 'VIP 3', tag_type: 'products' }, { id: inherited.id, version: 1 }), '22023');
    const renamed = await f.taxonomySave('tags', { name: 'VIP Ouro' }, { id: inherited.id, version: 1 });
    assert.deepEqual([renamed.item.name, renamed.item.tag_type, renamed.item.version], ['VIP Ouro', 'contacts', 2]);
    await fails(assert, f.taxonomySave('categories', { name: 'Ferragens', tag_type: 'products' }), '22023');
    assert.equal((await f.taxonomySave('categories', { name: 'Ferragens' })).item.tag_type, null);
    // The database refuses a type change and a group of another type even outside the RPC.
    await assert.rejects(f.db.query(`update erp_catalog.taxonomy set tag_type='products' where id=$1`, [inherited.id]), error => error.message === 'erp_catalog_taxonomy_type_fixed');
  } finally { await f.close(); }
});

test('153 permissions by type: products roles see and write Produtos tags, contacts roles the Contatos tags', async () => {
  const f = await produtosFixture();
  try {
    const product = (await f.taxonomySave('tags', { name: 'Linha A', tag_type: 'products' })).item;
    const contact = (await f.taxonomySave('tags', { name: 'Atacadista', tag_type: 'contacts' })).item;
    const names = async user => (await f.taxonomy('tags', user)).items.map(item => item.name).sort();
    assert.deepEqual(await names(f.users.admin), ['Atacadista', 'Linha A']);
    assert.deepEqual(await names(f.users.financeiro), ['Atacadista'], 'financeiro reads contacts, not products');
    assert.deepEqual(await names(f.users.consulta), ['Atacadista', 'Linha A']);
    assert.equal((await f.taxonomySave('tags', { name: 'Inadimplente', tag_type: 'contacts' }, { user: f.users.financeiro })).saved, true);
    await fails(assert, f.taxonomySave('tags', { name: 'Linha B', tag_type: 'products' }, { user: f.users.financeiro }), '42501');
    await fails(assert, f.taxonomySave('tags', { name: 'Fornecedor A', tag_type: 'contacts' }, { user: f.users.estoque }), '42501');
    assert.equal((await f.taxonomySave('tags', { name: 'Linha C', tag_type: 'products' }, { user: f.users.estoque })).saved, true);
    await fails(assert, f.taxonomySave('tags', { name: 'Nada', tag_type: 'contacts' }, { user: f.users.consulta }), '42501');
    await fails(assert, f.taxonomyDelete('tags', product.id, 1, { user: f.users.financeiro }), '42501');
    await fails(assert, f.taxonomyDelete('tags', contact.id, 1, { user: f.users.estoque }), '42501');
    await fails(assert, f.taxonomy('tags', f.users.inactive), '42501');
    await fails(assert, f.taxonomy('categories', f.users.financeiro), '42501');
  } finally { await f.close(); }
});

test('153 the product form accepts only Produtos tags', async () => {
  const f = await produtosFixture();
  try {
    const contactTag = (await f.taxonomySave('tags', { name: 'VIP', tag_type: 'contacts' })).item;
    const productTag = (await f.taxonomySave('tags', { name: 'Promoção', tag_type: 'products' })).item;
    await fails(assert, f.product({ name: 'Parafuso', tag_ids: [contactTag.id] }), '22023');
    const saved = await f.product({ name: 'Parafuso', tag_ids: [productTag.id] });
    assert.deepEqual(saved.tag_ids, [productTag.id]);
    await assert.rejects(f.db.query('insert into erp_catalog.product_tag(record_id,tag_id) values($1,$2)', [saved.id, contactTag.id]), error => error.code === '23503');
  } finally { await f.close(); }
});

test('153 contact tags: replace with the version of the tag set, add without it, replay, conflicts and the contact version untouched', async () => {
  const f = await produtosFixture();
  try {
    const group = (await f.taxonomySave('tag_groups', { name: 'Segmento', tag_type: 'contacts' })).item;
    const a = (await f.taxonomySave('tags', { name: 'Atacado', parent_id: group.id })).item;
    const b = (await f.taxonomySave('tags', { name: 'Varejo', tag_type: 'contacts' })).item;
    const productTag = (await f.taxonomySave('tags', { name: 'Promoção', tag_type: 'products' })).item;
    const contact = await f.contact({ name: 'Cliente Sintético' });
    const save = (args, user = f.users.admin) => f.rpc('erp_catalog_contact_tags_save', { p_user_id: user, p_id: contact.id, p_expected_version: 0, p_command_id: randomUUID(), p_tag_ids: [], p_mode: 'replace', ...args });
    const command = randomUUID();
    const first = await save({ p_command_id: command, p_tag_ids: [a.id] });
    assert.deepEqual([first.changed, first.contact.version, first.contact.tag_ids, first.contact.tags[0].group_name], [true, 1, [a.id], 'Segmento']);
    assert.equal((await save({ p_command_id: command, p_tag_ids: [a.id] })).replayed, true, 'the same command answers the stored result');
    await fails(assert, save({ p_command_id: command, p_tag_ids: [b.id] }), '40001');
    await fails(assert, save({ p_tag_ids: [b.id] }), '40001');
    await fails(assert, save({ p_expected_version: 1, p_tag_ids: [productTag.id] }), '22023');
    const added = await save({ p_mode: 'add', p_expected_version: null, p_tag_ids: [b.id] });
    assert.deepEqual([added.changed, added.contact.version, added.contact.tag_ids.length], [true, 2, 2]);
    const again = await save({ p_mode: 'add', p_expected_version: null, p_tag_ids: [b.id] });
    assert.deepEqual([again.changed, again.contact.version], [false, 2], 'adding a tag it has changes nothing');
    await fails(assert, save({ p_mode: 'add', p_expected_version: 2, p_tag_ids: [b.id] }), '22023');
    await fails(assert, save({ p_mode: 'add', p_expected_version: null, p_tag_ids: [] }), '22023');
    const cleared = await save({ p_expected_version: 2, p_tag_ids: [] });
    assert.deepEqual([cleared.contact.version, cleared.contact.tag_ids], [3, []]);
    assert.equal((await f.rpc('erp_catalog_contact_get', { p_user_id: f.users.admin, p_id: contact.id })).record.version, contact.version, 'the contact form version did not change');
    assert.deepEqual((await f.rows("select action from erp_catalog.audit where entity='contacts' and record_id=$1 and action like 'tags%' order by id", [contact.id])).map(row => row.action), ['tags_update', 'tags_added', 'tags_update']);
    await fails(assert, save({ p_expected_version: 3, p_tag_ids: [a.id] }, f.users.consulta), '42501');
    await fails(assert, save({ p_expected_version: 3, p_tag_ids: [a.id] }, f.users.estoque), '42501');
    // Excluído is read-only.
    const situation = await f.rpc('erp_catalog_contact_set_situation', { p_user_id: f.users.admin, p_id: contact.id, p_expected_version: contact.version, p_command_id: randomUUID(), p_situation: 'E' });
    assert.equal(situation.record.situation, 'E');
    await fails(assert, save({ p_expected_version: 3, p_tag_ids: [a.id] }), '22023');
  } finally { await f.close(); }
});

test('153 contact tags respect "Contato acessível somente ao vendedor vinculado"', async () => {
  const f = await produtosFixture();
  try {
    const tag = (await f.taxonomySave('tags', { name: 'VIP', tag_type: 'contacts' })).item;
    const sellerContact = await f.contact({ name: 'Vendedora Sintética' });
    const seller = await f.scalar('insert into erp_catalog.seller(contact_id,user_id,created_by,updated_by) values($1,$2,$3,$3) returning id v', [sellerContact.id, f.users.vendas, f.users.admin]);
    const mine = await f.contact({ name: 'Cliente da vendedora', seller_id: seller });
    const other = await f.contact({ name: 'Cliente de outro' });
    await f.preference('cadastros-contatos', 'contatos.acesso_vendedor', true);
    const list = await f.rpc('erp_catalog_contact_tags', { p_user_id: f.users.vendas, p_ids: [mine.id, other.id] });
    assert.deepEqual(list.items.map(item => item.contact_id), [mine.id]);
    await fails(assert, f.rpc('erp_catalog_contact_tags_save', { p_user_id: f.users.vendas, p_id: other.id, p_expected_version: 0, p_command_id: randomUUID(), p_tag_ids: [tag.id], p_mode: 'replace' }), '42501');
    const saved = await f.rpc('erp_catalog_contact_tags_save', { p_user_id: f.users.vendas, p_id: mine.id, p_expected_version: 0, p_command_id: randomUUID(), p_tag_ids: [tag.id], p_mode: 'replace' });
    assert.equal(saved.contact.version, 1);
    const page = await f.rpc('erp_catalog_contact_page_tagged', { p_user_id: f.users.vendas, p_situation: 'all', p_tag: 'none' });
    assert.deepEqual([page.scoped, page.items.map(item => item.name)], [true, []], 'the vendor only sees the own contacts, and this one has a tag');
    await fails(assert, f.rpc('erp_catalog_contact_tags', { p_user_id: f.users.vendas, p_ids: [mine.id, mine.id] }), '22023');
  } finally { await f.close(); }
});

test('153 tagged page and export: Tags (tag, Sem Tag) and Lista de preço (contact link or UF), same results as the contatos page otherwise', async () => {
  const f = await produtosFixture();
  try {
    const tag = (await f.taxonomySave('tags', { name: 'VIP', tag_type: 'contacts' })).item;
    const tagged = await f.contact({ name: 'Ana Atacado', state: 'SP', city: 'Campinas' });
    const plain = await f.contact({ name: 'Bruno Varejo', state: 'MG', city: 'Uberaba' });
    const third = await f.contact({ name: 'Carla Regional', state: 'SP', city: 'Santos' });
    await f.rpc('erp_catalog_contact_tags_save', { p_user_id: f.users.admin, p_id: tagged.id, p_expected_version: 0, p_command_id: randomUUID(), p_tag_ids: [tag.id], p_mode: 'replace' });
    const listSave = data => f.rpc('erp_pricing_list_save', { p_user_id: f.users.admin, p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
      p_data: { name: data.name, category: data.category, list_type: 'rates', factor: '5', factor_unit: 'percent', direction: 'discount', considers_datetime: false, starts_on: null, ends_on: null, start_time: null, end_time: null, contacts: data.contacts ?? [], regions: data.regions ?? [] } });
    const byContact = (await listSave({ name: 'Lista contato', category: 'contact', contacts: [plain.id] })).list;
    const byRegion = (await listSave({ name: 'Lista SP', category: 'region', regions: ['SP'] })).list;
    const names = async args => (await f.rpc('erp_catalog_contact_page_tagged', { p_user_id: f.users.admin, p_situation: 'all', p_sort: 'name_asc', ...args })).items.map(item => item.name);
    assert.deepEqual(await names({ p_tag: tag.id }), ['Ana Atacado']);
    assert.deepEqual(await names({ p_tag: 'none' }), ['Bruno Varejo', 'Carla Regional']);
    assert.deepEqual(await names({ p_price_list_id: byContact.id }), ['Bruno Varejo']);
    assert.deepEqual(await names({ p_price_list_id: byRegion.id }), ['Ana Atacado', 'Carla Regional']);
    assert.deepEqual(await names({ p_price_list_id: byRegion.id, p_tag: 'none', p_city: 'santos' }), ['Carla Regional']);
    const base = await f.rpc('erp_catalog_contact_page', { p_user_id: f.users.admin, p_situation: 'all', p_sort: 'name_asc' });
    const same = await f.rpc('erp_catalog_contact_page_tagged', { p_user_id: f.users.admin, p_situation: 'all', p_sort: 'name_asc' });
    assert.deepEqual(same, base, 'without the new filters the tagged page is the contatos page');
    const exported = await f.rpc('erp_catalog_contact_export_tagged', { p_user_id: f.users.admin, p_situation: 'all', p_sort: 'name_asc', p_tag: 'none' });
    assert.deepEqual([exported.total, exported.items.map(item => item.name)], [2, ['Bruno Varejo', 'Carla Regional']]);
    const baseExport = await f.rpc('erp_catalog_contact_export', { p_user_id: f.users.admin, p_situation: 'all', p_sort: 'name_asc' });
    const taggedExport = await f.rpc('erp_catalog_contact_export_tagged', { p_user_id: f.users.admin, p_situation: 'all', p_sort: 'name_asc' });
    assert.deepEqual(taggedExport, baseExport);
    await fails(assert, f.rpc('erp_catalog_contact_page_tagged', { p_user_id: f.users.admin, p_tag: 'VIP' }), '22023');
    await fails(assert, f.rpc('erp_catalog_contact_page_tagged', { p_user_id: f.users.inactive, p_tag: 'none' }), '42501');
    await fails(assert, f.rpc('erp_catalog_contact_export_tagged', { p_user_id: f.users.admin, p_price_list_id: 'x' }), '22P02');
  } finally { await f.close(); }
});

test('153 deleting a Contatos tag removes it from the contacts with a new version of their tags and an audit row', async () => {
  const f = await produtosFixture();
  try {
    const tag = (await f.taxonomySave('tags', { name: 'Temporária', tag_type: 'contacts' })).item;
    const keep = (await f.taxonomySave('tags', { name: 'Fixa', tag_type: 'contacts' })).item;
    const contact = await f.contact({ name: 'Cliente Sintético' });
    await f.rpc('erp_catalog_contact_tags_save', { p_user_id: f.users.admin, p_id: contact.id, p_expected_version: 0, p_command_id: randomUUID(), p_tag_ids: [tag.id, keep.id], p_mode: 'replace' });
    assert.equal((await f.taxonomy('tags')).items.find(item => item.id === tag.id).contacts, 1);
    const removed = await f.taxonomyDelete('tags', tag.id, 1);
    assert.deepEqual([removed.deleted, removed.products], [true, 1]);
    const after = (await f.rpc('erp_catalog_contact_tags', { p_user_id: f.users.admin, p_ids: [contact.id] })).items[0];
    assert.deepEqual([after.version, after.tag_ids], [2, [keep.id]]);
    assert.equal(await f.scalar("select count(*)::int v from erp_catalog.audit where record_id=$1 and action='tag_removed'", [contact.id]), 1);
  } finally { await f.close(); }
});
