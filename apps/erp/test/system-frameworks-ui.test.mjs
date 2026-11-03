import test from'node:test';import assert from'node:assert/strict';import{readFile}from'node:fs/promises';
import{mountComponent}from'./helpers/component-recovery-harness.mjs';
import{createFrameworksFixture}from'../src/qa/frameworks-fixture.ts';
import{toggleAction,openDestinations}from'../src/lib/frameworks-model.ts';
import{captureSystemPortRequest}from'../src/lib/system-request.ts';
import{parsePreferencesPath}from'../src/lib/preferences-route.ts';
import{COMPANY_PREFERENCES}from'../src/lib/origin-menu.ts';

// Gerenciador de transições (migration 148); the grupos de tags/tags of 148 were retired by migration 185. Synthetic data only.
let previous;test.before(()=>{previous=globalThis.document;globalThis.document={activeElement:null,addEventListener(){},removeEventListener(){},querySelector:()=>null,body:{append(){}}};});
test.after(()=>{globalThis.document=previous;});
const textOf=n=>Array.isArray(n)?n.map(textOf).join(''):n&&typeof n==='object'?textOf(n.props?.children):n===null||n===undefined||typeof n==='boolean'?'':String(n);
const situations=f=>mountComponent('RealSituations.tsx',{controller:f.controller},{expandChildren:['Badge','SituationGraph','Modal','OriginListHeader']});
const toggle=(v,name)=>v.find(n=>n.type==='button'&&n.props.className==='situation-toggle'&&textOf(n).includes(name));
const posts=f=>f.calls.filter(c=>c.method==='POST');

test('148 Gerenciador de transições: tabs, accordion by origin, Criar nova situação with Conferir resultado, transitions and Excluir selecionados',async()=>{
 const f=createFrameworksFixture({lostAck:true}),v=await situations(f);try{
  for(const label of['Gerenciador de transições','Pedidos de Venda','Pedidos de Compra','Ordem de Serviço','Ordens de Produção','Criar nova situação','Estado de origem: Em digitação','Estado de origem: Verificado'])assert.ok(v.text().includes(label),label);
  assert.match(v.text(),/ainda seguem as situações padrão/);assert.equal(v.find(n=>n.props.role==='tab'&&textOf(n)==='Ordens de Produção').disabled,true);
  // Criar nova situação: Baseada em, Nome, Cor; the lost answer keeps the same command for Conferir resultado.
  await v.click('Criar nova situação');assert.match(v.text(),/Criar nova situação.*Baseada em/s);
  await v.change('situation-base','open');await v.change('situation-name','Aguardando pagamento');await v.change('situation-color','#FF8800');await v.click('Salvar');
  assert.match(v.text(),/Conferir resultado/);assert.equal(posts(f).length,1);assert.deepEqual(posts(f)[0].body.data,{base_status:'open',name:'Aguardando pagamento',color:'#ff8800',active:true});
  await v.click('Conferir resultado');assert.equal(posts(f).length,2);assert.deepEqual(posts(f)[1].body,posts(f)[0].body);assert.match(v.text(),/Situação criada \(comando já registrado\)\./);
  assert.match(v.text(),/Estado de origem: Aguardando pagamentoBaseada em Em aberto/);
  // Em aberto: default transitions cannot be selected; the new destination is offered; actions wait for the adoption.
  toggle(v,'Em aberto').props.onClick();await v.flush();
  const defaults=v.nodes().filter(n=>n.type==='input'&&String(n.props['aria-label']).startsWith('Selecionar transição para'));assert.ok(defaults.length>=5&&defaults.every(n=>n.disabled));
  assert.equal(v.button('Excluir selecionados').disabled,true);
  await v.click('Criar nova transição');assert.match(v.text(),/Criar transição.*Origem.*Em aberto.*Destino/s);
  assert.equal(v.input('transition-to').props.value,f.custom.sales_orders[0].key);assert.equal(v.input('transition-post_stock').disabled,true);assert.match(v.text(),/Disponível quando os pedidos passarem/);
  await v.click('Salvar');const created=posts(f).at(-1);assert.equal(created.path,'/v1/sistema/transicoes');assert.deepEqual(created.body.data,{active:true,actions:[]});assert.equal(created.body.expected_version,0);
  assert.match(v.text(),/Transição salva\./);
  // A default transition is only deactivated (Status da transição); a custom one is selected and deleted by version.
  v.find(n=>n.props['aria-label']==='Editar transição para Cancelado').props.onClick();await v.flush();
  assert.equal(v.input('transition-to').disabled,true);await v.change('transition-active','inativa');await v.click('Salvar');
  assert.deepEqual([posts(f).at(-1).body.to,posts(f).at(-1).body.data.active],['cancelled',false]);assert.match(v.text(),/Cancelado padrãoNenhuma açãoInativa/);
  const custom=v.find(n=>n.type==='input'&&n.props['aria-label']==='Selecionar transição para Aguardando pagamento');assert.equal(custom.disabled,false);custom.props.onChange({target:{checked:true}});await v.flush();
  await v.click('Excluir selecionados');assert.match(v.text(),/Excluir 1 transição\(ões\)/);await v.click('Excluir');
  const removed=posts(f).at(-1);assert.equal(removed.path,'/v1/sistema/transicoes/exclusao');assert.deepEqual(removed.body.items.map(i=>i.to),[f.custom.sales_orders[0].key]);assert.ok(removed.body.items[0].expected_version>0);
  assert.match(v.text(),/1 transição\(ões\) excluída\(s\)\./);
  // Graph: radial SVG with every destination of the origin.
  v.find(n=>n.props['aria-label']==='Visualizar gráfico de transições de Em aberto').props.onClick();await v.flush();
  assert.ok(v.nodes().some(n=>n.type==='svg'&&/Transições a partir de Em aberto: 6 destino\(s\)/.test(n.props['aria-label'])));await v.click('Fechar');
  // The tab follows the kind; a role change hides the screen.
  v.find(n=>n.props.role==='tab'&&textOf(n)==='Pedidos de Compra').props.onClick();await v.flush();assert.ok(f.calls.some(c=>c.path==='/v1/sistema/situacoes?tipo=purchase_orders'));
  assert.doesNotMatch(v.text(),/Aguardando pagamento/);
  f.setAccess({role:'vendas'});await v.flush();assert.match(v.text(),/Gerenciador de transições não liberado/);
 }finally{v.unmount();}
});

