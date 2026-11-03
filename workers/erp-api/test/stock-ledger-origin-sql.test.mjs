import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {readdir} from 'node:fs/promises';
import {stockOriginFixture,fails,migrationSql} from './helpers/stock-origin-fixture.mjs';
import {bootstrap} from '../../../tools/migration/helpers/stock-reservation-fixture.mjs';
import {stockRoute,stockOperation,stockResponse} from '../src/stock.mjs';

// Migration 105: Balanço, preços e observação dos lançamentos, depósito padrão e saldo desconsiderado (PGlite, synthetic data).
let f,s;
const PUBLIC=['erp_stock_balances(uuid,uuid,uuid)','erp_stock_ledger(uuid,uuid,uuid,text,text,date,date,integer,integer,text)',
 'erp_stock_launch(uuid,uuid,text,uuid,uuid,text,integer,text,text,text,uuid,integer)','erp_stock_movement_amend(uuid,uuid,uuid,uuid,integer,text,text,text)',
 'erp_stock_product_reservations(uuid,uuid,uuid)','erp_stock_totals(uuid,uuid)','erp_stock_warehouses(uuid,text,boolean,integer,integer)',
 'erp_stock_warehouse_save(uuid,uuid,uuid,integer,integer,text,boolean)','erp_stock_warehouse_set_default(uuid,uuid,uuid,integer)'];
const HELPERS=['erp_stock.warehouse_access(uuid,boolean,boolean)','erp_stock.warehouse_dto(uuid)','erp_stock.ignored_warehouse(uuid)','erp_stock.price_105(text)','erp_stock.price_text(numeric)',
 'erp_stock.ledger_document_price(uuid,uuid)','erp_stock.ledger_row_105(uuid,uuid,text)','erp_stock.command_taken(uuid)'];
