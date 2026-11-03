import test from'node:test';import assert from'node:assert/strict';import{readFile,readdir}from'node:fs/promises';import{randomUUID}from'node:crypto';import{PGlite}from'@electric-sql/pglite';
import{bootstrap}from'./helpers/stock-reservation-fixture.mjs';import{prepareSalesPriceRefreshApply,prepareSalesPriceRefreshReadback,SOURCE_HASHES}from'./prepare_sales_price_refresh_apply.mjs';
test('085 guarded installation preserves prior ledgers and closes all new queue contracts',async t=>{
 const db=new PGlite(),scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;let audit;const lookup='public.origin_sync_sales_price_candidates(uuid,uuid,uuid,integer)',helper='origin_sales_price_refresh.require_leases(uuid,uuid,uuid)';
 try{
  await db.exec(bootstrap);const root=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(root)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=84).sort();assert.equal(files.length,84);for(const file of files)await db.exec(await readFile(new URL(file,root),'utf8'));
  const user=randomUUID();await db.query('insert into auth.users values($1)',[user]);await db.query("insert into erp_access.membership(user_id,role)values($1,'admin')",[user]);
  await db.exec("create table erp_access.fixture085(id integer primary key,value text);insert into erp_access.fixture085 values(1,'PRIVATE_SENTINEL');alter table erp_access.fixture085 enable row level security;create policy fixture_read on erp_access.fixture085 for select to authenticated using(false);grant select(value)on erp_access.fixture085 to authenticated;insert into storage.buckets(id,name,public)values('fixture085','fixture085',false);insert into storage.objects values('fixture085','PRIVATE_OBJECT','{}');");
  await db.exec('begin');for(let i=1;i<=200;i++){const command=randomUUID(),id='bsh_'+randomUUID();await db.query("insert into erp_sales_history.snapshot(history_id,source_id,command_id,snapshot_hash,observation)select $1,$2,$3,encode(sha256(convert_to(v::text,'UTF8')),'hex'),v from(select jsonb_build_object('profile','origin-sales-history-observation-v1','source_id',$2::text)v)x",[id,String(i),command]);await db.query("insert into erp_sales_history.command(command_id,actor,request_hash,history_id,receipt)values($1,$2,repeat('a',64),$3,'{}')",[command,user,id]);}await db.exec('commit');
  await db.exec('alter default privileges grant select on tables to authenticated;');
  const sql=await prepareSalesPriceRefreshApply(),readback=await prepareSalesPriceRefreshReadback(),inject=value=>sql.replace('-- reviewed functions created',()=> '-- reviewed functions created\n '+value);
  const absent=async()=>{assert.equal(await scalar("select to_regnamespace('origin_sales_price_refresh')::text v"),null);assert.equal(await scalar('select value v from erp_access.fixture085 where id=1'),'PRIVATE_SENTINEL');assert.equal(await scalar('select count(*)::int v from erp_sales_history.snapshot'),200);};
  const probes=[
   ['source pin',sql.replace('-- Directed GET recapture','-- Altered GET recapture'),'22023','source_hash_mismatch'],
   ['dependency pin',sql.replace('"erp_cutover.sales_capture(origin_sync.raw_record)":"','"erp_cutover.sales_capture(origin_sync.raw_record)":"0'),'55000','previous_contract_changed'],
   ['old row',inject("update erp_access.fixture085 set value='CHANGED';"),'40001','existing_data_changed'],
   ['auth row',inject(`insert into auth.users values('${randomUUID()}');`),'40001','existing_data_changed'],
   ['storage metadata',inject("update storage.objects set metadata='{\"changed\":true}'where bucket_id='fixture085';"),'40001','existing_data_changed'],
   ['old history',inject("alter table erp_sales_history.snapshot disable trigger immutable_snapshot;update erp_sales_history.snapshot set captured_at=captured_at+interval '1 second';alter table erp_sales_history.snapshot enable trigger immutable_snapshot;"),'40001','existing_data_changed'],
   ['new table',inject('create table erp_access.unexpected085(id integer);'),'40001','table_inventory_changed'],
   ['old table grant',inject('grant select on erp_access.fixture085 to service_role;'),'42501','table_security_changed'],
   ['old column grant',inject('grant update(value)on erp_access.fixture085 to service_role;'),'42501','table_security_changed'],
   ['old table RLS',inject('alter table erp_access.fixture085 disable row level security;'),'42501','table_security_changed'],
   ['old policy',inject('drop policy fixture_read on erp_access.fixture085;'),'42501','table_security_changed'],
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
   ['default expression',inject(`do $probe$begin execute replace(pg_get_functiondef('${lookup}'::regprocedure),'DEFAULT 40','DEFAULT 39');end $probe$;`),'42501','function_contract_failed'],
   ['new RPC volatility',inject(`alter function ${lookup}stable;`),'42501','function_contract_failed'],
   ['old namespace type',inject("create type erp_cutover.unexpected085 as enum('a');"),'42501','other_catalog_changed'],
   ['unexpected function',inject('create function public.erp_unexpected085()returns integer language sql as $$select 1$$;'),'40001','other_functions_changed'],
   ['new schema grant',inject('grant usage on schema origin_sales_price_refresh to service_role;'),'42501','private_schema_failed'],
   ['new schema defaults',inject('alter default privileges in schema origin_sales_price_refresh grant select on tables to authenticated;'),'42501','private_schema_failed'],
   ['new row',inject("insert into origin_sales_price_refresh.origin(source_id)values('900');"),'40001','new_table_seed_invalid'],
   ['seed changed',inject("update origin_sales_price_refresh.scope_state set retry_after=clock_timestamp();"),'40001','new_table_seed_invalid'],
   ['seed missing',inject('delete from origin_sales_price_refresh.scope_state;'),'40001','new_table_seed_invalid'],
   ['new table grant',inject('grant select on origin_sales_price_refresh.attempt to service_role;'),'42501','private_table_failed'],
   ['new column grant',inject('grant select(source_id)on origin_sales_price_refresh.origin to anon;'),'42501','private_table_failed'],
   ['new RLS',inject('alter table origin_sales_price_refresh.origin disable row level security;'),'42501','private_table_failed'],
   ['new policy',inject('create policy unexpected on origin_sales_price_refresh.origin for select to anon using(true);'),'42501','private_table_failed'],
   ['new column default',inject('alter table origin_sales_price_refresh.origin alter failures set default 1;'),'40001','table_contract_failed'],
   ['new constraint',inject('alter table origin_sales_price_refresh.origin drop constraint origin_source_id_check;'),'40001','table_contract_failed'],
   ['new trigger disabled',inject('alter table origin_sales_price_refresh.attempt disable trigger sales_price_attempt_immutable;'),'40001','table_contract_failed'],
   ['new trigger WHEN false',inject('drop trigger sales_price_attempt_immutable on origin_sales_price_refresh.attempt;create trigger sales_price_attempt_immutable before update or delete on origin_sales_price_refresh.attempt for each row when(false)execute function origin_sales_price_refresh.immutable_attempt();'),'40001','table_contract_failed'],
   ['new type',inject("create type origin_sales_price_refresh.unexpected as enum('a');"),'40001','table_contract_failed'],
   ['new sequence',inject('create sequence origin_sales_price_refresh.unexpected;'),'40001','table_contract_failed'],
  ];
  for(const[name,input,code,message]of probes)await t.test(name,async()=>{assert.notEqual(input,sql);try{await assert.rejects(db.exec(input),e=>e.code===code&&e.message.includes(message));}finally{await db.exec('rollback');}await absent();});
  await t.test('same-name overload refuses partial installation',async()=>{await db.exec('begin;create function public.origin_sync_sales_price_candidates(integer)returns integer language sql as $$select $1$$;');try{await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('already_present'));}finally{await db.exec('rollback');}await absent();});
  await t.test('missing084 fails before installation',async()=>{await db.exec('begin;drop function public.erp_itau_legacy_readiness(uuid,text,text,integer,text);');try{await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('previous_contract_changed'));}finally{await db.exec('rollback');}await absent();});
  await t.test('success preserves all154+fixture tables and200historyrows',async()=>{audit=(await db.exec(sql)).flatMap(x=>x.rows??[]).find(x=>x.sales_price_refresh_apply_audit).sales_price_refresh_apply_audit;assert.deepEqual(audit.before,audit.after);assert.deepEqual(audit.source_sha256,SOURCE_HASHES);assert.equal(audit.protected_table_count,155);assert.equal(audit.new_service_only_rpcs,6);assert.equal(audit.new_private_helpers,4);assert.equal(audit.new_tables,3);assert.equal(audit.new_scope_seed_count,1);assert.equal(audit.before['erp_sales_history.snapshot'].count,200);assert.equal(audit.before['erp_sales_history.command'].count,200);assert.equal(audit.native_mutation_performed,false);assert.doesNotMatch(JSON.stringify(audit),/PRIVATE_SENTINEL|PRIVATE_OBJECT/);});
  await t.test('readonly readback matches prior data/security and exactnewseed',async()=>{const r=(await db.exec(readback)).flatMap(x=>x.rows??[]).find(x=>x.sales_price_refresh_commit_readback).sales_price_refresh_commit_readback;assert.deepEqual(r.rows,audit.after);for(const k of['table_security_sha256','schema_security_sha256','default_privileges_sha256','other_functions_sha256','other_catalog_sha256'])assert.equal(r[k],audit[k]);assert.equal(r.function_contracts_valid,true);assert.equal(r.new_scope_seed_count,1);});
  await t.test('public roles denied and service status remainsreadonly',async()=>{for(const role of['anon','authenticated','service_role']){assert.equal(await scalar("select has_function_privilege($1,$2,'EXECUTE')v",[role,lookup]),role==='service_role');assert.equal(await scalar("select has_table_privilege($1,'origin_sales_price_refresh.attempt','SELECT')v",[role]),false);}await db.exec('begin read only;set local role service_role;');try{const s=await scalar('select public.origin_sync_sales_price_status()v');assert.equal(s.pending,0);assert.equal(s.historical_writes,false);}finally{await db.exec('rollback');}});
  await t.test('readback rejects GRANTOPTION and reapply refuses withoutchanges',async()=>{try{await db.exec(`grant execute on function ${lookup}to service_role with grant option;`);await assert.rejects(db.exec(readback),e=>e.code==='42501'&&e.message.includes('function_contract_failed'));}finally{await db.exec(`rollback;revoke grant option for execute on function ${lookup}from service_role;`);}try{await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('already_present'));}finally{await db.exec('rollback');}});
 }finally{await db.close();}
});
