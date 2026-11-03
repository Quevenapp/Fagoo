import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneFFixture,migrationSql,fails} from './helpers/stock-lane-f-fixture.mjs';

// 277 on PGlite (every migration published up to 266, then the lane F files) with synthetic data only: the global total of the
// positions without the ignored warehouses, the recebimento dated by the preference, the decimals of the entries, the reservation by
// a custom situation and the lot import.
let f;
before(async()=>{f=await stockLaneFFixture({upto:1});});
after(()=>f?.close());
const today=async()=>f.scalar("select (clock_timestamp() at time zone 'America/Sao_Paulo')::date::text v");
const day=async offset=>f.scalar(`select ((clock_timestamp() at time zone 'America/Sao_Paulo')::date+${offset})::text v`);
const positions=(args={})=>f.rpc('erp_stock_positions',{p_user_id:f.users.consulta,p_limit:100,p_after:null,p_query:null,p_active:null,p_warehouse_id:null,p_brand:null,
 p_location:null,p_stock_state:null,p_limit_state:null,...args});
// Direct write of a company preference value the page does not offer yet (custom situation ids); synthetic setup only.
const forcePreference=async(key,value)=>{await f.db.exec("set session_replication_role=replica");try{
 await f.db.query('update erp_preferences.company_value set value=$2::jsonb where key=$1',[key,JSON.stringify(value)]);}finally{await f.db.exec("set session_replication_role=origin");}};

test('277 entry points are SECURITY DEFINER for service_role only, helpers are internal and the guard refuses a second run',async()=>{
 for(const signature of['public.erp_stock_positions(uuid,integer,uuid,text,boolean,uuid,text,text,text,text)',
  'public.erp_stock_launch(uuid,uuid,text,uuid,uuid,text,integer,text,text,text,uuid,integer)','public.erp_stock_movement_amend(uuid,uuid,uuid,uuid,integer,text,text,text)',
  'public.erp_stock_launch_context(uuid,uuid)','public.erp_stock_product_reservations(uuid,uuid,uuid)','public.erp_stock_lot_import(uuid,uuid,uuid,text,date,date,text)',
  ]){
  for(const role of['anon','authenticated','public'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,[signature]),false,signature);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",[signature]),true,signature);
  assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure',[signature]),true,signature);
  assert.deepEqual(await f.scalar('select proconfig v from pg_proc where oid=$1::regprocedure',[signature]),['search_path=pg_catalog'],signature);
 }
 for(const internal of['erp_stock.entry_decimals()','erp_stock.entry_price_check(text)','erp_stock.reserve_situation_ids()','erp_stock.situation_reservations(uuid)',
  'erp_purchase_receipts.preview(uuid,erp_documents.document,text,date,text,jsonb,uuid)'])
  for(const role of['anon','authenticated','service_role'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,[internal]),false,internal);
 await assert.rejects(f.db.exec(await migrationSql('202610200277_stock_lane_f_rules.sql')),/stock_lane_f_rules_277_previous_definition_changed/);await f.db.exec('rollback');
});

test('277 positions: the global total leaves out "Desconsiderar saldo deste depósito"; the chosen warehouse keeps its own balance',async()=>{
 const main=await f.warehouse('Principal F posições'),ignored=await f.warehouse('Consignado F posições',true);
 const item=await f.product('Produto posição F',{stock_min:'4',stock_max:'8'});
 await f.launch(item.id,main.id,'receipt','5');await f.launch(item.id,ignored.id,'receipt','30');
 const row=async args=>(await positions({p_query:'Produto posição F',...args})).items[0];
 const all=await row();
 assert.deepEqual({state:all.global.state,quantity:all.global.quantity,count:all.global.recorded_warehouse_count,limit:all.limit_state},{state:'recorded',quantity:'5.000000',count:'2',limit:'within'});
 const chosen=await row({p_warehouse_id:ignored.id});
 assert.deepEqual({quantity:chosen.selected_position.quantity,global:chosen.global.quantity},{quantity:'30.000000',global:'5.000000'});
 // Only an ignored warehouse: the total is zero (not "Sem lançamentos"); below the minimum.
 const only=await f.product('Produto só consignado F',{stock_min:'1'});await f.launch(only.id,ignored.id,'receipt','2');
 const alone=(await positions({p_query:'Produto só consignado F'})).items[0];
 assert.deepEqual({state:alone.global.state,quantity:alone.global.quantity,limit:alone.limit_state},{state:'recorded',quantity:'0.000000',limit:'below_min'});
 // A position in review in an ignored warehouse still leaves the total in review.
 await f.db.exec("set session_replication_role=replica");
 try{await f.db.query('update erp_stock.balance set version=version+5 where product_id=$1 and warehouse_id=$2',[only.id,ignored.id]);}finally{await f.db.exec("set session_replication_role=origin");}
 const review=(await positions({p_query:'Produto só consignado F'})).items[0];
 assert.deepEqual({state:review.global.state,quantity:review.global.quantity},{state:'review_required',quantity:null});
});

