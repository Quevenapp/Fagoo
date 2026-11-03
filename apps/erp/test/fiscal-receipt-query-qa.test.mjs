import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {build} from 'esbuild';
import {createReceiptQueryQa} from '../src/qa/receipt-query-fixture.ts';
import {receiptQueryContext,receiptQueryIntent,receiptQueryResult} from '../src/lib/fiscal-receipt-query-model.ts';
import {inspectBuildFile} from '../../../tools/qa/check-erp-build.mjs';
const B='/v1/fiscal-authorization/reviewed';
test('QA covers55/65, original versus079, disabled, conflict and lostACK without any remote port',async()=>{
 for(const model of ['55','65'])for(const scenario of ['pending','revalidation','disabled','authorized','conflict','lost-ack']){
  const f=createReceiptQueryQa({model,scenario}),raw=await f.controller.fiscalReceiptQuery(B+'/receipt-query-context',{method:'POST',body:{source_kind:f.reference.source_kind,source_command_id:f.reference.source_command_id,expected_attempt_id:f.reference.authorization_attempt_id}}),context=receiptQueryContext(raw,f.reference);assert.equal(context.source.model,model);
  if(scenario==='lost-ack'){const body=receiptQueryIntent(context,f.reference,'30000000-0000-4000-8000-000000000090',true);await assert.rejects(()=>f.controller.fiscalReceiptQuery(B+'/receipt-queries',{method:'POST',body}));const value=receiptQueryResult(await f.controller.fiscalReceiptQuery(B+'/receipt-query-commands/'+body.command_id),f.reference,body.command_id,{input:body});assert.equal(value.current.state,'authorized_homologation');}
  if(scenario==='conflict')assert.equal(context.resolution.protocol,null);await assert.rejects(()=>f.controller.fiscalReceiptQuery('/v1/fiscal-authorization/reviewed/run',{method:'POST',body:{}}));
 }
});
test('localQA uses actual panel and styles; entry/fixture/bundle are rejected by production scanner',async()=>{
 const output=await build({entryPoints:['apps/erp/src/qa/receipt-query-main.tsx'],bundle:true,write:false,outdir:'/unused',platform:'browser',format:'esm',loader:{'.css':'css'},define:{'import.meta.env.DEV':'true'},logLevel:'silent'});
 assert.ok(output.outputFiles.some(f=>f.path.endsWith('.css')&&f.text.includes('receipt-query-resolution')));assert.match(output.outputFiles.find(f=>f.path.endsWith('.js')).text,/QA_SYNTHETIC_RECEIPT_QUERY/);
 for(const p of ['../receipt-query-qa.html','../src/qa/receipt-query-main.tsx','../src/qa/receipt-query-fixture.ts'])assert.ok(inspectBuildFile(p,await readFile(new URL(p,import.meta.url))).failures.includes('qa_marker'));
 const main=await readFile(new URL('../src/qa/receipt-query-main.tsx',import.meta.url),'utf8');assert.match(main,/import\.meta\.env\.DEV/);assert.match(main,/127\.0\.0\.1/);const fixture=await readFile(new URL('../src/qa/receipt-query-fixture.ts',import.meta.url),'utf8');assert.doesNotMatch(fixture,/\bfetch\s*\(|localStorage|sessionStorage|PRIVATE_KEY/);
});
