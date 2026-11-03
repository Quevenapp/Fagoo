import test from'node:test';import assert from'node:assert/strict';import{readFile}from'node:fs/promises';
import{mountComponent,AccessError}from'./helpers/component-recovery-harness.mjs';
import{createPreferencesFixture,PREFERENCES_QA_OTHER}from'../src/qa/preferences-fixture.ts';
import{preferencePage,PREFERENCE_PAGES}from'../../../packages/erp-domain/src/preferences/catalog.mjs';
import{COMPANY_PREFERENCES,resolvePreferences}from'../src/lib/origin-menu.ts';
import{parsePreferencesPath,preferencesResetKey}from'../src/lib/preferences-route.ts';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
let previous;test.before(()=>{previous=globalThis.document;globalThis.document={activeElement:null,documentElement:{dataset:{}},addEventListener(){},removeEventListener(){}};});test.after(()=>{globalThis.document=previous;});
const mount=(f,id,section)=>{const page=preferencePage(id);const category=COMPANY_PREFERENCES.find(c=>c.id===page.category);
 return mountComponent('PreferenceSettingsPage.tsx',{controller:f.controller,page,section,categoryLabel:category.label,categoryTo:`/preferencias/${category.id}`},{expandChildren:true,location:`/preferencias/${page.category}/${page.path}`});};
const posts=f=>f.calls.filter(c=>c.method==='POST');
const reads=f=>f.calls.filter(c=>c.path.includes('/comandos/'));
const has=(v,label)=>v.nodes().some(n=>n.type==='button'&&!n.props.hidden&&v.nodes&&String(n.props.children).includes(label));

test('115 Empresa › Geral loads once, marks every stored option honestly and saves only the changed key',async()=>{const f=createPreferencesFixture(),v=await mount(f,'empresa-geral');try{
 assert.deepEqual(f.calls.map(c=>[c.method,c.path]),[['GET','/v1/preferencias/empresa-geral']]);
 const text=v.text();for(const label of['Número de casas decimais na quantidade','Número de casas decimais no preço nas entradas','Número de casas decimais no preço nas saídas','Número de casas decimais no peso do produto','Não enviar link no envio de documentos','Permite a edição da data e hora das ocorrências','Ainda não aplicada','O FAGOO guarda até 6 casas decimais'])assert.ok(text.includes(label),label);
 assert.equal(v.input('pref-empresa-decimais_quantidade').props.value,'6');assert.equal(v.button('Salvar').disabled,true);
 await v.change('pref-empresa-decimais_quantidade','4');assert.equal(v.guard().changed,true);assert.equal(v.button('Salvar').disabled,false);
 await v.click('Salvar');assert.equal(posts(f).length,1);const body=posts(f)[0].body;
 assert.deepEqual(Object.keys(body).sort(),['changes','command_id']);assert.deepEqual(body.changes,[{key:'empresa.decimais_quantidade',expected_version:0,value:4}]);
 assert.match(v.text(),/1 preferência salva/);assert.equal(v.guard().changed,false);assert.equal(v.guard().busy,false);assert.equal(f.values.get('empresa.decimais_quantidade').version,1);
 // A second change carries the version the screen read.
 await v.change('pref-empresa-editar_data_ocorrencia',true);await v.click('Salvar');assert.deepEqual(posts(f)[1].body.changes,[{key:'empresa.editar_data_ocorrencia',expected_version:0,value:true}]);
}finally{v.unmount();}});

test('115 a role that only reads sees the values, no Salvar and no way to edit; company writes stay administrador-only',async()=>{const f=createPreferencesFixture({role:'vendas'}),v=await mount(f,'empresa-geral');try{
 assert.match(v.text(),/Somente administradores alteram estas preferências/);assert.equal(v.nodes().some(n=>n.type==='button'&&v.text&&n.props.children==='Salvar'),false);
 assert.equal(v.input('pref-empresa-decimais_quantidade').disabled,true);assert.equal(posts(f).length,0);
}finally{v.unmount();}});

test('115 lost answer keeps the same command; “Conferir resultado” reads it without a second POST',async()=>{const f=createPreferencesFixture({lostAck:true}),v=await mount(f,'empresa-geral');try{
 await v.change('pref-empresa-decimais_peso','2');await v.click('Salvar');const body=posts(f)[0].body;
 assert.match(v.text(),/Não foi possível confirmar se as preferências foram salvas/);assert.match(v.text(),new RegExp(body.command_id));assert.equal(v.guard().busy,true);
 assert.equal(v.nodes().some(n=>n.type==='button'&&n.props.children==='Reenviar o mesmo comando'),false);assert.equal(v.input('pref-empresa-decimais_peso').disabled,true);
 await v.click('Conferir resultado');assert.equal(posts(f).length,1);assert.equal(reads(f).length,1);assert.equal(reads(f)[0].path.split('/').at(-1),body.command_id);
 assert.match(v.text(),/1 preferência salva \(comando já registrado\)/);assert.equal(v.guard().busy,false);assert.equal(v.input('pref-empresa-decimais_peso').props.value,'2');
}finally{v.unmount();}});

