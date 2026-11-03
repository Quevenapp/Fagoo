import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {closureFixture,hash,CLOSE,GET,BEGIN} from './expired-closure-fixture.mjs';
import {projectResponse} from '../src/service-dto.mjs';
const reject=(fn,code)=>assert.rejects(fn,e=>e.code===code);
const rows=(f,sql,args=[])=>f.db.query(sql,args).then(x=>x.rows);
const inventory=f=>rows(f,"select n.nspname,p.proname,p.oid,pg_get_functiondef(p.oid) def,p.proacl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where(n.nspname like'erp_%'or(n.nspname='public'and p.proname like'erp_%'))and p.prokind='f'order by p.oid");
const history=async(f,x)=>{
 const a=x.b.value.receipt.attempt_id;
 return{
  command:await rows(f,'select to_jsonb(c) v from erp_fiscal_authorization.command c where attempt_id=$1',[a]),
  request:await rows(f,'select to_jsonb(r) v from erp_fiscal_authorization.request r where attempt_id=$1',[a]),
  binding:await rows(f,'select to_jsonb(r) v from erp_fiscal_reviewed_authorization.review_binding r where attempt_id=$1',[a]),
  review:await rows(f,'select to_jsonb(r) v from erp_fiscal_subset_review.review r where id=$1',[x.proof.review_id]),
  intent:await rows(f,'select to_jsonb(i) v from erp_fiscal_authorization.intent i where id=$1',[x.b.value.receipt.intent_id])
 };
};
const counts=f=>rows(f,`select (select count(*)::int from erp_fiscal_authorization.attempt) attempts,
 (select count(*)::int from erp_fiscal_authorization.command) commands,
 (select count(*)::int from erp_fiscal_authorization_closure.command) closures,
 (select count(*)::int from erp_fiscal_authorization.audit where action='consume') consumes,
 (select count(*)::int from erp_fiscal_authorization.audit where action='fail') failures,
 (select count(*)::int from erp_fiscal_authorization.result) results,
 (select count(*)::int from erp_fiscal_reviewed_authorization.observation) observations`);

