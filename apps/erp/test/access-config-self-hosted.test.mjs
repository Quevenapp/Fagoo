import test from 'node:test';
import assert from 'node:assert/strict';
import { accessConfig } from '../src/lib/access-config.ts';
import { parseExportLink } from '../src/lib/platform-model.ts';

const anon = payload => `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.synthetic`;
const hosted = { VITE_SUPABASE_URL: 'https://project.supabase.co', VITE_SUPABASE_ANON_KEY: anon({role:'anon',ref:'project'}), VITE_ERP_API_URL:'https://api.example.test' };
const local = { ...hosted, VITE_SUPABASE_DEPLOYMENT:'self-hosted', VITE_SUPABASE_URL:'https://auth.example.test', VITE_SUPABASE_ANON_KEY:anon({role:'anon',iss:'supabase'}) };

test('self-hosted is explicit and accepts a public anon key without a hosted project ref', () => {
  assert.equal(accessConfig(hosted).supabaseUrl, hosted.VITE_SUPABASE_URL);
  assert.equal(accessConfig(local).supabaseUrl, local.VITE_SUPABASE_URL);
  assert.equal(accessConfig({...local,VITE_SUPABASE_ANON_KEY:'sb_publishable_abcdefghijklmnop'}).publicKey,'sb_publishable_abcdefghijklmnop');
  assert.throws(()=>accessConfig({...local,VITE_SUPABASE_DEPLOYMENT:undefined}));
  assert.throws(()=>accessConfig({...local,VITE_SUPABASE_DEPLOYMENT:'unknown'}));
  assert.throws(()=>accessConfig({...hosted,VITE_SUPABASE_ANON_KEY:anon({role:'anon'})}));
  assert.throws(()=>accessConfig({...hosted,VITE_SUPABASE_ANON_KEY:anon({role:'anon',ref:'other'})}));
});

test('self-hosted Auth requires an exact HTTPS origin and never accepts privileged public-build keys', () => {
  for (const origin of ['http://auth.example.test','http://localhost:8000','https://localhost','https://127.0.0.1','https://[::1]','https://auth.example.test:8443','https://user:pass@auth.example.test','https://auth.example.test/auth/v1','https://auth.example.test/','https://auth.example.test?token=x','https://auth.example.test#fragment','//auth.example.test','javascript:alert(1)']) {
    assert.throws(()=>accessConfig({...local,VITE_SUPABASE_URL:origin}),origin);
  }
  for (const key of [anon({role:'service_role'}),anon({role:'authenticated'}),'sb_secret_abcdefghijklmnop','arbitrary']) {
    assert.throws(()=>accessConfig({...local,VITE_SUPABASE_ANON_KEY:key}));
  }
  assert.throws(()=>accessConfig({VITE_SUPABASE_DEPLOYMENT:'self-hosted'}));
  assert.equal(accessConfig({}),null);
  assert.equal(accessConfig({...local,VITE_ERP_API_URL:'http://localhost:3000'}).apiUrl,'http://localhost:3000');
});

const link = origin => ({scope:'platform_export_link',expires_in:120,url:`${origin}/storage/v1/object/sign/brufap-exports/exports/synthetic.zip?token=synthetic`,filename:'brufap-exportacao-2026-10-21-1300.zip'});
test('private export download trusts the configured storage origin while preserving the existing bucket contract', () => {
  const origin='https://auth.example.test';
  assert.equal(parseExportLink(link(origin),origin).url,link(origin).url);
  assert.equal(parseExportLink(link('https://project.supabase.co')).filename,link(origin).filename);
  assert.throws(()=>parseExportLink(link(origin)));
  for(const foreign of ['https://other.example.test','https://auth.example.test.evil.test','https://other.supabase.co','http://auth.example.test','https://user:pass@auth.example.test']) {
    assert.throws(()=>parseExportLink(link(foreign),origin),foreign);
  }
  for(const url of [`${origin}/storage/v1/object/sign/another-bucket/x?token=x`,`${origin}/storage/v1/object/sign/brufap-exports/../another-bucket/x`,`${origin}/storage/v1/object/sign/brufap-exports/x#fragment`]) {
    assert.throws(()=>parseExportLink({...link(origin),url},origin));
  }
  assert.throws(()=>parseExportLink(link(origin),`${origin}/path`));
  assert.throws(()=>parseExportLink({...link(origin),expires_in:3600},origin));
});
