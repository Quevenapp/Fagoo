import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {REPORTS,chartPoints,defaultReportFilters,reportById,reportPath} from '../src/lib/stock-reports-model.ts';

// Relatórios de suprimentos (migration 146). Synthetic data only.
globalThis.document??={activeElement:null,getElementById:()=>null,addEventListener(){},removeEventListener(){},body:{classList:{add(){},remove(){}},append(){},style:{}}};
const P='91460000-0000-4000-8000-000000000001',W='92460000-0000-4000-8000-000000000001',actor='93460000-0000-4000-8000-000000000001';
const textOf=value=>Array.isArray(value)?value.map(textOf).join(''):value&&typeof value==='object'?textOf(value.props?.children):value===null||value===undefined||typeof value==='boolean'?'':String(value);
const component=(view,name)=>view.nodes().find(n=>typeof n.type==='function'&&n.type.name===name);
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};
const product={product_id:P,code:'P-1',name:'Produto relatório',unit:'UN'};
function server({role='estoque',hold=()=>null,total=1}={}){
 const calls=[];
 const controller={getSnapshot:()=>({phase:'ready',membership:{role,user_id:actor}}),async catalog(){return{items:[]};},
  async stock(path,options={}){calls.push({path,...options});const url=new URL(path,'https://synthetic.invalid'),q=url.searchParams;const held=hold(path);if(held)await held;
   if(url.pathname==='/v1/estoque/depositos/opcoes')return{scope:'stock_warehouse_options',data_mode:'erp_native',total:1,items:[{id:W,name:'Geral',active:true,is_default:true,ignore_balance:false}]};
   if(url.pathname==='/v1/estoque/totais')return{scope:'stock_totals',data_mode:'erp_native',warehouse_id:null,quantity:'0.000000',sale_value:'0.00',unpriced_products:0,ignored_warehouses:0,cost_visible:true,cost_value:'0.00',uncosted_products:0,cost_basis:'preco_compra',warehouses:[{id:W,name:'Geral',active:true,is_default:true,ignore_balance:false}]};
   const report=url.pathname.split('/').at(-1);
   if(report==='movimentacao-produto')return{report,data_mode:'erp_native',scope:'stock_report_product',product,opening:'2.000000',days:[{date:'2026-10-02',entries:'5.000000',exits:'1.000000',balance:'6.000000'},{date:'2026-10-05',entries:'0.000000',exits:'2.500000',balance:'3.500000'}],closing:'3.500000',totals:{entries:'5.000000',exits:'3.500000'},filters:{}};
   const offset=Number(q.get('offset')??0);
   return{report,data_mode:'erp_native',scope:'stock_report_movements',filters:{},offset,limit:500,total,items:[{...product,product_id:`${P.slice(0,-1)}${offset?2:1}`,entries:'10.000000',exits:'4.000000',balances:'3.000000',net:'9.000000',launches:4}],
    totals:{entries:'10.000000',exits:'4.000000',balances:'3.000000',net:'9.000000'}};}};
 return{calls,controller,reports:()=>calls.filter(call=>call.path.startsWith('/v1/estoque/relatorios/'))};
}
const mount=(s,search='')=>mountComponent('StockReports.tsx',{controller:s.controller},{location:`/relatorios-estoque${search}`});