const TABLES=['warehouse_command','warehouse_setting','warehouse_default','ledger_command','movement_detail','balance_count'];
const ledger=(args={})=>f.rpc('erp_stock_ledger',{p_user_id:f.users.consulta,p_product_id:s.product.id,...args});
const http=async(path,method,body)=>{const url=new URL(`https://api.example.test${path}`);const request=new Request(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const route=stockRoute(url.pathname);return{route,operation:await stockOperation(request,route,url.searchParams)};};

test.before(async()=>{
 f=await stockOriginFixture();
 const product=await f.catalog('products',{name:'Produto extrato105',code:'EXT105',unit:'UN',kind:'P',format:'S',price:'2.5',stock_min:'4',stock_max:'50'});
 const other=await f.catalog('products',{name:'Outro produto105',unit:'UN',kind:'P',format:'S',price:'10'});
 const a=await f.warehouse('Geral'),b=await f.warehouse('Avarias',true),c=await f.warehouse('Loja');
 s={product,other,a,b,c};
});
test.after(async()=>f?.close());

test('105 grants: only service_role runs the public RPCs; helpers and tables stay closed; definer with fixed search_path',async()=>{
 for(const role of['anon','authenticated','service_role']){
  for(const fn of PUBLIC)assert.equal(await f.scalar('select has_function_privilege($1,$2,\'execute\')v',[role,`public.${fn}`]),role==='service_role',`${role} ${fn}`);
  for(const fn of HELPERS)assert.equal(await f.scalar('select has_function_privilege($1,$2,\'execute\')v',[role,fn]),false,`${role} ${fn}`);
  for(const table of TABLES)assert.equal(await f.scalar("select has_table_privilege($1,$2,'select')v",[role,`erp_stock.${table}`]),false);
 }
 for(const fn of PUBLIC)assert.deepEqual(await f.scalar("select jsonb_build_object('definer',prosecdef,'config',proconfig)v from pg_proc where oid=$1::regprocedure",[`public.${fn}`]),{definer:true,config:['search_path=pg_catalog']},fn);
 for(const table of TABLES)assert.equal(await f.scalar("select relrowsecurity v from pg_class where oid=$1::regclass",[`erp_stock.${table}`]),true);
 assert.equal(await f.scalar("select count(*)::int v from pg_proc where proname='erp_stock_ledger' and pronamespace='public'::regnamespace"),1,'the 098 signature was replaced, not overloaded');
});

test('105 refuses to apply over a changed published body',async()=>{
 const db=new PGlite();try{
  await db.exec(bootstrap);const dir=new URL('../../../supabase/migrations/',import.meta.url);
  for(const name of(await readdir(dir)).filter(n=>/^20261(01[67]|019)\d{4}_.+\.sql$/.test(n)).sort())await db.exec(await migrationSql(name));
  await db.exec("create or replace function public.erp_stock_balances(p_user_id uuid,p_product_id uuid,p_warehouse_id uuid default null)returns jsonb language sql as $$select '{}'::jsonb$$");
  await assert.rejects(db.exec(await migrationSql('202610200105_stock_ledger_warehouses_origin.sql')),error=>/stock_ledger_105_previous_definition_changed/.test(error.message));
 }finally{await db.close();}
});

test('105 Depósitos: Descrição and Desconsiderar saldo in one audited command; default warehouse; readers and writers of the catalog',async()=>{
 const list=await f.rpc('erp_stock_warehouses',{p_user_id:f.users.consulta});
 assert.deepEqual(list.items.map(item=>item.name),['Avarias','Geral','Loja']);assert.equal(list.can_manage,false);assert.equal(list.total,3);
 assert.deepEqual(list.items.map(item=>[item.ignore_balance,item.setting_version]),[[true,1],[false,0],[false,0]]);
 assert.equal((await f.rpc('erp_stock_warehouses',{p_user_id:f.users.estoque})).can_manage,true);
 for(const role of['vendas','fiscal','financeiro'])await assert.rejects(f.rpc('erp_stock_warehouses',{p_user_id:f.users[role]}),fails('42501'),role);
 await assert.rejects(f.rpc('erp_stock_warehouse_save',{p_user_id:f.users.consulta,p_command_id:randomUUID(),p_warehouse_id:null,p_expected_version:0,p_expected_setting_version:0,p_name:'Nunca',p_ignore_balance:false}),fails('42501'));
 assert.deepEqual((await f.rpc('erp_stock_warehouses',{p_user_id:f.users.admin,p_query:'avária'})).items.map(item=>item.name),['Avarias'],'accent-insensitive "Pesquisar por descrição"');
 const command=randomUUID(),args={p_user_id:f.users.estoque,p_command_id:command,p_warehouse_id:s.c.id,p_expected_version:s.c.version,p_expected_setting_version:0,p_name:'Loja Centro',p_ignore_balance:true};
 const saved=await f.rpc('erp_stock_warehouse_save',args);
 assert.deepEqual([saved.warehouse.name,saved.warehouse.ignore_balance,saved.warehouse.version,saved.warehouse.setting_version,saved.receipt.catalog_changed,saved.receipt.setting_changed,saved.replayed],['Loja Centro',true,2,1,true,true,false]);
 assert.equal((await f.rpc('erp_stock_warehouse_save',args)).replayed,true,'same command, same body: stored receipt');
 await assert.rejects(f.rpc('erp_stock_warehouse_save',{...args,p_name:'Outro nome'}),fails('40001'));
 await assert.rejects(f.rpc('erp_stock_warehouse_save',{...args,p_command_id:randomUUID()}),fails('40001'),'stale catalog version');
 assert.equal(await f.scalar("select count(*)::int v from erp_catalog.audit where record_id=$1 and command_id=$2",[s.c.id,command]),1,'the catalog part keeps the 006 audit');
 const back=await f.rpc('erp_stock_warehouse_save',{...args,p_command_id:randomUUID(),p_expected_version:2,p_expected_setting_version:1,p_name:'Loja',p_ignore_balance:false});
 assert.deepEqual([back.warehouse.ignore_balance,back.warehouse.setting_version],[false,2]);s.c=back.warehouse;
 assert.equal(await f.scalar("select code is null and description is null v from erp_catalog.record r join erp_catalog.warehouse w on w.record_id=r.id where r.id=$1",[s.c.id]),true,'code and long description untouched');
 // Depósito padrão.
 const first=await f.rpc('erp_stock_warehouse_set_default',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_warehouse_id:s.a.id,p_expected_version:0});
 assert.deepEqual([first.receipt.from.warehouse_id,first.receipt.to.version,first.warehouse.is_default],[null,1,true]);
 await assert.rejects(f.rpc('erp_stock_warehouse_set_default',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_warehouse_id:s.c.id,p_expected_version:0}),fails('40001'));
 await assert.rejects(f.rpc('erp_stock_warehouse_set_default',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_warehouse_id:s.a.id,p_expected_version:1}),fails('22023'),'already the default');
 await assert.rejects(f.rpc('erp_stock_warehouse_set_default',{p_user_id:f.users.consulta,p_command_id:randomUUID(),p_warehouse_id:s.c.id,p_expected_version:1}),fails('42501'));
 // Inativar o padrão é recusado em qualquer caminho; um depósito inativo nunca vira padrão.
 const record=await f.scalar('select version v from erp_catalog.record where id=$1',[s.a.id]);
 await assert.rejects(f.rpc('erp_catalog_set_active',{p_user_id:f.users.admin,p_entity:'warehouses',p_id:s.a.id,p_expected_version:record,p_command_id:randomUUID(),p_active:false}),fails('22023'));
 const inactive=await f.warehouse('Arquivo');const v=await f.scalar('select version v from erp_catalog.record where id=$1',[inactive.id]);
 await f.rpc('erp_catalog_set_active',{p_user_id:f.users.admin,p_entity:'warehouses',p_id:inactive.id,p_expected_version:v,p_command_id:randomUUID(),p_active:false});
 await assert.rejects(f.rpc('erp_stock_warehouse_set_default',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_warehouse_id:inactive.id,p_expected_version:1}),fails('22023'));
 assert.deepEqual((await f.rpc('erp_stock_warehouses',{p_user_id:f.users.admin,p_active:false})).items.map(item=>item.name),['Arquivo']);
 // Tables only change through their commands.
 await assert.rejects(f.db.query('update erp_stock.warehouse_setting set ignore_balance=false'),error=>/immutable/.test(error.message));
 await assert.rejects(f.db.query('update erp_stock.warehouse_default set warehouse_id=null'),error=>/immutable/.test(error.message));
 await assert.rejects(f.db.query('delete from erp_stock.warehouse_command'),error=>/immutable/.test(error.message));
 // Command UUIDs are unique across the stock families and the catalog.
 const taken=randomUUID();await f.post('receipt',[[s.other.id,s.a.id,'1']],{command:taken});
 await assert.rejects(f.rpc('erp_stock_warehouse_set_default',{p_user_id:f.users.admin,p_command_id:taken,p_warehouse_id:s.c.id,p_expected_version:1}),fails('40001'));
});

