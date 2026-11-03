import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { refreshFinance } from '../src/finance-refresh.mjs';
import { OriginClient } from '../src/client.mjs';

let db, lease;
const owner = randomUUID();
const errorCode = code => error => error.code === code;
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].value;
const rpc = async (suffix, args = {}) => {
  const entries = Object.entries(args);
  await db.exec('set role service_role');
  try {
    return await scalar(`select public.origin_sync_finance_refresh_${suffix}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(',')}) value`,
      entries.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value));
  } finally { await db.exec('reset role'); }
};
const identity = () => ({ p_owner: owner, p_lease_token: lease.lease_token });
const candidates = async (options = {}) => (await rpc('candidates', { ...identity(), ...options })).items;
const row = id => scalar('select to_jsonb(r) value from origin_sync.raw_record r where source_id=$1', [id]);
const begin = candidate => rpc('begin', { ...identity(), p_attempt_id: randomUUID(), p_entity: candidate.entity,
  p_source_id: candidate.source_id, p_source_hash: candidate.source_hash, p_source_seen_at: candidate.source_seen_at });
const finish = (attempt, payload) => rpc('finish', { ...identity(), p_attempt_id: attempt.attempt_id, p_payload: payload });
const fail = (attempt, code = 'ORIGIN_HTTP_404', status = 404) => rpc('fail', { ...identity(), p_attempt_id: attempt.attempt_id, p_code: code, p_http_status: status });
const payload = (id, status = 1, balance = 100) => ({ id, situacao: status, valor: 100, saldo: balance, synthetic: true });
async function seed(id, entity = 'receivables', p = payload(id), age = 7200) {
  await db.query(`insert into origin_sync.raw_record(entity,last_resource,source_id,payload,document_links,version_hash,last_seen_at,source_updated_at)
   values($1,'synthetic_seed',$2,$3::jsonb,'[]',encode(sha256(convert_to(jsonb_build_object('payload',$3::jsonb,'document_links','[]'::jsonb)::text,'UTF8')),'hex'),
    clock_timestamp()-make_interval(secs=>$4),'2020-01-01T00:00:00Z')`, [entity, id, JSON.stringify(p), age]);
}
before(async () => {
  db = new PGlite();
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  for (const filename of ['202610160001_origin_sync.sql', '202610160002_origin_quotes_nfce.sql', '202610160005_origin_auxiliary_catalogs.sql', '202610160030_origin_finance_refresh.sql']) {
    await db.exec(await readFile(new URL(`../../../supabase/migrations/${filename}`, import.meta.url), 'utf8'));
  }
  await db.exec("insert into origin_sync.resource_state(resource) values('synthetic_seed')");
});
beforeEach(async () => {
  await db.exec('truncate origin_finance_refresh.attempt,origin_finance_refresh.origin,origin_sync.raw_record cascade;update origin_finance_refresh.entity_state set retry_after=null,last_error=null;');
  lease = await scalar("select public.origin_sync_claim('__scheduler__',$1,600) value", [owner]);
});
after(() => db?.close());

test('030 is service-only, has RLS and never grants direct table access', async () => {
  const rows = (await db.query("select relrowsecurity from pg_class join pg_namespace on pg_namespace.oid=relnamespace where nspname='origin_finance_refresh' and relkind='r'")).rows;
  assert.equal(rows.length, 3); assert.ok(rows.every(r => r.relrowsecurity));
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await db.exec(`set role ${role}`);
    try {
      await assert.rejects(db.query('select * from origin_finance_refresh.attempt'), errorCode('42501'));
      if (role !== 'service_role') await assert.rejects(scalar('select public.origin_sync_finance_refresh_status() value'), errorCode('42501'));
    } finally { await db.exec('reset role'); }
  }
  assert.equal((await rpc('status')).erp_mutations, false);
});

