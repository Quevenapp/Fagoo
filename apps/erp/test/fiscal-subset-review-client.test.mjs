import './helpers/synthetic-october-clock.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createFiscalSubsetReviewClient,SubsetReviewClientError} from '../src/lib/fiscal-subset-review-client.ts';
import {captureSubsetReviewRequest} from '../src/lib/fiscal-subset-review-model.ts';
import {context,result,saveBody} from '../../../packages/fiscal-authorization-runtime/test/review-fixtures.mjs';
import {actor,otherActor,candidateId,commandId} from '../../../packages/fiscal-authorization-http/test/fixtures.mjs';
import {MAX_REVIEW_REQUEST_BYTES,MAX_REVIEW_RESPONSE_BYTES} from '../../../packages/fiscal-authorization-runtime/src/review-protocol.mjs';
import * as realAccess from '../src/lib/real-access.ts';
import {createSubsetReviewQaFixture} from '../src/qa/subset-review-fixture.ts';
import {AUTHORIZATION_QA_ACTOR} from '../src/qa/authorization-fixture.ts';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
const origin='https://review.synthetic.invalid',path=`/v1/fiscal-authorization/candidates/${candidateId}/review`,commandPath=`/v1/fiscal-authorization/review-commands/${commandId}`,token='synthetic-review-token-1234567890';
const state=()=>({phase:'ready',membership:{user_id:actor,role:'fiscal'}}),gate=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve};},tick=()=>new Promise(r=>setImmediate(r));
const ports=fetchImpl=>({origin,getToken:()=>token,getSnapshot:state,fetchImpl});
const isError=(status,recovery)=>e=>e instanceof SubsetReviewClientError&&e.status===status&&e.recovery_required===recovery;
function json(value,{url,status=200,headers={}}={}){const r=Response.json(value,{status,headers});if(url)Object.defineProperty(r,'url',{value:url});return r;}
function streamResponse(chunks,{headers={},status=200}={}){let reads=0,cancels=0;const body=new ReadableStream({pull(c){reads++;if(chunks.length)c.enqueue(chunks.shift());else c.close();},cancel(){cancels++;}},{highWaterMark:0});return{response:new Response(body,{status,headers:{'content-type':'application/json',...headers}}),counts:()=>({reads,cancels})};}

test('068 client accepts only review context/save/command and preserves all non-operational flags',async()=>{
 const calls=[],client=createFiscalSubsetReviewClient(ports(async(url,o)=>{calls.push({url,...o});return json(o.method==='POST'?result('save',JSON.parse(o.body)):url.includes('/review-commands/')?result('command'):context(),{url});}));
 const c=await client(path),ack=await client(path,{method:'POST',body:saveBody()}),r=await client(commandPath);
 assert.deepEqual(calls.map(x=>x.method),['GET','POST','GET']);assert.equal(calls[0].body,undefined);assert.equal(calls[2].body,undefined);
 for(const call of calls){assert.equal(call.credentials,'omit');assert.equal(call.cache,'no-store');assert.equal(call.redirect,'manual');assert.equal(call.referrerPolicy,'no-referrer');assert.equal(call.headers.Authorization,'Bearer '+token);assert.equal(call.headers.Accept,'application/json');}
 for(const value of [c,ack,r]){assert.equal(value.can_transmit,false);assert.equal(value.can_emit,false);assert.equal(value.sefaz_authorized,false);assert.equal(value.tax_rules_validated,false);assert.equal(value.financial_mutation_performed,false);assert.equal(value.stock_mutation_performed,false);assert.equal(Object.isFrozen(value),true);}
 assert.equal(Object.isFrozen(ack.declaration.items[0]),true);assert.equal(ack.command_id,commandId);assert.equal(r.receipt.review_id,commandId);
});

test('body, nested choices, command and signal are captured before awaiting the token',async()=>{
 const wait=gate(),oldSignal=new AbortController(),replacement=new AbortController(),calls=[];
 const client=createFiscalSubsetReviewClient({...ports(async(url,o)=>{calls.push(o);return json(result('save',JSON.parse(o.body)),{url});}),getToken:()=>wait.promise});
 const body=saveBody(),expected=structuredClone(body),options={method:'POST',body,signal:oldSignal.signal},pending=client(path,options);
 body.command_id=otherActor;body.choices.document.operation='outside_scope';body.choices.items[0].classification='outside_scope';body.choices.items.push({...body.choices.items[0],position:2});options.method='GET';options.body=null;options.signal=replacement.signal;replacement.abort();wait.resolve(token);
 const ack=await pending;assert.deepEqual(JSON.parse(calls[0].body),expected);assert.equal(calls[0].method,'POST');assert.equal(ack.command_id,expected.command_id);assert.equal(calls.length,1);
});

