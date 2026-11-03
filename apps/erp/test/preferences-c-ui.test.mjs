import './helpers/synthetic-october-clock.mjs';
import test from'node:test';import assert from'node:assert/strict';
import{mountComponent}from'./helpers/component-recovery-harness.mjs';
import{STATES}from'../../../packages/erp-domain/src/index.mjs';
import{homePeriodBuckets,homePeriodRange,HOME_SHORTCUTS}from'../../../workers/erp-api/src/home.mjs';
import{homeChartValues,moveChart,homeFavoriteLabel}from'../src/lib/home-model.ts';
import{createPreferencesFixture,PREFERENCES_QA_OTHER}from'../src/qa/preferences-fixture.ts';
import{preferencePage}from'../../../packages/erp-domain/src/preferences/catalog.mjs';
import{AccessError}from'./helpers/component-recovery-harness.mjs';
import{createBusinessFixture}from'../src/qa/business-fixture.ts';
import{forecastPeriod,mapShade,BRAZIL_TILES}from'../src/lib/business-model.ts';
import{storageSummary}from'../src/lib/system-model.ts';

// Wave C of Preferências, Sistema and Meu Negócio (migrations 185-190). Synthetic data only.
let previous,previousWindow;test.before(()=>{previous=globalThis.document;previousWindow=globalThis.window;globalThis.window={addEventListener(){},removeEventListener(){}};
 globalThis.document={activeElement:null,documentElement:{dataset:{}},addEventListener(){},removeEventListener(){},querySelector:()=>null,body:{append(){},classList:{add(){},remove(){}}}};});
test.after(()=>{globalThis.document=previous;globalThis.window=previousWindow;});
const textOf=n=>Array.isArray(n)?n.map(textOf).join(''):n&&typeof n==='object'?textOf(n.props?.children):n===null||n===undefined||typeof n==='boolean'?'':String(n);

test('PRF-253 the home Customizado calendar disables future days and never applies them; the charts say "Atualizado em"',async()=>{
 const applied=[],v=await mountComponent('OriginList.tsx',{from:'2026-10-01',to:'2026-10-10',today:'2026-10-20',noFuture:true,onApply:range=>applied.push(range)},{componentName:'PeriodPicker',expandChildren:['CalendarMonth']});
 try{
  v.find(n=>n.type==='button'&&n.props.title==='Abrir períodos').props.onClick();await v.flush();
  const day=(label,side=0)=>v.nodes().filter(n=>n.type==='button'&&n.props['aria-label']===label)[side];
  assert.equal(day('21/10/2026').disabled,true);assert.equal(day('20/10/2026').disabled,false);assert.equal(day('19/10/2026').disabled,false);
  // "Este mês" would end on 31/10; the end is today. A typed future date becomes today too.
  await v.click('Este mês');await v.click('Filtrar');assert.deepEqual(applied.at(-1),{from:'2026-10-01',to:'2026-10-20',dateType:undefined});
  v.find(n=>n.type==='button'&&n.props.title==='Abrir períodos').props.onClick();await v.flush();
  const end=v.nodes().filter(n=>n.type==='input'&&n.props.placeholder==='dd/mm/aaaa')[1];end.props.onChange({target:{value:'25/12/2026'}});await v.flush();
  assert.equal(v.nodes().filter(n=>n.type==='input'&&n.props.placeholder==='dd/mm/aaaa')[1].props.value,'20/10/2026');
  await v.click('Filtrar');assert.equal(applied.at(-1).to,'2026-10-20');
 }finally{v.unmount();}
 // Other lists keep future days (Origin lists filter by due dates ahead).
 const w=await mountComponent('OriginList.tsx',{from:'',to:'',today:'2026-10-20',onApply(){}},{componentName:'PeriodPicker',expandChildren:['CalendarMonth']});
 try{w.find(n=>n.type==='button'&&n.props.title==='Abrir períodos').props.onClick();await w.flush();assert.equal(w.nodes().find(n=>n.type==='button'&&n.props['aria-label']==='21/10/2026').disabled,false);}finally{w.unmount();}
 const{homeChartUpdated}=await import('../src/lib/home-model.ts');
 assert.equal(homeChartUpdated('2026-10-20T12:05:00Z'),'Atualizado em: 20/10 às 09:05');assert.equal(homeChartUpdated('2026-10-21T02:30:00Z'),'Atualizado em: 20/10 às 23:30');
});

