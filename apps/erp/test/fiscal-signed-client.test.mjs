import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {createFiscalSignedClient,SignedClientError} from '../src/lib/fiscal-signed-client.ts';
import {AccessError} from '../src/lib/real-access.ts';
import {SIGNED_BASE} from '../src/lib/fiscal-signed-model.ts';
import {projectSqlView,projectSqlHistory} from '../../../packages/fiscal-signed-runtime/src/sql-dto.mjs';
import {publicResult} from '../../../packages/fiscal-signed-runtime/src/dto.mjs';
import {response as sqlResponse,actor,job,command,candidate,hash} from '../../../packages/fiscal-signed-rpc/test/fixtures.mjs';
const body=()=>({command_id:command,unsigned_job_id:job,unsigned_hash:hash,basis_hash:hash,expected_a1_version:1});
const ready=()=>({phase:'ready',membership:{user_id:actor,role:'fiscal'}}),json=(v,init={})=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'},...init});
const current=()=>projectSqlView(sqlResponse('get'),{candidateId:candidate});
const run=()=>publicResult({...current(),command_id:command},{action:'run',payload:body()});
const pending=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
function setup(fetchImpl=async()=>json(run()),getToken=()=> 'SYNTHETIC_NOT_A_TOKEN'){
 let state=ready(),epoch=0;const calls=[];
 const client=createFiscalSignedClient({origin:'https://gateway.synthetic.invalid',getToken,getSnapshot:()=>state,getEpoch:()=>epoch,fetchImpl:async(...args)=>{calls.push(args);return fetchImpl(...args);}});
 return{client,calls,get state(){return state;},set state(v){state=v;},advance:()=>epoch++};
}
const send=(p,options={})=>p.client(SIGNED_BASE+'/run',{method:'POST',body:body(),...options});
const uncertain=(e,status)=>e instanceof SignedClientError&&e instanceof AccessError&&e.recovery_required===true&&(status===undefined||e.status===status);

test('050 client exact routes bind run, candidate, command and history and never issue a request on construction',async()=>{
 const p=setup(async(url)=>url.endsWith('/run')?json(run()):url.includes('/commands/')?json(projectSqlView(sqlResponse('command'),{commandId:command})):url.endsWith('/history')?json(projectSqlHistory(sqlResponse('history'),{jobId:job,payload:{limit:25,before:null}})):json(current()));
 assert.equal(p.calls.length,0);await send(p);await p.client(SIGNED_BASE+'/candidates/'+candidate);await p.client(SIGNED_BASE+'/commands/'+command);await p.client(SIGNED_BASE+'/jobs/'+job+'/history',{method:'POST',body:{limit:25,before:null}});
 assert.equal(p.calls.length,4);for(const[url,options]of p.calls){assert.ok(url.startsWith('https://gateway.synthetic.invalid/v1/fiscal-signed/'));assert.equal(options.redirect,'manual');assert.equal(options.cache,'no-store');assert.equal(options.credentials,'omit');assert.equal(options.headers.Authorization,'Bearer SYNTHETIC_NOT_A_TOKEN');}
 assert.deepEqual(JSON.parse(p.calls[0][1].body),body());assert.equal(p.calls[1][1].method,'GET');
 for(const path of [SIGNED_BASE+'/run?x=1',SIGNED_BASE+'/run#x',SIGNED_BASE+'/run%2f','https://evil.invalid'+SIGNED_BASE+'/run',SIGNED_BASE+'/run/../run',SIGNED_BASE+'/jobs/'+job])await assert.rejects(p.client(path,{method:'POST',body:body()}),e=>e.status===400);
 for(const extra of [{user_id:actor},{expected_a1_version:0},{unsigned_job_id:'A0000000-0000-4000-8000-000000000005'},{xml:'PRIVATE'}])await assert.rejects(send(p,{body:{...body(),...extra}}),e=>e.status===400);
 await assert.rejects(p.client(SIGNED_BASE+'/candidates/'+candidate,{method:'POST',body:{}}),e=>e.status===400);
 await assert.rejects(p.client(SIGNED_BASE+'/jobs/'+job+'/history',{method:'POST',body:{limit:26,before:null}}),e=>e.status===400);assert.equal(p.calls.length,4);
});

