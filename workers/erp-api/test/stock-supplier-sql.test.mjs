import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneCFixture,migrationSql,fails} from './helpers/stock-lane-c-fixture.mjs';
import {stockRoute,stockOperation,stockResponse} from '../src/stock.mjs';

// 181 on PGlite (every published migration up to 152, then 181) with synthetic data only: product suppliers, DUN and images (119)
// in the stock dashboards, the purchase suggestion, the suggested entry price, the count and the check-in.
let f,supplier,other;
before(async()=>{
 f=await stockLaneCFixture({upto:1});
 supplier=await f.catalog('contacts',{name:'Fornecedor Alfa',roles:['supplier']});
 other=await f.catalog('contacts',{name:'Fornecedor Beta',roles:['supplier']});
});
after(()=>f?.close());
const http=async(path,value,args)=>{const url=new URL(`https://api.example.test${path}`),route=stockRoute(url.pathname),operation=await stockOperation(new Request(url),route,url.searchParams);
 if(args)assert.deepEqual(operation.args,args);return stockResponse(await f.rpc(operation.rpc,{p_user_id:value,...operation.args}),route,operation);};
const suppliers=(id,list)=>f.productDetail(id,{suppliers:list.map(item=>({is_default:false,...item}))});
const dashboard=(args={},user=f.users.estoque)=>f.rpc('erp_stock_dashboard_stock',{p_user_id:user,p_query:null,p_search_by:'description',p_warehouse_id:null,p_brand:null,p_page:1,p_size:100,...args});
const suggestion=(args={},user=f.users.estoque)=>f.rpc('erp_stock_purchase_suggestion',{p_user_id:user,p_date_from:'2026-10-01',p_date_to:'2026-10-20',p_coverage:20,p_warehouse_id:null,p_reserve:false,
 p_purchase_statuses:['open','in_progress'],p_sales_statuses:['open','verified'],p_brand:null,...args});

test('181 entry points are SECURITY DEFINER for service_role only; the helper stays private; the guard refuses a second run',async()=>{
 for(const signature of['public.erp_stock_warehouse_options(uuid)','public.erp_stock_suppliers(uuid,text)','public.erp_stock_launch_context(uuid,uuid)',
  'public.erp_stock_dashboard_stock(uuid,text,text,uuid,text,integer,integer,uuid,text)','public.erp_stock_purchase_suggestion(uuid,date,date,integer,uuid,boolean,jsonb,jsonb,text,uuid)']){
  for(const role of['anon','authenticated','public'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,[signature]),false,signature);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",[signature]),true,signature);
  assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure',[signature]),true,signature);
  assert.deepEqual(await f.scalar('select proconfig v from pg_proc where oid=$1::regprocedure',[signature]),['search_path=pg_catalog'],signature);
 }
 // The 145 signatures are gone, so the published API never meets two candidates.
 for(const old of['public.erp_stock_dashboard_stock(uuid,text,text,uuid,text,integer,integer)','public.erp_stock_purchase_suggestion(uuid,date,date,integer,uuid,boolean,jsonb,jsonb,text)'])
  assert.equal(await f.scalar('select to_regprocedure($1) is null v',[old]),true);
 assert.equal(await f.scalar("select has_function_privilege('service_role','erp_stock.default_supplier(uuid)','EXECUTE') v"),false);
 await assert.rejects(f.db.exec(await migrationSql('202610200181_stock_supplier_parity.sql')),/stock_supplier_181_previous_definition_changed/);await f.db.exec('rollback');
});

test('181 warehouse options: every stock reader, inactive and ignored warehouses flagged, no totals computed',async()=>{
 const a=await f.warehouse('Opção A'),b=await f.warehouse('Opção B',true);await f.setDefault(a.id);
 for(const user of[f.users.vendas,f.users.fiscal,f.users.consulta,f.users.estoque]){
  const value=await f.rpc('erp_stock_warehouse_options',{p_user_id:user});
  assert.equal(value.scope,'stock_warehouse_options');assert.equal(value.total,value.items.length);
  assert.deepEqual(value.items.find(i=>i.id===a.id),{id:a.id,name:'Opção A',active:true,is_default:true,ignore_balance:false});
  assert.equal(value.items.find(i=>i.id===b.id).ignore_balance,true);
 }
 for(const user of[f.users.financeiro,randomUUID()])await assert.rejects(f.rpc('erp_stock_warehouse_options',{p_user_id:user}),fails('42501'));
 const out=await http('/v1/estoque/depositos/opcoes',f.users.vendas,{});assert.ok(out.items.some(i=>i.id===b.id));
});

