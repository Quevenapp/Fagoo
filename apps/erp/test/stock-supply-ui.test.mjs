import test from 'node:test';
import assert from 'node:assert/strict';
import {AccessError,mountComponent} from './helpers/component-recovery-harness.mjs';
import {proposedSupplier,purchaseOrderItems,stockDashboardPath,suggestionPath} from '../src/lib/stock-dashboards-model.ts';
import {initialBalancePayload,parseWarehouseOptions,priceField,selectableWarehouses,transferPrice,transferQuantity} from '../src/lib/stock-supply-model.ts';
import {addBox,matchItems,supplierCodeOf} from '../src/lib/receipt-checkin-model.ts';
import {contextSuggestion} from '../src/lib/stock-launch-model.ts';

// Estoque lane, wave C (181/183): Fornecedor, Tipo de Estoque and Custo of the dashboard, "Gerar pedido de compra com os selecionados",
// "Transferir estoque dos produtos selecionados", the light warehouse list, DUN in the check-in and the saldo inicial. Synthetic data only.
globalThis.document??={activeElement:null,getElementById:()=>null,addEventListener(){},removeEventListener(){},body:{classList:{add(){},remove(){}},append(){},style:{}}};
const P='a9000000-0000-4000-8000-000000000001',Q='a9000000-0000-4000-8000-000000000002',R='a9000000-0000-4000-8000-000000000003';
const W='b9000000-0000-4000-8000-000000000001',V='b9000000-0000-4000-8000-000000000002',S='c9000000-0000-4000-8000-000000000001',D='d9000000-0000-4000-8000-000000000001';
const textOf=value=>Array.isArray(value)?value.map(textOf).join(''):value&&typeof value==='object'?textOf(value.props?.children):value===null||value===undefined||typeof value==='boolean'?'':String(value);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const options={scope:'stock_warehouse_options',data_mode:'erp_native',total:3,items:[{id:W,name:'Geral',active:true,is_default:true,ignore_balance:false},{id:V,name:'Loja',active:true,is_default:false,ignore_balance:false},
 {id:'b9000000-0000-4000-8000-000000000009',name:'Antigo',active:false,is_default:false,ignore_balance:false}]};
const suppliers=query=>({scope:'stock_suppliers',data_mode:'erp_native',query,total:1,items:[{id:S,name:'Fornecedor Alfa',code:'F1',active:true,products:3}]});
const sugRow=(id,patch)=>({product_id:id,code:'CAN-1',name:'Caneta',unit:'UN',sold:'6.000000',stock:'0.000000',reserved:'0.000000',ordered:'0.000000',suggestion:'6',unit_price:'1.2000000000',value:'7.20',price_source:'supplier_cost',supplier_id:S,supplier_name:'Fornecedor Alfa',...patch});
function server({role='estoque',documents}={}){
 const calls=[];
 const controller={getSnapshot:()=>({phase:'ready',membership:{role,user_id:'e9000000-0000-4000-8000-000000000001'}}),
  async documents(path,request={}){calls.push({path,...request,body:request.body?structuredClone(request.body):undefined});return documents?documents(path,request):{document:{id:D,kind:'purchase_orders',number:'57',status:'open'}};},
  async stock(path,request={}){calls.push({path,...request,body:request.body?structuredClone(request.body):undefined});const url=new URL(path,'https://synthetic.invalid'),q=url.searchParams;
   if(url.pathname==='/v1/estoque/depositos/opcoes')return options;
   if(url.pathname==='/v1/estoque/fornecedores')return suppliers(q.get('q'));
   if(url.pathname==='/v1/estoque/painel/ajustes')return{scope:'stock_dashboard_preference',data_mode:'erp_native',preference:{purchase_statuses:['open'],sales_statuses:['open'],version:0,updated_at:null}};
   if(url.pathname==='/v1/estoque/painel/estoque')return{scope:'stock_dashboard_stock',data_mode:'erp_native',page:1,size:100,total:2,cost_visible:true,cost_basis:'preco_compra',filters:{},
    items:[{product_id:P,code:'CAN-1',name:'Caneta',quantity:'4.000000',value:'10.00',average_cost:'1.2500000000',cost:'5.00',supplier_cost:'2.0000000000',unit_cost:'2.0000000000',cost_source:'supplier',stock_cost:'8.00'},
     {product_id:Q,code:'LAP-1',name:'Lápis',quantity:'2.000000',value:'4.00',average_cost:'1.0000000000',cost:'2.00',supplier_cost:null,unit_cost:'1.0000000000',cost_source:'average',stock_cost:'2.00'}],
    totals:{quantity:'6.000000',value:'14.00',unpriced:0,cost:'7.00',uncosted:0,stock_cost:'10.00',stock_uncosted:1,supplier_costed:1},warehouses:[{warehouse_id:W,name:'Geral',ignored:false,quantity:'6.000000',value:'14.00',cost:'7.00',stock_cost:'10.00'}]};
   if(url.pathname==='/v1/estoque/painel/sugestao')return{scope:'stock_purchase_suggestion',data_mode:'erp_native',days:30,total:3,price_mode:'custo',
    filters:{date_from:q.get('de'),date_to:q.get('ate'),coverage:Number(q.get('cobertura')),reserve:q.get('reserva')==='sim',supplier_id:q.get('fornecedor')},
    items:[sugRow(P),sugRow(Q,{code:'LAP-1',name:'Lápis',suggestion:'0',value:'0.00'}),sugRow(R,{code:'BOR-1',name:'Borracha',suggestion:'2',unit_price:null,value:null,price_source:null})]};
   throw new Error(`unexpected ${path}`);}};
 return{calls,controller};
}

