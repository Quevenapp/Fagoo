// QA_SYNTHETIC_RECEIPT_QUERY_PROCESSED — local synthetic signed XML; no remote ports or credentials.
import fixtures from './receipt-query-processed-artifacts.json' with {type:'json'};
import {captureFiscalReceiptQueryRequest} from '../lib/fiscal-receipt-query-request.ts';
import {RECEIPT_QUERY_PUBLIC_FLAGS,projectReceiptQueryPublic,type ReceiptQueryPublicContext,type ReceiptQueryPublicResult} from '../../../../packages/fiscal-authorization/src/receipt-query-public-dto.mjs';
import {route} from '../../../../packages/fiscal-danfe-runtime/src/processed-protocol.mjs';
import {publicProcessedResult} from '../../../../packages/fiscal-danfe-runtime/src/processed-dto.mjs';
import type {ReceiptQueryController} from '../components/FiscalReceiptQueries';
import type {NativeRequestOptions} from '../lib/real-access';
export function createReceiptQueryProcessedQa({model='55',conflict=false,changed=()=>{}}:{model?:'55'|'65';conflict?:boolean;changed?:()=>void}={}){
 const data=structuredClone(fixtures.cases[model]),initial=projectReceiptQueryPublic(data.result,{action:'receiptQueryCommand',commandId:data.result.command_id}),{source_binding_hash,...reference}=initial.source,calls:{action:string;mutation:boolean}[]=[];
 if(conflict){const resolution={state:'conflict',resolution_hash:'f'.repeat(64),query_ids:[data.result.command_id,'30000000-0000-4000-8000-000000000099'],selected_query_id:null,protocol:null};Object.assign(data.result.resolution,resolution);Object.assign(data.context.resolution,resolution);data.context.history.forEach(v=>Object.assign(v.resolution,resolution));}
 const context=()=>projectReceiptQueryPublic(data.context,{action:'receiptQueryContext',input:{source_kind:reference.source_kind,source_command_id:reference.source_command_id,expected_attempt_id:reference.authorization_attempt_id}}) as ReceiptQueryPublicContext;
 const result=()=>projectReceiptQueryPublic(data.result,{action:'receiptQueryCommand',commandId:data.result.command_id}) as ReceiptQueryPublicResult;
 const controller={getSnapshot:()=>({phase:'ready',membership:{user_id:'30000000-0000-4000-8000-000000000900',role:'fiscal'}}),subscribe:()=>()=>{},async fiscalReceiptQuery(path:string,options:NativeRequestOptions={}){
  const captured=captureFiscalReceiptQueryRequest(path,options),b=captured.binding;if(captured.mutation)throw new Error('SYNTHETIC_MUTATION_DISABLED');calls.push({action:b.action,mutation:false});changed();
  if(b.action==='receiptQueryContext')return context();
  if(b.action==='receiptQueryCommand'&&b.commandId===data.result.command_id)return result();
  if(b.action==='receiptQueryHistory'){const c=context();return {...RECEIPT_QUERY_PUBLIC_FLAGS,kind:'history',read_only:true,can_query:false,authorization_command_id:reference.authorization_command_id,authorization_attempt_id:reference.authorization_attempt_id,observed_at:c.observed_at,chain_hash:c.chain_hash,resolution:c.resolution,items:[result()],next_before:null,limit:b.input.limit};}
  throw new Error('SYNTHETIC_ACTION_NOT_AVAILABLE');
 },async fiscalProcessedDocument(path:string,options:NativeRequestOptions={}){
  const selected=route(path,options.method??'GET','/v1/fiscal-danfe');if(options.body!==undefined||selected.sourceKind!=='receipt_query'||selected.commandId!==data.result.command_id||conflict)throw new Error('SYNTHETIC_DOCUMENT_NOT_AVAILABLE');calls.push({action:`processed_${selected.action}`,mutation:false});changed();return publicProcessedResult(data[selected.action],{sourceKind:'receipt_query',commandId:selected.commandId,action:selected.action});
 }} as unknown as ReceiptQueryController;
 return{reference,controller,calls,context};
}