test('routes, getters, symbols, bodies on GET and malformed declarations fail before token or fetch',async()=>{
 let tokens=0,fetches=0,getters=0;const client=createFiscalSubsetReviewClient({...ports(async()=>{fetches++;return json(context());}),getToken:()=>{tokens++;return token;}});
 const getter={method:'POST',get body(){getters++;return saveBody();}},hidden={method:'POST',body:saveBody()};Object.defineProperty(hidden,'hidden',{value:true});const symbol={method:'POST',body:saveBody(),[Symbol('private')]:true};
 const nested=saveBody();Object.defineProperty(nested.choices.items[0],'classification',{get(){getters++;return'reviewed_physical_goods';},enumerable:true});
 for(const [route,o]of [[path+'?x=1',{}],[path+'#x',{}],[path.replace(candidateId,'%2f'),{}],[path.replace('/review','/review/'),{}],['/v1/fiscal-authorization/run',{method:'POST',body:saveBody()}],['/v1/fiscal-authorization/recover',{method:'POST',body:saveBody()}],[commandPath,{method:'POST',body:saveBody()}],[path,{method:'PUT',body:saveBody()}],[path,{body:undefined}],[path,getter],[path,hidden],[path,symbol],[path,{method:'POST',body:nested}],[path,{method:'POST',body:{...saveBody(),actor}}]])await assert.rejects(client(route,o),isError(400,false));
 assert.equal(tokens,0);assert.equal(fetches,0);assert.equal(getters,0);
 const invalid=saveBody();invalid.valid_until='2026-02-30T00:00:00.000Z';assert.throws(()=>captureSubsetReviewRequest(path,{method:'POST',body:invalid}));
});

test('250 item declarations fit the byte bound; overflow, holes, credits and extra text never dispatch',async()=>{
 const calls=[],client=createFiscalSubsetReviewClient(ports(async(url,o)=>{calls.push(o);return json(result('save',JSON.parse(o.body)),{url});}));
 const maximal=saveBody(250);assert.ok(Buffer.byteLength(JSON.stringify(maximal))<=MAX_REVIEW_REQUEST_BYTES);assert.equal((await client(path,{method:'POST',body:maximal})).declaration.items.length,250);
 const hole=saveBody(2);delete hole.choices.items[0];const credit=saveBody();credit.choices.items[0].credit={statement:'not authorized'};const extra=saveBody();extra.extra='x'.repeat(MAX_REVIEW_REQUEST_BYTES+1);
 for(const body of [saveBody(251),hole,credit,extra])await assert.rejects(client(path,{method:'POST',body}),isError(400,false));assert.equal(calls.length,1);
});

test('lost save acknowledgement stays uncertain and recovery is an explicit GET of the same command',async()=>{
 const calls=[];let saved;const client=createFiscalSubsetReviewClient(ports(async(url,o)=>{calls.push({url,...o});if(o.method==='POST'){saved=result('save',JSON.parse(o.body));throw Error('PRIVATE_PROVIDER_DETAIL');}return json({...saved,kind:'command',read_only:true},{url});}));
 const body=saveBody();await assert.rejects(client(path,{method:'POST',body}),e=>isError(503,true)(e)&&!String(e).includes('PRIVATE'));assert.equal(calls.length,1);
 const recovered=await client(commandPath);assert.equal(recovered.command_id,body.command_id);assert.deepEqual(calls.map(c=>c.method),['POST','GET']);assert.equal(calls[1].body,undefined);
});

test('invalid ACK bindings and promoted flags are uncertain, sanitized and never cause automatic retries',async()=>{
 const mutations=[v=>{v.command_id=otherActor;},v=>{v.receipt.candidate_id=otherActor;},v=>{v.receipt.candidate_version=2;},v=>{v.receipt.signed_hash='0'.repeat(64);},v=>{v.receipt.facts_hash='0'.repeat(64);},v=>{v.declaration.document.operation='outside_scope';},v=>{v.can_transmit=true;},v=>{v.certificate='PRIVATE_CERTIFICATE';}];
 for(const mutate of mutations){let calls=0;const bad=result();mutate(bad);const client=createFiscalSubsetReviewClient(ports(async()=>{calls++;return json(bad);}));await assert.rejects(client(path,{method:'POST',body:saveBody()}),e=>isError(502,true)(e)&&!String(e).includes('PRIVATE'));assert.equal(calls,1);}
 const wrong=context();wrong.candidate.candidate_id=otherActor;const read=createFiscalSubsetReviewClient(ports(async()=>json(wrong)));await assert.rejects(read(path),isError(502,false));
});

