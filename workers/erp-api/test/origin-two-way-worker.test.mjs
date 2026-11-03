// Worker side of the two-way sync: the Origin client, send/reread, census and the Sincronizar run, against a fake Origin and,
// end to end, against the real SQL (PGlite). All records are synthetic; no request leaves the process.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OriginWriter, OriginWriteError, sendItem, pushOutbox, advanceRun, runOriginTwoWay, createdId, originErrorDetail, originSyncStatus, censusPlans } from '../src/origin-two-way.mjs';
import { createHandler } from '../src/index.mjs';
import { originTwoWayFixture } from './helpers/origin-two-way-fixture.mjs';

const noSleep = async () => {};
const json = (status, body, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** In-memory Origin: records per resource path, POST creates, PUT replaces, PATCH situação, DELETE removes, GET lists and reads. */
function fakeOrigin({ seed = {}, firstId = 880000 } = {}) {
  const store = new Map(Object.entries(seed).map(([path, rows]) => [path, new Map(rows.map(r => [String(r.id), r])) ]));
  const calls = []; let next = firstId;
  const table = base => { if (!store.has(base)) store.set(base, new Map()); return store.get(base); };
  const fetchImpl = async (url, init) => {
    const u = new URL(url), path = u.pathname.replace('/Api/v3', ''), method = init.method;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, query: Object.fromEntries(u.searchParams), auth: init.headers.Authorization });
    if (path === '/estoques' && method === 'POST') return json(201, { data: { id: ++next } });
    if (path === '/estoques/saldos') return json(200, { data: u.searchParams.getAll('idsProdutos[]').map(id => ({ produto: { id: Number(id) }, depositos: [{ id: 5001, saldoFisico: 7, saldoVirtual: 7 }] })) });
    let m = /^(\/contas\/(?:receber|pagar))\/(\d+)\/baixar$/.exec(path);
    if (m) return json(200, { bordero: { id: ++next } });
    m = /^(.+?)\/(\d+)\/situacoes(?:\/(\d+))?$/.exec(path);
    if (m) { const row = table(m[1]).get(m[2]); if (!row) return json(404, { error: { type: 'RESOURCE_NOT_FOUND' } }); row.situacao = m[3] ? { id: Number(m[3]) } : body.situacao; return new Response(null, { status: 204 }); }
    m = /^(.+?)\/(\d+)$/.exec(path);
    if (m) {
      const rows = table(m[1]), row = rows.get(m[2]);
      if (!row) return json(404, { error: { type: 'RESOURCE_NOT_FOUND', message: 'Não encontrado' } });
      if (method === 'GET') return json(200, { data: row });
      if (method === 'PUT') { rows.set(m[2], { ...body, id: Number(m[2]) }); return new Response(null, { status: 204 }); }
      if (method === 'DELETE') { rows.delete(m[2]); return new Response(null, { status: 204 }); }
    }
    if (method === 'POST') {
      if (body?.nome === 'Inválido') return json(400, { error: { type: 'VALIDATION_ERROR', message: 'Não foi possível salvar', fields: [{ msg: 'O campo numeroDocumento é inválido' }] } });
      const id = ++next; table(path).set(String(id), { ...body, id }); return json(201, { data: { id } });
    }
    if (method === 'GET') {
      const page = Number(u.searchParams.get('pagina') || 1), limit = Number(u.searchParams.get('limite') || 100);
      const rows = [...table(path).values()].slice((page - 1) * limit, page * limit).map(r => ({ id: r.id }));
      return json(200, { data: rows });
    }
    return json(405, { error: { type: 'METHOD' } });
  };
  return { fetchImpl, calls, store };
}

test('the Origin client only reaches allowed write paths and returns the Origin validation text, never the request', async () => {
  const origin = fakeOrigin();
  const writer = new OriginWriter('token-sintetico', { apiOrigin: 'https://api.provider.example', fetchImpl: origin.fetchImpl, sleep: noSleep, intervalMs: 0 });
  await assert.rejects(writer.call('DELETE', '/nfe/1'), e => e.code === 'ORIGIN_INVALID_PATH');
  await assert.rejects(writer.call('POST', '/contatos/1/../../nfe'), e => e.code === 'ORIGIN_INVALID_PATH');
  const created = await writer.call('POST', '/contatos', { body: { nome: 'Cliente', tipo: 'J', situacao: 'A' } });
  assert.equal(createdId(created.data), '880001');
  assert.equal(origin.calls[0].auth, 'Bearer token-sintetico');
  const failure = await writer.call('POST', '/contatos', { body: { nome: 'Inválido' } }).catch(e => e);
  assert.ok(failure instanceof OriginWriteError);
  assert.equal(failure.code, 'ORIGIN_VALIDATION_ERROR'); assert.equal(failure.retryable, false);
  assert.equal(failure.detail, 'Não foi possível salvar · O campo numeroDocumento é inválido');
  assert.equal(originErrorDetail({ error: { description: 'x'.repeat(900) } }).length, 200);
  assert.equal(createdId({ id: 12 }), '12'); assert.equal(createdId({ data: { id: 0 } }), null);
});

