import test from 'node:test';
import assert from 'node:assert/strict';
import { syncPage, runSync, nextWindow, advanceWindow, localTimestamp } from '../src/sync.mjs';
import { getResource } from '../src/resources.mjs';
import { Repository } from '../src/repository.mjs';

const env = { ORIGIN_ENABLED: 'true', ORIGIN_API_ORIGIN: 'https://api.provider.example', SYNC_ENABLED: 'true', SYNC_START_DATE: '2024-01-01', SYNC_TIME_ZONE: 'America/Sao_Paulo', MAX_API_REQUESTS: '120' };
const now = new Date('2026-10-16T01:00:00Z');
function repository(checkpoint = {}) {
  return {
    commits: [], releases: [],
    async claim() { return { acquired: true, lease_token: 'fence', checkpoint_version: 4, checkpoint }; },
    async apply(...args) { this.commits.push(args); return { checkpoint_version: 5 }; },
    async release(...args) { this.releases.push(args); },
    async renew() { return { renewed: true }; },
  };
}

test('source calendar uses São Paulo and initializes a bounded recent window', () => {
  assert.equal(localTimestamp(now, env.SYNC_TIME_ZONE), '2026-10-15 22:00:00');
  const w = nextWindow(getResource('contacts'), {}, '2026-10-15 22:00:00', env.SYNC_START_DATE);
  assert.equal(w.cursor.from, '2026-09-15 22:00:00');
  assert.equal(w.cursor.to, '2026-10-15 22:00:00');
});

test('a failed detail never advances a page or partially commits', async () => {
  const repo = repository(); let calls = 0;
  const client = { async get() { if (++calls === 1) return [{ id: 1 }, { id: 2 }]; if (calls === 2) return { id: 1 }; throw new Error('UPSTREAM_FAILED'); } };
  await assert.rejects(syncPage(repo, client, getResource('contacts'), 'owner', env, now), /UPSTREAM_FAILED/);
  assert.equal(repo.commits.length, 0); assert.equal(repo.releases.length, 1);
});

test('date-only finance filters are explicit and successful page commits canonically', async () => {
  const repo = repository(); let params;
  const client = { async get(path, query) { if (query) { params = query; return [{ id: 123 }]; } return { id: 123, situacao: 1 }; } };
  await syncPage(repo, client, getResource('receivables'), 'owner', env, now);
  assert.equal(params.dataInicial, '2026-09-15');
  assert.equal(params.dataFinal, '2026-10-15');
  assert.equal(params.tipoFiltroData, 'E');
  assert.equal(repo.commits[0][1], 'receivables');
  assert.equal(repo.commits[0][4][0].source_id, '123');
  assert.equal(repo.commits[0][5].nextLane, 'history');
});

test('full pages resume fixed windows while recent and historical lanes alternate', () => {
  const resource = getResource('contacts');
  let state = nextWindow(resource, {}, '2026-10-15 22:00:00', '2024-01-01');
  const original = { ...state.cursor };
  let cp = advanceWindow(state, 10, '2026-10-15 22:00:00');
  assert.equal(cp.recent.page, 2);
  state = nextWindow(resource, cp, '2026-10-16 22:00:00', '2024-01-01');
  assert.equal(state.cursor.from, '2024-01-01 00:00:00');
  cp = advanceWindow(state, 0, '2026-10-16 22:00:00');
  state = nextWindow(resource, cp, '2026-10-17 22:00:00', '2024-01-01');
  assert.equal(state.cursor.from, original.from);
  assert.equal(state.cursor.to, original.to);
  assert.equal(state.cursor.page, 2);
});

test('the recent lane starts at the last completed pass less 15 minutes, never more than 30 days back', () => {
  const resource = getResource('sales_orders');
  let state = nextWindow(resource, { recentCompletedAt: '2026-10-22 14:45:22' }, '2026-10-22 20:00:00', '2024-01-01');
  assert.equal(state.cursor.from, '2026-10-22 14:30:22');assert.equal(state.cursor.to, '2026-10-22 20:00:00');
  const cp = advanceWindow(state, 5, '2026-10-22 20:00:00');assert.equal(cp.recentCompletedAt, '2026-10-22 20:00:00');
  state = nextWindow(resource, { recentCompletedAt: '2026-08-01 00:00:00' }, '2026-10-22 20:00:00', '2024-01-01');
  assert.equal(state.cursor.from, '2026-09-22 20:00:00');
});

test('deleted catalog detail 404 is retained explicitly, normal 404 does not commit', async () => {
  const client = { async get(path, query) { if (query) return [{ id: 7 }]; throw Object.assign(new Error('ORIGIN_NOT_FOUND'), { status: 404 }); } };
  const repo = repository();
  await syncPage(repo, client, getResource('contacts_deleted'), 'owner', env, now);
  assert.equal(repo.commits[0][4][0].payload._brufap_source.deleted, true);
  const activeRepo = repository();
  await assert.rejects(syncPage(activeRepo, client, getResource('contacts'), 'owner', env, now));
  assert.equal(activeRepo.commits.length, 0);
});

test('disabled cron never accesses credentials or database', async () => {
  assert.deepEqual(await runSync({}, { SYNC_ENABLED: 'false' }), { status: 'disabled' });
});

test('slow requests renew the lease and exceeding the page deadline cannot commit', async () => {
  let clock = 0; let renewals = 0; let calls = 0; let heartbeat = 0;
  const repo = repository(); repo.renew = async () => { renewals++; };
  const client = { async get(_path, query) { clock += 100000; calls++; return query ? [{ id: 1 }, { id: 2 }] : { id: 1 }; } };
  await assert.rejects(syncPage(repo, client, getResource('contacts'), 'owner', env, now, {
    clock: () => clock, deadline: 180000, heartbeat: async () => { heartbeat++; },
  }), /ORIGIN_PAGE_TIME_BUDGET/);
  assert.equal(calls, 2); assert.equal(renewals, 1); assert.equal(heartbeat, 2);
  assert.equal(repo.commits.length, 0); assert.equal(repo.releases.length, 1);
});

test('scheduler records sanitized failure and releases the global lease', async () => {
  const repo = repository();
  const result = await runSync(repo, env, { now: () => now, getToken: async () => { throw new Error('Bearer private-data'); } });
  assert.equal(result.status, 'failed');
  assert.equal(result.errors[0].code, 'SYNC_FAILED');
  assert.equal(repo.commits[0][0], '__scheduler__');
  assert.equal(repo.releases.at(-1)[0], '__scheduler__');
});

test('database retries preserve the same batch ID and never include credentials in body', async () => {
  const bodies = []; let attempt = 0;
  const repo = new Repository({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'secret' }, {
    sleep: async () => {}, fetchImpl: async (_url, init) => { bodies.push(init.body); if (++attempt === 1) return new Response('', { status: 503 }); return Response.json({ checkpoint_version: 1 }); },
  });
  await repo.apply('contacts', 'contacts', 'owner', { lease_token: 'fence', checkpoint_version: 0 }, [], { page: 2 });
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
  assert.ok(!bodies[0].includes('secret'));
});
