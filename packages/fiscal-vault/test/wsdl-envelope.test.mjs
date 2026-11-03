import test from 'node:test';
import assert from 'node:assert/strict';
import {createSecureContext, SecureContext} from 'node:tls';
import {randomBytes} from 'node:crypto';
import {withWsdlCredential, sealCredential, envelopeHash, envelopeBytes} from '../src/envelope.mjs';
import * as publicVault from '../src/index.mjs';
import {createOpenSslLoader} from '../src/openssl-loader.mjs';
import {createWsdlTlsLoader} from '../src/wsdl-tls-loader.mjs';
import {binary, exportPfx, HOLDER, OTHER, NOW, PASSWORD, KEK, CONTEXT} from './fixtures.mjs';
import {trustFixture} from './trust-fixtures.mjs';

const fixture = await trustFixture();
const pfx = await exportPfx(fixture.leaf, [fixture.intermediate, fixture.root]);
const offline = await createOpenSslLoader({binaryPath:binary});
const tlsLoader = await createWsdlTlsLoader({binaryPath:binary});
const sealed = await sealCredential({pfxBytes:pfx, passwordBytes:PASSWORD, context:CONTEXT,
  kekBytes:KEK, keyId:'synthetic-key-v1', loader:offline, now:NOW});
const input = (extra = {}) => ({envelope:sealed, expectedEnvelopeHash:envelopeHash(sealed), expectedContext:CONTEXT,
  kekBytes:KEK, expectedKeyId:'synthetic-key-v1', loader:tlsLoader, purpose:'sefaz-sp-wsdl-readonly-v1', now:NOW, ...extra});
const clone = value => structuredClone(value);
const gate = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise,resolve};};
const syntheticScope = value => ({secureContext:createSecureContext(), signal:value.signal, deadline:value.deadline, metadata:{
  fingerprint_sha256:sealed.metadata.fingerprint_sha256, holder_cnpj:HOLDER,
  not_before:sealed.metadata.not_before, not_after:sealed.metadata.not_after, client_auth_usage:'explicit_client_auth',
  presented_chain_links_checked:true, icp_brasil_chain_validated:false, revocation_checked:false,
  a1_policy_verified:false, can_emit:false, can_transmit:false,
}});
const wiped = value => assert.equal(value.every(byte => byte === 0), true);

test('041 offline envelope opens only for explicit WSDL purpose, with real scoped TLS context and no public export', async () => {
  assert.equal(publicVault.withWsdlCredential, undefined);
  const original = envelopeBytes(sealed), originalKey = Buffer.from(KEK); let called = 0, scopedSignal;
  const result = await withWsdlCredential(input(), async value => {
    called++; scopedSignal=value.signal;
    assert.ok(value.secureContext instanceof SecureContext);
    assert.deepEqual(Object.keys(value).sort(), ['deadline','metadata','secureContext','signal']);
    assert.equal(value.metadata.holder_cnpj,HOLDER);
    assert.equal(value.metadata.fingerprint_sha256,sealed.metadata.fingerprint_sha256);
    assert.equal(value.metadata.can_transmit,false); assert.equal(value.metadata.icp_brasil_chain_validated,false);
    await Promise.resolve(); assert.equal(value.signal.aborted,false);
  });
  assert.equal(result,undefined); assert.equal(called,1); assert.equal(scopedSignal.aborted,true);
  assert.deepEqual(envelopeBytes(sealed),original); assert.equal(sealed.context.purpose,'offline-homologation');
  assert.notEqual(pfx[0],0); assert.notEqual(PASSWORD[0],0); assert.deepEqual(KEK,originalKey);
});

test('wrong expected hash, historical context, key id or KEK cannot reach a TLS callback', async () => {
  let calls=0;const action=()=>{calls++;};
  for(const extra of [
    {expectedEnvelopeHash:'0'.repeat(64)}, {expectedEnvelopeHash:undefined},
    {expectedContext:{...CONTEXT,company_identity_version:CONTEXT.company_identity_version+1}},
    {expectedContext:{...CONTEXT,holder_cnpj:OTHER}}, {expectedKeyId:'different-key'}, {kekBytes:randomBytes(32)},
    {purpose:'offline-homologation'}, {purpose:undefined}, {purpose:'sefaz-soap-transmit'},
  ]) await assert.rejects(withWsdlCredential(input(extra),action), /VAULT_/);
  assert.equal(calls,0);
});

