import test from 'node:test';
import assert from 'node:assert/strict';
import {SIGNED_FLAGS,signedCandidate,signedOutcome,signedHistory,signedRun,sameSignedCandidate,validSignedRun,signedMessage} from '../src/lib/fiscal-signed-model.ts';
import {projectSqlView,projectSqlHistory} from '../../../packages/fiscal-signed-runtime/src/sql-dto.mjs';
import {publicResult} from '../../../packages/fiscal-signed-runtime/src/dto.mjs';
import {response,view,command,candidate,job,hash,credential} from '../../../packages/fiscal-signed-rpc/test/fixtures.mjs';
import {unsignedFixture,unsignedUuid} from './helpers/fiscal-unsigned-fixtures.mjs';
const clone=v=>structuredClone(v),read=()=>projectSqlView(response('get'),{candidateId:candidate});
const runBody=()=>({command_id:command,unsigned_job_id:job,unsigned_hash:hash,basis_hash:hash,expected_a1_version:1});
const a1=()=>({state:'configured_offline',version:1,credential_id:credential,company_identity_version:1,company_changed:false,time_valid_now:true,metadata:{}});

test('050 public SQL/runtime payloads normalize for both models and all terminal states without credential references',()=>{
 for(const model of ['55','65'])for(const state of ['pending','stored','failed']){
  const sql={...view(state),read_only:true};sql.receipt.model=model;if(sql.artifact&&model==='65')sql.artifact.evidence.qr={profile:'sp-homologation-online-qr-v3',verified:true};
  const projected=projectSqlView(sql,{candidateId:candidate}),out=signedCandidate(projected,{candidate_id:candidate,model,read_only:true});
  assert.deepEqual(out,projected);assert.equal(out.signed,state==='stored');assert.equal(out.can_emit,false);assert.equal(out.can_transmit,false);
  assert.equal(JSON.stringify(out).includes('credential'),false);assert.ok(Object.isFrozen(out)&&Object.isFrozen(out.current));
  const run=publicResult({...projected,command_id:command},{action:'run',payload:runBody()});assert.deepEqual(signedOutcome(run,runBody()),run);
 }
 const commandRead=projectSqlView(response('command'),{commandId:command});assert.deepEqual(signedCandidate(commandRead,{command_id:command,read_only:true}),commandRead);
 const history=projectSqlHistory(response('history'),{jobId:job,payload:{limit:25,before:null}});assert.deepEqual(signedHistory(history,job),history);
});

test('050 historical A1 and immutable receipt remain distinct from newer current state',()=>{
 const raw=read(),out=signedCandidate(raw,{read_only:true});raw.current.a1_version=2;raw.current.a1_changed=true;raw.current.artifact_current=false;
 const later=signedCandidate(raw,{read_only:true});assert.equal(later.a1_version,1);assert.equal(later.current.a1_version,2);assert.equal(sameSignedCandidate(out,later),true);
 raw.artifact.sha256='d'.repeat(64);assert.equal(sameSignedCandidate(out,signedCandidate(raw)),false);
 assert.equal(out.current.a1_version,1);assert.notEqual(out.current,raw.current);assert.notEqual(out.artifact,raw.artifact);
 const pending=read();Object.assign(pending,{status:'pending',signed:false,signature_verified:false,xsd_validated:false,artifact:null});Object.assign(pending.current,{state:'pending',artifact_current:false});assert.equal(sameSignedCandidate(signedCandidate(pending),out),true);
});

test('050 DTO rejects promoted gates, mismatched bindings, hidden/private fields, inconsistent state and calendar dates',()=>{
 const bad=[v=>v.can_transmit=true,v=>v.authorized=true,v=>v.credential_id=credential,v=>v.current.lease_until='PRIVATE',v=>v.artifact.path='PRIVATE',v=>v.current.a1_changed=true,v=>v.current.is_latest_candidate=false,v=>v.current.latest_candidate_version=2,v=>v.current.artifact_current=false,v=>v.artifact.size_bytes=512001,v=>v.artifact.created_at='2026-02-30T12:00:00Z',v=>v.status='failed',v=>v.read_only=false,v=>v.recovered=true];
 for(const change of bad){const raw=read();change(raw);assert.throws(()=>signedCandidate(raw,{candidate_id:candidate,read_only:true}));}
 for(const expected of [{candidate_id:unsignedUuid(99)},{unsigned_job_id:unsignedUuid(99)},{unsigned_hash:'d'.repeat(64)},{basis_hash:'d'.repeat(64)},{completion_version:2},{completion_hash:'d'.repeat(64)},{a1_version:2},{model:'65'}])assert.throws(()=>signedCandidate(read(),expected));
 let called=false;const getter=read();Object.defineProperty(getter,'status',{get(){called=true;return'stored';},enumerable:true});assert.throws(()=>signedCandidate(getter));assert.equal(called,false);
 const hidden=read();Object.defineProperty(hidden,'status',{value:'stored',enumerable:false});assert.throws(()=>signedCandidate(hidden));
 const privateSymbol=read();privateSymbol[Symbol('private')]='PRIVATE';assert.throws(()=>signedCandidate(privateSymbol));
 const illegalCode=read();illegalCode.code='PRIVATE';assert.throws(()=>signedCandidate(illegalCode));
});

