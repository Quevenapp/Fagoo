import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {selectedDispatchFixture} from './selected-dispatch-fixture.mjs';
import {createAuthorizationDispatchService} from '../src/dispatch-service.mjs';
const reject=(fn,code)=>assert.rejects(fn,e=>e.code===code);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
test('073 selected run is one durable review, exact bytes and one transport',{timeout:60000},async t=>{
 const f=await selectedDispatchFixture();try{
  const counts=()=>({use:f.events.filter(n=>n.endsWith('_use')).length,post:f.events.filter(n=>n==='POST').length,vault:f.events.filter(n=>n==='vault-read').length});
  for(const model of ['55','65'])await t.test(model+' binds before prepare/use and a historical replay never reads a new review',async()=>{
   const c=await f.source(model),request=await f.request(c),x=f.compose(c),before=counts();
   assert.throws(()=>createAuthorizationDispatchService({...x.ports,enabled:false}).runReviewed({actor:c.input.actor,request}),/AUTHORIZATION_SERVICE_DISABLED/);assert.deepEqual(counts(),before);
   const out=await x.service.runReviewed({actor:c.input.actor,request});assert.equal(out.status,'authorized_homologation',JSON.stringify(out));assert.equal(out.subset_review.review_hash,request.expected_review_hash);assert.equal(out.tax_rules_validated,false);assert.equal(counts().post-before.post,1);
   const calls=f.rpcCalls.filter(v=>v.args.p_command_id===c.input.commandId);assert.ok(calls.some(v=>v.name.endsWith('_begin_selected')));
   const state=await f.wire('command',{p_user_id:c.input.actor,p_command_id:c.input.commandId});assert.equal(state.rule_review.review_id,request.expected_review_id);
   const saved=counts(),never=()=>{throw Error('MUST_NOT_SELECT_OR_TRANSMIT');};const recovered=await createAuthorizationDispatchService({...x.ports,selectReview:never,withPreparedSession:never,transport:never}).runReviewed({actor:c.input.actor,request});assert.equal(recovered.status,'authorized_homologation');assert.deepEqual(counts(),saved);
   await reject(()=>x.service.runReviewed({actor:c.input.actor,request:{...request,expected_review_version:2}}),'40001');assert.deepEqual(counts(),saved);
  });
  await t.test('stale displayed CAS cannot start a command even if a newer backend review is valid',async()=>{
   const c=await f.source(),request=await f.request(c);await f.review(c,{p_command_id:randomUUID(),p_expected_review_version:1});const before=counts();
   await reject(()=>f.compose(c).service.runReviewed({actor:c.input.actor,request}),'40001');await reject(()=>f.wire('command',{p_user_id:c.input.actor,p_command_id:c.input.commandId}),'P0002');assert.deepEqual(counts(),before);
  });
  await t.test('caller mutation during selection cannot change command or review, and new review before use blocks grant',async()=>{
   const c=await f.source(),request=await f.request(c),copy=structuredClone(request),entered=deferred(),gate=deferred();
   const x=f.compose(c,{selectReview:async(q,o)=>{entered.resolve();await gate.promise;return f.preflight.select(q,o);},rpc:async(n,a,o)=>{f.events.push(n);if(n.endsWith('_use'))await f.review(c,{p_command_id:randomUUID(),p_expected_review_version:1});return f.rpc(n,a,o);}});
   const before=counts(),pending=x.service.runReviewed({actor:c.input.actor,request});await entered.promise;request.command_id=randomUUID();request.expected_review_hash='0'.repeat(64);gate.resolve();const out=await pending;
   assert.equal(out.command_id,copy.command_id);assert.equal(out.failure_code,'40001');assert.equal(counts().post,before.post);const v=await f.wire('command',{p_user_id:c.input.actor,p_command_id:copy.command_id});assert.equal(v.rule_review.review_hash,copy.expected_review_hash);assert.equal(v.current.grant_consumed,false);
  });
  await t.test('lost begin ACK records the pinned review; recovery cannot issue a grant or select a new review',async()=>{
   const c=await f.source(),request=await f.request(c);let once=true;const x=f.compose(c,{rpc:async(n,a,o)=>{f.events.push(n);const v=await f.rpc(n,a,o);if(n.endsWith('_begin_selected')&&once){once=false;throw Error('LOST_BEGIN_ACK');}return v;}}),before=counts();
   const out=await x.service.runReviewed({actor:c.input.actor,request});assert.equal(out.status,'failed_before_dispatch');assert.deepEqual(counts(),before);const v=await f.wire('command',{p_user_id:c.input.actor,p_command_id:request.command_id});assert.equal(v.rule_review.review_hash,request.expected_review_hash);
   const never=()=>{throw Error('NO_NEW_OPERATION');};await createAuthorizationDispatchService({...x.ports,enabled:false,selectReview:never,readReview:never,withPreparedSession:never,transport:never}).recover({actor:c.input.actor,commandId:request.command_id});assert.deepEqual(counts(),before);
  });
  await t.test('consumed journal recovery ignores later policy, A1 and review, and never obtains a new grant',async()=>{
   const c=await f.source(),request=await f.request(c),x=f.compose(c,{validate:(v,o)=>{if(v.kind==='response')throw Error('VALIDATOR_DOWN');return f.ports.validate(v,o);}});assert.equal((await x.service.runReviewed({actor:c.input.actor,request})).status,'unconfirmed');
   await f.review(c,{p_command_id:randomUUID(),p_expected_review_version:1});await f.disable();await f.enable('operational',false);await f.age(c.input.commandId);const before=counts(),never=()=>{throw Error('NO_NEW_OPERATION');};
   const out=await createAuthorizationDispatchService({...x.ports,enabled:false,validate:f.ports.validate,selectReview:never,readReview:never,withPreparedSession:never,transport:never}).recover({actor:c.input.actor,commandId:request.command_id});assert.equal(out.status,'authorized_homologation',JSON.stringify(out));assert.equal(out.subset_review.review_hash,request.expected_review_hash);assert.deepEqual(counts(),before);
  });
 }finally{await f.close();}
});
