import test from 'node:test';
import assert from 'node:assert/strict';
import { OriginClient } from '../src/client.mjs';
import { Repository } from '../src/repository.mjs';
import { stockCapture } from '../src/stock-json.mjs';
import { canonicalPriceToken } from '../src/price-json-parser.mjs';
import { stockBatch } from '../src/extra-resources.mjs';
import { projectStockMirror } from '../src/stock-mirror.mjs';
import { runSync } from '../src/sync.mjs';

const params = { 'idsProdutos[]': ['1'], filtroSaldoEstoque: 0 };
const parse = text => new OriginClient('synthetic-stock', { apiOrigin: 'https://api.provider.example', intervalMs: 0, fetchImpl: async () => new Response(text) }).get('/estoques/saldos', params);

test('stock quantities keep exact decimal tokens, numeric wire values and deposit identity', async () => {
  for (const lexeme of ['99999999999999.9999999999', '-0.1234567890123456789', '1.20000', '1e-8', '-0']) {
    const [row] = await parse(`{"data":[{"produto":{"id":1},"saldoFisicoTotal":${lexeme},"saldoVirtualTotal":${lexeme},"depositos":[{"id":"001","saldoFisico":${lexeme},"saldoVirtual":${lexeme}}]}]}`);
    const encoded = JSON.stringify(row), canonical = canonicalPriceToken(lexeme);
    for (const field of ['saldoFisicoTotal', 'saldoVirtualTotal', 'saldoFisico', 'saldoVirtual']) assert.ok(encoded.includes(`"${field}":${canonical}`));
    assert.equal(row.produto.id, 1); assert.equal(row.depositos[0].id, '001');
    assert.deepEqual(stockCapture(row).tokens.map(x => x.lexeme), [lexeme, lexeme, lexeme, lexeme]);
    assert.equal(stockCapture(row).profile, 'origin-stock-json-v1');
    assert.throws(() => { row.depositos[0].saldoFisico = 0; }, TypeError);
  }
});

test('missing, null and invalid stock values remain distinguishable, without invented zero', async () => {
  const [row] = await parse('{"data":[{"produto":{"id":1},"saldoFisicoTotal":null,"saldoVirtualTotal":"1.25","depositos":[{"id":2,"saldoFisico":false}]}]}');
  assert.equal(row.saldoFisicoTotal, null); assert.equal(row.saldoVirtualTotal, '1.25');
  assert.equal(row.depositos[0].saldoFisico, false); assert.equal(Object.hasOwn(row.depositos[0], 'saldoVirtual'), false);
  assert.deepEqual(stockCapture(row).tokens, []);
});

test('stock capture remains selective and rejects unsafe identities and duplicate quantities', async () => {
  const [row] = await parse('{"data":[{"produto":{"id":1,"saldoFisico":0.1234567890123456789},"depositos":[],"saldoFisicoTotal":0.1234567890123456789}]}');
  assert.equal(typeof row.produto.saldoFisico, 'number'); assert.equal(stockCapture(row).tokens.length, 1);
  for (const text of [
    '{"data":[{"produto":{"id":9007199254740993},"saldoFisicoTotal":1}]}',
    '{"data":[{"produto":{"id":1},"depositos":[{"id":1.5,"saldoFisico":1}]}]}',
    '{"data":[{"produto":{"id":1},"saldoFisicoTotal":1,"saldoFisicoTotal":2}]}',
  ]) await assert.rejects(parse(text), error => /^ORIGIN_(?:UNSAFE_NUMBER|INVALID_ID_NUMBER|DUPLICATE_JSON_KEY)$/.test(error.code));
});

async function batchFixture(quantities = ['1.20000', '1.2', '1.2']) {
  const writes = [], calls = [];
  const client = new OriginClient('synthetic', { apiOrigin: 'https://api.provider.example', intervalMs: 0, fetchImpl: async (url, options) => {
    assert.equal(options.method, 'GET'); const partition = Number(new URL(url).searchParams.get('filtroSaldoEstoque')); calls.push(partition);
    return new Response(`{"data":[{"produto":{"id":1},"depositos":[{"id":2,"saldoFisico":${quantities[partition]}}]}]}`);
  } });
  const repo = {
    async rpc() { return { items: ['1'], has_more: false, next_cursor: null, coverage_complete: false }; },
    async apply(...args) { writes.push(args); return { inserted: 1 }; },
  };
  const run = () => stockBatch(repo, client, 'owner', { lease_token: 'test' }, {}, { keepLease: async () => {}, deadline: Infinity, cutoff: '2026-10-22', clock: () => 0 });
  return { run, writes, calls };
}

test('stock partitions deduplicate equivalent exact numbers and persist lexical evidence with the payload', async () => {
  const f = await batchFixture(); const result = await f.run();
  assert.equal(result.overlaps, 2); assert.equal(f.writes[0][4].length, 1); assert.deepEqual(f.calls, [0, 1, 2]);
  const row = f.writes[0][4][0]; assert.equal(row.source_id, '1');
  assert.deepEqual(row.payload._brufap_stock_capture.tokens, [{ path: '/depositos/0/saldoFisico', lexeme: '1.20000' }]);
  assert.match(JSON.stringify(row), /"saldoFisico":1\.2/);
});

