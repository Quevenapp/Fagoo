import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { refreshFinance } from '../src/finance-refresh.mjs';
import { OriginClient, OriginApiError } from '../src/client.mjs';

const candidate = (id, entity = 'receivables') => ({ entity, source_id: String(id), source_hash: 'a'.repeat(64), source_seen_at: '2020-01-01T00:00:00+00:00' });
function harness(items = [candidate(101), candidate(201, 'payables')]) {
  const calls = [];
  const repo = { calls, async rpc(name, args, options) {
    calls.push({ name, args: structuredClone(args), options });
    if (name.endsWith('_candidates')) return { items };
    if (name.endsWith('_begin')) return { attempt_id: args.p_attempt_id, entity: args.p_entity, source_id: args.p_source_id,
      source_hash: args.p_source_hash, source_seen_at: args.p_source_seen_at, state: 'pending', replayed: false };
    if (name.endsWith('_finish')) return { stored: true, conflict: false, unchanged: false, balance_available: args.p_payload.saldo !== undefined && args.p_payload.saldo !== null, replayed: false };
    if (name.endsWith('_fail')) return { recorded: true, already_finished: false, replayed: false };
    throw new Error('UNEXPECTED_RPC');
  } };
  return { repo, options: { owner: randomUUID(), lease: { lease_token: randomUUID() }, deadline: Date.now() + 180000 } };
}
const client = fetchImpl => new OriginClient('synthetic-token', { apiOrigin: 'https://api.provider.example', intervalMs: 0, fetchImpl });
const ok = async url => Response.json({ data: { id: url.split('/').at(-1), situacao: 1, saldo: 100 } });

test('direct GET only uses the existing token client and records a bounded attempt before each call', async () => {
  const h = harness(), requests = [];
  const c = client(async (url, init) => { requests.push({ url, init }); return ok(url); });
  const result = await refreshFinance(h.repo, c, h.options);
  assert.equal(result.stored, 2); assert.equal(result.requests, 2); assert.equal(result.stop_json, false);
  assert.deepEqual(requests.map(r => r.url), ['https://api.provider.example/Api/v3/contas/receber/101', 'https://api.provider.example/Api/v3/contas/pagar/201']);
  assert.ok(requests.every(r => r.init.method === 'GET' && r.init.headers.Authorization === 'Bearer synthetic-token'));
  assert.equal(h.repo.calls.filter(c => c.name.endsWith('_begin')).length, 2);
  assert.ok(h.repo.calls.every(c => c.options.deadline <= h.options.deadline && c.options.deadline <= Date.now() + 40000));
  assert.doesNotMatch(JSON.stringify(result), /source_id|2020|synthetic-token|saldo|https/);
});

test('eight titles share the global budget; retries count toward the 24-attempt phase cap', async () => {
  let clock = Date.now(), fetches = 0;
  const h = harness(Array.from({ length: 8 }, (_, i) => candidate(100 + i, i % 2 ? 'payables' : 'receivables')));
  const c = new OriginClient('synthetic-token', { apiOrigin: 'https://api.provider.example', now: () => clock, intervalMs: 0, sleep: async ms => { clock += ms; }, fetchImpl: async url => {
    fetches++; return fetches % 3 ? new Response('', { status: 503 }) : ok(url);
  } });
  const result = await refreshFinance(h.repo, c, { ...h.options, now: () => clock, deadline: clock + 180000 });
  assert.equal(result.stored, 8); assert.equal(result.requests, 24); assert.equal(fetches, 24); assert.equal(c.remainingRequests, 96);
});

test('reserves fourteen shared requests and does not even create attempts when budget is too small', async () => {
  const h = harness(); let calls = 0;
  const c = new OriginClient('synthetic-token', { apiOrigin: 'https://api.provider.example', maxRequests: 17, intervalMs: 0, sleep: async () => {}, fetchImpl: async url => {
    calls++; return calls % 3 ? new Response('', { status: 503 }) : ok(url);
  } });
  const result = await refreshFinance(h.repo, c, h.options);
  assert.equal(result.stored, 1); assert.equal(result.status, 'skipped_budget'); assert.equal(c.remainingRequests, 14);
  const empty = harness(); const skipped = await refreshFinance(empty.repo, { requestsMade: 6, remainingRequests: 14 }, empty.options);
  assert.equal(skipped.status, 'skipped_budget'); assert.equal(empty.repo.calls.length, 0);
});

