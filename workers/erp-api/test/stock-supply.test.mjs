import test from 'node:test';
import assert from 'node:assert/strict';
import {stockRoute,stockMethods,stockOperation,stockResponse} from '../src/stock.mjs';
import {initialBalanceArgs,initialBalanceDto} from '../src/stock-supply.mjs';

// Routes of the estoque lane, wave C (181/183), under /v1/estoque. Synthetic IDs only.
const P='a8000000-0000-4000-8000-000000000001',Q='a8000000-0000-4000-8000-000000000002',W='b8000000-0000-4000-8000-000000000001',V='b8000000-0000-4000-8000-000000000002';
const S='c8000000-0000-4000-8000-000000000001',CMD='d8000000-0000-4000-8000-000000000001',M='e8000000-0000-4000-8000-000000000001',N='e8000000-0000-4000-8000-000000000002';
const request=(path,body,method='POST')=>{const url=new URL(`https://api.example.test${path}`);
 return {url,request:body===undefined?new Request(url):new Request(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})};};
const parse=async(path,body)=>{const {url,request:r}=request(path,body);return stockOperation(r,stockRoute(url.pathname),url.searchParams);};
const project=async(path,value,body)=>stockResponse(value,stockRoute(new URL(`https://x${path}`).pathname),await parse(path,body));
const invalid=promise=>assert.rejects(promise,error=>error.status===400);
const upstream=promise=>assert.rejects(promise,error=>error.status===502);

test('181/183 routes, methods and strict params',async()=>{
 assert.deepEqual(stockMethods(stockRoute('/v1/estoque/depositos/opcoes')),['GET']);assert.deepEqual(stockMethods(stockRoute('/v1/estoque/fornecedores')),['GET']);
 assert.deepEqual(stockMethods(stockRoute('/v1/estoque/transferencias/posicoes')),['GET']);assert.deepEqual(stockMethods(stockRoute('/v1/estoque/transferencias')),['POST']);
 assert.deepEqual((await parse('/v1/estoque/depositos/opcoes')).args,{});await invalid(parse('/v1/estoque/depositos/opcoes?q=a'));
 assert.deepEqual((await parse('/v1/estoque/fornecedores?q=Alfa')).args,{p_query:'Alfa'});assert.deepEqual((await parse('/v1/estoque/fornecedores')).args,{p_query:null});
 for(const query of['?q=','?q=a&q=b','?nome=a'])await invalid(parse(`/v1/estoque/fornecedores${query}`));
 assert.deepEqual((await parse(`/v1/estoque/transferencias/posicoes?origem=${W.toUpperCase()}&destino=${V}&produtos=${P},${Q.toUpperCase()}`)).args,{p_source_id:W,p_destination_id:V,p_product_ids:[P,Q]});
 for(const query of[`origem=${W}&destino=${W}&produtos=${P}`,`origem=${W}&produtos=${P},${P}`,`origem=${W}&produtos=x`,`destino=${V}&produtos=${P}`,`origem=${W}&produtos=${Array.from({length:51},(_,i)=>P.replace(/1$/,String(i%10))).join(',')}`])
  await invalid(parse(`/v1/estoque/transferencias/posicoes?${query}`));
 const body={command_id:CMD,source_id:W,destination_id:V,note:'Reposição',items:[{product_id:P,quantity:'2.5',source_version:3,destination_version:0,unit_price:'1,5'.replace(',','.'),unit_cost:null}]};
 assert.deepEqual((await parse('/v1/estoque/transferencias',body)).args,{p_command_id:CMD,p_source_id:W,p_destination_id:V,p_note:'Reposição',
  p_items:[{product_id:P,quantity:'2.5',source_version:3,destination_version:0,unit_price:'1.5',unit_cost:null}]});
 for(const patch of[{destination_id:W},{items:[]},{items:[{...body.items[0],quantity:'0'}]},{items:[{...body.items[0],quantity:'-1'}]},{items:[{...body.items[0],lot:'L'}]},
  {items:[body.items[0],body.items[0]]},{items:[{...body.items[0],unit_price:'1,5'}]},{note:'a\nb'},{extra:true}])await invalid(parse('/v1/estoque/transferencias',{...body,...patch}));
 await invalid(parse('/v1/estoque/transferencias?x=1',body));
});

