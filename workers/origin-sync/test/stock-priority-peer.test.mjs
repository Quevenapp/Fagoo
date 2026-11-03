import test from 'node:test';
import assert from 'node:assert/strict';
import { OriginClient } from '../src/client.mjs';
import { runSync } from '../src/sync.mjs';
import { getResource } from '../src/resources.mjs';
import { collectPriorityStock } from '../src/stock-priority.mjs';

const start = Date.parse('2026-10-17T09:00:00Z');
const env = { ORIGIN_ENABLED: 'true', ORIGIN_API_ORIGIN: 'https://api.provider.example', SYNC_ENABLED: 'true', EXTRA_RESOURCES_ENABLED: 'true', STOCK_PRIORITY_ENABLED: 'true',
  SYNC_START_DATE: '2024-01-01', MAX_API_REQUESTS: '120' };
const stock = getResource('stock_balances'), contacts = getResource('contacts');

/** Real scheduler, page collector and OriginClient; every HTTP and database port is synthetic. */
function fixture(options = {}) {
  let time = start;
  const states = new Map(), claims = [], releases = [], commits = [], calls = [], gets = [], configs = [];
  const ids = Array.from({ length: options.products ?? 100 }, (_, i) => String(100001 + i));
  if (options.checkpoint) states.set('stock_balances', structuredClone(options.checkpoint));
  if (options.nextIndex !== undefined) states.set('__scheduler__', { nextIndex: options.nextIndex });
  const repo = {
    async claim(resource, _owner, ttl, dbOptions) {
      claims.push({ resource, ttl, options: dbOptions });
      if (resource === 'stock_balances' && options.leased) return { acquired: false };
      return { acquired: true, lease_token: 'synthetic-lease', checkpoint_version: 1,
        checkpoint: structuredClone(states.get(resource) ?? {}) };
    },
    async renew() {},
    async release(resource, _owner, _lease, dbOptions) {
      releases.push({ resource, options: dbOptions });
      if (resource === 'stock_balances' && options.releaseError) throw Error('DATABASE_RELEASE_UNCONFIRMED');
    },
    async rpc(name, args) {
      if (name === 'origin_sync_renew') return {};
      assert.equal(name, 'origin_sync_stock_product_page');
      assert.equal(args.p_limit, 25);
      const remaining = ids.filter(id => args.p_after === null || id > args.p_after);
      const items = remaining.slice(0, 25), more = remaining.length > 25;
      return { items, has_more: more, next_cursor: more ? items.at(-1) : null, coverage_complete: false };
    },
    async apply(resource, entity, _owner, _lease, records, checkpoint, dbOptions) {
      assert.ok(['stock_balances', 'contacts', 'control'].includes(entity));
      // Repository transmits JSON: rawJSON quantities are deliberately not structured-cloneable.
      commits.push({ resource, entity, records: JSON.parse(JSON.stringify(records)), checkpoint: structuredClone(checkpoint), options: dbOptions });
      states.set(resource, structuredClone(checkpoint));
      if (resource === 'stock_balances' && records.length && options.lostAck) throw Error('DATABASE_UNAVAILABLE');
      return { inserted: records.length };
    },
  };
  class Client extends OriginClient {
    constructor(token, config) {
      configs.push(config);
      super(token, { ...config, now: () => time, intervalMs: 700,
        sleep: async ms => { time += ms; }, fetchImpl: async (url, init) => {
          const u = new URL(url), path = u.pathname.replace('/Api/v3', '');
          assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
          calls.push({ path, partition: u.searchParams.get('filtroSaldoEstoque'), ids: u.searchParams.getAll('idsProdutos[]'), at: time });
          if (path !== '/estoques/saldos') return Response.json({ data: [] });
          if (options.stockStatus) return new Response(new ReadableStream({ cancel() { return new Promise(() => {}); } }),
            { status: options.stockStatus, headers: { 'retry-after': '20' } });
          if (options.stockDelay) time += options.stockDelay;
          return Response.json({ data: u.searchParams.get('filtroSaldoEstoque') === '0'
            ? u.searchParams.getAll('idsProdutos[]').map(id => ({ produto: { id }, saldoFisicoTotal: 0, depositos: [] })) : [] });
        } });
    }
    get(path, params, requestOptions) {
      gets.push({ path, options: requestOptions ? { ...requestOptions } : null });
      return super.get(path, params, requestOptions);
    }
  }
  const xmlCalls = [];
  const run = (patch = {}, resources = [stock, contacts], prefixCalls = 0) => runSync(repo, { ...env, ...patch }, {
    clock: () => time, now: () => new Date(time), Client, resources,
    getToken: async () => { time += options.beforePhases ?? 0; return 'synthetic'; },
    financeRefresher: async (_repo, client) => {
      for (let i = 0; i < prefixCalls; i++) await client.get('/contatos');
      return { errors: [], stop_json: false };
    },
    xmlCollector: async (_repo, _client, input) => {
      xmlCalls.push(input);
      return { status: 'completed', keys: 0, files: 0, unchanged: 0, requests: 0, errors: [], stop_json: false };
    },
  });
  return { run, states, claims, releases, commits, calls, gets, configs, xmlCalls,
    stockCalls: () => calls.filter(c => c.path === '/estoques/saldos'),
    stockWrites: () => commits.filter(c => c.resource === 'stock_balances'), now: () => time };
}

