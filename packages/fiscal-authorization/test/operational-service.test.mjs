import test from 'node:test';
import assert from 'node:assert/strict';
import {AuthorizationServiceError} from '../src/service-common.mjs';
import {operationalFixture,hash} from './operational-fixtures.mjs';
const count=(f,name)=>f.calls.ledger.filter(x=>x.action===name).length;
const invoke=async(options,fn)=>{const f=await operationalFixture(options);try{await fn(f);}finally{f.close();}};
test('55 and 65/250 items compose reviewed SOAP, real XSD, backend review and one consumed local dispatch',async()=>{
 for(const [model,items]of[['55',1],['65',250]])await invoke({model,count:items},async f=>{
  const got=await f.service().run(f.input);assert.equal(got.status,'authorization_observed',JSON.stringify(got));assert.equal(got.artifact.protocol_cstat,'100');assert.equal(got.artifact.tls_origin_verified,false);assert.equal(got.sefaz_authorized,false);assert.equal(got.tax_rules_validated,false);assert.equal(got.can_transmit,false);assert.equal(got.subset_review.coverage,'listed_rules_only_not_full_tax_validation');
  assert.equal(f.state.used,1);assert.equal(f.calls.transport.length,1);assert.equal(f.calls.custody.length,1);assert.deepEqual(f.calls.validate,['request','response','processed']);assert.equal(f.calls.review.length,2);assert.equal(count(f,'prepare'),1);assert.ok(got.observation.sha256);
  const again=await f.service().run(f.input);assert.equal(again.status,got.status);assert.equal(again.recovered,true);assert.equal(f.state.used,1);assert.equal(f.calls.transport.length,1);
  const history=await f.service().history({actor:f.input.actor,candidateId:f.input.candidateId,limit:25,before:null});assert.equal(history.items[0].subset_review.review_hash,got.subset_review.review_hash);assert.ok(!JSON.stringify(history).includes('credential_id'));
 });
});
test('default gate prevents all ledger/Storage/review/custody calls; missing review cannot consume',async()=>invoke({},async f=>{
 assert.throws(()=>f.service({syntheticDispatchEnabled:false}).run(f.input),{code:'AUTHORIZATION_SERVICE_DISABLED'});assert.equal(f.calls.ledger.length,0);
 f.state.reviewMissing=true;const result=await f.service().run(f.input);assert.equal(result.status,'failed_before_dispatch');assert.equal(f.state.used,0);assert.equal(f.calls.transport.length,0);assert.equal(f.calls.custody.length,0);
}));
test('review change after preparation or at atomic use fails before any POST',async()=>{
 for(const at of ['reread','use'])await invoke({},async f=>{
  if(at==='reread'){let n=0;const original=f.ports.readReview;f.ports.readReview=(...args)=>{if(++n===2)f.state.reviewVersion++;return original(...args);};}
  else f.state.beforeUse=()=>{f.state.reviewVersion++;};
  await f.service().run(f.input);assert.equal(f.state.used,0);assert.equal(f.calls.transport.length,0);
 });
});
test('lost use ACK records consumption but never constructs a transport or repeats use on recovery/run',async()=>invoke({},async f=>{
 const original=f.ports.ledger;f.ports.ledger=async(action,...args)=>{const v=await original(action,...args);if(action==='use')throw Error('PRIVATE LOST ACK');return v;};
 const service=f.service(),got=await service.run(f.input);assert.equal(got.status,'unconfirmed');assert.equal(f.state.used,1);assert.equal(f.calls.transport.length,0);
 await service.recover({actor:f.input.actor,commandId:f.input.commandId});await service.run(f.input);assert.equal(count(f,'use'),1);assert.equal(f.calls.custody.length,1);assert.equal(f.calls.transport.length,0);
}));
test('durable response recovers with changed A1/policy/review and closed gate; no custody, review, begin or transport',async()=>invoke({},async f=>{
 const original=f.ports.validate;let fail=true;f.ports.validate=async(v,o)=>{if(fail&&v.kind==='response')throw Error('PRIVATE VALIDATOR');return original(v,o);};
 const first=await f.service().run(f.input);assert.equal(first.status,'unconfirmed');assert.equal(f.state.used,1);assert.equal(f.calls.transport.length,1);
 const at={review:f.calls.review.length,custody:f.calls.custody.length,begin:count(f,'begin'),use:count(f,'use'),transport:f.calls.transport.length};
 fail=false;f.state.current=false;f.state.reviewMissing=true;f.state.reviewVersion=99;Object.assign(f.state.known.current,{a1_changed:true,policy_changed:true,policy_enabled:false});
 const got=await f.service({syntheticDispatchEnabled:false}).recover({actor:f.input.actor,commandId:f.input.commandId});assert.equal(got.status,'authorization_observed',JSON.stringify(got));assert.deepEqual({review:f.calls.review.length,custody:f.calls.custody.length,begin:count(f,'begin'),use:count(f,'use'),transport:f.calls.transport.length},at);
 f.state.acl=false;await assert.rejects(f.service().recover({actor:f.input.actor,commandId:f.input.commandId}),{code:'42501'});
}));
test('finish ACK lost and command unavailable retain same attempt; subsequent command recovers without POST',async()=>invoke({},async f=>{
 const original=f.ports.ledger;let lost=false;f.ports.ledger=async(action,...args)=>{if(lost&&action==='command')throw Error('unavailable');const v=await original(action,...args);if(action==='finish'){lost=true;throw Error('lost finish');}return v;};
 const service=f.service(),got=await service.run(f.input);assert.equal(got.status,'unconfirmed');assert.equal(f.state.known.current.state,'authorization_observed');lost=false;
 const recovered=await service.recover({actor:f.input.actor,commandId:f.input.commandId});assert.equal(recovered.status,'authorization_observed');assert.equal(count(f,'use'),1);assert.equal(f.calls.transport.length,1);
}));
test('known finish ACK remains stored if final command GET fails, after exact response/sidecar readback',async()=>invoke({},async f=>{
 const original=f.ports.ledger;let finished=false;f.ports.ledger=async(action,...args)=>{if(finished&&action==='command')throw Error('unavailable');const v=await original(action,...args);if(action==='finish')finished=true;return v;};
 const got=await f.service().run(f.input);assert.equal(got.status,'authorization_observed');assert.equal(got.recovered,true);assert.equal(got.recovery_required,false);assert.equal(f.calls.transport.length,1);
}));
test('stored sidecar hash tamper blocks readback claim and never repeats transport',async()=>invoke({},async f=>{
 const service=f.service(),got=await service.run(f.input);assert.equal(got.status,'authorization_observed');const key=[...f.files.keys()].find(x=>x.includes('/observations/')),raw=JSON.parse(f.files.get(key));raw.server_trust_anchor_sha256='f'.repeat(64);f.files.set(key,Buffer.from(JSON.stringify(raw)));
 const recover=await service.recover({actor:f.input.actor,commandId:f.input.commandId});assert.equal(recover.status,'unconfirmed');assert.equal(recover.artifact,null);assert.equal(f.calls.transport.length,1);assert.equal(count(f,'use'),1);
}));
test('103/rejection/217 preserve separate states and never turn consultation absence into resend permission',async()=>{
 for(const [options,status]of[[{batch:'103',protocol:false,receipt:true},'receipt_pending'],[{status:'539'},'review_required'],[{status:'204'},'review_required'],[{status:'217'},'review_required'],[{status:'301'},'rejected'],[{status:'150'},'authorization_observed']])await invoke({},async f=>{f.state.responseOptions=options;const service=f.service(),got=await service.run(f.input);assert.equal(got.status,status,JSON.stringify(got));assert.equal(got.retry_submission_allowed,false);await service.run(f.input);assert.equal(f.calls.transport.length,1);});
});
test('callbacks duplicate even if custody swallows exception cannot cause second use/dispatch',async()=>invoke({},async f=>{
 const original=f.ports.withPreparedSession;f.ports.withPreparedSession=async(v,action,o)=>{await original(v,async s=>{await action(s);try{await action(s);}catch{}},o);};
 const got=await f.service().run(f.input);assert.equal(got.status,'unconfirmed');assert.equal(count(f,'use'),1);assert.equal(f.calls.transport.length,1);assert.equal(count(f,'finish'),0);
}));
test('run input and mutable backend proof are captured; accessor input is rejected without invocation',async()=>invoke({},async f=>{
 let getter=0;const bad={...f.input};Object.defineProperty(bad,'candidateId',{enumerable:true,get(){getter++;return f.input.candidateId;}});assert.throws(()=>f.service().run(bad));assert.equal(getter,0);
 const input={...f.input},pending=f.service().run(input);input.signedHash='a'.repeat(64);input.expectedPolicyVersion=999;const got=await pending;assert.equal(got.status,'authorization_observed');assert.equal(got.receipt.signed_hash,f.input.signedHash);
}));
test('abort or deadline immediately after consumption cannot dispatch/finalize or renew the grant',async()=>{
 for(const mode of ['abort','deadline'])await invoke({},async f=>{
  const ac=new AbortController(),original=f.ports.ledger,clock=Date.now;f.ports.ledger=async(action,args,o)=>{const v=await original(action,args,o);if(action==='use'){if(mode==='abort')ac.abort();else Date.now=()=>o.deadline+1;}return v;};
  try{const result=await f.service().run(f.input,{signal:ac.signal});assert.equal(result.status,'unconfirmed');assert.equal(f.state.used,1);assert.equal(f.calls.transport.length,0);assert.equal(count(f,'finish'),0);}finally{Date.now=clock;f.ports.ledger=original;}
  await f.service().run(f.input);assert.equal(count(f,'use'),1);assert.equal(f.calls.transport.length,0);assert.equal(f.calls.custody.length,1);
 });
});
test('late custody callback after its port prematurely returns cannot obtain a grant',async()=>invoke({},async f=>{
 let late;const original=f.ports.withPreparedSession;f.ports.withPreparedSession=async(v,action,o)=>{await original(v,async session=>{late=()=>action(session);},o);};
 const got=await f.service().run(f.input);assert.equal(got.status,'failed_before_dispatch');await assert.rejects(late());assert.equal(f.state.used,0);assert.equal(f.calls.transport.length,0);
}));
test('missing journal after consumed response is recoverable only by existing durable bytes, never new dispatch',async()=>invoke({},async f=>{
 const validate=f.ports.validate;f.ports.validate=(v,o)=>{if(v.kind==='response')throw Error('validator offline');return validate(v,o);};
 await f.service().run(f.input);const key=[...f.files.keys()].find(x=>x.includes('/observations/')),saved=f.files.get(key);f.files.delete(key);f.ports.validate=validate;
 const recover=await f.service().recover({actor:f.input.actor,commandId:f.input.commandId});assert.equal(recover.status,'unconfirmed');assert.equal(count(f,'finish'),0);assert.equal(f.calls.transport.length,1);
 f.files.set(key,saved);assert.equal((await f.service().recover({actor:f.input.actor,commandId:f.input.commandId})).status,'authorization_observed');assert.equal(count(f,'use'),1);assert.equal(f.calls.custody.length,1);
}));
test('request Storage readback failure prevents preparation/use, and operational-origin records are refused',async()=>{
 await invoke({},async f=>{const read=f.ports.storage.read;f.ports.storage={...f.ports.storage,read:v=>v.key.includes('/requests/')?null:read(v)};await f.service().run(f.input);assert.equal(count(f,'prepare'),0);assert.equal(count(f,'use'),0);assert.equal(f.calls.transport.length,0);});
 await invoke({},async f=>{const ledger=f.ports.ledger;f.ports.ledger=async(...args)=>{const v=await ledger(...args);if(v.view?.receipt){v.view.receipt.origin='operational';v.view.recovery.origin='operational';if(v.view.execution)v.view.execution.origin='operational';}return v;};const got=await f.service().run(f.input);assert.equal(got.status,'unconfirmed');assert.equal(count(f,'prepare'),0);assert.equal(count(f,'use'),0);assert.equal(f.calls.transport.length,0);});
});
test('late callback during command catch cannot consume a closed TLS scope',async()=>invoke({},async f=>{
 let late,invoked=false,callbackCode;const custody=f.ports.withPreparedSession,ledger=f.ports.ledger;
 f.ports.withPreparedSession=(v,action,o)=>custody(v,async session=>{late=()=>action(session);},o);
 f.ports.ledger=async(action,args,o)=>{if(action==='command'&&late&&!invoked){invoked=true;try{await late();}catch(e){callbackCode=e.code;}}return ledger(action,args,o);};
 const got=await f.service().run(f.input);assert.equal(invoked,true);assert.equal(callbackCode,'AUTHORIZATION_CALLBACK_INVALID');assert.equal(got.status,'failed_before_dispatch');assert.equal(f.state.used,0);assert.equal(count(f,'use'),0);assert.equal(f.calls.transport.length,0);
}));
test('explicit access denial after finish ACK does not fall back to private Storage or disclose the receipt',async()=>invoke({},async f=>{
 const ledger=f.ports.ledger;let readsAtFinish,commandsAtFinish;f.ports.ledger=async(action,...args)=>{const v=await ledger(action,...args);if(action==='finish'){f.state.acl=false;readsAtFinish=f.calls.read.length;commandsAtFinish=count(f,'command');}return v;};
 const got=await f.service().run(f.input);assert.equal(got.status,'unconfirmed');assert.equal(got.failure_code,'42501');assert.equal(got.command_id,f.input.commandId);assert.equal(got.receipt,null);assert.equal(got.current,null);assert.equal(got.artifact,null);assert.equal(got.recovery_required,true);assert.equal(f.calls.read.length,readsAtFinish);assert.equal(count(f,'command'),commandsAtFinish+1);
 f.state.acl=true;const recovered=await f.service({syntheticDispatchEnabled:false}).recover({actor:f.input.actor,commandId:f.input.commandId});assert.equal(recovered.status,'authorization_observed');assert.equal(f.calls.transport.length,1);assert.equal(count(f,'use'),1);
}));
test('use proof mismatch after consumed ACK cannot dispatch; history cannot promote an operational origin',async()=>invoke({},async f=>{
 const ledger=f.ports.ledger;f.ports.ledger=async(action,...args)=>{const v=await ledger(action,...args);if(action==='use')v.rule_review.review_hash='f'.repeat(64);if(action==='history')v.page.items[0].receipt.origin='operational';return v;};
 const got=await f.service().run(f.input);assert.equal(got.status,'unconfirmed');assert.equal(f.state.used,1);assert.equal(f.calls.transport.length,0);assert.equal(count(f,'use'),1);
 await assert.rejects(f.service().history({actor:f.input.actor,candidateId:f.input.candidateId,limit:25,before:null}),{code:'AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE'});
}));
test('Fault bytes are immutable evidence and classified without promoting protocol authority',async()=>invoke({},async f=>{
 const original=f.ports.transport;f.ports.transport=async(...args)=>{const result=await original(...args);await result.response.body.cancel();return{...result,response:new Response('<Envelope xmlns="http://www.w3.org/2003/05/soap-envelope"><Body><Fault><Code>SYNTHETIC</Code></Fault></Body></Envelope>',{status:500,headers:{'content-type':'application/soap+xml; charset=utf-8'}})};};
 const got=await f.service().run(f.input);assert.equal(got.status,'review_required');assert.equal(got.artifact.rejection_code,'SOAP_FAULT');assert.equal(got.artifact.processed_hash,null);assert.equal(got.sefaz_authorized,false);assert.equal(f.calls.transport.length,1);assert.ok([...f.files.keys()].some(x=>x.includes('/responses/')));
}));
test('custody returning while use ACK is pending closes admission before any transport continuation',async()=>invoke({},async f=>{
 let release,enter;const entered=new Promise(r=>enter=r),hold=new Promise(r=>release=r),ledger=f.ports.ledger,custody=f.ports.withPreparedSession;let actionDone,dispatch=0;
 f.ports.ledger=async(action,args,o)=>{if(action==='command'&&f.state.used===1)release();const v=await ledger(action,args,o);if(action==='use'){enter();await hold;}return v;};
 f.ports.withPreparedSession=(v,action,o)=>custody(v,async session=>{actionDone=action(session);actionDone.catch(()=>{});await entered;},o);
 f.ports.transport=async()=>{dispatch++;throw Error('port ignores signal');};
 const got=await f.service().run(f.input);await assert.rejects(actionDone);assert.equal(got.status,'unconfirmed');assert.equal(f.state.used,1);assert.equal(count(f,'use'),1);assert.equal(dispatch,0);assert.equal(count(f,'finish'),0);
}));