test('429 waits and retries; the request budget stops before the Origin quota', async () => {
  let n = 0; const waits = [];
  const writer = new OriginWriter('t', { apiOrigin: 'https://api.provider.example', intervalMs: 0, sleep: async ms => { waits.push(ms); }, maxRequests: 3,
    fetchImpl: async () => (++n === 1 ? json(429, { error: { type: 'TOO_MANY_REQUESTS' } }, { 'Retry-After': '2' }) : json(200, { data: [] })) });
  await writer.call('GET', '/contatos');
  assert.deepEqual(waits, [2000]); assert.equal(writer.requestsMade, 2);
  await writer.call('GET', '/contatos');
  await assert.rejects(writer.call('GET', '/contatos'), e => e.code === 'ORIGIN_REQUEST_BUDGET_EXHAUSTED' && e.retryable);
});

test('a claimed item runs its requests in order, fills the created ID and stages the reread record', async () => {
  const origin = fakeOrigin(), staged = [];
  const writer = new OriginWriter('t', { apiOrigin: 'https://api.provider.example', fetchImpl: origin.fetchImpl, sleep: noSleep, intervalMs: 0 });
  const rpc = async (name, args) => { staged.push([name, args]); return {}; };
  const result = await sendItem({ id: 1, token: 'tk', entity: 'purchase_orders', requests: [
    { method: 'POST', path: '/pedidos/compras', body: { fornecedor: { id: 1 }, itens: [] } },
    { method: 'PATCH', path: '/pedidos/compras/{id}/situacoes/77' }], fetch: '/pedidos/compras/{id}' }, { writer, rpc });
  assert.deepEqual(result, { id: 1, token: 'tk', ok: true, status: 200, origin_id: '880001', deleted: false });
  assert.deepEqual(origin.calls.map(c => `${c.method} ${c.path}`), ['POST /pedidos/compras', 'PATCH /pedidos/compras/880001/situacoes/77', 'GET /pedidos/compras/880001']);
  assert.equal(staged[0][0], 'erp_sync_stage'); assert.equal(staged[0][1].p_entity, 'purchase_orders'); assert.equal(staged[0][1].p_source_id, '880001');
  assert.deepEqual(staged[0][1].p_payload.situacao, { id: 77 });
  const refused = await sendItem({ id: 2, token: 'tk', entity: 'contacts', requests: [{ method: 'POST', path: '/contatos', body: { nome: 'Inválido' } }] }, { writer, rpc });
  assert.equal(refused.ok, false); assert.equal(refused.retry, false); assert.match(refused.error, /^ORIGIN_VALIDATION_ERROR: Não foi possível salvar/);
});

test('the census finds a record created in the Origin and confirms one deleted there, then the run ends', async () => {
  const origin = fakeOrigin({ seed: { '/contatos': [{ id: 11 }, { id: 12 }] } });
  const writer = new OriginWriter('t', { apiOrigin: 'https://api.provider.example', fetchImpl: origin.fetchImpl, sleep: noSleep, intervalMs: 0 });
  const calls = []; let saved;
  const rpc = async (name, args) => {
    calls.push([name, args]);
    if (name === 'erp_sync_claim') return [];
    if (name === 'erp_sync_pull') return { state: 'ready', processed: 0, applied: 0 };
    if (name === 'erp_sync_census_diff') return args.p_entity === 'contacts' ? { fetch: ['12'], check: ['13'] } : { fetch: [], check: [] };
    if (name === 'erp_sync_run_update') { saved = args; return {}; }
    return {};
  };
  const stats = {};
  await advanceRun({ id: 'r1', state: 'queued', phase: 'push', cursor: {} }, { rpc, writer, deadline: Infinity, stats });
  assert.equal(saved.p_state, 'done'); assert.equal(saved.p_phase, 'done');
  assert.deepEqual(calls.find(c => c[0] === 'erp_sync_census_add')[1], { p_run: 'r1', p_entity: 'contacts', p_ids: ['11', '12'] });
  assert.ok(calls.some(c => c[0] === 'erp_sync_stage' && c[1].p_source_id === '12'));
  assert.ok(calls.some(c => c[0] === 'erp_sync_remote_deleted' && c[1].p_origin === '13'));
  assert.equal(stats.deleted_in_origin, 1);
  assert.equal(origin.calls.filter(c => c.method !== 'GET').length, 0);
  const plans = censusPlans(Date.parse('2026-10-22T12:00:00Z'));
  assert.deepEqual(plans.find(p => p.entity === 'sales_orders').partitions, [{ dataInicial: '2025-10-23', dataFinal: '2026-10-22' }]);
});