test('181 Estoque de Produtos: Fornecedor and Tipo de Estoque filters, the 15 minutes hint, Custo of the supplier and the light warehouse list',async()=>{
 const s=server(),view=await mountComponent('StockDashboards.tsx',{controller:s.controller},{location:'/painel-produtos-empresa',expandChildren:['StockProducts','StockDashboardsNav','StockSupplierPicker']});
 try{
  assert.equal(s.calls.some(call=>call.path.startsWith('/v1/estoque/totais')),false,'no totals are computed for the selector');
  assert.match(textOf(view.find(n=>n.props.id==='stock-dash-warehouse')),/^TodosGeralLoja$/,'inactive warehouses stay out of the selector');
  assert.match(view.text(),/podem levar até 15 minutos para ser atualizados no Origin\. No FAGOO, eles são calculados na hora da consulta\./);
  assert.match(view.text(),/CAN-1Caneta4R\$ 8,00R\$ 10,00LAP-1Lápis2R\$ 2,00 médioR\$ 4,00TOTAL6R\$ 10,00R\$ 14,00/);
  assert.match(view.text(),/1 produto\(s\) com estoque e sem custo ficam sem custo/);
  await view.change('stock-dash-supplier','Alf');await wait(300);await view.flush();
  assert.equal(s.calls.at(-1).path,'/v1/estoque/fornecedores?q=Alf');
  view.find(n=>n.type==='button'&&textOf(n).startsWith('Fornecedor Alfa')).props.onClick();await view.flush();
  await view.change('stock-dash-type','virtual');await view.submit();
  assert.equal(s.calls.filter(call=>call.path.startsWith('/v1/estoque/painel/estoque')).at(-1).path,`/v1/estoque/painel/estoque?pesquisar_por=description&fornecedor=${S}&tipo_estoque=virtual`);
  assert.match(view.text(),/O FAGOO ainda não tem composições com estoque virtual/);
 }finally{view.unmount();}
});

