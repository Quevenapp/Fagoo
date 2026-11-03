import test from 'node:test';import assert from 'node:assert/strict';
import {createFiscalProcessedDocumentClient} from '../src/lib/fiscal-processed-document-client.ts';
import {checkedProcessedDocument,processedDocumentPath} from '../src/lib/fiscal-processed-document-model.ts';
import {processedUiFixtures} from './helpers/fiscal-processed-document-fixtures.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
let f,x;test.before(async()=>{f=await processedUiFixtures();x=await f.create();});test.after(()=>f?.close());
function setup(value=x.xml,token=()=> 'synthetic-token-123456789012345'){let state={phase:'ready',membership:{role:'fiscal',user_id:x.actor}},epoch=0;const calls=[];const client=createFiscalProcessedDocumentClient({origin:'https://synthetic.invalid',getSnapshot:()=>state,getEpoch:()=>epoch,getToken:token,fetchImpl:async(...a)=>{calls.push(a);return Response.json(value);}});return{client,calls,set state(s){state=s;},bump(){epoch++;}};}
test('both receipt kinds and models use only four GET routes, checking exact download/print source',async()=>{
 for(const model of ['55','65'])for(const kind of ['authorization','revalidation']){const y=await f.create(model,kind);for(const action of ['xml','print']){const p=setup(y[action]);assert.equal(p.calls.length,0);const result=await p.client(processedDocumentPath(y.reference,action));assert.equal(result.action,action);assert.deepEqual(await checkedProcessedDocument(result,y.reference,action),result);assert.equal(p.calls[0][1].method,'GET');assert.equal(p.calls[0][1].body,undefined);}}
});
test('mutable options and token refresh cannot switch method, signal, actor or role',async()=>{
 const wait=deferred(),p=setup(undefined,()=>wait.promise),a=new AbortController(),opts={method:'GET',signal:a.signal};const pending=p.client(processedDocumentPath(x.reference,'xml'),opts);opts.method='POST';opts.signal=new AbortController().signal;a.abort();wait.resolve('synthetic-token-123456789012345');await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(p.calls.length,0);
 for(const change of [p=>p.state={phase:'ready',membership:{role:'consulta',user_id:x.actor}},p=>p.state={phase:'signed_out',membership:null},p=>p.bump()]){const gate=deferred(),q=setup(undefined,()=>gate.promise),out=q.client(processedDocumentPath(x.reference,'xml'));change(q);gate.resolve('synthetic-token-123456789012345');await assert.rejects(out,e=>e.name==='AbortError');assert.equal(q.calls.length,0);}
});
test('unknown paths/options are rejected and response hash/context cannot be replaced',async()=>{
 const p=setup(),path=processedDocumentPath(x.reference,'xml');for(const candidate of [path+'?download=1',path.replace('/xml','/run'),path.replace('/authorizations/','/candidates/'),path+'/'])await assert.rejects(p.client(candidate),e=>e.status===400);
 for(const options of [{method:'POST'},{body:{}},{signal:'bad'}])await assert.rejects(p.client(path,options),e=>e.status===400);assert.equal(p.calls.length,0);
 await assert.rejects(setup({...x.xml,xml_base64:'AAAA'}).client(path),e=>e.status===502);await assert.rejects(checkedProcessedDocument(x.xml,{...x.reference,attemptId:'f0000000-0000-4000-8000-000000000001'},'xml'));
});
test('session epoch changes during public hash verification discard bytes before client returns',async t=>{
 const wait=deferred(),entered=deferred(),original=crypto.subtle.digest.bind(crypto.subtle);t.mock.method(crypto.subtle,'digest',(...args)=>{entered.resolve();return wait.promise.then(()=>original(...args));});const p=setup(),pending=p.client(processedDocumentPath(x.reference,'xml'));await entered.promise;p.bump();wait.resolve();await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(p.calls.length,1);
});
