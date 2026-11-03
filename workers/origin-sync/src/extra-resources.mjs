/** 063 staging helpers. No native catalogs, balances, settlements or deletion inference. */
import {sourceId} from './resources.mjs';
import {isCapturedPriceNumber} from './price-json-parser.mjs';
import {stockCapture} from './stock-json.mjs';
const fail=code=>{throw new Error(code);};
export const EXTRA_FLAG='EXTRA_RESOURCES_ENABLED';
export function extraFailure(error,previous,now=Date.now()){
 const failures=Math.min(10,(Number.isSafeInteger(previous?.failures)?previous.failures:0)+1);
 const status=Number.isInteger(error?.status)&&error.status>=400&&error.status<=599?error.status:null;
 const code=String(error?.code||error?.message||'EXTRA_COLLECTION_FAILED');
 const seconds=status===403?86400:status===404?3600:Math.min(3600,60*2**(failures-1));
 return {failures,code:/^[A-Z][A-Z0-9_]{0,80}$/.test(code)?code:'EXTRA_COLLECTION_FAILED',http_status:status,next_attempt_at:new Date(now+seconds*1000).toISOString()};
}
export function extraIsDeferred(checkpoint,now=Date.now()){
 const next=checkpoint?.failure?.next_attempt_at??checkpoint?.next_attempt_at;
 if(next===undefined)return false;
 if(typeof next!=='string'||!Number.isFinite(Date.parse(next)))fail('ORIGIN_EXTRA_CHECKPOINT_INVALID');
 return Date.parse(next)>now;
}
export function cleanExtraCheckpoint(checkpoint){const cp=structuredClone(checkpoint);delete cp.failure;delete cp.next_attempt_at;return cp;}
export async function sourcePageSlice(listed,cursor){
 if(!Array.isArray(listed)||listed.length>1000)fail('ORIGIN_SOURCE_PAGE_LIMIT');
 const ids=listed.map(row=>sourceId(row?.id));if(new Set(ids).size!==ids.length)fail('ORIGIN_DUPLICATE_SOURCE_ID');
 const bytes=new TextEncoder().encode(JSON.stringify(ids)),digest=await crypto.subtle.digest('SHA-256',bytes);
 const fingerprint=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
 const offset=cursor.list_fingerprint===fingerprint?(cursor.offset??0):0;
 if(!Number.isSafeInteger(offset)||offset<0||offset>listed.length)fail('ORIGIN_EXTRA_CHECKPOINT_INVALID');
 const items=listed.slice(offset,offset+10),end=offset+items.length;
 return {items,more:end<listed.length,next:{...cursor,offset:end,list_fingerprint:fingerprint}};
}
// OriginClient has already bounded/validated JSON. Sort object keys only; retain
// array order, types, every amount and every warehouse field without coercion.
const canonicalStock=value=>isCapturedPriceNumber(value)?JSON.stringify(value):Array.isArray(value)?`[${value.map(canonicalStock).join(',')}]`
 :value!==null&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalStock(value[key])}`).join(',')}}`
 :JSON.stringify(value);
export async function stockBatch(repo,client,owner,lease,checkpoint,{keepLease,deadline,cutoff,clock=Date.now,databaseOptions}){
 const after=checkpoint?.unfiltered?.after??null;if(after!==null)sourceId(after);
 await keepLease();
 const page=await repo.rpc('origin_sync_stock_product_page',{p_owner:owner,p_lease_token:lease.lease_token,p_after:after,p_limit:25},{deadline});
 if(!page||!Array.isArray(page.items)||page.items.length>25||typeof page.has_more!=='boolean'||page.coverage_complete!==false||page.next_cursor!==(page.has_more?page.items.at(-1):null))fail('ORIGIN_STOCK_SOURCE_PAGE_INVALID');
 const ids=page.items.map(sourceId);if(ids.some((id,i)=>id!==page.items[i]||(i>0&&id<=ids[i-1])||(after!==null&&id<=after))||page.has_more&&!ids.length)fail('ORIGIN_STOCK_SOURCE_PAGE_INVALID');
 const wanted=new Set(ids),found=new Map(),contents=new Map();let overlaps=0;
 if(ids.length)for(const partition of [0,1,2]){
  await keepLease();const rows=await client.get('/estoques/saldos',{'idsProdutos[]':ids,filtroSaldoEstoque:partition},{deadline});
  if(!Array.isArray(rows)||rows.length>ids.length)fail('ORIGIN_STOCK_RESPONSE_INVALID');
  const seen=new Set();
  for(const payload of rows){
   if(!payload||Array.isArray(payload)||typeof payload!=='object')fail('ORIGIN_STOCK_RESPONSE_INVALID');
   const id=sourceId(payload.produto?.id);
   if(!wanted.has(id)||seen.has(id))fail('ORIGIN_STOCK_RESPONSE_CONFLICT');
   seen.add(id);
   if(payload.depositos!==undefined){
    if(!Array.isArray(payload.depositos)||payload.depositos.length>1000)fail('ORIGIN_STOCK_RESPONSE_INVALID');
    const deposits=payload.depositos.map(d=>sourceId(d?.id));if(new Set(deposits).size!==deposits.length)fail('ORIGIN_STOCK_RESPONSE_CONFLICT');
   }
   const content=canonicalStock(payload);
   // The source can repeat an unchanged product across filters. Only an exact
   // whole-JSON match may collapse; differing observations still abort the batch.
   if(found.has(id)){if(contents.get(id)!==content)fail('ORIGIN_STOCK_RESPONSE_CONFLICT');overlaps++;}
   else {
    if(Object.hasOwn(payload,'_brufap_stock_capture'))fail('ORIGIN_STOCK_RESPONSE_CONFLICT');
    const evidence=stockCapture(payload);
    found.set(id,{source_id:id,payload:evidence?{...payload,_brufap_stock_capture:evidence}:payload});contents.set(id,content);
   }
  }
 }
 await keepLease();const cp=cleanExtraCheckpoint(checkpoint??{});cp.version=1;
 cp.last_observation={requested:ids.length,returned:found.size,unavailable:ids.length-found.size,overlaps,observed_at:new Date(clock()).toISOString(),coverage_complete:false};
 if(page.has_more)cp.unfiltered={after:page.next_cursor};else{delete cp.unfiltered;cp.unfilteredCompletedAt=cutoff;cp.next_attempt_at=new Date(clock()+900000).toISOString();}
 const records=[...found.values()];const result=await repo.apply('stock_balances','stock_balances',owner,lease,records,cp,databaseOptions);
 return {resource:'stock_balances',records:records.length,requested:ids.length,unavailable:ids.length-found.size,overlaps,...result};
}