test('050 uncertain versus blocked results preserve unknown outcome and require the original command',()=>{
 for(const status of ['recoverable','blocked']){
  const raw={...SIGNED_FLAGS,status,command_id:command,code:'SIGNED_PORT_FAILED',phase:'readback',signed:status==='recoverable'?null:false,outcome:status==='recoverable'?'unconfirmed':'not_started',storage_operations:0,signature_verified:false,xsd_validated:false};
  assert.deepEqual(signedOutcome(raw,runBody()),publicResult(raw,{action:'run',payload:runBody()}));
  for(const change of [v=>v.signed=status==='recoverable'?false:null,v=>v.command_id=unsignedUuid(99),v=>v.phase='SEFAZ',v=>v.code='SECRET',v=>v.signature_verified=true,v=>v.storage_operations=6]){const invalid=clone(raw);change(invalid);assert.throws(()=>signedOutcome(invalid,runBody()));}
 }
 assert.doesNotMatch(signedMessage('SECRET CREDENTIAL'),/SECRET|CREDENTIAL/);
});

test('050 history verifies exclusive descending cursor, limit, uniqueness and job binding',()=>{
 const high=read();high.candidate_id=unsignedUuid(101);high.candidate_version=2;high.current.latest_candidate_id=high.candidate_id;high.current.latest_candidate_version=2;
 const low=read();low.current.latest_candidate_id=high.candidate_id;low.current.latest_candidate_version=2;low.current.is_latest_candidate=false;low.current.artifact_current=false;
 const page={...SIGNED_FLAGS,read_only:true,unsigned_job_id:job,items:[high,low],limit:2,has_more:true,next_cursor:1};assert.equal(signedHistory(page,job,{limit:2}).items.length,2);
 for(const change of [v=>v.items.reverse(),v=>v.items[1]=clone(high),v=>v.next_cursor=2,v=>v.limit=25,v=>v.items[0].unsigned_job_id=unsignedUuid(99)]){const bad=clone(page);change(bad);assert.throws(()=>signedHistory(bad,job,{limit:2}));}
 assert.throws(()=>signedHistory(page,job,{limit:2,before:2}));
 const empty={...page,items:[],has_more:false,next_cursor:null};assert.equal(signedHistory(empty,job,{limit:2}).items.length,0);assert.throws(()=>signedHistory({...empty,has_more:true},job,{limit:2}));
});

test('050 write preparation is explicit, immutable and never substitutes newer A1 into an old command',()=>{
 const unsigned=unsignedFixture().job,cert=a1(),copy=clone(unsigned),body=signedRun(unsigned,cert,true,command);
 assert.equal(validSignedRun(body),true);assert.ok(Object.isFrozen(body));assert.deepEqual(unsigned,copy);assert.deepEqual(Object.keys(body),['command_id','unsigned_job_id','unsigned_hash','basis_hash','expected_a1_version']);
 cert.version=2;assert.equal(body.expected_a1_version,1);assert.equal(signedRun(unsigned,cert,true,command).expected_a1_version,2);
 for(const mutate of [v=>v.current.basis_changed=true,v=>v.current.artifact_current=false,v=>v.current.series_enabled=false,v=>v.current.draft_archived=true,v=>v.current.source_cancelled=true,v=>v.status='pending',v=>v.artifact.size_bytes=480001]){const bad=clone(unsigned);mutate(bad);assert.throws(()=>signedRun(bad,a1(),true,command));}
 for(const mutate of [v=>v.company_changed=true,v=>v.time_valid_now=false,v=>v.credential_id=null,v=>v.metadata=null,v=>v.state='disabled']){const bad=a1();mutate(bad);assert.throws(()=>signedRun(unsigned,bad,true,command));}
 assert.throws(()=>signedRun(unsigned,a1(),false,command));assert.equal(validSignedRun({...body,xml:'PRIVATE'}),false);assert.equal(validSignedRun({...body,expected_a1_version:'1'}),false);
});
