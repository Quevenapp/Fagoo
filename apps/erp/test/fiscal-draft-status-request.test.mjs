import test from 'node:test';
import assert from 'node:assert/strict';
import {captureFiscalDraftStatusRequest as capture,fiscalDraftStatusPath as path,FISCAL_DRAFT_STATUS_PATH as BASE,FISCAL_DRAFT_STATUS_RESPONSE_BYTES} from '../src/lib/fiscal-draft-status-request.ts';
const id='a0000000-0000-4000-8000-000000000082';
test('082 summary request binds only the readonly endpoint and existing list filters',()=>{
 assert.equal(FISCAL_DRAFT_STATUS_RESPONSE_BYTES,262144);
 for(const model of ['','55','65'])for(const status of ['','draft','archived']){
  const url=path({model,status},id),p=new URL(url,'https://synthetic.invalid');
  assert.equal(p.pathname,BASE);assert.equal(p.searchParams.get('model'),model||null);assert.equal(p.searchParams.get('status'),status||null);assert.equal(p.searchParams.get('after'),id);assert.equal(capture(url).options.method,'GET');
 }
 assert.equal(capture(BASE).base,'/v1/rascunhos-fiscais');
 assert.equal(new URL(path({model:'55',status:''},null,id),'https://synthetic.invalid').searchParams.get('source_document_id'),id);
 assert.equal(capture(BASE+'?source_document_id='+id).options.method,'GET');
});
test('082 captures method and signal without retaining mutable options or evaluating accessors',()=>{
 const controller=new AbortController(),input={method:'GET',signal:controller.signal},selected=capture(BASE,input);
 input.method='POST';input.body={command_id:id};input.signal=new AbortController().signal;
 assert.deepEqual(Object.keys(selected.options).sort(),['method','signal']);assert.equal(selected.options.method,'GET');assert.equal(selected.options.signal,controller.signal);assert.ok(Object.isFrozen(selected.options));
 let getters=0;for(const key of ['method','body','signal'])assert.throws(()=>capture(BASE,Object.defineProperty({},key,{enumerable:true,get(){getters++;return'GET';}})));
 assert.equal(getters,0);controller.abort();assert.equal(selected.options.signal.aborted,true);
});
test('082 request refuses draft mutations, adjacent paths and ambiguous or injected list parameters',()=>{
 for(const input of [{method:'POST'},{method:'PATCH'},{method:'DELETE'},{body:null},{body:{}},{signal:{}},{actor:id},Object.defineProperty({},'method',{value:'GET'})])assert.throws(()=>capture(BASE,input));
 for(const suffix of ['/','/'+id,'/../'+id,'?actor='+id,'?model=55&model=65','?limit=26','?limit=01','?limit=0','?after=bad','?status=authorized','?model=57','?status=','?x=1','#x','?limit=25#x'])assert.throws(()=>capture(BASE+suffix));
 for(const other of ['/v1/rascunhos-fiscais','/v1/rascunhos-fiscais/'+id,'https://synthetic.invalid'+BASE])assert.throws(()=>capture(other));
 assert.throws(()=>path({model:'55',status:'authorized'}));assert.throws(()=>path({model:'55',status:''},'bad'));
});