test('401/403 definitive responses and uncertain errors remain distinct without retrying or changing command',async()=>{
 for(const status of [401,403,409])for(const recovery of [false,true]){let calls=0;const client=createFiscalSubsetReviewClient(ports(async()=>{calls++;return json({error:status===401?'AUTHORIZATION_UNAUTHENTICATED':status===403?'AUTHORIZATION_FORBIDDEN':'AUTHORIZATION_CONFLICT',recovery_required:recovery,command_id:commandId},{status});}));await assert.rejects(client(path,{method:'POST',body:saveBody()}),e=>isError(recovery?503:status,recovery)(e)&&e.upstream_status===status);assert.equal(calls,1);}
 for(const value of [{error:'AUTHORIZATION_FORBIDDEN',recovery_required:false,command_id:otherActor},{error:'AUTHORIZATION_FORBIDDEN',recovery_required:false,message:'PRIVATE_UPSTREAM'},{error:'UNREVIEWED_PROVIDER_CODE',recovery_required:false}]){const client=createFiscalSubsetReviewClient(ports(async()=>json(value,{status:403})));await assert.rejects(client(path,{method:'POST',body:saveBody()}),e=>isError(502,true)(e)&&!String(e).includes('PRIVATE'));}
 const read=createFiscalSubsetReviewClient(ports(async()=>json({error:'AUTHORIZATION_FORBIDDEN',recovery_required:true,command_id:commandId},{status:403})));await assert.rejects(read(commandPath),isError(502,false));
});

test('unauthorized state and late token after logout, actor replacement, role loss or epoch change do not fetch',async()=>{
 for(const initial of [{phase:'signed_out',membership:null},{phase:'ready',membership:{user_id:actor,role:'consulta'}}]){let calls=0;const client=createFiscalSubsetReviewClient({...ports(async()=>{calls++;return json(context());}),getSnapshot:()=>initial});await assert.rejects(client(path),e=>e instanceof SubsetReviewClientError&&[401,403].includes(e.status));assert.equal(calls,0);}
 for(const change of ['logout','actor','role','epoch']){const tokenWait=gate();let current=state(),epoch=1,calls=0;const client=createFiscalSubsetReviewClient({...ports(async()=>{calls++;return json(context());}),getToken:()=>tokenWait.promise,getSnapshot:()=>current,getEpoch:()=>epoch});const pending=client(path,{method:'POST',body:saveBody()});await tick();if(change==='logout')current={phase:'signed_out',membership:null};else if(change==='actor')current={...current,membership:{...current.membership,user_id:otherActor}};else if(change==='role')current={...current,membership:{...current.membership,role:'consulta'}};else epoch++;tokenWait.resolve(token);await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(calls,0);}
});

test('late save response after session or actor change is discarded and its body is cancelled',async()=>{
 for(const change of ['logout','actor','epoch']){const response=gate(),entered=gate();let current=state(),epoch=1,calls=0;const client=createFiscalSubsetReviewClient({...ports(async()=>{calls++;entered.resolve();return response.promise;}),getSnapshot:()=>current,getEpoch:()=>epoch});const pending=client(path,{method:'POST',body:saveBody()});await entered.promise;
 if(change==='logout')current={phase:'signed_out',membership:null};else if(change==='actor')current={...current,membership:{...current.membership,user_id:otherActor}};else epoch++;const s=streamResponse([new TextEncoder().encode(JSON.stringify(result()))]);response.resolve(s.response);await assert.rejects(pending,e=>e.name==='AbortError');await tick();assert.equal(calls,1);assert.equal(s.counts().cancels,1);}
});

