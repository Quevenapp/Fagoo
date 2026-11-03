import test from'node:test';import assert from'node:assert/strict';
import{mountComponent}from'./helpers/component-recovery-harness.mjs';
import{createSystemFixture,SYSTEM_QA_ACTOR}from'../src/qa/system-fixture.ts';
import{createUsersFixture}from'../src/qa/users-fixture.ts';
import{notificationDate,notificationContent,bytesText}from'../src/lib/system-model.ts';
import{captureSystemPortRequest}from'../src/lib/system-request.ts';

// Top bar, notifications, Empresa and Usuários security (migration 151). Synthetic data only.
let previous,previousWindow;test.before(()=>{previous=globalThis.document;previousWindow=globalThis.window;globalThis.window={addEventListener(){},removeEventListener(){}};
 globalThis.document={activeElement:null,documentElement:{dataset:{}},addEventListener(){},removeEventListener(){},querySelector:()=>null,body:{append(){},classList:{add(){},remove(){}}}};});
test.after(()=>{globalThis.document=previous;globalThis.window=previousWindow;});
const textOf=n=>Array.isArray(n)?n.map(textOf).join(''):n&&typeof n==='object'?textOf(n.props?.children):n===null||n===undefined||typeof n==='boolean'?'':String(n);
const NAV_MODULES={'../lib/real-access':"export const ROLE_LABELS={admin:'Administrador',consulta:'Consulta',vendas:'Vendas',financeiro:'Financeiro',estoque:'Estoque',fiscal:'Fiscal'};export class AccessError extends Error{constructor(s){super('x');this.status=s;}}"};
const nav=(f,withController=true)=>mountComponent('CompanyNavigation.tsx',{state:f.controller.getSnapshot(),onLogout(){},...(withController?{controller:f.controller}:{})},{location:'/acesso',expandChildren:['OriginTopBar'],modules:NAV_MODULES});
const company=()=>{const calls=[];return{calls,port:{async company(path,options={}){calls.push({path,...options});
 if(path==='/v1/empresa')return{read_identity:true,write_identity:true,read_fiscal:false,write_fiscal:false,data_mode:'erp_native',emission_enabled:false};
 return{section:'identity',record:{version:1,data:{legal_name:'Empresa Sintética Ltda',trade_name:'Sintética',cnpj:'11222333000181',ie:null,postal_code:'01001000',street:'Rua Sintética',number:'1',complement:null,district:'Centro',city:'São Paulo',municipality_code:'3550308',state:'SP',phone:null,email:null},created_at:'2026-10-20T12:00:00Z',updated_at:'2026-10-20T12:00:00Z'},data_mode:'erp_native',emission_enabled:false};}}};};

test('151 top bar: name, Meu Perfil, razão social, Armazenamento and the unread badge; the saved theme is applied at login',async()=>{
 const f=createSystemFixture({theme:true}),v=await nav(f);try{
  const user=v.find(n=>n.type==='button'&&n.props.className==='origin-user-button');assert.equal(user.props.title,'Meu Perfil');assert.match(textOf(user),/Ana Sintética/);
  const bell=v.find(n=>n.type==='button'&&String(n.props['aria-label']).startsWith('Notificações'));assert.equal(bell.props['aria-label'],'Notificações: 1 não lidas');
  assert.equal(globalThis.document.documentElement.dataset.theme,'dark');assert.ok(f.calls.some(c=>c.path==='/v1/preferencias/sistema-interface'));
  user.props.onClick();await v.flush();assert.match(v.text(),/Empresa Sintética Ltda/);assert.ok(v.nodes().some(n=>n.props.to==='/empresa-configuracoes'&&textOf(n).includes('Empresa Sintética Ltda')));
  assert.ok(v.nodes().some(n=>n.props.to==='/empresa-configuracoes?secao=armazenamento'&&textOf(n).includes('Armazenamento 3,0 MB')));
 }finally{v.unmount();}
 // Without a saved value nothing changes the browser theme; without the Sistema port the bar keeps the role name.
 globalThis.document.documentElement.dataset.theme='light';const g=createSystemFixture({theme:null}),w=await nav(g);
 try{assert.equal(globalThis.document.documentElement.dataset.theme,'light');}finally{w.unmount();}
 const h=createSystemFixture(),x=await nav(h,false);
 try{assert.match(textOf(x.find(n=>n.type==='button'&&n.props.className==='origin-user-button')),/Administrador/);assert.equal(h.calls.length,0);}finally{x.unmount();}
});

