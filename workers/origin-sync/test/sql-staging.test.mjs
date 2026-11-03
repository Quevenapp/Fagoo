import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

let db;
let migrations;

before(async () => {
  db = new PGlite();
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
  migrations = await Promise.all([
    '202610160001_origin_sync.sql',
    '202610160002_origin_quotes_nfce.sql',
    '202610160005_origin_auxiliary_catalogs.sql',
  ].map(filename => readFile(new URL(`../../../supabase/migrations/${filename}`, import.meta.url), 'utf8')));
  for (const migration of migrations) await db.exec(migration);
});

after(async () => db?.close());

async function scalar(sql, args = []) {
  return (await db.query(sql, args)).rows[0].value;
}

async function claim(resource, owner = randomUUID(), ttl = 300) {
  const result = await scalar('SELECT public.origin_sync_claim($1::text,$2::uuid,$3::int) AS value', [resource, owner, ttl]);
  return { resource, owner, ...result };
}

async function apply(lease, { entity = 'products', records = [], checkpoint = {}, version = lease.checkpoint_version, batchId = randomUUID() } = {}) {
  return scalar('SELECT public.origin_sync_apply_batch($1::text,$2::text,$3::uuid,$4::uuid,$5::uuid,$6::jsonb,$7::jsonb,$8::bigint) AS value',
    [lease.resource, entity, lease.owner, lease.lease_token, batchId, JSON.stringify(records), JSON.stringify(checkpoint), version]);
}

const sqlError = code => error => error.code === code;

test('private staging enables RLS and denies API roles except service RPC execution', async () => {
  const tables = (await db.query("SELECT relname, relrowsecurity FROM pg_class JOIN pg_namespace ON pg_namespace.oid = relnamespace WHERE nspname='origin_sync' AND relkind='r'")).rows;
  assert.equal(tables.length, 6);
  assert.ok(tables.every(row => row.relrowsecurity));
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    try {
      await assert.rejects(() => scalar('SELECT public.origin_sync_get_credentials() AS value'), sqlError('42501'));
      await assert.rejects(() => scalar('SELECT public.origin_sync_status() AS value'), sqlError('42501'));
      assert.equal(await scalar("SELECT has_function_privilege(current_user,'public.origin_sync_apply_batch(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint)','EXECUTE') AS value"), false);
      await assert.rejects(() => db.query('SELECT * FROM origin_sync.raw_record'), sqlError('42501'));
    } finally {
      await db.exec('RESET ROLE');
    }
  }
  await db.exec('SET ROLE service_role');
  try {
    assert.deepEqual(await scalar('SELECT public.origin_sync_get_credentials() AS value'), { ciphertext: null, expires_at: null, revision: 0 });
    const status = await scalar('SELECT public.origin_sync_status() AS value');
    assert.equal(status.connected, false);
    assert.equal(status.entities.length, 11);
    assert.ok(status.entities.every(entity => entity.records === 0));
    await assert.rejects(() => db.query('SELECT * FROM origin_sync.credentials'), sqlError('42501'));
  } finally {
    await db.exec('RESET ROLE');
  }
});

