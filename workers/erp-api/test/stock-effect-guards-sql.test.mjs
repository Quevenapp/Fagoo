import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneFFixture,migrationSql,fails} from './helpers/stock-lane-f-fixture.mjs';

// 279 on PGlite (every migration published up to 266, then the lane F files) with synthetic data only: what a document with active
// stock (lançamento, recebimento or reserva) may still save, and the stock of a pedido de venda Em aberto.
let f;
before(async()=>{f=await stockLaneFFixture({upto:3});});
after(()=>f?.close());
const get=async doc=>(await f.rpc('erp_document_get',{p_user_id:f.users.admin,p_kind:doc.kind,p_id:doc.id})).document;
// The body the editor sends back: the same items (with their ids) and the header fields, with a patch.
const bodyOf=(d,patch={})=>({date:d.date,contact_id:d.contact_id,warehouse_id:d.warehouse_id,expected_date:d.expected_date,notes:d.notes,internal_notes:d.internal_notes,
 items:d.items.map(i=>({id:i.id,product_id:i.product_id,description:i.description,unit:i.unit,quantity:i.quantity,unit_price:i.unit_price})),...patch});
const save=async(doc,patch,user=f.users.admin)=>{const d=await get(doc);
 return(await f.rpc('erp_document_save',{p_user_id:user,p_kind:doc.kind,p_id:doc.id,p_expected_version:d.version,p_command_id:randomUUID(),p_body:bodyOf(d,typeof patch==='function'?patch(d):patch)})).document;};
const transition=async(doc,status)=>{const d=await get(doc);return f.transition({...doc,version:d.version},status);};
const post=async doc=>{const d=await get(doc);
 const p=(await f.rpc('erp_document_stock_preview',{p_user_id:f.users.estoque,p_kind:doc.kind,p_document_id:doc.id,p_expected_version:d.version,p_occurred_on:'2026-10-20',p_reason:'Baixa sintética 279'})).preview;
 return f.rpc('erp_document_stock_post',{p_user_id:f.users.estoque,p_kind:doc.kind,p_document_id:doc.id,p_expected_version:d.version,p_command_id:randomUUID(),p_preview_hash:p.preview_hash,
  p_occurred_on:'2026-10-20',p_reason:'Baixa sintética 279',p_ignored_item_ids:p.ignored.map(i=>i.id)});};

test('279 guards are internal; the guard refuses a second run',async()=>{
 for(const internal of['erp_stock.effect_transition_allowed(text,text,text)','erp_stock.effect_edit_allowed(erp_documents.document,erp_documents.document)',
  'erp_stock.effect_document_allowed(erp_documents.document,erp_documents.document)','erp_stock.effect_item_allowed(text,erp_documents.item,erp_documents.item)',
  'erp_stock.document_eligible(text,text)','erp_stock.guard_posted_document()','erp_purchase_receipts.guard_item()'])
  for(const role of['anon','authenticated','service_role'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,[internal]),false,internal);
 await assert.rejects(f.db.exec(await migrationSql('202610200279_stock_effect_guards.sql')),/stock_effect_guards_279_previous_definition_changed/);await f.db.exec('rollback');
});

