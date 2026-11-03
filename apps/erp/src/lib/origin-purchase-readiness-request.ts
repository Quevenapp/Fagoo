import type {NativeRequestOptions} from './real-access';

export const PURCHASE_READINESS_BASE='/v1/compras-origin-prontidao';
export const PURCHASE_READINESS_RESPONSE_BYTES=1024*1024;
export const purchaseSourceId=(value:unknown):value is string=>typeof value==='string'&&/^[1-9][0-9]{0,39}$/.test(value)&&!/[\r\n]/.test(value);
const invalid=():never=>{throw new Error('PURCHASE_READINESS_REQUEST_INVALID');};
const queryText=(value:string)=>Array.from(value).length<=100&&!/[\x00-\x1f\x7f-\x9f]/.test(value);

/** GET-only, captured synchronously before a caller can wait for token refresh. */
export function capturePurchaseReadinessRequest(path:string,input:NativeRequestOptions={}){
 if(typeof path!=='string'||!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return invalid();
 const fields=Object.getOwnPropertyDescriptors(input),keys=Reflect.ownKeys(fields);
 if(keys.some(key=>typeof key!=='string'||!['method','body','signal'].includes(key)||!fields[key].enumerable||!Object.hasOwn(fields[key],'value')))return invalid();
 const method=fields.method?.value??'GET',body=fields.body?.value,signal=fields.signal?.value;
 if(method!=='GET'||body!==undefined||signal!==undefined&&!(signal instanceof AbortSignal))return invalid();
 const base=PURCHASE_READINESS_BASE;
 let sourceId:string|null=null;
 if(path===base||path.startsWith(base+'?')){
  if(path.includes('#'))return invalid();
  const query=new URLSearchParams(path.slice(base.length+1));
  for(const key of query.keys()){
   const value=query.get(key)!;
   if(!['limit','after','q'].includes(key)||query.getAll(key).length!==1||key==='limit'&&(!/^[1-9][0-9]?$/.test(value)||value!==String(Number(value))||Number(value)>25)||key==='after'&&!purchaseSourceId(value)||key==='q'&&!queryText(value))return invalid();
  }
 }else if(path.startsWith(base+'/')&&purchaseSourceId(path.slice(base.length+1)))sourceId=path.slice(base.length+1);
 else return invalid();
 return Object.freeze({base,path,sourceId,options:Object.freeze({method:'GET' as const,...(signal?{signal:signal as AbortSignal}:{})})});
}

export function purchaseReadinessListPath(query:string,after:string|null=null){
 if(typeof query!=='string'||!queryText(query)||after!==null&&!purchaseSourceId(after))return invalid();
 const params=new URLSearchParams({limit:'25'}),clean=query.trim();if(clean)params.set('q',clean);if(after)params.set('after',after);
 return `${PURCHASE_READINESS_BASE}?${params}`;
}
export function purchaseReadinessDetailPath(sourceId:string){if(!purchaseSourceId(sourceId))return invalid();return`${PURCHASE_READINESS_BASE}/${sourceId}`;}
