import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {reviewedFixture} from './reviewed-ledger-fixture.mjs';
import {RULE_PROFILE_V1_HASH,RULE_PROFILE_V2_HASH} from '../src/rule-profile-registry.mjs';
import {projectResponse} from '../src/service-dto.mjs';
const migration=()=>readFile(new URL('../../../supabase/migrations/202610160077_fiscal_gtin_rule_profile_v2.sql',import.meta.url),'utf8');
const err=code=>e=>e.code===code;
test('077 preserves a consumed v1 request and exact historical proof across deployment and current changes',async t=>{
 const f=await reviewedFixture();try{
  await f.db.exec(await readFile(new URL('../../../supabase/migrations/202610160072_fiscal_reviewed_preflight.sql',import.meta.url),'utf8'));
  const version=await f.enable(),cases=[];
  for(const model of ['55','65']){const c=await f.candidate(model),proof=await f.review(c),b=await f.begin(c,version),p=await f.prepare(b,proof);await f.use(b,proof);cases.push({c,proof,b,p,finish:await f.finishArgs(b,p)});}
  const rows=(await f.db.query('select id,record_text,review_hash from erp_fiscal_subset_review.review order by id')).rows;await f.db.exec(await migration());
  assert.deepEqual((await f.db.query('select id,record_text,review_hash from erp_fiscal_subset_review.review order by id')).rows,rows);
  await f.disable();
  for(const x of cases)await t.test(x.c.stored.receipt.model+' finish/readback/replay retain v1 after v2 disabled seeds and changed A1',async()=>{
   const done=await f.wire('finish',x.finish);assert.equal(done.rule_review.profile_hash,RULE_PROFILE_V1_HASH);assert.equal(done.current.state,'authorized_homologation');assert.equal(done.current.a1_changed,true);
   const replay=await f.wire('finish',x.finish);assert.equal(replay.replayed,true);assert.deepEqual(replay.rule_review,x.proof);assert.deepEqual(replay.artifact,done.artifact);
   const a={p_user_id:f.users.fiscal,p_command_id:x.c.input.commandId};const command=await f.callSql('erp_fiscal_authorization_command',a);assert.doesNotThrow(()=>projectResponse('erp_fiscal_authorization_command',command,a));
   const ha={p_user_id:f.users.fiscal,p_candidate_id:x.c.input.candidateId,p_limit:25,p_before:null};const h=await f.callSql('erp_fiscal_authorization_history',ha);assert.doesNotThrow(()=>projectResponse('erp_fiscal_authorization_history',h,ha));
   assert.equal((await f.wire('command',a)).rule_review.profile_hash,RULE_PROFILE_V1_HASH);await assert.rejects(f.wire('command',{...a,p_user_id:f.users.admin}),err('42501'));
  });
  await t.test('new helpers private and latest is STABLE service-only; unknown/null profile cannot become current',async()=>{
   const rows=(await f.db.query("select p.proname,p.provolatile,p.prosecdef,has_function_privilege('anon',p.oid,'execute')anon,has_function_privilege('authenticated',p.oid,'execute')authenticated,has_function_privilege('service_role',p.oid,'execute')service from pg_proc p join pg_namespace n on n.oid=p.pronamespace where(n.nspname='public'and p.proname='erp_fiscal_subset_review_latest')or(n.nspname='erp_fiscal_subset_review'and p.proname in('profile_definition','current_profile_hash'))or(n.nspname='erp_fiscal_reviewed_authorization'and p.proname='manifest'and p.pronargs=2)")).rows;assert.equal(rows.length,4);for(const r of rows){assert.equal(r.anon,false);assert.equal(r.authenticated,false);assert.equal(r.service,r.proname==='erp_fiscal_subset_review_latest');if(r.service){assert.equal(r.provolatile,'s');assert.equal(r.prosecdef,true);}}
   for(const value of [null,'','f'.repeat(64)])await assert.rejects(f.db.query('select erp_fiscal_subset_review.profile_definition($1)',[value]),err('22023'));
   assert.equal((await f.db.query('select erp_fiscal_subset_review.current_profile_hash()v')).rows[0].v,RULE_PROFILE_V2_HASH);
  });
 }finally{await f.close();}
});
