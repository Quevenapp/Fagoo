import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
import {stockRoute,stockMethods,stockOperation,stockResponse} from '../src/stock.mjs';

// Routes and projections of migration 145 (Preferências > Suprimentos > Estoque applied to stock). Synthetic IDs only.
const USER='a1450000-0000-4000-8000-000000000001',P='b1450000-0000-4000-8000-000000000001',A='c1450000-0000-4000-8000-000000000001',B='c1450000-0000-4000-8000-000000000002';
const M='e1450000-0000-4000-8000-000000000001',R='e1450000-0000-4000-8000-000000000002',X='e1450000-0000-4000-8000-000000000003',DOC='d1450000-0000-4000-8000-000000000001',CMD='f1450000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://exampleproject.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',ALLOWED_ORIGINS:'https://erp.example.test'};
const request=(path,method='GET',body)=>new Request(`https://api.example.test${path}`,{method,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
const parse=async(path,method,body)=>{const req=request(path,method,body),url=new URL(req.url);return stockOperation(req,stockRoute(url.pathname),url.searchParams);};
const project=async(path,method,body,value)=>{const op=await parse(path,method,body);return stockResponse(value,stockRoute(new URL(`https://x${path}`).pathname),op);};
const invalid=promise=>assert.rejects(promise,error=>error.status===400&&error.code==='ERP_INVALID_QUERY');
const bad=promise=>assert.rejects(promise,error=>error.status===502&&error.code==='ERP_UPSTREAM_INVALID_RESPONSE');
const context=(patch={})=>({scope:'stock_launch_context',data_mode:'erp_native',product_id:P,settings:{show_unit_price:true,price_type:'ultima_compra',consider_balances:false,average_cost_base:'preco_compra'},
 last_purchase:{unit_price:'2.5000000000',unit_cost:'2.7500000000',occurred_on:'2026-10-19',movement_id:M,source:'manual'},average_cost:'2.6000000000',sale_price:'10.0000000000',private:'x',...patch});

test('145 GET /v1/estoque/sugestao: strict query, closed DTO, Balanço only when considered, supplier types suggest nothing',async()=>{
 assert.deepEqual(stockMethods(stockRoute('/v1/estoque/sugestao')),['GET']);
 assert.deepEqual((await parse(`/v1/estoque/sugestao?product_id=${P.toUpperCase()}`,'GET')).args,{p_product_id:P});
 for(const query of['',`?product_id=${P}&product_id=${P}`,'?product_id=bad',`?product_id=${P}&warehouse_id=${A}`,'?product_id='])await invalid(parse(`/v1/estoque/sugestao${query}`,'GET'));
 const path=`/v1/estoque/sugestao?product_id=${P}`,out=await project(path,'GET',undefined,context());
 assert.deepEqual(out,{product_id:P,settings:{show_unit_price:true,price_type:'ultima_compra',consider_balances:false,average_cost_base:'preco_compra'},
  last_purchase:{unit_price:'2.5000000000',unit_cost:'2.7500000000',occurred_on:'2026-10-19',movement_id:M,source:'manual'},average_cost:'2.6000000000',sale_price:'10.0000000000',default_supplier:null,price_decimals:{entry:10},scope:'stock_launch_context',data_mode:'erp_native'},'181: an answer without the supplier has none; 277: without decimals, ten');
 assert.equal((await project(path,'GET',undefined,context({last_purchase:null,settings:{...context().settings,price_type:'custo_fornecedor'}}))).last_purchase,null);
 for(const value of[context({product_id:A}),context({settings:{...context().settings,price_type:'outro'}}),context({settings:{...context().settings,extra:true}}),
  context({last_purchase:{...context().last_purchase,source:'balance'}}),context({settings:{...context().settings,price_type:'compra_fornecedor'}}),
  context({last_purchase:{...context().last_purchase,unit_price:'2.5'}}),context({average_cost:2.6}),context({last_purchase:{...context().last_purchase,unit_price:null}})])
  await bad(project(path,'GET',undefined,value));
 assert.equal((await project(path,'GET',undefined,context({settings:{...context().settings,consider_balances:true},last_purchase:{...context().last_purchase,source:'balance'}}))).last_purchase.source,'balance');
});

test('145 balances and "Visualizar vendas" carry the reservation by sale situation; inconsistent answers fail closed',async()=>{
 const reservation={by_situation:true,by_warehouse:true,statuses:['draft','open','verified'],unassigned_quantity:'0.000000'};
 const row=(patch={})=>({warehouse_id:A,warehouse_name:'Geral',warehouse_active:true,quantity:'8.000000',version:3,unit:'UN',warehouse_default:true,warehouse_ignored:false,reserved_quantity:'3.000000',situation_reserved_quantity:'2.000000',...patch});
 const balances=(patch={})=>({product_id:P,items:[row()],reservation,data_mode:'erp_native',...patch});
 const path=`/v1/estoque/saldos?product_id=${P}`;
 assert.deepEqual((await project(path,'GET',undefined,balances())).reservation,reservation);
 for(const value of[balances({reservation:undefined}),balances({items:[row({situation_reserved_quantity:'4.000000'})]}),balances({items:[row({situation_reserved_quantity:undefined})]}),
  balances({reservation:{...reservation,statuses:['open','draft']}}),balances({reservation:{...reservation,statuses:['venda_agenciada']}}),balances({reservation:{...reservation,by_situation:false}}),
  balances({reservation:{...reservation,by_warehouse:false}}),balances({reservation:{...reservation,unassigned_quantity:'-1.000000'}})])
  await bad(project(path,'GET',undefined,value));
 assert.equal((await project(path,'GET',undefined,balances({items:[row({situation_reserved_quantity:'0.000000'})],reservation:{...reservation,by_warehouse:false,unassigned_quantity:'2.000000'}}))).reservation.unassigned_quantity,'2.000000');
 const explicit={reservation_id:R,source:'reservation',document_id:DOC,document_number:'12',status:'verified',contact_name:'Cliente sintético',warehouse_id:A,warehouse_ignored:false,quantity:'1.000000',unit:'UN',reserved_at:'2026-10-20T12:00:00Z'};
 const situation={reservation_id:null,source:'situation',document_id:DOC,document_number:'13',status:'open',contact_name:null,warehouse_id:null,warehouse_ignored:false,quantity:'2.000000',unit:'UN',reserved_at:null};
 const list=(items,patch={})=>({scope:'stock_product_reservations',data_mode:'erp_native',product_id:P,warehouse_id:A,items,total:items.length,quantity:'3.000000',reservation:{by_situation:true,by_warehouse:false,statuses:['open','verified']},...patch});
 const listPath=`/v1/estoque/reservas?product_id=${P}&warehouse_id=${A}`;
 const out=await project(listPath,'GET',undefined,list([situation,explicit]));
 assert.deepEqual(out.items.map(i=>[i.source,i.reservation_id,i.warehouse_id]),[['situation',null,null],['reservation',R,A]]);
 for(const value of[list([{...situation,reservation_id:X},explicit]),list([{...situation,reserved_at:'2026-10-20T12:00:00Z'},explicit]),list([{...situation,status:'fulfilled'},explicit]),
  list([situation,{...explicit,warehouse_id:null}]),list([situation,{...explicit,source:'other'}]),list([{...situation,warehouse_ignored:true},explicit]),
  list([situation,explicit],{reservation:{by_situation:false,by_warehouse:true,statuses:[]}}),list([situation,{...explicit,warehouse_id:B}])])
  await bad(project(listPath,'GET',undefined,value));
});

test('145 totals and Estoque de Produtos: Valor de Custo and the Custo column are exact and hidden as a whole when not visible',async()=>{
 const totals=(patch={})=>({scope:'stock_totals',data_mode:'erp_native',warehouse_id:null,quantity:'4.000000',sale_value:'40.00',unpriced_products:0,ignored_warehouses:0,cost_visible:true,cost_value:'10.00',uncosted_products:1,cost_basis:'custo_lancamento',warehouses:[],...patch});
 const out=await project('/v1/estoque/totais','GET',undefined,totals());
 assert.deepEqual([out.cost_visible,out.cost_value,out.uncosted_products,out.cost_basis],[true,'10.00',1,'custo_lancamento']);
 assert.equal((await project('/v1/estoque/totais','GET',undefined,totals({cost_visible:false,cost_value:null,uncosted_products:null}))).cost_value,null);
 for(const value of[totals({cost_visible:false}),totals({cost_value:null}),totals({cost_value:'10.0'}),totals({cost_basis:'outro'}),totals({uncosted_products:null}),totals({cost_visible:undefined})])
  await bad(project('/v1/estoque/totais','GET',undefined,value));
 const item=(patch={})=>({product_id:P,code:'P-1',name:'Produto',quantity:'3.000000',value:'30.00',average_cost:'0.3333333333',cost:'1.00',...patch});
 const stock=(items,patch={})=>({scope:'stock_dashboard_stock',data_mode:'erp_native',page:1,size:100,total:items.length,filters:{query:null,search_by:'description',warehouse_id:null,brand:null},items,
  totals:{quantity:items.reduce((s,i)=>s+Number(i.quantity),0).toFixed(6),value:'30.00',unpriced:0,cost:'1.00',uncosted:0},cost_visible:true,cost_basis:'preco_compra',
  warehouses:[{warehouse_id:A,name:'Geral',ignored:false,quantity:items.reduce((s,i)=>s+Number(i.quantity),0).toFixed(6),value:'30.00',cost:'1.00'}],...patch});
 const dash='/v1/estoque/painel/estoque';
 assert.equal((await project(dash,'GET',undefined,stock([item()]))).items[0].cost,'1.00','3 × 0.3333333333 = 0.9999999999 → 1.00');
 assert.equal((await project(dash,'GET',undefined,stock([item({quantity:'-3.000000',value:'-30.00',average_cost:'0.0016666667',cost:'-0.01'})]))).items[0].cost,'-0.01','half away from zero, like SQL round()');
 for(const value of[stock([item({cost:'0.99'})]),stock([item({average_cost:null})]),stock([item({cost:null})]),stock([item()],{cost_visible:false}),stock([item({average_cost:'1/3'})]),stock([item()],{totals:{quantity:'3.000000',value:'30.00',unpriced:0,cost:null,uncosted:0}})])
  await bad(project(dash,'GET',undefined,value));
 const hidden=stock([item({average_cost:null,cost:null})],{cost_visible:false,totals:{quantity:'3.000000',value:'30.00',unpriced:0,cost:null,uncosted:null},warehouses:[{warehouse_id:A,name:'Geral',ignored:false,quantity:'3.000000',value:'30.00',cost:null}]});
 assert.equal((await project(dash,'GET',undefined,hidden)).cost_visible,false);
 await bad(project(dash,'GET',undefined,{...hidden,warehouses:[{...hidden.warehouses[0],cost:'1.00'}]}));
});

test('145 estorno: the balance adjustments are opposite to the reversal at the same positions, never anything else',async()=>{
 const line=(quantity,balance,warehouse=A)=>({product_id:P,warehouse_id:warehouse,quantity,unit:'UN',balance_after:balance,balance_version:4});
 const mov=(id,kind,items,patch={})=>({id,kind,occurred_on:'2026-10-20',reason:'Estorno sintético',reference:null,created_at:'2026-10-20T12:00:00Z',reverses_id:kind==='reversal'?M:null,reversed_by:null,items,...patch});
 const body={command_id:CMD,occurred_on:'2026-10-20',reason:'Estorno sintético',versions:[{product_id:P,warehouse_id:A,expected_version:3}]};
 const path=`/v1/estoque/movimentos/${M}/estorno`,reversal=mov(R,'reversal',[line('-10.000000','4.000000')]);
 const out=await project(path,'POST',body,{movement:reversal,balance_adjustments:[mov(X,'adjustment',[line('10.000000','14.000000')],{reason:'Estorno anterior ao balanço: saldo atual mantido'})],replayed:false,data_mode:'erp_native'});
 assert.deepEqual([out.movement.id,out.balance_adjustments.length,out.balance_adjustments[0].items[0].quantity],[R,1,'10.000000']);
 assert.deepEqual((await project(path,'POST',body,{movement:reversal,balance_adjustments:[],replayed:true,data_mode:'erp_native'})).balance_adjustments,[]);
 for(const adjustments of[undefined,[mov(X,'adjustment',[line('9.000000','13.000000')])],[mov(X,'receipt',[line('10.000000','14.000000')])],[mov(X,'adjustment',[line('10.000000','14.000000',B)])],
  [mov(X,'adjustment',[line('10.000000','14.000000')]),mov(DOC,'adjustment',[line('10.000000','24.000000')])]])
  await bad(project(path,'POST',body,{movement:reversal,balance_adjustments:adjustments,replayed:false,data_mode:'erp_native'}));
 await bad(project(path,'POST',body,{movement:{...reversal,reverses_id:X},balance_adjustments:[],replayed:false,data_mode:'erp_native'}));
});

test('145 composed handler: the suggestion route authenticates the actor and reaches the protected RPC',async()=>{
 const calls=[];const handler=createHandler({fetchImpl:async(url,options)=>{calls.push({url,...options});return new Response(JSON.stringify(url.endsWith('/user')?{id:USER}:context()),{status:200});}});
 const response=await handler(new Request(`https://api.example.test/v1/estoque/sugestao?product_id=${P}`,{headers:{Authorization:'Bearer synthetic-user'}}),env);
 assert.equal(response.status,200);const json=await response.json();assert.equal(json.private,undefined);assert.equal(json.last_purchase.unit_price,'2.5000000000');
 assert.ok(calls[1].url.endsWith('/rpc/erp_stock_launch_context'));assert.deepEqual(JSON.parse(calls[1].body),{p_product_id:P,p_user_id:USER});
});
