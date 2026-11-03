/** Closed100 contract shared by the API boundary and the browser: negative stock policy and Origin opening adoption. */
export const STOCK_OPENING_BASE='/v1/saldo-abertura-estoque';
export const STOCK_POLICY_BASE='/v1/politica-estoque';
export const STOCK_OPENING_MAX_BYTES=262144;
export const STOCK_OPENING_BODY_BYTES=65536;
export const STOCK_OPENING_PAGE_LIMIT=50;
export const STOCK_OPENING_BATCH_LIMIT=100;
export const STOCK_OPENING_PROFILE='origin-stock-opening-v1';
export const STOCK_OPENING_GROUPS=Object.freeze(['positive','zero','negative','no_native_product','no_observation','invalid','adopted','native_movements']);
export const STOCK_OPENING_STATUSES=Object.freeze(['positive','zero','negative','negative_blocked','no_native_product','no_observation','invalid','adopted','adopted_zero','adopted_reversed','native_movements']);
export const STOCK_OPENING_REASONS=Object.freeze(['NATIVE_PRODUCT_MISSING','ALREADY_ADOPTED','NATIVE_MOVEMENTS','OBSERVATION_MISSING','WAREHOUSE_LIST_MISSING','WAREHOUSE_ABSENT',
 'SOURCE_INVALID','WAREHOUSE_LIST_INVALID','PHYSICAL_ABSENT','PHYSICAL_NULL','PHYSICAL_INVALID','PHYSICAL_PRECISION','PHYSICAL_RANGE','PRODUCT_UNAVAILABLE','NEGATIVE_NOT_ALLOWED',
 'SOURCE_CHANGED','PRODUCT_CHANGED','UNIT_CHANGED']);
export class StockOpeningError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const fail=(status=502,code='ERP_UPSTREAM_INVALID_RESPONSE')=>{throw new StockOpeningError(status,code);};
const need=v=>{if(!v)fail();};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const stockOpeningSourceId=v=>typeof v==='string'&&v.length<=40&&/^[0-9]+$/.test(v)&&!/^0+$/.test(v);
export const stockOpeningUuid=v=>typeof v==='string'&&v.length===36&&UUID.test(v);
const hash=v=>typeof v==='string'&&v.length===64&&/^[a-f0-9]+$/.test(v);
const sourceVersion=v=>typeof v==='string'&&/^[1-9][0-9]{0,17}$/.test(v);
const int=(v,min=0,max=2147483647)=>Number.isInteger(v)&&v>=min&&v<=max;
const bool=v=>typeof v==='boolean';
const text=(v,max,min=0)=>typeof v==='string'&&[...v].length>=min&&[...v].length<=max&&!/[\x00-\x1f\x7f-\x9f]/.test(v);
/** Signed exact quantity with the six decimals of numeric(18,6); never "-0". */
export const stockOpeningQuantity=v=>typeof v==='string'&&/^-?(0|[1-9][0-9]{0,11})\.[0-9]{6}$/.test(v)&&v!=='-0.000000';
const units=v=>BigInt(v.replace('.',''));
export function stockOpeningDay(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||v<'1900-01-01')return false;const d=new Date(`${v}T00:00:00Z`);return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v;}
function stamp(v){if(typeof v!=='string'||v.length>40)return false;const m=/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-](\d{2})(?::?(\d{2}))?)$/.exec(v);return!!m&&stockOpeningDay(`${m[1]}-${m[2]}-${m[3]}`)&&+m[4]<=23&&+m[5]<=59&&+m[6]<=59&&Number.isFinite(Date.parse(v.replace(' ','T').replace(/([+-]\d{2})$/,'$1:00')));}
const exact=(v,keys)=>need(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)));
/** Deep frozen copy of plain JSON data: no getters, prototypes or unbounded structures cross the boundary. */
function snapshot(raw,max=STOCK_OPENING_MAX_BYTES){let nodes=0;const clone=(v,depth)=>{need(++nodes<=60000&&depth<=12);if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return v;if(typeof v==='string'){need(v.length<=max);return v;}need(v&&typeof v==='object'&&[Object.prototype,null,Array.prototype].includes(Object.getPrototypeOf(v)));if(Array.isArray(v)){need(v.length<=200);const d=Object.getOwnPropertyDescriptors(v);need(Reflect.ownKeys(d).length===v.length+1);return Object.freeze(Array.from({length:v.length},(_,i)=>{need(d[i]?.enumerable&&Object.hasOwn(d[i],'value'));return clone(d[i].value,depth+1);}));}const out={};for(const k of Reflect.ownKeys(v)){const d=Object.getOwnPropertyDescriptor(v,k);need(typeof k==='string'&&!['__proto__','constructor','prototype'].includes(k)&&d.enumerable&&Object.hasOwn(d,'value'));out[k]=clone(d.value,depth+1);}return Object.freeze(out);};const out=clone(raw,0);need(new TextEncoder().encode(JSON.stringify(out)).length<=max);return out;}
const input=fn=>(raw,...rest)=>{try{return fn(snapshot(raw,STOCK_OPENING_BODY_BYTES),...rest);}catch{return fail(400,'ERP_INVALID_INPUT');}};

