import test from 'node:test';
import assert from 'node:assert/strict';
import { OriginClient } from '../src/client.mjs';
import { parseServiceJson } from '../src/service-json.mjs';
const read = text => parseServiceJson(text, new TextEncoder().encode(text));

test('OS: captura lexical preserva totais, preço, horas e desconto sem alterar identidades', async () => {
  const body = '{"data":{"id":123,"total":999999999.123456789012345,"pecas":[{"produto":{"id":456},"quantidade":0.1234567890123456789,"valorUnitario":1.2e-8,"desconto":0}],"servicos":[{"horas":1.234567890123456789,"valorTotal":12.34567890123456789}]}}';
  const client = new OriginClient('synthetic', { apiOrigin: 'https://api.provider.example', intervalMs: 0, fetchImpl: async (_url, init) => { assert.equal(init.method, 'GET'); return new Response(body); } });
  const value = await client.get('/ordens/servico/123');
  assert.equal(value.id, 123); assert.equal(value.pecas[0].produto.id, 456);
  const encoded = JSON.stringify(value);
  assert.match(encoded, /"total":999999999\.123456789012345/);
  assert.match(encoded, /"quantidade":0\.1234567890123456789/);
  assert.match(encoded, /"valorUnitario":0\.000000012/);
  assert.match(encoded, /"horas":1\.234567890123456789/);
  assert.equal(value._brufap_service_capture.profile, 'origin-service-json-v1');
  assert.equal(value._brufap_service_capture.tokens.length, 6);
  assert.deepEqual(value._brufap_service_capture.tokens[2], { path: '/pecas/0/valorUnitario', lexeme: '1.2e-8' });
});

test('OS: ausência, null e texto não se transformam em zero; evidência reservada é recusada', async () => {
  const result = await read('{"data":{"id":1,"total":null,"pecas":[{"valorUnitario":"1.2300","quantidade":null}]}}');
  assert.equal(result.data.total, null); assert.equal(result.data.pecas[0].valorUnitario, '1.2300');
  assert.equal(result.data.pecas[0].quantidade, null); assert.deepEqual(result.data._brufap_service_capture.tokens, []);
  await assert.rejects(read('{"data":{"id":1,"_brufap_service_capture":{}}}'), { code: 'ORIGIN_SERVICE_RESPONSE_CONFLICT' });
  await assert.rejects(read('{"data":{"id":1,"total":1,"total":2}}'), { code: 'ORIGIN_DUPLICATE_JSON_KEY' });
});

test('OS: lista mantém forma original e não cria evidência de detalhe', async () => {
  const client = new OriginClient('synthetic', { apiOrigin: 'https://api.provider.example', intervalMs: 0, fetchImpl: async () => new Response('{"data":[{"id":1,"total":1.5}]}') });
  assert.deepEqual(await client.get('/ordens/servico'), [{ id: 1, total: 1.5 }]);
});
