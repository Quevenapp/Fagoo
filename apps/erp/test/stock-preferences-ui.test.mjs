import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {contextSuggestion,parseLaunchContext,parseReservations,parseStockTotals,reservedDisplay} from '../src/lib/stock-launch-model.ts';

// Preferências > Suprimentos > Estoque applied to the stock screens (migration 145). Synthetic data only.
globalThis.document??={activeElement:null,getElementById:()=>null,addEventListener(){},removeEventListener(){},body:{classList:{add(){},remove(){}},append(){},style:{}}};
const P='71450000-0000-4000-8000-000000000001',Q='71450000-0000-4000-8000-000000000002',actor='71450000-0000-4000-8000-000000000003',DOC='71450000-0000-4000-8000-000000000004';
const A='72450000-0000-4000-8000-000000000001',B='72450000-0000-4000-8000-000000000002',M='73450000-0000-4000-8000-000000000001';
const textOf=value=>Array.isArray(value)?value.map(textOf).join(''):value&&typeof value==='object'?textOf(value.props?.children):value===null||value===undefined||typeof value==='boolean'?'':String(value);
const component=(view,name)=>view.nodes().find(n=>typeof n.type==='function'&&n.type.name===name);
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};
const context=(product=P,patch={})=>({scope:'stock_launch_context',data_mode:'erp_native',product_id:product,settings:{show_unit_price:false,price_type:'ultima_compra',consider_balances:false,average_cost_base:'preco_compra'},
 last_purchase:{unit_price:'2.5000000000',unit_cost:'2.7500000000',occurred_on:'2026-10-19',movement_id:M,source:'manual'},average_cost:'2.6000000000',sale_price:'9.9000000000',...patch});
const totals=(warehouse,patch={})=>({scope:'stock_totals',data_mode:'erp_native',warehouse_id:warehouse,quantity:'11.000000',sale_value:'108.90',unpriced_products:0,ignored_warehouses:1,
 cost_visible:true,cost_value:'27.50',uncosted_products:2,cost_basis:'custo_lancamento',warehouses:[{id:A,name:'Depósito A',active:true,is_default:true,ignore_balance:false},{id:B,name:'Depósito B',active:true,is_default:false,ignore_balance:true}],...patch});
function server({role='estoque',contextFor=product=>context(product),hold=()=>null,totalsPatch={},reservation={by_situation:true,by_warehouse:false,statuses:['open'],unassigned_quantity:'2.000000'},reservations=[]}={}){
 const calls=[];const balances=[{warehouse_id:A,warehouse_name:'Depósito A',warehouse_active:true,quantity:'8.000000',version:5,unit:'UN',warehouse_default:true,warehouse_ignored:false,reserved_quantity:'1.500000',situation_reserved_quantity:'0.000000'},
  {warehouse_id:B,warehouse_name:'Depósito B',warehouse_active:true,quantity:'3.000000',version:1,unit:'UN',warehouse_default:false,warehouse_ignored:true,reserved_quantity:'4.000000',situation_reserved_quantity:'0.000000'}];
 const record=id=>({id,entity:'products',name:id===P?'Produto preferências':'Outro produto',code:'PRF-1',active:true,kind:'P',format:'S',unit:'UN',version:1,price:'9.9'});
 const controller={getSnapshot:()=>({phase:'ready',membership:{role,user_id:actor}}),async catalog(path){calls.push({path});return{record:record(path.split('/').at(-1))};},
  async stock(path,options={}){calls.push({path,...options,body:options.body?structuredClone(options.body):undefined});const url=new URL(path,'https://synthetic.invalid'),q=url.searchParams;
   if(url.pathname==='/v1/estoque/totais')return totals(q.get('warehouse_id'),totalsPatch);
   if(url.pathname==='/v1/estoque/sugestao'){const held=hold(path);if(held)await held;return contextFor(q.get('product_id'));}
   if(url.pathname==='/v1/estoque/saldos')return{product_id:q.get('product_id'),items:structuredClone(balances),reservation,data_mode:'erp_native'};
   if(url.pathname==='/v1/estoque/reservas')return{scope:'stock_product_reservations',data_mode:'erp_native',product_id:q.get('product_id'),warehouse_id:q.get('warehouse_id'),items:reservations,total:reservations.length,quantity:'2.000000',reservation};
   return{product_id:q.get('product_id'),items:[],limit:100,offset:0,total:0,has_more:false,next_offset:null,filters:{warehouse_id:q.get('warehouse_id'),kind:null,origin:null,date_from:null,date_to:null,direction:null},
    totals:{entries:'0.000000',exits:'0.000000',current_balance:'8.000000',unit:'UN'},data_mode:'erp_native'};}};
 return{calls,controller};
}
const open=async(s,search=`?produto=${P}`)=>{const view=await mountComponent('RealStock.tsx',{controller:s.controller},{location:`/estoque-empresa${search}`});await view.flush();return view;};

