import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneDFixture,migrationSql,fails} from './helpers/stock-lane-d-fixture.mjs';
import {parseDocumentStockRoute,executeDocumentStockRoute} from '../src/document-stock.mjs';
import {parsePurchaseReceiptsRoute,executePurchaseReceiptsRoute} from '../src/purchase-receipts.mjs';
import {purchaseReceiptsResponse} from '../../../packages/erp-domain/src/purchase-receipts-dto.mjs';

// 224 on PGlite (published migrations up to 190, then 222-224) with synthetic data only: "Considerar estorno para o cálculo do saldo
// atual se houver balanço após o lançamento original" in the reversal by the document (018) and by the purchase receipt (090).
let f;
before(async()=>{f=await stockLaneDFixture({upto:3});});
after(()=>f?.close());
const day='2026-10-20';
const post=(path,body)=>new Request('https://erp.invalid'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const documentStock=async(path,body,user=f.users.estoque)=>executeDocumentStockRoute(await parseDocumentStockRoute(post(path,body)),{userId:user,rpc:f.rpc});
const receipts=async(path,body,user=f.users.estoque)=>executePurchaseReceiptsRoute(await parsePurchaseReceiptsRoute(post(path,body)),{userId:user,rpc:f.rpc});
const docVersion=id=>f.scalar('select version v from erp_documents.document where id=$1',[id]);
const option=value=>f.setPreferences('suprimentos-estoque',{'estoque.estorno_balanco':value});
const saleAndPost=async(product,warehouse,quantity)=>{
 const sale=await f.transition(await f.order('sales_orders',[f.item(product,quantity)],warehouse.id),'verified'),base=`/v1/documentos-estoque/sales_orders/${sale.id}`;
 const preview=(await documentStock(`${base}/preview`,{expected_document_version:sale.version,occurred_on:day,reason:'Venda sintética'})).preview;
 const posted=await documentStock(`${base}/post`,{expected_document_version:sale.version,occurred_on:day,reason:'Venda sintética',command_id:randomUUID(),preview_hash:preview.preview_hash,ignored_item_ids:[]});
 return{sale,base,posted};};
const reverseSale=async({sale,base,posted},command=randomUUID())=>{const version=await docVersion(sale.id);
 const preview=(await documentStock(`${base}/${posted.posting.id}/reverse-preview`,{expected_document_version:version,occurred_on:day,reason:'Estorno sintético',expected_posting_version:1})).preview;
 return{preview,result:await documentStock(`${base}/${posted.posting.id}/reverse`,{expected_document_version:version,occurred_on:day,reason:'Estorno sintético',expected_posting_version:1,command_id:command,preview_hash:preview.preview_hash})};};

test('224 guards: published bodies only, a second run is refused, internal helper not executable',async()=>{
 assert.equal(await f.scalar("select has_function_privilege('service_role','erp_stock.balance_kept(uuid,uuid,uuid)','EXECUTE') v"),false);
 await assert.rejects(f.db.exec(await migrationSql('202610200224_stock_document_reversal_balance.sql')),/stock_document_reversal_224_previous_definition_changed/);await f.db.exec('rollback');
});

test('224 option on (Origin default): the document reversal after a Balanço changes the balance as before',async()=>{
 const depot=await f.warehouse('Reversal on'),p=await f.product('Revertido ligado');await f.launch(p.id,depot.id,'receipt','10');
 const flow=await saleAndPost(p,depot,'2');await f.launch(p.id,depot.id,'balance','5');
 const {preview}=await reverseSale(flow);
 assert.equal(preview.positions[0].balance_kept,undefined);assert.equal(await f.balance(p.id,depot.id),'7.000000');
});

test('224 option off: a sales order reversal after a Balanço keeps the current balance (adjustment after it), replay keeps it',async()=>{
 await option(false);
 try{
  const depot=await f.warehouse('Reversal off'),p=await f.product('Revertido desligado'),q=await f.product('Sem balanço');
  await f.launch(p.id,depot.id,'receipt','10');await f.launch(q.id,depot.id,'receipt','10');
  const sale=await f.transition(await f.order('sales_orders',[f.item(p,'2'),f.item(q,'3')],depot.id),'verified'),base=`/v1/documentos-estoque/sales_orders/${sale.id}`;
  const pre=(await documentStock(`${base}/preview`,{expected_document_version:sale.version,occurred_on:day,reason:'Venda sintética'})).preview;
  const posted=await documentStock(`${base}/post`,{expected_document_version:sale.version,occurred_on:day,reason:'Venda sintética',command_id:randomUUID(),preview_hash:pre.preview_hash,ignored_item_ids:[]});
  await f.launch(p.id,depot.id,'balance','5');
  const command=randomUUID(),{preview,result}=await reverseSale({sale,base,posted},command);
  const kept=Object.fromEntries(preview.positions.map(row=>[row.product_id,row.balance_kept??false]));
  assert.deepEqual([kept[p.id],kept[q.id]],[true,false]);
  assert.equal(result.posting.state,'reversed');
  assert.deepEqual([await f.balance(p.id,depot.id),await f.balance(q.id,depot.id)],['5.000000','10.000000'],'p keeps the Balanço; q is reversed');
  const adjustment=await f.scalar("select count(*)::integer v from erp_stock.movement where kind='adjustment' and reason='Estorno anterior ao balanço: saldo atual mantido' and created_at>(select created_at from erp_stock.movement where id=$1)",[posted.movement.id]);
  assert.equal(adjustment,1);
  const version=await docVersion(sale.id);
  const replay=await documentStock(`${base}/${posted.posting.id}/reverse`,{expected_document_version:version-1,occurred_on:day,reason:'Estorno sintético',expected_posting_version:1,command_id:command,preview_hash:preview.preview_hash});
  assert.equal(replay.replayed,true);assert.equal(await f.balance(p.id,depot.id),'5.000000');
  // A Balanço that was itself reversed does not keep the balance.
  const depot2=await f.warehouse('Reversal balanço estornado'),r=await f.product('Balanço estornado');await f.launch(r.id,depot2.id,'receipt','10');
  const flow=await saleAndPost(r,depot2,'2');const counted=await f.launch(r.id,depot2.id,'balance','4');await f.reverse(counted.movement.id);
  const second=await reverseSale(flow);
  assert.equal(second.preview.positions[0].balance_kept,undefined);assert.equal(await f.balance(r.id,depot2.id),'10.000000');
 }finally{await option(true);}
});

test('224 option off: a purchase receipt reversal after a lower Balanço keeps it (adjustment before it), never below zero',async()=>{
 await option(false);
 try{
  const depot=await f.warehouse('Compra revertida'),p=await f.product('Comprado revertido');
  const order=await f.order('purchase_orders',[f.item(p,'5','2')],depot.id);
  const current=(await f.rpc('erp_purchase_receipts_get',{p_user_id:f.users.estoque,p_document_id:order.id,p_limit:1})).current;
  const items=current.items.map(i=>({item_id:i.item_id,quantity:i.remaining_quantity}));
  const base=`/v1/recebimentos-compras/${order.id}`,reason='Recebimento sintético';
  const preview=(await receipts(`${base}/preview`,{expected_document_version:order.version,occurred_on:day,reason,items})).preview;
  const received=await receipts(`${base}/receive`,{expected_document_version:order.version,occurred_on:day,reason,items,command_id:randomUUID(),preview_hash:preview.preview_hash,confirmed:true});
  assert.equal(await f.balance(p.id,depot.id),'5.000000');
  await f.launch(p.id,depot.id,'balance','1');
  const receipt=received.receipt.receipt.id,version=received.receipt.document_version;
  const reverse=(await receipts(`${base}/${receipt}/reverse-preview`,{expected_document_version:version,occurred_on:day,reason:'Estorno do recebimento'})).preview;
  // The conferência says the position keeps its balance (the arithmetic "Físico depois" would be -4).
  assert.deepEqual([reverse.positions[0].balance_kept,reverse.positions[0].physical_before,reverse.positions[0].physical_after],[true,'1.000000','-4.000000']);
  const reversed=await receipts(`${base}/${receipt}/reverse`,{expected_document_version:version,occurred_on:day,reason:'Estorno do recebimento',command_id:randomUUID(),preview_hash:reverse.preview_hash,confirmed:true});
  assert.equal(reversed.receipt.reversal.positions[0].balance_kept,true,'the stored reversal keeps the mark and passes the projection');
  assert.equal(await f.balance(p.id,depot.id),'1.000000','the Balanço stays; the reversal stays in the history');
  const history=purchaseReceiptsResponse(await f.rpc('erp_purchase_receipts_get',{p_user_id:f.users.estoque,p_document_id:order.id,p_limit:25,p_after:null,p_receipt_id:receipt}),{action:'get',args:{p_document_id:order.id,p_limit:25,p_after:null,p_receipt_id:receipt}});
  assert.equal(history.selected.reversal.positions[0].balance_kept,true,'Ver recebimento shows the stored mark');
  // With the option on, the same reversal would go below zero and is refused (negative stock not allowed).
  await option(true);
  const order2=await f.order('purchase_orders',[f.item(p,'5','2')],depot.id);
  const current2=(await f.rpc('erp_purchase_receipts_get',{p_user_id:f.users.estoque,p_document_id:order2.id,p_limit:1})).current;
  const items2=current2.items.map(i=>({item_id:i.item_id,quantity:i.remaining_quantity}));
  const p2=(await receipts(`/v1/recebimentos-compras/${order2.id}/preview`,{expected_document_version:order2.version,occurred_on:day,reason,items:items2})).preview;
  const r2=await receipts(`/v1/recebimentos-compras/${order2.id}/receive`,{expected_document_version:order2.version,occurred_on:day,reason,items:items2,command_id:randomUUID(),preview_hash:p2.preview_hash,confirmed:true});
  await f.launch(p.id,depot.id,'balance','2');
  await assert.rejects(receipts(`/v1/recebimentos-compras/${order2.id}/${r2.receipt.receipt.id}/reverse-preview`,{expected_document_version:r2.receipt.document_version,occurred_on:day,reason:'Estorno'}),error=>error.status===409);
 }finally{await option(true);}
});
