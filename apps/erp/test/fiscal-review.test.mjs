import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFiscalReview,FISCAL_REVIEW_LABELS as coreLabels} from '../../../packages/fiscal-core/src/review.mjs';
import {reviewBasis,reviewIds} from '../../../packages/fiscal-core/test/review-fixtures.mjs';
import {fiscalReviewPath,fiscalReviewView,FISCAL_REVIEW_LABELS} from '../src/lib/fiscal-review-model.ts';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
const props=controller=>({controller,draftId:reviewIds.draft,revision:1,snapshotHash:'a'.repeat(64)});
const response=()=>buildFiscalReview(reviewBasis());
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
test('review model binds draft/revision/snapshot hash and rejects readiness claims or missing findings',()=>{
 const report=response();assert.deepEqual(fiscalReviewView(report,reviewIds.draft,1,'a'.repeat(64)),report);
 for(const mutate of[v=>v.can_emit=true,v=>v.xsd_validated=true,v=>v.report.findings=[],v=>v.report.summary.review=0]){
  const bad=response();mutate(bad);assert.throws(()=>fiscalReviewView(bad,reviewIds.draft,1,'a'.repeat(64)));
 }
 assert.throws(()=>fiscalReviewView(report,reviewIds.draft,1,'b'.repeat(64)));assert.throws(()=>fiscalReviewPath(reviewIds.draft,0));
});
test('read-only UI qualifies historical findings and separates unobserved preparations without writing or defaulting',async()=>{
 const calls=[];const controller={async fiscalDraft(path,options){calls.push({path,options});return response();}};
 const view=await mountComponent('FiscalDraftReview.tsx',props(controller));
 try{
  assert.equal(calls.length,1);assert.equal(calls[0].path,fiscalReviewPath(reviewIds.draft,1));assert.equal(calls[0].options.method,undefined);assert.equal(calls[0].options.body,undefined);
  assert.match(view.text(),/Conferência fiscal da cópia inicial/);assert.match(view.text(),/não habilita emissão/);assert.match(view.text(),/A origem não integra a cópia inicial/);
  assert.match(view.text(),/1,23 UN/);assert.doesNotMatch(view.text(),/pl010f|snapshot|Representação sem perda/);assert.match(view.text(),/NCM atual00000000/);assert.match(view.text(),/Origem atual0/);
  assert.doesNotMatch(view.text(),/Emitir nota|Autorizar emissão|Pronto para emitir/);
  await view.click('Repetir conferência');assert.equal(calls.length,2);
 }finally{view.unmount();}
});
test('029 presentation preserves diagnostic codes and report but makes no current XML, certificate or preparation-state claims',async()=>{
 const report=response(),original=structuredClone(report),calls=[];
 // Unrelated current-module hints are deliberately not consumed by this report.
 const controller={async fiscalDraft(path,options){calls.push({path,options});return{...report,item_preparation:{saved:true},tax_preparation:{saved:true},business_completion:{saved:true},artifact:{state:'stored'},certificate:{state:'configured_offline'}};}};
 const view=await mountComponent('FiscalDraftReview.tsx',props(controller));
 try{
  assert.deepEqual(Object.keys(FISCAL_REVIEW_LABELS).sort(),Object.keys(coreLabels).sort());assert.deepEqual(report,original);
  assert.match(view.text(),/Não consulta as preparações de itens, tributária ou complemento fiscal, nem o XML gerado ou o certificado/);
  assert.match(view.text(),/não são pendências atuais desses módulos/);
  assert.match(view.text(),/A geração de XML, a validação XSD e a assinatura não são consultadas/);
  assert.match(view.text(),/não consulta o certificado\/cofre/);
  assert.doesNotMatch(view.text(),/ainda não foram realizadas|permanecem dependências|Etapa fiscal pendente|Origem, CEST e GTIN tributário ainda não|nenhum tributo foi calculado/);
  assert.doesNotMatch(view.text(),/configured_offline|state.*stored|Certificado disponível|XML já gerado/);
  const observed=report.report.findings.filter(f=>f.source!=='pipeline');
  assert.match(view.text(),new RegExp(`${observed.filter(f=>f.severity==='blocking').length} limites ou ausências na cópia inicial`));
  assert.match(view.text(),new RegExp(`${observed.filter(f=>f.severity==='review').length} comparações e verificações desta cópia`));
  assert.equal(calls.length,1);assert.equal(calls[0].options.method,undefined);
 }finally{view.unmount();}
});
test('changing revision aborts old reads and cannot display a late response from the previous revision',async()=>{
 const late=deferred(),calls=[];const controller={async fiscalDraft(path,options){calls.push({path,options});if(calls.length===1)return late.promise;throw new AccessError(403);}};
 const view=await mountComponent('FiscalDraftReview.tsx',props(controller));
 try{
  await view.updateProps({revision:2});assert.equal(calls[0].options.signal.aborted,true);assert.match(view.text(),/acesso à conferência fiscal não está disponível/);
  late.resolve(response());await view.flush();assert.doesNotMatch(view.text(),/NCM atual|Produto sintético|Representação sem perda/);
 }finally{view.unmount();}
});
test('a failed new read clears old findings; retry and unmount keep read-only request cancellation',async()=>{
 let count=0;const calls=[];const controller={async fiscalDraft(path,options){calls.push({path,options});if(++count===2)throw new AccessError(503);return response();}};
 const view=await mountComponent('FiscalDraftReview.tsx',props(controller));
 try{
  await view.click('Repetir conferência');assert.match(view.text(),/Não foi possível consultar/);assert.doesNotMatch(view.text(),/Produto sintético|NCM atual/);
  await view.click('Tentar novamente');assert.match(view.text(),/Produto sintético/);assert.equal(count,3);
 }finally{view.unmount();assert.equal(calls.at(-1).options.signal.aborted,true);}
});
test('the item table pages locally through the exact revision without issuing new requests or losing findings',async()=>{
 let reads=0;const controller={async fiscalDraft(){reads++;return buildFiscalReview(reviewBasis({itemCount:26}));}};
 const view=await mountComponent('FiscalDraftReview.tsx',props(controller));
 try{
  assert.match(view.text(),/Página 1 · 26 itens/);assert.doesNotMatch(view.text(),/26\. Produto sintético/);
  await view.click('Próximos itens');assert.match(view.text(),/Página 2 · 26 itens/);assert.match(view.text(),/26\. Produto sintético/);
  assert.doesNotMatch(view.text(),/25\. Produto sintético/);assert.equal(reads,1);
  await view.click('Itens anteriores');assert.match(view.text(),/Página 1 · 26 itens/);assert.equal(reads,1);
 }finally{view.unmount();}
});
