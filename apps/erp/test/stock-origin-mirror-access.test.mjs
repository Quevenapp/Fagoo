import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccessController } from '../src/lib/real-access.ts';
import { mirrorActor, mirrorPage } from './helpers/stock-origin-mirror-fixture.mjs';

test('existing stock transport supports the mirror GET for stock reading sessions without issuing a native write', async () => {
  for (const role of ['admin', 'estoque', 'vendas', 'fiscal', 'consulta']) {
    const calls = [], auth = { getSession: async () => ({ data: { session: { access_token: 'synthetic-mirror-session', user: { id: mirrorActor } } }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({ error: null }) };
    const controller = createAccessController(auth, 'https://api.synthetic.test', async (url, options) => {
      if (url.endsWith('/me')) return Response.json({ user_id: mirrorActor, role, resources: [], data_mode: 'staging_readonly' });
      calls.push({ url, ...options }); return Response.json(mirrorPage());
    });
    const stop = controller.start();
    try {
      for (let attempt = 0; attempt < 30 && controller.getSnapshot().phase !== 'ready'; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
      const result = await controller.stock('/v1/estoque/espelho?limit=50', { method: 'GET' });
      assert.equal(result.data_mode, 'origin_mirror'); assert.equal(calls.length, 1); assert.equal(calls[0].method, 'GET');
      assert.equal(calls[0].url, 'https://api.synthetic.test/v1/estoque/espelho?limit=50'); assert.equal(calls[0].body, undefined);
    } finally { stop(); }
  }
});
