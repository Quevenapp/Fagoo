import test from 'node:test';
import assert from 'node:assert/strict';
import {stockRoute,stockMethods,stockOperation,stockResponse} from '../src/stock.mjs';

// Routes of migration 107 under /v1/estoque/painel. Synthetic IDs only.
const P='a4000000-0000-4000-8000-000000000001',W='b4000000-0000-4000-8000-000000000001',CMD='c4000000-0000-4000-8000-000000000001';
const parse=async(path,body)=>{const url=new URL(`https://api.example.test${path}`),request=body===undefined?new Request(url):new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return stockOperation(request,stockRoute(url.pathname),url.searchParams);};
const project=async(path,value,body)=>stockResponse(value,stockRoute(new URL(`https://x${path}`).pathname),await parse(path,body));
const invalid=promise=>assert.rejects(promise,error=>error.status===400);
const upstream=promise=>assert.rejects(promise,error=>error.status===502);
const suggestionPath='/v1/estoque/painel/sugestao?de=2026-10-01&ate=2026-10-30&cobertura=47&compras=open,in_progress&vendas=open,fulfilled';
const suggestion=(patch={},row={})=>({scope:'stock_purchase_suggestion',data_mode:'erp_native',days:30,total:1,filters:{date_from:'2026-10-01',date_to:'2026-10-30',coverage:47,warehouse_id:null,reserve:false,purchase_statuses:['in_progress','open'],sales_statuses:['fulfilled','open'],brand:null},
 items:[{product_id:P,code:'CAN-1',name:'Caneta',sold:'6.000000',stock:'4.000000',reserved:'0.000000',ordered:'4.000000',suggestion:'1',unit_price:'1.2000000000',value:'1.20',...row}],...patch});

test('dashboard routes and strict params',async()=>{
 assert.deepEqual(stockMethods(stockRoute('/v1/estoque/painel/ajustes')),['GET','POST']);for(const path of['estoque','sem-movimentacao','sugestao'])assert.deepEqual(stockMethods(stockRoute(`/v1/estoque/painel/${path}`)),['GET']);
 assert.equal(stockRoute('/v1/estoque/painel'),null);
 assert.deepEqual((await parse(`/v1/estoque/painel/estoque?q=Can&pesquisar_por=code&warehouse_id=${W.toUpperCase()}&marca=Acme&pagina=2`)).args,{p_query:'Can',p_search_by:'code',p_warehouse_id:W,p_brand:'Acme',p_page:2,p_size:100});
 assert.deepEqual((await parse(suggestionPath)).args,{p_date_from:'2026-10-01',p_date_to:'2026-10-30',p_coverage:47,p_warehouse_id:null,p_reserve:false,p_purchase_statuses:['open','in_progress'],p_sales_statuses:['open','fulfilled'],p_brand:null});
 for(const query of['de=2026-10-31&ate=2026-10-01&cobertura=30&compras=open&vendas=open','de=2026-10-01&ate=2026-10-30&cobertura=0&compras=open&vendas=open','de=2026-10-01&ate=2026-10-30&cobertura=30&compras=open,open&vendas=open',
  'de=2026-10-01&ate=2026-10-30&cobertura=30&compras=aberto&vendas=open','de=2026-10-01&ate=2026-10-30&cobertura=30&vendas=open','de=2026-10-01&ate=2026-10-30&cobertura=30&compras=open&vendas=open&reserva=talvez'])
  await invalid(parse(`/v1/estoque/painel/sugestao?${query}`));
 await invalid(parse('/v1/estoque/painel/estoque?pesquisar_por=sku'));await invalid(parse('/v1/estoque/painel/sem-movimentacao'));await invalid(parse('/v1/estoque/painel/sem-movimentacao?data=2026-02-30'));
 assert.deepEqual((await parse('/v1/estoque/painel/ajustes',{command_id:CMD,expected_version:0,purchase_statuses:['open'],sales_statuses:['open']})).args,{p_command_id:CMD,p_expected_version:0,p_purchase_statuses:['open'],p_sales_statuses:['open']});
 for(const body of[{command_id:CMD,expected_version:0,purchase_statuses:[],sales_statuses:['open']},{command_id:CMD,expected_version:0,purchase_statuses:['open'],sales_statuses:['open','open']},{command_id:CMD,expected_version:0,purchase_statuses:['x'],sales_statuses:['open']}])
  await invalid(parse('/v1/estoque/painel/ajustes',body));
});

test('dashboard responses fail closed: the suggestion formula is recomputed exactly; totals and filters must match',async()=>{
 assert.equal((await project(suggestionPath,suggestion())).items[0].suggestion,'1');
 for(const value of[suggestion({},{suggestion:'2'}),suggestion({},{suggestion:'1.0'}),suggestion({days:31}),suggestion({filters:{...suggestion().filters,coverage:30}}),suggestion({},{reserved:'1.000000'}),suggestion({},{sold:'0.000000'}),suggestion({},{unit_price:null}),suggestion({total:2})])
  await upstream(project(suggestionPath,value));
 assert.equal((await project(suggestionPath,suggestion({},{sold:'1.000000',suggestion:'0'}))).items[0].suggestion,'0','never negative');
 // Reserva = Sim: Estoque Atual is the balance less the reserved quantity, so the reservation raises the suggestion.
 const reservedPath=`${suggestionPath}&reserva=sim`,reserved=(row,patch={})=>suggestion({filters:{...suggestion().filters,reserve:true},...patch},row);
 assert.equal((await project(reservedPath,reserved({reserved:'1.000000',suggestion:'2'}))).items[0].suggestion,'2','floor(6 x 47 / 30 - (4 - 1) - 4) = floor(2.4)');
 await upstream(project(reservedPath,reserved({reserved:'1.000000',suggestion:'0'})));
 const stock={scope:'stock_dashboard_stock',data_mode:'erp_native',page:1,size:100,total:1,filters:{query:null,search_by:'description',warehouse_id:null,brand:null},
  items:[{product_id:P,code:'CAN-1',name:'Caneta',quantity:'4.000000',value:'10.00',average_cost:'1.2500000000',cost:'5.00'}],totals:{quantity:'4.000000',value:'10.00',unpriced:0,cost:'5.00',uncosted:0},
  cost_visible:true,cost_basis:'preco_compra',
  warehouses:[{warehouse_id:W,name:'Geral',ignored:false,quantity:'4.000000',value:'10.00',cost:'5.00'},{warehouse_id:P,name:'Avarias',ignored:true,quantity:'5.000000',value:'12.50',cost:'6.25'}]};
 assert.equal((await project('/v1/estoque/painel/estoque',stock)).warehouses.length,2);
 await upstream(project('/v1/estoque/painel/estoque',{...stock,totals:{...stock.totals,quantity:'9.000000'}}));
 await upstream(project('/v1/estoque/painel/estoque',{...stock,total:2}));
 const idle={scope:'stock_dashboard_idle',data_mode:'erp_native',since:'2026-10-01',page:1,size:100,total:1,items:[{product_id:P,code:null,name:'Caneta',quantity:'4.000000',last_sale:'2026-09-30'}]};
 assert.equal((await project('/v1/estoque/painel/sem-movimentacao?data=2026-10-01',idle)).items[0].last_sale,'2026-09-30');
 await upstream(project('/v1/estoque/painel/sem-movimentacao?data=2026-10-01',{...idle,items:[{...idle.items[0],last_sale:'2026-10-01'}]}));
 await upstream(project('/v1/estoque/painel/sem-movimentacao?data=2026-10-01',{...idle,items:[{...idle.items[0],quantity:'0.000000'}]}));
});
