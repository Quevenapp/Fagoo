import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

let db;
const users = {};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sqlCode = code => error => error.code === code;
before(async () => {
  db = new PGlite();
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);');
  for (const name of ['202610160001_origin_sync.sql', '202610160002_origin_quotes_nfce.sql', '202610160004_erp_access.sql',
    '202610160005_origin_auxiliary_catalogs.sql', '202610160006_erp_catalog.sql']) {
    await db.exec(await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  }
  for (const role of ['admin', 'consulta', 'vendas', 'financeiro', 'estoque', 'fiscal', 'inactive', 'unlisted']) {
    users[role] = randomUUID();
    await db.query('INSERT INTO auth.users(id) VALUES ($1)', [users[role]]);
    if (role !== 'unlisted') await db.query('INSERT INTO erp_access.membership(user_id,role,active) VALUES ($1,$2,$3)',
      [users[role], role === 'inactive' ? 'admin' : role, role !== 'inactive']);
  }
  await db.query("INSERT INTO origin_sync.resource_state(resource) VALUES ('catalog_test')");
});
after(async () => db?.close());
async function scalar(sql, args = []) { return (await db.query(sql, args)).rows[0].value; }
async function role(name, action) {
  await db.exec(`SET ROLE ${name}`);
  try { return await action(); } finally { await db.exec('RESET ROLE'); }
}
async function rpc(name, types, args) {
  return role('service_role', () => scalar(`SELECT public.${name}(${types.map((t, i) => `$${i + 1}::${t}`).join(',')}) AS value`, args));
}
const access = (user = users.admin) => rpc('erp_catalog_access', ['uuid'], [user]);
const save = ({ entity = 'contacts', id = null, version = 0, command = randomUUID(), data = { name: 'Cadastro sintético' }, user = users.admin } = {}) =>
  rpc('erp_catalog_save', ['uuid', 'text', 'uuid', 'int', 'uuid', 'jsonb'], [user, entity, id, version, command, JSON.stringify(data)]);
const setActive = (record, active, command = randomUUID(), user = users.admin) => rpc('erp_catalog_set_active',
  ['uuid', 'text', 'uuid', 'int', 'uuid', 'bool'], [user, record.entity, record.id, record.version, command, active]);
const get = (record, user = users.admin) => rpc('erp_catalog_get', ['uuid', 'text', 'uuid'], [user, record.entity, record.id]);
const list = ({ entity = 'contacts', user = users.admin, limit = 25, after = null, query = null, active = null } = {}) => rpc('erp_catalog_list',
  ['uuid', 'text', 'int', 'uuid', 'text', 'bool'], [user, entity, limit, after, query, active]);
const importer = (entity, items, { user = users.admin, command = null, dryRun = true } = {}) => rpc('erp_catalog_import_origin',
  ['uuid', 'text', 'jsonb', 'uuid', 'bool'], [user, entity, JSON.stringify(items), command, dryRun]);
async function seed(entity, sourceId, payload) {
  const sourceHash = hash(payload);
  await db.query(`INSERT INTO origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)
    VALUES ($1,'catalog_test',$2,$3::jsonb,$4) ON CONFLICT(entity,source_id) DO UPDATE SET
    payload=excluded.payload,version_hash=excluded.version_hash,version=origin_sync.raw_record.version+1`,
  [entity, sourceId, JSON.stringify(payload), sourceHash]);
  return { source_id: sourceId, source_hash: sourceHash };
}
const contactPayload = name => ({ nome: name, codigo: '0001', situacao: 'A', tipo: 'J', numeroDocumento: 'AB.123.CD/0001-99',
  endereco: { geral: { endereco: 'Rua sintética', numero: '001', uf: 'SP', cep: '00000000' } } });
const productPayload = name => ({ nome: name, codigo: '0001', situacao: 'A', tipo: 'P', formato: 'S', unidade: 'UN', preco: 12.5,
  tributacao: { ncm: '00000000' }, gtin: '00000000000000' });
const count = table => scalar(`SELECT count(*)::int AS value FROM erp_catalog.${table}`);

