import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockOriginFixture,fails} from './helpers/stock-origin-fixture.mjs';
import {stockRoute,stockOperation,stockResponse} from '../src/stock.mjs';

// Migration 106: Conferência de estoque and "Gerar balanço" (PGlite, synthetic data only).
let f,s;
const PUBLIC=['erp_stock_count_get(uuid)','erp_stock_count_read(uuid,uuid,uuid,text,text,uuid)','erp_stock_count_delete(uuid,uuid,uuid,uuid)','erp_stock_count_warehouse(uuid,uuid,uuid,integer,uuid)',
 'erp_stock_count_restart(uuid,uuid,uuid,integer)','erp_stock_count_balance(uuid,uuid,uuid,integer,text,boolean)'];
const read=(code,quantity='1',extra={})=>f.rpc('erp_stock_count_read',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_session_id:null,p_code:code,p_quantity:quantity,p_warehouse_id:s.a.id,...extra});
const current=(user=f.users.estoque)=>f.rpc('erp_stock_count_get',{p_user_id:user});
const http=async(path,body)=>{const url=new URL(`https://api.example.test${path}`),route=stockRoute(url.pathname);const request=body===undefined?new Request(url):new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const operation=await stockOperation(request,route,url.searchParams);return stockResponse(await f.rpc(operation.rpc,{...operation.args,p_user_id:f.users.estoque}),route,operation);};

test.before(async()=>{
 f=await stockOriginFixture();
 const pen=await f.catalog('products',{name:'Caneta sintética',code:'CAN-1',unit:'UN',kind:'P',format:'S',price:'2',gtin:'7891234567895',gtin_tax:'17891234567892',location:'A1'});
 const pencil=await f.catalog('products',{name:'Lápis sintético',code:'LAP-1',unit:'UN',kind:'P',format:'S',price:'1'});
 const service=await f.catalog('products',{name:'Serviço sintético',code:'SRV-1',unit:'UN',kind:'S',format:'S',price:'1'});
 const kit=await f.catalog('products',{name:'Kit sintético',code:'KIT-1',unit:'UN',kind:'P',format:'E',price:'1'});
 const idle=await f.catalog('products',{name:'Borracha parada',code:'BOR-1',unit:'UN',kind:'P',format:'S',price:'1'});
 const a=await f.warehouse('Geral'),b=await f.warehouse('Loja');
 await f.launch(pencil.id,a.id,'receipt','7');await f.launch(idle.id,a.id,'receipt','4');await f.launch(pen.id,b.id,'receipt','9');
 s={pen,pencil,service,kit,idle,a,b};
});
test.after(async()=>f?.close());

test('106 grants and roles: only service_role runs the RPCs; only admin and estoque count stock',async()=>{
 for(const role of['anon','authenticated','service_role'])for(const fn of PUBLIC)assert.equal(await f.scalar('select has_function_privilege($1,$2,\'execute\')v',[role,`public.${fn}`]),role==='service_role',`${role} ${fn}`);
 for(const fn of PUBLIC)assert.deepEqual(await f.scalar("select jsonb_build_object('definer',prosecdef,'config',proconfig)v from pg_proc where oid=$1::regprocedure",[`public.${fn}`]),{definer:true,config:['search_path=pg_catalog']},fn);
 for(const table of['count_session','count_reading','count_command'])for(const role of['anon','authenticated','service_role'])assert.equal(await f.scalar("select has_table_privilege($1,$2,'select')v",[role,`erp_stock.${table}`]),false);
 for(const role of['consulta','vendas','fiscal','financeiro']){await assert.rejects(current(f.users[role]),fails('42501'),role);await assert.rejects(read('CAN-1','1',{p_user_id:f.users[role]}),fails('42501'),role);}
 assert.equal((await current()).count,null,'nothing is created by a GET');
});

