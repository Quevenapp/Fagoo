import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMigrationPlan } from '../src/migration-sweep.mjs';
import { migrationPolicy, migrationSchedulerState, nextMigrationPlan } from '../src/migration-policy.mjs';
import { runSync } from '../src/sync.mjs';
import { getResource } from '../src/resources.mjs';

const now = new Date('2026-10-17T18:10:00Z');
const make = (resource = 'contacts', patch = {}) => createMigrationPlan({ campaign: 'synthetic-migration',
  resource, mode: 'directed', sourceIds: ['991234567891234'], cutoff: '2026-10-17 15:00:00', ...patch });
const config = plans => ({ ORIGIN_ENABLED: 'true', ORIGIN_API_ORIGIN: 'https://api.provider.example', SYNC_ENABLED: 'true', SYNC_START_DATE: '2024-01-01',
  MIGRATION_SWEEP_ENABLED: 'true', MIGRATION_SWEEP_PLANS: plans, MAX_API_REQUESTS: '160' });

test('normal collection ignores migration-only settings until explicitly enabled', async () => {
  assert.equal(await migrationPolicy({ MIGRATION_SWEEP_PLANS: 'invalid' }), null);
  assert.equal(await migrationPolicy({ MIGRATION_SWEEP_ENABLED: 'false', MAX_API_REQUESTS: '999999' }), null);
});

test('migration has finite rate, deadline, daily projection and exact selection pins', async () => {
  const plan = await make(), policy = await migrationPolicy(config([plan]));
  assert.equal(policy.maxRequests, 160); assert.equal(policy.cycleMs, 180000); assert.equal(policy.intervalMs, 700);
  assert.equal(Math.ceil(86400000 / policy.cycleMs) * policy.maxRequests, 76800);
  assert.match(policy.selectionHash, /^[a-f0-9]{64}$/);
  const faster = await migrationPolicy({ ...config([plan]), MAX_API_REQUESTS: '120',
    MIGRATION_SWEEP_CYCLE_MS: '120000', MIGRATION_SWEEP_INTERVAL_MS: '500' });
  assert.equal(Math.ceil(86400000 / faster.cycleMs) * faster.maxRequests, 86400);
  for (const patch of [{ MIGRATION_SWEEP_CYCLE_MS: '60000' }, { MIGRATION_SWEEP_INTERVAL_MS: '100' },
    { MIGRATION_SWEEP_CYCLE_MS: '120000', MAX_API_REQUESTS: '160' }, { MAX_API_REQUESTS: '161' },
    { MIGRATION_SWEEP_PLANS: [] }, { MIGRATION_SWEEP_PLANS: [{ ...plan, hash: 'f'.repeat(64) }] },
    { MIGRATION_SWEEP_PLANS: [plan, plan] }]) {
    await assert.rejects(migrationPolicy({ ...config([plan]), ...patch }));
  }
});

test('two plans for one resource require an explicit ordered predecessor', async () => {
  const a = await make(), b = await make('contacts', { sourceIds: ['991234567891235'] });
  await assert.rejects(migrationPolicy(config([a, b])));
  const c = await make('contacts', { sourceIds: ['991234567891235'], supersedes: a.hash });
  const policy = await migrationPolicy(config([a, c])), state = migrationSchedulerState(policy, {}, now);
  assert.equal(nextMigrationPlan(policy, state).plan.hash, a.hash);
  state.next_index = 1; assert.equal(nextMigrationPlan(policy, state).plan.hash, a.hash);
  state.completed_plan_hashes.push(a.hash); assert.equal(nextMigrationPlan(policy, state).plan.hash, c.hash);
  await assert.rejects(migrationPolicy(config([c, a])));
});

