// Disposable local PGlite; no credentials, external IO or execution of a remote apply.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PROFILES,CNPJ} from '../../packages/cnab-core/test/fixtures.mjs';
import {PGlite} from '@electric-sql/pglite';
import {prepareItauOperationalV2Apply,SOURCE_SHA256} from './prepare_itau_operational_v2_apply.mjs';

test('067 applicator is atomic, pins dependencies, protects all existing data/security and exposes only eight new RPCs and twelve private helpers',async t=>{
 const db=new PGlite();
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;
 const absent=async()=>{assert.equal(await scalar("select to_regclass('erp_cnab.operational_encoding_revision')::text v"),null);assert.equal(await scalar("select count(*)::int v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='erp_cnab_operational_profiles_v2'"),0);};
 try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
  const base=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(base)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=66).sort();
  assert.equal(files.length,66); // Complete current baseline, including the already applied064.
  for(const file of files)await db.exec(await readFile(new URL(file,base),'utf8'));
  const actor=randomUUID();await db.query('insert into auth.users values($1)',[actor]);await db.query("insert into erp_access.membership(user_id,role)values($1,'admin')",[actor]);
  const account=await scalar("select public.erp_finance_execute($1,$2,'account_save',$3::jsonb)v",[actor,randomUUID(),JSON.stringify({expected_version:0,name:'PRIVATE_SYNTHETIC_ACCOUNT_067',kind:'bank'})]);
  await db.exec("insert into storage.buckets values('brufap-cnab','brufap-cnab',false,4020000,ARRAY['application/octet-stream'])");
  const rpc=async(name,args)=>scalar(`select public.${name}(${Object.keys(args).map((k,i)=>`${k}=>$${i+1}`).join(',')})v`,Object.values(args).map(v=>v&&typeof v==='object'?JSON.stringify(v):v));
  const today=await scalar("select(clock_timestamp()at time zone'America/Sao_Paulo')::date::text v");
  await rpc('erp_company_save_identity',{p_user_id:actor,p_command_id:randomUUID(),p_expected_version:0,p_data:{legal_name:'PRIVATE SYNTHETIC BENEFICIARY',cnpj:CNPJ,postal_code:'13400000',street:'RUA FICTICIA',number:'1',district:'TESTE',city:'PIRACICABA',municipality_code:'3538709',state:'SP'}});
  const{accountId,...core}=PROFILES.itau;
  const profile=(await rpc('erp_cnab_profile_save',{p_user_id:actor,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{...core,account_id:account.record.id,ourNumberStart:'00000001',remittanceSequenceStart:'1'}})).profile;
  await rpc('erp_cnab_operational_approve',{p_user_id:actor,p_profile_id:profile.id,p_command_id:randomUUID(),p_expected_approval:0,p_expected_profile:1,p_expected_identity:1,p_enabled:true,p_confirmed_on:today,p_reference:'PRIVATE SYNTHETIC LEGACY APPROVAL'});
  // Include real protected data plus a policy/column ACL in the baseline; none is promoted.
  await db.exec("create policy fixture_read on erp_finance.account for select to authenticated using(false);grant select(name)on erp_finance.account to authenticated;");
  const sql=await prepareItauOperationalV2Apply(),inject=value=>sql.replace(' EXECUTE source_body;',()=> ' EXECUTE source_body;\n '+value);
  const before=await scalar("select jsonb_build_object('account',(select jsonb_agg(to_jsonb(t))from erp_finance.account t),'commands',(select jsonb_agg(to_jsonb(t))from erp_finance.command t))v");
  const probes=[
   ['source hash',sql.replace('Explicit Itaú encoding profiles','Altered Itaú encoding profiles'),'22023','source_hash_mismatch'],
   ['dependency pin',sql.replace('"erp_cnab.access(uuid,boolean,boolean)":"','"erp_cnab.access(uuid,boolean,boolean)":"0'),'55000','previous_contract_changed'],
   ['data rollback',inject("UPDATE erp_finance.account SET name='INJECTED_CHANGE';"),'40001','existing_data_changed'],
   ['table inventory',inject('CREATE TABLE erp_cnab.injected_067(id integer);'),'40001','table_inventory_changed'],
   ['table grant',inject('GRANT SELECT ON erp_finance.account TO authenticated;'),'42501','table_security_changed'],
   ['schema grant',inject('GRANT USAGE ON SCHEMA erp_cnab TO service_role;'),'42501','schema_security_changed'],
   ['existing RPC grant',inject('GRANT EXECUTE ON FUNCTION public.erp_finance_execute(uuid,uuid,text,jsonb)TO anon;'),'40001','other_functions_changed'],
   ['new RPC grant',inject('GRANT EXECUTE ON FUNCTION public.erp_cnab_operational_profiles_v2(uuid)TO authenticated;'),'42501','function_contract_failed'],
   ['old column grant',inject('GRANT UPDATE(name)ON erp_finance.account TO authenticated;'),'42501','table_security_changed'],
   ['old policy changed',inject('DROP POLICY fixture_read ON erp_finance.account;'),'42501','table_security_changed'],
   ['new private helper exposed',inject('GRANT EXECUTE ON FUNCTION erp_cnab.encoding_terms(bigint,date,boolean)TO service_role;'),'42501','function_contract_failed'],
   ['new table RLS',inject('ALTER TABLE erp_cnab.operational_encoding_revision DISABLE ROW LEVEL SECURITY;'),'42501','private_table_failed'],
   ['new table grant',inject('GRANT SELECT ON erp_cnab.operational_encoding_revision TO service_role;'),'42501','private_table_failed'],
   ['new table column grant',inject('GRANT SELECT(policy_hash)ON erp_cnab.operational_encoding_revision TO authenticated;'),'42501','private_table_failed'],
   ['new table policy',inject('CREATE POLICY injected ON erp_cnab.operational_encoding_revision USING(true);'),'42501','private_table_failed'],
   ['immutability trigger disabled',inject('ALTER TABLE erp_cnab.operational_encoding_revision DISABLE TRIGGER operational_encoding_revision_immutable;'),'40001','table_contract_failed'],
   ['new approval forbidden',inject("INSERT INTO erp_cnab.operational_encoding_revision SELECT profile_id,version,ARRAY['itau109-no-charges-v1'],false,false,repeat('a',64) FROM erp_cnab.operational_approval_revision;"),'40001','new_table_not_empty'],
   ['counter forbidden',inject('UPDATE erp_cnab.profile SET next_sequence=next_sequence+1;'),'40001','existing_data_changed'],
   ['default ACL changed',inject('ALTER DEFAULT PRIVILEGES IN SCHEMA erp_cnab GRANT SELECT ON TABLES TO authenticated;'),'42501','default_privileges_changed'],
   ['replaced function body',inject('CREATE OR REPLACE FUNCTION erp_cnab.operational_status(p_id uuid)RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$SELECT null::jsonb$$;'),'42501','function_contract_failed'],
   ['new extra RPC',inject('CREATE FUNCTION public.erp_cnab_itau_boleto_items(integer)RETURNS integer LANGUAGE sql AS $$SELECT $1$$;'),'40001','other_functions_changed'],
  ];
  for(const[name,input,code,message]of probes)await t.test(name,async()=>{
   assert.notEqual(input,sql);try{await assert.rejects(db.exec(input),e=>e.code===code&&e.message.includes(message));}finally{await db.exec('rollback;');}await absent();
   assert.equal(await scalar("select to_regclass('erp_cnab.injected_067')::text v"),null);
   assert.deepEqual(await scalar("select jsonb_build_object('account',(select jsonb_agg(to_jsonb(t))from erp_finance.account t),'commands',(select jsonb_agg(to_jsonb(t))from erp_finance.command t))v"),before);
  });
  await t.test('existing overload prevents apply',async()=>{
   await db.exec('begin;create function public.erp_cnab_operational_profiles_v2(integer)returns integer language sql as $$select $1$$;');
   await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('already_present'));await db.exec('rollback;');await absent();
  });
  await t.test('success preserves complete inventory and function contracts without activating operations',async()=>{
   const result=await db.exec(sql),rows=result.flatMap(x=>x.rows??[]).filter(x=>x.itau_operational_v2_apply_audit);assert.equal(rows.length,1);
   const a=rows[0].itau_operational_v2_apply_audit;assert.equal(a.source_sha256,SOURCE_SHA256);assert.equal(a.new_service_only_rpcs,8);assert.equal(a.new_private_helpers,12);assert.equal(a.replaced_functions,10);assert.equal(a.reviewed_functions,30);assert.equal(a.new_tables,1);assert.ok(a.protected_table_count>=143);assert.deepEqual(a.before,a.after);
   for(const k of ['before_equals_after','table_security_unchanged','schema_security_unchanged','other_functions_unchanged','replaced_function_security_unchanged','default_privileges_unchanged','new_table_empty','new_table_rls','new_table_owner_only'])assert.equal(a[k],true,k);
   for(const k of ['operation_activated','financial_mutation_performed','stock_mutation_performed','can_issue','can_transmit','can_pay'])assert.equal(a[k],false,k);
   assert.equal(a.before['erp_finance.account'].count,1);assert.equal(a.before['erp_cnab.billing_title'].count,0);assert.equal(a.before['erp_cnab.remittance'].count,0);
   assert.doesNotMatch(JSON.stringify(a),/PRIVATE_SYNTHETIC_ACCOUNT|INJECTED_CHANGE|"payload"|"snapshot"|"cnpj"/);
   assert.equal(a.before['erp_cnab.profile'].count,1);assert.equal(a.before['erp_cnab.operational_approval_revision'].count,1);assert.equal(a.table_locks,'share_row_exclusive_nowait');
   for(const fn of ['erp_cnab_operational_profiles_v2']){
    for(const role of ['anon','authenticated'])assert.equal(await scalar('select has_function_privilege($1,$2,\'EXECUTE\')v',[role,`public.${fn}(uuid)`]),false);
    assert.equal(await scalar('select has_function_privilege(\'service_role\',$1,\'EXECUTE\')v',[`public.${fn}(uuid)`]),true);
   }
  });
  await t.test('reapply fails without altering the first result',async()=>{await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('already_present'));await db.exec('rollback;');assert.equal(await scalar("select count(*)::int v from erp_finance.account"),1);});
 }finally{await db.close();}
});