const uid='a0000000-0000-4000-8000-000000000001',today='2026-10-19';
function homeServer(role='admin'){
 const calls=[];const snapshot={phase:'ready',membership:{user_id:uid,role,resources:['contacts','products','sales_orders']}};
 const summary=path=>{const params=new URL(path,'https://synthetic.invalid').searchParams,key=params.get('periodo');const [from,to]=homePeriodRange(key,today,params.get('de'),params.get('ate')),{grain,buckets}=homePeriodBuckets(from,to);
  return{data_mode:'erp_native',as_of:'2026-10-19T12:00:00Z',business_date:today,timezone:'America/Sao_Paulo',role,catalog:[{entity:'contacts',active:1,archived:0}],documents:[],stock:null,finance:null,
   period:{key,from,to,day_count:(Date.parse(to)-Date.parse(from))/86400000+1,grain,points:buckets.map(bucket=>({bucket,sales_cents:'0',receivable_cents:null,payable_cents:null})),
    sales:{count:0,statuses:Object.keys(STATES.sales_orders).map(status=>({status,count:0,total_cents:'0'}))},receivable:null,payable:null,invoices:null}};};
 return{calls,controller:{getSnapshot:()=>snapshot,subscribe:()=>()=>{},async home(path,options={}){calls.push({path,...options});return summary(path);}}};
}
test('PRF-253 the home picker is the no-future one and the chart shows the update time of the summary',async()=>{
 const s=homeServer(),v=await mountComponent('RealHome.tsx',{controller:s.controller},{location:'/acesso?periodo=customizado&de=2026-10-01&ate=2026-10-10',expandChildren:['HomeView']});
 try{const picker=v.find(n=>n.type?.name==='PeriodPicker');assert.equal(picker.props.noFuture,true);assert.equal(picker.props.today,today);
  assert.equal(v.find(n=>n.type?.name==='HomeChartCards').props.resumo.props.asOf,'2026-10-19T12:00:00Z');}finally{v.unmount();}
});

const company=()=>{const calls=[];return{calls,port:{async company(path,options={}){calls.push({path,...options});
 if(path==='/v1/empresa')return{read_identity:true,write_identity:true,read_fiscal:false,write_fiscal:false,data_mode:'erp_native',emission_enabled:false};
 return{section:'identity',record:{version:1,data:{legal_name:'Empresa Sintética Ltda',trade_name:'Sintética',cnpj:'11222333000181',ie:null,postal_code:'01001000',street:'Rua Sintética',number:'1',complement:null,district:'Centro',city:'São Paulo',municipality_code:'3550308',state:'SP',phone:null,email:null},created_at:'2026-10-20T12:00:00Z',updated_at:'2026-10-20T12:00:00Z'},data_mode:'erp_native',emission_enabled:false};}}};};
test('PRF-303 Dados da empresa: Salvar and Cancelar as in Origin, with "(*) Campos obrigatórios"; Cancelar returns to the saved data',async()=>{
 const c=company(),v=await mountComponent('CompanySettings.tsx',{controller:c.port},{location:'/empresa-configuracoes'});
 try{
  assert.ok(v.text().includes('(*) Campos obrigatórios'));assert.doesNotMatch(v.text(),/Salvar identidade da empresa/);
  assert.equal(v.button('Cancelar').disabled,true,'nothing to cancel');assert.equal(v.button('Salvar').disabled,false);
  await v.change('company-street','Rua Alterada');assert.equal(v.guard().changed,true);assert.equal(v.button('Cancelar').disabled,false);
  await v.click('Cancelar');assert.equal(v.input('company-street').props.value,'Rua Sintética');assert.equal(v.guard().changed,false);assert.equal(c.calls.filter(x=>x.method==='POST').length,0);
  // Corrigir dados bloqueados can be cancelled too: the three fields lock again.
  await v.click('Corrigir dados bloqueados');assert.equal(v.input('company-cnpj').disabled,false);await v.click('Cancelar');assert.equal(v.input('company-cnpj').disabled,true);
  await v.change('company-number','2');await v.submit(0);const post=c.calls.find(x=>x.method==='POST');assert.equal(post.path,'/v1/empresa/identidade');assert.equal(post.body.data.number,'2');
 }finally{v.unmount();}
});

