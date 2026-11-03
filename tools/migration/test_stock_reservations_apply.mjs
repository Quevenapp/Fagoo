// One disposable local database. No remote calls, secrets, or operational activation.
import test from'node:test';import assert from'node:assert/strict';import{readFile,readdir}from'node:fs/promises';import{randomUUID}from'node:crypto';import{PGlite}from'@electric-sql/pglite';
import{bootstrap}from'./helpers/stock-reservation-fixture.mjs';import{prepareStockReservationsApply,prepareStockReservationsReadback,SOURCE_SHA256}from'./prepare_stock_reservations_apply.mjs';
test('070 applicator preserves all prior rows/permissions/contracts atomically and creates only empty reservation structures',async t=>{
 const db=new PGlite(),scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;let audit;
 try{
  await db.exec(bootstrap);const base=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(base)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=69).sort();assert.equal(files.length,69);for(const file of files)await db.exec(await readFile(new URL(file,base),'utf8'));
  const actor=randomUUID();await db.query('insert into auth.users values($1)',[actor]);await db.query("insert into erp_access.membership(user_id,role)values($1,'admin')",[actor]);
  await db.exec("create table erp_stock.fixture070(id integer primary key,value text);insert into erp_stock.fixture070 values(1,'PRIVATE_SYNTHETIC');alter table erp_stock.fixture070 enable row level security;create policy fixture_read on erp_stock.fixture070 for select to authenticated using(false);grant select(value)on erp_stock.fixture070 to authenticated;");
  const rpc=async(name,args)=>scalar(`select public.${name}(${Object.keys(args).map((k,i)=>`${k}=>$${i+1}`).join(',')})v`,Object.values(args).map(v=>v&&typeof v==='object'?JSON.stringify(v):v));
  const catalog=async(entity,data)=>(await rpc('erp_catalog_save',{p_user_id:actor,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data})).record;
  const p=await catalog('products',{name:'PRIVATE_SYNTHETIC_PRODUCT',unit:'UN',kind:'P',format:'S'}),w=await catalog('warehouses',{name:'PRIVATE_SYNTHETIC_WAREHOUSE'}),c=await catalog('contacts',{name:'PRIVATE_SYNTHETIC_CONTACT'});
  const d=(await rpc('erp_document_save',{p_user_id:actor,p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-15',contact_id:c.id,warehouse_id:w.id,items:[{product_id:p.id,description:'PRIVATE_SYNTHETIC_ITEM',unit:'UN',quantity:'1',unit_price:'1'}]}})).document;
  await rpc('erp_stock_post',{p_user_id:actor,p_command_id:randomUUID(),p_kind:'receipt',p_occurred_on:'2026-10-15',p_reason:'PRIVATE_SYNTHETIC_STOCK',p_items:[{product_id:p.id,warehouse_id:w.id,quantity:'10',expected_version:0}]});
  const sql=await prepareStockReservationsApply(),readback=await prepareStockReservationsReadback(),inject=value=>sql.replace(' EXECUTE source_body;',()=> ' EXECUTE source_body;\n '+value);
  const absent=async()=>{assert.equal(await scalar("select to_regclass('erp_stock.reservation')::text v"),null);assert.equal(await scalar("select count(*)::int v from pg_proc where proname='erp_stock_reservation_get'"),0);assert.equal(await scalar("select value v from erp_stock.fixture070 where id=1"),'PRIVATE_SYNTHETIC');};
  const probes=[
   ['source SHA',sql.replace('-- Reserva integral e explícita','-- Alterada integral e explícita'),'22023','source_hash_mismatch'],
   ['dependency pin',sql.replace('"erp_stock.require_access(uuid,boolean)":"','"erp_stock.require_access(uuid,boolean)":"0'),'55000','previous_contract_changed'],
   ['old row rollback',inject("update erp_stock.fixture070 set value='INJECTED';"),'40001','existing_data_changed'],
   ['old document rollback',inject(`update erp_documents.document set version=version+1 where id='${d.id}';`),'40001','existing_data_changed'],
   ['table inventory',inject('create table erp_stock.injected070(id integer);'),'40001','table_inventory_changed'],
   ['old table grant',inject('grant select on erp_stock.fixture070 to service_role;'),'42501','table_security_changed'],
   ['old table RLS',inject('alter table erp_stock.fixture070 disable row level security;'),'42501','table_security_changed'],
   ['old column grant',inject('grant update(value)on erp_stock.fixture070 to authenticated;'),'42501','table_security_changed'],
   ['old policy removed',inject('drop policy fixture_read on erp_stock.fixture070;'),'42501','table_security_changed'],
   ['schema grant',inject('grant usage on schema erp_stock to authenticated;'),'42501','schema_security_changed'],
   ['old RPC grant',inject('grant execute on function public.erp_stock_post(uuid,uuid,text,date,text,jsonb,text)to anon;'),'40001','other_functions_changed'],
   ['new public RPC grant',inject('grant execute on function public.erp_stock_reservation_command(uuid,uuid)to authenticated;'),'42501','function_contract_failed'],
   ['new private helper grant',inject('grant execute on function erp_stock.reserved_quantity(uuid,uuid)to service_role;'),'42501','function_contract_failed'],
   ['new table RLS',inject('alter table erp_stock.reservation disable row level security;'),'42501','private_table_failed'],
   ['new table grant',inject('grant select on erp_stock.reservation to service_role;'),'42501','private_table_failed'],
   ['new column grant',inject('grant select(result)on erp_stock.reservation_command to authenticated;'),'42501','private_table_failed'],
   ['new policy',inject('create policy injected on erp_stock.reservation using(true);'),'42501','private_table_failed'],
   ['new command forbidden',inject(`insert into erp_stock.reservation_command(id,actor,document_id,request_hash,result)values('${randomUUID()}','${actor}','${d.id}',repeat('a',64),'{}');`),'40001','new_table_not_empty'],
   ['default privileges',inject('alter default privileges in schema erp_stock grant select on tables to authenticated;'),'42501','default_privileges_changed'],
   ['reservation immutable trigger',inject('alter table erp_stock.reservation disable trigger immutable_reservation;'),'40001','table_contract_failed'],
   ['balance floor trigger',inject('alter table erp_stock.balance disable trigger protect_reserved_balance;'),'40001','guard_contract_failed'],
   ['deferred physical binding',inject('alter table erp_stock.reservation drop constraint reservation_consumed_command_id_fkey;'),'40001','consumption_contract_failed'],
   ['extra RPC',inject('create function public.erp_stock_reservation_command(integer)returns integer language sql as $$select $1$$;'),'40001','other_functions_changed'],
  ];
  for(const[name,input,code,message]of probes)await t.test(name,async()=>{assert.notEqual(input,sql);try{await assert.rejects(db.exec(input),e=>e.code===code&&e.message.includes(message));}finally{await db.exec('rollback;');}await absent();});
  await t.test('existing overload prevents partial apply',async()=>{await db.exec('begin;create function public.erp_stock_reservation_get(integer)returns integer language sql as $$select $1$$;');try{await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('already_present'));}finally{await db.exec('rollback;');}await absent();});
  await t.test('success preserves all baseline rows and function identity/security',async()=>{const rows=(await db.exec(sql)).flatMap(r=>r.rows??[]).filter(r=>r.stock_reservations_apply_audit);assert.equal(rows.length,1);audit=rows[0].stock_reservations_apply_audit;assert.equal(audit.source_sha256,SOURCE_SHA256);assert.deepEqual(audit.before,audit.after);assert.ok(audit.protected_table_count>=146);assert.equal(audit.new_service_only_rpcs,5);assert.equal(audit.new_private_helpers,15);assert.equal(audit.replaced_functions,1);assert.equal(audit.reviewed_functions,21);assert.equal(audit.new_tables,3);assert.equal(audit.before['erp_stock.movement'].count,1);assert.equal(audit.before['erp_documents.document'].count,1);assert.equal(audit.operation_activated,false);for(const k of['reservations_created','movements_created','balances_initialized'])assert.equal(audit[k],0);assert.doesNotMatch(JSON.stringify(audit),/PRIVATE_SYNTHETIC|INJECTED/);});
  await t.test('read-only commit readback matches apply audit and new private contracts',async()=>{const rows=(await db.exec(readback)).flatMap(r=>r.rows??[]).filter(r=>r.stock_reservations_commit_readback),r=rows[0].stock_reservations_commit_readback;assert.deepEqual(r.legacy_rows,audit.after);assert.equal(r.source_sha256,audit.source_sha256);for(const k of['legacy_table_security_sha256','schema_security_sha256','other_functions_sha256','default_privileges_sha256','replaced_function_security_sha256'])assert.equal(r[k],audit[k],k);assert.equal(r.guards_verified,7);assert.equal(r.operation_activated,false);assert.equal(await scalar("select nullif(current_setting('brufap.stock_070_readback',true),'')is null v"),true);});
  await t.test('reapply is refused without changing history',async()=>{try{await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('already_present'));}finally{await db.exec('rollback;');}assert.equal(await scalar('select count(*)::int v from erp_stock.reservation'),0);assert.equal(await scalar('select count(*)::int v from erp_stock.movement'),1);});
 }finally{await db.close();}
});
