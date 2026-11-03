import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneGFixture,migrationSql,fails} from './helpers/stock-lane-g-fixture.mjs';

// 296 on PGlite (every migration published up to 286, then the lane G files) with synthetic data only: the lots informed on the
// items of a document (data->'lots', stored by the documentos lane) in the lançamento and in the estorno of its stock, and the
// notes-only edit (erp_document_notes_save of the documentos lane) through the stock, reservation and receipt guards.
let f;
before(async()=>{f=await stockLaneGFixture();});
after(()=>f?.close());
const get=async doc=>(await f.rpc('erp_document_get',{p_user_id:f.users.admin,p_kind:doc.kind,p_id:doc.id})).document;
const items=doc=>f.rows('select id::text,position from erp_documents.item where document_id=$1 order by position',[doc.id]);
// What the documentos lane stores for "Informar lotes" of an item, written here directly (the document has no effect yet).
const informLots=async(itemId,lots)=>f.db.query("update erp_documents.item set data=jsonb_set(data,'{lots}',$2::jsonb) where id=$1",[itemId,JSON.stringify(lots)]);
const preview=async(doc,{user=f.users.estoque}={})=>{const d=await get(doc);
 return(await f.rpc('erp_document_stock_preview',{p_user_id:user,p_kind:doc.kind,p_document_id:doc.id,p_expected_version:d.version,p_occurred_on:'2026-10-20',p_reason:'Baixa sintética 296'})).preview;};
const post=async(doc,{prior=null,user=f.users.estoque,command=randomUUID()}={})=>{const d=await get(doc);const p=prior??await preview(doc,{user});
 return f.rpc('erp_document_stock_post',{p_user_id:user,p_kind:doc.kind,p_document_id:doc.id,p_expected_version:d.version,p_command_id:command,p_preview_hash:p.preview_hash,
  p_occurred_on:'2026-10-20',p_reason:'Baixa sintética 296',p_ignored_item_ids:p.ignored.map(i=>i.id)});};
const reversePreview=async doc=>{const d=await get(doc);const posting=await f.scalar("select jsonb_build_object('id',id,'version',version) v from erp_stock.document_posting where document_id=$1 and state='active'",[doc.id]);
 return{posting,preview:(await f.rpc('erp_document_stock_reverse_preview',{p_user_id:f.users.estoque,p_kind:doc.kind,p_document_id:doc.id,p_expected_version:d.version,p_posting_id:posting.id,
  p_posting_version:posting.version,p_occurred_on:'2026-10-21',p_reason:'Estorno sintético 296'})).preview};};
const reverse=async doc=>{const {posting,preview:p}=await reversePreview(doc);const d=await get(doc);
 return f.rpc('erp_document_stock_reverse',{p_user_id:f.users.estoque,p_kind:doc.kind,p_document_id:doc.id,p_expected_version:d.version,p_posting_id:posting.id,p_posting_version:posting.version,
  p_command_id:randomUUID(),p_preview_hash:p.preview_hash,p_occurred_on:'2026-10-21',p_reason:'Estorno sintético 296'});};

test('296 helpers are internal; the guard refuses a second run',async()=>{
 for(const internal of['erp_stock.document_item_lots(jsonb)','erp_stock.post_document_lots()','erp_stock.document_preview_data(erp_documents.document,date,text)',
  'erp_stock.document_reverse_preview_data(erp_documents.document,uuid,integer,date,text)'])
  for(const role of['anon','authenticated','service_role'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,[internal]),false,internal);
 await assert.rejects(f.db.exec(await migrationSql('202610200296_stock_document_lots.sql')),/stock_document_lots_296_previous_definition_changed/);await f.db.exec('rollback');
});