test('181 Sugestão de Compras: Fornecedor and "Gerar pedido de compra com os selecionados" through the documentos API, with Conferir resultado',async()=>{
 let fail=true;
 const s=server({documents:()=>{if(fail){fail=false;throw new Error('network');}return{document:{id:D,kind:'purchase_orders',number:'57',status:'open'}};}});
 const view=await mountComponent('StockDashboards.tsx',{controller:s.controller},{location:'/painel-produtos-empresa?painel=sugestao',expandChildren:['PurchaseSuggestion','StockDashboardsNav','StockSupplierPicker','PurchaseOrderPanel','StockSidePanel']});
 try{
  await view.change('stock-sug-supplier','Alfa');await wait(300);await view.flush();
  view.find(n=>n.type==='button'&&textOf(n).startsWith('Fornecedor Alfa')).props.onClick();await view.flush();
  await view.submit();
  assert.match(s.calls.filter(call=>call.path.startsWith('/v1/estoque/painel/sugestao')).at(-1).path,new RegExp(`&fornecedor=${S}$`));
  assert.match(view.text(),/O Valor Estimado usa o preço de custo do fornecedor/);
  assert.equal(view.button('Gerar pedido de compra com os selecionados').disabled,true,'nothing selected');
  assert.equal(view.input(`stock-sug-pick-${Q}`).disabled,true,'a row without suggestion cannot be ordered');
  await view.change('stock-sug-all',true);
  await view.click('Gerar pedido de compra com os selecionados');
  assert.match(view.text(),/Gerar pedido de compraPedido de compraFornecedor \*DepósitoSem depósitoGeralLoja/);assert.equal(view.input('stock-order-supplier').props.value,'Fornecedor Alfa');
  assert.equal(view.input('stock-order-warehouse').props.value,W,'the default warehouse');
  await view.click('Gerar pedido de compra');
  assert.match(view.text(),/Não foi possível confirmar se o pedido de compra foi gerado/);
  const first=s.calls.filter(call=>call.path==='/v1/documentos/purchase_orders').at(-1);
  assert.equal(first.method,'POST');
  const {command_id,data}=first.body;
  assert.deepEqual(data.items,[{product_id:P,description:'Caneta',code:'CAN-1',unit:'UN',quantity:'6',unit_price:'1.2000000000'},{product_id:R,description:'Borracha',code:'BOR-1',unit:'UN',quantity:'2',unit_price:'0'}]);
  assert.deepEqual([data.contact_id,data.warehouse_id,/^\d{4}-\d{2}-\d{2}$/.test(data.date)],[S,W,true]);
  await view.click('Conferir resultado');
  const second=s.calls.filter(call=>call.path==='/v1/documentos/purchase_orders').at(-1);
  assert.deepEqual([second.body.command_id,second.body.data],[command_id,data],'the same command and body');
  assert.match(view.text(),/Pedido de compra nº 57 gerado com os produtos selecionados\. Abrir pedido de compra/);
  assert.equal(view.find(n=>typeof n.props?.to==='string'&&n.props.to.includes('documento=')).props.to,`/documentos-empresa?tipo=purchase_orders&documento=${D}`);
 }finally{view.unmount();}
 // Readers of purchase orders that cannot write them see the suggestion without the action.
 const reader=server({role:'consulta'}),read=await mountComponent('StockDashboards.tsx',{controller:reader.controller},{location:'/painel-produtos-empresa?painel=sugestao',expandChildren:['PurchaseSuggestion','StockDashboardsNav','StockSupplierPicker']});
 try{await read.submit();assert.doesNotMatch(read.text(),/Gerar pedido de compra/);}finally{read.unmount();}
});

