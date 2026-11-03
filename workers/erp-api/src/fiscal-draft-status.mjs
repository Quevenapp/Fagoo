import{FiscalDraftStatusError,parseFiscalDraftStatusPage,FISCAL_DRAFT_STATUS_MAX_BYTES}from'../../../packages/erp-domain/src/fiscal-draft-status-dto.mjs';
export{FiscalDraftStatusError,FISCAL_DRAFT_STATUS_MAX_BYTES};
export const FISCAL_DRAFT_STATUS_BASE='/v1/rascunhos-fiscais/resumo';
const routes=new WeakSet(),need=(v,status=400,code='ERP_INVALID_QUERY')=>{if(!v)throw new FiscalDraftStatusError(status,code);};
const uuid=v=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const plain=v=>{need(v&&typeof v==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));const out={};for(const k of Reflect.ownKeys(v)){const d=Object.getOwnPropertyDescriptor(v,k);need(typeof k==='string'&&d.enumerable&&Object.hasOwn(d,'value'));out[k]=d.value;}return out;};
export const fiscalDraftStatusRoute=path=>typeof path==='string'&&(path===FISCAL_DRAFT_STATUS_BASE||path.startsWith(FISCAL_DRAFT_STATUS_BASE+'/'));
export const fiscalDraftStatusMethods=path=>fiscalDraftStatusRoute(path)?['GET']:null;
export function parseFiscalDraftStatusRoute(request){
 need(request instanceof Request);const u=new URL(request.url);if(!fiscalDraftStatusRoute(u.pathname))return null;
 need(u.pathname===FISCAL_DRAFT_STATUS_BASE,404,'ERP_NOT_FOUND');need(request.url.length<=4096&&!u.hash);need(request.method==='GET',405,'ERP_METHOD_NOT_ALLOWED');need(request.body===null&&(!request.headers.has('content-length')||request.headers.get('content-length')==='0'));
 for(const k of u.searchParams.keys())need(['model','status','source_document_id','limit','after'].includes(k)&&u.searchParams.getAll(k).length===1);
 const model=u.searchParams.get('model'),status=u.searchParams.get('status'),sourceDocumentId=u.searchParams.get('source_document_id'),after=u.searchParams.get('after'),limit=u.searchParams.get('limit')??'25';
 need([null,'55','65'].includes(model)&&[null,'draft','archived'].includes(status)&&(sourceDocumentId===null||uuid(sourceDocumentId))&&(after===null||uuid(after))&&/^[1-9][0-9]?$/.test(limit)&&Number(limit)<=25);
 const route=Object.freeze({action:'list',rpc:'erp_fiscal_draft_status_list',args:Object.freeze({p_model:model,p_status:status,p_source_document_id:sourceDocumentId,p_limit:Number(limit),p_after:after}),query:Object.freeze({model,status,sourceDocumentId,limit:Number(limit),after})});routes.add(route);return route;
}
/** Session verification belongs to composition; the RPC independently checks active admin/fiscal. */
export async function executeFiscalDraftStatusRoute(route,context){
 need(routes.has(route),404,'ERP_NOT_FOUND');const c=plain(context);need(Object.keys(c).every(k=>['userId','rpc','signal','timeoutMs'].includes(k)));need(uuid(c.userId)&&typeof c.rpc==='function',403,'ERP_ACCESS_DENIED');need(c.signal===undefined||c.signal instanceof AbortSignal);need(c.timeoutMs===undefined||Number.isInteger(c.timeoutMs)&&c.timeoutMs>0&&c.timeoutMs<=15000);
 const actor=c.userId,rpc=c.rpc,signal=c.signal,args=Object.freeze({...route.args,p_user_id:actor}),query=route.query,name=route.rpc;
 const control=new AbortController(),timeout=c.timeoutMs??15000,deadline=Date.now()+timeout;let timer;const cancel=()=>control.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
 const aborted=new Promise((_,reject)=>{control.signal.addEventListener('abort',()=>reject(new FiscalDraftStatusError(408,'ERP_REQUEST_TIMEOUT')),{once:true});timer=setTimeout(()=>control.abort(),timeout);});aborted.catch(()=>{});
 try{need(!control.signal.aborted,408,'ERP_REQUEST_TIMEOUT');const raw=await Promise.race([Promise.resolve().then(()=>{need(!control.signal.aborted&&Date.now()<deadline,408,'ERP_REQUEST_TIMEOUT');return rpc(name,args,{signal:control.signal,deadline});}),aborted]);need(!control.signal.aborted&&Date.now()<deadline,408,'ERP_REQUEST_TIMEOUT');const out=parseFiscalDraftStatusPage(raw,query);need(!control.signal.aborted&&Date.now()<deadline,408,'ERP_REQUEST_TIMEOUT');return out;}
 catch(e){if(e instanceof FiscalDraftStatusError)throw e;const known={42501:[403,'ERP_ACCESS_DENIED'],22023:[400,'ERP_INVALID_QUERY'],P0002:[404,'ERP_NOT_FOUND'],ERP_ACCESS_DENIED:[403,'ERP_ACCESS_DENIED'],ERP_FORBIDDEN:[403,'ERP_ACCESS_DENIED'],ERP_NOT_FOUND:[404,'ERP_NOT_FOUND'],ERP_INVALID_QUERY:[400,'ERP_INVALID_QUERY']};const own=e&&typeof e==='object'?Object.getOwnPropertyDescriptor(e,'code'):null,match=own&&Object.hasOwn(own,'value')&&typeof own.value==='string'&&Object.hasOwn(known,own.value)&&known[own.value];if(match)throw new FiscalDraftStatusError(...match);throw new FiscalDraftStatusError(502,'ERP_UPSTREAM_UNAVAILABLE');}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);control.abort();}
}