test('296 a document without lots keeps the published conferência and hash (lançamento and estorno)',async()=>{
 const g=await stockLaneGFixture({upto:1});
 try{
  const target=await g.warehouse('Depósito hash 296'),item=await g.product('Produto hash 296');await g.launch(item.id,target.id,'receipt','10');
  const doc=await g.order('sales_orders',[g.item(item,'2')],target.id);
  const call=async()=>{const d=(await g.rpc('erp_document_get',{p_user_id:g.users.admin,p_kind:doc.kind,p_id:doc.id})).document;
   return(await g.rpc('erp_document_stock_preview',{p_user_id:g.users.estoque,p_kind:doc.kind,p_document_id:doc.id,p_expected_version:d.version,p_occurred_on:'2026-10-20',p_reason:'Hash sintético'})).preview;};
  // A posted document without lots: the conferência of its estorno.
  const posted=await g.order('sales_orders',[g.item(item,'1')],target.id);
  const doc2=(await g.rpc('erp_document_get',{p_user_id:g.users.admin,p_kind:'sales_orders',p_id:posted.id})).document;
  const p2=(await g.rpc('erp_document_stock_preview',{p_user_id:g.users.estoque,p_kind:'sales_orders',p_document_id:posted.id,p_expected_version:doc2.version,p_occurred_on:'2026-10-20',p_reason:'Hash sintético'})).preview;
  await g.rpc('erp_document_stock_post',{p_user_id:g.users.estoque,p_kind:'sales_orders',p_document_id:posted.id,p_expected_version:doc2.version,p_command_id:randomUUID(),p_preview_hash:p2.preview_hash,
   p_occurred_on:'2026-10-20',p_reason:'Hash sintético',p_ignored_item_ids:[]});
  const reverseCall=async()=>{const d=(await g.rpc('erp_document_get',{p_user_id:g.users.admin,p_kind:'sales_orders',p_id:posted.id})).document;
   const posting=await g.scalar("select jsonb_build_object('id',id,'version',version) v from erp_stock.document_posting where document_id=$1",[posted.id]);
   return(await g.rpc('erp_document_stock_reverse_preview',{p_user_id:g.users.estoque,p_kind:'sales_orders',p_document_id:posted.id,p_expected_version:d.version,p_posting_id:posting.id,
    p_posting_version:posting.version,p_occurred_on:'2026-10-21',p_reason:'Hash sintético'})).preview;};
  const before296=await call(),reverseBefore=await reverseCall();
  await g.db.exec(await migrationSql('202610200296_stock_document_lots.sql'));
  const after296=await call();
  assert.equal(after296.preview_hash,before296.preview_hash);
  assert.equal(after296.positions[0].lots,undefined);
  const reverseAfter=await reverseCall();
  assert.equal(reverseAfter.preview_hash,reverseBefore.preview_hash);
  assert.equal(reverseAfter.positions[0].lots,undefined);
 }finally{await g.close();}
});

