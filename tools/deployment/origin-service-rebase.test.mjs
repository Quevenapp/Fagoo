import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const directory = process.env.ORIGIN_SERVICE_REBASE_TEST_DIR;
const before = directory ? await import(pathToFileURL(path.resolve(directory, 'worker-before-test.mjs')).href) : null;
const after = directory ? await import(pathToFileURL(path.resolve(directory, 'worker-service-rebase-test.mjs')).href) : null;
const check = directory ? test : (name, fn) => test(name, { skip: 'Set ORIGIN_SERVICE_REBASE_TEST_DIR to the ignored rebase output' }, fn);
const classes = [['public', module => module.OriginClient], ['scheduled-diagnostic', module => module.createDiagnosticClientClass(() => {})]];
for (const [name, select] of classes) {
  check(`${name}: service detail retains exact quantities, prices and source evidence`, async () => {
    const Client = select(after), value = await new Client('synthetic', { intervalMs: 0, fetchImpl: async (_url, init) => {
      assert.equal(init.method, 'GET'); return new Response('{"data":{"id":1,"total":12.1234567890123456789,"pecas":[{"valorUnitario":0.1234567890123456789}],"servicos":[{"horas":1.234567890123456789}]}}');
    } }).get('/ordens/servico/1');
    assert.match(JSON.stringify(value), /"valorUnitario":0\.1234567890123456789/);
    assert.equal(value._brufap_service_capture.profile, 'origin-service-json-v1');
    assert.equal(value._brufap_service_capture.tokens.length, 3);
  });
  check(`${name}: existing fiscal, product, stock and service list outputs are unchanged`, async () => {
    for (const [endpoint, params, body] of [['/ordens/servico', {}, '{"data":[{"id":1,"total":1.2}]}'], ['/produtos/1', {}, '{"data":{"id":1,"preco":0.1234567890123456789}}'],
      ['/nfe/1', {}, '{"data":{"id":1,"situacao":6}}'], ['/estoques/saldos', { 'idsProdutos[]': ['1'], filtroSaldoEstoque: 0 }, '{"data":[{"produto":{"id":1},"saldoFisicoTotal":0.1234567890123456789}]}']]) {
      const values = [];
      for (const module of [before, after]) values.push(JSON.stringify(await new (select(module))('synthetic', { intervalMs: 0, priceCaptureEnabled: true, fetchImpl: async () => new Response(body) }).get(endpoint, params)));
      assert.equal(values[0], values[1]);
    }
  });
}
check('campaign and capacity literals are preserved exactly', () => { assert.deepEqual(before.input, after.input); assert.deepEqual(before.capacityConfig, after.capacityConfig); });
check('scheduled diagnostic client persists OS evidence through the unchanged syncPage staging path', async () => {
  const Client = after.createDiagnosticClientClass(() => {}), commits = [];
  const client = new Client('synthetic', { intervalMs: 0, fetchImpl: async url => new Response(url.endsWith('/1') ? '{"data":{"id":1,"total":1.1234567890123456789}}' : '{"data":[{"id":1}]}') });
  const repo = { claim: async () => ({ acquired: true, lease_token: 'synthetic', checkpoint: {} }), apply: async (...args) => { commits.push(args); return { inserted: 1 }; }, release: async () => {} };
  const resource = after.RESOURCES.find(row => row.id === 'service_orders'); assert.ok(resource);
  await after.syncPage(repo, client, resource, 'synthetic', { SYNC_START_DATE: '2024-01-01' });
  assert.equal(commits.length, 1); const record = commits[0][4][0];
  assert.equal(record.payload._brufap_service_capture.profile, 'origin-service-json-v1');
  assert.match(JSON.stringify(record), /"total":1\.1234567890123456789/);
});
