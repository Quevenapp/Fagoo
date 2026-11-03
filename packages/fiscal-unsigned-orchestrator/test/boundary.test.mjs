import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixture.mjs';
import {createUnsignedXmlOrchestrator} from '../src/unsigned.mjs';

test('factory and inputs require explicit ports and disallow arbitrary identity, actor and storage paths',async()=>{
 assert.throws(()=>createUnsignedXmlOrchestrator(),e=>e.code==='UNSIGNED_PORTS_REQUIRED');
 let calls=0;const executor=createUnsignedXmlOrchestrator({rpc:async()=>{calls++;},storage:{read:async()=>null,putImmutable:async()=>({status:201})}});
 const input={actor:randomUUID(),draftId:randomUUID(),completionVersion:1};
 for(const bad of[{...input,cNF:'00000000'},{...input,actor:'admin'},{...input,completionVersion:0},null])await assert.rejects(()=>executor.preview(bad),e=>e.code==='UNSIGNED_INPUT_INVALID');
 for(const options of[{deadline:Date.now()+60000},{signal:'signal'},{url:'https://example.invalid'}])await assert.rejects(()=>executor.preview(input,options));
 const a=new AbortController();a.abort();await assert.rejects(()=>executor.preview(input,{signal:a.signal}),e=>e.code==='UNSIGNED_ABORTED');assert.equal(calls,0);
});

test('untrusted basis cannot promote authorization flags or feed a mismatched fingerprint into begin',async()=>{
 const f=await fixture();try{const p=await f.prepare(),input=await f.input(p);
  for(const mutate of[r=>r.can_emit=true,r=>r.basis_hash='f'.repeat(64),r=>r.basis_fingerprint_text+=' ',r=>r.inputs.basisHashes.completion_record_hash='e'.repeat(64)]){
   const o=f.orchestrator({rpc:async(name,args,options)=>{const r=await f.rpc(name,args,options);if(name.endsWith('_basis'))mutate(r);return r;}});
   const result=await o.run({...input,commandId:randomUUID()});assert.equal(result.status,'blocked');assert.equal(result.can_emit,false);
  }
  assert.equal(f.calls.rpc.filter(c=>c.name.endsWith('_begin')).length,0);assert.equal((await f.counts()).identities,0);assert.equal(f.calls.put.length,0);
 }finally{await f.close();}
});

test('forged execution identity or receipt proof never reaches Storage or marks failure as deterministic',async()=>{
 const f=await fixture();try{
  for(const mutate of[r=>r.execution.identity.cNF='99999999',r=>r.receipt.proofs.company_fiscal_version++,r=>r.execution.private_executor_only=false]){
   const p=await f.prepare(),input=await f.input(p),o=f.orchestrator({rpc:async(name,args,options)=>{const r=await f.rpc(name,args,options);if(name.endsWith('_begin'))mutate(r);return r;}});
   const result=await o.run(input);assert.equal(result.status,'recoverable');assert.equal((await f.command(input)).current.state,'pending');
  }
  assert.equal(f.calls.put.length,0);assert.equal(f.calls.rpc.some(c=>c.name.endsWith('_fail')),false);
 }finally{await f.close();}
});

test('read error, redirects, content coding, missing body and mismatched lengths never mean absent',async()=>{
 const f=await fixture();try{
  const reads=[async()=>{throw new Error('SECRET_EXTERNAL_MESSAGE');},async()=>new Response('x',{status:302,headers:{location:'https://elsewhere.invalid'}}),
   async()=>new Response('x',{headers:{'content-type':'application/octet-stream','content-encoding':'gzip'}}),async()=>new Response(null,{headers:{'content-type':'application/octet-stream'}}),
   async()=>new Response('x',{headers:{'content-type':'application/octet-stream','content-length':'1'}})];
  for(const read of reads){const p=await f.prepare(),input=await f.input(p),r=await f.orchestrator({storage:{...f.ports.storage,read}}).run(input);
   assert.equal(r.status,'recoverable');assert.doesNotMatch(JSON.stringify(r),/SECRET_EXTERNAL|elsewhere/);assert.equal((await f.command(input)).current.state,'pending');
  }
  assert.equal(f.calls.put.length,0);assert.equal((await f.counts()).artifacts,0);
 }finally{await f.close();}
});

test('preview deadline bounds an uncooperative port and never starts a write',async()=>{
 let rpcCalls=0;const o=createUnsignedXmlOrchestrator({rpc:async()=>{rpcCalls++;return new Promise(()=>{});},storage:{read:async()=>assert.fail(),putImmutable:async()=>assert.fail()}});
 const result=await o.preview({actor:randomUUID(),draftId:randomUUID(),completionVersion:1},{deadline:Date.now()+20});
 assert.equal(result.status,'blocked');assert.equal(result.code,'UNSIGNED_TIMEOUT');assert.equal(rpcCalls,1);
});

test('late begin acknowledgement after abort cannot start storage; same command remains pending for later recovery',async()=>{
 const f=await fixture();let release,observed;const gated=new Promise(r=>release=r),seen=new Promise(r=>observed=r);try{
  const p=await f.prepare(),input=await f.input(p),abort=new AbortController();
  const o=f.orchestrator({rpc:async(name,args,options)=>{const r=await f.rpc(name,args,options);if(name.endsWith('_begin')){observed();await gated;}return r;}});
  const pending=o.run(input,{signal:abort.signal});await seen;abort.abort();const result=await pending;
  assert.equal(result.status,'recoverable');assert.equal(result.code,'UNSIGNED_ABORTED');release();await new Promise(r=>setTimeout(r,5));
  assert.equal(f.calls.put.length,0);assert.equal(f.calls.read.length,0);const current=await f.orchestrator().run(input);assert.equal(current.status,'pending');assert.equal(current.current.attempt_count,1);
  assert.doesNotMatch(JSON.stringify(current),/"identity"|"inputs"|"lease_id"|unsignedXml|INTERNAL-COMMERCIAL/);
 }finally{release?.();await f.close();}
});