test('181 answers fail closed: warehouse options, suppliers and the transfer grid',async()=>{
 const options={scope:'stock_warehouse_options',data_mode:'erp_native',total:2,items:[{id:W,name:'Geral',active:true,is_default:true,ignore_balance:false},{id:V,name:'Avarias',active:false,is_default:false,ignore_balance:true}]};
 assert.equal((await project('/v1/estoque/depositos/opcoes',options)).items.length,2);
 for(const value of[{...options,total:3},{...options,items:[options.items[0],{...options.items[1],is_default:true}]},{...options,items:[{...options.items[0],active:false}]},{...options,items:[{...options.items[0],extra:1}]}])
  await upstream(project('/v1/estoque/depositos/opcoes',value));
 const suppliers={scope:'stock_suppliers',data_mode:'erp_native',query:'a',total:1,items:[{id:S,name:'Fornecedor',code:null,active:true,products:2}]};
 assert.equal((await project('/v1/estoque/fornecedores?q=a',suppliers)).items[0].products,2);
 await upstream(project('/v1/estoque/fornecedores?q=b',suppliers));await upstream(project('/v1/estoque/fornecedores?q=a',{...suppliers,items:[{...suppliers.items[0],products:-1}]}));
 const ref=id=>({id,name:'Depósito',active:true,ignore_balance:false});
 const grid={scope:'stock_transfer_positions',data_mode:'erp_native',source:ref(W),destination:ref(V),show_unit_price:true,
  items:[{product_id:P,name:'Caneta',code:'C1',unit:'UN',kind:'P',format:'S',active:true,eligibility:'eligible',source:{quantity:'5.000000',version:2,reserved:'1.000000'},destination:{quantity:'0.000000',version:0},suggested_price:'1.2000000000',suggested_cost:null}]};
 const path=`/v1/estoque/transferencias/posicoes?origem=${W}&destino=${V}&produtos=${P}`;
 assert.equal((await project(path,grid)).items[0].source.reserved,'1.000000');
 for(const value of[{...grid,source:ref(V)},{...grid,items:[{...grid.items[0],eligibility:'eligible',active:false}]},{...grid,items:[{...grid.items[0],eligibility:'perhaps'}]},
  {...grid,items:[{...grid.items[0],source:{...grid.items[0].source,reserved:'-1.000000'}}]},{...grid,items:[{...grid.items[0],product_id:Q}]},{...grid,items:[]}])await upstream(project(path,value));
});

test('183 batch receipt: every asked product once, exact quantities and the asked prices',async()=>{
 const body={command_id:CMD,source_id:W,destination_id:V,note:null,items:[{product_id:P,quantity:'2',source_version:3,destination_version:0,unit_price:'1.5'},{product_id:Q,quantity:'1',source_version:1,destination_version:1}]};
 const line=(product,movement,patch={})=>({product_id:product,name:'Produto',code:null,unit:'UN',quantity:product===P?'2.000000':'1.000000',movement_id:movement,source_balance_after:'1.000000',destination_balance_after:'2.000000',
  unit_price:product===P?'1.5000000000':null,unit_cost:null,...patch});
 const value=(patch={},items=[line(P,M),line(Q,N)])=>({scope:'stock_transfer_batch',data_mode:'erp_native',replayed:false,receipt:{command_id:CMD,source:{id:W,name:'Origem'},destination:{id:V,name:'Destino'},
  note:'Transferência',occurred_on:'2026-10-20',items,saved_at:'2026-10-20T12:00:00Z'},...patch});
 const out=await project('/v1/estoque/transferencias',value(),body);assert.deepEqual([out.receipt.items.length,out.replayed],[2,false]);
 for(const forged of[value({},[line(P,M)]),value({},[line(P,M),line(P,N)]),value({},[line(P,M,{quantity:'3.000000'}),line(Q,N)]),value({},[line(P,M,{unit_price:'1.4000000000'}),line(Q,N)]),
  value({},[line(P,M),line(Q,M)]),value({receipt:{...value().receipt,command_id:Q}})])await upstream(project('/v1/estoque/transferencias',forged,body));
 // A replay may come with the prices stored by the first execution.
 assert.equal((await project('/v1/estoque/transferencias',value({replayed:true},[line(P,M,{unit_price:'9.0000000000'}),line(Q,N)]),body)).replayed,true);
});