test('050 invalid gateway, absent or unauthorized session are rejected before token or fetch',async()=>{
 for(const origin of ['http://gateway.invalid','https://gateway.invalid/','https://u:p@gateway.invalid','https://gateway.invalid/path'])assert.throws(()=>createFiscalSignedClient({origin,getSnapshot:ready,getToken:()=> 'x'}));
 const p=setup();for(const state of [{phase:'signed_out',membership:null},{phase:'ready',membership:{user_id:actor,role:'consulta'}}]){p.state=state;await assert.rejects(send(p),e=>[401,403].includes(e.status)&&!e.recovery_required);}
 assert.equal(p.calls.length,0);const badToken=setup(undefined,()=> 'private\nheader');await assert.rejects(send(badToken),e=>e.status===401&&!e.recovery_required);assert.equal(badToken.calls.length,0);
});

test('050 request body and original abort signal are captured before token await',async()=>{
 const token=pending(),p=setup(undefined,()=>token.promise),original=new AbortController(),replacement=new AbortController(),input=body(),options={method:'POST',body:input,signal:original.signal};
 const request=p.client(SIGNED_BASE+'/run',options);input.command_id=actor;input.expected_a1_version=99;options.body={xml:'PRIVATE'};options.signal=replacement.signal;token.resolve('SYNTHETIC_NOT_A_TOKEN');await request;
 assert.deepEqual(JSON.parse(p.calls[0][1].body),body());assert.equal(original.signal.aborted,false);
 let getterCalled=false;const malicious=body();Object.defineProperty(malicious,'expected_a1_version',{get(){getterCalled=true;return 1;},enumerable:true});await assert.rejects(send(p,{body:malicious}),e=>e.status===400);assert.equal(getterCalled,false);assert.equal(p.calls.length,1);
 const slow=pending(),p2=setup(undefined,()=>slow.promise),signal=new AbortController(),mutable={method:'POST',body:body(),signal:signal.signal};const req=p2.client(SIGNED_BASE+'/run',mutable);mutable.signal=new AbortController().signal;signal.abort();await assert.rejects(req,e=>e.name==='AbortError');slow.resolve('TOKEN');await tick();assert.equal(p2.calls.length,0);
});

test('050 forwarded errors explicitly requiring recovery retain origin status and cannot become definitive rejections',async()=>{
 for(const status of [400,401,403,409]){
  const p=setup(async()=>json({error:status===403?'SIGNED_FORBIDDEN':'SIGNED_CONFLICT',recovery_required:true},{status}));
  await assert.rejects(send(p),e=>uncertain(e,503)&&e.upstream_status===status);assert.equal(p.calls.length,1);
  const known=setup(async()=>json({error:'SIGNED_CONFLICT',recovery_required:false},{status}));await assert.rejects(send(known),e=>e.status===status&&!e.recovery_required&&e.upstream_status===status);
 }
 const read=setup(async()=>json({error:'SIGNED_UNAUTHENTICATED',recovery_required:false},{status:401}));await assert.rejects(read.client(SIGNED_BASE+'/candidates/'+candidate),e=>e.status===401&&e.upstream_status===401&&!e.recovery_required);
});

test('050 network, invalid success binding and unsafe error payloads after run remain uncertain without leaking raw details',async()=>{
 const wrong=current();wrong.unsigned_hash='d'.repeat(64);delete wrong.read_only;wrong.command_id=command;
 for(const response of [()=>{throw new Error('PRIVATE TOKEN');},()=>json(wrong),()=>json({...run(),credential_id:actor}),()=>json({error:'PRIVATE TOKEN',recovery_required:false},{status:409}),()=>json({error:'SIGNED_CONFLICT',recovery_required:false,trace:'PRIVATE TOKEN'},{status:409}),()=>new Response('PRIVATE TOKEN',{status:503})]){
  const p=setup(response);await assert.rejects(send(p),e=>{assert.equal(uncertain(e),true);assert.doesNotMatch(String(e),/PRIVATE|TOKEN/);return true;});assert.equal(p.calls.length,1);
 }
});

test('050 explicit cancellation after dispatch retains uncertain run while read cancellation is AbortError',async()=>{
 const started=pending(),p=setup(()=>{started.resolve();return new Promise(()=>{});}),abort=new AbortController(),request=send(p,{signal:abort.signal});await started.promise;abort.abort();await assert.rejects(request,e=>uncertain(e,503));assert.equal(p.calls.length,1);
 const reading=pending(),r=setup(()=>{reading.resolve();return new Promise(()=>{});}),readAbort=new AbortController(),readRequest=r.client(SIGNED_BASE+'/candidates/'+candidate,{signal:readAbort.signal});await reading.promise;readAbort.abort();await assert.rejects(readRequest,e=>e.name==='AbortError');
 const aborted=new AbortController();aborted.abort();const before=setup();await assert.rejects(send(before,{signal:aborted.signal}),e=>e.name==='AbortError');assert.equal(before.calls.length,0);
});