test('148 adopted kind: the actions are offered, opposite actions exclude each other and the body keeps the SQL order',async()=>{
 const f=createFrameworksFixture({adopted:true}),v=await situations(f);try{
  assert.doesNotMatch(v.text(),/ainda seguem as situações padrão/);
  toggle(v,'Em andamento').props.onClick();await v.flush();v.find(n=>n.props['aria-label']==='Editar transição para Atendido').props.onClick();await v.flush();
  await v.change('transition-reverse_stock',true);await v.change('transition-post_stock',true);await v.change('transition-post_finance',true);
  assert.equal(v.input('transition-reverse_stock').props.checked,false);await v.click('Salvar');
  assert.deepEqual(posts(f).at(-1).body.data.actions,['post_finance','post_stock']);assert.match(v.text(),/Atendido padrãoLançar contas · Lançar estoqueAtiva/);
 }finally{v.unmount();}
 assert.deepEqual(toggleAction(['post_stock'],'reverse_stock',true),['reverse_stock']);assert.deepEqual(toggleAction(['post_finance','post_stock'],'post_stock',false),['post_finance']);
 const page={situations:[{key:'open',base_status:'open'},{key:'cancelled',base_status:'cancelled'},{key:'x',base_status:'open'}],rules:{open:['cancelled'],cancelled:[]},transitions:[{from:'open',to:'cancelled'}]};
 assert.deepEqual(openDestinations(page,'open').map(s=>s.key),['x']);assert.deepEqual(openDestinations(page,'cancelled').map(s=>s.key),[]);
 for(const bad of['/v1/sistema/situacoes?tipo=x','/v1/sistema/tags','/v1/sistema/tags/grupos','/v1/sistema/tags?grupo=1','/v1/sistema/tags/grupos?grupo=40000000-0000-4000-8000-000000000001'])assert.throws(()=>captureSystemPortRequest(bad,{}),bad);
 for(const bad of['/v1/sistema/tags','/v1/sistema/tags/grupos','/v1/sistema/tags/exclusao','/v1/sistema/tags/grupos/exclusao'])assert.throws(()=>captureSystemPortRequest(bad,{method:'POST',body:{command_id:'40000000-0000-4000-8000-000000000001',items:[]}}),bad);
 assert.throws(()=>captureSystemPortRequest('/v1/sistema/constructor',{method:'POST',body:{}}));
});

test('185 Suprimentos > Gerenciar grupos de tags and Gerenciar tags open the product tag screens; the old addresses redirect there',async()=>{
 assert.deepEqual(parsePreferencesPath('/preferencias/sistema/gerenciador-transicoes'),{kind:'screen',screen:'gerenciador-transicoes'});
 assert.deepEqual(parsePreferencesPath('/preferencias/suprimentos/grupos-tags'),{kind:'supply',screen:'grupos-tags'});
 assert.deepEqual(parsePreferencesPath('/preferencias/suprimentos/tags'),{kind:'supply',screen:'tags'});
 // CompanyPreferences answers both addresses with a redirect (no screen of its own any more).
 const source=await readFile(new URL('../src/components/CompanyPreferences.tsx',import.meta.url),'utf8');
 assert.match(source,/route\.kind==='supply'\)return <Navigate to=\{route\.screen==='grupos-tags'\?'\/grupos-tags':'\/tags'\} replace\/>/);assert.doesNotMatch(source,/RealTags/);
 // The menu opens the product tag screens (migration 119), whose tags are linked to products; the old addresses redirect there.
 const entries=COMPANY_PREFERENCES.flatMap(c=>c.sections.flatMap(s=>s.entries));
 for(const [label,to] of[['Gerenciador de transições','/preferencias/sistema/gerenciador-transicoes'],['Gerenciar grupos de tags','/grupos-tags'],['Gerenciar tags','/tags']])
  assert.equal(entries.find(e=>e.label===label).to,to,label);
});
