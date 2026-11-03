import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {closureFixture,CLOSE,GET,BEGIN,hash} from './expired-closure-fixture.mjs';
import {createAuthorizationClosureRpc} from '../src/closure-rpc.mjs';
import {createAuthorizationClosureService} from '../src/closure-service.mjs';
import {captureClosureInput,projectClosurePublic} from '../src/closure-dto.mjs';
import {createAuthorizationRuntimeHandler} from '../../fiscal-authorization-runtime/src/handler.mjs';
import {createAuthorizationGateway} from '../../fiscal-authorization-runtime/src/gateway.mjs';
import {dispatchService} from '../../fiscal-authorization-runtime/test/dispatch-fixtures.mjs';
import {secret,keyId,audience,external,env,service as legacyService} from '../../fiscal-authorization-runtime/test/fixtures.mjs';
const input=x=>({command_id:x.args.p_command_id,authorization_command_id:x.args.p_authorization_command_id,expected_attempt_id:x.args.p_expected_attempt_id,expected_state:x.args.p_expected_state,confirmed:true});
const reject=(fn,code)=>assert.rejects(fn,e=>e.code===code);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('074 SQL→RPC→closure service→HMAC gateway with gatefalse and no transport ports',{timeout:60000},async t=>{
 const f=await closureFixture();let handler;const calls=[];
 const rpc=createAuthorizationClosureRpc({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-test-service-key-only',fetchImpl:async(url,o)=>{const name=url.split('/').at(-1),args=JSON.parse(o.body);calls.push({name,args});try{return Response.json(await f.callSql(name,args));}catch(e){return Response.json({code:e.code,message:'PRIVATE_DATABASE_SENTINEL'},{status:400});}}});
 const compose=(patch={})=>createAuthorizationClosureService({closureRpc:rpc,reviewedRpc:async(n,a,o)=>{calls.push({name:n,args:a});return f.rpc(n,a,o);},...patch});
 const send=(actor,closure)=>{
  handler?.dispose();handler=createAuthorizationRuntimeHandler({service:legacyService(),dispatch:{enabled:false,readAccess:async()=>{throw Error('unexpected status');},service:dispatchService(closure)},transportSecret:secret,transportKeyId:keyId,audience});
  const gateway=createAuthorizationGateway({fetchImpl:async()=>Response.json({id:actor}),now:Date.now,nonce:randomUUID}),environment={...env(),FISCAL_AUTHORIZATION_REVIEWED_ENABLED:'false',A1_RUNTIME:{fetch:r=>handler(new Request('http://runtime.internal'+new URL(r.url).pathname,r))}};
  return(path,body)=>gateway(external('/reviewed'+path,body),environment);
 };
 try{
  for(const model of ['55','65'])for(const prepared of [false,true])await t.test(model+' '+(prepared?'request_ready':'prepared')+' derives hash privately; close and GET succeed with gatefalse',async()=>{
   const x=await f.start(model,{prepared});await f.age(x.b.args.p_command_id);calls.length=0;const body=input(x),request=send(x.args.p_user_id,compose());
   const response=await request('/close-expired',body);assert.equal(response.status,200,await response.clone().text());const ack=await response.json();assert.equal(ack.read_only,false);assert.equal(ack.receipt.reason,'LEASE_EXPIRED_UNCONSUMED');assert.equal(ack.receipt.attempt_id,body.expected_attempt_id);assert.equal(ack.can_transmit,false);assert.equal(Object.hasOwn(ack.receipt,'request_hash'),false);
   assert.deepEqual(calls.map(x=>x.name),[GET,'erp_fiscal_reviewed_authorization_command',CLOSE]);assert.equal(calls[2].args.p_expected_request_hash,x.args.p_expected_request_hash);assert.ok(calls.every(c=>c.args.p_user_id===x.args.p_user_id));
   const read=await request('/closure-commands/'+body.command_id);assert.equal(read.status,200);const current=await read.json();assert.deepEqual(current.receipt,ack.receipt);assert.equal(current.read_only,true);assert.deepEqual(projectClosurePublic(current,{action:'closureCommand',commandId:body.command_id}),current);
  });
  await t.test('valid lease, mismatched attempt/state and consumed grant never reach close RPC',async()=>{
   const x=await f.start('55',{prepared:true}),closure=compose();calls.length=0;
   await reject(()=>closure.closeExpired({actor:x.args.p_user_id,request:input(x)},f.opts()),'40001');assert.equal(calls.filter(c=>c.name===CLOSE).length,0);
   await f.age(x.b.args.p_command_id);for(const patch of [{expected_attempt_id:randomUUID()},{expected_state:'prepared'}])await reject(()=>closure.closeExpired({actor:x.args.p_user_id,request:{...input(x),...patch}},f.opts()),'40001');assert.equal(calls.filter(c=>c.name===CLOSE).length,0);
   const used=await f.start('65',{prepared:true});await f.use(used.b,used.proof);await f.age(used.b.args.p_command_id);await reject(()=>closure.closeExpired({actor:used.args.p_user_id,request:input(used)},f.opts()),'40001');assert.equal(calls.filter(c=>c.name===CLOSE).length,0);
  });
  await t.test('commit ACK loss preserves UUID; GET and replay do not read current authorization or repeat close',async()=>{
   const x=await f.start(),body=input(x);await f.age(x.b.args.p_command_id);calls.length=0;let lost=true;
   const closure=compose({closureRpc:async(n,a,o)=>{const v=await rpc(n,a,o);if(n===CLOSE&&lost){lost=false;throw Error('PRIVATE_LOST_ACK');}return v;}}),request=send(x.args.p_user_id,closure);
   const response=await request('/close-expired',body);assert.equal(response.status,503);const uncertain=await response.json();assert.equal(uncertain.recovery_required,true);assert.equal(uncertain.command_id,body.command_id);assert.doesNotMatch(JSON.stringify(uncertain),/PRIVATE/);
   const read=await request('/closure-commands/'+body.command_id);assert.equal(read.status,200);const prior=await read.json();assert.equal(calls.filter(c=>c.name===CLOSE).length,1);
   await f.rpc(BEGIN,{...x.b.args,p_command_id:randomUUID()},f.opts());await f.review(x.c,{p_command_id:randomUUID(),p_expected_review_version:1});f.setPolicy(await f.enable('operational',false));
   const before=calls.length,replayed=await request('/close-expired',body);assert.equal(replayed.status,200);const v=await replayed.json();assert.deepEqual(v.receipt,prior.receipt);assert.equal(v.current.successor_exists,true);assert.equal(v.replayed,true);assert.deepEqual(calls.slice(before).map(c=>c.name),[GET]);
   const conflict=await request('/close-expired',{...body,expected_state:'request_ready'});assert.equal(conflict.status,409);assert.equal((await conflict.json()).recovery_required,false);f.setPolicy(await f.enable());
  });
  await t.test('captures caller body before awaiting the first command read',async()=>{
   const x=await f.start();await f.age(x.b.args.p_command_id);const entered=deferred(),gate=deferred(),body=input(x),original=structuredClone(body);let first=true;
   const closure=compose({closureRpc:async(n,a,o)=>{if(first){first=false;entered.resolve();await gate.promise;}return rpc(n,a,o);}}),pending=closure.closeExpired({actor:x.args.p_user_id,request:body},f.opts());
   await entered.promise;body.authorization_command_id=randomUUID();body.expected_attempt_id=randomUUID();body.expected_state='request_ready';gate.resolve();const v=await pending;assert.equal(v.receipt.authorization_command_id,original.authorization_command_id);assert.equal(v.receipt.attempt_id,original.expected_attempt_id);
  });
  await t.test('concurrent same UUID committed after initial404 returns its receipt without another append',async()=>{
   const x=await f.start();await f.age(x.b.args.p_command_id);let raced=false;calls.length=0;
   const closure=compose({reviewedRpc:async(n,a,o)=>{if(!raced){raced=true;await f.closeAttempt(x);}calls.push({name:n,args:a});return f.rpc(n,a,o);}});
   const v=await closure.closeExpired({actor:x.args.p_user_id,request:input(x)},f.opts());assert.equal(v.replayed,true);assert.equal(v.receipt.command_id,x.args.p_command_id);assert.deepEqual(calls.map(c=>c.name),[GET,'erp_fiscal_reviewed_authorization_command',GET]);assert.equal((await f.db.query('select count(*)::int n from erp_fiscal_authorization_closure.command where id=$1',[x.args.p_command_id])).rows[0].n,1);
  });
  await t.test('ACL revocation between private read and append aborts SQL; roleloss also blocks historical GET',async()=>{
   const x=await f.start();await f.age(x.b.args.p_command_id);const actor=x.args.p_user_id;
   const closure=compose({reviewedRpc:async(n,a,o)=>{const v=await f.rpc(n,a,o);await f.db.query('update erp_access.membership set active=false where user_id=$1',[actor]);return v;}});
   try{await reject(()=>closure.closeExpired({actor,request:input(x)},f.opts()),'42501');}finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[actor]);}
   assert.equal((await f.db.query('select count(*)::int n from erp_fiscal_authorization_closure.command where id=$1',[x.args.p_command_id])).rows[0].n,0);
   await compose().closeExpired({actor,request:input(x)},f.opts());await f.db.query('update erp_access.membership set active=false where user_id=$1',[actor]);try{await reject(()=>compose().closureCommand({actor,commandId:x.args.p_command_id},f.opts()),'42501');}finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[actor]);}
  });
  await t.test('input getters and browser hash/actor aliases are rejected before ports',async()=>{
   const x=await f.start();let gets=0;const body=input(x);Object.defineProperty(body,'expected_state',{enumerable:true,get(){gets++;return'prepared';}});assert.throws(()=>captureClosureInput(body));assert.equal(gets,0);
   for(const patch of [{request_hash:hash('forged')},{actor:x.args.p_user_id},{original_command_id:randomUUID()},{confirmed:false}])assert.throws(()=>captureClosureInput({...input(x),...patch}));
  });
 }finally{handler?.dispose();await f.close();}
});
test('074 bounded RPC rejects empty/stalled/malformed responses and abort before dispatch',async()=>{
 let calls=0,cancelled=0;const rpc=createAuthorizationClosureRpc({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-test-service-key-only',fetchImpl:async()=>{calls++;return new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array());},cancel(){cancelled++;return new Promise(()=>{});}}),{headers:{'Content-Type':'application/json'}});}}),args={p_user_id:randomUUID(),p_command_id:randomUUID()};
 await assert.rejects(()=>rpc(GET,args,{deadline:Date.now()+1000}));assert.equal(calls,1);assert.equal(cancelled,1);const abort=new AbortController();abort.abort();await reject(()=>rpc(GET,args,{signal:abort.signal}),'AUTHORIZATION_SERVICE_ABORTED');assert.equal(calls,1);
 await reject(()=>rpc('erp_fiscal_authorization_use',args),'AUTHORIZATION_CLOSURE_RPC_UNSUPPORTED');assert.equal(calls,1);
});
