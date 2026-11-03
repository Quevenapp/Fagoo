import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parseFinancialImportRoute,executeFinancialImportRoute,financialImportMethods} from '../src/financial-import.mjs';
const prefix='https://erp.invalid/v1/importacao-financeira-origin';
const base=()=>({entity:'receivables',duplicate_reviewed:true,items:[{source_id:'123',source_hash:'a'.repeat(64),source_version:'1',source_seen_at:'2026-10-16T10:30:00.123456Z',category_id:null,category_version:null}]});
const request=(path,body=base(),extra={})=>new Request(prefix+path,{method:'POST',headers:{'content-type':'application/json',...extra.headers},body:JSON.stringify(body),...Object.fromEntries(Object.entries(extra).filter(([k])=>k!=='headers'))});
const invalid=e=>e.status===400;
test('039 import input is exact, explicit and bounded; money/contact never come from the browser',async()=>{
 const variants=[v=>v.duplicate_reviewed=false,v=>v.items=[],v=>v.items=Array.from({length:26},(_,i)=>({...v.items[0],source_id:String(i+1)})),v=>v.items.push(v.items[0]),
  v=>v.items[0].amount_cents='1',v=>v.items[0].contact_id=randomUUID(),v=>v.entity='contacts',v=>delete v.items[0].category_id,
  v=>v.items[0].category_id=randomUUID(),v=>v.items[0].source_hash=['a'.repeat(64)],v=>v.items[0].source_version='9223372036854775808',
  v=>v.items[0].source_version=1,v=>v.items[0].source_id='0',v=>v.items[0].source_id='123 ',v=>v.items[0].source_seen_at='2026-10-16',v=>v.items[0].category_version=1];
 for(const mutate of variants){const value=base();mutate(value);await assert.rejects(()=>parseFinancialImportRoute(request('/preview',value)),invalid);}
 const value=base(),category=randomUUID();value.items[0].category_id=category.toUpperCase();value.items[0].category_version=2;
 const route=await parseFinancialImportRoute(request('/preview',value));assert.equal(route.args.p_items[0].category_id,category);assert.equal(route.args.p_items[0].source_seen_at,value.items[0].source_seen_at);
 const apply={...base(),command_id:randomUUID(),preview_hash:'b'.repeat(64),confirm_import:true};assert.equal((await parseFinancialImportRoute(request('/apply',apply))).type,'apply');
 for(const mutate of[v=>delete v.confirm_import,v=>v.confirm_import=false,v=>v.preview_hash=['b'.repeat(64)],v=>v.command_id='bad']){const bad=structuredClone(apply);mutate(bad);await assert.rejects(()=>parseFinancialImportRoute(request('/apply',bad)),invalid);}
});
test('039 paths and methods separate finance-read origin from admin operations without accepting query aliases',async()=>{
 assert.equal(financialImportMethods('/v1/importacao-financeira-origin-evil/preview'),null);
 assert.deepEqual(financialImportMethods('/v1/importacao-financeira-origin/preview'),['POST']);
 for(const path of['/preview?q=x','/apply?actor=x','/batches/'+randomUUID()+'?x=1','/origins/receivables/123?q=x','/titles/'+randomUUID()+'/origin?version=1']){
  await assert.rejects(()=>parseFinancialImportRoute(path.startsWith('/preview')||path.startsWith('/apply')?request(path):new Request(prefix+path)),invalid);
 }
 for(const path of['/origins/contacts/1','/preview/extra','/titles/'+randomUUID()+'/origin/other'])await assert.rejects(()=>parseFinancialImportRoute(new Request(prefix+path)),e=>e.status===404);
 for(const path of['/origins/receivables/%ZZ','/origins/payables/00','/batches/not-uuid'])await assert.rejects(()=>parseFinancialImportRoute(new Request(prefix+path)),invalid);
 await assert.rejects(()=>parseFinancialImportRoute(new Request(prefix+'/preview')),e=>e.status===405);
 await assert.rejects(()=>parseFinancialImportRoute(request('/titles/'+randomUUID()+'/origin')),e=>e.status===405);
 const id=randomUUID(),route=await parseFinancialImportRoute(new Request(prefix+'/titles/'+id.toUpperCase()+'/origin'));assert.equal(route.args.p_title_id,id);
 await assert.rejects(()=>executeFinancialImportRoute(route,{userId:'not-an-actor',rpc:()=>assert.fail('RPC must not run')}),e=>e.status===403);
});
test('039 encoded or oversized body is rejected before parsing and streams are cancelled',async()=>{
 for(const headers of[{'content-encoding':'gzip'},{'content-length':'65537'},{'content-length':'invalid'},{'content-type':'text/plain'}])await assert.rejects(()=>parseFinancialImportRoute(request('/preview',base(),{headers})),invalid);
 await assert.rejects(()=>parseFinancialImportRoute(request('/preview',{...base(),padding:'x'.repeat(65536)})),invalid);
 let cancelled=false;const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(65537));},cancel(){cancelled=true;}});
 await assert.rejects(()=>parseFinancialImportRoute(new Request(prefix+'/preview',{method:'POST',headers:{'content-type':'application/json'},body:stream,duplex:'half'})),invalid);assert.equal(cancelled,true);
 const controller=new AbortController();controller.abort();await assert.rejects(()=>parseFinancialImportRoute(request('/preview',base(),{signal:controller.signal})),invalid);
});
test('039 stalled body has a finite deadline and cannot reach the mutation RPC',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let cancelled=false;
 const stream=new ReadableStream({cancel(){cancelled=true;}}),pending=parseFinancialImportRoute(new Request(prefix+'/preview',{method:'POST',headers:{'content-type':'application/json'},body:stream,duplex:'half'}));
 t.mock.timers.tick(10001);await assert.rejects(()=>pending,e=>e.status===408);assert.equal(cancelled,true);
});
test('039 minimal title provenance binds title UUID, strips private fields and requires explicit locks',async()=>{
 const id=randomUUID(),actor=randomUUID(),route=await parseFinancialImportRoute(new Request(prefix+'/titles/'+id+'/origin'));
 const value={data_mode:'erp_native',read_only:true,title_id:id,origin:{system:'origin',entity:'receivables',source_id:'123',batch_id:randomUUID(),imported_at:'2026-10-16T10:00:00Z',source_hash:'a'.repeat(64),source_version:'1',core_fields_locked:true,cnab_reservation_blocked:true,payload:{secret:'PRIVATE'}}};
 const safe=await executeFinancialImportRoute(route,{userId:actor.toUpperCase(),rpc:async(name,args)=>{assert.equal(name,'erp_origin_financial_import_title_origin');assert.equal(args.p_user_id,actor);return value;}});assert.doesNotMatch(JSON.stringify(safe),/PRIVATE|payload/);
 for(const mutate of[v=>v.title_id=randomUUID(),v=>v.origin.core_fields_locked=false,v=>v.origin.cnab_reservation_blocked=false,v=>v.origin.source_version=1]){const bad=structuredClone(value);mutate(bad);await assert.rejects(()=>executeFinancialImportRoute(route,{userId:actor,rpc:async()=>bad}),e=>e.status===502);}
 assert.equal((await executeFinancialImportRoute(route,{userId:actor,rpc:async()=>({...value,origin:null})})).origin,null);
});
