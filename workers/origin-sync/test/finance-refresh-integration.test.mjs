import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runSync } from '../src/sync.mjs';
import { getResource } from '../src/resources.mjs';
import { handleRequest } from '../src/index.mjs';

const env = { ORIGIN_ENABLED: 'true', ORIGIN_API_ORIGIN: 'https://api.provider.example', SYNC_ENABLED: 'true', SYNC_START_DATE: '2024-01-01', MAX_API_REQUESTS: '120' };
function fixture() {
  const commits = [], calls = [];
  const repo = { async claim() { return { acquired: true, lease_token: randomUUID(), checkpoint: {}, checkpoint_version: 0 }; },
    async release() {}, async renew() {}, async rpc(name, body, options) { calls.push({ name, body, options }); return {}; },
    async apply(...args) { commits.push(args); return { checkpoint_version: 1 }; } };
  class Client {
    requestsMade = 0; remainingRequests = 120;
    async get() { this.requestsMade++; this.remainingRequests--; return []; }
  }
  return { repo, commits, calls, deps: { getToken: async () => 'synthetic-token', Client, resources: [getResource('contacts')] } };
}
const phase = { status: 'completed', attempted: 0, stored: 0, unchanged: 0, conflicts: 0, unavailable_balance: 0, requests: 0, errors: [], stop_json: false };

test('030 defaults off; XML and JSON preserve existing behavior without new RPCs', async () => {
  const f = fixture(); let financeCalls = 0;
  const result = await runSync(f.repo, env, { ...f.deps, financeRefresher: async () => { financeCalls++; return phase; } });
  assert.equal(financeCalls, 0); assert.equal(result.finance_refresh, undefined); assert.equal(result.pages, 2);
  assert.ok(!f.calls.some(c => c.name.startsWith('origin_sync_finance_refresh_')));
});

test('XML, finance refresh and JSON use one scheduler/client/deadline in that order', async () => {
  const f = fixture(), order = []; let sharedClient, sharedOwner, sharedDeadline;
  const result = await runSync(f.repo, { ...env, XML_SYNC_ENABLED: 'true', FINANCE_REFRESH_ENABLED: 'true', FINANCE_REFRESH_STALE_SECONDS: '7200' }, {
    ...f.deps, xmlCollector: async (_repo, client, options) => {
      sharedClient = client; sharedOwner = options.owner; sharedDeadline = options.deadline;
      order.push('xml'); await client.get(); return { ...phase, keys: 0, files: 0 };
    }, financeRefresher: async (_repo, client, options) => {
      order.push('finance'); assert.equal(client, sharedClient); assert.equal(options.owner, sharedOwner); assert.equal(options.deadline, sharedDeadline);
      assert.equal(options.staleSeconds, 7200); await client.get(); return { ...phase, requests: 1 };
    },
  });
  assert.deepEqual(order, ['xml', 'finance']); assert.equal(result.requests, 4); assert.equal(result.pages, 2);
  assert.equal(f.commits.at(-1)[0], '__scheduler__');
});

test('upstream 401/429 stop later calls while 403/isolated phase failure preserve JSON', async () => {
  for (const behavior of ['xml_auth', 'finance_auth', 'finance_403', 'finance_throw']) {
    const f = fixture(); let financeCalls = 0;
    const result = await runSync(f.repo, { ...env, XML_SYNC_ENABLED: 'true', FINANCE_REFRESH_ENABLED: 'true' }, {
      ...f.deps, xmlCollector: async () => ({ ...phase, keys: 0, files: 0, stop_json: behavior === 'xml_auth' }),
      financeRefresher: async () => {
        financeCalls++; if (behavior === 'finance_throw') throw new Error('private account data');
        return { ...phase, status: 'partial', stop_json: behavior === 'finance_auth', errors: [{ code: 'ORIGIN_HTTP_ERROR' }] };
      },
    });
    assert.equal(financeCalls, behavior === 'xml_auth' ? 0 : 1);
    assert.equal(result.pages, ['xml_auth', 'finance_auth'].includes(behavior) ? 0 : 2);
    assert.doesNotMatch(JSON.stringify(result), /private account data|synthetic-token/);
  }
});

test('aggregate finance freshness is available only behind admin auth and the feature flag', async () => {
  const adminToken = 'synthetic-administrator-token-at-least-32-characters', calls = [];
  const request = authorized => new Request('https://synthetic.invalid/admin/status', { method: 'POST', headers: authorized ? { Authorization: `Bearer ${adminToken}` } : {} });
  const deps = { repoFactory: () => ({ async rpc(name, body) { calls.push({ name, body }); return { coverage_complete: false, erp_mutations: false }; } }) };
  const config = { ...env, INTEGRATION_ADMIN_TOKEN: adminToken };
  assert.equal((await handleRequest(request(false), { ...config, FINANCE_REFRESH_ENABLED: 'true' }, deps)).status, 401); assert.equal(calls.length, 0);
  const disabled = await (await handleRequest(request(true), config, deps)).json(); assert.deepEqual(disabled.finance_refresh, { enabled: false });
  assert.ok(!calls.some(c => c.name === 'origin_sync_finance_refresh_status')); calls.length = 0;
  const enabled = await (await handleRequest(request(true), { ...config, FINANCE_REFRESH_ENABLED: 'true', FINANCE_REFRESH_STALE_SECONDS: '7200' }, deps)).json();
  assert.equal(enabled.finance_refresh.enabled, true); assert.equal(enabled.finance_refresh.coverage_complete, false);
  assert.deepEqual(calls.find(c => c.name === 'origin_sync_finance_refresh_status').body, { p_stale_seconds: 7200 });
});
