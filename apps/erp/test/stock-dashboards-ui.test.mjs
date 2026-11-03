import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {defaultPeriod,sortSuggestion,suggestionPath,suggestionTotals,currentStock} from '../src/lib/stock-dashboards-model.ts';
import {toCsv,toXlsx,textCell,numberCell,zipStore} from '../src/lib/spreadsheet-export.ts';
import {resolveMenu} from '../src/lib/origin-menu.ts';

// Meu Negócio > Dashboard produtos like Origin (migration 107). Synthetic data only.
globalThis.document??={activeElement:null,getElementById:()=>null,addEventListener(){},removeEventListener(){},body:{classList:{add(){},remove(){}},append(){},style:{}}};
const P='a5000000-0000-4000-8000-000000000001',Q='a5000000-0000-4000-8000-000000000002',W='b5000000-0000-4000-8000-000000000001';
const textOf=value=>Array.isArray(value)?value.map(textOf).join(''):value&&typeof value==='object'?textOf(value.props?.children):value===null||value===undefined||typeof value==='boolean'?'':String(value);
const component=(view,name)=>view.nodes().find(n=>typeof n.type==='function'&&n.type.name===name);
const row=(id,patch)=>({product_id:id,code:'CAN-1',name:'Caneta',sold:'6.000000',stock:'4.000000',reserved:'1.000000',ordered:'4.000000',suggestion:'16',unit_price:'1.2000000000',value:'19.20',...patch});
function server({role='vendas'}={}){
 const calls=[];
 const controller={getSnapshot:()=>({phase:'ready',membership:{role,user_id:'c5000000-0000-4000-8000-000000000001'}}),
  async stock(path,options={}){calls.push({path,...options,body:options.body?structuredClone(options.body):undefined});const url=new URL(path,'https://synthetic.invalid'),q=url.searchParams;
   if(url.pathname==='/v1/estoque/depositos/opcoes')return{scope:'stock_warehouse_options',data_mode:'erp_native',total:1,items:[{id:W,name:'Geral',active:true,is_default:true,ignore_balance:false}]};
   if(url.pathname==='/v1/estoque/totais')return{scope:'stock_totals',data_mode:'erp_native',warehouse_id:null,quantity:'0.000000',sale_value:'0.00',unpriced_products:0,ignored_warehouses:0,warehouses:[{id:W,name:'Geral',active:true,is_default:true,ignore_balance:false}]};
   if(url.pathname==='/v1/estoque/painel/ajustes'){if(options.method)return{scope:'stock_dashboard_preference',data_mode:'erp_native',replayed:false,receipt:{command_id:options.body.command_id,from_version:0,to_version:1},preference:{purchase_statuses:options.body.purchase_statuses,sales_statuses:options.body.sales_statuses,version:1,updated_at:'2026-10-20T12:00:00Z'}};
    return{scope:'stock_dashboard_preference',data_mode:'erp_native',preference:{purchase_statuses:['open','in_progress'],sales_statuses:['open','fulfilled'],version:0,updated_at:null}};}
   if(url.pathname==='/v1/estoque/painel/estoque'){const page=Number(q.get('pagina')??1);return{scope:'stock_dashboard_stock',data_mode:'erp_native',page,size:100,total:1,filters:{},items:[{product_id:P,code:'CAN-1',name:'Caneta',quantity:'4.000000',value:'10.00'}],totals:{quantity:'4.000000',value:'10.00',unpriced:1},warehouses:[{warehouse_id:W,name:'Geral',ignored:false,quantity:'4.000000',value:'10.00'}]};}
   if(url.pathname==='/v1/estoque/painel/sem-movimentacao')return{scope:'stock_dashboard_idle',data_mode:'erp_native',since:q.get('data'),page:1,size:100,total:2,items:[{product_id:P,code:'CAN-1',name:'Caneta',quantity:'4.000000',last_sale:null},{product_id:Q,code:'LAP-1',name:'Lápis',quantity:'1.000000',last_sale:'2000-01-01'}]};
   return{scope:'stock_purchase_suggestion',data_mode:'erp_native',days:30,total:2,filters:{date_from:q.get('de'),date_to:q.get('ate'),coverage:Number(q.get('cobertura')),reserve:q.get('reserva')==='sim'},
    items:[row(P),row(Q,{code:'LAP-1',name:'Lápis',sold:'3.000000',suggestion:'2',unit_price:null,value:null})]};}};
 return{calls,controller};
}
const mount=(s,search='')=>mountComponent('StockDashboards.tsx',{controller:s.controller},{location:`/painel-produtos-empresa${search}`,expandChildren:['StockProducts','IdleProducts','PurchaseSuggestion','StockDashboardsNav','SuggestionSettings','StockSidePanel']});