test('scheduler resumes its exact selection and requires a pinned change of campaign', async () => {
  const a = await make(), policy = await migrationPolicy(config([a]));
  const state = migrationSchedulerState(policy, {}, now); state.completed_plan_hashes.push(a.hash); state.completed_at = now.toISOString();
  assert.deepEqual(migrationSchedulerState(policy, { migration_sweep: state }, now), state);
  const b = await make('payables');
  const changed = await migrationPolicy(config([a, b]));
  assert.throws(() => migrationSchedulerState(changed, { migration_sweep: state }, now));
  const permitted = await migrationPolicy({ ...config([a, b]), MIGRATION_SWEEP_PREVIOUS_SELECTION_SHA256: policy.selectionHash });
  const next = migrationSchedulerState(permitted, { migration_sweep: state }, now);
  assert.deepEqual(next.completed_plan_hashes, [a.hash]); assert.equal(next.completed_at, null);
  assert.equal(next.predecessor_selection_sha256, policy.selectionHash);
  assert.throws(() => migrationSchedulerState(policy, { migration_sweep: { ...state, completed_plan_hashes: ['0'.repeat(64)] } }, now));
});

function fixture(checkpoint = {}) {
  let cp = structuredClone(checkpoint); const writes = [], calls = [], clientOptions = [];
  const repo = {
    async claim() { return { acquired: true, lease_token: randomUUID(), checkpoint_version: 1, checkpoint: structuredClone(cp) }; },
    async apply(...args) { writes.push(args); cp = structuredClone(args[5]); return {}; },
    async release() { return { released: true }; }, async renew() { return { renewed: true }; },
  };
  class Client {
    constructor(token, options) { assert.equal(token, 'synthetic-token'); clientOptions.push(options); this.requestsMade = 0; this.maximum = options.maxRequests; }
    get remainingRequests() { return this.maximum - this.requestsMade; }
    async get(path) { this.requestsMade++; calls.push(path); return []; }
  }
  return { repo, Client, writes, calls, clientOptions, checkpoint: () => cp };
}
const part = patch => ({ status: 'completed', attempted: 0, stored: 0, present: 0, unavailable: 0,
  requests: 0, pages: 0, completed: true, errors: [], stop_json: false, stop_residual: false, ...patch });

test('scheduler uses the shared client and preserves all preexisting control checkpoint fields', async () => {
  const plan = await make(), f = fixture({ nextIndex: 0, custom: { keep: true } });
  const result = await runSync(f.repo, config([plan]), { now: () => now, clock: () => now.getTime(),
    getToken: async () => 'synthetic-token', Client: f.Client, resources: [],
    migrationSweeper: async (repo, client, options) => {
      assert.equal(repo, f.repo); assert.equal(options.plan.hash, plan.hash);
      assert.equal(options.reserveRequests, 14); assert.equal(options.deadline, now.getTime()+160000);
      await client.get('/contatos/991234567891234'); return part({ attempted: 1, stored: 1, requests: 1 });
    } });
  assert.equal(result.requests, 1); assert.equal(result.migration_sweep.stored, 1);
  assert.equal(f.clientOptions[0].maxRequests, 160); assert.equal(f.clientOptions[0].intervalMs, 700);
  assert.deepEqual(f.checkpoint().custom, { keep: true });
  assert.deepEqual(f.checkpoint().migration_sweep.completed_plan_hashes, [plan.hash]);
  assert.ok(f.checkpoint().migration_sweep.completed_at);
  assert.doesNotMatch(JSON.stringify(f.checkpoint().lastRun), /991234567891234|sourceIds|migration_checkpoint/);
});

test('an unfinished plan gives the next resource its turn in the following cycle', async () => {
  const plans = [await make(), await make('payables')], f = fixture(), seen = [];
  const deps = { now: () => now, clock: () => now.getTime(), getToken: async () => 'synthetic-token', Client: f.Client,
    resources: [], migrationSweeper: async (_repo, _client, options) => { seen.push(options.plan.resource); return part({ completed: false, status: 'skipped_budget' }); } };
  await runSync(f.repo, config(plans), deps); await runSync(f.repo, config(plans), deps);
  assert.deepEqual(seen, ['contacts', 'payables']);
  assert.deepEqual(f.checkpoint().migration_sweep.completed_plan_hashes, []);
});

