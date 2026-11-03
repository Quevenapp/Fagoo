import './helpers/synthetic-october-clock.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {REVIEWED_AUTHORIZATION_BASE as B,captureReviewedAuthorizationRequest as capture,reviewedAuthorizationResponse as project,bindReviewedAuthorizationResult as bind} from '../src/lib/fiscal-reviewed-authorization-model.ts';
import {candidate,result,history,status,preflight} from './helpers/fiscal-reviewed-authorization-fixtures.mjs';
test('reviewed routes are isolated, own-data captured and no XML/actor/versions defaulted',()=>{
 const c=candidate(),r=result(c),body={command_id:r.command_id},selected=capture(B+'/recover',{method:'POST',body});body.command_id=c.candidate_id;assert.equal(selected.payload.command_id,r.command_id);assert.ok(Object.isFrozen(selected.payload));
 const run={request_profile:'authorization-reviewed-selection-v1',command_id:r.command_id,...preflight(c,{enabled:true}).selection,confirmed:true};assert.deepEqual(capture(B+'/run',{method:'POST',body:run}).payload,run);
 for(const [path,options] of [[B.replace('/reviewed','')+'/run',{method:'POST',body:run}],[B+'/status',{body:undefined}],[B+'/status?x=1',{}],[B+'/recover',{method:'POST',body:{...body,actor:'x'}}],[B+'/run',{method:'POST',body:{...run,expected_policy_version:undefined}}],[B+'/candidates/'+c.candidate_id+'/history',{method:'POST',body:{limit:26,before:null}}]])assert.throws(()=>capture(path,options));
 let called=0;const bad=Object.defineProperty({},'body',{enumerable:true,get(){called++;return body;}});assert.throws(()=>capture(B+'/recover',bad));assert.equal(called,0);
});
test('models55/65 bind historical candidate and proof separately from current certificate and bases',()=>{
 for(const model of ['55','65']){const c=candidate(model),r=result(c),route=capture(B+'/commands/'+r.command_id),checked=bind(project(r,route),c);const changed=structuredClone(r);changed.current.a1_changed=true;changed.current.candidate.basis_changed=true;bind(project(changed,route),c,checked);
 for(const edit of [v=>v.receipt.model=model==='55'?'65':'55',v=>v.receipt.signing_a1_version++,v=>v.subset_review.review_hash='f'.repeat(64),v=>v.subset_review.review_id=c.candidate_id]){const bad=structuredClone(r);edit(bad);assert.throws(()=>bind(project(bad,route),c,checked));}
 const terminal=result(c,{state:'authorized_homologation'}),t=bind(project(terminal,route),c,checked),tampered=structuredClone(terminal);tampered.observation.sha256='f'.repeat(64);assert.throws(()=>bind(project(tampered,route),c,t));
 assert.equal(project(history(c),capture(`${B}/candidates/${c.candidate_id}/history`,{method:'POST',body:{limit:25,before:null}})).items.length,2);
 }
 assert.equal(project(status(true),capture(B+'/status')).policy_checked,false);
});