export const captureStockOpeningQuery=(raw={})=>{try{const v=snapshot(raw,4096);need(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>['limit','after','group'].includes(k)));
 const limit=v.limit??25,after=v.after??null,group=v.group??null;need(int(limit,1,STOCK_OPENING_PAGE_LIMIT)&&(after===null||stockOpeningSourceId(after))&&(group===null||STOCK_OPENING_GROUPS.includes(group)));return Object.freeze({limit,after,group});}catch{return fail(400,'ERP_INVALID_QUERY');}};
export const captureStockOpeningBatch=input(v=>{exact(v,['occurred_on','limit']);need(stockOpeningDay(v.occurred_on)&&int(v.limit,1,STOCK_OPENING_BATCH_LIMIT));return v;});
/** The observation has no unit: the native unit shown in the batch is part of what the administrator confirms. */
function intentItem(v){exact(v,['product_source_id','product_id','unit','source_hash','source_version','target']);need(stockOpeningSourceId(v.product_source_id)&&stockOpeningUuid(v.product_id)&&text(v.unit,64,1)&&hash(v.source_hash)&&sourceVersion(v.source_version)&&stockOpeningQuantity(v.target));}
export const captureStockOpeningApply=input(v=>{exact(v,['command_id','occurred_on','preview_hash','confirmed','items']);
 need(stockOpeningUuid(v.command_id)&&stockOpeningDay(v.occurred_on)&&hash(v.preview_hash)&&v.confirmed===true&&Array.isArray(v.items)&&v.items.length>=1&&v.items.length<=STOCK_OPENING_BATCH_LIMIT);
 v.items.forEach(intentItem);need(new Set(v.items.map(i=>i.product_source_id)).size===v.items.length&&new Set(v.items.map(i=>i.product_id)).size===v.items.length);return v;});
export const captureStockPolicyInput=input(v=>{exact(v,['command_id','expected_version','allow_negative','reason','confirmed']);
 need(stockOpeningUuid(v.command_id)&&int(v.expected_version,0,2147483646)&&bool(v.allow_negative)&&text(v.reason,500)&&v.reason.trim().length>=3&&v.confirmed===true);return v;});

function policy(v){exact(v,['allow_negative','version','updated_at']);need(bool(v.allow_negative)&&int(v.version)&&(v.updated_at===null?v.version===0&&!v.allow_negative:stamp(v.updated_at)&&v.version>0));}
function warehouse(v,sourceId){exact(v,['source_id','warehouse_id','name','active','source_name','imported_at']);
 need(stockOpeningSourceId(v.source_id)&&(!sourceId||v.source_id===sourceId)&&stockOpeningUuid(v.warehouse_id)&&text(v.name,200,1)&&bool(v.active)&&(v.source_name===null||text(v.source_name,200,1))&&stamp(v.imported_at));}