test('183 saldo inicial: strict body inside the product data and an exact receipt',()=>{
 assert.deepEqual(initialBalanceArgs({warehouse_id:W.toUpperCase(),quantity:'2.5',unit_price:'1',note:'Abertura'}),{p_warehouse_id:W,p_quantity:'2.5',p_unit_price:'1',p_unit_cost:null,p_note:'Abertura'});
 for(const value of[{warehouse_id:W,quantity:'0'},{warehouse_id:W,quantity:'1,5'},{warehouse_id:'x',quantity:'1'},{warehouse_id:W,quantity:'1',lot:'L'},{warehouse_id:W,quantity:'1',note:'a\nb'},{warehouse_id:W,quantity:'1',unit_cost:'1,2'}])
  assert.throws(()=>initialBalanceArgs(value),error=>error.status===400);
 const args={p_command_id:CMD,p_warehouse_id:W,p_quantity:'2.5',p_unit_price:'1',p_unit_cost:null};
 const receipt={command_id:CMD,warehouse_id:W,warehouse_name:'Geral',quantity:'2.500000',movement_id:M,occurred_on:'2026-10-20',unit_price:'1.0000000000',unit_cost:null,note:'Saldo inicial'};
 assert.equal(initialBalanceDto(receipt,args,P,false).quantity,'2.500000');
 for(const forged of[{...receipt,quantity:'3.000000'},{...receipt,warehouse_id:V},{...receipt,unit_price:'2.0000000000'},{...receipt,extra:1},{...receipt,note:''}])
  assert.throws(()=>initialBalanceDto(forged,args,P,false),error=>error.status===502);
});

test('181 dashboards: Fornecedor and Tipo de Estoque only when used; Custo of the supplier recomputed; older answers keep the custo médio',async()=>{
 assert.deepEqual((await parse(`/v1/estoque/painel/estoque?fornecedor=${S.toUpperCase()}&tipo_estoque=virtual`)).args,{p_query:null,p_search_by:'description',p_warehouse_id:null,p_brand:null,p_page:1,p_size:100,p_supplier_id:S,p_stock_type:'virtual'});
 for(const query of['tipo_estoque=composicao','fornecedor=x','tipo_estoque=fisico&tipo_estoque=virtual'])await invalid(parse(`/v1/estoque/painel/estoque?${query}`));
 const item={product_id:P,code:'C',name:'Caneta',quantity:'4.000000',value:'10.00',average_cost:'1.2500000000',cost:'5.00',supplier_cost:'2.0000000000',unit_cost:'2.0000000000',cost_source:'supplier',stock_cost:'8.00'};
 const stock=(patch={},row=item)=>({scope:'stock_dashboard_stock',data_mode:'erp_native',page:1,size:100,total:1,filters:{query:null,search_by:'description',warehouse_id:null,brand:null,supplier_id:S,stock_type:'physical'},
  items:[row],totals:{quantity:'4.000000',value:'10.00',unpriced:0,cost:'5.00',uncosted:0,stock_cost:'8.00',stock_uncosted:0,supplier_costed:1},cost_visible:true,cost_basis:'preco_compra',
  warehouses:[{warehouse_id:W,name:'Geral',ignored:false,quantity:'4.000000',value:'10.00',cost:'5.00',stock_cost:'8.00'}],...patch});
 const path=`/v1/estoque/painel/estoque?fornecedor=${S}&tipo_estoque=fisico`,out=await project(path,stock());
 assert.deepEqual([out.items[0].stock_cost,out.items[0].cost_source,out.totals.stock_cost,out.filters.supplier_id,out.filters.stock_type],['8.00','supplier','8.00',S,'physical']);
 for(const value of[stock({},{...item,stock_cost:'8.01'}),stock({},{...item,cost_source:'average'}),stock({},{...item,unit_cost:'1.2500000000'}),stock({filters:{...stock().filters,supplier_id:null}}),
  stock({totals:{...stock().totals,stock_uncosted:null}})])await upstream(project(path,value));
 const average=await project(path,stock({},{...item,supplier_cost:null,unit_cost:'1.2500000000',cost_source:'average',stock_cost:'5.00'}));assert.equal(average.items[0].cost_source,'average');
 // A database still on 145: no new fields, never asked for the new filters.
 const legacy={...stock(),filters:{query:null,search_by:'description',warehouse_id:null,brand:null},items:[{product_id:P,code:'C',name:'Caneta',quantity:'4.000000',value:'10.00',average_cost:'1.2500000000',cost:'5.00'}],
  totals:{quantity:'4.000000',value:'10.00',unpriced:0,cost:'5.00',uncosted:0},warehouses:[{warehouse_id:W,name:'Geral',ignored:false,quantity:'4.000000',value:'10.00',cost:'5.00'}]};
 const old=await project('/v1/estoque/painel/estoque',legacy);
 assert.deepEqual([old.items[0].stock_cost,old.items[0].cost_source,old.totals.stock_cost,old.warehouses[0].stock_cost],['5.00','average','5.00','5.00']);
 await upstream(project(path,legacy));
 // Sugestão: supplier filter, price origin and the row supplier.
 const sPath=`/v1/estoque/painel/sugestao?de=2026-10-01&ate=2026-10-30&cobertura=30&compras=open&vendas=open&fornecedor=${S}`;
 assert.equal((await parse(sPath)).args.p_supplier_id,S);
 const sug=(patch={},row={})=>({scope:'stock_purchase_suggestion',data_mode:'erp_native',days:30,total:1,price_mode:'compra',filters:{date_from:'2026-10-01',date_to:'2026-10-30',coverage:30,warehouse_id:null,reserve:false,
  purchase_statuses:['open'],sales_statuses:['open'],brand:null,supplier_id:S},items:[{product_id:P,code:'C',name:'Caneta',unit:'UN',sold:'30.000000',stock:'0.000000',reserved:'0.000000',ordered:'0.000000',
  suggestion:'30',unit_price:'2.0000000000',value:'60.00',price_source:'supplier_purchase',supplier_id:S,supplier_name:'Fornecedor',...row}],...patch});
 assert.deepEqual((await project(sPath,sug())).items[0].supplier_id,S);
 for(const value of[sug({},{price_source:'supplier_cost'}),sug({},{supplier_id:Q}),sug({},{price_source:null}),sug({price_mode:'outro'}),sug({filters:{...sug().filters,supplier_id:null}}),sug({},{unit:''})])
  await upstream(project(sPath,value));
});