test('181 suppliers of the filter: active supplier contacts and every contact linked to a product, with search',async()=>{
 const p=await f.product('Produto fornecedor lista');const linked=await f.catalog('contacts',{name:'Contato só ligado'});
 await suppliers(p.id,[{supplier_id:linked.id,code:'L-1',is_default:true}]);
 const all=await f.rpc('erp_stock_suppliers',{p_user_id:f.users.vendas,p_query:null});
 assert.ok(all.items.some(i=>i.id===supplier.id&&i.products===0));assert.equal(all.items.find(i=>i.id===linked.id).products,1);
 assert.equal(all.items.some(i=>i.id===f.contact.id),false,'a contact that is not a supplier nor linked stays out');
 const found=await http('/v1/estoque/fornecedores?q=alfa',f.users.fiscal,{p_query:'alfa'});assert.deepEqual(found.items.map(i=>i.name),['Fornecedor Alfa']);
 await assert.rejects(f.rpc('erp_stock_suppliers',{p_user_id:f.users.vendas,p_query:'x\u0001'}),fails('22023'));
});

test('181 Estoque de Produtos: Fornecedor, Tipo de Estoque, Custo do fornecedor padrão with the custo médio as fallback, sem custo only with stock',async()=>{
 const w=await f.warehouse('Painel 181');
 const a=await f.product('Painel A supplier'),b=await f.product('Painel B average'),c=await f.product('Painel C uncosted'),z=await f.product('Painel D zero');
 await suppliers(a.id,[{supplier_id:supplier.id,code:'A-1',purchase_price:'3',cost_price:'3.3',is_default:true},{supplier_id:other.id,cost_price:'9'}]);
 await suppliers(b.id,[{supplier_id:other.id,cost_price:'7',is_default:true}]);
 await f.launch(a.id,w.id,'receipt','10',{price:'2'});await f.launch(b.id,w.id,'receipt','4',{price:'2.5'});await f.launch(c.id,w.id,'receipt','5');
 await f.launch(z.id,w.id,'receipt','1');await f.launch(z.id,w.id,'issue','1');
 const value=await dashboard({p_warehouse_id:w.id});
 const row=id=>value.items.find(i=>i.product_id===id);
 assert.deepEqual([row(a.id).supplier_cost,row(a.id).unit_cost,row(a.id).cost_source,row(a.id).stock_cost,row(a.id).average_cost,row(a.id).cost],['3.3000000000','3.3000000000','supplier','33.00','2.0000000000','20.00']);
 assert.deepEqual([row(b.id).cost_source,row(b.id).stock_cost],['supplier','28.00']);
 assert.deepEqual([row(c.id).cost_source,row(c.id).stock_cost,row(c.id).unit_cost],[null,null,null],'no supplier cost and no priced entry');
 assert.deepEqual([row(z.id).quantity,row(z.id).cost_source],['0.000000',null]);
 assert.deepEqual([value.totals.stock_cost,value.totals.stock_uncosted,value.totals.supplier_costed,value.totals.uncosted],['61.00',1,2,1],'the zero balance product is not counted as sem custo');
 assert.equal(value.warehouses[0].stock_cost,'61.00');
 // Without a default supplier cost the custo médio stays.
 await suppliers(b.id,[{supplier_id:other.id,is_default:true}]);
 const fallback=(await dashboard({p_warehouse_id:w.id})).items.find(i=>i.product_id===b.id);
 assert.deepEqual([fallback.cost_source,fallback.unit_cost,fallback.stock_cost],['average','2.5000000000','10.00']);
 // Fornecedor: any supplier of the product (not only the default one).
 assert.deepEqual((await dashboard({p_warehouse_id:w.id,p_supplier_id:other.id})).items.map(i=>i.product_id).sort(),[a.id,b.id].sort());
 assert.deepEqual((await dashboard({p_warehouse_id:w.id,p_supplier_id:supplier.id})).items.map(i=>i.product_id),[a.id]);
 // Tipo de Estoque: a product that became a composition after it had stock is Virtual; the others are Físico.
 const kit=await f.product('Painel E kit');await f.launch(kit.id,w.id,'receipt','2');
 await f.rpc('erp_catalog_save',{p_user_id:f.users.admin,p_entity:'products',p_id:kit.id,p_expected_version:await f.scalar('select version v from erp_catalog.record where id=$1',[kit.id]),p_command_id:randomUUID(),p_data:{format:'E'}});
 assert.deepEqual((await dashboard({p_warehouse_id:w.id,p_stock_type:'virtual'})).items.map(i=>i.product_id),[kit.id]);
 assert.equal((await dashboard({p_warehouse_id:w.id,p_stock_type:'physical'})).items.some(i=>i.product_id===kit.id),false);
 // Purchase data: hidden for vendas.
 const sales=await dashboard({p_warehouse_id:w.id},f.users.vendas);
 assert.deepEqual([sales.cost_visible,sales.totals.stock_cost,sales.items.find(i=>i.product_id===a.id).supplier_cost],[false,null,null]);
 await assert.rejects(dashboard({p_stock_type:'logico'}),fails('22023'));await assert.rejects(dashboard({p_supplier_id:randomUUID()}),fails('P0002'));
 // SQL -> HTTP -> DTO.
 const out=await http(`/v1/estoque/painel/estoque?warehouse_id=${w.id}&fornecedor=${other.id}&tipo_estoque=fisico`,f.users.estoque,
  {p_query:null,p_search_by:'description',p_warehouse_id:w.id,p_brand:null,p_page:1,p_size:100,p_supplier_id:other.id,p_stock_type:'physical'});
 assert.deepEqual(out.filters,{query:null,search_by:'description',warehouse_id:w.id,brand:null,supplier_id:other.id,stock_type:'physical'});
 assert.equal(out.items.find(i=>i.product_id===a.id).stock_cost,'33.00');
});

