import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {bootstrap,quote} from './helpers/financial-import-postgres-fixture.mjs';
import {seedFinancialImportAuthorizationApply,FINANCIAL_IMPORT_APPLY as target} from './helpers/financial-import-authorization-apply-fixture.mjs';
import {prepareFinancialImportAuthorizationApply,prepareFinancialImportAuthorizationReadback,SOURCE_HASHES,PREVIOUS_BODY_SHA256} from './prepare_financial_import_authorization_apply.mjs';

test('088 audited replacement preserves prior data, receipts, function identity and security',async t=>{
 const db=new PGlite(),scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;
 const rows=r=>r.flatMap(x=>x.rows??[]),result=r=>Object.values(rows(r).at(-1))[0];
 const rpc=async(name,args)=>result(await db.exec(`begin;set local role service_role;select public.${name}(${Object.entries(args).map(([k,v])=>k+'=>'+quote(v)).join(',')});commit;`));
 let audit;
 try{
  await db.exec(bootstrap);const dir=new URL('../../supabase/migrations/',import.meta.url);
  const files=(await readdir(dir)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=87).sort();assert.equal(files.length,87);
  for(const f of files)await db.exec(await readFile(new URL(f,dir),'utf8'));
  const seed=await seedFinancialImportAuthorizationApply({run:s=>db.exec(s),result,ok:x=>x,rpc});
  const beforeTarget=await scalar('select to_jsonb(p) v from pg_proc p where oid=to_regprocedure($1)',[target]);
  const sql=await prepareFinancialImportAuthorizationApply(),readback=await prepareFinancialImportAuthorizationReadback();
  const inject=v=>sql.replace('-- reviewed function replaced',()=> '-- reviewed function replaced\n'+v);
  const unchanged=async()=>{
   assert.deepEqual(await scalar('select to_jsonb(p)v from pg_proc p where oid=to_regprocedure($1)',[target]),beforeTarget);
   assert.equal(await scalar('select value v from erp_access.fixture087 where id=1'),'PRIVATE_SENTINEL');
   assert.equal(await scalar('select count(*)::int v from erp_sales_history.snapshot'),276);
   assert.equal(await scalar('select count(*)::int v from erp_warehouse_import.binding'),1);
   assert.equal(await scalar('select count(*)::int v from erp_finance.command'),1);
   assert.equal(await scalar('select count(*)::int v from erp_finance.title'),1);
  };
  const probes=[
   ['source hash',sql.replace('--039 financial adoption','--039 changed adoption'),'22023','source_hash_mismatch'],
   ['dependency hash',sql.replace('"erp_cutover.require_admin(uuid)":"','"erp_cutover.require_admin(uuid)":"0'),'55000','previous_contract_changed'],
   ['old row',inject("update erp_access.fixture087 set value='CHANGED';"),'40001','existing_data_changed'],
   ['old receipt',inject("alter table erp_finance.command disable trigger user;update erp_finance.command set result=result||'{\"changed\":true}';alter table erp_finance.command enable trigger user;"),'40001','existing_data_changed'],
   ['history snapshot',inject("alter table erp_sales_history.snapshot disable trigger user;update erp_sales_history.snapshot set captured_at=captured_at+interval'1 second';alter table erp_sales_history.snapshot enable trigger user;"),'40001','existing_data_changed'],
   ['storage metadata',inject("update storage.objects set metadata='{\"changed\":true}'where bucket_id='fixture087';"),'40001','existing_data_changed'],
   ['queue state',inject("update origin_sales_price_refresh.scope_state set retry_after=null;"),'40001','existing_data_changed'],
   ['table inventory',inject('create table erp_access.unexpected088(id integer);'),'40001','table_inventory_changed'],
   ['table ACL',inject('grant select on erp_access.fixture087 to service_role;'),'42501','table_security_changed'],
   ['column ACL',inject('grant update(value)on erp_access.fixture087 to service_role;'),'42501','table_security_changed'],
   ['RLS',inject('alter table erp_access.fixture087 disable row level security;'),'42501','table_security_changed'],
   ['policy',inject('drop policy fixture_read on erp_access.fixture087;'),'42501','table_security_changed'],
   ['column default',inject("alter table erp_access.fixture087 alter value set default 'changed';"),'42501','table_security_changed'],
   ['constraint',inject('alter table erp_access.fixture087 add constraint extra088 check(id>0);'),'42501','table_security_changed'],
   ['index',inject('drop index origin_sync.raw_record_changed_idx;'),'42501','table_security_changed'],
   ['schema ACL',inject('grant usage on schema erp_access to anon;'),'42501','schema_security_changed'],
   ['global default ACL',inject('alter default privileges grant select on tables to anon;'),'42501','default_privileges_changed'],
   ['schema default ACL',inject('alter default privileges in schema erp_access grant select on tables to anon;'),'42501','default_privileges_changed'],
   ['other function ACL',inject('grant execute on function public.erp_access_me(uuid)to anon;'),'40001','other_functions_changed'],
   ['other function attributes',inject('alter function public.erp_access_me(uuid)cost 123;'),'40001','other_functions_changed'],
   ['unexpected function',inject('create function public.erp_unexpected088()returns integer language sql as $$select 1$$;'),'40001','other_functions_changed'],
   ['unexpected type',inject("create type erp_cutover.unexpected088 as enum('a');"),'42501','other_catalog_changed'],
   ['target public ACL',inject(`grant execute on function ${target}to authenticated;`),'42501','target_attributes_changed'],
   ['target delegation',inject(`grant execute on function ${target}to service_role with grant option;`),'42501','target_attributes_changed'],
   ['target owner',inject(`alter function ${target}owner to service_role;`),'42501','target_attributes_changed'],
   ['target definer',inject(`alter function ${target}security invoker;`),'42501','target_attributes_changed'],
   ['target search path',inject(`alter function ${target}set search_path=public;`),'42501','target_attributes_changed'],
   ['target strictness',inject(`alter function ${target}strict;`),'42501','target_attributes_changed'],
   ['target volatility',inject(`alter function ${target}stable;`),'42501','target_attributes_changed'],
   ['target cost',inject(`alter function ${target}cost 123;`),'42501','target_attributes_changed'],
   ['target OID',inject(`do $probe$ declare s text;begin s:=pg_get_functiondef('${target}'::regprocedure);execute 'drop function ${target}';execute s;end$probe$;`),'42501','target_attributes_changed'],
   ['target body',inject(`do $probe$ begin execute replace(pg_get_functiondef('${target}'::regprocedure),'erp_origin_import_confirmation_required','erp_origin_import_changed');end$probe$;`),'42501','function_contract_failed'],
  ];
  for(const[name,input,code,message]of probes)await t.test(name,async()=>{
   assert.notEqual(input,sql,'probe must change generated SQL');
   try{await assert.rejects(db.exec(input),e=>e.code===code&&e.message.includes(message));}finally{await db.exec('rollback');}
   await unchanged();
  });
  for(const[name,setup,code,message]of[
   ['old body mismatch',`do $probe$ begin execute replace(pg_get_functiondef('${target}'::regprocedure),'erp_origin_import_confirmation_required','erp_origin_import_changed');end$probe$;`,'55000','previous_apply_changed'],
   ['missing087 prerequisite','drop function public.erp_origin_stock_observations(uuid,text,integer,text,text);','55000','previous_contract_changed'],
   ['preexisting target delegation',`grant execute on function ${target}to service_role with grant option;`,'42501','function_contract_failed'],
   ['preexisting unsafe target path',`alter function ${target}set search_path=public;`,'42501','target_attributes_changed'],
  ])await t.test(name,async()=>{try{await db.exec('begin;'+setup);await assert.rejects(db.exec(sql),e=>e.code===code&&e.message.includes(message));}finally{await db.exec('rollback');}await unchanged();});
  await t.test('success only replaces body while preserving full catalog identity',async()=>{
   audit=rows(await db.exec(sql)).find(r=>r.financial_import_authorization_apply_audit).financial_import_authorization_apply_audit;
   assert.deepEqual(audit.before,audit.after);assert.deepEqual(audit.source_sha256,SOURCE_HASHES);assert.equal(audit.protected_table_count,160);
   for(const k of['new_service_only_rpcs','new_private_helpers','new_tables'])assert.equal(audit[k],0);assert.equal(audit.redefined_functions,1);
   assert.equal(audit.before['erp_finance.command'].count,1);assert.equal(audit.before['erp_sales_history.snapshot'].count,276);
   const after=await scalar('select to_jsonb(p)v from pg_proc p where oid=to_regprocedure($1)',[target]);
   const {prosrc:oldBody,...oldAttrs}=beforeTarget,{prosrc:newBody,...newAttrs}=after;assert.deepEqual(newAttrs,oldAttrs);assert.notEqual(newBody,oldBody);
   assert.equal(await scalar("select encode(sha256(convert_to(prosrc,'UTF8')),'hex')v from pg_proc where oid=to_regprocedure($1)",[target])===PREVIOUS_BODY_SHA256,false);
   assert.doesNotMatch(JSON.stringify(audit),/PRIVATE_SENTINEL|PRIVATE_OBJECT|Synthetic contact/);
  });
  await t.test('readonly commit readback matches every installation fingerprint',async()=>{
   const r=result(await db.exec(readback));assert.deepEqual(r.rows,audit.after);
   for(const k of['table_security_sha256','schema_security_sha256','default_privileges_sha256','other_functions_sha256','other_catalog_sha256','target_oid','target_attributes_sha256'])assert.equal(r[k],audit[k]);
   assert.equal(r.function_contracts_valid,true);
  });
  await t.test('historical receipt replays without another title or command',async()=>{
   assert.deepEqual(await rpc('erp_origin_financial_import_apply',seed.args),{...seed.receipt,replayed:true});
   assert.deepEqual(result(await db.exec(readback)).rows,audit.after);
  });
  await t.test('service-only ACL remains unchanged and forbids delegation',async()=>{
   for(const role of['anon','authenticated','service_role'])assert.equal(await scalar("select has_function_privilege($1,$2,'EXECUTE')v",[role,target]),role==='service_role');
   try{await db.exec(`grant execute on function ${target}to service_role with grant option;`);await assert.rejects(db.exec(readback),e=>e.code==='42501'&&e.message.includes('function_contract_failed'));}finally{await db.exec(`rollback;revoke grant option for execute on function ${target}from service_role;`);}
  });
  await t.test('reapply refuses before changing anything',async()=>{
   try{await assert.rejects(db.exec(sql),e=>e.code==='55000'&&e.message.includes('previous_apply_changed'));}finally{await db.exec('rollback');}
   assert.deepEqual(result(await db.exec(readback)).rows,audit.after);
  });
 }finally{await db.close();}
});
