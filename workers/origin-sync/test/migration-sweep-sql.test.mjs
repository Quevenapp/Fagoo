import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { historyFixture } from '../../erp-api/test/helpers/sales-history-fixture.mjs';
import { parseSalesPriceJson, salesPriceCapture } from '../src/sales-price-json.mjs';

let f, owner, scheduler, oldRows, oldFunctions, oldSecurity, oldHistory;
let serial = 91910000;
const error = code => value => value.code === code;
const source = () => String(++serial);
const migrations = new URL('../../../supabase/migrations/', import.meta.url);
const history = () => f.scalar("select jsonb_build_object('snapshots',(select jsonb_agg(to_jsonb(s)order by source_id)from erp_sales_history.snapshot s),'commands',(select jsonb_agg(to_jsonb(c)order by command_id)from erp_sales_history.command c))v");
const raw = (entity, id) => f.scalar('select to_jsonb(r)v from origin_sync.raw_record r where entity=$1 and source_id=$2', [entity, id]);
const checkpoint = resource => f.scalar('select jsonb_build_object(\'checkpoint\',checkpoint,\'version\',checkpoint_version::text)v from origin_sync.resource_state where resource=$1', [resource]);
async function acquire(resource = 'contacts') {
  const lease = await f.rpc('origin_sync_claim', { p_resource: resource, p_owner: owner, p_ttl_seconds: 600 });
  assert.equal(lease.acquired, true);
  return { resource, lease };
}
const identity = job => ({ p_resource: job.resource, p_owner: owner,
  p_scheduler_token: scheduler.lease_token, p_resource_token: job.lease.lease_token });
const metadata = (job, ids) => f.rpc('origin_sync_migration_sources', { ...identity(job), p_ids: ids });
async function seed(entity, id, { links = [], date = null, payload = { id, nome: 'Synthetic migration source' } } = {}) {
  await f.db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,document_links,version_hash,source_updated_at)values($1,'synthetic091',$2,$3,$4,repeat('a',64),$5)",
    [entity, id, JSON.stringify(payload), JSON.stringify(links), date]);
}
async function args(job, records, expected = null, cp = null) {
  return { ...identity(job), p_entity: job.resource === 'products_zero' ? 'products' : job.resource,
    p_batch_id: randomUUID(), p_records: records,
    p_checkpoint: cp ?? { version: 1, recent: { page: 7 }, history: { page: 11 }, migration: { offset: records.length } },
    p_expected_checkpoint_version: (await checkpoint(job.resource)).version,
    p_expected_sources: expected ?? await metadata(job, records.map(row => row.source_id)) };
}
const apply = input => f.rpc('origin_sync_migration_apply', input);

before(async () => {
  f = await historyFixture();
  for (const name of (await readdir(migrations)).filter(name => /^2026101600(?:8[4-9]|90)_/.test(name)).sort()) {
    await f.db.exec(await readFile(new URL(name, migrations), 'utf8'));
  }
  const id = await f.sale(source()); await f.capture(id);
  owner = randomUUID();
  scheduler = await f.rpc('origin_sync_claim', { p_resource: '__scheduler__', p_owner: owner, p_ttl_seconds: 600 });
  await f.db.exec("insert into origin_sync.resource_state(resource)values('synthetic091')");
  oldRows = await f.fingerprint(); oldSecurity = await f.security(); oldHistory = await history();
  oldFunctions = await f.scalar("select jsonb_agg(to_jsonb(p)order by p.oid)v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname like 'erp_%'or n.nspname like 'origin_%'or n.nspname='public'");
  await f.db.exec(await readFile(new URL('202610170091_origin_migration_sweep.sql', migrations), 'utf8'));
});
after(() => f?.close());

test('091 preserves every old row, function and security contract during installation', async () => {
  assert.deepEqual(await f.fingerprint(), oldRows); assert.deepEqual(await f.security(), oldSecurity);
  assert.deepEqual(await history(), oldHistory);
  const oids = oldFunctions.map(row => row.oid);
  assert.deepEqual(await f.scalar('select jsonb_agg(to_jsonb(p)order by oid)v from pg_proc p where oid=any($1::oid[])', [oids]), oldFunctions);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(await f.scalar("select has_function_privilege($1,'public.origin_sync_migration_sources(text,uuid,uuid,uuid,jsonb)','EXECUTE')v", [role]), role === 'service_role');
    assert.equal(await f.scalar("select has_function_privilege($1,'origin_sync.migration_source_metadata(text,jsonb)','EXECUTE')v", [role]), false);
    assert.equal(await f.scalar("select has_table_privilege($1,'origin_sync.raw_record','SELECT')v", [role]), false);
  }
});

