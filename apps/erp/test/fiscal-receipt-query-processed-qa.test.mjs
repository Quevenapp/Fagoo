import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {projectReceiptQueryPublic} from '../../../packages/fiscal-authorization/src/receipt-query-public-dto.mjs';
import {createReceiptQueryProcessedQa} from '../src/qa/receipt-query-processed-fixture.ts';
import {receiptQueryProcessedReference} from '../src/lib/fiscal-receipt-query-processed-model.ts';
import {checkedProcessedDocument,processedDocumentPath} from '../src/lib/fiscal-processed-document-model.ts';
import {inspectBuildFile} from '../../../tools/qa/check-erp-build.mjs';
const B='/v1/fiscal-authorization/reviewed';
test('local processed QA uses real synthetic100/150 XML/HTML and refuses every mutation and conflicted file',async()=>{
 for(const model of['55','65'])for(const conflict of[false,true]){const f=createReceiptQueryProcessedQa({model,conflict}),c=f.context(),id=c.history[0].command_id,r=await f.controller.fiscalReceiptQuery(`${B}/receipt-query-commands/${id}`),ref=receiptQueryProcessedReference(r);const input={authorization_command_id:f.reference.authorization_command_id,expected_attempt_id:f.reference.authorization_attempt_id,limit:25,before:null},history=await f.controller.fiscalReceiptQuery(`${B}/receipt-query-history`,{method:'POST',body:input});assert.equal(projectReceiptQueryPublic(history,{action:'receiptQueryHistory',input}).items.length,1);assert.equal(r.observation.protocol_cstat,model==='55'?'100':'150');assert.equal(Boolean(ref),!conflict);if(ref)for(const action of['xml','print']){const value=await f.controller.fiscalProcessedDocument(processedDocumentPath(ref,action));assert.equal((await checkedProcessedDocument(value,ref,action)).action,action);}else await assert.rejects(()=>f.controller.fiscalProcessedDocument(`/v1/fiscal-danfe/receipt-queries/${id}/print`));await assert.rejects(()=>f.controller.fiscalReceiptQuery(`${B}/receipt-query-commands/${id}/recover`,{method:'POST',body:{confirmed:true}}));assert.ok(f.calls.every(c=>!c.mutation));}
});
test('processed QA fixture and artifacts are excluded from a production build by marker; no network or storage adapter',async()=>{
 for(const file of['receipt-query-processed-fixture.ts','receipt-query-processed-artifacts.json']){const b=await readFile(new URL(`../src/qa/${file}`,import.meta.url));assert.ok(inspectBuildFile(file,b).failures.includes('qa_marker'));if(file.endsWith('.ts'))assert.doesNotMatch(b.toString(),/\bfetch\s*\(|localStorage|sessionStorage|PRIVATE_KEY/);}
});
