import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneFFixture,migrationSql,fails} from './helpers/stock-lane-f-fixture.mjs';

// 278 on PGlite (every migration published up to 266, then the lane F files) with synthetic data only: "Informar lotes de produtos"
// of a recorded line (manual, pedido de venda, recebimento de compra, nota fiscal) and the "Informações de lote lançado" of an item.
let f,saleNature,buyNature;
before(async()=>{
 f=await stockLaneFFixture({upto:2});
 await f.db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,'{\"state\":\"SP\",\"cnpj\":\"11222333000181\"}',$1) on conflict do nothing",[f.users.admin]);
 await f.db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1) on conflict do nothing",[f.users.admin]);
 const nature=async data=>(await f.rpc('erp_fiscal_nature_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'create',p_data:{nature:data}})).nature;
 saleNature=await nature({description:'Venda sintética 278',direction:'1',crt:'1'});buyNature=await nature({description:'Compra sintética 278',direction:'0',crt:'1',presence:'9'});
});
after(()=>f?.close());
const read=(movement,product,warehouse,user=f.users.consulta)=>f.rpc('erp_stock_movement_lots',{p_user_id:user,p_movement_id:movement,p_product_id:product,p_warehouse_id:warehouse});
const assign=async(movement,product,warehouse,lots,{user=f.users.estoque,command=randomUUID(),expected}={})=>f.rpc('erp_stock_movement_lots_assign',{p_user_id:user,p_command_id:command,
 p_movement_id:movement,p_product_id:product,p_warehouse_id:warehouse,p_expected_lots:expected??(await read(movement,product,warehouse,f.users.estoque)).line.lots_version,p_lots:lots});
