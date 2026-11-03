import test from 'node:test';import assert from 'node:assert/strict';
import {createFiscalReviewedAuthorizationClient,ReviewedAuthorizationClientError} from '../src/lib/fiscal-reviewed-authorization-client.ts';
import {candidate,result,history,status,actor,deferred} from './helpers/fiscal-reviewed-authorization-fixtures.mjs';
const B='/v1/fiscal-authorization/reviewed',c=candidate(),r=result(c),token='synthetic-reviewed-token',state=()=>({phase:'ready',membership:{user_id:actor,role:'fiscal'}});
const ports=fetchImpl=>({origin:'https://reviewed.invalid',getToken:()=>token,getSnapshot:state,fetchImpl});
test('reviewed client uses exact bound routes/methods; captures before refresh and dispatches only once',async()=>{
 const wait=deferred(),calls=[],client=createFiscalReviewedAuthorizationClient({...ports(async(url,o)=>{calls.push({url,o});assert.equal(o.credentials,'omit');assert.equal(o.redirect,'manual');assert.equal(o.cache,'no-store');return Response.json(url.endsWith('status')?status():url.endsWith('history')?history():result(c,{reading:!url.endsWith('recover')}));}),getToken:()=>wait.promise});
 const body={command_id:r.command_id},o={method:'POST',body},pending=client(B+'/recover',o);body.command_id=c.candidate_id;o.method='GET';wait.resolve(token);await pending;assert.deepEqual(JSON.parse(calls[0].o.body),{command_id:r.command_id});
 await client(B+'/status');await client(`${B}/commands/${r.command_id}`);await client(`${B}/candidates/${c.candidate_id}/history`,{method:'POST',body:{limit:25,before:null}});assert.deepEqual(calls.map(x=>x.o.method),['POST','GET','GET','POST']);
 await assert.rejects(client('/v1/fiscal-authorization/recover',{method:'POST',body:{command_id:r.command_id}}),e=>e.status===400);assert.equal(calls.length,4);
});
test('closed rejection stays definitive; missing, malformed and uncertain write responses preserve recovery semantics',async()=>{
 for(const [statusCode,uncertain] of [[409,false],[403,true],[401,true],[503,true]]){let calls=0;const client=createFiscalReviewedAuthorizationClient(ports(async()=>{calls++;return Response.json({error:statusCode===409?'AUTHORIZATION_CONFLICT':statusCode===403?'AUTHORIZATION_FORBIDDEN':statusCode===401?'AUTHORIZATION_UNAUTHENTICATED':'AUTHORIZATION_UPSTREAM_UNAVAILABLE',recovery_required:uncertain,command_id:r.command_id},{status:statusCode});}));await assert.rejects(client(B+'/recover',{method:'POST',body:{command_id:r.command_id}}),e=>e instanceof ReviewedAuthorizationClientError&&e.status===(uncertain&&statusCode<500?503:statusCode)&&e.recovery_required===uncertain&&e.upstream_status===statusCode);assert.equal(calls,1);}
 for(const response of [Response.json({error:'AUTHORIZATION_CONFLICT',recovery_required:false,command_id:c.candidate_id},{status:409}),new Response(' '.repeat(262145),{headers:{'content-type':'application/json'}}),new Response('',{status:302,headers:{location:'https://else.invalid'}}),Response.json({...r,can_emit:true}),Response.json({error:'AUTHORIZATION_UPSTREAM_UNAVAILABLE',recovery_required:false,private:'not exposed'},{status:503})]){
 const client=createFiscalReviewedAuthorizationClient(ports(async()=>response));await assert.rejects(client(B+'/recover',{method:'POST',body:{command_id:r.command_id}}),e=>e.status===502&&e.recovery_required&&!String(e).includes('not exposed'));
 }
});
test('abort after dispatch is uncertain, identity switch discards late result, token role recheck prevents dispatch',async()=>{
 const wait=deferred(),cancel=new AbortController();let calls=0;const client=createFiscalReviewedAuthorizationClient(ports(async()=>{calls++;return wait.promise;})),pending=client(B+'/recover',{method:'POST',body:{command_id:r.command_id},signal:cancel.signal}),rejected=assert.rejects(pending,e=>e.status===503&&e.recovery_required);await new Promise(r=>setImmediate(r));cancel.abort();await rejected;wait.resolve(Response.json(result(c,{reading:false})));assert.equal(calls,1);
 const next=deferred();let epoch=1;const stale=createFiscalReviewedAuthorizationClient({...ports(async()=>next.promise),getEpoch:()=>epoch}),reading=stale(B+'/commands/'+r.command_id);await new Promise(r=>setImmediate(r));epoch++;next.resolve(Response.json(r));await assert.rejects(reading,e=>e.name==='AbortError');
 const tokenWait=deferred(),snapshot=state();let sent=0;const changed=createFiscalReviewedAuthorizationClient({...ports(async()=>{sent++;return Response.json(r);}),getSnapshot:()=>snapshot,getToken:()=>tokenWait.promise}),blocked=changed(B+'/recover',{method:'POST',body:{command_id:r.command_id}});snapshot.membership.role='consulta';tokenWait.resolve(token);await assert.rejects(blocked,e=>e.name==='AbortError');assert.equal(sent,0);
});
test('UTF8, decoded byte bound, private error fields and public operational-origin guarantees fail closed for reads',async()=>{
 const wrong=result();wrong.receipt.origin='synthetic';
 for(const response of [new Response(new Uint8Array([0xc3,0x28]),{headers:{'content-type':'application/json'}}),Response.json(wrong),new Response('{}'.repeat(131073),{headers:{'content-type':'application/json','content-encoding':'gzip'}}),Response.json({error:'AUTHORIZATION_UPSTREAM_UNAVAILABLE',recovery_required:true},{status:503})]){
 const client=createFiscalReviewedAuthorizationClient(ports(async()=>response));await assert.rejects(client(`${B}/commands/${r.command_id}`),e=>[502,503].includes(e.status)&&!e.recovery_required);
 }
});
