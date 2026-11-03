import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/index.mjs';

test('history route authenticates before private Storage, verifies bytes and returns a sandboxed attachment', async () => {
  const bytes = new TextEncoder().encode('<nfe>synthetic-only</nfe>');
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  const backup = 'a'.repeat(64); const calls = [];
  const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-server-key' };
  const handler = createHandler({ fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    if (url.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: 'a0000000-0000-4000-8000-000000000001' }));
    if (url.includes('/rest/v1/rpc/')) return new Response(JSON.stringify({ bucket: 'origin-backups', sha256: hash, object_key: `objects/${hash}.xml`, size: bytes.length, model: '55' }));
    return new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } });
  } });
  const url = `https://api.example.test/v1/history/xml/${hash}/download?backup=${backup}`;
  assert.equal((await handler(new Request(url), env)).status, 401); assert.equal(calls.length, 0);
  const result = await handler(new Request(url, { headers: { Authorization: 'Bearer synthetic-user-token' } }), env);
  assert.equal(result.status, 200); assert.equal(result.headers.get('Content-Type'), 'application/octet-stream');
  assert.match(result.headers.get('Content-Disposition'), /^attachment; filename="origin-55-/);
  assert.match(result.headers.get('Content-Security-Policy'), /sandbox/); assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes);
  assert.equal(calls[2].url, `${env.SUPABASE_URL}/storage/v1/object/authenticated/origin-backups/objects/${hash}.xml`);
  assert.equal(calls[2].redirect, 'manual'); assert.equal(calls[2].headers.Authorization, `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
  assert.deepEqual(JSON.parse(calls[1].body), { p_user_id: 'a0000000-0000-4000-8000-000000000001', p_backup_sha: backup, p_xml_sha: hash });
  assert.equal(calls.length, 4);
  assert.equal(calls[3].url, calls[1].url);
  assert.deepEqual(JSON.parse(calls[3].body), JSON.parse(calls[1].body));
});

test('backup XML delivery rechecks access after Storage and refuses revoked membership', async () => {
  const bytes = new TextEncoder().encode('<NFe>synthetic-revocation-check</NFe>');
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  const metadata = { bucket:'origin-backups',sha256:hash,object_key:`objects/${hash}.xml`,size:bytes.length,model:'55' };
  let active = true, rpcReads = 0;
  const handler = createHandler({ fetchImpl: async url => {
    if (url.endsWith('/auth/v1/user')) return Response.json({ id:'a0000000-0000-4000-8000-000000000001' });
    if (url.includes('/rest/v1/rpc/')) {
      rpcReads++;
      return active ? Response.json(metadata) : Response.json({ code:'42501' }, { status:403 });
    }
    active = false; return new Response(bytes);
  } });
  const result = await handler(new Request(`https://synthetic.invalid/v1/history/xml/${hash}/download?backup=${'a'.repeat(64)}`,
    { headers:{ Authorization:'Bearer synthetic-user-token' } }),
    { SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-server-key' });
  assert.equal(rpcReads, 2); assert.equal(result.status, 403);
  assert.equal(result.headers.get('Content-Disposition'), null);
  assert.doesNotMatch(await result.text(), /synthetic-revocation-check|object_key/);
});

test('backup XML delivery rejects changed canonical metadata after the verified download', async () => {
  const bytes = new TextEncoder().encode('<NFe>synthetic-metadata-check</NFe>');
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  const metadata = { bucket:'origin-backups',sha256:hash,object_key:`objects/${hash}.xml`,size:bytes.length,model:'55' };
  for (const patch of [{model:'65'}, {model:null}, {size:bytes.length+1}, {bucket:'other-bucket'},
    {object_key:`objects/${'b'.repeat(64)}.xml`}, {sha256:'b'.repeat(64)}]) {
    let rpcReads = 0, storageReads = 0;
    const handler = createHandler({ fetchImpl: async url => {
      if (url.endsWith('/auth/v1/user')) return Response.json({ id:'a0000000-0000-4000-8000-000000000001' });
      if (url.includes('/rest/v1/rpc/')) return Response.json(++rpcReads === 1 ? metadata : {...metadata,...patch});
      storageReads++; return new Response(bytes);
    } });
    const result = await handler(new Request(`https://synthetic.invalid/v1/history/xml/${hash}/download?backup=${'a'.repeat(64)}`,
      { headers:{ Authorization:'Bearer synthetic-user-token' } }),
      { SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-server-key' });
    assert.equal(storageReads, 1); assert.equal(rpcReads, 2); assert.equal(result.status, 502);
    assert.equal(result.headers.get('Content-Disposition'), null);
    assert.doesNotMatch(await result.text(), /synthetic-metadata-check|object_key/);
  }
});
