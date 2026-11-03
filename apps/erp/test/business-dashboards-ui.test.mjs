import test from'node:test';import assert from'node:assert/strict';
import{mountComponent}from'./helpers/component-recovery-harness.mjs';
import{createBusinessFixture}from'../src/qa/business-fixture.ts';
import{todaySP,shiftDay,monthStart,previousMonthRange,businessScreen,moneyText,qtyText,variation,goalBody,blankGoal}from'../src/lib/business-model.ts';
import{captureSystemPortRequest}from'../src/lib/system-request.ts';
import{resolveMenu}from'../src/lib/origin-menu.ts';

// Meu Negócio dashboards like Origin (migration 150). Synthetic data only.
let previous,downloads=[];test.before(()=>{previous=globalThis.document;globalThis.document={activeElement:null,documentElement:{dataset:{}},addEventListener(){},removeEventListener(){},
 body:{append(){},classList:{add(){},remove(){}}},createElement:()=>({click(){downloads.push(this.download);},remove(){}})};globalThis.URL.createObjectURL??=()=>'blob:synthetic';globalThis.URL.revokeObjectURL??=()=>{};});
test.after(()=>{globalThis.document=previous;});
const textOf=n=>Array.isArray(n)?n.map(textOf).join(''):n&&typeof n==='object'?textOf(n.props?.children):n===null||n===undefined||typeof n==='boolean'?'':String(n);
const mount=(f,screen='mensal')=>mountComponent('BusinessDashboards.tsx',{controller:f.controller},{location:`/meu-negocio?painel=${screen}`,expandChildren:true});
const panels=f=>f.calls.filter(c=>c.path.startsWith('/v1/meu-negocio/')).map(c=>c.path);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};

test('150 Dashboard Mensal opens with the Ajustes statuses, the current month and the previous month, and shows the Origin blocks',async()=>{
 const f=createBusinessFixture(),v=await mount(f);try{
  const today=todaySP(),from=monthStart(today),cmp=previousMonthRange(from,today);
  assert.equal(f.calls[0].path,'/v1/preferencias/meu-negocio');
  assert.deepEqual(panels(f),[`/v1/meu-negocio/mensal?situacoes=verified%2Cin_progress%2Cfulfilled&de=${from}&ate=${today}&comparar_de=${cmp.from}&comparar_ate=${cmp.to}`]);
  const text=v.text();
  for(const label of['Dashboard Mensal','Situação de Venda','Visualizar','Valor Total','Quantidade de Pedidos','Produtos Vendidos','Ticket Médio','Metas em andamento','Todas as metas','Valor total de pedidos por dia',
   'Período Anterior','Período Atual','Todos os pedidos','Situação','Indicadores','FATURAMENTO SEM FRETE','PREÇO DE CUSTO','MARGEM BRUTA','IMPOSTOS','TAXA VENDA','LUCRO','Valor Total por Canal no Período',
   'Top 10 SKUs Mais Vendidos','Valor Total Bruto','Estatísticas Anual','Última atualização','Como funciona','Previsão Inteligente'])assert.ok(text.includes(label),label);
  assert.match(text,/Valor TotalR\$ 16,00\+100,0%Período anterior: R\$ 8,00/);assert.match(text,/Meta de outubroR\$ 16,00 de R\$ 100,00/);
  assert.match(text,/MARGEM BRUTA.*R\$ 8,50 \(77,27%\)/s);// 188: Previsão Inteligente is a linear projection of the period (tested in preferences-c-ui).
  assert.equal(v.button('Previsão Inteligente').disabled,false);
  // Side menu in Origin order; Produtos opens the estoque lane dashboards.
  assert.match(text,/DashboardMensalDiárioVendasPedidos de VendaVenda por VendedorVenda Canal \(24 meses\)Previsão de EstoqueGestão de MarketplacesMargem por PedidoProdutosEstoque de ProdutosSugestão de ComprasSem MovimentaçãoClientesNovo x RecorrentesAtividade da CarteiraDesempenhoCurva ABCMetas/);
  await v.click('Como funciona');assert.match(v.text(),/preço da última compra registrada no FAGOO/);
 }finally{v.unmount();}
});