test('side menu Produtos and Estoque de Produtos: Pesquisar por, Depósito, Marca, Tabela de Estoques and Estoque por Depósito',async()=>{
 const s=server(),view=await mount(s);
 try{
  assert.match(view.text(),/ProdutosEstoque de ProdutosSem Movimentação/,'vendas: no Sugestão de Compras (purchase data)');
  assert.equal(s.calls.find(call=>call.path.startsWith('/v1/estoque/painel/')).path,'/v1/estoque/painel/estoque?pesquisar_por=description');
  await view.change('stock-dash-query','CAN');await view.change('stock-dash-by','code');await view.change('stock-dash-warehouse',W);await view.change('stock-dash-brand','Acme');await view.submit();
  assert.equal(s.calls.at(-1).path,`/v1/estoque/painel/estoque?q=CAN&pesquisar_por=code&warehouse_id=${W}&marca=Acme`);
  assert.match(view.text(),/Tabela de EstoquesCódigoDescriçãoEstoqueValor CAN-1Caneta4R\$ 10,00TOTAL4R\$ 10,00/);
  assert.match(view.text(),/Estoque por DepósitoNomeEstoqueValorGeral4R\$ 10,00/);assert.match(view.text(),/1 produto\(s\) sem preço de venda/);
 }finally{view.unmount();}
});

test('Sem Movimentação: Data of the current month, Última Venda or the red badge "Sem Venda"',async()=>{
 const s=server(),view=await mount(s,'?painel=sem-movimentacao');
 try{
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
  assert.equal(view.input('stock-dash-since').props.value,`${today.slice(0,8)}01`);
  assert.match(view.text(),/CAN-1Caneta4Sem VendaLAP-1Lápis101\/01\/2000/);
  assert.equal(view.find(node=>node.type==='span'&&textOf(node)==='Sem Venda').props.className,'status-badge status-danger is-bold');
 }finally{view.unmount();}
});

test('Sugestão de Compras: Origin filters with the saved situations, sortable columns, TOTAL, local search and Ajustes',async()=>{
 const s=server({role:'estoque'}),view=await mount(s,'?painel=sugestao');
 try{
  assert.equal(view.input('stock-sug-coverage').props.value,'30');assert.equal(view.input('stock-sug-reserve').props.value,'sim','Origin opens with Reserva = Sim');
  assert.match(view.text(),/ProdutosEstoque de ProdutosSugestão de ComprasSem Movimentação/);assert.equal(view.input('stock-sug-purchase-open').props.checked,true);assert.equal(view.input('stock-sug-purchase-cancelled').props.checked,false);
  await view.change('stock-sug-from','2026-10-01');await view.change('stock-sug-to','2026-10-30');await view.change('stock-sug-reserve','sim');await view.submit();
  const call=s.calls.at(-1).path;assert.match(call,/^\/v1\/estoque\/painel\/sugestao\?de=2026-10-01&ate=2026-10-30&cobertura=30&reserva=sim&compras=open%2Cin_progress&vendas=open%2Cfulfilled$/);
  const table=()=>textOf(view.find(node=>node.type==='table'));
  assert.match(table(),/SKUDescriçãoPeças VendidasEstoque AtualPedido de CompraSugestão de CompraValor EstimadoCAN-1Caneta63416R\$ 19,20LAP-1Lápis3342-TOTAL96818R\$ 19,20/,'Estoque Atual takes off the reserved quantity');
  view.find(node=>node.type==='button'&&textOf(node)==='Sugestão de Compra').props.onClick();await view.flush();
  assert.match(table(),/LAP-1.*CAN-1/,'ascending after the first click on the default descending column');
  await view.change('stock-sug-local','lápis');assert.doesNotMatch(table(),/CAN-1/);
  await view.change('stock-sug-coverage','0');await view.submit();assert.match(view.text(),/Filtros inválidos!/);
  await view.click('Ajustes');await view.change('stock-settings-sales-verified',true);await view.click('Salvar');
  const save=s.calls.filter(call=>call.method==='POST').at(-1);assert.equal(save.path,'/v1/estoque/painel/ajustes');assert.deepEqual([save.body.expected_version,save.body.sales_statuses],[0,['open','fulfilled','verified']]);
 }finally{view.unmount();}
});

