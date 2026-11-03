import test from 'node:test';
import assert from 'node:assert/strict';
import {receiptQueryRoute,parseReceiptQueryPayload,receiptQueryBinding,isReceiptQueryMutation,receiptQueryMutationPath} from '../src/receipt-query-protocol.mjs';
import {createReceiptQueryBoundary} from '../src/receipt-query-boundary.mjs';
import {publicContext,publicHistory,publicResult,publicSelection,contextBinding,uuid} from '../../fiscal-authorization/test/receipt-query-public-fixture.mjs';
const base='/internal/v1/fiscal-authorization',actor=uuid(500),ctx=publicContext(),history=publicHistory();
const run={...publicSelection(),command_id:uuid(11),confirmed:true};
const cases=[
 ['/reviewed/receipt-query-context','POST','receiptQueryContext',contextBinding(ctx).input,'context'],
 ['/reviewed/receipt-query-history','POST','receiptQueryHistory',history.binding.input,'history'],
 ['/reviewed/receipt-queries','POST','receiptQueryRun',run,'run'],
 ['/reviewed/receipt-query-commands/'+run.command_id,'GET','receiptQueryCommand',undefined,'command'],
 ['/reviewed/receipt-query-commands/'+run.command_id+'/recover','POST','receiptQueryRecover',{confirmed:true},'recover'],
];
const bytes=v=>new TextEncoder().encode(v===undefined?'':JSON.stringify(v));
const scope=()=>({signal:new AbortController().signal,deadline:Date.now()+1000,check(){},bounded:fn=>fn()});
function service(overrides={}){return {context:async()=>publicContext(),history:async()=>publicHistory().raw,run:async()=>publicResult({readOnly:false}),command:async()=>publicResult(),recover:async()=>publicResult({readOnly:false}),...overrides};}
test('089 routes preserve read semantics for POST context/history and never alias authorization paths',()=>{
 for(const[path,method,action,input]of cases){
  const selected=receiptQueryRoute(base+path,method,base);assert.equal(selected.action,action);assert.equal(selected.receiptQuery,true);assert.ok(Object.isFrozen(selected));
  const mutation=['receiptQueryRun','receiptQueryRecover'].includes(action);assert.equal(isReceiptQueryMutation(action),mutation);assert.equal(receiptQueryMutationPath(base+path,method),mutation);
  const payload=parseReceiptQueryPayload(bytes(input),selected),binding=receiptQueryBinding(selected,payload);assert.equal(binding.action,action);assert.ok(Object.isFrozen(binding));
  assert.throws(()=>receiptQueryRoute(base+path,method==='GET'?'POST':'GET',base),e=>e.status===405);
  assert.equal(receiptQueryRoute(base+path+'/','GET',base),null);
 }
 for(const path of['/reviewed/run','/reviewed/commands/'+uuid(1)+'/recover','/reviewed/revalidations'])assert.equal(receiptQueryRoute(base+path,'POST',base),null);
 assert.throws(()=>receiptQueryRoute(base+'/reviewed/receipt-query-commands/garbage','GET',base),e=>e.status===404);
});
test('089 payloads are captured synchronously, exact and bounded; no actor, receipt, URL or XML input',()=>{
 for(const[path,method,,input]of cases){const selected=receiptQueryRoute(base+path,method,base);
  if(method==='GET'){assert.throws(()=>parseReceiptQueryPayload(bytes({}),selected));continue;}
  for(const extra of[{actor},{receipt_number:'123456789012345'},{xml:'PRIVATE'},{url:'https://untrusted.invalid'},{confirmed:false}]){
   assert.throws(()=>parseReceiptQueryPayload(bytes({...input,...extra}),selected),e=>e.status===400);
  }
  assert.throws(()=>parseReceiptQueryPayload(new Uint8Array(16385),selected));assert.throws(()=>parseReceiptQueryPayload(new Uint8Array([255]),selected));
 }
 assert.throws(()=>receiptQueryBinding({action:'receiptQueryCommand',commandId:uuid(1)},{}));
});
test('089 boundary calls only the selected port with frozen actor/body and deadline',async()=>{
 const calls=[],port=service(),boundary=createReceiptQueryBoundary(Object.fromEntries(Object.entries(port).map(([name,fn])=>[name,async(...args)=>{calls.push({name,args});return fn(...args);}])));
 for(const[path,method,,input,name]of cases){const selected=receiptQueryRoute(base+path,method,base),payload=parseReceiptQueryPayload(bytes(input),selected),s=scope();
  const res=await boundary(selected,payload,actor,s);assert.equal(res.status,200,await res.clone().text());assert.equal(res.headers.get('cache-control'),'no-store');
  const call=calls.at(-1);assert.equal(call.name,name);assert.ok(Object.isFrozen(call.args[0]));assert.ok(Object.isFrozen(call.args[1]));assert.equal(call.args[0].actor,actor);assert.equal(call.args[1].signal,s.signal);assert.equal(call.args[1].deadline,s.deadline);
  if(['context','history','run'].includes(name)){assert.deepEqual(call.args[0].request,input);assert.ok(Object.isFrozen(call.args[0].request));}
  else assert.equal(call.args[0].commandId,run.command_id);
 }
 assert.equal(calls.length,5);
});
test('089 read failures never advertise uncertain mutation; run and local recovery retain query UUID',async()=>{
 for(const[path,method,action,input,name]of cases){const boundary=createReceiptQueryBoundary(service({[name]:async()=>{throw Error('PRIVATE_SECRET_OR_XML');}}));
  const selected=receiptQueryRoute(base+path,method,base),res=await boundary(selected,parseReceiptQueryPayload(bytes(input),selected),actor,scope()),value=await res.json();
  assert.equal(res.status,503);assert.equal(value.recovery_required,isReceiptQueryMutation(action));assert.doesNotMatch(JSON.stringify(value),/PRIVATE/);
  if(isReceiptQueryMutation(action))assert.equal(value.command_id,run.command_id);
 }
});
test('089 SQL errors are definitive unless mutation explicitly reports an uncertain durable outcome',async()=>{
 for(const[code,status]of[['42501',403],['P0002',404],['40001',409],['55000',409],['22023',400]])for(const uncertain of[false,true]){
  const boundary=createReceiptQueryBoundary(service({run:async()=>{throw Object.assign(Error('PRIVATE'),{code,recovery_required:uncertain});}}));
  const selected=receiptQueryRoute(base+'/reviewed/receipt-queries','POST',base),res=await boundary(selected,parseReceiptQueryPayload(bytes(run),selected),actor,scope()),value=await res.json();
  assert.equal(res.status,uncertain?503:status);assert.equal(value.recovery_required,uncertain);assert.equal(value.command_id,run.command_id);assert.doesNotMatch(JSON.stringify(value),/PRIVATE/);
 }
});
test('089 malformed output after run cannot release private data or lose recovery identity',async()=>{
 for(const alter of[v=>v.source.source_command_id=uuid(999),v=>v.receipt.authorization_attempt_id=uuid(998),v=>v.current.can_recover='true',v=>v.private_key='PRIVATE',v=>v.production_authorized=true]){
  const boundary=createReceiptQueryBoundary(service({run:async()=>{const v=publicResult({readOnly:false});alter(v);return v;}}));
  const selected=receiptQueryRoute(base+'/reviewed/receipt-queries','POST',base),res=await boundary(selected,parseReceiptQueryPayload(bytes(run),selected),actor,scope()),value=await res.json();
  assert.equal(res.status,502);assert.equal(value.recovery_required,true);assert.equal(value.command_id,run.command_id);assert.doesNotMatch(JSON.stringify(value),/PRIVATE/);
 }
});
test('089 service can attest pre-dispatch refusal, while unmarked failures remain uncertain',async()=>{
 for(const[code,recovery,statusCode]of[['AUTHORIZATION_SERVICE_DISABLED',false,'AUTHORIZATION_SERVICE_DISABLED'],['SOURCE_UNAVAILABLE',false,'AUTHORIZATION_SERVICE_UNAVAILABLE'],['SOURCE_UNAVAILABLE',undefined,'AUTHORIZATION_SERVICE_UNAVAILABLE']]){
  const boundary=createReceiptQueryBoundary(service({run:async()=>{throw Object.assign(Error('PRIVATE'),{code,...(recovery===undefined?{}:{recovery_required:recovery})});}}));
  const selected=receiptQueryRoute(base+'/reviewed/receipt-queries','POST',base),response=await boundary(selected,parseReceiptQueryPayload(bytes(run),selected),actor,scope()),value=await response.json();
  assert.equal(response.status,503);assert.equal(value.error,statusCode);assert.equal(value.recovery_required,recovery!==false);assert.equal(value.command_id,run.command_id);
 }
});
