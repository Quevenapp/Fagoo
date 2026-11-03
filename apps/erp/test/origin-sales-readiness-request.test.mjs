import test from 'node:test';import assert from 'node:assert/strict';
import {SALES_READINESS_BASE as B,captureSalesReadinessRequest as capture,salesReadinessListPath as list,salesReadinessDetailPath as detail} from '../src/lib/origin-sales-readiness-request.ts';
test('sales readiness accepts only bounded GET list/detail routes, with exact decimal source IDs',()=>{
 const id='9'.repeat(40);assert.equal(detail(id),B+'/'+id);assert.equal(capture(detail(id)).sourceId,id);assert.equal(capture(B).sourceId,null);assert.equal(list(' Venda QA/1 ','2'),B+'?limit=25&q=Venda+QA%2F1&after=2');
 for(const path of [B+'/01',B+'/0',B+'/'+id+'0',B+'/1?x=1',B+'/1/',B+'/preview',B+'/apply',B+'?limit=26',B+'?limit=1&limit=2',B+'?after=01',B+'?q=%00',B+'?q=%C2%85',B+'?q='+encodeURIComponent('x'.repeat(101)),B+'?status=0',B+'?q=a#fragment','https://evil.invalid'+B])assert.throws(()=>capture(path));
 for(const options of [{method:'POST'},{method:'PATCH'},{body:{}},{body:null},{headers:{}},{signal:{}}])assert.throws(()=>capture(B,options));
 for(const path of [B+'/1\n',B+'?after=1%0A',B+'?limit=1%0A'])assert.throws(()=>capture(path));
 assert.throws(()=>list('x\n'));assert.throws(()=>detail('0001'));assert.throws(()=>detail('1\n'));
});
test('sales readiness copies method/signal before await without invoking input getters',()=>{
 const a=new AbortController(),b=new AbortController(),options={method:'GET',signal:a.signal},r=capture(B+'?limit=25',options);options.method='POST';options.signal=b.signal;assert.equal(r.options.method,'GET');assert.equal(r.options.signal,a.signal);assert.ok(Object.isFrozen(r)&&Object.isFrozen(r.options));
 let gets=0;for(const key of ['method','signal','body']){const input={};Object.defineProperty(input,key,{enumerable:true,get(){gets++;return undefined;}});assert.throws(()=>capture(B,input));}assert.equal(gets,0);assert.throws(()=>capture(B,{[Symbol('private')]:true}));
});
