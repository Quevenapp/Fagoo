import{SalesReadinessError,parseSalesReadinessPage,parseSalesReadinessDetail,SALES_READINESS_MAX_BYTES}from'../../../packages/erp-domain/src/origin-sales-readiness-dto.mjs';
export{SalesReadinessError,SALES_READINESS_MAX_BYTES};
export const SALES_READINESS_BASE='/v1/vendas-origin-prontidao';
const routes=new WeakSet(),need=(v,status=400,code='ERP_INVALID_QUERY')=>{if(!v)throw new SalesReadinessError(status,code);};
const sid=v=>typeof v==='string'&&v.length<=40&&/^[1-9][0-9]*$/.test(v)&&!/[\r\n]/.test(v);
const uuid=v=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const plain=v=>{need(v&&typeof v==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));const out={};for(const k of Reflect.ownKeys(v)){const d=Object.getOwnPropertyDescriptor(v,k);need(typeof k==='string'&&d.enumerable&&Object.hasOwn(d,'value'));out[k]=d.value;}return out;};
export const salesReadinessRoute=path=>typeof path==='string'&&(path===SALES_READINESS_BASE||path.startsWith(SALES_READINESS_BASE+'/'));
export const salesReadinessMethods=path=>salesReadinessRoute(path)?['GET']:null;
/** Composition must verify the session; SQL independently requires current active admin. */
export function parseSalesReadinessRoute(request){
 need(request instanceof Request);const u=new URL(request.url);if(!salesReadinessRoute(u.pathname))return null;
 need(request.url.length<=4096&&!u.hash);need(request.method==='GET',405,'ERP_METHOD_NOT_ALLOWED');need(request.body===null&&(!request.headers.has('content-length')||request.headers.get('content-length')==='0'));
 let action,args,rpc;
 if(u.pathname===SALES_READINESS_BASE){
  for(const k of u.searchParams.keys())need(['limit','after','q'].includes(k)&&u.searchParams.getAll(k).length===1);
  const limit=u.searchParams.get('limit')??'25',after=u.searchParams.get('after'),q=u.searchParams.get('q');
  need(/^[1-9][0-9]?$/.test(limit)&&Number(limit)<=25&&(after===null||sid(after))&&(q===null||[...q].length<=100&&!/[\x00-\x1f\x7f-\x9f]/.test(q)));
  action='list';rpc='erp_origin_sales_readiness_sources';args={p_limit:Number(limit),p_after:after,p_query:q};
 }else{const id=u.pathname.slice(SALES_READINESS_BASE.length+1);need(sid(id),404,'ERP_NOT_FOUND');need(!u.search);action='detail';rpc='erp_origin_sales_readiness_detail';args={p_source_id:id};}
 const route=Object.freeze({action,rpc,args:Object.freeze(args)});routes.add(route);return route;
}
export async function executeSalesReadinessRoute(route,context){
 need(routes.has(route),404,'ERP_NOT_FOUND');const c=plain(context);need(Object.keys(c).every(k=>['userId','rpc','signal','timeoutMs'].includes(k)));need(uuid(c.userId)&&typeof c.rpc==='function',403,'ERP_ACCESS_DENIED');need(c.signal===undefined||c.signal instanceof AbortSignal);need(c.timeoutMs===undefined||Number.isInteger(c.timeoutMs)&&c.timeoutMs>0&&c.timeoutMs<=15000);
 // Everything crossing the first await is immutable or captured by identity.
 const actor=c.userId,rpc=c.rpc,signal=c.signal,args=Object.freeze({...route.args,p_user_id:actor}),action=route.action,name=route.rpc;
 const control=new AbortController(),timeout=c.timeoutMs??15000,deadline=Date.now()+timeout;let timer;const cancel=()=>control.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
 const aborted=new Promise((_,reject)=>{control.signal.addEventListener('abort',()=>reject(new SalesReadinessError(408,'ERP_REQUEST_TIMEOUT')),{once:true});timer=setTimeout(()=>control.abort(),timeout);});aborted.catch(()=>{});
 try{need(!control.signal.aborted,408,'ERP_REQUEST_TIMEOUT');const raw=await Promise.race([Promise.resolve().then(()=>{need(!control.signal.aborted&&Date.now()<deadline,408,'ERP_REQUEST_TIMEOUT');return rpc(name,args,{signal:control.signal,deadline});}),aborted]);need(!control.signal.aborted&&Date.now()<deadline,408,'ERP_REQUEST_TIMEOUT');return action==='list'?parseSalesReadinessPage(raw,{limit:args.p_limit,after:args.p_after}):parseSalesReadinessDetail(raw,{sourceId:args.p_source_id});}
 catch(e){if(e instanceof SalesReadinessError)throw e;const known={42501:[403,'ERP_ACCESS_DENIED'],22023:[400,'ERP_INVALID_QUERY'],P0002:[404,'ERP_NOT_FOUND'],ERP_ACCESS_DENIED:[403,'ERP_ACCESS_DENIED'],ERP_FORBIDDEN:[403,'ERP_ACCESS_DENIED'],ERP_NOT_FOUND:[404,'ERP_NOT_FOUND'],ERP_INVALID_QUERY:[400,'ERP_INVALID_QUERY']};const own=e&&typeof e==='object'?Object.getOwnPropertyDescriptor(e,'code'):null,match=own&&Object.hasOwn(own,'value')&&typeof own.value==='string'&&Object.hasOwn(known,own.value)&&known[own.value];if(match)throw new SalesReadinessError(...match);throw new SalesReadinessError(502,'ERP_UPSTREAM_UNAVAILABLE');}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);control.abort();}
}
