import test from'node:test';import assert from'node:assert/strict';
import{parsePurchaseReadinessRoute as parse,executePurchaseReadinessRoute as execute,purchaseReadinessMethods,PurchaseReadinessError,PURCHASE_READINESS_BASE as BASE}from'../src/origin-purchase-readiness.mjs';
import{parsePurchaseReadinessPage,parsePurchaseReadinessDetail}from'../../../packages/erp-domain/src/origin-purchase-readiness-dto.mjs';
import{ACTOR,OTHER,page,detail,deferred}from'../../../apps/erp/test/helpers/purchase-readiness-fixtures.mjs';
const request=(path='',method='GET')=>new Request('https://synthetic.invalid'+BASE+path,{method});
test('076 only fixed GET routes and closed bounded queries; no mutation or guessed source identifiers',()=>{
 assert.equal(parse(new Request('https://synthetic.invalid/v1/other')),null);assert.deepEqual(purchaseReadinessMethods(BASE),['GET']);assert.equal(purchaseReadinessMethods('/v1/other'),null);
 for(const path of ['?limit=0','?limit=26','?limit=01','?after=01','?q='+encodeURIComponent('\u0085'),'?q='+'x'.repeat(101),'?limit=1&limit=1','?actor='+ACTOR,'/01','/%31','/100000?raw=1','/commands/x','/preview','?q='+'界'.repeat(1000)])assert.throws(()=>parse(request(path)),e=>[400,404].includes(e.status));
 for(const method of ['POST','PUT','PATCH','DELETE','HEAD','OPTIONS'])assert.throws(()=>parse(request('',method)),e=>e.status===405);
 const r=parse(request('?limit=25&after=999&q=%25'));assert.deepEqual(r.args,{p_limit:25,p_after:'999',p_query:'%'});assert.ok(Object.isFrozen(r)&&Object.isFrozen(r.args));
});
test('076 captures actor/port/options before await and forwards only the fixed read RPC',async()=>{
 const gate=deferred(),calls=[],context={userId:ACTOR,rpc:async(name,args,options)=>{calls.push({name,args,options});return gate.promise;}};
 const route=parse(request('/100000')),pending=execute(route,context);context.userId=OTHER;context.rpc=()=>assert.fail('replacement must not run');await Promise.resolve();
 assert.equal(calls[0].name,'erp_origin_purchase_readiness_detail');assert.deepEqual(calls[0].args,{p_source_id:'100000',p_user_id:ACTOR});assert.ok(Object.isFrozen(calls[0].args));assert.ok(calls[0].options.signal instanceof AbortSignal);gate.resolve(detail());assert.equal((await pending).source.source_id,'100000');assert.equal(calls.length,1);
 await assert.rejects(()=>execute({...route},{userId:ACTOR,rpc:()=>assert.fail()}),e=>e.status===404);let reads=0;await assert.rejects(()=>execute(route,{userId:ACTOR,get rpc(){reads++;return()=>{};}}),e=>e.status===400);assert.equal(reads,0);
});
test('076 timeout/abort suppress late result and never retry reads or send writes',async()=>{
 let calls=0;const stop=new AbortController();stop.abort();await assert.rejects(()=>execute(parse(request()),{userId:ACTOR,signal:stop.signal,rpc:()=>{calls++;}}),e=>e.status===408);assert.equal(calls,0);
 const active=new AbortController(),gate=deferred();let sent;const entered=new Promise(r=>sent=r);const pending=execute(parse(request()),{userId:ACTOR,signal:active.signal,rpc:()=>{calls++;sent();return gate.promise;}});await entered;active.abort();await assert.rejects(()=>pending,e=>e.status===408);gate.resolve(page());await Promise.resolve();assert.equal(calls,1);
 await assert.rejects(()=>execute(parse(request()),{userId:ACTOR,timeoutMs:5,rpc:()=>{calls++;return new Promise(()=>{});}}),e=>e.status===408);assert.equal(calls,2);
});
test('076 sanitized SQL errors and malformed responses never expose diagnostics or claim mutation uncertainty',async()=>{
 for(const[code,status]of[['42501',403],['P0002',404],['22023',400],['PRIVATE_SECRET',502],['__proto__',502]])await assert.rejects(()=>execute(parse(request()),{userId:ACTOR,rpc:()=>{throw{code,message:'PRIVATE_RAW_SQL'};}}),e=>e.status===status&&!e.message.includes('PRIVATE')&&e.code!=='ERP_RESULT_UNCONFIRMED');
 await assert.rejects(()=>execute(parse(request()),{userId:ACTOR,rpc:()=>({...page(),payload:'PRIVATE'})}),e=>e.status===502);let called=0;const error={get code(){called++;return'42501';}};await assert.rejects(()=>execute(parse(request()),{userId:ACTOR,rpc:()=>{throw error;}}),e=>e.status===502);assert.equal(called,0);
});
test('076 DTO rejects claims, secrets, accessors, malformed timestamps, numeric coercion and stale binding',()=>{
 for(const mutate of [v=>v.can_import=true,v=>v.native_effects=true,v=>v.coverage_certified=true,v=>v.pending_contracts=[],v=>v.source.source_id='100001',v=>v.source.source_version='9223372036854775808',v=>v.observed_at='2026-02-30T12:00:00Z',v=>v.source.last_seen_at='2026-01-01T12:00:00+15:00',v=>v.items[0].unit_price.value=12.5,v=>v.items[0].unit_price.value='1.00000000001',v=>v.items[0].product.active=false,v=>v.items[0].product.applied_hash='c'.repeat(64),v=>v.items[0].invoice_reference.source_id='23',v=>v.history.comparison='same',v=>v.items=[],v=>v.secret='PRIVATE',v=>v.source.capture.tokens=[]]){const raw=detail();mutate(raw);assert.throws(()=>parsePurchaseReadinessDetail(raw,{sourceId:'100000'}),e=>e instanceof PurchaseReadinessError&&e.status===502);}
 let reads=0;const raw=detail();Object.defineProperty(raw,'source',{enumerable:true,get(){reads++;return{};}});assert.throws(()=>parsePurchaseReadinessDetail(raw,{sourceId:'100000'}));assert.equal(reads,0);
 const copied=detail(),result=parsePurchaseReadinessDetail(copied,{sourceId:'100000'});copied.items[0].unit_price.value='9';assert.equal(result.items[0].unit_price.value,'12.1234567891');assert.ok(Object.isFrozen(result.items[0].unit_price));
});
test('076 DTO pages reject repeated/backward cursors, wrong count, and oversized data',()=>{
 for(const mutate of [v=>v.items.push(v.items[0]),v=>v.limit=1,v=>v.next_cursor='100000',v=>v.has_more=true,v=>v.items[0].source_id='1'.repeat(41),v=>v.items[0].number.value='x'.repeat(1048577)]){const raw=page();mutate(raw);assert.throws(()=>parsePurchaseReadinessPage(raw,{limit:25,after:null}));}assert.throws(()=>parsePurchaseReadinessPage(page(),{limit:25,after:'100001'}));
});
