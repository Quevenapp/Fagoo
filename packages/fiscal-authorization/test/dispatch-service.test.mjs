import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createSecureContext} from 'node:tls';
import {createAuthorizationDispatchTransport} from '../src/dispatch-transport.mjs';
import {wire} from '../../fiscal-reconciliation/test/protocol-wire.mjs';
import {dispatchFixture} from './dispatch-fixture.mjs';
import {createAuthorizationDispatchService} from '../src/dispatch-service.mjs';

let f;test.before(async()=>{f=await dispatchFixture();});test.after(async()=>{await f?.close();});
const denial=code=>Object.assign(new Error(code),{code});
const counts=()=>({use:f.events.filter(x=>x.endsWith('_use')).length,post:f.events.filter(x=>x==='POST').length,vault:f.events.filter(x=>x==='vault-read').length});
test('default is closed before RPC; exact SQL069/HTTP→AEAD041→mTLS context→XSD journal→homologation for55/65',async()=>{
 for(const model of ['55','65']){
  const c=await f.source(model),x=f.compose(c),before=counts();
  const {enabled,...closed}=x.ports;assert.throws(()=>createAuthorizationDispatchService(closed).run(c.input),/AUTHORIZATION_SERVICE_DISABLED/);
  assert.throws(()=>createAuthorizationDispatchService({...x.ports,enabled:false}).run(c.input),/AUTHORIZATION_SERVICE_DISABLED/);
  assert.deepEqual(counts(),before);
  const out=await x.service.run(c.input);assert.equal(out.status,'authorized_homologation',JSON.stringify(out));
  assert.equal(out.tax_rules_validated,false);assert.equal(out.authorized_in_homologation,true);assert.equal(out.can_emit,false);assert.equal(out.can_transmit,false);assert.equal(out.production_authorized,false);
  assert.equal(out.artifact.tls_origin_verified,true);assert.ok(out.artifact.processed_hash);assert.equal(counts().use-before.use,1);assert.equal(counts().post-before.post,1);
  assert.equal(f.envelope.context.purpose,'offline-homologation');assert.ok(f.owned.every(b=>b.every(x=>x===0)));
  const n=counts(),replay=await x.service.run(c.input);assert.equal(replay.status,'authorized_homologation');assert.equal(replay.recovered,true);assert.deepEqual(counts(),n);
  const history=await x.service.history({actor:c.input.actor,candidateId:c.input.candidateId,limit:25,before:null});assert.equal(history.items[0].status,'authorized_homologation');
  assert.equal(history.items[0].read_only,true);assert.equal(JSON.stringify(out).includes('lease_id'),false);
 }
});
test('lost use ACK consumes exactly once with zero socket; run replay and recover never open the cofre again',async()=>{
 const c=await f.source(),before=counts();let lost=false;const x=f.compose(c,{rpc:async(n,a,o)=>{f.events.push(n);const v=await f.rpc(n,a,o);if(n.endsWith('_use')&&!lost){lost=true;throw Error('PRIVATE_LOST_ACK');}return v;}});
 const out=await x.service.run(c.input);assert.equal(out.status,'unconfirmed');assert.equal(counts().use-before.use,1);assert.equal(counts().post-before.post,0);
 const n=counts();await x.service.run(c.input);await x.service.recover({actor:c.input.actor,commandId:c.input.commandId});assert.deepEqual(counts(),n);
});
test('revision changed immediately before use blocks the SQL grant without another request',async()=>{
 const c=await f.source(),before=counts();let revised=false;
 const x=f.compose(c,{rpc:async(n,a,o)=>{f.events.push(n);if(n.endsWith('_use')&&!revised){revised=true;await f.review(c,{p_command_id:randomUUID(),p_expected_review_version:1});}return f.rpc(n,a,o);}});
 const out=await x.service.run(c.input);assert.equal(out.status,'unconfirmed');assert.equal(out.failure_code,'40001');assert.equal(counts().post,before.post);
 const command=await f.wire('command',{p_user_id:c.input.actor,p_command_id:c.input.commandId});assert.equal(command.current.grant_consumed,false);
 await x.service.run(c.input);assert.equal(counts().post,before.post);
});
test('abort after confirmed consume cannot dispatch or obtain a replacement grant',async()=>{
 const c=await f.source(),before=counts(),abort=new AbortController();const x=f.compose(c,{rpc:async(n,a,o)=>{f.events.push(n);const v=await f.rpc(n,a,o);if(n.endsWith('_use'))abort.abort();return v;}});
 const out=await x.service.run(c.input,{signal:abort.signal});assert.equal(out.status,'unconfirmed');assert.equal(counts().use-before.use,1);assert.equal(counts().post,before.post);
 const n=counts();await x.service.run(c.input);assert.deepEqual(counts(),n);
});
test('callback retained during catch cannot consume after custody returned; no current-private reads on42501',async()=>{
 const c=await f.source(),before=counts();let callback,offered=false;
 const x=f.compose(c,{withPreparedSession:async(_v,action)=>{callback=action;},rpc:async(n,a,o)=>{
  f.events.push(n);if(callback&&n.endsWith('_command')&&!offered){offered=true;await assert.rejects(callback({}),/AUTHORIZATION_CALLBACK_INVALID/);}return f.rpc(n,a,o);
 }});
 const result=await x.service.run(c.input);assert.equal(result.status,'failed_before_dispatch');assert.equal(counts().use,before.use);assert.equal(counts().post,before.post);assert.equal(offered,true);
 const c2=await f.source();let denied=false,readsAtDenial;
 const y=f.compose(c2,{rpc:async(n,a,o)=>{f.events.push(n);if(denied){readsAtDenial=f.calls.read.length;throw denial('42501');}const v=await f.rpc(n,a,o);if(n.endsWith('_finish'))denied=true;return v;}});
 const noAccess=await y.service.run(c2.input);assert.equal(noAccess.status,'unconfirmed');assert.equal(noAccess.failure_code,'42501');assert.equal(noAccess.artifact,null);assert.equal(noAccess.receipt,null);assert.equal(f.calls.read.length,readsAtDenial);
});
test('callback already awaiting use is fenced when custody returns early; duplicated callbacks cannot consume twice',async()=>{
 const c=await f.source(),before=counts();let entered,release,held;
 const waiting=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});let closed=false;
 const x=f.compose(c,{withPreparedSession:async(_v,action)=>{held=action({});held.catch(()=>{});await waiting;closed=true;},rpc:async(n,a,o)=>{
  f.events.push(n);if(n.endsWith('_use')){entered();await gate;}if(closed&&n.endsWith('_command'))release();return f.rpc(n,a,o);
 }});
 const out=await x.service.run(c.input);await assert.rejects(held);assert.equal(out.status,'failed_before_dispatch');assert.equal(counts().post,before.post);
 const saved=await f.wire('command',{p_user_id:c.input.actor,p_command_id:c.input.commandId});assert.equal(saved.current.grant_consumed,false);
 const c2=await f.source();let y;const start=counts();y=f.compose(c2,{withPreparedSession:(v,action,o)=>y.custody(v,async session=>{await action(session);await assert.rejects(action(session),/AUTHORIZATION_CALLBACK_INVALID/);},o)});
 const second=await y.service.run(c2.input);assert.equal(second.status,'unconfirmed');assert.equal(counts().use-start.use,1);assert.equal(counts().post-start.post,1);
 const recovered=await y.service.recover({actor:c2.input.actor,commandId:c2.input.commandId});assert.equal(recovered.status,'authorized_homologation');assert.equal(counts().use-start.use,1);assert.equal(counts().post-start.post,1);
});
test('missing or altered sidecar blocks recovery without custody, review or new transport',async()=>{
 for(const mode of ['missing','corrupt']){
  const c=await f.source(),x=f.compose(c,{validate:(v,o)=>{if(v.kind==='response')throw Error('SYNTHETIC_DOWN');return f.ports.validate(v,o);}});
  assert.equal((await x.service.run(c.input)).status,'unconfirmed');const v=await f.wire('command',{p_user_id:c.input.actor,p_command_id:c.input.commandId});
  const key=`authorization/${v.recovery.attempt_id}/observations/${v.recovery.request_hash}.json`,bytes=f.files.get(key);
  if(mode==='missing')f.files.delete(key);else f.files.set(key,Buffer.from(bytes.toString().replace(v.rule_review.review_hash,'0'.repeat(64))));
  const n=counts(),never=()=>{throw Error('NO_NEW_OPERATION');};
  const out=await createAuthorizationDispatchService({...x.ports,enabled:false,validate:f.ports.validate,readReview:never,withPreparedSession:never,transport:never}).recover({actor:c.input.actor,commandId:c.input.commandId});
  assert.equal(out.status,'unconfirmed');assert.equal(out.artifact,null);assert.deepEqual(counts(),n);f.files.set(key,bytes);
 }
});
test('lost finish and command ACK recover the permanent receipt without a second POST',async()=>{
 const c=await f.source();let fail=false;const x=f.compose(c,{rpc:async(n,a,o)=>{f.events.push(n);if(fail&&n.endsWith('_command'))throw Error('PRIVATE_NETWORK');const v=await f.rpc(n,a,o);if(n.endsWith('_finish')){fail=true;throw Error('PRIVATE_LOST_ACK');}return v;}});
 const out=await x.service.run(c.input);assert.equal(out.status,'unconfirmed');const n=counts(),never=()=>{throw Error('NO_NEW_OPERATION');};
 const recovered=await createAuthorizationDispatchService({...x.ports,rpc:f.rpc,enabled:false,readReview:never,withPreparedSession:never,transport:never}).recover({actor:c.input.actor,commandId:c.input.commandId});
 assert.equal(recovered.status,'authorized_homologation');assert.deepEqual(counts(),n);
});
test('103 is a stored receipt only; protocol rejection never promotes authorization or re-submits',async()=>{
 for(const options of [{batch:'103',protocol:false,receipt:true},{status:'302'},{status:'217'}]){
  const c=await f.source(),x=f.compose(c,{responseOptions:options}),out=await x.service.run(c.input);
  assert.equal(out.status,options.batch==='103'?'receipt_pending':options.status==='217'?'review_required':'rejected',JSON.stringify(out));assert.equal(out.authorized_in_homologation,false);assert.equal(out.artifact.processed_hash,null);
  const n=counts();await x.service.recover({actor:c.input.actor,commandId:c.input.commandId});assert.deepEqual(counts(),n);
 }
});
test('transport rejects substituted grants, review, request, trust and client certificate before opening a socket',async()=>{
 const c=await f.source(),x=f.compose(c,{transport:async(v,session,o)=>{
  const changes=[x=>x.grant.origin='synthetic',x=>x.grant.purpose='sefaz-sp-wsdl-readonly-v1',x=>x.grant.request_hash='0'.repeat(64),x=>x.grant.model='65',x=>x.rule_review.signed_hash='0'.repeat(64),x=>x.request={...x.request}];
  for(const edit of changes){const input={...v,grant:{...v.grant},rule_review:{...v.rule_review}};edit(input);const driver=wire();await assert.rejects(createAuthorizationDispatchTransport({requestImpl:driver.requestImpl})(input,session,o));assert.equal(driver.trace.requests,0);}
  for(const variant of [{...session,secureContext:createSecureContext()},{...session,metadata:{...session.metadata,fingerprint_sha256:'0'.repeat(64)}}]){const driver=wire();await assert.rejects(createAuthorizationDispatchTransport({requestImpl:driver.requestImpl})(v,variant,o));assert.equal(driver.trace.requests,0);}
  const driver=wire({body:f.soapResponse(c,v.grant.batch_id)}),send=createAuthorizationDispatchTransport({requestImpl:driver.requestImpl});
  const response=await send(v,session,o);await assert.rejects(send(v,session,o),/AUTHORIZATION_GRANT_MISMATCH/);assert.equal(driver.trace.requests,1);return response;
 }});assert.equal((await x.service.run(c.input)).status,'authorized_homologation');
});
test('transport closes partial/redirect/compressed/empty replies and consumes its local nonce on timeout',async()=>{
 const c=await f.source(),x=f.compose(c,{transport:async(v,session,o)=>{
  for(const change of [{status:302},{encoding:'gzip'},{partial:true},{earlyResponse:true},{body:Buffer.alloc(0)},{type:'text/html'}]){
   const driver=wire(change);await assert.rejects(createAuthorizationDispatchTransport({requestImpl:driver.requestImpl})(v,session,o),/AUTHORIZATION_TRANSPORT_INVALID/);assert.ok(driver.trace.destroyed>=1);
  }
  const driver=wire({noTls:true}),send=createAuthorizationDispatchTransport({requestImpl:driver.requestImpl}),abort=new AbortController(),pending=send(v,session,{signal:abort.signal,deadline:o.deadline});setImmediate(()=>abort.abort());
  await assert.rejects(pending,/AUTHORIZATION_SERVICE_ABORTED/);assert.equal(driver.trace.ends,0);assert.ok(driver.trace.destroyed>=2);await assert.rejects(send(v,session,o),/AUTHORIZATION_GRANT_MISMATCH/);assert.equal(driver.trace.requests,1);
  throw Error('SYNTHETIC_TIMEOUT_WITHOUT_RESPONSE');
 }});assert.equal((await x.service.run(c.input)).status,'unconfirmed');
});
test('wrong envelope bytes, hash and rejected preparation prevent any PFX opening or grant',async()=>{
 for(const mode of ['bytes','authorization']){
  const c=await f.source(),before=counts(),at=f.events.length,bytes=Buffer.from('PRIVATE_CIPHERTEXT_SENTINEL');
  const x=f.compose(c,mode==='bytes'?{readObject:async()=>bytes}:{authorize:async()=>{throw denial('42501');}});
  const out=await x.service.run(c.input);assert.notEqual(out.status,'authorized_homologation');assert.equal(counts().use,before.use);assert.equal(counts().post,before.post);
  assert.equal(f.events.slice(at).includes('pkcs12'),false);assert.equal(JSON.stringify(out).includes('PRIVATE_CIPHERTEXT_SENTINEL'),false);if(mode==='bytes')assert.ok(bytes.every(x=>x===0));
 }
});
test('raw Fault and malformed XML remain in the immutable journal without a processed artifact',async()=>{
 for(const [status,body]of [[500,Buffer.from('<Envelope xmlns="http://www.w3.org/2003/05/soap-envelope"><Body><Fault><Code><Value>Sender</Value></Code><Reason><Text xml:lang="pt">PRIVATE_TEST_FAULT</Text></Reason></Fault></Body></Envelope>')],[200,Buffer.from('<broken>PRIVATE_TEST_XML')]]){
  const c=await f.source(),x=f.compose(c,{transport:(v,session,o)=>createAuthorizationDispatchTransport({requestImpl:wire({status,body}).requestImpl})(v,session,o)}),out=await x.service.run(c.input);
  assert.equal(out.status,'review_required');assert.equal(out.authorized_in_homologation,false);assert.equal(out.artifact.outcome,'invalid_response');assert.equal(out.artifact.processed_hash,null);assert.equal(JSON.stringify(out).includes('PRIVATE_TEST'),false);
  const v=await f.wire('command',{p_user_id:c.input.actor,p_command_id:c.input.commandId});assert.deepEqual(f.files.get(`authorization/${v.recovery.attempt_id}/responses/${v.recovery.request_hash}.xml`),body);
 }
});
test('run captures all caller fields before await and corrupted signed bytes fail before custody',async()=>{
 const c=await f.source(),x=f.compose(c),input={...c.input},original=input.commandId,pending=x.service.run(input);input.commandId=randomUUID();input.expectedA1Version=999;input.signedHash='0'.repeat(64);
 const out=await pending;assert.equal(out.status,'authorized_homologation');assert.equal(out.command_id,original);
 const other=await f.source(),key=`candidates/${other.input.candidateId}/${other.input.signedHash}.xml`,before=counts(),bytes=f.files.get(key);f.files.set(key,Buffer.from('PRIVATE_CORRUPTION'));
 const bad=await f.compose(other).service.run(other.input);assert.equal(bad.status,'failed_before_dispatch');assert.deepEqual(counts(),before);f.files.set(key,bytes);
});
test('journal recovery ignores current A1/policy/review and performs no second dispatch',async()=>{
 const c=await f.source(),before=counts(),x=f.compose(c,{validate:(v,o)=>{if(v.kind==='response')throw Error('PRIVATE_VALIDATOR_DOWN');return f.ports.validate(v,o);}});
 const out=await x.service.run(c.input);assert.equal(out.status,'unconfirmed');assert.equal(counts().post-before.post,1);
 const saved=await f.callSql('erp_fiscal_subset_review_get',c.getArgs);
 await f.review(c,{p_command_id:randomUUID(),p_expected_review_version:saved.receipt.review_version});
 await f.enable('operational',false);await f.age(c.input.commandId);await f.disable();
 const never=()=>{throw Error('NO_CURRENT_RESOURCE_ON_RECOVERY');};const n=counts();
 const recovered=await createAuthorizationDispatchService({...x.ports,enabled:false,readReview:never,withPreparedSession:never,transport:never,validate:f.ports.validate}).recover({actor:c.input.actor,commandId:c.input.commandId});
 assert.equal(recovered.status,'authorized_homologation',JSON.stringify(recovered));assert.equal(recovered.recovered,false);assert.deepEqual(counts(),n);
 // Keep subsequent fixture candidates on the same configured credential/version.
});
