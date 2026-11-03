import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createSignedCustodyPort,SignedCustodyError} from '../src/index.mjs';
import {createOpenSslLoader,sealCredential,envelopeBytes} from '../../fiscal-vault/src/index.mjs';
import {signNfeXml,FiscalXmlError} from '../../fiscal-xml/src/index.mjs';
import {inspectNfe} from '../../fiscal-xml/src/xml.mjs';
import {binary,exportPfx,credentials,PASSWORD,CONTEXT,KEK,NOW,HOLDER,unsignedXml} from '../../fiscal-vault/test/fixtures.mjs';

const credential=await credentials(),pfx=await exportPfx(credential),loader=await createOpenSslLoader({binaryPath:binary});
const envelope=await sealCredential({pfxBytes:pfx,passwordBytes:PASSWORD,context:CONTEXT,kekBytes:KEK,keyId:'test-key-v1',loader,now:NOW});
const sealed=envelopeBytes(envelope),hash=b=>createHash('sha256').update(b).digest('hex'),parsed=inspectNfe(unsignedXml());
function fixture(overrides={}){
 const g={actor:randomUUID(),command_id:randomUUID(),candidate_id:randomUUID(),a1_version:1,lease_id:randomUUID(),lease_until:new Date(NOW.getTime()+60000).toISOString(),used_at:NOW.toISOString(),identity:structuredClone(parsed.identity),access_key:parsed.accessKey,unsigned_object:{bucket:'brufap-fiscal-artifacts',path:`jobs/${randomUUID()}/${hash(unsignedXml())}.xml`,hash:hash(unsignedXml()),size:Buffer.byteLength(unsignedXml())},credential_context:structuredClone(CONTEXT),credential_metadata:structuredClone(envelope.metadata),credential_object:{bucket:'brufap-a1-vault',path:`credentials/${CONTEXT.credential_id}/${hash(sealed)}.json`,hash:hash(sealed),size:sealed.length,key_id:'test-key-v1'}};
 const reads=[],owned=[];let loads=0;
 const port=createSignedCustodyPort({readObject:async(ref,opts)=>{reads.push({ref,opts});const bytes=Buffer.from(sealed);owned.push(bytes);return bytes;},loader:{load:async args=>{loads++;return loader.load(args);}},keyring:new Map([['test-key-v1',KEK]]),now:()=>NOW.getTime(),...overrides});
 return{g,port,reads,owned,loads:()=>loads};
}
const options=extra=>({deadline:Date.now()+5000,...extra});
const reject=(promise,code)=>assert.rejects(promise,e=>e instanceof SignedCustodyError&&e.code===code&&!e.cause);
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('authorized envelope opens only within the callback, signs offline and disposes its signer and owned buffers',async()=>{
 const f=fixture(),keyBefore=Buffer.from(KEK);let calls=0,handle;
 assert.equal(await f.port(f.g,signer=>{calls++;handle=signer;assert.equal(signNfeXml({xml:unsignedXml(),signer,expectedIssuerCnpj:HOLDER,now:NOW}).verification.signatureVerified,true);},options()),undefined);
 assert.equal(calls,1);assert.equal(f.loads(),1);assert.equal(f.reads.length,1);assert.deepEqual(f.reads[0].ref,f.g.credential_object);assert.equal(f.reads[0].opts.signal.aborted,true);
 assert.ok(f.owned.every(b=>b.every(v=>v===0)));assert.deepEqual(KEK,keyBefore);
 assert.throws(()=>signNfeXml({xml:unsignedXml(),signer:handle,expectedIssuerCnpj:HOLDER,now:NOW}),/SIGNER/);
});
test('strict grants reject getters, extra fields and cross-context object references before reading',async()=>{
 for(const mutate of [g=>{g.extra=true;},g=>{g.actor=['bad'];},g=>{Object.defineProperty(g,'actor',{get(){throw Error('SECRET');}});},g=>{g.identity.environment='1';},g=>{g.access_key='0'.repeat(44);},g=>{g.credential_object.bucket='other';},g=>{g.credential_object.path='../private';},g=>{g.unsigned_object.path='../private';},g=>{g.credential_context.credential_id=randomUUID();},g=>{g.a1_version=0;}]){
  const f=fixture();mutate(f.g);await reject(f.port(f.g,()=>assert.fail('callback'),options()),'SIGNED_CUSTODY_GRANT_INVALID');assert.equal(f.reads.length,0);
 }
});
test('grant is captured before awaits and metadata substitutions never open a different envelope',async()=>{
 let resolve;const gate=new Promise(r=>resolve=r),f=fixture({readObject:async()=>{await gate;return Buffer.from(sealed);}});
 const pending=f.port(f.g,()=>{},options());f.g.credential_object.path='../changed';f.g.credential_metadata.fingerprint_sha256='f'.repeat(64);resolve();await pending;
 const other=fixture();other.g.credential_metadata.fingerprint_sha256='f'.repeat(64);other.g.credential_metadata.presented_chain=['f'.repeat(64)];await reject(other.port(other.g,()=>assert.fail('callback'),options()),'SIGNED_CUSTODY_ENVELOPE_CONFLICT');assert.equal(other.loads(),0);
});
test('unknown key, mismatched bytes and changed ciphertext fail closed without provider diagnostics',async()=>{
 const missing=fixture();missing.g.credential_object.key_id='missing';await reject(missing.port(missing.g,()=>{},options()),'SIGNED_CUSTODY_KEY_UNAVAILABLE');assert.equal(missing.reads.length,0);
 const wrong=fixture({readObject:async()=>Buffer.from('SYNTHETIC_PRIVATE_PROVIDER_CONTENT')});await reject(wrong.port(wrong.g,()=>{},options()),'SIGNED_CUSTODY_OBJECT_INVALID');assert.equal(wrong.loads(),0);
 const e=structuredClone(envelope);e.payload.tag=Buffer.alloc(16,17).toString('base64');const bad=envelopeBytes(e),f=fixture({readObject:async()=>Buffer.from(bad)});f.g.credential_object={...f.g.credential_object,path:`credentials/${CONTEXT.credential_id}/${hash(bad)}.json`,hash:hash(bad),size:bad.length};await reject(f.port(f.g,()=>assert.fail('callback'),options()),'SIGNED_CUSTODY_OPEN_FAILED');
});
test('lease is checked before IO and after a delayed object read',async()=>{
 const f=fixture();f.g.lease_until=NOW.toISOString();f.g.used_at=new Date(NOW.getTime()-1000).toISOString();await reject(f.port(f.g,()=>{},options()),'SIGNED_CUSTODY_LEASE_EXPIRED');assert.equal(f.reads.length,0);
 let clock=NOW.getTime();const delayed=fixture({now:()=>clock,readObject:async()=>{clock+=61000;return Buffer.from(sealed);}});await reject(delayed.port(delayed.g,()=>assert.fail('callback'),options()),'SIGNED_CUSTODY_LEASE_EXPIRED');assert.equal(delayed.loads(),0);
});
test('timeout and abort stop waiting, cancel the port and wipe late object bytes',async()=>{
 for(const aborted of [false,true]){
  let resolve,portSignal;const controller=new AbortController(),gate=new Promise(r=>resolve=r),f=fixture({readObject:async(ref,opts)=>{portSignal=opts.signal;return gate;}}),late=Buffer.from(sealed);
  const pending=f.port(f.g,()=>assert.fail('callback'),options({signal:controller.signal,deadline:Date.now()+(aborted?5000:15)}));await tick();if(aborted)controller.abort();await reject(pending,aborted?'SIGNED_CUSTODY_ABORTED':'SIGNED_CUSTODY_TIMEOUT');assert.equal(portSignal.aborted,true);resolve(late);await tick();assert.ok(late.every(v=>v===0));assert.equal(f.loads(),0);
 }
});
test('late loader completion after abort never invokes the callback and still disposes the created signer',async()=>{
 let release,loadedHandle,started;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r),controller=new AbortController();
 const f=fixture({loader:{load:async args=>{const result=await loader.load(args);loadedHandle=result.signer;started();await gate;return result;}}});
 const pending=f.port(f.g,()=>assert.fail('callback'),options({signal:controller.signal}));await ready;controller.abort();await reject(pending,'SIGNED_CUSTODY_ABORTED');release();await tick();
 assert.throws(()=>signNfeXml({xml:unsignedXml(),signer:loadedHandle,expectedIssuerCnpj:HOLDER,now:NOW}),/SIGNER/);
});
test('only synchronous void callbacks are accepted and unexpected action diagnostics are sanitized',async()=>{
 for(const action of [()=>true,()=>Promise.resolve(),()=>{throw Error('SYNTHETIC_SECRET');}]){
  const f=fixture();await assert.rejects(f.port(f.g,action,options()),e=>e instanceof SignedCustodyError&&!JSON.stringify(e).includes('SYNTHETIC_SECRET'));
 }
 const f=fixture();await assert.rejects(f.port(f.g,()=>{throw new FiscalXmlError('XML_MODEL_MISMATCH');},options()),e=>e instanceof FiscalXmlError&&e.code==='XML_MODEL_MISMATCH'&&!e.cause);
});
test('already-aborted or expired options cause no object IO',async()=>{
 const f=fixture(),controller=new AbortController();controller.abort();await reject(f.port(f.g,()=>{},options({signal:controller.signal})),'SIGNED_CUSTODY_ABORTED');await reject(f.port(f.g,()=>{},options({deadline:Date.now()-1})),'SIGNED_CUSTODY_TIMEOUT');assert.equal(f.reads.length,0);
});
test('certificate expiration during loader work prevents even a synchronous callback',async()=>{
 let clock=Date.parse(envelope.metadata.not_after)-1;
 const f=fixture({now:()=>clock,loader:{load:async args=>{const result=await loader.load(args);clock+=2;return result;}}});
 f.g.lease_until=new Date(clock+60000).toISOString();
 await reject(f.port(f.g,()=>assert.fail('callback'),options()),'SIGNED_CUSTODY_CERTIFICATE_EXPIRED');
});
test('hostile local proxy and clock failures cannot expose free-form diagnostics before the first await',async()=>{
 const f=fixture(),proxy=new Proxy(f.g,{getPrototypeOf(){throw Error('SYNTHETIC_PRIVATE_PROXY_DETAIL');}});
 await reject(f.port(proxy,()=>{},options()),'SIGNED_CUSTODY_GRANT_INVALID');
 const clock=fixture({now:()=>{throw Error('SYNTHETIC_PRIVATE_CLOCK_DETAIL');}});await reject(clock.port(clock.g,()=>{},options()),'SIGNED_CUSTODY_CONFIGURATION_INVALID');
 assert.equal(f.reads.length,0);assert.equal(clock.reads.length,0);
});
test('signer is already disposed when a microtask scheduled by the synchronous callback runs',async()=>{
 const f=fixture();let afterCallbackSigned=false,checked=false;
 await f.port(f.g,signer=>{queueMicrotask(()=>{checked=true;try{signNfeXml({xml:unsignedXml(),signer,expectedIssuerCnpj:HOLDER,now:NOW});afterCallbackSigned=true;}catch{}});},options());
 assert.equal(checked,true);assert.equal(afterCallbackSigned,false);
});
