import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneEFixture,migrationSql,fails} from './helpers/stock-lane-e-fixture.mjs';

// 260 on PGlite (every migration published up to 233, then the lane E files) with synthetic data only: the permissions of the three
// product dashboards (229), Sem Movimentação with the exit notes (259), the product locations and the direct launch of a composition.
let f;
before(async()=>{f=await stockLaneEFixture({upto:3});});
after(()=>f?.close());
const controls=async(target,permissions)=>{const version=await f.scalar('select coalesce((select version from erp_access.user_control where user_id=$1),0) v',[target]);
 return f.rpc('erp_access_user_controls_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_target:target,p_expected_version:version,
  p_data:{user_type:'normal',schedule:{enabled:false,windows:[]},permissions}});};
const panel={
 stock:user=>f.rpc('erp_stock_dashboard_stock',{p_user_id:user,p_query:null,p_search_by:'description',p_warehouse_id:null,p_brand:null,p_page:1,p_size:100,p_supplier_id:null,p_stock_type:null}),
 suggestion:user=>f.rpc('erp_stock_purchase_suggestion',{p_user_id:user,p_date_from:'2026-10-01',p_date_to:'2026-10-20',p_coverage:30,p_warehouse_id:null,p_reserve:false,p_purchase_statuses:['open','in_progress'],p_sales_statuses:['verified','fulfilled'],p_brand:null,p_supplier_id:null}),
 idle:user=>f.rpc('erp_stock_dashboard_idle',{p_user_id:user,p_since:'2026-10-01',p_page:1,p_size:100})};

test('260 entry points are SECURITY DEFINER for service_role only and the guard refuses a second run',async()=>{
 for(const signature of['public.erp_stock_dashboard_stock(uuid,text,text,uuid,text,integer,integer,uuid,text)','public.erp_stock_purchase_suggestion(uuid,date,date,integer,uuid,boolean,jsonb,jsonb,text,uuid)',
  'public.erp_stock_dashboard_idle(uuid,date,integer,integer)','public.erp_stock_launch(uuid,uuid,text,uuid,uuid,text,integer,text,text,text,uuid,integer)','public.erp_stock_product_locations(uuid,jsonb)']){
  for(const role of['anon','authenticated','public'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,[signature]),false,signature);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",[signature]),true,signature);
  assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure',[signature]),true,signature);
  assert.deepEqual(await f.scalar('select proconfig v from pg_proc where oid=$1::regprocedure',[signature]),['search_path=pg_catalog'],signature);
 }
 await assert.rejects(f.db.exec(await migrationSql('202610200260_stock_access_location.sql')),/stock_access_location_260_previous_definition_changed/);await f.db.exec('rollback');
});

test('260 PRF-222: Estoque de Produtos, Sugestão de Compras and Sem Movimentação follow the Meu Negócio permissions of Sistema › Usuários',async()=>{
 // Without a saved set the profile decides (as before); the administrador always reads.
 for(const name of['stock','suggestion','idle'])assert.ok(await panel[name](f.users.estoque),name);
 await controls(f.users.estoque,['meu_negocio.dashboard','meu_negocio.dashboard.sem_movimentacao']);
 assert.ok(await panel.idle(f.users.estoque));
 await assert.rejects(panel.stock(f.users.estoque),error=>error.code==='42501'&&/permission_denied/.test(error.message));
 await assert.rejects(panel.suggestion(f.users.estoque),fails('42501'));
 await controls(f.users.estoque,['meu_negocio.dashboard','meu_negocio.dashboard.estoque_produtos','meu_negocio.dashboard.sugestao_compras']);
 assert.ok(await panel.stock(f.users.estoque));assert.ok(await panel.suggestion(f.users.estoque));
 await assert.rejects(panel.idle(f.users.estoque),fails('42501'));
 // A set without the Meu Negócio module refuses every dashboard; the profile rules still apply (vendas never reads the suggestion).
 await controls(f.users.estoque,['cadastros.produtos']).catch(()=>controls(f.users.estoque,[]));
 for(const name of['stock','suggestion','idle'])await assert.rejects(panel[name](f.users.estoque),fails('42501'),name);
 await assert.rejects(panel.suggestion(f.users.vendas),fails('42501'));
 for(const name of['stock','suggestion','idle'])assert.ok(await panel[name](f.users.admin),name);
 await controls(f.users.estoque,null);
});

