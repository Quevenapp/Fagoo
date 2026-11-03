// Pure synthetic vault/PKCS12 tests. No database, socket or actual A1.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createSecureContext,rootCertificates} from 'node:tls';
import {X509Certificate} from 'node:crypto';
import {createAuthorizationCustodyPort} from '../src/authorization-custody.mjs';
import {createSpAuthorizationTlsLoader,requireAuthorizationServerContext,SP_AUTHORIZATION_ROOT_HASH} from '../src/authorization-server-trust.mjs';
import {createOpenSslLoader,sealCredential,envelopeBytes} from '../../fiscal-vault/src/index.mjs';
import * as publicVault from '../../fiscal-vault/src/index.mjs';
import {withAuthorizationCredential,withProtocolCredential,withWsdlCredential} from '../../fiscal-vault/src/envelope.mjs';
import {operationalFixture,hash} from '../../fiscal-authorization/test/operational-fixtures.mjs';
import {SUBSET_POLICY_HASHES} from '../../fiscal-authorization/src/reviewed-ledger-dto.mjs';
import {trustFixture} from '../../fiscal-vault/test/trust-fixtures.mjs';
import {binary,exportPfx,KEK,PASSWORD,CONTEXT} from '../../fiscal-vault/test/fixtures.mjs';
const client=await trustFixture(),pfx=await exportPfx(client.leaf,[client.intermediate,client.root]),offline=await createOpenSslLoader({binaryPath:binary});
const tls=await createSpAuthorizationTlsLoader({binaryPath:binary});
const envelope=await sealCredential({pfxBytes:pfx,passwordBytes:PASSWORD,context:CONTEXT,kekBytes:KEK,keyId:'test',loader:offline,now:new Date()}),sealed=envelopeBytes(envelope);pfx.fill(0);
const f=await operationalFixture({credential:client.leaf});let base;
await f.service({withPreparedSession:async value=>{base=value;throw Error('capture-before-use');}}).run(f.input);
const execution={...base.execution,origin:'operational',policy_manifest_hash:SUBSET_POLICY_HASHES[base.execution.model],credential_id:CONTEXT.credential_id,envelope_hash:hash(sealed)};
const value={actor:base.actor,execution,context:execution,rule_review:base.rule_review,request:f.request};
test.after(()=>{f.close();sealed.fill(0);for(const c of [client.leaf,client.intermediate,client.root])c.privateDer.fill(0);});
function fixture(patch={}){
 const events=[],owned=[],key=Buffer.from(KEK),keyring=new Map([['test',key]]);
 const port=createAuthorizationCustodyPort({authorizePreparation:async v=>{events.push('authorize');return v.execution;},readObject:async r=>{events.push('read');assert.equal(r.key,`credentials/${CONTEXT.credential_id}/${hash(sealed)}.json`);const b=Buffer.from(sealed);owned.push(b);return b;},loader:{async withContext(v,action){events.push('load');owned.push(v.pfxBytes,v.passwordBytes);return tls.withContext(v,action);}},keyring,...patch});
 return{port,events,owned,key,keyring,opts:{deadline:Date.now()+10000}};
}
const tick=()=>new Promise(r=>setImmediate(r));
test('private purpose/AAD is preserved; authority precedes bounded read/open, context fingerprint is pinned and all owned material wiped',async()=>{
 const x=fixture();let called=0;
 await x.port(value,async s=>{called++;assert.deepEqual(Object.keys(s).sort(),['deadline','metadata','secureContext','signal']);assert.equal(s.metadata.fingerprint_sha256,envelope.metadata.fingerprint_sha256);assert.equal(requireAuthorizationServerContext(s.secureContext,s.metadata.fingerprint_sha256).server_trust_anchor_sha256,SP_AUTHORIZATION_ROOT_HASH);assert.throws(()=>requireAuthorizationServerContext(s.secureContext,'0'.repeat(64)));},x.opts);
 assert.equal(called,1);assert.deepEqual(x.events,['authorize','read','load']);assert.ok(x.owned.every(b=>b.every(x=>x===0)));assert.deepEqual(x.key,KEK);assert.equal(publicVault.withAuthorizationCredential,undefined);assert.equal(envelope.context.purpose,'offline-homologation');
 const input={envelope,expectedEnvelopeHash:hash(sealed),expectedContext:CONTEXT,kekBytes:KEK,expectedKeyId:'test',loader:tls,purpose:'sp-authorization-homologation-v1',now:new Date(),deadline:Date.now()+10000};
 await assert.rejects(withProtocolCredential(input,()=>{}));await assert.rejects(withWsdlCredential(input,()=>{}));await withAuthorizationCredential(input,()=>{});
});
test('mutation after await cannot select another key, body, actor or deadline',async()=>{
 let release,entered;const gate=new Promise(r=>{release=r;}),seen=new Promise(r=>{entered=r;});
 const x=fixture({authorizePreparation:async v=>{entered();await gate;return v.execution;}}),input={...value,execution:{...value.execution},context:{...value.context},rule_review:{...value.rule_review}},opts={...x.opts};
 const pending=x.port(input,async()=>{},opts);await seen;input.actor='other';input.context.envelope_hash='0'.repeat(64);input.execution.credential_id='other';input.rule_review.review_hash='0'.repeat(64);x.key.fill(0);opts.deadline=0;release();await pending;
 assert.ok(x.owned.every(b=>b.every(x=>x===0)));
});
test('hash/AEAD/context mismatches refuse opening; shared bytes and malformed key material are rejected',async()=>{
 for(const edit of [e=>e.payload.tag=Buffer.alloc(16).toString('base64'),e=>e.context.company_identity_version++,e=>e.metadata.fingerprint_sha256='0'.repeat(64)]){
  const changed=structuredClone(envelope);edit(changed);let bytes;try{bytes=envelopeBytes(changed);}catch{bytes=Buffer.from(JSON.stringify(changed));}
  const ctx={...execution,envelope_hash:hash(bytes)},x=fixture({readObject:async()=>Buffer.from(bytes)});
  await assert.rejects(x.port({...value,execution:ctx,context:ctx},()=>assert.fail(),x.opts));assert.equal(x.events.includes('load'),false);bytes.fill(0);
 }
 const bad=Buffer.from('private-ciphertext'),x=fixture({readObject:async()=>bad});await assert.rejects(x.port(value,()=>{},x.opts));assert.ok(bad.every(x=>x===0));
 const shared=fixture({keyring:new Map([['test',new Uint8Array(new SharedArrayBuffer(32))]])});await assert.rejects(shared.port(value,()=>{},shared.opts));assert.equal(shared.events.length,0);
});
test('abort discards late Storage, closes the callback and does not await a hung port',async()=>{
 let release,entered;const gate=new Promise(r=>{release=r;}),seen=new Promise(r=>{entered=r;}),bytes=Buffer.from(sealed),abort=new AbortController();
 const x=fixture({readObject:async()=>{entered();await gate;return bytes;}}),pending=x.port(value,()=>assert.fail(),{...x.opts,signal:abort.signal});await seen;abort.abort();await assert.rejects(pending);release();await tick();assert.ok(bytes.every(x=>x===0));
 let retained;const y=fixture({loader:{async withContext(v,action){retained=()=>tls.withContext(v,action);}}});await assert.rejects(y.port(value,()=>assert.fail(),y.opts));await assert.rejects(retained());
});
test('trust profile uses only explicit Node roots plus pinned ITI SSL root, never PFX CA; other contexts are rejected',async()=>{
 assert.throws(()=>requireAuthorizationServerContext(createSecureContext(),envelope.metadata.fingerprint_sha256));let configured;
 const loader=await createSpAuthorizationTlsLoader({binaryPath:binary},{createContext(options){configured=options;assert.deepEqual(options.ca.slice(0,-1),rootCertificates);assert.equal(hash(new X509Certificate(options.ca.at(-1)).raw),SP_AUTHORIZATION_ROOT_HASH);assert.equal(options.ca.includes(client.root.certificate),false);return createSecureContext(options);}});
 await fixture({loader}).port(value,()=>{}, {deadline:Date.now()+10000});assert.ok(configured);
 await assert.rejects(createSpAuthorizationTlsLoader({binaryPath:binary},{readFileImpl:async()=>Buffer.from(client.root.certificate)}),/AUTHORIZATION_SERVER_TRUST_INVALID/);
});