test('abort before dispatch sends nothing; abort after save fences a late response and keeps recovery required',async()=>{
 const early=new AbortController();early.abort();let calls=0;const first=createFiscalSubsetReviewClient(ports(async()=>{calls++;return json(context());}));await assert.rejects(first(path,{signal:early.signal}),e=>e.name==='AbortError');assert.equal(calls,0);
 const signal=new AbortController(),response=gate(),entered=gate();const client=createFiscalSubsetReviewClient(ports(async()=>{calls++;entered.resolve();return response.promise;}));const pending=client(path,{method:'POST',body:saveBody(),signal:signal.signal});await entered.promise;signal.abort();await assert.rejects(pending,isError(503,true));const s=streamResponse([new TextEncoder().encode(JSON.stringify(result()))]);response.resolve(s.response);await tick();assert.equal(s.counts().cancels,1);assert.equal(calls,1);
});

test('decoded stream and error limits, fatal UTF8, declared lengths and URL/redirect checks fail closed',async()=>{
 const bytes=new TextEncoder().encode(JSON.stringify(context()));
 for(const make of [()=>streamResponse([new Uint8Array(MAX_REVIEW_RESPONSE_BYTES+1)]),()=>streamResponse([new Uint8Array(8193)],{status:503}),()=>streamResponse([Uint8Array.of(0xff)]),()=>streamResponse([bytes],{headers:{'content-length':String(bytes.length+1)}}),()=>streamResponse([bytes],{headers:{'content-length':String(MAX_REVIEW_RESPONSE_BYTES+1)}}),()=>streamResponse([bytes],{headers:{'content-encoding':'unknown'}})]){const s=make(),client=createFiscalSubsetReviewClient(ports(async()=>s.response));await assert.rejects(client(path),e=>e instanceof SubsetReviewClientError&&[502,503].includes(e.status)&&e.recovery_required===false);await tick();assert.ok(s.counts().reads<=2);}
 for(const r of [json(context(),{url:'https://foreign.synthetic.invalid'+path}),new Response(null,{status:302,headers:{location:origin+path}})]){const client=createFiscalSubsetReviewClient(ports(async()=>r));await assert.rejects(client(path),isError(502,false));}
 // Browser decoding means a compressed Content-Length is not the decoded byte count.
 const valid=createFiscalSubsetReviewClient(ports(async()=>json(context(),{headers:{'content-encoding':'br','content-length':'12'}})));assert.equal((await valid(path)).kind,'context');
});

test('absolute deadline fences an immediately resolved response while retaining save uncertainty',async()=>{
 const original=Date.now,now=original();let calls=0;try{Date.now=()=>now;const client=createFiscalSubsetReviewClient(ports(async()=>{calls++;Date.now=()=>now+65001;return json(result());}));await assert.rejects(client(path,{method:'POST',body:saveBody()}),isError(504,true));assert.equal(calls,1);}finally{Date.now=original;}
});

async function qaController(fixture){
 const session={access_token:token,user:{id:AUTHORIZATION_QA_ACTOR}};
 const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signInWithPassword:async()=>({data:{session:null},error:null}),signOut:async()=>({error:null})};
 const controller=realAccess.createAccessController(auth,'http://127.0.0.1:9011',fixture.fetch,{a1ApiUrl:'https://unsigned.qa.invalid'}),stop=controller.start();
 for(let i=0;i<200&&controller.getSnapshot().phase!=='ready';i++)await tick();assert.equal(controller.getSnapshot().phase,'ready');return{controller,stop};
}
test('QA 55/65 uses the actual controller/client, lost ACK plus failed GET retain one command and no network fallback',async()=>{
 const fixture=createSubsetReviewQaFixture(),{controller,stop}=await qaController(fixture);
 try{for(const model of ['55','65']){
  const c=fixture.candidate(model),route=`/v1/fiscal-authorization/candidates/${c.candidate_id}/review`,read=await controller.fiscalSubsetReview(route);
  assert.equal(read.candidate.model,model);assert.equal(read.facts.ide.mod,model);
  const body={...saveBody(),command_id:crypto.randomUUID(),signed_hash:read.candidate.signed_hash,expected_facts_hash:read.candidate.facts_hash};
  await assert.rejects(controller.fiscalSubsetReview(route,{method:'POST',body}),e=>e.recovery_required===true);
  const lookup=`/v1/fiscal-authorization/review-commands/${body.command_id}`;
  await assert.rejects(controller.fiscalSubsetReview(lookup),e=>e.status===503&&e.recovery_required===false);
  const receipt=await controller.fiscalSubsetReview(lookup),current=await controller.fiscalSubsetReview(route);
  assert.equal(receipt.receipt.command_id,body.command_id);assert.equal(receipt.receipt.reviewed_by,AUTHORIZATION_QA_ACTOR);assert.equal(current.review.receipt.review_id,body.command_id);assert.equal(current.can_emit,false);assert.equal(current.can_transmit,false);
 }
 assert.deepEqual(fixture.counts,{membership:1,context:4,save:2,committed:2,command:4,lostAck:2,failedLookup:2,forbidden:0});
 for(const url of ['http://127.0.0.1:9011/v1/financeiro/titles','https://unsigned.qa.invalid/v1/fiscal-authorization/run','https://foreign.invalid/v1/me'])await assert.rejects(fixture.fetch(url));
 assert.equal(fixture.counts.forbidden,3);assert.equal(fixture.counts.save,2);
 }finally{stop();}
});

