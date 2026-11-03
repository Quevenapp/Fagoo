import test from 'node:test';import assert from 'node:assert/strict';
import {createOperationalV2Fixture,OBSERVED,LEGACY} from './helpers/cnab-operational-v2-fixture.mjs';
import {parseBoletoPreviewRoute,executeBoletoPreviewRoute} from '../src/boleto-preview.mjs';
import {boletoItems,boletoPreview} from '../../../apps/erp/src/lib/boleto-preview-model.ts';
import {boletoOperationalV2Fixture,actor} from './helpers/boleto-preview-fixture.mjs';
const route=id=>parseBoletoPreviewRoute(new Request(`https://test.invalid/v1/boletos-itau/${id}/preview`));
const status=n=>e=>e.status===n;
test('067 stored remittance → SQL066 replacement → exact bytes → preview → UI preserves explicit terms, no writes',async t=>{
 const f=await createOperationalV2Fixture();
 const preview=id=>executeBoletoPreviewRoute(route(id),f.ports({rpc:f.rpc}));
 try{for(const [encoding,amount,zero]of [[OBSERVED,'12345',false],[OBSERVED,'1',true],[LEGACY,'12345',false]])await t.test(`${encoding}/${amount}`,async()=>{
  const p=await f.profile(encoding===LEGACY);await f.approve(p,[encoding]);const title=await f.title(amount),s=await f.selection(p,[title],encoding,zero?[title.id]:[]),r=await f.reserve(s),ready=await f.finalize(r);
  const id=ready.generated.manifest[0].titleId,before=await f.scalar("select jsonb_build_array((select count(*) from erp_cnab.command),(select count(*) from erp_cnab.audit),(select count(*) from storage.objects),(select version from erp_finance.title where id=$1))::text v",[title.id]);
  const result=(await preview(id)).body;
  const list=(await executeBoletoPreviewRoute(parseBoletoPreviewRoute(new Request(`https://test.invalid/v1/boletos-itau/remittances/${r.id}/items`)),f.ports({rpc:f.rpc}))).body;
  const items=boletoItems(list,{id:r.id,profile_id:p.id,file_hash:ready.generated.fileHash,kind:'remittance',state:'ready'},'operational');
  const dto=await boletoPreview(result,items,items.items[0]);
  assert.equal(dto.renderProfile,'itau109-print-preview-v2');assert.equal(dto.encoding.profile,encoding);assert.equal(dto.binding.amountCents,amount);assert.match(dto.html,/NÃO PAGAR/);
  if(encoding===OBSERVED){assert.equal(dto.encoding.terms.dailyInterestCents,zero?'0':'4');assert.equal(dto.encoding.terms.zeroDailyInterestConfirmed,zero);assert.match(dto.html,/Multa/);assert.doesNotMatch(dto.html,/Encargos não calculados/);}else assert.equal(dto.encoding.terms,null);
  for(const key of ['canPay','canIssue','canTransmit','financialMutationPerformed','bankTransmissionPerformed','persisted','counters_changed'])assert.equal(dto[key],false);
  assert.equal(await f.scalar("select jsonb_build_array((select count(*) from erp_cnab.command),(select count(*) from erp_cnab.audit),(select count(*) from storage.objects),(select version from erp_finance.title where id=$1))::text v",[title.id]),before);
  await f.approve(p,[]);await assert.rejects(()=>preview(id),status(409));
 });assert.equal(await f.scalar('select count(*)::int v from erp_finance.movement'),0);assert.equal(await f.scalar('select count(*)::int v from erp_finance.settlement'),0);
 }finally{await f.close();}
});
test('067 preview refuses tampered terms, mixed legacy envelope and stale approval before Storage',async()=>{
 const f=await boletoOperationalV2Fixture();
 for(const change of [c=>c.snapshot.titles[0].encodingTerms.dailyInterestCents='5',c=>c.snapshot.encoding_authorization.compatibility_confirmed=false,c=>c.snapshot.encoding_authorization.approval_version=2,c=>c.profile='itau109-persisted-print-preview-v1',c=>c.snapshot.encoding_profile='unknown',c=>c.manifest[0].encodingTerms.penaltyPercentHundredths='100']){
  const c=structuredClone(f.context);change(c);let reads=0;await assert.rejects(()=>executeBoletoPreviewRoute(route(f.billing),{userId:actor,rpc:async()=>c,getFile:async()=>{reads++;return f.bytes.slice();}}));assert.equal(reads,0);
 }
 let calls=0;await assert.rejects(()=>executeBoletoPreviewRoute(route(f.billing),{userId:actor,rpc:async()=>{const c=structuredClone(f.context);if(++calls===2)c.context_hash='f'.repeat(64);return c;},getFile:async()=>f.bytes.slice()}),status(409));assert.equal(calls,2);
});
test('preview passes cancellation to the production Storage port first argument',async()=>{
 const f=await boletoOperationalV2Fixture(),abort=new AbortController();let signal;
 const work=executeBoletoPreviewRoute(route(f.billing),{userId:actor,signal:abort.signal,rpc:async()=>structuredClone(f.context),getFile:async arg=>{signal=arg.signal;assert.ok(signal instanceof AbortSignal);abort.abort();return f.bytes.slice();}});
 await assert.rejects(()=>work,status(504));assert.equal(signal.aborted,true);
});
