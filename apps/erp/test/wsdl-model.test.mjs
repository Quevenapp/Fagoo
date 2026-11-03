import test from 'node:test';
import assert from 'node:assert/strict';
import {wsdlRun,wsdlResult,bindWsdlResult,wsdlReady,validWsdlRun,WSDL_OPERATIONS} from '../src/lib/wsdl-model.ts';
import {parsePayload,route} from '../../../packages/fiscal-wsdl-runtime/src/protocol.mjs';
import {payload,result,unconfirmed,command} from '../../../packages/fiscal-wsdl-runtime/test/fixtures.mjs';
import {configured,company} from './helpers/a1-fixtures.mjs';
const copy=structuredClone,identity={version:company.record.version,...company.record.data};
test('WSDL intention explicitly binds current A1/company/model/service and agrees with the unchanged runtime contract',()=>{
 for(const model of ['55','65'])for(const operation of Object.keys(WSDL_OPERATIONS)){const body=wsdlRun(model,operation,configured,identity,true,command);assert.deepEqual(body,{...payload(),model,operation});assert.equal(validWsdlRun(body),true);assert.ok(Object.isFrozen(body));assert.deepEqual(parsePayload(new TextEncoder().encode(JSON.stringify(body)),route('/v1/fiscal-wsdl/run','POST','/v1/fiscal-wsdl')),body);}
 for(const input of [['','protocol',configured,identity,true],['55','protocol',configured,identity,false],['55','protocol',{...configured,time_valid_now:false},identity,true],['55','protocol',{...configured,company_changed:true},identity,true],['55','protocol',configured,{...identity,version:3},true],['55','protocol',configured,{...identity,cnpj:'11222333000181'},true]])assert.throws(()=>wsdlRun(...input,command));
 for(const operation of ['',undefined,null,'status','authorization/send','constructor',['protocol']]){assert.throws(()=>wsdlRun('55',operation,configured,identity,true,command));assert.equal(validWsdlRun({...payload(),operation}),false);}
 assert.equal(wsdlReady(null,identity),false);assert.equal(validWsdlRun({...payload(),endpoint:'https://private.invalid'}),false);
 assert.equal(validWsdlRun({...payload(),model:['55']}),false);let coerced=false;assert.equal(validWsdlRun({...payload(),model:{toString(){coerced=true;return'55';}}}),false);assert.equal(coerced,false);
});
test('WSDL readback preserves receipt and artifact while current A1 may change',()=>{
 const prior=wsdlResult(result(),{body:payload()}),next=result('stored',payload(),true);next.current.a1_version=2;next.current.a1_changed=true;
 const current=bindWsdlResult(wsdlResult(next,{commandId:command}),payload(),prior);assert.equal(current.receipt.a1_version,1);assert.equal(current.current.a1_version,2);assert.ok(Object.isFrozen(current.receipt));
 const altered=copy(next);altered.artifact.sha256='b'.repeat(64);assert.throws(()=>bindWsdlResult(wsdlResult(altered,{commandId:command}),payload(),prior));
 assert.equal(wsdlResult(unconfirmed(),{body:payload()}).recovery_required,true);
});
test('WSDL frontend rejects private extras, invented gate successes, wrong binding and getters',()=>{
 for(const change of [v=>v.execution={},v=>v.can_emit=true,v=>v.receipt.issuer_cnpj='PRIVATE',v=>v.current.lease_id='PRIVATE',v=>v.artifact.evidence={},v=>v.artifact.sha256='x']){const raw=result();change(raw);assert.throws(()=>wsdlResult(raw,{body:payload()}));}
 let invoked=false;const raw=result();Object.defineProperty(raw,'current',{get(){invoked=true;return null;},enumerable:true});assert.throws(()=>wsdlResult(raw,{body:payload()}));assert.equal(invoked,false);
 assert.throws(()=>bindWsdlResult(wsdlResult(result('stored',payload(),true),{commandId:command}),{...payload(),expected_identity_version:99}));
 for(const operation of ['authorization','receipt'])assert.throws(()=>bindWsdlResult(wsdlResult(result('stored',payload(),true),{commandId:command}),{...payload(),operation}));
});
