import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {gtinDispatchFixture} from './gtin-dispatch-v2-fixture.mjs';
import {RULE_PROFILE_V2_HASH} from '../src/rule-profile-registry.mjs';
import {createAuthorizationDispatchService} from '../src/dispatch-service.mjs';
import {projectResponse} from '../src/service-dto.mjs';
import {projectDispatchPublic} from '../../fiscal-authorization-runtime/src/dispatch-public-dto.mjs';
test('077 numeric GTIN55/65 connects current review to persisted073 selection, XSD/signature/custody and historical recovery',{timeout:60000},async t=>{
 const f=await gtinDispatchFixture();try{
  for(const model of ['55','65'])await t.test(model+' exact proof, one grant/POST and no rereview on recovery',async()=>{
   const c=await f.source(model),request=await f.request(c),x=f.compose(c,{validate:(v,o)=>{if(v.kind==='response')throw Error('SYNTHETIC_VALIDATOR_UNAVAILABLE');return f.ports.validate(v,o);}}),before=f.events.filter(x=>x==='POST').length;
   const out=await x.service.runReviewed({actor:c.input.actor,request});assert.equal(out.status,'unconfirmed',JSON.stringify(out));assert.equal(f.events.filter(x=>x==='POST').length,before+1);
   const stored=await f.wire('command',{p_user_id:c.input.actor,p_command_id:c.input.commandId});assert.equal(stored.rule_review.profile_hash,RULE_PROFILE_V2_HASH);assert.equal(stored.current.grant_consumed,true);
   // Old immutable command/history readers remain valid and never misstate tax coverage.
   const args={p_user_id:c.input.actor,p_command_id:c.input.commandId},legacy=await f.callSql('erp_fiscal_authorization_command',args);assert.doesNotThrow(()=>projectResponse('erp_fiscal_authorization_command',legacy,args));
   const previewArgs={p_user_id:c.input.actor,p_candidate_id:c.input.candidateId,p_signed_hash:c.input.signedHash};const pv=await f.callSql('erp_fiscal_authorization_preview',previewArgs);assert.doesNotThrow(()=>projectResponse('erp_fiscal_authorization_preview',pv,previewArgs));
   await f.reviewService.save({...c.reviewBody,commandId:randomUUID(),expectedReviewVersion:1});const beforeRecover=f.events.length,never=()=>{throw Error('NO_CURRENT_REVIEW_OR_PRIVATE_KEY_DURING_RECOVERY');};
   const recovered=await createAuthorizationDispatchService({...x.ports,enabled:false,validate:f.ports.validate,selectReview:never,readReview:never,withPreparedSession:never,transport:never}).recover({actor:c.input.actor,commandId:c.input.commandId});assert.equal(recovered.status,'authorized_homologation',JSON.stringify(recovered));assert.equal(recovered.tax_rules_validated,false);assert.equal(recovered.subset_review.profile_hash,RULE_PROFILE_V2_HASH);assert.equal(f.events.filter(x=>x==='POST').length,before+1);assert.ok(f.events.slice(beforeRecover).every(n=>n.endsWith('_command')||n.endsWith('_finish')));
   assert.doesNotThrow(()=>projectDispatchPublic(recovered,{action:'recover',commandId:c.input.commandId}));
  });
  await t.test('direct064 use without pinned binding cannot bypass the reviewed proof',async()=>{
   const c=await f.source(),b=await f.begin(c,c.input.expectedPolicyVersion);
   await assert.rejects(f.callSql('erp_fiscal_authorization_use',{p_user_id:c.input.actor,p_attempt_id:b.value.receipt.attempt_id,p_lease_id:b.value.recovery.lease_id}),e=>['40001','55000'].includes(e.code));
   assert.equal((await f.wire('command',{p_user_id:c.input.actor,p_command_id:c.input.commandId})).current.grant_consumed,false);
  });
 }finally{await f.close();}
});
