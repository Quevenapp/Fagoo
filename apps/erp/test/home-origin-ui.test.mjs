import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {STATES} from '../../../packages/erp-domain/src/index.mjs';
import {HOME_SHORTCUTS,homePeriodBuckets,homePeriodRange} from '../../../workers/erp-api/src/home.mjs';

// Synthetic data only. Exercises the real RealHome handlers without a DOM.
const uid='a0000000-0000-4000-8000-000000000001',today='2026-10-19';
const RESOURCES={admin:['contacts','products','sales_orders','purchase_orders','sales_proposals','receivables','payables','nfe','nfce'],vendas:['contacts','products','sales_orders','sales_proposals'],fiscal:['contacts','products','sales_orders','purchase_orders','nfe','nfce'],financeiro:['contacts','receivables','payables']};
const allowed=role=>Object.keys(HOME_SHORTCUTS).filter(path=>HOME_SHORTCUTS[path].includes(role));
function summary(path,role,salesCents){
 const params=new URL(path,'https://synthetic.invalid').searchParams,key=params.get('periodo');
 const [from,to]=homePeriodRange(key,today,params.get('de'),params.get('ate')),{grain,buckets}=homePeriodBuckets(from,to);
 const finance=['admin','financeiro','consulta'].includes(role),invoices=['admin','fiscal'].includes(role);
 return {data_mode:'erp_native',as_of:'2026-10-19T12:00:00Z',business_date:today,timezone:'America/Sao_Paulo',role,
  catalog:[{entity:'contacts',active:1,archived:0}],documents:[{kind:'sales_orders',count:1,statuses:[{status:'open',count:1}]}],stock:null,
  finance:finance?{titles:['receivable','payable'].map(kind=>({kind,buckets:['overdue','today','next_7_days','later'].map(bucket=>({bucket,count:0,balance_cents:'0'}))})),accounts:{active:1,archived:0,opening_pending:0,recorded_balance_cents:'0'}}:null,
  period:{key,from,to,day_count:(Date.parse(to)-Date.parse(from))/86400000+1,grain,
   points:buckets.map((bucket,index)=>({bucket,sales_cents:index===0?salesCents:'0',receivable_cents:finance?(index===0?'10000':'0'):null,payable_cents:finance?'7550':null})),
   sales:{count:1,statuses:Object.keys(STATES.sales_orders).map(status=>({status,count:status==='open'?1:0,total_cents:status==='open'?salesCents:'0'}))},
   receivable:finance?{count:1,total_cents:'10000',open_cents:'9000',fee_cents:'150'}:null,payable:finance?{count:2,total_cents:'7550',open_cents:'7500'}:null,invoices:invoices?{count:3,total_cents:'100101'}:null}};
}
function server({role='admin',summaryHook,saveHook,readHook}={}){
 const calls=[],listeners=new Set();let snapshot={phase:'ready',membership:{user_id:uid,role,resources:RESOURCES[role]}},sales='1250';
 let favorites={version:0,customized:false,shortcuts:['/documentos-empresa?tipo=sales_orders','/cadastros-reais?cadastro=products']};
 const getSnapshot=()=>snapshot,subscribe=listener=>{listeners.add(listener);return()=>listeners.delete(listener);};
 const reply=()=>({scope:'home_shortcuts',data_mode:'erp_native',role:snapshot.membership.role,...structuredClone(favorites),available:allowed(snapshot.membership.role)});
 // Leva H (PRF-252): the Notas Fiscais card reads the real new NF-es from /v1/plataforma/novas-nfes (drafts no longer count).
 const controller={getSnapshot,subscribe,async platform(path){assert.equal(path,'/v1/plataforma/novas-nfes');
  return {scope:'home_new_invoices',data_mode:'erp_native',since:'2026-10-12T12:00:00Z',seen_before:false,total:3,synced:2,received:1,as_of:'2026-10-19T12:00:00Z'};},async home(path,options={}){
  const call={path,...options};calls.push(call);
  if(path==='/v1/inicio/atalhos'){
   if(options.method!=='POST'){await readHook?.(call,calls.filter(item=>item.path==='/v1/inicio/atalhos'&&item.method===undefined).length);return reply();}
   const hooked=await saveHook?.(call,calls.filter(item=>item.method==='POST').length);if(hooked)return hooked;
   if(options.body.expected_version!==favorites.version)throw new AccessError(409);
   favorites={version:favorites.version+1,customized:true,shortcuts:[...options.body.shortcuts]};return {...reply(),replayed:false};
  }
  assert.equal(options.method,undefined);assert.equal(options.body,undefined);
  await summaryHook?.(call,calls.filter(item=>item.path.startsWith('/v1/inicio?')).length);
  return summary(path,snapshot.membership.role,sales);
 }};
 return {calls,controller,summaries:()=>calls.filter(call=>call.path.startsWith('/v1/inicio?')),saves:()=>calls.filter(call=>call.method==='POST'),
  setSales(value){sales=value;},setFavorites(value){favorites=value;},setRole(next){snapshot={phase:'ready',membership:{user_id:uid,role:next,resources:RESOURCES[next]}};listeners.forEach(listener=>listener());}};
}
const mount=(source,location='/acesso')=>mountComponent('RealHome.tsx',{controller:source.controller},{location,expandChildren:['HomeView','HomeFavorites','HomeChartCards','HomeChart','HomeNewInvoices']});
const byLabel=(view,label)=>view.find(node=>node.type==='button'&&node.props['aria-label']===label);
const press=async(view,node)=>{node.props.onClick?.({preventDefault(){}});await view.flush();};
const picker=view=>view.nodes().find(node=>typeof node.type==='function'&&node.type.name==='PeriodPicker');

