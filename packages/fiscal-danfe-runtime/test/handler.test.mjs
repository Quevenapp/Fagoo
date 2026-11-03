import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,request,result,actor} from './fixtures.mjs';
import {maximalHeader,candidateFixture} from '../../fiscal-danfe/test/fixtures.mjs';
import {DanfeRuntimeError} from '../src/protocol.mjs';

test('both models read only the exact immutable object and reauthorize after rendering',async()=>{
 for(const model of ['55','65']){
  const f=await fixture({model}),h=f.handler();try{const v=await result(await h(await request(f.id)));assert.deepEqual(v,f.dto);assert.deepEqual(f.calls,['rpc','read','rpc']);assert.equal(v.authorized,false);}finally{h.dispose();}
 }
});
test('ACL failure before read or after Storage never returns HTML and does not retry',async()=>{
 for(const failAt of [1,2]){
  const f=await fixture();let calls=0;const h=f.handler({rpc:async(...args)=>{calls++;if(calls===failAt)throw Object.assign(Error('PRIVATE_DIAGNOSTIC'),{code:'42501'});return f.ports.rpc(...args);}});
  const v=await result(await h(await request(f.id)),403);assert.equal(v.error,'DANFE_FORBIDDEN');assert.equal(v.html,undefined);assert.equal(calls,failAt);assert.equal(f.calls.includes('read'),failAt===2);h.dispose();
 }
});
test('immutable receipt/artifact changes during read conflict; current context can change without rewriting history',async()=>{
 for(const mutate of [v=>{v.receipt.completion_hash='e'.repeat(64);},v=>{v.artifact.created_at='2026-10-17T00:00:00Z';}]){
  const f=await fixture();let n=0;const h=f.handler({rpc:async()=>{const v=structuredClone(f.raw);if(++n===2)mutate(v);return v;}});assert.equal((await result(await h(await request(f.id)),409)).error,'DANFE_CONFLICT');h.dispose();
 }
 const f=await fixture();let n=0;const h=f.handler({rpc:async()=>{const v=structuredClone(f.raw);if(++n===2)Object.assign(v.current,{basis_changed:true,unsigned_artifact_current:false,artifact_current:false,a1_version:2,a1_changed:true});return v;}});
 const v=await result(await h(await request(f.id)));assert.equal(v.html,f.dto.html);assert.equal(v.current.basis_changed,true);assert.equal(v.current.a1_changed,true);h.dispose();
});
test('hash, size, missing objects, redirects and unsupported media fail without exposing upstream diagnostics',async()=>{
 const f=await fixture();
 for(const read of [()=>null,()=>new Response(new Uint8Array(f.bytes.length).fill(32),{headers:{'Content-Type':'application/octet-stream'}}),()=>new Response(f.bytes,{headers:{'Content-Type':'text/xml'}}),()=>new Response(null,{status:302,headers:{Location:'https://never-follow.invalid'}}),()=>new Response(f.bytes,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(f.bytes.length+1)}})]){
  const h=f.handler({storage:{read}});const r=await h(await request(f.id));assert.ok(r.status>=400);const v=await result(r,r.status);assert.equal(v.html,undefined);h.dispose();
 }
});
test('authentication, stored state and strict private DTO precede Storage',async()=>{
 const f=await fixture();const h=f.handler();await result(await h(new Request(`http://runtime.internal/internal/v1/fiscal-danfe/candidates/${f.id}/preview`)),401);
 await result(await h(await request(f.id,{claimedBody:new Uint8Array([1])})),401);assert.deepEqual(f.calls,[]);h.dispose();
 const pending=structuredClone(f.raw);Object.assign(pending,{signed:false,signature_verified:false,xsd_validated:false,artifact:null});Object.assign(pending.current,{state:'pending',lease_until:'2026-10-16T12:01:00Z',artifact_current:false});
 for(const [raw,status]of [[pending,409],[{...f.raw,execution:{PRIVATE_DIAGNOSTIC:true}},502]]){const handler=f.handler({rpc:async()=>raw,storage:{read:()=>assert.fail('No read')}});await result(await handler(await request(f.id)),status);handler.dispose();}
});
test('dispose/abort covers a late Storage result, cancels the body and closes admission',async()=>{
 const f=await fixture();let enter,finish,cancelled=false;const ready=new Promise(r=>{enter=r;});
 const h=f.handler({storage:{read:()=>{enter();return new Promise(r=>{finish=r;});}}});
 const pending=h(await request(f.id));await ready;h.dispose();await result(await pending,503);
 finish(new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'Content-Type':'application/octet-stream'}}));await new Promise(r=>setImmediate(r));assert.equal(cancelled,true);await result(await h(await request(f.id)),503);
});
test('concurrency is bounded at two authenticated reads and sanitization never exposes arbitrary error codes',async()=>{
 const f=await fixture();let enters=[],finishes=[];const h=f.handler({rpc:()=>{enters.shift()();return new Promise(r=>finishes.push(r));}});
 const next=()=>new Promise(r=>enters.push(r)),a=new AbortController(),b=new AbortController();
 let entered=next();const first=h(await request(f.id,{signal:a.signal}));await entered;entered=next();const second=h(await request(f.id,{signal:b.signal}));await entered;
 assert.equal((await result(await h(await request(f.id)),503)).error,'DANFE_RUNTIME_BUSY');a.abort();b.abort();await result(await first,503);await result(await second,503);finishes.forEach(r=>r(f.raw));h.dispose();
 for(const error of [Error('PRIVATE_DIAGNOSTIC'),new DanfeRuntimeError(200,'PRIVATE_DIAGNOSTIC')]){const bad=f.handler({rpc:()=>{throw error;}});assert.equal((await result(await bad(await request(f.id)),503)).error,'DANFE_RUNTIME_FAILED');bad.dispose();}
});
test('XML within parser limits but excessive header is rejected explicitly without incomplete HTML',async()=>{
 const f=await fixture(),large=await candidateFixture({transformUnsigned:maximalHeader});const raw=structuredClone(f.raw);raw.artifact.signed_hash=large.context.sha256;raw.artifact.size_bytes=large.bytes.length;raw.artifact.evidence.signature.xml_hash=large.context.sha256;raw.artifact.evidence.xsd.xml_hash=large.context.sha256;
 const h=f.handler({rpc:async()=>raw,storage:{read:async()=>new Response(large.bytes,{headers:{'Content-Type':'application/octet-stream'}})}});assert.equal((await result(await h(await request(f.id)),422)).error,'DANFE_LAYOUT_UNSUPPORTED');h.dispose();
});
