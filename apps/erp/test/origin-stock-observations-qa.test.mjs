import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {build} from 'esbuild';
import {createStockObservationsFixture,stockQaWarehouse} from '../src/qa/stock-observations-fixture.ts';
import {parseStockObservationsPage,parseStockObservationsDetail,stockObservationsListPath,stockObservationsDetailPath} from '../src/lib/origin-stock-observations-model.ts';
import {inspectBuildFile} from '../../../tools/qa/check-erp-build.mjs';
test('087 local synthetic fixture exercises real closed DTO for zero/absent/invalid and changed warehouse with GET only',async()=>{
 for(const warehouse of[stockQaWarehouse(),{...stockQaWarehouse(),source:null,source_state:'missing',record:{...stockQaWarehouse().record,active:false}}]){
  const f=createStockObservationsFixture({warehouse}),p=parseStockObservationsPage(await f.controller.stockObservations(stockObservationsListPath('007')),{warehouseSourceId:'007',limit:25,after:null});
  for(const row of p.items){const d=parseStockObservationsDetail(await f.controller.stockObservations(stockObservationsDetailPath('007',row.product_source_id)),{warehouseSourceId:'007',productSourceId:row.product_source_id});assert.equal(d.item.observation.state,row.observation.state);assert.equal(d.native_effects,false);}
  assert.equal(f.calls.length,5);assert.ok(f.calls.every(c=>c.method==='GET'&&!('body'in c)));await assert.rejects(()=>f.controller.stockObservations('/v1/estoque'));
 }
});
test('087 QA bundles actual component/styles, stays dev-local and fails deployment asset scanning',async()=>{
 const b=await build({entryPoints:['apps/erp/src/qa/stock-observations-main.tsx'],bundle:true,write:false,outdir:'/unused',platform:'browser',format:'esm',loader:{'.css':'css'},define:{'import.meta.env.DEV':'true'},logLevel:'silent'});
 assert.ok(b.outputFiles.some(f=>f.path.endsWith('.css')&&f.text.includes('stock-observations-actions')));assert.match(b.outputFiles.find(f=>f.path.endsWith('.js')).text,/QA_SYNTHETIC_STOCK_OBSERVATIONS/);
 for(const p of['../stock-observations-qa.html','../src/qa/stock-observations-main.tsx','../src/qa/stock-observations-fixture.ts'])assert.ok(inspectBuildFile(p,await readFile(new URL(p,import.meta.url))).failures.includes('qa_marker'));
 const main=await readFile(new URL('../src/qa/stock-observations-main.tsx',import.meta.url),'utf8');assert.match(main,/import\.meta\.env\.DEV/);assert.match(main,/127\.0\.0\.1/);
});
