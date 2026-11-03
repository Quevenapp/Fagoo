import test from 'node:test';
import assert from 'node:assert/strict';
import {publicResult} from '../src/dto.mjs';
import {candidate,command,payload,result,history,unconfirmed} from './fixtures.mjs';
const run={action:'run',payload:payload(),commandId:command};
test('public projection preserves immutable receipt, current state and observed TLS without authorization',()=>{
 const value=result();value.execution={credential:'PRIVATE'};value.current.nonce='PRIVATE';value.receipt.lease_id='PRIVATE';value.artifact.raw_xml='PRIVATE';
 const safe=publicResult(value,run);assert.doesNotMatch(JSON.stringify(safe),/PRIVATE|lease_id|raw_xml|execution|credential|nonce/);
 assert.equal(safe.artifact.tls_origin_verified,true);assert.equal(safe.artifact.cstat,'217');assert.equal(safe.sefaz_authorized,false);assert.equal(safe.can_emit,false);
 assert.deepEqual(publicResult(safe,run),safe);
 for(const state of ['prepared','dispatched','uncertain','failed_before_dispatch'])assert.equal(publicResult(result(state),run).status,state);
 assert.equal(publicResult(unconfirmed(),run).status,'unconfirmed');
});
test('private or synthetic evidence, unsafe flags, stale bindings and contradictory state are rejected',()=>{
 for(const mutate of [v=>v.origin='synthetic',v=>v.can_emit=true,v=>v.profile='synthetic-protocol-reconciliation-v1',v=>v.receipt.candidate_id=command,
  v=>v.receipt.signed_hash='f'.repeat(64),v=>v.receipt.a1_version=2,v=>v.current.grant_consumed=false,v=>v.current.candidate.artifact_current=false,
  v=>v.artifact.tls_origin_verified=false,v=>v.artifact.cstat=100,v=>v.artifact.rejection_code='unknown',v=>v.current.used_at=v.current.expires_at,v=>v.recoverable_by_actor=true]){
  const value=result();mutate(value);assert.throws(()=>publicResult(value,run),/RECONCILIATION_RESPONSE_INVALID/);
 }
 const v=result();Object.defineProperty(v,'status',{get(){throw new Error('must not read');}});assert.throws(()=>publicResult(v,run),/RECONCILIATION_RESPONSE_INVALID/);
});
test('history binds candidate, descending ordinals, exact cursor and actor-specific recovery',()=>{
 const context={action:'history',candidateId:candidate,payload:{limit:25,before:null}};
 const page=history();page.items[0].recoverable_by_actor=false;assert.equal(publicResult(page,context).items[0].recoverable_by_actor,false);
 for(const mutate of [p=>p.candidate_id=command,p=>p.items[0].receipt.candidate_id=command,p=>p.has_more=true,p=>p.next_cursor='1',p=>p.items[0].read_only=false]){
  const value=history();mutate(value);assert.throws(()=>publicResult(value,context));
 }
 assert.throws(()=>publicResult(history(),{...context,payload:{limit:25,before:'1'}}));
});
test('query and recovery remain distinct; rejected SOAP is stored evidence, not fiscal authorization',()=>{
 const read=publicResult(result('stored',payload(),true),{action:'command',commandId:command});assert.equal(read.read_only,true);
 assert.throws(()=>publicResult(result(),{action:'command',commandId:command}));
 const recovered=result();recovered.recovered=true;assert.equal(publicResult(recovered,{action:'recover',payload:{command_id:command}}).recovered,true);
 const rejected=result();Object.assign(rejected.artifact,{outcome:'rejected',rejection_code:'SOAP_RESPONSE_REJECTED',cstat:null,event_reconciliation_required:null});
 assert.equal(publicResult(rejected,run).artifact.outcome,'rejected');
});
