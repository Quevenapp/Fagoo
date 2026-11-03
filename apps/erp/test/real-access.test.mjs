import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccessController, decimalMoney } from '../src/lib/real-access.ts';
import { accessConfig } from '../src/lib/access-config.ts';

const uid = 'a0000000-0000-4000-8000-000000000001';
const session = { access_token: 'synthetic-access-token', user: { id: uid } };
const me = { user_id: uid, role: 'vendas', resources: ['contacts', 'products', 'sales_orders', 'sales_proposals'], data_mode: 'staging_readonly' };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function fakeAuth(initialSession = null) {
  let callback = () => {};
  const calls = [];
  return {
    calls,
    getSession: async () => ({ data: { session: initialSession }, error: null }),
    onAuthStateChange(next) { callback = next; return { data: { subscription: { unsubscribe() { callback = () => {}; } } } }; },
    signInWithPassword: async credentials => { calls.push(['login', credentials]); return { data: { session: null }, error: { message: 'private upstream failure', status: 400 } }; },
    signOut: async options => { calls.push(['logout', options]); callback('SIGNED_OUT', null); return { error: null }; },
    emit(event, value) { callback(event, value); },
  };
}
const page = { entity: 'products', items: [{ id: '90071992547409931234', entity: 'products', name: 'Produto sintético', amount: '9007199254740993.27', raw: 'private raw payload', xml: 'private link' }], limit: 25, offset: 0, total: 1, has_more: false, next_offset: null, data_mode: 'staging_readonly' };

test('public configuration rejects privileged JWTs, secret keys, mismatched projects and unsafe URLs before build', () => {
  const env = { VITE_SUPABASE_URL: 'https://project.supabase.co', VITE_SUPABASE_ANON_KEY: 'sb_publishable_abcdefghijklmnop', VITE_ERP_API_URL: 'https://api.example.test' };
  assert.equal(accessConfig({}), null);
  assert.equal(accessConfig(env).apiUrl, 'https://api.example.test');
  const jwt = role => `e30.${Buffer.from(JSON.stringify({ role, ref: 'project' })).toString('base64url')}.synthetic`;
  assert.equal(accessConfig({ ...env, VITE_SUPABASE_ANON_KEY: jwt('anon') }).publicKey, jwt('anon'));
  for (const key of ['sb_secret_abcdefghijklmnop', jwt('service_role'), jwt('authenticated'), 'arbitrary']) assert.throws(() => accessConfig({ ...env, VITE_SUPABASE_ANON_KEY: key }), /Configuração pública/);
  assert.throws(() => accessConfig({ ...env, VITE_SUPABASE_URL: 'https://other.supabase.co', VITE_SUPABASE_ANON_KEY: jwt('anon') }));
  for (const url of ['https://api.example.test/path', 'https://user:password@api.example.test', 'http://api.example.test', 'javascript:alert(1)']) assert.throws(() => accessConfig({ ...env, VITE_ERP_API_URL: url }));
  assert.throws(() => accessConfig({ VITE_SUPABASE_URL: env.VITE_SUPABASE_URL }));
});

test('invalid login exposes a generic message and never queries records or stores credentials in state', async () => {
  const auth = fakeAuth(); let requests = 0;
  const controller = createAccessController(auth, 'https://api.example.test', async () => { requests++; return response(me); });
  const stop = controller.start(); await tick();
  await controller.login(' person@example.test ', 'synthetic-password');
  assert.equal(controller.getSnapshot().phase, 'signed_out');
  assert.match(controller.getSnapshot().message, /Confira seu e-mail e senha/);
  assert.equal(requests, 0);
  assert.doesNotMatch(JSON.stringify(controller.getSnapshot()), /synthetic-password|private upstream|person@example/);
  assert.equal(auth.calls[0][1].email, 'person@example.test');
  stop();
});

test('authenticated user without membership waits for release and cannot query any data', async () => {
  const calls = [];
  const controller = createAccessController(fakeAuth(session), 'https://api.example.test', async url => { calls.push(url); return response({ error: { code: 'ERP_FORBIDDEN' } }, 403); });
  const stop = controller.start(); await tick();
  assert.equal(controller.getSnapshot().phase, 'pending');
  assert.equal(controller.getSnapshot().membership, null);
  await controller.loadRecords({ entity: 'products', limit: 25, offset: 0 });
  assert.equal(calls.length, 1); assert.match(calls[0], /\/v1\/me$/);
  stop();
});

