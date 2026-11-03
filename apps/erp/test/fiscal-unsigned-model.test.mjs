import test from 'node:test';
import assert from 'node:assert/strict';
import {completionEnvelope} from '../src/lib/fiscal-completion-model.ts';
import {unsignedPreview,unsignedJob,unsignedOutcome,unsignedHistory,currentCompletion,reservationEnvelope,reservationReady,reservationWrite,generateWrite,sameJob,UNSIGNED_FLAGS} from '../src/lib/fiscal-unsigned-model.ts';
import {unsignedFixture,unsignedUuid} from './helpers/fiscal-unsigned-fixtures.mjs';
import {publicResult} from '../../../packages/fiscal-unsigned-runtime/src/dto.mjs';

test('048 preview is bound to current bases, has no legal claims and strips unrelated payload',()=>{
 const f=unsignedFixture({count:250}),c=completionEnvelope(f.completion,f.draft.record.id),r=currentCompletion(f.draft,c);assert.ok(r);
 const p=unsignedPreview(publicResult(f.preview,{action:'preview',payload:{draft_id:f.draft.record.id,completion_version:1}}),f.draft,r);assert.equal(p.items,250);assert.equal('xml'in p,false);
 for(const patch of[{draft_id:unsignedUuid(99)},{completion_version:2},{model:'65'},{environment:'1'},{can_emit:true},{signature_verified:true},{items:249},{identity_assigned:true},{pending:['UNKNOWN']}])assert.throws(()=>unsignedPreview({...f.preview,...patch},f.draft,r));
 const changed=structuredClone(c);changed.current.tax_preparation_version=2;changed.current.matches_current_tax_preparation=false;assert.equal(currentCompletion(f.draft,changed),null);
 assert.equal(currentCompletion({...f.draft,current:{...f.draft.current,status:'archived'}},c),null);
});
test('048 explicit reservation binds canonical number and unchanged bases without requiring unchanged series counter',()=>{
 const f=unsignedFixture(),c=completionEnvelope(f.completion,f.draft.record.id).record;
 const b=reservationWrite(f.draft,c,f.series,true,unsignedUuid(3));assert.equal('number'in b,false);assert.equal(b.expected_series_version,1);assert.throws(()=>reservationWrite(f.draft,c,f.series,false,unsignedUuid(3)));
 const r=reservationEnvelope(f.reserveEnvelope,f.draft.record.id);assert.equal(reservationReady(r,c),true);assert.equal(r.receipt.number,'999999998');
 const advanced=structuredClone(f.reserveEnvelope);advanced.current_series.version=3;advanced.current_series.next_number=null;advanced.current_series.exhausted=true;assert.equal(reservationReady(reservationEnvelope(advanced,f.draft.record.id),c),true);
 const ack={...f.reserveEnvelope,read_only:undefined,action:'reserve',command_id:b.command_id,replayed:true};assert.equal(reservationEnvelope(ack,f.draft.record.id,{body:b}).receipt.id,f.reservation.id);
 for(const patch of[{number:'0999999998'},{series:'0123'},{reserved_at:'2026-02-30T12:00:00Z'},{series_version:2},{draft_id:unsignedUuid(8)},{company_identity_version:2}])assert.throws(()=>reservationEnvelope({...ack,receipt:{...ack.receipt,...patch}},f.draft.record.id,{body:b}));
 const out=generateWrite(unsignedPreview(f.preview,f.draft,c),r.receipt,unsignedUuid(9));assert.deepEqual(Object.keys(out).sort(),['basis_hash','command_id','completion_hash','completion_version','draft_id','reservation_id']);
});
test('048 runtime compact views interoperate and reject foreign/hash/false readiness, retaining no XML or identity',()=>{
 const f=unsignedFixture(),v=publicResult({...f.job,command_id:f.body.command_id},{action:'generate',payload:f.body});const p=unsignedOutcome(v,f.body);assert.equal(p.status,'stored');
 const read=unsignedJob(publicResult(f.job,{action:'job',jobId:f.job.job_id}),{...f.body,command_id:undefined,read_only:true});assert.equal(sameJob(p,read),true);
 for(const patch of[{basis_hash:'b'.repeat(64)},{completion_version:2},{command_id:unsignedUuid(88)},{reservation_id:unsignedUuid(9)},{authorized:true},{can_transmit:true}])assert.throws(()=>unsignedOutcome({...v,...patch},f.body));
 for(const patch of[{artifact_current:false},{basis_changed:true},{lease_until:'2026-10-16T12:00:00Z'}])assert.throws(()=>unsignedJob({...f.job,current:{...f.job.current,...patch}}));
 assert.throws(()=>unsignedJob({...f.job,artifact:{...f.job.artifact,created_at:'2026-09-31T10:00:00Z'}}));
 assert.doesNotMatch(JSON.stringify(unsignedJob({...f.job,xml:'PRIVATE',identity:'PRIVATE',lease_id:'PRIVATE'})),/PRIVATE/);
});
test('048 history validates descending versions, uniqueness, paging and per-item read-only claims',()=>{
 const f=unsignedFixture(),raw={...UNSIGNED_FLAGS,read_only:true,reservation_id:f.reservation.id,items:[f.job],limit:25,has_more:false,next_cursor:null};assert.equal(unsignedHistory(raw,f.reservation.id,f.draft.record.id,null).items.length,1);
 for(const patch of[{items:[f.job,f.job]},{next_cursor:1},{has_more:true},{items:[{...f.job,read_only:false}]},{items:[{...f.job,draft_id:unsignedUuid(9)}]}])assert.throws(()=>unsignedHistory({...raw,...patch},f.reservation.id,f.draft.record.id,null));
 assert.throws(()=>unsignedHistory(raw,f.reservation.id,f.draft.record.id,1));
});