test('050 actor/epoch change fences token, HTTP response and body; late response is never returned',async()=>{
 const token=pending(),p=setup(undefined,()=>token.promise),request=send(p);p.advance();token.resolve('TOKEN');await assert.rejects(request,e=>e.name==='AbortError');assert.equal(p.calls.length,0);
 const http=pending(),started=pending(),p2=setup(()=>{started.resolve();return http.promise;}),r=send(p2);await started.promise;p2.state={...ready(),membership:{user_id:command,role:'fiscal'}};http.resolve(json(run()));await assert.rejects(r,e=>e.name==='AbortError');
 const pulled=pending(),chunk=pending();let cancelled=false;const stream=new ReadableStream({pull(){pulled.resolve();return chunk.promise;},cancel(){cancelled=true;}}),p3=setup(async()=>new Response(stream,{headers:{'content-type':'application/json'}})),a=new AbortController(),r3=send(p3,{signal:a.signal});await pulled.promise;await tick();assert.equal(p3.calls.length,1);p3.advance();a.abort();await assert.rejects(r3,e=>e.name==='AbortError');await tick();assert.equal(cancelled,true);chunk.resolve();
});

test('050 redirects, effective URL, MIME, UTF8 and byte limits are rejected with uncertain outcome after send',async()=>{
 const changed=json(run());Object.defineProperty(changed,'url',{value:'https://evil.invalid/'});
 const responses=[new Response('PRIVATE',{status:302,headers:{location:'https://evil.invalid'}}),changed,json(run(),{headers:{'content-type':'text/html'}}),json(run(),{headers:{'content-type':'application/json','content-length':'1'}}),json(run(),{headers:{'content-type':'application/json','content-encoding':'unknown'}}),json(run(),{headers:{'content-type':'application/json','content-length':'131073'}}),json('x'.repeat(131073)),new Response(new Uint8Array([0xc0,0xaf]),{headers:{'content-type':'application/json'}}),json({error:'SIGNED_CONFLICT',recovery_required:true,x:'x'.repeat(8192)},{status:409})];
 for(const response of responses){const p=setup(async()=>response);await assert.rejects(send(p),e=>uncertain(e));assert.equal(p.calls.length,1);}
 // Browser Fetch already decoded these bytes; the cap is checked on decoded content.
 const compressed=setup(async()=>json(run(),{headers:{'content-type':'application/json','content-encoding':'br','content-length':'80'}}));assert.equal((await send(compressed)).status,'stored');
});

test('050 deadline covers an uncooperative HTTP call and cancels it without automatic resend',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});const started=pending(),p=setup((url,options)=>{started.resolve(options.signal);return new Promise(()=>{});}),request=send(p);const signal=await started.promise;
 t.mock.timers.tick(65000);await assert.rejects(request,e=>uncertain(e,504));assert.equal(signal.aborted,true);assert.equal(p.calls.length,1);t.mock.timers.reset();
});

test('050 deadline includes body stream and private late bytes are cancelled',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});let cancelled=false;const entered=pending(),stream=new ReadableStream({pull(){entered.resolve();return new Promise(()=>{});},cancel(){cancelled=true;}}),p=setup(async()=>new Response(stream,{headers:{'content-type':'application/json'}})),request=send(p);await entered.promise;await tick();t.mock.timers.tick(65000);await assert.rejects(request,e=>uncertain(e,504));await tick();assert.equal(cancelled,true);assert.equal(p.calls.length,1);t.mock.timers.reset();
});

test('050 abort while obtaining token does not leave an unhandled rejection and cannot dispatch later',async()=>{
 const unhandled=[],observe=e=>unhandled.push(e);process.on('unhandledRejection',observe);
 try{const token=pending(),p=setup(undefined,()=>token.promise),abort=new AbortController(),request=send(p,{signal:abort.signal});await tick();abort.abort();await assert.rejects(request,e=>e.name==='AbortError');token.resolve('TOKEN');await tick();await tick();assert.equal(p.calls.length,0);assert.deepEqual(unhandled,[]);}finally{process.off('unhandledRejection',observe);}
});

test('050 history POST is a read and never reports a financial or candidate mutation uncertainty',async()=>{
 const p=setup(()=>{throw new Error('PRIVATE');});await assert.rejects(p.client(SIGNED_BASE+'/jobs/'+job+'/history',{method:'POST',body:{limit:25,before:null}}),e=>e.status===503&&!e.recovery_required);assert.equal(p.calls.length,1);
});
