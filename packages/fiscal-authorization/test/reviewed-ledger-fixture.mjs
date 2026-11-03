// Synthetic certificates, SQL and injected HTTP only. Never reads a real A1 or opens a socket.
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {subsetFixture,hash} from './subset-review-fixtures.mjs';
import {createReviewedAuthorizationRpc} from '../src/reviewed-ledger-rpc.mjs';
import {reviewProof,SUBSET_POLICY_HASHES} from '../src/reviewed-ledger-dto.mjs';
export {hash};
export async function reviewedFixture({beforeMigration,...options}={}){
 const f=await subsetFixture(options);try{
  if(beforeMigration)await beforeMigration(f);
  const policiesBefore=(await f.db.query('select to_jsonb(p) as value from erp_fiscal_authorization.policy p order by model,version')).rows.map(x=>x.value);
  await f.db.exec(await readFile(new URL('../../../supabase/migrations/202610160069_fiscal_reviewed_authorization.sql',import.meta.url),'utf8'));
  const rpcCalls=[];
  const http=async(url,o)=>{const name=url.split('/').at(-1),args=JSON.parse(Buffer.from(o.body).toString());rpcCalls.push({name,args});try{return Response.json(await f.callSql(name,args));}catch(e){return Response.json({code:e.code,message:'PRIVATE_DATABASE_SENTINEL'},{status:400});}};
  const rpc=createReviewedAuthorizationRpc({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-test-service-key-not-secret',fetchImpl:http});
  const call=(action,args)=>f.callSql('erp_fiscal_reviewed_authorization_'+action,args);
  const wire=(action,args)=>rpc('erp_fiscal_reviewed_authorization_'+action,args,f.opts());
  const enable=async(origin='operational',enabled=true)=>{
   const v=Number((await f.db.query('select max(version)+1 v from erp_fiscal_authorization.policy')).rows[0].v);
   await f.db.query(`insert into erp_fiscal_authorization.policy(model,version,origin,enabled,binding_profile,rule_profile,binding_reviewed,tax_rules_reviewed,source_manifest_hash,valid_from,valid_until,authorization_profile)
    select m,$1,$2,$3,'sp'||m||'-authorization-soap12-reviewed-20261016-v1',erp_fiscal_subset_review.profile(),$2='operational',false,erp_fiscal_reviewed_authorization.manifest(m),'2026-10-16T00:00:00-03:00','2026-10-26T00:00:00-03:00','reviewed_subset_v1'from unnest(array['55','65'])m`,[v,origin,enabled]);return v;
  };
  const review=async(c,patch={})=>{
   const saved=await f.call('save',{...c.args,...patch});const {command_id,schema,...r}=saved.receipt;
   return reviewProof({...r,tax_rules_validated:false});
  };
  const begin=async(c,version=4,extra={})=>{
   const args={p_user_id:f.users.fiscal,p_command_id:c.input.commandId,p_candidate_id:c.input.candidateId,p_signed_hash:c.input.signedHash,p_expected_identity_version:1,p_expected_a1_version:2,p_expected_policy_version:version,p_confirmed:true,...extra};
   return{args,value:await wire('begin',args)};
  };
  const ids=b=>({p_user_id:f.users.fiscal,p_attempt_id:b.value.receipt.attempt_id,p_lease_id:b.value.recovery.lease_id});
  const prepare=async(b,proof,patch={})=>{
   const requestHash=hash('synthetic reviewed request '+b.value.receipt.batch_id);await f.object(b,'requests',requestHash);
   const args={...ids(b),p_request_hash:requestHash,p_request_size:32,p_evidence:f.preparation(b,requestHash),p_rule_review:proof,...patch};
   return{args,value:await wire('prepare',args)};
  };
  const use=(b,proof)=>wire('use',{...ids(b),p_rule_review:proof});
  const finishArgs=async(b,p)=>{
   const args=await f.finishArgs(b,p),observationHash=hash('synthetic observation '+b.value.receipt.batch_id);
   await f.object(b,'observations',p.args.p_request_hash,128);
   if(b.value.receipt.origin==='operational')Object.assign(args.p_evidence,{tls_origin_verified:true,transport_hash:observationHash,transport_size:128});
   return{p_user_id:f.users.fiscal,...args,p_observation_hash:observationHash,p_observation_size:128};
  };
  return{...f,policiesBefore,rpc,http,rpcCalls,call,wire,enable,review,begin,ids,prepare,use,finishArgs,randomUUID,policyHashes:SUBSET_POLICY_HASHES};
 }catch(e){await f.close();throw e;}
}
