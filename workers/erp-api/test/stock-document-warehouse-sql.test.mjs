import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneCFixture,migrationSql,fails} from './helpers/stock-lane-c-fixture.mjs';
import {parseDocumentStockRoute,executeDocumentStockRoute} from '../src/document-stock.mjs';
import {parsePurchaseReceiptsRoute,executePurchaseReceiptsRoute} from '../src/purchase-receipts.mjs';

// 184 on PGlite (every published migration up to 152, then 181-184) with synthetic data only: the warehouse chosen when the stock of a
// document without warehouse is launched (018 postings and 090 receipts), the document unchanged and the reversal by the posting's warehouse.
let f;
before(async()=>{f=await stockLaneCFixture({upto:4});});
after(()=>f?.close());
const post=(path,body)=>new Request('https://erp.invalid'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const documentStock=async(path,body,user=f.users.estoque)=>executeDocumentStockRoute(await parseDocumentStockRoute(post(path,body)),{userId:user,rpc:f.rpc});
const receipts=async(path,body,user=f.users.estoque)=>executePurchaseReceiptsRoute(await parsePurchaseReceiptsRoute(post(path,body)),{userId:user,rpc:f.rpc});
const withoutWarehouse=async(kind,items,statuses)=>{let d=(await f.rpc('erp_document_save',{p_user_id:f.users.admin,p_kind:kind,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-15',contact_id:f.contact.id,items}})).document;
 for(const s of statuses)d=await f.transition(d,s);return d;};

test('184 entry points are SECURITY DEFINER for service_role only; the guard refuses a second run',async()=>{
 for(const signature of['public.erp_stock_document_warehouse_preview(uuid,text,uuid,integer,uuid,date,text)','public.erp_stock_document_warehouse_post(uuid,text,uuid,integer,uuid,uuid,text,date,text,jsonb)',
  'public.erp_stock_purchase_receive_preview(uuid,uuid,integer,uuid,date,text,jsonb)','public.erp_stock_purchase_receive(uuid,uuid,integer,uuid,date,text,jsonb,uuid,text,boolean)',
  'public.erp_purchase_receipts_reverse_preview(uuid,uuid,integer,uuid,date,text)']){
  for(const role of['anon','authenticated','public'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,[signature]),false,signature);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",[signature]),true,signature);
  assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure',[signature]),true,signature);
 }
 for(const internal of['erp_purchase_receipts.apply_warehouse(uuid,uuid,integer,text,date,text,jsonb,uuid,uuid,text,boolean,uuid)','erp_purchase_receipts.apply(uuid,uuid,integer,text,date,text,jsonb,uuid,uuid,text,boolean)'])
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",[internal]),false,internal);
 await assert.rejects(f.db.exec(await migrationSql('202610200184_stock_document_warehouse.sql')),/stock_document_warehouse_184_previous_definition_changed/);await f.db.exec('rollback');
});

test('184 sales order without warehouse: the chosen warehouse in preview and post, the same command, the document unchanged and the reversal',async()=>{
 const w=await f.warehouse('Depósito escolhido venda'),p=await f.product('Vendido sem depósito');await f.launch(p.id,w.id,'receipt','10');
 const sale=await withoutWarehouse('sales_orders',[f.item(p,'3','9')],['verified']);
 const base=`/v1/documentos-estoque/sales_orders/${sale.id}`,day='2026-10-20',reason='Saída do pedido';
 await assert.rejects(documentStock(`${base}/preview`,{expected_document_version:sale.version,occurred_on:day,reason}),fails('22023'),'without a warehouse the published preview refuses');
 const preview=(await documentStock(`${base}/preview`,{expected_document_version:sale.version,occurred_on:day,reason,warehouse_id:w.id})).preview;
 assert.deepEqual([preview.warehouse.id,preview.positions[0].warehouse_id,preview.positions[0].balance_after,preview.document.warehouse_id],[w.id,w.id,'7.000000',null]);
 const command=randomUUID(),body={expected_document_version:sale.version,occurred_on:day,reason,warehouse_id:w.id,command_id:command,preview_hash:preview.preview_hash,ignored_item_ids:[]};
 const result=await documentStock(`${base}/post`,body);
 assert.deepEqual([result.replayed,result.movement.items[0].warehouse_id,await f.balance(p.id,w.id)],[false,w.id,'7.000000']);
 assert.equal(await f.scalar('select warehouse_id v from erp_documents.document where id=$1',[sale.id]),null,'the document keeps its own (empty) warehouse');
 const again=await documentStock(`${base}/post`,body);assert.deepEqual([again.replayed,again.posting.id],[true,result.posting.id]);
 const other=await f.warehouse('Outro depósito venda');
 await assert.rejects(f.rpc('erp_stock_document_warehouse_post',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:sale.id,p_expected_version:sale.version,p_warehouse_id:other.id,
  p_command_id:command,p_preview_hash:preview.preview_hash,p_occurred_on:day,p_reason:reason,p_ignored_item_ids:[]}),fails('40001'),'the same UUID with another warehouse is another body');
 // Estornar estoque of the document works through the posting's own warehouse.
 const version=await f.scalar('select version v from erp_documents.document where id=$1',[sale.id]);
 const reverse=(await documentStock(`${base}/${result.posting.id}/reverse-preview`,{expected_document_version:version,occurred_on:day,reason:'Estorno da saída',expected_posting_version:1})).preview;
 assert.equal(reverse.warehouse.id,w.id);
 await documentStock(`${base}/${result.posting.id}/reverse`,{expected_document_version:version,occurred_on:day,reason:'Estorno da saída',expected_posting_version:1,command_id:randomUUID(),preview_hash:reverse.preview_hash});
 assert.equal(await f.balance(p.id,w.id),'10.000000');
 // A document with a warehouse may launch in another one; an inactive warehouse or an active reservation is refused.
 const own=await f.warehouse('Depósito do pedido');await f.launch(p.id,own.id,'receipt','2');
 const second=await f.transition(await f.order('sales_orders',[f.item(p,'1','9')],own.id),'verified');
 const change=(await f.rpc('erp_stock_document_warehouse_preview',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:second.id,p_expected_version:second.version,p_warehouse_id:w.id,p_occurred_on:day,p_reason:reason})).preview;
 assert.equal(change.positions[0].warehouse_id,w.id);
 const closed=await f.warehouse('Depósito inativo venda');await f.setActive(closed.id,false);
 await assert.rejects(f.rpc('erp_stock_document_warehouse_preview',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:second.id,p_expected_version:second.version,p_warehouse_id:closed.id,p_occurred_on:day,p_reason:reason}),fails('22023'));
 await assert.rejects(f.rpc('erp_stock_document_warehouse_preview',{p_user_id:f.users.vendas,p_kind:'sales_orders',p_document_id:second.id,p_expected_version:second.version,p_warehouse_id:w.id,p_occurred_on:day,p_reason:reason}),fails('42501'));
 const pre=(await f.rpc('erp_stock_reservation_preview',{p_user_id:f.users.admin,p_document_id:second.id,p_expected_version:second.version,p_action:'reserve',p_occurred_on:day,p_reason:'Reserva sintética'})).preview;
 await f.rpc('erp_stock_reservation_apply',{p_user_id:f.users.admin,p_document_id:second.id,p_expected_version:second.version,p_command_id:randomUUID(),p_action:'reserve',p_preview_hash:pre.preview_hash,p_occurred_on:day,p_reason:'Reserva sintética',p_ignored_item_ids:[]});
 const reserved=await f.scalar('select version v from erp_documents.document where id=$1',[second.id]);
 const blocked=(await f.rpc('erp_stock_document_warehouse_preview',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:second.id,p_expected_version:reserved,p_warehouse_id:w.id,p_occurred_on:day,p_reason:reason})).preview;
 await assert.rejects(f.rpc('erp_stock_document_warehouse_post',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:second.id,p_expected_version:reserved,p_warehouse_id:w.id,p_command_id:randomUUID(),
  p_preview_hash:blocked.preview_hash,p_occurred_on:day,p_reason:reason,p_ignored_item_ids:[]}),fails('40001'),'an active reservation must be consumed');
});

