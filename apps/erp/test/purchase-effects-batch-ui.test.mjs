import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {createPurchaseReceiptsFixture} from '../src/qa/purchase-receipts-fixture.ts';
import {purchaseEffectSkip} from '../src/lib/purchase-effects-batch-model.ts';

// EST-024 (estoque, onda F): Lançar estoque, Estornar estoque, Lançar contas and Estornar contas of the selected pedidos de compra,
// one pedido at a time with its own command. Synthetic data only.
globalThis.document??={activeElement:null,getElementById:()=>null,addEventListener(){},removeEventListener(){},body:{classList:{add(){},remove(){}},append(){},style:{}}};
const W='1e646bfd-45dc-4ec1-b5c0-568a201e36fd';
const options={scope:'stock_warehouse_options',data_mode:'erp_native',total:1,items:[{id:W,name:'Depósito sintético090',active:true,is_default:true,ignore_balance:false}]};
const row=(patch={})=>({id:'b7000000-0000-4000-8000-0000000000a1',kind:'purchase_orders',number:'15',status:'in_progress',version:2,date:'2026-10-15',contact_name:'Fornecedor sintético',total:'10.00',
 expected_date:null,next_contact:null,template:false,warehouse_id:W,warehouse_name:'Depósito sintético090',source_proposal_id:null,source_proposal_number:null,finance_active:false,stock_active:false,
 receipt_active:false,reservation_active:null,fiscal_draft:null,internal_notes:null,...patch});

test('EST-024 skip reasons follow the pedido before anything runs',()=>{
 assert.equal(purchaseEffectSkip('stock-post',row()),null);
 assert.match(purchaseEffectSkip('stock-post',row({status:'open'})),/A situação do pedido não permite lançar o estoque/);
 assert.match(purchaseEffectSkip('stock-post',row({stock_active:true})),/documento inteiro/);
 assert.match(purchaseEffectSkip('stock-reverse',row()),/Não há estoque lançado/);assert.equal(purchaseEffectSkip('stock-reverse',row({receipt_active:true})),null);
 // The batch reverses recebimentos (225); a pedido posted as a whole (018) has no recebimento and is reversed by its own ⋮.
 assert.match(purchaseEffectSkip('stock-reverse',row({stock_active:true})),/documento inteiro; use Estornar estoque do próprio pedido/);
 assert.match(purchaseEffectSkip('finance-post',row({finance_active:true})),/já foram lançadas/);assert.equal(purchaseEffectSkip('finance-post',row({status:'open'})),null);
 assert.match(purchaseEffectSkip('finance-reverse',row()),/Não há contas lançadas/);
});

test('EST-024 Lançar estoque of the selected: one recebimento per pedido, skipped rows with the reason, Tentar novamente repeats the same command',async()=>{
 const s=createPurchaseReceiptsFixture({lostAck:true,launchDay:'2026-10-16'});s.controller.stock=async()=>options;
 const eligible=row({id:s.current.document.id,number:s.current.document.number}),skipped=row({id:'b7000000-0000-4000-8000-0000000000b2',number:'16',status:'open'});
 let closed=null;
 const view=await mountComponent('PurchaseEffectsBatch.tsx',{controller:s.controller,action:'stock-post',rows:[eligible,skipped],onClose:changed=>{closed=changed;}},{expandChildren:['BatchDialog','Modal']});
 try{
  assert.match(view.text(),/Lançar estoque dos pedidos selecionados/);assert.match(view.text(),/1 registro será processado/);
  assert.match(view.text(),/A situação do pedido não permite lançar o estoque/);
  await view.click('Lançar estoque');await new Promise(r=>setTimeout(r,20));await view.flush();
  const previews=s.calls.filter(c=>c.path.endsWith('/preview')),receives=s.calls.filter(c=>c.path.endsWith('/receive'));
  assert.equal(previews[0].body.occurred_on,null,'the server dates the recebimento');assert.equal(receives.length,1);
  assert.match(view.text(),/Resultado não confirmado: use “Tentar novamente”/);
  await view.click('Tentar novamente');await view.flush();
  await view.click('Lançar estoque');await new Promise(r=>setTimeout(r,20));await view.flush();
  const again=s.calls.filter(c=>c.path.endsWith('/receive'));
  assert.equal(again.length,2);assert.equal(again[1].body.command_id,again[0].body.command_id,'the same command, never a new recebimento');
  assert.equal(s.calls.filter(c=>c.path.endsWith('/preview')).length,1,'no new preview for the stored command');
  assert.match(view.text(),/1 concluído/);
  await view.click('Fechar');assert.equal(closed,true);
 }finally{view.unmount();}
});