test('183 Transferir estoque dos produtos selecionados: grid of the origin, one command, receipt and print',async()=>{
 const calls=[];let fail=false;
 const grid=(source,destination)=>({scope:'stock_transfer_positions',data_mode:'erp_native',source:{id:source,name:'Geral',active:true,ignore_balance:false},destination:destination?{id:destination,name:'Loja',active:true,ignore_balance:false}:null,show_unit_price:true,
  items:[{product_id:P,name:'Caneta',code:'CAN-1',unit:'UN',kind:'P',format:'S',active:true,eligibility:'eligible',source:{quantity:'10.000000',version:4,reserved:'3.000000'},destination:destination?{quantity:'1.000000',version:2}:null,suggested_price:'1.5000000000',suggested_cost:null},
   {product_id:Q,name:'Kit',code:'KIT',unit:'UN',kind:'P',format:'E',active:true,eligibility:'composition',source:{quantity:'0.000000',version:0,reserved:'0.000000'},destination:destination?{quantity:'0.000000',version:0}:null,suggested_price:null,suggested_cost:null}]});
 const controller={getSnapshot:()=>({phase:'ready',membership:{role:'estoque',user_id:'e9000000-0000-4000-8000-000000000001'}}),catalog:async()=>({items:[]}),
  async stock(path,request={}){calls.push({path,...request,body:request.body?structuredClone(request.body):undefined});const url=new URL(path,'https://synthetic.invalid'),q=url.searchParams;
   if(url.pathname==='/v1/estoque/depositos/opcoes')return options;
   if(url.pathname==='/v1/estoque/transferencias/posicoes')return grid(q.get('origem'),q.get('destino'));
   if(url.pathname==='/v1/estoque/transferencias'){if(fail)throw new AccessError(409);const b=request.body;
    return{scope:'stock_transfer_batch',data_mode:'erp_native',replayed:false,receipt:{command_id:b.command_id,source:{id:b.source_id,name:'Geral'},destination:{id:b.destination_id,name:'Loja'},note:b.note??'Transferência',occurred_on:'2026-10-20',saved_at:'2026-10-20T12:00:00Z',
     items:b.items.map(item=>({product_id:item.product_id,name:'Caneta',code:'CAN-1',unit:'UN',quantity:'2.000000',movement_id:'f9000000-0000-4000-8000-000000000001',source_balance_after:'8.000000',destination_balance_after:'3.000000',unit_price:item.unit_price??null,unit_cost:item.unit_cost??null}))}};}
   throw new Error(`unexpected ${path}`);}};
 const view=await mountComponent('StockTransferBatch.tsx',{controller,products:[{id:P,name:'Caneta',code:'CAN-1'},{id:Q,name:'Kit',code:'KIT'}],onClose(){}},{expandChildren:['StockSidePanel','StockPrintPreview']});
 try{
  assert.deepEqual([view.input('stock-batch-source').props.value,view.input('stock-batch-destination').props.value],[W,V],'origem = depósito padrão, destino = the next active one');
  assert.equal(view.guard().changed,false,'review: the defaults and the suggested prices are not unsaved changes');
  assert.equal(calls.filter(call=>call.path.startsWith('/v1/estoque/transferencias/posicoes')).at(-1).path,`/v1/estoque/transferencias/posicoes?origem=${W}&destino=${V}&produtos=${P}%2C${Q}`);
  assert.match(view.text(),/DescriçãoCódigoEstoqueEstoque ReservadoQuantidade \*Preço Un\. \*Custo Un\./);
  assert.match(view.text(),/CanetaCAN-1103/);assert.match(view.text(),/Produto com composição ou variações/);
  assert.equal(view.input(`stock-batch-quantity-${Q}`).disabled,true);assert.equal(view.input(`stock-batch-price-${P}`).props.value,'1,50','suggested price');
  await view.change(`stock-batch-quantity-${P}`,'8');assert.match(view.text(),/Acima do disponível/);assert.equal(view.guard().changed,true,'a typed quantity is');
  await view.change(`stock-batch-quantity-${P}`,'2');await view.change('stock-batch-note','Reposição');
  await view.click('Salvar');
  const save=calls.filter(call=>call.path==='/v1/estoque/transferencias').at(-1);
  const {command_id,...body}=save.body;
  assert.deepEqual(body,{source_id:W,destination_id:V,note:'Reposição',items:[{product_id:P,quantity:'2',source_version:4,destination_version:2,unit_price:'1.50',unit_cost:null}]});
  assert.match(view.text(),/Transferência registrada para 1 produto\(s\)\./);
  await view.click('IMPRIMIR COMPROVANTE TRANSFERÊNCIA');assert.match(view.text(),/Comprovante de transferência entre depósitos/);
 }finally{view.unmount();}
 // The action is shown to stock writers only.
 const action=role=>mountComponent('StockTransferBatch.tsx',{controller:{...controller,getSnapshot:()=>({phase:'ready',membership:{role,user_id:'e9000000-0000-4000-8000-000000000001'}})},items:[{id:P,name:'Caneta',code:null}]},{componentName:'StockTransferBatchAction'});
 const writer=await action('admin');try{assert.equal(writer.button('Transferir estoque dos produtos selecionados').disabled,false);}finally{writer.unmount();}
 const seller=await action('vendas');try{assert.equal(seller.text(),'');}finally{seller.unmount();}
});

