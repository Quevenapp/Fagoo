import test from 'node:test';
import assert from 'node:assert/strict';
import { OriginApiError, OriginClient } from '../src/client.mjs';

const jsonResponse = (data = [], status = 200, headers = {}) => new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json', ...headers } });

function harness(responses = [jsonResponse()], config = {}) {
  const calls = [], waits = [];
  let time = Date.parse('2026-10-16T01:00:00Z');
  const client = new OriginClient('test-private-token', { apiOrigin: 'https://api.provider.example',
    fetchImpl: async (url, init) => {
      calls.push({ url, init, time });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
    sleep: async (ms) => { waits.push(ms); time += ms; },
    now: () => time,
    ...config,
  });
  return { client, calls, waits };
}

test('client issues only GET to the fixed origin with JWT auth and no redirects', async () => {
  const { client, calls } = harness([jsonResponse([{ id: 12345678901 }])]);
  assert.deepEqual(await client.get('/contatos', { criterio: 1, pagina: 1, limite: 25 }), [{ id: 12345678901 }]);
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.provider.example/Api/v3/contatos?criterio=1&pagina=1&limite=25');
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.headers.Authorization, 'Bearer test-private-token');
  assert.equal(init.headers['enable-jwt'], '1');
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(client.requestsMade, 1);
  assert.equal(client.remainingRequests, 119);
});

test('paths cannot change origin, escape API prefix or invoke actions', async () => {
  const { client, calls } = harness();
  for (const path of ['https://evil.test', '//evil.test/contatos', '/produtos/../oauth/token', '/produtos?url=https://evil.test', '/produtos%2F1', '/nfe/1/enviar', '/oauth/token']) {
    await assert.rejects(client.get(path), { code: 'ORIGIN_INVALID_PATH' });
  }
  assert.equal(calls.length, 0);
  assert.equal(client.requestsMade, 0);
});

test('auxiliary catalogs allow list and detail reads but reject mutations and unapproved resources', async () => {
  const { client, calls } = harness([jsonResponse([{ id: 10 }]), jsonResponse({ id: 10 }), jsonResponse([{ id: 20 }]), jsonResponse({ id: 20 })]);
  await client.get('/formas-pagamentos', { situacao: 0 });
  await client.get('/formas-pagamentos/10');
  await client.get('/vendedores', { situacaoContato: 'T' });
  await client.get('/vendedores/20');
  for (const path of ['/formas-pagamentos/10/padrao', '/formas-pagamentos/10/situacao', '/ordens/servico/10/situacoes/1', '/depositos/1/estoque']) {
    await assert.rejects(client.get(path), { code: 'ORIGIN_INVALID_PATH' });
  }
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.init.method === 'GET'));
});

test('proposals and NFC-e permit only read-only collection and detail routes', async () => {
  const { client, calls } = harness([
    jsonResponse([{ id: 123 }]), jsonResponse({ id: 123, itens: [] }),
    jsonResponse([{ id: 456 }]), jsonResponse({ id: 456, chaveAcesso: '9'.repeat(44) }),
  ]);
  assert.deepEqual(await client.get('/propostas-comerciais', { pagina: 1, limite: 10 }), [{ id: 123 }]);
  assert.equal((await client.get('/propostas-comerciais/123')).id, 123);
  assert.deepEqual(await client.get('/nfce', { pagina: 1, limite: 10 }), [{ id: 456 }]);
  assert.equal((await client.get('/nfce/456')).chaveAcesso, '9'.repeat(44));
  assert.ok(calls.every(({ url, init }) => new URL(url).origin === 'https://api.provider.example' && init.method === 'GET'));
  for (const path of [
    '/propostas-comerciais/123/situacoes', '/nfce/456/enviar',
    '/nfce/456/lancar-contas', '/nfce/456/estornar-contas',
    '/nfce/456/lancar-estoque', '/nfce/456/lancar-estoque/1',
    '/nfce/456/estornar-estoque', '/pedidos/vendas/123/gerar-nfce',
    '/nfce/456?redirect=https://evil.test', '/nfce/../nfe',
  ]) await assert.rejects(client.get(path), { code: 'ORIGIN_INVALID_PATH' });
  assert.equal(calls.length, 4);
});

