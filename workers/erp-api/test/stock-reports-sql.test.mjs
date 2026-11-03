import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneFixture,fails} from './helpers/stock-lane-b-fixture.mjs';
import {stockRoute,stockOperation,stockResponse} from '../src/stock.mjs';

// 146 on PGlite with synthetic data only: the supply reports of Origin over the Brufap ledger, purchase orders and entry notes.
let f,s,today;
const REPORTS=['erp_stock_report_movements(uuid,date,date,uuid,uuid,integer,integer)','erp_stock_report_transfers(uuid,date,date,uuid,integer,integer)','erp_stock_report_balances_at(uuid,date,uuid,integer,integer)',
 'erp_stock_report_top(uuid,date,date,uuid,integer)','erp_stock_report_idle(uuid,date,uuid,integer,integer)','erp_stock_report_below_min(uuid,uuid,integer,integer)','erp_stock_report_financial(uuid,uuid,integer,integer)',
 'erp_stock_report_product(uuid,uuid,date,date,uuid)','erp_stock_report_purchase_orders(uuid,date,date,jsonb,text)','erp_stock_report_entry_notes(uuid,date,date,text)'];
before(async()=>{
 f=await stockLaneFixture({upto:2});today=await f.scalar("select (clock_timestamp() at time zone 'America/Sao_Paulo')::date::text v");
 const A=await f.warehouse('Depósito A'),B=await f.warehouse('Depósito B'),X=await f.warehouse('Depósito avarias',true);
 const P=await f.product('Produto relatório P',{stock_min:'20'}),Q=await f.product('Produto relatório Q',{price:'5'}),R=await f.product('Produto relatório R',{stock_min:'1'}),S=await f.product('Produto relatório S');
 await f.post('receipt',[[P.id,A.id,'10']],{day:'2026-10-01'});await f.post('receipt',[[S.id,A.id,'2']],{day:'2026-10-01'});await f.post('receipt',[[Q.id,B.id,'4']],{day:'2026-10-02'});
 await f.post('issue',[[P.id,A.id,'-3']],{day:'2026-10-05'});
 await f.post('transfer',[[P.id,A.id,'-2'],[P.id,B.id,'2']],{day:'2026-10-06'});await f.post('transfer',[[P.id,A.id,'-1'],[P.id,X.id,'1']],{day:'2026-10-07'});
 await f.launch(P.id,B.id,'balance','5',{price:'6',cost:'6'});await f.launch(Q.id,B.id,'issue','1',{price:'5'});
 s={A,B,X,P,Q,R,S};
});
after(()=>f?.close());
const call=(name,args,user=f.users.consulta)=>f.rpc(name,{p_user_id:user,...args});

test('146 reports are SECURITY DEFINER for service_role only; profiles follow stock, purchase and fiscal reading',async()=>{
 for(const signature of REPORTS.map(r=>`public.${r}`)){
  for(const role of['anon','authenticated','public'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,[signature]),false,signature);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",[signature]),true,signature);
  assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure',[signature]),true,signature);
 }
 await assert.rejects(call('erp_stock_report_movements',{p_date_from:'2026-10-01',p_date_to:today,p_warehouse_id:null,p_product_id:null,p_offset:0,p_limit:500},f.users.financeiro),fails('42501'));
 await assert.rejects(call('erp_stock_report_financial',{p_warehouse_id:null,p_offset:0,p_limit:500},f.users.vendas),fails('42501'),'custo médio is purchase data');
 await assert.rejects(call('erp_stock_report_purchase_orders',{p_date_from:'2026-10-01',p_date_to:today,p_statuses:['open'],p_group:'supplier'},f.users.vendas),fails('42501'));
 assert.ok(await call('erp_stock_report_purchase_orders',{p_date_from:'2026-10-01',p_date_to:today,p_statuses:['open'],p_group:'supplier'},f.users.financeiro),'financeiro reads purchase orders');
 for(const user of[f.users.consulta,f.users.vendas,f.users.estoque])await assert.rejects(call('erp_stock_report_entry_notes',{p_date_from:'2026-10-01',p_date_to:today,p_group:'month'},user),fails('42501'));
 for(const args of[{p_date_from:'2026-10-05',p_date_to:'2026-10-01'},{p_date_from:'1890-01-01',p_date_to:'2026-10-01'},{p_date_from:'2016-01-01',p_date_to:'2026-10-01'}])
  await assert.rejects(call('erp_stock_report_movements',{...args,p_warehouse_id:null,p_product_id:null,p_offset:0,p_limit:500}),fails('22023'));
 await assert.rejects(call('erp_stock_report_movements',{p_date_from:'2026-10-01',p_date_to:today,p_warehouse_id:null,p_product_id:null,p_offset:0,p_limit:501}),fails('22023'));
 await assert.rejects(call('erp_stock_report_movements',{p_date_from:'2026-10-01',p_date_to:today,p_warehouse_id:randomUUID(),p_product_id:null,p_offset:0,p_limit:500}),fails('P0002'));
});