test('145 Novo Lançamento follows the company: hidden unit price, última compra and custo médio suggested; a late context of another product is ignored',async()=>{
 const gate=deferred(),s=server({hold:path=>path.includes(Q)?gate.promise:null}),view=await open(s);
 try{
  assert.ok(s.calls.some(call=>call.path===`/v1/estoque/sugestao?product_id=${P}`));
  await view.click('Incluir lançamento');
  const panel=component(view,'StockLaunchPanel');
  assert.deepEqual([panel.props.showPrice,panel.props.suggestion,panel.props.priceHelp],[false,{sale:'9,90',purchase:'2,50',cost:'2,60'},null]);
  panel.props.onClose();await view.flush();
  await view.navigate(`/estoque-empresa?produto=${Q}`);
  assert.equal(view.button('Incluir lançamento').disabled,true,'the launch waits for the settings of the new product');
  gate.resolve();await view.flush();
  assert.equal(view.button('Incluir lançamento').disabled,false);
  await view.click('Incluir lançamento');assert.equal(component(view,'StockLaunchPanel').props.suggestion.purchase,'2,50');
 }finally{view.unmount();}
 const supplier=server({contextFor:product=>context(product,{settings:{show_unit_price:true,price_type:'custo_fornecedor',consider_balances:false,average_cost_base:'preco_compra'},last_purchase:null,average_cost:null})}),other=await open(supplier);
 try{await other.click('Incluir lançamento');const panel=component(other,'StockLaunchPanel');
  assert.deepEqual([panel.props.showPrice,panel.props.suggestion.purchase,panel.props.suggestion.cost],[true,'','']);assert.match(panel.props.priceHelp,/fornecedor padrão, que este produto não tem no cadastro \(aba Fornecedores\)/);}
 finally{other.unmount();}
 // Without the context (an older API or a failure) the panel keeps the previous behavior: prices shown.
 const failing=server({contextFor:()=>{throw new Error('unavailable');}}),fallback=await open(failing);
 try{await fallback.click('Incluir lançamento');assert.equal(component(fallback,'StockLaunchPanel').props.showPrice,true);}finally{fallback.unmount();}
 // Readers never ask for the context (it is a writer RPC).
 const reader=server({role:'consulta'}),read=await open(reader);try{assert.equal(reader.calls.some(call=>call.path.startsWith('/v1/estoque/sugestao')),false);}finally{read.unmount();}
});