test('RLS, private tables and service-only RPCs enforce an explicit active membership', async () => {
  const tables = (await db.query("SELECT relname,relrowsecurity FROM pg_class JOIN pg_namespace ON pg_namespace.oid=relnamespace WHERE nspname='erp_catalog' AND relkind='r'")).rows;
  assert.equal(tables.length, 8);
  assert.ok(tables.every(row => row.relrowsecurity));
  for (const apiRole of ['anon', 'authenticated', 'service_role']) {
    for (const table of tables) {
      assert.equal(await scalar("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') AS value", [apiRole, `erp_catalog.${table.relname}`]), false);
    }
    await role(apiRole, async () => {
      await assert.rejects(() => db.query('SELECT * FROM erp_catalog.record'), sqlCode('42501'));
      if (apiRole !== 'service_role') await assert.rejects(() => scalar('SELECT public.erp_catalog_access($1) AS value', [users.admin]), sqlCode('42501'));
    });
  }
  for (const user of [users.unlisted, users.inactive, randomUUID()]) {
    await assert.rejects(() => access(user), sqlCode('42501'));
    await assert.rejects(() => save({ user }), sqlCode('42501'));
  }
  assert.equal(await scalar("SELECT count(*)::int AS value FROM pg_policies WHERE schemaname='erp_catalog'"), 0);
});

test('approved role matrix controls reads and writes without adding new roles', async () => {
  const rights = {
    admin: [['contacts', 'products', 'warehouses'], ['contacts', 'products', 'warehouses']],
    consulta: [['contacts', 'products', 'warehouses'], []],
    vendas: [['contacts', 'products'], ['contacts']],
    financeiro: [['contacts'], ['contacts']],
    estoque: [['contacts', 'products', 'warehouses'], ['products', 'warehouses']],
    fiscal: [['contacts', 'products'], []],
  };
  for (const [name, [read, write]] of Object.entries(rights)) {
    assert.deepEqual(await access(users[name]), { read, write, data_mode: 'erp_native' });
    for (const entity of ['contacts', 'products', 'warehouses']) {
      if (read.includes(entity)) assert.equal((await list({ entity, user: users[name] })).data_mode, 'erp_native');
      else await assert.rejects(() => list({ entity, user: users[name] }), sqlCode('42501'));
      if (write.includes(entity)) assert.equal((await save({ entity, user: users[name] })).record.entity, entity);
      else await assert.rejects(() => save({ entity, user: users[name] }), sqlCode('42501'));
    }
  }
});

test('create commands are idempotent, field patches preserve omitted values, and CAS prevents lost updates', async () => {
  const command = randomUUID();
  const data = { name: 'Empresa sintética', document: 'AB.123.CD/0001-99', code: '0009', roles: ['supplier', 'customer', 'customer'] };
  const first = await save({ command, data });
  assert.equal(first.record.version, 1);
  assert.equal(first.record.document, data.document);
  assert.deepEqual(first.record.roles, ['customer', 'supplier']);
  assert.equal(first.record.source, null);
  assert.deepEqual(await save({ command, data }), { ...first, replayed: true });
  await assert.rejects(() => save({ command, data: { ...data, name: 'Alterado' } }), sqlCode('40001'));
  const second = await save({ id: first.record.id, version: 1, data: { name: 'Nova razão sintética' } });
  assert.equal(second.record.version, 2);
  assert.equal(second.record.document, data.document);
  await assert.rejects(() => save({ id: first.record.id, version: 1, data: { code: '9999' } }), sqlCode('40001'));
  assert.equal((await get(second.record)).record.code, '0009');
  await assert.rejects(() => get({ entity: 'products', id: first.record.id }), sqlCode('P0002'));
  const audit = (await db.query('SELECT action FROM erp_catalog.audit WHERE record_id=$1 ORDER BY id', [first.record.id])).rows;
  assert.deepEqual(audit, [{ action: 'create' }, { action: 'update' }]);
});

