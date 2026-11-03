import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createReconciliationRuntimeHandler} from '../src/handler.mjs';
import {signRuntimeRequest,digest} from '../src/auth.mjs';
import {actor,command,candidate,payload,result,history} from './fixtures.mjs';
const secret=randomBytes(32),keyId='synthetic',audience='synthetic-reconciliation',prefix='/internal/v1/fiscal-reconciliation';
function service(overrides={}){return {run:async()=>result(),command:async()=>result('stored',payload(),true),recover:async()=>({...result(),recovered:true}),history:async()=>history(),...overrides};}
function setup(value){return createReconciliationRuntimeHandler({service:value,transportSecret:secret,transportKeyId:keyId,audience});}
async function request({action='run',body,overrideBody,overrideAudience=audience,now,signal}={}){
 const path=action==='command'?`${prefix}/commands/${command}`:action==='history'?`${prefix}/candidates/${candidate}/history`:`${prefix}/${action}`;
 const method=action==='command'?'GET':'POST',data=body??(action==='run'?payload():action==='recover'?{command_id:command}:{limit:25,before:null});
 const bytes=new TextEncoder().encode(method==='POST'?JSON.stringify(data):'');
 const authorization=await signRuntimeRequest({secretBytes:secret,keyId,audience:overrideAudience,actor,nonce:randomUUID(),method,path,bodyHash:await digest(bytes),...(now===undefined?{}:{now})});
 return new Request(`http://runtime.internal${path}`,{method,headers:{Authorization:authorization,...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:overrideBody??bytes}:{}),signal});
}
async function checked(response,status=200){assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'no-store');const text=await response.text();assert.doesNotMatch(text,/SYNTHETIC_PRIVATE|credential|lease_id|nonce|raw_xml/);return JSON.parse(text);}
test('authenticated actor and body are captured; recover and history never invoke run',async()=>{
 const calls=[],handlers={};for(const name of ['run','command','recover','history'])handlers[name]=async(input,options)=>{calls.push({name,input,options});return service()[name](input);};
 const handler=setup(handlers);try{
  for(const action of ['run','command','recover','history'])await checked(await handler(await request({action})));
  assert.deepEqual(calls.map(c=>c.name),['run','command','recover','history']);
  assert.deepEqual(calls[0].input,{actor,commandId:command,candidateId:candidate,signedHash:payload().signed_hash,expectedA1Version:1,expectedIdentityVersion:2,confirmed:true});
  assert.deepEqual(calls[2].input,{actor,commandId:command});assert.deepEqual(calls[3].input,{actor,candidateId:candidate,limit:25,before:null});
  assert.ok(calls.every(c=>c.options.signal.aborted&&c.options.deadline<=Date.now()+45000));
 }finally{handler.dispose();}
});
test('authentication, substitution and invalid confirmation fail before reaching service',async()=>{
 let calls=0;const handler=setup(service({run:async()=>{calls++;return result();}}));try{
  for(const req of [new Request('http://runtime.internal'+prefix+'/run',{method:'POST'}),await request({now:Date.now()-61000}),await request({overrideAudience:'other-reconciliation'}),await request({overrideBody:JSON.stringify({...payload(),signed_hash:'f'.repeat(64)})})])await checked(await handler(req),401);
  for(const change of [{confirmed:false},{expected_a1_version:0},{actor},{endpoint:'https://evil.invalid'},{password:'SYNTHETIC_PRIVATE'}])await checked(await handler(await request({body:{...payload(),...change}})),400);
  assert.equal(calls,0);
 }finally{handler.dispose();}
});
test('disabled execution is explicit and does not block read or recovery methods',async()=>{
 const handler=setup(service({run:async()=>{throw Object.assign(new Error('SYNTHETIC_PRIVATE'),{code:'RECONCILIATION_DISABLED'});}}));try{
  const blocked=await checked(await handler(await request()),409);assert.equal(blocked.error,'RECONCILIATION_DISABLED');assert.equal(blocked.recovery_required,false);
  await checked(await handler(await request({action:'command'})));await checked(await handler(await request({action:'recover'})));
 }finally{handler.dispose();}
});
test('private failures are sanitized and interrupted admitted work never retries',async()=>{
 const entered=[],resolve=[];let calls=0;
 const handler=setup(service({run:async(_,opts)=>{calls++;entered.push(opts.signal);return new Promise(r=>resolve.push(r));}}));
 const abort=new AbortController(),a=handler(await request({signal:abort.signal}));await new Promise(r=>setImmediate(r));
 const b=handler(await request());await new Promise(r=>setImmediate(r));
 try{
  assert.equal((await checked(await handler(await request()),503)).error,'RECONCILIATION_RUNTIME_BUSY');assert.equal(calls,2);
  abort.abort();assert.equal((await checked(await a,503)).recovery_required,true);assert.equal(entered[0].aborted,true);
  handler.dispose();await checked(await b,503);assert.equal(entered[1].aborted,true);resolve.forEach(r=>r(result()));await new Promise(r=>setImmediate(r));assert.equal(calls,2);
 }finally{handler.dispose();resolve.forEach(r=>r(result()));}
});