test('145 totalizer: Valor de Custo do Estoque from the custo médio, Indisponível without purchase access; Reservado with the situation reservation',async()=>{
 const s=server(),view=await open(s,'');
 try{
  assert.match(view.text(),/Valor de Custo do EstoqueR\$ 27,50Valor de Venda do EstoqueR\$ 108,90/);
  assert.match(view.text(),/custo médio de cada produto, calculado pelo custo do lançamento dos lançamentos de entrada \(Preferências › Suprimentos › Estoque\); 2 produto\(s\) sem custo médio não entram/);
 }finally{view.unmount();}
 const seller=server({role:'vendas',totalsPatch:{cost_visible:false,cost_value:null,uncosted_products:null}}),hidden=await open(seller,'');
 try{assert.match(hidden.text(),/Valor de Custo do EstoqueIndisponível/);assert.match(hidden.text(),/usa preços de compra, que seu perfil não consulta/);}finally{hidden.unmount();}
 const reserved=server({reservations:[{reservation_id:null,source:'situation',document_id:DOC,document_number:'31',status:'open',contact_name:'Cliente sintético',warehouse_id:null,warehouse_ignored:false,quantity:'2.000000',unit:'UN',reserved_at:null}]});
 const withProduct=await open(reserved);
 try{
  assert.match(withProduct.text(),/Reservado.*Visualizar vendas3,5 UN/,'1,5 in Depósito A plus 2 reserved for every considered warehouse');
  assert.match(withProduct.text(),/valendo para todos os depósitos considerados\. Essa reserva não impede lançamentos\./);
  await withProduct.click('Visualizar vendas');
  assert.match(withProduct.text(),/31Cliente sintéticoEm abertoReserva pela situação · todos os depósitos2/);
  const selector=component(withProduct,'OriginSelector');selector.props.onChange('Todos os depósitos');await withProduct.flush();
  assert.match(withProduct.text(),/Reservado.*Visualizar vendas3,5 UN/,'Todos: the ignored Depósito B (4) stays out');
 }finally{withProduct.unmount();}
});

test('145 panels: hidden prices send no price; Transferência hides Preço un. and Custo Un.; estorno tells when the Balanço kept the balance',async()=>{
 const calls=[];const stock=async(path,options={})=>{calls.push({path,...options,body:structuredClone(options.body)});
  if(path.endsWith('/estorno'))return{movement:{id:'73450000-0000-4000-8000-000000000009',kind:'reversal',reverses_id:M},balance_adjustments:[{id:'73450000-0000-4000-8000-000000000010',kind:'adjustment'}],replayed:false,data_mode:'erp_native'};
  const q=options.body.quantity,kind=options.body.kind;
  return{scope:'stock_launch',data_mode:'erp_native',kind,occurred_on:'2026-10-20',replayed:false,movement:{id:M,items:kind==='transfer'?[{product_id:P,warehouse_id:A,quantity:`-${q}.000000`,balance_after:'6.000000'},{product_id:P,warehouse_id:B,quantity:`${q}.000000`,balance_after:'5.000000'}]:[{product_id:P,warehouse_id:A,quantity:`${q}.000000`,balance_after:'10.000000'}]},
   detail:{revision:1,unit_price:null,unit_cost:null,note:kind==='transfer'?'Transferência':'Lançamento manual'},balance:null};};
 const product={id:P,entity:'products',name:'Produto',code:'PRF-1',active:true,kind:'P',format:'S',unit:'UN',version:1,price:'9.9'};
 const balance=(id,version)=>({warehouse_id:id,warehouse_name:id===A?'Geral':'Loja',warehouse_active:true,quantity:'8.000000',version,unit:'UN',warehouse_default:id===A,warehouse_ignored:false,reserved_quantity:'0.000000'});
 const suggestion={sale:'9,90',purchase:'2,50',cost:'2,60'};
 const launch=await mountComponent('StockMovementPanel.tsx',{controller:{stock},product,warehouse:balance(A,5),readReady:true,suggestion,showPrice:false,onClose(){},onSaved(){},onRefresh(){}},{componentName:'StockLaunchPanel',expandChildren:['StockSidePanel']});
 try{
  assert.equal(launch.nodes().some(node=>['stock-launch-price','stock-launch-cost'].includes(node.props?.id)),false);
  assert.match(launch.text(),/O preço unitário não é exibido nos lançamentos manuais/);
  await launch.change('stock-launch-quantity','2');await launch.click('Incluir');
  const {command_id,...body}=calls[0].body;assert.deepEqual(body,{kind:'receipt',product_id:P,warehouse_id:A,quantity:'2',expected_version:5,unit_price:null,note:null,unit_cost:null});
 }finally{launch.unmount();}
 const shown=await mountComponent('StockMovementPanel.tsx',{controller:{stock},product,warehouse:balance(A,5),readReady:true,suggestion,showPrice:true,priceHelp:'Informe o preço.',onClose(){},onSaved(){},onRefresh(){}},{componentName:'StockLaunchPanel',expandChildren:['StockSidePanel']});
 try{assert.match(shown.text(),/Preço de Compra \*Informe o preço\./);await shown.change('stock-launch-kind','issue');assert.doesNotMatch(shown.text(),/Informe o preço\./,'the supplier help is for Entrada and Balanço');}finally{shown.unmount();}
 const transfer=await mountComponent('StockTransferPanel.tsx',{controller:{stock},product,balances:[balance(A,5),balance(B,1)],readReady:true,initialSource:A,suggestion,showPrice:false,onClose(){},onSaved(){},onRefresh(){}},{expandChildren:['StockSidePanel']});
 try{
  assert.equal(transfer.nodes().some(node=>['stock-transfer-price','stock-transfer-cost'].includes(node.props?.id)),false);
  await transfer.change('stock-transfer-quantity','2');await transfer.click('Salvar');
  const {command_id,...body}=calls.at(-1).body;assert.deepEqual([body.unit_price,body.unit_cost,body.destination_id],[null,null,B]);
 }finally{transfer.unmount();}
 const saved=[],reversal={id:M,kind:'receipt',occurred_on:'2026-10-19',reason:'Lançamento manual',reference:null,created_at:'2026-10-19T12:00:00Z',reverses_id:null,reversed_by:null,items:[{product_id:P,warehouse_id:A,quantity:'2.000000',unit:'UN',balance_after:'10.000000',balance_version:5}]};
 const form=await mountComponent('StockMovementPanel.tsx',{controller:{stock},product,balances:[balance(A,6)],readReady:true,reversal,onClose(){},onSaved:value=>saved.push(value),onRefresh(){}},{componentName:'StockReversalForm',expandChildren:['StockSidePanel']});
 try{await form.change('stock-reversal-reason','Estorno sintético');await form.submit();await form.click('Confirmar estorno');assert.deepEqual(saved,[{balanceKept:true}]);}finally{form.unmount();}
});

