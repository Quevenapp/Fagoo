import {dispatchResult,dispatchHistory} from '../../../../packages/fiscal-authorization-runtime/test/dispatch-fixtures.mjs';
import {FLAGS} from '../../../../packages/fiscal-authorization-runtime/src/dispatch-public-dto.mjs';
import {authorizationQaCandidate,AUTHORIZATION_QA_ACTOR} from '../../src/qa/authorization-fixture.ts';
export {reviewedQaPreflight as preflight,reviewedQaRunResult as runResult} from '../../src/qa/reviewed-authorization-fixture.ts';
import {reviewedQaPreflight,reviewedQaRunResult} from '../../src/qa/reviewed-authorization-fixture.ts';
export const actor=AUTHORIZATION_QA_ACTOR;
export const candidate=authorizationQaCandidate;
export const status=(enabled=false)=>({...FLAGS,tax_rules_validated:false,dispatch_profile:'authorization-reviewed-dispatch-v1',read_only:true,runtime_enabled:enabled,policy_checked:false});
export function result(c=candidate(),{state='submission_uncertain',reading=true,ordinal='2'}={}){
 const id=`b6900000-0000-4000-8000-${String(Number(ordinal)+(c.model==='65'?100:0)).padStart(12,'0')}`;
 const r=dispatchResult({state,reading,ordinal,id,candidate:c.candidate_id});
 Object.assign(r.receipt,{candidate_version:c.candidate_version,unsigned_job_id:c.unsigned_job_id,model:c.model,signed_hash:c.artifact.sha256,signed_size:c.artifact.size_bytes,signing_a1_version:c.a1_version,basis_hash:c.basis_hash,completion_version:c.completion_version,completion_hash:c.completion_hash});
 Object.assign(r.current.candidate,c.current,{state:'stored',lease_until:null});
 if(r.subset_review)Object.assign(r.subset_review,{candidate_version:c.candidate_version,review_id:'b6900000-0000-4000-8000-000000000099'});
 return r;
}
export function history(c=candidate(),rows=[result(c),result(c,{state:'authorized_homologation',ordinal:'1'})]){return {...dispatchHistory(rows),candidate_id:c.candidate_id};}
export const deferred=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
export const setup=({model='55',before=()=>{}}={})=>{
 const s={candidate:candidate(model),actor,role:'fiscal',phase:'ready',calls:[],history:null},listeners=new Set();s.history=history(s.candidate);
 s.notify=()=>listeners.forEach(fn=>fn());
 s.controller={getSnapshot:()=>({phase:s.phase,membership:s.actor?{user_id:s.actor,role:s.role}:null}),subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},async fiscalReviewedAuthorization(path,options={}){
  const kind=path.endsWith('/preflight')?'preflight':path.endsWith('/run')?'run':path.endsWith('/history')?'history':path.endsWith('/recover')?'recover':path.endsWith('/status')?'status':'command',call={kind,path,...options};s.calls.push(call);const custom=await before(call,s);if(custom!==undefined)return custom;
  if(kind==='preflight')return reviewedQaPreflight(s.candidate);if(kind==='run')return reviewedQaRunResult(s.candidate,options.body,false);if(kind==='command'){const prior=s.calls.find(x=>x.kind==='run'&&path.endsWith(x.body.command_id));if(prior)return reviewedQaRunResult(s.candidate,prior.body);}
  if(kind==='history')return structuredClone(s.history);if(kind==='status')return status();return result(s.candidate,{state:'authorized_homologation',reading:kind!=='recover'});
 }};return s;
};