test('without the Origin app secrets the cron only receives, and a pending run fails with a clear code', async () => {
  const calls = [];
  const rpc = async (name, args) => { calls.push([name, args]); if (name === 'erp_sync_run_get') return { id: 'r2', state: 'queued', phase: 'push' }; return { state: 'ready', processed: 0 }; };
  const result = await runOriginTwoWay({ rpc, env: { ORIGIN_ENABLED: 'true', ORIGIN_TWO_WAY_ENABLED: 'true' } });
  assert.equal(result.state, 'receive_only');
  assert.deepEqual(calls.map(c => c[0]), ['erp_sync_pull', 'erp_sync_run_get', 'erp_sync_run_update']);
  assert.equal(calls[2][1].p_error, 'ORIGIN_WRITE_NOT_CONFIGURED');
  assert.equal((await runOriginTwoWay({ rpc, env: { ORIGIN_TWO_WAY_ENABLED: 'false' } })).state, 'disabled');
});

test('status responses keep only aggregate fields and allow-listed issue data', () => {
  const status = originSyncStatus({ scope: 'origin_sync', enabled: true, actor_configured: true, secret: 'x',
    push: { pending: 2, failed: 0, last_sent_at: null, extra: 1 }, pull: { pending: 3, failed: 1, last_applied_at: '2026-10-22T12:00:00Z' }, issues: 1,
    recent_issues: [{ at: '2026-10-22T12:00:00Z', direction: 'push', entity: 'contacts', record_id: null, source_id: null, code: 'ORIGIN_VALIDATION_ERROR', detail: 'Campo', payload: {} }],
    run: { id: 'r', state: 'running', phase: 'census', requested_at: '2026-10-22T12:00:00Z', started_at: null, finished_at: null, stats: { listed: 10, bad: 'x' }, error: null, cursor: {} } });
  assert.equal(status.secret, undefined); assert.equal(status.push.extra, undefined); assert.equal(status.recent_issues[0].payload, undefined);
  assert.deepEqual(status.run.stats, { listed: 10 }); assert.equal(status.run.cursor, undefined);
  assert.throws(() => originSyncStatus({ scope: 'other' }), e => e.code === 'ERP_UPSTREAM_INVALID_RESPONSE');
});

