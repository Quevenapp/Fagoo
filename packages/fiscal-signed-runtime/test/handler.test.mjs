import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from '../../fiscal-signed-orchestrator/test/fixture.mjs';
import {createSignedRuntimeHandler} from '../src/handler.mjs';
import {digest,signRuntimeRequest} from '../src/auth.mjs';
import {response as sqlResponse,actor,command,candidate} from '../../fiscal-signed-rpc/test/fixtures.mjs';
import {SignedRuntimeError} from '../src/protocol.mjs';
const secret=new Uint8Array(32).fill(27),keyId='runtime-test',audience='synthetic-signed',prefix='/internal/v1/fiscal-signed';
const bytes=value=>new TextEncoder().encode(JSON.stringify(value));
const request=async(action,payload,{user=actor,raw,claimed,signal,headers={}}={})=>{
 const method=payload===undefined&&raw===undefined?'GET':'POST',path=prefix+'/'+action,body=raw??(payload===undefined?new Uint8Array():bytes(payload));
 const authorization=await signRuntimeRequest({secretBytes:secret,keyId,audience,actor:user,nonce:randomUUID(),method,path,bodyHash:await digest(claimed??body)});
 return new Request('http://runtime.internal'+path,{method,signal,headers:{Authorization:authorization,...(method==='POST'?{'Content-Type':'application/json'}:{}),...headers},...(method==='POST'?{body}:{})});
};
const handler=ports=>createSignedRuntimeHandler({...ports,transportSecret:secret,transportKeyId:keyId,audience});
const unused={read:async()=>assert.fail('Unexpected Storage read'),putImmutable:async()=>assert.fail('Unexpected Storage write')};
const readOnly=rpc=>handler({rpc,storage:unused,withAuthorizedSigner:async()=>assert.fail('Unexpected custody'),validateXsd:async()=>assert.fail('Unexpected XSD')});
const payload=j=>({command_id:j.commandId,unsigned_job_id:j.unsignedJobId,unsigned_hash:j.unsignedHash,basis_hash:j.basisHash,expected_a1_version:j.expectedA1Version});
async function result(r,status=200){assert.equal(r.status,status);assert.equal(r.headers.get('cache-control'),'no-store');const v=await r.json();assert.doesNotMatch(JSON.stringify(v),/credential_id|fingerprint|private_executor_only|lease_|access_key|holder_cnpj|<NFe|PRIVATE_UPSTREAM/);return v;}
test('real050 signs synthetic55/65 once, then exposes only scoped candidate/command/history metadata',async()=>{
 for(const model of ['55','65']){
  const f=await fixture({model});try{
   const h=handler(f.ports),body=payload(f.input),req=await request('run',body,{user:f.input.actor}),replay=req.clone();
   const created=await result(await h(req));assert.equal(created.status,'stored');assert.equal(created.a1_version,f.input.expectedA1Version);assert.equal(created.signature_verified,true);assert.equal(created.can_emit,false);
   const repeated=await result(await h(replay));assert.equal(repeated.candidate_id,created.candidate_id);assert.equal(f.calls.custody.length,1);assert.equal(f.calls.put.length,1);
   const c=await result(await h(await request('candidates/'+created.candidate_id,undefined,{user:f.input.actor})));assert.equal(c.read_only,true);assert.equal(Object.hasOwn(c,'command_id'),false);
   const cmd=await result(await h(await request('commands/'+body.command_id,undefined,{user:f.input.actor})));assert.equal(cmd.command_id,body.command_id);assert.equal(cmd.artifact.sha256,created.artifact.sha256);
   const history=await result(await h(await request(`jobs/${body.unsigned_job_id}/history`,{limit:25,before:null},{user:f.input.actor})));assert.equal(history.items.length,1);assert.equal(history.items[0].read_only,true);
   const denied=await result(await h(await request('candidates/'+created.candidate_id,undefined,{user:f.users.consulta})),403);assert.equal(denied.error,'SIGNED_FORBIDDEN');
   const wrongOwner=await result(await h(await request('commands/'+body.command_id,undefined,{user:f.users.admin})),403);assert.equal(wrongOwner.error,'SIGNED_FORBIDDEN');
  }finally{await f.close();}
 }
});
test('authentication and body binding precede RPC, custody and schema; unknown client execution fields fail closed',async()=>{
 let calls=0;const h=readOnly(async()=>{calls++;return sqlResponse('get');});
 const raw=new Request('http://runtime.internal'+prefix+'/run',{method:'POST',body:'{}',headers:{'Content-Type':'application/json'}});
 await result(await h(raw),401);
 const base={command_id:command,unsigned_job_id:randomUUID(),unsigned_hash:'a'.repeat(64),basis_hash:'b'.repeat(64),expected_a1_version:1};
 await result(await h(await request('run',base,{claimed:bytes({...base,expected_a1_version:2})})),401);
 for(const [options,code]of [[{raw:new Uint8Array(4097)},413],[{raw:new Uint8Array([0xc3,0x28])},400],[{headers:{'Content-Encoding':'gzip'}},400],[{headers:{'Content-Type':'text/plain'}},415]])await result(await h(await request('run',base,options)),code);
 for(const extra of [{actor},{lease_id:randomUUID()},{xml:'<synthetic/>'},{credential_id:randomUUID()}])await result(await h(await request('run',{...base,...extra})),400);
 assert.equal(calls,0);
});
test('same runtime concurrency budget covers reads and cancels a stalled RPC without returning late private data',async()=>{
 const entered=[],releases=[];let calls=0;
 const h=readOnly(async()=>{calls++;entered.shift()?.();return new Promise(resolve=>releases.push(resolve));});
 const a=new AbortController(),b=new AbortController();
 const wait=()=>new Promise(resolve=>entered.push(resolve));
 let reached=wait();const one=h(await request('candidates/'+candidate,undefined,{signal:a.signal}));await reached;
 reached=wait();const two=h(await request('candidates/'+candidate,undefined,{signal:b.signal}));await reached;
 const busy=await result(await h(await request('candidates/'+candidate)),503);assert.equal(busy.error,'SIGNED_RUNTIME_BUSY');assert.equal(calls,2);
 a.abort();b.abort();await result(await one,503);await result(await two,503);
 releases.forEach(resolve=>resolve(sqlResponse('get')));
 await new Promise(resolve=>setImmediate(resolve));
 reached=wait();const three=h(await request('candidates/'+candidate));await reached;releases.at(-1)(sqlResponse('get'));assert.equal((await result(await three)).candidate_id,candidate);
});
test('private response shape errors and driver diagnostics are sanitized rather than forwarding executor inputs',async()=>{
 const broken=readOnly(async()=>{throw new Error('PRIVATE_UPSTREAM diagnostic');});assert.equal((await result(await broken(await request('candidates/'+candidate)),503)).error,'SIGNED_RUNTIME_FAILED');
 const forged=readOnly(async()=>({...sqlResponse('get'),private_executor_only:true,credential_object:{path:'PRIVATE_UPSTREAM'}}));
 assert.equal((await result(await forged(await request('candidates/'+candidate)),502)).error,'SIGNED_RESPONSE_INVALID');
 const unexpected=readOnly(async()=>{throw new SignedRuntimeError(200,'PRIVATE_UPSTREAM');});
 assert.equal((await result(await unexpected(await request('candidates/'+candidate)),503)).error,'SIGNED_RUNTIME_FAILED');
});
test('factory validates its fixed transport context and owns a copy of its key',async()=>{
 const ports={rpc:async()=>sqlResponse('get'),storage:unused,withAuthorizedSigner:async()=>{},validateXsd:async()=>{}};
 for(const change of [{audience:'synthetic-unsigned'},{transportKeyId:'bad key'},{concurrency:3}])assert.throws(()=>createSignedRuntimeHandler({...ports,transportSecret:secret,transportKeyId:keyId,audience,...change}));
 const original=new Uint8Array(secret),h=createSignedRuntimeHandler({...ports,transportSecret:original,transportKeyId:keyId,audience});original.fill(0);
 assert.equal((await result(await h(await request('candidates/'+candidate)))).candidate_id,candidate);
 h.dispose();
});
test('dispose closes admission and aborts active reads while discarding the eventual private response',async()=>{
 let resolveEntered,finish,signal,calls=0;const entered=new Promise(resolve=>{resolveEntered=resolve;});
 const h=readOnly(async(_name,_args,opts)=>{calls++;signal=opts.signal;resolveEntered();return new Promise(resolve=>{finish=resolve;});});
 const pending=h(await request('candidates/'+candidate));await entered;h.dispose();h.dispose();
 assert.equal(signal.aborted,true);await result(await pending,503);
 finish(sqlResponse('get'));await new Promise(resolve=>setImmediate(resolve));
 assert.equal((await result(await h(await request('candidates/'+candidate)),503)).error,'SIGNED_RUNTIME_FAILED');assert.equal(calls,1);
 const pre=readOnly(async()=>{assert.fail('No RPC after dispose');});const verifying=pre(await request('candidates/'+candidate));pre.dispose();await result(await verifying,503);
});