test('145 Estoque de Produtos shows Custo only with purchase access; models keep exact strings',async()=>{
 const W='72450000-0000-4000-8000-000000000003';
 const dashboard=visible=>({scope:'stock_dashboard_stock',data_mode:'erp_native',page:1,size:100,total:1,filters:{},cost_visible:visible,cost_basis:'preco_compra',
  items:[{product_id:P,code:'CAN-1',name:'Caneta',quantity:'4.000000',value:'10.00',average_cost:visible?'1.2500000000':null,cost:visible?'5.00':null}],totals:{quantity:'4.000000',value:'10.00',unpriced:0,cost:visible?'5.00':null,uncosted:visible?0:null},
  warehouses:[{warehouse_id:W,name:'Geral',ignored:false,quantity:'4.000000',value:'10.00',cost:visible?'5.00':null}]});
 for(const visible of[true,false]){
  const controller={getSnapshot:()=>({phase:'ready',membership:{role:visible?'estoque':'vendas',user_id:actor}}),async stock(path){const url=new URL(path,'https://synthetic.invalid');
   if(url.pathname==='/v1/estoque/depositos/opcoes')return{scope:'stock_warehouse_options',data_mode:'erp_native',total:1,items:[{id:W,name:'Geral',active:true,is_default:true,ignore_balance:false}]};
   if(url.pathname==='/v1/estoque/totais')return totals(null);return dashboard(visible);}};
  const view=await mountComponent('StockDashboards.tsx',{controller},{location:'/painel-produtos-empresa',expandChildren:['StockProducts','StockDashboardsNav']});
  try{
   if(visible){assert.match(view.text(),/CódigoDescriçãoEstoqueCusto Valor CAN-1Caneta4R\$ 5,00 médioR\$ 10,00TOTAL4R\$ 5,00R\$ 10,00/,'181: without the supplier fields the Custo is the custo médio, marked as such');assert.match(view.text(),/NomeEstoqueCustoValorGeral4R\$ 5,00R\$ 10,00/);}
   else{assert.doesNotMatch(view.text(),/EstoqueCusto/);assert.match(view.text(),/Custo não aparece: ele usa preços de compra, que seu perfil não consulta\./);}
  }finally{view.unmount();}
 }
 const ctx=parseLaunchContext(context(),P);
 assert.deepEqual(contextSuggestion(ctx,'1'),{sale:'9,90',purchase:'2,50',cost:'2,60',showPrice:false,help:null});
 assert.deepEqual(contextSuggestion({...ctx,average_cost:null},'1').cost,'2,75');
 assert.match(contextSuggestion({...ctx,last_purchase:null,average_cost:null},'1').help,/Ainda não há compra com preço/);
 assert.throws(()=>parseLaunchContext(context(Q),P));assert.throws(()=>parseLaunchContext(context(P,{average_cost:'2.6'}),P));
 const legacy=parseStockTotals({...totals(null),cost_visible:undefined,cost_value:undefined,uncosted_products:undefined,cost_basis:undefined},null);
 assert.deepEqual([legacy.cost_visible,legacy.cost_value],[false,null],'an older answer shows the cost as unavailable');
 assert.throws(()=>parseStockTotals(totals(null,{cost_value:null}),null),'present fields are strict');
 const balances=[{warehouse_id:A,reserved_quantity:'1.500000',warehouse_ignored:false},{warehouse_id:B,reserved_quantity:'4.000000',warehouse_ignored:true}];
 assert.equal(reservedDisplay(balances,'',{by_situation:true,by_warehouse:false,statuses:['open'],unassigned_quantity:'0.333333'}),'1.833333');
 assert.equal(reservedDisplay(balances,B,null),'4.000000');
 const list=parseReservations({scope:'stock_product_reservations',product_id:P,warehouse_id:A,items:[{reservation_id:null,source:'situation',document_id:DOC,document_number:'31',quantity:'2.000000',warehouse_id:null}],total:1,quantity:'2.000000',reservation:{by_situation:true,by_warehouse:false,statuses:['open']}},P,A);
 assert.equal(list.items[0].source,'situation');
 assert.throws(()=>parseReservations({scope:'stock_product_reservations',product_id:P,warehouse_id:A,items:[{reservation_id:null,source:'reservation',document_id:DOC,document_number:'31',quantity:'2.000000',warehouse_id:A}],total:1,quantity:'2.000000'},P,A));
});

test('145 Preferências > Suprimentos > Estoque says honestly what is applied and what is only stored',async()=>{
 const {default:page}=await import('../../../packages/erp-domain/src/preferences/pages/suprimentos-estoque.mjs');
 const status=Object.fromEntries(page.fields.filter(f=>!f.info).map(f=>[f.key,f.status]));
 assert.deepEqual(status,{'estoque.exibir_preco_unitario':'applied','estoque.tipo_preco_entrada':'applied','estoque.considerar_balancos':'applied','estoque.nf_estoque_negativo':'applied',
  'estoque.data_lancamento':'applied','estoque.custo_medio_base':'applied','estoque.cross_docking_dias':'applied','estoque.estorno_balanco':'applied',
  'estoque.reserva_por_situacao':'applied','estoque.reserva_situacoes':'applied','estoque.reserva_por_deposito':'applied'});
 for(const field of page.fields.filter(f=>!f.info))assert.ok(field.note,`${field.key} explains its state`);
 assert.match(page.fields.find(f=>f.key==='estoque.tipo_preco_entrada').note,/opções do fornecedor padrão usam o preço de compra ou de custo do fornecedor padrão da aba Fornecedores/);
});
