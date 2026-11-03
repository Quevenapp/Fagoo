import test from 'node:test';
import assert from 'node:assert/strict';
import {receiptFixture} from './receipt-fixtures.mjs';
import {serviceFixture} from './receipt-query-service-fixture.mjs';
let f;test.before(async()=>{f=await receiptFixture();});test.after(()=>f?.close());
const err=code=>Object.assign(Error(code),{code});
test('default closed gate precedes every RPC; historical context/history remain available without custody',async()=>{
 const x=serviceFixture(f),s=x.service({enabled:false});assert.throws(()=>s.run(x.input()),e=>e.code==='AUTHORIZATION_SERVICE_DISABLED'&&e.recovery_required===false);assert.deepEqual(x.calls,[]);
 const c=await s.context({actor:x.actor,request:x.contextInput});assert.equal(c.can_query,false);assert.deepEqual(c.blockers,['RUNTIME_DISABLED']);assert.equal(c.source_validation.verified,true);assert.equal(c.eligibility.ledger_eligible,true);
 const h=await s.history({actor:x.actor,request:{authorization_command_id:x.x.input.authorizationCommandId,expected_attempt_id:x.x.input.authorizationAttemptId,limit:25,before:null}});assert.deepEqual(h.items,[]);assert.equal(x.state.sessionCalls,0);
});
test('real source/signature/XSD55/65 and069/079: one query, durable request/use, literal105 and idempotent replay',async()=>{
 for(const model of ['55','65'])for(const kind of ['authorization','revalidation']){
  const x=serviceFixture(f,model,kind),s=x.service(),i=x.input(),r=await s.run(i);assert.equal(r.current.state,'receipt_pending');assert.equal(r.observation.cstat,'105');assert.equal(r.source.source_kind,kind);assert.equal(r.source.original.state,kind==='authorization'?'receipt_pending':'review_required');assert.equal(x.state.transports,1);
  assert.ok(x.calls.indexOf('prepare')<x.calls.indexOf('use'));assert.ok(x.calls.indexOf('use')<x.calls.indexOf('finish'));assert.equal(x.files.size,3);
  const again=await s.run(i);assert.equal(again.replayed,true);assert.equal(x.state.transports,1);assert.equal(x.state.sessionCalls,1);assert.equal(x.calls.filter(v=>v==='use').length,1);
  const changed={actor:x.actor,request:{...i.request,expected_chain_hash:'0'.repeat(64)}};await assert.rejects(s.run(changed),e=>e.code==='40001'&&!e.recovery_required);assert.equal(x.state.transports,1);
 }
});
test('104 authorization uses exact processed bytes and real processed XSD; rejection has no invented protocol grant',async()=>{
 for(const status of ['100','245']){const x=serviceFixture(f,'65','revalidation');x.state.variant={batch:'104',status};const r=await x.service().run(x.input());assert.equal(r.current.state,status==='100'?'authorized_homologation':'rejected');assert.equal(r.observation.protocol_cstat,status);assert.equal(r.resolution.state,r.current.state);assert.equal(r.observation.processed_hash!==null,status==='100');assert.equal(r.observation.protocol_number!==null,status==='100');assert.equal(x.state.transports,1);}
});
test('invalid original response remains journaled with no authorization or processed artifact',async()=>{
 const x=serviceFixture(f);x.state.raw=Buffer.from('<not-soap/>');const r=await x.service().run(x.input());assert.equal(r.current.state,'review_required');assert.equal(r.observation.rejection_code,'SOAP_INVALID');assert.equal(r.observation.cstat,null);assert.equal(r.observation.processed_hash,null);assert.equal(x.files.size,3);
});
test('lost begin ACK leaves a failed-before-dispatch query and never opens credentials',async()=>{
 const x=serviceFixture(f),i=x.input();x.state.hooks.after=async action=>{if(action==='begin')throw Error('lost begin ACK');};const r=await x.service().run(i);assert.equal(r.current.state,'failed_before_dispatch');assert.equal(r.current.grant_consumed,false);assert.equal(x.state.transports,0);assert.equal(x.state.sessionCalls,0);
});
test('lost use ACK never calls transport; retry/recover never recreates a grant',async()=>{
 const x=serviceFixture(f),s=x.service(),i=x.input();x.state.hooks.after=async action=>{if(action==='use')throw Error('lost use ACK');};await assert.rejects(s.run(i),e=>e.recovery_required===true);assert.equal(x.state.transports,0);assert.equal(x.calls.filter(v=>v==='use').length,1);
 x.state.hooks.after=null;const repeat=await s.run(i);assert.equal(repeat.current.state,'dispatched');assert.equal(x.state.transports,0);x.age();await assert.rejects(s.recover({actor:x.actor,commandId:i.request.command_id,confirmed:true}),e=>e.recovery_required===true);assert.equal(x.state.transports,0);assert.equal(x.state.sessionCalls,1);
});
test('lost finish ACK reads the immutable result; subsequent command detects processed corruption without another POST',async()=>{
 const x=serviceFixture(f);x.state.variant={batch:'104',status:'100'};const s=x.service(),i=x.input();x.state.hooks.after=async action=>{if(action==='finish')throw Error('lost finish ACK');};const r=await s.run(i);assert.equal(r.current.state,'authorized_homologation');assert.equal(x.state.transports,1);
 const k=[...x.files.keys()].find(k=>k.includes('/processed/'));x.files.set(k,Buffer.from('corrupt'));await assert.rejects(s.command({actor:x.actor,commandId:i.request.command_id}));assert.equal(x.state.transports,1);
});
test('offline recovery consumes only stored response/sidecar even after current policy is disabled',async()=>{
 const x=serviceFixture(f),s=x.service(),i=x.input();x.state.hooks.before=async action=>{if(action==='finish')throw Error('finish unavailable');};await assert.rejects(s.run(i),e=>e.recovery_required===true);assert.equal(x.state.transports,1);assert.equal(x.files.size,3);
 x.state.hooks.before=null;x.state.policyOff=true;x.age();const offline=x.service({enabled:false,withPreparedSession:()=>{throw Error('custody forbidden');},transport:()=>{throw Error('transport forbidden');}});const r=await offline.recover({actor:x.actor,commandId:i.request.command_id,confirmed:true});assert.equal(r.current.state,'receipt_pending');assert.equal(x.state.transports,1);
});
test('42501 after consumption performs no fallback read or append',async()=>{
 const x=serviceFixture(f),i=x.input();x.state.hooks.after=async action=>{if(action==='use'){x.state.denied=true;throw err('42501');}};await assert.rejects(x.service().run(i),e=>e.code==='42501'&&e.recovery_required===true);assert.equal(x.calls.at(-1),'use');assert.equal(x.state.transports,0);
});
test('only the frozen input may select a source/UUID while context waits',async()=>{
 const x=serviceFixture(f),i=x.input(),original=structuredClone(i);let release,entered;const gate=new Promise(r=>release=r),seen=new Promise(r=>entered=r);let first=true;
 x.state.hooks.before=async action=>{if(action==='context'&&first){first=false;entered();await gate;}};const p=x.service().run(i);await seen;i.request.command_id='a0000000-0000-4000-8000-000000000001';i.request.expected_signed_hash='0'.repeat(64);release();const r=await p;assert.equal(r.command_id,original.request.command_id);assert.equal(r.source.signed_hash,original.request.expected_signed_hash);
});
test('late source handle is disposed on abort; no begin/custody follows',async()=>{
 const x=serviceFixture(f);let entered,resolve;const seen=new Promise(r=>entered=r),s=x.service({readSource:()=>{entered();return new Promise(r=>resolve=r);}}),ac=new AbortController();const p=s.context({actor:x.actor,request:x.contextInput},{signal:ac.signal});await seen;ac.abort();await assert.rejects(p,e=>e.recovery_required===false);const h=await x.x.read();resolve(h);await new Promise(r=>setImmediate(r));const {receiptQuerySource}=await import('../src/receipt-query-source.mjs');assert.throws(()=>receiptQuerySource(h));assert.equal(x.calls.includes('begin'),false);
});
test('wrong validator pins after durable response stay uncertain and do not create an observation result',async()=>{
 const x=serviceFixture(f),validate=x.ports.validate;await assert.rejects(x.service({validate:async(v,o)=>{const r=await validate(v,o);return v.kind==='response'?{...r,validatorHash:'0'.repeat(64)}:r;}}).run(x.input()),e=>e.recovery_required===true);assert.equal(x.state.record.artifact,null);assert.equal(x.calls.includes('finish'),false);assert.equal(x.files.size,3);
});
test('HTTP500 preserves bytes but cannot become a valid authorization',async()=>{
 const x=serviceFixture(f),transport=x.ports.transport;x.state.variant={batch:'104',status:'100'};
 const r=await x.service({transport:async(...a)=>{const v=await transport(...a);return{...v,response:new Response(await v.response.arrayBuffer(),{status:500,headers:{'content-type':'application/soap+xml; charset=utf-8'}})};}}).run(x.input());assert.equal(r.current.state,'review_required');assert.equal(r.observation.rejection_code,'SOAP_INVALID');assert.equal(r.observation.processed_hash,null);
});
test('recovery refuses absent/mismatched sidecar and never interprets a raw response as TLS proof',async()=>{
 for(const corrupt of [false,true]){const x=serviceFixture(f),i=x.input(),s=x.service();x.state.hooks.before=async action=>{if(action==='finish')throw Error('offline');};await assert.rejects(s.run(i));x.state.hooks.before=null;x.age();const k=[...x.files.keys()].find(k=>k.includes('/observations/'));if(corrupt){const m=JSON.parse(x.files.get(k));m.nonce='a0000000-0000-4000-8000-000000000001';x.files.set(k,Buffer.from(JSON.stringify(m)));}else x.files.delete(k);await assert.rejects(s.recover({actor:x.actor,commandId:i.request.command_id,confirmed:true}),e=>e.recovery_required===true);assert.equal(x.state.transports,1);assert.equal(x.state.record.artifact,null);}
});
