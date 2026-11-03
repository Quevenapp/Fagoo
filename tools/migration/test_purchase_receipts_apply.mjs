import{seedPurchaseReceiptsLegacyApply}from'./helpers/purchase-receipts-apply-fixture.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {readFile,readdir}from'node:fs/promises';import {randomUUID}from'node:crypto';import{PGlite}from'@electric-sql/pglite';
import{bootstrap,quote}from'./helpers/financial-import-postgres-fixture.mjs';import{seedFinancialImportAuthorizationApply}from'./helpers/financial-import-authorization-apply-fixture.mjs';import{preparePurchaseReceiptsApply,preparePurchaseReceiptsReadback,verifyPurchaseReceiptsCommit}from'./prepare_purchase_receipts_apply.mjs';
test('090 audited installation preserves complete001–089 and requires independent commit readback',async t=>{
 const db=new PGlite(),scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;
 const result=r=>Object.values(r.flatMap(x=>x.rows??[]).at(-1))[0];
 try{
  await db.exec(bootstrap);const root=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(root)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=89).sort();assert.equal(files.length,89);assert.ok(files.every((f,i)=>+f.slice(9,12)===i+1));for(const file of files)await db.exec(await readFile(new URL(file,root),'utf8'));
  const rpc=async(name,args)=>result(await db.exec(`begin;set local role service_role;select public.${name}(${Object.entries(args).map(([k,v])=>k+'=>'+quote(v)).join(',')});commit;`));
  await seedFinancialImportAuthorizationApply({run:s=>db.exec(s),result,ok:x=>x,rpc});
  const legacy=await seedPurchaseReceiptsLegacyApply({run:s=>db.exec(s),ok:x=>x,rpc});
  const sql=await preparePurchaseReceiptsApply(),readback=await preparePurchaseReceiptsReadback(),inject=value=>sql.replace('-- reviewed functions created',()=> '-- reviewed functions created\n '+value);
  const absent=async()=>{assert.equal(await scalar("select to_regnamespace('erp_purchase_receipts')::text v"),null);assert.equal(await scalar('select value v from erp_access.fixture087 where id=1'),'PRIVATE_SENTINEL');assert.equal(await scalar('select count(*)::int v from erp_sales_history.snapshot'),276);assert.equal(await scalar('select count(*)::int v from erp_finance.title'),1);};
  const newRpc='public.erp_purchase_receipts_get(uuid,uuid,integer,uuid,uuid)',changed='public.erp_stock_reverse(uuid,uuid,uuid,date,text,jsonb)';
  const probes=[
   ['source hash',sql.replace('-- Native purchase receipts only.','-- Altered purchase receipts.'),'22023','source_hash_mismatch'],
   ['805 previous function hashes',sql.replace('"erp_a1.company()":"','"erp_a1.company()":"0'),'55000','previous_contract_changed'],
   ['old dynamic data',inject("update erp_access.fixture087 set value='CHANGED';"),'40001','existing_data_changed'],
   ['auth users',inject(`insert into auth.users values('${randomUUID()}');`),'40001','existing_data_changed'],
   ['storage metadata',inject("update storage.objects set metadata='{\"changed\":true}'where bucket_id='fixture087';"),'40001','existing_data_changed'],
   ['new unexpected table',inject('create table erp_access.unexpected090(id integer);'),'40001','table_inventory_changed'],
   ['prior table ACL',inject('grant select on erp_access.fixture087 to service_role;'),'42501','table_security_changed'],
   ['prior column ACL',inject('grant update(value)on erp_access.fixture087 to service_role;'),'42501','table_security_changed'],
   ['prior RLS',inject('alter table erp_access.fixture087 disable row level security;'),'42501','table_security_changed'],
   ['prior policy',inject('drop policy fixture_read on erp_access.fixture087;'),'42501','table_security_changed'],
   ['prior schema ACL',inject('grant usage on schema erp_access to anon;'),'42501','schema_security_changed'],
   ['global defaults',inject('alter default privileges grant select on tables to anon;'),'42501','default_privileges_changed'],
   ['prior function ACL',inject('grant execute on function public.erp_access_me(uuid)to anon;'),'40001','other_functions_changed'],
   ['redefined function ACL',inject(`grant execute on function ${changed}to anon;`),'40001','other_functions_changed'],
   ['redefined function OID',inject(`do $probe$declare d text;begin d:=pg_get_functiondef('${changed}'::regprocedure);drop function ${changed};execute d;revoke all on function ${changed}from public,anon,authenticated;grant execute on function ${changed}to service_role;end$probe$;`),'40001','other_functions_changed'],
   ['new RPC ACL',inject(`grant execute on function ${newRpc}to authenticated;`),'42501','function_acl_failed'],
   ['new RPC delegation',inject(`grant execute on function ${newRpc}to service_role with grant option;`),'42501','function_acl_failed'],
   ['new RPC body',inject(`do $probe$begin execute replace(pg_get_functiondef('${newRpc}'::regprocedure),'purchase_receipt_document_not_found','purchase_receipt_document_not_found_changed');end$probe$;`),'42501','function_contract_failed'],
   ['new helper grant',inject('grant execute on function erp_purchase_receipts.active(uuid)to service_role;'),'42501','function_acl_failed'],
   ['new helper path',inject('alter function erp_purchase_receipts.active(uuid)set search_path=public;'),'42501','function_contract_failed'],
   ['new namespace grant',inject('grant usage on schema erp_purchase_receipts to anon;'),'42501','private_schema_failed'],
   ['new table grant',inject('grant select on erp_purchase_receipts.receipt to service_role;'),'42501','private_table_failed'],
   ['new table RLS',inject('alter table erp_purchase_receipts.receipt disable row level security;'),'42501','private_table_failed'],
   ['new foreign key removed',inject('alter table erp_purchase_receipts.receipt drop constraint receipt_actor_fkey;'),'40001','table_contract_failed'],
   ['new deferred constraint',inject('alter table erp_purchase_receipts.receipt alter constraint receipt_command_id_fkey not deferrable;'),'40001','table_contract_failed'],
   ['new guard removed',inject('drop trigger protect_purchase_receipt_document on erp_documents.document;'),'40001','table_contract_failed'],
   ['new guard disabled',inject('alter table erp_documents.item disable trigger protect_purchase_receipt_item;'),'40001','table_contract_failed'],
   ['new immutable trigger removed',inject('drop trigger immutable_purchase_receipt on erp_purchase_receipts.receipt;'),'40001','table_contract_failed'],
   ['new extra function',inject('create function erp_purchase_receipts.extra()returns integer language sql as $$select 1$$;'),'40001','function_inventory_changed'],
  ];
  for(const[label,probe,code,message]of probes)await t.test('rollback: '+label,async()=>{await assert.rejects(()=>db.exec(probe),e=>e.code===code&&e.message.includes(message),label);await db.exec('rollback;');await absent();});
  await t.test('requires089 even though090 execution has no fiscal dependency',async()=>{await db.exec('alter table erp_fiscal_receipt_query.query rename to missing089');try{await assert.rejects(()=>db.exec(sql),e=>e.message.includes('prerequisite_missing'));await db.exec('rollback;');await absent();}finally{await db.exec('alter table erp_fiscal_receipt_query.missing089 rename to query');}});
  await t.test('rejects partial namespace before DDL',async()=>{await db.exec('create schema erp_purchase_receipts');try{await assert.rejects(()=>db.exec(sql),e=>e.message.includes('already_present'));await db.exec('rollback;');}finally{await db.exec('drop schema erp_purchase_receipts');}});
  let audit,back;
  await t.test('valid install preserves165 tables,276 history snapshots and all prior function identities/ACL',async()=>{audit=result(await db.exec(sql));assert.equal(audit.protected_table_count,165);assert.equal(audit.before_equals_after,true);assert.deepEqual(audit.before,audit.after);assert.equal(audit.after['erp_sales_history.snapshot'].count,276);assert.equal(audit.after['erp_finance.title'].count,1);assert.equal(audit.after['erp_stock.document_posting'].count,1);for(const n of['receipt','reversal','command'])assert.equal(await scalar(`select count(*)::int v from erp_purchase_receipts.${n}`),0);});
  await t.test('readback proves post-COMMIT equality without modifying data',async()=>{back=result(await db.exec(readback));assert.deepEqual(verifyPurchaseReceiptsCommit({audit,readback:back,commitAcknowledged:true}),{confirmed:true,migrations:['090'],protected_table_count:165});});
  await t.test('018 original command replays and090 preserves legacy mode',async()=>{assert.deepEqual(await rpc('erp_document_stock_post',legacy.args),{...legacy.receipt,replayed:true});const current=await rpc('erp_purchase_receipts_get',{p_user_id:legacy.actor,p_document_id:legacy.document.id});assert.equal(current.current.document.mode,'legacy_full');assert.deepEqual(current.current.items,[]);assert.deepEqual(result(await db.exec(readback)),back);});
  await t.test('audit alone, missing ACK or mismatched later state never certify installation',async()=>{for(const bad of[{audit,commitAcknowledged:true},{audit,readback:back,commitAcknowledged:false},{audit,readback:{...back,rows:{}},commitAcknowledged:true},{audit,readback:{...back,other_functions_sha256:'0'.repeat(64)},commitAcknowledged:true}])assert.throws(()=>verifyPurchaseReceiptsCommit(bad),/COMMIT_NOT_CONFIRMED/);});
  await t.test('second install refuses without altering committed installation',async()=>{await assert.rejects(()=>db.exec(sql),e=>e.message.includes('already_present'));await db.exec('rollback;');assert.deepEqual(result(await db.exec(readback)),back);});
 }finally{await db.close();}
});