test('277 recebimento of the pedido de compra follows "Ao lançar estoque utilizar data atual ou data entrada/saída"',async()=>{
 const target=await f.warehouse('Depósito recebimento F'),item=await f.product('Produto recebimento F');
 const yesterday=await day(-1),past=await day(-5),now=await today();
 const order=await f.order('purchase_orders',[f.item(item,'4')],target.id,['in_progress'],{date:past});
 const itemId=await f.scalar('select id::text v from erp_documents.item where document_id=$1',[order.id]);
 const preview=(occurred,user=f.users.estoque)=>f.rpc('erp_purchase_receipts_preview',{p_user_id:user,p_document_id:order.id,p_expected_version:order.version,p_occurred_on:occurred,
  p_reason:'Recebimento sintético',p_items:[{item_id:itemId,quantity:'1'}]});
 // Data atual (default): a preview without a date receives today; another date is refused.
 assert.equal((await preview(null)).preview.occurred_on,now);
 assert.equal((await preview(now)).preview.occurred_on,now);
 await assert.rejects(preview(yesterday),error=>error.code==='22023'&&/launch_date_mismatch/.test(error.message));
 // Data entrada/saída: the Data prevista of the pedido (none here: its date); a future Data prevista becomes today.
 await f.setPreferences('suprimentos-estoque',{'estoque.data_lancamento':'data_documento'});
 try{
  assert.equal((await preview(null)).preview.occurred_on,past);
  await assert.rejects(preview(now),error=>error.code==='22023');
  const expected=await f.order('purchase_orders',[f.item(item,'2')],target.id,['in_progress'],{date:past});
  await f.db.query("update erp_documents.document set body=body||jsonb_build_object('expected_date',$2::text) where id=$1",[expected.id,yesterday]);
  const expectedItem=await f.scalar('select id::text v from erp_documents.item where document_id=$1',[expected.id]);
  const ahead=await f.order('purchase_orders',[f.item(item,'2')],target.id,['in_progress'],{date:past});
  await f.db.query("update erp_documents.document set body=body||jsonb_build_object('expected_date',$2::text) where id=$1",[ahead.id,await day(10)]);
  const aheadItem=await f.scalar('select id::text v from erp_documents.item where document_id=$1',[ahead.id]);
  const first=await f.rpc('erp_purchase_receipts_preview',{p_user_id:f.users.estoque,p_document_id:expected.id,p_expected_version:expected.version,p_occurred_on:null,p_reason:'Recebimento sintético',p_items:[{item_id:expectedItem,quantity:'2'}]});
  assert.equal(first.preview.occurred_on,yesterday);
  const second=await f.rpc('erp_purchase_receipts_preview',{p_user_id:f.users.estoque,p_document_id:ahead.id,p_expected_version:ahead.version,p_occurred_on:null,p_reason:'Recebimento sintético',p_items:[{item_id:aheadItem,quantity:'2'}]});
  assert.equal(second.preview.occurred_on,now);
  // The receive command with the preview day is accepted and dated by it.
  const p=first.preview;
  const received=await f.rpc('erp_purchase_receipts_receive',{p_user_id:f.users.estoque,p_document_id:expected.id,p_expected_version:expected.version,p_occurred_on:p.occurred_on,
   p_reason:'Recebimento sintético',p_items:[{item_id:expectedItem,quantity:'2'}],p_command_id:randomUUID(),p_preview_hash:p.preview_hash,p_confirm:true});
  assert.equal(received.receipt.receipt.occurred_on,yesterday);
  // The chosen-warehouse path (184) follows the same rule.
  const loose=await f.order('purchase_orders',[f.item(item,'1')],null,['in_progress'],{date:past});
  const looseItem=await f.scalar('select id::text v from erp_documents.item where document_id=$1',[loose.id]);
  const chosen=await f.rpc('erp_stock_purchase_receive_preview',{p_user_id:f.users.estoque,p_document_id:loose.id,p_expected_version:loose.version,p_warehouse_id:target.id,p_occurred_on:null,
   p_reason:'Recebimento sintético',p_items:[{item_id:looseItem,quantity:'1'}]});
  assert.equal(chosen.preview.occurred_on,past);
  await assert.rejects(f.rpc('erp_stock_purchase_receive_preview',{p_user_id:f.users.estoque,p_document_id:loose.id,p_expected_version:loose.version,p_warehouse_id:target.id,p_occurred_on:now,
   p_reason:'Recebimento sintético',p_items:[{item_id:looseItem,quantity:'1'}]}),fails('22023'));
  // The reversal keeps its informed date (not a lançamento).
  const receipt=received.receipt.receipt.id,version=received.current.document.version;
  const reverse=await f.rpc('erp_purchase_receipts_reverse_preview',{p_user_id:f.users.estoque,p_document_id:expected.id,p_expected_version:version,p_receipt_id:receipt,p_occurred_on:now,p_reason:'Estorno sintético'});
  assert.equal(reverse.preview.occurred_on,now);
 }finally{await f.setPreferences('suprimentos-estoque',{'estoque.data_lancamento':'data_atual'});}
});

