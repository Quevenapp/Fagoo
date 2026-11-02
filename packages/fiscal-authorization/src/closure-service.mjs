/**074 close/replay only. Deliberately has no gate, Storage, validator, custody or transport ports. */
import {data,need,id,scope,freeze} from './service-common.mjs';
import {captureClosureInput,projectClosureLedger,closurePublicFromLedger} from './closure-dto.mjs';
import {CLOSURE_RPC,CLOSURE_COMMAND_RPC} from './closure-rpc.mjs';
import {snapshot} from '../../fiscal-authorization-http/src/protocol.mjs';
import {projectReviewedLedger,SUBSET_LEDGER_PROFILE} from './reviewed-ledger-dto.mjs';
export function createAuthorizationClosureService(configuration){
 const p=data(configuration,['reviewedRpc','closureRpc']);need(typeof p.reviewedRpc==='function'&&typeof p.closureRpc==='function');const {reviewedRpc,closureRpc}=p;
 async function lookup(actor,commandId,s){const value=await s.bounded(()=>closureRpc(CLOSURE_COMMAND_RPC,{p_user_id:actor,p_command_id:commandId},{signal:s.signal,deadline:s.deadline}));s.check();return projectClosureLedger(value,{action:'closureCommand',commandId});}
 function historical(value,q,binding){need(value.receipt.authorization_command_id===q.authorization_command_id&&value.receipt.attempt_id===q.expected_attempt_id&&value.receipt.previous_state===q.expected_state,'40001');return closurePublicFromLedger({...value,read_only:false},binding);}
 async function closureCommand(input,options={}){
  const x=data(input,['actor','commandId']);need(id(x.actor)&&id(x.commandId));const s=scope(options,15000);
  try{const value=await lookup(x.actor,x.commandId,s);const out=closurePublicFromLedger(value,{action:'closureCommand',commandId:x.commandId});s.check();return out;}finally{s.close();}
 }
 async function closeExpired(input,options={}){
  const x=data(input,['actor','request']);need(id(x.actor));const actor=x.actor,q=captureClosureInput(x.request),binding=freeze({action:'closeExpired',commandId:q.command_id,input:q}),s=scope(options,15000);
  try{
   let previous;try{previous=await lookup(actor,q.command_id,s);}catch(e){if(Object.getOwnPropertyDescriptor(e??{},'code')?.value!=='P0002')throw e;}s.check();
   if(previous){const out=historical(previous,q,binding);s.check();return out;}
   const originalArgs={p_user_id:actor,p_command_id:q.authorization_command_id};
   const captured=snapshot(await s.bounded(()=>reviewedRpc('erp_fiscal_reviewed_authorization_command',originalArgs,{signal:s.signal,deadline:s.deadline})));s.check();
   const {rule_review,observation,...view}=captured,original=projectReviewedLedger('command',{ledger_profile:SUBSET_LEDGER_PROFILE,view,rule_review,observation},originalArgs);
   const r=original.receipt,c=original.current,ctx=original.recovery;
   need(original.command_id===q.authorization_command_id&&r?.command_id===q.authorization_command_id&&r?.attempt_id===q.expected_attempt_id&&ctx?.actor===actor&&ctx?.command_id===q.authorization_command_id&&ctx?.attempt_id===q.expected_attempt_id&&ctx.candidate_id===r.candidate_id&&ctx.signed_hash===r.signed_hash,'40001');
   if(c?.state!==q.expected_state){
    // A concurrent identical close may commit after the first074 GET returned404.
    // Re-read only its own receipt; never reinterpret a terminal attempt as success.
    let concurrent;try{concurrent=await lookup(actor,q.command_id,s);}catch(e){if(Object.getOwnPropertyDescriptor(e??{},'code')?.value!=='P0002')throw e;}s.check();need(concurrent,'40001');const out=historical(concurrent,q,binding);s.check();return out;
   }
   need(c.grant_consumed===false&&c.lease_expired===true&&original.artifact===null&&original.observation===null,'40001');
   const args={p_user_id:actor,p_command_id:q.command_id,p_authorization_command_id:q.authorization_command_id,p_expected_attempt_id:q.expected_attempt_id,p_expected_state:q.expected_state,p_expected_request_hash:ctx.request_hash,p_confirmed:true};
   const value=await s.bounded(()=>closureRpc(CLOSURE_RPC,args,{signal:s.signal,deadline:s.deadline}));s.check();const out=closurePublicFromLedger(value,binding);need(['candidate_id','signed_hash','model','origin','policy_version'].every(k=>out.receipt[k]===r[k]),'AUTHORIZATION_CLOSURE_RPC_RESPONSE_INVALID');s.check();return out;
  }finally{s.close();}
 }
 return Object.freeze({closeExpired,closureCommand});
}