test('150 filters: Situação chips and dates build the strict path; Filtros inválidos! sends nothing; a late older answer is ignored',async()=>{
 const gate=deferred();let first=true;
 const f=createBusinessFixture({before:async call=>{if(call.path.startsWith('/v1/meu-negocio/pedidos-venda')&&first){first=false;await gate.promise;}}}),v=await mount(f,'pedidos-venda');try{
  await v.change('business-pedidos-venda-status-open',true);await v.change('business-pedidos-uf','SP');await v.submit(0);
  const today=todaySP(),from=monthStart(today);
  assert.equal(panels(f).at(-1),`/v1/meu-negocio/pedidos-venda?situacoes=open%2Cverified%2Cin_progress%2Cfulfilled&de=${from}&ate=${today}&uf=SP`);
  gate.resolve();await v.flush();assert.match(v.text(),/Vendas por estadoExcelCSVPDFProcurar:/);assert.match(v.text(),/SPR\$ 5,00/);
  const before=panels(f).length;await v.change('business-pedidos-venda-from','2026-12-31');await v.change('business-pedidos-venda-to','2026-01-01');await v.submit(0);
  assert.match(v.text(),/Filtros inválidos!/);assert.equal(panels(f).length,before);
  await v.change('business-pedidos-venda-from',from);await v.change('business-pedidos-venda-to',today);
  for(const s of['verified','in_progress','fulfilled','open'])await v.change(`business-pedidos-venda-status-${s}`,false);await v.submit(0);
  assert.match(v.text(),/Escolha ao menos uma Situação de Venda/);assert.equal(panels(f).length,before);
 }finally{v.unmount();}
});

test('150 visibility: vendas has no Margem por Pedido and no cost; financeiro has no stock dashboards; the menu and the shortcuts agree',async()=>{
 const f=createBusinessFixture({role:'vendas'}),v=await mount(f);try{
  assert.doesNotMatch(v.text(),/Margem por Pedido/);assert.match(v.text(),/PREÇO DE CUSTOSeu perfil não consulta o preço de custo \(custo médio do estoque, fornecedor padrão e compras\)\.—/);assert.match(v.text(),/Previsão de Estoque/);
  await v.navigate('/meu-negocio?painel=margem-pedido');assert.equal(businessScreen('?painel=margem-pedido','vendas'),'mensal');
 }finally{v.unmount();}
 const g=createBusinessFixture({role:'financeiro'}),w=await mount(g);try{assert.doesNotMatch(w.text(),/Previsão de Estoque|Estoque de Produtos/);assert.match(w.text(),/Margem por Pedido/);}finally{w.unmount();}
 const menu=(role,res=[])=>resolveMenu('real',{role,resources:res}).find(group=>group.name==='Meu Negócio').columns[0].items.filter(i=>!i.disabled).map(i=>i.label);
 assert.deepEqual(menu('vendas'),['Dashboard geral','Dashboard vendas','Dashboard produtos','Dashboard clientes','Curva ABC','Metas']);
 assert.deepEqual(menu('financeiro'),['Dashboard geral','Dashboard vendas','Dashboard margem por pedido','Dashboard clientes','Curva ABC','Metas']);
});

