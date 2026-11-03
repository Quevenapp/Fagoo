import test from 'node:test';
import assert from 'node:assert/strict';
import {homePeriodRoute,homeCustomRoute,homeSummaryPath,homePeriodSearch,homePeriodMatches,homePeriodText,homeSalesLines,homeNetCents,homeChart,homeBarPath,homeAxisMoney,homeBucketLabel,
 homeShortcutsResult,homeShortcutOptions,homeSessionAccess,HOME_PERIOD_OPTIONS,HOME_SALES_LINES} from '../src/lib/home-model.ts';
import {captureHomeRequest,homeShortcutPaths} from '../src/lib/home-request.ts';
import {resolveMenu} from '../src/lib/origin-menu.ts';
import {HOME_SHORTCUTS} from '../../../workers/erp-api/src/home.mjs';
import {STATES} from '../../../packages/erp-domain/src/index.mjs';

const RESOURCES={admin:['contacts','products','sales_orders','purchase_orders','sales_proposals','receivables','payables','nfe','nfce'],consulta:['contacts','products','sales_orders','purchase_orders','sales_proposals','receivables','payables','nfe','nfce'],
 vendas:['contacts','products','sales_orders','sales_proposals'],financeiro:['contacts','receivables','payables'],estoque:['contacts','products','purchase_orders'],fiscal:['contacts','products','sales_orders','purchase_orders','nfe','nfce']};
const period=(points,extra={})=>({key:'30d',from:'2026-09-20',to:'2026-10-19',day_count:30,grain:'day',points,sales:{count:0,statuses:[]},receivable:null,payable:null,invoices:null,...extra});

test('period selector uses Origin labels, keeps Hoje as the clean default and builds strict API paths',()=>{
 assert.deepEqual(HOME_PERIOD_OPTIONS.map(option=>option.label),['Hoje','7D','30D','3M','6M','12M','Customizado']);
 assert.deepEqual(homePeriodRoute(''),{key:'hoje',from:null,to:null});
 assert.deepEqual(homePeriodRoute('?periodo=12m&aba=x'),{key:'12m',from:null,to:null});
 assert.deepEqual(homePeriodRoute('?periodo=customizado&de=2026-01-01&ate=2026-12-31'),{key:'customizado',from:'2026-01-01',to:'2026-12-31'});
 assert.deepEqual(homePeriodRoute('?periodo=6m'),{key:'6m',from:null,to:null});
 for(const search of ['?periodo=1d','?periodo=7D','?periodo=30d&de=2026-01-01&ate=2026-01-02','?periodo=customizado&de=2026-02-30&ate=2026-03-01','?periodo=customizado&de=2026-01-01&ate=2027-01-02','?periodo=30d&periodo=12m','?de=2026-01-01'])
  assert.throws(()=>homePeriodRoute(search),/366 dias/);
 assert.equal(homeSummaryPath({key:'hoje',from:null,to:null}),'/v1/inicio?periodo=hoje');
 assert.equal(homeSummaryPath({key:'customizado',from:'2026-01-01',to:'2026-01-31'}),'/v1/inicio?periodo=customizado&de=2026-01-01&ate=2026-01-31');
 assert.equal(homePeriodSearch({key:'hoje',from:null,to:null}),'');assert.equal(homePeriodSearch({key:'30d',from:null,to:null}),'?periodo=30d');
 assert.deepEqual(homeCustomRoute('2026-03-01','2026-02-01'),{key:'customizado',from:'2026-02-01',to:'2026-03-01'});
 assert.throws(()=>homeCustomRoute('','2026-02-01'),/início e o fim/);assert.throws(()=>homeCustomRoute('2025-01-01','2026-01-02'),/até 366 dias/);assert.throws(()=>homeCustomRoute('2026-02-30','2026-03-01'),/datas válidas/);
 assert.equal(homePeriodMatches(period([]),{key:'30d',from:null,to:null}),true);assert.equal(homePeriodMatches(period([]),{key:'12m',from:null,to:null}),false);
 assert.equal(homePeriodMatches({...period([]),key:'customizado'},{key:'customizado',from:'2026-09-20',to:'2026-10-18'}),false);
 assert.equal(homePeriodText(period([])),'20/09/2026 a 19/10/2026');assert.equal(homePeriodText({...period([]),from:'2026-10-19'}),'19/10/2026');
});