test('peer: three priority pages advance the existing cursor exactly once each and keep normal rotation', async () => {
  const f = fixture({ nextIndex: 0 }), r = await f.run();
  assert.equal(r.stock_priority.batches, 3); assert.equal(r.stock_priority.requests, 9);
  assert.equal(r.stock_priority.requested, 75); assert.equal(r.stock_priority.returned, 75);
  assert.equal(r.stock_priority.coverage_complete, false);
  assert.deepEqual(f.stockWrites().map(c => c.checkpoint.unfiltered.after), ['100025', '100050', '100075']);
  assert.equal(new Set(f.stockWrites().flatMap(c => c.records.map(v => v.source_id))).size, 75);
  assert.equal(f.claims.filter(c => c.resource === 'stock_balances').length, 3);
  assert.equal(f.calls.filter(c => c.path === '/contatos').length, 2);
  assert.ok(f.gets.filter(c => c.path === '/estoques/saldos').every(c => c.options.maxAttempts === 1 && c.options.deadline === start + 45000));
  assert.deepEqual(f.stockCalls().map(c => c.partition), ['0', '1', '2', '0', '1', '2', '0', '1', '2']);
  assert.equal(f.states.get('__scheduler__').nextIndex, 0);
  assert.equal(f.configs[0].maxRequests, 120);
  assert.equal(f.commits.at(-1).options.deadline, start + 175000);
  assert.equal(f.releases.at(-1).options.deadline, start + 180000);
});

test('peer: the priority phase leaves fourteen real requests and does not borrow its final page', async () => {
  const f = fixture(), r = await f.run({ MAX_API_REQUESTS: '20' });
  assert.equal(r.stock_priority.batches, 2); assert.equal(r.stock_priority.requests, 6);
  assert.equal(f.calls.filter(c => c.path === '/contatos').length, 1);
  assert.equal(r.requests, 7); assert.equal(f.states.get('__scheduler__').nextIndex, 0);
  assert.equal(f.states.get('stock_balances').unfiltered.after, '100050');
});

test('peer: a priority budget refusal does not suppress a normal stock opportunity', async () => {
  const f = fixture(), r = await f.run({ MAX_API_REQUESTS: '20', FINANCE_REFRESH_ENABLED: 'true' }, [stock], 4);
  assert.equal(r.stock_priority.status, 'skipped_budget'); assert.equal(r.stock_priority.attempted, false);
  assert.equal(r.stock_priority.requests, 0); assert.equal(f.stockCalls().length, 3);
  assert.ok(f.gets.filter(c => c.path === '/estoques/saldos').every(c => !Object.hasOwn(c.options, 'maxAttempts')));
  assert.equal(f.states.get('stock_balances').unfiltered.after, '100025');
});

test('peer: insufficient priority time leaves the normal deadline and rotation available', async () => {
  const f = fixture({ beforePhases: 125000 }), r = await f.run({}, [stock]);
  assert.equal(r.stock_priority.status, 'skipped_time'); assert.equal(r.stock_priority.attempted, false);
  assert.equal(r.stock_priority.requests, 0); assert.equal(f.stockCalls().length, 6);
  assert.ok(f.gets.filter(c => c.path === '/estoques/saldos').every(c => c.options.deadline === start + 160000));
  assert.equal(f.stockWrites().length, 2);
});