function receiptDto(v,{warehouseId,productSourceId,commandId}={}){
 exact(v,['id','command_id','product_source_id','product_id','warehouse_id','outcome','state','target','previous_quantity','adjustment','unit','movement_id','reversal_movement_id','occurred_on','source_hash','source_version','created_at']);
 need(stockOpeningUuid(v.id)&&stockOpeningUuid(v.command_id)&&(!commandId||v.command_id===commandId)&&stockOpeningSourceId(v.product_source_id)&&(!productSourceId||v.product_source_id===productSourceId)
  &&stockOpeningUuid(v.product_id)&&stockOpeningUuid(v.warehouse_id)&&(!warehouseId||v.warehouse_id===warehouseId)&&['adopted','adopted_zero'].includes(v.outcome)&&['adopted','adopted_zero','reversed'].includes(v.state)
  &&stockOpeningQuantity(v.target)&&stockOpeningQuantity(v.previous_quantity)&&stockOpeningQuantity(v.adjustment)&&text(v.unit,64,1)&&stockOpeningDay(v.occurred_on)&&hash(v.source_hash)&&sourceVersion(v.source_version)&&stamp(v.created_at));
 need(units(v.previous_quantity)+units(v.adjustment)===units(v.target));
 if(v.outcome==='adopted_zero')need(v.state==='adopted_zero'&&v.movement_id===null&&v.reversal_movement_id===null&&units(v.target)===0n&&units(v.adjustment)===0n);
 else need(v.state!=='adopted_zero'&&stockOpeningUuid(v.movement_id)&&units(v.adjustment)!==0n&&(v.state==='reversed'?stockOpeningUuid(v.reversal_movement_id)&&v.reversal_movement_id!==v.movement_id:v.reversal_movement_id===null));
}
const groupOf=s=>s==='negative_blocked'?'negative':['adopted','adopted_zero','adopted_reversed'].includes(s)?'adopted':s;
const PENDING=['positive','zero','negative','negative_blocked'];
function row(v,{warehouseId,allowNegative}){
 exact(v,['product_source_id','group','status','reason','product','source','physical','current','target','adjustment','receipt']);
 need(stockOpeningSourceId(v.product_source_id)&&STOCK_OPENING_STATUSES.includes(v.status)&&v.group===groupOf(v.status)&&(v.reason===null||STOCK_OPENING_REASONS.includes(v.reason)));
 if(v.product!==null){exact(v.product,['id','name','code','unit']);need(stockOpeningUuid(v.product.id)&&text(v.product.name,200,1)&&(v.product.code===null||text(v.product.code,100,1))&&(v.product.unit===null||text(v.product.unit,64,1)));}
 need((v.product===null)===(v.status==='no_native_product'));
 exact(v.source,['name','code','source_hash','source_version','last_seen_at']);const s=v.source;
 need((s.name===null||text(s.name,200,1))&&(s.code===null||text(s.code,100,1))&&(s.source_hash===null?s.source_version===null&&s.last_seen_at===null:hash(s.source_hash)&&sourceVersion(s.source_version)&&stamp(s.last_seen_at)));
 need(v.physical===null||stockOpeningQuantity(v.physical));
 exact(v.current,['quantity','version']);need((v.current.quantity===null||stockOpeningQuantity(v.current.quantity))&&int(v.current.version)&&(v.current.quantity!==null||v.current.version===0));
 if(PENDING.includes(v.status)){
  need(v.product!==null&&v.product.unit!==null&&s.source_hash!==null&&stockOpeningQuantity(v.target)&&v.physical===v.target&&stockOpeningQuantity(v.adjustment)&&v.receipt===null);
  need(units(v.target)-(v.current.quantity===null?0n:units(v.current.quantity))===units(v.adjustment));
  const t=units(v.target);need(v.status==='positive'?t>0n:v.status==='zero'?t===0n:t<0n);
  need(v.status==='negative_blocked'?v.reason==='NEGATIVE_NOT_ALLOWED'&&allowNegative===false:v.reason===null&&(v.status!=='negative'||allowNegative===true));
 }else{
  need(v.target===null&&v.adjustment===null&&v.reason!==null);
  if(v.group==='adopted'){need(v.reason==='ALREADY_ADOPTED'&&v.receipt!==null);receiptDto(v.receipt,{warehouseId,productSourceId:v.product_source_id});need(v.receipt.product_id===v.product.id&&v.receipt.state===({adopted:'adopted',adopted_zero:'adopted_zero',adopted_reversed:'reversed'})[v.status]);}
  else need(v.receipt===null);
  if(v.status==='no_native_product')need(v.reason==='NATIVE_PRODUCT_MISSING'&&v.current.quantity===null);
  if(v.status==='native_movements')need(v.reason==='NATIVE_MOVEMENTS');
  if(v.status==='no_observation')need(['OBSERVATION_MISSING','WAREHOUSE_LIST_MISSING','WAREHOUSE_ABSENT'].includes(v.reason)&&v.physical===null);
  if(v.status==='invalid')need(['SOURCE_INVALID','WAREHOUSE_LIST_INVALID','PHYSICAL_ABSENT','PHYSICAL_NULL','PHYSICAL_INVALID','PHYSICAL_PRECISION','PHYSICAL_RANGE','PRODUCT_UNAVAILABLE'].includes(v.reason));
 }
}
const COUNT_KEYS=['total','positive','zero','negative','negative_blocked','no_native_product','no_observation','invalid','adopted','native_movements','pending'];
function counts(v,allowNegative){exact(v,COUNT_KEYS);need(COUNT_KEYS.every(k=>int(v[k],0,100000000)));
 need(v.total===v.positive+v.zero+v.negative+v.no_native_product+v.no_observation+v.invalid+v.adopted+v.native_movements&&v.negative_blocked<=v.negative
  &&v.pending===v.positive+v.zero+v.negative-v.negative_blocked&&(!allowNegative||v.negative_blocked===0)&&(allowNegative||v.negative_blocked===v.negative));}