test('151 notifications popover: Não lidas (N) and Todas, an expanded item is marked read, ⋮ Marcar todas como lida and an uncertain answer kept for Conferir resultado',async()=>{
 const f=createSystemFixture({lostAck:true}),v=await mountComponent('CompanyChrome.tsx',{controller:f.controller,actor:SYSTEM_QA_ACTOR,onUnread(){},onNavigate(){}},{componentName:'NotificationsPanel'});try{
  assert.match(v.text(),/Não lidas \(1\)Todas/);assert.match(v.text(),new RegExp(`Contas a receber atrasadas${notificationDate('2026-10-20T12:00:00.000000+00:00')}`));
  v.find(n=>n.type==='button'&&n.props.className==='origin-notification-item').props.onClick();await v.flush();
  const post=f.calls.find(c=>c.method==='POST');assert.deepEqual(post.body.ids,['2']);assert.match(v.text(),/Conferir resultado/);
  await v.click('Conferir resultado');assert.equal(f.calls.filter(c=>c.method==='POST').length,2);assert.deepEqual(f.calls.filter(c=>c.method==='POST').map(c=>c.body.command_id).filter((x,i,a)=>a.indexOf(x)===i).length,1);
  assert.match(v.text(),/Não lidas \(0\)/);
  v.find(n=>n.type==='button'&&n.props.role==='tab'&&textOf(n)==='Todas').props.onClick();await v.flush();assert.match(v.text(),/Estoque disponível abaixo do mínimo/);
  v.find(n=>n.props['aria-label']==='Mais ações').props.onClick();await v.flush();assert.ok(v.nodes().some(n=>n.props.to==='/preferencias/sistema/central-notificacoes'));
  assert.equal(v.button('Marcar todas como lida').disabled,true);
 }finally{v.unmount();}
 const c=notificationContent({id:'1',type:'contas_receber_atrasadas',day:'2026-10-20',quantity:3,amount:'1500.50',created_at:'2026-10-20T12:00:00Z',read:false});
 assert.equal(c.text,'3 contas a receber vencidas e em aberto — R$ 1.500,50.');assert.equal(c.to,'/financeiro-empresa?area=receivable');
 assert.equal(bytesText('3145728'),'3,0 MB');assert.equal(bytesText('512'),'512 B');assert.equal(notificationDate('2026-10-20T12:05:00Z'),'20 de outubro - 09:05');
 for(const bad of['/v1/sistema/perfil?x=1','/v1/sistema/notificacoes?aba=x','/v1/sistema/usuarios/x/seguranca'])assert.throws(()=>captureSystemPortRequest(bad,{}),bad);
});

test('151 Empresa: Minha conta menu, locked Nome/Fantasia/CNPJ, complementary data saved by its own command and Espaço e armazenamento',async()=>{
 const f=createSystemFixture({lostAck:true}),c=company(),controller={...c.port,...f.controller},v=await mountComponent('CompanySettings.tsx',{controller},{location:'/empresa-configuracoes',expandChildren:true});try{
  for(const label of['Minha conta','Dados da empresa','Dados do sócio(s)','Alterar senha','Controle de horários','Gerenciamento','Espaço e armazenamento','Dados complementares da empresa','Tipo da Pessoa','Inscrição Estadual: Isento',
   'Inscrição Municipal','Inscrição Suframa','CNAE','Tamanho da empresa','Seu segmento *','Faturamento do último ano','Quantidade de funcionários','Pessoas de contato','Celular','E-mail de Cobrança','Site',
   'Inscrições Estaduais dos substitutos tributários','Sua marca','(*) Campos obrigatórios'])assert.ok(v.text().includes(label),label);
  assert.equal(v.input('company-legal_name').disabled,true);assert.equal(v.input('company-cnpj').disabled,true);assert.equal(v.input('company-street').disabled,false);
  await v.change('company-extra-segment-comercio',true);await v.change('company-extra-cnae','4751201');await v.click('Adicionar inscrição');await v.change('company-extra-ie-uf-0','RJ');await v.change('company-extra-ie-0','12345678');
  const form=v.nodes().filter(n=>n.type==='form').length-1;await v.submit(form);
  const post=f.calls.find(x=>x.method==='POST');assert.equal(post.body.data.cnae,'4751-2/01');assert.deepEqual(post.body.data.substitute_ies,[{uf:'RJ',ie:'12345678'}]);assert.equal(post.body.expected_version,0);
  assert.match(v.text(),/Conferir resultado/);await v.click('Conferir resultado');assert.match(v.text(),/Dados conferidos: a alteração já estava salva/);
  const posts=f.calls.filter(x=>x.method==='POST');assert.equal(posts.length,2);assert.deepEqual(posts[0].body,posts[1].body);
  await v.click('Espaço e armazenamento');assert.match(v.text(),/Armazenamento usado: 3,0 MB em 3 arquivo\(s\)/);assert.match(v.text(),/Anexos dos documentos11,0 MB/);
 }finally{v.unmount();}
 const g=createSystemFixture({role:'vendas'}),d=company(),w=await mountComponent('CompanySettings.tsx',{controller:{...d.port,...g.controller}},{location:'/empresa-configuracoes',expandChildren:true});
 try{assert.match(w.text(),/Somente administradores alteram os dados da empresa/);assert.equal(w.nodes().find(n=>n.type==='fieldset'&&n.props.className==='company-extra-fields').props.disabled,true);}finally{w.unmount();}
});

