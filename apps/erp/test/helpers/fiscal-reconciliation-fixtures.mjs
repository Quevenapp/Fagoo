import {randomUUID} from 'node:crypto';
import {result,payload,actor} from '../../../../packages/fiscal-reconciliation-runtime/test/fixtures.mjs';
import {FLAGS} from '../../../../packages/fiscal-reconciliation-runtime/src/dto.mjs';
import {SIGNED_FLAGS} from '../../src/lib/fiscal-signed-model.ts';
import {configured,company,envelope} from './a1-fixtures.mjs';
import {AccessError} from './component-recovery-harness.mjs';
export {actor,payload,result};
export const clone=structuredClone;
export const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
export function candidate(model='55'){
 const r=result().receipt,c=result().current.candidate;const {lease_until,...current}=c;
 return {...SIGNED_FLAGS,status:'stored',candidate_id:r.candidate_id,candidate_version:r.candidate_version,unsigned_job_id:r.unsigned_job_id,unsigned_hash:'f'.repeat(64),basis_hash:r.basis_hash,model,completion_version:r.completion_version,completion_hash:r.completion_hash,a1_version:r.signing_a1_version,error_code:null,signed:true,signature_verified:true,xsd_validated:true,current,artifact:{sha256:r.signed_hash,size_bytes:r.signed_size,created_at:r.created_at},read_only:true};
}
export function fixture({model='55',state='stored',before=()=>{},after=()=>{},historyRows=[]}={}){
 const s={actor,role:'fiscal',phase:'ready',candidate:candidate(model),a1:clone(configured),company:clone(company),calls:[],counts:{},commands:new Map(),historyRows:clone(historyRows),state};
 const listeners=new Set();s.notify=()=>{for(const fn of listeners)fn();};
 const call=async(kind,path,options={})=>{
  const c={kind,path,body:clone(options.body),signal:options.signal};s.calls.push(c);s.counts[kind]=(s.counts[kind]??0)+1;await before(c,s);let value;
  if(kind==='a1')value=envelope(s.a1);else if(kind==='company')value=s.company;
  else if(kind==='history')value={...FLAGS,read_only:true,candidate_id:s.candidate.candidate_id,items:clone(s.historyRows),limit:options.body.limit,has_more:false,next_cursor:null};
  else if(kind==='run'){
   value=result(s.state,options.body);value.receipt.model=s.candidate.model;value.receipt.attempt_id=randomUUID();s.commands.set(options.body.command_id,clone(value));
  }else if(kind==='recover'){
   const old=s.commands.get(options.body.command_id);if(!old)throw new AccessError(404);
   const body={command_id:old.command_id,candidate_id:old.receipt.candidate_id,signed_hash:old.receipt.signed_hash,expected_a1_version:old.receipt.a1_version,expected_identity_version:old.receipt.identity_version,confirmed:true};
   value=result('stored',body);value.receipt=clone(old.receipt);value.recovered=true;s.commands.set(body.command_id,clone(value));
  }else{
   const stored=s.commands.get(path.split('/').at(-1));if(!stored)throw new AccessError(404);value={...clone(stored),read_only:true,recovered:false,failure_code:null};
  }
  await after(c,s,value);return clone(value);
 };
 s.controller={getSnapshot:()=>({phase:s.phase,membership:s.phase==='signed_out'?null:{user_id:s.actor,role:s.role}}),subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},a1:(p,o)=>call('a1',p,o),company:(p,o)=>call('company',p,o),fiscalReconciliation:(p,o)=>call(p.endsWith('/run')?'run':p.endsWith('/recover')?'recover':p.endsWith('/history')?'history':'command',p,o)};
 return s;
}
