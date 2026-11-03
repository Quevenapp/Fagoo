import test from 'node:test';
import assert from 'node:assert/strict';
import {RECONCILIATION_BASE as BASE,captureReconciliationRequest,reconciliationResponse,bindReconciliationResult,reconciliationRun,reconciliationReady} from '../src/lib/fiscal-reconciliation-model.ts';
import {payload,result,candidate,clone} from './helpers/fiscal-reconciliation-fixtures.mjs';
import {history,unconfirmed} from '../../../packages/fiscal-reconciliation-runtime/test/fixtures.mjs';
import {configured,company} from './helpers/a1-fixtures.mjs';
import {a1Company} from '../src/lib/a1-model.ts';
const body=payload(),run=captureReconciliationRequest(BASE+'/run',{method:'POST',body}),get=captureReconciliationRequest(BASE+'/commands/'+body.command_id);
test('062 model reuses real public DTO, strips nothing unexpected and binds historical candidate separately from current A1',()=>{
 const c=candidate();for(const state of ['prepared','dispatched','stored','failed_before_dispatch','uncertain']){
  const r=reconciliationResponse(result(state),run);assert.equal(Object.isFrozen(r.receipt),true);assert.deepEqual(bindReconciliationResult(r,c,body),r);
 }
 const v=result('stored');v.current.a1_version=3;v.current.a1_changed=true;v.current.candidate.a1_version=3;v.current.candidate.a1_changed=true;v.current.candidate.artifact_current=false;
 assert.equal(bindReconciliationResult(reconciliationResponse(v,run),c,body).receipt.a1_version,1);
 const u=reconciliationResponse(unconfirmed(),run);assert.equal(u.status,'unconfirmed');assert.equal(u.can_query,false);
 for(const change of [v=>v.credential_id=body.command_id,v=>v.receipt.envelope_hash='a'.repeat(64),v=>v.current.candidate.path='/private',v=>v.artifact.xml='private',v=>v.can_emit=true,v=>v.recoverable_by_actor=true]){const v=result();change(v);assert.throws(()=>reconciliationResponse(v,run));}
});
test('closed request capture rejects extra inputs and coercion, preserves original body and signal before async work',()=>{
 const p=clone(body),signal=new AbortController().signal,captured=captureReconciliationRequest(BASE+'/run',{method:'POST',body:p,signal});p.signed_hash='b'.repeat(64);assert.equal(captured.payload.signed_hash,body.signed_hash);assert.equal(captured.signal,signal);
 let invoked=false;const property=Object.defineProperty({},'body',{enumerable:true,get(){invoked=true;return body;}});assert.throws(()=>captureReconciliationRequest(BASE+'/run',property));assert.equal(invoked,false);
 for(const [path,o] of [[BASE+'/run',{method:'POST',body:{...body,confirmed:false}}],[BASE+'/run',{method:'POST',body:{...body,signed_hash:[body.signed_hash]}}],[BASE+'/recover',{method:'POST',body:{command_id:body.command_id,confirmed:true}}],[BASE+'/commands/'+body.command_id,{body:undefined}],[BASE+'/candidates/'+body.candidate_id+'/history',{method:'POST',body:{limit:25,before:1}}],[BASE+'/candidates/'+body.candidate_id+'/history',{method:'POST',body:{limit:25,before:'9223372036854775808'}}],[BASE+'/run?x=1',{method:'POST',body}]])assert.throws(()=>captureReconciliationRequest(path,o));
});
test('history and readbacks bind hashes/versions, immutable receipt and artifact; canonical cursor remains string',()=>{
 const c=candidate(),h=history(),selected=captureReconciliationRequest(BASE+'/candidates/'+body.candidate_id+'/history',{method:'POST',body:{limit:25,before:null}});
 assert.equal(reconciliationResponse(h,selected).items[0].read_only,true);h.items.push(clone(h.items[0]));assert.throws(()=>reconciliationResponse(h,selected));
 const ack=reconciliationResponse(result(),run),read=reconciliationResponse(result('stored',body,true),get);assert.deepEqual(bindReconciliationResult(read,c,body,ack),read);
 for(const change of [v=>v.receipt.model='65',v=>v.receipt.signed_size++,v=>v.receipt.candidate_version++,v=>v.receipt.signing_a1_version++,v=>v.receipt.unsigned_job_id=body.command_id,v=>v.receipt.completion_hash='f'.repeat(64),v=>v.artifact.sha256='f'.repeat(64)]){const v=clone(read);change(v);assert.throws(()=>bindReconciliationResult(v,c,body,ack));}
});
test('new query uses current identity/A1, accepts historical commercial bases, and requires explicit confirmation',()=>{
 const c=candidate();c.current.a1_version=2;c.current.a1_changed=true;c.current.artifact_current=false;c.current.basis_changed=true;c.current.unsigned_artifact_current=false;
 const a=clone(configured);a.version=2;const b=a1Company(company);assert.equal(reconciliationReady(c,a,b),true);const r=reconciliationRun(c,a,b,true,body.command_id);assert.equal(r.expected_a1_version,2);assert.equal(c.a1_version,1);
 assert.throws(()=>reconciliationRun(c,a,b,false,body.command_id));a.company_changed=true;assert.equal(reconciliationReady(c,a,b),false);
});
