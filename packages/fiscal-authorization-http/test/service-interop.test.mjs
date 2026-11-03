// SQL064, renderer/signature and Python XSD are local synthetic fixtures. No sockets.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {serviceFixture} from '../../fiscal-authorization/test/service-sql-fixture.mjs';
import {createAuthorizationHttpBoundary} from '../src/handler.mjs';
import {request} from './fixtures.mjs';
let f;before(async()=>{f=await serviceFixture();});after(async()=>{await f?.close();});
const counts=()=>({use:f.calls.rpc.filter(x=>x.name==='erp_fiscal_authorization_use').length,custody:f.calls.custody.length,transport:f.calls.transport.length});
async function json(h,path,body,actor){const response=await h(request(path,body),{actor});const out=await response.json();assert.equal(response.status,200,JSON.stringify(out));return out;}
function noPrivate(value){assert.doesNotMatch(JSON.stringify(value),/"(?:execution|recovery|credential_id|envelope_hash|certificate_fingerprint|access_key|issuer_cnpj|lease_id|nonce|request_hash|request_size|evidence|key|bucket|xml)"/);}

test('actual064 NF55/NFC65 previews stay unavailable; HTTP run never invokes even the enabled synthetic service',async()=>{
 for(const model of ['55','65']){
  const {input}=await f.source(model),service=f.service({enabled:false}),h=createAuthorizationHttpBoundary({service});const p=await json(h,'/preview',{candidate_id:input.candidateId,signed_hash:input.signedHash},input.actor);
  assert.equal(p.model,model);assert.equal(p.can_prepare,false);assert.equal(p.service_enabled,false);assert.equal(p.signature_checked,true);assert.equal(p.operational_binding_available,false);noPrivate(p);
  const start=f.calls.rpc.length,guard=createAuthorizationHttpBoundary({service:f.service()});const response=await guard(request('/run',{command_id:input.commandId,candidate_id:input.candidateId,signed_hash:input.signedHash,expected_identity_version:input.expectedIdentityVersion,expected_a1_version:input.expectedA1Version,expected_policy_version:input.expectedPolicyVersion,confirmed:true}),{actor:input.actor});
  assert.equal(response.status,503);assert.equal((await response.json()).recovery_required,false);assert.equal(f.calls.rpc.length,start);
  // The fixture itself prepares a synthetic historical receipt, outside the HTTP boundary.
  const stored=await f.service().run(input);assert.equal(stored.status,'authorization_observed');const snapshot=counts();
  const read=await json(h,'/commands/'+input.commandId,undefined,input.actor);assert.equal(read.status,'authorization_observed');assert.equal(read.receipt.model,model);assert.equal(read.receipt.origin,'synthetic');assert.equal(read.recoverable_by_actor,false);noPrivate(read);
  const page=await json(h,'/candidates/'+input.candidateId+'/history',{limit:25,before:null},input.actor);assert.equal(page.items.length,1);assert.equal(page.items[0].command_id,input.commandId);assert.equal(typeof page.items[0].receipt.ordinal,'string');noPrivate(page);
  const recovered=await json(h,'/recover',{command_id:input.commandId},input.actor);assert.equal(recovered.status,'authorization_observed');assert.equal(recovered.recovered,true);assert.equal(recovered.can_emit,false);assert.equal(recovered.can_transmit,false);noPrivate(recovered);assert.deepEqual(counts(),snapshot);
 }
});

test('lost use ACK stays uncertain through explicit HTTP recovery and cannot consume or transport again',async()=>{
 const {input}=await f.source();let lose=true;const source=f.service({rpc:async(n,a,o)=>{const v=await f.ports.rpc(n,a,o);if(n==='erp_fiscal_authorization_use'&&lose){lose=false;throw Error('SYNTHETIC_LOST_ACK');}return v;}});
 const uncertain=await source.run(input);assert.equal(uncertain.status,'unconfirmed');const snapshot=counts(),h=createAuthorizationHttpBoundary({service:f.service({enabled:false,withPreparedSession:()=>assert.fail('no custody'),transport:()=>assert.fail('no transport')})});
 const recovered=await json(h,'/recover',{command_id:input.commandId},input.actor);assert.equal(recovered.status,'unconfirmed');assert.equal(recovered.recovery_required,true);assert.equal(recovered.recoverable_by_actor,true);assert.equal(recovered.receipt.command_id,input.commandId);assert.equal(recovered.artifact,null);noPrivate(recovered);assert.deepEqual(counts(),snapshot);
 const command=await json(h,'/commands/'+input.commandId,undefined,input.actor);assert.equal(command.current.grant_consumed,true);assert.equal(command.current.recovery_required,true);assert.deepEqual(counts(),snapshot);
});

test('HTTP recovery finishes saved bytes after A1/policy/lease changes with historical versions, no new preparation or transport',async()=>{
 const {input}=await f.source('65');let outage=true;const source=f.service({validate:async(v,o)=>{if(outage&&v.kind==='response')throw Error('SYNTHETIC_VALIDATOR_OUTAGE');return f.ports.validate(v,o);}});
 const pending=await source.run(input);assert.equal(pending.status,'unconfirmed');const snapshot=counts();await f.age(input.commandId);await f.disable();await f.install(3);outage=false;
 const h=createAuthorizationHttpBoundary({service:f.service({enabled:false,withPreparedSession:()=>assert.fail('no custody'),transport:()=>assert.fail('no transport')})});
 const out=await json(h,'/recover',{command_id:input.commandId},input.actor);assert.equal(out.status,'authorization_observed');assert.equal(out.receipt.a1_version,2);assert.equal(out.current.a1_changed,true);assert.equal(out.current.policy_changed,true);assert.equal(out.current.lease_expired,true);assert.equal(out.current.candidate.artifact_current,false);assert.deepEqual(counts(),snapshot);noPrivate(out);
 const failed=await h(request('/commands/'+input.commandId),{actor:f.users.admin});assert.equal(failed.status,403);assert.equal((await failed.json()).recovery_required,false);assert.deepEqual(counts(),snapshot);
});
