import type {NativeRequestOptions} from './real-access';

const BASE='/v1/importacao-financeira-origin';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function invalid():never{throw new Error('FINANCIAL_IMPORT_REQUEST_INVALID');}
function fields(value:unknown,allowed:string[],exact=false):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid();
 const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);
 if(keys.some(k=>typeof k!=='string'||!allowed.includes(k))||Object.values(descriptors).some(d=>!Object.hasOwn(d,'value'))||exact&&keys.length!==allowed.length)invalid();
 return Object.fromEntries(Object.entries(descriptors).map(([key,d])=>[key,d.value]));
}
/** Capture the exact nested intent before credential refresh can suspend dispatch. */
export function captureFinancialImportRequest(path:string,input:NativeRequestOptions={}){
 if(typeof path!=='string')invalid();
 const options=fields(input,['method','body','signal']),method=options.method??'GET',signal=options.signal;
 if(signal!==undefined&&!(signal instanceof AbortSignal))invalid();
 const apply=path===BASE+'/apply',write=apply||path===BASE+'/preview';
 const read=new RegExp(`^${BASE}/(?:batches/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|origins/(?:receivables|payables)/[0-9]{1,40})$`).test(path);
 if(write?method!=='POST'||options.body===undefined:!read||method!=='GET'||options.body!==undefined)invalid();
 let body:Record<string,unknown>|undefined;
 if(write){
  body=fields(options.body,['entity','duplicate_reviewed','items',...(apply?['command_id','preview_hash','confirm_import']:[])],true);
  if(!['receivables','payables'].includes(body.entity as string)||body.duplicate_reviewed!==true||!Array.isArray(body.items)||body.items.length<1||body.items.length>25)invalid();
  const descriptors=Object.getOwnPropertyDescriptors(body.items),length=body.items.length;
  if(Object.getPrototypeOf(body.items)!==Array.prototype||Reflect.ownKeys(body.items).length!==length+1||Object.values(descriptors).some(d=>!Object.hasOwn(d,'value')))invalid();
  const items:Record<string,unknown>[]=[],seen=new Set<string>();
  for(let index=0;index<length;index++){
   if(!Object.hasOwn(descriptors,String(index)))invalid();
   const item=fields(descriptors[String(index)].value,['source_id','source_hash','source_version','source_seen_at','category_id','category_version'],true);
   if(typeof item.source_id!=='string'||!/^\d{1,40}$/.test(item.source_id)||/^0+$/.test(item.source_id)||seen.has(item.source_id)
    ||typeof item.source_hash!=='string'||!/^[a-f0-9]{64}$/.test(item.source_hash)
    ||typeof item.source_version!=='string'||!/^[1-9]\d{0,18}$/.test(item.source_version)||BigInt(item.source_version)>9223372036854775807n
    ||typeof item.source_seen_at!=='string'||item.source_seen_at.length>40||!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})$/.test(item.source_seen_at)||!Number.isFinite(Date.parse(item.source_seen_at))
    ||!(item.category_id===null&&item.category_version===null||typeof item.category_id==='string'&&UUID.test(item.category_id)&&typeof item.category_version==='number'&&Number.isInteger(item.category_version)&&item.category_version>=1&&item.category_version<=2147483647))invalid();
   seen.add(item.source_id);items.push(Object.freeze(item));
  }
  body.items=Object.freeze(items);
  if(apply&&(typeof body.command_id!=='string'||!UUID.test(body.command_id)||typeof body.preview_hash!=='string'||!/^[a-f0-9]{64}$/.test(body.preview_hash)||body.confirm_import!==true))invalid();
  if(new TextEncoder().encode(JSON.stringify(body)).length>65536)invalid();
  Object.freeze(body);
 }
 return Object.freeze({base:BASE,path,options:Object.freeze({method:method as 'GET'|'POST',...(body?{body}:{}),...(signal?{signal:signal as AbortSignal}:{})})});
}