test('peer: existing backoff and another live lease cause no upstream stock calls or duplicate claims', async () => {
  for (const options of [
    { checkpoint: { version: 1, unfiltered: { after: '100025' }, failure: { next_attempt_at: new Date(start + 86400000).toISOString() } } },
    { leased: true },
  ]) {
    const f = fixture(options), r = await f.run();
    assert.equal(r.stock_priority.status, options.leased ? 'already_running' : 'deferred');
    assert.equal(r.stock_priority.attempted, true); assert.equal(f.stockCalls().length, 0);
    assert.equal(f.claims.filter(c => c.resource === 'stock_balances').length, 1);
    assert.equal(f.stockWrites().length, 0); assert.equal(f.calls.filter(c => c.path === '/contatos').length, 2);
    if (options.checkpoint) assert.deepEqual(f.states.get('stock_balances'), options.checkpoint);
  }
});

test('peer: 401 and 429 retain status through never-finishing cleanup and stop JSON/residual after one GET', async () => {
  for (const status of [401, 429]) {
    const f = fixture({ stockStatus: status }), r = await f.run({ XML_SYNC_ENABLED: 'true', XML_RESIDUAL_ENABLED: 'true' });
    assert.equal(f.stockCalls().length, 1); assert.equal(f.calls.length, 1);
    assert.equal(r.stock_priority.stop_json, true); assert.equal(r.stock_priority.stop_residual, true);
    assert.equal(r.xml_residual.status, 'skipped_stopped'); assert.equal(f.xmlCalls.length, 1);
    assert.equal(f.stockWrites().length, 1); assert.deepEqual(f.stockWrites()[0].records, []);
    assert.equal(f.states.get('stock_balances').failure.http_status, status);
    assert.equal(f.states.get('stock_balances').unfiltered, undefined);
    assert.equal(f.releases.at(-1).resource, '__scheduler__');
  }
});

test('peer: 403 backs off only stock for 24h, retains its cursor and suppresses residual XML', async () => {
  const checkpoint = { version: 1, unfiltered: { after: '100025' } };
  const f = fixture({ stockStatus: 403, checkpoint }), r = await f.run({ XML_SYNC_ENABLED: 'true', XML_RESIDUAL_ENABLED: 'true' });
  assert.equal(f.stockCalls().length, 1); assert.equal(r.stock_priority.stop_json, false);
  assert.equal(r.stock_priority.stop_residual, true); assert.equal(r.xml_residual.status, 'skipped_stopped');
  assert.equal(f.calls.filter(c => c.path === '/contatos').length, 2);
  assert.equal(f.states.get('stock_balances').unfiltered.after, '100025');
  assert.equal(Date.parse(f.states.get('stock_balances').failure.next_attempt_at), start + 86400000);
});

test('peer: 503 gets one real attempt, stops this phase and preserves normal JSON/residual work', async () => {
  const f = fixture({ stockStatus: 503 }), r = await f.run({ XML_SYNC_ENABLED: 'true', XML_RESIDUAL_ENABLED: 'true' });
  assert.equal(f.stockCalls().length, 1); assert.equal(r.stock_priority.requests, 1);
  assert.equal(r.stock_priority.errors[0].code, 'ORIGIN_SERVER_ERROR');
  assert.equal(r.stock_priority.stop_json, false); assert.equal(r.stock_priority.stop_residual, false);
  assert.equal(f.calls.filter(c => c.path === '/contatos').length, 2); assert.equal(f.xmlCalls.length, 2);
  assert.equal(f.states.get('stock_balances').failure.http_status, 503);
  assert.equal(Date.parse(f.states.get('stock_balances').failure.next_attempt_at), start + 60000);
});

test('peer: lost database ACK never manufactures a second stock command or resumes JSON/residual', async () => {
  const f = fixture({ lostAck: true }), r = await f.run({ XML_SYNC_ENABLED: 'true', XML_RESIDUAL_ENABLED: 'true' });
  assert.equal(f.stockCalls().length, 3); assert.equal(f.stockWrites().length, 1);
  assert.equal(f.stockWrites()[0].records.length, 25); assert.equal(f.states.get('stock_balances').unfiltered.after, '100025');
  assert.equal(f.states.get('stock_balances').failure, undefined);
  assert.equal(r.stock_priority.batches, 0); assert.equal(r.stock_priority.stop_json, true);
  assert.equal(r.xml_residual.status, 'skipped_stopped'); assert.equal(f.calls.length, 3);
});

