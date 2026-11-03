import type {NativeRequestOptions} from './real-access';
import {captureWarehouseInput,captureWarehouseFilters,warehouseSourceId,warehouseCommandId} from '../../../../packages/erp-domain/src/origin-warehouse-import-dto.mjs';
export const WAREHOUSE_IMPORT_BASE='/v1/depositos-origin',WAREHOUSE_IMPORT_RESPONSE_BYTES=131072;
const invalid=():never=>{throw Error('WAREHOUSE_REQUEST_INVALID');};
export function warehouseListPath(q='',after:string|null=null){const f=captureWarehouseFilters({limit:25,q:q.trim()||null,after});const p=new URLSearchParams({limit:'25'});if(f.q)p.set('q',f.q);if(f.after)p.set('after',f.after);return `${WAREHOUSE_IMPORT_BASE}?${p}`;}
export function warehouseActionPath(id:string,action:'preview'|'import'){if(!warehouseSourceId(id)||!['preview','import'].includes(action))return invalid();return `${WAREHOUSE_IMPORT_BASE}/${id}/${action}`;}
export function warehouseCommandPath(id:string){if(!warehouseCommandId(id))return invalid();return `${WAREHOUSE_IMPORT_BASE}/commands/${id}`;}
/** Capture path, body and signal synchronously before credential refresh. */
export function captureWarehouseRequest(path:string,input:NativeRequestOptions={}){
 if(typeof path!=='string'||path.length>4096||!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return invalid();
 const d=Object.getOwnPropertyDescriptors(input);if(Reflect.ownKeys(d).some(k=>typeof k!=='string'||!['method','body','signal'].includes(k)||!d[k].enumerable||!Object.hasOwn(d[k],'value')))return invalid();
 const method=d.method?.value??'GET',signal=d.signal?.value,body=d.body?.value;if(signal!==undefined&&!(signal instanceof AbortSignal))return invalid();
 let captured;
 if(path===WAREHOUSE_IMPORT_BASE||path.startsWith(WAREHOUSE_IMPORT_BASE+'?')){if(method!=='GET'||body!==undefined||path.includes('#'))return invalid();const p=new URLSearchParams(path.slice(WAREHOUSE_IMPORT_BASE.length+1));for(const k of p.keys())if(!['limit','after','q'].includes(k)||p.getAll(k).length!==1)return invalid();const limit=p.get('limit');if(limit!==null&&!/^[1-9][0-9]?$/.test(limit))return invalid();captureWarehouseFilters({limit:limit===null?25:Number(limit),after:p.get('after'),q:p.get('q')});}
 else if(path.startsWith(WAREHOUSE_IMPORT_BASE+'/commands/')){if(method!=='GET'||body!==undefined||!warehouseCommandId(path.slice((WAREHOUSE_IMPORT_BASE+'/commands/').length)))return invalid();}
 else {const m=/^\/v1\/depositos-origin\/([0-9]{1,40})\/(preview|import)$/.exec(path);if(method!=='POST'||!m||!warehouseSourceId(m[1]))return invalid();captured=m[2]==='import'?captureWarehouseInput(body,true):captureWarehouseInput(body);}
 return Object.freeze({path,options:Object.freeze({method:method as 'GET'|'POST',...(captured?{body:captured}:{}),...(signal?{signal:signal as AbortSignal}:{})})});
}