test('QA panel runs real review handlers and disables model changes until the explicit GET recovery completes',async()=>{
 const fixture=createSubsetReviewQaFixture(),{controller,stop}=await qaController(fixture);let v;
 try{v=await mountComponent('../qa/FiscalSubsetReviewQA.tsx',{controller,fixture},{expandChildren:true,ports:{access:realAccess},modules:{'../lib/real-access':'export const {AccessError,decimalMoney}=r.access;'}});
  assert.equal(fixture.counts.context,0);await v.click('Conferir dados fiscais');
  const until=v.find(n=>n.props['aria-label']==='Validade da revisão (São Paulo)');until.props.onChange({target:{value:'2026-10-25T12:00'}});await v.flush();
  const model=()=>v.find(n=>n.type==='select'&&!n.props['aria-label']);assert.equal(model().disabled,true);
  await v.click('Salvar revisão fiscal');assert.match(v.text(),/resultado ainda não foi confirmado/);assert.equal(fixture.counts.save,1);assert.equal(fixture.counts.committed,1);
  await v.click('Consultar resultado da revisão');assert.match(v.text(),/resultado ainda não foi confirmado/);assert.equal(model().disabled,true);
  await v.click('Consultar resultado da revisão');assert.match(v.text(),/Revisão salva e conferida/);assert.equal(fixture.counts.save,1);assert.equal(fixture.counts.command,2);assert.equal(model().disabled,false);
  model().props.onChange({target:{value:'65'}});await v.flush();assert.doesNotMatch(v.text(),/Revisão salva e conferida/);assert.equal(fixture.counts.context,2);
  await v.click('Conferir dados fiscais');assert.equal(fixture.counts.context,3);assert.match(v.text(),/CFOP: 5101/);
 }finally{v?.unmount();stop();}
});

test('077 QA previous-profile scenario uses the real client and editor without reusing historical consent',async()=>{
 const fixture=createSubsetReviewQaFixture(),{controller,stop}=await qaController(fixture);let v;
 try{v=await mountComponent('../qa/FiscalSubsetReviewQA.tsx',{controller,fixture},{expandChildren:true,ports:{access:realAccess},modules:{'../lib/real-access':'export const {AccessError,decimalMoney}=r.access;'}});
  v.find(n=>n.props['aria-label']==='Contexto de teste').props.onChange({target:{value:'previous'}});await v.flush();await v.click('Conferir dados fiscais');assert.match(v.text(),/Revisão anterior \(somente consulta\)/);assert.equal(v.find(n=>n.props['aria-label']==='Operação').props.value,'unreviewed');assert.equal(v.find(n=>n.props['aria-label']==='Validade da revisão (São Paulo)').props.value,'');assert.equal(fixture.counts.save,0);
  v.find(n=>n.props['aria-label']==='Validade da revisão (São Paulo)').props.onChange({target:{value:'2026-10-25T12:00'}});await v.flush();assert.equal(v.find(n=>n.props['aria-label']==='Contexto de teste').disabled,true);await v.click('Salvar revisão fiscal');await v.click('Consultar resultado da revisão');await v.click('Consultar resultado da revisão');assert.match(v.text(),/Revisão salva e conferida/);assert.doesNotMatch(v.text(),/Revisão anterior \(somente consulta\)/);assert.equal(fixture.counts.save,1);assert.equal(fixture.counts.command,2);assert.equal(fixture.counts.forbidden,0);assert.equal(v.find(n=>n.props['aria-label']==='Contexto de teste').disabled,false);
 }finally{v?.unmount();stop();}
});