test('Resumo diário opens on Hoje and shows the Origin cards with exact cents for the role',async()=>{
 const source=server(),view=await mount(source);
 try{
  assert.deepEqual(source.summaries().map(call=>call.path),['/v1/inicio?periodo=hoje']);
  const text=view.text();
  for(const label of ['Resumo diário','Pedidos de venda','Total de vendas','Novos','Em andamento','Cancelados','Contas a receber','Taxas','Líquido','Contas a pagar','Valor total a pagar','Notas Fiscais','Novas NF-es','Período: 19/10/2026'])assert.match(text,new RegExp(label),label);
  for(const value of ['R$ 12,50','R$ 100,00','R$ 1,50','R$ 98,50','R$ 75,50'])assert.ok(text.includes(value),value);
  assert.match(text,/3Novas NF-es/);assert.match(text,/2 do histórico importado/);assert.doesNotMatch(text,/R$ 1.001,01/,'FAGOO drafts are not the new NF-es');
  assert.equal(view.button('Hoje').props['aria-pressed'],true);assert.equal(view.button('30D').props['aria-pressed'],false);
  const receivable=view.nodes().find(node=>node.type==='test-router-link'&&/Contas a receber/.test(JSON.stringify(node.props.children))&&String(node.props.to).includes('from='));
  assert.equal(receivable.props.to,'/financeiro-empresa?area=receivable&from=2026-10-19&to=2026-10-19');
  assert.ok(view.nodes().some(node=>node.type==='svg'&&node.props.role==='img'));assert.match(text,/Ver dados do gráfico/);
  assert.ok(view.nodes().some(node=>node.type==='test-router-link'&&node.props.to==='/cobranca-empresa'),'fixed FAGOO link kept for finance roles');
 }finally{view.unmount();}
});
test('30D and 12M change the URL, request the matching period and abort a late older response',async()=>{
 let release;const source=server({summaryHook:(call,index)=>index===2?new Promise(resolve=>{release=resolve;}):undefined}),view=await mount(source);
 try{
  await view.click('30D');assert.equal(view.location().search,'?periodo=30d');assert.equal(source.summaries()[1].path,'/v1/inicio?periodo=30d');
  assert.match(view.text(),/Carregando resumo/);
  source.setSales('9900');await view.click('12M');assert.equal(source.summaries()[1].signal.aborted,true);assert.equal(source.summaries()[2].path,'/v1/inicio?periodo=12m');
  release();await view.flush();
  assert.equal(view.button('12M').props['aria-pressed'],true);assert.match(view.text(),/Período: 01\/11\/2025 a 19\/10\/2026/);assert.ok(view.text().includes('R$ 99,00'));assert.ok(!view.text().includes('R$ 12,50'));
  await view.click('Hoje');assert.equal(view.location().search,'');assert.equal(source.summaries().at(-1).path,'/v1/inicio?periodo=hoje');
 }finally{view.unmount();}
});
test('Customizado validates the range before requesting and keeps the applied range in the URL',async()=>{
 const source=server(),view=await mount(source);
 try{
  assert.equal(picker(view),undefined);await view.click('Customizado');assert.equal(view.button('Customizado').props['aria-pressed'],true);
  const node=picker(view);assert.equal(node.props.from,today);assert.equal(node.props.to,today);
  node.props.onApply({from:'2025-01-01',to:'2026-01-02'});await view.flush();assert.match(view.text(),/até 366 dias/);assert.equal(source.summaries().length,1);
  picker(view).props.onApply({from:'',to:''});await view.flush();assert.match(view.text(),/início e o fim/);assert.equal(source.summaries().length,1);
  picker(view).props.onApply({from:'2026-10-01',to:'2026-09-01'});await view.flush();
  assert.equal(view.location().search,'?periodo=customizado&de=2026-09-01&ate=2026-10-01');assert.equal(source.summaries()[1].path,'/v1/inicio?periodo=customizado&de=2026-09-01&ate=2026-10-01');
  assert.match(view.text(),/Período: 01\/09\/2026 a 01\/10\/2026/);assert.doesNotMatch(view.text(),/até 366 dias/);
 }finally{view.unmount();}
 const invalid=server(),broken=await mount(invalid,'/acesso?periodo=semana');
 try{assert.equal(invalid.summaries().length,0);assert.match(broken.text(),/período do endereço é inválido/);await broken.click('30D');assert.equal(invalid.summaries()[0].path,'/v1/inicio?periodo=30d');}finally{broken.unmount();}
});
test('cards appear only for the data the role reads; the eye hides values and is remembered in this browser',async()=>{
 const sales=server({role:'vendas'}),seller=await mount(sales);
 try{const text=seller.text();assert.match(text,/Pedidos de venda/);assert.doesNotMatch(text,/Contas a receber|Contas a pagar|Novas NF-es|Contas em aberto|Cobrança bancária/);}finally{seller.unmount();}
 const fiscal=server({role:'fiscal'}),tax=await mount(fiscal);
 try{const text=tax.text();assert.match(text,/Novas NF-es/);assert.doesNotMatch(text,/Contas a receber|Taxas/);}finally{tax.unmount();}
 const store=new Map();globalThis.localStorage={getItem:key=>store.get(key)??null,setItem:(key,value)=>store.set(key,String(value))};
 try{
  const source=server(),view=await mount(source);
  try{await press(view,byLabel(view,'Ocultar valores'));assert.equal(store.get('brufap.erp.home-values'),'hidden');assert.ok(view.text().includes('R$ ••••'));assert.ok(!view.text().includes('R$ 12,50'));}finally{view.unmount();}
  const again=await mount(server());
  try{assert.equal(byLabel(again,'Exibir valores').props['aria-pressed'],true);assert.ok(!again.text().includes('R$ 98,50'));await press(again,byLabel(again,'Exibir valores'));assert.equal(store.get('brufap.erp.home-values'),'visible');assert.ok(again.text().includes('R$ 98,50'));}finally{again.unmount();}
 }finally{delete globalThis.localStorage;}
});
test('Atalhos favoritos add and remove through versioned commands with Origin labels',async()=>{
 const source=server(),view=await mount(source);
 try{
  let text=view.text();assert.match(text,/Atalhos favoritos/);assert.match(text,/Pedidos de venda/);assert.match(text,/Listagem de produtos/);
  await press(view,byLabel(view,'Adicionar atalho'));
  const select=view.find(node=>node.type==='select');const labels=view.nodes().filter(node=>node.type==='option').map(node=>node.props.children);
  assert.ok(labels.includes('Contas a pagar')&&labels.includes('Notas fiscais')&&!labels.includes('Pedidos de venda'));
  assert.equal(view.button('Adicionar').disabled,true);
  select.props.onChange({target:{value:'/financeiro-empresa?area=payable'}});await view.flush();
  assert.equal(source.saves().length,0,'choosing a screen (arrow keys fire change) never saves by itself');
  await view.click('Adicionar');
  const [first]=source.saves();assert.equal(first.body.expected_version,0);assert.match(first.body.command_id,/^[0-9a-f-]{36}$/);
  assert.deepEqual(first.body.shortcuts,['/documentos-empresa?tipo=sales_orders','/cadastros-reais?cadastro=products','/financeiro-empresa?area=payable']);
  text=view.text();assert.match(text,/Atalhos salvos/);assert.ok(view.nodes().some(node=>node.type==='test-router-link'&&node.props.to==='/financeiro-empresa?area=payable'));
  await press(view,byLabel(view,'Remover atalho Listagem de produtos'));
  const second=source.saves()[1];assert.equal(second.body.expected_version,1);assert.notEqual(second.body.command_id,first.body.command_id);
  assert.deepEqual(second.body.shortcuts,['/documentos-empresa?tipo=sales_orders','/financeiro-empresa?area=payable']);assert.doesNotMatch(view.text(),/Listagem de produtos/);
 }finally{view.unmount();}
 const limited=server({role:'vendas'}),seller=await mount(limited);
 try{await press(seller,byLabel(seller,'Adicionar atalho'));const labels=seller.nodes().filter(node=>node.type==='option').map(node=>node.props.children);assert.ok(!labels.includes('Contas a pagar'));assert.ok(labels.includes('Lançamentos de estoque'));}finally{seller.unmount();}
});
test('uncertain save keeps the command, guards navigation and "Conferir resultado" replays the same command',async()=>{
 const source=server({saveHook:(call,index)=>{if(index===1)throw new AccessError(503);if(index===2)return {scope:'home_shortcuts',data_mode:'erp_native',role:'admin',version:1,customized:true,shortcuts:call.body.shortcuts,available:allowed('admin'),replayed:true};}});
 const view=await mount(source);
 try{
  await press(view,byLabel(view,'Remover atalho Pedidos de venda'));
  assert.match(view.text(),/Não foi possível confirmar/);assert.deepEqual(view.guard(),{changed:true,busy:false});
  assert.equal(byLabel(view,'Adicionar atalho').disabled,true);assert.equal(byLabel(view,'Remover atalho Listagem de produtos').disabled,true);
  await view.click('Conferir resultado');const [first,second]=source.saves();
  assert.equal(second.body.command_id,first.body.command_id);assert.deepEqual(second.body,first.body);
  assert.match(view.text(),/Resultado conferido/);assert.deepEqual(view.guard(),{changed:false,busy:false});assert.doesNotMatch(view.text(),/Conferir resultado/);
  assert.equal(byLabel(view,'Adicionar atalho').disabled,false);
 }finally{view.unmount();}
});
test('a save conflict reloads the list from the server instead of overwriting another session',async()=>{
 const source=server(),view=await mount(source);
 try{
  source.setFavorites({version:5,customized:true,shortcuts:['/estoque-empresa']});
  await press(view,byLabel(view,'Remover atalho Pedidos de venda'));
  assert.match(view.text(),/alterados em outra sessão/);assert.match(view.text(),/Lançamentos de estoque/);assert.doesNotMatch(view.text(),/Listagem de produtos/);
  assert.equal(source.calls.filter(call=>call.path==='/v1/inicio/atalhos'&&call.method===undefined).length,2);
  await press(view,byLabel(view,'Remover atalho Lançamentos de estoque'));assert.equal(source.saves().at(-1).body.expected_version,5);assert.match(view.text(),/Adicione as telas que você mais usa/);
 }finally{view.unmount();}
});
test('a role change remounts the home without old values, pending saves or shortcuts of the previous role',async()=>{
 let release;const source=server({saveHook:()=>new Promise(resolve=>{release=resolve;})}),view=await mount(source);
 try{
  await press(view,byLabel(view,'Remover atalho Pedidos de venda'));assert.deepEqual(view.guard(),{changed:false,busy:true});
  const pending=source.saves()[0];source.setRole('vendas');await view.flush();
  assert.equal(pending.signal.aborted,true);release({scope:'home_shortcuts',data_mode:'erp_native',role:'admin',version:1,customized:true,shortcuts:[],available:allowed('admin'),replayed:false});await view.flush();
  const text=view.text();assert.doesNotMatch(text,/Contas a receber|Novas NF-es|Atalhos salvos/);assert.match(text,/Listagem de produtos/);
  assert.equal(source.summaries().length,2);assert.equal(source.summaries()[0].signal.aborted,true);
 }finally{view.unmount();}
});
test('the picker closes without saving and saves are blocked while the list reloads after a rejected command',async()=>{
 let release;const source=server({saveHook:(call,index)=>{if(index===1)throw new AccessError(403);},readHook:(call,index)=>index===2?new Promise(resolve=>{release=resolve;}):undefined});
 const view=await mount(source);
 try{
  await press(view,byLabel(view,'Adicionar atalho'));view.find(node=>node.type==='select').props.onChange({target:{value:'/estoque-empresa'}});await view.flush();
  await view.click('Cancelar');assert.equal(view.nodes().some(node=>node.type==='select'),false);assert.equal(source.saves().length,0);
  await press(view,byLabel(view,'Adicionar atalho'));assert.equal(view.find(node=>node.type==='select').props.value,'');
  view.find(node=>node.type==='select').props.onChange({target:{value:'/estoque-empresa'}});await view.flush();await view.click('Adicionar');
  assert.equal(source.saves().length,1);assert.match(view.text(),/Seu perfil não permite salvar este atalho/);assert.deepEqual(view.guard(),{changed:false,busy:false});
  assert.match(view.text(),/Carregando atalhos/);assert.equal(byLabel(view,'Adicionar atalho').disabled,true,'no command while the list reloads');
  release();await view.flush();
  assert.equal(byLabel(view,'Adicionar atalho').disabled,false);assert.match(view.text(),/Listagem de produtos/);assert.equal(source.saves().length,1);
 }finally{view.unmount();}
});
test('browser navigation to another period closes an open Customizado choice',async()=>{
 const source=server(),view=await mount(source,'/acesso?periodo=30d');
 try{
  await view.click('Customizado');assert.equal(view.button('Customizado').props['aria-pressed'],true);assert.ok(picker(view));
  await view.navigate('/acesso?periodo=12m');
  assert.equal(view.button('12M').props['aria-pressed'],true);assert.equal(view.button('Customizado').props['aria-pressed'],false);assert.equal(picker(view),undefined);
  assert.equal(source.summaries().at(-1).path,'/v1/inicio?periodo=12m');
 }finally{view.unmount();}
});

test('home identifies native indicators and the number of excluded Origin documents', async () => {
 const s=server(),read=s.controller.home;
 s.controller.home=async(...args)=>{const raw=await read(...args);return args[0].startsWith('/v1/inicio?')?{...raw,origin:'brufap',mirror_excluded_count:17,coverage:{partial:true,reason:'native_effects_only'}}:raw;};
 const view=await mount(s);
 try { assert.match(view.text(),/Indicadores operacionais do FAGOO; 17 documentos Origin não entram neste cálculo/); } finally { view.unmount(); }
});