test('106 Leitura: GTIN, GTIN tributário or SKU, multiplied by "Quantidade a ser lida"; Origin refusals record nothing',async()=>{
 const first=await read('7891234567895','3');
 assert.equal(first.outcome,'read');assert.equal(first.count.session.warehouse_name,'Geral');assert.equal(first.count.items[0].counted,'3.000000');
 s.session=first.count.session;
 assert.equal((await read('17891234567892','1',{p_session_id:s.session.id})).count.total_read,'4.000000');
 const sku=await read(' can-1 ','0.5',{p_session_id:s.session.id});assert.equal(sku.count.items.find(item=>item.product_id===s.pen.id).counted,'4.500000');
 assert.deepEqual(sku.count.items.find(item=>item.product_id===s.pen.id).location,'A1');
 const pencil=await read('LAP-1','5',{p_session_id:s.session.id});
 const row=pencil.count.items.find(item=>item.product_id===s.pencil.id);assert.deepEqual([row.counted,row.physical,row.difference],['5.000000','7.000000','-2.000000']);
 const before=await f.scalar('select count(*)::int v from erp_stock.count_reading');
 for(const [code,quantity,reason]of[['NAO-EXISTE','1','not_found'],['SRV-1','1','invalid_kind'],['KIT-1','1','invalid_format'],['CAN-1','0','invalid_quantity'],['CAN-1','1,5','invalid_quantity'],['CAN-1','-1','invalid_quantity']])
  assert.equal((await read(code,quantity,{p_session_id:s.session.id})).reason,reason,code);
 assert.equal(await f.scalar('select count(*)::int v from erp_stock.count_reading'),before);
 await assert.rejects(read('CAN-1','1',{p_session_id:randomUUID()}),fails('40001'),'another session id');
 const restored=(await current()).count;assert.equal(restored.session.id,s.session.id,'the open count is restored');assert.equal(restored.readings,4);assert.equal(restored.log[0].code,'LAP-1');
 assert.equal(restored.log[0].recorded_at_local.length,19);
 // Replay: the same command returns its stored answer and never reads twice.
 const command=randomUUID(),args={p_user_id:f.users.estoque,p_command_id:command,p_session_id:s.session.id,p_code:'LAP-1',p_quantity:'1',p_warehouse_id:s.a.id};
 await f.rpc('erp_stock_count_read',args);assert.equal((await f.rpc('erp_stock_count_read',args)).replayed,true);
 await assert.rejects(f.rpc('erp_stock_count_read',{...args,p_quantity:'2'}),fails('40001'));
 assert.equal((await current()).count.items.find(item=>item.product_id===s.pencil.id).counted,'6.000000');
});

test('106 excluir leitura, depósito and reiniciar: marked with actor and command, never deleted; versions protect concurrent screens',async()=>{
 const deleted=await f.rpc('erp_stock_count_delete',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_session_id:s.session.id,p_product_id:s.pencil.id});
 assert.equal(deleted.deleted_readings,2);assert.equal(deleted.count.items.some(item=>item.product_id===s.pencil.id),false);
 assert.equal(await f.scalar('select count(*)::int v from erp_stock.count_reading where product_id=$1 and deleted_at is not null',[s.pencil.id]),2);
 await assert.rejects(f.rpc('erp_stock_count_delete',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_session_id:s.session.id,p_product_id:s.pencil.id}),fails('P0002'));
 await assert.rejects(f.db.query('delete from erp_stock.count_reading'),error=>/immutable/.test(error.message));
 await assert.rejects(f.db.query('update erp_stock.count_reading set quantity=1'),error=>/immutable/.test(error.message));
 const all=await f.rpc('erp_stock_count_warehouse',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_session_id:s.session.id,p_expected_version:1,p_warehouse_id:null});
 assert.equal(all.count.session.version,2);assert.equal(all.count.items.find(item=>item.product_id===s.pen.id).physical,'9.000000','"Todos" sums the considered warehouses');
 await assert.rejects(f.rpc('erp_stock_count_warehouse',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_session_id:s.session.id,p_expected_version:1,p_warehouse_id:s.a.id}),fails('40001'));
 // Gerar balanço needs one warehouse.
 await assert.rejects(f.rpc('erp_stock_count_balance',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_session_id:s.session.id,p_expected_version:2,p_scope:'counted',p_confirmed:false}),fails('22023'));
 await f.rpc('erp_stock_count_warehouse',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_session_id:s.session.id,p_expected_version:2,p_warehouse_id:s.a.id});
 // Reiniciar keeps the old session as history and starts an empty one in the same warehouse.
 const other=await read('BOR-1','1',{p_user_id:f.users.admin});assert.notEqual(other.count.session.id,s.session.id,'one open count per user');
 const restarted=await f.rpc('erp_stock_count_restart',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_session_id:other.count.session.id,p_expected_version:1});
 assert.deepEqual([restarted.discarded_readings,restarted.count.readings,restarted.count.session.warehouse_id],[1,0,s.a.id]);
 assert.equal(await f.scalar("select state v from erp_stock.count_session where id=$1",[other.count.session.id]),'restarted');
 await assert.rejects(f.rpc('erp_stock_count_balance',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_session_id:restarted.count.session.id,p_expected_version:1,p_scope:'counted',p_confirmed:false}),fails('22023'),'"Nenhuma leitura foi efetuada."');
});

