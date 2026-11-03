import type {NativeRequestOptions} from './real-access';
import type {SalesHistoryId} from '../../../../packages/erp-domain/src/origin-sales-history-dto.mjs';

export const SALES_HISTORY_BASE='/v1/historico-vendas-origin';
export const SALES_HISTORY_RESPONSE_BYTES=1048576;
export const salesHistoryId=(value:unknown):value is SalesHistoryId=>typeof value==='string'&&value.length===40&&/^bsh_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const invalid=():never=>{throw new Error('SALES_HISTORY_REQUEST_INVALID');};
const queryText=(value:string)=>[...value].length<=100&&!/[\x00-\x1f\x7f-\x9f]/.test(value);

/** This UI can read lists/details only; no capture, command, or native-document route. */
export function captureSalesHistoryRequest(path:string,input:NativeRequestOptions={}){
 if(typeof path!=='string'||path.length>4096||!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return invalid();
 const fields=Object.getOwnPropertyDescriptors(input);
 if(Reflect.ownKeys(fields).some(key=>typeof key!=='string'||!['method','body','signal'].includes(key)||!fields[key].enumerable||!Object.hasOwn(fields[key],'value')))return invalid();
 const method=fields.method?.value??'GET',body=fields.body?.value,signal=fields.signal?.value;
 if(method!=='GET'||body!==undefined||signal!==undefined&&!(signal instanceof AbortSignal))return invalid();
 let historyId:SalesHistoryId|null=null;
 if(path===SALES_HISTORY_BASE||path.startsWith(SALES_HISTORY_BASE+'?')){
  if(path.includes('#'))return invalid();
  const query=new URLSearchParams(path.slice(SALES_HISTORY_BASE.length+1));
  for(const key of query.keys()){
   const value=query.get(key)!;
   if(!['limit','after','q'].includes(key)||query.getAll(key).length!==1||key==='limit'&&(!/^[1-9][0-9]?$/.test(value)||Number(value)>25)||key==='after'&&!salesHistoryId(value)||key==='q'&&!queryText(value))return invalid();
  }
 }else if(path.startsWith(SALES_HISTORY_BASE+'/')&&salesHistoryId(path.slice(SALES_HISTORY_BASE.length+1)))historyId=path.slice(SALES_HISTORY_BASE.length+1) as SalesHistoryId;
 else return invalid();
 return Object.freeze({path,historyId,options:Object.freeze({method:'GET' as const,...(signal?{signal:signal as AbortSignal}:{})})});
}
export function salesHistoryListPath(query:string,after:SalesHistoryId|null=null){
 if(typeof query!=='string'||!queryText(query)||after!==null&&!salesHistoryId(after))return invalid();
 const params=new URLSearchParams({limit:'25'});if(query.trim())params.set('q',query.trim());if(after)params.set('after',after);
 return`${SALES_HISTORY_BASE}?${params}`;
}
export function salesHistoryDetailPath(id:SalesHistoryId){if(!salesHistoryId(id))return invalid();return`${SALES_HISTORY_BASE}/${id}`;}
