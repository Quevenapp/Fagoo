import test from 'node:test';import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {setup,result,history} from './helpers/fiscal-reviewed-authorization-fixtures.mjs';
import {original,context,revalidated} from './helpers/fiscal-revalidation-fixtures.mjs';
import {receiptQueryAuthorizationReference,receiptQueryRevalidationReference} from '../src/lib/fiscal-receipt-query-model.ts';
import {receiptQueryFixture} from './helpers/fiscal-receipt-query-fixtures.mjs';
const expandChildren=['FiscalStoredResponseRevalidation','FiscalReceiptQueries','ReceiptQueriesPanel'];
function fixture(model,kind,{lost=false}={}){
 const s=setup({model}),old=kind==='authorization'?result(s.candidate,{state:'receipt_pending'}):original(s.candidate),rev=kind==='revalidation'?revalidated(old,undefined,true,'receipt_pending'):null;
 const reference=rev?receiptQueryRevalidationReference(rev,s.candidate,old):receiptQueryAuthorizationReference(old,s.candidate);
 const q=receiptQueryFixture({model,kind,before(c){if(lost&&c.kind==='receiptQueryRun')throw new AccessError(503);}});q.source={...reference,source_binding_hash:'e'.repeat(64)};
 s.history=history(s.candidate,[old]);const read=s.controller.fiscalReviewedAuthorization;s.controller.fiscalReviewedAuthorization=(path,o)=>path.includes('/revalidation-context/')?Promise.resolve(context(old,rev)):read(path,o);s.controller.fiscalReceiptQuery=q.controller.fiscalReceiptQuery;
 return{s,q,old};
}
async function open(v,kind){await v.click('Consultar histórico da autorização revisada');if(kind==='revalidation'){await v.click('Conferir resposta armazenada da tentativa 2');await v.click('Ver processamento da resposta conferida');}else await v.click('Ver processamento da tentativa 2');}
test('55/65 × original103/revalidated103 opens contextual queries without mutation; dismiss releases parent',async()=>{
 for(const model of ['55','65'])for(const kind of ['authorization','revalidation']){const {s,q}=fixture(model,kind),busy=[],v=await mountComponent('FiscalReviewedAuthorization.tsx',{controller:s.controller,candidate:s.candidate,onBusy:x=>busy.push(x)},{expandChildren});try{
  await open(v,kind);assert.equal(q.calls.length,0);assert.equal(v.button('Consultar histórico da autorização revisada').disabled,true);await v.click('Atualizar condições da consulta');assert.equal(q.calls.length,1);assert.equal(q.calls[0].mutation,false);assert.match(v.text(),/Consultas de processamento/);
  await v.click('Fechar consultas de processamento');if(kind==='revalidation')await v.click('Fechar conferência da resposta');assert.equal(v.button('Consultar histórico da autorização revisada').disabled,false);assert.equal(busy.at(-1),false);assert.equal(s.calls.some(x=>['run','recover'].includes(x.kind)),false);
 }finally{v.unmount();}}
});
test('nested query consent and lost ACK guard parent; role restore recovers only the same query and then can close',async()=>{
 for(const kind of ['authorization','revalidation']){const {s,q}=fixture('55',kind,{lost:true}),busy=[],v=await mountComponent('FiscalReviewedAuthorization.tsx',{controller:s.controller,candidate:s.candidate,onBusy:x=>busy.push(x)},{expandChildren});try{
  await open(v,kind);const stale=v.button('Consultar histórico da autorização revisada');await v.click('Atualizar condições da consulta');v.find(n=>n.props['aria-label']==='Confirmo a consulta de processamento').props.onChange({target:{checked:true}});await v.flush();assert.equal(busy.at(-1),true);
  await v.click('Consultar processamento na SEFAZ');const id=q.calls.find(c=>c.kind==='receiptQueryRun').body.command_id,old=v.button('Consultar o mesmo comando');stale.props.onClick();await v.flush();assert.equal(s.calls.filter(x=>x.kind==='history').length,1);
  s.role='consulta';s.notify();await v.flush();old.props.onClick();await v.flush();assert.equal(q.calls.filter(c=>c.kind==='receiptQueryCommand').length,0);s.role='fiscal';s.notify();await v.flush();await v.click('Consultar o mesmo comando');assert.equal(q.calls.at(-1).path.endsWith(id),true);assert.equal(q.calls.filter(c=>c.kind==='receiptQueryRun').length,1);assert.equal(busy.at(-1),false);
  await v.click('Fechar consultas de processamento');if(kind==='revalidation')await v.click('Fechar conferência da resposta');assert.equal(v.button('Consultar histórico da autorização revisada').disabled,false);
 }finally{v.unmount();}}
});