test('forty-second phase is enforced before detail/finish; no late result is stored', async () => {
  let clock = Date.now(); const h = harness(); let gets = 0;
  const c = { requestsMade: 0, remainingRequests: 120, async get(_path, _params, options) {
    gets++; assert.ok(options.deadline <= clock + 18000); clock += 41000; this.requestsMade++; this.remainingRequests--;
    return { id: '101', situacao: 2, saldo: 0 };
  } };
  const result = await refreshFinance(h.repo, c, { ...h.options, now: () => clock, deadline: clock + 180000 });
  assert.equal(result.stored, 0); assert.equal(gets, 1); assert.ok(!h.repo.calls.some(c => c.name.endsWith('_finish')));
  const expired = harness(); assert.equal((await refreshFinance(expired.repo, c, { ...expired.options, deadline: clock - 1, now: () => clock })).status, 'skipped_time');
});

test('404, wrong ID and missing status never reach finish; null saldo remains null in successful detail', async () => {
  for (const response of [new Response('', { status: 404 }), Response.json({ data: { id: '999', situacao: 1 } }), Response.json({ data: { id: '101' } })]) {
    const h = harness([candidate(101)]); const result = await refreshFinance(h.repo, client(async () => response), h.options);
    assert.equal(result.stored, 0); assert.equal(result.errors.length, 1); assert.ok(!h.repo.calls.some(c => c.name.endsWith('_finish')));
    assert.ok(h.repo.calls.some(c => c.name.endsWith('_fail')));
  }
  const h = harness([candidate(101)]);
  const result = await refreshFinance(h.repo, client(async () => Response.json({ data: { id: '101', situacao: 3, saldo: null } })), h.options);
  assert.equal(result.unavailable_balance, 1); assert.equal(h.repo.calls.find(c => c.name.endsWith('_finish')).args.p_payload.saldo, null);
});

test('403 skips only its resource; 401/429 stop JSON; sanitized result includes no private body', async () => {
  for (const status of [401, 403, 429]) {
    const h = harness([candidate(101), candidate(102), candidate(201, 'payables')]); let gets = 0;
    const c = { requestsMade: 0, remainingRequests: 120, async get(path) {
      gets++; this.requestsMade++; this.remainingRequests--;
      if (path.includes('/receber/')) throw new OriginApiError('ORIGIN_HTTP_ERROR', { status });
      return { id: '201', situacao: 1, saldo: 100 };
    } };
    const result = await refreshFinance(h.repo, c, h.options);
    assert.equal(result.stop_json, status !== 403); assert.equal(gets, status === 403 ? 2 : 1);
    assert.equal(result.errors[0].code, `ORIGIN_HTTP_${status}`);
    assert.equal(h.repo.calls.find(c => c.name.endsWith('_fail')).args.p_http_status, status);
  }
  const h = harness([candidate(101)]); const result = await refreshFinance(h.repo, { requestsMade: 0, remainingRequests: 120, async get() { throw new Error('Bearer private source data'); } }, h.options);
  assert.equal(result.errors[0].code, 'FINANCE_REFRESH_FAILED'); assert.doesNotMatch(JSON.stringify(result), /Bearer|private|source data/);
});

test('invalid or duplicate candidate list is rejected before any detail call', async () => {
  for (const items of [[null], [candidate(101), candidate(101)], Array.from({ length: 9 }, (_, i) => candidate(100 + i)), [{ ...candidate(101), entity: 'products' }]]) {
    const h = harness(items); const result = await refreshFinance(h.repo, { requestsMade: 0, remainingRequests: 120 }, h.options);
    assert.equal(result.status, 'failed'); assert.equal(h.repo.calls.length, 1);
  }
});

test('CAS conflict is a safe result; uncertain finish cannot overwrite a committed result with failure', async () => {
  const h = harness([candidate(101)]), original = h.repo.rpc;
  h.repo.rpc = async (...args) => args[0].endsWith('_finish')
    ? { stored: false, conflict: true, unchanged: false, balance_available: false, replayed: true } : original(...args);
  const conflict = await refreshFinance(h.repo, client(ok), h.options); assert.equal(conflict.conflicts, 1); assert.equal(conflict.stored, 0);
  const lost = harness([candidate(101)]), old = lost.repo.rpc; let commits = 0;
  lost.repo.rpc = async (...args) => {
    if (args[0].endsWith('_finish')) { commits++; throw new Error('DATABASE_UNAVAILABLE'); }
    if (args[0].endsWith('_fail')) return { recorded: false, already_finished: true, replayed: true };
    return old(...args);
  };
  assert.equal((await refreshFinance(lost.repo, client(ok), lost.options)).status, 'partial'); assert.equal(commits, 1);
});