const central=(f)=>mountComponent('PreferenceSettingsPage.tsx',{controller:f.controller,page:preferencePage('central-notificacoes'),categoryLabel:'Sistema',categoryTo:'/preferencias/sistema'},{expandChildren:true,location:'/preferencias/sistema/central-notificacoes'});
test('PRF-284 Central de Notificações: the Origin table Notificação | Destinatários | Editar, inline "Adicionar Usuário", one command by Salvar',async()=>{
 const f=createPreferencesFixture({lostAck:true}),v=await central(f);try{
  const heads=v.nodes().filter(n=>n.type==='th').map(textOf);assert.deepEqual(heads,['Notificação','Destinatários','Editar']);
  const rows=v.nodes().filter(n=>n.type==='tr').slice(1).map(r=>textOf(r.props.children[0]));
  assert.deepEqual(rows.map(r=>r.replace(/Contatos com.*|Produtos cuja.*|O certificado A1.*|Lotes com saldo.*/,'')),['Cliente a ser visitado','Contas a pagar atrasadas','Contas a receber atrasadas','Estoque disponível abaixo do mínimo','Estoque disponível chegou ao máximo',
   'Estoque disponível zerado ou negativo','Lote próximo ao vencimento','Pagamento efetuado','Pagamento recebido','Produto com data de validade próxima','Próximo contato proposta comercial','Certificado A1 próximo do vencimento']);
  // 283 (wave F): Lote próximo ao vencimento has recipients too, from the lots of the stock.
  assert.doesNotMatch(v.text(),/Indisponível/);assert.match(v.text(),/Administradores \(padrão\)/);
  assert.ok(v.nodes().some(n=>n.type==='button'&&n.props['aria-label']==='Editar destinatários de Lote próximo ao vencimento'));
  v.find(n=>n.type==='button'&&n.props['aria-label']==='Editar destinatários de Produto com data de validade próxima').props.onClick();await v.flush();
  const input=v.input('pref-notificacoes-validade-add');assert.equal(input.props.placeholder,'Adicionar Usuário');
  await v.change('pref-notificacoes-validade-add','Vendas sintético · Vendas');assert.match(v.text(),/Remover Vendas sintético|Vendas sintético/);
  assert.equal(v.input('pref-notificacoes-validade-add').props.value,'');assert.equal(v.guard().changed,true);
  v.find(n=>n.type==='button'&&n.props['aria-label']==='Concluir edição de Produto com data de validade próxima').props.onClick();await v.flush();
  assert.match(v.text(),/Vendas sintético \(1\)/);
  await v.click('Salvar');const post=f.calls.find(c=>c.method==='POST');assert.deepEqual(post.body.changes,[{key:'notificacoes.validade',expected_version:0,value:[PREFERENCES_QA_OTHER]}]);
  assert.match(v.text(),/Conferir resultado/);await v.click('Conferir resultado');assert.match(v.text(),/1 preferência salva/);
  assert.equal(new Set(f.calls.filter(c=>c.method==='POST').map(c=>c.body.command_id)).size,1);
 }finally{v.unmount();}
 // Only the administrador edits: another role sees the recipients without Editar.
 const g=createPreferencesFixture({role:'vendas'}),w=await central(g);try{
  assert.ok(!w.nodes().some(n=>n.type==='button'&&String(n.props['aria-label']).startsWith('Editar destinatários')));assert.match(w.text(),/Somente administradores alteram estas preferências/);
 }finally{w.unmount();}
});

const expiring=(items,{total=items.length,days=7}={})=>({scope:'product_expiry',data_mode:'erp_native',business_date:'2026-10-20',days,total,items});
test('PRD-128 the home shows "Produtos próximos da validade" for product readers only, expired ones marked; nothing when none is due',async()=>{
 const calls=[],port=(answer)=>({async system(path,options){calls.push({path,...options});if(answer instanceof Error)throw answer;return answer;}});
 const more=Array.from({length:18},(_,i)=>({product_id:`30000000-0000-4000-8000-0000000001${String(i).padStart(2,'0')}`,code:null,name:`Lote ${i}`,expiry_date:'2026-10-26',expired:false}));
 const due=expiring([{product_id:'30000000-0000-4000-8000-000000000001',code:'QJ-1',name:'Queijo vencido',expiry_date:'2026-10-17',expired:true},{product_id:'30000000-0000-4000-8000-000000000002',code:null,name:'Iogurte',expiry_date:'2026-10-25',expired:false},...more],{total:23});
 const v=await mountComponent('HomeExpiring.tsx',{controller:port(due),role:'vendas'},{componentName:'HomeExpiring'});try{
  assert.equal(calls.at(-1).path,'/v1/sistema/validade');assert.match(v.text(),/Produtos próximos da validade/);assert.match(v.text(),/QJ-1Queijo vencido17\/10\/2026 Vencido/);
  assert.match(v.text(),/—Iogurte25\/10\/2026/);assert.match(v.text(),/Mostrando os 20 primeiros de 23 produtos/);assert.match(v.text(),/até 7 dia\(s\) a partir de hoje/);
 }finally{v.unmount();}
 const before=calls.length,w=await mountComponent('HomeExpiring.tsx',{controller:port(due),role:'financeiro'},{componentName:'HomeExpiring'});try{assert.equal(w.text(),'');assert.equal(calls.length,before);}finally{w.unmount();}
 for(const answer of[expiring([]),new AccessError(503),{...due,items:[...due.items].reverse()}]){const x=await mountComponent('HomeExpiring.tsx',{controller:port(answer),role:'admin'},{componentName:'HomeExpiring'});try{assert.equal(x.text(),'');}finally{x.unmount();}}
});

