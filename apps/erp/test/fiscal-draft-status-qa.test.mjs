import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createFiscalDraftStatusQaFixture} from '../src/qa/fiscal-draft-status-fixture.ts';
import {parseFiscalDraftStatusPage} from '../../../packages/erp-domain/src/fiscal-draft-status-dto.mjs';
import {inspectBuildFile} from '../../../tools/qa/check-erp-build.mjs';
const BASE='/v1/rascunhos-fiscais/resumo';
test('082 QA uses the actual public parser for both models and never provides a mutation port',async()=>{
 const f=createFiscalDraftStatusQaFixture();assert.equal(parseFiscalDraftStatusPage(await f.controller.fiscalDraftStatus(BASE)).items.length,3);
 for(const model of ['55','65'])assert.ok(parseFiscalDraftStatusPage(await f.controller.fiscalDraftStatus(BASE+'?model='+model),{model}).items.every(r=>r.draft.model===model));
 for(const method of ['POST','PATCH','DELETE'])await assert.rejects(f.controller.fiscalDraftStatus(BASE,{method}));assert.deepEqual(f.counts,{get:3,rejected:3});
});
test('082 each isolated QA entry is rejected if accidentally included in a production artifact',async()=>{
 for(const file of ['../fiscal-draft-status-qa.html','../src/qa/fiscal-draft-status-main.tsx','../src/qa/fiscal-draft-status-fixture.ts'])assert.ok(inspectBuildFile(file,await readFile(new URL(file,import.meta.url))).failures.includes('qa_marker'));
});