test('181 Sugestão de Compras: Fornecedor, Valor Estimado by the purchase order default price, unit and supplier of each row',async()=>{
 const w=await f.warehouse('Sugestão 181'),p=await f.product('Sugerido fornecedor'),q=await f.product('Sugerido sem fornecedor');
 await suppliers(p.id,[{supplier_id:supplier.id,purchase_price:'4',cost_price:'4.4',is_default:true},{supplier_id:other.id,purchase_price:'5',cost_price:'5.5'}]);
 await f.order('sales_orders',[f.item(p,'10','9'),f.item(q,'10','9')],w.id);
 await f.order('purchase_orders',[f.item(q,'1','2')],w.id,[]);
 let value=await suggestion({p_warehouse_id:w.id});
 assert.equal(value.price_mode,'ultima_compra');
 const row=(v,id)=>v.items.find(i=>i.product_id===id);
 assert.deepEqual([row(value,p.id).unit,row(value,p.id).supplier_id,row(value,p.id).supplier_name,row(value,p.id).price_source,row(value,p.id).unit_price],['UN',supplier.id,'Fornecedor Alfa',null,null]);
 assert.deepEqual([row(value,q.id).price_source,row(value,q.id).unit_price,row(value,q.id).supplier_id],['last_purchase','2.0000000000',null]);
 await f.setPreferences('suprimentos-compras',{'compras.preco_padrao':true});
 value=await suggestion({p_warehouse_id:w.id});
 assert.deepEqual([value.price_mode,row(value,p.id).price_source,row(value,p.id).unit_price,row(value,q.id).price_source],['custo','supplier_cost','4.4000000000','last_purchase']);
 await f.setPreferences('suprimentos-compras',{'compras.preco_padrao_tipo':'compra'});
 value=await suggestion({p_warehouse_id:w.id,p_supplier_id:other.id});
 assert.deepEqual(value.items.map(i=>i.product_id),[p.id],'only products of the supplier');
 assert.deepEqual([value.price_mode,row(value,p.id).supplier_id,row(value,p.id).price_source,row(value,p.id).unit_price],['compra',other.id,'supplier_purchase','5.0000000000'],'the filtered supplier gives the price');
 assert.equal(value.filters.supplier_id,other.id);
 const s=row(value,p.id);assert.equal(s.value,(Number(s.suggestion)*5).toFixed(2));
 await f.setPreferences('suprimentos-compras',{'compras.preco_padrao':false,'compras.preco_padrao_tipo':'custo'});
 await assert.rejects(suggestion({p_supplier_id:randomUUID()}),fails('P0002'));
 const out=await http(`/v1/estoque/painel/sugestao?de=2026-10-01&ate=2026-10-20&cobertura=20&warehouse_id=${w.id}&compras=open,in_progress&vendas=open,verified&fornecedor=${supplier.id}`,f.users.estoque);
 assert.deepEqual([out.price_mode,out.filters.supplier_id,out.items[0].unit,out.items[0].supplier_id],['ultima_compra',supplier.id,'UN',supplier.id]);
});

test('181 Novo Lançamento: the default supplier and its prices for the supplier price types',async()=>{
 const p=await f.product('Lançamento fornecedor');
 let c=await f.rpc('erp_stock_launch_context',{p_user_id:f.users.estoque,p_product_id:p.id});assert.equal(c.default_supplier,null);
 await suppliers(p.id,[{supplier_id:other.id,purchase_price:'1'},{supplier_id:supplier.id,code:'F-9',purchase_price:'1.25',cost_price:'1.5',is_default:true}]);
 await f.setPreferences('suprimentos-estoque',{'estoque.tipo_preco_entrada':'compra_fornecedor'});
 c=await f.rpc('erp_stock_launch_context',{p_user_id:f.users.estoque,p_product_id:p.id});
 assert.deepEqual(c.default_supplier,{supplier_id:supplier.id,supplier_name:'Fornecedor Alfa',code:'F-9',purchase_price:'1.2500000000',cost_price:'1.5000000000'});
 assert.deepEqual([c.settings.price_type,c.last_purchase],['compra_fornecedor',null]);
 const out=await http(`/v1/estoque/sugestao?product_id=${p.id}`,f.users.estoque);assert.equal(out.default_supplier.purchase_price,'1.2500000000');
 await f.setPreferences('suprimentos-estoque',{'estoque.tipo_preco_entrada':'ultima_compra'});
});

