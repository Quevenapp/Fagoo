import type {NativeRequestOptions} from './real-access';
import {STOCK_OPENING_BASE,STOCK_POLICY_BASE,STOCK_OPENING_MAX_BYTES,STOCK_OPENING_GROUPS,captureStockOpeningQuery,captureStockOpeningBatch,captureStockOpeningApply,captureStockPolicyInput,
 stockOpeningSourceId,stockOpeningUuid,type StockOpeningGroup} from '../../../../packages/erp-domain/src/stock-opening-dto.mjs';
export {STOCK_OPENING_BASE,STOCK_POLICY_BASE};
export const STOCK_OPENING_RESPONSE_BYTES=STOCK_OPENING_MAX_BYTES;
export const STOCK_OPENING_ROUTE='/estoque-abertura';
const invalid=():never=>{throw Error('STOCK_OPENING_REQUEST_INVALID');};
export const stockOpeningWarehousesPath=()=>STOCK_OPENING_BASE;
export function stockOpeningPagePath(source:string,{limit=50,after=null,group=null}:{limit?:number;after?:string|null;group?:StockOpeningGroup|null}={}){
 if(!stockOpeningSourceId(source))return invalid();const q=captureStockOpeningQuery({limit,after,group});const p=new URLSearchParams({limit:String(q.limit)});
 if(q.after)p.set('after',q.after);if(q.group)p.set('grupo',q.group);return `${STOCK_OPENING_BASE}/${source}?${p}`;
}
export function stockOpeningActionPath(source:string,action:'lote'|'adotar'){if(!stockOpeningSourceId(source)||!['lote','adotar'].includes(action))return invalid();return `${STOCK_OPENING_BASE}/${source}/${action}`;}
export function stockOpeningCommandPath(id:string){if(!stockOpeningUuid(id))return invalid();return `${STOCK_OPENING_BASE}/comandos/${id}`;}
export const stockPolicyPath=()=>STOCK_POLICY_BASE;
export function stockPolicyCommandPath(id:string){if(!stockOpeningUuid(id))return invalid();return `${STOCK_POLICY_BASE}/comandos/${id}`;}
/**
 * Capture path, body and signal synchronously before any credential refresh. Only GET of the policy is open to the
 * stock readers (screens explain refusals); every other route is administrador-only.
 */
export function captureStockOpeningRequest(path:string,input:NativeRequestOptions={}){
 if(typeof path!=='string'||path.length>4096||path.includes('#')||!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return invalid();
 const d=Object.getOwnPropertyDescriptors(input);if(Reflect.ownKeys(d).some(k=>typeof k!=='string'||!['method','body','signal'].includes(k)||!d[k].enumerable||!Object.hasOwn(d[k],'value')))return invalid();
 const method=d.method?.value??'GET',signal=d.signal?.value,body=d.body?.value;if(signal!==undefined&&!(signal instanceof AbortSignal))return invalid();
 let captured:unknown,base:string,admin=true;
 const get=()=>{if(method!=='GET'||body!==undefined)invalid();};
 if(path===STOCK_POLICY_BASE){base=STOCK_POLICY_BASE;if(method==='GET'){get();admin=false;}else if(method==='POST')captured=captureStockPolicyInput(body);else return invalid();}
 else if(path.startsWith(STOCK_POLICY_BASE+'/comandos/')){base=STOCK_POLICY_BASE;get();if(!stockOpeningUuid(path.slice((STOCK_POLICY_BASE+'/comandos/').length)))return invalid();}
 else if(path===STOCK_OPENING_BASE){base=STOCK_OPENING_BASE;get();}
 else if(path.startsWith(STOCK_OPENING_BASE+'/comandos/')){base=STOCK_OPENING_BASE;get();if(!stockOpeningUuid(path.slice((STOCK_OPENING_BASE+'/comandos/').length)))return invalid();}
 else{
  base=STOCK_OPENING_BASE;const page=/^\/v1\/saldo-abertura-estoque\/([0-9]{1,40})(?:\?(.*))?$/.exec(path),action=/^\/v1\/saldo-abertura-estoque\/([0-9]{1,40})\/(lote|adotar)$/.exec(path);
  if(page&&stockOpeningSourceId(page[1])){get();const p=new URLSearchParams(page[2]??'');for(const k of p.keys())if(!['limit','after','grupo'].includes(k)||p.getAll(k).length!==1)return invalid();
   const limit=p.get('limit'),group=p.get('grupo');if(limit!==null&&!/^[1-9][0-9]?$/.test(limit)||group!==null&&!(STOCK_OPENING_GROUPS as readonly string[]).includes(group))return invalid();
   captureStockOpeningQuery({limit:limit===null?25:Number(limit),after:p.get('after'),group:group as StockOpeningGroup|null});}
  else if(action&&stockOpeningSourceId(action[1])){if(method!=='POST')return invalid();captured=action[2]==='lote'?captureStockOpeningBatch(body):captureStockOpeningApply(body);}
  else return invalid();
 }
 return Object.freeze({base,path,admin,options:Object.freeze({method:method as 'GET'|'POST',...(captured?{body:captured}:{}),...(signal?{signal:signal as AbortSignal}:{})})});
}
