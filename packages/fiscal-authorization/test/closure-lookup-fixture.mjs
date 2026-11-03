import {readFile} from 'node:fs/promises';
import {closureFixture} from './expired-closure-fixture.mjs';
export const LOOKUP='erp_fiscal_reviewed_authorization_closure_lookup';
export async function closureLookupFixture({beforeMigration}={}){
 const f=await closureFixture();try{
  if(beforeMigration)await beforeMigration(f);
  await f.db.exec(await readFile(new URL('../../../supabase/migrations/202610160075_fiscal_closure_lookup.sql',import.meta.url),'utf8'));
  return{...f,lookupArgs:x=>({p_user_id:x.args.p_user_id,p_authorization_command_id:x.args.p_authorization_command_id,p_expected_attempt_id:x.args.p_expected_attempt_id}),discover:(x,patch={})=>f.callSql(LOOKUP,{p_user_id:x.args.p_user_id,p_authorization_command_id:x.args.p_authorization_command_id,p_expected_attempt_id:x.args.p_expected_attempt_id,...patch})};
 }catch(e){await f.close();throw e;}
}