test('incremental migration preserves existing rows, credentials, leases, ledger and access controls', async () => {
  const upgrade = new PGlite();
  const query = async (sql, args = []) => (await upgrade.query(sql, args)).rows[0].value;
  try {
    await upgrade.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
    await upgrade.exec(migrations[0]);
    const owner = randomUUID();
    const lease = await query("SELECT public.origin_sync_claim('upgrade_products',$1::uuid,300) AS value", [owner]);
    const oauth = await query("SELECT public.origin_sync_claim('__oauth__',$1::uuid,300) AS value", [owner]);
    const args = [owner, lease.lease_token, randomUUID(), JSON.stringify([{ source_id: 'upgrade-1', payload: { synthetic: true } }])];
    const applySql = "SELECT public.origin_sync_apply_batch('upgrade_products','products',$1::uuid,$2::uuid,$3::uuid,$4::jsonb,'{\"page\":2}'::jsonb,0) AS value";
    const initialBatch = await query(applySql, args);
    await query("SELECT public.origin_sync_put_credentials('{\"data\":\"synthetic-ciphertext\"}'::jsonb,clock_timestamp()+interval '1 hour',0,$1::uuid,$2::uuid) AS value", [owner, oauth.lease_token]);
    await query("SELECT public.origin_sync_create_oauth_state($1,$2,clock_timestamp()+interval '5 minutes') AS value", ['d'.repeat(64), 'e'.repeat(64)]);

    const snapshot = async () => {
      const result = {};
      for (const table of ['account', 'resource_state', 'credentials', 'oauth_state', 'raw_record', 'batch_inbox']) {
        result[table] = (await upgrade.query(`SELECT to_jsonb(row) AS value FROM origin_sync.${table} AS row ORDER BY to_jsonb(row)`)).rows;
      }
      result.tables = (await upgrade.query("SELECT relname, relrowsecurity, relacl::text FROM pg_class JOIN pg_namespace ON pg_namespace.oid=relnamespace WHERE nspname='origin_sync' AND relkind='r' ORDER BY relname")).rows;
      result.functions = (await upgrade.query("SELECT proname, proacl::text, prosecdef, proconfig FROM pg_proc JOIN pg_namespace ON pg_namespace.oid=pronamespace WHERE nspname='public' AND proname LIKE 'origin_sync_%' ORDER BY proname")).rows;
      return result;
    };
    const before = await snapshot();
    for (const migration of migrations.slice(1)) await upgrade.exec(migration);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await query(applySql, args), { ...initialBatch, replayed: true });
    const status = await query('SELECT public.origin_sync_status() AS value');
    assert.equal(status.connected, true);
    assert.equal(status.entities.length, 11);
    assert.equal(status.entities.find(row => row.entity === 'products').records, 1);
    assert.equal(status.entities.find(row => row.entity === 'sales_proposals').records, 0);
    assert.equal(status.entities.find(row => row.entity === 'nfce').records, 0);
    assert.equal((await query('SELECT public.origin_sync_renew($1,$2::uuid,$3::uuid,300) AS value', ['upgrade_products', owner, lease.lease_token])).renewed, true);
    assert.equal(await query('SELECT public.origin_sync_consume_oauth_state($1,$2) AS value', ['d'.repeat(64), 'e'.repeat(64)]), true);
  } finally {
    await upgrade.close();
  }
});

test('proposals and NFC-e upsert and deduplicate across cursors without colliding with NF-e', async () => {
  const sourceId = 'synthetic-shared-id';
  const base = { source_id: sourceId, payload: { total: 100 }, source_updated_at: '2026-10-15T10:00:00Z' };
  await db.exec('SET ROLE service_role');
  try {
    for (const entity of ['sales_proposals', 'nfce']) {
      const history = await claim(`test_${entity}_history`);
      const recent = await claim(`test_${entity}_recent`);
      const batch = { entity, records: [base], batchId: randomUUID() };
      assert.equal((await apply(history, batch)).inserted, 1);
      assert.equal((await apply(history, batch)).replayed, true);
      await assert.rejects(() => apply(history, { ...batch, records: [{ ...base, payload: { total: 999 } }] }), sqlError('22023'));
      assert.equal((await apply(recent, { entity, records: [base] })).unchanged, 1);
      const updated = { ...base, payload: { total: 125 }, source_updated_at: '2026-10-15T11:00:00Z' };
      assert.equal((await apply(recent, { entity, records: [updated], version: 1 })).updated, 1);
      await assert.rejects(() => apply(recent, { entity, records: [base], version: 1 }), sqlError('40001'));
      await assert.rejects(() => apply(recent, { entity: 'unsupported_entity', records: [base], version: 2 }), sqlError('22023'));
    }
    const nfe = await claim('test_nfe_shared_id');
    assert.equal((await apply(nfe, { entity: 'nfe', records: [base] })).inserted, 1);
    const status = await scalar('SELECT public.origin_sync_status() AS value');
    assert.equal(status.entities.find(row => row.entity === 'sales_proposals').records, 1);
    assert.equal(status.entities.find(row => row.entity === 'nfce').records, 1);
    assert.equal(status.entities.find(row => row.entity === 'nfe').records, 1);
  } finally {
    await db.exec('RESET ROLE');
  }
  const rows = (await db.query('SELECT entity, version, payload FROM origin_sync.raw_record WHERE source_id=$1 ORDER BY entity', [sourceId])).rows;
  assert.deepEqual(rows, [
    { entity: 'nfce', version: 2, payload: { total: 125 } },
    { entity: 'nfe', version: 1, payload: { total: 100 } },
    { entity: 'sales_proposals', version: 2, payload: { total: 125 } },
  ]);
  await assert.rejects(() => db.query("UPDATE origin_sync.raw_record SET entity='unsupported_entity' WHERE entity='nfce'"), sqlError('23514'));
  await assert.rejects(() => db.query("UPDATE origin_sync.batch_inbox SET entity='unsupported_entity' WHERE entity='sales_proposals'"), sqlError('23514'));
});

