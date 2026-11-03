const BASE='/v1/recebimentos-compras',UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export interface PurchaseReceiptsRequestOptions{method?:'GET'|'POST';body?:unknown;signal?:AbortSignal}
function invalid():never{throw new Error('PURCHASE_RECEIPTS_REQUEST_INVALID');}
function object(v:unknown,keys:string[],exact=false):Record<string,unknown>{
 if(!v||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))invalid();
 const ds=Object.getOwnPropertyDescriptors(v),own=Reflect.ownKeys(v);if(own.some(k=>typeof k!=='string'||!keys.includes(k))||Object.values(ds).some(d=>!d.enumerable||!Object.hasOwn(d,'value'))||exact&&own.length!==keys.length)invalid();
 return Object.fromEntries(Object.entries(ds).map(([k,d])=>[k,d.value]));
}
const id=(v:unknown):v is string=>typeof v==='string'&&UUID.test(v);
/** Capture before credential refresh/await; no caller array, getter, or body survives. */
export function capturePurchaseReceiptsRequest(path:string,options:PurchaseReceiptsRequestOptions={}){
 if(typeof path!=='string'||/[#%\\]/.test(path))invalid();const [pathname,query,...extra]=path.split('?');if(extra.length)invalid();
 const o=object(options,['method','body','signal']),method=o.method??'GET',signal=o.signal;if(signal!==undefined&&!(signal instanceof AbortSignal))invalid();
 const c=new RegExp(`^${BASE}/comandos/([a-f0-9-]+)$`).exec(pathname),d=new RegExp(`^${BASE}/([a-f0-9-]+)(?:/(preview|receive)|/([a-f0-9-]+)/(reverse-preview|reverse))?$`).exec(pathname);
 if(c?!id(c[1]):!d||!id(d[1])||d[3]&&!id(d[3]))invalid();
 const action=c?'command':d?.[2]??d?.[4]??'get',write=!['get','command'].includes(action),params=new URLSearchParams(query);let body:Record<string,unknown>|undefined;
 for(const k of params.keys())if(params.getAll(k).length!==1)invalid();
 if(!write){if(method!=='GET'||o.body!==undefined)invalid();for(const k of params.keys())if(action!=='get'||!['limit','after','receipt_id'].includes(k))invalid();const limit=params.get('limit');if(limit!==null&&(!/^[1-9]\d?$/.test(limit)||Number(limit)>25)||['after','receipt_id'].some(k=>params.has(k)&&!id(params.get(k))))invalid();}
 else{
  if(method!=='POST'||query!==undefined)invalid();const receive=['preview','receive'].includes(action),mutation=['receive','reverse'].includes(action);
  // 184 (estoque): the warehouse chosen in "Lançar estoque" of an order without warehouse travels with the receive preview and command.
  const chosen=receive&&o.body!==null&&typeof o.body==='object'&&!Array.isArray(o.body)&&Object.hasOwn(o.body as object,'warehouse_id');
  body=object(o.body,['expected_document_version','occurred_on','reason',...(receive?['items']:[]),...(chosen?['warehouse_id']:[]),...(mutation?['command_id','preview_hash','confirmed']:[])],true);
  if(chosen&&!id(body.warehouse_id))invalid();
  const v=body.expected_document_version,day=body.occurred_on,reason=body.reason;
  // 277 (estoque): a receive preview may go without a date (dated by Preferências › Suprimentos › Estoque).
  const dateless=action==='preview'&&day===null;
  if(typeof v!=='number'||!Number.isInteger(v)||v<1||v>=2147483647||!dateless&&(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)||day<'1900-01-01'||!Number.isFinite(Date.parse(day+'T00:00:00Z'))||new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day)||typeof reason!=='string'||reason.trim().length<3||[...reason].length>500||/[\x00-\x1f\x7f-\x9f]/.test(reason))invalid();
  body.reason=reason.trim();
  if(receive){const items=body.items;if(!Array.isArray(items)||Object.getPrototypeOf(items)!==Array.prototype||items.length<1||items.length>250)invalid();const ds=Object.getOwnPropertyDescriptors(items);if(Reflect.ownKeys(items).length!==items.length+1||Object.values(ds).some(d=>!Object.hasOwn(d,'value')))invalid();const seen=new Set();
   body.items=Object.freeze(Array.from({length:items.length},(_,index)=>{const desc=ds[String(index)];if(!desc)invalid();const i=object(desc.value,['item_id','quantity'],true);if(!id(i.item_id)||seen.has(i.item_id)||typeof i.quantity!=='string'||!/^(0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(i.quantity)||BigInt(i.quantity.replace('.',''))<=0n)invalid();seen.add(i.item_id);return Object.freeze(i);}));
  }
  if(mutation&&(!id(body.command_id)||typeof body.preview_hash!=='string'||!/^[a-f0-9]{64}$/.test(body.preview_hash)||body.confirmed!==true))invalid();
  if(new TextEncoder().encode(JSON.stringify(body)).length>131072)invalid();Object.freeze(body);
 }
 return Object.freeze({base:BASE,path,write,options:Object.freeze({method:method as 'GET'|'POST',...(body?{body}:{}),...(signal?{signal:signal as AbortSignal}:{})})});
}
