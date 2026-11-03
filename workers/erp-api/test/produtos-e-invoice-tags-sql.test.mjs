import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { produtosEFixture, fails } from './helpers/produtos-e-fixture.mjs';

// SQL of the produtos lane, wave E, part 3 (migration 236): Marcadores (tags) of the notas fiscais. The Tipo "Notas fiscais" of
// the tags, the tag set of each note (Origin mirror and Brufap) with its version, command and audit, the removal of a tag and
// the Tags filter of the notes list, compared with the list of the notas lane. Synthetic data only.
const NEW = ['public.erp_catalog_invoice_tags(uuid,text,text,text[])', 'public.erp_catalog_invoice_tags_save(uuid,text,text,text,integer,uuid,jsonb,text)',
  'public.erp_catalog_invoice_list_tagged(uuid,text,text,text,integer,integer,text,text,text,date,date,text,uuid,text,text,text,text,text,text,text,text,integer,text,text,text,uuid,text)'];
async function scene(f) {
  await f.originNote('nfe', '7001', { tipo: 1, numero: '000101', serie: 1, dataEmissao: '2026-10-15 10:00:00', situacao: 5, valorNota: 100, contato: { nome: 'Cliente Alfa Sintético', numeroDocumento: '12345678000190', endereco: { uf: 'SP' } } });
  await f.originNote('nfe', '7002', { tipo: 1, numero: 102, serie: 1, dataEmissao: '2026-10-14 10:00:00', situacao: 5, valorNota: '20.50', contato: { nome: 'Cliente Beta Sintético', endereco: { uf: 'MG' } } });
  await f.originNote('nfe', '7003', { tipo: 1, numero: 103, serie: 2, dataEmissao: '2026-10-13 10:00:00', situacao: 2, valorNota: 7, contato: { nome: 'Cliente Gama Sintético', endereco: { uf: 'SP' } } });
  await f.originNote('nfe', '7004', { tipo: 0, numero: 55, serie: 1, dataEmissao: '2026-10-12 10:00:00', situacao: 5, valorNota: 300, contato: { nome: 'Fornecedor Delta Sintético' } });
  await f.originNote('nfce', '7101', { numero: 9, serie: 1, dataEmissao: '2026-10-10 12:00:00', situacao: 5, valorNota: 12.5, contato: { nome: 'Consumidor sintético' } });
  const group = (await f.taxonomySave('tag_groups', { name: 'Expedição sintética', tag_type: 'invoices' }, { user: f.users.fiscal })).item;
  const urgent = (await f.taxonomySave('tags', { name: 'Urgente', tag_type: 'invoices', parent_id: group.id }, { user: f.users.fiscal })).item;
  const review = (await f.taxonomySave('tags', { name: 'Conferir', tag_type: 'invoices' }, { user: f.users.fiscal })).item;
  const productTag = (await f.taxonomySave('tags', { name: 'Urgente', tag_type: 'products' })).item;
  return { group, urgent, review, productTag };
}
const save = (f, { origin = 'origin', model = '55', id, version = 0, tags, mode = 'replace', user = f.users.fiscal, command = randomUUID() }) =>
  f.rpc('erp_catalog_invoice_tags_save', { p_user_id: user, p_origin: origin, p_model: model, p_id: id, p_expected_version: mode === 'add' ? null : version, p_command_id: command, p_tag_ids: tags, p_mode: mode });
const read = (f, ids, { origin = 'origin', model = '55', user = f.users.consulta } = {}) => f.rpc('erp_catalog_invoice_tags', { p_user_id: user, p_origin: origin, p_model: model, p_ids: ids });
const list = (f, args = {}, user = f.users.consulta) => f.rpc('erp_fiscal_invoice_list', { p_user_id: user, ...args });
const tagged = (f, tag, args = {}, user = f.users.consulta) => f.rpc('erp_catalog_invoice_list_tagged', { p_user_id: user, ...args, p_tag: tag });
const ids = page => page.items.map(row => row.id);