test('105 lançamento manual: Entrada, Saída, Balanço and Transferência dated today, with prices, through the 009 engine',async()=>{
 const {product,a,b,c}=s;
 const receipt=await f.launch(product.id,a.id,'receipt','10',{p_note:'  '});
 assert.equal(receipt.movement.kind,'receipt');assert.equal(receipt.movement.reason,'Lançamento manual');assert.deepEqual(receipt.detail,{revision:1,unit_price:'1.5000000000',unit_cost:'1.7500000000',note:'Lançamento manual'});
 assert.equal(receipt.occurred_on,await f.scalar("select (clock_timestamp() at time zone 'America/Sao_Paulo')::date::text v"));
 const issue=await f.launch(product.id,a.id,'issue','3',{p_note:'Venda balcão'});assert.equal(issue.movement.items[0].quantity,'-3.000000');assert.equal(issue.detail.unit_cost,null);
 await assert.rejects(f.launch(product.id,a.id,'issue','1',{p_unit_cost:'1'}),fails('22023'),'Saída has no Preço de Custo');
 const counted=await f.launch(product.id,a.id,'balance','5',{p_note:'ok'});
 assert.deepEqual([counted.movement.kind,counted.movement.items[0].quantity,counted.balance.counted,counted.balance.previous,counted.movement.reason,counted.detail.note],['adjustment','-2.000000','5.000000','7.000000','Lançamento manual','ok']);
 await assert.rejects(f.launch(product.id,a.id,'balance','5'),fails('22023'),'Balanço equal to the current balance records nothing');
 await assert.rejects(f.rpc('erp_stock_launch',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_kind:'balance',p_product_id:product.id,p_warehouse_id:a.id,p_quantity:'9',p_expected_version:1}),fails('40001'),'stale version');
 const transfer=await f.launch(product.id,a.id,'transfer','2',{p_destination_id:b.id,p_destination_version:0,p_note:null});
 assert.deepEqual(transfer.movement.items.map(item=>[item.warehouse_id,item.quantity]).sort(),[[a.id,'-2.000000'],[b.id,'2.000000']].sort());assert.equal(transfer.detail.note,'Transferência');
 const zero=await f.launch(product.id,c.id,'balance','0.5');assert.equal(zero.balance.previous,'0.000000');
 // Policy (100) applies to the Balanço difference: a negative target needs "Permitir estoque negativo".
 await assert.rejects(f.launch(product.id,c.id,'balance','-1'),fails('22023'));
 await f.setPolicy(true);try{const negative=await f.launch(product.id,c.id,'balance','-1');assert.equal(negative.balance.counted,'-1.000000');}finally{await f.setPolicy(false);}
 for(const role of['vendas','consulta','fiscal','financeiro'])await assert.rejects(f.rpc('erp_stock_launch',{p_user_id:f.users[role],p_command_id:randomUUID(),p_kind:'receipt',p_product_id:product.id,p_warehouse_id:a.id,p_quantity:'1',p_expected_version:0}),fails('42501'),role);
 for(const bad of[{p_quantity:'0'},{p_quantity:'-1'},{p_quantity:'1.1234567'},{p_unit_price:'1,5'},{p_unit_price:'1.12345678901'},{p_kind:'adjustment'},{p_destination_id:b.id,p_destination_version:0},{p_note:'a\u0001b'}])
  await assert.rejects(f.launch(product.id,a.id,'receipt','1',bad),fails('22023'),JSON.stringify(bad));
 s.movements={receipt,issue,counted,transfer,zero};
});

