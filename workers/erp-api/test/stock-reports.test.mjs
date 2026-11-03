import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
import {stockRoute,stockMethods,stockOperation,stockResponse} from '../src/stock.mjs';

// Routes and projections of migration 146 (relatórios de suprimentos) under /v1/estoque/relatorios. Synthetic IDs only.
const USER='a1460000-0000-4000-8000-000000000001',P='b1460000-0000-4000-8000-000000000001',W='c1460000-0000-4000-8000-000000000001',V='c1460000-0000-4000-8000-000000000002',M='d1460000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://exampleproject.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',ALLOWED_ORIGINS:'https://erp.example.test'};
const request=(path,method='GET')=>new Request(`https://api.example.test${path}`,{method});
const parse=async(path,method='GET')=>{const req=request(path,method),url=new URL(req.url);return stockOperation(req,stockRoute(url.pathname),url.searchParams);};
const project=async(path,value)=>{const op=await parse(path);return stockResponse(value,stockRoute(new URL(`https://x${path}`).pathname),op);};
const invalid=promise=>assert.rejects(promise,error=>error.status===400&&error.code==='ERP_INVALID_QUERY');
const bad=promise=>assert.rejects(promise,error=>error.status===502&&error.code==='ERP_UPSTREAM_INVALID_RESPONSE');
const product={product_id:P,code:'P-1',name:'Produto relatório',unit:'UN'};

test('146 routes: ten GET reports with strict params',async()=>{
 for(const id of['entradas-saidas','transferencias','saldos','maior-circulacao','sem-movimentacao','abaixo-minimo','visao-financeira','movimentacao-produto','pedidos-compra','notas-entrada'])
  assert.deepEqual(stockMethods(stockRoute(`/v1/estoque/relatorios/${id}`)),['GET'],id);
 assert.equal(stockRoute('/v1/estoque/relatorios/outro'),null);
 await assert.rejects(parse('/v1/estoque/relatorios/saldos?data=2026-10-01','POST'),error=>error.status===405);
 assert.deepEqual((await parse(`/v1/estoque/relatorios/entradas-saidas?de=2026-10-01&ate=2026-10-20&warehouse_id=${W.toUpperCase()}&offset=500`)).args,
  {p_date_from:'2026-10-01',p_date_to:'2026-10-20',p_warehouse_id:W,p_product_id:null,p_offset:500,p_limit:500});
 assert.deepEqual((await parse('/v1/estoque/relatorios/pedidos-compra?de=2026-10-01&ate=2026-10-20&situacoes=open,in_progress&agrupar=produto')).args,
  {p_date_from:'2026-10-01',p_date_to:'2026-10-20',p_statuses:['open','in_progress'],p_group:'product'});
 assert.equal((await parse('/v1/estoque/relatorios/notas-entrada?de=2026-10-01&ate=2026-10-20&agrupar=evolucao')).args.p_group,'month');
 assert.equal((await parse('/v1/estoque/relatorios/maior-circulacao?de=2026-10-01&ate=2026-10-20')).args.p_limit,50);
 for(const path of['entradas-saidas?de=2026-10-20&ate=2026-10-01','entradas-saidas?de=2026-10-01','entradas-saidas?de=2016-01-01&ate=2026-10-20','saldos?data=2026-02-30','saldos?data=2026-10-01&x=1',
  'saldos?data=2026-10-01&data=2026-10-02','maior-circulacao?de=2026-10-01&ate=2026-10-20&limite=501','pedidos-compra?de=2026-10-01&ate=2026-10-20&situacoes=open,open&agrupar=produto',
  'pedidos-compra?de=2026-10-01&ate=2026-10-20&situacoes=draft&agrupar=produto','notas-entrada?de=2026-10-01&ate=2026-10-20&agrupar=mes','movimentacao-produto?de=2026-10-01&ate=2026-10-20','abaixo-minimo?offset=-1'])
  await invalid(parse(`/v1/estoque/relatorios/${path}`));
});

