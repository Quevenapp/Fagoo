import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogData, catalogListParams } from '../src/lib/catalog-model.ts';
import { createAccessController } from '../src/lib/real-access.ts';

test('native contact payload preserves alphanumeric document, normalizes optional fields and never includes source or audit input', () => {
  const data = catalogData('contacts', { name: ' Empresa sintética ', document: '12.ABC.345/01DE-35', state: 'sp', source: 'untrusted', version: '99' }, ['customer','supplier']);
  assert.equal(data.name, 'Empresa sintética'); assert.equal(data.document, '12.ABC.345/01DE-35'); assert.equal(data.state, 'SP'); assert.equal(data.code, null);
  assert.equal(data.source, undefined); assert.equal(data.version, undefined); assert.deepEqual(data.roles, ['customer','supplier']);
});

test('native product prices remain decimal strings with no numeric precision loss; invalid input cannot be saved', () => {
  assert.equal(catalogData('products', { name: 'Produto', price: '12345678901234,1234' }, []).price, '12345678901234.1234');
  assert.equal(catalogData('products', { name: 'Produto', price: '1,12345' }, []).price, '1.1234500000');
  for (const price of ['-1','1e2','1.234,56','NaN','1.12345678901']) assert.throws(() => catalogData('products', { name: 'Produto', price }, []), /preço/);
  assert.throws(() => catalogData('products', { name: '   ' }, []), /nome/);
});

test('product measurements and inventory thresholds preserve six decimals without floating point arithmetic', () => {
  const data = catalogData('products', { name: 'Produto', price: '0,0001', net_weight: '999999999999,999999', stock_min: '0,000001', stock_max: '0,000002', volumes: '999999', origin: '0', production: 'third_party' }, []);
  assert.equal(data.net_weight, '999999999999.999999'); assert.equal(data.stock_min, '0.000001'); assert.equal(data.stock_max, '0.000002');
  assert.equal(data.price, '0.0001'); assert.equal(data.volumes, '999999'); assert.equal(data.origin, '0');
  assert.equal(data.production, 'third_party'); assert.equal(data.brand, null);
  assert.throws(() => catalogData('products', { name: 'P', stock_min: '999999999999.999999', stock_max: '999999999999.999998' }, []), /máximo/);
  for (const net_weight of ['-1', '1e3', '1.234,56', '0.0000001', '1000000000000', '01']) assert.throws(() => catalogData('products', { name: 'P', net_weight }, []));
  for (const volumes of ['-1', '1.1', '1000000', '01', 'NaN']) assert.throws(() => catalogData('products', { name: 'P', volumes }, []));
});

test('product metadata has explicit classifications, no fiscal defaults or operational inputs', () => {
  const empty = catalogData('products', { name: 'Produto', balance: '50', cost: '12', tax_rate: '18', warehouse_id: 'outside' }, []);
  for (const key of ['kind', 'format', 'origin', 'condition', 'production', 'dimension_unit']) assert.equal(empty[key], null);
  for (const key of ['balance', 'cost', 'tax_rate', 'warehouse_id']) assert.equal(empty[key], undefined);
  for (const [key, value] of [['origin', '9'], ['kind', 'X'], ['condition', 'broken'], ['dimension_unit', 'kg'], ['cest', '12.345.67']]) {
    assert.throws(() => catalogData('products', { name: 'Produto', [key]: value }, []), error => error.field === key);
  }
  assert.equal(catalogData('products', { name: 'Produto', cest: '0123456', format: 'E' }, []).cest, '0123456');
});

test('legacy NCM/GTIN may be retained but edits must follow the supported shape', () => {
  const record = { ncm: 'LEGACY', gtin: '123' };
  assert.equal(catalogData('products', { name: 'P', ncm: 'LEGACY', gtin: '123' }, [], record).ncm, 'LEGACY');
  assert.throws(() => catalogData('products', { name: 'P', ncm: 'INVALID' }, [], record), /NCM/);
  assert.throws(() => catalogData('products', { name: 'P', gtin: '456' }, [], record), /GTIN/);
  assert.throws(() => catalogData('products', { name: 'P', gtin_tax: '123' }, [], record), /GTIN/);
  const data = catalogData('products', { name: 'P', ncm: '01234567', gtin: 'SEM GTIN', gtin_tax: '00000000000000' }, [], record);
  assert.equal(data.ncm, '01234567'); assert.equal(data.gtin, 'SEM GTIN'); assert.equal(data.gtin_tax, '00000000000000');
});