test('296 pedido de venda: the informed lots leave with the lançamento, the rest is Sem lote, and the estorno gives them back',async()=>{
 const target=await f.warehouse('Depósito lotes venda'),item=await f.lotProduct('Produto lotes venda'),plain=await f.product('Produto sem lote venda');
 const a=await f.lotSave(item.id,{code:'A-1',expires_on:'2027-01-31'}),b=await f.lotSave(item.id,{code:'B-2'});
 await f.lotLaunch(item.id,target.id,'receipt','5',{lot_id:a.id});await f.lotLaunch(item.id,target.id,'receipt','3',{lot_id:b.id});await f.launch(item.id,target.id,'receipt','2');
 await f.launch(plain.id,target.id,'receipt','5');
 const doc=await f.order('sales_orders',[f.item(item,'4'),f.item(item,'1.5'),f.item(plain,'1')],target.id);
 const [first,second]=await items(doc);
 await informLots(first.id,[{lot_id:a.id,quantity:'2'},{lot_id:b.id,quantity:'1'}]);
 await informLots(second.id,[{lot_id:a.id,quantity:'1.5'}]);
 const p=await preview(doc);
 const row=p.positions.find(x=>x.product_id===item.id);
 assert.equal(row.quantity,'-5.500000');
 assert.deepEqual(row.lots.map(l=>[l.code,l.quantity,l.balance_before,l.balance_after,l.sources.map(s=>[s.position,s.quantity])]),
  [['A-1','-3.500000','5.000000','1.500000',[[1,'2.000000'],[2,'1.500000']]],['B-2','-1.000000','3.000000','2.000000',[[1,'1.000000']]]]);
 assert.equal(row.lots[0].expires_on,'2027-01-31');
 assert.equal(p.positions.find(x=>x.product_id===plain.id).lots,undefined,'a product without lots has no lots key');
 const result=await post(doc,{prior:p});
 assert.deepEqual([await f.lotBalance(a.id,target.id),await f.lotBalance(b.id,target.id),await f.balance(item.id,target.id)],['1.500000','2.000000','4.500000']);
 const movement=result.movement.id;
 assert.deepEqual(await f.rows('select l.code,e.quantity::text from erp_stock.lot_entry e join erp_stock.lot l on l.id=e.lot_id where e.movement_id=$1 order by l.code',[movement]),
  [{code:'A-1',quantity:'-3.500000'},{code:'B-2',quantity:'-1.000000'}]);
 // "Informações de lote lançado" of the item and "Informar lotes" of the lançamento (278) read the same lines; the rest is Sem lote.
 const source=await f.rpc('erp_stock_source_lots',{p_user_id:f.users.consulta,p_source:'document',p_source_id:doc.id,p_product_id:item.id});
 assert.deepEqual(source.lines.map(l=>[l.assigned,l.unassigned]),[['4.500000','1.000000']]);
 // Estorno: the conferência shows the lots that come back; the reversal gives them back (258).
 const {preview:rp}=await reversePreview(doc);
 assert.deepEqual(rp.positions.find(x=>x.product_id===item.id).lots.map(l=>[l.code,l.quantity,l.balance_before,l.balance_after]),
  [['A-1','3.500000','1.500000','5.000000'],['B-2','1.000000','2.000000','3.000000']]);
 assert.equal(rp.positions.find(x=>x.product_id===plain.id).lots,undefined);
 await reverse(doc);
 assert.deepEqual([await f.lotBalance(a.id,target.id),await f.lotBalance(b.id,target.id),await f.balance(item.id,target.id)],['5.000000','3.000000','10.000000']);
});

test('296 the lots of an item are checked again: shape, product, control, active, quantity and balance of the lot',async()=>{
 const target=await f.warehouse('Depósito lotes conferidos'),item=await f.lotProduct('Produto lotes conferidos'),other=await f.lotProduct('Outro produto com lote');
 const plain=await f.product('Produto sem controle conferido');
 const a=await f.lotSave(item.id,{code:'C-1'}),foreign=await f.lotSave(other.id,{code:'X-1'}),idle=await f.lotSave(item.id,{code:'I-1'});
 await f.lotLaunch(item.id,target.id,'receipt','2',{lot_id:a.id});await f.launch(item.id,target.id,'receipt','10');await f.launch(plain.id,target.id,'receipt','5');
 await f.rpc('erp_stock_lot_status',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_lot_id:idle.id,p_expected_version:1,p_active:false});
 const doc=await f.order('sales_orders',[f.item(item,'3'),f.item(plain,'1')],target.id);
 const [first,second]=await items(doc);
 const refused=async(lots,code,message,itemId=first.id)=>{await informLots(itemId,lots);await assert.rejects(preview(doc),e=>e.code===code&&new RegExp(message).test(e.message),message);await informLots(itemId,[]);};
 await refused([{lot_id:a.id,quantity:'1'},{lot_id:a.id,quantity:'1'}],'22023','erp_document_stock_lots_invalid');
 await refused([{lot_id:a.id,quantity:'0'}],'22023','erp_document_stock_lots_invalid');
 await refused([{lot_id:a.id,quantity:'1.1234567'}],'22023','erp_document_stock_lots_invalid');
 await refused([{lot_id:'nao-e-uuid',quantity:'1'}],'22023','erp_document_stock_lots_invalid');
 await refused({lot_id:a.id},'22023','erp_document_stock_lots_invalid');
 await refused([{lot_id:foreign.id,quantity:'1'}],'P0002','erp_stock_lot_not_found');
 await refused([{lot_id:randomUUID(),quantity:'1'}],'P0002','erp_stock_lot_not_found');
 await refused([{lot_id:idle.id,quantity:'1'}],'22023','erp_stock_lot_inactive');
 await refused([{lot_id:a.id,quantity:'3.5'}],'22023','erp_document_stock_lots_exceed');
 await refused([{lot_id:a.id,quantity:'1'}],'22023','erp_stock_lot_control_off',second.id);
 // The lot never goes negative, even with negative stock allowed (258).
 await f.setPolicy(true);
 try{await refused([{lot_id:a.id,quantity:'2.5'}],'22023','erp_stock_lot_insufficient');}finally{await f.setPolicy(false);}
 // An empty list, null or no key at all is Sem lote; a JSON number quantity is read exactly.
 await informLots(first.id,null);assert.equal((await preview(doc)).positions.find(x=>x.product_id===item.id).lots,undefined);
 await informLots(first.id,[{lot_id:a.id.toUpperCase(),quantity:1.5}]);
 assert.deepEqual((await preview(doc)).positions.find(x=>x.product_id===item.id).lots.map(l=>[l.lot_id,l.quantity]),[[a.id,'-1.500000']]);
 // A conferência made before the lots changed is refused by its hash.
 const stale=await preview(doc);await informLots(first.id,[{lot_id:a.id,quantity:'1'}]);
 await assert.rejects(post(doc,{prior:stale}),fails('40001'));
});

