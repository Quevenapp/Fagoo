import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,hash} from '../../../packages/fiscal-unsigned-orchestrator/test/fixture.mjs';
import {commercialFoundation,applyPricePrecision} from '../../../tools/migration/fixtures/fiscal-price-precision.mjs';
import {parseFiscalDraftRoute,executeFiscalDraftRoute} from '../src/fiscal-drafts.mjs';
import {parseFiscalItemRoute,executeFiscalItemRoute} from '../src/fiscal-item-preparation.mjs';
import {parseFiscalTaxRoute,executeFiscalTaxRoute} from '../src/fiscal-tax-preparation.mjs';
import {parseFiscalCompletionRoute,executeFiscalCompletionRoute} from '../src/fiscal-completion.mjs';
import {parseFiscalReviewRoute,executeFiscalReviewRoute} from '../src/fiscal-review.mjs';
import {fiscalDraftEnvelope} from '../../../apps/erp/src/lib/fiscal-drafts-model.ts';
import {fiscalItemEnvelope} from '../../../apps/erp/src/lib/fiscal-item-model.ts';
import {taxEnvelope} from '../../../apps/erp/src/lib/fiscal-tax-model.ts';
import {completionEnvelope} from '../../../apps/erp/src/lib/fiscal-completion-model.ts';
import {fiscalReviewView} from '../../../apps/erp/src/lib/fiscal-review-model.ts';
import {unsignedOutcome,unsignedJob} from '../../../apps/erp/src/lib/fiscal-unsigned-model.ts';
import {publicResult,projectSqlView} from '../../../packages/fiscal-unsigned-runtime/src/dto.mjs';
import {resolveBusinessContent} from '../../../packages/fiscal-core/src/business-document.mjs';
import {buildBoundBusinessXml,bindResolvedBusinessContent} from '../../../packages/fiscal-xml/src/bound-business.mjs';

const generation=j=>({command_id:j.commandId,reservation_id:j.reservationId,draft_id:j.draftId,completion_version:j.completionVersion,completion_hash:j.completionHash,basis_hash:j.basisHash});
async function api(f,path,parse,execute){const value=await execute(await parse(new Request('https://synthetic.invalid'+path)),{userId:f.users.fiscal,rpc:f.callSql});return value?.type==='json'?value.body:value;}
async function views(f,source){
 const id=source.draft.record.id;
 const draft=await api(f,`/v1/rascunhos-fiscais/${id}`,parseFiscalDraftRoute,executeFiscalDraftRoute);
 const items=await api(f,`/v1/preparacao-itens-fiscais/${id}`,parseFiscalItemRoute,executeFiscalItemRoute);
 const tax=await api(f,`/v1/preparacao-tributaria/${id}`,parseFiscalTaxRoute,executeFiscalTaxRoute);
 const completion=await api(f,`/v1/complemento-fiscal/${id}`,parseFiscalCompletionRoute,executeFiscalCompletionRoute);
 const review=await api(f,`/v1/rascunhos-fiscais/${id}/conferencia?revision=1`,parseFiscalReviewRoute,executeFiscalReviewRoute);
 return{draft:fiscalDraftEnvelope(draft,id,1),items:fiscalItemEnvelope(items,id),tax:taxEnvelope(tax,id),completion:completionEnvelope(completion,id),review:fiscalReviewView(review,id,1,draft.record.snapshot_hash)};
}
async function immutable(f,id){
 const tables=['erp_fiscal_drafts.revision','erp_fiscal_items.revision','erp_fiscal_tax.revision','erp_fiscal_completion.revision'];
 const rows={};for(const table of tables)rows[table]=await f.scalar(`select coalesce(jsonb_agg(to_jsonb(r) order by version),'[]')value from ${table} r where draft_id=$1`,[id]);
 return rows;
}