test('archive and restore preserve identity, use CAS and support command replay', async () => {
  const first = (await save({ entity: 'products', data: { name: 'Produto sintético', price: '12.50', unit: 'UN' } })).record;
  assert.equal(first.price, '12.5000');
  const command = randomUUID();
  const archived = await setActive(first, false, command);
  assert.equal(archived.record.active, false);
  assert.equal(archived.record.version, 2);
  assert.deepEqual(await setActive(first, false, command), { ...archived, replayed: true });
  await assert.rejects(() => setActive(first, true), sqlCode('40001'));
  const restored = (await setActive(archived.record, true)).record;
  assert.equal(restored.id, first.id);
  assert.equal(restored.version, 3);
  assert.equal(restored.active, true);
  const noChange = (await setActive(restored, true)).record;
  assert.equal(noChange.version, 3);
  await assert.rejects(() => setActive(restored, false, randomUUID(), users.consulta), sqlCode('42501'));
});

test('strict validation rejects privilege fields, numeric prices, overflow, invalid enums and malformed patches', async () => {
  const initial = await count('record');
  for (const data of [{ name: 'X', active: false }, { name: 'X', id: randomUUID() }, { name: 'X', source: {} },
    { name: 'X', version: 1 }, { name: 'X', name2: 'Y' }, { name: '' }, { name: 1 }, { name: 'X'.repeat(201) },
    { name: 'X', person_type: 'Z' }, { name: 'X', roles: ['admin'] }, { name: 'X', roles: null }, { name: 'X', phone: {} },
    { name: 'X', state: 'São Paulo' }, { name: 'X', email: 'a\u0001b' }]) {
    await assert.rejects(() => save({ data }), sqlCode('22023'));
  }
  for (const price of [12.5, -1, '-1', '01.20', '1e3', '1,20', '0.00001', '100000000000000', {}, true]) {
    await assert.rejects(() => save({ entity: 'products', data: { name: 'X', price } }), sqlCode('22023'));
  }
  await assert.rejects(() => save({ entity: 'products', data: { name: 'X', kind: 'invalid' } }), sqlCode('22023'));
  await assert.rejects(() => save({ entity: 'warehouses', data: { name: 'X', description: 'a'.repeat(1001) } }), sqlCode('22023'));
  assert.equal(await count('record'), initial);
  const product = (await save({ entity: 'products', data: { name: 'Sem preço', price: null } })).record;
  assert.equal(product.price, null);
  await assert.rejects(() => save({ entity: 'products', id: product.id, version: 1, data: {} }), sqlCode('22023'));
  const cleared = await save({ entity: 'products', id: product.id, version: 1, data: { unit: '' } });
  assert.equal(cleared.record.unit, null);
  const multiline = (await save({ entity: 'products', data: { name: 'Descrição', description: 'Linha um\nLinha dois\tDetalhe' } })).record;
  assert.equal(multiline.description, 'Linha um\nLinha dois\tDetalhe');
});

test('keyset pagination is stable and query matching treats SQL wildcard characters literally', async () => {
  const created = [];
  for (const suffix of ['a', 'b', 'c', 'd', 'e']) created.push((await save({ entity: 'warehouses', data: { name: `Pagination%%${suffix}` } })).record);
  const expected = created.map(row => row.id).sort();
  const found = [];
  let after = null;
  do {
    const page = await list({ entity: 'warehouses', query: 'Pagination%%', limit: 2, after });
    assert.ok(page.items.length <= 2);
    found.push(...page.items.map(row => row.id));
    after = page.next_cursor;
    assert.equal(page.has_more, after !== null);
  } while (after);
  assert.deepEqual(found, expected);
  await setActive(created[0], false);
  assert.equal((await list({ entity: 'warehouses', query: 'Pagination%%', active: false })).items.length, 1);
  for (const limit of [0, 101, null]) await assert.rejects(() => list({ limit }), sqlCode('22023'));
  await assert.rejects(() => list({ query: 'x'.repeat(121) }), sqlCode('22023'));
});

