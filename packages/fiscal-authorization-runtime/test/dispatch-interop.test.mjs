// SQL069/068/050, encrypted synthetic041 and XSD. The only HTTPS peer is an injected driver.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {selectedDispatchFixture as dispatchFixture} from '../../fiscal-authorization/test/selected-dispatch-fixture.mjs';
import {createAuthorizationRuntimeHandler} from '../src/handler.mjs';
import {createAuthorizationGateway} from '../src/gateway.mjs';
import {createDispatchAccessReader} from '../src/dispatch-access.mjs';
import {secret,keyId,audience,external,env,service} from './fixtures.mjs';

test('versioned gateway→HMAC→069 HTTP/SQL→synthetic custody→XSD and immutable command recovery55/65',{timeout:60000},async t=>{
 const f=await dispatchFixture();let handler;const make=(c,x,enabled=true)=>{
  handler?.dispose();handler=createAuthorizationRuntimeHandler({service:service(),dispatch:{service:x.service,enabled,readAccess:createDispatchAccessReader({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-only-service-role',fetchImpl:async(url,o)=>{assert.match(url,/\/erp_access_me$/);return Response.json(await f.callSql('erp_access_me',JSON.parse(o.body)));}})},transportSecret:secret,transportKeyId:keyId,audience});
  const gateway=createAuthorizationGateway({fetchImpl:async()=>Response.json({id:c.input.actor}),now:Date.now,nonce:randomUUID});const environment={...env(),FISCAL_AUTHORIZATION_REVIEWED_ENABLED:'true',A1_RUNTIME:{fetch:r=>handler(new Request('http://runtime.internal'+new URL(r.url).pathname,r))}};
  return(p,b)=>gateway(external('/reviewed'+p,b),environment);
 };
 try{
  for(const model of ['55','65'])await t.test(model,async()=>{
   const c=await f.source(model),x=f.compose(c),send=make(c,x);const status=await send('/status');assert.equal(status.status,200,await status.clone().text());assert.equal((await status.json()).runtime_enabled,true);
   const body=await f.request(c);const r=await send('/run',body);assert.equal(r.status,200,await r.clone().text());const ack=await r.json();assert.equal(ack.status,'authorized_homologation');assert.equal(ack.authorized_in_homologation,true);assert.equal(ack.tax_rules_validated,false);assert.equal(ack.can_emit,false);assert.ok(ack.subset_review.review_hash);assert.ok(ack.observation.sha256);
   const count=f.events.filter(n=>n==='POST').length;const read=await send('/commands/'+c.input.commandId);assert.equal(read.status,200);assert.deepEqual((await read.json()).receipt,ack.receipt);
   const history=await send('/candidates/'+c.input.candidateId+'/history',{limit:25,before:null});assert.equal(history.status,200,await history.clone().text());assert.equal((await history.json()).items[0].command_id,c.input.commandId);
   const replay=await send('/run',body);assert.equal(replay.status,200);assert.equal(f.events.filter(n=>n==='POST').length,count);
  });
  await t.test('lost use ACK is recovered only by GET, never repeated or turned into another POST',async()=>{
   const c=await f.source('55');let lost=true;const x=f.compose(c,{rpc:async(n,a,o)=>{f.events.push(n);const v=await f.rpc(n,a,o);if(n.endsWith('_use')&&lost){lost=false;throw Error('PRIVATE_LOST_ACK');}return v;}}),send=make(c,x),before=f.events.filter(n=>n==='POST').length;
   const body=await f.request(c);const r=await send('/run',body);assert.equal(r.status,200);const value=await r.json();assert.equal(value.status,'unconfirmed');assert.equal(value.recovery_required,true);assert.doesNotMatch(JSON.stringify(value),/PRIVATE/);
   assert.equal((await send('/commands/'+c.input.commandId)).status,200);const recovery=await send('/recover',{command_id:c.input.commandId});assert.equal(recovery.status,200);assert.equal((await recovery.json()).status,'unconfirmed');assert.equal(f.events.filter(n=>n==='POST').length,before);
  });
  await t.test('current ACL is enforced by status and ledger reads independently',async()=>{
   const c=await f.source('65'),send=make(c,f.compose(c));await f.db.query('update erp_access.membership set active=false where user_id=$1',[c.input.actor]);
   try{assert.equal((await send('/status')).status,403);assert.equal((await send('/commands/'+c.input.commandId)).status,403);}finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[c.input.actor]);}
  });
 }finally{handler?.dispose();await f.close();}
});
