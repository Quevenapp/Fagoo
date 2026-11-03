import test from 'node:test';
import assert from 'node:assert/strict';
import {createFiscalUnsignedClient} from '../src/lib/fiscal-unsigned-client.ts';
import {unsignedUuid} from './helpers/fiscal-unsigned-fixtures.mjs';
const ready=()=>({phase:'ready',membership:{user_id:unsignedUuid(1),role:'fiscal'}}),response=(v={},init={})=>new Response(JSON.stringify(v),{status:200,headers:{'content-type':'application/json'},...init});
function port(fetchImpl=async()=>response()){let state=ready(),epoch=0;const calls=[];return{get state(){return state;},set state(v){state=v;},advance:()=>epoch++,calls,client:createFiscalUnsignedClient({origin:'https://gateway.synthetic.invalid',getToken:async()=> 'SYNTHETIC_NOT_A_TOKEN',getSnapshot:()=>state,getEpoch:()=>epoch,fetchImpl:async(...a)=>{calls.push(a);return fetchImpl(...a);}})};}
const path='/v1/fiscal-unsigned/preview',body={draft_id:unsignedUuid(2),completion_version:1};
test('048 isolated client permits only exact routes/body, authenticates and disables redirects',async()=>{
 const p=port();await p.client(path,{method:'POST',body});assert.equal(p.calls[0][1].redirect,'manual');assert.equal(p.calls[0][1].credentials,'omit');assert.equal(p.calls[0][1].cache,'no-store');assert.equal(p.calls[0][1].headers.Authorization,'Bearer SYNTHETIC_NOT_A_TOKEN');
 for(const candidate of[path+'?x=1',path+'#next','https://external.invalid'+path,'//external.invalid'+path,path+'/../generate',path+'%2f'])await assert.rejects(p.client(candidate,{method:'POST',body}),e=>e.status===400);
 for(const extra of[{actor:unsignedUuid(8)},{cNF:'12345678'},{completion_version:0},{draft_id:'A0000000-0000-4000-8000-000000000002'}])await assert.rejects(p.client(path,{method:'POST',body:{...body,...extra}}),e=>e.status===400);
 await assert.rejects(p.client('/v1/fiscal-unsigned/history',{method:'POST',body:{reservation_id:unsignedUuid(2),limit:26,before:null}}),e=>e.status===400);
 p.state={...ready(),membership:{...ready().membership,role:'consulta'}};await assert.rejects(p.client(path,{method:'POST',body}),e=>e.status===403);assert.equal(p.calls.length,1);
 for(const origin of['http://gateway.invalid','https://gateway.invalid/','https://u:p@gateway.invalid','https://gateway.invalid/path'])assert.throws(()=>createFiscalUnsignedClient({origin,getSnapshot:ready,getToken:async()=> 'x'}));
});
test('048 redirect/errors and oversized/wrong type bodies are refused without leaking text',async()=>{
 for(const r of[new Response('SECRET',{status:302,headers:{location:'https://other.invalid'}}),new Response('SECRET',{status:503}),new Response('SECRET',{headers:{'content-type':'text/html'}}),response({}, {headers:{'content-type':'application/json','content-length':'131073'}}),response('x'.repeat(131073)),response({}, {headers:{'content-type':'application/json','content-length':'1'}})]){
  const p=port(async()=>r);await assert.rejects(p.client(path,{method:'POST',body}),e=>{assert.doesNotMatch(String(e),/SECRET/);return true;});assert.equal(p.calls.length,1);
 }
});
test('048 client fences session changes and abort during token, response and body read',async()=>{
 let resolve;const delayed=new Promise(r=>resolve=r),p=port(()=>delayed),request=p.client(path,{method:'POST',body});await new Promise(r=>setTimeout(r,0));p.advance();resolve(response({PRIVATE:true}));await assert.rejects(request,e=>e.name==='AbortError');
 const abort=new AbortController(),p2=port(()=>new Promise(()=>{})),request2=p2.client(path,{method:'POST',body,signal:abort.signal});await new Promise(r=>setTimeout(r,0));abort.abort();await assert.rejects(request2,e=>e.name==='AbortError');
 let tokenResolve,fetches=0;const p3=createFiscalUnsignedClient({origin:'https://gateway.invalid',getSnapshot:ready,getToken:()=>new Promise(r=>tokenResolve=r),fetchImpl:async()=>{fetches++;return response();}}),signal=new AbortController(),request3=p3(path,{method:'POST',body,signal:signal.signal});await new Promise(r=>setTimeout(r,0));signal.abort();await assert.rejects(request3,e=>e.name==='AbortError');tokenResolve('PRIVATE');await new Promise(r=>setTimeout(r,0));assert.equal(fetches,0);
 let cancelled=false;const stream=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}}),p4=port(async()=>new Response(stream,{headers:{'content-type':'application/json'}})),last=new AbortController(),request4=p4.client(path,{method:'POST',body,signal:last.signal});await new Promise(r=>setTimeout(r,0));last.abort();await assert.rejects(request4,e=>e.name==='AbortError');await new Promise(r=>setTimeout(r,0));assert.equal(cancelled,true);
});