test('105 replay and recovery: the same command returns the stored result even after the balance changed; other bodies or families conflict',async()=>{
 const {product,a}=s,command=randomUUID(),version=await f.version(product.id,a.id);
 const args={p_user_id:f.users.estoque,p_command_id:command,p_kind:'balance',p_product_id:product.id,p_warehouse_id:a.id,p_quantity:'8',p_expected_version:version,p_unit_price:'1',p_unit_cost:'1',p_note:null,p_destination_id:null,p_destination_version:null};
 const first=await f.rpc('erp_stock_launch',args);await f.launch(product.id,a.id,'receipt','1');
 const again=await f.rpc('erp_stock_launch',args);assert.equal(again.replayed,true);assert.deepEqual(again.movement,first.movement);assert.deepEqual(again.balance,first.balance);
 assert.equal(await f.scalar('select count(*)::int v from erp_stock.movement where command_id=$1',[command]),1);
 await assert.rejects(f.rpc('erp_stock_launch',{...args,p_quantity:'9'}),fails('40001'));
 await assert.rejects(f.rpc('erp_stock_launch',{...args,p_user_id:f.users.other}),fails('40001'),'another actor');
 const taken=randomUUID();await f.post('receipt',[[s.other.id,a.id,'1']],{command:taken});
 await assert.rejects(f.rpc('erp_stock_launch',{...args,p_command_id:taken}),fails('40001'));
 await assert.rejects(f.rpc('erp_stock_post',{p_user_id:f.users.estoque,p_command_id:command,p_kind:'receipt',p_occurred_on:'2026-10-15',p_reason:'Reuso sintético',p_items:[{product_id:product.id,warehouse_id:a.id,quantity:'1',expected_version:await f.version(product.id,a.id)}],p_reference:null}),fails('40001'),'the 009 engine refuses the launch UUID with another body');
 for(const table of['ledger_command','movement_detail','balance_count'])await assert.rejects(f.db.query(`delete from erp_stock.${table}`),error=>/immutable/.test(error.message),table);
});

