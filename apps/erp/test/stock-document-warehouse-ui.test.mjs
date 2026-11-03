import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {createPurchaseReceiptsFixture} from '../src/qa/purchase-receipts-fixture.ts';
import {capturePurchaseReceiptsRequest} from '../src/lib/purchase-receipts-request.ts';

// 184: "Lançar estoque" of a purchase order without warehouse (Origin "Depósitos" / "Selecione o depósito") and the Depósito of the
// document stock conferência. Synthetic data only.
globalThis.document??={activeElement:null,getElementById:()=>null,addEventListener(){},removeEventListener(){},body:{classList:{add(){},remove(){}},append(){},style:{}}};
const W='1e646bfd-45dc-4ec1-b5c0-568a201e36fd',V='b7000000-0000-4000-8000-000000000002';
const options={scope:'stock_warehouse_options',data_mode:'erp_native',total:2,items:[{id:W,name:'Depósito sintético090',active:true,is_default:true,ignore_balance:false},{id:V,name:'Loja',active:true,is_default:false,ignore_balance:false}]};

test('184 purchase order without warehouse: Depósitos modal receives every pending item in the chosen warehouse, with Conferir resultado',async()=>{
 const s=createPurchaseReceiptsFixture({lostAck:true});s.current.document.warehouse_id=null;s.controller.stock=async path=>{if(path==='/v1/estoque/depositos/opcoes')return options;throw new Error(path);};
 let closed=null;
 const view=await mountComponent('PurchaseStockLaunch.tsx',{controller:s.controller,documentId:s.current.document.id,number:s.current.document.number,onClose:changed=>{closed=changed;}},{expandChildren:['Modal']});
 try{
  assert.equal(s.calls[0].path,`/v1/recebimentos-compras/${s.current.document.id}?limit=25`,'the same page size the DTO checks');
  assert.match(view.text(),/Depósitos · Pedido de compra nº 15/);assert.equal(view.input('purchase-launch-warehouse').props.value,W,'the depósito padrão');
  assert.match(view.text(),/Serão recebidos 1 item\(ns\) com a quantidade pendente, na data definida em Preferências › Suprimentos › Estoque/);
  await view.click('Lançar');
  const preview=s.calls.find(call=>call.path.endsWith('/preview')),receive=s.calls.filter(call=>call.path.endsWith('/receive'));
  assert.deepEqual([preview.body.warehouse_id,preview.body.items,preview.body.reason],[W,[{item_id:'79cce346-00b7-4d97-b9cf-5d06aa4c145b',quantity:'2.000001'}],'Lançamento de estoque do pedido de compra nº 15']);
  assert.equal(receive[0].body.warehouse_id,W);
  assert.match(view.text(),/Não foi possível confirmar o lançamento/);assert.equal(view.button('Cancelar').disabled,true,'an unknown result keeps the modal');
  await view.click('Conferir resultado');
  const again=s.calls.filter(call=>call.path.endsWith('/receive')).at(-1);assert.equal(again.body.command_id,receive[0].body.command_id,'the same command');
  assert.match(view.text(),/Estoque lançado no pedido de compra nº 15 em 17\/10\/2026\./);
  await view.click('Fechar');assert.equal(closed,true);
 }finally{view.unmount();}
 // An order with its own warehouse launches there (no warehouse_id is sent).
 const t=createPurchaseReceiptsFixture();t.controller.stock=async()=>options;
 const own=await mountComponent('PurchaseStockLaunch.tsx',{controller:t.controller,documentId:t.current.document.id,number:'15',onClose(){}},{expandChildren:['Modal']});
 try{assert.equal(own.input('purchase-launch-warehouse').disabled,true);await own.click('Lançar');assert.equal(Object.hasOwn(t.calls.find(call=>call.path.endsWith('/preview')).body,'warehouse_id'),false);}finally{own.unmount();}
 // 277 "Ao lançar estoque utilizar ... data entrada/saída": no date is asked; the preview goes without one and the server's day is confirmed.
 const u=createPurchaseReceiptsFixture({launchDay:'2026-10-15'});u.controller.stock=async()=>options;
 const dated=await mountComponent('PurchaseStockLaunch.tsx',{controller:u.controller,documentId:u.current.document.id,number:'15',onClose(){}},{expandChildren:['Modal']});
 try{await dated.click('Lançar');assert.equal(u.calls.find(call=>call.path.endsWith('/preview')).body.occurred_on,null);
  assert.equal(u.calls.find(call=>call.path.endsWith('/receive')).body.occurred_on,'2026-10-15');assert.match(dated.text(),/Estoque lançado no pedido de compra nº 15 em 15\/10\/2026\./);}finally{dated.unmount();}
 assert.throws(()=>capturePurchaseReceiptsRequest(`/v1/recebimentos-compras/${s.current.document.id}/preview`,{method:'POST',body:{expected_document_version:2,occurred_on:'2026-10-20',reason:'Recebimento',items:[{item_id:'79cce346-00b7-4d97-b9cf-5d06aa4c145b',quantity:'1'}],warehouse_id:'x'}}));
});

