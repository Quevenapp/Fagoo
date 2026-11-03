import type {NativeRequestOptions} from './real-access';
import {LIST_PREFERENCES_BASE,LIST_PREFERENCES_MAX_BYTES,captureListPreferencesSave,listPreferenceId,listPreferenceUuid} from '../../../../packages/erp-domain/src/list-preferences.mjs';
export {LIST_PREFERENCES_BASE};
export const LIST_PREFERENCES_RESPONSE_BYTES=LIST_PREFERENCES_MAX_BYTES;
const invalid=():never=>{throw Error('LIST_PREFERENCES_REQUEST_INVALID');};
export function listPreferencesPath(listId:string){if(!listPreferenceId(listId)||listId==='comandos')return invalid();return `${LIST_PREFERENCES_BASE}/${listId}`;}
export function listPreferencesCommandPath(id:string){if(!listPreferenceUuid(id))return invalid();return `${LIST_PREFERENCES_BASE}/comandos/${id}`;}
/** Capture path, body and signal synchronously before any credential refresh. Every active member manages only their own lists. */
export function captureListPreferencesRequest(path:string,input:NativeRequestOptions={}){
 if(typeof path!=='string'||path.length>256||path.includes('#')||path.includes('?')||!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return invalid();
 const d=Object.getOwnPropertyDescriptors(input);if(Reflect.ownKeys(d).some(k=>typeof k!=='string'||!['method','body','signal'].includes(k)||!d[k].enumerable||!Object.hasOwn(d[k],'value')))return invalid();
 const method=d.method?.value??'GET',signal=d.signal?.value,body=d.body?.value;if(signal!==undefined&&!(signal instanceof AbortSignal))return invalid();
 if(!path.startsWith(`${LIST_PREFERENCES_BASE}/`))return invalid();const rest=path.slice(LIST_PREFERENCES_BASE.length+1);let captured:unknown;
 if(rest.startsWith('comandos/')){if(method!=='GET'||body!==undefined||!listPreferenceUuid(rest.slice(9)))return invalid();}
 else{if(!listPreferenceId(rest)||rest==='comandos')return invalid();
  if(method==='GET'){if(body!==undefined)return invalid();}else if(method==='POST'){try{captured=captureListPreferencesSave(body,rest);}catch{return invalid();}}else return invalid();}
 return Object.freeze({path,options:Object.freeze({method:method as 'GET'|'POST',...(captured?{body:captured}:{}),...(signal?{signal:signal as AbortSignal}:{})})});
}