test('074 explicit expired closure, local SQL through existing050/068/069/073',{timeout:90000},async t=>{
 let oldFunctions,oldPolicies;
 const f=await closureFixture({beforeMigration:async f=>{oldFunctions=await inventory(f);oldPolicies=await rows(f,'select to_jsonb(p) v from erp_fiscal_authorization.policy p order by model,version');}});
 try{
  await t.test('additive private table/helper and two service-only RPCs, no old function or policy changes',async()=>{
   const current=await inventory(f);assert.deepEqual(current.filter(x=>oldFunctions.some(y=>y.oid===x.oid)),oldFunctions);assert.equal(current.length,oldFunctions.length+3);
   const policies=await rows(f,'select to_jsonb(p) v from erp_fiscal_authorization.policy p order by model,version');assert.deepEqual(policies.filter(x=>oldPolicies.some(y=>y.v.model===x.v.model&&y.v.version===x.v.version)),oldPolicies);
   const acl=await rows(f,"select proname,prosecdef,proconfig,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') authenticated,has_function_privilege('service_role',oid,'execute') service from pg_proc where proname=any($1)",[[CLOSE,GET]]);
   assert.equal(acl.length,2);assert.ok(acl.every(x=>x.prosecdef&&!x.anon&&!x.authenticated&&x.service&&x.proconfig[0]==='search_path=pg_catalog'));
   for(const role of ['anon','authenticated','service_role']){
    assert.equal((await rows(f,"select has_schema_privilege($1,'erp_fiscal_authorization_closure','usage') v",[role]))[0].v,false);
    assert.equal((await rows(f,"select has_table_privilege($1,'erp_fiscal_authorization_closure.command','select,insert,update,delete') v",[role]))[0].v,false);
   }
   assert.equal((await rows(f,"select relrowsecurity from pg_class where oid='erp_fiscal_authorization_closure.command'::regclass"))[0].relrowsecurity,true);
  });
  for(const model of ['55','65'])for(const prepared of [false,true])await t.test(model+' closes expired '+(prepared?'request_ready':'prepared')+' with immutable selected history and no grant',async()=>{
   const x=await f.start(model,{prepared});await reject(()=>f.closeAttempt(x),'40001');await f.age(x.b.args.p_command_id);
   const before=await history(f,x),n=(await counts(f))[0],v=await f.closeAttempt(x);
   assert.equal(v.receipt.previous_state,prepared?'request_ready':'prepared');assert.equal(v.receipt.reason,'LEASE_EXPIRED_UNCONSUMED');assert.equal(v.receipt.review_id,x.proof.review_id);assert.equal(v.receipt.origin,'operational');assert.equal(v.receipt.request_hash,x.args.p_expected_request_hash);
   assert.deepEqual(v.current,{state:'failed_before_dispatch',grant_consumed:false,finished_at:v.receipt.closed_at,successor_exists:false,intent_consumed:false});
   for(const k of ['tax_rules_validated','can_emit','can_transmit','production_authorized','legal_fiscal_value','retry_submission_allowed','financial_mutation_performed','stock_mutation_performed'])assert.equal(v[k],false);
   assert.ok(!('recovery'in v)&&!('execution'in v)&&!('artifact'in v));assert.ok(Buffer.byteLength(JSON.stringify(v))<4096);
   assert.deepEqual(await history(f,x),before);assert.deepEqual((await counts(f))[0],{...n,closures:n.closures+1,failures:n.failures+1});
   const replay=await f.closeAttempt(x);assert.equal(replay.replayed,true);assert.deepEqual(replay.receipt,v.receipt);assert.deepEqual((await f.lookup(x)).receipt,v.receipt);
   await reject(()=>f.closeAttempt(x,{p_command_id:randomUUID()}),'40001');
   const raw=await f.callSql('erp_fiscal_authorization_command',{p_user_id:x.args.p_user_id,p_command_id:x.b.args.p_command_id});
   assert.equal(projectResponse('erp_fiscal_authorization_command',raw,{p_user_id:x.args.p_user_id,p_command_id:x.b.args.p_command_id}).current.state,'failed_before_dispatch');
   const reviewed=await f.wire('command',{p_user_id:x.args.p_user_id,p_command_id:x.b.args.p_command_id});assert.deepEqual(reviewed.rule_review,x.proof);assert.equal(reviewed.error_code,'PREPARATION_FAILED');
   const page=await f.wire('history',{p_user_id:f.users.admin,p_candidate_id:x.c.input.candidateId,p_limit:25,p_before:null});assert.deepEqual(page.items[0].rule_review,x.proof);assert.equal(page.items[0].recoverable_by_actor,false);
   await reject(()=>f.use(x.b,x.proof),'40001');
   const oldReplay=await f.rpc(BEGIN,x.b.args,f.opts());assert.equal(oldReplay.execution,null);assert.deepEqual(oldReplay.rule_review,x.proof);
  });
  await t.test('invalid confirmation/CAS and body changes refuse without a closure or fail audit',async()=>{
   const x=await f.start('55',{prepared:true});await f.age(x.b.args.p_command_id);const before=await counts(f);
   for(const patch of [{p_confirmed:false},{p_confirmed:null},{p_command_id:null},{p_command_id:x.b.args.p_command_id},{p_expected_state:null},{p_expected_state:'dispatched'},{p_expected_request_hash:null},{p_expected_request_hash:'A'.repeat(64)}])await reject(()=>f.closeAttempt(x,patch),'22023');
   for(const patch of [{p_expected_attempt_id:randomUUID()},{p_expected_request_hash:hash('wrong')},{p_expected_state:'prepared',p_expected_request_hash:null}])await reject(()=>f.closeAttempt(x,patch),'40001');assert.deepEqual(await counts(f),before);
   await f.closeAttempt(x);await reject(()=>f.closeAttempt(x,{p_expected_request_hash:hash('different replay')}),'40001');await reject(()=>f.closeAttempt(x,{p_expected_attempt_id:randomUUID()}),'40001');
  });
  await t.test('same actor only; role loss blocks write/replay/GET and foreign actors cannot close',async()=>{
   const x=await f.start();await f.age(x.b.args.p_command_id);const before=await counts(f);
   await reject(()=>f.closeAttempt(x,{p_user_id:f.users.admin}),'42501');
   await f.db.query("update erp_access.membership set role='consulta'where user_id=$1",[x.args.p_user_id]);try{await reject(()=>f.closeAttempt(x),'42501');}finally{await f.db.query("update erp_access.membership set role='fiscal'where user_id=$1",[x.args.p_user_id]);}
   assert.deepEqual(await counts(f),before);await f.closeAttempt(x);
   await reject(()=>f.lookup(x,{p_user_id:f.users.admin}),'42501');await f.db.query('update erp_access.membership set active=false where user_id=$1',[x.args.p_user_id]);try{await reject(()=>f.lookup(x),'42501');await reject(()=>f.closeAttempt(x),'42501');}finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[x.args.p_user_id]);}
  });
  await t.test('ACK loss is resolved by GET and immutable closure remains separate from a later attempt',async()=>{
   const x=await f.start();await f.age(x.b.args.p_command_id);const before=(await counts(f))[0];
   await assert.rejects(async()=>{await f.closeAttempt(x);throw Error('lost local ACK');});const got=await f.lookup(x);assert.equal(got.read_only,true);
   const successor=await f.rpc(BEGIN,{...x.b.args,p_command_id:randomUUID()},f.opts());assert.notEqual(successor.receipt.attempt_id,x.b.value.receipt.attempt_id);
   const p=await f.prepare({value:successor},x.proof);assert.equal(p.value.current.state,'request_ready');await f.use({value:successor},x.proof);
   const now=await f.lookup(x);assert.deepEqual(now.receipt,got.receipt);assert.equal(now.current.successor_exists,true);assert.equal(now.current.intent_consumed,true);assert.equal(now.current.grant_consumed,false);
   assert.deepEqual((await f.closeAttempt(x)).receipt,got.receipt);assert.equal((await counts(f))[0].closures,before.closures+1);
   await reject(()=>f.lookup(x,{p_command_id:randomUUID()}),'P0002');
  });
  await t.test('consumed, uncertain, receipt pending and terminal attempts cannot be closed',async()=>{
   const x=await f.start('65',{prepared:true});await f.use(x.b,x.proof);await f.age(x.b.args.p_command_id);let before=await counts(f);await reject(()=>f.closeAttempt(x),'40001');assert.deepEqual(await counts(f),before);
   await f.wire('fail',{...f.ids(x.b),p_error_code:'TRANSPORT_UNCONFIRMED'});before=await counts(f);await reject(()=>f.closeAttempt(x),'40001');assert.deepEqual(await counts(f),before);
   // Owner-only fixture state changes test every excluded terminal value. No RPC can set these from an unused attempt.
   for(const state of ['receipt_pending','rejected','review_required','authorization_observed','authorized_homologation']){
    await f.db.exec('alter table erp_fiscal_authorization.attempt disable trigger guard_attempt');try{await f.db.query('update erp_fiscal_authorization.attempt set state=$2 where id=$1',[x.b.value.receipt.attempt_id,state]);}finally{await f.db.exec('alter table erp_fiscal_authorization.attempt enable trigger guard_attempt');}
    await reject(()=>f.closeAttempt(x),'40001');assert.deepEqual(await counts(f),before);
   }
   const unused=await f.start();await f.wire('fail',{...f.ids(unused.b),p_error_code:'PREPARATION_FAILED'});await f.age(unused.b.args.p_command_id);await reject(()=>f.closeAttempt(unused),'40001');
  });
  await t.test('storage request and073 binding remain if closure receipt persistence fails atomically',async()=>{
   const x=await f.start('55',{prepared:true});await f.age(x.b.args.p_command_id);const before=await counts(f),immutable=await history(f,x);
   await f.db.exec("create function public.fixture_closure_reject()returns trigger language plpgsql as $$begin raise exception'fixture persistence failure'using errcode='40001';end$$;create trigger fixture_closure_reject before insert on erp_fiscal_authorization_closure.command for each row execute function public.fixture_closure_reject();");
   try{await reject(()=>f.closeAttempt(x),'40001');}finally{await f.db.exec('drop trigger fixture_closure_reject on erp_fiscal_authorization_closure.command;drop function public.fixture_closure_reject();');}
   assert.deepEqual(await counts(f),before);assert.deepEqual(await history(f,x),immutable);assert.equal((await f.wire('command',{p_user_id:x.args.p_user_id,p_command_id:x.b.args.p_command_id})).current.state,'request_ready');
   await f.closeAttempt(x);await reject(()=>f.db.query('delete from erp_fiscal_authorization_closure.command where id=$1',[x.args.p_command_id]),'42501');await reject(()=>f.db.query('update erp_fiscal_authorization_closure.command set receipt=$2 where id=$1',[x.args.p_command_id,{}]),'42501');
  });
  await t.test('legacy profile is not eligible; original069 prepared without a binding can close without inventing one',async()=>{
   const x=await f.start('55',{selected:false});assert.equal(x.b.value.rule_review,null);await f.age(x.b.args.p_command_id);assert.equal((await f.closeAttempt(x)).receipt.review_id,null);
   const c=await f.candidate();const version=Number((await rows(f,'select max(version)+1 v from erp_fiscal_authorization.policy'))[0].v);
   await f.db.query("insert into erp_fiscal_authorization.policy(model,version,origin,enabled,binding_profile,rule_profile,binding_reviewed,tax_rules_reviewed,source_manifest_hash,valid_from,valid_until)values('55',$1,'synthetic',true,'synthetic-authorization-binding','synthetic-rules-only',false,false,$2,clock_timestamp()-interval'1day',clock_timestamp()+interval'1day')",[version,hash('legacy closure fixture')]);
   const a={...x.b.args,p_command_id:randomUUID(),p_candidate_id:c.input.candidateId,p_signed_hash:c.input.signedHash,p_expected_policy_version:version};const b=await f.callSql('erp_fiscal_authorization_begin',a);await f.age(a.p_command_id);
   await reject(()=>f.callSql(CLOSE,{...x.args,p_command_id:randomUUID(),p_authorization_command_id:a.p_command_id,p_expected_attempt_id:b.receipt.attempt_id}),'22023');f.setPolicy(await f.enable());
  });
  await t.test('expired closure and historical reads need neither current review, enabled policy, current A1 nor current basis',async()=>{
   const x=await f.start('65',{prepared:true});await f.age(x.b.args.p_command_id);const pinned=await history(f,x);await f.review(x.c,{p_command_id:randomUUID(),p_expected_review_version:1});await f.enable('operational',false);
   const current=await f.callSql('erp_a1_metadata',{p_user_id:f.users.admin});const cmd=randomUUID();await f.callSql('erp_a1_disable',{p_user_id:f.users.admin,p_command_id:cmd,p_request_hash:hash(cmd),p_expected_version:current.current.version,p_reason:'TESTE LOCAL SEM USO DO CERTIFICADO'});
   const draftId=(await rows(f,'select j.draft_id from erp_fiscal_unsigned.job j join erp_fiscal_signed.candidate c on c.unsigned_job_id=j.id where c.id=$1',[x.c.input.candidateId]))[0].draft_id;
   await f.callSql('erp_fiscal_draft_execute',{p_user_id:f.users.fiscal,p_command_id:randomUUID(),p_action:'archive',p_data:{id:draftId,expected_version:1,reason:'TESTE LOCAL DE HISTORICO'}});
   const v=await f.closeAttempt(x);assert.deepEqual(await history(f,x),pinned);assert.equal(v.receipt.review_id,x.proof.review_id);assert.deepEqual((await f.lookup(x)).receipt,v.receipt);assert.deepEqual((await f.closeAttempt(x)).receipt,v.receipt);
   assert.deepEqual((await f.wire('command',{p_user_id:x.args.p_user_id,p_command_id:x.b.args.p_command_id})).rule_review,x.proof);
  });
  await t.test('no financial/stock effects or active policies introduced by closure',async()=>{
   for(const table of ['erp_finance.title','erp_finance.movement','erp_stock.movement'])assert.equal((await rows(f,`select count(*)::int n from ${table}`))[0].n,0);
   assert.equal((await rows(f,"select count(*)::int n from erp_fiscal_authorization_closure.command c join erp_fiscal_authorization.attempt a on a.id=c.attempt_id where a.used_at is not null or a.state<>'failed_before_dispatch'"))[0].n,0);
  });
 }finally{await f.close();}
});