test('236 functions are SECURITY DEFINER with a fixed search_path and run only for service_role', async () => {
  const f = await produtosEFixture();
  try {
    for (const signature of NEW) {
      for (const role of ['public', 'anon', 'authenticated']) assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`, [signature]), false, `${role} ${signature}`);
      assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [signature]), true);
      assert.deepEqual(await f.scalar("select jsonb_build_object('definer',prosecdef,'config',proconfig) v from pg_proc where oid=$1::regprocedure", [signature]), { definer: true, config: ['search_path=pg_catalog'] });
    }
    for (const table of ['invoice_tag', 'invoice_tag_state', 'invoice_tag_audit'])
      assert.equal(await f.scalar("select has_table_privilege('service_role',$1,'SELECT') v", [`erp_catalog.${table}`]), false, table);
  } finally { await f.close(); }
});

test('236 Tipo "Notas fiscais": read by the profiles of the notes, written by administrador and fiscal', async () => {
  const f = await produtosEFixture();
  try {
    const { group, urgent } = await scene(f);
    assert.deepEqual([group.tag_type, urgent.tag_type, urgent.invoices, group.invoices], ['invoices', 'invoices', 0, 0]);
    const kinds = async user => (await f.rpc('erp_catalog_taxonomy_list', { p_user_id: user, p_kind: 'tags' })).items.map(item => `${item.tag_type}:${item.name}`).sort();
    assert.deepEqual(await kinds(f.users.consulta), ['invoices:Conferir', 'invoices:Urgente', 'products:Urgente']);
    assert.deepEqual(await kinds(f.users.vendas), ['products:Urgente'], 'vendas does not read the notes');
    assert.equal((await f.rpc('erp_catalog_taxonomy_list', { p_user_id: f.users.consulta, p_kind: 'tags' })).items.find(item => item.tag_type === 'products').invoices, undefined, 'only Notas fiscais items count notes');
    await fails(assert, f.taxonomySave('tags', { name: 'Nova', tag_type: 'invoices' }, { user: f.users.consulta }), '42501');
    await fails(assert, f.taxonomySave('tags', { name: 'Nova', tag_type: 'invoices' }, { user: f.users.estoque }), '42501');
    // A tag of a Notas fiscais group is a Notas fiscais tag; the type never changes.
    await fails(assert, f.taxonomySave('tags', { name: 'Mista', tag_type: 'products', parent_id: group.id }), '22023');
    await fails(assert, f.taxonomySave('tags', { name: 'Urgente 2', tag_type: 'products' }, { user: f.users.fiscal, id: urgent.id, version: urgent.version }), '22023');
    assert.equal((await f.taxonomySave('tags', { name: 'Urgente!' }, { user: f.users.fiscal, id: urgent.id, version: urgent.version })).item.name, 'Urgente!');
  } finally { await f.close(); }
});

test('236 Editar tags of a note: version, idempotent command, audit, references and the profiles', async () => {
  const f = await produtosEFixture();
  try {
    const { urgent, review, productTag } = await scene(f);
    const command = randomUUID();
    const first = await save(f, { id: '7001', tags: [urgent.id, review.id], command });
    assert.deepEqual([first.changed, first.replayed, first.invoice.version, first.invoice.tag_ids.length, first.invoice.tags.map(t => t.name)], [true, false, 1, 2, ['Conferir', 'Urgente']]);
    assert.equal(first.invoice.tags.find(t => t.id === urgent.id).group_name, 'Expedição sintética');
    // "Conferir resultado": the same command answers the stored result.
    const again = await save(f, { id: '7001', tags: [urgent.id, review.id], command });
    assert.deepEqual([again.replayed, again.invoice.version], [true, 1]);
    await fails(assert, save(f, { id: '7001', tags: [urgent.id], command }), '40001');
    // A stale version is a conflict; the right one replaces the set.
    await fails(assert, save(f, { id: '7001', tags: [urgent.id], version: 0 }), '40001');
    const replaced = await save(f, { id: '7001', tags: [urgent.id], version: 1 });
    assert.deepEqual([replaced.invoice.version, replaced.invoice.tag_ids], [2, [urgent.id]]);
    const unchanged = await save(f, { id: '7001', tags: [urgent.id], version: 2 });
    assert.deepEqual([unchanged.changed, unchanged.invoice.version], [false, 2]);
    // Add mode never removes a tag.
    const added = await save(f, { id: '7001', tags: [review.id], mode: 'add' });
    assert.deepEqual([added.invoice.version, added.invoice.tag_ids.length], [3, 2]);
    assert.deepEqual(await f.rows('select action from erp_catalog.invoice_tag_audit where invoice_id=$1 order by id', ['7001']), [{ action: 'tags_update' }, { action: 'tags_update' }, { action: 'tags_added' }]);
    // Only tags of Notas fiscais; only notes that exist (Origin mirror of the same model, Brufap notes not deleted).
    await fails(assert, save(f, { id: '7002', tags: [productTag.id] }), '22023');
    await fails(assert, save(f, { id: '7002', tags: [randomUUID()] }), '22023');
    await fails(assert, save(f, { id: '9999', tags: [urgent.id] }), 'P0002');
    await fails(assert, save(f, { id: '7101', tags: [urgent.id] }), 'P0002');
    assert.equal((await save(f, { id: '7101', model: '65', tags: [urgent.id] })).invoice.version, 1, 'the NFC-e is the model 65 note');
    await fails(assert, save(f, { origin: 'brufap', id: randomUUID(), tags: [urgent.id] }), 'P0002');
    await fails(assert, save(f, { id: 'abc', tags: [urgent.id] }), '22023');
    await fails(assert, save(f, { origin: 'brufap', id: '7001', tags: [urgent.id] }), '22023');
    // Profiles: consulta reads, vendas and estoque do not see notes.
    await fails(assert, save(f, { id: '7002', tags: [urgent.id], user: f.users.consulta }), '42501');
    await fails(assert, read(f, ['7001'], { user: f.users.vendas }), '42501');
    await fails(assert, read(f, ['7001'], { origin: 'brufap', user: f.users.fiscal }), '22023');
    const page = await read(f, ['7002', '7001']);
    assert.deepEqual(page.items.map(item => [item.invoice_id, item.version, item.tag_ids.length]), [['7002', 0, 0], ['7001', 3, 2]]);
    await fails(assert, read(f, ['7001', '7001']), '22023');
    await fails(assert, read(f, Array.from({ length: 101 }, (_, n) => String(n + 1))), '22023');
    // The tag counts its notes.
    assert.equal((await f.rpc('erp_catalog_taxonomy_list', { p_user_id: f.users.consulta, p_kind: 'tags' })).items.find(item => item.id === urgent.id).invoices, 2);
  } finally { await f.close(); }
});

test('236 a Brufap note takes tags for administrador and fiscal; excluding a tag removes it from the notes with a new version', async () => {
  const f = await produtosEFixture();
  try {
    const { urgent, review } = await scene(f);
    const nature = (await f.rpc('erp_fiscal_nature_execute', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: 'create', p_data: { nature: { description: 'Venda sintética', direction: '1', crt: '1' } } })).nature;
    const client = await f.contact({ name: 'Cliente Nativo Sintético', document: '12345678000190' }), item = await f.product({ name: 'Peça sintética', price: '20' });
    const note = (await f.rpc('erp_fiscal_invoice_execute', { p_user_id: f.users.fiscal, p_command_id: randomUUID(), p_action: 'create', p_data: { invoice: { model: '55', direction: '1', issue_type: 'N', series: '2',
      nature_id: nature.id, issue_date: '2026-10-18', crt: '1', purpose: '1', presence: '1', final_consumer: false,
      recipient: { contact_id: client.id, name: 'Cliente Nativo Sintético', person_type: 'J', document: '12345678000190', state: 'RJ' },
      items: [{ product_id: item.id, description: 'Peça sintética', quantity: '1', unit_price: '20' }] } } })).invoice;
    const saved = await save(f, { origin: 'brufap', id: note.id, tags: [urgent.id, review.id] });
    assert.deepEqual([saved.origin, saved.invoice.invoice_id, saved.invoice.version], ['brufap', note.id, 1]);
    await fails(assert, save(f, { origin: 'brufap', model: '65', id: note.id, tags: [urgent.id] }), 'P0002');
    await fails(assert, read(f, [note.id], { origin: 'brufap', user: f.users.consulta }), '42501');
    assert.equal((await read(f, [note.id], { origin: 'brufap', user: f.users.fiscal })).items[0].tag_ids.length, 2);
    await save(f, { id: '7001', tags: [urgent.id] });
    // Excluding the tag (Preferências › Tags) takes it out of every note, each with a new version of its set and an audit row.
    const current = (await f.rpc('erp_catalog_taxonomy_list', { p_user_id: f.users.fiscal, p_kind: 'tags' })).items.find(row => row.id === urgent.id);
    const removed = await f.rpc('erp_catalog_taxonomy_delete', { p_user_id: f.users.fiscal, p_kind: 'tags', p_id: urgent.id, p_expected_version: current.version, p_command_id: randomUUID() });
    assert.deepEqual([removed.deleted, removed.products], [true, 2]);
    assert.deepEqual((await read(f, [note.id], { origin: 'brufap', user: f.users.fiscal })).items[0].tag_ids, [review.id]);
    assert.deepEqual((await read(f, ['7001'])).items[0], { invoice_id: '7001', version: 2, tag_ids: [], tags: [] });
    assert.equal(await f.scalar("select count(*)::int v from erp_catalog.invoice_tag_audit where action='tag_removed'"), 2);
    await fails(assert, f.rpc('erp_catalog_taxonomy_delete', { p_user_id: f.users.consulta, p_kind: 'tags', p_id: review.id, p_expected_version: review.version, p_command_id: randomUUID() }), '42501');
  } finally { await f.close(); }
});

test('236 filter Tags: the tagged list answers like the list of the notas lane, with the tag or Sem Tag', async () => {
  const f = await produtosEFixture();
  try {
    const { urgent, review } = await scene(f);
    // Without any tag, "Sem Tag" is exactly the list of the notas lane, for several filters.
    for (const args of [{}, { p_state: 'SP' }, { p_order: 'number_asc' }, { p_status: 'authorized' }, { p_query: 'Beta' }, { p_direction: '0' }, { p_model: '65' }, { p_limit: 1, p_page: 2 }, { p_date_from: '2026-10-14' }])
      assert.deepEqual(await tagged(f, 'none', args), await list(f, args), JSON.stringify(args));
    await save(f, { id: '7001', tags: [urgent.id] }); await save(f, { id: '7003', tags: [urgent.id, review.id] });
    assert.deepEqual(ids(await tagged(f, urgent.id)), ['7001', '7003']);
    assert.deepEqual(ids(await tagged(f, review.id)), ['7003']);
    assert.deepEqual(ids(await tagged(f, 'none')), ['7002']);
    const page = await tagged(f, urgent.id, { p_state: 'SP' });
    assert.deepEqual([page.total_count, page.total_amount, page.has_more], [2, '107.00', false]);
    assert.deepEqual(ids(await tagged(f, urgent.id, { p_model: '65' })), [], 'the NFC-e tags are their own');
    await fails(assert, tagged(f, 'x'), '22023');
    await fails(assert, tagged(f, null), '22023');
    await fails(assert, tagged(f, urgent.id, {}, f.users.vendas), '42501');
    await fails(assert, tagged(f, urgent.id, { p_origin: 'brufap' }, f.users.consulta), '42501');
  } finally { await f.close(); }
});