test('105 extrato: Tipo Entrada/Saída/Balanço, prices and observação; totals skip balanços; Saldo atual skips ignored warehouses',async()=>{
 const {product,a,b}=s,m=s.movements;
 const page=await ledger();const byId=new Map(page.items.map(item=>[item.id,item]));
 const counted=byId.get(m.counted.movement.id);
 assert.deepEqual([counted.kind,counted.balance.counted,counted.balance.previous,counted.note,counted.unit_price,counted.revision,counted.price_source],['adjustment','5.000000','7.000000','ok','1.5000000000',1,'detail']);
 assert.equal(byId.get(m.issue.movement.id).unit_price,'2.0000000000');
 const directions={};for(const direction of['entry','exit','balance'])directions[direction]=(await ledger({p_direction:direction})).items.map(item=>item.id);
 assert.ok(directions.balance.includes(m.counted.movement.id)&&directions.balance.includes(m.zero.movement.id));
 assert.ok(!directions.entry.includes(m.counted.movement.id)&&!directions.exit.includes(m.counted.movement.id));
 assert.ok(directions.entry.includes(m.receipt.movement.id)&&directions.exit.includes(m.issue.movement.id));
 assert.ok(directions.entry.includes(m.transfer.movement.id)&&directions.exit.includes(m.transfer.movement.id),'a transfer in "Todos os depósitos" is both');
 assert.deepEqual((await ledger({p_direction:'entry',p_warehouse_id:a.id})).items.map(item=>item.id).includes(m.transfer.movement.id),false,'only the outgoing line at the origin');
 const all=await ledger({p_limit:100});
 const sum=(predicate)=>all.items.filter(item=>!item.balance).flatMap(item=>item.items).filter(predicate).reduce((total,line)=>total+Number(line.quantity),0);
 assert.equal(Number(all.totals.entries),sum(line=>Number(line.quantity)>0));assert.equal(Number(all.totals.exits),-sum(line=>Number(line.quantity)<0));
 const balances=(await f.rpc('erp_stock_balances',{p_user_id:f.users.vendas,p_product_id:product.id})).items;
 const considered=balances.filter(item=>!item.warehouse_ignored).reduce((total,item)=>total+Number(item.quantity),0);
 assert.equal(Number(all.totals.current_balance),considered);assert.notEqual(Number(all.totals.current_balance),balances.reduce((total,item)=>total+Number(item.quantity),0),'the ignored warehouse holds stock');
 assert.equal((await ledger({p_warehouse_id:b.id})).totals.current_balance,balances.find(item=>item.warehouse_id===b.id).quantity.replace(/(\.\d{6})$/,'$1'),'a filtered ignored warehouse shows its own balance');
 assert.deepEqual(balances.map(item=>[item.warehouse_name,item.warehouse_default,item.warehouse_ignored,item.reserved_quantity]).sort(),[['Arquivo',false,false,'0.000000'],['Avarias',false,true,'0.000000'],['Geral',true,false,'0.000000'],['Loja',false,false,'0.000000']]);
 await assert.rejects(ledger({p_direction:'balanço'}),fails('22023'));
 // SQL → HTTP → DTO: the worker accepts the real rows and keeps the decimals.
 const url=new URL(`https://api.example.test/v1/estoque/movimentos?product_id=${product.id}&offset=0&direction=balance`);
 const operation=await stockOperation(new Request(url),stockRoute(url.pathname),url.searchParams);
 const projected=stockResponse(await f.rpc(operation.rpc,{...operation.args,p_user_id:f.users.consulta}),stockRoute(url.pathname),operation);
 assert.ok(projected.items.every(item=>item.balance!==null));assert.equal(projected.filters.direction,'balance');
});

