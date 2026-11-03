// Disposable local PGlite; no credentials, external IO or execution of a remote apply.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {prepareFiscalAuthorizationApply,SOURCE_SHA256} from './prepare_fiscal_authorization_apply.mjs';

test('064 applicator preserves prior data/security and installs a disabled private ledger atomically',async t=>{
 const db=new PGlite();
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;
 const absent=async()=>assert.equal(await scalar("select to_regnamespace('erp_fiscal_authorization')::text v"),null);
 try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
  const base=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(base)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&(+n.slice(9,12)<=63||[65,66].includes(+n.slice(9,12)))).sort();
  assert.equal(files.length,65); // Current remote prerequisite set:001–063,065,066.
  for(const file of files)await db.exec(await readFile(new URL(file,base),'utf8'));
  const actor=randomUUID();await db.query('insert into auth.users values($1)',[actor]);await db.query("insert into erp_access.membership(user_id,role)values($1,'admin')",[actor]);
  await scalar("select public.erp_finance_execute($1,$2,'account_save',$3::jsonb)v",[actor,randomUUID(),JSON.stringify({expected_version:0,name:'PRIVATE_SYNTHETIC_ACCOUNT_064',kind:'bank'})]);
  await db.exec("insert into storage.buckets values('brufap-cnab','brufap-cnab',false,4020000,ARRAY['application/octet-stream'])");
  const sql=await prepareFiscalAuthorizationApply(),inject=value=>sql.replace(' EXECUTE source_body;',()=> ' EXECUTE source_body;\n '+value);
  const before=await scalar("select jsonb_build_object('account',(select jsonb_agg(to_jsonb(t))from erp_finance.account t),'commands',(select jsonb_agg(to_jsonb(t))from erp_finance.command t))v");
  const probes=[
   ['source hash',sql.replace('Local authorization ledger.','Tampered authorization ledger.'),'22023','source_hash_mismatch'],
   ['dependency pin',sql.replace('"erp_a1.access(uuid,boolean)":"','"erp_a1.access(uuid,boolean)":"0'),'55000','previous_contract_changed'],
   ['data rollback',inject("UPDATE erp_finance.account SET name='INJECTED_CHANGE';"),'40001','existing_data_changed'],
   ['table inventory',inject('CREATE TABLE erp_cnab.injected_064(id integer);'),'40001','table_inventory_changed'],
   ['table grant',inject('GRANT SELECT ON erp_finance.account TO authenticated;'),'42501','table_security_changed'],
   ['schema grant',inject('GRANT USAGE ON SCHEMA erp_cnab TO service_role;'),'42501','schema_security_changed'],
   ['existing RPC grant',inject('GRANT EXECUTE ON FUNCTION public.erp_finance_execute(uuid,uuid,text,jsonb)TO anon;'),'40001','other_functions_changed'],
   ['new RPC grant',inject('GRANT EXECUTE ON FUNCTION public.erp_fiscal_authorization_command(uuid,uuid)TO authenticated;'),'42501','rpc_contract_failed'],
   ['new extra RPC',inject('CREATE FUNCTION public.erp_fiscal_authorization_history(integer)RETURNS integer LANGUAGE sql AS $$SELECT $1$$;'),'40001','other_functions_changed'],
   ['private function grant',inject('GRANT EXECUTE ON FUNCTION erp_fiscal_authorization.flags()TO service_role;'),'42501','rpc_contract_failed'],
   ['new table grant',inject('GRANT SELECT ON erp_fiscal_authorization.attempt TO authenticated;'),'42501','private_schema_failed'],
   ['new schema grant',inject('GRANT USAGE ON SCHEMA erp_fiscal_authorization TO service_role;'),'42501','private_schema_failed'],
   ['new RLS disabled',inject('ALTER TABLE erp_fiscal_authorization.attempt DISABLE ROW LEVEL SECURITY;'),'42501','private_schema_failed'],
   ['new RLS policy',inject('CREATE POLICY injected ON erp_fiscal_authorization.attempt FOR SELECT TO service_role USING(true);'),'42501','private_schema_failed'],
   ['new table owner',inject('ALTER TABLE erp_fiscal_authorization.audit OWNER TO anon;'),'42501','private_schema_failed'],
   ['history guard disabled',inject('ALTER TABLE erp_fiscal_authorization.audit DISABLE TRIGGER immutable;'),'42501','history_protection_failed'],
   ['future function access',inject('ALTER DEFAULT PRIVILEGES IN SCHEMA erp_fiscal_authorization GRANT EXECUTE ON FUNCTIONS TO anon;'),'42501','history_protection_failed'],
   ['unexpected policy',inject("INSERT INTO erp_fiscal_authorization.policy(model,version,origin,enabled,binding_reviewed,tax_rules_reviewed,valid_from,valid_until) VALUES('55',2,'operational',false,false,false,'2026-10-16','2026-10-26');"),'42501','disabled_policy_failed'],
  ];
  for(const[name,input,code,message]of probes)await t.test(name,async()=>{
   assert.notEqual(input,sql);try{await assert.rejects(db.exec(input),e=>e.code===code&&e.message.includes(message));}finally{await db.exec('rollback;');}await absent();
   assert.equal(await scalar("select to_regclass('erp_cnab.injected_064')::text v"),null);
   assert.deepEqual(await scalar("select jsonb_build_object('account',(select jsonb_agg(to_jsonb(t))from erp_finance.account t),'commands',(select jsonb_agg(to_jsonb(t))from erp_finance.command t))v"),before);
  });
  await t.test('existing overload prevents apply',async()=>{
   await db.exec('begin;create function public.erp_fiscal_authorization_command(integer)returns integer language sql as $$select $1$$;');
   await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('already_present'));await db.exec('rollback;');await absent();
  });
  await t.test('success preserves complete inventory and function contracts without activating operations',async()=>{
   const result=await db.exec(sql),rows=result.flatMap(x=>x.rows??[]).filter(x=>x.authorization_apply_audit);assert.equal(rows.length,1);
   const a=rows[0].authorization_apply_audit;assert.equal(a.source_sha256,SOURCE_SHA256);assert.equal(a.new_service_only_rpcs,8);assert.equal(a.new_tables,7);assert.equal(a.new_private_functions,14);assert.equal(a.seeded_disabled_policies,2);assert.ok(a.protected_table_count>=136);assert.deepEqual(a.before,a.after);
   for(const k of ['before_equals_after','table_security_unchanged','schema_security_unchanged','other_functions_unchanged'])assert.equal(a[k],true,k);
   for(const k of ['operation_activated','financial_mutation_performed','stock_mutation_performed','can_issue','can_transmit','can_pay'])assert.equal(a[k],false,k);
   assert.equal(a.before['erp_finance.account'].count,1);assert.equal(a.before['erp_cnab.billing_title'].count,0);assert.equal(a.before['erp_cnab.remittance'].count,0);
   assert.doesNotMatch(JSON.stringify(a),/PRIVATE_SYNTHETIC_ACCOUNT|INJECTED_CHANGE|"payload"|"snapshot"|"cnpj"/);
   for(const fn of ['erp_fiscal_authorization_command']){
    for(const role of ['anon','authenticated'])assert.equal(await scalar('select has_function_privilege($1,$2,\'EXECUTE\')v',[role,`public.${fn}(uuid,uuid)`]),false);
    assert.equal(await scalar('select has_function_privilege(\'service_role\',$1,\'EXECUTE\')v',[`public.${fn}(uuid,uuid)`]),true);
   }
  });
  await t.test('reapply fails without altering the first result',async()=>{await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('already_present'));await db.exec('rollback;');assert.equal(await scalar("select count(*)::int v from erp_finance.account"),1);});
 }finally{await db.close();}
});