test('150 Margem por Pedido tabs request the server again; Curva ABC tabs filter the rows; exports download the whole table',async()=>{
 const f=createBusinessFixture(),v=await mount(f,'margem-pedido');try{
  assert.match(v.text(),/Informações importantes sobre o cálculo/);assert.match(v.text(),/Margem de contribuiçãoR\$ 8,50 \(77,27%\)/);
  v.find(n=>n.type==='button'&&n.props.role==='tab'&&textOf(n)==='Prejuízo').props.onClick();await v.flush();
  assert.match(panels(f).at(-1),/aba=prejuizo/);assert.match(v.text(),/Nenhum resultado encontrado/);
  v.find(n=>n.type==='button'&&textOf(n).endsWith('CSV')).props.onClick?.();
 }finally{v.unmount();}
 downloads=[];const g=createBusinessFixture(),w=await mount(g,'curva-abc');try{
  assert.match(w.text(),/Curva A1 SKUsCurva B0 SKUsCurva C1 SKUs/);assert.match(w.text(),/Caneta azul/);assert.doesNotMatch(w.text(),/Lápis/);
  w.find(n=>n.type==='button'&&n.props.role==='tab'&&textOf(n)==='Curva C').props.onClick();await w.flush();assert.match(w.text(),/Lápis/);
  w.find(n=>n.type==='button'&&textOf(n)==='CSV').props.onClick();assert.deepEqual(downloads,['curva-abc-c.csv']);
 }finally{w.unmount();}
});

test('150 Metas: administrador includes a goal with a recorded command; an uncertain answer keeps it for Conferir resultado; others only read',async()=>{
 const f=createBusinessFixture({lostAck:true}),v=await mount(f,'metas');try{
  assert.match(v.text(),/Metas em andamentoMetas inativas/);assert.match(v.text(),/Você ainda não possui metas cadastradas/);
  await v.click('Nova meta');assert.match(v.text(),/Objetivo: O que você gostaria de acompanhar\?/);
  await v.change('goal-name','Meta sintética');await v.change('goal-target','1.500,50');await v.click('Salvar');
  const post=f.calls.find(c=>c.method==='POST');assert.equal(post.body.data.target,'1500.50');assert.equal(post.body.goal_id,null);
  assert.match(v.text(),/Conferir resultado/);await v.click('Conferir resultado');
  assert.ok(f.calls.some(c=>c.path===`/v1/meu-negocio/metas/comandos/${post.body.command_id}`));assert.match(v.text(),/Meta incluída \(comando já registrado\)/);assert.match(v.text(),/Meta sintética/);
 }finally{v.unmount();}
 const g=createBusinessFixture({role:'consulta'}),w=await mount(g,'metas');try{assert.throws(()=>w.button('Nova meta'));assert.match(w.text(),/Somente administradores incluem e alteram metas/);}finally{w.unmount();}
 assert.match(goalBody({...blankGoal('2026-10-20'),name:'X',target:'0'},null,'20000000-0000-4000-8000-000000000150').problem,/Valor da meta/);
});

test('150 Ajustes opens Configurações Meu negócio in a modal; saving closes it and the dashboard reloads with the new statuses',async()=>{
 const f=createBusinessFixture(),v=await mount(f);try{
  await v.click('Ajustes');assert.match(v.text(),/Configurações Meu negócio.*Taxas de Marketplace/s);assert.match(v.text(),/Adicione as situações que considera como Pedido Finalizado/);
  await v.change('pref-negocio-situacoes_finalizado-open',true);await v.click('Salvar');
  assert.doesNotMatch(v.text(),/Taxas de Marketplace/);assert.match(panels(f).at(-1),/situacoes=open%2Cverified%2Cin_progress%2Cfulfilled/);
 }finally{v.unmount();}
});