test('057 keeps old fiscal JSONB/hashes/artifact/replay, and reads exact new prices through SQL → API → UI → 048',async t=>{
 const f=await fixture();
 try{
  await commercialFoundation(f);
  const old=await f.prepare(),oldInput=await f.input(old),oldRun=await f.orchestrator().run(oldInput);
  assert.equal(oldRun.status,'stored');
  const oldViews=await views(f,old),oldRows=await immutable(f,old.draft.record.id),oldBasis=await f.basis(old),oldCount=await f.counts();
  const oldFiles=Object.fromEntries([...f.files].map(([key,bytes])=>[key,hash(bytes)]));
  await applyPricePrecision(f);
  await t.test('existing 022/035/040/047 JSONB and 048 bytes remain unchanged, replay consumes no number',async()=>{
   assert.deepEqual(await immutable(f,old.draft.record.id),oldRows);
   const afterViews=await views(f,old);assert.ok(Date.parse(afterViews.review.basis.observed_at)>=Date.parse(oldViews.review.basis.observed_at));
   // This read timestamp is current observation, never part of the immutable 022 snapshot.
   afterViews.review.basis.observed_at=oldViews.review.basis.observed_at;assert.deepEqual(afterViews,oldViews);assert.deepEqual(await f.basis(old),oldBasis);
   assert.deepEqual(Object.fromEntries([...f.files].map(([key,bytes])=>[key,hash(bytes)])),oldFiles);
   const replay=await f.orchestrator().run(oldInput);assert.equal(replay.status,'stored');assert.deepEqual(replay.artifact,oldRun.artifact);assert.equal(replay.basis_hash,oldRun.basis_hash);
   assert.deepEqual(await f.counts(),oldCount);assert.equal(oldViews.draft.record.snapshot.items[0].unit_price,'10.0000');
  });
  for(const model of ['55','65'])await t.test(`model ${model}: precise prices, explicit payments and allocations survive every reader`,async()=>{
   const source=await f.prepare({model,count:2,quantity:'2.000000',unit_price:'10.1234567891',discount:'0.03',freight:'1.01',other:'0.02',installments:true});
   const checked=await views(f,source),snapshot=checked.draft.record.snapshot;
   assert.equal(snapshot.items[0].unit_price,'10.1234567891');assert.equal(snapshot.items[1].gross,'20.25');assert.equal(snapshot.totals.total,'41.50');
   assert.equal(snapshot.installments[0].amount,'41.50');assert.equal(checked.items.draft.record.snapshot.items[0].unit_price,'10.1234567891');
   assert.equal(checked.completion.record.completion.items[0].tributary.unit_price,'10.1234567891');
   assert.ok(!JSON.stringify(checked.review).includes('ITEM_PRICE_PRECISION'));assert.equal(checked.review.tax_rules_validated,false);
   const input=await f.input(source),body=generation(input),before=await f.counts();
   const preflight=await f.orchestrator().preview(f.previewInput(source));assert.equal(preflight.status,'checked');
   const run=await f.orchestrator().run(input);assert.equal(run.status,'stored',JSON.stringify(run));
   const publicRun=publicResult(run,{action:'generate',payload:body});assert.equal(unsignedOutcome(publicRun,body).status,'stored');
   const read=await f.get(run.job_id),publicRead=projectSqlView(read,{jobId:run.job_id});
   assert.equal(unsignedJob(publicRead,{...body,job_id:run.job_id,command_id:undefined,read_only:true}).artifact.sha256,run.artifact.sha256);
   const bytes=f.files.get(`jobs/${run.job_id}/${run.artifact.sha256}.xml`),xml=bytes.toString('utf8');
   assert.match(xml,/<vUnCom>10\.1234567891<\/vUnCom>/);assert.match(xml,/<vUnTrib>10\.1234567891<\/vUnTrib>/);assert.match(xml,/<vNF>41\.50<\/vNF>/);assert.match(xml,/<vPag>41\.50<\/vPag>/);
   const after=await f.counts();assert.equal(after.reservations,before.reservations);assert.equal(after.finance,0);assert.equal(after.stock,0);
   assert.equal(publicRun.signature_verified,false);assert.equal(publicRun.xsd_validated,false);assert.equal(publicRun.can_transmit,false);
   assert.doesNotMatch(JSON.stringify(publicRun),/10\.1234567891|<NFe|execution|holder_cnpj/);
   // Updating 047 cannot reinterpret or silently regenerate an already stored 048 artifact.
   await f.updateCompletion(source,{additional_information:'NOVA REVISAO FICTICIA'});
   const historical=projectSqlView(await f.get(run.job_id),{jobId:run.job_id});
   assert.equal(historical.current.basis_changed,true);assert.equal(historical.current.artifact_current,false);assert.equal(historical.artifact.sha256,run.artifact.sha256);
   assert.equal((await f.orchestrator().run(input)).artifact.sha256,run.artifact.sha256);assert.equal(f.files.get(`jobs/${run.job_id}/${run.artifact.sha256}.xml`).toString('utf8'),xml);
  });
  await t.test('q6 commercial data remains readable but fiscal q4 violation blocks generation without rounding',async()=>{
   const source=await f.prepare({quantity:'0.000001',unit_price:'10000.1234567891',reserve:false}),checked=await views(f,source);
   assert.equal(checked.draft.record.snapshot.items[0].quantity,'0.000001');assert.equal(checked.draft.record.snapshot.totals.total,'0.01');
   assert.ok(JSON.stringify(checked.review).includes('ITEM_QUANTITY_PRECISION'));
   const before=await f.counts(),preview=await f.orchestrator().preview(f.previewInput(source));
   assert.equal(preview.status,'blocked');assert.equal(preview.code,'BUSINESS_QUANTITY_PRECISION');assert.deepEqual(await f.counts(),before);
  });
  await t.test('a stale source is rejected before the binder consumes a new persisted identity',async()=>{
   const source=await f.prepare({unit_price:'10.1234567891'}),input=await f.input(source),begin=await f.begin(input);
   const content=resolveBusinessContent(begin.execution.inputs),xml=buildBoundBusinessXml(bindResolvedBusinessContent({content,receipt:begin.receipt}));assert.match(xml.unsignedXml,/<vUnCom>10\.1234567891/);
   await f.callSql('erp_document_transition',{p_user_id:f.users.admin,p_kind:'sales_orders',p_id:source.document.id,p_expected_version:source.document.version,p_command_id:randomUUID(),p_status:'open',p_reason:'Mudanca sintetica de fonte'});
   const after=await f.counts(),stale=await f.orchestrator().preview(f.previewInput(source));assert.equal(stale.status,'blocked');assert.equal(stale.code,'UNSIGNED_RPC_40001');assert.deepEqual(await f.counts(),after);
  });
 }finally{await f.close();}
});