test('184 purchase order without warehouse: "Lançar estoque" receives the pending items in the chosen warehouse; the reversal uses the receipt warehouse',async()=>{
 const w=await f.warehouse('Depósito escolhido compra'),p=await f.product('Comprado sem depósito'),q=await f.product('Serviço comprado',{kind:'S'});
 const order=await withoutWarehouse('purchase_orders',[f.item(p,'4','2.5'),f.item(q,'1','10')],['in_progress']);
 const current=(await f.rpc('erp_purchase_receipts_get',{p_user_id:f.users.estoque,p_document_id:order.id,p_limit:1})).current;
 const items=current.items.filter(i=>i.eligibility==='eligible').map(i=>({item_id:i.item_id,quantity:i.remaining_quantity}));
 const base=`/v1/recebimentos-compras/${order.id}`,day='2026-10-20',reason=`Lançamento de estoque do pedido de compra nº ${order.number}`;
 await assert.rejects(receipts(`${base}/preview`,{expected_document_version:order.version,occurred_on:day,reason,items}),error=>error.status===400,'the published preview needs the order warehouse');
 const preview=(await receipts(`${base}/preview`,{expected_document_version:order.version,occurred_on:day,reason,items,warehouse_id:w.id})).preview;
 assert.deepEqual([preview.warehouse.id,preview.positions[0].warehouse_id,preview.document.warehouse_id],[w.id,w.id,null]);
 const command=randomUUID(),body={expected_document_version:order.version,occurred_on:day,reason,items,warehouse_id:w.id,command_id:command,preview_hash:preview.preview_hash,confirmed:true};
 const received=await receipts(`${base}/receive`,body);
 assert.deepEqual([received.replayed,received.receipt.receipt.warehouse_id,await f.balance(p.id,w.id)],[false,w.id,'4.000000']);
 assert.equal((await receipts(`${base}/receive`,body)).replayed,true,'Conferir resultado repeats the same command');
 await assert.rejects(f.rpc('erp_stock_purchase_receive',{p_user_id:f.users.estoque,p_document_id:order.id,p_expected_version:order.version,p_warehouse_id:(await f.warehouse('Outro compra')).id,p_occurred_on:day,p_reason:reason,
  p_items:items,p_command_id:command,p_preview_hash:preview.preview_hash,p_confirm:true}),fails('40001'));
 // Reversal through the published routes, in the receipt warehouse.
 const receipt=received.receipt.receipt.id,version=received.receipt.document_version;
 const reverse=(await receipts(`${base}/${receipt}/reverse-preview`,{expected_document_version:version,occurred_on:day,reason:'Estorno do recebimento'})).preview;
 assert.equal(reverse.warehouse.id,w.id);
 await receipts(`${base}/${receipt}/reverse`,{expected_document_version:version,occurred_on:day,reason:'Estorno do recebimento',command_id:randomUUID(),preview_hash:reverse.preview_hash,confirmed:true});
 assert.equal(await f.balance(p.id,w.id),'0.000000');
});