const ordered=(items,after=null)=>{let prior=after;for(const i of items){need(prior===null||i.product_source_id>prior);prior=i.product_source_id;}};

export function parseStockOpeningWarehouses(raw){const v=snapshot(raw);exact(v,['scope','profile','items','has_more','policy','data_mode']);
 need(v.scope==='stock_opening_warehouses'&&v.profile===STOCK_OPENING_PROFILE&&v.data_mode==='erp_native'&&Array.isArray(v.items)&&v.items.length<=100&&bool(v.has_more)&&(!v.has_more||v.items.length===100));
 policy(v.policy);let prior=null;for(const w of v.items){warehouse(w);need(prior===null||w.source_id>prior);prior=w.source_id;}need(new Set(v.items.map(w=>w.warehouse_id)).size===v.items.length);return v;}
export function parseStockOpeningPage(raw,{warehouseSourceId,limit=25,after=null,group=null}={}){const v=snapshot(raw),q=captureStockOpeningQuery({limit,after,group});need(stockOpeningSourceId(warehouseSourceId));
 exact(v,['scope','profile','warehouse','policy','counts','group','items','limit','has_more','next_cursor','unit_source','observed_at','data_mode']);
 need(v.scope==='stock_opening'&&v.profile===STOCK_OPENING_PROFILE&&v.data_mode==='erp_native'&&v.unit_source==='native_product'&&stamp(v.observed_at)&&v.limit===q.limit&&v.group===q.group);
 warehouse(v.warehouse,warehouseSourceId);policy(v.policy);counts(v.counts,v.policy.allow_negative);
 need(Array.isArray(v.items)&&v.items.length<=q.limit&&bool(v.has_more)&&v.next_cursor===(v.has_more?v.items.at(-1)?.product_source_id:null)&&(!v.has_more||v.items.length===q.limit));
 for(const i of v.items){row(i,{warehouseId:v.warehouse.warehouse_id,allowNegative:v.policy.allow_negative});need(q.group===null||i.group===q.group);}ordered(v.items,q.after);return v;}