test('181/183 models: warehouse list, filters, purchase order items, DUN, supplier price and the saldo inicial payload',()=>{
 const items=parseWarehouseOptions(options);assert.deepEqual(selectableWarehouses(items,'').map(i=>i.name),['Geral','Loja']);
 assert.deepEqual(selectableWarehouses(items,'b9000000-0000-4000-8000-000000000009').map(i=>i.name),['Geral','Loja','Antigo']);
 assert.throws(()=>parseWarehouseOptions({...options,items:[{...options.items[0]},{...options.items[1],is_default:true}]}));
 assert.equal(stockDashboardPath({query:'',searchBy:'code',warehouse:'',brand:'',supplier:{id:S,name:'A'},stockType:'fisico'},2),`/v1/estoque/painel/estoque?pesquisar_por=code&fornecedor=${S}&tipo_estoque=fisico&pagina=2`);
 assert.match(suggestionPath({from:'2026-10-01',to:'2026-10-02',coverage:'30',warehouse:'',reserve:false,purchase:['open'],sales:['open'],brand:'',supplier:{id:S,name:'A'}}),new RegExp(`fornecedor=${S}$`));
 const rows=[sugRow(P),sugRow(Q,{suggestion:'0'}),sugRow(R,{unit:null})];
 assert.deepEqual(purchaseOrderItems(rows).map(i=>i.product_id),[P],'no suggestion or no unit stays out');
 assert.deepEqual(proposedSupplier(rows,null),{id:S,name:'Fornecedor Alfa'});assert.equal(proposedSupplier([sugRow(P),sugRow(Q,{supplier_id:null,supplier_name:null})],null),null);
 assert.deepEqual([transferQuantity('1,5'),transferPrice('',false,'x'),priceField('2.5000000000'),priceField('1234.0000000000')],['1.5',null,'2,50','1234,00']);
 assert.throws(()=>transferQuantity('0'));assert.throws(()=>transferPrice('',true,'Preço Un.'),/Informe o Preço Un\./);
 const item={position:1,product_id:P,product_code:'CAN-1',product_gtin:null,description:'Caneta',supplier_code:'NOTA-1',gtin:null,unit:'UN',quantity:'24.0000',unit_price:'1.0000000000',received:'0.0000',issue:null,
  issue_quantity:null,issue_action:null,state:'pending',requested:null,catalog_supplier_code:'FORN-1',product_duns:[{code:'17891234567892',quantity:'12.000000'}]};
 assert.deepEqual([matchItems([item],'17891234567892').box,matchItems([item],'forn-1').exact?.position,supplierCodeOf(item),supplierCodeOf({...item,catalog_supplier_code:null})],['12.000000',1,'FORN-1','NOTA-1']);
 assert.deepEqual([addBox('1.0000','12.000000'),addBox('0.0000','0.123450')],['13.0000',null]);
 const ctx={settings:{show_unit_price:true,price_type:'compra_fornecedor',consider_balances:false,average_cost_base:'preco_compra'},last_purchase:null,average_cost:null,sale_price:'9.0000000000',
  default_supplier:{supplier_id:S,supplier_name:'Fornecedor Alfa',code:null,purchase_price:'2.5000000000',cost_price:'2.7500000000'}};
 assert.deepEqual(contextSuggestion(ctx,'1'),{sale:'9,00',purchase:'2,50',cost:'2,75',showPrice:true,help:null});
 assert.match(contextSuggestion({...ctx,default_supplier:null},'1').help,/que este produto não tem no cadastro \(aba Fornecedores\)/);
 assert.deepEqual(initialBalancePayload({warehouse:W,quantity:'',price:'',cost:'',note:''}),{},'nothing typed, nothing sent');
 assert.deepEqual(initialBalancePayload({warehouse:W,quantity:'3,5',price:'2',cost:'',note:' Abertura '}),{initial_balance:{warehouse_id:W,quantity:'3.5',unit_price:'2',unit_cost:null,note:'Abertura'}});
 assert.throws(()=>initialBalancePayload({warehouse:'',quantity:'1',price:'',cost:'',note:''}),/selecione o depósito/);
});

