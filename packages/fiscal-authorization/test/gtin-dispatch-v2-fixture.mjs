import {readFile} from 'node:fs/promises';
import {dispatchFixture} from './dispatch-fixture.mjs';
import {createSubsetReviewService} from '../src/subset-review-service.mjs';
import {createSubsetReviewRpc} from '../src/subset-review-rpc.mjs';
import {createAuthorizationPreflightRpc} from '../src/preflight-rpc.mjs';
import {createAuthorizationPreflightService} from '../src/preflight-service.mjs';
import {createAuthorizationDispatchService} from '../src/dispatch-service.mjs';
import {RULE_PROFILE_V2_HASH,ruleProfileByHash} from '../src/rule-profile-registry.mjs';
import {SELECTED_RUN_PROFILE} from '../src/selected-run-dto.mjs';
import {saveBody} from './gtin-review-v2-fixture.mjs';
export async function gtinDispatchFixture(options){
 const f=await dispatchFixture({...options,sourceOptions:{gtin:'7891234567895'}});try{
  for(const n of ['072_fiscal_reviewed_preflight','073_fiscal_reviewed_begin_selection','077_fiscal_gtin_rule_profile_v2'])await f.db.exec(await readFile(new URL(`../../../supabase/migrations/202610160${n}.sql`,import.meta.url),'utf8'));
  const config={projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-077-dispatch-key',fetchImpl:f.http};
  const ports={signedRpc:f.callSql,reviewRpc:createSubsetReviewRpc(config),storage:{read:f.ports.storage.read}},review=createSubsetReviewService(ports),preflight=createAuthorizationPreflightService({...ports,rpc:createAuthorizationPreflightRpc(config),enabled:true});
  const active=ruleProfileByHash(RULE_PROFILE_V2_HASH),version=Number((await f.db.query('select max(version)+1 v from erp_fiscal_authorization.policy')).rows[0].v);
  for(const m of ['55','65'])await f.db.query(`insert into erp_fiscal_authorization.policy(model,version,origin,enabled,binding_profile,rule_profile,binding_reviewed,tax_rules_reviewed,source_manifest_hash,valid_from,valid_until,authorization_profile)values($1,$2,'operational',true,'sp'||$1||'-authorization-soap12-reviewed-20261016-v1',$3,true,false,$4,'2026-10-16T00:00:00-03:00','2026-10-26T00:00:00-03:00','reviewed_subset_v1')`,[m,version,active.profile,active.policyHashes[m]]);
  const source=async(model='55')=>{const c=await f.candidate(model),ctx=await review.context({actor:c.q.actor,candidateId:c.q.candidateId}),body=saveBody(c,ctx);await review.save(body);return{...c,reviewBody:body,input:{...c.input,expectedPolicyVersion:version}};};
  const request=async c=>({request_profile:SELECTED_RUN_PROFILE,command_id:c.input.commandId,...(await preflight.preflight({actor:c.input.actor,candidateId:c.input.candidateId,signedHash:c.input.signedHash})).selection,confirmed:true});
  const compose=(c,patch={})=>{const base=f.compose(c,patch),ports={...base.ports,selectReview:patch.selectReview??preflight.select,...(patch.enabled===undefined?{}:{enabled:patch.enabled})};return{...base,ports,service:createAuthorizationDispatchService(ports)};};
  return{...f,source,reviewService:review,preflight,request,compose};
 }catch(e){await f.close();throw e;}
}