test('product filters stay on product queries and preserve literal brand and GTIN searches', () => {
  const filter = { kind: 'P', format: 'S', ncm_presence: 'missing', brand: ' Marca 100%_Teste ' };
  const query = catalogListParams('products', ' 00000001 ', 'true', 'cursor', filter);
  assert.equal(query.get('q'), '00000001'); assert.equal(query.get('brand'), 'Marca 100%_Teste'); assert.equal(query.get('ncm_presence'), 'missing'); assert.equal(query.get('after'), 'cursor');
  const contacts = catalogListParams('contacts', '', '', null, filter);
  assert.deepEqual([...contacts], [['limit', '25']]);
});

test('native request body uses SDK token only in Authorization and logout aborts a pending mutation without showing late data', async () => {
  const session = { access_token: 'synthetic-token', user: { id: 'a0000000-0000-4000-8000-000000000001' } };
  const auth = { getSession: async () => ({ data: { session }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signInWithPassword: async () => ({ data: { session }, error: null }), signOut: async () => ({ error: null }) };
  let resolve; let options;
  const controller = createAccessController(auth, 'https://api.example.test', async (url, init) => {
    if (url.endsWith('/me')) return new Response(JSON.stringify({ user_id: session.user.id, role: 'admin', resources: [], data_mode: 'staging_readonly' }));
    options = init; return new Promise(next => { resolve = next; });
  });
  const stop = controller.start(); await new Promise(next => setTimeout(next, 0));
  const pending = controller.catalog('/v1/cadastros/contacts', { method: 'POST', body: { command_id: 'synthetic-command', data: { name: 'Contato' } } });
  await new Promise(next => setTimeout(next, 0));
  assert.equal(options.headers.Authorization, 'Bearer synthetic-token'); assert.doesNotMatch(options.body, /synthetic-token/);
  await controller.logout(); assert.equal(options.signal.aborted, true);
  resolve(new Response(JSON.stringify({ private: 'late record' })));
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(controller.getSnapshot().phase, 'signed_out'); stop();
});

test('catalog 403 rechecks the same actor in background without aborting an independently authorized read', async () => {
  const session = { access_token: 'synthetic-token', user: { id: 'a0000000-0000-4000-8000-000000000001' } };
  const auth = { getSession: async () => ({ data: { session }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signInWithPassword: async () => ({ data: { session }, error: null }), signOut: async () => ({ error: null }) };
  let checks = 0; let finish; let signal; const transitions = [];
  const controller = createAccessController(auth, 'https://api.example.test', async (url, options) => {
    if (url.endsWith('/me')) { checks++; return new Response(JSON.stringify({ user_id: session.user.id, role: checks === 1 ? 'admin' : 'consulta', resources: [], data_mode: 'staging_readonly' })); }
    if (url.endsWith('/contacts')) return new Response('{}', { status: 403 });
    signal = options.signal; return new Promise(resolve => { finish = resolve; });
  });
  const unsubscribe = controller.subscribe(() => transitions.push(controller.getSnapshot()));
  const stop = controller.start(); await new Promise(resolve => setTimeout(resolve, 0));
  transitions.length=0;
  const late = controller.catalog('/v1/cadastros/products');
  await assert.rejects(() => controller.catalog('/v1/cadastros/contacts'), error => error.status === 403);
  assert.equal(signal.aborted, false);
  assert.ok(transitions.every(state => state.phase === 'ready' && state.membership.user_id === session.user.id));
  finish(new Response(JSON.stringify({ record: 'same-actor permitted response' })));assert.deepEqual(await late,{record:'same-actor permitted response'});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(controller.getSnapshot().membership.role, 'consulta'); assert.equal(checks, 2); unsubscribe(); stop();
});

test('catalog JSON response size is limited even when the upstream sends no Content-Length', async () => {
  const session = { access_token: 'synthetic-token', user: { id: 'a0000000-0000-4000-8000-000000000001' } };
  const auth = { getSession: async () => ({ data: { session }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signInWithPassword: async () => ({ data: { session }, error: null }), signOut: async () => ({ error: null }) };
  const controller = createAccessController(auth, 'https://api.example.test', async url => new Response(JSON.stringify(url.endsWith('/me') ? { user_id: session.user.id, role: 'admin', resources: [], data_mode: 'staging_readonly' } : { data: 'x'.repeat(1024 * 1024) })));
  const stop = controller.start(); await new Promise(resolve => setTimeout(resolve, 0));
  await assert.rejects(() => controller.catalog('/v1/cadastros/products'), error => error.status === 502); stop();
});