export function parseStockOpeningBatch(raw,{warehouseSourceId,occurredOn,limit}={}){const v=snapshot(raw);need(stockOpeningSourceId(warehouseSourceId)&&stockOpeningDay(occurredOn)&&int(limit,1,STOCK_OPENING_BATCH_LIMIT));
 exact(v,['scope','profile','warehouse','policy','occurred_on','items','pending','limit','preview_hash','unit_source','observed_at','data_mode']);
 need(v.scope==='stock_opening_batch'&&v.profile===STOCK_OPENING_PROFILE&&v.data_mode==='erp_native'&&v.unit_source==='native_product'&&stamp(v.observed_at)&&v.occurred_on===occurredOn&&v.limit===limit);
 warehouse(v.warehouse,warehouseSourceId);policy(v.policy);
 need(Array.isArray(v.items)&&v.items.length<=limit&&int(v.pending,0,100000000)&&v.pending>=v.items.length&&(v.items.length===limit||v.items.length===v.pending)&&(v.items.length?hash(v.preview_hash):v.preview_hash===null));
 for(const i of v.items){row(i,{warehouseId:v.warehouse.warehouse_id,allowNegative:v.policy.allow_negative});need(['positive','zero','negative'].includes(i.status));}ordered(v.items);
 need(new Set(v.items.map(i=>i.product.id)).size===v.items.length);return v;}
/** The exact confirmation the browser sends: only what the administrator saw in the pinned batch. */
export function stockOpeningIntent(batch,commandId){need(batch&&Array.isArray(batch.items)&&batch.items.length>0&&hash(batch.preview_hash));
 return captureStockOpeningApply({command_id:commandId,occurred_on:batch.occurred_on,preview_hash:batch.preview_hash,confirmed:true,
  items:batch.items.map(i=>({product_source_id:i.product_source_id,product_id:i.product.id,unit:i.product.unit,source_hash:i.source.source_hash,source_version:i.source.source_version,target:i.target}))});}