test('a bounded census gives another plan its opportunity while the shared budget remains', async () => {
  const plans = [await make(), await make('payables')], f = fixture(), seen = [];
  await runSync(f.repo, config(plans), { now: () => now, clock: () => now.getTime(),
    getToken: async () => 'synthetic-token', Client: f.Client, resources: [],
    migrationSweeper: async (_repo, _client, options) => {
      seen.push(options.plan.resource);
      return options.plan.resource === 'contacts' ? part({ completed: false, status: 'bounded' }) : part();
    } });
  assert.deepEqual(seen, ['contacts', 'payables']);
  assert.deepEqual(f.checkpoint().migration_sweep.completed_plan_hashes, [plans[1].hash]);
});

test('an uncertain migration result stops normal JSON work and is recorded without a false completion', async () => {
  const plan = await make(), f = fixture();
  const result = await runSync(f.repo, config([plan]), { now: () => now, clock: () => now.getTime(),
    getToken: async () => 'synthetic-token', Client: f.Client, resources: [getResource('contacts')],
    migrationSweeper: async () => part({ status: 'partial', completed: false, stop_json: true,
      stop_residual: true, errors: [{ code: 'DATABASE_UNAVAILABLE' }] }) });
  assert.deepEqual(f.calls, []); assert.equal(result.status, 'partial');
  assert.deepEqual(f.checkpoint().migration_sweep.completed_plan_hashes, []);
  assert.equal(f.checkpoint().migration_sweep.completed_at, null);
});

test('a late bounded sweep preserves the normal cursor for a later cycle instead of claiming an expiring page',async()=>{
  const plan=await make(),f=fixture({nextIndex:0,custom:{keep:true}}),claims=[];
  const claim=f.repo.claim;f.repo.claim=async(resource,...args)=>{claims.push(resource);return claim(resource,...args);};
  let time=now.getTime();
  const deps={now:()=>now,clock:()=>time,getToken:async()=>'synthetic-token',Client:f.Client,
    resources:[getResource('contacts')],migrationSweeper:async()=>{time=now.getTime()+150000;return part();}};
  const first=await runSync(f.repo,config([plan]),deps);
  assert.deepEqual(claims,['__scheduler__']);assert.deepEqual(f.calls,[]);assert.equal(first.pages,0);
  assert.deepEqual(first.errors,[]);assert.equal(f.checkpoint().nextIndex,0);
  assert.deepEqual(f.checkpoint().custom,{keep:true});
  assert.deepEqual(f.checkpoint().migration_sweep.completed_plan_hashes,[plan.hash]);
  time=now.getTime();await runSync(f.repo,config([plan]),deps);
  assert.ok(claims.includes('contacts'));assert.ok(f.calls.includes('/contatos'));
});

test('invalid migration configuration cannot claim a lease or load credentials', async () => {
  let access = 0;
  await assert.rejects(runSync({ claim() { access++; } }, config([]), { getToken() { access++; } }));
  assert.equal(access, 0);
});

for (const committed of [false, true]) test(`a successor waits for durable scheduler state when global ACK is lost (committed=${committed})`, async () => {
  const a = await make(), b = await make('contacts', { sourceIds: ['991234567891235'], supersedes: a.hash });
  const f = fixture(), original = f.repo.apply; let fail = true; const seen = [];
  f.repo.apply = async (...args) => {
    if (fail) {
      fail = false;
      if (committed) await original(...args);
      throw new Error('DATABASE_UNAVAILABLE');
    }
    return original(...args);
  };
  const deps = { now: () => now, clock: () => now.getTime(), getToken: async () => 'synthetic-token',
    Client: f.Client, resources: [], migrationSweeper: async (_repo, _client, options) => { seen.push(options.plan.hash); return part(); } };
  await assert.rejects(runSync(f.repo, config([a, b]), deps), /DATABASE_UNAVAILABLE/);
  assert.deepEqual(seen, [a.hash]);
  await runSync(f.repo, config([a, b]), deps);
  if (committed) assert.deepEqual(seen, [a.hash, b.hash]);
  else {
    assert.deepEqual(seen, [a.hash, a.hash]);
    await runSync(f.repo, config([a, b]), deps);
    assert.deepEqual(seen, [a.hash, a.hash, b.hash]);
  }
  assert.deepEqual(f.checkpoint().migration_sweep.completed_plan_hashes, [a.hash, b.hash]);
  assert.ok(f.checkpoint().migration_sweep.completed_at);
});