test('sales lines group FAGOO situations under the Origin dots with exact cents and every status covered',()=>{
 assert.deepEqual(HOME_SALES_LINES.map(line=>line.label),['Total de vendas','Novos','Em andamento','Cancelados']);
 const covered=new Set(HOME_SALES_LINES.flatMap(line=>line.statuses));assert.deepEqual([...covered].sort(),Object.keys(STATES.sales_orders).sort());
 const statuses=Object.keys(STATES.sales_orders).map((status,index)=>({status,count:index+1,total_cents:status==='cancelled'?'500':status==='fulfilled'?'9007199254740993':'1'}));
 const lines=Object.fromEntries(homeSalesLines({count:28,statuses}).map(line=>[line.id,[line.count,line.total_cents]]));
 // 202610200245 (documentos lane): Venda Agenciada counts in the total; Faturado parcialmente also in Em andamento.
 // 202610200291: Checkout parcial (6th situação) counts in the total and in Em andamento.
 assert.deepEqual(lines,{total:[45,'9007199254741001'],novos:[3,'2'],andamento:[28,'5'],cancelados:[10,'500']});
 assert.equal(homeNetCents({count:1,total_cents:'100',open_cents:'0',fee_cents:'250'}),'-150');
});

test('chart model keeps one axis with exact tick values, grouped bars per bucket and thinned labels',()=>{
 const points=Array.from({length:30},(_,index)=>({bucket:`2026-10-${String(index+1).padStart(2,'0')}`,sales_cents:index===0?'1250':'0',receivable_cents:index===29?'999999999999999':'0',payable_cents:'75'}));
 const chart=homeChart(period(points));
 assert.deepEqual(chart.series.map(item=>item.label),['Vendas','Contas a receber','Contas a pagar']);
 assert.deepEqual(chart.ticks.map(tick=>tick.cents),['0','500000000000000','1000000000000000']);assert.equal(chart.ticks[0].y,chart.height-chart.bottom);assert.equal(chart.ticks.at(-1).y,chart.top);
 assert.equal(chart.groups.length,30);assert.equal(chart.groups.filter(group=>group.label).length,8);assert.equal(chart.groups[0].label,'01/10');assert.equal(chart.groups[0].title,'01/10/2026');
 const tallest=chart.groups[29].bars.find(bar=>bar.series==='receivable');assert.ok(Math.abs(tallest.y-(chart.top+(chart.height-chart.top-chart.bottom)*0.0001))<0.001);
 assert.ok(chart.groups[0].bars.find(bar=>bar.series==='sales').height>=1);assert.equal(chart.groups[1].bars.find(bar=>bar.series==='sales').height,0);
 for(const group of chart.groups)for(const bar of group.bars){assert.ok(bar.x>=group.x&&bar.x+bar.width<=group.x+group.width+0.001);}
 const single=homeChart(period(points.map(point=>({...point,receivable_cents:null,payable_cents:null}))));assert.deepEqual(single.series.map(item=>item.key),['sales']);
 assert.deepEqual(single.ticks.map(tick=>tick.cents),['0','500','1000','1500']);
 const empty=homeChart(period(points.map(point=>({...point,sales_cents:'0',receivable_cents:'0',payable_cents:'0'}))));assert.equal(empty.empty,true);
 assert.match(homeBarPath({series:'sales',cents:'1',x:10,y:20,width:8,height:30}),/^M10,50V22Q10,20 12,20H16Q18,20 18,22V50Z$/);
 assert.equal(homeAxisMoney('150000'),'R$ 1.500');assert.equal(homeAxisMoney('50'),'R$ 0,50');
 assert.equal(homeBucketLabel('2026-10','month'),'out/26');assert.equal(homeBucketLabel('2026-10','month',true),'10/2026');
});

test('shortcut catalog labels come from the Origin menu and follow the same permissions as resolveMenu("real")',()=>{
 const paths=homeShortcutPaths();assert.deepEqual(paths,Object.keys(HOME_SHORTCUTS));assert.equal(paths.includes('/acesso'),false);
 for(const role of Object.keys(RESOURCES)){
  const available=paths.filter(path=>HOME_SHORTCUTS[path].includes(role));
  const menu=new Set(resolveMenu('real',{role,resources:RESOURCES[role]}).flatMap(group=>[...group.columns.flatMap(column=>column.items),...(group.footer?[group.footer]:[])]).map(item=>item.to).filter(to=>to&&to!=='/acesso'));
  assert.deepEqual(available.slice().sort(),[...menu].sort(),role);
  assert.deepEqual(homeShortcutOptions(paths,{role,resources:RESOURCES[role]}).map(option=>option.to),available,role);
 }
 const admin=homeShortcutOptions(paths,{role:'admin',resources:RESOURCES.admin});
 assert.deepEqual(admin.slice(0,9).map(option=>[option.label,option.group]),[['Dashboard vendas','Meu Negócio'],['Dashboard margem por pedido','Meu Negócio'],['Dashboard produtos','Meu Negócio'],
  ['Dashboard clientes','Meu Negócio'],['Curva ABC','Meu Negócio'],['Metas','Meu Negócio'],['Listagem de produtos','Cadastros'],['Clientes e fornecedores','Cadastros'],['Vendedores','Cadastros']]);
 // Margem por pedido needs the purchase price (purchase orders): vendas reads the other Meu Negócio dashboards only.
 assert.equal(homeShortcutOptions(paths,{role:'vendas',resources:RESOURCES.vendas}).some(option=>option.to==='/meu-negocio?painel=margem-pedido'),false);
 assert.equal(admin.find(option=>option.to==='/historico-fiscal?modelo=55').label,'Notas fiscais');assert.equal(admin.find(option=>option.to==='/financeiro-empresa?area=relatorios').label,'Ver relatórios financeiros');
 assert.deepEqual(homeShortcutOptions(['/estoque-empresa'],null).map(option=>option.label),['Lançamentos de estoque']);
 assert.deepEqual(homeShortcutOptions(paths,{role:'vendas',resources:[]}).some(option=>option.to==='/cadastros-reais?cadastro=products'),false);
});

