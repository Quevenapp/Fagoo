import {RULE_PROFILE_V1_HASH} from '../src/rule-profile-registry.mjs';
import {readFile} from 'node:fs/promises';
import {reviewedFixture,hash} from './reviewed-ledger-fixture.mjs';
import {createAuthorizationPreflightRpc} from '../src/preflight-rpc.mjs';
import {createSubsetReviewRpc} from '../src/subset-review-rpc.mjs';
import {createAuthorizationPreflightService} from '../src/preflight-service.mjs';
export {hash};
export const query=c=>({actor:c.input.actor,candidateId:c.input.candidateId,signedHash:c.input.signedHash});
export const publicQuery=c=>({candidate_id:c.input.candidateId,signed_hash:c.input.signedHash});
export async function preflightFixture(){
 const f=await reviewedFixture();try{
  const before=(await f.db.query("select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' name,p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname like 'erp_%'or(n.nspname='public'and p.proname like 'erp_%')order by 1")).rows;
  await f.db.exec(await readFile(new URL('../../../supabase/migrations/202610160072_fiscal_reviewed_preflight.sql',import.meta.url),'utf8'));
  const calls=[],rpc=createAuthorizationPreflightRpc({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-test-service-key-only',fetchImpl:async(url,o)=>{calls.push(url.split('/').at(-1));return f.http(url,o);}});
  const reviewRpc=createSubsetReviewRpc({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-test-service-key-only',fetchImpl:f.http});
  const ports={profileHash:RULE_PROFILE_V1_HASH,rpc,signedRpc:(n,a)=>{calls.push(n);return f.callSql(n,a);},reviewRpc:(n,a,o)=>{calls.push(n);return reviewRpc(n,a,o);},storage:{read:async x=>{calls.push('read');const b=f.files.get(x.key);return b?new Response(Buffer.from(b),{headers:{'content-type':'application/octet-stream'}}):null;}}};
  return{...f,before,preflightRpc:rpc,preflightCalls:calls,preflightPorts:ports,preflight:patch=>createAuthorizationPreflightService({...ports,...patch}),close:f.close};
 }catch(e){await f.close();throw e;}
}
