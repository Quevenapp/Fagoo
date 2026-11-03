import test from 'node:test';
import assert from 'node:assert/strict';
import {checkedStoredFinancialImportBatch,checkedRecoveredFinancialImportBatch} from '../src/lib/financial-import-read.ts';
import {importCommand,importRequest,applyRequest,importPreview,importAck,importBatch,financialRow} from './fixtures/financial-import.mjs';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};

test('stored batch can reopen without local ACK, preserving historical values and paid/current changes',()=>{
 const a=importAck(),b=importBatch(a);Object.assign(b.current_titles[0],{version:8,description:'Descrição corrigida\nsegunda linha',due_on:'2100-12-31',status:'paid',settled_cents:'12345',balance_cents:'0'});
 const checked=checkedStoredFinancialImportBatch(b,importCommand);assert.equal(checked.batch.items[0].due_on,'2026-10-31');assert.equal(checked.current_titles[0].due_on,'2100-12-31');assert.equal(checked.current_titles[0].status,'paid');
 for(const change of [v=>v.bank_actions=true,v=>v.batch.id='40000000-0000-4000-8000-000000000001',v=>v.batch.total_cents='12346',v=>v.batch.items[0].source_reference='Origin AP 0001',v=>v.current_titles[0].contact_id='40000000-0000-4000-8000-000000000001',v=>v.current_titles[0].amount_cents='12346',v=>v.current_titles[0].balance_cents='1',v=>v.current_titles[0].due_on='2100-02-30',v=>v.batch.items.push(v.batch.items[0]),v=>v.secret='PRIVATE']){const bad=structuredClone(b);change(bad);assert.throws(()=>checkedStoredFinancialImportBatch(bad,importCommand));}
});
test('recovery GET binds exact local request and reviewed fields even without ACK',()=>{
 const body=applyRequest(importRequest()),preview=importPreview(body),ack=importAck(body,preview),batch=importBatch(ack);
 assert.equal(checkedRecoveredFinancialImportBatch(batch,body,preview,null).batch.id,importCommand);
 for(const change of [b=>b.batch.items[0].description='Different reviewed title',b=>b.batch.items[0].source_seen_at='2026-10-16T14:00:00Z',b=>b.batch.preview_hash='f'.repeat(64),b=>b.batch.items[0].category_id='40000000-0000-4000-8000-000000000001']){const bad=structuredClone(batch);change(bad);assert.throws(()=>checkedRecoveredFinancialImportBatch(bad,body,preview,null));}
 const changedTime=structuredClone(batch);changedTime.batch.created_at='2026-10-16T15:00:01Z';assert.throws(()=>checkedRecoveredFinancialImportBatch(changedTime,body,preview,ack));
 const many=importAck(applyRequest(importRequest(Array.from({length:25},(_,i)=>financialRow(String(i+1))))),importPreview(importRequest(Array.from({length:25},(_,i)=>financialRow(String(i+1)))),'999999999999999'));
 assert.equal(checkedStoredFinancialImportBatch(importBatch(many),importCommand).batch.total_cents,'24999999999999975');
});
test('read-only lookup validates UUID and performs GET only after explicit submit, including after reload',async()=>{
 const calls=[],b=importBatch();Object.assign(b.current_titles[0],{version:2,due_on:'2100-12-31',status:'paid',settled_cents:'12345',balance_cents:'0'});
 const controller={async financialImport(path,options){calls.push({path,options});return b;}},ui=await mountComponent('FinancialImportBatchLookup.tsx',{controller},{expandChildren:true});
 try{assert.equal(calls.length,0);await ui.change('financial-import-batch-id','bad');await ui.submit();assert.equal(calls.length,0);await ui.change('financial-import-batch-id',importCommand.toUpperCase());await ui.submit();assert.equal(calls.length,1);assert.equal(calls[0].path,`/v1/importacao-financeira-origin/batches/${importCommand}`);assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.body,undefined);assert.match(ui.text(),/31\/10\/2026/);assert.match(ui.text(),/31\/12\/2100/);assert.match(ui.text(),/Quitado · versão 2/);assert.match(ui.text(),/R\$ 0,00/);assert.match(ui.text(),/R\$ 123,45/);}finally{ui.unmount();}
});
test('lookup404/403/failure never offers writes and hides prior receipt; unmount ignores late result',async()=>{
 for(const status of [404,403,503]){let calls=0;const controller={async financialImport(){calls++;if(calls===1)return importBatch();throw new AccessError(status);}},ui=await mountComponent('FinancialImportBatchLookup.tsx',{controller},{expandChildren:true});try{await ui.change('financial-import-batch-id',importCommand);await ui.submit();assert.match(ui.text(),/Lote registrado/);await ui.submit();assert.doesNotMatch(ui.text(),/Lote registrado e situação atual consultada/);assert.equal(ui.nodes().filter(n=>n.type==='button').length,1);assert.equal(calls,2);}finally{ui.unmount();}}
 const gate=deferred(),calls=[],controller={async financialImport(path,options){calls.push({path,options});return gate.promise;}},ui=await mountComponent('FinancialImportBatchLookup.tsx',{controller},{expandChildren:true});await ui.change('financial-import-batch-id',importCommand);const staleSubmit=ui.nodes().find(n=>n.type==='form').props.onSubmit;await ui.submit();ui.unmount();assert.equal(calls[0].options.signal.aborted,true);await staleSubmit({preventDefault(){}});gate.resolve(importBatch());await new Promise(r=>setTimeout(r,5));assert.equal(calls.length,1);
});