test('296 reserva consumida and pedido de compra lançado por inteiro carry the lots; the estorno of an entrada whose lot left is refused first',async()=>{
 const target=await f.warehouse('Depósito lotes reserva'),item=await f.lotProduct('Produto lotes reserva');
 const a=await f.lotSave(item.id,{code:'R-1'});await f.lotLaunch(item.id,target.id,'receipt','4',{lot_id:a.id});
 const doc=await f.order('sales_orders',[f.item(item,'3')],target.id,['verified']);
 const [first]=await items(doc);await informLots(first.id,[{lot_id:a.id,quantity:'3'}]);
 let d=await get(doc);
 const args={p_user_id:f.users.estoque,p_document_id:doc.id,p_expected_version:d.version,p_occurred_on:'2026-10-20',p_reason:'Reserva sintética 296'};
 const reserve=(await f.rpc('erp_stock_reservation_preview',{...args,p_action:'reserve'})).preview;
 const reserved=await f.rpc('erp_stock_reservation_apply',{...args,p_action:'reserve',p_command_id:randomUUID(),p_preview_hash:reserve.preview_hash,p_ignored_item_ids:[],p_reservation_id:null,p_reservation_version:null});
 const r=reserved.receipt.reservation;d=await get(doc);
 const consumeArgs={...args,p_expected_version:d.version,p_action:'consume',p_reservation_id:r.id,p_reservation_version:r.version};
 const consume=(await f.rpc('erp_stock_reservation_preview',consumeArgs)).preview;
 await f.rpc('erp_stock_reservation_apply',{...consumeArgs,p_command_id:randomUUID(),p_preview_hash:consume.preview_hash,p_ignored_item_ids:null});
 assert.equal(await f.lotBalance(a.id,target.id),'1.000000','the consumed reserva leaves the informed lot');
 // Pedido de compra lançado por inteiro (018): the lots enter with the lançamento.
 const buy=await f.order('purchase_orders',[f.item(item,'5')],target.id);
 const [bought]=await items(buy);const n=await f.lotSave(item.id,{code:'N-9'});
 await informLots(bought.id,[{lot_id:n.id,quantity:'5'}]);
 const pp=await preview(buy);assert.deepEqual(pp.positions[0].lots.map(l=>[l.code,l.quantity,l.balance_before,l.balance_after]),[['N-9','5.000000','0.000000','5.000000']]);
 await post(buy,{prior:pp});
 assert.equal(await f.lotBalance(n.id,target.id),'5.000000');
 // The lot leaves by a manual Saída; the estorno of the entrada would take the lot below zero and is refused by its conferência.
 await f.lotLaunch(item.id,target.id,'issue','4',{lot_id:n.id});await f.launch(item.id,target.id,'receipt','10');
 await assert.rejects(reversePreview(buy),e=>e.code==='22023'&&/erp_stock_lot_insufficient/.test(e.message));
});

