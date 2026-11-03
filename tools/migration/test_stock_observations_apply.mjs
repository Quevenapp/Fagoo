import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {STOCK_OBSERVATIONS_ACTOR,STOCK_OBSERVATIONS_SEED} from './helpers/stock-observations-apply-fixture.mjs';
import {parseStockObservationsPage} from '../../packages/erp-domain/src/origin-stock-observations-dto.mjs';
import {PGlite} from '@electric-sql/pglite';
import {bootstrap} from './helpers/stock-reservation-fixture.mjs';
import {prepareStockObservationsApply,prepareStockObservationsReadback,SOURCE_HASHES} from './prepare_stock_observations_apply.mjs';
const lookup='public.erp_origin_stock_observations(uuid,text,integer,text,text)',list=lookup,detail='public.erp_origin_stock_observation_detail(uuid,text,text)',helper='erp_cutover.stock_observation_row(text,text)';
test('087 apply preserves all prior state and adds only six private helpers and two service-only RPCs',async t=>{
 const db=new PGlite(),scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;let audit;
 try{
  await db.exec(bootstrap);const root=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(root)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=86).sort();assert.equal(files.length,86);for(const file of files)await db.exec(await readFile(new URL(file,root),'utf8'));
  const user=STOCK_OBSERVATIONS_ACTOR;await db.exec(STOCK_OBSERVATIONS_SEED);
  const sql=await prepareStockObservationsApply(),readback=await prepareStockObservationsReadback(),inject=value=>sql.replace('-- reviewed functions created',()=> '-- reviewed functions created\n '+value);
  const absent=async()=>{assert.equal(await scalar('select to_regprocedure($1)::text v',[lookup]),null);assert.equal(await scalar('select value v from erp_access.fixture087 where id=1'),'PRIVATE_SENTINEL');};
  const addEnabledPolicy="insert into erp_fiscal_authorization.policy select (jsonb_populate_record(null::erp_fiscal_authorization.policy,to_jsonb(p)||jsonb_build_object('version',100,'enabled',true))).* from erp_fiscal_authorization.policy p where model='55'and authorization_profile='reviewed_subset_v1'order by version desc limit 1;";
  const probes=[
   ['087 source pin',sql.replace('-- Read-only current staging observations.','-- Altered current staging observations.'),'22023','source_hash_mismatch'],
   ['dependency pin',sql.replace('"erp_cutover.require_admin(uuid)":"','"erp_cutover.require_admin(uuid)":"0'),'55000','previous_contract_changed'],
   ['old rows',inject("update erp_access.fixture087 set value='CHANGED';"),'40001','existing_data_changed'],
   ['auth rows',inject(`insert into auth.users values('${randomUUID()}');`),'40001','existing_data_changed'],
   ['storage metadata',inject("update storage.objects set metadata='{\"changed\":true}'where bucket_id='fixture087';"),'40001','existing_data_changed'],
   ['policy row',inject(addEnabledPolicy),'40001','existing_data_changed'],
   ['new table',inject('create table erp_access.unexpected087(id integer);'),'40001','table_inventory_changed'],
   ['table grant',inject('grant select on erp_access.fixture087 to service_role;'),'42501','table_security_changed'],
   ['column grant',inject('grant update(value)on erp_access.fixture087 to service_role;'),'42501','table_security_changed'],
   ['table RLS',inject('alter table erp_access.fixture087 disable row level security;'),'42501','table_security_changed'],
   ['table policy',inject('drop policy fixture_read on erp_access.fixture087;'),'42501','table_security_changed'],
   ['old internal FK trigger',inject("do $probe$ declare n text;begin select tgname into strict n from pg_trigger where tgrelid='erp_access.membership'::regclass and tgisinternal limit 1;execute format('alter table erp_access.membership disable trigger %I',n);end $probe$;"),'42501','table_security_changed'],
   ['index',inject('drop index origin_sync.raw_record_changed_idx;'),'42501','table_security_changed'],
   ['schema ACL',inject('grant usage on schema erp_access to anon;'),'42501','schema_security_changed'],
   ['default privileges',inject('alter default privileges in schema erp_access grant select on tables to anon;'),'42501','default_privileges_changed'],
   ['global defaults',inject('alter default privileges grant select on tables to anon;'),'42501','default_privileges_changed'],
   ['preserved warehouse binding',inject("alter table erp_warehouse_import.binding disable trigger immutable_binding;update erp_warehouse_import.binding set imported_at=imported_at+interval'1 second';alter table erp_warehouse_import.binding enable trigger immutable_binding;"),'40001','existing_data_changed'],
   ['preserved queue085',inject("update origin_sales_price_refresh.origin set failures=failures+1;"),'40001','existing_data_changed'],
   ['preserved history083',inject("alter table erp_sales_history.snapshot disable trigger immutable_snapshot;update erp_sales_history.snapshot set captured_at=captured_at+interval'1 second';alter table erp_sales_history.snapshot enable trigger immutable_snapshot;"),'40001','existing_data_changed'],
   ['old function ACL',inject('grant execute on function public.erp_access_me(uuid)to anon;'),'40001','other_functions_changed'],
   ['new RPC ACL',inject(`grant execute on function ${lookup} to authenticated;`),'42501','function_contract_failed'],
   ['new RPC delegation',inject(`grant execute on function ${lookup} to service_role with grant option;`),'42501','function_contract_failed'],
   ['new RPC definer',inject(`alter function ${lookup} security invoker;`),'42501','function_contract_failed'],
   ['new RPC search path',inject(`alter function ${lookup} set search_path=public;`),'42501','function_contract_failed'],
   ['private helper grant',inject(`grant execute on function ${helper} to service_role;`),'42501','function_contract_failed'],
   ['new RPC default expression',inject(`do $probe$ begin execute replace(pg_get_functiondef('${list}'::regprocedure),'DEFAULT 25','DEFAULT 24');end $probe$;`),'42501','function_contract_failed'],
   ['new RPC volatility',inject(`alter function ${lookup} volatile;`),'42501','function_contract_failed'],
   ['unexpected type',inject('create type erp_cutover.unexpected087 as enum(\'a\');'),'42501','other_catalog_changed'],
   ['unexpected function',inject('create function public.erp_unexpected087()returns integer language sql as $$select 1$$;'),'40001','other_functions_changed'],
  ];
  for(const[name,input,code,message]of probes)await t.test(name,async()=>{assert.notEqual(input,sql);try{await assert.rejects(db.exec(input),e=>e.code===code&&e.message.includes(message));}finally{await db.exec('rollback');}await absent();});
  await t.test('existing same-name overload prevents partial application',async()=>{await db.exec('begin;create function public.erp_origin_stock_observations(integer)returns integer language sql as $$select $1$$;');try{await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('already_present'));}finally{await db.exec('rollback');}await absent();});
  await t.test('missing086 function blocks the installed baseline',async()=>{await db.exec('begin;drop function public.erp_origin_warehouse_sources(uuid,integer,text,text);');try{await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('previous_contract_changed'));}finally{await db.exec('rollback');}await absent();});
  await t.test('success preserves rows and adds eight closed function contracts',async()=>{audit=(await db.exec(sql)).flatMap(x=>x.rows??[]).find(x=>x.stock_observations_apply_audit).stock_observations_apply_audit;assert.deepEqual(audit.before,audit.after);assert.deepEqual(audit.source_sha256,SOURCE_HASHES);assert.equal(audit.new_service_only_rpcs,2);assert.equal(audit.new_tables,0);assert.equal(audit.before['erp_sales_history.snapshot'].count,276);assert.equal(audit.protected_table_count,160);assert.equal(audit.can_import_balance,false);assert.equal(audit.stock_write_performed,false);assert.equal(audit.new_private_helpers,6);assert.equal(audit.native_mutation_performed,false);assert.doesNotMatch(JSON.stringify(audit),/PRIVATE_SENTINEL|PRIVATE_OBJECT/);});
  await t.test('readonly committed readback matches every audited invariant',async()=>{const r=(await db.exec(readback)).flatMap(x=>x.rows??[]).find(x=>x.stock_observations_commit_readback).stock_observations_commit_readback;assert.deepEqual(r.rows,audit.after);for(const k of['table_security_sha256','schema_security_sha256','default_privileges_sha256','other_functions_sha256','other_catalog_sha256'])assert.equal(r[k],audit[k]);assert.equal(r.new_private_helpers,6);assert.equal(r.function_contracts_valid,true);});
  await t.test('service GET exposes exact synthetic observations without stock writes',async()=>{await db.exec('begin read only;set local role service_role;');try{const p=parseStockObservationsPage(await scalar('select public.erp_origin_stock_observations($1,$2)v',[user,'007']),{warehouseSourceId:'007',limit:25,after:null});assert.equal(p.items.length,1);assert.equal(p.items[0].observation.warehouse.physical.value,'0');assert.equal(p.items[0].observation.warehouse.virtual.value,'-0.125');assert.equal(p.warehouse.record.active,false);assert.equal(p.can_import_balance,false);}finally{await db.exec('rollback');}});
  await t.test('public roles cannot execute new RPCs or access fiscal ledgers',async()=>{for(const role of['anon','authenticated','service_role']){for(const sig of[lookup,detail])assert.equal(await scalar("select has_function_privilege($1,$2,'EXECUTE')v",[role,sig]),role==='service_role');assert.equal(await scalar("select has_table_privilege($1,'erp_fiscal_authorization.attempt','SELECT')v",[role]),false);}});
  await t.test('readback refuses later EXECUTE delegation',async()=>{try{await db.exec(`grant execute on function ${lookup} to service_role with grant option;`);await assert.rejects(db.exec(readback),e=>e.code==='42501'&&e.message.includes('function_contract_failed'));}finally{await db.exec(`rollback;revoke grant option for execute on function ${lookup} from service_role;`);}});
  await t.test('reapply is refused with no change',async()=>{try{await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('already_present'));}finally{await db.exec('rollback');}const r=(await db.exec(readback)).flatMap(x=>x.rows??[]).find(x=>x.stock_observations_commit_readback).stock_observations_commit_readback;assert.deepEqual(r.rows,audit.after);});
 }finally{await db.close();}
});
