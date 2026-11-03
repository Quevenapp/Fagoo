import test from 'node:test';import assert from 'node:assert/strict';
import {captureSalesHistoryRequest,salesHistoryListPath,salesHistoryDetailPath,SALES_HISTORY_RESPONSE_BYTES} from '../src/lib/origin-sales-history-request.ts';
import {BASE,id} from './helpers/sales-history-fixtures.mjs';
test('083 captures a GET-only immutable request and exact historical IDs before awaiting',()=>{
 const controller=new AbortController(),options={method:'GET',signal:controller.signal},r=captureSalesHistoryRequest(salesHistoryDetailPath(id(1)),options);options.method='POST';assert.equal(r.options.method,'GET');assert.equal(r.options.signal,controller.signal);assert.equal(r.historyId,id(1));assert.ok(Object.isFrozen(r.options));assert.equal(SALES_HISTORY_RESPONSE_BYTES,1048576);
 const path=salesHistoryListPath(' %_ número ',id(1));assert.equal(new URL(path,'https://test.invalid').searchParams.get('q'),'%_ número');assert.equal(captureSalesHistoryRequest(path).historyId,null);
});
test('083 rejects mutation, operational UUIDs, command/capture routes and ambiguous filters',()=>{
 for(const path of [BASE+'/capture',BASE+'/commands/'+id(1).slice(4),BASE+'/'+id(1).slice(4),BASE+'/'+id(1)+'?q=x',BASE+'?limit=26',BASE+'?limit=01',BASE+'?q=a&q=b',BASE+'?after=1',BASE+'?q=%00',BASE+'?unknown=1',BASE+'#fragment'])assert.throws(()=>captureSalesHistoryRequest(path));
 for(const options of [{method:'POST'},{method:'PATCH'},{body:{}},{signal:{}},{extra:true}])assert.throws(()=>captureSalesHistoryRequest(BASE,options));assert.throws(()=>salesHistoryListPath('x'.repeat(101)));assert.throws(()=>salesHistoryDetailPath(id(1).slice(4)));
});
test('083 rejects option accessors without invoking them',()=>{let invoked=0;const options={get method(){invoked++;return'GET';}};assert.throws(()=>captureSalesHistoryRequest(BASE,options));assert.equal(invoked,0);});