test('151 Usuários ⋮: Dispositivos utilizados and Segurança do usuário read the Auth sessions, administrador only',async()=>{
 const u=createUsersFixture(),s=createSystemFixture(),controller={...u.controller,system:s.controller.system},v=await mountComponent('RealUsers.tsx',{controller},{expandChildren:['RowMenu','UserSecurityModal','Modal']});try{
  const row=v.find(n=>n.type==='button'&&n.props['aria-label']==='Ações de Vendas Sintético');row.props.onClick({stopPropagation(){},currentTarget:{getBoundingClientRect:()=>({top:0,left:0})}});await v.flush();
  v.find(n=>n.type==='button'&&textOf(n).includes('Dispositivos utilizados')).props.onClick();await v.flush();
  assert.match(v.text(),/Dispositivos utilizados · Vendas Sintético/);assert.match(v.text(),/Último acessoIpDispositivo.*203\.0\.113\.7Mozilla\/5\.0 Sintético/s);
  assert.ok(s.calls.some(c=>/\/v1\/sistema\/usuarios\/[a-f0-9-]{36}\/seguranca$/.test(c.path)));
 }finally{v.unmount();}
});

test('151 review: Conferir resultado that proves the company data command was never recorded releases the form',async()=>{
 let posts=0;const refuse=status=>{throw Object.assign(new Error('synthetic'),{status});};
 const f=createSystemFixture({before:call=>{if(call.method==='POST'){posts++;refuse(posts===1?503:409);}}}),c=company(),v=await mountComponent('CompanySettings.tsx',{controller:{...c.port,...f.controller}},{location:'/empresa-configuracoes',expandChildren:true});try{
  await v.change('company-extra-segment-comercio',true);const form=v.nodes().filter(n=>n.type==='form').length-1;await v.submit(form);
  assert.match(v.text(),/Não foi possível confirmar se os dados foram salvos/);assert.equal(v.nodes().find(n=>n.type==='fieldset'&&n.props.className==='company-extra-fields').props.disabled,true);
  await v.click('Conferir resultado');
  // The same command answered 409: it was never recorded (the SQL replays first), so the screen says so and unlocks.
  assert.match(v.text(),/Os dados mudaram desde a consulta\. Nada foi salvo; recarregue para conferir\./);assert.doesNotMatch(v.text(),/Conferir resultado/);
  assert.equal(v.nodes().find(n=>n.type==='fieldset'&&n.props.className==='company-extra-fields').props.disabled,false);
  const sent=f.calls.filter(x=>x.method==='POST');assert.equal(sent.length,2);assert.deepEqual(sent[0].body,sent[1].body);
 }finally{v.unmount();}
 // A 403 to Conferir resultado proves nothing (access is checked before the replay): the command stays pending.
 posts=0;const g=createSystemFixture({before:call=>{if(call.method==='POST'){posts++;refuse(posts===1?503:403);}}}),d=company(),w=await mountComponent('CompanySettings.tsx',{controller:{...d.port,...g.controller}},{location:'/empresa-configuracoes',expandChildren:true});try{
  await w.change('company-extra-segment-comercio',true);await w.submit(w.nodes().filter(n=>n.type==='form').length-1);await w.click('Conferir resultado');assert.match(w.text(),/Conferir resultado/);
 }finally{w.unmount();}
});