test('EST-024 Estornar estoque, Lançar contas and Estornar contas run through the routes of the ⋮ actions',async()=>{
 const D='b7000000-0000-4000-8000-0000000000c3',P='b7000000-0000-4000-8000-0000000000d4',calls=[];
 const record={id:D,kind:'purchase_orders',number:'17',version:5,installments:[{due_date:'2026-11-15',amount:'10.00'}],totals:{total:'10.00'},date:'2026-10-15'};
 const controller={getSnapshot:()=>({phase:'ready',membership:{role:'admin',user_id:'e7000000-0000-4000-8000-000000000001'}}),
  async stock(path,o={}){calls.push({via:'stock',path,...o});if(path==='/v1/estoque/depositos/opcoes')return options;if(path.endsWith('/estorno'))return{document_id:D,reversed:['x']};throw new Error(path);},
  async documents(path){calls.push({via:'documents',path});return{document:structuredClone(record)};},
  async documentFinance(path,o={}){calls.push({via:'finance',path,...o,body:o.body?structuredClone(o.body):undefined});
   if(path.endsWith('/financeiro/preview'))return{preview:{document_id:D,document_version:5,preview_hash:'a'.repeat(64)}};
   if(path.endsWith('/financeiro/post'))return{posting:{}};
   if(path.endsWith('/financeiro?limit=25'))return{document_id:D,document_version:5,active_posting:{id:P,version:1},items:[],has_more:false,next_cursor:null};
   if(path.endsWith(`/financeiro/${P}`))return{document_id:D,document_version:5,posting:{id:P,version:1,state:'active'},titles:[]};
   if(path.endsWith('/reverse-preview'))return{preview:{document_id:D,document_version:5,posting:{id:P,version:1,state:'active'},titles:[{id:'t1',version:2,settled_cents:'0',cnab_linked:false}],preview_hash:'b'.repeat(64)}};
   if(path.endsWith('/reverse'))throw new AccessError(409);
   throw new Error(path);}};
 const run=async(action,patch,label)=>{const view=await mountComponent('PurchaseEffectsBatch.tsx',{controller,action,rows:[row({id:D,number:'17',version:5,...patch})],onClose(){}},{expandChildren:['BatchDialog','Modal']});
  try{await view.click(label);await new Promise(r=>setTimeout(r,20));await view.flush();return view.text();}finally{view.unmount();}};
 assert.match(await run('stock-reverse',{receipt_active:true},'Estornar estoque'),/1 concluído/);
 assert.deepEqual(calls.find(c=>c.path.endsWith('/estorno')).body.expected_version,5);
 assert.match(await run('finance-post',{},'Lançar contas'),/1 concluído/);
 const post=calls.find(c=>c.path.endsWith('/financeiro/post'));
 assert.deepEqual([post.body.category_id,post.body.installments,post.body.preview_hash],[null,null,'a'.repeat(64)],'the category and the parcelas of the pedido');
 const text=await run('finance-reverse',{finance_active:true},'Estornar contas');
 assert.match(text,/O pedido mudou em outra operação/);assert.match(text,/com falha/);
 assert.equal(calls.find(c=>c.path.endsWith('/reverse')).body.reason,'Estorno das contas do pedido de compra nº 17');
});
