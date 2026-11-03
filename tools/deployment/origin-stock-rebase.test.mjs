import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const privateDirectory = process.env.ORIGIN_STOCK_REBASE_TEST_DIR;
const before = privateDirectory ? await import(pathToFileURL(path.resolve(privateDirectory, 'worker-original-test.mjs')).href) : null;
const after = privateDirectory ? await import(pathToFileURL(path.resolve(privateDirectory, 'worker-stock-rebase-test.mjs')).href) : null;
const integrationTest = privateDirectory ? test : (name, fn) => test(name, { skip: 'Set ORIGIN_STOCK_REBASE_TEST_DIR to the ignored rebase output directory' }, fn);

const stockParams = { 'idsProdutos[]': ['1'], filtroSaldoEstoque: 0 };
const classes = [['public', module => module.OriginClient], ['scheduled-diagnostic', module => module.createDiagnosticClientClass(() => {})]];
for (const [name, select] of classes) {
  integrationTest(`${name}: exact stock numbers are parsed through the production client path`, async () => {
    const body = '{"data":[{"produto":{"id":1},"saldoFisicoTotal":0.1234567890123456789,"saldoVirtualTotal":-0.1234567890123456789,"depositos":[{"id":"001","saldoFisico":99999999999999.9999999999,"saldoVirtual":1.2e-8}]}]}';
    const Client = select(after);
    const actual = await new Client('synthetic', { intervalMs: 0, fetchImpl: async () => new Response(body) }).get('/estoques/saldos', stockParams);
    const encoded = JSON.stringify(actual);
    assert.match(encoded, /"saldoFisicoTotal":0\.1234567890123456789/);
    assert.match(encoded, /"saldoVirtualTotal":-0\.1234567890123456789/);
    assert.match(encoded, /"saldoFisico":99999999999999\.9999999999/);
    assert.match(encoded, /"saldoVirtual":0\.000000012/);
    assert.equal(actual[0].depositos[0].id, '001');
  });
  integrationTest(`${name}: null/missing/string and non-stock parsing are unchanged`, async () => {
    for (const [endpoint, query, body] of [
      ['/estoques/saldos', stockParams, '{"data":[{"produto":{"id":1},"saldoFisicoTotal":null,"saldoVirtualTotal":"1.200","depositos":[{"id":1,"saldoFisico":false}]}]}'],
      ['/produtos/1', {}, '{"data":{"id":1,"preco":0.1234567890123456789}}'],
      ['/nfe/1', {}, '{"data":{"id":1,"situacao":6}}'],
    ]) {
      const outputs = [];
      for (const module of [before, after]) {
        const Client = select(module);
        outputs.push(await new Client('synthetic', { intervalMs: 0, priceCaptureEnabled: true, fetchImpl: async () => new Response(body) }).get(endpoint, query));
      }
      assert.equal(JSON.stringify(outputs[0]), JSON.stringify(outputs[1]));
    }
  });
  integrationTest(`${name}: errors, GET-only behavior and budget consumption match the active wrapper`, async () => {
    for (const status of [400, 401, 403, 429, 503]) {
      const outputs = [];
      for (const module of [before, after]) {
        const Client = select(module); let calls = 0;
        const client = new Client('synthetic', { intervalMs: 0, sleep: async () => {}, fetchImpl: async (_url, init) => {
          calls++; assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
          return new Response('{"error":{"type":"UNKNOWN_ERROR"}}', { status });
        } });
        let failure; try { await client.get('/estoques/saldos', stockParams, { maxAttempts: 1 }); } catch (error) { failure = { code: error.code, status: error.status }; }
        outputs.push({ failure, calls, requests: client.requestsMade });
      }
      assert.deepEqual(outputs[0], outputs[1]);
    }
  });
}

integrationTest('literal campaign selection and capacity configuration are unchanged', () => {
  assert.deepEqual(after.input, before.input); assert.deepEqual(after.capacityConfig, before.capacityConfig);
});

integrationTest('active scheduled client + production stockBatch persists lexical proof using the existing staging RPC', async () => {
  const Client = after.createDiagnosticClientClass(() => {}), writes = [];
  const client = new Client('synthetic', { intervalMs: 0, fetchImpl: async () => new Response('{"data":[{"produto":{"id":1},"depositos":[{"id":2,"saldoFisico":0.1234567890123456789,"saldoVirtual":null}]}]}') });
  const repo = {
    rpc: async name => { assert.equal(name, 'origin_sync_stock_product_page'); return { items: ['1'], has_more: false, next_cursor: null, coverage_complete: false }; },
    apply: async (...args) => { writes.push(args); return { inserted: 1 }; },
  };
  const result = await after.stockBatch(repo, client, 'synthetic', { lease_token: 'synthetic' }, {}, { keepLease: async () => {}, deadline: Infinity, cutoff: '2026-10-22', clock: () => 0 });
  assert.equal(result.overlaps, 2); assert.equal(client.requestsMade, 3); assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'stock_balances'); assert.equal(writes[0][1], 'stock_balances');
  const row = writes[0][4][0]; assert.equal(row.payload._brufap_stock_capture.profile, 'origin-stock-json-v1');
  assert.deepEqual(row.payload._brufap_stock_capture.tokens, [{ path: '/depositos/0/saldoFisico', lexeme: '0.1234567890123456789' }]);
  assert.match(JSON.stringify(row), /"saldoFisico":0\.1234567890123456789/);
});

integrationTest('active stockBatch rejects different exact values that the previous client rounded together', async () => {
  for (const [module, expectedFailure] of [[before, false], [after, true]]) {
    const Client = module.createDiagnosticClientClass(() => {}); let commits = 0;
    const client = new Client('synthetic', { intervalMs: 0, fetchImpl: async url => {
      const value = new URL(url).searchParams.get('filtroSaldoEstoque') === '1' ? '0.1234567890123456790' : '0.1234567890123456789';
      return new Response(`{"data":[{"produto":{"id":1},"depositos":[{"id":2,"saldoFisico":${value}}]}]}`);
    } });
    const repo = { rpc: async () => ({ items: ['1'], has_more: false, next_cursor: null, coverage_complete: false }), apply: async () => { commits++; return { inserted: 1 }; } };
    const run = () => module.stockBatch(repo, client, 'synthetic', { lease_token: 'synthetic' }, {}, { keepLease: async () => {}, deadline: Infinity, cutoff: '2026-10-22', clock: () => 0 });
    if (expectedFailure) { await assert.rejects(run(), /ORIGIN_STOCK_RESPONSE_CONFLICT/); assert.equal(commits, 0); }
    else { await run(); assert.equal(commits, 1); }
  }
});

