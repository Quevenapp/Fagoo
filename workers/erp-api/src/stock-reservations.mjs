import {StockReservationsError,stockReservationsResponse} from '../../../packages/erp-domain/src/stock-reservations-dto.mjs';
export {StockReservationsError,stockReservationsResponse};
/** Explicit whole-order stock reservations. Composition authenticates the actor. No default RPC/network. */
const BASE='/v1/reservas-estoque',UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/;
const id=v=>typeof v==='string'&&UUID.test(v),hash=v=>typeof v==='string'&&HASH.test(v);
const ver=(v,min=1)=>Number.isInteger(v)&&v>=min&&v<=2147483647;
const text=(v,max,min=0)=>typeof v==='string'&&[...v].length<=max&&v.replace(/^ +| +$/g,'').length>=min&&!/[\x00-\x1f\x7f]/.test(v);
const obj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const day=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&v>='1900-01-01'&&Number.isFinite(Date.parse(`${v}T00:00:00Z`))&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v;
const need=(v,status=502,code='ERP_UPSTREAM_INVALID_RESPONSE')=>{if(!v)throw new StockReservationsError(status,code);};
const snap=v=>{need(obj(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)),400,'ERP_INVALID_QUERY');const out={};for(const k of Reflect.ownKeys(v)){const d=Object.getOwnPropertyDescriptor(v,k);need(typeof k==='string'&&d&&Object.hasOwn(d,'value'),400,'ERP_INVALID_QUERY');out[k]=d.value;}return out;};
async function body(request){
 need(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??''),415,'ERP_CONTENT_TYPE_UNSUPPORTED');
 need([null,'identity'].includes(request.headers.get('content-encoding')),415,'ERP_ENCODING_UNSUPPORTED');
 need(request.body&&(!request.headers.has('content-length')||(/^\d+$/.test(request.headers.get('content-length'))&&Number(request.headers.get('content-length'))<=16384)),413,'ERP_BODY_TOO_LARGE');
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true}),deadline=Date.now()+10000;let timer,size=0,source='',abort;
 const cancelled=new Promise((_,reject)=>{abort=()=>reject(new StockReservationsError(408,'ERP_REQUEST_TIMEOUT'));request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();});
 const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new StockReservationsError(408,'ERP_REQUEST_TIMEOUT')),10000);});
 try{while(true){need(!request.signal.aborted&&Date.now()<deadline,408,'ERP_REQUEST_TIMEOUT');const r=await Promise.race([reader.read(),timeout,cancelled]);need(!request.signal.aborted&&Date.now()<deadline,408,'ERP_REQUEST_TIMEOUT');if(r.done)break;need(r.value instanceof Uint8Array&&r.value.byteLength>0,400,'ERP_BODY_INVALID');size+=r.value.byteLength;need(size<=16384,413,'ERP_BODY_TOO_LARGE');source+=decoder.decode(r.value,{stream:true});}return JSON.parse(source+decoder.decode());}
 catch(e){if(e instanceof StockReservationsError)throw e;throw new StockReservationsError(400,'ERP_BODY_INVALID');}
 finally{clearTimeout(timer);request.signal.removeEventListener('abort',abort);try{void reader.cancel().catch(()=>{});}catch{}try{reader.releaseLock();}catch{}}
}
export function stockReservationsMethods(path){if(path!==BASE&&!path.startsWith(`${BASE}/`))return null;return /\/(preview|reserve|release-preview|release|consume-preview|consume)$/.test(path)?['POST']:['GET'];}
export async function parseStockReservationsRoute(request){
 const u=new URL(request.url);if(u.pathname!==BASE&&!u.pathname.startsWith(`${BASE}/`))return null;
 let action,args={};const m=new RegExp(`^${BASE}/pedidos/([a-f0-9-]+)(?:/(preview|reserve)|/([a-f0-9-]+)/(release-preview|release|consume-preview|consume))?$`).exec(u.pathname);
 if(u.pathname===`${BASE}/disponibilidade`){action='availability';}
 else if(new RegExp(`^${BASE}/comandos/([a-f0-9-]+)$`).test(u.pathname)){action='command';args.p_command_id=u.pathname.split('/').at(-1);need(id(args.p_command_id),404,'ERP_NOT_FOUND');}
 else if(m&&id(m[1])&&(!m[3]||id(m[3]))){action=m[2]??m[4]??'get';args.p_document_id=m[1];if(m[3])args.p_reservation_id=m[3];}
 else throw new StockReservationsError(404,'ERP_NOT_FOUND');
 const write=!['get','command','availability'].includes(action);need(request.method===(write?'POST':'GET'),405,'ERP_METHOD_NOT_ALLOWED');
 if(!write){const allowed=action==='get'?['limit','after']:action==='availability'?['product_id','warehouse_id']:[];for(const k of u.searchParams.keys())need(allowed.includes(k)&&u.searchParams.getAll(k).length===1,400,'ERP_INVALID_QUERY');
  if(action==='get'){const limit=u.searchParams.get('limit')??'25',after=u.searchParams.get('after');need(/^[1-9]\d?$/.test(limit)&&Number(limit)<=25&&(after===null||id(after)),400,'ERP_INVALID_QUERY');args.p_limit=Number(limit);args.p_after=after;}
  if(action==='availability'){for(const k of ['product_id','warehouse_id']){const v=u.searchParams.get(k);need(id(v),400,'ERP_INVALID_QUERY');args[`p_${k}`]=v;}}
 }else{
  need(!u.search,400,'ERP_INVALID_QUERY');const v=snap(await body(request)),mutation=['reserve','release','consume'].includes(action),closing=action.startsWith('release')||action.startsWith('consume');
  const keys=['expected_document_version','occurred_on','reason',...(closing?['expected_reservation_version']:[]),...(mutation?['command_id','preview_hash']:[]),...(action==='reserve'?['ignored_item_ids']:[])];
  need(Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)),400,'ERP_INVALID_QUERY');
  need(ver(v.expected_document_version)&&day(v.occurred_on)&&text(v.reason,500,3),400,'ERP_INVALID_QUERY');
  Object.assign(args,{p_expected_version:v.expected_document_version,p_occurred_on:v.occurred_on,p_reason:v.reason,p_action:closing?action.split('-')[0]:'reserve',p_reservation_id:args.p_reservation_id??null,p_reservation_version:null});
  if(closing){need(ver(v.expected_reservation_version),400,'ERP_INVALID_QUERY');args.p_reservation_version=v.expected_reservation_version;}
  if(mutation){need(id(v.command_id)&&hash(v.preview_hash),400,'ERP_INVALID_QUERY');Object.assign(args,{p_command_id:v.command_id,p_preview_hash:v.preview_hash,p_ignored_item_ids:null});}
  if(action==='reserve'){need(Array.isArray(v.ignored_item_ids)&&v.ignored_item_ids.length<=250&&v.ignored_item_ids.every(id)&&new Set(v.ignored_item_ids).size===v.ignored_item_ids.length,400,'ERP_INVALID_QUERY');args.p_ignored_item_ids=[...v.ignored_item_ids].sort();}
 }
 const rpc=action==='availability'?'erp_stock_availability':`erp_stock_reservation_${['reserve','release','consume'].includes(action)?'apply':action==='get'||action==='command'?action:'preview'}`;
 return Object.freeze({action,rpc,args:Object.freeze(args)});
}
export async function executeStockReservationsRoute(route,context){
 const c=snap(context);need(id(c.userId)&&typeof c.rpc==='function',403,'ERP_ACCESS_DENIED');const selected={action:route.action,rpc:route.rpc,args:structuredClone(route.args)},actor=c.userId,rpc=c.rpc,signal=c.signal;
 need(signal===undefined||signal instanceof AbortSignal,400,'ERP_INVALID_QUERY');
 const control=new AbortController(),deadline=Date.now()+15000;let timer;const cancel=()=>control.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
 const stopped=new Promise((_,reject)=>{control.signal.addEventListener('abort',()=>reject(new Error('STOPPED')),{once:true});timer=setTimeout(()=>control.abort(),15000);});stopped.catch(()=>{});
 const mutation=['reserve','release','consume'].includes(selected.action);let result;try{if(control.signal.aborted)throw new Error('STOPPED');result=await Promise.race([rpc(selected.rpc,{...selected.args,p_user_id:actor},{signal:control.signal,deadline}),stopped]);if(control.signal.aborted||Date.now()>=deadline)throw new Error('STOPPED');}catch(e){
 const known={ERP_FORBIDDEN:403,ERP_ACCESS_DENIED:403,ERP_INVALID_QUERY:400,ERP_NOT_FOUND:404,ERP_CONFLICT:409};if(Object.hasOwn(known,e?.code)&&e.status===known[e.code])throw new StockReservationsError(e.status,e.code==='ERP_FORBIDDEN'?'ERP_ACCESS_DENIED':e.code);
if(['42501','22023','P0002','40001','23505'].includes(e?.code))throw new StockReservationsError(({42501:403,22023:400,P0002:404,40001:409,23505:409})[e.code],({42501:'ERP_ACCESS_DENIED',22023:'ERP_INVALID_QUERY',P0002:'ERP_NOT_FOUND',40001:'ERP_CONFLICT',23505:'ERP_CONFLICT'})[e.code]);throw new StockReservationsError(503,mutation?'ERP_RESULT_UNCONFIRMED':'ERP_UPSTREAM_UNAVAILABLE');}finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);control.abort();}
 try{return stockReservationsResponse(result,selected);}catch(e){if(mutation)throw new StockReservationsError(503,'ERP_RESULT_UNCONFIRMED');throw e;}
}
