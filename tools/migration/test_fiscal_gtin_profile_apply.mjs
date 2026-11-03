import test from'node:test';import assert from'node:assert/strict';import{readFile,readdir}from'node:fs/promises';import{PGlite}from'@electric-sql/pglite';import{bootstrap}from'./helpers/stock-reservation-fixture.mjs';
import{prepareFiscalGtinProfileApply,prepareFiscalGtinProfileReadback,SOURCE_HASHES}from'./prepare_fiscal_gtin_profile_apply.mjs';
const latest='public.erp_fiscal_subset_review_latest(uuid,uuid,integer,text,text,text)',replaced='public.erp_fiscal_subset_review_get(uuid,uuid,integer,text,text,text)';
test('077 applicator preserves historical state and only changes the closed reviewed-profile contract',async t=>{
 const db=new PGlite(),scalar=async(s,a=[])=>(await db.query(s,a)).rows[0].v;let audit;
 try{
  await db.exec(bootstrap);const root=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(root)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=76).sort();assert.equal(files.length,76);for(const f of files)await db.exec(await readFile(new URL(f,root),'utf8'));
  await db.exec("create table erp_access.fixture077(id integer primary key,value text default 'fixed');insert into erp_access.fixture077 values(1,'PRIVATE_SENTINEL');alter table erp_access.fixture077 enable row level security;create policy fixture_read on erp_access.fixture077 for select to authenticated using(false);grant select(value)on erp_access.fixture077 to authenticated;insert into storage.buckets(id,name,public)values('fixture077','fixture077',false);insert into storage.objects values('fixture077','PRIVATE_OBJECT','{}');");
  const sql=await prepareFiscalGtinProfileApply(),readback=await prepareFiscalGtinProfileReadback(),inject=v=>sql.replace('-- reviewed077 objects installed',()=> '-- reviewed077 objects installed\n'+v),absent=async()=>{assert.equal(await scalar('select to_regprocedure($1)::text v',[latest]),null);assert.equal(await scalar('select value v from erp_access.fixture077 where id=1'),'PRIVATE_SENTINEL');};
  const disableImmutable="alter table erp_fiscal_authorization.policy disable trigger user;";
  const probes=[
   ['source pin',sql.replace('-- GS1 reviewed rule profile v2.','-- Altered reviewed rule profile v2.'),'22023','source_hash_mismatch'],
   ['dependency pin',sql.replace('"erp_a1.access(uuid,boolean)":"','"erp_a1.access(uuid,boolean)":"0'),'55000','dependency_changed'],
   ['historical rows',inject("update erp_access.fixture077 set value='CHANGED';"),'40001','historical_data_changed'],
   ['storage metadata',inject("update storage.objects set metadata='{\"changed\":true}'where bucket_id='fixture077';"),'40001','historical_data_changed'],
   ['historical policy',inject(disableImmutable+"update erp_fiscal_authorization.policy set valid_until=valid_until+interval'1day'where version=1;alter table erp_fiscal_authorization.policy enable trigger user;"),'40001','historical_data_changed'],
   ['seed enabled',inject(disableImmutable+"update erp_fiscal_authorization.policy set enabled=true where rule_profile like '%-v2';alter table erp_fiscal_authorization.policy enable trigger user;"),'40001','seed_contract_changed'],
   ['seed timestamp',inject(disableImmutable+"update erp_fiscal_authorization.policy set created_at='2000-01-01'where rule_profile like '%-v2';alter table erp_fiscal_authorization.policy enable trigger user;"),'40001','seed_contract_changed'],
   ['third seed',inject("insert into erp_fiscal_authorization.policy select(jsonb_populate_record(null::erp_fiscal_authorization.policy,to_jsonb(p)||jsonb_build_object('version',100))).*from erp_fiscal_authorization.policy p where model='55'and rule_profile like '%-v2';"),'40001','seed_contract_changed'],
   ['new table',inject('create table erp_access.unexpected077(id integer);'),'40001','table_inventory_changed'],
   ['table grant',inject('grant select on erp_access.fixture077 to service_role;'),'42501','table_security_changed'],
   ['column grant',inject('grant update(value)on erp_access.fixture077 to service_role;'),'42501','table_security_changed'],
   ['table RLS',inject('alter table erp_access.fixture077 disable row level security;'),'42501','table_security_changed'],
   ['table policy',inject('drop policy fixture_read on erp_access.fixture077;'),'42501','table_security_changed'],
   ['column default',inject("alter table erp_access.fixture077 alter value set default 'changed';"),'42501','table_security_changed'],
   ['extra CHECK',inject('alter table erp_access.fixture077 add constraint extra077 check(id>0);'),'42501','table_security_changed'],
   ['weakened profile CHECK',inject('alter table erp_fiscal_subset_review.review drop constraint review_supported_profile_hash_check;alter table erp_fiscal_subset_review.review add constraint review_supported_profile_hash_check check(true);'),'55000','check_contract_changed'],
   ['index',inject('drop index origin_sync.raw_record_changed_idx;'),'42501','table_security_changed'],
   ['schema ACL',inject('grant usage on schema erp_access to anon;'),'42501','schema_security_changed'],
   ['default ACL',inject('alter default privileges in schema erp_access grant select on tables to anon;'),'42501','default_privileges_changed'],
   ['unrelated function ACL',inject('grant execute on function public.erp_access_me(uuid)to anon;'),'40001','other_functions_changed'],
   ['new RPC public ACL',inject(`grant execute on function ${latest}to authenticated;`),'42501','function_contract_failed'],
   ['new RPC delegation',inject(`grant execute on function ${latest}to service_role with grant option;`),'42501','function_contract_failed'],
   ['redefined RPC delegation',inject(`grant execute on function ${replaced}to service_role with grant option;`),'42501','function_contract_failed'],
   ['private helper exposure',inject('grant execute on function erp_fiscal_subset_review.current_profile_hash()to service_role;'),'42501','function_contract_failed'],
   ['new RPC volatility',inject(`alter function ${latest}volatile;`),'42501','function_contract_failed'],
   ['new RPC strictness',inject(`alter function ${latest}strict;`),'42501','function_contract_failed'],
   ['new RPC path',inject(`alter function ${latest}set search_path=public;`),'42501','function_contract_failed'],
   ['unexpected function',inject('create function public.erp_unexpected077()returns integer language sql as $$select 1$$;'),'40001','other_functions_changed'],
  ];
  for(const[name,input,code,message]of probes)await t.test(name,async()=>{assert.notEqual(input,sql);try{await assert.rejects(db.exec(input),e=>e.code===code&&e.message.includes(message));}finally{await db.exec('rollback');}await absent();});
  await t.test('preexisting changed function refuses before applying source',async()=>{try{await db.exec('begin;'+`alter function ${replaced}security invoker;`);await assert.rejects(db.exec(sql),e=>e.code==='42501'&&e.message.includes('function_contract_failed'));}finally{await db.exec('rollback');}await absent();});
  await t.test('success appends two disabled policies without touching history or unrelated contracts',async()=>{audit=(await db.exec(sql)).flatMap(x=>x.rows??[]).find(x=>x.fiscal_gtin_profile_apply_audit).fiscal_gtin_profile_apply_audit;assert.deepEqual(audit.before,audit.after_historical);assert.equal(audit.source_sha256,SOURCE_HASHES['077']);assert.equal(audit.new_disabled_policy_seeds.length,2);assert.ok(audit.new_disabled_policy_seeds.every(x=>x.enabled===false&&x.tax_rules_reviewed===false));assert.equal(audit.new_functions,4);assert.equal(audit.replaced_functions,7);assert.equal(audit.new_tables,0);assert.equal(audit.after_full['erp_fiscal_authorization.policy'].count,audit.before['erp_fiscal_authorization.policy'].count+2);assert.doesNotMatch(JSON.stringify(audit),/PRIVATE_SENTINEL|PRIVATE_OBJECT/);});
  await t.test('readonly readback matches rows, metadata, ACL and old function identities',async()=>{const r=(await db.exec(readback)).flatMap(x=>x.rows??[]).find(x=>x.fiscal_gtin_profile_commit_readback).fiscal_gtin_profile_commit_readback;assert.deepEqual(r.rows_full,audit.after_full);assert.deepEqual(r.rows_historical,audit.before);assert.deepEqual(r.new_disabled_policy_seeds,audit.new_disabled_policy_seeds);for(const k of['table_security_sha256','schema_security_sha256','default_privileges_sha256','other_functions_sha256','replaced_function_identity'])assert.deepEqual(r[k],audit[k]);});
  await t.test('readback refuses service grant option',async()=>{try{await db.exec(`grant execute on function ${latest}to service_role with grant option;`);await assert.rejects(db.exec(readback),e=>e.code==='42501'&&e.message.includes('function_contract_failed'));}finally{await db.exec(`rollback;revoke grant option for execute on function ${latest}from service_role;`);}});
  await t.test('reapply refuses before seeds or data change',async()=>{try{await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('already_present'));}finally{await db.exec('rollback');}assert.equal(await scalar("select count(*)::int v from erp_fiscal_authorization.policy where rule_profile like '%-v2'"),2);});
 }finally{await db.close();}
});