test('AEAD authenticates every ciphertext component and metadata even if the caller supplies its changed hash', async () => {
  let loads=0;const loader={withContext(){loads++;}};
  for(const part of ['wrapped_key','payload'])for(const field of ['iv','ciphertext','tag']){
    const changed=clone(sealed),bytes=Buffer.from(changed[part][field],'base64');bytes[0]^=1;changed[part][field]=bytes.toString('base64');
    await assert.rejects(withWsdlCredential(input({envelope:changed,expectedEnvelopeHash:envelopeHash(changed),loader}),()=>{}), /VAULT_/);
  }
  const changed=clone(sealed);changed.metadata.legacy_provider_enabled=!changed.metadata.legacy_provider_enabled;
  await assert.rejects(withWsdlCredential(input({envelope:changed,expectedEnvelopeHash:envelopeHash(changed),loader}),()=>{}), /VAULT_/);
  const moved=clone(sealed);moved.context.credential_version++;
  await assert.rejects(withWsdlCredential(input({envelope:moved,expectedContext:moved.context,expectedEnvelopeHash:envelopeHash(moved),loader}),()=>{}), /VAULT_/);
  assert.equal(loads,0);
});

test('actual TLS loader rechecks sealed fingerprint, CNPJ and current certificate validity', async () => {
  let calls=0;
  for(const altered of [
    {...sealed.metadata,fingerprint_sha256:'0'.repeat(64),presented_chain:['0'.repeat(64),...sealed.metadata.presented_chain.slice(1)]},
    {...sealed.metadata,holder_cnpj:OTHER},
  ]){
    const ctx={...CONTEXT,holder_cnpj:altered.holder_cnpj};
    const e=await sealCredential({pfxBytes:pfx,passwordBytes:PASSWORD,context:ctx,kekBytes:KEK,keyId:'synthetic-key-v1',now:NOW,
      loader:{async load(){return{metadata:altered};}}});
    await assert.rejects(withWsdlCredential(input({envelope:e,expectedEnvelopeHash:envelopeHash(e),expectedContext:ctx}),()=>{calls++;}), /VAULT_/);
  }
  await assert.rejects(withWsdlCredential(input({now:new Date('2028-01-01T00:00:00Z')}),()=>{calls++;}), /VAULT_/);
  assert.equal(calls,0);
});

test('envelope, expected context, KEK, Date and loader method are captured before awaiting', async () => {
  const entered=gate(),release=gate();let observed,called=0;
  const loader={async withContext(value,action){observed=value;entered.resolve();await release.promise;await tlsLoader.withContext(value,action);}};
  const envelope=clone(sealed),expectedContext=clone(CONTEXT),kek=Buffer.from(KEK),at=new Date(NOW);
  const options=input({envelope,expectedContext,kekBytes:kek,now:at,loader});
  const pending=withWsdlCredential(options,()=>{called++;});
  // The method itself was captured before even the deferred loader invocation.
  loader.withContext=()=>{throw new Error('CALLER-MUTATION');};
  kek.fill(0);expectedContext.holder_cnpj=OTHER;envelope.payload.tag='bad';at.setUTCFullYear(2028);
  options.expectedEnvelopeHash='0'.repeat(64);options.expectedKeyId='changed';options.purpose='changed';
  try {
    await entered.promise;assert.deepEqual(observed.pfxBytes,pfx);assert.deepEqual(observed.passwordBytes,Buffer.from(PASSWORD));
    assert.equal(observed.purpose,'sefaz-sp-wsdl-readonly-v1');assert.equal(observed.expectedHolderCnpj,HOLDER);
  } finally {release.resolve();await pending;}
  assert.equal(called,1);wiped(observed.pfxBytes);wiped(observed.passwordBytes);
});

test('input accessors, symbols and malformed nested data are refused without invoking getters', async () => {
  let getters=0;
  const options=input();Object.defineProperty(options,'kekBytes',{enumerable:true,get(){getters++;return KEK;}});
  await assert.rejects(withWsdlCredential(options,()=>{}), /VAULT_WSDL_INPUT_INVALID/);
  const envelope=clone(sealed);Object.defineProperty(envelope.metadata,'fingerprint_sha256',{enumerable:true,get(){getters++;return sealed.metadata.fingerprint_sha256;}});
  await assert.rejects(withWsdlCredential(input({envelope}),()=>{}), /VAULT_WSDL_INPUT_INVALID/);
  await assert.rejects(withWsdlCredential(input({[Symbol('unexpected')]:true}),()=>{}), /VAULT_WSDL_INPUT_INVALID/);
  await assert.rejects(withWsdlCredential(input({expectedContext:{...CONTEXT,credential_id:[CONTEXT.credential_id]}}),()=>{}), /VAULT_ID_INVALID/);
  assert.equal(getters,0);
});