test('explicit import defaults to dry-run, requires admin and hashes, and never changes raw staging', async () => {
  const source = await seed('contacts', 'import-initial', contactPayload('Origem sintética'));
  const rawBefore = (await db.query("SELECT to_jsonb(r) row FROM origin_sync.raw_record r WHERE entity='contacts' AND source_id=$1", [source.source_id])).rows;
  const before = await count('record');
  const snapshotBefore = await count('source_snapshot');
  const dry = await importer('contacts', [{ source_id: source.source_id }]);
  assert.equal(dry.dry_run, true);
  assert.equal(dry.items[0].action, 'create');
  assert.equal(dry.items[0].source_hash, source.source_hash);
  assert.equal(await count('record'), before);
  assert.equal(await count('source_snapshot'), snapshotBefore);
  for (const user of [users.vendas, users.financeiro, users.consulta]) {
    await assert.rejects(() => importer('contacts', [source], { user }), sqlCode('42501'));
  }
  await assert.rejects(() => importer('contacts', [{ source_id: source.source_id }], { dryRun: false, command: randomUUID() }), sqlCode('22023'));
  const command = randomUUID();
  const applied = await importer('contacts', [source], { dryRun: false, command });
  assert.equal(applied.items[0].action, 'create');
  assert.equal(applied.operational_effects, false);
  assert.deepEqual(await importer('contacts', [source], { dryRun: false, command }), { ...applied, replayed: true });
  assert.equal((await importer('contacts', [source], { dryRun: false, command: randomUUID() })).items[0].action, 'unchanged');
  assert.equal(await count('record'), before + 1);
  const record = (await get({ entity: 'contacts', id: applied.items[0].record_id })).record;
  assert.equal(record.document, 'AB.123.CD/0001-99');
  assert.equal(record.number, '001');
  assert.equal(record.code, '0001');
  assert.equal(record.source.state, 'synced');
  assert.equal(record.source.system, 'origin');
  assert.equal(record.candidate, undefined);
  assert.deepEqual((await db.query("SELECT to_jsonb(r) row FROM origin_sync.raw_record r WHERE entity='contacts' AND source_id=$1", [source.source_id])).rows, rawBefore);
});

test('untouched imports update by stable source ID; identity never merges by name or SKU', async () => {
  const source = await seed('products', 'stable-product', productPayload('Mesmo nome'));
  const result = await importer('products', [source], { dryRun: false, command: randomUUID() });
  const recordId = result.items[0].record_id;
  const changed = await seed('products', source.source_id, { ...productPayload('Mesmo nome'), preco: 20 });
  const update = await importer('products', [changed], { dryRun: false, command: randomUUID() });
  assert.equal(update.items[0].action, 'update');
  assert.equal(update.items[0].record_id, recordId);
  const record = (await get({ entity: 'products', id: recordId })).record;
  assert.equal(record.price, '20.0000');
  assert.equal(record.version, 2);
  const duplicate = await seed('products', 'different-product', productPayload('Mesmo nome'));
  const other = await importer('products', [duplicate], { dryRun: false, command: randomUUID() });
  assert.notEqual(other.items[0].record_id, recordId);
  const sameIdContact = await seed('contacts', source.source_id, contactPayload('Mesmo nome'));
  const contact = await importer('contacts', [sameIdContact], { dryRun: false, command: randomUUID() });
  assert.notEqual(contact.items[0].record_id, recordId);
  assert.equal(await scalar("SELECT count(*)::int AS value FROM erp_catalog.source_snapshot WHERE entity='products' AND source_id=$1", [source.source_id]), 2);
});

test('human edits are never overwritten; changed source becomes a private candidate', async () => {
  const source = await seed('contacts', 'human-protected', contactPayload('Nome da origem'));
  const result = await importer('contacts', [source], { dryRun: false, command: randomUUID() });
  const id = result.items[0].record_id;
  const edited = (await save({ id, version: 1, data: { name: 'Edição humana', city: 'Cidade fictícia' } })).record;
  assert.equal(edited.source.state, 'local_modified');
  const changed = await seed('contacts', source.source_id, contactPayload('Nome atualizado pela origem'));
  const pending = await importer('contacts', [changed], { dryRun: false, command: randomUUID() });
  assert.equal(pending.items[0].action, 'pending_human_review');
  const kept = (await get(edited)).record;
  assert.equal(kept.name, edited.name);
  assert.equal(kept.city, edited.city);
  assert.equal(kept.version, edited.version);
  assert.equal(kept.source.state, 'source_changed');
  assert.equal(kept.source.applied_hash, source.source_hash);
  assert.equal(kept.source.latest_hash, changed.source_hash);
  assert.equal(kept.candidate, undefined);
  assert.equal(await scalar('SELECT candidate#>>\'{data,name}\' AS value FROM erp_catalog.origin WHERE record_id=$1', [id]), 'Nome atualizado pela origem');
  const snapshot = await scalar('SELECT payload AS value FROM erp_catalog.source_snapshot WHERE entity=$1 AND source_id=$2 AND source_hash=$3', ['contacts', source.source_id, source.source_hash]);
  assert.equal(snapshot.nome, 'Nome da origem');
});

