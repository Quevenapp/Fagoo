import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {bootstrap} from './helpers/stock-reservation-fixture.mjs';
import {prepareFiscalClosureLookupApply,prepareFiscalClosureLookupReadback,SOURCE_HASHES} from './prepare_fiscal_closure_lookup_apply.mjs';
const lookup='public.erp_fiscal_reviewed_authorization_closure_lookup(uuid,uuid,uuid)';
test('075 apply preserves all prior state and adds only one service-only RPC',async t=>{
 const db=new PGlite(),scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;let audit;
 try{
  await db.exec(bootstrap);const root=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(root)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=74).sort();assert.equal(files.length,74);for(const file of files)await db.exec(await readFile(new URL(file,root),'utf8'));
  const user=randomUUID();await db.query('insert into auth.users values($1)',[user]);await db.query("insert into erp_access.membership(user_id,role)values($1,'admin')",[user]);
  await db.exec("create table erp_access.fixture075(id integer primary key,value text);insert into erp_access.fixture075 values(1,'PRIVATE_SENTINEL');alter table erp_access.fixture075 enable row level security;create policy fixture_read on erp_access.fixture075 for select to authenticated using(false);grant select(value)on erp_access.fixture075 to authenticated;insert into storage.buckets(id,name,public)values('fixture075','fixture075',false);insert into storage.objects values('fixture075','PRIVATE_OBJECT','{}');");
  const sql=await prepareFiscalClosureLookupApply(),readback=await prepareFiscalClosureLookupReadback(),inject=value=>sql.replace('-- reviewed functions created',()=> '-- reviewed functions created\n '+value);
  const absent=async()=>{assert.equal(await scalar('select to_regprocedure($1)::text v',[lookup]),null);assert.equal(await scalar('select value v from erp_access.fixture075 where id=1'),'PRIVATE_SENTINEL');};
  const addEnabledPolicy="insert into erp_fiscal_authorization.policy select (jsonb_populate_record(null::erp_fiscal_authorization.policy,to_jsonb(p)||jsonb_build_object('version',100,'enabled',true))).* from erp_fiscal_authorization.policy p where model='55'and authorization_profile='reviewed_subset_v1';";
  const probes=[
   ['075 source pin',sql.replace('-- Read-only discovery of an existing074 receipt','-- Altered discovery of an existing074 receipt'),'22023','source_hash_mismatch'],
   ['dependency pin',sql.replace('"erp_a1.access(uuid,boolean)":"','"erp_a1.access(uuid,boolean)":"0'),'55000','previous_contract_changed'],
   ['old rows',inject("update erp_access.fixture075 set value='CHANGED';"),'40001','existing_data_changed'],
   ['auth rows',inject(`insert into auth.users values('${randomUUID()}');`),'40001','existing_data_changed'],
   ['storage metadata',inject("update storage.objects set metadata='{\"changed\":true}'where bucket_id='fixture075';"),'40001','existing_data_changed'],
   ['policy row',inject(addEnabledPolicy),'40001','existing_data_changed'],
   ['new table',inject('create table erp_access.unexpected075(id integer);'),'40001','table_inventory_changed'],
   ['table grant',inject('grant select on erp_access.fixture075 to service_role;'),'42501','table_security_changed'],
   ['column grant',inject('grant update(value)on erp_access.fixture075 to service_role;'),'42501','table_security_changed'],
   ['table RLS',inject('alter table erp_access.fixture075 disable row level security;'),'42501','table_security_changed'],
   ['table policy',inject('drop policy fixture_read on erp_access.fixture075;'),'42501','table_security_changed'],
   ['index',inject('drop index origin_sync.raw_record_changed_idx;'),'42501','table_security_changed'],
   ['schema ACL',inject('grant usage on schema erp_access to anon;'),'42501','schema_security_changed'],
   ['default privileges',inject('alter default privileges in schema erp_access grant select on tables to anon;'),'42501','default_privileges_changed'],
   ['old function ACL',inject('grant execute on function public.erp_access_me(uuid)to anon;'),'40001','other_functions_changed'],
   ['new RPC ACL',inject(`grant execute on function ${lookup} to authenticated;`),'42501','function_contract_failed'],
   ['new RPC delegation',inject(`grant execute on function ${lookup} to service_role with grant option;`),'42501','function_contract_failed'],
   ['new RPC definer',inject(`alter function ${lookup} security invoker;`),'42501','function_contract_failed'],
   ['new RPC search path',inject(`alter function ${lookup} set search_path=public;`),'42501','function_contract_failed'],
   ['new RPC volatility',inject(`alter function ${lookup} volatile;`),'42501','function_contract_failed'],
   ['unexpected function',inject('create function public.erp_unexpected075()returns integer language sql as $$select 1$$;'),'40001','other_functions_changed'],
  ];
  for(const[name,input,code,message]of probes)await t.test(name,async()=>{assert.notEqual(input,sql);try{await assert.rejects(db.exec(input),e=>e.code===code&&e.message.includes(message));}finally{await db.exec('rollback');}await absent();});
  await t.test('existing same-name overload prevents partial application',async()=>{await db.exec('begin;create function public.erp_fiscal_reviewed_authorization_closure_lookup(integer)returns integer language sql as $$select $1$$;');try{await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('already_present'));}finally{await db.exec('rollback');}await absent();});
  await t.test('enabled policy prevents application',async()=>{try{await db.exec('begin;'+addEnabledPolicy);await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('fiscal_gate_not_closed'));}finally{await db.exec('rollback');}await absent();});
  await t.test('success preserves rows and adds one private RPC contract',async()=>{audit=(await db.exec(sql)).flatMap(x=>x.rows??[]).find(x=>x.reviewed_closure_lookup_apply_audit).reviewed_closure_lookup_apply_audit;assert.deepEqual(audit.before,audit.after);assert.deepEqual(audit.source_sha256,SOURCE_HASHES);assert.equal(audit.new_service_only_rpcs,1);assert.equal(audit.new_tables,0);assert.equal(audit.fiscal_attempts_created,0);assert.equal(audit.enabled_policies,0);assert.equal(audit.native_mutation_performed,false);assert.doesNotMatch(JSON.stringify(audit),/PRIVATE_SENTINEL|PRIVATE_OBJECT/);});
  await t.test('readonly committed readback matches every audited invariant',async()=>{const r=(await db.exec(readback)).flatMap(x=>x.rows??[]).find(x=>x.reviewed_closure_lookup_commit_readback).reviewed_closure_lookup_commit_readback;assert.deepEqual(r.rows,audit.after);for(const k of['table_security_sha256','schema_security_sha256','default_privileges_sha256','other_functions_sha256'])assert.equal(r[k],audit[k]);assert.equal(r.enabled_policies,0);assert.equal(r.fiscal_attempts,0);assert.equal(r.function_contracts_valid,true);});
  await t.test('public roles cannot execute new RPCs or access fiscal ledgers',async()=>{for(const role of['anon','authenticated','service_role']){for(const sig of[lookup])assert.equal(await scalar("select has_function_privilege($1,$2,'EXECUTE')v",[role,sig]),role==='service_role');assert.equal(await scalar("select has_table_privilege($1,'erp_fiscal_authorization.attempt','SELECT')v",[role]),false);}});
  await t.test('readback refuses later EXECUTE delegation',async()=>{try{await db.exec(`grant execute on function ${lookup} to service_role with grant option;`);await assert.rejects(db.exec(readback),e=>e.code==='42501'&&e.message.includes('function_contract_failed'));}finally{await db.exec(`rollback;revoke grant option for execute on function ${lookup} from service_role;`);}});
  await t.test('reapply is refused with no change',async()=>{try{await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('already_present'));}finally{await db.exec('rollback');}const r=(await db.exec(readback)).flatMap(x=>x.rows??[]).find(x=>x.reviewed_closure_lookup_commit_readback).reviewed_closure_lookup_commit_readback;assert.deepEqual(r.rows,audit.after);});
 }finally{await db.close();}
});
