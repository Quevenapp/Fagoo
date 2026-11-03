import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash,X509Certificate} from 'node:crypto';
import {createSecureContext,SecureContext,rootCertificates} from 'node:tls';
import {createProtocolCustodyPort,ProtocolCustodyError} from '../src/protocol-custody.mjs';
import {createSpProtocolTlsLoader,requireProtocolServerContext} from '../src/protocol-server-trust.mjs';
import {createProtocolTlsLoader} from '../../fiscal-vault/src/protocol-tls-loader.mjs';
import {createWsdlTlsLoader} from '../../fiscal-vault/src/wsdl-tls-loader.mjs';
import {createOpenSslLoader,sealCredential,envelopeBytes} from '../../fiscal-vault/src/index.mjs';
import {withProtocolCredential,withWsdlCredential,envelopeHash} from '../../fiscal-vault/src/envelope.mjs';
import * as publicVault from '../../fiscal-vault/src/index.mjs';
import {prepareReviewedProtocolSoap,encodeReviewedProtocolSoap} from '../../fiscal-xml/src/protocol-binding.mjs';
import {buildAccessKey} from '../../fiscal-core/src/identity.mjs';
import {identity} from '../../fiscal-core/test/fixtures.mjs';
import {binary,exportPfx,PASSWORD,CONTEXT,KEK,NOW,HOLDER} from '../../fiscal-vault/test/fixtures.mjs';
import {trustFixture} from '../../fiscal-vault/test/trust-fixtures.mjs';

const certificates=await trustFixture(),pfx=await exportPfx(certificates.leaf,[certificates.intermediate,certificates.root]);
const offline=await createOpenSslLoader({binaryPath:binary}),tls=await createSpProtocolTlsLoader({binaryPath:binary},{now:()=>NOW});
const envelope=await sealCredential({pfxBytes:pfx,passwordBytes:PASSWORD,context:CONTEXT,kekBytes:KEK,keyId:'synthetic-key',loader:offline,now:NOW});
const sealed=envelopeBytes(envelope),hash=bytes=>createHash('sha256').update(bytes).digest('hex'),purpose='sefaz-sp-protocol-homologation-v1';
const clone=structuredClone,tick=()=>new Promise(r=>setImmediate(r)),wiped=b=>assert.ok(b.every(x=>x===0));
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const error=(promise,code)=>assert.rejects(promise,e=>e instanceof ProtocolCustodyError&&e.code===code&&!JSON.stringify(e).includes('PRIVATE-DETAIL'));
function fixture(overrides={},model='55'){
 const actor=randomUUID(),attempt=randomUUID(),accessKey=buildAccessKey({...identity,cnpj:HOLDER,model}),request=prepareReviewedProtocolSoap({accessKey,expectedModel:model,environment:'2',requestId:attempt}),bytes=encodeReviewedProtocolSoap(request);
 const context={attempt_id:attempt,command_id:randomUUID(),actor,lease_id:randomUUID(),nonce:randomUUID(),expires_at:new Date(NOW.getTime()+60000).toISOString(),purpose,binding_profile:'sp-protocol-soap12-reviewed-v1',environment:'2',model,method:'POST',endpoint:request.endpoint,
  identity_version:CONTEXT.company_identity_version,issuer_cnpj:HOLDER,a1_version:CONTEXT.credential_version,credential_id:CONTEXT.credential_id,envelope_hash:hash(sealed),certificate_fingerprint:envelope.metadata.fingerprint_sha256,
  candidate_id:randomUUID(),signed_hash:'a'.repeat(64),signed_size:100,access_key:accessKey,reference_digest:Buffer.alloc(20,1).toString('base64'),request_hash:null,request_size:null};
 const execution={private_executor_only:true,context,credential:{id:CONTEXT.credential_id,context:clone(CONTEXT),metadata:clone(envelope.metadata),object:{bucket:'brufap-a1-vault',key:`credentials/${CONTEXT.credential_id}/${hash(sealed)}.json`,hash:hash(sealed),size_bytes:sealed.length,key_id:'synthetic-key'}}};
 const value={actor,execution,context:{...context,request_hash:hash(bytes),request_size:bytes.length}},events=[],owned=[],key=Buffer.from(KEK),keys=new Map([['synthetic-key',key]]);let loads=0;
 const port=createProtocolCustodyPort({authorizePreparation:async input=>{events.push('authorize');return clone(input.execution);},readObject:async()=>{events.push('read');const bytes=Buffer.from(sealed);owned.push(bytes);return bytes;},loader:{async withContext(input,action){loads++;events.push('load');owned.push(input.pfxBytes,input.passwordBytes);await tls.withContext(input,action);}},keyring:keys,now:()=>NOW.getTime(),...overrides});
 return{port,value,events,owned,key,keys,request,loads:()=>loads,options:{deadline:Date.now()+5000}};
}