test('lease fence prevents an expired worker from writing or releasing its successor', async () => {
  const first = await claim('test_lease');
  assert.equal(first.acquired, true);
  const retry = await claim('test_lease', first.owner);
  assert.equal(retry.lease_token, first.lease_token);
  assert.equal((await claim('test_lease')).acquired, false);
  await db.query("UPDATE origin_sync.resource_state SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE resource=$1", [first.resource]);
  const successor = await claim('test_lease');
  assert.notEqual(successor.lease_token, first.lease_token);
  await assert.rejects(() => apply(first), sqlError('55000'));
  assert.deepEqual(await scalar('SELECT public.origin_sync_release($1::text,$2::uuid,$3::uuid) AS value', [first.resource, first.owner, first.lease_token]), { released: false });
  assert.equal((await scalar('SELECT public.origin_sync_renew($1::text,$2::uuid,$3::uuid,60) AS value', [successor.resource, successor.owner, successor.lease_token])).renewed, true);
  await assert.rejects(() => claim('test_invalid_ttl', randomUUID(), 901), sqlError('22023'));
});

test('batch replay is idempotent, rejects changed content, and uses checkpoint CAS', async () => {
  const lease = await claim('test_replay');
  const batch = { batchId: randomUUID(), records: [{ source_id: 'replay-1', payload: { id: 'replay-1', name: 'synthetic' } }], checkpoint: { page: 2 } };
  const initial = await apply(lease, batch);
  assert.equal(initial.inserted, 1);
  assert.equal(initial.checkpoint_version, 1);
  assert.equal((await apply(lease, batch)).replayed, true);
  await assert.rejects(() => apply(lease, { ...batch, checkpoint: { page: 3 } }), sqlError('22023'));
  await assert.rejects(() => apply(lease, { records: [], checkpoint: { page: 3 } }), sqlError('40001'));
  await db.query("UPDATE origin_sync.resource_state SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE resource=$1", [lease.resource]);
  assert.equal((await apply(lease, batch)).replayed, true);
  assert.equal(await scalar("SELECT count(*)::int AS value FROM origin_sync.batch_inbox WHERE resource='test_replay'"), 1);
});

test('canonical entity deduplicates different cursors and preserves the newest source version', async () => {
  const zero = await claim('test_products_zero');
  const positive = await claim('test_products_positive');
  const base = { source_id: 'canonical-1', payload: { id: 'canonical-1', name: 'synthetic' }, source_updated_at: '2026-10-15T10:00:00Z' };
  assert.equal((await apply(zero, { records: [base] })).inserted, 1);
  assert.equal((await apply(positive, { records: [base] })).unchanged, 1);
  const newer = { ...base, payload: { ...base.payload, name: 'synthetic updated' }, source_updated_at: '2026-10-15T11:00:00Z' };
  assert.equal((await apply(positive, { records: [newer], version: 1 })).updated, 1);
  assert.equal((await apply(zero, { records: [base], version: 1 })).stale, 1);
  const rows = (await db.query("SELECT payload, version, last_resource FROM origin_sync.raw_record WHERE entity='products' AND source_id='canonical-1'")).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, 2);
  assert.equal(rows[0].payload.name, 'synthetic updated');
  assert.equal(rows[0].last_resource, positive.resource);
  const contacts = await claim('test_contacts');
  assert.equal((await apply(contacts, { entity: 'contacts', records: [base] })).inserted, 1);
});

test('invalid record rolls back earlier writes, ledger and checkpoint for the entire batch', async () => {
  const lease = await claim('test_rollback');
  const records = [
    { source_id: 'rollback-1', payload: { name: 'synthetic' } },
    { source_id: 'rollback-2', payload: null },
  ];
  await assert.rejects(() => apply(lease, { records, checkpoint: { page: 2 } }), sqlError('22023'));
  assert.equal(await scalar("SELECT count(*)::int AS value FROM origin_sync.raw_record WHERE source_id='rollback-1'"), 0);
  assert.equal(await scalar("SELECT checkpoint_version AS value FROM origin_sync.resource_state WHERE resource='test_rollback'"), 0);
  assert.equal(await scalar("SELECT count(*)::int AS value FROM origin_sync.batch_inbox WHERE resource='test_rollback'"), 0);
  await assert.rejects(() => apply(lease, { records: [records[0], records[0]] }), sqlError('22023'));
  const scheduler = await claim('__scheduler__');
  assert.equal((await apply(scheduler, { entity: 'control', checkpoint: { status: 'idle' } })).checkpoint_version, 1);
  await assert.rejects(() => apply(scheduler, { entity: 'control', records: [records[0]], version: 1 }), sqlError('22023'));
});

