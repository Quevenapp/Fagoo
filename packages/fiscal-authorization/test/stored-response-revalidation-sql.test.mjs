import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {revalidationFixture,hash,PREFIX} from './stored-response-revalidation-fixture.mjs';
import {STORED_RESPONSE_MANIFEST_HASH} from '../src/stored-response-manifest.mjs';
const error=code=>e=>e.code===code;
test('079 revalidates immutable original journals with strict CAS, current access and no dispatch',async t=>{
 const f=await revalidationFixture();try{
  await t.test('one private immutable RLS table; three service-only RPCs without grant option',async()=>{
   const acl=(await f.db.query(`select p.proname,p.prosecdef,p.provolatile,p.proconfig,has_function_privilege('anon',p.oid,'EXECUTE')anon,has_function_privilege('authenticated',p.oid,'EXECUTE')authenticated,has_function_privilege('service_role',p.oid,'EXECUTE')service,exists(select 1 from aclexplode(p.proacl)a where a.is_grantable)grantable from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and p.proname like $1`,[PREFIX+'%'])).rows;
   assert.equal(acl.length,3);for(const r of acl){assert.equal(r.prosecdef,true);assert.deepEqual(r.proconfig,['search_path=pg_catalog']);assert.equal(r.anon,false);assert.equal(r.authenticated,false);assert.equal(r.service,true);assert.equal(r.grantable,false);}
   const tables=(await f.db.query("select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='erp_fiscal_authorization_revalidation'and relkind='r'")).rows;assert.deepEqual(tables,[{relname:'command',relrowsecurity:true}]);
   assert.ok((await f.db.query("select has_function_privilege('service_role',p.oid,'EXECUTE')service from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='erp_fiscal_authorization_revalidation'")).rows.every(r=>!r.service));
   assert.equal((await f.db.query('select erp_fiscal_authorization_revalidation.manifest()v')).rows[0].v,STORED_RESPONSE_MANIFEST_HASH);
  });
  for(const model of['55','65'])await t.test(model+' original review_required remains byte-identical while the new receipt records homologation',async()=>{
   const x=await f.start(model),before=await f.snapshot();assert.equal(x.context.can_revalidate,true);assert.equal(x.context.existing,null);
   const saved=await f.callRevalidation('finish',x.args);assert.equal(saved.receipt.state,'authorized_homologation');assert.equal(saved.receipt.original_state,'review_required');assert.equal(saved.receipt.tax_rules_validated,false);assert.equal(saved.can_transmit,false);assert.equal(saved.production_authorized,false);
   assert.deepEqual(await f.snapshot(),before);assert.equal((await f.wire('command',{p_user_id:f.users.fiscal,p_command_id:x.c.input.commandId})).current.state,'review_required');
   const got=await f.callRevalidation('command',{p_user_id:f.users.fiscal,p_command_id:x.args.p_command_id});assert.deepEqual(got.receipt,saved.receipt);assert.equal(got.read_only,true);
   const context=await f.callRevalidation('context',x.contextArgs);assert.equal(context.can_revalidate,false);assert.deepEqual(context.existing.receipt,saved.receipt);assert.equal(context.source_hash,x.context.source_hash);
   const replay=await f.callRevalidation('finish',x.args);assert.equal(replay.replayed,true);assert.deepEqual(replay.receipt,saved.receipt);
   await assert.rejects(f.callRevalidation('finish',{...x.args,p_command_id:randomUUID()}),error('40001'));
   await assert.rejects(f.callRevalidation('finish',{...x.args,p_evidence:{...x.args.p_evidence,protocol_number:'135260000000002'}}),error('40001'));
   await assert.rejects(f.db.query('delete from erp_fiscal_authorization_revalidation.command where id=$1',[x.args.p_command_id]),error('42501'));
   await assert.rejects(f.db.query('update erp_fiscal_authorization_revalidation.command set source_hash=$1 where id=$2',[hash('other'),x.args.p_command_id]),error('42501'));
  });
  await t.test('source, parser, result and Storage disagreements never append',async()=>{
   const x=await f.start(),count=async()=>Number((await f.db.query('select count(*)::int n from erp_fiscal_authorization_revalidation.command')).rows[0].n),before=await count();
   for(const [patch,code]of[[{p_expected_source_hash:hash('other')},'40001'],[{p_expected_attempt_id:randomUUID()},'40001'],[{p_parser_profile:'unknown'},'22023'],[{p_parser_manifest_hash:hash('other')},'22023'],[{p_evidence:{...x.args.p_evidence,response_hash:hash('other')}},'22023'],[{p_evidence:{...x.args.p_evidence,transport_hash:hash('other')}},'22023'],[{p_evidence:{...x.args.p_evidence,origin:'synthetic',tls_origin_verified:false}},'22023'],[{p_evidence:{...x.args.p_evidence,tax_rules_validated:true}},'22023'],[{p_evidence:{...x.args.p_evidence,signature_verified:false}},'22023'],[{p_processed_hash:null,p_processed_size:null},'22023'],[{p_evidence:x.bad.p_evidence,p_processed_hash:null,p_processed_size:null},'22023']])await assert.rejects(f.callRevalidation('finish',{...x.args,...patch}),error(code));
   await f.db.query('delete from storage.objects where name=$1',[x.key]);await assert.rejects(f.callRevalidation('finish',x.args),error('40001'));assert.equal(await count(),before);
  });
  await t.test('UUID/type/null limits fail closed before append',async()=>{
   const x=await f.start();for(const patch of[{p_command_id:null},{p_expected_source_hash:null},{p_parser_profile:null},{p_parser_manifest_hash:null},{p_confirmed:false},{p_confirmed:null},{p_evidence:null},{p_evidence:[]},{p_evidence:'private'},{p_processed_size:0},{p_processed_size:512001},{p_processed_hash:null},{p_command_id:x.args.p_authorization_command_id}])await assert.rejects(f.callRevalidation('finish',{...x.args,...patch}),error('22023'));
   await assert.rejects(f.callRevalidation('context',{...x.contextArgs,p_expected_attempt_id:null}),error('22023'));
  });
  await t.test('only original actor with current admin/fiscal role can discover or save',async()=>{
   const x=await f.start();await assert.rejects(f.callRevalidation('context',{...x.contextArgs,p_user_id:f.users.admin}),error('42501'));await assert.rejects(f.callRevalidation('finish',{...x.args,p_user_id:f.users.admin}),error('42501'));
   await f.db.query('update erp_access.membership set active=false where user_id=$1',[f.users.fiscal]);try{await assert.rejects(f.callRevalidation('context',x.contextArgs),error('42501'));await assert.rejects(f.callRevalidation('finish',x.args),error('42501'));}finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[f.users.fiscal]);}
   await f.callRevalidation('finish',x.args);await assert.rejects(f.callRevalidation('command',{p_user_id:f.users.admin,p_command_id:x.args.p_command_id}),error('42501'));
  });
  await t.test('valid100/150,103,rejection and review statuses are independent; an exception is never a stored fallback',async()=>{
   for(const variant of['150','103','225','217']){
    const x=await f.start();let e={...x.args.p_evidence},processed=x.args.p_processed_hash,size=x.args.p_processed_size,state;
    if(variant==='150'){e.protocol_cstat='150';state='authorized_homologation';}else{
     Object.assign(e,{cstat:variant,protocol_cstat:null,protocol_number:null,reference_digest:null,signature_verified:false,processed_xsd_validated:false,outcome:variant==='103'?'receipt_pending':variant==='225'?'rejected':'review_required',receipt_number:variant==='103'?'350000000000001':null});processed=null;size=null;state=e.outcome;
    }
    assert.equal((await f.callRevalidation('finish',{...x.args,p_evidence:e,p_processed_hash:processed,p_processed_size:size})).receipt.state,state);
   }
  });
  await t.test('historical source and receipts survive profile rotation, new reviews, disabled A1 and policy',async()=>{
   const x=await f.start();await f.review(x.c,{p_command_id:randomUUID(),p_expected_review_version:1});await f.disable();
   await f.db.exec(await readFile(new URL('../../../supabase/migrations/202610160072_fiscal_reviewed_preflight.sql',import.meta.url),'utf8'));
   await f.db.exec(await readFile(new URL('../../../supabase/migrations/202610160077_fiscal_gtin_rule_profile_v2.sql',import.meta.url),'utf8'));
   const context=await f.callRevalidation('context',x.contextArgs);assert.equal(context.source_hash,x.context.source_hash);assert.deepEqual(context.source,x.context.source);
   const before=await f.snapshot(),saved=await f.callRevalidation('finish',x.args);assert.equal(saved.receipt.state,'authorized_homologation');assert.deepEqual(await f.snapshot(),before);
   assert.deepEqual((await f.callRevalidation('finish',x.args)).receipt,saved.receipt);
   assert.deepEqual((await f.callRevalidation('command',{p_user_id:f.users.fiscal,p_command_id:x.args.p_command_id})).receipt,saved.receipt);
  });
 }finally{await f.close();}
});
