import {RULE_PROFILE_V1_HASH} from '../src/rule-profile-registry.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {subsetFixture,canonical,credit} from './subset-review-fixtures.mjs';
import {createSubsetReviewService,SUBSET_SERVICE_REQUEST_BYTES,SUBSET_SERVICE_RESPONSE_BYTES} from '../src/subset-review-service.mjs';
import {projectReviewPublic} from '../../fiscal-authorization-runtime/src/review-dto.mjs';
import {captureReviewInput} from '../../fiscal-authorization-runtime/src/review-protocol.mjs';
const choices=d=>({document:structuredClone(d.document),items:d.items.map(({item_hash,...x})=>structuredClone(x))});
const saveInput=(c,context,patch={})=>({actor:c.q.actor,candidateId:c.q.candidateId,commandId:randomUUID(),expectedCandidateVersion:context.candidate.candidate_version,signedHash:context.candidate.signed_hash,expectedReviewVersion:context.review.current.latest_review_version,expectedFactsHash:context.candidate.facts_hash,expectedProfileHash:context.candidate.profile_hash,validUntil:'2026-10-25T23:59:59.000Z',choices:choices(c.declaration),...patch});
const reject=(fn,code)=>assert.rejects(fn,e=>e.code===code);
const wire=x=>({command_id:x.commandId,expected_candidate_version:x.expectedCandidateVersion,signed_hash:x.signedHash,expected_review_version:x.expectedReviewVersion,expected_facts_hash:x.expectedFactsHash,expected_profile_hash:x.expectedProfileHash,valid_until:x.validUntil,choices:x.choices});
test('068 service derives55/65 facts from private exact bytes and only persists declarations',async t=>{
 const f=await subsetFixture(),calls={signed:0,read:0,review:[]};
 const signedRpc=async(name,args)=>{assert.equal(name,'erp_fiscal_signed_get');calls.signed++;return f.callSql(name,args);};
 const read=async x=>{calls.read++;assert.equal(x.bucket,'brufap-fiscal-artifacts');assert.match(x.key,/^candidates\/[a-f0-9-]{36}\/[a-f0-9]{64}\.xml$/);assert.ok(x.signal instanceof AbortSignal);const b=f.files.get(x.key);return b?new Response(Buffer.from(b),{headers:{'Content-Type':'application/octet-stream','Content-Length':String(b.length)}}):null;};
 const reviewRpc=async(name,args,opts)=>{calls.review.push(name);return f.rpc(name,args,opts);};
 const factory=patch=>{
  const service=createSubsetReviewService({profileHash:RULE_PROFILE_V1_HASH,signedRpc,reviewRpc,storage:{read},...patch});
  return Object.fromEntries(['context','save','command'].map(action=>[action,async(input,options)=>{
   // Capture the independent HTTP expectation before callers can mutate input.
   // Adversarial descriptors are left to the service's own rejection path.
   let binding;try{binding={action,candidateId:input.candidateId,commandId:input.commandId,...(action==='save'?{input:captureReviewInput(wire(input))}:{})};}catch{}
   const result=await service[action](input,options);
   assert.deepEqual(projectReviewPublic(result,binding),result);return result;
  }]));
 },service=factory();
 const c=await f.candidate('55'),d=await f.candidate('65');let context,input,saved;
 try{
  await t.test('context and saved/reopened declarations55/65 match the existing exact facts/item hashes',async()=>{
   for(const source of [c,d]){
    const before=await service.context({actor:source.q.actor,candidateId:source.q.candidateId});
    assert.equal(before.candidate.facts_hash,source.handle.factsHash);assert.equal(before.candidate.signed_hash,source.q.signedHash);assert.equal(before.review.receipt,null);assert.equal(before.report.review,null);assert.equal(before.save_available,true);assert.ok(before.labels.items[0].description);assert.equal(before.facts.model,source.stored.receipt.model);
    const body=saveInput(source,before),ack=await service.save(body);assert.equal(ack.receipt.candidate_version,source.stored.receipt.version);assert.equal(ack.kind,'save');assert.equal(ack.receipt.schema,undefined);assert.equal(ack.record_text,undefined);assert.equal(ack.declaration.items[0].item_hash,undefined);
    const fresh=await service.context({actor:source.q.actor,candidateId:source.q.candidateId});assert.equal(fresh.report.status,'reviewed_subset');assert.equal(fresh.review.receipt.review_id,body.commandId);assert.equal(fresh.report.taxRulesValidated,false);assert.equal(fresh.can_emit,false);
    const replay=await service.save(body);assert.equal(replay.replayed,true);assert.deepEqual(replay.receipt,ack.receipt);
    const raw=await f.call('command',{p_user_id:source.q.actor,p_command_id:body.commandId});assert.equal(JSON.parse(raw.record_text).items[0].item_hash,source.q.items[0].itemHash);
    if(source===c){context=fresh;input=body;saved=ack;}
   }
  });
  await t.test('input is captured before awaiting metadata; source hashes/CAS are expectations, not evidence',async()=>{
   let release,started;const entered=new Promise(r=>started=r),gate=new Promise(r=>release=r);let once=true;
   const own=factory({signedRpc:async(...args)=>{if(once){once=false;started();await gate;}return signedRpc(...args);}}),body=saveInput(c,context);body.choices.document.payment='unreviewed';const original=body.commandId;
   const pending=own.save(body);await entered;body.commandId=randomUUID();body.choices.document.payment='matches_signed_document';release();const result=await pending;
   assert.equal(result.command_id,original);assert.equal(result.declaration.document.payment,'unreviewed');
   const count=calls.review.filter(x=>x.endsWith('_save')).length;
   for(const patch of [{expectedFactsHash:'a'.repeat(64)},{expectedProfileHash:'a'.repeat(64)},{signedHash:'a'.repeat(64)},{expectedCandidateVersion:999}])await reject(()=>service.save(saveInput(c,context,patch)),'40001');
   assert.equal(calls.review.filter(x=>x.endsWith('_save')).length,count);
  });
  await t.test('250 signed items retain positions/hashes through SQL and the closed HTTP projection',async()=>{
   const many=await f.candidate('55',250),before=await service.context({actor:many.q.actor,candidateId:many.q.candidateId});
   assert.equal(before.facts.items.length,250);assert.equal(before.labels.items.length,250);assert.equal(before.facts.items[249].itemHash,many.q.items[249].itemHash);
   const body=saveInput(many,before),ack=await service.save(body),current=await service.context({actor:many.q.actor,candidateId:many.q.candidateId});
   assert.equal(ack.declaration.items.length,250);assert.equal(current.report.status,'reviewed_subset');assert.ok(Buffer.byteLength(JSON.stringify(current))<=SUBSET_SERVICE_RESPONSE_BYTES);
   assert.ok(Buffer.byteLength(JSON.stringify(wire(body)))<=SUBSET_SERVICE_REQUEST_BYTES);
  });
  await t.test('getters, missing/extra positions, injected item hashes and credit evidence cannot dispatch',async()=>{
   const base=await service.context({actor:c.q.actor,candidateId:c.q.candidateId}),count=calls.review.filter(x=>x.endsWith('_save')).length;
   for(const patch of [{item_hash:'a'.repeat(64)},{credit:credit('invented')},{position:2}]){const body=saveInput(c,base);Object.assign(body.choices.items[0],patch);await assert.rejects(()=>service.save(body));}
   let invoked=0;const body=saveInput(c,base);Object.defineProperty(body.choices.items[0],'classification',{enumerable:true,get(){invoked++;return 'reviewed_physical_goods';}});await assert.rejects(()=>service.save(body));assert.equal(invoked,0);assert.equal(calls.review.filter(x=>x.endsWith('_save')).length,count);
   assert.equal(SUBSET_SERVICE_REQUEST_BYTES,144*1024);assert.equal(SUBSET_SERVICE_RESPONSE_BYTES,1024*1024);
  });
  await t.test('lost save ACK is uncertain and command readback never reads XML or repeats save',async()=>{
   const base=await service.context({actor:c.q.actor,candidateId:c.q.candidateId}),body=saveInput(c,base);let posts=0;
   const lossy=factory({reviewRpc:async(name,args,opts)=>{const value=await reviewRpc(name,args,opts);if(name.endsWith('_save')){posts++;throw Error('PRIVATE_SENTINEL');}return value;}});
   await assert.rejects(()=>lossy.save(body),e=>e.command_id===body.commandId&&e.recovery_required===true&&!e.message.includes('PRIVATE_SENTINEL'));
   const prior={read:calls.read,signed:calls.signed},result=await lossy.command({actor:c.q.actor,commandId:body.commandId});assert.equal(result.receipt.command_id,body.commandId);assert.equal(result.read_only,true);assert.equal(posts,1);assert.equal(calls.read,prior.read);assert.equal(calls.signed,prior.signed);
   await reject(()=>service.command({actor:f.users.admin,commandId:body.commandId}),'42501');
  });
  await t.test('Storage hash mismatch and revocation after read release no facts or save',async()=>{
   const bad=factory({storage:{read:async()=>new Response('changed',{headers:{'Content-Type':'application/octet-stream'}})}});await assert.rejects(()=>bad.context({actor:c.q.actor,candidateId:c.q.candidateId}));
   let n=0;const denied=factory({signedRpc:async(...args)=>{if(++n===2)throw Object.assign(Error('PRIVATE'),{code:'42501'});return signedRpc(...args);}});
   await assert.rejects(()=>denied.context({actor:c.q.actor,candidateId:c.q.candidateId}),e=>e.code==='42501'&&e.recovery_required===false);
  });
  await t.test('cancellation discards a late Storage response and never writes',async()=>{
   let ready,release;const entered=new Promise(r=>ready=r),gate=new Promise(r=>release=r),a=new AbortController();let cancelled=0;
   const delayed=factory({storage:{read:async()=>{ready();await gate;return new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'Content-Type':'application/octet-stream'}});}}});
   const promise=delayed.context({actor:c.q.actor,candidateId:c.q.candidateId},{signal:a.signal});await entered;a.abort();await assert.rejects(()=>promise);release();await new Promise(r=>setTimeout(r,0));assert.equal(cancelled,1);
  });
  await t.test('expired and inactive reviews remain readable without being used as current evidence',async()=>{
   const base=await service.context({actor:c.q.actor,candidateId:c.q.candidateId}),body=saveInput(c,base,{validUntil:new Date(Date.now()+100).toISOString()});await service.save(body);await new Promise(r=>setTimeout(r,110));
   const expired=await service.context({actor:c.q.actor,candidateId:c.q.candidateId});assert.equal(expired.review.current.within_validity,false);assert.ok(expired.review.declaration);assert.equal(expired.report.review,null);assert.equal(expired.report.status,'pending_classification');
   await f.db.query('update erp_access.membership set active=false where user_id=$1',[c.q.actor]);
   try{const inactive=await service.context({actor:f.users.admin,candidateId:c.q.candidateId});assert.equal(inactive.review.current.reviewer_active,false);assert.ok(inactive.review.receipt);assert.equal(inactive.report.review,null);}finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[c.q.actor]);}
  });
  await t.test('existing backend credit is displayed read-only and cannot be silently discarded',async()=>{
   const base=await service.context({actor:c.q.actor,candidateId:c.q.candidateId}),raw=structuredClone(c.declaration);raw.items[0].credit=credit('Existing backend evidence');
   await f.call('save',{...c.args,p_command_id:randomUUID(),p_expected_review_version:base.review.current.latest_review_version,p_declaration_text:canonical(raw)});
   const next=await service.context({actor:c.q.actor,candidateId:c.q.candidateId});assert.equal(next.save_available,false);assert.ok(next.save_blockers.includes('EXISTING_CREDIT_EVIDENCE_READ_ONLY'));assert.equal(next.review.declaration.items[0].credit.statement,'Existing backend evidence');
   await reject(()=>service.save(saveInput(c,next)),'SUBSET_REVIEW_EXISTING_CREDIT_READ_ONLY');
  });
  await t.test('A1 disabled and archived bases still allow history/command; zero064/financial/stock effects',async()=>{
   await f.disable();await f.callSql('erp_fiscal_draft_execute',{p_user_id:f.users.fiscal,p_command_id:randomUUID(),p_action:'archive',p_data:{id:c.stored.receipt.draft_id,expected_version:1,reason:'Synthetic history test'}});
   const historical=await service.command({actor:c.q.actor,commandId:input.commandId});assert.deepEqual(historical.receipt,saved.receipt);
   const current=await service.context({actor:c.q.actor,candidateId:c.q.candidateId});assert.equal(current.save_available,false);assert.ok(current.save_blockers.includes('A1_CHANGED'));assert.ok(current.save_blockers.includes('DRAFT_ARCHIVED'));
   const counts=(await f.db.query('select (select count(*)::int from erp_fiscal_authorization.intent)i,(select count(*)::int from erp_fiscal_authorization.attempt)a,(select count(*)::int from erp_fiscal_authorization.command)c,(select count(*)::int from erp_fiscal_authorization.request)r,(select count(*)::int from erp_fiscal_authorization.result)z,(select count(*)::int from erp_finance.title)f,(select count(*)::int from erp_stock.movement)s')).rows[0];assert.deepEqual(counts,{i:0,a:0,c:0,r:0,z:0,f:0,s:0});
   assert.ok(calls.review.every(n=>['get','save','command'].some(a=>n===`erp_fiscal_subset_review_${a}`)));
  });
 }finally{await f.close();}
});