test('both models: authorize before open, pinned TLS context, use-before-POST and awaited void callback; all buffers wiped',async()=>{
 for(const model of ['55','65']){const f=fixture({},model),entered=gate(),release=gate();let done=false,scope;
  const pending=f.port(f.value,async s=>{scope=s;assert.ok(s.secureContext instanceof SecureContext);assert.deepEqual(Object.keys(s).sort(),['deadline','metadata','secureContext','signal']);assert.equal(s.metadata.holder_cnpj,HOLDER);assert.equal(s.metadata.icp_brasil_chain_validated,false);assert.equal(s.metadata.can_transmit,false);
   assert.deepEqual(requireProtocolServerContext(s.secureContext),{server_trust_profile:'node-bundled-plus-iti-ssl-v10-20261016',server_trust_anchor_sha256:'6e0bff069a26994c15de2c4888cc54af84882e5495b7fbf66be9ccffec7489f6'});
   f.events.push('consume-use062');entered.resolve();await release.promise;f.events.push('synthetic-POST');},f.options).then(()=>{done=true;});
  await entered.promise;assert.equal(done,false);assert.deepEqual(f.events,['authorize','read','load','consume-use062']);release.resolve();assert.equal(await pending,undefined);assert.equal(scope.signal.aborted,true);f.owned.forEach(wiped);assert.deepEqual(f.key,KEK);assert.equal(envelope.context.purpose,'offline-homologation');}
});
test('actor, candidate, request hash/size, endpoint, model, purpose, grant and credential substitutions never open Storage',async()=>{
 const changes=[v=>{v.actor=randomUUID();},v=>{v.context.candidate_id=randomUUID();},v=>{v.context.request_hash='0'.repeat(64);},v=>{v.context.request_size++;},v=>{v.context.endpoint+='?WSDL';},v=>{v.context.model='65';},v=>{v.execution.context.purpose='synthetic-protocol-reconciliation-v1';},v=>{v.context.purpose='sefaz-sp-wsdl-readonly-v1';},v=>{v.execution.context.request_hash=v.context.request_hash;v.execution.context.request_size=v.context.request_size;},v=>{v.execution.credential.context.company_identity_version++;},v=>{v.execution.credential.object.key='../bad';},v=>{v.execution.credential.object.size_bytes=1500001;},v=>{v.context.method='GET';},v=>{v.execution.credential.metadata.fingerprint_sha256='0'.repeat(64);},v=>{Object.defineProperty(v,'actor',{get(){throw Error('PRIVATE-DETAIL');}});}];
 for(const change of changes){const f=fixture();change(f.value);await assert.rejects(f.port(f.value,()=>assert.fail(),f.options),e=>e instanceof ProtocolCustodyError&&!JSON.stringify(e).includes('PRIVATE-DETAIL'));assert.equal(f.events.length,0);}
 const expired=fixture();expired.value.execution.context.expires_at=NOW.toISOString();expired.value.context.expires_at=NOW.toISOString();await error(expired.port(expired.value,()=>{},expired.options),'PROTOCOL_CUSTODY_LEASE_EXPIRED');
});
test('authorization failure or changed replay execution rejects before byte IO, and missing authorizer is invalid',async()=>{
 const denied=fixture({authorizePreparation:async()=>{throw Error('PRIVATE-DETAIL');}});await error(denied.port(denied.value,()=>{},denied.options),'PROTOCOL_CUSTODY_AUTHORIZATION_REJECTED');assert.equal(denied.events.length,0);
 for(const change of [e=>e.context.a1_version++,e=>{e.context.nonce=randomUUID();},e=>{e.context.lease_id=randomUUID();},e=>{e.credential.object.key_id='other';}]){const f=fixture({authorizePreparation:async v=>{const e=clone(v.execution);change(e);return e;}});await error(f.port(f.value,()=>{},f.options),'PROTOCOL_CUSTODY_PREPARATION_CHANGED');assert.equal(f.events.length,0);}
 assert.throws(()=>createProtocolCustodyPort({readObject:()=>{},loader:tls,keyring:new Map([['x',KEK]])}),/PROTOCOL_CUSTODY_CONFIGURATION_INVALID/);
});
test('snapshots protect authorization context, selected KEK and options from mutation across await',async()=>{
 const entered=gate(),release=gate();let authorized,calls=0;const f=fixture({authorizePreparation:async v=>{authorized=v;entered.resolve();await release.promise;return clone(v.execution);}}),expected=clone(f.value);
 const pending=f.port(f.value,()=>{calls++;},f.options);await entered.promise;f.value.context.request_hash='0'.repeat(64);f.value.execution.context.a1_version++;f.key.fill(0);f.options.deadline=0;release.resolve();await pending;assert.deepEqual(authorized,expected);assert.equal(calls,1);
});
test('wrong bytes/hash and AEAD tamper cannot reach a TLS callback even after metadata/hash are updated',async()=>{
 const bytes=Buffer.from('PRIVATE-DETAIL'),f=fixture({readObject:async()=>bytes});await error(f.port(f.value,()=>{},f.options),'PROTOCOL_CUSTODY_OBJECT_INVALID');wiped(bytes);assert.equal(f.loads(),0);
 const changed=clone(envelope),tag=Buffer.from(changed.payload.tag,'base64');tag[0]^=1;changed.payload.tag=tag.toString('base64');const raw=envelopeBytes(changed),other=fixture({readObject:async()=>Buffer.from(raw)});
 for(const c of [other.value.context,other.value.execution.context])c.envelope_hash=hash(raw);Object.assign(other.value.execution.credential.object,{hash:hash(raw),key:`credentials/${CONTEXT.credential_id}/${hash(raw)}.json`,size_bytes:raw.length});
 await error(other.port(other.value,()=>{},other.options),'PROTOCOL_CUSTODY_OPEN_FAILED');assert.equal(other.loads(),0);
});
test('20 second ceiling, lease expiry after IO and abort during authorization stop before use',async()=>{
 const f=fixture();await error(f.port(f.value,()=>{},{deadline:Date.now()+21000}),'PROTOCOL_CUSTODY_OPTIONS_INVALID');assert.equal(f.events.length,0);
 let at=NOW.getTime();const bytes=Buffer.from(sealed),expired=fixture({now:()=>at,readObject:async()=>{at+=61000;return bytes;}});await error(expired.port(expired.value,()=>{},expired.options),'PROTOCOL_CUSTODY_LEASE_EXPIRED');wiped(bytes);
 for(const mode of ['abort','timeout']){const entered=gate(),release=gate(),abort=new AbortController(),x=fixture({authorizePreparation:async v=>{entered.resolve();await release.promise;return clone(v.execution);}});
  const options={signal:abort.signal,deadline:Date.now()+(mode==='timeout'?100:5000)},pending=x.port(x.value,()=>assert.fail(),options);await entered.promise;if(mode==='abort')abort.abort();await error(pending,mode==='abort'?'PROTOCOL_CUSTODY_ABORTED':'PROTOCOL_CUSTODY_TIMEOUT');release.resolve();await tick();assert.equal(x.events.length,0);}
});
test('late Storage and TLS callbacks are discarded/wiped; active callback signal is cancelled',async()=>{
 const entered=gate(),release=gate(),abort=new AbortController(),bytes=Buffer.from(sealed),x=fixture({readObject:async()=>{entered.resolve();await release.promise;return bytes;}});
 const pending=x.port(x.value,()=>assert.fail(),{...x.options,signal:abort.signal});await entered.promise;abort.abort();await error(pending,'PROTOCOL_CUSTODY_ABORTED');release.resolve();await tick();wiped(bytes);assert.equal(x.loads(),0);
 const started=gate(),finish=gate(),signal=new AbortController();let scope,calls=0;const y=fixture({loader:{async withContext(input,action){await tls.withContext(input,async s=>{scope=s;started.resolve();await finish.promise;await action(s);});}}});
 const late=y.port(y.value,()=>{calls++;},{...y.options,signal:signal.signal});await started.promise;signal.abort();await error(late,'PROTOCOL_CUSTODY_ABORTED');assert.equal(scope.signal.aborted,true);finish.resolve();await tick();assert.equal(calls,0);
});
test('use062 rejection, private errors, non-void and repeated callbacks cannot reach an extra POST',async()=>{
 let posts=0;const f=fixture();await error(f.port(f.value,async()=>{throw Error('PRIVATE-DETAIL');posts++;},f.options),'PROTOCOL_CUSTODY_OPEN_FAILED');assert.equal(posts,0);
 const returned=fixture();await assert.rejects(returned.port(returned.value,()=>({pfx:'PRIVATE-DETAIL'}),returned.options),e=>e instanceof ProtocolCustodyError&&!JSON.stringify(e).includes('PRIVATE-DETAIL'));
 let callbacks=0;const twice=fixture({loader:{async withContext(input,action){await tls.withContext(input,async s=>{await action(s);try{await action(s);}catch{}});}}});await error(twice.port(twice.value,()=>{callbacks++;},twice.options),'PROTOCOL_CUSTODY_OPEN_FAILED');assert.equal(callbacks,1);
});
test('protocol envelope has no public index export and neither WSDL API nor WSDL TLS loader accepts the new purpose',async()=>{
 assert.equal(publicVault.withProtocolCredential,undefined);const input={envelope,expectedEnvelopeHash:envelopeHash(envelope),expectedContext:CONTEXT,kekBytes:KEK,expectedKeyId:'synthetic-key',loader:tls,purpose,now:NOW};
 await assert.rejects(withWsdlCredential(input,()=>{}),/VAULT_WSDL_PURPOSE_INVALID/);
 await assert.rejects(withProtocolCredential({...input,purpose:'sefaz-sp-wsdl-readonly-v1'},()=>{}),/VAULT_PROTOCOL_PURPOSE_INVALID/);
 const wsdl=await createWsdlTlsLoader({binaryPath:binary});await assert.rejects(withProtocolCredential({...input,loader:wsdl},()=>{}),/VAULT_TLS_PURPOSE_INVALID/);
 await withProtocolCredential(input,()=>{});assert.deepEqual(envelopeBytes(envelope),sealed);
});
test('server trust attestation rejects foreign contexts and pins Node plus public ITI root without trusting the A1 chain',async()=>{
 assert.throws(()=>requireProtocolServerContext(createSecureContext()),/PROTOCOL_SERVER_TRUST_INVALID/);let contexts=0,previous;
 const loader=await createSpProtocolTlsLoader({binaryPath:binary},{now:()=>NOW,createContext(options){contexts++;assert.deepEqual(options.ca.slice(0,-1),rootCertificates);assert.equal(options.ca.includes(certificates.root.certificate),false);assert.equal(new X509Certificate(options.ca.at(-1)).fingerprint256.replaceAll(':','').toLowerCase(),'6e0bff069a26994c15de2c4888cc54af84882e5495b7fbf66be9ccffec7489f6');previous=options.ca;return createSecureContext(options);}});
 const input={pfxBytes:pfx,passwordBytes:PASSWORD,expectedHolderCnpj:HOLDER,expectedFingerprint:envelope.metadata.fingerprint_sha256,now:NOW,purpose};
 await loader.withContext(input,s=>{requireProtocolServerContext(s.secureContext);});previous.fill(certificates.root.certificate);await loader.withContext(input,()=>{});assert.equal(contexts,2);
 const generic=await createProtocolTlsLoader({binaryPath:binary});await generic.withContext(input,s=>assert.throws(()=>requireProtocolServerContext(s.secureContext),/PROTOCOL_SERVER_TRUST_INVALID/));
 await assert.rejects(createSpProtocolTlsLoader({binaryPath:'/not/openssl'},{now:()=>NOW,readFileImpl:async()=>Buffer.from(certificates.root.certificate)}),/PROTOCOL_SERVER_TRUST_INVALID/);
});