test('106 Gerar balanço "Apenas produtos conferidos": one Balanço per changed product, reserved positions protected, all or nothing',async()=>{
 const before=await f.scalar('select count(*)::int v from erp_stock.movement');
 const command=randomUUID(),args={p_user_id:f.users.estoque,p_command_id:command,p_session_id:s.session.id,p_expected_version:3,p_scope:'counted',p_confirmed:false};
 const done=await f.rpc('erp_stock_count_balance',args);
 assert.deepEqual(done.changed.map(item=>[item.name,item.previous,item.counted]),[['Caneta sintética','0.000000','4.500000']]);assert.equal(done.unchanged,0);
 assert.equal(await f.balance(s.pen.id,s.a.id),'4.500000');assert.equal(await f.balance(s.pencil.id,s.a.id),'7.000000','deleted readings never count');
 assert.equal(await f.scalar('select count(*)::int v from erp_stock.movement'),before+1);
 const ledger=await f.rpc('erp_stock_ledger',{p_user_id:f.users.consulta,p_product_id:s.pen.id,p_direction:'balance'});
 assert.deepEqual([ledger.items[0].balance.source,ledger.items[0].balance.counted,ledger.items[0].reason],['count','4.500000','Balanço (conferência de estoque)']);
 assert.equal((await f.rpc('erp_stock_count_balance',args)).replayed,true);assert.equal(await f.scalar('select count(*)::int v from erp_stock.movement'),before+1);
 assert.equal((await current()).count,null,'the count is closed');
 await assert.rejects(f.rpc('erp_stock_count_balance',{...args,p_command_id:randomUUID()}),fails('40001'));
 // A reserved position is never balanced below its reservation.
 const sale=await f.order('sales_orders',[{product_id:s.idle.id,description:'Linha sintética',unit:'UN',quantity:'3',unit_price:'1'}],s.a.id);
 const preview=(await f.rpc('erp_stock_reservation_preview',{p_user_id:f.users.estoque,p_document_id:sale.id,p_expected_version:sale.version,p_action:'reserve',p_occurred_on:'2026-10-15',p_reason:'Reserva sintética',p_reservation_id:null,p_reservation_version:null})).preview;
 await f.rpc('erp_stock_reservation_apply',{p_user_id:f.users.estoque,p_document_id:sale.id,p_expected_version:sale.version,p_command_id:randomUUID(),p_action:'reserve',p_preview_hash:preview.preview_hash,p_occurred_on:'2026-10-15',p_reason:'Reserva sintética',p_ignored_item_ids:[],p_reservation_id:null,p_reservation_version:null});
 const next=await read('BOR-1','1');
 const reserved=await f.rpc('erp_stock_count_balance',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_session_id:next.count.session.id,p_expected_version:1,p_scope:'counted',p_confirmed:false});
 assert.deepEqual(reserved.skipped.map(item=>[item.name,item.reason]),[['Borracha parada','reserved']]);assert.equal(await f.balance(s.idle.id,s.a.id),'4.000000');
});

test('106 Gerar balanço "Todos os produtos ativos": the confirmation is required and every unread active product is zeroed',async()=>{
 const counted=await read('LAP-1','2');const session=counted.count.session;
 await assert.rejects(f.rpc('erp_stock_count_balance',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_session_id:session.id,p_expected_version:1,p_scope:'all_active',p_confirmed:false}),fails('22023'),'"Estou ciente…" is required');
 const done=await f.rpc('erp_stock_count_balance',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_session_id:session.id,p_expected_version:1,p_scope:'all_active',p_confirmed:true});
 assert.deepEqual(done.changed.map(item=>[item.name,item.counted]).sort(),[['Caneta sintética','0.000000'],['Lápis sintético','2.000000']]);
 assert.deepEqual(done.skipped.map(item=>[item.name,item.reason]),[['Borracha parada','reserved']],'the reserved product stays reserved');
 assert.equal(await f.balance(s.pen.id,s.a.id),'0.000000');assert.equal(await f.balance(s.pen.id,s.b.id),'9.000000','other warehouses untouched');
 // SQL → HTTP → DTO for the count contract.
 const empty=await http('/v1/estoque/conferencias/atual');assert.equal(empty.count,null);
 const http1=await http('/v1/estoque/conferencias/leituras',{command_id:randomUUID(),session_id:null,code:'CAN-1',quantity:'2',warehouse_id:s.a.id});
 assert.equal(http1.outcome,'read');assert.equal(http1.count.items[0].difference,'2.000000');
 const rejected=await http('/v1/estoque/conferencias/leituras',{command_id:randomUUID(),session_id:http1.session_id,code:'NADA',quantity:'1',warehouse_id:s.a.id});
 assert.deepEqual([rejected.outcome,rejected.reason],['rejected','not_found']);
 const balanced=await http(`/v1/estoque/conferencias/${http1.session_id}/balanco`,{command_id:randomUUID(),expected_version:1,scope:'counted',confirmed:false});
 assert.equal(balanced.changed[0].counted,'2.000000');
});
