import {RULE_PROFILE_V1_HASH} from '../src/rule-profile-registry.mjs';
import {readFile} from 'node:fs/promises';
import {dispatchFixture} from './dispatch-fixture.mjs';
import {createAuthorizationPreflightRpc} from '../src/preflight-rpc.mjs';
import {createAuthorizationPreflightService} from '../src/preflight-service.mjs';
import {createSubsetReviewRpc} from '../src/subset-review-rpc.mjs';
import {createAuthorizationDispatchService} from '../src/dispatch-service.mjs';
import {SELECTED_RUN_PROFILE} from '../src/selected-run-dto.mjs';
export async function selectedDispatchFixture(options){
 const f=await dispatchFixture(options);try{
  for(const name of ['072_fiscal_reviewed_preflight','073_fiscal_reviewed_begin_selection'])await f.db.exec(await readFile(new URL(`../../../supabase/migrations/202610160${name}.sql`,import.meta.url),'utf8'));
  const config={projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-selected-service-only',fetchImpl:f.http};
  const preflight=createAuthorizationPreflightService({profileHash:RULE_PROFILE_V1_HASH,enabled:true,rpc:createAuthorizationPreflightRpc(config),signedRpc:f.callSql,reviewRpc:createSubsetReviewRpc(config),storage:{read:f.ports.storage.read}});
  const request=async c=>({request_profile:SELECTED_RUN_PROFILE,command_id:c.input.commandId,...(await preflight.preflight({actor:c.input.actor,candidateId:c.input.candidateId,signedHash:c.input.signedHash},f.opts())).selection,confirmed:true});
  const compose=(c,patch={})=>{const base=f.compose(c,patch),ports={...base.ports,selectReview:patch.selectReview??preflight.select,...(patch.enabled===undefined?{}:{enabled:patch.enabled})};return{...base,ports,service:Object.freeze({...createAuthorizationDispatchService(ports),preflight:preflight.preflight})};};
  return{...f,preflight,request,compose};
 }catch(e){await f.close();throw e;}
}
