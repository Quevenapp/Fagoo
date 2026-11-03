import {PURCHASE_RECEIPTS_LIMITS,PurchaseReceiptsError,purchaseReceiptsResponse} from '../../../packages/erp-domain/src/purchase-receipts-dto.mjs';
export {PurchaseReceiptsError,purchaseReceiptsResponse};
/** Isolated 090 HTTP adapter. The composition authenticates; each RPC rechecks current ACL. */
const BASE='/v1/recebimentos-compras', UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const need=(ok,status=400,code='ERP_INVALID_QUERY')=>{if(!ok)throw new PurchaseReceiptsError(status,code);};
const id=v=>typeof v==='string'&&UUID.test(v), version=v=>Number.isInteger(v)&&v>0&&v<2147483647;
const day=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&v>='1900-01-01'&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
function object(v){need(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));const out={};for(const k of Reflect.ownKeys(v)){const d=Object.getOwnPropertyDescriptor(v,k);need(typeof k==='string'&&!['__proto__','constructor','prototype'].includes(k)&&d.enumerable&&Object.hasOwn(d,'value'));out[k]=d.value;}return out;}
function exact(v,keys){const out=object(v);need(Object.keys(out).length===keys.length&&keys.every(k=>Object.hasOwn(out,k)));return out;}
async function body(request){
 need(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??''),415,'ERP_CONTENT_TYPE_UNSUPPORTED');
 need([null,'identity'].includes(request.headers.get('content-encoding')),415,'ERP_ENCODING_UNSUPPORTED');
 const length=request.headers.get('content-length');need(request.body&&(length===null||/^\d+$/.test(length)&&Number(length)<=PURCHASE_RECEIPTS_LIMITS.requestBytes),413,'ERP_BODY_TOO_LARGE');
 const reader=request.body.getReader(),deadline=Date.now()+10000,decoder=new TextDecoder('utf-8',{fatal:true});let timer,abort,size=0,text='';
 const check=()=>need(!request.signal.aborted&&Date.now()<deadline,408,'ERP_REQUEST_TIMEOUT');
 const stop=new Promise((_,reject)=>{abort=()=>reject(new PurchaseReceiptsError(408,'ERP_REQUEST_TIMEOUT'));request.signal.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,10000);if(request.signal.aborted)abort();});stop.catch(()=>{});
 try{while(true){check();const r=await Promise.race([reader.read(),stop]);check();if(r.done)break;need(r.value instanceof Uint8Array&&r.value.byteLength>0,400,'ERP_BODY_INVALID');size+=r.value.byteLength;need(size<=PURCHASE_RECEIPTS_LIMITS.requestBytes,413,'ERP_BODY_TOO_LARGE');text+=decoder.decode(r.value,{stream:true});}const result=JSON.parse(text+decoder.decode());check();return result;}
 catch(e){if(e instanceof PurchaseReceiptsError)throw e;throw new PurchaseReceiptsError(400,'ERP_BODY_INVALID');}
 finally{clearTimeout(timer);request.signal.removeEventListener('abort',abort);try{void reader.cancel().catch(()=>{});}catch{}try{reader.releaseLock();}catch{}}
}
export function purchaseReceiptsMethods(path){if(path!==BASE&&!path.startsWith(BASE+'/'))return null;return /\/(preview|receive|reverse-preview|reverse)$/.test(path)?['POST']:['GET'];}
export async function parsePurchaseReceiptsRoute(request){
 const u=new URL(request.url);if(u.pathname!==BASE&&!u.pathname.startsWith(BASE+'/'))return null;
 need(!u.hash&&!/%|\\/.test(u.pathname),404,'ERP_NOT_FOUND');
 const cmd=new RegExp(`^${BASE}/comandos/([a-f0-9-]+)$`).exec(u.pathname),doc=new RegExp(`^${BASE}/([a-f0-9-]+)(?:/(preview|receive)|/([a-f0-9-]+)/(reverse-preview|reverse))?$`).exec(u.pathname);
 let action,args={};if(cmd&&id(cmd[1])){action='command';args.p_command_id=cmd[1];}else if(doc&&id(doc[1])&&(!doc[3]||id(doc[3]))){action=(doc[2]??doc[4]??'get').replace('-','_');args.p_document_id=doc[1];if(doc[3])args.p_receipt_id=doc[3];}else throw new PurchaseReceiptsError(404,'ERP_NOT_FOUND');
 const write=!['get','command'].includes(action),mutation=['receive','reverse'].includes(action);need(request.method===(write?'POST':'GET'),405,'ERP_METHOD_NOT_ALLOWED');
 if(!write){for(const k of u.searchParams.keys())need(action==='get'&&['limit','after','receipt_id'].includes(k)&&u.searchParams.getAll(k).length===1);if(action==='get'){const limit=u.searchParams.get('limit')??'25',after=u.searchParams.get('after'),receipt=u.searchParams.get('receipt_id');need(/^[1-9]\d?$/.test(limit)&&Number(limit)<=25&&(after===null||id(after))&&(receipt===null||id(receipt)));Object.assign(args,{p_limit:Number(limit),p_after:after,p_receipt_id:receipt});}}
 else{
  // 184 (estoque): optional warehouse_id of the receive preview/command, for an order without warehouse ("Lançar estoque" of the list).
  need(!u.search);const receive=['preview','receive'].includes(action),raw=await body(request),chosen=receive&&raw!==null&&typeof raw==='object'&&!Array.isArray(raw)&&Object.hasOwn(raw,'warehouse_id');
  const v=exact(raw,['expected_document_version','occurred_on','reason',...(receive?['items']:[]),...(chosen?['warehouse_id']:[]),...(mutation?['command_id','preview_hash','confirmed']:[])]);
  if(chosen){need(id(v.warehouse_id));args.p_warehouse_id=v.warehouse_id;}
  // 277 (estoque): the receive preview may come without a date: the recebimento is dated by the preference ("Ao lançar estoque utilizar data
  // atual ou data entrada/saída") and the confirmation carries the day of that preview.
  need(version(v.expected_document_version)&&(day(v.occurred_on)||action==='preview'&&v.occurred_on===null)&&typeof v.reason==='string'&&[...v.reason].length<=500&&v.reason.trim().length>=3&&!/[\x00-\x1f\x7f-\x9f]/.test(v.reason));
  Object.assign(args,{p_expected_version:v.expected_document_version,p_occurred_on:v.occurred_on,p_reason:v.reason.trim()});
  if(receive){need(Array.isArray(v.items)&&v.items.length>0&&v.items.length<=250);const seen=new Set();args.p_items=Object.freeze(v.items.map(raw=>{const i=exact(raw,['item_id','quantity']);need(id(i.item_id)&&!seen.has(i.item_id)&&typeof i.quantity==='string'&&/^(0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(i.quantity)&&BigInt(i.quantity.replace('.',''))>0n);seen.add(i.item_id);return Object.freeze(i);}));}
  if(mutation){need(id(v.command_id)&&typeof v.preview_hash==='string'&&/^[a-f0-9]{64}$/.test(v.preview_hash)&&v.confirmed===true);Object.assign(args,{p_command_id:v.command_id,p_preview_hash:v.preview_hash,p_confirm:true});}
 }
 return Object.freeze({action,rpc:args.p_warehouse_id?(action==='preview'?'erp_stock_purchase_receive_preview':'erp_stock_purchase_receive'):`erp_purchase_receipts_${action}`,args:Object.freeze(args)});
}
export async function executePurchaseReceiptsRoute(route,context){
 const c=object(context);need(id(c.userId)&&typeof c.rpc==='function',403,'ERP_ACCESS_DENIED');need(c.signal===undefined||c.signal instanceof AbortSignal);
 const selected={action:route.action,rpc:route.rpc,args:structuredClone(route.args)},actor=c.userId,rpc=c.rpc,signal=c.signal,control=new AbortController(),deadline=Date.now()+15000;
 const mutation=['receive','reverse'].includes(selected.action),cancel=()=>control.abort();let timer;
 signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
 const stop=new Promise((_,reject)=>{control.signal.addEventListener('abort',()=>reject(new Error('STOPPED')),{once:true});timer=setTimeout(cancel,15000);});stop.catch(()=>{});
 try{
  if(control.signal.aborted)throw new Error('STOPPED');const raw=await Promise.race([rpc(selected.rpc,{...selected.args,p_user_id:actor},{signal:control.signal,deadline}),stop]);
  if(control.signal.aborted||Date.now()>=deadline)throw new Error('STOPPED');
  let result;try{result=purchaseReceiptsResponse(raw,selected);}catch(e){if(mutation)throw new PurchaseReceiptsError(503,'ERP_RESULT_UNCONFIRMED');throw e;}
  if(control.signal.aborted||Date.now()>=deadline)throw new Error('STOPPED');return result;
 }catch(e){
  if(e instanceof PurchaseReceiptsError)throw e;
  const known={ERP_FORBIDDEN:403,ERP_ACCESS_DENIED:403,ERP_INVALID_QUERY:400,ERP_NOT_FOUND:404,ERP_CONFLICT:409};if(Object.hasOwn(known,e?.code)&&e.status===known[e.code])throw new PurchaseReceiptsError(e.status,e.code==='ERP_FORBIDDEN'?'ERP_ACCESS_DENIED':e.code);
  const sql={42501:[403,'ERP_ACCESS_DENIED'],22023:[400,'ERP_INVALID_QUERY'],P0002:[404,'ERP_NOT_FOUND'],40001:[409,'ERP_CONFLICT'],23505:[409,'ERP_CONFLICT']};if(Object.hasOwn(sql,e?.code))throw new PurchaseReceiptsError(...sql[e.code]);
  throw new PurchaseReceiptsError(503,mutation?'ERP_RESULT_UNCONFIRMED':'ERP_UPSTREAM_UNAVAILABLE');
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);control.abort();}
}