test('query serialization escapes values and supports documented repeated-array parameters', async () => {
  const { client, calls } = harness();
  await client.get('/pedidos/vendas', { 'idsSituacoes[]': [1, 2], numero: '1&redirect=https://evil.test' });
  const url = new URL(calls[0].url);
  assert.equal(url.origin, 'https://api.provider.example');
  assert.deepEqual(url.searchParams.getAll('idsSituacoes[]'), ['1', '2']);
  assert.equal(url.searchParams.get('numero'), '1&redirect=https://evil.test');
  assert.equal(url.searchParams.has('redirect'), false);
  for (const params of [{ 'bad\r\nheader': 1 }, { pagina: {} }, { pagina: [1] }, { pagina: Number.MAX_SAFE_INTEGER + 1 }, { pesquisa: 'a\r\nb' }]) {
    await assert.rejects(client.get('/contatos', params), OriginApiError);
  }
  assert.equal(calls.length, 1);
});

test('concurrent calls share sequential pacing and a single request budget', async () => {
  const { client, calls, waits } = harness([jsonResponse(), jsonResponse(), jsonResponse()], { maxRequests: 2 });
  const results = await Promise.allSettled([client.get('/contatos'), client.get('/produtos'), client.get('/nfe')]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled', 'rejected']);
  assert.equal(results[2].reason.code, 'ORIGIN_REQUEST_BUDGET_EXHAUSTED');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].time - calls[0].time, 700);
  assert.deepEqual(waits, [700]);
  assert.equal(client.remainingRequests, 0);
});

test('429 and 5xx retry at most three total HTTP attempts with Retry-After bounded at 30s', async () => {
  const { client, calls, waits } = harness([
    new Response('SECRET_ERROR_BODY', { status: 429, headers: { 'retry-after': '999999' } }),
    new Response('SECRET_ERROR_BODY', { status: 503 }),
    jsonResponse([{ id: 1 }]),
  ]);
  assert.deepEqual(await client.get('/contatos'), [{ id: 1 }]);
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [30_000, 2000]);
  assert.equal(client.requestsMade, 3);
});

test('Retry-After HTTP date is honored', async () => {
  const { client, waits } = harness([
    new Response('private', { status: 429, headers: { 'retry-after': 'Fri, 16 Oct 2026 01:00:05 GMT' } }),
    jsonResponse(),
  ]);
  await client.get('/contatos');
  assert.deepEqual(waits, [5000]);
});

test('persistent 5xx stops after three attempts and never exposes error bodies', async () => {
  const { client, calls } = harness([500, 502, 503].map((status) => new Response('PRIVATE_NAME_123', { status })));
  await assert.rejects(client.get('/contatos'), (error) => {
    assert.equal(error.code, 'ORIGIN_SERVER_ERROR');
    assert.equal(error.status, 503);
    assert.equal(error.retryable, true);
    assert.doesNotMatch(String(error), /PRIVATE_NAME|token|https:/);
    return true;
  });
  assert.equal(calls.length, 3);
});

test('authentication, authorization and missing resources are not retried or silently discarded', async () => {
  for (const [status, code] of [[401, 'ORIGIN_UNAUTHORIZED'], [403, 'ORIGIN_FORBIDDEN'], [404, 'ORIGIN_NOT_FOUND'], [400, 'ORIGIN_HTTP_ERROR']]) {
    const { client, calls } = harness([new Response('private details', { status })]);
    await assert.rejects(client.get('/contatos/123'), { code, status, retryable: false });
    assert.equal(calls.length, 1);
  }
});

test('retries consume the same hard request budget', async () => {
  const { client, calls } = harness([new Response('', { status: 500 }), jsonResponse()], { maxRequests: 1 });
  await assert.rejects(client.get('/contatos'), { code: 'ORIGIN_REQUEST_BUDGET_EXHAUSTED' });
  assert.equal(calls.length, 1);
  assert.equal(client.requestsMade, 1);
});

