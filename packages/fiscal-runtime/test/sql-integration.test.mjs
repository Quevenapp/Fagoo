import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createRepository } from '../src/repository.mjs';
import { createRuntimeHandler } from '../src/handler.mjs';
import { encodeConfigure, CONFIGURE_TYPE } from '../src/protocol.mjs';
import { signRuntimeRequest, digest } from '../src/auth.mjs';
import { createOpenSslLoader, parseEnvelope } from '../../fiscal-vault/src/index.mjs';
import { binary, chainFixture, exportPfx, PASSWORD, HOLDER } from '../../fiscal-vault/test/fixtures.mjs';

test('real SQL041 + bounded repository + Node crypto: configure, lost commit, rewrap and disable stay separate from historical receipts', async () => {
  const db = new PGlite(), actor = randomUUID(), bytesStore = new Map(), key1 = randomBytes(32), key2 = randomBytes(32), transport = randomBytes(32), fingerprint = randomBytes(32);
  const chain = await chainFixture(), pfx = await exportPfx(chain.leaf, chain.chain), loader = await createOpenSslLoader({ binaryPath: binary });
  let loseFinalize = true, storagePosts = 0; const steps = [];
  const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].value;
  try {
    await db.exec("create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,unique(bucket_id,name));alter table storage.objects enable row level security;");
    for (const name of ['0001_origin_sync', '0002_origin_quotes_nfce', '0004_erp_access', '0016_company', '0041_a1_custody'])
      await db.exec(await readFile(new URL(`../../../supabase/migrations/20261016${name}.sql`, import.meta.url), 'utf8'));
    await db.query('insert into auth.users values($1)', [actor]);
    await db.query("insert into erp_access.membership(user_id,role,active)values($1,'admin',true)", [actor]);
    await db.exec("insert into storage.buckets values('brufap-a1-vault','brufap-a1-vault',false,1500000,array['application/json']);");
    const identity = { legal_name: 'Empresa Sintética de Teste', trade_name: null, cnpj: HOLDER, ie: null, postal_code: '13400000', street: 'Rua Sintética', number: '1', complement: null, district: 'Centro', city: 'Piracicaba', municipality_code: '3538709', state: 'SP', phone: null, email: null };
    await scalar('select public.erp_company_save_identity($1::uuid,0,$2::uuid,$3::jsonb)value', [actor, randomUUID(), JSON.stringify(identity)]);
    const fetchImpl = async (url, options) => {
      assert.equal(options.redirect, 'error'); assert.equal(options.headers.apikey, 'synthetic-service-key-never-real');
      const path = new URL(url).pathname;
      if (path.startsWith('/rest/v1/rpc/erp_a1_')) {
        const name = path.slice('/rest/v1/rpc/'.length), args = JSON.parse(options.body), keys = Object.keys(args);
        assert.ok(keys.every(k => /^p_[a-z_]+$/.test(k)));
        await db.exec('set role service_role'); let value;
        try {
          value = await scalar(`select public.${name}(${keys.map((key, i) => `${key} => $${i + 1}`).join(',')})value`, keys.map(key => typeof args[key] === 'object' && args[key] !== null ? JSON.stringify(args[key]) : args[key]));
        } catch (e) { return Response.json({ code: e.code, message: 'synthetic upstream diagnostics must not cross boundary' }, { status: 400 }); }
        finally { await db.exec('reset role'); }
        steps.push({ name, state: value.state, lease_until: value.lease_until, contextKeys: value.context ? Object.keys(value.context) : null, metadataNull: value.metadata === null, sourceNull: value.source_object === null });
        if (name === 'erp_a1_finalize' && loseFinalize) { loseFinalize = false; throw new TypeError('synthetic committed response loss'); }
        return Response.json(value);
      }
      const prefix = options.method === 'POST' ? '/storage/v1/object/brufap-a1-vault/' : '/storage/v1/object/authenticated/brufap-a1-vault/';
      assert.ok(path.startsWith(prefix)); const key = path.slice(prefix.length);
      if (options.method === 'POST') {
        assert.equal(options.headers['x-upsert'], 'false'); storagePosts++;
        if (bytesStore.has(key)) return Response.json({ code: 'duplicate' }, { status: 400 });
        bytesStore.set(key, Buffer.from(options.body));
        await db.query('insert into storage.objects(bucket_id,name,metadata)values($1,$2,$3::jsonb)', ['brufap-a1-vault', key, JSON.stringify({ size: options.body.length, mimetype: 'application/json' })]);
        return Response.json({ Key: key });
      }
      return bytesStore.has(key) ? new Response(bytesStore.get(key), { headers: { 'Content-Type': 'application/json' } }) : new Response(null, { status: 404 });
    };
    const repository = createRepository({ supabaseUrl: 'https://synthetic.supabase.co', serviceKey: 'synthetic-service-key-never-real', fetchImpl });
    const handler = currentKeyId => createRuntimeHandler({ repository, loader, transportSecret: transport, transportKeyId: 'transport', audience: 'test', fingerprintSecret: fingerprint, keyring: new Map([['key1', key1], ['key2', key2]]), currentKeyId });
    const send = async (handle, action, payload) => {
      const body = payload instanceof Uint8Array ? payload : payload ? Buffer.from(JSON.stringify(payload)) : new Uint8Array();
      const path = `/internal/v1/a1${action ? `/${action}` : ''}`, method = body.length ? 'POST' : 'GET';
      const authorization = await signRuntimeRequest({ secretBytes: transport, keyId: 'transport', audience: 'test', actor, nonce: randomUUID(), method, path, bodyHash: await digest(body) });
      const result = await handle(new Request(`https://test${path}`, { method, headers: { Authorization: authorization, 'Content-Type': action === 'configure' ? CONFIGURE_TYPE : 'application/json' }, ...(body.length ? { body } : {}) }));
      return { status: result.status, value: await result.json() };
    };
    const first = handler('key1'), second = handler('key2'), id = randomUUID();
    const body = encodeConfigure({ command_id: id, expected_version: 0, expected_identity_version: 1, reason: 'Configuração sintética', pfxBytes: pfx, passwordBytes: PASSWORD });
    const lost = await send(first, 'configure', body); assert.equal(lost.status, 503, JSON.stringify({ ...lost.value, steps }));
    const recovered = await send(first, 'configure', body); assert.equal(recovered.status, 200, JSON.stringify(recovered.value)); assert.equal(recovered.value.replayed, true); assert.equal(recovered.value.current.version, 1); assert.equal(storagePosts, 1);
    const before = parseEnvelope([...bytesStore.values()][0]);
    const rotated = await send(second, 'rewrap', { command_id: randomUUID(), expected_version: 1, expected_identity_version: 1, reason: 'Rotação sintética da KEK' });
    assert.equal(rotated.status, 200, JSON.stringify(rotated.value)); assert.equal(rotated.value.current.version, 2); assert.equal(storagePosts, 2);
    const after = parseEnvelope([...bytesStore.values()][1]); assert.deepEqual(after.payload, before.payload); assert.deepEqual(after.context, before.context); assert.equal(after.key_id, 'key2');
    const disabled = await send(second, 'disable', { command_id: randomUUID(), expected_version: 2, reason: 'Desativação sintética' }); assert.equal(disabled.status, 200, JSON.stringify(disabled.value));
    const historical = await send(second, 'configure', body); assert.equal(historical.value.receipt.version, 1); assert.equal(historical.value.current.state, 'disabled'); assert.equal(historical.value.current.version, 3);
    assert.equal(await scalar('select count(*)::int value from erp_a1.credential'), 1); assert.equal(await scalar('select count(*)::int value from erp_a1.sealed_object'), 2);
    const commands = JSON.stringify((await db.query('select request_hash,result from erp_a1.command')).rows);
    assert.equal(commands.includes(Buffer.from(PASSWORD).toString()), false); assert.equal(commands.includes('PRIVATE KEY'), false);
    await db.query('update erp_access.membership set active=false where user_id=$1', [actor]);
    assert.equal((await send(second, '', null)).status, 403);
  } finally { await db.close(); }
});