test('277 Lançar estoque: "Número de casas decimais no preço nas entradas" limits Preço de Compra and Preço de Custo of Entrada and Balanço',async()=>{
 const target=await f.warehouse('Depósito decimais F'),item=await f.product('Produto decimais F'),lotted=await f.lotProduct('Produto lote decimais F');
 const context=async()=>f.rpc('erp_stock_launch_context',{p_user_id:f.users.estoque,p_product_id:item.id});
 assert.deepEqual((await context()).price_decimals,{entry:10});
 await f.setPreferences('empresa-geral',{'empresa.decimais_preco_entrada':2});
 try{
  assert.deepEqual((await context()).price_decimals,{entry:2});
  await assert.rejects(f.launch(item.id,target.id,'receipt','1',{price:'1.234'}),error=>error.code==='22023'&&/price_decimals_exceeded/.test(error.message));
  await assert.rejects(f.launch(item.id,target.id,'receipt','1',{price:'1.23',cost:'0.001'}),fails('22023'));
  await assert.rejects(f.launch(item.id,target.id,'balance','3',{price:'2.555'}),fails('22023'));
  await assert.rejects(f.lotLaunch(lotted.id,target.id,'receipt','1',{code:'LD-1'},{price:'9.999'}),fails('22023'));
  // Trailing zeros do not count; Saída (Preço de Venda) and Transferência are not entries.
  const ok=await f.launch(item.id,target.id,'receipt','4',{price:'1.2300000000',cost:'0.5'});
  assert.equal(ok.detail.unit_price,'1.2300000000');
  await f.launch(item.id,target.id,'issue','1',{price:'3.14159'});
  const other=await f.warehouse('Depósito destino decimais F');
  await f.launch(item.id,target.id,'transfer','1',{price:'1.23456',cost:'1.23456',destination:other.id});
  // The price of an entry changed in the extrato follows the limit; the note alone keeps the stored price.
  const movement=ok.movement.id;
  const amend=(price,cost,note,revision)=>f.rpc('erp_stock_movement_amend',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_movement_id:movement,p_product_id:item.id,
   p_expected_revision:revision,p_unit_price:price,p_unit_cost:cost,p_note:note});
  await assert.rejects(amend('1.231','0.5','Lançamento manual',1),fails('22023'));
  await f.setPreferences('empresa-geral',{'empresa.decimais_preco_entrada':1});
  const kept=await amend('1.2300000000','0.5','Nota alterada',1);
  assert.equal(kept.detail.unit_price,'1.2300000000');
 }finally{await f.setPreferences('empresa-geral',{'empresa.decimais_preco_entrada':10});}
});