test('models: default sales period, exact totals and sorting, path validation, CSV and XLSX exports',()=>{
 assert.deepEqual(defaultPeriod('2026-03-31'),{from:'2026-02-28',to:'2026-03-31'});assert.deepEqual(defaultPeriod('2026-01-15'),{from:'2025-12-15',to:'2026-01-15'});
 const rows=[row(P),row(Q,{sold:'0.000001',suggestion:'0',value:null,unit_price:null})];
 assert.deepEqual(suggestionTotals(rows,true),{sold:'6.000001',stock:'6.000000',ordered:'8.000000',suggestion:'16.000000',value:'19.20'});
 assert.equal(currentStock(row(P,{stock:'1.000000',reserved:'1.500000'}),true),'-0.500000');
 assert.deepEqual(sortSuggestion(rows,{key:'sold',direction:'asc'},false).map(item=>item.product_id),[Q,P]);
 assert.throws(()=>suggestionPath({from:'2026-10-02',to:'2026-10-01',coverage:'30',warehouse:'',reserve:false,purchase:['open'],sales:['open'],brand:''}),/Filtros inválidos!/);
 const csv=toCsv([[textCell('SKU'),textCell('=1+1')],[textCell('CAN-1'),numberCell('1.5')]]);
 assert.equal(csv,'﻿"SKU";"\'=1+1"\r\n"CAN-1";"1,5"\r\n','formulas are neutralized and decimals use a comma');
 const zip=toXlsx('Sugestão',[[textCell('SKU'),numberCell('12345678901234567.5')],[textCell('A'),numberCell('2.500000')]]);
 assert.deepEqual([...zip.slice(0,4)],[0x50,0x4b,0x03,0x04]);const text=new TextDecoder().decode(zip);
 assert.match(text,/<c r="B2"><v>2\.5<\/v><\/c>/);assert.match(text,/<c r="B1" t="inlineStr"><is><t xml:space="preserve">12345678901234567\.5<\/t>/,'more than 15 digits stays text');
 assert.equal(zipStore([]).length,22);
});

test('Sugestão de Compras is purchase data: vendas reads the other dashboards but neither sees nor opens the suggestion',async()=>{
 const s=server({role:'vendas'}),view=await mount(s,'?painel=sugestao');
 try{
  assert.match(view.text(),/ProdutosEstoque de ProdutosSem Movimentação/);assert.doesNotMatch(view.text(),/ProdutosEstoque de ProdutosSugestão de Compras/);
  assert.match(view.text(),/Sugestão de Compras não liberada/);
  assert.equal(s.calls.some(call=>call.path.startsWith('/v1/estoque/painel/sugestao')||call.path.startsWith('/v1/estoque/painel/ajustes')),false,'nothing is requested');
 }finally{view.unmount();}
});

test('menu: Dashboard produtos for stock readers; Sugestão de Compras for those who also read purchase orders',()=>{
 for(const role of['admin','consulta','vendas','estoque','fiscal']){
  const items=resolveMenu('real',{role,resources:[]}).flatMap(group=>group.columns.flatMap(column=>column.items));
  assert.equal(items.find(item=>item.label==='Dashboard produtos').to,'/painel-produtos-empresa',role);
  const suggestion=items.find(item=>item.label==='Sugestão de Compras');
  if(role==='vendas')assert.ok(!suggestion||suggestion.disabled||suggestion.to!=='/painel-produtos-empresa?painel=sugestao',role);else assert.equal(suggestion.to,'/painel-produtos-empresa?painel=sugestao',role);
 }
 assert.equal(resolveMenu('real',{role:'financeiro',resources:[]}).flatMap(group=>group.columns.flatMap(column=>column.items)).some(item=>item.label==='Dashboard produtos'&&!item.disabled),false);
});

test('stock panels preserve and show native-only coverage when Origin documents were excluded', async () => {
 for (const search of ['', '?painel=sem-movimentacao', '?painel=sugestao']) {
  const s=server({role:'admin'}),read=s.controller.stock;
  s.controller.stock=async(...args)=>({...await read(...args),origin:'brufap',mirror_excluded_count:17,coverage:{partial:true,reason:'native_effects_only'}});
  const view=await mount(s,search);
  if(search.includes('sugestao'))await view.submit();
  try { assert.match(view.text(),/Indicadores operacionais do FAGOO; 17 documentos Origin não entram neste cálculo/); } finally { view.unmount(); }
 }
});