test('115 only an authoritative 404 on the command enables resending the very same body',async()=>{let sends=0;
 const f=createPreferencesFixture({before(c){if(c.method==='POST'&&++sends===1)throw new AccessError(503);if(c.path.includes('/comandos/'))throw new AccessError(404);}}),v=await mount(f,'empresa-geral');try{
 await v.change('pref-empresa-nao_enviar_link',true);await v.click('Salvar');await v.click('Conferir resultado');assert.match(v.text(),/Este comando não foi registrado/);
 const first=posts(f)[0].body;await v.click('Reenviar o mesmo comando');assert.equal(posts(f).length,2);assert.deepEqual(posts(f)[1].body,first);assert.match(v.text(),/1 preferência salva/);
}finally{v.unmount();}});

test('115 a definite refusal releases the command and keeps the edits in the form',async()=>{const f=createPreferencesFixture({before(c){if(c.method==='POST')throw new AccessError(409);}}),v=await mount(f,'empresa-geral');try{
 await v.change('pref-empresa-decimais_preco_saida','2');await v.click('Salvar');assert.match(v.text(),/As preferências mudaram desde a consulta. Nada foi salvo/);
 assert.equal(v.nodes().some(n=>n.type==='button'&&n.props.children==='Conferir resultado'),false);assert.equal(v.input('pref-empresa-decimais_preco_saida').props.value,'2');assert.equal(v.guard().busy,false);assert.equal(v.guard().changed,true);
}finally{v.unmount();}});

test('115 invalid typed values block Salvar with the reason; text is sent trimmed and canonical',async()=>{const f=createPreferencesFixture(),v=await mount(f,'suprimentos-estoque');try{
 await v.change('pref-estoque-cross_docking_dias','12a');assert.match(v.text(),/Informe um número inteiro entre 0 e 9999/);assert.equal(v.button('Salvar').disabled,true);
 await v.change('pref-estoque-cross_docking_dias','12');assert.equal(v.button('Salvar').disabled,false);await v.click('Salvar');
 assert.deepEqual(posts(f)[0].body.changes,[{key:'estoque.cross_docking_dias',expected_version:0,value:12}]);
 assert.match(v.text(),/Desativado — os lançamentos não podem deixar o saldo negativo/);assert.ok(f.calls.some(c=>c.path==='/v1/politica-estoque'));
 // The multiselect of situations appears only when "Considerar situações" is on, and keeps Origin's option order.
 assert.equal(v.nodes().some(n=>n.props.id==='pref-estoque-reserva_situacoes-verificado'),false);
 await v.change('pref-estoque-reserva_por_situacao',true);await v.change('pref-estoque-reserva_situacoes-verificado',true);await v.change('pref-estoque-reserva_situacoes-em_aberto',true);
 await v.click('Salvar');const sent=posts(f)[1].body.changes;assert.deepEqual(sent.find(c=>c.key==='estoque.reserva_situacoes').value,['em_aberto','verificado']);
 const f2=createPreferencesFixture(),w=await mount(f2,'suprimentos-compras');try{await w.change('pref-compras-observacao_padrao','  Entregar até 17h.\r\nConferir NF.  ');await w.click('Salvar');
  assert.deepEqual(posts(f2)[0].body.changes,[{key:'compras.observacao_padrao',expected_version:0,value:'Entregar até 17h.\nConferir NF.'}]);}finally{w.unmount();}
}finally{v.unmount();}});

test('115 subsections: one section at a time, address-driven navigation that never discards the unsaved edits',async()=>{const f=createPreferencesFixture(),v=await mount(f,'vendas-vendas','configuracoes');try{
 assert.match(v.text(),/Vendedor obrigatório nos pedidos de vendas/);assert.doesNotMatch(v.text(),/Ordenar itens do checkout por localização/);
 for(const title of['Configurações de vendas','Checkout de Pedidos','Lançamento de contas a receber','Envio por E-mail de Pedido de Vendas','Configuração de Impressão','Configuração de Impressão do Comprovante','Configuração de Impressão do Relatório de Produção'])assert.ok(v.text().includes(title),title);
 await v.change('pref-vendas-gerar_nfe',true);await v.click('Checkout de Pedidos');assert.equal(v.location().pathname,'/preferencias/vendas/vendas/checkout');
 await v.updateProps({section:'checkout'});assert.match(v.text(),/Ordenar itens do checkout por localização/);assert.equal(v.guard().changed,true);
 await v.click('Salvar');assert.deepEqual(posts(f)[0].body.changes.map(c=>c.key),['vendas.gerar_nfe']);
 // Users fields list the active members for the administrador and keep a sorted list.
 await v.updateProps({section:'configuracoes'});await v.change(`pref-vendas-exibir_totais_usuarios-${PREFERENCES_QA_OTHER}`,true);await v.click('Salvar');
 assert.deepEqual(posts(f)[1].body.changes,[{key:'vendas.exibir_totais_usuarios',expected_version:0,value:[PREFERENCES_QA_OTHER]}]);
}finally{v.unmount();}});