test('146 Entradas e Saídas: transfers between considered warehouses cancel out, to an ignored one they leave; Balanço apart',async()=>{
 const run=warehouse=>call('erp_stock_report_movements',{p_date_from:'2026-10-01',p_date_to:today,p_warehouse_id:warehouse,p_product_id:null,p_offset:0,p_limit:500});
 const all=await run(null),row=name=>all.items.find(i=>i.name===name);
 assert.deepEqual([row('Produto relatório P').entries,row('Produto relatório P').exits,row('Produto relatório P').balances,row('Produto relatório P').net,row('Produto relatório P').launches],['10.000000','4.000000','3.000000','9.000000',4]);
 assert.deepEqual([row('Produto relatório Q').entries,row('Produto relatório Q').exits,row('Produto relatório Q').net],['4.000000','1.000000','3.000000']);
 assert.deepEqual(all.totals,{entries:'16.000000',exits:'5.000000',balances:'3.000000',net:'14.000000'});
 const a=(await run(s.A.id)).items.find(i=>i.name==='Produto relatório P');
 assert.deepEqual([a.entries,a.exits,a.balances,a.net],['10.000000','6.000000','0.000000','4.000000'],'in Depósito A both transfers are exits');
 const transfers=await call('erp_stock_report_transfers',{p_date_from:'2026-10-01',p_date_to:today,p_warehouse_id:null,p_offset:0,p_limit:500});
 assert.deepEqual(transfers.items.map(t=>[t.occurred_on,t.quantity,t.source_name,t.destination_name,t.reversed]),[['2026-10-07','1.000000','Depósito A','Depósito avarias',false],['2026-10-06','2.000000','Depósito A','Depósito B',false]]);
 assert.equal((await call('erp_stock_report_transfers',{p_date_from:'2026-10-01',p_date_to:today,p_warehouse_id:s.B.id,p_offset:0,p_limit:500})).total,1);
});

test('146 Saldos em uma data, Maior Circulação, Sem Movimentação and Abaixo do Estoque Mínimo',async()=>{
 const at=async date=>Object.fromEntries((await call('erp_stock_report_balances_at',{p_date:date,p_warehouse_id:null,p_offset:0,p_limit:500})).items.map(i=>[i.name,i.quantity]));
 assert.deepEqual(await at('2026-10-05'),{'Produto relatório P':'7.000000','Produto relatório Q':'4.000000','Produto relatório S':'2.000000'});
 assert.equal((await at('2026-10-07'))['Produto relatório P'],'6.000000','the transfer to the ignored warehouse leaves the considered stock');
 assert.equal((await at(today))['Produto relatório P'],'9.000000');
 assert.deepEqual(await at('2026-09-30'),{});
 const top=await call('erp_stock_report_top',{p_date_from:'2026-10-01',p_date_to:today,p_warehouse_id:null,p_limit:2});
 assert.deepEqual([top.total,top.items.map(i=>[i.name,i.moved])],[3,[['Produto relatório P','14.000000'],['Produto relatório Q','5.000000']]]);
 const idle=await call('erp_stock_report_idle',{p_since:'2026-10-03',p_warehouse_id:null,p_offset:0,p_limit:500});
 assert.deepEqual(idle.items.map(i=>[i.name,i.quantity,i.last_movement]),[['Produto relatório S','2.000000','2026-10-01']]);
 const below=await call('erp_stock_report_below_min',{p_warehouse_id:null,p_offset:0,p_limit:500});
 assert.deepEqual(below.items.filter(i=>i.name.startsWith('Produto relatório')).map(i=>[i.name,i.stock_min,i.quantity,i.missing]),[['Produto relatório P','20.000000','9.000000','11.000000'],['Produto relatório R','1.000000','0.000000','1.000000']]);
 assert.equal((await call('erp_stock_report_below_min',{p_warehouse_id:s.B.id,p_offset:0,p_limit:500})).items.find(i=>i.name==='Produto relatório P').quantity,'5.000000');
});

