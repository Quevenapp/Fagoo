import type {NativeRequestOptions} from './real-access';
import {USERS_BASE,USERS_MAX_BYTES,USER_FILTERS,USER_TYPE_FILTERS,captureUsersQuery,captureUserSave,captureUserInvite,accessUuid,type UsersQuery} from '../../../../packages/erp-domain/src/access-users.mjs';
import {captureControlsSave} from '../../../../packages/erp-domain/src/user-permissions.mjs';
export {USERS_BASE};
export const USERS_RESPONSE_BYTES=USERS_MAX_BYTES;
const invalid=():never=>{throw Error('USERS_REQUEST_INVALID');};
export function usersListPath(query:Partial<UsersQuery>={}){const q=captureUsersQuery(query);const p=new URLSearchParams();if(q.q)p.set('q',q.q);if(q.status!=='todos')p.set('situacao',q.status);if(q.type!=='todos')p.set('tipo',q.type);
 if(q.limit!==100)p.set('limit',String(q.limit));if(q.offset)p.set('offset',String(q.offset));const s=p.toString();return s?`${USERS_BASE}?${s}`:USERS_BASE;}
export function userPath(id:string){if(!accessUuid(id))return invalid();return `${USERS_BASE}/${id}`;}
export const userInvitePath=()=>`${USERS_BASE}/convites`;
/** 229: Tipo de usuário, Restringir horários de acesso and Permissões of one user. */
export function userControlsPath(id:string){if(!accessUuid(id))return invalid();return `${USERS_BASE}/${id}/controles`;}
export function userCommandPath(id:string){if(!accessUuid(id))return invalid();return `${USERS_BASE}/comandos/${id}`;}
/** Capture path, body and signal synchronously before any credential refresh. Every route is administrador-only on the server. */
export function captureAccessUsersRequest(path:string,input:NativeRequestOptions={}){
 if(typeof path!=='string'||path.length>512||path.includes('#')||!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return invalid();
 const d=Object.getOwnPropertyDescriptors(input);if(Reflect.ownKeys(d).some(k=>typeof k!=='string'||!['method','body','signal'].includes(k)||!d[k].enumerable||!Object.hasOwn(d[k],'value')))return invalid();
 const method=d.method?.value??'GET',signal=d.signal?.value,body=d.body?.value;if(signal!==undefined&&!(signal instanceof AbortSignal))return invalid();
 const [pathname,search='']=path.split('?');let captured:unknown;
 if(pathname===USERS_BASE){if(method!=='GET'||body!==undefined)return invalid();const p=new URLSearchParams(search);
  for(const k of p.keys())if(!['q','situacao','tipo','limit','offset'].includes(k)||p.getAll(k).length!==1)return invalid();
  const status=p.get('situacao')??'todos',type=p.get('tipo')??'todos';if(!(USER_FILTERS as readonly string[]).includes(status)||!(USER_TYPE_FILTERS as readonly string[]).includes(type))return invalid();
  const num=(k:string,dflt:number)=>{const v=p.get(k);if(v===null)return dflt;if(!/^(0|[1-9][0-9]{0,5})$/.test(v))invalid();return Number(v);};
  captureUsersQuery({q:p.get('q'),status:status as UsersQuery['status'],type:type as UsersQuery['type'],limit:num('limit',100),offset:num('offset',0)});}
 else{if(search)return invalid();const rest=pathname.startsWith(`${USERS_BASE}/`)?pathname.slice(USERS_BASE.length+1):'';
  if(rest.startsWith('comandos/')){if(method!=='GET'||body!==undefined||!accessUuid(rest.slice(9)))return invalid();}
  else if(rest==='convites'){if(method!=='POST')return invalid();try{captured=captureUserInvite(body);}catch{return invalid();}}
  else if(rest.length===46&&rest.endsWith('/controles')&&accessUuid(rest.slice(0,36))){if(method==='GET'){if(body!==undefined)return invalid();}else if(method==='POST'){try{captured=captureControlsSave(body);}catch{return invalid();}}else return invalid();}
  else if(accessUuid(rest)){if(method==='GET'){if(body!==undefined)return invalid();}else if(method==='POST'){try{captured=captureUserSave(body);}catch{return invalid();}}else return invalid();}
  else return invalid();}
 return Object.freeze({path,options:Object.freeze({method:method as 'GET'|'POST',...(captured?{body:captured}:{}),...(signal?{signal:signal as AbortSignal}:{})})});
}
