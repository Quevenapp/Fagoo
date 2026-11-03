import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createAuthorizationRuntimeHandler} from '../src/handler.mjs';
import {createAuthorizationGateway} from '../src/gateway.mjs';
import {projectReviewPublic} from '../src/review-dto.mjs';
import {captureReviewInput,MAX_REVIEW_REQUEST_BYTES,MAX_REVIEW_RESPONSE_BYTES} from '../src/review-protocol.mjs';
import {route} from '../src/protocol.mjs';
import {actor,candidateId as candidate,commandId as command,secret,keyId,audience,internal,external,env,service as oldService,deferred,bounded} from './fixtures.mjs';
import {context,result,saveBody,reviewService} from './review-fixtures.mjs';
const path=`/candidates/${candidate}/review`,commandPath=`/review-commands/${command}`;
function setup(overrides={}){const review=reviewService(overrides),legacy={calls:[],service:oldService(Object.fromEntries(['preview','run','recover','command','history'].map(k=>[k,async()=>{legacy.calls.push(k);throw Error('LEGACY_UNEXPECTED');}])))},handler=createAuthorizationRuntimeHandler({service:legacy.service,reviewService:review.service,transportSecret:secret,transportKeyId:keyId,audience}),calls=[];const gateway=createAuthorizationGateway({fetchImpl:async(url)=>{calls.push(url);return Response.json({id:actor});},now:Date.now,nonce:randomUUID});const environment={...env(),A1_RUNTIME:{fetch:r=>handler(new Request('http://runtime.internal'+new URL(r.url).pathname,r))}};return{handler,gateway,environment,review,legacy,calls,close:()=>handler.dispose()};}
test('review syntax binds only new routes and keeps legacy4KiB limits',()=>{
 for(const method of ['GET','POST'])assert.equal(route('/internal/v1/fiscal-authorization'+path,method).responseLimit,1024*1024);
 assert.equal(route('/internal/v1/fiscal-authorization'+path,'POST').limit,144*1024);assert.equal(route('/internal/v1/fiscal-authorization/preview','POST').limit,4096);assert.equal(route('/internal/v1/fiscal-authorization/preview','POST').responseLimit,undefined);
 const body=saveBody();assert.deepEqual(captureReviewInput(body),body);let gets=0;Object.defineProperty(body.choices.items[0],'credit',{enumerable:true,get(){gets++;return null;}});assert.throws(()=>captureReviewInput(body));assert.equal(gets,0);
 for(const patch of [{actor},{schema:{}},{choices:{...saveBody().choices,items:[{...saveBody().choices.items[0],item_hash:'a'.repeat(64)}]}}])assert.throws(()=>captureReviewInput({...saveBody(),...patch}));
 assert.throws(()=>route('/internal/v1/fiscal-authorization'+path,'DELETE'));assert.throws(()=>route('/internal/v1/fiscal-authorization'+path+'/', 'GET'));
});
test('review DTO binds receipt and exposes no executor fields or promoted flags',()=>{
 const c=context();assert.deepEqual(projectReviewPublic(c,{action:'context',candidateId:candidate}),c);assert.deepEqual(projectReviewPublic(result(),{action:'save',candidateId:candidate,commandId:command,input:saveBody()}),result());
 for(const mutate of [v=>v.can_emit=true,v=>v.record_text='private',v=>v.candidate.facts_hash='c'.repeat(64),v=>v.facts.items[0].private_key='private',v=>v.report.taxRulesValidated=true,v=>v.review.schema={}]){const bad=context();mutate(bad);assert.throws(()=>projectReviewPublic(bad,{action:'context',candidateId:candidate}),e=>e.code==='AUTHORIZATION_RESPONSE_INVALID');}
 for(const mutate of [v=>v.receipt.command_id=randomUUID(),v=>v.declaration.document.payment='unreviewed',v=>v.receipt.candidate_version=2]){const bad=result();mutate(bad);assert.throws(()=>projectReviewPublic(bad,{action:'save',candidateId:candidate,commandId:command,input:saveBody()}));}
 let invoked=0;const bad=context();Object.defineProperty(bad,'facts',{enumerable:true,get(){invoked++;return {};}});assert.throws(()=>projectReviewPublic(bad,{action:'context',candidateId:candidate}));assert.equal(invoked,0);
});
test('three review routes authenticate actor/body and never reach old service or fiscal ports',async()=>{const f=setup();try{
 for(const [p,b] of [[path,undefined],[path,saveBody()],[commandPath,undefined]]){const response=await f.gateway(external(p,b),f.environment);assert.equal(response.status,200,await response.clone().text());}
 assert.deepEqual(f.review.calls.map(x=>x[0]),['context','save','command']);assert.ok(f.review.calls.every(x=>x[1].actor===actor));assert.equal(f.legacy.calls.length,0);assert.equal(f.calls.length,3);
 const valid=await internal(path,saveBody()),tampered=new Request(valid.url,{method:'POST',headers:valid.headers,body:JSON.stringify({...saveBody(),expected_review_version:1})});assert.equal((await f.handler(tampered)).status,401);assert.equal(f.review.calls.length,3);
 const bad=await internal(path,undefined,{header:'Bearer PRIVATE_SENTINEL'});assert.equal((await f.handler(bad)).status,401);assert.equal(f.review.calls.length,3);
 }finally{f.close();}});