test('membership resources govern requests; query strings are encoded and raw response extras are discarded', async () => {
  const calls = [];
  const controller = createAccessController(fakeAuth(session), 'https://api.example.test', async (url, options) => { calls.push({ url, options }); return response(url.endsWith('/me') ? { ...me, email: 'private@example.test' } : page); });
  const stop = controller.start(); await tick();
  assert.equal(controller.getSnapshot().phase, 'ready');
  await controller.loadRecords({ entity: 'nfe', limit: 25, offset: 0 });
  assert.equal(calls.length, 1);
  await controller.loadRecords({ entity: 'products', q: 'A&B ?', limit: 25, offset: 0 });
  assert.equal(new URL(calls[1].url).searchParams.get('q'), 'A&B ?');
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${session.access_token}`);
  assert.equal(calls[1].options.credentials, 'omit'); assert.equal(calls[1].options.cache, 'no-store');
  const state = controller.getSnapshot();
  assert.equal(state.records.items[0].id, page.items[0].id);
  assert.equal(state.records.items[0].amount, page.items[0].amount);
  assert.doesNotMatch(JSON.stringify(state), /private|synthetic-access-token|raw|xml/);
  stop();
});

test('logout aborts pending data and a late successful response cannot restore the previous user records', async () => {
  const auth = fakeAuth(session); let resolve; let signal;
  const controller = createAccessController(auth, 'https://api.example.test', async (url, options) => {
    if (url.endsWith('/me')) return response(me);
    signal = options.signal; return new Promise(next => { resolve = next; });
  });
  const stop = controller.start(); await tick();
  const pending = controller.loadRecords({ entity: 'products', limit: 25, offset: 0 });
  assert.equal(controller.getSnapshot().listPending, true);
  await tick(); // Ensure this request was dispatched before testing in-flight cancellation.
  await controller.logout();
  assert.equal(signal.aborted, true);
  resolve(response(page)); await pending;
  assert.equal(controller.getSnapshot().phase, 'signed_out');
  assert.equal(controller.getSnapshot().records, null); assert.equal(controller.getSnapshot().membership, null);
  assert.deepEqual(auth.calls.at(-1), ['logout', { scope: 'local' }]);
  stop();
});

test('SDK token refresh preserves same-actor cached records while verifying the renewed credential', async () => {
  const auth = fakeAuth(session); const tokens = [];
  const controller = createAccessController(auth, 'https://api.example.test', async (url, options) => { tokens.push(options.headers.Authorization); return response(url.endsWith('/me') ? me : page); });
  const stop = controller.start(); await tick(); await controller.loadRecords({ entity: 'products', limit: 25, offset: 0 });
  const records=controller.getSnapshot().records;
  auth.emit('TOKEN_REFRESHED', { ...session, access_token: 'refreshed-synthetic-token' });
  assert.equal(controller.getSnapshot().phase, 'ready');
  assert.equal(controller.getSnapshot().records, records);
  await tick(); assert.equal(controller.getSnapshot().phase, 'ready');
  assert.equal(tokens.at(-1), 'Bearer refreshed-synthetic-token');
  stop();
});

test('confirmed revoked membership and expired token clear rows, and unmount aborts requests', async () => {
  for (const status of [401, 403]) {
    let checks=0;
    const controller = createAccessController(fakeAuth(session), 'https://api.example.test', async url => url.endsWith('/me')&&++checks===1?response(me):response({},status));
    const stop = controller.start(); await tick(); await controller.loadRecords({ entity: 'products', limit: 25, offset: 0 }); await tick();
    assert.equal(controller.getSnapshot().phase, status === 401 ? 'signed_out' : 'pending');
    assert.equal(controller.getSnapshot().records, null); assert.equal(controller.getSnapshot().membership, null); stop();
  }
  let signal; let finish;
  const controller = createAccessController(fakeAuth(session), 'https://api.example.test', async (_url, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); });
  const stop = controller.start(); await tick(); stop();
  assert.equal(signal.aborted, true); finish(response(me)); await tick();
  assert.equal(controller.getSnapshot().membership, null);
});

test('decimal formatting preserves cents and long values without numeric conversion', () => {
  assert.equal(decimalMoney('9007199254740993.27'), 'R$ 9.007.199.254.740.993,27');
  assert.equal(decimalMoney('-12.3'), 'R$ -12,30');
  assert.equal(decimalMoney('12.3456'), 'R$ 12,3456');
  assert.equal(decimalMoney(null), '—'); assert.equal(decimalMoney('NaN'), '—');
});