test('peer: uncertain lease release after commit is also a stop, without a second stock batch', async () => {
  const f = fixture({ releaseError: true }), r = await f.run();
  assert.equal(f.stockWrites().length, 1); assert.equal(f.stockCalls().length, 3);
  assert.equal(r.stock_priority.stop_json, true); assert.equal(r.stock_priority.stop_residual, true);
  assert.equal(f.calls.length, 3); assert.equal(f.releases.at(-1).resource, '__scheduler__');
});

test('peer: a late partition response cannot commit partial stock or restart normal stock in the same cycle', async () => {
  const f = fixture({ stockDelay: 45000 }), r = await f.run();
  assert.equal(f.stockCalls().length, 1); assert.equal(f.stockWrites().length, 0);
  assert.equal(r.stock_priority.batches, 0); assert.equal(r.stock_priority.errors[0].code, 'ORIGIN_PAGE_TIME_BUDGET');
  assert.equal(f.calls.filter(c => c.path === '/contatos').length, 2);
  assert.equal(f.states.get('stock_balances'), undefined);
});

test('peer: source exhaustion stops at the existing sweep pause, not a fourth page or a new sweep', async () => {
  const f = fixture({ products: 30 }), r = await f.run();
  assert.equal(r.stock_priority.batches, 2); assert.equal(r.stock_priority.returned, 30);
  assert.equal(f.stockCalls().length, 6); assert.equal(f.stockWrites().length, 2);
  assert.equal(f.states.get('stock_balances').unfiltered, undefined);
  assert.ok(Date.parse(f.states.get('stock_balances').next_attempt_at) > f.now());
});

test('peer: absent/false flags preserve the legacy ceiling, calls, cursor and unbounded-database option', async () => {
  const results = [];
  for (const value of [undefined, 'false']) {
    const f = fixture(), r = await f.run({ STOCK_PRIORITY_ENABLED: value, MAX_API_REQUESTS: '240' });
    assert.equal(Object.hasOwn(r, 'stock_priority'), false); assert.equal(f.configs[0].maxRequests, 240);
    assert.equal(f.stockCalls().length, 6); assert.ok(f.commits.every(c => c.options === undefined));
    results.push({ calls: f.calls, states: [...f.states], pages: r.pages, records: r.records });
  }
  assert.deepEqual(results[0], results[1]);
  const f = fixture(), r = await f.run({ EXTRA_RESOURCES_ENABLED: 'false', MAX_API_REQUESTS: '240' });
  assert.equal(Object.hasOwn(r, 'stock_priority'), false); assert.equal(f.stockCalls().length, 0);
  assert.equal(f.configs[0].maxRequests, 240);
});

test('peer: scoped path and phase request/time guards refuse a caller that exceeds the stock contract', async () => {
  let made = 0, clock = start;
  const client = { get requestsMade() { return made; }, get remainingRequests() { return 120 - made; },
    async get(_path, _params, options) { made++; assert.equal(options.maxAttempts, 1); return []; } };
  const wrong = await collectPriorityStock(client, c => c.get('/contatos', {}), { deadline: start + 160000, clock: () => clock });
  assert.equal(wrong.errors[0].code, 'STOCK_PRIORITY_PATH_INVALID'); assert.equal(made, 0);
  const tooMany = await collectPriorityStock(client, async c => {
    for (let i = 0; i < 10; i++) await c.get('/estoques/saldos', {});
  }, { deadline: start + 160000, clock: () => clock });
  assert.equal(tooMany.errors[0].code, 'STOCK_PRIORITY_REQUEST_BUDGET'); assert.equal(made, 9);
  const time = await collectPriorityStock(client, async c => {
    clock += 45000; await c.get('/estoques/saldos', {});
  }, { deadline: start + 160000, clock: () => clock });
  assert.equal(time.errors[0].code, 'STOCK_PRIORITY_TIME_BUDGET'); assert.equal(made, 9);
});
