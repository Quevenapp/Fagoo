// Real local signature/PKCS12/TLS context branding; invented grants and an in-memory
// HTTPS driver only. This never opens a socket, SQL database or real certificate.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {signedFixture,hash,HOLDER,NOW} from './service-fixtures.mjs';
import {prepareAuthorization,authorizationRequestBytes} from '../src/index.mjs';
import {prepareReviewedAuthorizationSoap,encodeReviewedAuthorizationSoap} from '../src/authorization-soap-binding.mjs';
import {authorizationRequestEmission,authorizationSoapEmission} from '../src/request-emission.mjs';
import {createAuthorizationDispatchTransport} from '../src/dispatch-transport.mjs';
import {RULE_PROFILES} from '../src/rule-profile-registry.mjs';
import {createSpAuthorizationTlsLoader} from '../../fiscal-runtime/src/authorization-server-trust.mjs';
import {exportPfx,binary,PASSWORD} from '../../fiscal-vault/test/fixtures.mjs';
import {wire} from '../../fiscal-reconciliation/test/protocol-wire.mjs';
let f,session,requests,identities;
before(async()=>{
 f=await signedFixture();requests={};identities={};
 for(const model of ['55','65']){
  const value=f.create(model),request=prepareAuthorization({signedBytes:value.signedBytes,expectedSignedHash:value.signed.xmlDigest,expectedModel:model,expectedIssuerCnpj:HOLDER,expectedHolderCnpj:HOLDER,expectedCertificate:f.credential.certificate,expectedCertificateFingerprint:hash(f.credential.certificateDer),now:NOW,batchId:'1'});
  requests[model]={request,soap:prepareReviewedAuthorizationSoap({request})};identities[model]=authorizationRequestEmission(request);value.signedBytes.fill(0);
 }
 const loader=await createSpAuthorizationTlsLoader({binaryPath:binary}),pfx=await exportPfx(f.credential);
 try{await loader.withContext({pfxBytes:pfx,passwordBytes:PASSWORD,expectedHolderCnpj:HOLDER,expectedFingerprint:hash(f.credential.certificateDer),now:new Date(),purpose:'sp-authorization-homologation-v1'},v=>{session={secureContext:v.secureContext,metadata:v.metadata};});}finally{pfx.fill(0);}
});
after(()=>{f?.close();f?.credential.privateDer.fill(0);});
function fixture(model='65'){
 const {request,soap}=requests[model],profile=RULE_PROFILES.at(-1),at=Date.now(),candidate=randomUUID(),actor=randomUUID(),controller=new AbortController(),deadline=at+5000;
 const grant={private_executor_only:true,attempt_id:randomUUID(),intent_id:randomUUID(),command_id:randomUUID(),actor,lease_id:randomUUID(),nonce:randomUUID(),expires_at:new Date(at+55000).toISOString(),issued_at:new Date(at).toISOString(),purpose:'sp-authorization-homologation-v1',environment:'2',model,origin:'operational',policy_version:1,binding_profile:soap.profile,rule_profile:profile.profile,policy_manifest_hash:profile.policyHashes[model],candidate_id:candidate,signed_hash:request.signedHash,signed_size:1024,batch_id:'1',access_key:request.accessKey,reference_digest:request.referenceDigest,issuer_cnpj:HOLDER,identity_version:1,a1_version:1,credential_id:randomUUID(),envelope_hash:hash('synthetic envelope'),certificate_fingerprint:hash(f.credential.certificateDer),request_hash:soap.envelopeHash,request_size:soap.envelopeSizeBytes};
 const rule_review={candidate_id:candidate,candidate_version:1,signed_hash:request.signedHash,facts_hash:hash('synthetic facts'),profile:profile.profile,profile_hash:profile.profileHash,review_id:randomUUID(),review_version:1,review_hash:hash('synthetic review'),reviewed_by:actor,reviewed_at:new Date(at-1000).toISOString(),valid_until:new Date(at+60000).toISOString(),coverage:'listed_rules_only_not_full_tax_validation',tax_rules_validated:false};
 return{value:{request:soap,grant,rule_review},session:{...session,signal:controller.signal,deadline},options:{signal:controller.signal,deadline},controller,issued:Date.parse(identities[model].issuedAt)};
}
test('request/SOAP extraction uses original attested bytes; clones/getters cannot supply an identity',()=>{
 for(const model of ['55','65']){
  const {request,soap}=requests[model],a=authorizationRequestBytes(request),b=encodeReviewedAuthorizationSoap(soap);a.fill(0);b.fill(0);
  assert.deepEqual(authorizationSoapEmission(soap),identities[model]);assert.ok(Object.isFrozen(identities[model]));
  assert.equal(identities[model].model,model);assert.equal(identities[model].environment,'2');assert.equal(identities[model].emissionType,'1');
  for(const [read,handle] of [[authorizationRequestEmission,request],[authorizationSoapEmission,soap]]){
   assert.throws(()=>read({...handle}),{code:'AUTHORIZATION_NFCE_EMISSION_INPUT_INVALID'});
   let calls=0;assert.throws(()=>read({get model(){calls++;throw Error('must not read');}}),{code:'AUTHORIZATION_NFCE_EMISSION_INPUT_INVALID'});assert.equal(calls,0);
  }
 }
});
test('65 expired/future at entry creates no request and burns the local nonce, without accepting a new caller date',async()=>{
 for(const [offset,code] of [[300000,'AUTHORIZATION_NFCE_EMISSION_EXPIRED'],[-300001,'AUTHORIZATION_NFCE_EMISSION_FUTURE']]){
  const v=fixture(),driver=wire();let clock=v.issued+offset;
  const send=createAuthorizationDispatchTransport({requestImpl:driver.requestImpl,now:()=>clock});
  await assert.rejects(send(v.value,v.session,v.options),{code});assert.equal(driver.trace.requests,0);assert.equal(driver.trace.ends,0);
  clock=v.issued;await assert.rejects(send(v.value,v.session,v.options),{code:'AUTHORIZATION_GRANT_MISMATCH'});assert.equal(driver.trace.requests,0);
 }
});
test('65 finalTLS check blocks the exact300s boundary after an initially valid clock, zero HTTP body',async()=>{
 const v=fixture(),driver=wire();let checks=0;
 const send=createAuthorizationDispatchTransport({requestImpl:driver.requestImpl,now:()=>v.issued+(++checks===1?299999:300000)});
 await assert.rejects(send(v.value,v.session,v.options),{code:'AUTHORIZATION_NFCE_EMISSION_EXPIRED'});
 assert.equal(checks,2);assert.equal(driver.trace.requests,1);assert.equal(driver.trace.ends,0);assert.equal(driver.trace.bytes,null);assert.ok(driver.trace.destroyed>=2);
 await assert.rejects(send(v.value,v.session,v.options),{code:'AUTHORIZATION_GRANT_MISMATCH'});assert.equal(driver.trace.requests,1);
});
test('clock moving backwards past future tolerance beforeTLS end also blocks body',async()=>{
 const v=fixture(),driver=wire();let checks=0;
 await assert.rejects(createAuthorizationDispatchTransport({requestImpl:driver.requestImpl,now:()=>v.issued+(++checks===1?0:-300001)})(v.value,v.session,v.options),{code:'AUTHORIZATION_NFCE_EMISSION_FUTURE'});
 assert.equal(driver.trace.requests,1);assert.equal(driver.trace.ends,0);
});
test('65 at299999ms and future300000ms writes exact bytes once; final guard has no operational margin',async()=>{
 for(const offset of [270000,299999,-300000]){
  const v=fixture(),driver=wire();let checks=0;const send=createAuthorizationDispatchTransport({requestImpl:driver.requestImpl,now:()=>{checks++;return v.issued+offset;}});
  const result=await send(v.value,v.session,v.options);assert.equal(result.tls.origin,'operational');assert.equal(driver.trace.ends,1);assert.equal(checks,2);assert.equal(hash(driver.trace.bytes),v.value.grant.request_hash);
  await assert.rejects(send(v.value,v.session,v.options),{code:'AUTHORIZATION_GRANT_MISMATCH'});assert.equal(driver.trace.ends,1);
 }
});
test('55 does not consult new clock or reject old signed timestamps',async()=>{
 const v=fixture('55'),driver=wire();const result=await createAuthorizationDispatchTransport({requestImpl:driver.requestImpl,now:()=>{throw Error('model55 must not date gate');}})(v.value,v.session,v.options);
 assert.equal(result.response.status,200);assert.equal(driver.trace.ends,1);assert.equal(hash(driver.trace.bytes),v.value.grant.request_hash);
});
test('65 temporal check does not weaken original request hash, grant or brand checks',async()=>{
 for(const edit of [v=>v.grant.request_hash='0'.repeat(64),v=>v.grant.model='55',v=>v.request={...v.request}]){
  const v=fixture(),driver=wire(),value={...v.value,grant:{...v.value.grant}};edit(value);
  await assert.rejects(createAuthorizationDispatchTransport({requestImpl:driver.requestImpl,now:()=>v.issued})(value,v.session,v.options));assert.equal(driver.trace.requests,0);
 }
});
test('abort beforeTLS closes local resources without body and without reusing a grant',async()=>{
 const v=fixture(),driver=wire({noTls:true}),send=createAuthorizationDispatchTransport({requestImpl:driver.requestImpl,now:()=>v.issued});
 const pending=send(v.value,v.session,v.options);setImmediate(()=>v.controller.abort());
 await assert.rejects(pending,{code:'AUTHORIZATION_SERVICE_ABORTED'});assert.equal(driver.trace.requests,1);assert.equal(driver.trace.ends,0);assert.ok(driver.trace.destroyed>=2);
});
