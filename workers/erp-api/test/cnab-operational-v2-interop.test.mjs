import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createOperationalV2Fixture,OBSERVED,LEGACY} from './helpers/cnab-operational-v2-fixture.mjs';
import {parseCnabOperationalV2Route,executeCnabOperationalV2Route} from '../src/cnab-operational-v2.mjs';
import {v2Profiles,v2Preview,v2Page,v2Ack,v2Command} from '../../../apps/erp/src/lib/cnab-operational-v2-model.ts';
const code=c=>e=>e.code===c;
function previewBody(p){return{command_id:p.p_command_id,profile_id:p.p_profile_id,expected_version:p.p_expected_version,expected_approval_version:p.p_expected_approval,
 generated_on:p.p_generated_on,titles:p.p_titles,confirm_operational:false,encoding_profile:p.p_encoding_profile,confirm_encoding_profile:false,zero_daily_title_ids:p.p_zero_daily_title_ids};}

test('067 actual SQL → HTTP → codec → Storage, sequential synthetic fixture',async t=>{
 const f=await createOperationalV2Fixture();
 const api=async(path,body,extra={})=>executeCnabOperationalV2Route(await parseCnabOperationalV2Route(new Request('https://test.invalid/v1/cobranca-operacional-v2'+path,
  body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})),f.ports({rpc:f.rpc,...extra}));
 let first,firstBody,firstProfile,approvalCommand,approvalIntent;
 try{
  await t.test('approval endpoint and private command read preserve historical approval and enforce admin actor',async()=>{
   const p=await f.profile(),body={command_id:randomUUID(),expected_approval_version:0,expected_profile_version:1,expected_identity_version:1,enabled:true,confirmed_on:f.today,reference:'SYNTHETIC HTTP CONFIRMATION',allowed_encoding_profiles:[OBSERVED],compatibility_confirmed:true,permanent_instructions_acknowledged:true};
   const ack=(await api(`/profiles/${p.id}/approval`,body,{userId:f.users.admin})).body;assert.equal(ack.approval.allowed_encoding_profiles[0],OBSERVED);approvalCommand=body.command_id;firstProfile=p;approvalIntent={kind:'approval',profileId:p.id,body};assert.equal(v2Ack(ack,approvalIntent).approval.approval_version,1);
   const read=(await api('/commands/'+body.command_id,undefined,{userId:f.users.admin})).body;assert.equal(read.kind,'approval');assert.deepEqual(read.receipt,ack);assert.equal(read.current.approval.approval_version,1);assert.equal(v2Command(read,approvalIntent,v2Ack(ack,approvalIntent)).kind,'approval');
   await assert.rejects(()=>api('/commands/'+body.command_id),code('ERP_NOT_FOUND'));
   const profiles=(await api('/profiles')).body;assert.ok(profiles.items.some(x=>x.profile.id===p.id));assert.ok(v2Profiles(profiles).some(x=>x.profile.id===p.id));assert.doesNotMatch(JSON.stringify(profiles),/"cnpj"|"accountDigit"|"agency"/);
  });
  await t.test('observed positive preview/generate/read/file with preserved no-effect flags',async()=>{
   const row=await f.title(),selection=await f.selection(firstProfile,[row]),b=previewBody(selection),preview=(await api('/remittances/preview',b)).body;
   assert.equal(preview.can_reserve,true);assert.equal(v2Preview(preview,b).can_reserve,true);assert.equal(preview.items[0].encoding_terms.dailyInterestCents,'4');assert.equal(preview.items[0].encoding_terms.interestDateField,f.today);
   const before=await f.scalar("select encode(sha256(convert_to(jsonb_agg(to_jsonb(t)order by id)::text,'UTF8')),'hex')v from erp_finance.title t");
   firstBody={...b,preview_hash:preview.preview_hash,confirm_operational:true,confirm_encoding_profile:true};first=(await api('/remittances',firstBody)).body;assert.equal(first.byte_size,1608);assert.equal(first.state,'ready');assert.equal(v2Ack(first,{kind:'generate',profileId:firstProfile.id,body:firstBody}).id,first.id);
   assert.equal(await f.scalar("select encode(sha256(convert_to(jsonb_agg(to_jsonb(t)order by id)::text,'UTF8')),'hex')v from erp_finance.title t"),before);
   const c=(await api('/commands/'+b.command_id)).body;assert.equal(c.kind,'remittance');assert.equal(c.receipt.state,'reserved');assert.equal(c.current.state,'ready');assert.equal(v2Command(c,{kind:'generate',profileId:firstProfile.id,body:firstBody},v2Ack(first,{kind:'generate',profileId:firstProfile.id,body:firstBody})).current.state,'ready');
   const download=await api('/files/remittance/'+first.id,undefined,{userId:f.users.consulta});assert.equal(createHash('sha256').update(download.bytes).digest('hex'),first.file_hash);
   const list=(await api('/remittances?limit=30')).body;assert.equal(list.items.find(x=>x.id===first.id).encoding_profile,OBSERVED);assert.equal(v2Page(list,30).items.find(x=>x.id===first.id).encoding_profile,OBSERVED);
   for(const k of['productionReady','bankTransmissionPerformed','financialMutationPerformed','originAuthenticated'])assert.equal(first[k],false);
  });
  await t.test('zero pending cannot reserve until a new matching preview confirms precisely its title',async()=>{
   const p=await f.profile();await f.approve(p);const row=await f.title('1'),selection=await f.selection(p,[row]),b=previewBody(selection);
   const pending=(await api('/remittances/preview',b)).body;assert.equal(pending.can_reserve,false);assert.equal(v2Preview(pending,b).can_reserve,false);assert.deepEqual(pending.pending,[{code:'ZERO_DAILY_FIELD_UNCONFIRMED',title_id:row.id}]);
   await assert.rejects(()=>api('/remittances',{...b,preview_hash:pending.preview_hash,confirm_operational:true,confirm_encoding_profile:true}),code('ERP_CNAB_OPERATIONAL_V2_INVALID_INPUT'));
   const confirmed={...b,zero_daily_title_ids:[row.id]},pr=(await api('/remittances/preview',confirmed)).body;assert.equal(pr.can_reserve,true);assert.equal(v2Preview(pr,confirmed).can_reserve,true);assert.notEqual(pr.preview_hash,pending.preview_hash);
   const result=(await api('/remittances',{...confirmed,preview_hash:pr.preview_hash,confirm_operational:true,confirm_encoding_profile:true})).body;assert.equal(result.state,'ready');assert.ok(result.warnings.includes('ZERO_DAILY_FIELD_BANK_EFFECT_UNKNOWN'));
  });
  await t.test('no-charges v2 stays distinct from legacy and serializes without terms',async()=>{
   const p=await f.profile(true);await f.approve(p,[LEGACY]);const row=await f.title(),b=previewBody(await f.selection(p,[row],LEGACY)),pr=(await api('/remittances/preview',b)).body;
   assert.equal(Object.hasOwn(pr.items[0],'encoding_terms'),false);assert.equal(Object.hasOwn(v2Preview(pr,b).items[0],'encoding_terms'),false);const result=(await api('/remittances',{...b,preview_hash:pr.preview_hash,confirm_operational:true,confirm_encoding_profile:true})).body;
   assert.equal(result.byte_size,1206);assert.equal(result.encoding_profile,LEGACY);
   await assert.rejects(()=>f.op('/files/remittance/'+result.id),e=>e.code==='P0002');
  });
  await t.test('lost finalize response returns uncertainty and GET verifies commit without re-executing',async()=>{
   const p=await f.profile();await f.approve(p);const row=await f.title(),b=previewBody(await f.selection(p,[row])),pr=(await api('/remittances/preview',b)).body;let writes=0;
   await assert.rejects(()=>api('/remittances',{...b,preview_hash:pr.preview_hash,confirm_operational:true,confirm_encoding_profile:true},{rpc:async(n,a)=>{const r=await f.rpc(n,a);if(n==='erp_cnab_operational_finalize_v2'){writes++;throw new Error('SYNTHETIC LOST ACK');}return r;}}),code('ERP_RESULT_UNCONFIRMED'));
   const read=(await api('/commands/'+b.command_id)).body;assert.equal(read.current.state,'ready');assert.equal(read.receipt.state,'reserved');assert.equal(writes,1);
  });
  await t.test('revoked approval permits historical reads only; current result is never substituted into receipt',async()=>{
   await f.approve(firstProfile,[]);const historical=(await api('/commands/'+approvalCommand,undefined,{userId:f.users.admin})).body;
   assert.equal(historical.receipt.approval.enabled,true);assert.equal(historical.current.approval.enabled,false);assert.equal(v2Command(historical,approvalIntent).current.approval.enabled,false);
   const generation=(await api('/commands/'+firstBody.command_id)).body;assert.equal(generation.current.state,'ready');assert.equal(generation.receipt.approval_version,1);
   await assert.rejects(()=>api('/files/remittance/'+first.id),code('ERP_CONFLICT'));
   await assert.rejects(()=>api('/profiles',undefined,{userId:f.users.vendas}),code('ERP_FORBIDDEN'));
   assert.equal(await f.scalar('select count(*)::int v from erp_finance.movement'),0);assert.equal(await f.scalar('select count(*)::int v from erp_finance.settlement'),0);
  });
 }finally{await f.close();}
});