test('279 pedido de compra with recebimento: header saves; items, fornecedor and depósito stay; the reversal frees them again',async()=>{
 const target=await f.warehouse('Depósito trava compra'),other=await f.warehouse('Outro depósito trava'),item=await f.product('Produto trava compra'),extra=await f.product('Produto extra trava');
 const supplier=await f.catalog('contacts',{name:'Outro fornecedor sintético'});
 const order=await f.order('purchase_orders',[f.item(item,'5'),f.item(extra,'1')],target.id,['in_progress'],{date:'2026-10-10'});
 const items=await f.rows('select id::text from erp_documents.item where document_id=$1 order by position',[order.id]);
 let d=await get(order);
 const p=(await f.rpc('erp_purchase_receipts_preview',{p_user_id:f.users.estoque,p_document_id:order.id,p_expected_version:d.version,p_occurred_on:null,p_reason:'Recebimento 279',p_items:[{item_id:items[0].id,quantity:'2'}]})).preview;
 await f.rpc('erp_purchase_receipts_receive',{p_user_id:f.users.estoque,p_document_id:order.id,p_expected_version:d.version,p_occurred_on:p.occurred_on,p_reason:'Recebimento 279',
  p_items:[{item_id:items[0].id,quantity:'2'}],p_command_id:randomUUID(),p_preview_hash:p.preview_hash,p_confirm:true});
 // Allowed: observações, data prevista, frete, data; the same items are rewritten unchanged.
 const saved=await save(order,{notes:'Entregar pela manhã',internal_notes:'Conferir lacre',expected_date:'2026-10-30',freight:'15.50',date:'2026-10-11'});
 assert.deepEqual([saved.notes,saved.internal_notes,saved.expected_date,saved.freight,saved.date,saved.items.length],['Entregar pela manhã','Conferir lacre','2026-10-30','15.50','2026-10-11',2]);
 assert.equal(saved.items[0].id,items[0].id,'the items keep their ids');
 // Refused: items (quantity, a new one, a removed one), the fornecedor, the depósito.
 await assert.rejects(save(order,d=>({items:d.items.map((i,n)=>n===0?{id:i.id,product_id:i.product_id,description:i.description,unit:i.unit,quantity:'6',unit_price:i.unit_price}:{id:i.id,product_id:i.product_id,description:i.description,unit:i.unit,quantity:i.quantity,unit_price:i.unit_price})})),fails('40001'));
 await assert.rejects(save(order,d=>({items:[...bodyOf(d).items,f.item(extra,'1')]})),fails('40001'));
 await assert.rejects(save(order,d=>({items:bodyOf(d).items.slice(0,1)})),fails('40001'));
 await assert.rejects(save(order,{contact_id:supplier.id}),fails('40001'));
 await assert.rejects(save(order,{warehouse_id:other.id}),fails('40001'));
 // After the reversal of the recebimento the whole pedido is editable again.
 const receipt=await f.scalar('select id::text v from erp_purchase_receipts.receipt where document_id=$1',[order.id]);
 d=await get(order);const today=await f.scalar("select (clock_timestamp() at time zone 'America/Sao_Paulo')::date::text v");
 const rp=(await f.rpc('erp_purchase_receipts_reverse_preview',{p_user_id:f.users.estoque,p_document_id:order.id,p_expected_version:d.version,p_receipt_id:receipt,p_occurred_on:today,p_reason:'Estorno 279'})).preview;
 await f.rpc('erp_purchase_receipts_reverse',{p_user_id:f.users.estoque,p_document_id:order.id,p_expected_version:d.version,p_receipt_id:receipt,p_occurred_on:today,p_reason:'Estorno 279',
  p_command_id:randomUUID(),p_preview_hash:rp.preview_hash,p_confirm:true});
 assert.equal((await save(order,{warehouse_id:other.id})).warehouse_id,other.id);
});

test('279 pedido de venda with stock or reserva: only Observações and Observações internas save; Em aberto posts and moves forward',async()=>{
 const target=await f.warehouse('Depósito trava venda'),item=await f.product('Produto trava venda');await f.launch(item.id,target.id,'receipt','20');
 // Em aberto (a new pedido) now posts its stock, as in Origin.
 const open=await f.order('sales_orders',[f.item(item,'2')],target.id);
 assert.equal((await get(open)).status,'open');
 await post(open);
 assert.equal(await f.balance(item.id,target.id),'18.000000');
 const noted=await save(open,{notes:'Cliente retira',internal_notes:'Separado'});
 assert.deepEqual([noted.notes,noted.internal_notes],['Cliente retira','Separado']);
 await assert.rejects(save(open,{date:'2026-10-01'}),fails('40001'),'the date of a venda with stock stays');
 await assert.rejects(save(open,d=>({items:d.items.map(i=>({id:i.id,product_id:i.product_id,description:'Outra descrição',unit:i.unit,quantity:i.quantity,unit_price:i.unit_price}))})),fails('40001'));
 await assert.rejects(save(open,{discount_value:'1.00'}),fails('40001'),'a total that changes stays refused');
 // Em aberto goes forward with the stock (Verificado, Em andamento, Atendido); not back to Em digitação nor to Cancelado.
 await assert.rejects(transition(open,'cancelled'),fails('40001'));
 await assert.rejects(transition(open,'draft'),fails('40001'));
 assert.equal((await transition(open,'in_progress')).status,'in_progress');
 // A reserva (070) also keeps the observações editable.
 const reserved=await f.order('sales_orders',[f.item(item,'1')],target.id,['verified']);
 const r=await get(reserved);
 const args={p_user_id:f.users.estoque,p_document_id:reserved.id,p_expected_version:r.version,p_action:'reserve',p_occurred_on:'2026-10-15',p_reason:'Reserva sintética 279'};
 const pre=(await f.rpc('erp_stock_reservation_preview',args)).preview;
 await f.rpc('erp_stock_reservation_apply',{...args,p_command_id:randomUUID(),p_preview_hash:pre.preview_hash,p_ignored_item_ids:[],p_reservation_id:null,p_reservation_version:null});
 assert.equal((await save(reserved,{notes:'Reservado para retirada'})).notes,'Reservado para retirada');
 await assert.rejects(save(reserved,{date:'2026-10-02'}),fails('40001'));
 await assert.rejects(transition(reserved,'cancelled'),fails('40001'));
});
