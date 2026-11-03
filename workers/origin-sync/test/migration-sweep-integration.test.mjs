import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { historyFixture } from '../../erp-api/test/helpers/sales-history-fixture.mjs';
import { OriginClient } from '../src/client.mjs';
import { createMigrationPlan, runMigrationSweep } from '../src/migration-sweep.mjs';

let f, owner, scheduler;
const migrations = new URL('../../../supabase/migrations/', import.meta.url);
const ordinary = { version: 1, history: { page: 116 }, recent: { page: 4 }, unfiltered: { after: '333' }, nextLane: 'history' };
const state = resource => f.scalar('select checkpoint v from origin_sync.resource_state where resource=$1', [resource]);
const history = () => f.scalar("select jsonb_build_object('snapshots',(select jsonb_agg(to_jsonb(s)order by source_id)from erp_sales_history.snapshot s),'commands',(select jsonb_agg(to_jsonb(c)order by command_id)from erp_sales_history.command c))v");
const plan = (resource, sourceIds, extra = {}) => createMigrationPlan({ campaign: `synthetic-integration-${resource}`, resource,
  mode: 'directed', cutoff: '2026-10-17 15:00:00', sourceIds, ...extra });

before(async () => {
  f = await historyFixture();
  for (const name of (await readdir(migrations)).filter(name => /^2026101600(?:8[4-9]|90)_/.test(name)).sort()) {
    await f.db.exec(await readFile(new URL(name, migrations), 'utf8'));
  }
  await f.db.exec(await readFile(new URL('202610170091_origin_migration_sweep.sql', migrations), 'utf8'));
  owner = randomUUID(); scheduler = await f.rpc('origin_sync_claim', { p_resource: '__scheduler__', p_owner: owner, p_ttl_seconds: 600 });
});
after(() => f?.close());

async function initialize(resource) {
  await f.rpc('origin_sync_claim', { p_resource: resource, p_owner: owner, p_ttl_seconds: 300 });
  await f.db.query('update origin_sync.resource_state set checkpoint=$2 where resource=$1', [resource, JSON.stringify(ordinary)]);
}

function ports(fetcher, { loseAck = false, mutateAfterSources } = {}) {
  const calls = []; let lost = false;
  const repo = {
    async rpc(name, args) {
      calls.push({ name, args }); const result = await f.rpc(name, args);
      if (name === 'origin_sync_migration_sources') await mutateAfterSources?.(args);
      if (name === 'origin_sync_migration_apply' && args.p_records.length && loseAck && !lost) { lost = true; throw new Error('DATABASE_UNAVAILABLE'); }
      return result;
    },
    claim(resource, actor, ttl) { return this.rpc('origin_sync_claim', { p_resource: resource, p_owner: actor, p_ttl_seconds: ttl }); },
    renew(resource, actor, token, ttl) { return this.rpc('origin_sync_renew', { p_resource: resource, p_owner: actor, p_lease_token: token, p_ttl_seconds: ttl }); },
    release(resource, actor, token) { return this.rpc('origin_sync_release', { p_resource: resource, p_owner: actor, p_lease_token: token }); },
  };
  const client = new OriginClient('synthetic-only', { apiOrigin: 'https://api.provider.example', intervalMs: 0, maxRequests: 200,
    priceCaptureEnabled: true, purchasePriceCaptureEnabled: true, salesPriceCaptureEnabled: true,
    fetchImpl: async (url, init) => { assert.equal(init.method, 'GET'); return fetcher(new URL(url)); } });
  return { repo, client, calls, run: (p, extra = {}) => runMigrationSweep(repo, client,
    { owner, lease: scheduler, deadline: Date.now() + 160000, plan: p, reserveRequests: 0, ...extra }) };
}

