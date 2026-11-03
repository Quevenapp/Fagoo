// Disposable local001–068 baseline only. No HTTP, real credentials or remote execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {prepareReviewedAuthorizationApply,prepareReviewedAuthorizationReadback,SOURCE_SHA256} from './prepare_reviewed_authorization_apply.mjs';

test('069 applicator preserves old policy fields, all unrelated data/ACL and exact reviewed DDL',async t=>{
 const db=new PGlite();const scalar=async(s,args=[])=>(await db.query(s,args)).rows[0].v;
 const absent=async()=>{assert.equal(await scalar("select to_regnamespace('erp_fiscal_reviewed_authorization')::text v"),null);assert.equal(await scalar("select count(*)::int v from pg_attribute where attrelid='erp_fiscal_authorization.policy'::regclass and attname='authorization_profile'and not attisdropped"),0);};
 try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
  const root=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(root)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=68).sort();assert.equal(files.length,68);
  for(const f of files)await db.exec(await readFile(new URL(f,root),'utf8'));
  const actor=randomUUID();await db.query('insert into auth.users values($1)',[actor]);await db.query("insert into erp_access.membership(user_id,role)values($1,'admin')",[actor]);
  await scalar("select public.erp_finance_execute($1,$2,'account_save',$3::jsonb)v",[actor,randomUUID(),JSON.stringify({expected_version:0,name:'PRIVATE_SYNTHETIC_ACCOUNT_069',kind:'bank'})]);
  await db.exec("create policy fixture_read on erp_finance.account for select to authenticated using(false);grant select(name)on erp_finance.account to authenticated;alter default privileges in schema erp_documents grant select on tables to authenticated;");
  // A non-sequential existing policy version must remain byte-for-byte equivalent in every old field.
  await db.exec("insert into erp_fiscal_authorization.policy(model,version,origin,enabled,binding_reviewed,tax_rules_reviewed,valid_from,valid_until)values('55',7,'operational',false,false,false,'2026-10-16T00:00:00Z','2026-10-26T00:00:00Z');");
  // Dynamic inventory includes a non-empty unrelated private table, not only a hardcoded list.
  await db.exec("create table erp_fiscal_authorization.fixture_history(id integer primary key,payload jsonb not null);insert into erp_fiscal_authorization.fixture_history values(1,'{\"text\":\"PRIVATE_SYNTHETIC_HISTORY_ç\",\"price\":1.1234567890}');alter table erp_fiscal_authorization.fixture_history enable row level security;");
  const baseline=await scalar("select jsonb_build_object('policy',(select jsonb_agg(to_jsonb(p)order by model,version)from erp_fiscal_authorization.policy p),'account',(select jsonb_agg(to_jsonb(a))from erp_finance.account a),'history',(select jsonb_agg(to_jsonb(h))from erp_fiscal_authorization.fixture_history h))v");
  const sql=await prepareReviewedAuthorizationApply(),inject=x=>sql.replace(' EXECUTE source_body;',()=> ' EXECUTE source_body;\n '+x);
  await t.test('an enabled old policy refuses before disabled seeds could supersede it',async()=>{
   await db.exec("ALTER TABLE erp_fiscal_authorization.policy DISABLE TRIGGER immutable;UPDATE erp_fiscal_authorization.policy SET enabled=true,binding_profile='synthetic-fixture-binding',rule_profile='synthetic-fixture-rule',source_manifest_hash=repeat('a',64),binding_reviewed=true,tax_rules_reviewed=true WHERE model='65' AND version=1;ALTER TABLE erp_fiscal_authorization.policy ENABLE TRIGGER immutable;");
   const before=await scalar("select jsonb_agg(to_jsonb(p)order by model,version)v from erp_fiscal_authorization.policy p");
   try{await assert.rejects(db.exec(sql),e=>e.message.includes('active_policy_preflight_refused'));}finally{await db.exec('rollback;');}
   await absent();assert.deepEqual(await scalar("select jsonb_agg(to_jsonb(p)order by model,version)v from erp_fiscal_authorization.policy p"),before);
   await db.exec("ALTER TABLE erp_fiscal_authorization.policy DISABLE TRIGGER immutable;UPDATE erp_fiscal_authorization.policy SET enabled=false,binding_profile=null,rule_profile=null,source_manifest_hash=null,binding_reviewed=false,tax_rules_reviewed=false WHERE model='65' AND version=1;ALTER TABLE erp_fiscal_authorization.policy ENABLE TRIGGER immutable;");
  });
  const policyChange=x=>"ALTER TABLE erp_fiscal_authorization.policy DISABLE TRIGGER immutable;"+x+";ALTER TABLE erp_fiscal_authorization.policy ENABLE TRIGGER immutable;";
  const probes=[
   ['source pin',sql.replace('Versioned reviewed-subset ledger.','Unreviewed edited ledger.'),'source_hash_mismatch'],
   ['dependency pin',sql.replace('"erp_fiscal_authorization.check_policy(text,integer)":"','"erp_fiscal_authorization.check_policy(text,integer)":"0'),'previous_contract_changed'],
   ['unrelated native data',inject("UPDATE erp_finance.account SET name='INJECTED';"),'existing_data_changed'],
   ['dynamic historical data',inject("UPDATE erp_fiscal_authorization.fixture_history SET payload='{}';"),'existing_data_changed'],
   ['old policy value',inject(policyChange("UPDATE erp_fiscal_authorization.policy SET valid_until=valid_until+interval'1day' WHERE version=7")),'existing_data_changed'],
   ['old policy deletion',inject(policyChange("DELETE FROM erp_fiscal_authorization.policy WHERE version=7")),'existing_data_changed'],
   ['old policy discriminator',inject(policyChange("UPDATE erp_fiscal_authorization.policy SET authorization_profile='reviewed_subset_v1' WHERE version=7")),'legacy_policy_profile_changed'],
   ['new policy enabled',inject(policyChange("UPDATE erp_fiscal_authorization.policy SET enabled=true WHERE authorization_profile='reviewed_subset_v1'")),'policy_seeds_changed'],
   ['new policy deletion',inject(policyChange("DELETE FROM erp_fiscal_authorization.policy WHERE authorization_profile='reviewed_subset_v1' AND model='65'")),'policy_seeds_changed'],
   ['unexpected added table',inject('CREATE TABLE erp_documents.injected_069(id integer);'),'table_inventory_changed'],
   ['old table grant',inject('GRANT SELECT ON erp_finance.account TO authenticated;'),'table_security_changed'],
   ['old table RLS',inject('ALTER TABLE erp_finance.account DISABLE ROW LEVEL SECURITY;'),'table_security_changed'],
   ['old column grant',inject('GRANT UPDATE(name)ON erp_finance.account TO authenticated;'),'table_security_changed'],
   ['old policy definition',inject('DROP POLICY fixture_read ON erp_finance.account;'),'table_security_changed'],
   ['old schema grant',inject('GRANT USAGE ON SCHEMA erp_cnab TO authenticated;'),'schema_security_changed'],
   ['old default ACL',inject('ALTER DEFAULT PRIVILEGES IN SCHEMA erp_cnab GRANT SELECT ON TABLES TO authenticated;'),'default_privileges_changed'],
   ['new column default',inject("ALTER TABLE erp_fiscal_authorization.policy ALTER COLUMN authorization_profile SET DEFAULT 'reviewed_subset_v1';"),'policy_column_changed'],
   ['new CHECK body',inject('ALTER TABLE erp_fiscal_authorization.policy DROP CONSTRAINT reviewed_policy_authority_check;ALTER TABLE erp_fiscal_authorization.policy ADD CONSTRAINT reviewed_policy_authority_check CHECK(true);'),'policy_constraints_changed'],
   ['new dispatch trigger disabled',inject('ALTER TABLE erp_fiscal_authorization.attempt DISABLE TRIGGER reviewed_use_commit;'),'stage_trigger_changed'],
   ['old trigger disabled',inject('ALTER TABLE erp_fiscal_authorization.attempt DISABLE TRIGGER guard_attempt;'),'table_security_changed'],
   ['old function ACL',inject('GRANT EXECUTE ON FUNCTION public.erp_finance_execute(uuid,uuid,text,jsonb)TO anon;'),'other_functions_changed'],
   ['replaced function argument default',inject("CREATE OR REPLACE FUNCTION erp_fiscal_authorization.check_policy(model_id text,expected integer DEFAULT 1)RETURNS erp_fiscal_authorization.policy LANGUAGE sql SET search_path=pg_catalog AS $$SELECT NULL::erp_fiscal_authorization.policy$$;"),'function_contract_failed'],
   ['private helper exposed',inject('GRANT EXECUTE ON FUNCTION erp_fiscal_reviewed_authorization.guard_stage()TO service_role;'),'function_contract_failed'],
   ['private helper loses definer',inject('ALTER FUNCTION erp_fiscal_reviewed_authorization.guard_stage() SECURITY INVOKER;'),'function_contract_failed'],
   ['public RPC exposed',inject('GRANT EXECUTE ON FUNCTION public.erp_fiscal_reviewed_authorization_command(uuid,uuid)TO authenticated;'),'function_contract_failed'],
   ['new private table exposed',inject('GRANT SELECT ON erp_fiscal_reviewed_authorization.review_binding TO service_role;'),'private_table_failed'],
   ['new private table column exposed',inject('GRANT SELECT(proof)ON erp_fiscal_reviewed_authorization.review_binding TO authenticated;'),'private_table_failed'],
   ['new private table RLS',inject('ALTER TABLE erp_fiscal_reviewed_authorization.observation DISABLE ROW LEVEL SECURITY;'),'private_table_failed'],
   ['new private table policy',inject('CREATE POLICY injected ON erp_fiscal_reviewed_authorization.observation USING(true);'),'private_table_failed'],
   ['new table constraint',inject('ALTER TABLE erp_fiscal_reviewed_authorization.observation DROP CONSTRAINT observation_size_bytes_check;'),'table_contract_failed'],
   ['new immutability trigger',inject('ALTER TABLE erp_fiscal_reviewed_authorization.review_binding DISABLE TRIGGER immutable;'),'table_contract_failed'],
   ['new private schema',inject('GRANT USAGE ON SCHEMA erp_fiscal_reviewed_authorization TO service_role;'),'private_schema_failed'],
   ['new private default ACL',inject('ALTER DEFAULT PRIVILEGES IN SCHEMA erp_fiscal_reviewed_authorization GRANT SELECT ON TABLES TO authenticated;'),'private_schema_failed'],
   ['unexpected function',inject('CREATE FUNCTION public.erp_reviewed_069_extra()RETURNS integer LANGUAGE sql AS $$SELECT 1$$;'),'other_functions_changed'],
  ];
  for(const[name,input,code]of probes)await t.test(name,async()=>{
   assert.notEqual(input,sql);try{await assert.rejects(db.exec(input),e=>e.message.includes(code));}finally{await db.exec('rollback;');}await absent();
   assert.deepEqual(await scalar("select jsonb_build_object('policy',(select jsonb_agg(to_jsonb(p)order by model,version)from erp_fiscal_authorization.policy p),'account',(select jsonb_agg(to_jsonb(a))from erp_finance.account a),'history',(select jsonb_agg(to_jsonb(h))from erp_fiscal_authorization.fixture_history h))v"),baseline);
  });
  let audit;
  await t.test('success preserves full baseline while separately validating the new column and two disabled seeds',async()=>{
   const result=await db.exec(sql);audit=result.flatMap(r=>r.rows??[]).find(r=>r.reviewed_authorization_apply_audit)?.reviewed_authorization_apply_audit;assert.ok(audit);
   assert.equal(audit.source_sha256,SOURCE_SHA256);assert.ok(audit.protected_table_count>=144);assert.deepEqual(audit.before,audit.after);
   assert.notDeepEqual(audit.policy_before_full,audit.policy_after_full);assert.equal(audit.policy_before_full.count,3);assert.equal(audit.policy_after_full.count,5);assert.equal(audit.before_equals_after,undefined);
   assert.equal(audit.new_policy_seeds,2);assert.equal(audit.new_policy_seeds_disabled,true);assert.equal(audit.new_service_only_rpcs,7);assert.equal(audit.new_private_helpers,7);assert.equal(audit.replaced_functions,3);assert.equal(audit.reviewed_functions,17);
   for(const flag of ['legacy_projections_equal','old_policy_fields_preserved','table_security_preserved_except_reviewed_ddl','schema_security_unchanged','other_functions_unchanged','replaced_function_security_unchanged','default_privileges_unchanged','new_table_empty','new_table_rls','new_table_owner_only'])assert.equal(audit[flag],true,flag);
   for(const flag of ['operation_activated','financial_mutation_performed','stock_mutation_performed','tax_rules_validated','can_emit','can_transmit','production_authorized'])assert.equal(audit[flag],false,flag);
   assert.deepEqual((await db.query("select model,version from erp_fiscal_authorization.policy where authorization_profile='reviewed_subset_v1'order by model")).rows,[{model:'55',version:8},{model:'65',version:2}]);
   assert.doesNotMatch(JSON.stringify(audit),/PRIVATE_SYNTHETIC|INJECTED|"payload"|"cnpj"/);
  });
  await t.test('reapply refuses before changing the first committed result',async()=>{await assert.rejects(db.exec(sql),e=>e.message.includes('already_present'));await db.exec('rollback;');assert.equal(await scalar('select count(*)::int v from erp_fiscal_authorization.policy'),5);});
  await t.test('readback is read-only and matches legacy projections plus all unrelated functions',async()=>{
   const sql=await prepareReviewedAuthorizationReadback();assert.match(sql,/BEGIN READ ONLY;/);assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|GRANT|REVOKE)\b/);
   const result=await db.exec(sql),proof=result.flatMap(r=>r.rows??[]).find(r=>r.reviewed_authorization_readback)?.reviewed_authorization_readback;assert.ok(proof);
   assert.deepEqual(proof.legacy_rows,audit.after);assert.equal(proof.other_functions_sha256,audit.other_functions_sha256);assert.equal(proof.reviewed_functions,17);assert.equal(proof.service_only_rpcs,7);assert.equal(proof.new_policy_count,2);
   for(const k of ['function_contracts_valid','new_policies_disabled','private_schema','private_tables','new_tables_rls'])assert.equal(proof[k],true,k);
   for(const k of ['binding_count','observation_count','new_table_policies'])assert.equal(proof[k],0,k);
   assert.doesNotMatch(JSON.stringify(proof),/PRIVATE_SYNTHETIC|"payload"|"cnpj"/);
  });
 }finally{await db.close();}
});