test('shortcut responses are validated before use, including the exact saved list and version',()=>{
 const base={scope:'home_shortcuts',data_mode:'erp_native',role:'vendas',version:2,customized:true,shortcuts:['/estoque-empresa'],available:['/estoque-empresa','/cadastros-reais?cadastro=contacts'],extra:'discard'};
 assert.deepEqual(homeShortcutsResult(base),{scope:'home_shortcuts',data_mode:'erp_native',role:'vendas',version:2,customized:true,shortcuts:['/estoque-empresa'],labels:{},available:['/estoque-empresa','/cadastros-reais?cadastro=contacts']});
 assert.equal(homeShortcutsResult({...base,replayed:true},{version:2,shortcuts:['/estoque-empresa']}).replayed,true);
 for(const value of [{...base,version:0},{...base,customized:false},{...base,shortcuts:['/acesso']},{...base,shortcuts:['/notas-recebidas']},{...base,role:'root'},null])assert.throws(()=>homeShortcutsResult(value));
 assert.throws(()=>homeShortcutsResult({...base,replayed:false},{version:3,shortcuts:['/estoque-empresa']}));
 assert.throws(()=>homeShortcutsResult({...base,replayed:false},{version:2,shortcuts:[]}));
 assert.throws(()=>homeShortcutsResult(base,{version:2,shortcuts:['/estoque-empresa']}));
 assert.deepEqual(homeSessionAccess({phase:'ready',membership:{user_id:'u',role:'vendas',resources:['contacts']}}),{user_id:'u',role:'vendas',resources:['contacts']});
 for(const state of [null,{phase:'checking',membership:{user_id:'u',role:'vendas',resources:[]}},{phase:'ready',membership:{user_id:'u',role:'root',resources:[]}}])assert.equal(homeSessionAccess(state),null);
});

test('home request capture allows only the summary periods and the shortcut read/save shapes',()=>{
 const command='b0000000-0000-4000-8000-000000000002';
 for(const path of ['/v1/inicio','/v1/inicio?periodo=30d','/v1/inicio?periodo=customizado&de=2026-01-01&ate=2026-01-31','/v1/inicio/atalhos'])assert.equal(captureHomeRequest(path).path,path);
 const saved=captureHomeRequest('/v1/inicio/atalhos',{method:'POST',body:{command_id:command,expected_version:0,shortcuts:['/estoque-empresa']}});
 assert.deepEqual(saved.options.body,{command_id:command,expected_version:0,shortcuts:['/estoque-empresa']});assert.equal(saved.options.method,'POST');
 for(const [path,options] of [['/v1/inicio?actor=x',{}],['/v1/inicio',{method:'POST'}],['/v1/inicio',{body:{}}],['/v1/inicio/extra',{}],['/v1/inicio/atalhos?x=1',{}],['/v1/inicio/atalhos',{method:'PATCH',body:{}}],
  ['/v1/inicio/atalhos',{body:{}}],['/v1/inicio/atalhos',{method:'POST',body:{command_id:command,expected_version:0,shortcuts:['/acesso']}}],['/v1/inicio/atalhos',{method:'POST',body:{command_id:'x',expected_version:0,shortcuts:[]}}],
  ['/v1/inicio/atalhos',{method:'POST',body:{command_id:command,expected_version:0,shortcuts:[],extra:1}}],['/v1/inicio#x',{}],['https://other.invalid/v1/inicio',{}]])
  assert.throws(()=>captureHomeRequest(path,options),undefined,path);
});
