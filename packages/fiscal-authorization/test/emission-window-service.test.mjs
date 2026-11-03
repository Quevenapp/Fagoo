import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedDispatchFixture} from './selected-dispatch-fixture.mjs';
import {createAuthorizationDispatchService} from '../src/dispatch-service.mjs';
import {authorizationRequestEmission} from '../src/request-emission.mjs';
import {NfceEmissionWindowError} from '../src/emission-window.mjs';
const journal=async f=>(await f.db.query(`select (select count(*)from erp_fiscal_authorization.command)::int commands,(select count(*)from erp_fiscal_authorization.attempt)::int attempts,(select count(*)from erp_fiscal_authorization.request)::int requests,(select count(*)from erp_fiscal_reviewed_authorization.review_binding)::int bindings`)).rows[0];
const query=c=>({actor:c.input.actor,candidateId:c.input.candidateId,signedHash:c.input.signedHash});
const counts=f=>({use:f.events.filter(n=>n.endsWith('_use')).length,post:f.events.filter(n=>n==='POST').length,vault:f.events.filter(n=>n==='vault-read').length});
test('080 service derives the NFC-e window from attested XML and preserves historical recovery',{timeout:60000},async t=>{
 const f=await selectedDispatchFixture(),realNow=Date.now;
 try{
  for(const [age,code,status]of[[300000,'AUTHORIZATION_NFCE_EMISSION_EXPIRED','expired'],[-301000,'AUTHORIZATION_NFCE_EMISSION_FUTURE','future'],[270000,'AUTHORIZATION_NFCE_EMISSION_WINDOW_TOO_SHORT','too_short']])await t.test(status+' stops before begin, custody or grant; preflight is read-only',async()=>{
   const c=await f.source('65'),request=await f.request(c),issued=Date.parse(authorizationRequestEmission(c.request).issuedAt),before=await journal(f),calls=counts(f);Date.now=()=>issued+age;
   try{const p=await f.preflight.preflight(query(c));assert.equal(p.can_run,false);assert.equal(p.emission_window.status,status);assert.ok(p.blockers.includes(code));assert.equal(Date.parse(p.emission_window.send_before),issued+270000);await assert.rejects(()=>f.compose(c).service.runReviewed({actor:c.input.actor,request}),e=>e.code===code);assert.deepEqual(await journal(f),before);assert.deepEqual(counts(f),calls);}
   finally{Date.now=realNow;}
  });
  await t.test('crossing the safety boundary while custody waits blocks use and transport',async()=>{
   const c=await f.source('65'),request=await f.request(c),issued=Date.parse(authorizationRequestEmission(c.request).issuedAt);let now=issued+260000;Date.now=()=>now;
   // This test isolates the Node clock fence. SQL still uses its own real clock;
   // projected lease expiry is moved with the virtual clock, consistently across
   // all reads. SQL080 has independent real PostgreSQL lock/wait coverage.
   const expires=new Date(now+60000).toISOString();let custody=0,transport=0,use=0;
   const x=f.compose(c,{rpc:async(n,a,o)=>{if(n.endsWith('_use'))use++;const out=structuredClone(await f.rpc(n,a,o));for(const key of['recovery','execution','current','grant'])if(out[key])out[key].expires_at=expires;return out;},withPreparedSession:async(_v,action)=>{custody++;now=issued+270000;return action(Object.freeze({}));},transport:async()=>{transport++;throw Error('MUST_NOT_TRANSMIT');}});
   try{const out=await x.service.runReviewed({actor:c.input.actor,request});assert.equal(custody,1,JSON.stringify(out));assert.equal(out.failure_code,'AUTHORIZATION_NFCE_EMISSION_WINDOW_TOO_SHORT');assert.equal(out.current.state,'failed_before_dispatch');assert.equal(out.current.grant_consumed,false);assert.equal(out.recovery_required,true);assert.equal(use,0);assert.equal(transport,0);const saved=await f.wire('command',{p_user_id:c.input.actor,p_command_id:request.command_id});assert.equal(saved.current.grant_consumed,false);assert.equal(saved.current.state,'failed_before_dispatch');}
   finally{Date.now=realNow;}
  });
  await t.test('a transport fence after consumption remains uncertain and never authorizes another submission',async()=>{
   const c=await f.source('65'),request=await f.request(c);let transports=0;const x=f.compose(c,{transport:async()=>{transports++;throw new NfceEmissionWindowError('AUTHORIZATION_NFCE_EMISSION_EXPIRED');}});
   const out=await x.service.runReviewed({actor:c.input.actor,request});assert.equal(out.status,'unconfirmed');assert.equal(out.failure_code,'AUTHORIZATION_NFCE_EMISSION_EXPIRED');assert.equal(out.current.grant_consumed,true);assert.equal(out.current.state,'submission_uncertain');assert.equal(out.recovery_required,true);assert.equal(transports,1);
   const before=counts(f);await x.service.command({actor:c.input.actor,commandId:request.command_id});const again=await x.service.runReviewed({actor:c.input.actor,request});assert.equal(again.status,'unconfirmed');assert.equal(transports,1);assert.deepEqual(counts(f),before);
  });
  for(const model of['55','65'])await t.test(model+' stored result remains readable after the emission window',async()=>{
   const c=await f.source(model),request=await f.request(c),x=f.compose(c);const out=await x.service.runReviewed({actor:c.input.actor,request});assert.equal(out.status,'authorized_homologation',JSON.stringify(out));const before=counts(f),never=()=>{throw Error('NO_NEW_AUTHORIZATION');};Date.now=()=>realNow()+400000;
   try{const history=createAuthorizationDispatchService({...x.ports,enabled:false,selectReview:never,readReview:never,withPreparedSession:never,transport:never});assert.equal((await history.command({actor:c.input.actor,commandId:request.command_id})).status,'authorized_homologation');assert.equal((await history.recover({actor:c.input.actor,commandId:request.command_id})).status,'authorized_homologation');assert.deepEqual(counts(f),before);}
   finally{Date.now=realNow;}
  });
 }finally{Date.now=realNow;await f.close();}
});
