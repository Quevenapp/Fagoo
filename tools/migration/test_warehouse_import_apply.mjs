import test from'node:test';import assert from'node:assert/strict';import{readFile,readdir}from'node:fs/promises';import{randomUUID}from'node:crypto';import{PGlite}from'@electric-sql/pglite';
import{bootstrap}from'./helpers/stock-reservation-fixture.mjs';import{prepareWarehouseImportApply,prepareWarehouseImportReadback,SOURCE_HASHES}from'./prepare_warehouse_import_apply.mjs';
test('086 guarded installation preserves prior ledgers and closes all new warehouse adoption contracts',async t=>{
 const db=new PGlite(),scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;let audit;const lookup='public.erp_origin_warehouse_sources(uuid,integer,text,text)',helper='erp_warehouse_import.immutable()';
 try{
  await db.exec(bootstrap);const root=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(root)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=85).sort();assert.equal(files.length,85);for(const file of files)await db.exec(await readFile(new URL(file,root),'utf8'));
  const user=randomUUID();await db.query('insert into auth.users values($1)',[user]);await db.query("insert into erp_access.membership(user_id,role)values($1,'admin')",[user]);
  await db.exec("create table erp_access.fixture086(id integer primary key,value text);insert into erp_access.fixture086 values(1,'PRIVATE_SENTINEL');alter table erp_access.fixture086 enable row level security;create policy fixture_read on erp_access.fixture086 for select to authenticated using(false);grant select(value)on erp_access.fixture086 to authenticated;insert into storage.buckets(id,name,public)values('fixture086','fixture086',false);insert into storage.objects values('fixture086','PRIVATE_OBJECT','{}');");
  await db.exec('begin');for(let i=1;i<=200;i++){const command=randomUUID(),id='bsh_'+randomUUID();await db.query("insert into erp_sales_history.snapshot(history_id,source_id,command_id,snapshot_hash,observation)select $1,$2,$3,encode(sha256(convert_to(v::text,'UTF8')),'hex'),v from(select jsonb_build_object('profile','origin-sales-history-observation-v1','source_id',$2::text)v)x",[id,String(i),command]);await db.query("insert into erp_sales_history.command(command_id,actor,request_hash,history_id,receipt)values($1,$2,repeat('a',64),$3,'{}')",[command,user,id]);}await db.exec('commit');
  await db.exec('alter default privileges grant select on tables to authenticated;');
  const nativeCommand=randomUUID();const warehouse=await scalar(`select public.erp_catalog_save($1,'warehouses',null,0,$2,'{"name":"Preserved086"}')v`,[user,nativeCommand]).then(v=>v.record);
  await db.exec("insert into origin_sales_price_refresh.origin(source_id,failures,last_error)values('123',3,'HTTP_404');update origin_sales_price_refresh.scope_state set retry_after=clock_timestamp()+interval'1 hour';");
  const sql=await prepareWarehouseImportApply(),readback=await prepareWarehouseImportReadback(),inject=value=>sql.replace('-- reviewed functions created',()=> '-- reviewed functions created\n '+value);
  const absent=async()=>{assert.equal(await scalar("select to_regnamespace('erp_warehouse_import')::text v"),null);assert.equal(await scalar('select value v from erp_access.fixture086 where id=1'),'PRIVATE_SENTINEL');assert.equal(await scalar('select count(*)::int v from erp_sales_history.snapshot'),200);};
  const probes=[
   ['source pin',sql.replace('-- Explicit create-only warehouse','-- Altered create-only warehouse'),'22023','source_hash_mismatch'],
   ['dependency pin',sql.replace('"erp_catalog.dto(uuid)":"','"erp_catalog.dto(uuid)":"0'),'55000','previous_contract_changed'],
   ['old row',inject("update erp_access.fixture086 set value='CHANGED';"),'40001','existing_data_changed'],
   ['auth row',inject(`insert into auth.users values('${randomUUID()}');`),'40001','existing_data_changed'],
   ['storage metadata',inject("update storage.objects set metadata='{\"changed\":true}'where bucket_id='fixture086';"),'40001','existing_data_changed'],
   ['old history',inject("alter table erp_sales_history.snapshot disable trigger immutable_snapshot;update erp_sales_history.snapshot set captured_at=captured_at+interval '1 second';alter table erp_sales_history.snapshot enable trigger immutable_snapshot;"),'40001','existing_data_changed'],
   ['new table',inject('create table erp_access.unexpected086(id integer);'),'40001','table_inventory_changed'],
   ['old table grant',inject('grant select on erp_access.fixture086 to service_role;'),'42501','table_security_changed'],
   ['old column grant',inject('grant update(value)on erp_access.fixture086 to service_role;'),'42501','table_security_changed'],
   ['old table RLS',inject('alter table erp_access.fixture086 disable row level security;'),'42501','table_security_changed'],
   ['old policy',inject('drop policy fixture_read on erp_access.fixture086;'),'42501','table_security_changed'],
   ['old internal trigger',inject("do $probe$declare n text;begin select tgname into strict n from pg_trigger where tgrelid='erp_access.membership'::regclass and tgisinternal limit 1;execute format('alter table erp_access.membership disable trigger %I',n);end $probe$;"),'42501','table_security_changed'],
   ['old index',inject('drop index origin_sync.raw_record_changed_idx;'),'42501','table_security_changed'],
   ['old schema ACL',inject('grant usage on schema erp_access to anon;'),'42501','schema_security_changed'],
   ['defaults',inject('alter default privileges in schema erp_access grant select on tables to anon;'),'42501','default_privileges_changed'],
   ['global defaults',inject('alter default privileges grant select on tables to anon;'),'42501','default_privileges_changed'],
   ['old function ACL',inject('grant execute on function public.erp_access_me(uuid)to anon;'),'40001','other_functions_changed'],
   ['new RPC ACL',inject(`grant execute on function ${lookup}to authenticated;`),'42501','function_contract_failed'],
   ['new RPC delegation',inject(`grant execute on function ${lookup}to service_role with grant option;`),'42501','function_contract_failed'],
   ['new RPC definer',inject(`alter function ${lookup}security invoker;`),'42501','function_contract_failed'],
   ['new RPC path',inject(`alter function ${lookup}set search_path=public;`),'42501','function_contract_failed'],
   ['helper grant',inject(`grant execute on function ${helper}to service_role;`),'42501','function_contract_failed'],
   ['default expression',inject(`do $probe$begin execute replace(pg_get_functiondef('${lookup}'::regprocedure),'DEFAULT 25','DEFAULT 24');end $probe$;`),'42501','function_contract_failed'],
   ['new RPC volatility',inject(`alter function ${lookup}volatile;`),'42501','function_contract_failed'],
   ['old namespace type',inject("create type erp_cutover.unexpected086 as enum('a');"),'42501','other_catalog_changed'],
   ['unexpected function',inject('create function public.erp_unexpected086()returns integer language sql as $$select 1$$;'),'40001','other_functions_changed'],
   ['new schema grant',inject('grant usage on schema erp_warehouse_import to service_role;'),'42501','private_schema_failed'],
   ['new schema defaults',inject('alter default privileges in schema erp_warehouse_import grant select on tables to authenticated;'),'42501','private_schema_failed'],
   ['new binding row',inject(`insert into erp_warehouse_import.binding(source_id,warehouse_id,command_id,source_hash,source_version,source_seen_at,observation,source,record)values('900','${warehouse.id}','${nativeCommand}',repeat('a',64),1,clock_timestamp(),'{}','{}','{}');`),'40001','new_table_seed_invalid'],
   ['new table grant',inject('grant select on erp_warehouse_import.command to service_role;'),'42501','private_table_failed'],
   ['new column grant',inject('grant select(source_id)on erp_warehouse_import.binding to anon;'),'42501','private_table_failed'],
   ['new RLS',inject('alter table erp_warehouse_import.binding disable row level security;'),'42501','private_table_failed'],
   ['new policy',inject('create policy unexpected on erp_warehouse_import.binding for select to anon using(true);'),'42501','private_table_failed'],
   ['new column default',inject("alter table erp_warehouse_import.binding alter entity set default 'products';"),'40001','table_contract_failed'],
   ['new FK deferral',inject('alter table erp_warehouse_import.binding alter constraint binding_command_id_fkey not deferrable;'),'40001','table_contract_failed'],
   ['new owner',inject('alter table erp_warehouse_import.binding owner to service_role;'),'42501','private_table_failed'],
   ['new constraint',inject('alter table erp_warehouse_import.binding drop constraint binding_source_id_check;'),'40001','table_contract_failed'],
   ['new trigger disabled',inject('alter table erp_warehouse_import.command disable trigger immutable_command;'),'40001','table_contract_failed'],
   ['new trigger WHEN false',inject('drop trigger immutable_command on erp_warehouse_import.command;create trigger immutable_command before update or delete on erp_warehouse_import.command for each row when(false)execute function erp_warehouse_import.immutable();'),'40001','table_contract_failed'],
   ['new type',inject("create type erp_warehouse_import.unexpected as enum('a');"),'40001','table_contract_failed'],
   ['new sequence',inject('create sequence erp_warehouse_import.unexpected;'),'40001','table_contract_failed'],
  ];
  for(const[name,input,code,message]of probes)await t.test(name,async()=>{assert.notEqual(input,sql);try{await assert.rejects(db.exec(input),e=>e.code===code&&e.message.includes(message));}finally{await db.exec('rollback');}await absent();});
  await t.test('same-name overload refuses partial installation',async()=>{await db.exec('begin;create function public.erp_origin_warehouse_sources(integer)returns integer language sql as $$select $1$$;');try{await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('already_present'));}finally{await db.exec('rollback');}await absent();});
  await t.test('missing085 fails before installation',async()=>{await db.exec('begin;drop function public.origin_sync_sales_price_status();');try{await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('previous_contract_changed'));}finally{await db.exec('rollback');}await absent();});
  await t.test('success preserves all157+fixture tables and200historyrows',async()=>{audit=(await db.exec(sql)).flatMap(x=>x.rows??[]).find(x=>x.warehouse_import_apply_audit).warehouse_import_apply_audit;assert.deepEqual(audit.before,audit.after);assert.deepEqual(audit.source_sha256,SOURCE_HASHES);assert.equal(audit.protected_table_count,158);assert.equal(audit.new_service_only_rpcs,4);assert.equal(audit.new_private_helpers,8);assert.equal(audit.new_tables,2);assert.equal(audit.new_bindings_empty,true);assert.equal(audit.new_commands_empty,true);assert.equal(audit.before['erp_sales_history.snapshot'].count,200);assert.equal(audit.before['erp_sales_history.command'].count,200);assert.equal(audit.native_mutation_performed,false);assert.doesNotMatch(JSON.stringify(audit),/PRIVATE_SENTINEL|PRIVATE_OBJECT/);});
  await t.test('readonly readback matches prior data/security and new empty bindings/commands',async()=>{const r=(await db.exec(readback)).flatMap(x=>x.rows??[]).find(x=>x.warehouse_import_commit_readback).warehouse_import_commit_readback;assert.deepEqual(r.rows,audit.after);for(const k of['table_security_sha256','schema_security_sha256','default_privileges_sha256','other_functions_sha256','other_catalog_sha256'])assert.equal(r[k],audit[k]);assert.equal(r.function_contracts_valid,true);assert.equal(r.new_bindings_empty,true);assert.equal(r.new_commands_empty,true);});
  await t.test('public roles denied and service status remainsreadonly',async()=>{for(const role of['anon','authenticated','service_role']){assert.equal(await scalar("select has_function_privilege($1,$2,'EXECUTE')v",[role,lookup]),role==='service_role');assert.equal(await scalar("select has_table_privilege($1,'erp_warehouse_import.command','SELECT')v",[role]),false);}await db.exec('begin read only;set local role service_role;');try{const s=await scalar('select public.erp_origin_warehouse_sources($1,25,null,null)v',[user]);assert.equal(s.items.length,0);assert.equal(s.stock_effects,false);assert.equal(s.financial_effects,false);}finally{await db.exec('rollback');}});
  await t.test('readback rejects GRANTOPTION and reapply refuses withoutchanges',async()=>{try{await db.exec(`grant execute on function ${lookup}to service_role with grant option;`);await assert.rejects(db.exec(readback),e=>e.code==='42501'&&e.message.includes('function_contract_failed'));}finally{await db.exec(`rollback;revoke grant option for execute on function ${lookup}from service_role;`);}try{await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('already_present'));}finally{await db.exec('rollback');}});
 }finally{await db.close();}
});
