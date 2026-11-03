import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createWsdlRuntimeHandler} from '../src/handler.mjs';
import {signRuntimeRequest,digest} from '../src/auth.mjs';
import {FLAGS} from '../src/dto.mjs';

const actor=randomUUID(),commandId=randomUUID(),attempt=randomUUID(),secret=randomBytes(32),keyId='synthetic',audience='synthetic-wsdl';
const payload={command_id:commandId,model:'55',operation:'protocol',expected_a1_version:1,expected_identity_version:1,confirmed:true};
function result(readOnly=false){
 const created=new Date(Date.now()-1000).toISOString(),expires=new Date(Date.now()+59000).toISOString();
 return{...FLAGS,status:'stored',command_id:commandId,recovery_required:false,read_only:readOnly,recovered:false,failure_code:null,error_code:null,
  receipt:{attempt_id:attempt,command_id:commandId,profile:FLAGS.profile,model:'55',operation:'protocol',environment:'2',a1_version:1,identity_version:1,confirmed:true,created_at:created},
  current:{state:'stored',a1_version:1,identity_version:1,a1_changed:false,company_changed:false,certificate_time_valid_now:true,grant_consumed:true,lease_expired:false,
   expires_at:expires,used_at:created,finished_at:created,recovery_required:false,retry_get_allowed:false},
  artifact:{sha256:'a'.repeat(64),size_bytes:100,inspection_status:'supported',inspection_code:null,created_at:created},
  execution:'SYNTHETIC-PRIVATE-MUST-NOT-LEAK',credential:'SYNTHETIC-PRIVATE-MUST-NOT-LEAK'};
}
function setup(service){return createWsdlRuntimeHandler({service,transportSecret:secret,transportKeyId:keyId,audience});}
async function request({action='run',body=payload,overrideBody,overrideAudience=audience,now,signal}={}){
 const path=action==='run'?'/internal/v1/fiscal-wsdl/run':`/internal/v1/fiscal-wsdl/commands/${commandId}`;
 const method=action==='run'?'POST':'GET',bytes=new TextEncoder().encode(method==='POST'?JSON.stringify(body):'');
 const authorization=await signRuntimeRequest({secretBytes:secret,keyId,audience:overrideAudience,actor,nonce:randomUUID(),method,path,bodyHash:await digest(bytes),...(now===undefined?{}:{now})});
 return new Request(`http://runtime.internal${path}`,{method,headers:{Authorization:authorization,...(method==='POST'?{'Content-Type':'application/json'}:{})},
  ...(method==='POST'?{body:overrideBody??bytes}:{}),signal});
}
async function checked(response,status=200){
 assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
 const text=await response.text();assert.doesNotMatch(text,/SYNTHETIC-PRIVATE|execution|credential|client_fingerprint|<definitions|lease_id/);return JSON.parse(text);
}
test('private handler binds authenticated actor and captured fields, separates GET recovery and strips private output',async()=>{
 const calls=[],handler=setup({async run(input,options){calls.push(['run',input,options]);return result();},async command(input,options){calls.push(['command',input,options]);return result(true);}});
 try{
  const post=await checked(await handler(await request()));assert.equal(post.status,'stored');assert.equal(post.can_emit,false);assert.equal(post.binding_verified,false);
  const get=await checked(await handler(await request({action:'command'})));assert.equal(get.read_only,true);
  assert.deepEqual(calls[0][1],{actor,commandId,model:'55',operation:'protocol',expectedA1Version:1,expectedIdentityVersion:1,confirmed:true});
  assert.deepEqual(calls[1][1],{actor,commandId});
  for(const call of calls){assert.ok(call[2].signal instanceof AbortSignal);assert.equal(call[2].signal.aborted,true);assert.ok(call[2].deadline<=Date.now()+45000);}
 }finally{handler.dispose();}
});
test('missing/stale/wrong-audience HMAC and body substitution fail before service calls',async()=>{
 let calls=0;const handler=setup({async run(){calls++;return result();},async command(){calls++;return result(true);}});
 try{
  for(const req of [new Request('http://runtime.internal/internal/v1/fiscal-wsdl/run',{method:'POST'}),
   await request({now:Date.now()-61000}),await request({overrideAudience:'other-wsdl'}),await request({overrideBody:JSON.stringify({...payload,model:'65'})})])
    await checked(await handler(req),401);
  assert.equal(calls,0);
 }finally{handler.dispose();}
});
test('confirmation, scope and positive versions are mandatory and no URL or credential field is accepted',async()=>{
 let calls=0;const handler=setup({async run(){calls++;return result();},async command(){calls++;return result(true);}});
 try{
  for(const change of [{confirmed:false},{expected_a1_version:0},{model:'57'},{operation:'distribution'},{endpoint:'https://evil.invalid'},{password:'SYNTHETIC-PRIVATE'}])
   await checked(await handler(await request({body:{...payload,...change}})),400);
  assert.equal(calls,0);
 }finally{handler.dispose();}
});
test('SQL authorization errors and arbitrary service errors have only fixed responses and recovery advice',async()=>{
 for(const [code,status]of [['42501',403],['40001',409],['P0002',404],['WSDL_SERVICE_ALREADY_RUNNING',503],['arbitrary-private',503]]){
  const handler=setup({async run(){throw Object.assign(new Error('SYNTHETIC-PRIVATE'),{code});},async command(){throw Object.assign(new Error('SYNTHETIC-PRIVATE'),{code});}});
  try{assert.equal((await checked(await handler(await request()),status)).recovery_required,true);assert.equal((await checked(await handler(await request({action:'command'})),status)).recovery_required,false);}
  finally{handler.dispose();}
 }
});
test('two admitted requests block a third; abort and disposal discard late service responses without retry',async()=>{
 const entered=[],resolve=[];let calls=0;
 const handler=setup({async run(_,opts){calls++;entered.push(opts.signal);return new Promise(r=>resolve.push(r));},async command(){return result(true);}});
 const abort=new AbortController(),a=handler(await request({signal:abort.signal}));
 await new Promise(r=>setImmediate(r));const b=handler(await request());await new Promise(r=>setImmediate(r));
 try{
  assert.equal((await checked(await handler(await request()),503)).error,'WSDL_RUNTIME_BUSY');assert.equal(calls,2);
  abort.abort();assert.equal((await checked(await a,503)).recovery_required,true);assert.equal(entered[0].aborted,true);
  handler.dispose();await checked(await b,503);assert.equal(entered[1].aborted,true);
  resolve.forEach(r=>r(result()));await new Promise(r=>setImmediate(r));await checked(await handler(await request()),503);assert.equal(calls,2);
 }finally{handler.dispose();resolve.forEach(r=>r(result()));}
});