test('184 an order with its own warehouse keeps the published receipts: same request hash, a different chosen warehouse is refused',async()=>{
 const own=await f.warehouse('Depósito do pedido de compra'),other=await f.warehouse('Outro depósito compra'),p=await f.product('Comprado com depósito');
 const order=await f.order('purchase_orders',[f.item(p,'2','3')],own.id);
 const item=await f.scalar('select id v from erp_documents.item where document_id=$1',[order.id]),items=[{item_id:item,quantity:'2'}],day='2026-10-20',reason='Recebimento do pedido';
 await assert.rejects(f.rpc('erp_stock_purchase_receive_preview',{p_user_id:f.users.estoque,p_document_id:order.id,p_expected_version:order.version,p_warehouse_id:other.id,p_occurred_on:day,p_reason:reason,p_items:items}),fails('22023'));
 const preview=(await f.rpc('erp_purchase_receipts_preview',{p_user_id:f.users.estoque,p_document_id:order.id,p_expected_version:order.version,p_occurred_on:day,p_reason:reason,p_items:items})).preview;
 const command=randomUUID(),args={p_user_id:f.users.estoque,p_document_id:order.id,p_expected_version:order.version,p_occurred_on:day,p_reason:reason,p_items:items,p_command_id:command,p_preview_hash:preview.preview_hash,p_confirm:true};
 const first=await f.rpc('erp_purchase_receipts_receive',args);assert.equal(first.receipt.receipt.warehouse_id,own.id);
 const expected=await f.scalar("select encode(sha256(convert_to(jsonb_build_object('actor',$1::uuid,'document_id',$2::uuid,'version',$3::integer,'action','receive','occurred_on',$4::date,'reason',$5::text,'items',$6::jsonb,'receipt_id',null::uuid,'preview_hash',$7::text,'confirm',true)::text,'UTF8')),'hex') v",
  [f.users.estoque,order.id,order.version,day,reason,JSON.stringify(items),preview.preview_hash]);
 assert.equal(await f.scalar('select request_hash v from erp_purchase_receipts.command where id=$1',[command]),expected,'the published request hash');
 assert.equal((await f.rpc('erp_purchase_receipts_receive',args)).replayed,true);
});
