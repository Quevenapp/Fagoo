import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {bootstrap} from './helpers/stock-reservation-fixture.mjs';
import {prepareSalesHistoryApply,prepareSalesHistoryReadback,SOURCE_HASHES} from './prepare_sales_history_apply.mjs';
const lookup='public.erp_origin_sales_history_detail(uuid,text)',list='public.erp_origin_sales_history_list(uuid,integer,text,text)',helper='erp_sales_history.observed(jsonb,boolean,integer)';
test('083 apply preserves all prior state and adds only nine private helpers, five service-only RPCs and two empty private tables',async t=>{
 const db=new PGlite(),scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;let audit;
 try{
  await db.exec(bootstrap);const root=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(root)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=82).sort();assert.equal(files.length,82);for(const file of files)await db.exec(await readFile(new URL(file,root),'utf8'));
  const user=randomUUID();await db.query('insert into auth.users values($1)',[user]);await db.query("insert into erp_access.membership(user_id,role)values($1,'admin')",[user]);
  await db.exec("create table erp_access.fixture083(id integer primary key,value text);insert into erp_access.fixture083 values(1,'PRIVATE_SENTINEL');alter table erp_access.fixture083 enable row level security;create policy fixture_read on erp_access.fixture083 for select to authenticated using(false);grant select(value)on erp_access.fixture083 to authenticated;insert into storage.buckets(id,name,public)values('fixture083','fixture083',false);insert into storage.objects values('fixture083','PRIVATE_OBJECT','{}');");
  const sql=await prepareSalesHistoryApply(),readback=await prepareSalesHistoryReadback(),inject=value=>sql.replace('-- reviewed functions created',()=> '-- reviewed functions created\n '+value);
  const absent=async()=>{assert.equal(await scalar("select to_regnamespace('erp_sales_history')::text v"),null);assert.equal(await scalar('select to_regprocedure($1)::text v',[lookup]),null);assert.equal(await scalar('select value v from erp_access.fixture083 where id=1'),'PRIVATE_SENTINEL');};
  const addEnabledPolicy="insert into erp_fiscal_authorization.policy select (jsonb_populate_record(null::erp_fiscal_authorization.policy,to_jsonb(p)||jsonb_build_object('version',100,'enabled',true))).* from erp_fiscal_authorization.policy p where model='55'and authorization_profile='reviewed_subset_v1'order by version desc limit 1;";
  const newCommand=randomUUID(),newHistory='bsh_'+randomUUID();
  const newRows=`insert into erp_sales_history.snapshot(history_id,source_id,command_id,snapshot_hash,observation) select '${newHistory}','1','${newCommand}',encode(sha256(convert_to(v::text,'UTF8')),'hex'),v from(select '{"profile":"origin-sales-history-observation-v1","source_id":"1"}'::jsonb v)x;insert into erp_sales_history.command(command_id,actor,request_hash,history_id,receipt)values('${newCommand}','${user}',repeat('a',64),'${newHistory}','{}');`;
  const probes=[
   ['083 source pin',sql.replace('-- Immutable commercial observations','-- Altered commercial observations'),'22023','source_hash_mismatch'],
   ['dependency pin',sql.replace('"erp_cutover.require_admin(uuid)":"','"erp_cutover.require_admin(uuid)":"0'),'55000','previous_contract_changed'],
   ['old rows',inject("update erp_access.fixture083 set value='CHANGED';"),'40001','existing_data_changed'],
   ['auth rows',inject(`insert into auth.users values('${randomUUID()}');`),'40001','existing_data_changed'],
   ['storage metadata',inject("update storage.objects set metadata='{\"changed\":true}'where bucket_id='fixture083';"),'40001','existing_data_changed'],
   ['policy row',inject(addEnabledPolicy),'40001','existing_data_changed'],
   ['new table',inject('create table erp_access.unexpected083(id integer);'),'40001','table_inventory_changed'],
   ['table grant',inject('grant select on erp_access.fixture083 to service_role;'),'42501','table_security_changed'],
   ['column grant',inject('grant update(value)on erp_access.fixture083 to service_role;'),'42501','table_security_changed'],
   ['table RLS',inject('alter table erp_access.fixture083 disable row level security;'),'42501','table_security_changed'],
   ['table policy',inject('drop policy fixture_read on erp_access.fixture083;'),'42501','table_security_changed'],
   ['old internal FK trigger',inject("do $probe$ declare n text;begin select tgname into strict n from pg_trigger where tgrelid='erp_access.membership'::regclass and tgisinternal limit 1;execute format('alter table erp_access.membership disable trigger %I',n);end $probe$;"),'42501','table_security_changed'],
   ['index',inject('drop index origin_sync.raw_record_changed_idx;'),'42501','table_security_changed'],
   ['schema ACL',inject('grant usage on schema erp_access to anon;'),'42501','schema_security_changed'],
   ['default privileges',inject('alter default privileges in schema erp_access grant select on tables to anon;'),'42501','default_privileges_changed'],
   ['old function ACL',inject('grant execute on function public.erp_access_me(uuid)to anon;'),'40001','other_functions_changed'],
   ['new RPC ACL',inject(`grant execute on function ${lookup} to authenticated;`),'42501','function_contract_failed'],
   ['new RPC delegation',inject(`grant execute on function ${lookup} to service_role with grant option;`),'42501','function_contract_failed'],
   ['new RPC definer',inject(`alter function ${lookup} security invoker;`),'42501','function_contract_failed'],
   ['new RPC search path',inject(`alter function ${lookup} set search_path=public;`),'42501','function_contract_failed'],
   ['private helper grant',inject(`grant execute on function ${helper} to service_role;`),'42501','function_contract_failed'],
   ['new RPC default expression',inject(`do $probe$ begin execute replace(pg_get_functiondef('${list}'::regprocedure),'DEFAULT 25','DEFAULT 24');end $probe$;`),'42501','function_contract_failed'],
   ['new RPC volatility',inject(`alter function ${lookup} volatile;`),'42501','function_contract_failed'],
   ['unexpected type',inject('create type erp_cutover.unexpected083 as enum(\'a\');'),'42501','other_catalog_changed'],
   ['unexpected function',inject('create function public.erp_unexpected083()returns integer language sql as $$select 1$$;'),'40001','other_functions_changed'],
   ['private schema grant',inject('grant usage on schema erp_sales_history to service_role;'),'42501','private_schema_failed'],
   ['private defaults grant',inject('alter default privileges in schema erp_sales_history grant select on tables to anon;'),'42501','private_schema_failed'],
   ['private column grant',inject('grant select(observation)on erp_sales_history.snapshot to service_role;'),'42501','private_table_failed'],
   ['private table grant',inject('grant select on erp_sales_history.command to service_role;'),'42501','private_table_failed'],
   ['private RLS',inject('alter table erp_sales_history.snapshot disable row level security;'),'42501','private_table_failed'],
   ['private policy',inject('create policy wrong on erp_sales_history.snapshot for select to anon using(true);'),'42501','private_table_failed'],
   ['private column',inject('alter table erp_sales_history.snapshot add column extra text;'),'40001','table_contract_failed'],
   ['private index',inject('drop index erp_sales_history.snapshot_command_id_key;'),'2BP01',''],
   ['private default',inject("alter table erp_sales_history.snapshot alter column history_id set default 'bad';"),'40001','table_contract_failed'],
   ['private constraint',inject('alter table erp_sales_history.snapshot drop constraint snapshot_source_id_check;'),'40001','table_contract_failed'],
   ['deferred FK changed',inject('alter table erp_sales_history.snapshot alter constraint history_snapshot_command not deferrable;'),'40001','table_contract_failed'],
   ['immutable trigger disabled',inject('alter table erp_sales_history.snapshot disable trigger immutable_snapshot;'),'40001','table_contract_failed'],
   ['immutable trigger condition bypass',inject('drop trigger immutable_snapshot on erp_sales_history.snapshot;create trigger immutable_snapshot before update or delete on erp_sales_history.snapshot for each row when(false)execute function erp_sales_history.immutable();'),'40001','table_contract_failed'],
   ['new history is required to stay empty',inject(newRows),'40001','new_tables_not_empty'],
   ['internal FK triggers disabled',inject('alter table erp_sales_history.command disable trigger all;'),'40001','table_contract_failed'],
   ['private view',inject('create view erp_sales_history.extra as select 1 as x;'),'40001','table_contract_failed'],
   ['private enum',inject("create type erp_sales_history.extra as enum('x');"),'40001','table_contract_failed'],

  ];
  for(const[name,input,code,message]of probes)await t.test(name,async()=>{assert.notEqual(input,sql);try{await assert.rejects(db.exec(input),e=>e.code===code&&e.message.includes(message));}finally{await db.exec('rollback');}await absent();});
  await t.test('existing same-name overload prevents partial application',async()=>{await db.exec('begin;create function public.erp_origin_sales_history_detail(integer)returns integer language sql as $$select $1$$;');try{await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('already_present'));}finally{await db.exec('rollback');}await absent();});
  await t.test('missing082 function blocks the installed baseline',async()=>{await db.exec('begin;drop function public.erp_fiscal_draft_status_list(uuid,text,text,uuid,integer,uuid);');try{await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('previous_contract_changed'));}finally{await db.exec('rollback');}await absent();});
  await t.test('success preserves rows and adds fourteen closed function contracts',async()=>{audit=(await db.exec(sql)).flatMap(x=>x.rows??[]).find(x=>x.sales_history_apply_audit).sales_history_apply_audit;assert.deepEqual(audit.before,audit.after);assert.deepEqual(audit.source_sha256,SOURCE_HASHES);assert.equal(audit.new_service_only_rpcs,5);assert.equal(audit.new_tables,2);assert.equal(audit.new_private_helpers,9);assert.equal(audit.native_mutation_performed,false);assert.doesNotMatch(JSON.stringify(audit),/PRIVATE_SENTINEL|PRIVATE_OBJECT/);});
  await t.test('readonly committed readback matches every audited invariant',async()=>{const r=(await db.exec(readback)).flatMap(x=>x.rows??[]).find(x=>x.sales_history_commit_readback).sales_history_commit_readback;assert.deepEqual(r.rows,audit.after);for(const k of['table_security_sha256','schema_security_sha256','default_privileges_sha256','other_functions_sha256','other_catalog_sha256'])assert.equal(r[k],audit[k]);assert.equal(r.new_private_helpers,9);assert.equal(r.function_contracts_valid,true);});
  await t.test('new endpoint executes under service role without touching rows',async()=>{await db.exec('begin read only;set local role service_role;');try{const p=await scalar('select public.erp_origin_sales_history_list($1)v',[user]);assert.deepEqual(p.items,[]);assert.equal(p.can_convert,false);assert.equal(p.profile,'origin-sales-history-v1');}finally{await db.exec('rollback');}});
  await t.test('public roles cannot execute new RPCs or access fiscal ledgers',async()=>{for(const role of['anon','authenticated','service_role']){for(const sig of[lookup,list])assert.equal(await scalar("select has_function_privilege($1,$2,'EXECUTE')v",[role,sig]),role==='service_role');assert.equal(await scalar("select has_table_privilege($1,'erp_fiscal_authorization.attempt','SELECT')v",[role]),false);}});
  await t.test('readback refuses later EXECUTE delegation',async()=>{try{await db.exec(`grant execute on function ${lookup} to service_role with grant option;`);await assert.rejects(db.exec(readback),e=>e.code==='42501'&&e.message.includes('function_contract_failed'));}finally{await db.exec(`rollback;revoke grant option for execute on function ${lookup} from service_role;`);}});
  await t.test('reapply is refused with no change',async()=>{try{await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('already_present'));}finally{await db.exec('rollback');}const r=(await db.exec(readback)).flatMap(x=>x.rows??[]).find(x=>x.sales_history_commit_readback).sales_history_commit_readback;assert.deepEqual(r.rows,audit.after);});
 }finally{await db.close();}
});