test('260 Sem Movimentação counts the exit of a Brufap note as a sale; the product locations of a page',async()=>{
 await f.db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,'{\"state\":\"SP\",\"cnpj\":\"11222333000181\"}',$1) on conflict do nothing",[f.users.admin]);
 await f.db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1) on conflict do nothing",[f.users.admin]);
 const nature=(await f.rpc('erp_fiscal_nature_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'create',p_data:{nature:{description:'Venda 260',direction:'1',crt:'1'}}})).nature;
 const depot=await f.warehouse('Depósito 260');
 const sold=await f.product('Vendido pela nota 260',{location:'Corredor 3'}),still=await f.product('Parado 260');
 await f.launch(sold.id,depot.id,'receipt','5');await f.launch(still.id,depot.id,'receipt','5');
 const exit=(await f.rpc('erp_fiscal_invoice_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'create',p_data:{invoice:{model:'55',direction:'1',issue_type:'N',series:'1',nature_id:nature.id,
  issue_date:'2026-10-20',crt:'1',purpose:'1',presence:'1',final_consumer:false,recipient:{name:'Cliente 260',person_type:'J',document:'12345678000190',state:'SP'},
  items:[{product_id:sold.id,description:'Vendido',unit:'UN',quantity:'1',unit_price:'10'}],payment:{installments:[{date:'2026-11-20',amount:'10.00'}]}},orders:[]}})).invoice;
 const version=await f.scalar('select version v from erp_fiscal_invoices.invoice where id=$1',[exit.id]);
 const p=(await f.rpc('erp_stock_invoice_preview',{p_user_id:f.users.estoque,p_invoice_id:exit.id,p_expected_version:version,p_warehouse_id:depot.id})).preview;
 await f.rpc('erp_stock_invoice_post',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_invoice_id:exit.id,p_expected_version:version,p_warehouse_id:depot.id,p_preview_hash:p.preview_hash});
 const idle=await panel.idle(f.users.consulta);
 assert.equal(idle.items.some(i=>i.product_id===sold.id),false,'sold by the note today');assert.ok(idle.items.some(i=>i.product_id===still.id&&i.last_sale===null));
 const locations=await f.rpc('erp_stock_product_locations',{p_user_id:f.users.vendas,p_ids:[sold.id,still.id]});
 assert.deepEqual(locations.items.map(i=>[i.product_id,i.location]).sort(),[[sold.id,'Corredor 3'],[still.id,null]].sort());
 // A location mirrored with a tab or a line break comes on one line (the Worker refuses control characters).
 await f.db.query("update erp_catalog.product set location=E'Rua 2\\tPrateleira\\n' where record_id=$1",[still.id]);
 assert.equal((await f.rpc('erp_stock_product_locations',{p_user_id:f.users.vendas,p_ids:[still.id]})).items[0].location,'Rua 2 Prateleira');
 await assert.rejects(f.rpc('erp_stock_product_locations',{p_user_id:f.users.financeiro,p_ids:[sold.id]}),fails('42501'));
 await assert.rejects(f.rpc('erp_stock_product_locations',{p_user_id:f.users.vendas,p_ids:[sold.id,sold.id]}),fails('22023'));
 await assert.rejects(f.rpc('erp_stock_product_locations',{p_user_id:f.users.vendas,p_ids:[]}),fails('22023'));
});

test('260 a Físico composition with Lançar estoque Componentes or Produto e componente refuses a direct Entrada or Saída of its own stock',async()=>{
 const depot=await f.warehouse('Depósito composição 260'),other=await f.warehouse('Depósito composição 260 B');
 const c=await f.product('Componente 260');await f.launch(c.id,depot.id,'receipt','20');
 const both=await f.kit('Kit ambos 260',[[c,'2']],{stock_type:'physical',post_mode:'both'});
 const own=await f.kit('Kit produto 260',[[c,'2']],{stock_type:'physical',post_mode:'product'});
 for(const kind of['receipt','issue'])await assert.rejects(f.launch(both.id,depot.id,kind,'1'),error=>error.code==='22023'&&/composition_launch_required/.test(error.message),kind);
 // The composition lançamento moves it and its components; Balanço and transferência keep moving its own stock.
 const launched=await f.rpc('erp_stock_composition_launch',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_kind:'receipt',p_product_id:both.id,p_warehouse_id:depot.id,p_quantity:'2',
  p_expected_version:await f.version(both.id,depot.id),p_note:null,p_unit_price:null,p_unit_cost:null});
 assert.equal(launched.lines.length,2);
 await f.launch(both.id,depot.id,'balance','3');await f.launch(both.id,depot.id,'transfer','1',{destination:other.id});
 assert.deepEqual([await f.balance(both.id,depot.id),await f.balance(both.id,other.id)],['2.000000','1.000000']);
 // "Lançar estoque: Produto" keeps the common Novo Lançamento.
 await f.launch(own.id,depot.id,'receipt','4');assert.equal(await f.balance(own.id,depot.id),'4.000000');
});