test('105 edição do lançamento: new immutable revision of prices and observação per product, with version and audit',async()=>{
 const {product}=s,m=s.movements,id=m.receipt.movement.id;
 const args={p_user_id:f.users.estoque,p_command_id:randomUUID(),p_movement_id:id,p_product_id:product.id,p_expected_revision:1,p_unit_price:'1.6',p_unit_cost:'1.8',p_note:' Compra corrigida '};
 const amended=await f.rpc('erp_stock_movement_amend',args);
 assert.deepEqual([amended.from.unit_price,amended.detail.revision,amended.detail.unit_price,amended.detail.note],['1.5000000000',2,'1.6000000000','Compra corrigida']);
 assert.equal((await f.rpc('erp_stock_movement_amend',args)).replayed,true);
 await assert.rejects(f.rpc('erp_stock_movement_amend',{...args,p_command_id:randomUUID()}),fails('40001'),'stale revision');
 await assert.rejects(f.rpc('erp_stock_movement_amend',{...args,p_command_id:randomUUID(),p_expected_revision:2,p_note:'Compra corrigida'}),fails('22023'),'nothing changed');
 await assert.rejects(f.rpc('erp_stock_movement_amend',{...args,p_command_id:randomUUID(),p_product_id:s.other.id,p_expected_revision:0}),fails('P0002'),'product not in the movement');
 await assert.rejects(f.rpc('erp_stock_movement_amend',{...args,p_user_id:f.users.consulta,p_command_id:randomUUID(),p_expected_revision:2}),fails('42501'));
 const row=(await ledger()).items.find(item=>item.id===id);assert.deepEqual([row.revision,row.unit_price,row.unit_cost,row.note],[2,'1.6000000000','1.8000000000','Compra corrigida']);
 assert.deepEqual(await f.scalar('select jsonb_agg(jsonb_build_array(revision,note,actor=$2) order by revision)v from erp_stock.movement_detail where movement_id=$1',[id,f.users.estoque]),[[1,'Lançamento manual',true],[2,'Compra corrigida',true]]);
 assert.equal(await f.scalar('select quantity::text v from erp_stock.entry where movement_id=$1',[id]),'10.000000','quantity, date and warehouse never change');
 // A legacy or document lançamento starts its first revision from expected revision 0.
 const legacy=(await f.post('receipt',[[product.id,s.a.id,'1']])).movement;
 const first=await f.rpc('erp_stock_movement_amend',{...args,p_command_id:randomUUID(),p_movement_id:legacy.id,p_expected_revision:0,p_unit_price:'3',p_unit_cost:'3',p_note:'Movimento sintético'});
 assert.deepEqual([first.from.revision,first.from.note,first.detail.revision],[0,'Movimento sintético',1]);
});

