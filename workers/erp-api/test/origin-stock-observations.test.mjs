import test from'node:test';import assert from'node:assert/strict';
import{parseStockObservationsPage,parseStockObservationsDetail}from'../../../packages/erp-domain/src/origin-stock-observations-dto.mjs';
import{parseStockObservationsRoute,executeStockObservationsRoute,STOCK_OBSERVATIONS_BASE}from'../src/origin-stock-observations.mjs';
const actor='87000000-0000-4000-8000-000000000001',record='87000000-0000-4000-8000-000000000002',at='2026-10-17T08:00:00Z',hash='a'.repeat(64);
const obs=(state='absent',value=null)=>({state,value});
function fixture(){const item={product_source_id:'001',product:{source_known:true,source_name:obs('value','Sintético'),source_code:obs('value','C001'),record_id:null,record_name:null,record_unit:null,active:null,human_edited:null,binding_state:'missing_native'},observation:{state:'missing',source:null,product_code:obs(),physical_total:obs(),virtual_total:obs(),warehouse:{state:'unavailable',physical:obs(),virtual:obs()},issues:[]}};return{profile:'origin-stock-observations-v1',read_only:true,can_import_balance:false,coverage_certified:false,lexical_precision_certified:false,reconciled:false,native_effects:false,numeric_representation:'parsed_json_number',units_compared:false,observed_at:at,warehouse:{source_id:'007',record_id:record,imported_at:at,binding_source_hash:hash,binding_source_version:'1',source_state:'missing',record_state:'same',source:null,record:{name:'Depósito sintético',active:false,human_edited:false,version:1}},counts:{scope:'exact_staging_product_ids',product_ids:'1',known_product_ids:'1',stock_observation_ids:'0',known_without_observation:'1',observation_without_product:'0',invalid_product_ids:'0',invalid_stock_ids:'0'},items:[item],limit:25,has_more:false,next_cursor:null};}
const parse=p=>parseStockObservationsPage(p,{warehouseSourceId:'007',limit:25,after:null});
const route=(suffix='?warehouse_source_id=007')=>parseStockObservationsRoute(new Request('https://erp.invalid'+STOCK_OBSERVATIONS_BASE+suffix));
const reject=(fn,code)=>assert.rejects(fn,e=>e.code===code);
test('087 immutable browser contract refuses arithmetic/lexical/coverage promotion and bound identity tampering',()=>{
 const v=parse(fixture());assert.ok(Object.isFrozen(v.items[0].observation));
 for(const mutate of[v=>v.lexical_precision_certified=true,v=>v.units_compared=true,v=>v.native_effects=true,v=>v.reconciled=true,v=>v.can_import_balance=true,v=>v.warehouse.source_id='7',v=>v.warehouse.source_state='same',v=>v.items[0].observation.physical_total=obs('value','0'),v=>v.counts.stock_observation_ids='1',v=>v.items[0].observation.issues=['OTHER'],v=>v.payload='not public',v=>v.observed_at='2026-02-30T00:00:00Z']){const x=fixture();mutate(x);assert.throws(()=>parse(x),{code:'ERP_UPSTREAM_INVALID_RESPONSE'});}
 let calls=0;const x=fixture();Object.defineProperty(x,'items',{enumerable:true,get(){calls++;return[];}});assert.throws(()=>parse(x));assert.equal(calls,0);
});
test('087 route is GET-only, exact decimal IDs, closed bounded filters and no capture/native aliases',()=>{
 assert.equal(route().rpc,'erp_origin_stock_observations');assert.equal(route('/001?warehouse_source_id=007').args.p_product_source_id,'001');
 for(const s of['','?warehouse_source_id=0','?warehouse_source_id=007&warehouse_source_id=7','?warehouse_source_id=007&limit=26','?warehouse_source_id=007&after=abc','?warehouse_source_id=007&q=%00','?warehouse_source_id=007&q='+('x'.repeat(101)),'/001?warehouse_source_id=007&q=x','/capture?warehouse_source_id=007'])assert.throws(()=>route(s));
 assert.throws(()=>parseStockObservationsRoute(new Request('https://erp.invalid'+STOCK_OBSERVATIONS_BASE+'?warehouse_source_id=007',{method:'POST',body:'{}'})),{code:'ERP_METHOD_NOT_ALLOWED'});
});
test('087 captures actor/rpc before await and only returns bound immutable projection',async()=>{
 let release;const gate=new Promise(r=>release=r);let seen;const ctx={userId:actor,rpc:async(name,args,options)=>{seen={name,args,options};await gate;return fixture();}};
 const p=executeStockObservationsRoute(route(),ctx);ctx.userId=record;ctx.rpc=()=>{throw Error('changed');};release();const got=await p;assert.equal(seen.args.p_user_id,actor);assert.equal(seen.name,'erp_origin_stock_observations');assert.equal(seen.args.p_warehouse_source_id,'007');assert.ok(seen.options.signal instanceof AbortSignal);assert.equal(got.read_only,true);
 await reject(()=>executeStockObservationsRoute({...route()},{userId:actor,rpc:()=>fixture()}),'ERP_NOT_FOUND');
});
test('087 abort/deadline closes a never-settling port and post-parse deadline is checked',async()=>{
 const abort=new AbortController();abort.abort();let calls=0;await reject(()=>executeStockObservationsRoute(route(),{userId:actor,signal:abort.signal,rpc(){calls++;}}),'ERP_REQUEST_TIMEOUT');assert.equal(calls,0);
 await reject(()=>executeStockObservationsRoute(route(),{userId:actor,timeoutMs:5,rpc:()=>new Promise(()=>{})}),'ERP_REQUEST_TIMEOUT');
 const originalNow=Date.now,Encoder=globalThis.TextEncoder;let now=0;Date.now=()=>now;globalThis.TextEncoder=class extends Encoder{encode(v){const x=super.encode(v);now=200;return x;}};
 try{await reject(()=>executeStockObservationsRoute(route(),{userId:actor,timeoutMs:100,rpc:()=>fixture()}),'ERP_REQUEST_TIMEOUT');}finally{Date.now=originalNow;globalThis.TextEncoder=Encoder;}
});
test('087 SQL errors are closed and raw payload/PII never enters transport errors',async()=>{
 for(const[code,expected]of[['42501','ERP_ACCESS_DENIED'],['22023','ERP_INVALID_QUERY'],['P0002','ERP_NOT_FOUND'],['other','ERP_UPSTREAM_UNAVAILABLE']])await reject(()=>executeStockObservationsRoute(route(),{userId:actor,rpc:()=>{throw Object.assign(new Error('PRIVATE'),{code});}}),expected);
 const p=fixture();p.items[0].product.source_name=obs('value','x'.repeat(262144));assert.throws(()=>parse(p),{code:'ERP_UPSTREAM_INVALID_RESPONSE'});
});