test('115 role loss hides the page and cancels reads; the same user regaining access reads again',async()=>{const hold=deferred();let first=true;
 const f=createPreferencesFixture({before(c){if(first&&c.method==='GET'&&c.path.endsWith('/notas-nfe')){first=false;return hold.promise;}}}),v=await mount(f,'notas-nfe','gerais');try{
 f.setAccess({role:'financeiro'});await v.flush();assert.match(v.text(),/Preferência não liberada/);hold.resolve(undefined);await v.flush();assert.doesNotMatch(v.text(),/Lançar estoque ao emitir/);
 f.setAccess({role:'fiscal'});await v.flush();assert.match(v.text(),/Lançar estoque ao emitir ou cancelar nota/);assert.match(v.text(),/Somente administradores alteram estas preferências/);
 assert.equal(f.calls.filter(c=>c.path==='/v1/preferencias/notas-nfe').length,2);
}finally{hold.resolve(undefined);v.unmount();}});

test('115 a late answer for a previous user never fills the page',async()=>{const hold=deferred();const f=createPreferencesFixture({before(c){if(c.method==='GET')return hold.promise;}}),v=await mount(f,'empresa-geral');try{
 f.setAccess({actor:'10000000-0000-4000-8000-000000000999'});await v.flush();
 hold.resolve({scope:'preferences_page',data_mode:'erp_native',page:'empresa-geral',owner:'company',role:'admin',can_manage:true,items:[],directory:null});await v.flush();
 assert.match(v.text(),/Preferência não liberada/);assert.equal(v.nodes().some(n=>n.props.id==='pref-empresa-decimais_quantidade'),false);
}finally{v.unmount();}});

test('115 Sistema › Interface is personal: any role saves its own theme and it is applied in this browser',async()=>{const f=createPreferencesFixture({role:'estoque'}),v=await mount(f,'sistema-interface');try{
 assert.match(v.text(),/valem somente para o seu usuário/);await v.change('pref-sistema-tema_escuro',true);await v.click('Salvar');
 assert.deepEqual(posts(f)[0].body.changes,[{key:'sistema.tema_escuro',expected_version:0,value:true}]);assert.equal(globalThis.document.documentElement.dataset.theme,'dark');
}finally{v.unmount();}});

test('115 keymaps refuse a repeated key, documents accept masked CPF/CNPJ and info entries link only allowed roles',async()=>{const f=createPreferencesFixture(),v=await mount(f,'vendas-frente-caixa','atalhos');try{
 await v.change('pref-pdv-teclas_atalho-cliente','b');assert.match(v.text(),/Cada ação precisa de uma tecla diferente/);assert.equal(v.button('Salvar').disabled,true);
 await v.change('pref-pdv-teclas_atalho-cliente','k');await v.click('Salvar');assert.equal(posts(f)[0].body.changes[0].value.cliente,'K');
 await v.click('Redefinir');await v.click('Salvar');assert.equal(posts(f)[1].body.changes[0].value.cliente,'C');
}finally{v.unmount();}
 const g=createPreferencesFixture(),w=await mount(g,'notas-nfe','preenchimento');try{
  await w.click('Adicionar outro contato');await w.change('pref-nfe-autxml_pessoas-0-document','529.982.247-25');await w.change('pref-nfe-autxml_pessoas-0-name','Contador sintético');await w.click('Salvar');
  assert.deepEqual(posts(g)[0].body.changes,[{key:'nfe.autxml_pessoas',expected_version:0,value:[{document:'52998224725',name:'Contador sintético'}]}]);
 }finally{w.unmount();}
 const h=createPreferencesFixture({role:'consulta'}),x=await mount(h,'notas-nfe','emissao');try{
  assert.match(x.text(),/2 - Homologação \(teste\)/);assert.equal(x.nodes().some(n=>n.props.to==='/conexao-sefaz'),false);
 }finally{x.unmount();}
 const k=createPreferencesFixture(),y=await mount(k,'certificado-digital');try{assert.equal(k.calls.length,0);assert.match(y.text(),/A1 - Servidor/);assert.match(y.text(),/Indisponível/);assert.ok(y.nodes().some(n=>n.props.to==='/certificado-a1'));}finally{y.unmount();}
});

