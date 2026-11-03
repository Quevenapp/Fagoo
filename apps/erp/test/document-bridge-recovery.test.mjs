import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
const id='10000000-0000-4000-8000-000000000001',warehouse='20000000-0000-4000-8000-000000000001';
const original={id,kind:'sales_orders',number:'1',version:3,status:'verified',date:'2026-10-16',warehouse_id:warehouse,totals:{total:'3.02'},installments:[{amount:'3.02',due_date:'2026-11-01'}]};
const changeCheck=async view=>{view.find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});await view.flush();};
const makeProps=controller=>({controller,record:original,writable:true,blocked:false,onChanged(){},onActive(){},onBusy(){},onDraft(){}});
for(const kind of ['finance','stock'])for(const refusal of [403,409])test(`${kind} document posting retains exact command after lost reply and later${refusal}; acknowledged replay retries GET only`,async()=>{
 const calls=[],accepted=[];let writes=0,readbacks=0,committed=false;
 const page={document:{...original,eligible:true,active_posting_id:null},document_id:id,document_version:3,active_posting:null,items:[],postings:[],has_more:false,next_cursor:null};
 const preview={document:page.document,document_id:id,document_version:3,kind:'sales_orders',number:'1',contact_name:'Contato sintético',direction:'receivable',total_cents:'302',category_name:null,plan_source:'document',preview_hash:'a'.repeat(64),installments:[{position:1,amount_cents:'302',due_on:'2026-11-01',method:null}],action:'post',occurred_on:'2026-10-16',reason:'Saída sintética',warehouse:{id:warehouse,name:'Depósito sintético'},positions:[],ignored:[]};
 const controller={getSnapshot:()=>({membership:{role:'admin'}}),finance:async()=>({items:[],has_more:false,next_cursor:null}),async documents(path,options){calls.push({path,...options});readbacks++;if(readbacks===1)throw new AccessError(503);return{document:{...original,version:4,effect_flags:{finance_active:true,stock_active:false}}};}};
 controller[kind==='finance'?'documentFinance':'documentStock']=async(path,options={})=>{
  calls.push({path,...options});if(path.endsWith('/preview'))return{preview};
  if(path.endsWith('/post')){writes++;if(writes===1){committed=true;throw new AccessError(503);}if(writes===2)throw new AccessError(refusal);return{document_id:id};}
  if(kind==='stock'&&committed){readbacks++;if(readbacks===1)throw new AccessError(503);return{...page,document:{...page.document,version:4}};}return page;
 };
 const props={...makeProps(controller),onChanged:value=>accepted.push(value)},view=await mountComponent(kind==='finance'?'DocumentFinance.tsx':'DocumentStock.tsx',props);
 try{
  if(kind==='stock')await view.change(view.find(n=>n.type==='input'&&n.props.maxLength===500).props.id,'Saída sintética');
  await view.click(kind==='finance'?'Conferir lançamento financeiro':'Conferir lançamento de estoque');await changeCheck(view);
  const commit=kind==='finance'?'Lançar contas confirmadas':'Lançar estoque confirmado',back=kind==='finance'?'Voltar à conferência':'Voltar aos dados';
  await view.click(commit);assert.equal(view.guard().busy,true);assert.equal(view.button(commit).disabled,true);assert.equal(view.button(back).disabled,true);
  // Handlers also defend the frozen operation, beyond disabled HTML controls.
  view.button(back).props.onClick();await view.flush();assert.ok(view.button(commit));
  if(kind==='finance'){view.button('Descartar conferência e plano financeiro').props.onClick();await view.flush();assert.ok(view.button(commit));}
  await view.click('Repetir a mesma confirmação');assert.equal(view.guard().busy,true);assert.equal(view.button(commit).disabled,true);assert.equal(accepted.length,0);
  await view.click('Repetir a mesma confirmação');assert.equal(writes,3);assert.equal(readbacks,1);assert.equal(view.guard().busy,true);
  await view.click('Consultar documento atualizado');assert.equal(writes,3);assert.equal(readbacks,2);assert.equal(accepted.length,1);assert.equal(view.guard().busy,false);
  const mutations=calls.filter(c=>c.path.endsWith('/post'));assert.equal(mutations.length,3);assert.deepEqual(mutations[0].body,mutations[1].body);assert.deepEqual(mutations[0].body,mutations[2].body);
 }finally{view.unmount();}
});
