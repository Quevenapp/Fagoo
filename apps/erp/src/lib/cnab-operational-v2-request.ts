import type {NativeRequestOptions} from './real-access.ts';
import {captureV2,CNAB_V2_BASE} from './cnab-operational-v2-model.ts';
export const CNAB_V2_RESPONSE_BYTES=262144,CNAB_V2_FILE_BYTES=24924;
const UUID='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
export function captureCnabV2Request(path:string,input:NativeRequestOptions={},download=false){
 const fail=():never=>{throw Error('CNAB_V2_REQUEST_INVALID');};
 if(typeof path!=='string'||!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return fail();
 const d=Object.getOwnPropertyDescriptors(input);
 if(Reflect.ownKeys(d).some(k=>typeof k!=='string'||!['method','body','signal'].includes(k)||!Object.hasOwn(d[k],'value')||!d[k].enumerable))return fail();
 const method=d.method?.value??'GET',signal=d.signal?.value;
 if(signal!==undefined&&!(signal instanceof AbortSignal)||!['GET','POST'].includes(method))return fail();
 const base=CNAB_V2_BASE,parts=path.split('?');if(parts.length>2||path.includes('#'))return fail();
 const name=parts[0],query=parts[1];let approval=false;
 if(download){if(method!=='GET'||query!==undefined||!new RegExp('^'+base+'/files/remittance/'+UUID+'$').test(name)||d.body?.value!==undefined)return fail();}
 else if(method==='GET'){
  if(d.body?.value!==undefined)return fail();
  if(name===base+'/remittances'){
   if(query!==undefined){const p=new URLSearchParams(query);if(!query||[...p.keys()].some(k=>!['limit','after'].includes(k))||[...p.keys()].some(k=>p.getAll(k).length!==1))return fail();
    const limit=p.get('limit'),after=p.get('after');if(limit!==null&&(!/^[1-9]\d?$/.test(limit)||Number(limit)>30)||after!==null&&!new RegExp('^'+UUID+'$').test(after))return fail();}
  }else if(query!==undefined||!(name===base+'/profiles'||new RegExp('^'+base+'/commands/'+UUID+'$').test(name)))return fail();
 }else{
  if(query!==undefined)return fail();approval=new RegExp('^'+base+'/profiles/'+UUID+'/approval$').test(name);
  if(!approval&&![base+'/remittances',base+'/remittances/preview'].includes(name)&&!new RegExp('^'+base+'/remittances/'+UUID+'/resume$').test(name))return fail();
 }
 let body:unknown;if(method==='POST'){body=captureV2(d.body?.value);if(!body||typeof body!=='object'||Array.isArray(body)||new TextEncoder().encode(JSON.stringify(body)).length>65536)return fail();}
 return Object.freeze({path,approval,options:Object.freeze({method:method as 'GET'|'POST',...(body!==undefined?{body}:{}),...(signal?{signal:signal as AbortSignal}:{})})});
}
