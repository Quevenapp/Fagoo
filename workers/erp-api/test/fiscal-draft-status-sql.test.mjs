import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {fiscalDraftStatusFixture,hash} from './helpers/fiscal-draft-status-fixture.mjs';
import {parseFiscalDraftStatusPage} from '../../../packages/erp-domain/src/fiscal-draft-status-dto.mjs';
import {parseFiscalDraftStatusRoute,executeFiscalDraftStatusRoute} from '../src/fiscal-draft-status.mjs';
test('082 real050/064/069/079 list is read-only, exact and preserves separate histories',async t=>{
 const f=await fiscalDraftStatusFixture();try{
  const page=async(p={})=>parseFiscalDraftStatusPage(await f.list(p),{model:p.p_model??null,status:p.p_status??null,sourceDocumentId:p.p_source_document_id??null,limit:p.p_limit??25,after:p.p_after??null});
  const row=async id=>(await page()).items.find(x=>x.draft.id===id);
  let x55,x65,id55;
  await t.test('empty list and exact service-only function ACLs',async()=>{
   assert.equal((await page()).items.length,0);
   const rs=(await f.db.query("select n.nspname,p.proname,p.prosecdef,p.provolatile,p.proconfig,has_function_privilege('service_role',p.oid,'EXECUTE')service,has_function_privilege('anon',p.oid,'EXECUTE')anon,has_function_privilege('authenticated',p.oid,'EXECUTE')authenticated,exists(select 1 from aclexplode(p.proacl)a where a.is_grantable)grantable from pg_proc p join pg_namespace n on n.oid=p.pronamespace where(n.nspname='erp_fiscal_drafts'and p.proname in('status_row','status_result'))or(n.nspname='public'and p.proname='erp_fiscal_draft_status_list')")).rows;
   assert.equal(rs.length,3);for(const r of rs){assert.equal(r.service,r.nspname==='public');assert.equal(r.prosecdef,r.nspname==='public');assert.equal(r.anon,false);assert.equal(r.authenticated,false);assert.equal(r.grantable,false);assert.deepEqual(r.proconfig,['search_path=pg_catalog']);assert.ok(['s','i'].includes(r.provolatile));}
  });
  await t.test('55 original SOAP_INVALID and079 authorization100 remain separately attributed',async()=>{
   x55=await f.start('55');id55=await f.draftId(x55.c.input.candidateId);await f.callRevalidation('finish',x55.args);const before=await f.snapshotAll();
   await f.db.exec('begin read only');try{const r=await row(id55);assert.equal(r.draft.status,'draft');assert.equal(r.numbering.visibility,'available');assert.equal(r.authorization.original.state,'review_required');assert.equal(r.authorization.original.result.rejection_code,'SOAP_INVALID');assert.equal(r.authorization.revalidation.result.state,'authorized_homologation');assert.equal(r.authorization.revalidation.result.protocol_cstat,'100');assert.equal(r.authorization.revalidation.result.command_id,x55.args.p_command_id);assert.equal(r.authorization.original.command_id,x55.c.input.commandId);assert.equal(r.authorization.basis.matches_current_preparation,true);}finally{await f.db.exec('rollback');}
   assert.deepEqual(await f.snapshotAll(),before);
  });
  await t.test('65 protocol245 is a rejection, never draft state or authorization',async()=>{
   x65=await f.terminal('65');const r=await row(x65.id);assert.equal(r.authorization.original.state,'rejected');assert.equal(r.authorization.original.result.cstat,'104');assert.equal(r.authorization.original.result.protocol_cstat,'245');assert.equal(r.authorization.revalidation.visibility,'none');assert.equal(r.draft.status,'draft');assert.equal(r.authorization.original.candidate_id,x65.c.input.candidateId);assert.notEqual(r.numbering.reservation.reservation_id,(await row(id55)).numbering.reservation.reservation_id);
   if(process.env.BRUFAP_TEST_STATUS_EXPORT){assert.match(process.env.BRUFAP_TEST_STATUS_EXPORT,/^\/Volumes\/Dev\/tmp\/brufap-fiscal-status-082-[a-z-]+\.json$/);await writeFile(process.env.BRUFAP_TEST_STATUS_EXPORT,JSON.stringify(await page(),null,2)+'\n',{flag:'wx',mode:0o600});}
  });
  await t.test('native authorized069, receipt103, pending begin and reserved-without-attempt stay distinct',async()=>{
   const authorized=await f.terminal('55','authorized'),pending=await f.terminal('55','receipt_pending');
   assert.equal((await row(authorized.id)).authorization.original.state,'authorized_homologation');assert.equal((await row(pending.id)).authorization.original.state,'receipt_pending');
   const c=await f.candidate('65'),id=await f.draftId(c.input.candidateId);assert.equal((await row(id)).authorization.visibility,'none');const b=await f.begin(c,4);const r=await row(id);assert.equal(r.authorization.selection,'active');assert.equal(r.authorization.original.state,'prepared');assert.equal(r.authorization.original.rule_review,null);assert.equal(r.authorization.original.result,null);assert.equal(r.authorization.original.attempt_id,b.value.receipt.attempt_id);
   // Reusing the real preparation path without reservation deliberately stops before unsigned build.
   await assert.rejects(f.stored({reserve:false}),/Explicit synthetic046 reservation required/);assert.ok((await page()).items.some(x=>x.numbering.visibility==='none'&&x.authorization.visibility==='none'));
  });
  await t.test('another active fiscal actor sees069 history but no079 existence oracle',async()=>{
   const p=await page({p_user_id:f.users.admin});for(const r of p.items.filter(r=>r.authorization.visibility==='available')){assert.equal(r.authorization.revalidation.visibility,'restricted');assert.equal(r.authorization.revalidation.result,null);}
   const r=p.items.find(r=>r.draft.id===id55);assert.equal(r.authorization.original.state,'review_required');assert.ok(!JSON.stringify(r).includes(x55.args.p_command_id));
   for(const actor of[f.users.consulta,f.users.vendas,randomUUID()])await assert.rejects(f.list({p_user_id:actor}),e=>e.code==='42501');
   await f.db.query('update erp_access.membership set active=false where user_id=$1',[f.users.fiscal]);try{await assert.rejects(f.list(),e=>e.code==='42501');}finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[f.users.fiscal]);}
  });
  await t.test('query limits, cursor and GET adapter preserve the exact original identities',async()=>{
   for(const patch of[{p_limit:0},{p_limit:26},{p_limit:null},{p_model:'66'},{p_status:'authorized_homologation'}])await assert.rejects(f.list(patch),e=>e.code==='22023');
   const first=await page({p_limit:2});assert.equal(first.has_more,true);const second=await page({p_limit:2,p_after:first.next_cursor});assert.ok(second.items.every(r=>r.draft.id>first.next_cursor));assert.ok((await page({p_model:'65'})).items.every(r=>r.draft.model==='65'));
   const sourceId=(await row(id55)).draft.source_document_id,route=parseFiscalDraftStatusRoute(new Request('https://erp.test/v1/rascunhos-fiscais/resumo?source_document_id='+sourceId));let calls=0;
   const actual=await executeFiscalDraftStatusRoute(route,{userId:f.users.fiscal,rpc:async(n,a)=>{calls++;assert.equal(n,'erp_fiscal_draft_status_list');return f.callSql(n,a);}});assert.equal(calls,1);assert.equal(actual.items.length,1);assert.equal(actual.items[0].draft.id,id55);
  });
  const corrupt=async(sql,args,check)=>{await f.db.exec('begin');try{await f.db.exec('set local session_replication_role=replica');await f.db.query(sql,args);await check();}finally{await f.db.exec('rollback');}};
  await t.test('inconsistent candidate, result, observation and review are never displayed as authorized',async()=>{
   const bad=[['update erp_fiscal_signed.artifact set signed_hash=$1 where candidate_id=$2',[hash('wrong'),x55.c.input.candidateId]],['update erp_fiscal_authorization.result set processed_hash=$1,processed_size=32 where attempt_id=$2',[hash('wrong'),x65.b.value.receipt.attempt_id]],['update erp_fiscal_reviewed_authorization.observation set response_hash=$1 where attempt_id=$2',[hash('wrong'),x55.b.value.receipt.attempt_id]],['update erp_fiscal_reviewed_authorization.review_binding set proof=jsonb_set(proof,\'{review_hash}\',to_jsonb($1::text))where attempt_id=$2',[hash('wrong'),x55.b.value.receipt.attempt_id]]];
   for(const[sql,args]of bad)await corrupt(sql,args,async()=>{const r=await row(sql.includes('processed_hash')?x65.id:id55);assert.equal(r.authorization.visibility,'inconsistent');assert.equal(r.authorization.original,null);assert.equal(r.authorization.revalidation.result,null);});
  });
  await t.test('unknown parser or inconsistent079 cannot hide the intact original069',async()=>{
   await corrupt('update erp_fiscal_authorization_revalidation.command set parser_profile=$1 where id=$2',['unknown-parser',x55.args.p_command_id],async()=>{const r=await row(id55);assert.equal(r.authorization.original.state,'review_required');assert.equal(r.authorization.revalidation.visibility,'unsupported');assert.equal(r.authorization.revalidation.result,null);});
   await corrupt('update erp_fiscal_authorization_revalidation.command set source_hash=$1 where id=$2',[hash('wrong'),x55.args.p_command_id],async()=>{const r=await row(id55);assert.equal(r.authorization.original.state,'review_required');assert.equal(r.authorization.revalidation.visibility,'inconsistent');assert.equal(r.authorization.revalidation.result,null);});
  });
  await t.test('captured reservation linkage wins over order proximity; newer candidate is not substituted',async()=>{
   await corrupt('update erp_fiscal_unsigned.job set draft_id=$1 where id=(select unsigned_job_id from erp_fiscal_signed.candidate where id=$2)',[x65.id,x55.c.input.candidateId],async()=>assert.equal((await row(id55)).authorization.visibility,'inconsistent'));
   await f.db.exec('begin');try{await f.db.query("insert into erp_fiscal_signed.candidate select(jsonb_populate_record(null::erp_fiscal_signed.candidate,to_jsonb(c)||jsonb_build_object('id',$1::text,'version',c.version+1,'a1_version',c.a1_version+1,'lease_id',$2::text))).* from erp_fiscal_signed.candidate c where id=$3",[randomUUID(),randomUUID(),x55.c.input.candidateId]);const r=await row(id55);assert.equal(r.authorization.original.candidate_id,x55.c.input.candidateId);assert.equal(r.authorization.basis.is_latest_candidate,false);assert.equal(r.authorization.basis.matches_current_preparation,false);assert.ok(r.authorization.basis.differences.includes('NEWER_SIGNED_CANDIDATE'));assert.equal(r.authorization.revalidation.result.protocol_cstat,'100');}finally{await f.db.exec('rollback');}
  });
  await t.test('business changes are separate warnings, not a rewritten historic authorization',async()=>{
   const d=(await row(id55)).draft;await f.callSql('erp_fiscal_draft_execute',{p_user_id:f.users.fiscal,p_command_id:randomUUID(),p_action:'update',p_data:{id:id55,expected_version:d.version,preparation:{operation_nature:'ALTERACAO FICTICIA',notes:null}}});
   const r=await row(id55);assert.equal(r.authorization.basis.matches_current_preparation,false);assert.ok(r.authorization.basis.differences.includes('DRAFT_CHANGED'));assert.equal(r.authorization.original.state,'review_required');assert.equal(r.authorization.revalidation.result.state,'authorized_homologation');
  });
  await t.test('active successor is selected explicitly and synthetic observations are not promoted',async()=>{
   const c=await f.candidate('55'),id=await f.draftId(c.input.candidateId),old=await f.begin(c,4);await f.wire('fail',{...f.ids(old),p_error_code:'PREPARATION_FAILED'});
   const next=await f.begin(c,4,{p_command_id:randomUUID()});assert.equal((await row(id)).authorization.original.attempt_id,next.value.receipt.attempt_id);assert.equal((await row(id)).authorization.selection,'active');
   const sv=await f.enable('synthetic'),s=await f.terminal('55','authorized',sv),r=await row(s.id);assert.equal(r.authorization.original.origin,'synthetic');assert.equal(r.authorization.original.state,'authorization_observed');assert.equal(r.authorization.revalidation.visibility,'none');
  });
  await t.test('history survives A1 change/disable, newer review, disabled policy and profile077 rotation',async()=>{
   await f.review(x65.c,{p_command_id:randomUUID(),p_expected_review_version:1});await f.configure();await f.disable();await f.enable('operational',false);
   await f.db.exec(await readFile(new URL('../../../supabase/migrations/202610160072_fiscal_reviewed_preflight.sql',import.meta.url),'utf8'));
   await f.db.exec(await readFile(new URL('../../../supabase/migrations/202610160077_fiscal_gtin_rule_profile_v2.sql',import.meta.url),'utf8'));
   const r=await row(id55);assert.equal(r.authorization.revalidation.result.state,'authorized_homologation');assert.equal((await row(x65.id)).authorization.original.result.protocol_cstat,'245');
   const before=await f.snapshotAll();await page();assert.deepEqual(await f.snapshotAll(),before);
  });
  await t.test('issuer mismatch withholds every fiscal identifier while draft022 remains visible',async()=>{
   await f.identity({cnpj:'04252011000110'});const r=await row(id55);assert.equal(r.numbering.visibility,'restricted');assert.equal(r.numbering.reservation,null);assert.equal(r.authorization.visibility,'restricted');assert.equal(r.authorization.original,null);assert.equal(r.authorization.revalidation.result,null);assert.equal(r.draft.id,id55);
  });
 }finally{await f.close();}
});