const OUTCOMES=['adopted','adopted_zero','skipped'];
const SKIP_REASONS=['SOURCE_CHANGED','PRODUCT_CHANGED','UNIT_CHANGED','NATIVE_PRODUCT_MISSING','ALREADY_ADOPTED','NATIVE_MOVEMENTS','OBSERVATION_MISSING','WAREHOUSE_LIST_MISSING','WAREHOUSE_ABSENT','SOURCE_INVALID','WAREHOUSE_LIST_INVALID','PHYSICAL_ABSENT','PHYSICAL_NULL','PHYSICAL_INVALID','PHYSICAL_PRECISION','PHYSICAL_RANGE','PRODUCT_UNAVAILABLE','NEGATIVE_NOT_ALLOWED'];
export function parseStockOpeningResult(raw,{commandId,warehouseSourceId,input:sent,lookup=false}={}){const v=snapshot(raw);need(stockOpeningUuid(commandId));
 exact(v,['scope','profile','data_mode','receipt','current','replayed']);need(v.scope==='stock_opening_command'&&v.profile===STOCK_OPENING_PROFILE&&v.data_mode==='erp_native'&&bool(v.replayed)&&(!lookup||v.replayed===true));
 const r=v.receipt;exact(r,['command_id','warehouse_source_id','warehouse_id','occurred_on','preview_hash','completed_at','items','summary']);
 need(r.command_id===commandId&&stockOpeningSourceId(r.warehouse_source_id)&&(!warehouseSourceId||r.warehouse_source_id===warehouseSourceId)&&stockOpeningUuid(r.warehouse_id)&&stockOpeningDay(r.occurred_on)&&hash(r.preview_hash)&&stamp(r.completed_at)
  &&Array.isArray(r.items)&&r.items.length>=1&&r.items.length<=STOCK_OPENING_BATCH_LIMIT);
 const tally={adopted:0,adopted_zero:0,skipped:0};
 for(const i of r.items){exact(i,['product_source_id','product_id','outcome','reason','target','adjustment','movement_id','receipt_id']);
  need(stockOpeningSourceId(i.product_source_id)&&stockOpeningUuid(i.product_id)&&OUTCOMES.includes(i.outcome)&&stockOpeningQuantity(i.target));tally[i.outcome]++;
  if(i.outcome==='skipped')need(SKIP_REASONS.includes(i.reason)&&i.adjustment===null&&i.movement_id===null&&i.receipt_id===null);
  else need(i.reason===null&&stockOpeningQuantity(i.adjustment)&&stockOpeningUuid(i.receipt_id)&&(i.outcome==='adopted_zero'?i.movement_id===null&&units(i.adjustment)===0n&&units(i.target)===0n:stockOpeningUuid(i.movement_id)&&units(i.adjustment)!==0n));}
 ordered(r.items);exact(r.summary,['adopted','adopted_zero','skipped']);need(r.summary.adopted===tally.adopted&&r.summary.adopted_zero===tally.adopted_zero&&r.summary.skipped===tally.skipped);
 const adopted=r.items.filter(i=>i.outcome!=='skipped');need(Array.isArray(v.current)&&v.current.length===adopted.length);
 v.current.forEach((c,n)=>{const i=adopted[n];receiptDto(c,{warehouseId:r.warehouse_id,productSourceId:i.product_source_id,commandId});
  need(c.id===i.receipt_id&&c.product_id===i.product_id&&c.outcome===i.outcome&&c.target===i.target&&c.adjustment===i.adjustment&&c.movement_id===i.movement_id&&c.occurred_on===r.occurred_on);});
 if(sent){const e=captureStockOpeningApply(sent);need(e.command_id===commandId&&e.occurred_on===r.occurred_on&&e.preview_hash===r.preview_hash&&e.items.length===r.items.length);
  const byId=new Map(e.items.map(i=>[i.product_source_id,i]));for(const i of r.items){const s=byId.get(i.product_source_id);need(s&&s.product_id===i.product_id&&s.target===i.target);}
  // Every adopted receipt carries exactly the confirmed native unit.
  for(const c of v.current)need(c.unit===byId.get(c.product_source_id)?.unit);}
 return v;}

export function parseStockPolicy(raw){const v=snapshot(raw);exact(v,['scope','policy','can_manage','data_mode']);need(v.scope==='stock_policy'&&v.data_mode==='erp_native'&&bool(v.can_manage));policy(v.policy);return v;}
/** The server stores btrim(reason): only ASCII spaces are removed, never other Unicode whitespace. */
const btrim=v=>v.replace(/^ +| +$/g,'');
export function parseStockPolicyResult(raw,{commandId,input:sent,lookup=false}={}){const v=snapshot(raw);need(stockOpeningUuid(commandId));
 exact(v,['scope','data_mode','receipt','policy','replayed']);need(v.scope==='stock_policy'&&v.data_mode==='erp_native'&&bool(v.replayed)&&(!lookup||v.replayed===true));policy(v.policy);
 const r=v.receipt;exact(r,['command_id','from','to','reason','changed_at']);exact(r.from,['allow_negative','version']);exact(r.to,['allow_negative','version']);
 need(r.command_id===commandId&&bool(r.from.allow_negative)&&int(r.from.version,0,2147483646)&&r.to.allow_negative===!r.from.allow_negative&&r.to.version===r.from.version+1&&text(r.reason,500,3)&&r.reason===btrim(r.reason)&&stamp(r.changed_at)&&v.policy.version>=r.to.version);
 if(sent){const e=captureStockPolicyInput(sent);need(e.command_id===commandId&&e.allow_negative===r.to.allow_negative&&e.expected_version===r.from.version&&btrim(e.reason)===r.reason);}
 return v;}
