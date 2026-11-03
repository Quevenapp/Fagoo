import test from 'node:test';import assert from 'node:assert/strict';
import {captureFiscalReceiptQueryRequest as capture} from '../src/lib/fiscal-receipt-query-request.ts';
import {publicSelection,uuid} from '../../../packages/fiscal-authorization/test/receipt-query-public-fixture.mjs';
const B='/v1/fiscal-authorization/reviewed';
test('exact five routes separate POST reads from mutation and capture body before any credential wait',()=>{
 const context={source_kind:'authorization',source_command_id:uuid(1),expected_attempt_id:uuid(3)},history={authorization_command_id:uuid(1),expected_attempt_id:uuid(3),limit:25,before:null},run={...publicSelection(),command_id:uuid(11),confirmed:true};
 for(const[path,body,mutation]of[[B+'/receipt-query-context',context,false],[B+'/receipt-query-history',history,false],[B+'/receipt-queries',run,true],[B+'/receipt-query-commands/'+uuid(11)+'/recover',{confirmed:true},true]]){
  const options={method:'POST',body:structuredClone(body),signal:new AbortController().signal},value=capture(path,options);options.body.confirmed=false;options.method='GET';assert.equal(value.options.method,'POST');assert.equal(value.mutation,mutation);assert.equal(value.requestLimit,16384);assert.equal(value.responseLimit,262144);assert.equal(value.timeoutMs,45000);assert.ok(Object.isFrozen(value.options.body));
 }
 assert.equal(capture(B+'/receipt-query-commands/'+uuid(11)).mutation,false);
});
test('paths/methods/extras/aliases/proof/getters are refused with no execution or fallback',()=>{
 for(const path of [B+'/run',B+'/receipt-queries?x=1',B+'/receipt-query-commands/invalid',B+'/receipt-query-commands/'+uuid(11)+'#x',B+'/receipt-query-commands/%31'])assert.throws(()=>capture(path));
 assert.throws(()=>capture(B+'/receipt-query-context',{method:'GET'}));assert.throws(()=>capture(B+'/receipt-query-commands/'+uuid(11),{body:{}}));assert.throws(()=>capture(B+'/receipt-query-commands/'+uuid(11),{signal:{}}));
 let read=false;const options={};Object.defineProperty(options,'body',{enumerable:true,get(){read=true;return{};}});assert.throws(()=>capture(B+'/receipt-queries',options));assert.equal(read,false);
 assert.throws(()=>capture(B+'/receipt-queries',{method:'POST',body:{...publicSelection(),command_id:uuid(11),confirmed:true,receipt_number:'123456789012345'}}));
});