test('146 Visão Financeira and Movimentação de um Produto reconcile with the ledger',async()=>{
 const fin=await call('erp_stock_report_financial',{p_warehouse_id:null,p_offset:0,p_limit:500},f.users.estoque);
 const row=name=>fin.items.find(i=>i.name===name);
 assert.deepEqual([row('Produto relatório P').quantity,row('Produto relatório P').average_cost,row('Produto relatório P').cost_value,row('Produto relatório P').sale_value,row('Produto relatório P').margin],
  ['9.000000','6.0000000000','54.00','90.00','36.00'],'the first priced entry (the Balanço at 6) sets the average');
 assert.deepEqual([row('Produto relatório Q').cost_value,row('Produto relatório Q').sale_value,row('Produto relatório Q').margin],[null,'15.00',null]);
 assert.deepEqual(fin.totals,{quantity:'14.000000',cost_value:'54.00',sale_value:'125.00',margin:'36.00',uncosted:2,unpriced:0});
 const movement=await call('erp_stock_report_product',{p_product_id:s.P.id,p_date_from:'2026-10-01',p_date_to:today,p_warehouse_id:null});
 assert.deepEqual([movement.opening,movement.days.map(d=>[d.date,d.entries,d.exits,d.balance]),movement.closing,movement.totals],
  ['0.000000',[['2026-10-01','10.000000','0.000000','10.000000'],['2026-10-05','0.000000','3.000000','7.000000'],['2026-10-07','0.000000','1.000000','6.000000'],[today,'3.000000','0.000000','9.000000']],'9.000000',{entries:'13.000000',exits:'4.000000'}]);
 const later=await call('erp_stock_report_product',{p_product_id:s.P.id,p_date_from:'2026-10-05',p_date_to:today,p_warehouse_id:s.A.id});
 assert.deepEqual([later.opening,later.days.map(d=>d.balance),later.closing],['10.000000',['7.000000','5.000000','4.000000'],'4.000000']);
 await assert.rejects(call('erp_stock_report_product',{p_product_id:randomUUID(),p_date_from:'2026-10-01',p_date_to:today,p_warehouse_id:null}),fails('P0002'));
});