test('115 hub: every page has a Origin category and an address; disabled items carry the reason; addresses are parsed strictly',async()=>{
 // Meu Negócio > Ajustes (150) and the Central de Notificações (151) are not in the hub, like Origin: they open from the dashboards
 // and from the bell (and still have their addresses).
 for(const page of PREFERENCE_PAGES){assert.equal(COMPANY_PREFERENCES.some(c=>c.id===page.category&&c.sections.some(s=>s.entries.some(e=>e.to===`/preferencias/${page.category}/${page.path}`))),!['meu-negocio','central-notificacoes','empresa-armazenamento'].includes(page.id),page.id);
  assert.equal(parsePreferencesPath(`/preferencias/${page.category}/${page.path}`).page,page);}
 assert.equal(parsePreferencesPath('/preferencias/vendas/vendas/checkout').section,'checkout');
 for(const path of['/preferencias/vendas/vendas/inexistente','/preferencias/empresa/geral/geral','/preferencias/x/y','/preferencias/A','/preferencias/vendas/vendas/checkout/extra'])assert.equal(parsePreferencesPath(path).kind,'missing',path);
 assert.equal(preferencesResetKey('/preferencias/vendas/vendas/checkout'),'/preferencias/vendas/vendas');assert.equal(preferencesResetKey('/estoque-empresa'),'/estoque-empresa');
 const app=await readFile(new URL('../src/App.tsx',import.meta.url),'utf8');assert.ok(app.includes("pathname.startsWith('/preferencias/')"));
 const v=await mountComponent('PreferencesPage.tsx',{homeTo:'/acesso',initialCategory:'sistema',categoryHref:id=>`/preferencias/${id}`,categories:resolvePreferences({role:'admin'})});try{
  assert.match(v.text(),/Configurações do sistema.*Interface.*Tabelas e configurações adicionais.*Usuários/s);
  // Campos customizados (produtos lane, migration 156) left the disabled list; another category keeps the reason check.
  assert.ok(v.nodes().some(n=>n.props.to==='/campos-customizados'));
  assert.ok(v.nodes().some(n=>n.props.to==='/preferencias/notas-fiscais'));assert.ok(v.nodes().some(n=>n.props.to==='/preferencias/sistema/interface'));
 }finally{v.unmount();}
 const b=await mountComponent('PreferencesPage.tsx',{homeTo:'/acesso',initialCategory:'backup',categoryHref:id=>`/preferencias/${id}`,categories:resolvePreferences({role:'admin'})});try{assert.match(b.text(),/Ainda não disponível no FAGOO/);}finally{b.unmount();}
 const n=await mountComponent('PreferencesPage.tsx',{homeTo:'/acesso',initialCategory:'notas-fiscais',categoryHref:id=>`/preferencias/${id}`,categories:resolvePreferences({role:'fiscal'})});try{
  assert.match(n.text(),/Antes de alterar as configurações entre em contato com o seu contador/);assert.ok(n.nodes().some(x=>x.props.to==='/preferencias/notas-fiscais/nfe'));
 }finally{n.unmount();}
});

test('115 opening Sistema › Interface never flips the theme of this browser until the user saved one',async()=>{
 globalThis.document.documentElement.dataset.theme='dark';
 const f=createPreferencesFixture(),v=await mount(f,'sistema-interface');try{assert.equal(v.input('pref-sistema-tema_escuro').props.checked,false);assert.equal(globalThis.document.documentElement.dataset.theme,'dark');}finally{v.unmount();}
 const g=createPreferencesFixture();g.set('sistema.tema_escuro',false);const w=await mount(g,'sistema-interface');try{assert.equal(globalThis.document.documentElement.dataset.theme,'light');}finally{w.unmount();}
});

test('115 a marked user who lost access can be unmarked from the users field',async()=>{
 const STALE='10000000-0000-4000-8000-000000000999',f=createPreferencesFixture();f.set('vendas.exibir_totais_usuarios',[STALE,PREFERENCES_QA_OTHER].sort());
 const v=await mount(f,'vendas-vendas','configuracoes');try{
  assert.match(v.text(),/1 usuário\(s\) marcado\(s\) não estão mais ativos/);await v.click('Desmarcar usuários inativos');
  assert.doesNotMatch(v.text(),/não estão mais ativos/);await v.click('Salvar');
  assert.deepEqual(posts(f)[0].body.changes,[{key:'vendas.exibir_totais_usuarios',expected_version:1,value:[PREFERENCES_QA_OTHER]}]);
  assert.match(v.text(),/Vendas sintético.*Vendas/s);
 }finally{v.unmount();}
});