test('real091 accepts atomic page/chunk receipts and skips existing sources under CAS', async () => {
  await initialize('payables');
  const existing = '919201';
  await f.db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,document_links,version_hash)values('payables','payables',$1,$2,'[{\"type\":\"backup\"}]',repeat('a',64))", [existing, JSON.stringify({ id: existing })]);
  const old = await f.scalar("select to_jsonb(r)v from origin_sync.raw_record r where entity='payables'and source_id=$1", [existing]);
  const io = ports(url => Response.json({ data: { id: url.pathname.split('/').at(-1), situacao: 1 } }));
  const result = await io.run(await plan('payables', [existing, '919202', '919203'], { onlyMissing: true }));
  assert.deepEqual(result.errors, []); assert.equal(result.completed, true); assert.equal(result.stored, 2); assert.equal(result.present, 1); assert.equal(result.requests, 2);
  assert.deepEqual(await f.scalar("select to_jsonb(r)v from origin_sync.raw_record r where entity='payables'and source_id=$1", [existing]), old);
  const cp = await state('payables'); assert.deepEqual(cp.history, ordinary.history); assert.deepEqual(cp.unfiltered, ordinary.unfiltered);
  assert.equal(cp.migration.processed, 3); assert.ok(cp._migration_guard);
  const receipt = await f.scalar("select result->'migration_receipt'v from origin_sync.batch_inbox where resource='payables'order by applied_at desc limit 1");
  assert.deepEqual(receipt.guarded_source_ids, [existing, '919202', '919203']); assert.deepEqual(receipt.source_ids, ['919202', '919203']);
});

test('real091 current historical sale capture preserves083 snapshot, links and exact price lexeme', async () => {
  const id = await f.sale('919211'); await f.capture(id); await initialize('sales_orders');
  await f.db.query("update origin_sync.raw_record set price_capture=null,document_links='[{\"type\":\"preserve\"}]'where entity='sales_orders'and source_id=$1", [id]);
  const before = await history();
  const io = ports(() => new Response(`{"data":{"id":"${id}","itens":[{"valor":0.123456789123}]}}`));
  const result = await io.run(await plan('sales_orders', [id]));
  assert.deepEqual(result.errors, []); assert.equal(result.stored, 1); assert.equal(result.completed, true); assert.deepEqual(await history(), before);
  const row = await f.scalar("select jsonb_build_object('lexeme',price_capture#>>'{tokens,0,lexeme}','links',document_links,'value',payload#>>'{itens,0,valor}')v from origin_sync.raw_record where entity='sales_orders'and source_id=$1", [id]);
  assert.equal(row.lexeme, '0.123456789123'); assert.equal(row.value, row.lexeme); assert.deepEqual(row.links, [{ type: 'preserve' }]);
});

test('real091 stock directed observation preserves the ordinary lexical cursor', async () => {
  await initialize('stock_balances');
  const io = ports(url => Response.json({ data: url.searchParams.get('filtroSaldoEstoque') === '0'
    ? url.searchParams.getAll('idsProdutos[]').map(id => ({ produto: { id }, saldoFisicoTotal: 0, depositos: [{ id: '7', saldoFisico: 0 }] })) : [] }));
  const result = await io.run(await plan('stock_balances', ['919221', '919222']));
  assert.deepEqual(result.errors, []); assert.equal(result.completed, true); assert.equal(result.stored, 2); assert.equal(result.requests, 3);
  assert.deepEqual((await state('stock_balances')).unfiltered, ordinary.unfiltered);
});

test('real committed chunk with lost ACK resumes from durable checkpoint, never repeats its details', async () => {
  await initialize('receivables'); const observed = [];
  const io = ports(url => { observed.push(url.pathname.split('/').at(-1)); return Response.json({ data: { id: observed.at(-1) } }); }, { loseAck: true });
  const p = await plan('receivables', ['919231', '919232', '919233']);
  const first = await io.run(p, { chunkSize: 2 }); assert.equal(first.stop_json, true); assert.equal(first.stored, 0);
  assert.equal((await state('receivables')).migration.directed_offset, 2);
  const second = await io.run(p); assert.deepEqual(second.errors, []); assert.equal(second.completed, true); assert.equal(second.stored, 1);
  assert.deepEqual(observed, ['919231', '919232', '919233']);
});

test('real091 rejects a source inserted between metadata read and GET without overwriting it', async () => {
  await initialize('contacts'); const id = '919241';
  const io = ports(() => Response.json({ data: { id, nome: 'Later GET' } }), { mutateAfterSources: async () => {
    await f.db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values('contacts','contacts',$1,$2,repeat('b',64))", [id, JSON.stringify({ id, nome: 'Concurrent source' })]);
  } });
  const result = await io.run(await plan('contacts', [id])); assert.equal(result.stop_json, true); assert.equal(result.stored, 0);
  assert.equal((await state('contacts')).migration.directed_offset, 0);
  assert.equal(await f.scalar("select payload->>'nome'v from origin_sync.raw_record where entity='contacts'and source_id=$1", [id]), 'Concurrent source');
});