test('146 Pedidos de Compras by supplier or product, and Notas de Entrada by operation, supplier, product and month',async()=>{
 const other=await f.catalog('contacts',{name:'Fornecedor relatório B'});
 await f.order('purchase_orders',[f.item(s.P,'2','1.5'),f.item(s.Q,'1','2')],s.A.id,['in_progress'],{date:'2026-10-10'});
 await f.order('purchase_orders',[f.item(s.P,'5','1')],s.A.id,['in_progress'],{date:'2026-10-11',contact_id:other.id});
 await f.order('purchase_orders',[f.item(s.P,'9','1')],s.A.id,['in_progress','cancelled'],{date:'2026-10-11'});
 const bySupplier=await call('erp_stock_report_purchase_orders',{p_date_from:'2026-10-01',p_date_to:today,p_statuses:['in_progress'],p_group:'supplier'},f.users.estoque);
 assert.deepEqual(bySupplier.items.map(i=>[i.label,i.orders,i.quantity,i.value]),[['Contato sintético B',1,'3.000000','5.00'],['Fornecedor relatório B',1,'5.000000','5.00']]);
 assert.deepEqual(bySupplier.totals,{orders:2,quantity:'8.000000',value:'10.00'});
 const byProduct=await call('erp_stock_report_purchase_orders',{p_date_from:'2026-10-01',p_date_to:today,p_statuses:['in_progress','cancelled'],p_group:'product'},f.users.estoque);
 assert.deepEqual(byProduct.items.map(i=>[i.label,i.orders,i.quantity,i.value]),[['Produto relatório P',3,'16.000000','17.00'],['Produto relatório Q',1,'1.000000','2.00']]);
 await assert.rejects(call('erp_stock_report_purchase_orders',{p_date_from:'2026-10-01',p_date_to:today,p_statuses:['open'],p_group:'month'}),fails('22023'));
 await assert.rejects(call('erp_stock_report_purchase_orders',{p_date_from:'2026-10-01',p_date_to:today,p_statuses:[],p_group:'product'}),fails('22023'));
 // Native entry notes (112).
 await f.db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,'{\"state\":\"SP\",\"cnpj\":\"11222333000181\"}',$1)",[f.users.admin]);
 await f.db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1)",[f.users.admin]);
 const nature=(await f.rpc('erp_fiscal_nature_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'create',p_data:{nature:{description:'Compra para revenda',direction:'0',crt:'1',presence:'9'}}})).nature;
 const note=async(product,quantity,price,document,number)=>(await f.rpc('erp_fiscal_invoice_execute',{p_user_id:f.users.fiscal,p_command_id:randomUUID(),p_action:'create',p_data:{invoice:{model:'55',direction:'0',issue_type:'T',series:'1',number,
  nature_id:nature.id,issue_date:'2026-10-12',crt:'1',purpose:'1',presence:'9',final_consumer:false,recipient:{name:`Fornecedor ${document.slice(0,4)}`,person_type:'J',document,state:'SP'},
  items:[{product_id:product.id,description:product.name,unit:'UN',quantity,unit_price:price,ncm:'84713012',cfop:'1102',icms:{origin:'0',situation:'102'},pis:{situation:'49'},cofins:{situation:'49'}}]}}})).invoice;
 await note(s.P,'2','50','12345678000190','9001');await note(s.Q,'1','50','11222333000181','9002');
 const deleted=await note(s.Q,'1','70','11222333000181','9003');
 await f.rpc('erp_fiscal_invoice_execute',{p_user_id:f.users.fiscal,p_command_id:randomUUID(),p_action:'delete',p_data:{id:deleted.id,expected_version:deleted.version,reason:'Nota sintética excluída'}});
 const notes=group=>call('erp_stock_report_entry_notes',{p_date_from:'2026-10-01',p_date_to:today,p_group:group},f.users.fiscal);
 assert.deepEqual((await notes('month')).items.map(i=>[i.label,i.notes,i.value]),[['10/2026',2,'150.00']]);
 assert.deepEqual((await notes('nature')).items.map(i=>[i.label,i.notes,i.value]),[['Compra para revenda',2,'150.00']]);
 assert.deepEqual((await notes('supplier')).items.map(i=>[i.code,i.notes,i.value]).sort(),[['11222333000181',1,'50.00'],['12345678000190',1,'100.00']]);
 assert.deepEqual((await notes('product')).items.map(i=>[i.label,i.quantity,i.value]),[['Produto relatório P','2.0000','100.00'],['Produto relatório Q','1.0000','50.00']]);
 assert.deepEqual((await notes('month')).totals,{notes:2,value:'150.00'});
});