test('146 catalog: the Origin report names by group, each available only to the profiles that read its data',async()=>{
 const seller=server({role:'vendas'}),view=await mount(seller);
 try{
  assert.match(view.text(),/Controle de EstoqueEntradas e Saídas de EstoqueTransferência de EstoqueSaldos em EstoqueProdutos com Maior CirculaçãoProdutos sem MovimentaçãoProdutos Abaixo do Estoque MínimoVisão Financeira do Estoque/);
  assert.match(view.text(),/Visão Financeira do EstoqueUsa preços de compra, que seu perfil não consulta\./);
  assert.match(view.text(),/Relatório de Pedidos de ComprasSomente quem consulta pedidos de compra vê este relatório\./);
  const link=view.find(n=>n.type==='a'&&textOf(n)==='Entradas e Saídas de Estoque');link.props.onClick({preventDefault(){},button:0});await view.flush();
  assert.equal(view.location().search,'?relatorio=entradas-saidas');
 }finally{view.unmount();}
 const finance=server({role:'financeiro'}),other=await mount(finance,'?relatorio=visao-financeira');
 try{assert.match(other.text(),/Visão Financeira do EstoqueUsa preços de compra/);assert.equal(finance.reports().length,0);}finally{other.unmount();}
 // The native entry notes are read by administrador and fiscal only (113): consulta sees the notes reports disabled.
 const reader=server({role:'consulta'}),catalog=await mount(reader);
 try{
  assert.match(catalog.text(),/Relatório de Notas de Entrada por OperaçãoSomente administrador e fiscal veem as notas de entrada do FAGOO\./);
  assert.ok(catalog.find(n=>n.type==='a'&&textOf(n)==='Visão Financeira do Estoque'),'consulta reads purchase prices');
  assert.equal(catalog.nodes().some(n=>n.type==='a'&&textOf(n)==='Relatório de Notas de Entrada por Operação'),false);
 }finally{catalog.unmount();}
 const fiscal=server({role:'fiscal'}),notes=await mount(fiscal);
 try{assert.ok(notes.find(n=>n.type==='a'&&textOf(n)==='Evolução de Notas Fiscais de Compra'));}finally{notes.unmount();}
});

test('146 Entradas e Saídas: Visualizar sends the filters, shows TOTAL and pages of 500; invalid filters never call',async()=>{
 const s=server({total:501}),view=await mount(s,'?relatorio=entradas-saidas');
 try{
  await view.change('stock-report-from','2026-10-01');await view.change('stock-report-to','2026-10-20');await view.change('stock-report-warehouse',W);await view.submit(0);
  assert.equal(s.reports()[0].path,`/v1/estoque/relatorios/entradas-saidas?de=2026-10-01&ate=2026-10-20&warehouse_id=${W}`);
  assert.match(view.text(),/CódigoDescriçãoUnEntradasSaídasBalançosSaldo do períodoP-1Produto relatórioUN10439TOTAL10439/);
  assert.match(view.text(),/1–1 de 501/);
  await view.click('Próxima página');assert.match(s.reports().at(-1).path,/&offset=500$/);
  await view.change('stock-report-from','2026-10-21');await view.submit(0);
  assert.match(view.text(),/Filtros inválidos!/);assert.equal(s.reports().length,2,'nothing is sent for an invalid period');
 }finally{view.unmount();}
});

test('146 pages and exports follow the report on screen, not filters edited after Visualizar',async()=>{
 const s=server({total:501}),view=await mount(s,'?relatorio=entradas-saidas');
 try{
  await view.change('stock-report-from','2026-10-01');await view.change('stock-report-to','2026-10-20');await view.submit(0);
  await view.change('stock-report-from','2026-10-05');await view.change('stock-report-warehouse',W);
  await view.click('Próxima página');
  assert.equal(s.reports().at(-1).path,'/v1/estoque/relatorios/entradas-saidas?de=2026-10-01&ate=2026-10-20&offset=500');
  const before=s.reports().length;await view.click('XLSX');
  assert.deepEqual(s.reports().slice(before).map(call=>call.path),['/v1/estoque/relatorios/entradas-saidas?de=2026-10-01&ate=2026-10-20','/v1/estoque/relatorios/entradas-saidas?de=2026-10-01&ate=2026-10-20&offset=500']);
  await view.submit(0);assert.equal(s.reports().at(-1).path,`/v1/estoque/relatorios/entradas-saidas?de=2026-10-05&ate=2026-10-20&warehouse_id=${W}`,'Visualizar uses the edited filters');
 }finally{view.unmount();}
});