test('manual redirect responses are blocked without following Location or retrying', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const { client, calls } = harness([new Response('private', { status, headers: { location: 'https://evil.test/steal' } })]);
    await assert.rejects(client.get('/contatos'), { code: 'ORIGIN_REDIRECT_BLOCKED', status });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.redirect, 'manual');
  }
});

test('network errors do not expose tokens, URLs or bodies', async () => {
  const { client } = harness([new Error('test-private-token https://private.test PERSONAL_NAME')]);
  await assert.rejects(client.get('/contatos'), (error) => {
    assert.equal(error.code, 'ORIGIN_NETWORK_ERROR');
    assert.doesNotMatch(JSON.stringify(error) + String(error), /test-private-token|private.test|PERSONAL_NAME/);
    return true;
  });
});

test('timeout aborts the request and bounds a fetch that never resolves', async () => {
  let signal;
  const client = new OriginClient('secret', { apiOrigin: 'https://api.provider.example', timeoutMs: 5, fetchImpl: async (_, init) => { signal = init.signal; return new Promise(() => {}); } });
  await assert.rejects(client.get('/contatos'), { code: 'ORIGIN_TIMEOUT' });
  assert.equal(signal.aborted, true);
  assert.equal(client.requestsMade, 1);
});

test('malformed envelopes and JSON fail without exposing record values', async () => {
  for (const body of ['PRIVATE_VALUE', '{"error":{"message":"PRIVATE_VALUE"}}', '{"data":null}', '{"data":"PRIVATE_VALUE"}', '{"data":[],"error":{}}']) {
    const { client } = harness([new Response(body, { status: 200 })]);
    await assert.rejects(client.get('/contatos'), (error) => {
      assert.ok(error instanceof OriginApiError);
      assert.doesNotMatch(String(error), /PRIVATE_VALUE/);
      return true;
    });
  }
});

test('unsafe numeric IDs are rejected recursively while string IDs retain precision', async () => {
  const unsafe = harness([new Response('{"data":[{"contato":{"id":9007199254740993}}]}')]);
  await assert.rejects(unsafe.client.get('/contatos'), { code: 'ORIGIN_UNSAFE_NUMBER' });
  const safe = harness([jsonResponse({ id: '9007199254740993', contato: { id: 12345678901 } })]);
  assert.equal((await safe.client.get('/contatos/1')).id, '9007199254740993');
  const fractional = harness([jsonResponse([{ id: 1.5 }])]);
  await assert.rejects(fractional.client.get('/contatos'), { code: 'ORIGIN_INVALID_ID_NUMBER' });
});

test('collection/detail shapes are enforced so a malformed page cannot look empty', async () => {
  const list = harness([jsonResponse({ id: 1 })]);
  await assert.rejects(list.client.get('/contatos'), { code: 'ORIGIN_INVALID_DATA_SHAPE' });
  const detail = harness([jsonResponse([{ id: 1 }])]);
  await assert.rejects(detail.client.get('/contatos/1'), { code: 'ORIGIN_INVALID_DATA_SHAPE' });
});

test('oversized responses fail before parsing or logging their content', async () => {
  const { client } = harness([jsonResponse([], 200, { 'content-length': String(9 * 1024 * 1024) })]);
  await assert.rejects(client.get('/contatos'), { code: 'ORIGIN_RESPONSE_SIZE_LIMIT' });
});
test('error-body cleanup never blocks known status or alters500 retry count',async()=>{
 for(const cancel of[()=>new Promise(()=>{}),()=>Promise.reject(new Error('private')),()=>{throw new Error('private');}]){
  let calls=0;
  const c=new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',timeoutMs:20,intervalMs:0,sleep:async()=>{},fetchImpl:async()=>{calls++;return{status:503,headers:new Headers(),body:{cancel}};}});
  await assert.rejects(c.get('/pedidos/vendas/1'),e=>e.code==='ORIGIN_SERVER_ERROR'&&e.status===503);assert.equal(calls,3);
 }
});
