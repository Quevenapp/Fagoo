import type {NativeRequestOptions} from './real-access';
const BASE='/v1/reservas-estoque',UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function invalid():never{throw new Error('STOCK_RESERVATION_REQUEST_INVALID');}
function fields(value:unknown,allowed:string[],exact=false):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid();
 const ds=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);if(keys.some(k=>typeof k!=='string'||!allowed.includes(k))||Object.values(ds).some(d=>!Object.hasOwn(d,'value'))||exact&&keys.length!==allowed.length)invalid();return Object.fromEntries(Object.entries(ds).map(([k,d])=>[k,d.value]));
}
const id=(v:unknown)=>typeof v==='string'&&UUID.test(v),version=(v:unknown)=>typeof v==='number'&&Number.isInteger(v)&&v>0&&v<=2147483647;
/** Snapshot the exact intent before credential refresh can suspend dispatch. */
export function captureStockReservationsRequest(path:string,input:NativeRequestOptions={}){
 if(typeof path!=='string'||path.includes('#')||path.includes('\\')||/%/i.test(path))invalid();
 const options=fields(input,['method','body','signal']),method=options.method??'GET',signal=options.signal;if(signal!==undefined&&!(signal instanceof AbortSignal))invalid();
 const [pathname,query,...extra]=path.split('?');if(extra.length)invalid();const params=new URLSearchParams(query);for(const k of params.keys())if(params.getAll(k).length!==1)invalid();
 const order=new RegExp(`^${BASE}/pedidos/([a-f0-9-]+)(?:/(preview|reserve)|/([a-f0-9-]+)/(release-preview|release|consume-preview|consume))?$`).exec(pathname),command=new RegExp(`^${BASE}/comandos/([a-f0-9-]+)$`).exec(pathname),availability=pathname===BASE+'/disponibilidade';
 if(order? !id(order[1])||order[3]&&!id(order[3]):command?!id(command[1]):!availability)invalid();
 const action=order?.[2]??order?.[4],write=Boolean(action);let body:Record<string,unknown>|undefined;
 if(write){
  if(method!=='POST'||query!==undefined)invalid();const closing=Boolean(order?.[3]),mutation=['reserve','release','consume'].includes(action!);
  body=fields(options.body,['expected_document_version','occurred_on','reason',...(closing?['expected_reservation_version']:[]),...(mutation?['command_id','preview_hash']:[]),...(action==='reserve'?['ignored_item_ids']:[])],true);
  if(!version(body.expected_document_version)||typeof body.occurred_on!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(body.occurred_on)||body.occurred_on<'1900-01-01'||!Number.isFinite(Date.parse(body.occurred_on))||new Date(body.occurred_on+'T00:00:00Z').toISOString().slice(0,10)!==body.occurred_on||typeof body.reason!=='string'||[...body.reason].length>500||body.reason.trim().length<3||/[\x00-\x1f\x7f]/.test(body.reason)||closing&&!version(body.expected_reservation_version)||mutation&&(!id(body.command_id)||typeof body.preview_hash!=='string'||!/^[a-f0-9]{64}$/.test(body.preview_hash)))invalid();
  if(action==='reserve'){
   const rows=body.ignored_item_ids;if(!Array.isArray(rows)||rows.length>250||Object.getPrototypeOf(rows)!==Array.prototype)invalid();const ds=Object.getOwnPropertyDescriptors(rows);if(Reflect.ownKeys(rows).length!==rows.length+1||Object.values(ds).some(d=>!Object.hasOwn(d,'value')))invalid();
   const ids=Array.from({length:rows.length},(_,i)=>{const d=ds[String(i)];if(!d||!id(d.value))invalid();return d.value as string;});if(new Set(ids).size!==ids.length)invalid();body.ignored_item_ids=Object.freeze(ids);
  }
  if(new TextEncoder().encode(JSON.stringify(body)).length>16384)invalid();Object.freeze(body);
 }else{
  if(method!=='GET'||options.body!==undefined)invalid();const allowed=availability?['product_id','warehouse_id']:order?['limit','after']:[];for(const k of params.keys())if(!allowed.includes(k))invalid();
  if(availability&&(!id(params.get('product_id'))||!id(params.get('warehouse_id'))))invalid();if(order){const limit=params.get('limit');if(limit!==null&&(!/^[1-9]\d?$/.test(limit)||Number(limit)>25)||params.has('after')&&!id(params.get('after')))invalid();}
 }
 return Object.freeze({base:BASE,path,write,options:Object.freeze({method:method as 'GET'|'POST',...(body?{body}:{}),...(signal?{signal:signal as AbortSignal}:{})})});
}