test('277 reserva pelas situações de venda also counts a custom situation chosen in estoque.reserva_situacoes',async()=>{
 const target=await f.warehouse('Depósito reserva F'),item=await f.product('Produto reserva F');await f.launch(item.id,target.id,'receipt','10');
 const situation=(await f.rpc('erp_preferences_situation_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_kind:'sales_orders',p_situation:null,p_expected_version:0,
  p_data:{name:'Separação F',base_status:'open',color:'#123456',active:true}})).receipt.target;
 const custom=await f.order('sales_orders',[f.item(item,'2')],target.id);
 const plain=await f.order('sales_orders',[f.item(item,'3')],target.id);
 await f.db.query("insert into erp_documents.document_situation(document_id,kind,situation_id,base_status,actor,command_id)values($1,'sales_orders',$2,'open',$3,$4)",
  [custom.id,situation,f.users.admin,randomUUID()]);
 const reservations=async()=>f.rpc('erp_stock_product_reservations',{p_user_id:f.users.consulta,p_product_id:item.id,p_warehouse_id:null});
 await f.setPreferences('suprimentos-estoque',{'estoque.reserva_por_situacao':true,'estoque.reserva_situacoes':['verificado']});
 try{
  assert.equal((await reservations()).items.length,0);
  await forcePreference('estoque.reserva_situacoes',['verificado',situation]);
  const listed=await reservations();
  assert.deepEqual(listed.reservation.situation_ids,[situation]);
  assert.deepEqual(listed.items.map(i=>({document:i.document_id,status:i.status,situation:i.situation_id,name:i.situation_name,quantity:i.quantity})),
   [{document:custom.id,status:'open',situation:situation,name:'Separação F',quantity:'2.000000'}]);
  // The base situation keeps reserving the pedidos without a custom situation (and the custom one too).
  await forcePreference('estoque.reserva_situacoes',['em_aberto',situation]);
  assert.deepEqual((await reservations()).items.map(i=>i.document_id).sort(),[custom.id,plain.id].sort());
  // Off: no reservation by situation, custom ids ignored.
  await f.setPreferences('suprimentos-estoque',{'estoque.reserva_por_situacao':false});
  const off=await reservations();assert.deepEqual({items:off.items.length,ids:off.reservation.situation_ids},{items:0,ids:[]});
  // A UUID that is not a sales-order situation is ignored.
  await f.setPreferences('suprimentos-estoque',{'estoque.reserva_por_situacao':true});
  await forcePreference('estoque.reserva_situacoes',[randomUUID(),'not-a-uuid']);
  assert.deepEqual((await reservations()).reservation.situation_ids,[]);
 }finally{await forcePreference('estoque.reserva_situacoes',['verificado']);await f.setPreferences('suprimentos-estoque',{'estoque.reserva_por_situacao':false});}
});

test('277 importação de lotes: create by code, update dates and Obs., unchanged, replay and the lot rules',async()=>{
 const item=await f.lotProduct('Produto importação lotes F'),plain=await f.product('Produto sem lote importação F');
 const run=(product,code,{made=null,expires=null,note=null,user=f.users.estoque,command=randomUUID()}={})=>f.rpc('erp_stock_lot_import',{p_user_id:user,p_command_id:command,
  p_product_id:product,p_code:code,p_manufactured_on:made,p_expires_on:expires,p_note:note});
 const command=randomUUID();
 const created=await run(item.id,' IMP-1 ',{made:'2026-01-10',expires:'2027-01-10',note:'Importado',command});
 assert.deepEqual({outcome:created.outcome,code:created.lot.code,made:created.lot.manufactured_on,expires:created.lot.expires_on,note:created.lot.note,version:created.lot.version,replayed:created.replayed},
  {outcome:'created',code:'IMP-1',made:'2026-01-10',expires:'2027-01-10',note:'Importado',version:1,replayed:false});
 const replay=await run(item.id,' IMP-1 ',{made:'2026-01-10',expires:'2027-01-10',note:'Importado',command});
 assert.deepEqual({outcome:replay.outcome,replayed:replay.replayed},{outcome:'created',replayed:true});
 await assert.rejects(run(item.id,'OUTRO',{command}),fails('40001'));
 // Same code in another case updates; null keeps the stored value; the same values are "unchanged".
 const updated=await run(item.id,'imp-1',{expires:'2027-06-30'});
 assert.deepEqual({outcome:updated.outcome,code:updated.lot.code,made:updated.lot.manufactured_on,expires:updated.lot.expires_on,note:updated.lot.note,version:updated.lot.version},
  {outcome:'updated',code:'IMP-1',made:'2026-01-10',expires:'2027-06-30',note:'Importado',version:2});
 assert.equal((await run(item.id,'IMP-1',{note:'Importado'})).outcome,'unchanged');
 assert.equal(await f.scalar('select version v from erp_stock.lot where id=$1',[created.lot.id]),2);
 // Rules: Controle de lote, dates in order, required dates, profiles.
 await assert.rejects(run(plain.id,'X-1'),fails('22023'));
 await assert.rejects(run(item.id,'IMP-2',{made:'2027-02-01',expires:'2027-01-01'}),fails('22023'));
 await assert.rejects(run(item.id,'IMP-1',{made:'2027-07-01'}),fails('22023'));
 await assert.rejects(run(randomUUID(),'IMP-3'),fails('P0002'));
 for(const user of[f.users.vendas,f.users.consulta,f.users.fiscal])await assert.rejects(run(item.id,'IMP-4',{user}),fails('42501'));
 await f.setPreferences('cadastros-lotes',{'lotes.validade_obrigatoria':true});
 try{await assert.rejects(run(item.id,'IMP-5',{made:'2026-01-01'}),error=>/expiry_required/.test(error.message));}
 finally{await f.setPreferences('cadastros-lotes',{'lotes.validade_obrigatoria':false});}
});