test('146 projections recompute nets, sums, values and the running balance; anything else fails closed',async()=>{
 const movements=(patch={},items=[{...product,entries:'10.000000',exits:'4.000000',balances:'3.000000',net:'9.000000',launches:4}])=>({scope:'stock_report_movements',data_mode:'erp_native',
  filters:{date_from:'2026-10-01',date_to:'2026-10-20',warehouse_id:null,product_id:null},offset:0,limit:500,total:items.length,items,totals:{entries:'10.000000',exits:'4.000000',balances:'3.000000',net:'9.000000'},...patch});
 const path='/v1/estoque/relatorios/entradas-saidas?de=2026-10-01&ate=2026-10-20';
 assert.equal((await project(path,movements())).items[0].net,'9.000000');
 for(const value of[movements({},[{...product,entries:'10.000000',exits:'4.000000',balances:'3.000000',net:'8.000000',launches:4}]),movements({totals:{entries:'11.000000',exits:'4.000000',balances:'3.000000',net:'10.000000'}}),
  movements({filters:{date_from:'2026-10-02',date_to:'2026-10-20',warehouse_id:null,product_id:null}}),movements({total:2}),movements({},[{...product,entries:'-1.000000',exits:'0.000000',balances:'0.000000',net:'-1.000000',launches:1}])])
  await bad(project(path,value));
 const daysPath=`/v1/estoque/relatorios/movimentacao-produto?product_id=${P}&de=2026-10-01&ate=2026-10-20`;
 const days=(patch={})=>({scope:'stock_report_product',data_mode:'erp_native',product,filters:{product_id:P,date_from:'2026-10-01',date_to:'2026-10-20',warehouse_id:null},opening:'2.000000',
  days:[{date:'2026-10-02',entries:'5.000000',exits:'1.000000',balance:'6.000000'},{date:'2026-10-05',entries:'0.000000',exits:'6.500000',balance:'-0.500000'}],closing:'-0.500000',totals:{entries:'5.000000',exits:'7.500000'},...patch});
 assert.equal((await project(daysPath,days())).days.length,2);
 for(const value of[days({closing:'0.000000'}),days({days:[...days().days].reverse()}),days({opening:'1.000000'}),days({totals:{entries:'5.000000',exits:'7.000000'}}),days({days:[{date:'2026-09-30',entries:'0.000000',exits:'0.000000',balance:'2.000000'}],closing:'2.000000',totals:{entries:'0.000000',exits:'0.000000'}})])
  await bad(project(daysPath,value));
 const finPath='/v1/estoque/relatorios/visao-financeira';
 const fin=(item={})=>({scope:'stock_report_financial',data_mode:'erp_native',filters:{warehouse_id:null},cost_basis:'preco_compra',offset:0,limit:500,total:1,
  items:[{...product,quantity:'3.000000',average_cost:'0.3333333333',cost_value:'1.00',sale_price:'2.5000000000',sale_value:'7.50',margin:'6.50',...item}],
  totals:{quantity:'3.000000',cost_value:'1.00',sale_value:'7.50',margin:'6.50',uncosted:item.average_cost===null?1:0,unpriced:0}});
 assert.equal((await project(finPath,fin())).items[0].margin,'6.50');
 assert.equal((await project(finPath,fin({average_cost:null,cost_value:null,margin:null}))).items[0].cost_value,null);
 for(const value of[fin({cost_value:'0.99'}),fin({margin:'6.49'}),fin({sale_value:'7.49'}),fin({average_cost:null,cost_value:'1.00'}),{...fin(),cost_basis:'outro'}])await bad(project(finPath,value));
 const below=(item={})=>({scope:'stock_report_below_min',data_mode:'erp_native',filters:{warehouse_id:W},offset:0,limit:500,total:1,items:[{...product,stock_min:'20.000000',stock_max:null,quantity:'9.000000',missing:'11.000000',...item}]});
 assert.equal((await project(`/v1/estoque/relatorios/abaixo-minimo?warehouse_id=${W}`,below())).items[0].missing,'11.000000');
 for(const value of[below({missing:'10.000000'}),below({quantity:'20.000000',missing:'0.000000'})])await bad(project(`/v1/estoque/relatorios/abaixo-minimo?warehouse_id=${W}`,value));
 const transfers=(item={})=>({scope:'stock_report_transfers',data_mode:'erp_native',filters:{date_from:'2026-10-01',date_to:'2026-10-20',warehouse_id:V},offset:0,limit:500,total:1,
  items:[{...product,movement_id:M,occurred_on:'2026-10-06',quantity:'2.000000',source_id:W,source_name:'A',destination_id:V,destination_name:'B',note:'Transferência',reversed:false,...item}]});
 const tPath=`/v1/estoque/relatorios/transferencias?de=2026-10-01&ate=2026-10-20&warehouse_id=${V}`;
 assert.equal((await project(tPath,transfers())).items[0].destination_name,'B');
 for(const value of[transfers({destination_id:W}),transfers({occurred_on:'2026-09-30'}),transfers({quantity:'-2.000000'})])await bad(project(tPath,value));
 const po=(patch={})=>({scope:'stock_report_purchase_orders',data_mode:'erp_native',filters:{date_from:'2026-10-01',date_to:'2026-10-20',statuses:['in_progress','open'],group:'supplier'},total:1,
  items:[{key:W,label:'Fornecedor',code:null,orders:1,quantity:'3.000000',value:'5.00'}],totals:{orders:1,quantity:'3.000000',value:'5.00'},...patch});
 const poPath='/v1/estoque/relatorios/pedidos-compra?de=2026-10-01&ate=2026-10-20&situacoes=open,in_progress&agrupar=fornecedor';
 assert.equal((await project(poPath,po())).items[0].value,'5.00');
 for(const value of[po({filters:{date_from:'2026-10-01',date_to:'2026-10-20',statuses:['open'],group:'supplier'}}),po({items:[{key:W,label:'Fornecedor',code:null,orders:0,quantity:'3.000000',value:'5.00'}]}),po({total:2})])await bad(project(poPath,value));
 const notes=(patch={})=>({scope:'stock_report_entry_notes',data_mode:'erp_native',filters:{date_from:'2026-10-01',date_to:'2026-10-20',group:'product'},total:1,
  items:[{key:P,label:'Produto relatório',code:'P-1',notes:1,quantity:'2.0000',value:'100.00'}],totals:{notes:1,value:'100.00'},...patch});
 const nPath='/v1/estoque/relatorios/notas-entrada?de=2026-10-01&ate=2026-10-20&agrupar=produto';
 assert.equal((await project(nPath,notes())).items[0].quantity,'2.0000');
 await bad(project(nPath,notes({items:[{key:P,label:'Produto relatório',code:'P-1',notes:1,quantity:null,value:'100.00'}]})));
});

test('146 composed handler: a report authenticates the actor and reaches the protected RPC',async()=>{
 const calls=[];const value={scope:'stock_report_balances_at',data_mode:'erp_native',filters:{date:'2026-10-05',warehouse_id:null},offset:0,limit:500,total:1,items:[{...product,quantity:'7.000000'}],totals:{quantity:'7.000000'},private:'x'};
 const handler=createHandler({fetchImpl:async(url,options)=>{calls.push({url,...options});return new Response(JSON.stringify(url.endsWith('/user')?{id:USER}:value),{status:200});}});
 const response=await handler(new Request('https://api.example.test/v1/estoque/relatorios/saldos?data=2026-10-05',{headers:{Authorization:'Bearer synthetic-user'}}),env);
 assert.equal(response.status,200);const json=await response.json();assert.equal(json.items[0].quantity,'7.000000');assert.equal(json.private,undefined);
 assert.ok(calls[1].url.endsWith('/rpc/erp_stock_report_balances_at'));assert.deepEqual(JSON.parse(calls[1].body),{p_date:'2026-10-05',p_warehouse_id:null,p_offset:0,p_limit:500,p_user_id:USER});
});