test('CSRF, preflight, anonymous Auth and malformed review choices fail before private dispatch',async()=>{const f=setup();try{
 for(const origin of [null,'https://evil.invalid']){const r=external(path,saveBody());origin?r.headers.set('origin',origin):r.headers.delete('origin');assert.equal((await f.gateway(r,f.environment)).status,403);}
 const preflight=external(path,undefined,{method:'OPTIONS',headers:{Origin:'https://app.synthetic.invalid','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'}});assert.equal((await f.gateway(preflight,f.environment)).status,204);assert.equal(f.calls.length,0);
 assert.equal((await f.gateway(external(path,{...saveBody(),actor}),f.environment)).status,400);assert.equal(f.review.calls.length,0);
 const anonymous=createAuthorizationGateway({fetchImpl:async()=>Response.json({id:actor,is_anonymous:true}),now:Date.now,nonce:randomUUID});assert.equal((await anonymous(external(path),f.environment)).status,401);assert.equal(f.review.calls.length,0);
 }finally{f.close();}});
test('lost save ACK preserves UUID and GET command recovers once without another save',async()=>{let saves=0;const f=setup({save:async()=>{saves++;throw Error('PRIVATE_SENTINEL_TOKEN_XML');}});try{
 const response=await f.gateway(external(path,saveBody()),f.environment),body=await response.json();assert.equal(response.status,503);assert.equal(body.recovery_required,true);assert.equal(body.command_id,command);assert.doesNotMatch(JSON.stringify(body),/PRIVATE|TOKEN|XML/);
 const read=await f.gateway(external(commandPath),f.environment);assert.equal(read.status,200);assert.equal((await read.json()).receipt.command_id,command);assert.equal(saves,1);
 }finally{f.close();}});
test('definitive SQL ACL/conflict preserves false recovery; only lost runtime response is uncertain',async()=>{for(const [code,status]of [['42501',403],['40001',409],['P0002',404]]){const f=setup({save:async()=>{throw Object.assign(Error('PRIVATE'),{code,recovery_required:false});},context:async()=>{throw Object.assign(Error('PRIVATE'),{code});}});try{
 const direct=await f.handler(await internal(path,saveBody()));assert.equal(direct.status,status);assert.equal((await direct.json()).recovery_required,false);
 const read=await f.gateway(external(path),f.environment);assert.equal(read.status,status);assert.equal((await read.json()).recovery_required,false);
 const save=await f.gateway(external(path,saveBody()),f.environment);assert.equal(save.status,status);assert.equal((await save.json()).recovery_required,false);
 }finally{f.close();}}});
test('new route accepts250 Unicode labels above128KiB; legacy limit and review1MiB remain closed',async()=>{const big=context(250);for(const l of big.labels.items)l.description='Produto sintético á'.repeat(60);const size=Buffer.byteLength(JSON.stringify(big));assert.ok(size>131072&&size<MAX_REVIEW_RESPONSE_BYTES);assert.ok(Buffer.byteLength(JSON.stringify(saveBody(250)))<MAX_REVIEW_REQUEST_BYTES);
 const f=setup({context:async()=>big});try{const response=await f.gateway(external(path),f.environment);assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).facts.items.length,250);
 const oversized=external(path,saveBody());oversized.headers.set('Content-Length',String(MAX_REVIEW_REQUEST_BYTES+1));assert.equal((await f.gateway(oversized,f.environment)).status,413);
 const tooBig=context(250);for(const l of tooBig.labels.items)l.description='😀'.repeat(1000);assert.throws(()=>projectReviewPublic(tooBig,{action:'context',candidateId:candidate}));
 const old=external('/preview',{candidate_id:candidate,signed_hash:'a'.repeat(64)});old.headers.set('Content-Length','4097');assert.equal((await f.gateway(old,f.environment)).status,413);
 }finally{f.close();}});
test('abort/dispose after save dispatch ignores late success without retries or logs',async()=>{const entered=deferred(),gate=deferred();let saves=0;const f=setup({save:async()=>{saves++;entered.resolve();await gate.promise;return result();}}),controller=new AbortController();try{const pending=f.handler(await internal(path,saveBody(),{signal:controller.signal}));await entered.promise;controller.abort();const response=await bounded(pending);assert.equal(response.status,503);assert.equal((await response.json()).recovery_required,true);gate.resolve();assert.equal(saves,1);f.close();assert.equal((await f.handler(await internal(path))).status,503);}finally{gate.resolve();f.close();}});


test('bounded250-item context allows more than2000 diagnostic issues without changing response cap',()=>{const v=context(250);v.report.pendingClassification=Array.from({length:2001},(_,i)=>({code:'PRODUCT_CLASSIFICATION_PENDING',kind:'classification_or_evidence_pending',position:i%250+1,sources:['rfb-pis-cofins','sre70']}));assert.ok(Buffer.byteLength(JSON.stringify(v))<MAX_REVIEW_RESPONSE_BYTES);assert.equal(projectReviewPublic(v,{action:'context',candidateId:candidate}).report.pendingClassification.length,2001);});