const source=(kind,id,product,user=f.users.consulta)=>f.rpc('erp_stock_source_lots',{p_user_id:user,p_source:kind,p_source_id:id,p_product_id:product});
let numbers=930000;
const note=async(direction,items)=>{const total=items.reduce((s,i)=>s+Number(i.quantity)*Number(i.unit_price),0).toFixed(2);
 const data={model:'55',direction,issue_type:direction==='0'?'T':'N',series:'1',...(direction==='0'?{number:String(++numbers)}:{}),nature_id:direction==='1'?saleNature.id:buyNature.id,
  issue_date:'2026-10-20',crt:'1',purpose:'1',presence:direction==='1'?'1':'9',final_consumer:false,recipient:{name:'Contato sintético 278',person_type:'J',document:'12345678000190',state:'SP'},
  items,payment:{installments:[{date:'2026-11-20',amount:total}]}};
 return(await f.rpc('erp_fiscal_invoice_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'create',p_data:{invoice:data,orders:[]}})).invoice;};

test('278 entry points are SECURITY DEFINER for service_role only; helpers are internal; the guard refuses a second run',async()=>{
 for(const signature of['public.erp_stock_movement_lots(uuid,uuid,uuid,uuid)','public.erp_stock_movement_lots_assign(uuid,uuid,uuid,uuid,uuid,integer,jsonb)',
  'public.erp_stock_source_lots(uuid,text,uuid,uuid)']){
  for(const role of['anon','authenticated','public'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,[signature]),false,signature);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",[signature]),true,signature);
  assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure',[signature]),true,signature);
  assert.deepEqual(await f.scalar('select proconfig v from pg_proc where oid=$1::regprocedure',[signature]),['search_path=pg_catalog'],signature);
 }
 for(const internal of['erp_stock.movement_lot_line(uuid,uuid,uuid)','erp_stock.lot_origin_access(uuid,jsonb)','erp_stock.unassigned_quantity(uuid,uuid)',
  'erp_stock.movement_lot_candidates(uuid,uuid,text)','erp_stock.movement_lots_dto(uuid,jsonb)'])
  for(const role of['anon','authenticated','service_role'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,[internal]),false,internal);
 await assert.rejects(f.db.exec(await migrationSql('202610200278_stock_movement_lots.sql')),/stock_movement_lots_278_already_applied/);await f.db.exec('rollback');
});

test('278 manual Entrada: informed lots (existing and Novo lote), Sem lote, replay, CAS, limits and the Sem lote of the warehouse',async()=>{
 const target=await f.warehouse('Depósito lotes informados'),item=await f.lotProduct('Produto lotes informados'),plain=await f.product('Produto sem lote informado');
 const old=(await f.lotSave(item.id,{code:'A-1',expires_on:'2027-01-31'})).lot;
 const entry=await f.launch(item.id,target.id,'receipt','10');const movement=entry.movement.id;
 const first=await read(movement,item.id,target.id);
 assert.deepEqual({assignable:first.line.assignable,direction:first.line.direction,quantity:first.line.quantity,unassigned:first.line.unassigned,room:first.room,version:first.line.lots_version,
  candidates:first.candidates.map(c=>c.code),write:first.can_write},{assignable:true,direction:'receipt',quantity:'10.000000',unassigned:'10.000000',room:'10.000000',version:0,candidates:['A-1'],write:false});
 assert.equal((await read(movement,item.id,target.id,f.users.estoque)).can_write,true);
 const command=randomUUID(),lots=[{lot_id:old.id,quantity:'4'},{code:'N-1',manufactured_on:'2026-09-01',expires_on:'2027-09-01',quantity:'3.5'}];
 const saved=await assign(movement,item.id,target.id,lots,{command});
 assert.deepEqual({assigned:saved.line.assigned,unassigned:saved.line.unassigned,version:saved.line.lots_version,lots:saved.line.lots.map(l=>[l.code,l.quantity]),replayed:saved.replayed,
  entries:saved.entries.map(e=>[e.code,e.quantity,e.created])},{assigned:'7.500000',unassigned:'2.500000',version:2,lots:[['A-1','4.000000'],['N-1','3.500000']],replayed:false,
  entries:[['A-1','4.000000',false],['N-1','3.500000',true]]});
 assert.equal(await f.lotBalance(old.id,target.id),'4.000000');
 const created=await f.scalar("select id::text v from erp_stock.lot where product_id=$1 and code='N-1'",[item.id]);
 assert.equal(await f.lotBalance(created,target.id),'3.500000');
 // Replay with the same command and body; another body or actor is a conflict; a stale version is refused.
 assert.equal((await assign(movement,item.id,target.id,lots,{command,expected:0})).replayed,true);
 await assert.rejects(assign(movement,item.id,target.id,[{lot_id:old.id,quantity:'1'}],{command,expected:0}),fails('40001'));
 await assert.rejects(assign(movement,item.id,target.id,[{code:'N-2',quantity:'1'}],{expected:0}),fails('40001'));
 // More than what is left, the same lot again, a duplicated new code, a taken code, an invalid body.
 await assert.rejects(assign(movement,item.id,target.id,[{code:'N-3',quantity:'2.6'}]),error=>error.code==='22023'&&/exceeded/.test(error.message));
 await assert.rejects(assign(movement,item.id,target.id,[{lot_id:old.id,quantity:'1'}]),error=>/duplicate/.test(error.message));
 await assert.rejects(assign(movement,item.id,target.id,[{code:'X',quantity:'1'},{code:'x',quantity:'1'}]),fails('22023'));
 await assert.rejects(assign(movement,item.id,target.id,[{code:'a-1',quantity:'1'}]),error=>/code_taken/.test(error.message));
 for(const body of[[],[{lot_id:old.id,code:'Z',quantity:'1'}],[{lot_id:old.id,quantity:'0'}],[{lot_id:old.id,quantity:'-1'}],[{lot_id:old.id,quantity:1}],[{code:'Z',quantity:'1',extra:true}],
  [{code:'Z',expires_on:'2027-13-01',quantity:'1'}],[{lot_id:old.id,expires_on:'2027-01-01',quantity:'1'}]])
  await assert.rejects(assign(movement,item.id,target.id,body),fails('22023'));
 for(const user of[f.users.vendas,f.users.consulta,f.users.fiscal,f.users.financeiro])await assert.rejects(assign(movement,item.id,target.id,[{code:'P-1',quantity:'1'}],{user,expected:2}),fails('42501'));
 // A Saída without lot leaves less "Sem lote" in the warehouse: the rest of the Entrada can only go up to it.
 const exit=await f.launch(item.id,target.id,'issue','2');
 const tight=await read(movement,item.id,target.id);
 assert.deepEqual({unassigned:tight.line.unassigned,room:tight.room},{unassigned:'2.500000',room:'0.500000'});
 await assert.rejects(assign(movement,item.id,target.id,[{code:'N-4',quantity:'1'}]),error=>/exceeds_unassigned/.test(error.message));
 const last=await assign(movement,item.id,target.id,[{code:'N-4',quantity:'0.5'}]);
 assert.deepEqual({unassigned:last.line.unassigned,room:last.room},{unassigned:'2.000000',room:'0.000000'});
 // The reversal of the Entrada gives every informed lot back; the reversed line no longer receives lots.
 await f.reverse(exit.movement.id);await f.reverse(movement);
 assert.equal(await f.lotBalance(old.id,target.id),'0.000000');
 const reversed=await read(movement,item.id,target.id);
 assert.deepEqual({assignable:reversed.line.assignable,reason:reversed.line.reason_code,candidates:reversed.candidates,room:reversed.room},{assignable:false,reason:'reversed',candidates:[],room:'0.000000'});
 await assert.rejects(assign(movement,item.id,target.id,[{code:'N-5',quantity:'1'}]),error=>/assign_unavailable/.test(error.message));
 // A product without "Controle de lote", a Balanço and an unknown line.
 const free=await f.launch(plain.id,target.id,'receipt','2');
 assert.equal((await read(free.movement.id,plain.id,target.id)).line.reason_code,'lot_control_off');
 const counted=await f.launch(item.id,target.id,'balance','9');
 assert.equal((await read(counted.movement.id,item.id,target.id)).line.reason_code,'kind');
 await assert.rejects(read(randomUUID(),item.id,target.id),fails('P0002'));
});

test('278 Saída of a pedido de venda: lots taken from their balance; item "Informações de lote lançado"; reversal by the document',async()=>{
 const target=await f.warehouse('Depósito venda lotes'),item=await f.lotProduct('Produto venda lotes');
 const lot=(await f.lotLaunch(item.id,target.id,'receipt','5',{code:'V-1',expires_on:'2027-02-01'})).lot;
 const order=await f.order('sales_orders',[f.item(item,'3')],target.id,['verified']);
 assert.deepEqual((await source('document',order.id,item.id)).lines,[],'nothing posted yet');
 assert.equal((await source('document',order.id,item.id)).posted,false);
 const p=(await f.rpc('erp_document_stock_preview',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:order.id,p_expected_version:order.version,p_occurred_on:'2026-10-20',p_reason:'Baixa sintética 278'})).preview;
 await f.rpc('erp_document_stock_post',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:order.id,p_expected_version:order.version,p_command_id:randomUUID(),p_preview_hash:p.preview_hash,
  p_occurred_on:'2026-10-20',p_reason:'Baixa sintética 278',p_ignored_item_ids:[]});
 const listed=await source('document',order.id,item.id);
 assert.deepEqual({posted:listed.posted,lines:listed.lines.map(l=>[l.direction,l.quantity,l.unassigned,l.origin.type,l.assignable]),write:listed.can_write,control:listed.product.lot_control},
  {posted:true,lines:[['issue','3.000000','3.000000','sales',true]],write:false,control:true});
 const line=listed.lines[0];
 const offer=await read(line.movement_id,item.id,target.id);assert.deepEqual(offer.candidates.map(c=>[c.code,c.quantity]),[['V-1','5.000000']]);
 await assert.rejects(assign(line.movement_id,item.id,target.id,[{code:'NOVO-SAIDA',quantity:'1'}]),fails('22023'),'a Saída never creates a lot');
 const saved=await assign(line.movement_id,item.id,target.id,[{lot_id:lot.id,quantity:'2'}]);
 assert.deepEqual([saved.line.assigned,saved.line.unassigned,await f.lotBalance(lot.id,target.id)],['2.000000','1.000000','3.000000']);
 // Profiles: the fiscal profile reads the pedido de venda; the purchase order kind is not readable by vendas.
 assert.equal((await source('document',order.id,item.id,f.users.fiscal)).lines.length,1);
 await assert.rejects(source('document',order.id,item.id,f.users.financeiro),fails('42501'));
 await assert.rejects(source('nota',order.id,item.id),fails('22023'));
 await assert.rejects(source('document',randomUUID(),item.id),fails('P0002'));
 // Estornar estoque of the pedido gives the lot back.
 const posting=await f.scalar("select id::text v from erp_stock.document_posting where document_id=$1 and state='active'",[order.id]);
 const current=await f.scalar('select version v from erp_documents.document where id=$1',[order.id]);
 const rp=(await f.rpc('erp_document_stock_reverse_preview',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:order.id,p_expected_version:current,p_posting_id:posting,p_posting_version:1,
  p_occurred_on:'2026-10-20',p_reason:'Estorno sintético 278'})).preview;
 await f.rpc('erp_document_stock_reverse',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:order.id,p_expected_version:current,p_posting_id:posting,p_posting_version:1,
  p_command_id:randomUUID(),p_preview_hash:rp.preview_hash,p_occurred_on:'2026-10-20',p_reason:'Estorno sintético 278'});
 assert.equal(await f.lotBalance(lot.id,target.id),'5.000000');
 assert.deepEqual((await source('document',order.id,item.id)).lines,[],'a reversed lançamento is not listed');
});