test('181 Conferência: the first image of the product in the count; Check-in: DUN, código no fornecedor da nota and Usuário responsável',async()=>{
 const w=await f.warehouse('Conferência 181'),p=await f.product('Conferido com imagem',{code:'IMG-1'}),q=await f.product('Conferido sem imagem',{code:'IMG-2'});
 await f.productDetail(p.id,{images:[{url:'https://exemplo.test/a.png'},{url:'https://exemplo.test/b.png'}]});
 const read=async code=>f.rpc('erp_stock_count_read',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_session_id:await f.scalar("select id v from erp_stock.count_session where actor=$1 and state='open'",[f.users.estoque])??null,p_code:code,p_quantity:'1',p_warehouse_id:w.id});
 await read('IMG-1');await read('IMG-2');
 const count=(await f.rpc('erp_stock_count_get',{p_user_id:f.users.estoque})).count;
 assert.deepEqual(count.items.map(i=>[i.code,i.image_url]).sort(),[['IMG-1','https://exemplo.test/a.png'],['IMG-2',null]]);
 const out=await http('/v1/estoque/conferencias/atual',f.users.estoque);assert.equal(out.count.items.find(i=>i.code==='IMG-1').image_url,'https://exemplo.test/a.png');
 // Check-in of a native entry note (112) of the supplier contact.
 await f.db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,'{\"state\":\"SP\",\"cnpj\":\"11222333000181\"}',$1) on conflict do nothing",[f.users.admin]);
 await f.db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1) on conflict do nothing",[f.users.admin]);
 const nature=(await f.rpc('erp_fiscal_nature_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'create',p_data:{nature:{description:'Compra sintética 181',direction:'0',crt:'1',presence:'9'}}})).nature;
 await f.productDetail(q.id,{dun_codes:[{code:'17891234567892',quantity:'12'}],suppliers:[{supplier_id:supplier.id,code:'FORN-77',is_default:true}]});
 const line=(product,code)=>({product_id:product.id,description:'Peça sintética',code,unit:'UN',quantity:'24',unit_price:'2',ncm:'84713012',cfop:'1102',icms:{origin:'0',situation:'102'},pis:{situation:'49'},cofins:{situation:'49'}});
 const invoice=(await f.rpc('erp_fiscal_invoice_execute',{p_user_id:f.users.fiscal,p_command_id:randomUUID(),p_action:'create',p_data:{invoice:{model:'55',direction:'0',issue_type:'T',series:'1',number:'181',nature_id:nature.id,
  issue_date:'2026-10-20',crt:'1',purpose:'1',presence:'9',final_consumer:false,recipient:{contact_id:supplier.id,name:'Fornecedor Alfa',person_type:'J',document:'12345678000190',state:'SP'},items:[line(q,'NOTA-1'),line(p,'NOTA-2')]}}})).invoice;
 let view=await f.rpc('erp_stock_checkin_get',{p_user_id:f.users.estoque,p_invoice_id:invoice.id});
 const item=view.items.find(i=>i.product_id===q.id);
 assert.deepEqual([item.supplier_code,item.catalog_supplier_code,item.product_duns],['NOTA-1','FORN-77',[{code:'17891234567892',quantity:'12.000000'}]]);
 assert.deepEqual(view.items.find(i=>i.product_id===p.id).product_duns,[]);
 assert.equal(view.responsible,null,'no check-in yet');
 await f.db.query("insert into erp_access.profile(user_id,name,version,updated_at,updated_by) values($1,'Estoquista Sintético',1,now(),$2)",[f.users.estoque,f.users.admin]);
 view=await f.rpc('erp_stock_checkin_save',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_invoice_id:invoice.id,p_expected_version:0,p_items:[{position:1,received:'12'}]});
 assert.deepEqual(view.responsible,{started_by_name:'Estoquista Sintético',finished_by_name:null});
 const projected=await http(`/v1/estoque/checkin/notas/${invoice.id}`,f.users.fiscal);
 assert.deepEqual([projected.responsible.started_by_name,projected.items[0].catalog_supplier_code,projected.items[0].product_duns.length],['Estoquista Sintético','FORN-77',1]);
});
