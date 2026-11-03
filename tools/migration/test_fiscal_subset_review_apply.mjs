// Disposable local PGlite; no credentials, external IO or execution of a remote apply.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {prepareFiscalSubsetReviewApply,prepareFiscalSubsetReviewReadback,SOURCE_SHA256} from './prepare_fiscal_subset_review_apply.mjs';

test('068 applicator protects the complete001–067 baseline and introduces only a private empty review store',async t=>{
 const db=new PGlite();
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;
 const absent=async()=>{assert.equal(await scalar("select to_regclass('erp_fiscal_subset_review.review')::text v"),null);assert.equal(await scalar("select count(*)::int v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='erp_fiscal_subset_review_command'"),0);};
 try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
  const base=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(base)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=67).sort();
  assert.equal(files.length,67); // Complete current baseline, including the already applied064.
  for(const file of files)await db.exec(await readFile(new URL(file,base),'utf8'));
  const actor=randomUUID();await db.query('insert into auth.users values($1)',[actor]);await db.query("insert into erp_access.membership(user_id,role)values($1,'admin')",[actor]);
  const account=await scalar("select public.erp_finance_execute($1,$2,'account_save',$3::jsonb)v",[actor,randomUUID(),JSON.stringify({expected_version:0,name:'PRIVATE_SYNTHETIC_ACCOUNT_068',kind:'bank'})]);
  // Include real protected data plus a policy/column ACL in the baseline; none is promoted.
  await db.exec("create policy fixture_read on erp_finance.account for select to authenticated using(false);grant select(name)on erp_finance.account to authenticated;");
  await db.exec('alter default privileges in schema erp_documents grant select on tables to authenticated;');
  const sql=await prepareFiscalSubsetReviewApply(),inject=value=>sql.replace(' EXECUTE source_body;',()=> ' EXECUTE source_body;\n '+value);
  const before=await scalar("select jsonb_build_object('account',(select jsonb_agg(to_jsonb(t))from erp_finance.account t),'commands',(select jsonb_agg(to_jsonb(t))from erp_finance.command t))v");
  const probes=[
   ['source hash',sql.replace('Persisted declarations only','Altered declarations only'),'22023','source_hash_mismatch'],
   ['dependency pin',sql.replace('"erp_a1.access(uuid,boolean)":"','"erp_a1.access(uuid,boolean)":"0'),'55000','previous_contract_changed'],
   ['data rollback',inject("UPDATE erp_finance.account SET name='INJECTED_CHANGE';"),'40001','existing_data_changed'],
   ['table inventory',inject('CREATE TABLE erp_cnab.injected_067(id integer);'),'40001','table_inventory_changed'],
   ['table grant',inject('GRANT SELECT ON erp_finance.account TO authenticated;'),'42501','table_security_changed'],
   ['schema grant',inject('GRANT USAGE ON SCHEMA erp_cnab TO service_role;'),'42501','schema_security_changed'],
   ['existing RPC grant',inject('GRANT EXECUTE ON FUNCTION public.erp_finance_execute(uuid,uuid,text,jsonb)TO anon;'),'40001','other_functions_changed'],
   ['new RPC grant',inject('GRANT EXECUTE ON FUNCTION public.erp_fiscal_subset_review_command(uuid,uuid)TO authenticated;'),'42501','function_contract_failed'],
   ['old column grant',inject('GRANT UPDATE(name)ON erp_finance.account TO authenticated;'),'42501','table_security_changed'],
   ['old policy changed',inject('DROP POLICY fixture_read ON erp_finance.account;'),'42501','table_security_changed'],
   ['new private helper exposed',inject('GRANT EXECUTE ON FUNCTION erp_fiscal_subset_review.digest(text)TO service_role;'),'42501','function_contract_failed'],
   ['new table RLS',inject('ALTER TABLE erp_fiscal_subset_review.review DISABLE ROW LEVEL SECURITY;'),'42501','private_table_failed'],
   ['new table grant',inject('GRANT SELECT ON erp_fiscal_subset_review.review TO service_role;'),'42501','private_table_failed'],
   ['new table column grant',inject('GRANT SELECT(review_hash)ON erp_fiscal_subset_review.review TO authenticated;'),'42501','private_table_failed'],
   ['new table policy',inject('CREATE POLICY injected ON erp_fiscal_subset_review.review USING(true);'),'42501','private_table_failed'],
   ['immutability trigger disabled',inject('ALTER TABLE erp_fiscal_subset_review.review DISABLE TRIGGER immutable;'),'40001','table_contract_failed'],
   ['private schema exposed',inject('GRANT USAGE ON SCHEMA erp_fiscal_subset_review TO service_role;'),'42501','private_schema_failed'],
   ['default ACL changed',inject('ALTER DEFAULT PRIVILEGES IN SCHEMA erp_cnab GRANT SELECT ON TABLES TO authenticated;'),'42501','default_privileges_changed'],
   ['new default ACL exposed',inject('ALTER DEFAULT PRIVILEGES IN SCHEMA erp_fiscal_subset_review GRANT SELECT ON TABLES TO authenticated;'),'42501','private_schema_failed'],
   ['new function body',inject('CREATE OR REPLACE FUNCTION erp_fiscal_subset_review.digest(v text)RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$SELECT null::text$$;'),'42501','function_contract_failed'],
   ['new extra RPC',inject('CREATE FUNCTION public.erp_fiscal_subset_review_extra(integer)RETURNS integer LANGUAGE sql AS $$SELECT $1$$;'),'40001','other_functions_changed'],
  ];
  for(const[name,input,code,message]of probes)await t.test(name,async()=>{
   assert.notEqual(input,sql);try{await assert.rejects(db.exec(input),e=>e.code===code&&e.message.includes(message));}finally{await db.exec('rollback;');}await absent();
   assert.equal(await scalar("select to_regclass('erp_cnab.injected_067')::text v"),null);
   assert.deepEqual(await scalar("select jsonb_build_object('account',(select jsonb_agg(to_jsonb(t))from erp_finance.account t),'commands',(select jsonb_agg(to_jsonb(t))from erp_finance.command t))v"),before);
  });
  await t.test('existing overload prevents apply',async()=>{
   await db.exec('begin;create function public.erp_fiscal_subset_review_command(integer)returns integer language sql as $$select $1$$;');
   await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('already_present'));await db.exec('rollback;');await absent();
  });
  await t.test('success preserves complete inventory and function contracts without activating operations',async()=>{
   const result=await db.exec(sql),rows=result.flatMap(x=>x.rows??[]).filter(x=>x.fiscal_subset_review_apply_audit);assert.equal(rows.length,1);
   const a=rows[0].fiscal_subset_review_apply_audit;assert.equal(a.source_sha256,SOURCE_SHA256);assert.equal(a.new_service_only_rpcs,3);assert.equal(a.new_private_helpers,10);assert.equal(a.replaced_functions,0);assert.equal(a.reviewed_functions,13);assert.equal(a.new_tables,1);assert.ok(a.protected_table_count>=143);assert.deepEqual(a.before,a.after);
   for(const k of ['before_equals_after','table_security_unchanged','schema_security_unchanged','other_functions_unchanged','default_privileges_unchanged','new_table_empty','new_table_rls','new_table_owner_only'])assert.equal(a[k],true,k);
   for(const k of ['operation_activated','financial_mutation_performed','stock_mutation_performed','tax_rules_validated','can_emit','can_transmit'])assert.equal(a[k],false,k);
   assert.equal(a.before['erp_finance.account'].count,1);assert.equal(a.before['erp_cnab.billing_title'].count,0);assert.equal(a.before['erp_cnab.remittance'].count,0);
   assert.doesNotMatch(JSON.stringify(a),/PRIVATE_SYNTHETIC_ACCOUNT|INJECTED_CHANGE|"payload"|"snapshot"|"cnpj"/);
   assert.equal(a.authorization_policy_disabled,true);assert.equal(a.table_locks,'share_row_exclusive_nowait');
   for(const fn of ['erp_fiscal_subset_review_command']){
    for(const role of ['anon','authenticated'])assert.equal(await scalar('select has_function_privilege($1,$2,\'EXECUTE\')v',[role,`public.${fn}(uuid,uuid)`]),false);
    assert.equal(await scalar('select has_function_privilege(\'service_role\',$1,\'EXECUTE\')v',[`public.${fn}(uuid,uuid)`]),true);
   }
  });
  await t.test('reapply fails without altering the first result',async()=>{await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('already_present'));await db.exec('rollback;');assert.equal(await scalar("select count(*)::int v from erp_finance.account"),1);});
  await t.test('separate read-only proof confirms hashes, service-only ACL and disabled authorization',async()=>{
   const readback=await prepareFiscalSubsetReviewReadback();assert.match(readback,/BEGIN READ ONLY;/);assert.doesNotMatch(readback,/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|GRANT|REVOKE)\b/);
   const result=await db.exec(readback),rows=result.flatMap(x=>x.rows??[]).filter(x=>x.fiscal_subset_review_readback);assert.equal(rows.length,1);const a=rows[0].fiscal_subset_review_readback;
   assert.equal(a.source_sha256,SOURCE_SHA256);assert.equal(a.new_functions,13);assert.equal(a.new_service_only_rpcs,3);assert.equal(a.review_count,0);assert.equal(a.policy_count,0);assert.equal(a.authorization_attempts,0);assert.equal(a.authorization_commands,0);
   for(const k of ['function_contracts_valid','private_schema','private_table','table_rls','immutable_trigger','authorization_policies_disabled'])assert.equal(a[k],true,k);
   assert.doesNotMatch(JSON.stringify(a),/PRIVATE_SYNTHETIC_ACCOUNT|"payload"|"cnpj"/);
  });
 }finally{await db.close();}
});