test('callback is awaited, returns no result and all credential views are wiped on success or failure', async () => {
  const entered=gate(),release=gate();let observed,settled=false;
  const loader={async withContext(value,action){observed=value;await action(syntheticScope(value));}};
  const pending=withWsdlCredential(input({loader}),async()=>{entered.resolve();await release.promise;}).finally(()=>{settled=true;});
  await entered.promise;await Promise.resolve();assert.equal(settled,false);release.resolve();assert.equal(await pending,undefined);
  wiped(observed.pfxBytes);wiped(observed.passwordBytes);assert.equal(observed.signal.aborted,true);
  await assert.rejects(withWsdlCredential(input({loader}),()=>({secret:'MUST-NOT-ESCAPE'})), /VAULT_WSDL_ACTION_MUST_RETURN_VOID/);
  wiped(observed.pfxBytes);wiped(observed.passwordBytes);
  await assert.rejects(withWsdlCredential(input({loader}),()=>{throw new Error('PASSWORD-MUST-NOT-ESCAPE');}), error=>error.code==='VAULT_WSDL_OPEN_OR_ACTION_FAILED'&&!JSON.stringify(error).includes('PASSWORD'));
  wiped(observed.pfxBytes);wiped(observed.passwordBytes);
});

test('loader cannot skip, duplicate, disguise metadata, return data or complete before its callback', async () => {
  let called=0;
  await assert.rejects(withWsdlCredential(input({loader:{async withContext(){}}}),()=>{called++;}), /VAULT_WSDL_CALLBACK_INVALID/);
  await assert.rejects(withWsdlCredential(input({loader:{async withContext(value,action){await action(syntheticScope(value));try{await action(syntheticScope(value));}catch{}}}}),()=>{called++;}), /VAULT_WSDL_CALLBACK_INVALID/);
  assert.equal(called,1);
  await assert.rejects(withWsdlCredential(input({loader:{async withContext(value,action){const scope=syntheticScope(value);scope.metadata.holder_cnpj=OTHER;await action(scope);}}}),()=>{called++;}), /VAULT_CERTIFICATE_MISMATCH/);
  await assert.rejects(withWsdlCredential(input({loader:{async withContext(value,action){await action(syntheticScope(value));return 'SECRET';}}}),()=>{called++;}), /VAULT_WSDL_CALLBACK_INVALID/);
  const release=gate();let callback;
  await assert.rejects(withWsdlCredential(input({loader:{withContext(value,action){callback=action(syntheticScope(value));}}}),async()=>{await release.promise;}), /VAULT_WSDL_CALLBACK_INVALID/);
  release.resolve();await assert.rejects(callback,/VAULT_WSDL_/);
});

test('aborted and timed-out loads cannot call a late action; retained plaintext views are immediately wiped', async () => {
  for(const mode of ['abort','deadline']){
    const entered=gate(),controller=new AbortController();let observed,callback,calls=0;
    const loader={withContext(value,action){observed=value;callback=action;entered.resolve();return new Promise(()=>{});}};
    const pending=withWsdlCredential(input({loader,signal:controller.signal,deadline:Date.now()+(mode==='deadline'?80:5000)}),()=>{calls++;});
    await entered.promise;if(mode==='abort')controller.abort();
    await assert.rejects(pending, mode==='abort'?/VAULT_WSDL_ABORTED/:/VAULT_WSDL_TIMEOUT/);
    wiped(observed.pfxBytes);wiped(observed.passwordBytes);
    await assert.rejects(callback(syntheticScope(observed)), /VAULT_WSDL_/);assert.equal(calls,0);
  }
  let loads=0;const controller=new AbortController();controller.abort();
  await assert.rejects(withWsdlCredential(input({signal:controller.signal,loader:{withContext(){loads++;}}}),()=>{}), /VAULT_WSDL_ABORTED/);
  assert.equal(loads,0);
});

test('aborting an active callback closes its scoped signal and prevents a late success from becoming a result', async () => {
  const entered=gate(),release=gate(),controller=new AbortController();let observed,scope;
  const loader={async withContext(value,action){observed=value;await action(syntheticScope(value));}};
  const pending=withWsdlCredential(input({loader,signal:controller.signal}),async value=>{scope=value;entered.resolve();await release.promise;});
  await entered.promise;controller.abort();await assert.rejects(pending,/VAULT_WSDL_ABORTED/);
  assert.equal(scope.signal.aborted,true);wiped(observed.pfxBytes);wiped(observed.passwordBytes);
  release.resolve();await new Promise(resolve=>setImmediate(resolve));
});
