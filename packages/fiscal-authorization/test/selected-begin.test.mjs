import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {preflightFixture,query,hash} from './preflight-fixture.mjs';
import {createReviewedAuthorizationRpc} from '../src/reviewed-ledger-rpc.mjs';
const RPC='erp_fiscal_reviewed_authorization_begin_selected';
const reject=(fn,code)=>assert.rejects(fn,e=>e.code===code);
export const selectedArgs=(c,proof,policy)=>({p_user_id:c.input.actor,p_command_id:c.input.commandId,p_candidate_id:c.input.candidateId,p_signed_hash:c.input.signedHash,p_expected_identity_version:1,p_expected_a1_version:2,p_expected_policy_version:policy,p_confirmed:true,p_expected_candidate_version:proof.candidate_version,p_expected_review_id:proof.review_id,p_expected_review_version:proof.review_version,p_expected_review_hash:proof.review_hash,p_expected_facts_hash:proof.facts_hash,p_expected_profile_hash:proof.profile_hash,p_rule_review:proof});
const counts=async f=>(await f.db.query('select (select count(*)::int from erp_fiscal_authorization.command) commands,(select count(*)::int from erp_fiscal_authorization.attempt) attempts,(select count(*)::int from erp_fiscal_authorization.intent) intents,(select count(*)::int from erp_fiscal_reviewed_authorization.review_binding) bindings,(select count(*)::int from erp_fiscal_authorization.request) requests,(select count(*)::int from erp_fiscal_authorization.audit) audits')).rows[0];
test('073 atomic selection through real SQL and HTTP adapter',{timeout:60000},async t=>{
 const f=await preflightFixture();try{
  const before=(await f.db.query("select oid,prosrc from pg_proc where proname like'erp_%'or pronamespace in(select oid from pg_namespace where nspname like'erp_%')order by oid")).rows;
  await f.db.exec(await readFile(new URL('../../../supabase/migrations/202610160073_fiscal_reviewed_begin_selection.sql',import.meta.url),'utf8'));
  const policy=await f.enable();
  await t.test('one service-only function, no replacement or new table/policy',async()=>{
   const after=(await f.db.query("select oid,prosrc from pg_proc where proname like'erp_%'or pronamespace in(select oid from pg_namespace where nspname like'erp_%')order by oid")).rows;assert.equal(after.length,before.length+1);assert.deepEqual(after.filter(x=>before.some(b=>b.oid===x.oid)),before);
   const acl=(await f.db.query("select prosecdef,proconfig,has_function_privilege('anon',oid,'EXECUTE') anon,has_function_privilege('authenticated',oid,'EXECUTE') authenticated,has_function_privilege('service_role',oid,'EXECUTE') service from pg_proc where proname=$1",[RPC])).rows[0];assert.deepEqual(acl,{prosecdef:true,proconfig:['search_path=pg_catalog'],anon:false,authenticated:false,service:true});
  });
  for(const model of ['55','65'])await t.test(model+' binds the evaluated backend review before request bytes or consumption',async()=>{
   const c=await f.candidate(model);await f.review(c);const selected=await f.preflight({enabled:true}).select(query(c),f.opts()),args=selectedArgs(c,selected.proof,policy),v=await f.rpc(RPC,args,f.opts());
   assert.equal(v.replayed,false);assert.deepEqual(v.rule_review,selected.proof);assert.equal(v.current.state,'prepared');assert.equal(v.current.grant_consumed,false);assert.equal(v.recovery.request_hash,null);
   const b=(await f.db.query('select proof from erp_fiscal_reviewed_authorization.review_binding where attempt_id=$1',[v.receipt.attempt_id])).rows;assert.equal(b.length,1);assert.deepEqual(b[0].proof,selected.proof);
  });
  await t.test('CAS mismatch and forged proof roll back the newly created intent, command, attempt and audit',async()=>{
   const c=await f.candidate(),proof=await f.review(c),args=selectedArgs(c,proof,policy),before=await counts(f);
   await reject(()=>f.callSql(RPC,{...args,p_expected_review_hash:hash('other')}),'40001');assert.deepEqual(await counts(f),before);
   const forged={...proof,reviewed_by:f.users.admin};await reject(()=>f.callSql(RPC,{...args,p_rule_review:forged}),'40001');assert.deepEqual(await counts(f),before);
   for(const key of ['p_expected_candidate_version','p_expected_review_id','p_expected_review_version','p_expected_profile_hash'])await reject(()=>f.callSql(RPC,{...args,[key]:null}),'22023');assert.deepEqual(await counts(f),before);
  });
  await t.test('lost begin ACK/crash preserves exactly one binding; same UUID rejects a different displayed review',async()=>{
   const c=await f.candidate(),proof=await f.review(c),args=selectedArgs(c,proof,policy);let calls=0;
   const lossy=createReviewedAuthorizationRpc({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-test-service-key-only',fetchImpl:async(url,o)=>{calls++;await f.http(url,o);throw Error('lost ACK');}});
   await reject(()=>lossy(RPC,args,f.opts()),'AUTHORIZATION_RPC_IO_FAILED');assert.equal(calls,1);
   const current=await f.wire('command',{p_user_id:c.input.actor,p_command_id:c.input.commandId});assert.deepEqual(current.rule_review,proof);const before=await counts(f);
   const replay=await f.rpc(RPC,args,f.opts());assert.equal(replay.replayed,true);assert.equal(replay.receipt.attempt_id,current.receipt.attempt_id);assert.deepEqual(await counts(f),before);
   const newer=await f.review(c,{p_command_id:randomUUID(),p_expected_review_version:1});await reject(()=>f.rpc(RPC,selectedArgs(c,newer,policy),f.opts()),'40001');assert.deepEqual(await counts(f),before);
   await reject(()=>f.prepare({value:replay},proof),'40001');
  });
  await t.test('revoked reviewer rejects a fresh selection atomically and actor ACL is checked on replay',async()=>{
   const c=await f.candidate(),proof=await f.review(c,{p_user_id:f.users.admin}),args=selectedArgs(c,proof,policy),before=await counts(f);
   await f.db.query('update erp_access.membership set active=false where user_id=$1',[f.users.admin]);try{await reject(()=>f.rpc(RPC,args,f.opts()),'42501');assert.deepEqual(await counts(f),before);}finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[f.users.admin]);}
   await f.rpc(RPC,args,f.opts());await f.db.query('update erp_access.membership set active=false where user_id=$1',[c.input.actor]);try{await reject(()=>f.rpc(RPC,args,f.opts()),'42501');}finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[c.input.actor]);}
  });
  await t.test('an old command without a selected binding cannot be adopted by the new begin',async()=>{
   const c=await f.candidate(),proof=await f.review(c);await f.begin(c,policy);const before=await counts(f);await reject(()=>f.rpc(RPC,selectedArgs(c,proof,policy),f.opts()),'40001');assert.deepEqual(await counts(f),before);
  });
  await t.test('terminal selected replay and command stay historical after latest review and policy change',async()=>{
   const c=await f.candidate(),proof=await f.review(c),args=selectedArgs(c,proof,policy),v=await f.rpc(RPC,args,f.opts());await f.wire('fail',{p_user_id:c.input.actor,p_attempt_id:v.receipt.attempt_id,p_lease_id:v.recovery.lease_id,p_error_code:'PREPARATION_FAILED'});
   await f.review(c,{p_command_id:randomUUID(),p_expected_review_version:1});await f.enable('operational',false);const before=await counts(f);
   const replay=await f.rpc(RPC,args,f.opts());assert.equal(replay.execution,null);assert.equal(replay.current.state,'failed_before_dispatch');assert.deepEqual(replay.rule_review,proof);assert.deepEqual(await counts(f),before);
  });
 }finally{await f.close();}
});