test('old open/partial candidates alternate AR/AP, cap eight, and exclude fresh/unknown/closed', async () => {
  for (let i = 1; i <= 6; i++) { await seed(`${100 + i}`); await seed(`${200 + i}`, 'payables', payload(`${200 + i}`, 3, 40)); }
  await seed('300', 'receivables', payload('300'), 0);
  for (const status of [2, 4, 5, 6, 7, null]) await seed(`40${status ?? 0}`, 'receivables', payload(`40${status ?? 0}`, status));
  const list = await candidates(); assert.equal(list.length, 8);
  assert.deepEqual(list.map(x => x.entity), ['payables', 'receivables', 'payables', 'receivables', 'payables', 'receivables', 'payables', 'receivables']);
  await assert.rejects(candidates({ p_limit: 9 }), errorCode('22023'));
  const stats = await rpc('status'); assert.equal(stats.coverage_complete, false);
  assert.equal(stats.entities.find(x => x.entity === 'receivables').stale, 6);
  assert.doesNotMatch(JSON.stringify(stats), /source_id|valor|contato|synthetic_seed/);
});

test('begin has exact replay, holds a retry slot and rejects mismatched identity/hash', async () => {
  await seed('101'); const c = (await candidates())[0];
  const args = { ...identity(), p_attempt_id: randomUUID(), p_entity: c.entity, p_source_id: c.source_id, p_source_hash: c.source_hash, p_source_seen_at: c.source_seen_at };
  const first = await rpc('begin', args), replay = await rpc('begin', args);
  assert.equal(replay.attempt_id, first.attempt_id); assert.equal(replay.replayed, true); assert.equal((await candidates()).length, 0);
  await assert.rejects(rpc('begin', { ...args, p_source_hash: 'f'.repeat(64) }), errorCode('40001'));
  assert.equal(await scalar('select count(*)::int value from origin_finance_refresh.attempt'), 1);
});

test('old title can become paid only from a matching detail, with provenance and exact finish replay', async () => {
  await seed('101'); const initial = await row('101'); const a = await begin((await candidates())[0]);
  const result = await finish(a, payload('101', 2, 0));
  assert.deepEqual(result, { stored: true, conflict: false, unchanged: false, balance_available: true, replayed: false });
  const current = await row('101'); assert.equal(current.payload.situacao, 2); assert.equal(current.version, initial.version + 1);
  assert.equal(current.last_resource, 'receivables_refresh'); assert.equal(current.source_updated_at, initial.source_updated_at);
  assert.deepEqual(current.document_links, initial.document_links); assert.equal((await candidates()).length, 0);
  const replay = await finish(a, payload('101', 2, 0)); assert.equal(replay.replayed, true); assert.deepEqual(await row('101'), current);
  await assert.rejects(finish(a, payload('101', 2, 1)), errorCode('40001'));
  await assert.rejects(db.exec("update origin_finance_refresh.attempt set error_code='ALTERED'"), errorCode('55000'));
});

test('unchanged payload renews only observation; absent or fractional saldo never becomes zero', async () => {
  await seed('101'); let a = await begin((await candidates())[0]); const initial = await row('101');
  assert.equal((await finish(a, payload('101'))).unchanged, true);
  const same = await row('101'); assert.equal(same.version, initial.version); assert.equal(same.changed_at, initial.changed_at);
  assert.ok(same.last_seen_at > initial.last_seen_at);
  for (const [id, value] of [['102', null], ['103', 0.001], ['104', '100.00']]) {
    await seed(id); a = await begin((await candidates()).find(x => x.source_id === id));
    const p = payload(id, 3, value); if (id === '102') delete p.saldo;
    assert.equal((await finish(a, p)).balance_available, false);
    assert.equal((await row(id)).payload.saldo, p.saldo);
    assert.equal((await row(id)).payload.situacao, 3);
  }
});

test('404 and missing status preserve raw data; failures back off without monopolizing the queue', async () => {
  await seed('101'); await seed('102'); const c = (await candidates())[0], before = await row(c.source_id), a = await begin(c);
  await assert.rejects(finish(a, { id: c.source_id, saldo: 0 }), errorCode('22023'));
  await assert.rejects(finish(a, payload('999')), errorCode('22023'));
  assert.equal((await fail(a)).recorded, true); assert.equal((await fail(a)).replayed, true);
  assert.deepEqual(await row(c.source_id), before);
  assert.ok((await candidates()).every(x => x.source_id !== c.source_id));
  assert.equal((await candidates()).length, 1);
  await db.exec("update origin_finance_refresh.origin set next_attempt_at=clock_timestamp()-interval '1 second'");
  assert.notEqual((await candidates({ p_limit: 1 }))[0].source_id, c.source_id);
});

