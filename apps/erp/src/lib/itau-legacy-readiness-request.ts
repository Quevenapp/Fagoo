import type {NativeRequestOptions} from './real-access';
import {captureItauLegacyFilters,ITAU_LEGACY_MAX_BYTES,type ItauLegacyFilters} from '../../../../packages/erp-domain/src/itau-legacy-readiness-dto.mjs';
export const ITAU_LEGACY_BASE='/v1/cobrancas-legadas-itau';
export const ITAU_LEGACY_RESPONSE_BYTES=ITAU_LEGACY_MAX_BYTES;
const invalid=():never=>{throw new Error('ITAU_LEGACY_REQUEST_INVALID');};
export function itauLegacyListPath(input:ItauLegacyFilters){const f=captureItauLegacyFilters(input),q=new URLSearchParams({status:f.status,bank_reference:f.bank_reference,limit:String(f.limit)});if(f.after!==null)q.set('after',f.after);return`${ITAU_LEGACY_BASE}?${q}`;}
/** Capture synchronously; the only public operation is a bounded GET of sources. */
export function captureItauLegacyRequest(path:string,input:NativeRequestOptions={}){
 if(typeof path!=='string'||path.length>4096||path.includes('#')||!(path===ITAU_LEGACY_BASE||path.startsWith(ITAU_LEGACY_BASE+'?'))||!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return invalid();
 const d=Object.getOwnPropertyDescriptors(input);if(Reflect.ownKeys(d).some(k=>typeof k!=='string'||!['method','body','signal'].includes(k)||!d[k].enumerable||!Object.hasOwn(d[k],'value')))return invalid();
 const method=d.method?.value??'GET',signal=d.signal?.value;if(method!=='GET'||d.body?.value!==undefined||signal!==undefined&&!(signal instanceof AbortSignal))return invalid();
 const q=new URLSearchParams(path.slice(ITAU_LEGACY_BASE.length+1));for(const k of q.keys())if(!['status','bank_reference','limit','after'].includes(k)||q.getAll(k).length!==1)return invalid();
 const limit=q.get('limit')??'25';if(!/^(?:[1-9]|1[0-9]|2[0-5])$/.test(limit))return invalid();
 const filters=captureItauLegacyFilters({status:q.get('status')??'open_partial',bank_reference:q.get('bank_reference')??'all',limit:Number(limit),after:q.get('after')});
 return Object.freeze({path:itauLegacyListPath(filters),filters,options:Object.freeze({method:'GET' as const,...(signal?{signal:signal as AbortSignal}:{})})});
}
