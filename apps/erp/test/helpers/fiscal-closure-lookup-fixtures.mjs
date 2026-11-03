import {setup,history} from './fiscal-reviewed-authorization-fixtures.mjs';
import {original,closed} from './fiscal-closure-fixtures.mjs';
export function lookupFixture({model='55',before=()=>{}}={}){
 const s=setup({model,before:async(call,s)=>{if(call.path.endsWith('/closure'))call.kind='closureLookup';const value=await before(call,s);if(value!==undefined)return value;if(call.kind==='history')return history(s.candidate,[s.failed]);if(call.kind==='closureLookup')return closed(s.original);return s.failed;}});
 s.original=original(s.candidate,'request_ready');const receipt=closed(s.original);s.failed={...structuredClone(s.original),status:'failed_before_dispatch',error_code:'PREPARATION_FAILED',recoverable_by_actor:false,current:{...s.original.current,state:'failed_before_dispatch',finished_at:receipt.receipt.closed_at}};return s;
}