test('146 grouped reports keep one row per supplier and product even when the snapshots differ',async()=>{
 // A contact renamed between two purchase orders keeps one supplier row (the documents keep the old snapshot).
 const contact=await f.catalog('contacts',{name:'Fornecedor renomeado'});
 await f.order('purchase_orders',[f.item(s.S,'1','3')],s.A.id,['in_progress'],{date:'2026-09-10',contact_id:contact.id});
 const renamed=await f.rpc('erp_catalog_save',{p_user_id:f.users.admin,p_entity:'contacts',p_id:contact.id,p_expected_version:contact.version,p_command_id:randomUUID(),p_data:{name:'Fornecedor renomeado Ltda'}});
 assert.equal(renamed.record.name,'Fornecedor renomeado Ltda');
 await f.order('purchase_orders',[f.item(s.S,'2','3')],s.A.id,['in_progress'],{date:'2026-09-11',contact_id:contact.id});
 const orders=await call('erp_stock_report_purchase_orders',{p_date_from:'2026-09-01',p_date_to:'2026-09-30',p_statuses:['in_progress'],p_group:'supplier'},f.users.estoque);
 assert.deepEqual(orders.items.map(i=>[i.key,i.orders,i.quantity,i.value]),[[contact.id,2,'3.000000','9.00']]);
 assert.equal(orders.items[0].label,'Fornecedor renomeado Ltda','the current name of the contact');
 // The same CNPJ with two names and the same product with two descriptions in the notes (112).
 await f.db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,'{\"state\":\"SP\",\"cnpj\":\"11222333000181\"}',$1) on conflict do nothing",[f.users.admin]);
 await f.db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1) on conflict do nothing",[f.users.admin]);
 const nature=(await f.rpc('erp_fiscal_nature_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'create',p_data:{nature:{description:'Compra de setembro',direction:'0',crt:'1',presence:'9'}}})).nature;
 const note=(name,description,number)=>f.rpc('erp_fiscal_invoice_execute',{p_user_id:f.users.fiscal,p_command_id:randomUUID(),p_action:'create',p_data:{invoice:{model:'55',direction:'0',issue_type:'T',series:'1',number,
  nature_id:nature.id,issue_date:'2026-09-12',crt:'1',purpose:'1',presence:'9',final_consumer:false,recipient:{name,person_type:'J',document:'33444555000166',state:'SP'},
  items:[{product_id:s.S.id,description,unit:'UN',quantity:'1',unit_price:'20',ncm:'84713012',cfop:'1102',icms:{origin:'0',situation:'102'},pis:{situation:'49'},cofins:{situation:'49'}}]}}});
 await note('Fornecedor Alfa','Peça do fornecedor','9101');await note('Fornecedor Alfa Ltda','PECA FORNECEDOR CX','9102');
 const notes=group=>call('erp_stock_report_entry_notes',{p_date_from:'2026-09-01',p_date_to:'2026-09-30',p_group:group},f.users.fiscal);
 assert.deepEqual((await notes('supplier')).items.map(i=>[i.key,i.code,i.notes,i.value]),[['33444555000166','33444555000166',2,'40.00']]);
 assert.deepEqual((await notes('product')).items.map(i=>[i.key,i.label,i.notes,i.quantity,i.value]),[[s.S.id,'Produto relatório S',2,'2.0000','40.00']]);
 // The strict projection of the worker accepts them (it refuses repeated keys).
 for(const[path,user]of[['pedidos-compra?de=2026-09-01&ate=2026-09-30&situacoes=in_progress&agrupar=fornecedor',f.users.estoque],
  ['notas-entrada?de=2026-09-01&ate=2026-09-30&agrupar=fornecedor',f.users.fiscal],['notas-entrada?de=2026-09-01&ate=2026-09-30&agrupar=produto',f.users.fiscal]]){
  const req=new Request(`https://api.example.test/v1/estoque/relatorios/${path}`),url=new URL(req.url),route=stockRoute(url.pathname),op=await stockOperation(req,route,url.searchParams);
  assert.equal(stockResponse(await f.rpc(op.rpc,{p_user_id:user,...op.args}),route,op).items.length,1,path);
 }
});

test('146 SQL → HTTP → DTO: every report answer passes the strict projection of the worker',async()=>{
 const project=async path=>{const req=new Request(`https://api.example.test/v1/estoque/relatorios/${path}`),url=new URL(req.url),route=stockRoute(url.pathname);
  const op=await stockOperation(req,route,url.searchParams);return stockResponse(await f.rpc(op.rpc,{p_user_id:f.users.admin,...op.args}),route,op);};
 const period=`de=2026-10-01&ate=${today}`;
 for(const path of[`entradas-saidas?${period}`,`entradas-saidas?${period}&warehouse_id=${s.A.id}`,`transferencias?${period}`,`saldos?data=2026-10-07`,`maior-circulacao?${period}&limite=2`,
  'sem-movimentacao?data=2026-10-03','abaixo-minimo',`abaixo-minimo?warehouse_id=${s.B.id}`,'visao-financeira',`movimentacao-produto?product_id=${s.P.id}&${period}`,
  `movimentacao-produto?product_id=${s.P.id}&de=2026-10-05&ate=${today}&warehouse_id=${s.A.id}`,`pedidos-compra?${period}&situacoes=in_progress,cancelled&agrupar=produto`,
  `pedidos-compra?${period}&situacoes=in_progress&agrupar=fornecedor`,...['operacao','fornecedor','produto','evolucao'].map(group=>`notas-entrada?${period}&agrupar=${group}`)]){
  const out=await project(path);assert.equal(out.data_mode,'erp_native',path);
 }
 assert.equal((await project(`movimentacao-produto?product_id=${s.P.id}&${period}`)).closing,'9.000000');
});