test('source deletion is pending review and never deletes or silently archives an existing record', async () => {
  const source = await seed('products', 'source-deletion', productPayload('Preservar produto'));
  const first = await importer('products', [source], { dryRun: false, command: randomUUID() });
  const record = { entity: 'products', id: first.items[0].record_id };
  const deleted = await seed('products', source.source_id, { ...productPayload('Preservar produto'), situacao: 'E' });
  const pending = await importer('products', [deleted], { dryRun: false, command: randomUUID() });
  assert.equal(pending.items[0].action, 'pending_source_deleted');
  const existing = (await get(record)).record;
  assert.equal(existing.active, true);
  assert.equal(existing.version, 1);
  assert.equal(existing.source.state, 'source_deleted');
  const initiallyDeleted = await seed('products', 'initially-deleted', { ...productPayload('Histórico excluído'), situacao: 'E' });
  const historical = await importer('products', [initiallyDeleted], { dryRun: false, command: randomUUID() });
  assert.equal((await get({ entity: 'products', id: historical.items[0].record_id })).record.active, false);
});

test('stale source hashes roll back an entire import command and require a fresh simulation', async () => {
  const first = await seed('contacts', 'atomic-1', contactPayload('Primeiro'));
  const second = await seed('contacts', 'atomic-2', contactPayload('Segundo'));
  await seed('contacts', second.source_id, contactPayload('Segundo atualizado'));
  const before = await count('record');
  const snapshots = await count('source_snapshot');
  await assert.rejects(() => importer('contacts', [first, second], { dryRun: false, command: randomUUID() }), sqlCode('40001'));
  assert.equal(await count('record'), before);
  assert.equal(await count('source_snapshot'), snapshots);
  assert.equal(await scalar("SELECT count(*)::int AS value FROM erp_catalog.origin WHERE source_id='atomic-1'"), 0);
});

test('unknown or malformed source fields remain explicit rejected candidates without guessed defaults', async () => {
  const badName = await seed('contacts', 'invalid-name', { ...contactPayload('Unused'), nome: { unexpected: true } });
  const unknown = await seed('contacts', 'unknown-status', { ...contactPayload('Unknown'), situacao: 'Z' });
  const before = await count('record');
  const result = await importer('contacts', [badName, unknown, { source_id: 'not-present', source_hash: hash('missing') }], { dryRun: false, command: randomUUID() });
  assert.deepEqual(result.items.map(item => item.action), ['invalid_source', 'invalid_source', 'missing_source']);
  assert.deepEqual(result.items.slice(0, 2).map(item => item.error), ['source_mapping_invalid', 'source_status_unknown']);
  assert.equal(await count('record'), before);
  const precise = await seed('products', 'no-rounding', { ...productPayload('Precisão'), preco: 0.00001 });
  assert.equal((await importer('products', [precise])).items[0].action, 'invalid_source');
  for (const items of [[], [badName, badName], [{ source_id: 'x', payload: {} }], [{ source_id: 123 }]]) {
    await assert.rejects(() => importer('contacts', items), sqlCode('22023'));
  }
  await assert.rejects(() => importer('warehouses', [{ source_id: 'x' }]), sqlCode('22023'));
});

test('deactivated membership cannot replay an earlier command or read saved data', async () => {
  const user = randomUUID();
  await db.query('INSERT INTO auth.users(id) VALUES ($1)', [user]);
  await db.query("INSERT INTO erp_access.membership(user_id,role) VALUES ($1,'admin')", [user]);
  const command = randomUUID();
  const first = await save({ user, command });
  await db.query('UPDATE erp_access.membership SET active=false WHERE user_id=$1', [user]);
  await assert.rejects(() => save({ user, command }), sqlCode('42501'));
  await assert.rejects(() => get(first.record, user), sqlCode('42501'));
});