const business=(f,screen)=>mountComponent('BusinessDashboards.tsx',{controller:f.controller},{location:`/meu-negocio?painel=${screen}`,expandChildren:true});
test('PRF-262 Previsão Inteligente projects the period by the daily average, in exact cents; a finished period is its own total',async()=>{
 const daily=[{day:'2026-10-01',total:'10.00'},{day:'2026-10-02',total:'0.01'},{day:'2026-10-03',total:'5.00'},{day:'2026-10-04',total:'100.00'}];
 assert.deepEqual(forecastPeriod(daily,'2026-10-01','2026-10-31','2026-10-03'),{elapsed:3,days:31,sum:'15.01',per_day:'5.00',projected:'155.10',complete:false});
 assert.deepEqual(forecastPeriod(daily,'2026-10-01','2026-10-04','2026-10-20'),{elapsed:4,days:4,sum:'115.01',per_day:'28.75',projected:'115.01',complete:true});
 assert.equal(forecastPeriod(daily,'2026-11-01','2026-11-30','2026-10-20'),null);
 const fx=createBusinessFixture(),v=await business(fx,'mensal');try{
  assert.doesNotMatch(v.text(),/previstos para o período/);await v.click('Previsão Inteligente');
  assert.match(v.text(),/Previsão Inteligente.*previstos para o período.*Projeção linear, sem sazonalidade/s);assert.equal(v.button('Previsão Inteligente').props['aria-pressed'],true);
  await v.click('Previsão Inteligente');assert.doesNotMatch(v.text(),/previstos para o período/);
 }finally{v.unmount();}
});
test('PRF-264 Pedidos de Venda: the UF tile map filters the dashboard by the chosen state and back to every state',async()=>{
 assert.equal(Object.keys(BRAZIL_TILES).length,27);assert.equal(new Set(Object.values(BRAZIL_TILES).map(p=>p.join())).size,27);
 assert.equal(mapShade('16.00',1600n),4);assert.equal(mapShade('0.00',1600n),0);assert.equal(mapShade('1.00',1600n),1);assert.equal(mapShade(undefined,1600n),0);
 const fx=createBusinessFixture(),v=await business(fx,'pedidos-venda');try{
  assert.match(v.text(),/Filtro por Estados/);const sp=v.find(n=>n.props.role==='button'&&String(n.props['aria-label']).startsWith('SP:'));assert.match(sp.props['aria-label'],/SP: R\$ 16,00 em 1 pedido/);
  sp.props.onClick();await v.flush();assert.match(fx.calls.filter(c=>c.path.startsWith('/v1/meu-negocio/')).at(-1).path,/&uf=SP$/);
  await v.click('Todos os estados');assert.doesNotMatch(fx.calls.filter(c=>c.path.startsWith('/v1/meu-negocio/')).at(-1).path,/uf=/);
  assert.match(v.text(),/Impostos/);
 }finally{v.unmount();}
});
test('PRF-268 Margem por Pedido asks to configure the alíquota and opens Ajustes; with one it shows the rate in the calculation note',async()=>{
 const fx=createBusinessFixture(),v=await business(fx,'margem-pedido');try{
  assert.match(v.text(),/Configure sua alíquota de imposto/);assert.match(v.text(),/Custos variáveis \(Imposto\)/);await v.click('Ir para ajustes');assert.match(v.text(),/Configurações Meu negócio/);
  assert.match(v.text(),/Alíquota de imposto sobre as vendas \(%\)/);
 }finally{v.unmount();}
 const g=createBusinessFixture({taxRate:'10.5'}),w=await business(g,'margem-pedido');try{assert.doesNotMatch(w.text(),/Configure sua alíquota de imposto/);assert.match(w.text(),/alíquota de Ajustes \(hoje 10,5%\)/);}finally{w.unmount();}
});
test('PRF-249/282 storage: used over the limit, orange above 90%; without a limit only the usage',()=>{
 assert.deepEqual(storageSummary({total_bytes:'3145728',limit_bytes:null}),{label:'3,0 MB',percent:null,warn:false});
 assert.deepEqual(storageSummary({total_bytes:'966367642',limit_bytes:'1073741824'}),{label:'921,6 MB/1,0 GB',percent:90,warn:false});
 assert.deepEqual(storageSummary({total_bytes:'1000000000',limit_bytes:'1073741824'}),{label:'953,6 MB/1,0 GB',percent:93.1,warn:true});
 assert.equal(storageSummary({total_bytes:'2147483648',limit_bytes:'1073741824'}).percent,100);
});

