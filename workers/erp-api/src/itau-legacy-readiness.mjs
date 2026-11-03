import {ItauLegacyReadinessError,captureItauLegacyFilters,parseItauLegacyPage,ITAU_LEGACY_MAX_BYTES} from '../../../packages/erp-domain/src/itau-legacy-readiness-dto.mjs';
export {ItauLegacyReadinessError,ITAU_LEGACY_MAX_BYTES};
export const ITAU_LEGACY_BASE='/v1/cobrancas-legadas-itau';
const routes=new WeakSet(),need=(v,status=400,code='ERP_INVALID_QUERY')=>{if(!v)throw new ItauLegacyReadinessError(status,code);};
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const data=v=>{need(v&&typeof v==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));const d=Object.getOwnPropertyDescriptors(v);need(Reflect.ownKeys(d).every(k=>typeof k==='string'&&d[k].enumerable&&Object.hasOwn(d[k],'value')));return Object.fromEntries(Object.keys(d).map(k=>[k,d[k].value]));};
export const itauLegacyReadinessRoute=path=>path===ITAU_LEGACY_BASE;
export const itauLegacyReadinessMethods=path=>itauLegacyReadinessRoute(path)?['GET']:null;
export function parseItauLegacyReadinessRoute(request){
 need(request instanceof Request);const u=new URL(request.url);if(!itauLegacyReadinessRoute(u.pathname))return null;
 need(request.method==='GET',405,'ERP_METHOD_NOT_ALLOWED');need(request.url.length<=4096&&!u.hash&&request.body===null&&(!request.headers.has('content-length')||request.headers.get('content-length')==='0'));
 for(const key of u.searchParams.keys())need(['status','bank_reference','limit','after'].includes(key)&&u.searchParams.getAll(key).length===1);
 const limit=u.searchParams.get('limit')??'25';need(/^[1-9][0-9]?$/.test(limit));
 const filters=captureItauLegacyFilters({status:u.searchParams.get('status')??'open_partial',bank_reference:u.searchParams.get('bank_reference')??'all',limit:Number(limit),after:u.searchParams.get('after')});
 const selected=Object.freeze({filters});routes.add(selected);return selected;
}
export async function executeItauLegacyReadinessRoute(selected,context){
 need(routes.has(selected),404,'ERP_NOT_FOUND');const c=data(context);need(Object.keys(c).every(k=>['userId','rpc','signal','timeoutMs'].includes(k)));need(uuid(c.userId)&&typeof c.rpc==='function',403,'ERP_ACCESS_DENIED');need(c.signal===undefined||c.signal instanceof AbortSignal);need(c.timeoutMs===undefined||Number.isInteger(c.timeoutMs)&&c.timeoutMs>0&&c.timeoutMs<=15000);
 const actor=c.userId,rpc=c.rpc,signal=c.signal,filters=selected.filters,deadline=Date.now()+(c.timeoutMs??15000),controller=new AbortController();
 const args=Object.freeze({p_user_id:actor,p_status:filters.status,p_bank_reference:filters.bank_reference,p_limit:filters.limit,p_after:filters.after});
 const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();let timer;
 const pending=new Promise((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(new ItauLegacyReadinessError(408,'ERP_REQUEST_TIMEOUT')),{once:true});timer=setTimeout(abort,Math.max(0,deadline-Date.now()));});pending.catch(()=>{});
 const check=()=>need(!controller.signal.aborted&&Date.now()<deadline,408,'ERP_REQUEST_TIMEOUT');
 try{check();const raw=await Promise.race([Promise.resolve().then(()=>{check();return rpc('erp_itau_legacy_readiness',args,{signal:controller.signal,deadline});}),pending]);check();const result=parseItauLegacyPage(raw,filters);check();return result;}
 catch(e){if(e instanceof ItauLegacyReadinessError)throw e;const d=e&&typeof e==='object'?Object.getOwnPropertyDescriptor(e,'code'):null,code=d&&Object.hasOwn(d,'value')?d.value:null;const known={42501:[403,'ERP_ACCESS_DENIED'],22023:[400,'ERP_INVALID_QUERY'],P0002:[404,'ERP_NOT_FOUND'],ERP_ACCESS_DENIED:[403,'ERP_ACCESS_DENIED'],ERP_FORBIDDEN:[403,'ERP_ACCESS_DENIED'],ERP_NOT_FOUND:[404,'ERP_NOT_FOUND'],ERP_INVALID_QUERY:[400,'ERP_INVALID_QUERY']};if(typeof code==='string'&&Object.hasOwn(known,code))throw new ItauLegacyReadinessError(...known[code]);throw new ItauLegacyReadinessError(502,'ERP_UPSTREAM_UNAVAILABLE');}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
}
