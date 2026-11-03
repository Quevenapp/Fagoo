import test from 'node:test';
import {subsetReviewInitialValues} from '../../../apps/erp/src/lib/fiscal-subset-review-model.ts';
import assert from 'node:assert/strict';
import {canonical} from '../src/subset-review-dto.mjs';
import {randomUUID} from 'node:crypto';
import {gtinFixture,saveBody,publicBody} from './gtin-review-v2-fixture.mjs';
import {RULE_PROFILE_V1_HASH,RULE_PROFILE_V2_HASH} from '../src/rule-profile-registry.mjs';
import {projectReviewPublic} from '../../fiscal-authorization-runtime/src/review-dto.mjs';
import {projectPreflightPublic} from '../src/preflight-dto.mjs';
const rejected=(p,code)=>assert.rejects(p,e=>e.code===code);
const view=(service,c)=>service.context({actor:c.q.actor,candidateId:c.q.candidateId});
const count=async f=>(await f.db.query('select(select count(*)from erp_fiscal_subset_review.review)reviews,(select count(*)from erp_fiscal_authorization.attempt)attempts,(select count(*)from erp_fiscal_authorization.command)commands')).rows[0];
test('077 numericGTIN transition is explicit, preserves v1 receipts and closes same-profile CAS',async t=>{
 const f=await gtinFixture();try{
  const cases=[];
  for(const model of ['55','65']){const c=await f.candidate(model),ctx=await view(f.v1(),c),body=saveBody(c,ctx),ack=await f.v1().save(body);cases.push({c,body,ack});assert.equal((await view(f.v1(),c)).report.pendingClassification.some(x=>x.code==='GS1_PREFIX_TABLE_NOT_PINNED'),true);}
  const legacyRows=(await f.db.query('select to_jsonb(p)value from erp_fiscal_authorization.policy p order by model,version')).rows,legacyReceipts=cases.map(x=>structuredClone(x.ack.receipt));
  await f.install();const service=f.service();
  await t.test('migration preserves old policies exactly and adds only disabled taxfalse policies',async()=>{
   const rows=(await f.db.query('select to_jsonb(p)value from erp_fiscal_authorization.policy p order by model,version')).rows;
   for(const old of legacyRows)assert.deepEqual(rows.find(x=>x.value.model===old.value.model&&x.value.version===old.value.version),old);
   const added=rows.filter(x=>!legacyRows.some(y=>y.value.model===x.value.model&&y.value.version===x.value.version));assert.equal(added.length,2);for(const{value:p}of added){assert.equal(p.enabled,false);assert.equal(p.tax_rules_reviewed,false);assert.match(p.rule_profile,/v2$/);}
  });
  for(const{c,body,ack}of cases)await t.test(c.stored.receipt.model+' old head is historical until an explicit v2 review',async()=>{
   const ctx=await view(service,c);assert.equal(ctx.candidate.profile_hash,RULE_PROFILE_V2_HASH);assert.equal(ctx.review.matches_profile,false);assert.deepEqual(ctx.review.receipt,ack.receipt);assert.equal(ctx.report.review,null);assert.equal(ctx.report.status,'pending_classification');assert.deepEqual(projectReviewPublic(ctx,{action:'context',candidateId:c.q.candidateId}),ctx);const form=subsetReviewInitialValues(ctx);assert.equal(form.validUntil,null);assert.ok(Object.values(form.choices.document).every(x=>x==='unreviewed'));assert.ok(form.choices.items.every(x=>x.gtin==='unreviewed'));assert.equal(ctx.review.current.latest_review_version,1);
   const before={...f.counts},replay=await service.save(body);assert.equal(replay.replayed,true);assert.deepEqual(replay.receipt,ack.receipt);assert.deepEqual(f.counts,before);
   await rejected(service.save({...body,commandId:randomUUID()}),'40001');
   await rejected(f.ports.reviewRpc('erp_fiscal_subset_review_get',{...c.getArgs,p_profile_hash:RULE_PROFILE_V2_HASH},f.opts()),'40001');
   const p=await f.preflight({enabled:true}).preflight({actor:c.q.actor,candidateId:c.q.candidateId,signedHash:c.q.signedHash});assert.equal(p.preflight_profile,'authorization-reviewed-preflight-v2');assert.equal(p.checks.review_matches,false);assert.equal(p.selection,null);assert.equal(p.can_run,false);
   const next=saveBody(c,ctx),saved=await service.save(next);assert.equal(saved.receipt.review_version,2);assert.equal(saved.receipt.profile_hash,RULE_PROFILE_V2_HASH);assert.deepEqual(projectReviewPublic(saved,{action:'save',candidateId:c.q.candidateId,commandId:next.commandId,input:publicBody(next)}),saved);
   const current=await view(service,c);assert.equal(current.review.matches_profile,true);assert.equal(current.report.status,'reviewed_subset');assert.deepEqual(current.report.pendingClassification,[]);assert.equal(current.report.canEmit,false);assert.deepEqual(projectReviewPublic(current,{action:'context',candidateId:c.q.candidateId}),current);
   await rejected(service.save(saveBody(c,ctx)),'40001');await rejected(f.ports.reviewRpc('erp_fiscal_subset_review_get',c.getArgs,f.opts()),'40001');
   const old=await service.command({actor:c.q.actor,commandId:body.commandId});assert.deepEqual(old.receipt,ack.receipt);assert.equal(old.current.is_latest,false);
   await f.enable(c.stored.receipt.model);const eligible=await f.preflight({enabled:true}).preflight({actor:c.q.actor,candidateId:c.q.candidateId,signedHash:c.q.signedHash});assert.equal(eligible.can_run,true);assert.equal(eligible.tax_rules_validated,false);assert.equal(eligible.selection.expected_profile_hash,RULE_PROFILE_V2_HASH);assert.deepEqual(projectPreflightPublic(eligible,{candidate_id:c.q.candidateId,signed_hash:c.q.signedHash}),eligible);
   const wrong=structuredClone(eligible);wrong.preflight_profile='authorization-reviewed-preflight-v1';assert.throws(()=>projectPreflightPublic(wrong,{candidate_id:c.q.candidateId,signed_hash:c.q.signedHash}));
  });
  await t.test('250 numeric items remain bounded from SQL through public DTO',async()=>{const c=await f.candidate('55',250),ctx=await view(service,c),body=saveBody(c,ctx),saved=await service.save(body),current=await view(service,c);assert.equal(current.report.status,'reviewed_subset');assert.equal(saved.declaration.items.length,250);assert.equal(current.facts.items[249].gtin,'7891234567895');assert.ok(Buffer.byteLength(JSON.stringify(current))<=1048576);assert.deepEqual(projectReviewPublic(current,{action:'context',candidateId:c.q.candidateId}),current);});
  await t.test('v1 command/replay ignore changed A1/bases and still require the original current actor',async()=>{
   const{c,body,ack}=cases[0];await f.disable();const before={...f.counts};assert.deepEqual((await service.save(body)).receipt,ack.receipt);assert.deepEqual(f.counts,before);await rejected(service.command({actor:f.users.admin,commandId:body.commandId}),'42501');
   const replay=await f.callSql('erp_fiscal_subset_review_save',{...c.args,p_command_id:body.commandId,p_declaration_text:canonical({...c.declaration,items:c.declaration.items.map(x=>({...x,gtin:'reviewed_identifiers'}))})});assert.equal(replay.replayed,true);assert.equal(replay.receipt.profile_hash,RULE_PROFILE_V1_HASH);
  });
  await t.test('no dispatch/financial/stock effects occurred; original receipt bytes remain identical',async()=>{const totals=await count(f);assert.equal(totals.reviews,5);assert.equal(totals.attempts,0);assert.equal(totals.commands,0);for(let i=0;i<cases.length;i++)assert.deepEqual((await service.command({actor:cases[i].c.q.actor,commandId:cases[i].body.commandId})).receipt,legacyReceipts[i]);});
 }finally{await f.close();}
});
