import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOperationalV2Fixture,OBSERVED,LEGACY} from './helpers/cnab-operational-v2-fixture.mjs';
let f;before(async()=>{f=await createOperationalV2Fixture();});after(()=>f?.close());const state=code=>e=>e.code===code;
test('067 explicit observed approval is separate from old simple policy and previews do not reserve',async()=>{
 const p=await f.profile();assert.equal(p.policy_verified,false);const a=await f.approve(p);assert.equal(a.result.approval.effective_enabled,true);assert.deepEqual(a.result.approval.allowed_encoding_profiles,[OBSERVED]);
 assert.equal(await f.scalar('select erp_cnab.operational_status($1)->\'effective_enabled\' v',[p.id]),false);
 const s=await f.selection(p,[await f.title()]),pr=await f.preview(s);assert.equal(pr.can_reserve,true);assert.deepEqual(pr.pending,[]);assert.equal(pr.snapshot.profile.simpleCollectionPolicyVerified,false);assert.equal(pr.snapshot.titles[0].encodingTerms.dailyInterestCents,'4');
 assert.equal(await f.scalar('select count(*)::int v from erp_cnab.remittance where profile_id=$1',[p.id]),0);
 const r=await f.reserve(s,pr),fin=await f.finalize(r);assert.equal(fin.result.state,'ready');assert.equal(fin.generated.bytes.length,1608);const c=await f.command(s.p_command_id);assert.equal(c.receipt.state,'reserved');assert.equal(c.current.state,'ready');assert.equal(c.current.file_hash,fin.generated.fileHash);
 assert.equal((await f.reserve(s,pr)).replayed,true);assert.equal(await f.scalar('select next_sequence::text v from erp_cnab.profile where id=$1',[p.id]),'2');
});
test('zero is an explicit per-title decision; pending preview cannot reserve and wrong IDs fail',async()=>{
 const p=await f.profile();await f.approve(p);const small=await f.title('1499'),large=await f.title('1500'),s=await f.selection(p,[small,large]);
 const pr=await f.preview(s);assert.equal(pr.can_reserve,false);assert.deepEqual(pr.pending,[{code:'ZERO_DAILY_FIELD_UNCONFIRMED',title_id:small.id}]);
 await assert.rejects(()=>f.reserve(s,pr),state('22023'));assert.equal(await f.scalar('select next_sequence::text v from erp_cnab.profile where id=$1',[p.id]),'1');
 for(const ids of[[large.id],[randomUUID()],[small.id,small.id]])await assert.rejects(()=>f.preview({...s,p_zero_daily_title_ids:ids}),state('22023'));
 const confirmed={...s,p_zero_daily_title_ids:[small.id]},p2=await f.preview(confirmed);assert.equal(p2.can_reserve,true);assert.notEqual(p2.preview_hash,pr.preview_hash);
 await assert.rejects(()=>f.reserve(confirmed,pr),state('40001'));const r=await f.reserve(confirmed,p2),fin=await f.finalize(r);assert.equal(fin.generated.bytes.length,2412);assert.equal(fin.generated.manifest[0].encodingTerms.dailyInterestCents,'0');
});
test('no implicit selection, strict consent shapes, admin only and no counterfeit simple-policy flag',async()=>{
 const p=await f.profile();for(const overrides of[{p_allowed_encoding_profiles:null},{p_allowed_encoding_profiles:[]},{p_allowed_encoding_profiles:[OBSERVED,OBSERVED]},{p_compatibility_confirmed:false},{p_permanent_instructions_acknowledged:null},{p_allowed_encoding_profiles:[LEGACY],p_compatibility_confirmed:false,p_permanent_instructions_acknowledged:false}])await assert.rejects(()=>f.approve(p,[OBSERVED],overrides));
 await assert.rejects(()=>f.approve(p,[OBSERVED],{p_user_id:f.users.financeiro}),state('42501'));await f.approve(p);
 const s=await f.selection(p,[await f.title()]);for(const patch of[{p_encoding_profile:null},{p_zero_daily_title_ids:null},{p_zero_daily_title_ids:[null]},{p_preview:null},{p_confirm_encoding_profile:null},{p_confirm_operational:true},{p_preview_hash:'a'.repeat(64)}])await assert.rejects(()=>f.preview({...s,...patch}),state('22023'));
 assert.equal(await f.scalar("select settings->'simpleCollectionPolicyVerified'v from erp_cnab.profile where id=$1",[p.id]),false);
});
test('captured approval and terms survive reconfirmation; revoked approval blocks bytes, history remains readable',async()=>{
 const p=await f.profile();await f.approve(p);const s=await f.selection(p,[await f.title()]),r=await f.reserve(s),before=(await f.read(r.id)).snapshot;
 await f.approve(p,[]);await assert.rejects(()=>f.read(r.id,2),state('40001'));assert.equal((await f.command(s.p_command_id)).current.state,'reserved');
 await f.approve(p,[OBSERVED],{p_reference:'NEW REVIEW DOES NOT REWRITE OLD CAPTURE'});const value=await f.read(r.id,3);assert.deepEqual(value.snapshot,before);assert.equal(value.approval_version,3);assert.equal(value.snapshot.encoding_authorization.approval_version,1);
 await f.finalize(r,3);const c=await f.command(s.p_command_id);assert.equal(c.receipt.approval_version,1);assert.equal(c.current.state,'ready');
 await f.db.query('update erp_access.membership set active=false where user_id=$1',[f.users.financeiro]);try{await assert.rejects(()=>f.command(s.p_command_id),state('42501'));await assert.rejects(()=>f.reserve(s),state('42501'));}finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[f.users.financeiro]);}
 await assert.rejects(()=>f.command(s.p_command_id,f.users.admin),state('P0002'));
});
test('manifest exact types, terms, DV and immutable Storage binding reject before ready',async()=>{
 const p=await f.profile();await f.approve(p);const s=await f.selection(p,[await f.title()]),r=await f.reserve(s);
 const v=await f.read(r.id);const{generateOperationalRemittanceV2}=await import('../../../packages/cnab-core/src/index.mjs');const g=await generateOperationalRemittanceV2(v.snapshot),path=`profiles/${p.id}/remittances/${g.fileHash}.rem`;
 await f.ports().storeFile({bucket:'brufap-cnab',path,bytes:g.bytes,upsert:false});const args={p_user_id:f.users.financeiro,p_command_id:randomUUID(),p_id:r.id,p_hash:g.fileHash,p_size:g.bytes.length,p_path:path,p_manifest:g.manifest,p_expected_approval:1};
 for(const change of[m=>{m[0].encodingTerms.dailyInterestCents='5';},m=>{m[0].ourNumber=m[0].ourNumber.slice(0,-1)+(Number(m[0].ourNumber.at(-1))+1)%10;},m=>{m[0].amountCents=12345;},m=>{m[0].x=true;},m=>{delete m[0].encodingTerms;}]){const m=structuredClone(g.manifest);change(m);await assert.rejects(()=>f.rpc('erp_cnab_operational_finalize_v2',{...args,p_manifest:m}));assert.equal((await f.command(s.p_command_id)).current.state,'reserved');}
 await assert.rejects(()=>f.rpc('erp_cnab_operational_finalize_v2',{...args,p_size:g.bytes.length+1}),state('40001'));
 const done=await f.rpc('erp_cnab_operational_finalize_v2',args);assert.equal(done.state,'ready');assert.equal((await f.rpc('erp_cnab_operational_finalize_v2',args)).replayed,true);
 await assert.rejects(()=>f.rpc('erp_cnab_operational_finalize_v2',{...args,p_manifest:[]}),state('40001'));
});
test('v1 stays byte-compatible, v2 family cannot be resumed through v1, both share command/counter identity',async()=>{
 const old=await f.prepare();const legacyHash=old.remittance.file_hash;
 const p=await f.profile(true);await f.approve(p,[LEGACY,OBSERVED]);const s=await f.selection(p,[await f.title()],LEGACY),r=await f.reserve(s),fin=await f.finalize(r);assert.equal(fin.generated.bytes.length,1206);assert.equal('encodingTerms'in fin.generated.manifest[0],false);
 for(const [name,args]of[['erp_cnab_operational_reservation',{p_id:r.id,p_expected_approval:1}],['erp_cnab_operational_file',{p_id:r.id}]])await assert.rejects(()=>f.rpc(name,{p_user_id:f.users.financeiro,...args}),state('P0002'));
 await assert.rejects(()=>f.rpc('erp_cnab_operational_reserve',{p_user_id:f.users.financeiro,p_command_id:s.p_command_id,p_profile_id:p.id,p_expected_version:s.p_expected_version,p_expected_approval:1,p_generated_on:f.today,p_titles:s.p_titles,p_confirm_operational:true,p_preview:false,p_preview_hash:'a'.repeat(64)}),state('40001'));
 assert.equal((await f.rpc('erp_cnab_operational_file',{p_user_id:f.users.financeiro,p_id:old.remittance.id})).hash,legacyHash);
 const page=await f.rpc('erp_cnab_operational_files_v2',{p_user_id:f.users.consulta,p_limit:100,p_after:null});assert.equal(page.items.find(x=>x.id===old.remittance.id).encoding_profile,null);assert.equal(page.items.find(x=>x.id===r.id).encoding_profile,LEGACY);
});
test('066 reads discriminate immutable v2 capture and keep preview unpayable, with original consent false',async()=>{
 const p=await f.profile();await f.approve(p);const r=await f.reserve(await f.selection(p,[await f.title()]));await f.finalize(r);const b=(await f.read(r.id)).snapshot.titles[0];
 const context=await f.rpc('erp_cnab_itau_boleto_context',{p_user_id:f.users.consulta,p_billing_title_id:b.id});assert.equal(context.profile,'itau109-persisted-print-preview-v2');assert.equal(context.can_pay,false);assert.equal(context.snapshot.profile.simpleCollectionPolicyVerified,false);assert.deepEqual(context.manifest[0].encodingTerms,b.encodingTerms);
 const before=context.snapshot_hash;await f.approve(p,[OBSERVED],{p_reference:'LATER REVIEW'});const after=await f.rpc('erp_cnab_itau_boleto_context',{p_user_id:f.users.consulta,p_billing_title_id:b.id});assert.equal(after.snapshot_hash,before);assert.equal(after.current.approval_version,2);
});
test('old authorization does not implicitly authorize observed; new observed-only approval never unlocks v1',async()=>{
 const p=await f.profile(true);await f.approve(p,[LEGACY]);const s=await f.selection(p,[await f.title()]);await assert.rejects(()=>f.preview(s),state('40001'));
 await f.approve(p,[OBSERVED]);assert.equal(await f.scalar("select erp_cnab.operational_status($1)->'effective_enabled'v",[p.id]),false);
 await assert.rejects(()=>f.rpc('erp_cnab_operational_reserve',{p_user_id:f.users.financeiro,p_command_id:randomUUID(),p_profile_id:p.id,p_expected_version:1,p_expected_approval:2,p_generated_on:f.today,p_titles:s.p_titles,p_confirm_operational:false,p_preview:true,p_preview_hash:null}),state('40001'));
});
test('30 zero titles fit bounded snapshots/manifests; 31 rejected and no finance effect',async()=>{
 const p=await f.profile();await f.approve(p);const titles=[];for(let i=0;i<30;i++)titles.push(await f.title('1499'));
 const before=await f.scalar("select md5(jsonb_build_object('titles',(select jsonb_agg(to_jsonb(t)order by id)from erp_finance.title t),'movements',(select jsonb_agg(to_jsonb(t)order by id)from erp_finance.movement t),'settlements',(select jsonb_agg(to_jsonb(t)order by id)from erp_finance.settlement t))::text)v");
 const s=await f.selection(p,titles,OBSERVED,titles.map(t=>t.id)),pr=await f.preview(s);assert.ok(Buffer.byteLength(JSON.stringify(pr))<131072);const r=await f.reserve(s,pr),fin=await f.finalize(r);assert.equal(fin.generated.bytes.length,24924);assert.ok(Buffer.byteLength(JSON.stringify(fin.generated.manifest))<32768);
 const after=await f.scalar("select md5(jsonb_build_object('titles',(select jsonb_agg(to_jsonb(t)order by id)from erp_finance.title t),'movements',(select jsonb_agg(to_jsonb(t)order by id)from erp_finance.movement t),'settlements',(select jsonb_agg(to_jsonb(t)order by id)from erp_finance.settlement t))::text)v");assert.equal(after,before);
 await assert.rejects(()=>f.preview({...s,p_titles:[...s.p_titles,s.p_titles[0]]}),state('22023'));
});
test('return exact linkage selects observed artifact policy; fee remains explicit and positive mora blocked',async()=>{
 const p=await f.profile();await f.approve(p);const t=await f.title(),r=await f.reserve(await f.selection(p,[t]));await f.finalize(r);const snap=(await f.read(r.id)).snapshot,synthetic={profile:p,title:t,remittance:r,snapshot:snap,bt:snap.titles[0]};
 const incoming=await f.importFile(synthetic,f.source(synthetic,{fee:'125',paid:'12220'})),category=await f.category(),pr=await f.netPreview(incoming,category);assert.equal(pr.context.settlement.allowed,true);
 const delayed=await f.importFile(synthetic,f.source(synthetic,{fee:'125',paid:'12225',interest:'5'},'00002'));const blocked=await f.netPreview(delayed,category);assert.equal(blocked.context.settlement.allowed,false);assert.ok(JSON.stringify(blocked).includes('MORA_PENALTY_UNSUPPORTED'));
 const settle=await f.rpc('erp_cnab_itau_net_credit_settle',f.netCommand(incoming,category,pr));assert.equal(settle.receipt.posting.principal_cents,'12345');assert.equal(settle.receipt.posting.net_cash_cents,'12220');
});
test('067 table/helper privileges stay closed, RPCs service-only and actor read checks remain current',async()=>{
 for(const role of['anon','authenticated','service_role'])assert.equal(await f.scalar("select has_table_privilege($1,'erp_cnab.operational_encoding_revision','SELECT,INSERT,UPDATE,DELETE')v",[role]),false);
 const funcs=(await f.db.query("select p.oid::regprocedure::text signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and p.proname like 'erp_cnab_operational_%_v2'")).rows;assert.equal(funcs.length,8);
 for(const row of funcs){assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE')v",[row.signature]),true);for(const role of['anon','authenticated'])assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE')v",[role,row.signature]),false);}
 await assert.rejects(()=>f.rpc('erp_cnab_operational_profiles_v2',{p_user_id:f.users.vendas}),state('42501'));await assert.rejects(()=>f.command(randomUUID()),state('P0002'));
});
test('approval lost ACK reads its historical receipt separately from current approval and current admin ACL',async()=>{
 const p=await f.profile(),a=await f.approve(p);await f.approve(p,[]);
 const c=await f.command(a.args.p_command_id,f.users.admin);assert.equal(c.kind,'approval');assert.equal(c.receipt.approval.enabled,true);assert.equal(c.current.approval.enabled,false);assert.equal(c.receipt.approval.approval_version,1);assert.equal(c.current.approval.approval_version,2);
 assert.equal((await f.rpc('erp_cnab_operational_approve_v2',a.args)).replayed,true);assert.equal((await f.command(a.args.p_command_id,f.users.admin)).current.approval.enabled,false);
 await f.db.query("update erp_access.membership set role='financeiro'where user_id=$1",[f.users.admin]);try{await assert.rejects(()=>f.command(a.args.p_command_id,f.users.admin),state('42501'));await assert.rejects(()=>f.rpc('erp_cnab_operational_approve_v2',a.args),state('42501'));}finally{await f.db.query("update erp_access.membership set role='admin'where user_id=$1",[f.users.admin]);}
});
test('SQL approval references with NBSP and Unicode limits remain generatable from their exact capture',async()=>{
 for(const reference of['\u00a0SYNTHETIC REVIEW\u00a0','🔎'.repeat(200)]){
  const p=await f.profile();await f.approve(p,[OBSERVED],{p_reference:reference});const r=await f.reserve(await f.selection(p,[await f.title()]));
  const capture=await f.read(r.id);assert.equal(capture.snapshot.encoding_authorization.reference,reference);
  assert.equal((await f.finalize(r)).result.state,'ready');
 }
});
