import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {createContainerBridge} from '../../../workers/fiscal-executor/src/bridge.mjs';
import {createExecutorDispatch} from '../../../workers/fiscal-executor/src/dispatch.mjs';
import {createAuthorizationRuntimeHandler} from '../src/handler.mjs';
import {createAuthorizationGateway} from '../src/gateway.mjs';
import {actor,candidateId as candidate,commandId as command,secret,keyId,audience,internal,external,env,service} from './fixtures.mjs';
import {saveBody,reviewService} from './review-fixtures.mjs';
const path=`/candidates/${candidate}/review`;
function setup(){const review=reviewService(),handler=createAuthorizationRuntimeHandler({service:service(),reviewService:review.service,transportSecret:secret,transportKeyId:keyId,audience}),gateway=createAuthorizationGateway({fetchImpl:async()=>Response.json({id:actor}),now:Date.now,nonce:randomUUID});return{review,handler,gateway,environment:env(),close:()=>handler.dispose()};}
test('review gateway→dispatch→bridge→handler authenticates before container and preserves uncertainty on link loss',async()=>{
 const f=setup();let starts=0,broken=false;const container={running:false,images:{base:'synthetic'},start(){starts++;this.running=true;},async setInactivityTimeout(){},getTcpPort(){return{fetch:async input=>{if(typeof input==='string')return new Response(null,{status:401,headers:{'x-content-type-options':'nosniff'}});if(broken)throw Error('PRIVATE_LINK_LOSS');return f.handler(new Request('http://runtime.internal'+new URL(input.url).pathname,input));}};}};
 const environment={...f.environment,SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',A1_FINGERPRINT_SECRET:'synthetic-fingerprint',A1_KEK_RING_JSON:'synthetic-ring',A1_CURRENT_KEK_ID:'synthetic-kek'};
 const bridge=createContainerBridge({container},environment,{wait:async()=>{},diagnostic:()=>{}}),dispatch=createExecutorDispatch({fetchImpl:()=>{throw Error('UNSIGNED_FORBIDDEN');}});environment.A1_CONTAINER={getByName:()=>({fetch:bridge})};environment.A1_RUNTIME={fetch:r=>dispatch(r,environment)};
 try{
  const authentic=await internal(path,saveBody(),{origin:'https://fiscal-runtime.internal'}),[scheme,token]=authentic.headers.get('authorization').split(' '),[id,encoded]=token.split('.');
  for(const domain of ['a1','signed','wsdl','reconciliation','danfe','unsigned']){const mac=createHmac('sha256',secret).update(`brufap-${domain}-request-v1.${id}.${encoded}`).digest('hex');const r=await bridge(new Request(authentic.url,{method:'POST',headers:{Authorization:`${scheme} ${id}.${encoded}.${mac}`,'Content-Type':'application/json'},body:JSON.stringify(saveBody())}));assert.equal(r.status,401);}
  assert.equal(starts,0);assert.equal(f.review.calls.length,0);
  assert.equal((await f.gateway(external(path,saveBody()),environment)).status,200);assert.equal(starts,1);assert.equal(f.review.calls.filter(x=>x[0]==='save').length,1);
  broken=true;const lost=await f.gateway(external(path,saveBody()),environment);assert.equal(lost.status,503);const value=await lost.json();assert.equal(value.recovery_required,true);assert.equal(value.command_id,command);assert.doesNotMatch(JSON.stringify(value),/PRIVATE/);
  const deniedEnv={A1_CONTAINER:{getByName(){throw Error('PRIVATE_DISPATCH');}}};for(const [route,expected]of [[path,true],['/preview',false]]){const r=await dispatch(await internal(route,route===path?saveBody():{candidate_id:candidate,signed_hash:'a'.repeat(64)},{origin:'https://fiscal-runtime.internal'}),deniedEnv);assert.equal((await r.json()).recovery_required,expected);}
 }finally{f.close();}
});
