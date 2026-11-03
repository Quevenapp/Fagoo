import {publicSource,publicResult,publicContext,publicHistory,pendingResolution,uuid} from '../../../../packages/fiscal-authorization/test/receipt-query-public-fixture.mjs';
import {captureFiscalReceiptQueryRequest} from '../../src/lib/fiscal-receipt-query-request.ts';
export {publicSource,publicResult,publicContext,publicHistory,uuid};
export const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
export function receiptQueryFixture({model='55',kind='authorization',ready=true,initial=[],before=()=>{},state='receipt_pending'}={}){
 const source=publicSource({model,kind}),{source_binding_hash,...reference}=source,listeners=new Set();
 const s={source,reference,actor:uuid(900),role:'fiscal',phase:'ready',calls:[],saved:new Map(initial.map(x=>[x.command_id,structuredClone(x)])),ready,state};
 const rows=()=>{const values=[...s.saved.values()].sort((a,b)=>b.receipt.ordinal-a.receipt.ordinal);const resolved=values.find(x=>['authorized_homologation','rejected'].includes(x.current.state))?.resolution??values.find(x=>x.current.state==='review_required')?.resolution??pendingResolution();return values.map(x=>({...structuredClone(x),read_only:true,replayed:true,resolution:structuredClone(resolved)}));};
 s.context=()=>{const history=rows();return publicContext({source:s.source,history,canQuery:s.ready&&(!history.length||history[0].resolution.state==='pending')});};
 s.notify=()=>listeners.forEach(fn=>fn());
 s.controller={getSnapshot:()=>({phase:s.phase,membership:s.actor?{user_id:s.actor,role:s.role}:null}),subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},async fiscalReceiptQuery(path,options={}){
  const captured=captureFiscalReceiptQueryRequest(path,options),call={path,...captured.options,kind:captured.binding.action,mutation:captured.mutation};s.calls.push(call);
  if(call.kind==='receiptQueryRun'){
   const value=publicResult({source:s.source,state:s.state,queryId:call.body.command_id,ordinal:s.saved.size+1,readOnly:false});value.current.can_recover=false;s.saved.set(value.command_id,value);
  }
  const overridden=await before(call,s);if(overridden!==undefined)return overridden;
  if(call.kind==='receiptQueryContext')return s.context();
  if(call.kind==='receiptQueryHistory'){const values=rows().filter(x=>call.body.before===null||x.receipt.ordinal<call.body.before);const page=publicHistory(values.slice(0,call.body.limit),{before:call.body.before,limit:call.body.limit});page.raw.next_before=values.length>call.body.limit?page.raw.items.at(-1).receipt.ordinal:null;return page.raw;}
  const id=captured.binding.commandId,row=rows().find(x=>x.command_id===id);if(!row)throw Object.assign(new Error('NOT_FOUND'),{status:404,recovery_required:false});
  return {...row,read_only:call.kind==='receiptQueryCommand',replayed:call.kind==='receiptQueryCommand'};
 }};
 return s;
}