test('181 Conferência de estoque: Imagem column with zoom, warehouse list without totals',async()=>{
 const count={session:{id:'f9000000-0000-4000-8000-000000000002',state:'open',version:1,warehouse_id:W,warehouse_name:'Geral',created_at:'2026-10-20T12:00:00Z',balance_scope:null,closed_at:null},
  total_read:'2.000000',readings:2,items_total:2,items:[{product_id:P,code:'CAN-1',name:'Caneta',location:null,unit:'UN',counted:'1.000000',physical:'0.000000',difference:'1.000000',image_url:'https://exemplo.test/c.png'},
   {product_id:Q,code:'LAP-1',name:'Lápis',location:null,unit:'UN',counted:'1.000000',physical:'1.000000',difference:'0.000000',image_url:null}],log:[]};
 const calls=[];const controller={getSnapshot:()=>({phase:'ready',membership:{role:'estoque',user_id:'e9000000-0000-4000-8000-000000000001'}}),
  async stock(path){calls.push(path);if(path==='/v1/estoque/depositos/opcoes')return options;if(path==='/v1/estoque/conferencias/atual')return{scope:'stock_count',data_mode:'erp_native',count};throw new Error(path);}};
 const view=await mountComponent('StockCount.tsx',{controller},{location:'/conferencia-estoque-empresa',expandChildren:['Modal']});
 try{
  assert.deepEqual(calls.sort(),['/v1/estoque/conferencias/atual','/v1/estoque/depositos/opcoes']);
  assert.equal(view.find(n=>n.type==='img'&&n.props.src==='https://exemplo.test/c.png').props.referrerPolicy,'no-referrer');
  assert.ok(view.find(n=>n.props['aria-label']==='Sem imagem'));
  view.find(n=>n.props['aria-label']==='Ampliar imagem de Caneta').props.onClick();await view.flush();
  assert.equal(view.find(n=>n.type==='img'&&n.props.className==='stock-count-zoom').props.alt,'Caneta');
 }finally{view.unmount();}
});

test('183 Saldo inicial of a new product: the default warehouse, the Origin fields and only for stock writers',async()=>{
 let value={warehouse:'',quantity:'',price:'',cost:'',note:''};const changes=[];
 const controller=role=>({getSnapshot:()=>({phase:'ready',membership:{role,user_id:'e9000000-0000-4000-8000-000000000001'}}),async stock(path){if(path==='/v1/estoque/depositos/opcoes')return options;throw new Error(path);}});
 const view=await mountComponent('StockInitialBalance.tsx',{controller:controller('estoque'),value,unit:'UN',onChange:next=>{changes.push(next);value=next;}},{componentName:'StockInitialBalanceFields'});
 try{
  assert.deepEqual(changes.at(-1),{warehouse:W,quantity:'',price:'',cost:'',note:''},'Origin opens on the default warehouse');
  await view.updateProps({value});
  assert.match(view.text(),/Saldo inicialDepósitoSelecioneGeralLojaQuantidade \(UN\)Preço de compra unitárioCusto de compra UnObservações do saldo inicial/);
  await view.change('product-initial-quantity','5');assert.equal(changes.at(-1).quantity,'5');
 }finally{view.unmount();}
 const seller=await mountComponent('StockInitialBalance.tsx',{controller:controller('vendas'),value,onChange(){}},{componentName:'StockInitialBalanceFields'});
 try{assert.equal(seller.text(),'');}finally{seller.unmount();}
});

