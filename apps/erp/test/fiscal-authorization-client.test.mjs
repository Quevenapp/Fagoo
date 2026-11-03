import test from 'node:test';import assert from 'node:assert/strict';
import {createFiscalAuthorizationClient,AuthorizationClientError} from '../src/lib/fiscal-authorization-client.ts';
import {authorizationQaCandidate,authorizationQaPreview,authorizationQaHistory,authorizationQaResult,AUTHORIZATION_QA_ACTOR} from '../src/qa/authorization-fixture.ts';
const base='/v1/fiscal-authorization',c=authorizationQaCandidate(),token='synthetic-authorization-token-123456',state={phase:'ready',membership:{role:'fiscal',user_id:AUTHORIZATION_QA_ACTOR}};
const options=()=>({method:'POST',body:{candidate_id:c.candidate_id,signed_hash:c.artifact.sha256}});
const ports=fetchImpl=>({origin:'https://authorization.invalid',getToken:()=>token,getSnapshot:()=>state,fetchImpl});
const gate=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
test('client sends exact read-only methods and validates preview/history/command with no mutation capability',async()=>{
 const calls=[],client=createFiscalAuthorizationClient(ports(async(url,options)=>{calls.push({url,options});assert.equal(options.credentials,'omit');assert.equal(options.cache,'no-store');assert.equal(options.redirect,'manual');return Response.json(url.endsWith('preview')?authorizationQaPreview():url.endsWith('history')?authorizationQaHistory():authorizationQaResult());}));
 await client(base+'/preview',options());await client(base+'/candidates/'+c.candidate_id+'/history',{method:'POST',body:{limit:25,before:null}});await client(base+'/commands/'+authorizationQaResult().command_id);assert.equal(calls.length,3);assert.deepEqual(calls.map(x=>x.options.method),['POST','POST','GET']);
 for(const route of ['run','recover','download'])await assert.rejects(client(base+'/'+route,options()),e=>e.status===400);assert.equal(calls.length,3);
});
test('bounded decoded JSON, redirects, malformed flags, hash substitutions and raw error fields fail closed',async()=>{
 const invalid=authorizationQaPreview();invalid.signed_hash='0'.repeat(64);
 for(const response of [Response.json(invalid),new Response(' '.repeat(131073),{headers:{'content-type':'application/json'}}),new Response('',{status:302,headers:{location:'https://else.invalid'}}),Response.json({error:'AUTHORIZATION_UPSTREAM_UNAVAILABLE',recovery_required:false,secret:'forbidden'},{status:503}),Response.json({error:'AUTHORIZATION_UPSTREAM_UNAVAILABLE',recovery_required:true},{status:503})]){
 const client=createFiscalAuthorizationClient(ports(async()=>response));await assert.rejects(client(base+'/preview',options()),e=>e instanceof AuthorizationClientError&&e.status===502);
 }
});
test('capture precedes token wait; abort/epoch change cancels result, no auto retries and error contents stay private',async()=>{
 const tokenWait=gate(),calls=[],client=createFiscalAuthorizationClient({...ports(async(url,options)=>{calls.push({url,options});return Response.json(authorizationQaPreview());}),getToken:()=>tokenWait.promise});
 const o=options(),p=client(base+'/preview',o);o.body.signed_hash='0'.repeat(64);tokenWait.resolve(token);await p;assert.equal(JSON.parse(calls[0].options.body).signed_hash,c.artifact.sha256);
 const response=gate();let epoch=1,count=0;const stopped=createFiscalAuthorizationClient({...ports(async()=>{count++;return response.promise;}),getEpoch:()=>epoch});const pending=stopped(base+'/preview',options());await new Promise(r=>setImmediate(r));epoch++;response.resolve(Response.json(authorizationQaPreview()));await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(count,1);
 let failures=0;const failed=createFiscalAuthorizationClient(ports(async()=>{failures++;throw Error('PRIVATE_UPSTREAM_DETAIL');}));await assert.rejects(failed(base+'/preview',options()),e=>e.status===503&&!String(e).includes('PRIVATE'));assert.equal(failures,1);
});
test('malformed calendar, cursor and post-await body overflow are not accepted as history',async()=>{
 const value=authorizationQaHistory();value.items[0].receipt.created_at='2026-02-30T12:00:00Z';
 const client=createFiscalAuthorizationClient(ports(async()=>Response.json(value)));await assert.rejects(client(base+'/candidates/'+c.candidate_id+'/history',{method:'POST',body:{limit:25,before:null}}),e=>e.status===502);
 const badCursor=authorizationQaHistory();badCursor.has_more=true;badCursor.next_cursor='2';const second=createFiscalAuthorizationClient(ports(async()=>Response.json(badCursor)));await assert.rejects(second(base+'/candidates/'+c.candidate_id+'/history',{method:'POST',body:{limit:25,before:null}}),e=>e.status===502);
});
