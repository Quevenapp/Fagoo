import test from 'node:test';import assert from 'node:assert/strict';
import {createPurchaseReadinessQaFixture,purchaseReadinessQaDetail} from '../src/qa/purchase-readiness-fixture.ts';
import {parsePurchaseReadinessPage,parsePurchaseReadinessDetail} from '../../../packages/erp-domain/src/origin-purchase-readiness-dto.mjs';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {readFile} from 'node:fs/promises';
import {inspectBuildFile} from '../../../tools/qa/check-erp-build.mjs';
const BASE='/v1/compras-origin-prontidao';
test('076 visual fixture uses the real parsers and rejects every mutation without network',async()=>{
 const f=createPurchaseReadinessQaFixture();assert.equal(parsePurchaseReadinessPage(await f.controller.purchaseReadiness(BASE+'?limit=25'),{limit:25,after:null}).items.length,2);
 for(const id of ['100000','100001'])assert.equal(parsePurchaseReadinessDetail(purchaseReadinessQaDetail(id),{sourceId:id}).can_import,false);
 for(const options of [{method:'POST'},{method:'PATCH'},{body:{}}])await assert.rejects(f.controller.purchaseReadiness(BASE+'/100000',options));assert.equal(f.counts.rejected,3);
 const a=new AbortController();a.abort();await assert.rejects(f.controller.purchaseReadiness(BASE,{signal:a.signal}));assert.equal(f.counts.list,1);
});
test('076 the visual fixture renders both actual detail states through the production component',async()=>{
 const f=createPurchaseReadinessQaFixture(),v=await mountComponent('OriginPurchaseReadiness.tsx',{controller:f.controller},{expandChildren:true});try{
  await v.click('Conferir compra 100000');assert.match(v.text(),/12,1234567891/);assert.match(v.text(),/Identificador zero, sem vínculo fiscal confirmado/);await v.click('Voltar à lista');await v.click('Conferir compra 100001');assert.match(v.text(),/Sem cadastro correspondente no FAGOO/);assert.match(v.text(),/Captura exata de preços ainda não registrada/);assert.deepEqual(f.counts,{list:1,detail:2,rejected:0});
 }finally{v.unmount();}
});
test('076 accidental packaging of any visual QA entry is rejected by the existing build scanner',async()=>{
 for(const file of ['../purchase-readiness-qa.html','../src/qa/purchase-readiness-main.tsx','../src/qa/purchase-readiness-fixture.ts']){
  const bytes=await readFile(new URL(file,import.meta.url));assert.ok(inspectBuildFile(file,bytes).failures.includes('qa_marker'));
 }
});
