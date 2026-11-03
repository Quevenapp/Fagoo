import type {NativeRequestOptions} from './real-access';
import type {FiscalFilters} from './fiscal-drafts-model';

export const FISCAL_DRAFT_STATUS_BASE='/v1/rascunhos-fiscais';
export const FISCAL_DRAFT_STATUS_PATH=`${FISCAL_DRAFT_STATUS_BASE}/resumo`;
export const FISCAL_DRAFT_STATUS_RESPONSE_BYTES=262144;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const invalid=():never=>{throw new Error('FISCAL_DRAFT_STATUS_REQUEST_INVALID');};

/** This reader cannot inherit the write methods of the existing draft editor. */
export function captureFiscalDraftStatusRequest(path:string,input:NativeRequestOptions={}){
 if(typeof path!=='string'||!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return invalid();
 const fields=Object.getOwnPropertyDescriptors(input);
 if(Reflect.ownKeys(fields).some(key=>typeof key!=='string'||!['method','body','signal'].includes(key)||!fields[key].enumerable||!Object.hasOwn(fields[key],'value')))return invalid();
 const method=fields.method?.value??'GET',body=fields.body?.value,signal=fields.signal?.value;
 if(method!=='GET'||body!==undefined||signal!==undefined&&!(signal instanceof AbortSignal))return invalid();
 if(path!==FISCAL_DRAFT_STATUS_PATH&&!path.startsWith(`${FISCAL_DRAFT_STATUS_PATH}?`)||path.includes('#'))return invalid();
 const params=new URLSearchParams(path.slice(FISCAL_DRAFT_STATUS_PATH.length+1));
 for(const key of params.keys()){
  const value=params.get(key)!;
  if(!['model','status','source_document_id','limit','after'].includes(key)||params.getAll(key).length!==1
   ||key==='model'&&!['55','65'].includes(value)||key==='status'&&!['draft','archived'].includes(value)
   ||key==='limit'&&(!/^[1-9][0-9]?$/.test(value)||Number(value)>25)||['after','source_document_id'].includes(key)&&!UUID.test(value))return invalid();
 }
 return Object.freeze({base:FISCAL_DRAFT_STATUS_BASE,path,options:Object.freeze({method:'GET' as const,...(signal?{signal:signal as AbortSignal}:{})})});
}

export function fiscalDraftStatusPath(filters:FiscalFilters,after:string|null=null,sourceDocumentId:string|null=null){
 if(!filters||!['','55','65'].includes(filters.model)||!['','draft','archived'].includes(filters.status)||after!==null&&!UUID.test(after)||sourceDocumentId!==null&&!UUID.test(sourceDocumentId))return invalid();
 const params=new URLSearchParams({limit:'25'});if(filters.model)params.set('model',filters.model);if(filters.status)params.set('status',filters.status);if(after)params.set('after',after);
 if(sourceDocumentId)params.set('source_document_id',sourceDocumentId);
 return`${FISCAL_DRAFT_STATUS_PATH}?${params}`;
}
