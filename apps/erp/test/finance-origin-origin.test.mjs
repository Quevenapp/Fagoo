import test from 'node:test';
import assert from 'node:assert/strict';
import {financeOriginOrigin} from '../src/lib/finance-origin-origin.ts';
import {mountComponent, AccessError} from './helpers/component-recovery-harness.mjs';
globalThis.document = {activeElement:null};
const id='10000000-0000-4000-8000-000000000001', other='10000000-0000-4000-8000-000000000002';
const title={id,kind:'receivable',version:1,group_id:id,installment:1,installments:1,contact_id:other,contact_name:'Contato sintético',category_id:null,category_name:null,description:'Título sintético',source_reference:'0000123',issued_on:'2026-10-01',due_on:'2026-10-20',amount_cents:'101',settled_cents:'0',balance_cents:'101',cancelled:false,status:'open',overdue:false,document_linked:false};
const envelope=(origin=true,titleId=id)=>({data_mode:'erp_native',read_only:true,title_id:titleId,origin:origin?{system:'origin',entity:'receivables',source_id:'000000123',batch_id:other,imported_at:'2026-10-16T09:00:00.123456+00:00',source_hash:'a'.repeat(64),source_version:'9007199254740993',core_fields_locked:true,cnab_reservation_blocked:true}:null});
const field=(ui,label)=>ui.input(ui.find(n=>n.type==='label'&&n.props.children===label).props.htmlFor);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('039 provenance binds exact title and direction, preserves large versions and strips excess data',()=>{
 const source=envelope();source.origin.raw_payload={secret:'never project'};
 const value=financeOriginOrigin(source,id,'receivable');assert.equal(value.source_id,'000000123');assert.equal(value.source_version,'9007199254740993');assert.equal(Object.hasOwn(value,'raw_payload'),false);
 assert.equal(financeOriginOrigin(envelope(false),id,'receivable'),null);
 for(const mutate of[v=>v.title_id=other,v=>v.origin.entity='payables',v=>v.read_only=false,v=>v.origin.core_fields_locked=false,v=>v.origin.cnab_reservation_blocked=false,v=>v.origin.source_version=9007199254740993,v=>v.origin.source_version='9223372036854775808',v=>v.origin.source_id='0',v=>v.origin.imported_at='invalid',v=>delete v.origin]){const v=envelope();mutate(v);assert.throws(()=>financeOriginOrigin(v,id,'receivable'));}
});
async function editor(controller){return mountComponent('RealFinance.tsx',{controller,mode:'title_update',record:title,kind:'receivable',onClose(){},onSaved(){}},{componentName:'FinanceEditor',expandChildren:['Field','Confirmation','TitleOriginNotice']});}
test('039 imported title editor preserves core fields even if a queued field handler changes their local values',async()=>{
 const writes=[],controller={async financialImportOrigin(){return envelope();},async finance(path,options){writes.push({path,...options});return{record:title};}},ui=await editor(controller);
 try{assert.match(ui.text(),/Importado do Origin/);assert.equal(field(ui,'Valor (R$) *').props.readOnly,true);assert.equal(field(ui,'Referência / documento').props.readOnly,true);
  await ui.change(field(ui,'Valor (R$) *').props.id,'999,99');await ui.change(field(ui,'Referência / documento').props.id,'alterada');await ui.change(field(ui,'Histórico *').props.id,'Descrição revisada');await ui.submit();await ui.click('Salvar título');
  assert.equal(writes.length,1);assert.equal(writes[0].body.data.source_reference,'0000123');assert.equal(Object.hasOwn(writes[0].body.data,'amount_cents'),false);assert.equal(writes[0].body.data.description,'Descrição revisada');
 }finally{ui.unmount();}
});
test('039 origin failure never falls back to an editable unlinked title; retry resolves without losing description',async()=>{
 let reads=0;const writes=[],controller={async financialImportOrigin(){if(++reads===1)throw new AccessError(503);return envelope(false);},async finance(path,options){writes.push({path,...options});return{record:title};}},ui=await editor(controller);
 try{assert.equal(ui.button('Salvar').disabled,true);await ui.change(field(ui,'Histórico *').props.id,'Preservada');await ui.submit();assert.equal(writes.length,0);assert.equal(ui.nodes().filter(n=>n.type==='dialog').length,0);
  await ui.click('Conferir origem novamente');assert.equal(field(ui,'Histórico *').props.value,'Preservada');assert.equal(ui.button('Salvar').disabled,false);assert.equal(field(ui,'Valor (R$) *').props.readOnly,false);
  await ui.change(field(ui,'Valor (R$) *').props.id,'2,01');await ui.submit();await ui.click('Salvar título');assert.equal(writes[0].body.data.amount_cents,'201');
 }finally{ui.unmount();}
});
test('039 late provenance cannot unlock a newly opened title and old edit handlers check current readiness',async()=>{
 const late=deferred(),calls=[],edits=[];const controller={async financialImportOrigin(path,options){calls.push({path,...options});return calls.length===1?envelope(false):late.promise;}};
 const ui=await mountComponent('RealFinance.tsx',{controller,entity:'titles',record:title,writable:true,onClose(){},onEdit:mode=>edits.push(mode)},{componentName:'FinanceDetail',expandChildren:['TitleOriginNotice']});
 try{const stale=ui.button('Editar título').props.onClick;await ui.updateProps({record:{...title,id:other}});assert.equal(calls[0].signal.aborted,true);assert.equal(ui.button('Editar título').disabled,true);stale();assert.equal(edits.length,0);
  late.resolve(envelope(true,other));await ui.flush();assert.equal(ui.button('Editar título').disabled,false);assert.match(ui.text(),/Importado do Origin/);
 }finally{ui.unmount();}
});
test('039 an aborted late imported origin cannot relabel a newer native title',async()=>{
 const late=deferred(),calls=[];const controller={async financialImportOrigin(path,options){calls.push({path,...options});return calls.length===1?late.promise:envelope(false,other);}};
 const ui=await mountComponent('RealFinance.tsx',{controller,entity:'titles',record:title,writable:true,onClose(){},onEdit(){}},{componentName:'FinanceDetail',expandChildren:['TitleOriginNotice']});
 try{
  assert.equal(ui.button('Editar título').disabled,true);
  await ui.updateProps({record:{...title,id:other,description:'Outro título nativo'}});
  assert.equal(calls[0].signal.aborted,true);
  assert.equal(ui.button('Editar título').disabled,false);
  late.resolve(envelope());await ui.flush();
  assert.doesNotMatch(ui.text(),/Importado do Origin|000000123/);
  assert.match(ui.text(),/Outro título nativo/);
  assert.equal(ui.button('Editar título').disabled,false);
 }finally{ui.unmount();}
});
test('039 failed provenance blocks core editing without blocking unrelated explicit cancellation review',async()=>{
 const writes=[];const controller={async financialImportOrigin(){throw new AccessError(503);},async finance(path,options){writes.push({path,...options});return{record:title};}};
 const ui=await mountComponent('RealFinance.tsx',{controller,mode:'title_cancel',record:title,kind:'receivable',onClose(){},onSaved(){}},{componentName:'FinanceEditor',expandChildren:['Field','Confirmation','TitleOriginNotice']});
 try{
  assert.match(ui.text(),/Não foi possível conferir a origem/);
  assert.equal(ui.button('Conferir operação').disabled,false);
  await ui.change(field(ui,'Justificativa *').props.id,'Conferência exclusivamente sintética');
  await ui.submit();
  assert.equal(ui.nodes().filter(n=>n.type==='dialog').length,1);
  assert.equal(writes.length,0);
 }finally{ui.unmount();}
});
