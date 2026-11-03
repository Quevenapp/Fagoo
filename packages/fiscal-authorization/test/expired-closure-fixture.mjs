// Local synthetic data only; no live certificate, network or environment credentials.
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {preflightFixture,hash} from './preflight-fixture.mjs';
export {hash};
export const CLOSE='erp_fiscal_reviewed_authorization_close_expired';
export const GET='erp_fiscal_reviewed_authorization_closure_command';
export const BEGIN='erp_fiscal_reviewed_authorization_begin_selected';
export async function closureFixture({beforeMigration}={}){
 const f=await preflightFixture();try{
  await f.db.exec(await readFile(new URL('../../../supabase/migrations/202610160073_fiscal_reviewed_begin_selection.sql',import.meta.url),'utf8'));
  if(beforeMigration)await beforeMigration(f);
  await f.db.exec(await readFile(new URL('../../../supabase/migrations/202610160074_fiscal_reviewed_expired_closure.sql',import.meta.url),'utf8'));
  let policy=await f.enable();
  const start=async(model='55',{prepared=false,selected=true}={})=>{
   const c=await f.candidate(model),proof=await f.review(c);
   const args={p_user_id:c.input.actor,p_command_id:c.input.commandId,p_candidate_id:c.input.candidateId,p_signed_hash:c.input.signedHash,p_expected_identity_version:1,p_expected_a1_version:2,p_expected_policy_version:policy,p_confirmed:true};
   const b=selected?{args:{...args,p_expected_candidate_version:proof.candidate_version,p_expected_review_id:proof.review_id,p_expected_review_version:proof.review_version,p_expected_review_hash:proof.review_hash,p_expected_facts_hash:proof.facts_hash,p_expected_profile_hash:proof.profile_hash,p_rule_review:proof}}:{args};
   b.value=selected?await f.rpc(BEGIN,b.args,f.opts()):(await f.begin(c,policy)).value;
   const p=prepared?await f.prepare(b,proof):null;
   const closeArgs={p_user_id:c.input.actor,p_command_id:randomUUID(),p_authorization_command_id:b.args.p_command_id,p_expected_attempt_id:b.value.receipt.attempt_id,p_expected_state:prepared?'request_ready':'prepared',p_expected_request_hash:p?.args.p_request_hash??null,p_confirmed:true};
   return{c,proof,b,p,args:closeArgs};
  };
  const closeAttempt=(x,patch={})=>f.callSql(CLOSE,{...x.args,...patch});
  const lookup=(x,patch={})=>f.callSql(GET,{p_user_id:x.args.p_user_id,p_command_id:x.args.p_command_id,...patch});
  return{...f,start,closeAttempt,lookup,setPolicy:v=>{policy=v;}};
 }catch(e){await f.close();throw e;}
}
