// Disposable, synthetic SQL fixture only. Age changes simulate elapsed wall time;
// production identity048 remains immutable and is never rewritten by migration080.
import {readFile} from 'node:fs/promises';
import {reviewedFixture} from './reviewed-ledger-fixture.mjs';
import {RULE_PROFILE_V2_HASH} from '../src/rule-profile-registry.mjs';
export const migration080=await readFile(new URL('../../../supabase/migrations/202610160080_nfce_emission_window.sql',import.meta.url),'utf8');
export async function emissionSqlFixture(){
 const f=await reviewedFixture();try{
  for(const name of ['072_fiscal_reviewed_preflight','073_fiscal_reviewed_begin_selection','077_fiscal_gtin_rule_profile_v2'])
   await f.db.exec(await readFile(new URL(`../../../supabase/migrations/202610160${name}.sql`,import.meta.url),'utf8'));
  async function enable(origin='operational',enabled=true){
   const v=Number((await f.db.query('select max(version)+1 v from erp_fiscal_authorization.policy')).rows[0].v);
   await f.db.query(`insert into erp_fiscal_authorization.policy(model,version,origin,enabled,binding_profile,rule_profile,binding_reviewed,tax_rules_reviewed,source_manifest_hash,valid_from,valid_until,authorization_profile)
    select m,$1,$2,$3,'sp'||m||'-authorization-soap12-reviewed-20261016-v1',erp_fiscal_subset_review.profile_definition($4)->>'profile',$2='operational',false,erp_fiscal_reviewed_authorization.manifest(m,$4),'2026-10-16T00:00:00-03:00','2026-10-26T00:00:00-03:00','reviewed_subset_v1'from unnest(array['55','65'])m`,[v,origin,enabled,RULE_PROFILE_V2_HASH]);return v;
  }
  async function fresh(model='65',origin='operational'){
   const version=await enable(origin),c=await f.candidate(model),proof=await f.review(c,{p_profile_hash:RULE_PROFILE_V2_HASH}),b=await f.begin(c,version),p=await f.prepare(b,proof);
   return{c,proof,b,p,use:{...f.ids(b),p_rule_review:proof}};
  }
  async function age(x,seconds,{literal=null}={}){
   await f.db.exec('alter table erp_fiscal_unsigned.identity disable trigger immutable_identity');
   try{await f.db.query(`update erp_fiscal_unsigned.identity i set identity=jsonb_set(identity,'{issuedAt}',to_jsonb(coalesce($2::text,to_char((clock_timestamp()-$3::double precision*interval'1 second')at time zone interval'-03:00','YYYY-MM-DD"T"HH24:MI:SS')||'-03:00')))
    from erp_fiscal_unsigned.job j join erp_fiscal_signed.candidate c on c.unsigned_job_id=j.id where c.id=$1 and i.reservation_id=j.reservation_id`,[x.c.input.candidateId,literal,seconds]);}
   finally{await f.db.exec('alter table erp_fiscal_unsigned.identity enable trigger immutable_identity');}
  }
  const ledger=async()=>{
   const out={};for(const [schema,table]of [['erp_fiscal_authorization','policy'],['erp_fiscal_authorization','attempt'],['erp_fiscal_authorization','intent'],['erp_fiscal_authorization','command'],['erp_fiscal_authorization','request'],['erp_fiscal_authorization','result'],['erp_fiscal_authorization','audit'],['erp_fiscal_reviewed_authorization','review_binding'],['erp_fiscal_reviewed_authorization','observation']])
    out[schema+'.'+table]=(await f.db.query(`select coalesce(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text),'[]'::jsonb)v from ${schema}.${table} t`)).rows[0].v;
   return out;
  };
  return{...f,enable,fresh,ageIdentity:age,ledger,install080:()=>f.db.exec(migration080)};
 }catch(e){await f.close();throw e;}
}