test('183 review: a new product with code and Saldo inicial passes the duplicate check without the saldo; services have no saldo inicial',async()=>{
 const calls=[];const record={id:'92000000-0000-4000-8000-0000000000ee',entity:'products',version:1,active:true,name:'Novo com saldo',code:'QA-SALDO'};
 const controller={getSnapshot:()=>({phase:'ready',membership:{role:'estoque',user_id:'e9000000-0000-4000-8000-000000000001'}}),
  async stock(path){if(path==='/v1/estoque/depositos/opcoes')return options;throw new Error(path);},
  async catalog(path,request={}){calls.push({path,method:request.method,body:request.body&&structuredClone(request.body)});
   const taxonomy=/^\/v1\/cadastros\/taxonomias\/([a-z-]+)$/.exec(path);
   if(taxonomy)return{kind:{'categorias-produtos':'categories','grupos-produtos':'product_groups','grupos-tags':'tag_groups',tags:'tags'}[taxonomy[1]],items:[],data_mode:'erp_native'};
   if(path.endsWith('/check'))return{entity:'products',warnings:[],data_mode:'erp_native'};
   if(request.method)return{entity:'products',record,initial_balance:{},replayed:false,data_mode:'erp_native'};
   return{entity:'products',record,data_mode:'erp_native'};}};
 const view=await mountComponent('ProductEditor.tsx',{controller,entity:'products',record:null,writable:true,onSaved(){},onClose(){}},{componentName:'ProductEditor',expandChildren:['ProductForm','StockInitialBalanceFields']});
 try{
  await view.change('catalog-name','Novo com saldo');await view.change('catalog-code','QA-SALDO');await view.change('product-initial-quantity','1');await view.submit();
  assert.match(view.text(),/Saldo inicial: informe a unidade do produto./,'the entry needs the unit');assert.equal(calls.some(call=>call.method),false,'nothing was sent');
  await view.change('catalog-unit','UN');
  assert.equal(view.input('product-initial-warehouse').props.value,W,'the default warehouse');
  await view.change('product-initial-quantity','3,5');
  await view.submit();
  const check=calls.find(call=>call.path==='/v1/cadastros/products/check'),save=calls.find(call=>call.path==='/v1/cadastros/products/completo');
  assert.ok(check,'the duplicate code is checked first');
  assert.equal(Object.hasOwn(check.body.data,'initial_balance'),false,'the check route only knows the product fields');
  assert.deepEqual(save.body.data.initial_balance,{warehouse_id:W,quantity:'3.5',unit_price:null,unit_cost:null,note:null});
  assert.deepEqual(save.body.acknowledged_warnings,[]);
 }finally{view.unmount();}
 // A service (or a product with variations or composition) has no stock: no Saldo inicial block and nothing is sent.
 calls.length=0;
 const service=await mountComponent('ProductEditor.tsx',{controller,entity:'products',record:null,writable:true,onSaved(){},onClose(){}},{componentName:'ProductEditor',expandChildren:['ProductForm','StockInitialBalanceFields']});
 try{
  await service.change('catalog-name','Serviço');await service.change('product-initial-quantity','2');await service.change('catalog-kind','S');
  assert.throws(()=>service.input('product-initial-quantity'));
  await service.submit();
  assert.equal(Object.hasOwn(calls.find(call=>call.path==='/v1/cadastros/products/completo').body.data,'initial_balance'),false);
 }finally{service.unmount();}
 assert.throws(()=>initialBalancePayload({warehouse:W,quantity:'1',price:'',cost:'',note:''},''),/informe a unidade do produto/);
});
