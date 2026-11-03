import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {bootstrap} from './helpers/stock-reservation-fixture.mjs';
import {prepareFiscalNfceEmissionWindowApply,prepareFiscalNfceEmissionWindowReadback,SOURCE_SHA256} from './prepare_nfce_emission_window_apply.mjs';
const helper='erp_fiscal_reviewed_authorization.check_nfce_emission_window(text,timestamptz)',guard='erp_fiscal_reviewed_authorization.guard_nfce_emission_window()';
test('080 applicator atomically adds only two private temporal helpers and two exact triggers',async t=>{
 const db=new PGlite(),scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;let audit;
 try{
  await db.exec(bootstrap);const root=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(root)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=79).sort();assert.equal(files.length,79);for(const file of files)await db.exec(await readFile(new URL(file,root),'utf8'));
  const user=randomUUID();await db.query('insert into auth.users values($1)',[user]);await db.query("insert into erp_access.membership(user_id,role)values($1,'admin')",[user]);
  await db.exec("create table erp_access.fixture080(id integer primary key,value text default 'KEEP');insert into erp_access.fixture080 values(1,'PRIVATE_SENTINEL');alter table erp_access.fixture080 enable row level security;create policy fixture_read on erp_access.fixture080 for select to authenticated using(false);grant select(value)on erp_access.fixture080 to authenticated;insert into storage.buckets(id,name,public)values('fixture080','fixture080',false);insert into storage.objects values('fixture080','PRIVATE_OBJECT','{}');");
  const sql=await prepareFiscalNfceEmissionWindowApply(),readback=await prepareFiscalNfceEmissionWindowReadback(),inject=v=>sql.replace('-- reviewed objects created',()=> '-- reviewed objects created\n '+v);
  const absent=async()=>{for(const f of[helper,guard])assert.equal(await scalar('select to_regprocedure($1)::text v',[f]),null);assert.equal(await scalar("select count(*)::int v from pg_trigger where tgrelid='erp_fiscal_authorization.attempt'::regclass and tgname in('reviewed_use_time_guard','reviewed_use_time_commit')"),0);assert.equal(await scalar('select value v from erp_access.fixture080 where id=1'),'PRIVATE_SENTINEL');};
  const enabledPolicy="insert into erp_fiscal_authorization.policy select (jsonb_populate_record(null::erp_fiscal_authorization.policy,to_jsonb(p)||jsonb_build_object('version',100,'enabled',true,'binding_reviewed',true,'valid_from',clock_timestamp()-interval'1 minute','valid_until',clock_timestamp()+interval'1 hour'))).* from erp_fiscal_authorization.policy p where model='55'and version=(select max(version)from erp_fiscal_authorization.policy where model='55');";
  const probes=[
   ['source pin',sql.replace('-- New reviewed NFC-e consumption only.','-- Changed new NFC-e consumption only.'),'22023','source_hash_mismatch'],
   ['dependency pin',sql.replace('"erp_fiscal_authorization.guard_attempt()":"','"erp_fiscal_authorization.guard_attempt()":"0'),'55000','previous_contract_changed'],
   ['old rows',inject("update erp_access.fixture080 set value='CHANGED';"),'40001','existing_data_changed'],
   ['auth rows',inject(`insert into auth.users values('${randomUUID()}');`),'40001','existing_data_changed'],
   ['storage rows',inject("update storage.objects set metadata='{\"changed\":true}'where bucket_id='fixture080';"),'40001','existing_data_changed'],
   ['policy row',inject(enabledPolicy),'40001','existing_data_changed'],
   ['unexpected table',inject('create table erp_access.unexpected080(id integer);'),'40001','table_inventory_changed'],
   ['old table grant',inject('grant select on erp_access.fixture080 to service_role;'),'42501','table_security_changed'],
   ['old column grant',inject('grant update(value)on erp_access.fixture080 to service_role;'),'42501','table_security_changed'],
   ['old RLS',inject('alter table erp_access.fixture080 disable row level security;'),'42501','table_security_changed'],
   ['old policy',inject('drop policy fixture_read on erp_access.fixture080;'),'42501','table_security_changed'],
   ['old column default',inject("alter table erp_access.fixture080 alter column value set default 'CHANGED';"),'42501','table_security_changed'],
   ['old constraint',inject('alter table erp_access.fixture080 add constraint new_constraint check(id>0);'),'42501','table_security_changed'],
   ['old index',inject('drop index origin_sync.raw_record_changed_idx;'),'42501','table_security_changed'],
   ['old schema ACL',inject('grant usage on schema erp_access to anon;'),'42501','schema_security_changed'],
   ['old defaults',inject('alter default privileges in schema erp_access grant select on tables to anon;'),'42501','default_privileges_changed'],
   ['old routine ACL',inject('grant execute on function public.erp_access_me(uuid)to anon;'),'40001','other_functions_changed'],
   ['helper public grant',inject(`grant execute on function ${helper} to authenticated;`),'42501','function_contract_failed'],
   ['helper delegation',inject(`grant execute on function ${guard} to service_role with grant option;`),'42501','function_contract_failed'],
   ['helper definer',inject(`alter function ${guard} security invoker;`),'42501','function_contract_failed'],
   ['helper search path',inject(`alter function ${helper} set search_path=public;`),'42501','function_contract_failed'],
   ['helper strictness',inject(`alter function ${helper} strict;`),'42501','function_contract_failed'],
   ['helper volatility',inject(`alter function ${helper} volatile;`),'42501','function_contract_failed'],
   ['unexpected routine',inject('create function public.erp_unexpected080()returns integer language sql as $$select 1$$;'),'40001','other_functions_changed'],
   ['old reviewed guard disabled',inject('alter table erp_fiscal_authorization.attempt disable trigger reviewed_use_guard;'),'42501','table_security_changed'],
   ['new before guard disabled',inject('alter table erp_fiscal_authorization.attempt disable trigger reviewed_use_time_guard;'),'40001','trigger_contract_failed'],
   ['new deferred guard disabled',inject('alter table erp_fiscal_authorization.attempt disable trigger reviewed_use_time_commit;'),'40001','trigger_contract_failed'],
   ['new trigger omitted',inject('drop trigger reviewed_use_time_commit on erp_fiscal_authorization.attempt;'),'40001','trigger_inventory_changed'],
   ['new predicate weakened',inject("drop trigger reviewed_use_time_guard on erp_fiscal_authorization.attempt;create trigger reviewed_use_time_guard before update of used_at on erp_fiscal_authorization.attempt for each row when(false)execute function erp_fiscal_reviewed_authorization.guard_nfce_emission_window();"),'40001','trigger_contract_failed'],
   ['deferred made immediate',inject("drop trigger reviewed_use_time_commit on erp_fiscal_authorization.attempt;create constraint trigger reviewed_use_time_commit after update on erp_fiscal_authorization.attempt deferrable initially immediate for each row when(old.used_at is null and new.used_at is not null)execute function erp_fiscal_reviewed_authorization.guard_nfce_emission_window();"),'40001','trigger_contract_failed'],
   ['unexpected sequence',inject('create sequence erp_access.unexpected080;'),'40001','other_catalog_changed'],
   ['unexpected type',inject("create type erp_access.unexpected080 as enum('value');"),'40001','other_catalog_changed'],
   ['unexpected view',inject('create view erp_access.unexpected080 as select 1 v;'),'40001','other_catalog_changed'],
  ];
  for(const[name,input,code,message]of probes)await t.test(name,async()=>{assert.notEqual(input,sql);try{await assert.rejects(db.exec(input),e=>e.code===code&&e.message.includes(message));}finally{await db.exec('rollback');}await absent();});
  await t.test('same-name overload refuses partial application',async()=>{try{await db.exec('begin;create function erp_fiscal_reviewed_authorization.guard_nfce_emission_window(integer)returns integer language sql as $$select $1$$;');await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('already_present'));}finally{await db.exec('rollback');}await absent();});
  await t.test('enabled policy refuses application',async()=>{try{await db.exec('begin;'+enabledPolicy);await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('fiscal_gate_not_closed'));}finally{await db.exec('rollback');}await absent();});
  await t.test('future enabled heads are refused even before their activation time',async()=>{try{await db.exec('begin;'+enabledPolicy.replace("clock_timestamp()-interval'1 minute'","clock_timestamp()+interval'1 second'"));await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('fiscal_gate_not_closed'));}finally{await db.exec('rollback');}await absent();});
  await t.test('enabled history with a disabled latest head is preserved',async()=>{await db.exec(enabledPolicy+"insert into erp_fiscal_authorization.policy select (jsonb_populate_record(null::erp_fiscal_authorization.policy,to_jsonb(p)||jsonb_build_object('version',101,'enabled',false))).*from erp_fiscal_authorization.policy p where model='55'and version=100;");});
  await t.test('success preserves all prior data/security and adds no table or RPC',async()=>{audit=(await db.exec(sql)).flatMap(x=>x.rows??[]).find(x=>x.fiscal_nfce_emission_window_apply_audit).fiscal_nfce_emission_window_apply_audit;assert.deepEqual(audit.before,audit.after);assert.equal(audit.source_sha256,SOURCE_SHA256);assert.equal(audit.protected_table_count,153);assert.equal(audit.new_service_only_rpcs,0);assert.equal(audit.new_private_helpers,2);assert.equal(audit.new_tables,0);assert.equal(audit.new_triggers,2);assert.equal(audit.fiscal_attempts,0);assert.equal(audit.enabled_heads,0);assert.equal(audit.historical_enabled_policies,1);assert.equal(audit.consumption_performed,false);assert.doesNotMatch(JSON.stringify(audit),/PRIVATE_SENTINEL|PRIVATE_OBJECT/);});
  await t.test('readonly readback matches old data/security/defaults/routines exactly',async()=>{const r=(await db.exec(readback)).flatMap(x=>x.rows??[]).find(x=>x.fiscal_nfce_emission_window_commit_readback).fiscal_nfce_emission_window_commit_readback;assert.deepEqual(r.rows,audit.after);for(const k of['table_security_sha256','schema_security_sha256','default_privileges_sha256','other_functions_sha256','other_catalog_sha256'])assert.equal(r[k],audit[k]);assert.equal(r.trigger_contracts_valid,true);});
  await t.test('both helpers remain closed to all client roles',async()=>{for(const role of['anon','authenticated','service_role'])for(const f of[helper,guard])assert.equal(await scalar("select has_function_privilege($1,$2,'EXECUTE')v",[role,f]),false);});
  await t.test('readback rejects later GRANT OPTION',async()=>{try{await db.exec(`grant execute on function ${guard} to service_role with grant option;`);await assert.rejects(db.exec(readback),e=>e.code==='42501'&&e.message.includes('function_contract_failed'));}finally{await db.exec(`rollback;revoke all on function ${guard} from service_role;`);}});
  await t.test('reapply refuses with no change',async()=>{try{await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('already_present'));}finally{await db.exec('rollback');}const r=(await db.exec(readback)).flatMap(x=>x.rows??[]).find(x=>x.fiscal_nfce_emission_window_commit_readback).fiscal_nfce_emission_window_commit_readback;assert.deepEqual(r.rows,audit.after);});
 }finally{await db.close();}
});
