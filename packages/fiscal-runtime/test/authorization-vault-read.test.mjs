import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createAuthorizationVaultReader} from '../src/authorization-vault-read.mjs';
const payload=Buffer.from('{"synthetic":"sealed ciphertext only"}'),sha=createHash('sha256').update(payload).digest('hex');
const reference=()=>({bucket:'brufap-a1-vault',key:`credentials/${randomUUID()}/${sha}.json`,sha256:sha,maxBytes:1500000});
const configuration=fetchImpl=>({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-service-key-not-secret',fetchImpl});
test('fixed private GET captures its reference and verifies exact bytes/hash',async()=>{
 let open;const gate=new Promise(r=>{open=r;});let url;
 const read=createAuthorizationVaultReader(configuration(async(u,o)=>{url=u;assert.equal(o.method,'GET');assert.equal(o.redirect,'manual');await gate;return new Response(payload,{headers:{'content-type':'application/json'}});}));
 const ref=reference(),expected=ref.key,opts={deadline:Date.now()+5000},pending=read(ref,opts);ref.key='other';ref.sha256='0'.repeat(64);opts.deadline=0;open();
 const bytes=await pending;assert.deepEqual(bytes,payload);assert.ok(url.endsWith(expected));bytes.fill(0);
});
test('wrong hash, oversized/empty chunks, redirects and compressed bodies fail closed without private errors',async()=>{
 const responses=[()=>new Response('wrong',{headers:{'content-type':'application/json'}}),()=>new Response(new Uint8Array(1500001),{headers:{'content-type':'application/json'}}),()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array());}}),{headers:{'content-type':'application/json'}}),()=>new Response(null,{status:302,headers:{Location:'https://example.invalid'}}),()=>new Response(payload,{headers:{'content-type':'application/json','content-encoding':'gzip'}})];
 for(const response of responses){const read=createAuthorizationVaultReader(configuration(async()=>response()));await assert.rejects(read(reference(),{deadline:Date.now()+5000}),e=>/^AUTHORIZATION_VAULT_/.test(e.code));}
});
test('abort bounds uncooperative fetch and cancellation does not wait for driver promises',async()=>{
 const abort=new AbortController(),read=createAuthorizationVaultReader(configuration(()=>new Promise(()=>{}))),pending=read(reference(),{signal:abort.signal,deadline:Date.now()+5000});abort.abort();await assert.rejects(pending,/AUTHORIZATION_SERVICE_ABORTED/);
 const body=new ReadableStream({pull(c){c.enqueue(new Uint8Array());},cancel(){return new Promise(()=>{});}}),reader=createAuthorizationVaultReader(configuration(async()=>new Response(body,{headers:{'content-type':'application/json'}})));
 await assert.rejects(reader(reference(),{deadline:Date.now()+5000}),/AUTHORIZATION_VAULT_BODY_INVALID/);
});
test('accessors and arbitrary bucket/path are refused before fetch',async()=>{
 let calls=0;const read=createAuthorizationVaultReader(configuration(()=>{calls++;throw Error('PRIVATE');}));
 for(const patch of [{bucket:'public'},{key:'credentials/../secret'},{maxBytes:1500001}])await assert.rejects(read({...reference(),...patch},{deadline:Date.now()+5000}));
 const ref=reference();Object.defineProperty(ref,'key',{get(){throw Error('PRIVATE');}});await assert.rejects(read(ref,{deadline:Date.now()+5000}));assert.equal(calls,0);
});