test('403 suspends the resource but leaves the other entity eligible, without marking titles closed', async () => {
  await seed('101'); await seed('102'); await seed('201', 'payables');
  const a = await begin((await candidates()).find(x => x.entity === 'receivables'));
  await fail(a, 'ORIGIN_HTTP_403', 403);
  assert.deepEqual((await candidates()).map(x => x.entity), ['payables']);
  assert.equal((await row('101')).payload.situacao, 1);
  assert.ok((await rpc('status')).entities.find(x => x.entity === 'receivables').retry_after);
});

test('CAS rejects both newer contents and a newer observation with identical hash', async () => {
  for (const id of ['101', '102']) {
    await seed(id); const a = await begin((await candidates()).find(x => x.source_id === id));
    if (id === '101') await db.query("update origin_sync.raw_record set version_hash=repeat('b',64),payload=jsonb_set(payload,'{saldo}','25') where source_id=$1", [id]);
    else await db.query('update origin_sync.raw_record set last_seen_at=clock_timestamp() where source_id=$1', [id]);
    const newer = await row(id); const rejected = await finish(a, payload(id, 2, 0));
    assert.equal(rejected.conflict, true); assert.equal(rejected.stored, false); assert.deepEqual(await row(id), newer);
    assert.equal((await finish(a, payload(id, 2, 0))).replayed, true);
  }
});

test('expired or changed scheduler fence cannot commit; successful replay does not reapply', async () => {
  await seed('101'); const a = await begin((await candidates())[0]);
  await db.exec("update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second' where resource='__scheduler__'");
  await assert.rejects(finish(a, payload('101', 2, 0)), errorCode('55000'));
  const next = await scalar("select public.origin_sync_claim('__scheduler__',$1,600) value", [owner]); assert.notEqual(next.lease_token, lease.lease_token);
  await assert.rejects(finish(a, payload('101', 2, 0)), errorCode('55000')); lease = next;
  await db.exec("update origin_finance_refresh.origin set next_attempt_at=clock_timestamp()-interval '1 second'");
  const b = await begin((await candidates())[0]); await finish(b, payload('101', 2, 0)); const saved = await row('101');
  await db.exec("update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second' where resource='__scheduler__'");
  assert.equal((await finish(b, payload('101', 2, 0))).replayed, true); assert.deepEqual(await row('101'), saved);
});

test('a late failure cannot undo a committed success; storage/provenance rollback is atomic', async () => {
  await seed('101'); const a = await begin((await candidates())[0]);
  await db.exec(`create function origin_finance_refresh.test_reject() returns trigger language plpgsql as $$begin if NEW.last_success_at is not null then raise exception 'synthetic rollback';end if;return NEW;end;$$;
    create trigger test_reject before update on origin_finance_refresh.origin for each row execute function origin_finance_refresh.test_reject();`);
  const prior = await row('101'); await assert.rejects(finish(a, payload('101', 2, 0)), /synthetic rollback/);
  assert.deepEqual(await row('101'), prior);
  assert.equal(await scalar("select state value from origin_finance_refresh.attempt where id=$1", [a.attempt_id]), 'pending');
  await db.exec('drop trigger test_reject on origin_finance_refresh.origin;drop function origin_finance_refresh.test_reject();');
  await finish(a, payload('101', 2, 0)); const saved = await row('101');
  assert.equal((await fail(a, 'DATABASE_UNAVAILABLE', null)).already_finished, true); assert.deepEqual(await row('101'), saved);
});

test('collector against actual 030 RPCs accepts exact timestamps and stores only the matching detail', async () => {
  await seed('101'); await seed('201', 'payables', payload('201', 3, 50));
  const client = new OriginClient('synthetic-token', { apiOrigin: 'https://api.provider.example', intervalMs: 0, fetchImpl: async url => {
    const id = url.split('/').at(-1); return Response.json({ data: payload(id, id === '101' ? 2 : 3, id === '101' ? 0 : null) });
  } });
  const result = await refreshFinance({ rpc: (name, args) => rpc(name.replace('origin_sync_finance_refresh_', ''), args) }, client,
    { owner, lease, deadline: Date.now() + 180000 });
  assert.equal(result.stored, 2); assert.equal(result.unavailable_balance, 1); assert.deepEqual(result.errors, []);
  assert.equal((await row('101')).payload.situacao, 2); assert.equal((await row('201')).payload.saldo, null);
});