const period=(sales)=>({key:'7d',from:'2026-10-14',to:'2026-10-20',day_count:7,grain:'day',points:[],receivable:null,payable:null,invoices:null,
 sales:{count:sales.reduce((n,s)=>n+s.count,0),statuses:Object.keys(STATES.sales_orders).map(status=>({status,count:0,total_cents:'0',...sales.find(s=>s.status===status)}))}});
function chartsPort({charts=['resumo','ticket_medio','valor_faturado','quantidade_pedidos','top_skus'],role='vendas',lose=false,fail=false,drop=false}={}){
 // `drop`: the first POST fails before anything is recorded (the command never reaches the database).
 const calls=[],recorded=new Set();let version=0,list=[...charts],lost=lose,dropped=drop;const available=['resumo','ticket_medio','valor_faturado','quantidade_pedidos',...(role==='financeiro'?[]:['top_skus'])];
 const view=()=>({scope:'home_charts',data_mode:'erp_native',role,version,customized:version>0,charts:[...list],available});
 return{calls,otherSession(next){version++;list=[...next];},controller:{async system(path,options={}){calls.push({path,...options});if(fail)throw new AccessError(502);
  if(path.startsWith('/v1/sistema/top-produtos'))return{scope:'home_top_products',data_mode:'erp_native',key:'7d',from:'2026-10-14',to:'2026-10-20',items:[{product_id:'30000000-0000-4000-8000-000000000001',code:'CAN-1',name:'Caneta',units:'6.000000',total_cents:'1800'}]};
  if(options.method==='POST'&&dropped){dropped=false;throw new AccessError(503);}
  if(options.method==='POST'&&drop){const b=options.body;if(!recorded.has(b.command_id)&&b.expected_version!==version)throw new AccessError(409);recorded.add(b.command_id);}
  if(options.method==='POST'){const b=options.body;if(b.expected_version!==version&&!calls.some(c=>c!==calls.at(-1)&&c.body?.command_id===b.command_id))throw new AccessError(409);
   const replayed=calls.filter(c=>c.body?.command_id===b.command_id).length>1;if(!replayed){version++;list=[...b.charts];}
   const out={...view(),receipt:{command_id:b.command_id,version,charts:[...b.charts],changed_at:'2026-10-20T12:00:00.000000+00:00'},replayed};if(lost){lost=false;throw new AccessError(503);}return out;}
  return view();}}};
}
test('PRF-254 Incluir gráficos: Ticket Médio, Valor Faturado, Quantidade de pedidos and Top 5 SKUs, per user order, Excluir gráfico and Conferir resultado',async()=>{
 const p=period([{status:'open',count:2,total_cents:'1001'},{status:'fulfilled',count:1,total_cents:'500'},{status:'cancelled',count:4,total_cents:'9999'}]);
 assert.deepEqual(homeChartValues(p),{orders:3,billed_cents:'1501',ticket_cents:'500'});assert.deepEqual(homeChartValues(period([])),{orders:0,billed_cents:'0',ticket_cents:'0'});
 assert.deepEqual(moveChart(['a','b','c'],'c',0),['c','a','b']);assert.deepEqual(moveChart(['a','b','c'],'a',9),['b','c','a']);
 const port=chartsPort({lose:true}),v=await mountComponent('HomeChartCards.tsx',{controller:port.controller,role:'vendas',period:p,hidden:false,resumo:{type:'div',props:{children:'RESUMO'}}},{componentName:'HomeChartCards'});
 try{
  assert.match(v.text(),/Valores por dia.*Ticket Médio.*R\$ 5,00.*Valor Faturado.*R\$ 15,01.*Quantidade de pedidos de venda.*3.*Top 5 SKU's mais vendidos.*CAN-1 · Caneta6 un\./s);
  assert.ok(port.calls.some(c=>c.path==='/v1/sistema/top-produtos?periodo=7d'));
  v.find(n=>n.type==='button'&&n.props['aria-label']==='Ações de Ticket Médio').props.onClick();await v.flush();await v.click('Excluir gráfico');
  const post=port.calls.find(c=>c.method==='POST');assert.deepEqual(post.body.charts,['resumo','valor_faturado','quantidade_pedidos','top_skus']);
  assert.match(v.text(),/Conferir resultado/);await v.click('Conferir resultado');assert.match(v.text(),/Resultado conferido/);
  assert.equal(new Set(port.calls.filter(c=>c.method==='POST').map(c=>c.body.command_id)).size,1);assert.doesNotMatch(v.text(),/Ticket Médio/);
  v.find(n=>n.type==='button'&&n.props['aria-label']==='Incluir gráficos').props.onClick();await v.flush();
  assert.match(v.text(),/Incluir gráficosSelecione os gráficos que deseja exibir ou ocultar na home/);assert.equal(v.button('Salvar alterações').disabled,true);
  await v.change('home-chart-ticket_medio',true);await v.click('Salvar alterações');
  assert.deepEqual(port.calls.filter(c=>c.method==='POST').at(-1).body.charts,['resumo','valor_faturado','quantidade_pedidos','top_skus','ticket_medio']);
  v.find(n=>n.type==='button'&&n.props['aria-label']==='Ações de Ticket Médio').props.onClick();await v.flush();await v.click('Mover para antes');
  assert.deepEqual(port.calls.filter(c=>c.method==='POST').at(-1).body.charts,['resumo','valor_faturado','quantidade_pedidos','ticket_medio','top_skus']);
 }finally{v.unmount();}
 // Financeiro does not read products: no Top 5. Without the charts list only Valores por dia shows, with no "+".
 const fin=chartsPort({role:'financeiro',charts:['resumo','ticket_medio']}),w=await mountComponent('HomeChartCards.tsx',{controller:fin.controller,role:'financeiro',period:p,hidden:true,resumo:'RESUMO'},{componentName:'HomeChartCards'});
 try{assert.ok(!fin.calls.some(c=>c.path.includes('top-produtos')));assert.match(w.text(),/R\$ ••••/);}finally{w.unmount();}
 const down=chartsPort({fail:true}),x=await mountComponent('HomeChartCards.tsx',{controller:down.controller,role:'admin',period:p,hidden:false,resumo:'RESUMO'},{componentName:'HomeChartCards'});
 try{assert.match(x.text(),/RESUMO/);assert.match(x.text(),/mostrando Valores por dia/);assert.ok(!x.nodes().some(n=>n.props?.['aria-label']==='Incluir gráficos'));}finally{x.unmount();}
});

test('PRF-253 "Atualizado em" stays on the charts when Valores por dia is hidden, and is never shown twice',async()=>{
 const p=period([{status:'open',count:1,total_cents:'100'}]),asOf='2026-10-20T12:34:00.000Z';
 const hiddenResumo=chartsPort({charts:['ticket_medio','top_skus']}),v=await mountComponent('HomeChartCards.tsx',{controller:hiddenResumo.controller,role:'vendas',period:p,hidden:false,resumo:'RESUMO',asOf},{componentName:'HomeChartCards'});
 try{assert.match(v.text(),/GráficosAtualizado em: 20\/10 às 09:34/);assert.doesNotMatch(v.text(),/RESUMO/);}finally{v.unmount();}
 const withResumo=chartsPort(),w=await mountComponent('HomeChartCards.tsx',{controller:withResumo.controller,role:'vendas',period:p,hidden:false,resumo:'RESUMO',asOf},{componentName:'HomeChartCards'});
 try{assert.match(w.text(),/RESUMO/);assert.doesNotMatch(w.text(),/Atualizado em/,'Valores por dia carries it');}finally{w.unmount();}
});

test('PRF-254 Conferir resultado: a 409 to the same command proves it was never recorded, so the list reloads instead of staying pending',async()=>{
 const p=period([{status:'open',count:1,total_cents:'100'}]);
 const port=chartsPort({drop:true}),v=await mountComponent('HomeChartCards.tsx',{controller:port.controller,role:'vendas',period:p,hidden:false,resumo:'RESUMO'},{componentName:'HomeChartCards'});
 try{
  v.find(n=>n.type==='button'&&n.props['aria-label']==='Ações de Ticket Médio').props.onClick();await v.flush();await v.click('Excluir gráfico');
  assert.match(v.text(),/Não foi possível confirmar/);assert.match(v.text(),/Conferir resultado/);
  // Another session changes the charts before the check: the retry of the same command meets the new version.
  port.otherSession(['resumo','top_skus']);const gets=port.calls.filter(c=>c.path==='/v1/sistema/graficos-inicio'&&c.method==='GET').length;
  await v.click('Conferir resultado');
  assert.equal(new Set(port.calls.filter(c=>c.method==='POST').map(c=>c.body.command_id)).size,1);
  assert.doesNotMatch(v.text(),/Conferir resultado/);assert.match(v.text(),/alterados em outra sessão/);
  assert.equal(port.calls.filter(c=>c.path==='/v1/sistema/graficos-inicio'&&c.method==='GET').length,gets+1);
  assert.doesNotMatch(v.text(),/Ticket Médio/);assert.match(v.text(),/Top 5 SKU's mais vendidos/);
 }finally{v.unmount();}
});

test('PRF-251 a favorite shows its Nome only while the menu of the session opens its screen',()=>{
 const options=[{to:'/estoque-empresa',label:'Controle de estoque',group:'Suprimentos'}],labels={'/estoque-empresa?deposito=principal':'Depósito principal','/relatorios-estoque':'Relatórios'};
 assert.equal(homeFavoriteLabel('/estoque-empresa?deposito=principal',labels,options),'Depósito principal');
 assert.equal(homeFavoriteLabel('/estoque-empresa?deposito=outro',labels,options),'Controle de estoque (filtrado)');
 assert.equal(homeFavoriteLabel('/estoque-empresa',labels,options),'Controle de estoque');
 assert.equal(homeFavoriteLabel('/relatorios-estoque',labels,options),null,'named, but the menu does not open the screen');
});

test('PRF-251 Adicionar atalho with Nome and Link: a screen with filters needs a name, the name goes with the command',async()=>{
 const calls=[];let state={version:0,shortcuts:['/estoque-empresa'],labels:{}};const role='vendas',available=Object.keys(HOME_SHORTCUTS).filter(p=>HOME_SHORTCUTS[p].includes(role));
 const controller={async home(path,options={}){calls.push({path,...options});if(options.method==='POST'){state={version:state.version+1,shortcuts:[...options.body.shortcuts],labels:{...(options.body.labels??{})}};
  return{scope:'home_shortcuts',data_mode:'erp_native',role,customized:true,...state,available,replayed:false};}return{scope:'home_shortcuts',data_mode:'erp_native',role,customized:state.version>0,...state,available};}};
 const v=await mountComponent('HomeFavorites.tsx',{controller,access:{role,resources:['contacts','products','sales_orders','sales_proposals']}},{componentName:'HomeFavorites'});
 try{
  v.find(n=>n.type==='button'&&n.props['aria-label']==='Adicionar atalho').props.onClick();await v.flush();
  const name=v.nodes().find(n=>n.type==='input'&&n.props.placeholder==='Digite o nome do atalho'),link=v.nodes().find(n=>n.type==='input'&&n.props.placeholder==='URL do destino');assert.ok(name&&link);
  link.props.onChange({target:{value:' /documentos-empresa?tipo=sales_orders&situacao=open '}});await v.flush();
  assert.match(v.text(),/Dê um nome ao atalho com filtros/);assert.equal(v.button('Adicionar').disabled,true);
  v.nodes().find(n=>n.type==='input'&&n.props.placeholder==='Digite o nome do atalho').props.onChange({target:{value:'Vendas em aberto'}});await v.flush();
  assert.equal(v.button('Adicionar').disabled,false);await v.click('Adicionar');
  const post=calls.find(c=>c.method==='POST');assert.deepEqual(post.body,{command_id:post.body.command_id,expected_version:0,shortcuts:['/estoque-empresa','/documentos-empresa?tipo=sales_orders&situacao=open'],labels:{'/documentos-empresa?tipo=sales_orders&situacao=open':'Vendas em aberto'}});
  assert.match(v.text(),/Vendas em aberto/);
  // A screen the role does not open is refused before any command; removing the named favorite drops its name.
  v.find(n=>n.type==='button'&&n.props['aria-label']==='Adicionar atalho').props.onClick();await v.flush();
  v.nodes().find(n=>n.type==='input'&&n.props.placeholder==='URL do destino').props.onChange({target:{value:'/financeiro-empresa?area=payable'}});await v.flush();
  assert.match(v.text(),/Informe uma tela do FAGOO que o seu perfil abre/);assert.equal(v.button('Adicionar').disabled,true);await v.click('Cancelar');
  v.find(n=>n.type==='button'&&n.props['aria-label']==='Remover atalho Vendas em aberto').props.onClick();await v.flush();
  assert.deepEqual(calls.filter(c=>c.method==='POST').at(-1).body,{command_id:calls.filter(c=>c.method==='POST').at(-1).body.command_id,expected_version:1,shortcuts:['/estoque-empresa']});
 }finally{v.unmount();}
});

test('PRF-291 Dados do sócio(s) for the administrador: table editor, Salvar | Cancelar, invalid CPF refused before sending, Conferir resultado',async()=>{
 const calls=[];let record=null,lose=true;
 const controller={async system(path,options={}){calls.push({path,...options});if(options.method!=='POST')return{scope:'company_partners',data_mode:'erp_native',record};
  const b=options.body;record={version:(record?.version??0)+1,partners:b.partners,updated_at:'2026-10-20T12:00:00.000000+00:00'};
  const out={scope:'company_partners_command',data_mode:'erp_native',receipt:{command_id:b.command_id,from_version:b.expected_version,to_version:b.expected_version+1,changed_at:'2026-10-20T12:00:00.000000+00:00'},record,replayed:!lose&&calls.filter(c=>c.method==='POST').length>1};
  if(lose){lose=false;throw new AccessError(503);}return out;}};
 const v=await mountComponent('CompanyPartners.tsx',{controller},{componentName:'CompanyPartners'});
 try{
  assert.match(v.text(),/Dados do sócio\(s\).*Nenhum sócio informado/s);await v.click('Adicionar sócio');
  await v.change('company-partner-name-0','Ana Sintética');await v.change('company-partner-cpf-0','12345678900');await v.change('company-partner-share-0','50');
  await v.submit(0);assert.match(v.text(),/CPF válido/);assert.equal(calls.filter(c=>c.method==='POST').length,0);
  await v.change('company-partner-cpf-0','529.982.247-25');await v.submit(0);
  const post=calls.find(c=>c.method==='POST');assert.deepEqual(post.body.partners,[{name:'Ana Sintética',cpf:'52998224725',share:'50.00',role:null,email:null,phone:null}]);
  assert.match(v.text(),/Conferir resultado/);await v.click('Conferir resultado');assert.match(v.text(),/Dados conferidos|Dados dos sócios salvos/);
  assert.equal(new Set(calls.filter(c=>c.method==='POST').map(c=>c.body.command_id)).size,1);assert.equal(v.button('Cancelar').disabled,true);
 }finally{v.unmount();}
});

test('PRF-293 correcting Nome, Nome Fantasia or CNPJ asks for the reason, which goes with the identity command',async()=>{
 const c=company(),v=await mountComponent('CompanySettings.tsx',{controller:c.port},{location:'/empresa-configuracoes'});
 try{
  await v.click('Corrigir dados bloqueados');assert.doesNotMatch(v.text(),/Motivo da correção/);
  await v.change('company-legal_name','Empresa Corrigida Ltda');assert.match(v.text(),/Motivo da correção \*/);
  await v.submit(0);assert.match(v.text(),/Informe o motivo da correção/);assert.equal(c.calls.filter(x=>x.method==='POST').length,0);
  await v.change('company-locked-reason','Contrato social de 2026');await v.submit(0);
  const post=c.calls.find(x=>x.method==='POST');assert.equal(post.body.reason,'Contrato social de 2026');assert.equal(post.body.data.legal_name,'Empresa Corrigida Ltda');
 }finally{v.unmount();}
 const d=company(),w=await mountComponent('CompanySettings.tsx',{controller:d.port},{location:'/empresa-configuracoes'});
 try{await w.change('company-number','9');await w.submit(0);assert.equal('reason' in d.calls.find(x=>x.method==='POST').body,false);}finally{w.unmount();}
});
