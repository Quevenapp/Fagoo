// Numeric identifiers are synthetic, never asserted as assigned to a product.
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {reviewedFixture} from './reviewed-ledger-fixture.mjs';
import {createSubsetReviewService} from '../src/subset-review-service.mjs';
import {createSubsetReviewRpc} from '../src/subset-review-rpc.mjs';
import {createAuthorizationPreflightRpc} from '../src/preflight-rpc.mjs';
import {createAuthorizationPreflightService} from '../src/preflight-service.mjs';
import {RULE_PROFILE_V1_HASH,RULE_PROFILE_V2_HASH,ruleProfileByHash} from '../src/rule-profile-registry.mjs';
export const choices=c=>({document:structuredClone(c.declaration.document),items:c.declaration.items.map(({item_hash,...x})=>({...x,gtin:'reviewed_identifiers'}))});
export const saveBody=(c,ctx,patch={})=>({actor:c.q.actor,candidateId:c.q.candidateId,commandId:randomUUID(),expectedCandidateVersion:ctx.candidate.candidate_version,signedHash:ctx.candidate.signed_hash,expectedReviewVersion:ctx.review.current.latest_review_version,expectedFactsHash:ctx.candidate.facts_hash,expectedProfileHash:ctx.candidate.profile_hash,validUntil:'2026-10-25T23:59:59.000Z',choices:choices(c),...patch});
export const publicBody=x=>({command_id:x.commandId,expected_candidate_version:x.expectedCandidateVersion,signed_hash:x.signedHash,expected_review_version:x.expectedReviewVersion,expected_facts_hash:x.expectedFactsHash,expected_profile_hash:x.expectedProfileHash,valid_until:x.validUntil,choices:x.choices});
export async function gtinFixture(){
 const f=await reviewedFixture({sourceOptions:{gtin:'7891234567895'}});try{
  for(const n of ['072_fiscal_reviewed_preflight','073_fiscal_reviewed_begin_selection'])await f.db.exec(await readFile(new URL(`../../../supabase/migrations/202610160${n}.sql`,import.meta.url),'utf8'));
  const counts={read:0,signed:0},config={projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-077-service-key',fetchImpl:f.http};
  const ports={signedRpc:async(n,a)=>{counts.signed++;return f.callSql(n,a);},reviewRpc:createSubsetReviewRpc(config),storage:{read:async x=>{counts.read++;const b=f.files.get(x.key);return b?new Response(Buffer.from(b),{headers:{'content-type':'application/octet-stream'}}):null;}}};
  const service=(patch={})=>createSubsetReviewService({...ports,...patch});
  const install=()=>f.db.exec(readFileSyncSource);
  const readFileSyncSource=await readFile(new URL('../../../supabase/migrations/202610160077_fiscal_gtin_rule_profile_v2.sql',import.meta.url),'utf8');
  const preflight=patch=>createAuthorizationPreflightService({...ports,rpc:createAuthorizationPreflightRpc(config),...patch});
  const enable=async(model='55',profileHash=RULE_PROFILE_V2_HASH)=>{const p=ruleProfileByHash(profileHash);return(await f.db.query(`insert into erp_fiscal_authorization.policy(model,version,origin,enabled,binding_profile,rule_profile,binding_reviewed,tax_rules_reviewed,source_manifest_hash,valid_from,valid_until,authorization_profile)select $1,coalesce(max(version),0)+1,'operational',true,'sp'||$1||'-authorization-soap12-reviewed-20261016-v1',$2,true,false,$3,'2026-10-16T00:00:00-03:00','2026-10-26T00:00:00-03:00','reviewed_subset_v1'from erp_fiscal_authorization.policy where model=$1 returning version`,[model,p.profile,p.policyHashes[model]])).rows[0].version;};
  return{...f,counts,ports,service,install,preflight,enable,v1:()=>service({profileHash:RULE_PROFILE_V1_HASH})};
 }catch(e){await f.close();throw e;}
}
