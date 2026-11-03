import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDanfeGateway} from '../src/gateway.mjs';
import {verifyRuntimeRequest,digest} from '../src/auth.mjs';
import {fixture,secret,keyId,actor,result} from './fixtures.mjs';
const ORIGIN='https://app.synthetic.invalid',PROJECT='https://abcdefghijklmnopqrst.supabase.co';
async function gatewayFixture({auth,upstream}={}){
 const f=await fixture(),calls={auth:0,runtime:0},env={ALLOWED_ORIGINS:ORIGIN,SUPABASE_URL:PROJECT,SUPABASE_ANON_KEY:'synthetic-public-anon-key',A1_TRANSPORT_SECRET:Buffer.from(secret).toString('base64'),A1_TRANSPORT_KEY_ID:keyId,A1_AUDIENCE:'synthetic',
  A1_RUNTIME:{fetch:async request=>{calls.runtime++;return upstream?upstream(request,f):Response.json(f.dto);}}};
 const gateway=createDanfeGateway({now:Date.now,nonce:randomUUID,fetchImpl:async(url,opts)=>{calls.auth++;assert.equal(url,PROJECT+'/auth/v1/user');assert.equal(opts.redirect,'manual');assert.equal(opts.credentials,'omit');return auth?auth(url,opts):Response.json({id:actor,is_anonymous:false});}});
 const request=(tail='',options={})=>new Request(`https://gateway.synthetic.invalid/v1/fiscal-danfe/candidates/${f.id}/preview${tail}`,{method:'GET',...options,headers:{Origin:ORIGIN,Authorization:'Bearer synthetic-user-session-1234567890',...options.headers}});
 return{...f,calls,env,gateway,request,send:(tail,opts)=>gateway(request(tail,opts),env)};
}
test('gateway verifies session and sends only a DANFE-bound actor to the private runtime',async()=>{
 const f=await gatewayFixture({upstream:async(request,f)=>{
  assert.equal(request.method,'GET');assert.equal(request.headers.get('origin'),null);assert.equal(request.headers.get('apikey'),null);assert.equal(request.redirect,'manual');
  const claims=await verifyRuntimeRequest({header:request.headers.get('authorization'),secretBytes:secret,keyId,audience:'synthetic-danfe',method:'GET',path:new URL(request.url).pathname});
  assert.equal(claims.actor,actor);assert.equal(claims.body_hash,await digest(new Uint8Array()));return Response.json(f.dto);
 }});
 const response=await f.send();assert.equal(response.headers.get('access-control-allow-origin'),ORIGIN);assert.deepEqual(await result(response),f.dto);assert.deepEqual(f.calls,{auth:1,runtime:1});
});
test('CORS/method/query/body/session failures never dispatch a preview',async()=>{
 const f=await gatewayFixture();
 const pre=await f.send('',{method:'OPTIONS',headers:{'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'authorization'}});assert.equal(pre.status,204);assert.deepEqual(f.calls,{auth:0,runtime:0});
 for(const[tail,opts,status]of [['?x=1',{},400],['#x',{},400],['/',{},404],['',{method:'POST',body:'{}'},405],['',{headers:{Origin:'https://other.invalid'}},403],['',{headers:{Authorization:'Bearer short'}},401],['',{headers:{'content-length':'1'}},413]])await result(await f.send(tail,opts),status);
 assert.equal(f.calls.runtime,0);
 for(const auth of [()=>Response.json({id:actor,is_anonymous:true}),()=>Response.json({id:'bad'}),()=>Response.json({error:'PRIVATE_DIAGNOSTIC'},{status:401})]){const a=await gatewayFixture({auth});await result(await a.send(),401);assert.equal(a.calls.runtime,0);}
});
test('upstream HTML/hash/identity/private fields and redirects fail closed with sanitized errors',async()=>{
 for(const upstream of [(_r,f)=>Response.json({...f.dto,html_sha256:'f'.repeat(64)}),(_r,f)=>Response.json({...f.dto,candidate_id:randomUUID()}),(_r,f)=>Response.json({...f.dto,credential_id:'PRIVATE_DIAGNOSTIC'}),()=>new Response(null,{status:302,headers:{Location:'https://never.invalid'}}),()=>Response.json({error:'PRIVATE_DIAGNOSTIC',recovery_required:false},{status:403})]){
  const f=await gatewayFixture({upstream});const v=await result(await f.send(),502);assert.equal(v.html,undefined);assert.equal(v.recovery_required,false);assert.equal(f.calls.runtime,1);
 }
 const denied=await gatewayFixture({upstream:()=>Response.json({error:'DANFE_FORBIDDEN',recovery_required:false},{status:403})});assert.equal((await result(await denied.send(),403)).error,'DANFE_FORBIDDEN');
});
test('abort cancels a late runtime body and never retries the GET automatically',async()=>{
 let enter,finish,cancelled=false;const ready=new Promise(r=>{enter=r;}),f=await gatewayFixture({upstream:()=>{enter();return new Promise(r=>{finish=r;});}}),a=new AbortController();
 const pending=f.send('',{signal:a.signal});await ready;a.abort();await result(await pending,503);finish(new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'Content-Type':'application/json'}}));await new Promise(r=>setImmediate(r));assert.equal(cancelled,true);assert.equal(f.calls.runtime,1);
});
