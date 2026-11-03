import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { collectInventory, inventorySql, parseInventory } from './inventory.mjs';
import { compareInventories, validateMapping } from './compare.mjs';

const relation = (schema = 'erp_stock') => ({ schema, name: 'balance', relationKind: 'r', owner: 'erp_owner', acl: null, rls: true, forceRls: false, replicaIdentity: 'd', parent: [], columns: [{ name: 'quantity', ordinal: 1, type: 'numeric(18,6)', nullable: false, identity: '', generated: '', collation: null, defaultHash: 'fixed' }], constraints: [], indexes: [], triggers: [], policies: [], viewHash: null, partitionHash: null, partitionBoundHash: null });
function fixture() {
  return {
    formatVersion: 1, database: { serverVersionNum: '170005', encoding: 'UTF8', collation: 'C.UTF-8', ctype: 'C.UTF-8', sizeBytes: '1024' },
    consistency: { readOnly: true, isolation: 'repeatable read', exactCounts: true },
    schemas: [{ name: 'erp_stock', owner: 'erp_owner', acl: null }], extensions: [{ name: 'plpgsql', version: '1.0', schema: 'pg_catalog' }],
    roles: [{ name: 'erp_owner', login: false, bypassRls: false }], memberships: [],
    relations: [relation()], counts: [{ schema: 'erp_stock', name: 'balance', rows: '9007199254740993' }],
    routines: [{ schema: 'public', name: 'erp_stock_get', arguments: 'p_user_id uuid', returns: 'jsonb', securityDefiner: true, definitionHash: 'body-v1' }],
    types: [], sequences: [], storage: { available: true, objects: '2', buckets: [{ id: 'erp-attachments', name: 'erp-attachments', public: false, fileSizeLimit: '1000', allowedMimeTypes: ['application/pdf'], objects: '2' }] },
    migrationVersions: { available: true, versions: ['202610160009'] },
  };
}
function spool(manifest = fixture()) {
  const { relations, routines, sequences, types, counts, storage, migrationVersions, ...header } = manifest;
  return [
    { kind: 'manifest', ...header },
    ...relations.map(value => ({ kind: 'relation', ...value })), ...routines.map(value => ({ kind: 'routine', ...value })),
    ...sequences.map(value => ({ kind: 'sequence', ...value })), ...types.map(value => ({ kind: 'type', ...value })), ...counts.map(value => ({ kind: 'count', ...value })),
    { kind: 'storageSummary', ...storage }, { kind: 'migrationVersions', ...migrationVersions }, { kind: 'complete', readOnly: true },
  ].map(value => JSON.stringify(value)).join('\n');
}
function fakePsql(output, { exitCode = 0, stderr = '' } = {}) {
  const calls = [];
  return { calls, spawn: (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    let input = ''; child.stdin = new Writable({ write(chunk, encoding, callback) { input += chunk.toString(); callback(); } });
    calls.push({ command, args, options, get input() { return input; } });
    child.stdin.on('finish', () => { child.stdout.end(output); child.stderr.end(stderr); queueMicrotask(() => child.emit('close', exitCode)); });
    return child;
  } };
}