test('a change below IEEE754 precision across stock partitions refuses the batch', async () => {
  const f = await batchFixture(['0.1234567890123456789', '0.1234567890123456790', '0.1234567890123456789']);
  await assert.rejects(f.run(), /ORIGIN_STOCK_RESPONSE_CONFLICT/); assert.equal(f.writes.length, 0);
});

test('stock repository retries transmit identical exact quantities and metadata', async () => {
  const [payload] = await parse('{"data":[{"produto":{"id":1},"saldoFisicoTotal":99999999999999.9999999999}]}');
  const bodies = [];
  const repo = new Repository({ SUPABASE_URL: 'https://synthetic.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic' }, {
    sleep: async () => {}, fetchImpl: async (url, init) => {
      assert.ok(url.endsWith('/origin_sync_apply_batch')); bodies.push(init.body);
      return bodies.length === 1 ? new Response('', { status: 503 }) : Response.json({ inserted: 1 });
    },
  });
  await repo.apply('stock_balances', 'stock_balances', 'owner', { lease_token: 'test', checkpoint_version: 0 }, [{ source_id: '1', payload: { ...payload, _brufap_stock_capture: stockCapture(payload) } }], {});
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]); assert.match(bodies[0], /"saldoFisicoTotal":99999999999999\.9999999999/);
});

test('projector performs one bounded database call and skips an exhausted phase', async () => {
  const calls = [];
  const repo = { async rpc(...args) { calls.push(args); return { processed: 50, applied: 49, failed: 1, pending: 100 }; } };
  assert.equal((await projectStockMirror(repo, { deadline: 100, clock: () => 0 })).status, 'partial');
  assert.deepEqual(calls, [['erp_stock_mirror_project', { p_limit: 50 }, { deadline: 100 }]]);
  assert.equal((await projectStockMirror(repo, { deadline: 100, clock: () => 100 })).status, 'skipped_time'); assert.equal(calls.length, 1);
  await assert.rejects(projectStockMirror({ rpc: async () => ({ processed: 51, applied: 51, failed: 0, pending: 0 }) }, { deadline: 100, clock: () => 0 }), /STOCK_MIRROR_RESULT_INVALID/);
});

function schedulerFixture({ failProjection = false, failToken = false } = {}) {
  const events = [];
  const repo = {
    async claim() { events.push('claim'); return { acquired: true, lease_token: 'test', checkpoint_version: 1, checkpoint: {} }; },
    async rpc(name) { events.push(name); if (failProjection) throw new Error('Bearer private-value'); return { processed: 1, applied: 1, failed: 0, pending: 0 }; },
    async apply() { events.push('checkpoint'); }, async release() { events.push('release'); },
  };
  class NoUpstreamClient { get requestsMade() { return 0; } get remainingRequests() { return 0; } }
  const run = enabled => runSync(repo, { ORIGIN_ENABLED: 'true', ORIGIN_API_ORIGIN: 'https://api.provider.example', SYNC_ENABLED: 'true', STOCK_MIRROR_ENABLED: enabled }, {
    Client: NoUpstreamClient, resources: [], clock: () => 1000, now: () => new Date(1000),
    getToken: async () => { if (failToken) throw new Error('TOKEN_UNAVAILABLE'); return 'synthetic'; },
  });
  return { run, events };
}

test('scheduler projects after upstream work and before lease release with no Origin requests', async () => {
  const f = schedulerFixture(); const result = await f.run('true');
  assert.equal(result.requests, 0); assert.equal(result.stock_mirror.applied, 1);
  assert.deepEqual(f.events, ['claim', 'erp_stock_mirror_project', 'checkpoint', 'release']);
  const off = schedulerFixture(); await off.run('false'); assert.deepEqual(off.events, ['claim', 'checkpoint', 'release']);
});

test('projection failures do not undo staging or prevent checkpoint/release; upstream failure still projects', async () => {
  const f = schedulerFixture({ failProjection: true }); const result = await f.run('true');
  assert.equal(result.status, 'partial'); assert.equal(result.stock_mirror.code, 'SYNC_FAILED');
  assert.deepEqual(f.events.slice(-2), ['checkpoint', 'release']); assert.equal(JSON.stringify(result).includes('private-value'), false);
  const upstream = schedulerFixture({ failToken: true }); const failed = await upstream.run('true');
  assert.equal(failed.status, 'failed'); assert.equal(failed.stock_mirror.applied, 1);
});

test('repository allows only the named stock projector among stock ERP RPCs', async () => {
  const names = [];
  const repo = new Repository({ SUPABASE_URL: 'https://synthetic.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic' }, {
    fetchImpl: async url => { names.push(url.split('/').at(-1)); return Response.json({ processed: 0, applied: 0, failed: 0, pending: 0 }); },
  });
  await repo.rpc('erp_stock_mirror_project', { p_limit: 50 });
  await assert.rejects(repo.rpc('erp_stock_post', {}), /INVALID_RPC/); assert.deepEqual(names, ['erp_stock_mirror_project']);
});