test('146 Movimentação de um Produto needs the product, shows the opening, the closing and the balance chart',async()=>{
 const s=server(),view=await mount(s,'?relatorio=movimentacao-produto');
 try{
  await view.submit(0);assert.match(view.text(),/Selecione o produto\./);assert.equal(s.reports().length,0);
  component(view,'StockProductSearch').props.onSelect({id:P,name:'Produto relatório',code:'P-1'});await view.flush();
  await view.submit(0);
  assert.match(s.reports()[0].path,new RegExp(`movimentacao-produto\\?product_id=${P}&de=`));
  assert.match(view.text(),/ProdutoP-1 - Produto relatórioSaldo anterior2Saldo final3,5/);
  const line=view.find(n=>n.type==='polyline');assert.equal(line.props.points.split(' ').length,3,'opening and two days');
  assert.match(view.text(),/DataEntradasSaídasSaldo02\/10\/2026516/);
 }finally{view.unmount();}
});

test('146 a late answer of the previous report never shows',async()=>{
 const gate=deferred(),s=server({hold:path=>path.includes('entradas-saidas')?gate.promise:null}),view=await mount(s,'?relatorio=entradas-saidas');
 try{
  await view.submit(0);await view.navigate('/relatorios-estoque?relatorio=saldos');
  gate.resolve();await view.flush();
  assert.doesNotMatch(view.text(),/Produto relatório/);assert.match(view.text(),/Saldos em Estoque/);
 }finally{view.unmount();}
});

test('146 model: report paths with fixed groups, statuses in option order, and chart points',()=>{
 const filters=defaultReportFilters('2026-10-20');
 assert.equal(reportPath(reportById('notas-evolucao'),filters),'/v1/estoque/relatorios/notas-entrada?de=2026-10-01&ate=2026-10-20&agrupar=evolucao');
 assert.equal(reportPath(reportById('pedidos-compra'),{...filters,poGroup:'produto'}),'/v1/estoque/relatorios/pedidos-compra?de=2026-10-01&ate=2026-10-20&situacoes=open%2Cin_progress%2Cpartially_fulfilled%2Cfulfilled&agrupar=produto');
 assert.throws(()=>reportPath(reportById('pedidos-compra'),{...filters,statuses:[]}),/Escolha ao menos uma situação/);
 assert.equal(reportPath(reportById('saldos'),{...filters,date:'2026-10-05'},500),'/v1/estoque/relatorios/saldos?data=2026-10-05&offset=500');
 assert.equal(REPORTS.length,13);
 assert.deepEqual(chartPoints('0.000000',[{date:'2026-10-01',balance:'10.000000'},{date:'2026-10-02',balance:'5.000000'}],100,50).map(p=>[p.x,p.y]),[[0,50],[50,0],[100,25]]);
});

test('purchase report preserves mirror exclusion coverage in display, print and exported files',async()=>{
 const s=server(),read=s.controller.stock,coverage={origin:'brufap',mirror_excluded_count:17,coverage:{partial:true,reason:'native_effects_only'}};
 s.controller.stock=async(...args)=>{const raw=await read(...args);return args[0].startsWith('/v1/estoque/relatorios/')?{...raw,...coverage}:raw;};
 const view=await mount(s,'?relatorio=pedidos-compra');
 const create=URL.createObjectURL,element=globalThis.document.createElement;let downloaded;
 URL.createObjectURL=blob=>{downloaded=blob;return create(blob);};globalThis.document.createElement=()=>({click(){}});
 try{
  await view.submit(0);assert.match(view.text(),/Relatório de registros do FAGOO; 17 documentos Origin não entram neste cálculo/);
  await view.click('Imprimir');assert.match(textOf(component(view,'StockPrintPreview').props.children),/17 documentos Origin não entram neste cálculo/);
  await view.click('CSV');assert.ok(downloaded);assert.match(await downloaded.text(),/17 documentos Origin não entram neste cálculo/);
  await view.click('XLSX');assert.ok(downloaded);assert.match(await downloaded.text(),/17 documentos Origin não entram neste cálculo/);
 }finally{view.unmount();URL.createObjectURL=create;globalThis.document.createElement=element;}
});