test('278 recebimento of a pedido de compra and the entry note: Novo lote on the received line; the note lists its own posting',async()=>{
 const target=await f.warehouse('Depósito compra lotes'),item=await f.lotProduct('Produto compra lotes');
 const order=await f.order('purchase_orders',[f.item(item,'6')],target.id,['in_progress'],{date:'2026-10-15'});
 const itemId=await f.scalar('select id::text v from erp_documents.item where document_id=$1',[order.id]);
 const p=(await f.rpc('erp_purchase_receipts_preview',{p_user_id:f.users.estoque,p_document_id:order.id,p_expected_version:order.version,p_occurred_on:null,p_reason:'Recebimento 278',
  p_items:[{item_id:itemId,quantity:'4'}]})).preview;
 await f.rpc('erp_purchase_receipts_receive',{p_user_id:f.users.estoque,p_document_id:order.id,p_expected_version:order.version,p_occurred_on:p.occurred_on,p_reason:'Recebimento 278',
  p_items:[{item_id:itemId,quantity:'4'}],p_command_id:randomUUID(),p_preview_hash:p.preview_hash,p_confirm:true});
 const listed=await source('document',order.id,item.id,f.users.estoque);
 assert.deepEqual(listed.lines.map(l=>[l.direction,l.quantity,l.origin.via]),[['receipt','4.000000','purchase_receipt']]);
 const saved=await assign(listed.lines[0].movement_id,item.id,target.id,[{code:'C-1',expires_on:'2027-10-01',quantity:'4'}]);
 assert.deepEqual([saved.line.unassigned,saved.line.assignable,saved.line.reason_code],['0.000000',false,'assigned']);
 // An entry note posted by itself: its own line.
 const entry=await note('0',[{product_id:item.id,description:'Item sintético',code:'S-1',unit:'UN',quantity:'2',unit_price:'10'}]);
 const version=await f.scalar('select version v from erp_fiscal_invoices.invoice where id=$1',[entry.id]);
 const ip=(await f.rpc('erp_stock_invoice_preview',{p_user_id:f.users.estoque,p_invoice_id:entry.id,p_expected_version:version,p_warehouse_id:target.id})).preview;
 await f.rpc('erp_stock_invoice_post',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_invoice_id:entry.id,p_expected_version:version,p_warehouse_id:target.id,p_preview_hash:ip.preview_hash});
 const fromNote=await source('invoice',entry.id,item.id,f.users.fiscal);
 assert.deepEqual({posted:fromNote.posted,reference:fromNote.reference,lines:fromNote.lines.map(l=>[l.direction,l.quantity,l.origin.type])},{posted:true,reference:null,lines:[['receipt','2.000000','invoices']]});
 await assert.rejects(source('invoice',entry.id,item.id,f.users.consulta),fails('42501'),'the note is read by admin, estoque and fiscal');
 await assign(fromNote.lines[0].movement_id,item.id,target.id,[{code:'NF-1',quantity:'2'}]);
 assert.equal((await source('invoice',entry.id,item.id,f.users.fiscal)).lines[0].lots[0].code,'NF-1');
 // A note without stock posted lists nothing.
 const other=await note('0',[{product_id:item.id,description:'Item sintético',code:'S-1',unit:'UN',quantity:'1',unit_price:'10'}]);
 assert.deepEqual(await source('invoice',other.id,item.id,f.users.estoque).then(v=>[v.posted,v.lines]),[false,[]]);
});