test('105 document prices, reservations and the totalizer without product',async()=>{
 const {product,other,a}=s;
 const sale=await f.order('sales_orders',[{product_id:product.id,description:'Linha sintética',unit:'UN',quantity:'1',unit_price:'7.25'},{product_id:other.id,description:'Outra linha',unit:'UN',quantity:'1',unit_price:'3'}],a.id);
 const preview=(await f.rpc('erp_stock_reservation_preview',{p_user_id:f.users.estoque,p_document_id:sale.id,p_expected_version:sale.version,p_action:'reserve',p_occurred_on:'2026-10-15',p_reason:'Reserva sintética',p_reservation_id:null,p_reservation_version:null})).preview;
 await f.rpc('erp_stock_reservation_apply',{p_user_id:f.users.estoque,p_document_id:sale.id,p_expected_version:sale.version,p_command_id:randomUUID(),p_action:'reserve',p_preview_hash:preview.preview_hash,p_occurred_on:'2026-10-15',p_reason:'Reserva sintética',p_ignored_item_ids:[],p_reservation_id:null,p_reservation_version:null});
 const reservations=await f.rpc('erp_stock_product_reservations',{p_user_id:f.users.fiscal,p_product_id:product.id,p_warehouse_id:null});
 assert.deepEqual([reservations.total,reservations.quantity,reservations.items[0].document_number,reservations.items[0].contact_name,reservations.items[0].status],[1,'1.000000',String(sale.number),'Contato sintético estoque','verified']);
 assert.equal((await f.rpc('erp_stock_balances',{p_user_id:f.users.vendas,p_product_id:product.id})).items.find(item=>item.warehouse_id===a.id).reserved_quantity,'1.000000');
 await assert.rejects(f.rpc('erp_stock_product_reservations',{p_user_id:f.users.financeiro,p_product_id:product.id,p_warehouse_id:null}),fails('42501'));
 const purchase=await f.order('purchase_orders',[{product_id:product.id,description:'Compra sintética',unit:'UN',quantity:'2',unit_price:'1.125'}],a.id);
 const p=(await f.rpc('erp_document_stock_preview',{p_user_id:f.users.estoque,p_kind:'purchase_orders',p_document_id:purchase.id,p_expected_version:purchase.version,p_occurred_on:'2026-10-15',p_reason:'Compra sintética'})).preview;
 const posted=await f.rpc('erp_document_stock_post',{p_user_id:f.users.estoque,p_kind:'purchase_orders',p_document_id:purchase.id,p_expected_version:purchase.version,p_command_id:randomUUID(),p_preview_hash:p.preview_hash,p_occurred_on:'2026-10-15',p_reason:'Compra sintética',p_ignored_item_ids:[]});
 const row=(await ledger()).items.find(item=>item.id===posted.movement.id);
 assert.deepEqual([row.unit_price,row.unit_cost,row.price_source,row.revision],['1.1250000000',null,'document',0]);
 // Purchase prices are purchase order data (008): vendas reads the extrato line and its origin, never the price.
 const asSeller=(await f.rpc('erp_stock_ledger',{p_user_id:f.users.vendas,p_product_id:product.id})).items.find(item=>item.id===posted.movement.id);
 assert.deepEqual([asSeller.unit_price,asSeller.unit_cost,asSeller.price_source,asSeller.origin.document_number],[null,null,null,String(purchase.number)]);
 const amended=await f.rpc('erp_stock_movement_amend',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_movement_id:posted.movement.id,p_product_id:product.id,p_expected_revision:0,p_unit_price:'1.2',p_unit_cost:'1.3',p_note:'Compra sintética'});
 assert.equal(amended.from.unit_price,'1.1250000000');
 const amendedForSeller=(await f.rpc('erp_stock_ledger',{p_user_id:f.users.vendas,p_product_id:product.id})).items.find(item=>item.id===posted.movement.id);
 assert.deepEqual([amendedForSeller.unit_price,amendedForSeller.unit_cost,amendedForSeller.price_source,amendedForSeller.revision,amendedForSeller.note],[null,null,'detail',1,'Compra sintética'],'an edited price of a purchase stays purchase data');
 assert.deepEqual(stockResponse(await f.rpc('erp_stock_ledger',{p_user_id:f.users.vendas,p_product_id:product.id,p_limit:100,p_offset:0}),{type:'movements'},
  {type:'ledger',args:{p_product_id:product.id,p_warehouse_id:null,p_kind:null,p_origin:null,p_date_from:null,p_date_to:null,p_limit:100,p_offset:0,p_direction:null}}).items.find(item=>item.id===posted.movement.id).unit_price,null,'the worker accepts the hidden price');
 const totals=await f.rpc('erp_stock_totals',{p_user_id:f.users.vendas,p_warehouse_id:null});
 const expected=await f.scalar("select jsonb_build_object('q',sum(b.quantity)::numeric(38,6)::text,'v',round(sum(b.quantity*p.price),2)::numeric(38,2)::text)v from erp_stock.balance b join erp_catalog.product p on p.record_id=b.product_id where not erp_stock.ignored_warehouse(b.warehouse_id)");
 assert.deepEqual([totals.quantity,totals.sale_value,totals.ignored_warehouses],[expected.q,expected.v,1]);
 assert.equal(totals.warehouses.filter(item=>item.is_default).map(item=>item.name).join(),'Geral');
 const onlyA=await f.rpc('erp_stock_totals',{p_user_id:f.users.vendas,p_warehouse_id:a.id});
 assert.equal(onlyA.quantity,await f.scalar('select sum(quantity)::numeric(38,6)::text v from erp_stock.balance where warehouse_id=$1',[a.id]));
 await assert.rejects(f.rpc('erp_stock_totals',{p_user_id:f.users.financeiro,p_warehouse_id:null}),fails('42501'));
 // SQL → HTTP → DTO for the launch and the totals.
 const launch=await http('/v1/estoque/lancamentos','POST',{command_id:randomUUID(),kind:'receipt',product_id:product.id,warehouse_id:a.id,quantity:'1',expected_version:await f.version(product.id,a.id),unit_price:'1',unit_cost:'1'});
 const projected=stockResponse(await f.rpc(launch.operation.rpc,{...launch.operation.args,p_user_id:f.users.estoque}),launch.route,launch.operation);
 assert.equal(projected.movement.items[0].quantity,'1.000000');assert.equal(projected.detail.note,'Lançamento manual');
});