test('OAuth state is bound to the browser, expires and is consumed once atomically', async () => {
  const state = 'a'.repeat(64);
  const browser = 'b'.repeat(64);
  const expiry = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  assert.equal((await scalar('SELECT public.origin_sync_create_oauth_state($1,$2,$3::timestamptz) AS value', [state, browser, expiry])).created, true);
  assert.equal(await scalar('SELECT public.origin_sync_consume_oauth_state($1,$2) AS value', [state, 'c'.repeat(64)]), false);
  assert.equal(await scalar('SELECT public.origin_sync_consume_oauth_state($1,$2) AS value', [state, browser]), true);
  assert.equal(await scalar('SELECT public.origin_sync_consume_oauth_state($1,$2) AS value', [state, browser]), false);
  await assert.rejects(() => scalar('SELECT public.origin_sync_create_oauth_state($1,$2,clock_timestamp()+interval \'11 minutes\') AS value', [state, browser]), sqlError('22023'));
  await scalar('SELECT public.origin_sync_create_oauth_state($1,$2,$3::timestamptz) AS value', [state, browser, expiry]);
  await db.query("UPDATE origin_sync.oauth_state SET expires_at=clock_timestamp()-interval '1 second' WHERE state_hash=$1", [state]);
  assert.equal(await scalar('SELECT public.origin_sync_consume_oauth_state($1,$2) AS value', [state, browser]), false);
});

test('credentials require an OAuth lease and compare-and-swap revision', async () => {
  const ciphertext = { version: 1, iv: 'synthetic-iv', data: 'synthetic-ciphertext' };
  const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const put = (owner, token, revision) => scalar('SELECT public.origin_sync_put_credentials($1::jsonb,$2::timestamptz,$3::bigint,$4::uuid,$5::uuid) AS value', [JSON.stringify(ciphertext), expiry, revision, owner, token]);
  await assert.rejects(() => put(randomUUID(), randomUUID(), 0), sqlError('55000'));
  const lease = await claim('__oauth__');
  assert.equal((await put(lease.owner, lease.lease_token, 0)).revision, 1);
  await assert.rejects(() => put(lease.owner, lease.lease_token, 0), sqlError('40001'));
  assert.equal((await put(lease.owner, lease.lease_token, 1)).revision, 2);
  assert.deepEqual((await scalar('SELECT public.origin_sync_get_credentials() AS value')).ciphertext, ciphertext);
});

test('admin status exposes counts and cursor metadata without credential or raw payload', async () => {
  await db.exec('SET ROLE service_role');
  try {
    const status = await scalar('SELECT public.origin_sync_status() AS value');
    assert.equal(status.connected, true);
    assert.ok(status.entities.find(entity => entity.entity === 'products').records > 0);
    assert.ok(status.resources.some(resource => resource.resource === 'test_products_zero'));
    assert.equal(status.ciphertext, undefined);
    assert.equal(status.payload, undefined);
    assert.doesNotMatch(JSON.stringify(status), /synthetic|ciphertext|lease_token|lease_owner/);
  } finally {
    await db.exec('RESET ROLE');
  }
});

test('authorized auxiliary catalogs retain independent identities and idempotent checkpoints', async () => {
  for (const entity of ['payment_methods', 'sellers']) {
    const lease = await claim(`aux_${entity}`);
    const batchId = randomUUID();
    const batch = { entity, batchId, records: [{ source_id: '1001', payload: { id: '1001', synthetic: true } }], checkpoint: { page: 2 } };
    assert.equal((await apply(lease, batch)).inserted, 1);
    assert.equal((await apply(lease, batch)).replayed, true);
  }
  const stored = await db.query("SELECT entity,source_id FROM origin_sync.raw_record WHERE entity IN ('payment_methods','sellers') ORDER BY entity");
  assert.deepEqual(stored.rows, [{ entity: 'payment_methods', source_id: '1001' }, { entity: 'sellers', source_id: '1001' }]);
});
