import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {createContainerBridge} from '../../../workers/fiscal-executor/src/bridge.mjs';
import {createExecutorDispatch} from '../../../workers/fiscal-executor/src/dispatch.mjs';
import {createAuthorizationRuntimeHandler} from '../src/handler.mjs';
import {createAuthorizationGateway} from '../src/gateway.mjs';
import {actor,candidateId,commandId,secret,keyId,audience,internal,external,env,service,runBody as legacyRunBody} from './fixtures.mjs';
import {dispatchService} from './dispatch-fixtures.mjs';
import {selectedRunBody as runBody} from './dispatch-fixtures.mjs';
test('reviewed HMAC routes traverse real dispatch/bridge and reject cross-domain before container start',async()=>{
 let starts=0,runs=0,broken=false;const handler=createAuthorizationRuntimeHandler({service:service(),dispatch:{service:dispatchService({run:async()=>{runs++;throw Error('PRIVATE_LOST_ACK');}}),readAccess:async actor=>({actor,role:'admin'}),enabled:true},transportSecret:secret,transportKeyId:keyId,audience});
 const gateway=createAuthorizationGateway({fetchImpl:async()=>Response.json({id:actor}),now:Date.now,nonce:randomUUID});
 const container={running:false,images:{base:'synthetic'},start(){starts++;this.running=true;},async setInactivityTimeout(){},getTcpPort(){return{fetch:async r=>{if(typeof r==='string')return new Response(null,{status:401,headers:{'x-content-type-options':'nosniff'}});if(broken)throw Error('PRIVATE_LINK');return handler(new Request('http://runtime.internal'+new URL(r.url).pathname,r));}};}};
 const environment={...env(),FISCAL_AUTHORIZATION_REVIEWED_ENABLED:'true',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',A1_FINGERPRINT_SECRET:'synthetic-fingerprint',A1_KEK_RING_JSON:'synthetic-ring',A1_CURRENT_KEK_ID:'synthetic-kek'};
 const bridge=createContainerBridge({container},environment,{wait:async()=>{},diagnostic:()=>{}}),dispatch=createExecutorDispatch({fetchImpl:()=>{throw Error('UNSIGNED_FORBIDDEN');}});environment.A1_CONTAINER={getByName:()=>({fetch:bridge})};environment.A1_RUNTIME={fetch:r=>dispatch(r,environment)};
 try{
  const request=await internal('/reviewed/run',runBody,{origin:'https://fiscal-runtime.internal'}),[scheme,token]=request.headers.get('authorization').split(' '),[id,encoded]=token.split('.');
  for(const domain of ['a1','signed','wsdl','reconciliation','danfe','unsigned']){const mac=createHmac('sha256',secret).update(`brufap-${domain}-request-v1.${id}.${encoded}`).digest('hex');const bad=new Request(request.url,{method:'POST',headers:{Authorization:`${scheme} ${id}.${encoded}.${mac}`,'Content-Type':'application/json'},body:JSON.stringify(runBody)});assert.equal((await bridge(bad)).status,401);}
  assert.equal(starts,0);assert.equal(runs,0);
  const status=await gateway(external('/reviewed/status'),environment);assert.equal(status.status,200);assert.equal(starts,1);
  const lost=await gateway(external('/reviewed/run',runBody),environment);assert.equal(lost.status,503);assert.equal((await lost.json()).recovery_required,true);assert.equal(runs,1);
  assert.equal((await gateway(external('/reviewed/commands/'+commandId),environment)).status,200);assert.equal(runs,1);
  broken=true;const failed=await gateway(external('/reviewed/recover',{command_id:commandId}),environment);assert.equal(failed.status,503);assert.equal((await failed.json()).recovery_required,true);
  const history=await gateway(external('/reviewed/candidates/'+candidateId+'/history',{limit:25,before:null}),environment);assert.equal(history.status,503);assert.equal((await history.json()).recovery_required,false);
  const denied={A1_CONTAINER:{getByName(){throw Error('PRIVATE_DISPATCH');}}};for(const[p,b,expected]of[['/reviewed/run',runBody,true],['/reviewed/recover',{command_id:commandId},true],['/reviewed/candidates/'+candidateId+'/history',{limit:25,before:null},false],['/reviewed/status',undefined,false]]){const r=await dispatch(await internal(p,b,{origin:'https://fiscal-runtime.internal'}),denied);const value=await r.json();assert.equal(value.recovery_required,expected);assert.doesNotMatch(JSON.stringify(value),/PRIVATE/);}
 }finally{handler.dispose();}
});