test('150 a role change hides the dashboard and discards a late answer; models keep exact decimals',async()=>{
 const gate=deferred(),f=createBusinessFixture({before:async call=>{if(call.path.startsWith('/v1/meu-negocio/'))await gate.promise;}}),v=await mount(f,'previsao-estoque');try{
  assert.match(v.text(),/Dashboard Previsão de Estoque/);f.setAccess({role:'financeiro'});await v.flush();
  // Financeiro does not read the stock: the screen falls back to Mensal and the stock answer never shows.
  assert.match(v.text(),/Dashboard Mensal/);assert.doesNotMatch(v.text(),/Previsão de Estoque/);gate.resolve();await v.flush();assert.doesNotMatch(v.text(),/Giro de Produto/);assert.match(v.text(),/Valor Total/);
  f.setAccess({actor:'10000000-0000-4000-8000-000000000999'});await v.flush();assert.match(v.text(),/Dashboard não liberado/);
 }finally{v.unmount();}
 assert.equal(moneyText('123456789012.30'),'R$ 123.456.789.012,30');assert.equal(qtyText('1500.250000'),'1.500,25');assert.deepEqual(variation('16.00','8.00'),{text:'+100,0%',up:true});
 assert.equal(variation('1.00','0.00'),null);assert.equal(shiftDay('2026-03-01',-1),'2026-02-28');assert.deepEqual(previousMonthRange('2026-03-01','2026-03-31'),{from:'2026-02-01',to:'2026-02-28'});
 for(const bad of['/v1/meu-negocio/mensal','/v1/meu-negocio/estoque','/v1/meu-negocio/metas?aba=x','/v1/outra/rota'])assert.throws(()=>captureSystemPortRequest(bad,{}),bad);
 assert.throws(()=>captureSystemPortRequest('/v1/meu-negocio/metas',{method:'POST',body:{command_id:'x'}}));
});

test('150 review: Ajustes without any situação opens the dashboards with the default; a table cut by the response bound says so',async()=>{
 const f=createBusinessFixture({finished:[]}),v=await mount(f);try{
  const today=todaySP(),from=monthStart(today),cmp=previousMonthRange(from,today);
  assert.deepEqual(panels(f),[`/v1/meu-negocio/mensal?situacoes=verified%2Cin_progress%2Cfulfilled&de=${from}&ate=${today}&comparar_de=${cmp.from}&comparar_ate=${cmp.to}`]);
  assert.match(v.text(),/Valor Total/);
 }finally{v.unmount();}
 // Curva ABC: 3 SKUs in curve A, the answer carries only the first one (byte budget of migration 150).
 const g=createBusinessFixture({before:call=>{if(!call.path.startsWith('/v1/meu-negocio/curva-abc'))return undefined;const q=new URLSearchParams(call.path.split('?')[1]);
  return{scope:'business_dashboard',data_mode:'erp_native',panel:'curva-abc',role:'admin',as_of:'2026-10-20T12:00:00.000000+00:00',business_date:'2026-10-20',cost_visible:true,stock_visible:true,
   filters:{statuses:q.get('situacoes').split(','),from:q.get('de'),to:q.get('ate'),brand:null},total:'30.00',counts:{A:3,B:0,C:0},
   products:[{product_id:null,code:'SKU-1',name:'Produto sintético 1',units:'1.000000',total:'10.00',share_pct:'33.33',cumulative_pct:'33.33',curve:'A'}]};}}),w=await mount(g,'curva-abc');try{
  assert.match(w.text(),/Produto sintético 1/);assert.match(w.text(),/Mostrando as 1 primeiras de 3 linhas; refine os filtros para ver as demais\./);
 }finally{w.unmount();}
});

test('150 review: a role change of the same user asks the panel again, so the cost read as administrador never stays on screen',async()=>{
 const f=createBusinessFixture(),v=await mount(f);try{
  assert.match(v.text(),/PREÇO DE CUSTO.*R\$ 2,50/s);const before=panels(f).length;
  f.setAccess({role:'vendas'});await v.flush();
  assert.equal(panels(f).length,before+1);assert.doesNotMatch(v.text(),/R\$ 2,50/);assert.match(v.text(),/Seu perfil não consulta o preço de custo/);
 }finally{v.unmount();}
});

test('business indicators identify native coverage after the shared parser', async () => {
 const f=createBusinessFixture(),read=f.controller.system;
 f.controller.system=async(...args)=>{const raw=await read(...args);return args[0].startsWith('/v1/meu-negocio/')?{...raw,origin:'brufap',mirror_excluded_count:17,coverage:{partial:true,reason:'native_effects_only'}}:raw;};
 const view=await mount(f);
 try { assert.match(view.text(),/Indicadores operacionais do FAGOO; 17 documentos Origin não entram neste cálculo/); } finally { view.unmount(); }
});
