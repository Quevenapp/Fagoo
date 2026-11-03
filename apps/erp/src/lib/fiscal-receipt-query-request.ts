import {captureReceiptQueryContextInput,captureReceiptQueryHistoryInput,captureReceiptQueryRunInput,captureReceiptQueryRecoverInput,MAX_RECEIPT_QUERY_INPUT_BYTES,MAX_RECEIPT_QUERY_PUBLIC_BYTES,type ReceiptQueryPublicBinding} from '../../../../packages/fiscal-authorization/src/receipt-query-public-dto.mjs';
import type {NativeRequestOptions} from './real-access';
const BASE='/v1/fiscal-authorization/reviewed',UUID='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const invalid=():never=>{throw new Error('RECEIPT_QUERY_INPUT_INVALID');};
/** Snapshot before credential refresh. Two POST routes are read-only; method alone is not a mutation classification. */
export function captureFiscalReceiptQueryRequest(path:string,raw:NativeRequestOptions={}){
 if(typeof path!=='string'||/[?#%\\]/.test(path)||!raw||typeof raw!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(raw)))invalid();
 const ds=Object.getOwnPropertyDescriptors(raw);if(Reflect.ownKeys(ds).some(k=>typeof k!=='string'||!['method','body','signal'].includes(k))||Object.values(ds).some(d=>!Object.hasOwn(d,'value')||!d.enumerable))invalid();
 const method=ds.method?.value??'GET',signal=ds.signal?.value;if(signal!==undefined&&!(signal instanceof AbortSignal))invalid();
 let binding:ReceiptQueryPublicBinding,body:Readonly<object>|undefined,mutation=false;
 const command=new RegExp(`^${BASE}/receipt-query-commands/(${UUID})(/recover)?$`).exec(path);
 if(command&&!command[2]){if(method!=='GET'||ds.body)invalid();binding={action:'receiptQueryCommand',commandId:command[1]};}
 else{
  if(method!=='POST')invalid();
  if(path===BASE+'/receipt-query-context'){body=captureReceiptQueryContextInput(ds.body?.value);binding={action:'receiptQueryContext',input:body as ReturnType<typeof captureReceiptQueryContextInput>};}
  else if(path===BASE+'/receipt-query-history'){body=captureReceiptQueryHistoryInput(ds.body?.value);binding={action:'receiptQueryHistory',input:body as ReturnType<typeof captureReceiptQueryHistoryInput>};}
  else if(path===BASE+'/receipt-queries'){const input=captureReceiptQueryRunInput(ds.body?.value);body=input;mutation=true;binding={action:'receiptQueryRun',commandId:input.command_id,input};}
  else if(command?.[2]){const input=captureReceiptQueryRecoverInput(ds.body?.value);body=input;mutation=true;binding={action:'receiptQueryRecover',commandId:command[1],input};}
  else return invalid();
 }
 return Object.freeze({path,mutation,binding:Object.freeze(binding),requestLimit:MAX_RECEIPT_QUERY_INPUT_BYTES,responseLimit:MAX_RECEIPT_QUERY_PUBLIC_BYTES,timeoutMs:45000,options:Object.freeze({method:method as 'GET'|'POST',...(body?{body}:{}),...(signal?{signal:signal as AbortSignal}:{})})});
}
