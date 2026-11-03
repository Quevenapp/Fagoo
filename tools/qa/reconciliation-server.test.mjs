import test from 'node:test';
import assert from 'node:assert/strict';
import {createReconciliationQaHandler,RECONCILIATION_QA_ORIGIN as ORIGIN,QA_ACTOR,QA_OTHER} from './reconciliation-server.mjs';
import {captureReconciliationRequest,reconciliationResponse,bindReconciliationResult} from '../../apps/erp/src/lib/fiscal-reconciliation-model.ts';
const req=(path,body,actor=QA_ACTOR)=>new Request(ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{Origin:'http://127.0.0.1:5173','x-qa-actor':actor,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
async function read(handler,path,body,actor){const response=await handler(req(path,body,actor));assert.equal(response.status,200);const selected=captureReconciliationRequest(path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{body})});return reconciliationResponse(await response.json(),selected);}
test('isolated QA 55/65 use real DTO and recover history locally while new run remains disabled',async()=>{
 const h=createReconciliationQaHandler(),f=await(await h(req('/fixtures'))).json();assert.equal(f.enabled,false);assert.deepEqual(f.candidates.map(c=>c.model),['55','65']);
 for(const c of f.candidates){const page=await read(h,`/v1/fiscal-reconciliation/candidates/${c.candidate_id}/history`,{limit:25,before:null});assert.deepEqual(page.items.map(r=>r.status),['dispatched','stored']);page.items.forEach(r=>bindReconciliationResult(r,c));const command_id=page.items[0].command_id;
  const recovered=await read(h,'/v1/fiscal-reconciliation/recover',{command_id});assert.equal(recovered.status,'stored');assert.equal(recovered.recoverable_by_actor,false);bindReconciliationResult(recovered,c,null,page.items[0]);const command=await read(h,`/v1/fiscal-reconciliation/commands/${command_id}`);assert.equal(command.read_only,true);
  const disabled=await h(req('/v1/fiscal-reconciliation/run',{command_id,candidate_id:c.candidate_id,signed_hash:c.artifact.sha256,expected_identity_version:2,expected_a1_version:1,confirmed:true}));assert.equal(disabled.status,409);assert.equal((await disabled.json()).error,'RECONCILIATION_DISABLED');
 }
});
test('other synthetic actor can read history but cannot read private command or recover it',async()=>{
 const h=createReconciliationQaHandler(),f=await(await h(req('/fixtures'))).json(),c=f.candidates[0],page=await read(h,`/v1/fiscal-reconciliation/candidates/${c.candidate_id}/history`,{limit:25,before:null},QA_OTHER);assert.ok(page.items.every(r=>!r.recoverable_by_actor));const id=page.items[0].command_id;assert.equal((await h(req(`/v1/fiscal-reconciliation/commands/${id}`,undefined,QA_OTHER))).status,403);assert.equal((await h(req('/v1/fiscal-reconciliation/recover',{command_id:id},QA_OTHER))).status,403);
});
test('QA refuses nonloopback/origin/query/arbitrary routes and oversized input',async()=>{
 const h=createReconciliationQaHandler();for(const r of [new Request('https://remote.invalid/fixtures'),new Request(ORIGIN+'/fixtures',{headers:{Origin:'https://evil.invalid'}}),req('/fixtures?secret=1')])assert.equal((await h(r)).status,403);
 assert.equal((await h(req('/v1/a1',{}))).status,400);assert.equal((await h(req('/v1/fiscal-reconciliation/recover',{padding:'x'.repeat(5000)}))).status,413);assert.equal((await h(req('/v1/a1',undefined,'unknown'))).status,401);
});