test('105 document prices follow the document readers: estoque posts a service order but never reads or edits its prices',async()=>{
 const {product,a}=s;await f.launch(product.id,a.id,'receipt','5');
 const service=await f.order('service_orders',[{product_id:product.id,description:'Peça sintética',unit:'UN',quantity:'1',unit_price:'9.5'}],a.id,['quoted','approved']);
 const p=(await f.rpc('erp_document_stock_preview',{p_user_id:f.users.estoque,p_kind:'service_orders',p_document_id:service.id,p_expected_version:service.version,p_occurred_on:'2026-10-15',p_reason:'OS sintética'})).preview;
 const posted=await f.rpc('erp_document_stock_post',{p_user_id:f.users.estoque,p_kind:'service_orders',p_document_id:service.id,p_expected_version:service.version,p_command_id:randomUUID(),p_preview_hash:p.preview_hash,p_occurred_on:'2026-10-15',p_reason:'OS sintética',p_ignored_item_ids:[]});
 const view=async role=>(await f.rpc('erp_stock_ledger',{p_user_id:f.users[role],p_product_id:product.id})).items.find(item=>item.id===posted.movement.id);
 for(const role of['admin','consulta','vendas'])assert.deepEqual([(await view(role)).unit_price,(await view(role)).price_source],['9.5000000000','document'],role);
 for(const role of['estoque','fiscal'])assert.deepEqual([(await view(role)).unit_price,(await view(role)).price_source,(await view(role)).origin.document_kind],[null,null,'service_orders'],role);
 const amend=user=>f.rpc('erp_stock_movement_amend',{p_user_id:user,p_command_id:randomUUID(),p_movement_id:posted.movement.id,p_product_id:product.id,p_expected_revision:0,p_unit_price:'1',p_unit_cost:null,p_note:'OS sintética editada'});
 await assert.rejects(amend(f.users.estoque),fails('42501'),'estoque does not read service orders');
 assert.equal((await amend(f.users.admin)).detail.unit_price,'1.0000000000');
 assert.deepEqual([(await view('estoque')).unit_price,(await view('estoque')).note],[null,'OS sintética editada']);
});