test('296 contract with the documentos lane (erp_document_notes_save): only Observações and Observações internas pass the stock, reserva and recebimento guards',async()=>{
 const target=await f.warehouse('Depósito observações'),item=await f.product('Produto observações');await f.launch(item.id,target.id,'receipt','20');
 // What the notes save writes: body.notes and body.internal_notes, one version more, updated_by and updated_at.
 const notes=(doc,patch={})=>f.db.query(`update erp_documents.document set body=body||$2::jsonb,version=version+1,updated_by=$3,updated_at=clock_timestamp() where id=$1`,
  [doc.id,JSON.stringify({notes:'Observação sintética',internal_notes:'Observação interna sintética',...patch}),f.users.vendas]);
 const refusedWith=code=>e=>e?.code==='40001'&&new RegExp(code).test(e.message);
 // Pedido de venda and OS with stock posted.
 const sale=await f.order('sales_orders',[f.item(item,'2')],target.id);await post(sale);
 await notes(sale);assert.equal((await get(sale)).notes,'Observação sintética');
 await assert.rejects(notes(sale,{expected_date:'2026-11-01'}),refusedWith('erp_document_active_stock'));
 await assert.rejects(f.db.query("update erp_documents.document set total=total+1,body=body||'{\"notes\":\"x\"}' where id=$1",[sale.id]),refusedWith('erp_document_active_stock'));
 const os=await f.order('service_orders',[f.item(item,'1')],target.id,['quoted','approved']);await post(os);
 await notes(os);assert.equal((await get(os)).internal_notes,'Observação interna sintética');
 await assert.rejects(notes(os,{seller_id:null}),refusedWith('erp_document_active_stock'));
 // Pedido de venda with an active reserva.
 const kept=await f.order('sales_orders',[f.item(item,'1')],target.id,['verified']);let d=await get(kept);
 const args={p_user_id:f.users.estoque,p_document_id:kept.id,p_expected_version:d.version,p_action:'reserve',p_occurred_on:'2026-10-15',p_reason:'Reserva sintética observações'};
 const pre=(await f.rpc('erp_stock_reservation_preview',args)).preview;
 await f.rpc('erp_stock_reservation_apply',{...args,p_command_id:randomUUID(),p_preview_hash:pre.preview_hash,p_ignored_item_ids:[],p_reservation_id:null,p_reservation_version:null});
 await notes(kept);assert.equal((await get(kept)).notes,'Observação sintética');
 await assert.rejects(notes(kept,{date:'2026-10-01'}),refusedWith('erp_document_active_reservation'));
 // Pedido de compra with a recebimento: the whole header except fornecedor and depósito, so the observações too.
 const buy=await f.order('purchase_orders',[f.item(item,'5')],target.id);
 const [line]=await items(buy);d=await get(buy);
 const rp=(await f.rpc('erp_purchase_receipts_preview',{p_user_id:f.users.estoque,p_document_id:buy.id,p_expected_version:d.version,p_occurred_on:null,p_reason:'Recebimento observações',p_items:[{item_id:line.id,quantity:'2'}]})).preview;
 await f.rpc('erp_purchase_receipts_receive',{p_user_id:f.users.estoque,p_document_id:buy.id,p_expected_version:d.version,p_occurred_on:rp.occurred_on,p_reason:'Recebimento observações',
  p_items:[{item_id:line.id,quantity:'2'}],p_command_id:randomUUID(),p_preview_hash:rp.preview_hash,p_confirm:true});
 await notes(buy);assert.equal((await get(buy)).notes,'Observação sintética');
 await assert.rejects(notes(buy,{warehouse_id:randomUUID()}),refusedWith('purchase_receipt_active'));
});