test('metadata is exact, sorted, read-only and distinguishes an absent source', async () => {
  const job = await acquire(), id = source(), absent = source();
  await seed('contacts', id, { links: [{ type: 'backup', path: 'synthetic-only' }] });
  const before = await f.fingerprint(), result = await metadata(job, [absent, id]);
  assert.deepEqual(result.map(row => row.source_id), [id, absent].sort());
  assert.deepEqual(result.find(row => row.source_id === absent), {
    source_id: absent, exists: false, source_hash: null, source_version: null, last_seen_at: null, document_links: null,
  });
  assert.equal(result.find(row => row.source_id === id).exists, true);
  assert.match(result.find(row => row.source_id === id).last_seen_at, /^\d{4}-\d{2}-\d{2}T.*\.\d{6}Z$/);
  assert.deepEqual(await f.fingerprint(), before);
});

test('a guarded ingestion preserves source links, source date and ordinary polling cursors', async () => {
  const job = await acquire(), id = source(), links = [{ type: 'backup', path: 'preserved-synthetic' }];
  await seed('contacts', id, { links, date: '2026-10-01T12:30:00Z' });
  const input = await args(job, [{ source_id: id, payload: { id, nome: 'Fresh synthetic detail' }, document_links: links }]);
  const result = await apply(input), current = await raw('contacts', id), cp = await checkpoint(job.resource);
  assert.equal(result.batch_id, input.p_batch_id); assert.equal(result.migration_receipt.records, 1);
  assert.deepEqual(current.document_links, links); assert.equal(Date.parse(current.source_updated_at), Date.parse('2026-10-01T12:30:00Z'));
  assert.deepEqual(cp.checkpoint.recent, input.p_checkpoint.recent); assert.deepEqual(cp.checkpoint.history, input.p_checkpoint.history);
  assert.deepEqual(cp.checkpoint.migration, input.p_checkpoint.migration);
  assert.match(cp.checkpoint._migration_guard.request_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(await history(), oldHistory);
});

test('empty checkpoint commits can freeze a list without modifying staging rows', async () => {
  const job = await acquire(), before = await f.scalar('select jsonb_agg(to_jsonb(r)order by entity,source_id)v from origin_sync.raw_record r');
  const input = await args(job, [], [], { version: 1, migration: { ids: ['1', '2'], offset: 0, pageSize: 100 } });
  assert.equal((await apply(input)).migration_receipt.records, 0);
  assert.deepEqual(await f.scalar('select jsonb_agg(to_jsonb(r)order by entity,source_id)v from origin_sync.raw_record r'), before);
});

test('already present sources can be skipped only under the same exact source CAS', async () => {
  const job = await acquire(), id = source(), absent = source(); await seed('contacts', id);
  const expected = await metadata(job, [id]);
  const input = await args(job, [], expected, { migration: { present: 1 } });
  const result = await apply(input);
  assert.equal(result.migration_receipt.records, 0);
  assert.deepEqual(result.migration_receipt.source_ids, []);
  assert.deepEqual(result.migration_receipt.guarded_source_ids, [id]);
  assert.deepEqual(result.migration_receipt.migration_checkpoint, input.p_checkpoint.migration);
  const stale = await args(job, [], expected, { migration: { present: 2 } });
  await f.db.query("update origin_sync.raw_record set last_seen_at=clock_timestamp()+interval'1 second'where entity='contacts'and source_id=$1", [id]);
  await assert.rejects(apply(stale), error('40001'));
  const unknown = await args(job, [], await metadata(job, [absent]));
  await assert.rejects(apply(unknown), error('22023'));
});

test('changed source hash, version, observation, links and an inserted absent ID all reject atomically', async () => {
  for (const alteration of ['hash', 'version', 'seen', 'links', 'insert']) {
    const job = await acquire(), id = source();
    if (alteration !== 'insert') await seed('contacts', id);
    const input = await args(job, [{ source_id: id, payload: { id, nome: 'Synthetic CAS detail' }, document_links: [] }]);
    if (alteration === 'insert') await seed('contacts', id);
    else {
      const clause = { hash: "version_hash=repeat('b',64)", version: 'version=version+1', seen: "last_seen_at=last_seen_at+interval'1 microsecond'", links: "document_links='[{\"type\":\"changed\"}]'" }[alteration];
      await f.db.query(`update origin_sync.raw_record set ${clause} where entity='contacts'and source_id=$1`, [id]);
    }
    const before = await f.fingerprint();
    await assert.rejects(apply(input), error('40001')); assert.deepEqual(await f.fingerprint(), before);
  }
});

test('callers cannot erase links or forge another entity or expected identity', async () => {
  const job = await acquire(), id = source(); await seed('contacts', id, { links: [{ type: 'backup' }] });
  const input = await args(job, [{ source_id: id, payload: { id }, document_links: [] }]);
  await assert.rejects(apply(input), error('40001'));
  await assert.rejects(apply({ ...input, p_entity: 'products' }), error('22023'));
  await assert.rejects(apply({ ...input, p_expected_sources: [{ ...input.p_expected_sources[0], source_id: source() }] }), error('22023'));
});

test('confirmed replay verifies the original body after later source changes and expired leases', async () => {
  const job = await acquire(), id = source();
  const input = await args(job, [{ source_id: id, payload: { id, nome: 'Original detail' }, document_links: [] }]);
  const first = await apply(input);
  await f.db.query("update origin_sync.raw_record set payload=payload||'{\"later\":true}',source_updated_at=clock_timestamp()where entity='contacts'and source_id=$1", [id]);
  await f.db.exec("update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval'1 second'where resource in('contacts','__scheduler__')");
  const before = await f.fingerprint(); assert.deepEqual(await apply(input), { ...first, replayed: true });
  assert.deepEqual(await f.fingerprint(), before);
  await assert.rejects(apply({ ...input, p_records: [{ ...input.p_records[0], payload: { id, nome: 'Different request' } }] }), error('22023'));
  await assert.rejects(apply({ ...input, p_expected_sources: [{ ...input.p_expected_sources[0], source_hash: 'c'.repeat(64) }] }), error('22023'));
  scheduler = await f.rpc('origin_sync_claim', { p_resource: '__scheduler__', p_owner: owner, p_ttl_seconds: 600 });
});

test('a new write requires both current lease fences and current checkpoint version', async () => {
  const job = await acquire(), id = source();
  const input = await args(job, [{ source_id: id, payload: { id }, document_links: [] }]);
  const before = await f.fingerprint();
  for (const patch of [{ p_scheduler_token: randomUUID() }, { p_resource_token: randomUUID() }, { p_owner: randomUUID() }]) {
    await assert.rejects(apply({ ...input, ...patch }), error('55000')); assert.deepEqual(await f.fingerprint(), before);
  }
  await assert.rejects(apply({ ...input, p_expected_checkpoint_version: '9999999' }), error('40001'));
  assert.deepEqual(await f.fingerprint(), before);
});

test('current precise sale capture can refresh an old historical source without modifying its snapshot', async () => {
  const job = await acquire('sales_orders'), id = await f.sale(source()); await f.capture(id);
  await f.db.query("update origin_sync.raw_record set price_capture=null,document_links='[{\"type\":\"backup\"}]'where entity='sales_orders'and source_id=$1", [id]);
  const before = await history(), text = `{"data":{"id":"${id}","itens":[{"valor":1.234567890123}]}}`;
  const parsed = await parseSalesPriceJson(text, new TextEncoder().encode(text), 'sales_detail');
  const input = await args(job, [{ source_id: id, payload: parsed.data, document_links: [{ type: 'backup' }], price_capture: salesPriceCapture(parsed.data) }]);
  const result = await apply(input), current = await raw('sales_orders', id);
  assert.equal(result.sales_price_captures, 1); assert.equal(current.price_capture.tokens[0].lexeme, '1.234567890123');
  assert.deepEqual(current.document_links, [{ type: 'backup' }]); assert.deepEqual(await history(), before);
});

test('a global lease that expires during the write rolls back rows, checkpoint and receipt', async () => {
  const job = await acquire(), id = source();
  const input = await args(job, [{ source_id: id, payload: { id }, document_links: [] }]);
  await f.db.exec("create function origin_sync.synthetic_expire091()returns trigger language plpgsql as $$begin update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval'1 second'where resource='__scheduler__';return NEW;end$$;create trigger synthetic_expire091 after insert on origin_sync.raw_record for each row execute function origin_sync.synthetic_expire091();");
  const before = await f.fingerprint();
  try { await assert.rejects(apply(input), error('55000')); assert.deepEqual(await f.fingerprint(), before); }
  finally { await f.db.exec('drop trigger synthetic_expire091 on origin_sync.raw_record;drop function origin_sync.synthetic_expire091();'); }
});

test('oversized, duplicate or malformed requests stop before any mutation', async () => {
  const job = await acquire(), id = source(), input = await args(job, [{ source_id: id, payload: { id }, document_links: [] }]);
  const before = await f.fingerprint();
  for (const patch of [{ p_records: Array(26).fill(input.p_records[0]) },
    { p_records: [input.p_records[0], input.p_records[0]], p_expected_sources: [input.p_expected_sources[0], input.p_expected_sources[0]] },
    { p_records: [{ ...input.p_records[0], payload: { id: source() } }] },
    { p_records: [{ ...input.p_records[0], source_updated_at: '2026-10-17' }] },
    { p_checkpoint: { large: 'x'.repeat(62001) } }, { p_expected_sources: [] }]) {
    await assert.rejects(apply({ ...input, ...patch }), error('22023')); assert.deepEqual(await f.fingerprint(), before);
  }
  await assert.rejects(metadata(job, [id, id]), error('22023'));
  await assert.rejects(metadata(job, ['01']), error('22023'));
});
