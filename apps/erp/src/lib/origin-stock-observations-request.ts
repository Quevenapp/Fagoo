import type {NativeRequestOptions} from './real-access';
import {stockObservationSourceId,STOCK_OBSERVATIONS_MAX_BYTES} from '../../../../packages/erp-domain/src/origin-stock-observations-dto.mjs';
export const STOCK_OBSERVATIONS_BASE='/v1/estoque-origin-observado';
export {STOCK_OBSERVATIONS_MAX_BYTES,stockObservationSourceId};
const invalid=():never=>{throw Error('STOCK_OBSERVATIONS_REQUEST_INVALID');};
const searchText=(v:string)=>[...v].length<=100&&!/[\x00-\x1f\x7f-\x9f]/.test(v);
/** Captures the GET-only contract synchronously, before any credential refresh. */
export function captureStockObservationsRequest(path:string,input:NativeRequestOptions={}){
 if(typeof path!=='string'||path.includes('#')||!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return invalid();
 const d=Object.getOwnPropertyDescriptors(input);
 if(Reflect.ownKeys(d).some(k=>typeof k!=='string'||!['method','body','signal'].includes(k)||!d[k].enumerable||!Object.hasOwn(d[k],'value')))return invalid();
 if((d.method?.value??'GET')!=='GET'||d.body?.value!==undefined||d.signal?.value!==undefined&&!(d.signal.value instanceof AbortSignal))return invalid();
 const pieces=path.split('?');if(pieces.length!==2)return invalid();
 const base=STOCK_OBSERVATIONS_BASE,productSourceId=pieces[0]===base?null:pieces[0].startsWith(base+'/')?pieces[0].slice(base.length+1):'';
 if(productSourceId!==null&&!stockObservationSourceId(productSourceId))return invalid();
 const q=new URLSearchParams(pieces[1]),warehouseSourceId=q.get('warehouse_source_id');
 if(!stockObservationSourceId(warehouseSourceId))return invalid();
 for(const [k,v] of q){
  if(q.getAll(k).length!==1||!(productSourceId?['warehouse_source_id']:['warehouse_source_id','limit','after','q']).includes(k))return invalid();
  if(k==='limit'&&(!/^[1-9][0-9]?$/.test(v)||Number(v)>25)||k==='after'&&!stockObservationSourceId(v)||k==='q'&&!searchText(v))return invalid();
 }
 const options=Object.freeze({method:'GET' as const,...(d.signal?.value?{signal:d.signal.value as AbortSignal}:{})});
 return Object.freeze({base,path,warehouseSourceId,productSourceId,limit:Number(q.get('limit')??25),after:q.get('after'),options});
}
export function stockObservationsListPath(warehouseSourceId:string,query='',after:string|null=null){
 if(!stockObservationSourceId(warehouseSourceId)||typeof query!=='string'||!searchText(query)||after!==null&&!stockObservationSourceId(after))return invalid();
 const q=new URLSearchParams({warehouse_source_id:warehouseSourceId,limit:'25'});if(query.trim())q.set('q',query.trim());if(after)q.set('after',after);
 return `${STOCK_OBSERVATIONS_BASE}?${q}`;
}
export function stockObservationsDetailPath(warehouseSourceId:string,productSourceId:string){
 if(!stockObservationSourceId(warehouseSourceId)||!stockObservationSourceId(productSourceId))return invalid();
 return `${STOCK_OBSERVATIONS_BASE}/${productSourceId}?${new URLSearchParams({warehouse_source_id:warehouseSourceId})}`;
}

export const STOCK_OBSERVATIONS_ROUTE='/preparacao-virada/depositos/estoque';
export function stockObservationsHref(sourceId:string){if(!stockObservationSourceId(sourceId))return invalid();return `${STOCK_OBSERVATIONS_ROUTE}?${new URLSearchParams({deposito:sourceId})}`;}
export function stockObservationsRouteSource(search:string){const q=new URLSearchParams(search);return [...q.keys()].length===1&&q.getAll('deposito').length===1&&stockObservationSourceId(q.get('deposito'))?q.get('deposito')!:null;}
