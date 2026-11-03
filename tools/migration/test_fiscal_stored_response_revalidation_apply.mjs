import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {bootstrap} from './helpers/stock-reservation-fixture.mjs';
import {prepareFiscalStoredResponseRevalidationApply,prepareFiscalStoredResponseRevalidationReadback,SOURCE_SHA256} from './prepare_fiscal_stored_response_revalidation_apply.mjs';
const writeRpc='public.erp_fiscal_reviewed_authorization_revalidation_finish(uuid,uuid,uuid,uuid,text,text,text,jsonb,text,integer,boolean)',readRpc='public.erp_fiscal_reviewed_authorization_revalidation_command(uuid,uuid)',contextRpc='public.erp_fiscal_reviewed_authorization_revalidation_context(uuid,uuid,uuid)',helper='erp_fiscal_authorization_revalidation.view(erp_fiscal_authorization_revalidation.command)',table='erp_fiscal_authorization_revalidation.command';
test('079 applicator atomically adds only an empty private ledger and three closed RPC contracts',async t=>{
 const db=new PGlite(),scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;let audit;
 try{
  await db.exec(bootstrap);const root=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(root)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=78).sort();assert.equal(files.length,78);for(const file of files)await db.exec(await readFile(new URL(file,root),'utf8'));
  const user=randomUUID();await db.query('insert into auth.users values($1)',[user]);await db.query("insert into erp_access.membership(user_id,role)values($1,'admin')",[user]);
  await db.exec("create table erp_access.fixture079(id integer primary key,value text default 'KEEP');insert into erp_access.fixture079 values(1,'PRIVATE_SENTINEL');alter table erp_access.fixture079 enable row level security;create policy fixture_read on erp_access.fixture079 for select to authenticated using(false);grant select(value)on erp_access.fixture079 to authenticated;insert into storage.buckets(id,name,public)values('fixture079','fixture079',false);insert into storage.objects values('fixture079','PRIVATE_OBJECT','{}');");
  const sql=await prepareFiscalStoredResponseRevalidationApply(),readback=await prepareFiscalStoredResponseRevalidationReadback(),inject=v=>sql.replace('-- reviewed objects created',()=> '-- reviewed objects created\n '+v);
  const absent=async()=>{assert.equal(await scalar("select to_regnamespace('erp_fiscal_authorization_revalidation')::text v"),null);for(const f of[writeRpc,readRpc,contextRpc])assert.equal(await scalar('select to_regprocedure($1)::text v',[f]),null);assert.equal(await scalar('select value v from erp_access.fixture079 where id=1'),'PRIVATE_SENTINEL');};
  const enabledPolicy="insert into erp_fiscal_authorization.policy select (jsonb_populate_record(null::erp_fiscal_authorization.policy,to_jsonb(p)||jsonb_build_object('version',100,'enabled',true,'binding_reviewed',true,'valid_from',clock_timestamp()-interval'1 minute','valid_until',clock_timestamp()+interval'1 hour'))).* from erp_fiscal_authorization.policy p where model='55'and version=(select max(version)from erp_fiscal_authorization.policy where model='55');";
  const probes=[
   ['source pin',sql.replace('-- Revalidate stored SOAP bytes.','-- Changed stored SOAP bytes.'),'22023','source_hash_mismatch'],
   ['dependency pin',sql.replace('"erp_a1.access(uuid,boolean)":"','"erp_a1.access(uuid,boolean)":"0'),'55000','previous_contract_changed'],
   ['old rows',inject("update erp_access.fixture079 set value='CHANGED';"),'40001','existing_data_changed'],
   ['auth rows',inject(`insert into auth.users values('${randomUUID()}');`),'40001','existing_data_changed'],
   ['storage rows',inject("update storage.objects set metadata='{\"changed\":true}'where bucket_id='fixture079';"),'40001','existing_data_changed'],
   ['policy row',inject(enabledPolicy),'40001','existing_data_changed'],
   ['unexpected table',inject('create table erp_access.unexpected079(id integer);'),'40001','table_inventory_changed'],
   ['old table grant',inject('grant select on erp_access.fixture079 to service_role;'),'42501','table_security_changed'],
   ['old column grant',inject('grant update(value)on erp_access.fixture079 to service_role;'),'42501','table_security_changed'],
   ['old RLS',inject('alter table erp_access.fixture079 disable row level security;'),'42501','table_security_changed'],
   ['old policy',inject('drop policy fixture_read on erp_access.fixture079;'),'42501','table_security_changed'],
   ['old column default',inject("alter table erp_access.fixture079 alter column value set default 'CHANGED';"),'42501','table_security_changed'],
   ['old constraint',inject('alter table erp_access.fixture079 add constraint new_constraint check(id>0);'),'42501','table_security_changed'],
   ['old index',inject('drop index origin_sync.raw_record_changed_idx;'),'42501','table_security_changed'],
   ['old schema ACL',inject('grant usage on schema erp_access to anon;'),'42501','schema_security_changed'],
   ['old defaults',inject('alter default privileges in schema erp_access grant select on tables to anon;'),'42501','default_privileges_changed'],
   ['old routine ACL',inject('grant execute on function public.erp_access_me(uuid)to anon;'),'40001','other_functions_changed'],
   ['new RPC public grant',inject(`grant execute on function ${writeRpc} to authenticated;`),'42501','function_contract_failed'],
   ['new RPC delegation',inject(`grant execute on function ${readRpc} to service_role with grant option;`),'42501','function_contract_failed'],
   ['new helper grant',inject(`grant execute on function ${helper} to service_role;`),'42501','function_contract_failed'],
   ['new RPC definer',inject(`alter function ${writeRpc} security invoker;`),'42501','function_contract_failed'],
   ['new RPC search path',inject(`alter function ${readRpc} set search_path=public;`),'42501','function_contract_failed'],
   ['new RPC strictness',inject(`alter function ${writeRpc} strict;`),'42501','function_contract_failed'],
   ['unexpected routine',inject('create function public.erp_unexpected079()returns integer language sql as $$select 1$$;'),'40001','other_functions_changed'],
   ['new schema grant',inject('grant usage on schema erp_fiscal_authorization_revalidation to service_role;'),'42501','private_schema_failed'],
   ['new schema defaults',inject('alter default privileges in schema erp_fiscal_authorization_revalidation grant execute on functions to authenticated;'),'42501','private_schema_failed'],
   ['new table must be empty',inject(`set session_replication_role=replica;insert into ${table}(id,actor,request_hash,attempt_id,parser_profile,parser_manifest_hash,source_hash,source,receipt)values('${randomUUID()}','${user}','${'a'.repeat(64)}','${randomUUID()}','test','${'b'.repeat(64)}','${'c'.repeat(64)}','{}','{}');set session_replication_role=origin;`),'40001','new_table_not_empty'],
   ['new table grant',inject(`grant select on ${table} to service_role;`),'42501','private_table_failed'],
   ['new column grant',inject(`grant select(receipt)on ${table} to service_role;`),'42501','private_table_failed'],
   ['new table RLS',inject(`alter table ${table} disable row level security;`),'42501','private_table_failed'],
   ['new table policy',inject(`create policy public_read on ${table} for select using(true);`),'42501','private_table_failed'],
   ['new column default',inject(`alter table ${table} alter column created_at set default now();`),'40001','table_contract_failed'],
   ['new column nullable',inject(`alter table ${table} alter column receipt drop not null;`),'40001','table_contract_failed'],
   ['new constraint',inject(`alter table ${table} drop constraint command_request_hash_check;`),'40001','table_contract_failed'],
   ['new index',inject(`create index unexpected079 on ${table}(created_at);`),'40001','table_contract_failed'],
   ['new immutable trigger',inject(`alter table ${table} disable trigger immutable;`),'40001','table_contract_failed'],
   ['unexpected sequence',inject('create sequence erp_fiscal_authorization_revalidation.unexpected;'),'40001','table_contract_failed'],
   ['unexpected type',inject("create type erp_fiscal_authorization_revalidation.unexpected as enum('value');"),'40001','table_contract_failed'],
  ];
  for(const[name,input,code,message]of probes)await t.test(name,async()=>{assert.notEqual(input,sql);try{await assert.rejects(db.exec(input),e=>e.code===code&&e.message.includes(message));}finally{await db.exec('rollback');}await absent();});
  await t.test('same-name overload refuses partial application',async()=>{try{await db.exec('begin;create function public.erp_fiscal_reviewed_authorization_revalidation_command(integer)returns integer language sql as $$select $1$$;');await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('already_present'));}finally{await db.exec('rollback');}await absent();});
  await t.test('enabled policy refuses application',async()=>{try{await db.exec('begin;'+enabledPolicy);await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('fiscal_gate_not_closed'));}finally{await db.exec('rollback');}await absent();});
  await t.test('a future enabled head becoming effective during apply also rolls back',async()=>{try{await db.exec('begin;'+enabledPolicy.replace("clock_timestamp()-interval'1 minute'","clock_timestamp()+interval'1 second'"));await assert.rejects(db.exec(inject('perform pg_sleep(1.1);')),e=>e.code==='55000'&&e.message.includes('fiscal_gate_not_closed'));}finally{await db.exec('rollback');}await absent();});
  await t.test('enabled history with a disabled latest head is preserved',async()=>{await db.exec(enabledPolicy+"insert into erp_fiscal_authorization.policy select (jsonb_populate_record(null::erp_fiscal_authorization.policy,to_jsonb(p)||jsonb_build_object('version',101,'enabled',false))).*from erp_fiscal_authorization.policy p where model='55'and version=100;");});
  await t.test('success preserves data and security while adding empty closed schema',async()=>{audit=(await db.exec(sql)).flatMap(x=>x.rows??[]).find(x=>x.fiscal_stored_response_revalidation_apply_audit).fiscal_stored_response_revalidation_apply_audit;assert.deepEqual(audit.before,audit.after);assert.equal(audit.source_sha256,SOURCE_SHA256);assert.equal(audit.protected_table_count,152);assert.equal(audit.new_service_only_rpcs,3);assert.equal(audit.new_private_helpers,6);assert.equal(audit.new_tables,1);assert.equal(audit.fiscal_attempts,0);assert.equal(audit.effective_enabled_heads,0);assert.equal(audit.historical_enabled_policies,1);assert.equal(audit.revalidations_created,0);assert.doesNotMatch(JSON.stringify(audit),/PRIVATE_SENTINEL|PRIVATE_OBJECT/);});
  await t.test('readonly readback matches old data/security/defaults/routines exactly',async()=>{const r=(await db.exec(readback)).flatMap(x=>x.rows??[]).find(x=>x.fiscal_stored_response_revalidation_commit_readback).fiscal_stored_response_revalidation_commit_readback;assert.deepEqual(r.rows,audit.after);for(const k of['table_security_sha256','schema_security_sha256','default_privileges_sha256','other_functions_sha256'])assert.equal(r[k],audit[k]);assert.equal(r.new_table_empty,true);});
  await t.test('new table stays owner-only and only service role may call three RPCs',async()=>{for(const role of['anon','authenticated','service_role']){for(const f of[writeRpc,readRpc,contextRpc])assert.equal(await scalar("select has_function_privilege($1,$2,'EXECUTE')v",[role,f]),role==='service_role');assert.equal(await scalar("select has_function_privilege($1,$2,'EXECUTE')v",[role,helper]),false);assert.equal(await scalar("select has_table_privilege($1,$2,'SELECT')v",[role,table]),false);}});
  await t.test('readback rejects later GRANT OPTION',async()=>{try{await db.exec(`grant execute on function ${writeRpc} to service_role with grant option;`);await assert.rejects(db.exec(readback),e=>e.code==='42501'&&e.message.includes('function_contract_failed'));}finally{await db.exec(`rollback;revoke grant option for execute on function ${writeRpc} from service_role;`);}});
  await t.test('reapply refuses with no change',async()=>{try{await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('already_present'));}finally{await db.exec('rollback');}const r=(await db.exec(readback)).flatMap(x=>x.rows??[]).find(x=>x.fiscal_stored_response_revalidation_commit_readback).fiscal_stored_response_revalidation_commit_readback;assert.deepEqual(r.rows,audit.after);});
 }finally{await db.close();}
});
