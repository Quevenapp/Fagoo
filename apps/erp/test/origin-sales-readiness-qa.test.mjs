import test from 'node:test';import assert from 'node:assert/strict';
import {createSalesReadinessQaFixture,salesReadinessQaDetail} from '../src/qa/sales-readiness-fixture.ts';
import {parseSalesReadinessPage,parseSalesReadinessDetail} from '../../../packages/erp-domain/src/origin-sales-readiness-dto.mjs';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {readFile} from 'node:fs/promises';
import {inspectBuildFile} from '../../../tools/qa/check-erp-build.mjs';
const BASE='/v1/vendas-origin-prontidao';
test('081 visual fixture uses the real parsers and rejects every mutation without network',async()=>{
 const f=createSalesReadinessQaFixture();assert.equal(parseSalesReadinessPage(await f.controller.salesReadiness(BASE+'?limit=25'),{limit:25,after:null}).items.length,2);
 for(const id of ['100000','100001'])assert.equal(parseSalesReadinessDetail(salesReadinessQaDetail(id),{sourceId:id}).can_import,false);
 for(const options of [{method:'POST'},{method:'PATCH'},{body:{}}])await assert.rejects(f.controller.salesReadiness(BASE+'/100000',options));assert.equal(f.counts.rejected,3);
 const a=new AbortController();a.abort();await assert.rejects(f.controller.salesReadiness(BASE,{signal:a.signal}));assert.equal(f.counts.list,1);
});
test('081 the visual fixture renders both actual detail states through the production component',async()=>{
 const f=createSalesReadinessQaFixture(),v=await mountComponent('OriginSalesReadiness.tsx',{controller:f.controller},{expandChildren:true});try{
  await v.click('Conferir venda 100000');assert.match(v.text(),/12,1234567891/);assert.match(v.text(),/Identificador zero, sem vínculo fiscal confirmado/);await v.click('Voltar à lista');await v.click('Conferir venda 100001');assert.match(v.text(),/Sem cadastro correspondente no FAGOO/);assert.match(v.text(),/Captura exata de preços ainda não registrada/);assert.deepEqual(f.counts,{list:1,detail:2,rejected:0});
 }finally{v.unmount();}
});
test('081 accidental packaging of any visual QA entry is rejected by the existing build scanner',async()=>{
 for(const file of ['../sales-readiness-qa.html','../src/qa/sales-readiness-main.tsx','../src/qa/sales-readiness-fixture.ts']){
  const bytes=await readFile(new URL(file,import.meta.url));assert.ok(inspectBuildFile(file,bytes).failures.includes('qa_marker'));
 }
});
