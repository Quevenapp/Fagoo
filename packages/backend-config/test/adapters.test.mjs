import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepository } from '../../fiscal-runtime/src/repository.mjs';

const ports = [
  ['fiscal-artifact-storage/src/storage.mjs', 'createFiscalArtifactStorage'],
  ['fiscal-dfe-storage/src/storage.mjs', 'createDfeStorage'],
  ['fiscal-unsigned-rpc/src/rpc.mjs', 'createFiscalUnsignedRpc'],
  ['fiscal-signed-rpc/src/rpc.mjs', 'createFiscalSignedRpc'],
  ['fiscal-sefaz-wsdl/src/service-rpc.mjs', 'createWsdlRpc'],
  ['fiscal-reconciliation/src/rpc.mjs', 'createReconciliationRpc'],
  ['fiscal-reconciliation/src/storage.mjs', 'createReconciliationStorage'],
  ['fiscal-authorization/src/rpc.mjs', 'createAuthorizationRpc'],
  ['fiscal-authorization/src/reviewed-ledger-rpc.mjs', 'createReviewedAuthorizationRpc'],
  ['fiscal-authorization/src/preflight-rpc.mjs', 'createAuthorizationPreflightRpc'],
  ['fiscal-authorization/src/closure-rpc.mjs', 'createAuthorizationClosureRpc'],
  ['fiscal-authorization/src/closure-lookup-rpc.mjs', 'createAuthorizationClosureLookupRpc'],
  ['fiscal-authorization/src/revalidation-rpc.mjs', 'createAuthorizationRevalidationRpc'],
  ['fiscal-authorization/src/receipt-query-rpc.mjs', 'createReceiptQueryRpc'],
  ['fiscal-authorization/src/subset-review-rpc.mjs', 'createSubsetReviewRpc'],
  ['fiscal-authorization/src/storage.mjs', 'createAuthorizationStorage'],
  ['fiscal-authorization/src/revalidation-storage.mjs', 'createAuthorizationRevalidationStorage'],
  ['fiscal-authorization/src/receipt-query-storage.mjs', 'createReceiptQueryStorage'],
  ['fiscal-authorization-runtime/src/dispatch-access.mjs', 'createDispatchAccessReader'],
  ['fiscal-runtime/src/authorization-vault-read.mjs', 'createAuthorizationVaultReader'],
];
for (const [path, name] of ports) {
  test(`${name}: opt-in is required before a credential can reach a customer backend`, async () => {
    const factory = (await import(`../../${path}`))[name];
    let calls = 0;
    const config = { projectUrl: 'https://backend.example.com', serviceKey: 'synthetic-private-credential', fetchImpl: () => { calls++; throw Error('unexpected'); } };
    assert.throws(() => factory(config));
    assert.doesNotThrow(() => factory({ ...config, supabaseDeployment: 'self-hosted' }));
    for (const patch of [{ supabaseDeployment: 'yes' }, { projectUrl: 'http://backend.example.com', supabaseDeployment: 'self-hosted' },
      { projectUrl: 'https://backend.example.com/redirect', supabaseDeployment: 'self-hosted' }]) assert.throws(() => factory({ ...config, ...patch }));
    assert.equal(calls, 0);
  });
}

test('self-hosted custody RPC uses the configured origin and keeps redirect rejection', async () => {
  const calls = [];
  const repo = createRepository({ supabaseUrl: 'https://backend.example.com', supabaseDeployment: 'self-hosted', serviceKey: 'synthetic-private-credential',
    fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }); } });
  assert.deepEqual(await repo.rpc('metadata', { p_user_id: 'synthetic-actor' }), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://backend.example.com/rest/v1/rpc/erp_a1_metadata');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-private-credential');
  await assert.rejects(repo.rpc('arbitrary', {}));
  assert.equal(calls.length, 1);
});