let db;
after(async () => { if (db) await db.close(); });
test('end to end: a Brufap contact and order reach the fake Origin and come back mirrored, and a Origin deletion reaches the Brufap', async () => {
  db = await originTwoWayFixture();
  const origin = fakeOrigin();
  const writerFactory = async () => new OriginWriter('t', { apiOrigin: 'https://api.provider.example', fetchImpl: origin.fetchImpl, sleep: noSleep, intervalMs: 0, maxRequests: 200 });
  const contact = await db.catalog('contacts', { name: 'Cliente ponta a ponta', person_type: 'J' });
  const product = await db.catalog('products', { name: 'Produto ponta a ponta', unit: 'UN', kind: 'P', format: 'S', price: '9' });
  const order = await db.document('sales_orders', { contact: contact.id, items: [{ product_id: product.id, description: 'Produto ponta a ponta', quantity: '2', unit_price: '9' }] });
  const first = await runOriginTwoWay({ rpc: db.rpc, env: { ORIGIN_ENABLED: 'true', ORIGIN_TWO_WAY_ENABLED: 'true' }, writerFactory });
  assert.equal(first.state, 'ready');
  // Blocked order waits ~20s for its contact and product; the next cycle sends it.
  await db.db.query("update erp_sync.outbox set next_attempt_at='-infinity' where state='pending'");
  const second = await runOriginTwoWay({ rpc: db.rpc, env: { ORIGIN_ENABLED: 'true', ORIGIN_TWO_WAY_ENABLED: 'true' }, writerFactory });
  assert.equal(second.failed, 0);
  const sent = origin.calls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.path}`);
  assert.deepEqual(sent.slice(0, 3).sort(), ['POST /contatos', 'POST /pedidos/vendas', 'POST /produtos']);
  const originOrder = [...origin.store.get('/pedidos/vendas').values()][0];
  assert.equal(originOrder.itens[0].quantidade, 2); assert.equal(originOrder.numero, Number(order.number));
  const orderLink = await db.scalar("select origin_id v from erp_sync.link where entity='sales_orders' and record_id=$1", [order.id]);
  assert.equal(orderLink, String(originOrder.id));
  assert.equal(await db.scalar("select count(*)::integer v from erp_sync.outbox where state in('pending','sending','failed')"), 0, JSON.stringify((await db.db.query("select entity,op,state,error,attempts from erp_sync.outbox where state<>'done'")).rows));
  // The reread echo was applied without being sent back.
  assert.equal(await db.scalar("select count(*)::integer v from erp_sync.inbox"), 0);
  assert.equal(await db.scalar("select authority v from erp_documents.document where id=$1", [order.id]), 'brufap');
  // Deleted in the Origin and found by the Sincronizar census: moved to the trash in the Brufap.
  origin.store.get('/pedidos/vendas').delete(String(originOrder.id));
  await db.db.query("update origin_sync.raw_record set payload=payload||'{\"data\":\"2026-10-20\"}' where entity='sales_orders'");
  const request = await db.rpc('erp_sync_request', { p_user_id: db.users.admin });
  for (let i = 0; i < 5 && (await db.rpc('erp_sync_run_get', {})); i++) await runOriginTwoWay({ rpc: db.rpc, env: { ORIGIN_ENABLED: 'true', ORIGIN_TWO_WAY_ENABLED: 'true' }, writerFactory, now: () => Date.parse('2026-10-22T12:00:00Z') });
  const run = (await db.db.query('select * from erp_sync.run where id=$1', [request.requested_run])).rows[0];
  assert.equal(run.state, 'done', JSON.stringify(run));
  assert.ok(await db.scalar('select deleted_at v from erp_documents.document where id=$1', [order.id]));
});

test('route: GET reads the status, POST asks for a run, and nothing is answered without a session', async () => {
  const env = { ORIGIN_ENABLED: 'true', ORIGIN_TWO_WAY_ENABLED: 'true', SUPABASE_URL: 'https://exampleproject.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', ALLOWED_ORIGINS: 'https://erp.example.test' };
  const user = 'a0000000-0000-4000-8000-000000000001', seen = [];
  const status = { scope: 'origin_sync', enabled: true, actor_configured: true, push: { pending: 0, failed: 0, last_sent_at: null }, pull: { pending: 0, failed: 0, last_applied_at: null }, issues: 0, recent_issues: [], run: null };
  const handler = createHandler({ fetchImpl: async (url, init) => {
    seen.push(url);
    if (url.endsWith('/auth/v1/user')) return json(200, { id: user, app_metadata: {} });
    if (url.endsWith('/rpc/erp_sync_status')) return json(200, status);
    if (url.endsWith('/rpc/erp_sync_request')) { assert.deepEqual(JSON.parse(init.body), { p_user_id: user }); return json(200, { ...status, requested_run: randomUUID() }); }
    return json(200, { state: 'ready', processed: 0 });
  } });
  const waits = [];
  const call = (method, auth = true) => handler(new Request('https://api.example.test/v1/sincronizacao-origin', { method, headers: auth ? { Authorization: 'Bearer token' } : {} }), env, { waitUntil: p => waits.push(p) });
  assert.equal((await call('GET', false)).status, 401);
  const got = await call('GET'); assert.equal(got.status, 200); assert.equal((await got.json()).scope, 'origin_sync');
  const posted = await call('POST'); assert.equal(posted.status, 200); assert.ok((await posted.json()).requested_run);
  assert.equal(waits.length, 1); await Promise.all(waits);
  assert.equal((await call('DELETE')).status, 405);
  assert.ok(!seen.some(url => url.includes('provider.example')));
});
