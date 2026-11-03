import type {NativeRequestOptions} from './real-access';
import {PREFERENCES_BASE,PREFERENCES_MAX_BYTES,capturePreferencesSave} from '../../../../packages/erp-domain/src/preferences/dto.mjs';
import {storedPreferencePage} from '../../../../packages/erp-domain/src/preferences/catalog.mjs';
import {preferenceUuid} from '../../../../packages/erp-domain/src/preferences/core.mjs';
export {PREFERENCES_BASE};
export const PREFERENCES_RESPONSE_BYTES=PREFERENCES_MAX_BYTES;
const invalid=():never=>{throw Error('PREFERENCES_REQUEST_INVALID');};
export function preferencesPagePath(pageId:string){if(!storedPreferencePage(pageId))return invalid();return `${PREFERENCES_BASE}/${pageId}`;}
export function preferencesCommandPath(id:string){if(!preferenceUuid(id))return invalid();return `${PREFERENCES_BASE}/comandos/${id}`;}
/**
 * Capture path, body and signal synchronously before any credential refresh. Reads are open to the roles of each page;
 * the server decides who may write (administrador for company pages, the user for their own pages).
 */
export function capturePreferencesRequest(path:string,input:NativeRequestOptions={}){
 if(typeof path!=='string'||path.length>512||path.includes('#')||path.includes('?')||!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return invalid();
 const d=Object.getOwnPropertyDescriptors(input);if(Reflect.ownKeys(d).some(k=>typeof k!=='string'||!['method','body','signal'].includes(k)||!d[k].enumerable||!Object.hasOwn(d[k],'value')))return invalid();
 const method=d.method?.value??'GET',signal=d.signal?.value,body=d.body?.value;if(signal!==undefined&&!(signal instanceof AbortSignal))return invalid();
 let captured:unknown;
 if(path.startsWith(`${PREFERENCES_BASE}/comandos/`)){if(method!=='GET'||body!==undefined||!preferenceUuid(path.slice(`${PREFERENCES_BASE}/comandos/`.length)))return invalid();}
 else{const page=path.startsWith(`${PREFERENCES_BASE}/`)?storedPreferencePage(path.slice(PREFERENCES_BASE.length+1)):null;if(!page)return invalid();
  if(method==='GET'){if(body!==undefined)return invalid();}
  else if(method==='POST'){try{captured=capturePreferencesSave(body,page.id);}catch{return invalid();}}
  else return invalid();}
 return Object.freeze({path,options:Object.freeze({method:method as 'GET'|'POST',...(captured?{body:captured}:{}),...(signal?{signal:signal as AbortSignal}:{})})});
}