test('184 document stock and purchase receipts accept the chosen warehouse only on the receive/post side',async()=>{
 const {parseDocumentStockRoute}=await import('../src/document-stock.mjs'),{parsePurchaseReceiptsRoute}=await import('../src/purchase-receipts.mjs');
 const post=(path,body)=>new Request('https://erp.invalid'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const doc=`/v1/documentos-estoque/sales_orders/${P}`,base={expected_document_version:3,occurred_on:'2026-10-20',reason:'Saída conferida'};
 const preview=await parseDocumentStockRoute(post(`${doc}/preview`,{...base,warehouse_id:W.toUpperCase()}));
 assert.deepEqual([preview.rpc,preview.args.p_warehouse_id],['erp_stock_document_warehouse_preview',W]);
 assert.equal((await parseDocumentStockRoute(post(`${doc}/preview`,base))).rpc,'erp_document_stock_preview','without warehouse the published RPC');
 const posted=await parseDocumentStockRoute(post(`${doc}/post`,{...base,warehouse_id:W,command_id:CMD,preview_hash:'a'.repeat(64),ignored_item_ids:[]}));assert.equal(posted.rpc,'erp_stock_document_warehouse_post');
 await assert.rejects(parseDocumentStockRoute(post(`${doc}/preview`,{...base,warehouse_id:'x'})),error=>error.status===400);
 await assert.rejects(parseDocumentStockRoute(post(`${doc}/${M}/reverse-preview`,{...base,expected_posting_version:1,warehouse_id:W})),error=>error.status===400,'a reversal never chooses a warehouse');
 const receipts=`/v1/recebimentos-compras/${P}`,items=[{item_id:Q,quantity:'1'}];
 const rp=await parsePurchaseReceiptsRoute(post(`${receipts}/preview`,{...base,items,warehouse_id:W}));assert.deepEqual([rp.rpc,rp.args.p_warehouse_id],['erp_stock_purchase_receive_preview',W]);
 const rr=await parsePurchaseReceiptsRoute(post(`${receipts}/receive`,{...base,items,warehouse_id:W,command_id:CMD,preview_hash:'a'.repeat(64),confirmed:true}));assert.equal(rr.rpc,'erp_stock_purchase_receive');
 assert.equal((await parsePurchaseReceiptsRoute(post(`${receipts}/preview`,{...base,items}))).rpc,'erp_purchase_receipts_preview');
 await assert.rejects(parsePurchaseReceiptsRoute(post(`${receipts}/${M}/reverse-preview`,{...base,warehouse_id:W})),error=>error.status===400);
});
