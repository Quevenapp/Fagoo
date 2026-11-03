import type {NativeRequestOptions} from './real-access';
import {ACTIVITY_BASE,FILES_BASE,ACTIVITY_MAX_BYTES,captureActivityQuery,captureFilesQuery,captureActivityDetailQuery,type ActivityQuery,type FilesQuery} from '../../../../packages/erp-domain/src/activity.mjs';
export {ACTIVITY_BASE,FILES_BASE};
export const ACTIVITY_RESPONSE_BYTES=ACTIVITY_MAX_BYTES;
const invalid=():never=>{throw Error('SYSTEM_REQUEST_INVALID');};
export function activityPath(input:Partial<ActivityQuery>&{from:string;to:string}){const q=captureActivityQuery(input);const p=new URLSearchParams({de:q.from,ate:q.to});
 if(q.module)p.set('modulo',q.module);if(q.operation)p.set('operacao',q.operation);if(q.actor)p.set('usuario',q.actor);if(q.q)p.set('q',q.q);if(q.limit!==100)p.set('limit',String(q.limit));if(q.offset)p.set('offset',String(q.offset));
 return `${ACTIVITY_BASE}?${p}`;}
/** Antes e depois of one entry (migration 148). */
export function activityDetailPath(source:string,id:string){const q=captureActivityDetailQuery({source,id});return `${ACTIVITY_BASE}/detalhe?${new URLSearchParams({origem:q.source,id:q.id})}`;}
export function filesPath(input:Partial<FilesQuery>={}){const q=captureFilesQuery(input);const p=new URLSearchParams();if(q.q)p.set('q',q.q);if(q.from)p.set('de',q.from);if(q.to)p.set('ate',q.to);
 if(q.order!=='data')p.set('ordem',q.order);if(q.origin)p.set('origem',q.origin);if(q.limit!==100)p.set('limit',String(q.limit));if(q.offset)p.set('offset',String(q.offset));const s=p.toString();return s?`${FILES_BASE}?${s}`:FILES_BASE;}
const num=(p:URLSearchParams,k:string,d:number)=>{const v=p.get(k);if(v===null)return d;if(!/^(0|[1-9][0-9]{0,5})$/.test(v))invalid();return Number(v);};
/** Registro de atividades and Gerenciador de arquivos are GET-only and administrador-only (checked again on the server). */
export function captureSystemRequest(path:string,input:NativeRequestOptions={}){
 if(typeof path!=='string'||path.length>1024||path.includes('#')||!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return invalid();
 const d=Object.getOwnPropertyDescriptors(input);if(Reflect.ownKeys(d).some(k=>typeof k!=='string'||!['method','signal'].includes(k)||!d[k].enumerable||!Object.hasOwn(d[k],'value')))return invalid();
 const method=d.method?.value??'GET',signal=d.signal?.value;if(method!=='GET'||signal!==undefined&&!(signal instanceof AbortSignal))return invalid();
 const [pathname,search='']=path.split('?'),p=new URLSearchParams(search);let base:string;
 const only=(keys:string[])=>{for(const k of p.keys())if(!keys.includes(k)||p.getAll(k).length!==1)invalid();};
 if(pathname===ACTIVITY_BASE){base=ACTIVITY_BASE;only(['de','ate','modulo','operacao','usuario','q','limit','offset']);
  captureActivityQuery({from:p.get('de')??'',to:p.get('ate')??'',module:p.get('modulo') as ActivityQuery['module'],operation:p.get('operacao') as ActivityQuery['operation'],actor:p.get('usuario'),q:p.get('q'),limit:num(p,'limit',100),offset:num(p,'offset',0)});}
 else if(pathname===`${ACTIVITY_BASE}/detalhe`){base=ACTIVITY_BASE;only(['origem','id']);captureActivityDetailQuery({source:p.get('origem')??'',id:p.get('id')??''});}
 else if(pathname===FILES_BASE){base=FILES_BASE;only(['q','de','ate','ordem','origem','limit','offset']);
  captureFilesQuery({q:p.get('q'),from:p.get('de'),to:p.get('ate'),order:(p.get('ordem')??'data') as FilesQuery['order'],origin:p.get('origem') as FilesQuery['origin'],limit:num(p,'limit',100),offset:num(p,'offset',0)});}
 else return invalid();
 return Object.freeze({base,path,options:Object.freeze({method:'GET' as const,...(signal?{signal:signal as AbortSignal}:{})})});
}