test('184 document stock conferência: Depósito of the document by default, another one sent with the preview and the post',async()=>{
 const D='c7000000-0000-4000-8000-000000000001',calls=[];
 const summary={id:D,kind:'sales_orders',number:'31',version:4,status:'verified',date:'2026-10-20',warehouse_id:null,eligible:true,active_posting_id:null};
 const preview=body=>({action:'post',document:summary,direction:'issue',occurred_on:body.occurred_on,reason:body.reason,warehouse:{id:body.warehouse_id,name:'Loja',version:1,active:true},
  positions:[{product_id:'d7000000-0000-4000-8000-000000000001',product_name:'Caneta',catalog_version:1,warehouse_id:body.warehouse_id,unit:'UN',quantity:'-1.000000',balance_before:'3.000000',balance_after:'2.000000',expected_version:2,sources:[]}],ignored:[],preview_hash:'b'.repeat(64)});
 const controller={getSnapshot:()=>({phase:'ready',membership:{role:'estoque',user_id:'e7000000-0000-4000-8000-000000000001'}}),
  async stock(path){if(path==='/v1/estoque/depositos/opcoes')return options;throw new Error(path);},
  async documentStock(path,request={}){calls.push({path,...request,body:request.body?structuredClone(request.body):undefined});
   if(path.endsWith('/preview'))return{preview:preview(request.body),data_mode:'erp_native'};
   if(path.endsWith('/post'))return new Promise(()=>{});
   return{document:summary,items:[],active_posting:null,postings:[],limit:25,has_more:false,next_cursor:null,data_mode:'erp_native'};}};
 const view=await mountComponent('DocumentStock.tsx',{controller,record:{id:D,kind:'sales_orders',version:4},blocked:false,onChanged(){},onActive(){},onBusy(){},onDraft(){}},{expandChildren:['StockDocumentWarehouse']});
 try{
  const select=view.find(n=>n.type==='select'&&String(n.props.id).endsWith('-warehouse'));
  assert.equal(select.props.value,W,'without a document warehouse the depósito padrão is proposed');
  assert.match(view.text(),/O documento não tem depósito: o lançamento usa o depósito escolhido\./);
  await view.change(select.props.id,V);
  await view.change(view.find(n=>n.type==='input'&&String(n.props.id).endsWith('-reason')).props.id,'Saída conferida');
  await view.click('Conferir lançamento de estoque');
  assert.equal(calls.find(call=>call.path.endsWith('/preview')).body.warehouse_id,V);
  assert.match(view.text(),/Depósito: Loja/);
  view.find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});await view.flush();
  await view.click('Lançar estoque confirmado');
  const sent=calls.find(call=>call.path.endsWith('/post')).body;assert.deepEqual([sent.warehouse_id,sent.preview_hash],[V,'b'.repeat(64)]);
 }finally{view.unmount();}
});

test('147/184 Notas fiscais de entrada: ⋮ Check-in de Recebimentos for native entry notes, after Gerar devolução',async()=>{
 const {SCREENS,rowActions}=await import('../src/lib/fiscal-invoice-list-model.ts');
 const base={origin:'brufap',id:'f7000000-0000-4000-8000-000000000001',version:1,number:12,series:1,issue_date:'2026-10-20',entry_date:null,name:'Fornecedor',document:null,state:'SP',nature:'Compra',status:1,status_raw:null,
  total:'10.00',total_known:true,environment:'2',issue_type:'T',access_key:null,xml_id:null,xml_hash:null,xml_size:null,protocol_present:false,event_count:0,orders:[]};
 const action=row=>rowActions(SCREENS.entrada,row,{writable:false}).find(item=>item.id==='checkin');
 assert.deepEqual([action(base).label,action(base).enabled],['Check-in de Recebimentos',true]);
 assert.equal(action({...base,origin:'origin'}).enabled,false);assert.equal(action({...base,status:3}).enabled,false);
 assert.equal(rowActions(SCREENS.nfe,base,{writable:true}).some(item=>item.id==='checkin'),false,'exit notes have no check-in');
 // Review: a profile that reads the notes but not the check-in (consulta) sees the action disabled with the reason.
 const denied=rowActions(SCREENS.entrada,base,{writable:false,checkin:false}).find(item=>item.id==='checkin');
 assert.deepEqual([denied.enabled,denied.reason],[false,'Seu perfil não inclui o Check-in de Recebimentos (administrador, estoque e fiscal).']);
 assert.equal(rowActions(SCREENS.entrada,base,{writable:false,checkin:true}).find(item=>item.id==='checkin').enabled,true);
});

test('184 review: an order with its own warehouse shows that warehouse even when the warehouse list answers first',async()=>{
 const t=createPurchaseReceiptsFixture();t.current.document.warehouse_id=V;t.controller.stock=async()=>options;
 // The order answers after the warehouse list.
 const read=t.controller.purchaseReceipts;t.controller.purchaseReceipts=async(...args)=>{await new Promise(resolve=>setTimeout(resolve,30));return read(...args);};
 const view=await mountComponent('PurchaseStockLaunch.tsx',{controller:t.controller,documentId:t.current.document.id,number:'15',onClose(){}},{expandChildren:['Modal']});
 try{
  await new Promise(resolve=>setTimeout(resolve,60));await view.flush();
  const select=view.input('purchase-launch-warehouse');
  assert.deepEqual([select.props.value,select.disabled],[V,true],'the order warehouse (Loja), not the depósito padrão');
  assert.match(view.text(),/O pedido já tem depósito; o estoque é lançado nele\./);
 }finally{view.unmount();}
});