test('inventory parses complete read-only snapshot, exact counts remain decimal strings', () => {
  const value = parseInventory(spool()); assert.equal(value.counts[0].rows, '9007199254740993'); assert.equal(value.relations[0].rls, true);
});
test('truncation, RLS-filtered/estimated claims and missing exact table counts are rejected', () => {
  assert.throws(() => parseInventory(spool().split('\n').slice(0, -1).join('\n')), /INCOMPLETE/);
  const value = fixture(); value.consistency.exactCounts = false; assert.throws(() => parseInventory(spool(value)), /NOT_CONSISTENT/);
  value.consistency.exactCounts = true; value.counts = []; assert.throws(() => parseInventory(spool(value)), /COUNT_MISSING/);
});
test('duplicate and floating-point counts are refused', () => {
  const value = fixture(); value.counts.push({ ...value.counts[0] }); assert.throws(() => parseInventory(spool(value)), /COUNT_INVALID/);
  value.counts = [{ schema: 'erp_stock', name: 'balance', rows: '1.2' }]; assert.throws(() => parseInventory(spool(value)), /COUNT_INVALID/);
});
test('SQL explicitly uses read-only repeatable snapshot, quoted SELECT generation and no data export', async () => {
  const sql = await inventorySql();
  assert.match(sql, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/); assert.match(sql, /SET LOCAL row_security = off/); assert.match(sql, /FROM ONLY %I\.%I/); assert.match(sql, /ROLLBACK;/);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|COPY|nextval)\b/i);
  assert.doesNotMatch(sql, /\b(?:email|encrypted_password|raw_user_meta_data|access_token|refresh_token|object_key)\s*[,)]/i);
  assert.match(sql, /md5\(pg_get_functiondef/); assert.match(sql, /supabase_migrations\.schema_migrations/);
  assert.match(sql, /select datcollate from pg_database/); assert.doesNotMatch(sql, /current_setting\('lc_(?:collate|ctype)'\)/);
});
test('psql receives connection only in environment, excludes startup file and password prompt', async () => {
  const fake = fakePsql(spool());
  const result = await collectInventory({ env: { PGSERVICE: 'private-source', PGPASSWORD: 'synthetic-secret' }, spawnImpl: fake.spawn });
  assert.equal(result.counts[0].rows, '9007199254740993');
  const call = fake.calls[0]; assert.equal(call.command, 'psql'); assert.equal(call.options.shell, false); assert.equal(call.options.windowsHide, true);
  assert.ok(call.args.includes('-X')); assert.ok(call.args.includes('-w')); assert.equal(call.options.env.PGPASSWORD, 'synthetic-secret');
  assert.doesNotMatch(JSON.stringify(call.args), /private-source|synthetic-secret/); assert.match(call.options.env.PGOPTIONS, /default_transaction_read_only=on/);
  assert.match(call.input, /REPEATABLE READ READ ONLY/);
});
test('connection is explicit; raw server diagnostics and partial results never escape failures', async () => {
  await assert.rejects(collectInventory({ env: {}, spawnImpl: () => assert.fail('must not start') }), /CONNECTION_ENV_REQUIRED/);
  const fake = fakePsql(spool(), { exitCode: 1, stderr: 'synthetic-secret in server detail' });
  await assert.rejects(collectInventory({ env: { PGSERVICE: 'private-source' }, spawnImpl: fake.spawn }), error => error.message === 'PSQL_INVENTORY_FAILED');
});
test('identical inventories report compatibility but never migration readiness', () => {
  const value = fixture(), report = compareInventories(value, structuredClone(value));
  assert.equal(report.status, 'inventory-compatible'); assert.equal(report.ready, false); assert.equal(report.blockers.length, 0); assert.ok(report.requiredEvidence.length >= 6);
});
test('a missing populated table is explicitly reported as data without destination', () => {
  const source = fixture(), target = fixture(); target.relations = []; target.counts = [];
  const report = compareInventories(source, target);
  assert.equal(report.status, 'blocked'); assert.ok(report.blockers.some(item => item.code === 'DESTINATION_OBJECT_MISSING'));
  assert.deepEqual(report.blockers.find(item => item.code === 'DESTINATION_DATA_MISSING'), { code: 'DESTINATION_DATA_MISSING', object: 'erp_stock.balance', sourceRows: '9007199254740993' });
});
test('counts compare losslessly beyond JavaScript integer precision', () => {
  const source = fixture(), target = fixture(); target.counts[0].rows = '9007199254740992';
  assert.ok(compareInventories(source, target).blockers.some(item => item.code === 'ROW_COUNT_DIFFERS'));
});
test('private schema/object/bucket/role mappings work on identifiers without modifying the input', () => {
  const source = fixture(), target = fixture(); source.schemas[0].name = 'old_inventory'; source.relations[0].schema = 'old_inventory'; source.counts[0].schema = 'old_inventory';
  source.routines[0].name = 'old_stock_get'; source.roles[0].name = 'old_owner'; source.schemas[0].owner = 'old_owner'; source.relations[0].owner = 'old_owner';
  source.storage.buckets[0].id = 'old-attachments'; source.storage.buckets[0].name = 'old-attachments';
  const before = JSON.stringify(source);
  const report = compareInventories(source, target, { version: 1, schemas: { old_inventory: 'erp_stock' }, objects: { 'public.old_stock_get': 'public.erp_stock_get' }, roles: { old_owner: 'erp_owner' }, buckets: { 'old-attachments': 'erp-attachments' } });
  assert.equal(report.blockers.length, 0); assert.equal(JSON.stringify(source), before);
});
test('mapping is one-to-one and cannot hide two source objects behind one target', () => {
  assert.throws(() => validateMapping({ version: 1, schemas: { a: 'c', b: 'c' } }), /ONE_TO_ONE/);
  assert.throws(() => validateMapping({ version: 1, ignoredTables: ['balance'] }), /MAPPING_INVALID/);
  const source = fixture(), target = fixture(); source.relations.push(relation('other')); source.counts.push({ schema: 'other', name: 'balance', rows: '0' });
  assert.throws(() => compareInventories(source, target, { version: 1, schemas: { other: 'erp_stock' } }), /COLLISION/);
});
test('namespace mapping cannot waive changed function/constraint evidence', () => {
  const source = fixture(), target = fixture(); target.routines[0].definitionHash = 'body-v2';
  const report = compareInventories(source, target); assert.equal(report.status, 'blocked'); assert.ok(report.blockers.some(item => item.fields?.includes('definitionHash')));
});
test('schema mappings apply once to complete type identifiers, including quoted types', () => {
  const source = fixture(), target = fixture();
  source.routines[0].arguments = 'a alpha.item, b "beta".item, c otheralpha.item';
  target.routines[0].arguments = 'a beta.item, b "gamma".item, c otheralpha.item';
  source.extensions[0].schema = 'alpha'; target.extensions[0].schema = 'beta';
  assert.equal(compareInventories(source, target, { version: 1, schemas: { alpha: 'beta', beta: 'gamma' } }).blockers.length, 0);
});
test('authentication table counts, storage policy, roles and migration versions remain checked', () => {
  const source = fixture(), target = fixture();
  source.relations.push({ ...relation('auth'), name: 'users' }); source.counts.push({ schema: 'auth', name: 'users', rows: '3' });
  target.storage.buckets[0].public = true; target.roles[0].bypassRls = true; target.migrationVersions.versions = [];
  const codes = compareInventories(source, target).blockers.map(item => item.code);
  for (const code of ['DESTINATION_DATA_MISSING', 'STORAGE_METADATA_DIFFERS', 'OBJECT_METADATA_DIFFERS', 'MIGRATION_VERSIONS_DIFFER']) assert.ok(codes.includes(code));
});
test('version/collation drift and unknown sequence state block matching counts', () => {
  const source = fixture(), target = fixture(); source.sequences = [{ schema: 'erp_stock', name: 'number_seq', lastValue: null }]; target.sequences = structuredClone(source.sequences); target.database.serverVersionNum = '180001'; target.database.collation = 'C';
  const codes = compareInventories(source, target).blockers.map(item => item.code);
  for (const code of ['POSTGRES_MAJOR_VERSION_DIFFERS', 'DATABASE_SETTING_DIFFERS', 'SEQUENCE_STATE_NOT_PROVEN']) assert.ok(codes.includes(code));
});
test('a malformed manifest cannot get a compatible status', () => {
  const source = fixture(); source.counts = []; assert.throws(() => compareInventories(source, fixture()), /COUNT_MISSING/);
});
