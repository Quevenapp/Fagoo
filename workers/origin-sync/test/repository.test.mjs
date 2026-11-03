import test from 'node:test';
import assert from 'node:assert/strict';
import { Repository } from '../src/repository.mjs';

test('history continuation grants only its four exact RPC names to the internal repository client', async () => {
  const called=[];
  const repo=new Repository({SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic'}, {
    fetchImpl:async(url,options)=>{called.push(new URL(url).pathname);assert.equal(options.method,'POST');return Response.json({});},
  });
  for(const action of ['get','prepare','apply','inventory']) await repo.rpc(`erp_origin_sales_history_continuation_${action}`);
  assert.equal(called.length,4);
  for(const name of ['erp_origin_sales_history_capture','erp_origin_sales_history_continuation_apply_extra',
    'erp_origin_sales_history_continuation_','erp_create_payment','erp_origin_sales_history_continuation_get/../capture']) {
    await assert.rejects(repo.rpc(name),/INVALID_RPC/);
  }
  assert.equal(called.length,4);
});

test('database redirects are rejected without reading a body, following Location or retrying', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let attempts = 0;
    const repo = new Repository({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'private' }, {
      fetchImpl: async (url, options) => {
        attempts++;
        assert.equal(url, 'https://example.supabase.co/rest/v1/rpc/origin_sync_status');
        assert.equal(options.redirect, 'manual');
        const response = new Response('private', { status, headers: { location: 'https://evil.test/steal' } });
        response.json = () => { assert.fail('redirect body must not be read'); };
        return response;
      },
      sleep: async () => { assert.fail('redirect must not be retried'); },
    });
    await assert.rejects(repo.rpc('origin_sync_status'), /^Error: DATABASE_REDIRECT_BLOCKED$/);
    assert.equal(attempts, 1);
  }
});
