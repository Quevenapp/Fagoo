/** Closed browser-safe074 projection. A request hash is private RPC metadata only. */
import {data,need,uuid,hash,version,timestamp,snapshot,freeze} from '../../fiscal-authorization-http/src/protocol.mjs';
import {FLAGS} from '../../fiscal-authorization-http/src/dto.mjs';
export const CLOSURE_PROFILE='reviewed-expired-unconsumed-v1';
export const MAX_CLOSURE_REQUEST_BYTES=4096,MAX_CLOSURE_RESPONSE_BYTES=16384;
const check=v=>need(v,502,'AUTHORIZATION_RESPONSE_INVALID');
const exact=(v,keys)=>data(v,keys,[],502,'AUTHORIZATION_RESPONSE_INVALID');
const receiptKeys=['command_id','authorization_command_id','attempt_id','candidate_id','signed_hash','model','origin','policy_version','previous_state','review_id','lease_expired_at','closed_at','reason','state','grant_consumed','tax_rules_validated'];
const keys=[...Object.keys(FLAGS),'closure_profile','tax_rules_validated','command_id','receipt','current','replayed','read_only'];
export function captureClosureInput(raw){
 const v=data(raw,['command_id','authorization_command_id','expected_attempt_id','expected_state','confirmed']);
 need(['command_id','authorization_command_id','expected_attempt_id'].every(k=>uuid(v[k]))&&v.command_id!==v.authorization_command_id&&['prepared','request_ready'].includes(v.expected_state)&&v.confirmed===true);return freeze(v);
}
function project(raw,binding,privateHash){
 const b=data(binding,['action','commandId'],['input']);check(['closeExpired','closureCommand'].includes(b.action)&&uuid(b.commandId));
 const v=snapshot(exact(raw,keys));check(Object.entries(FLAGS).every(([k,x])=>v[k]===x)&&v.closure_profile===CLOSURE_PROFILE&&v.tax_rules_validated===false&&v.command_id===b.commandId&&typeof v.replayed==='boolean'&&v.read_only===(b.action==='closureCommand'));
 if(v.read_only)check(v.replayed===true);
 const r=exact(v.receipt,privateHash?[...receiptKeys,'request_hash']:receiptKeys),c=exact(v.current,['state','grant_consumed','finished_at','successor_exists','intent_consumed']);
 check(['command_id','authorization_command_id','attempt_id','candidate_id'].every(k=>uuid(r[k]))&&r.command_id===b.commandId&&r.command_id!==r.authorization_command_id&&hash(r.signed_hash)&&['55','65'].includes(r.model)&&['synthetic','operational'].includes(r.origin)&&version(r.policy_version)&&['prepared','request_ready'].includes(r.previous_state)&&(r.review_id===null||uuid(r.review_id))&&timestamp(r.lease_expired_at)&&timestamp(r.closed_at)&&Date.parse(r.closed_at)>=Date.parse(r.lease_expired_at)&&r.reason==='LEASE_EXPIRED_UNCONSUMED'&&r.state==='failed_before_dispatch'&&r.grant_consumed===false&&r.tax_rules_validated===false);
 if(privateHash)check(r.previous_state==='prepared'?r.request_hash===null:hash(r.request_hash));
 check(c.state==='failed_before_dispatch'&&c.grant_consumed===false&&timestamp(c.finished_at)&&Date.parse(c.finished_at)===Date.parse(r.closed_at)&&typeof c.successor_exists==='boolean'&&typeof c.intent_consumed==='boolean'&&(!c.intent_consumed||c.successor_exists));
 if(b.input){const q=captureClosureInput(b.input);check(q.command_id===b.commandId&&q.authorization_command_id===r.authorization_command_id&&q.expected_attempt_id===r.attempt_id&&q.expected_state===r.previous_state);}
 const out={...v,receipt:r,current:c};check(new TextEncoder().encode(JSON.stringify(out)).length<=MAX_CLOSURE_RESPONSE_BYTES);return freeze(out);
}
export const projectClosurePublic=(value,binding)=>project(value,binding,false);
export const projectClosureLedger=(value,binding)=>project(value,binding,true);
export function closurePublicFromLedger(value,binding){
 const v=projectClosureLedger(value,binding),{request_hash,...receipt}=v.receipt;return projectClosurePublic({...v,receipt},binding);
}
