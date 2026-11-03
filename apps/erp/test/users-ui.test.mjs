import test from'node:test';import assert from'node:assert/strict';
import{mountComponent,AccessError}from'./helpers/component-recovery-harness.mjs';
import{createUsersFixture,USERS_QA_ADMIN}from'../src/qa/users-fixture.ts';
import{resolvePreferences}from'../src/lib/origin-menu.ts';
import{parsePreferencesPath}from'../src/lib/preferences-route.ts';
let previous;test.before(()=>{previous=globalThis.document;globalThis.document={activeElement:null,documentElement:{dataset:{}},addEventListener(){},removeEventListener(){}};});test.after(()=>{globalThis.document=previous;});
const mount=f=>mountComponent('RealUsers.tsx',{controller:f.controller},{expandChildren:true,location:'/preferencias/sistema/usuarios'});
const textOf=n=>Array.isArray(n)?n.map(textOf).join(''):n&&typeof n==='object'?textOf(n.props?.children):n===null||n===undefined||typeof n==='boolean'?'':String(n);
const VENDAS='30000000-0000-4000-8000-000000000001';
const userCalls=f=>f.calls.map(c=>[c.method,c.path]);
const row=(v,text)=>{const cell=v.nodes().find(n=>n.type==='td'&&n.props.onClick&&textOf(n).includes(text));if(!cell)throw new Error('row '+text);return cell;};
const press=async(v,label)=>{const b=v.find(n=>n.type==='button'&&n.props['aria-label']===label);if(b.disabled)throw new Error('disabled '+label);b.props.onClick();await v.flush();};

test('117 the list shows every account of the company with Origin columns, counts and the default listing',async()=>{const f=createUsersFixture(),v=await mount(f);try{
 assert.deepEqual(userCalls(f),[['GET','/v1/usuarios']]);assert.deepEqual(f.lists.calls.map(c=>c.path),['/v1/preferencias-listas/sistema.usuarios']);
 const text=v.text();for(const s of['Usuários','Incluir usuário','Administrador Sintético','vendas@sintetico.test','convidado@sintetico.test','Nome não informado','Sem acesso','Inativo','Login','Tipo','Perfil de acesso','Quantidade de usuários','Listagem customizada'])assert.ok(text.includes(s),s);
 assert.match(text,/Quantidade de usuários4/);
}finally{v.unmount();}});

test('117 editing saves the whole state against what was read; the administrador cannot change their own perfil',async()=>{const f=createUsersFixture(),v=await mount(f);try{
 row(v,'Vendas Sintético').props.onClick();await v.flush();assert.equal(v.input('user-login').props.readOnly,true);
 await v.change('user-name','Vendas Renomeado');await v.change('user-role','financeiro');assert.equal(v.guard().changed,true);await v.click('Salvar');
 const post=f.calls.find(c=>c.method==='POST');assert.equal(post.path,`/v1/usuarios/${VENDAS}`);
 assert.deepEqual({expected:post.body.expected,data:post.body.data},{expected:{role:'vendas',active:true,profile_version:1},data:{name:'Vendas Renomeado',phone:'(11) 90000-0001',role:'financeiro',active:true}});
 assert.match(v.text(),/Vendas Renomeado: alterações salvas/);assert.equal(f.calls.filter(c=>c.path==='/v1/usuarios').length,2);
 row(v,'Administrador Sintético').props.onClick();await v.flush();assert.equal(v.input('user-role').disabled,true);assert.equal(v.input('user-active').disabled,true);
 assert.match(v.text(),/Usuário vendedor \(acesso restrito\).*decisão do dono/s);assert.match(v.text(),/Tipo, horários e permissões/);
}finally{v.unmount();}});

test('117 a lost save keeps the command and "Conferir resultado" reads it without a second POST',async()=>{const f=createUsersFixture({lostAck:true}),v=await mount(f);try{
 row(v,'Vendas Sintético').props.onClick();await v.flush();await v.change('user-phone','(11) 91111-2222');await v.click('Salvar');
 assert.match(v.text(),/Não foi possível confirmar o resultado/);assert.equal(v.guard().busy,true);const id=f.calls.find(c=>c.method==='POST').body.command_id;assert.match(v.text(),new RegExp(id));
 await v.click('Conferir resultado');assert.equal(f.calls.filter(c=>c.method==='POST').length,1);assert.ok(f.calls.some(c=>c.path===`/v1/usuarios/comandos/${id}`));assert.match(v.text(),/alterações salvas/);
}finally{v.unmount();}});

test('117 invite sends one command; after a lost answer the same command completes the account created by Auth',async()=>{const f=createUsersFixture({lostAck:true}),v=await mount(f);try{
 await v.click('Incluir usuário');await v.change('invite-name','Nova Pessoa');await v.change('invite-email','  Nova.Pessoa@Sintetico.test ');await v.change('invite-role','estoque');await v.click('Salvar');
 const first=f.calls.find(c=>c.path==='/v1/usuarios/convites').body;assert.deepEqual({email:first.email,name:first.name,role:first.role},{email:'nova.pessoa@sintetico.test',name:'Nova Pessoa',role:'estoque'});
 assert.match(v.text(),/Não foi possível confirmar o convite/);await v.click('Conferir resultado');assert.match(v.text(),/A conta já foi criada pelo convite/);
 await v.click('Concluir o mesmo convite');const posts=f.calls.filter(c=>c.path==='/v1/usuarios/convites');assert.equal(posts.length,2);assert.deepEqual(posts[1].body,first);
 assert.match(v.text(),/Convite registrado para nova.pessoa@sintetico.test.*perfil Estoque/s);assert.equal(f.users.filter(u=>u.email==='nova.pessoa@sintetico.test').length,1);
}finally{v.unmount();}
 const g=createUsersFixture({before(c){if(c.path==='/v1/usuarios/convites')throw new AccessError(409);}}),w=await mount(g);try{await w.click('Incluir usuário');await w.change('invite-name','Duplicado');await w.change('invite-email','vendas@sintetico.test');await w.click('Salvar');
  assert.match(w.text(),/Já existe uma conta com este e-mail/);assert.equal(w.nodes().some(n=>n.type==='button'&&textOf(n)==='Conferir resultado'),false);
  await w.change('invite-email','sem-arroba');await w.click('Salvar');assert.match(w.text(),/Informe um e-mail válido/);assert.equal(g.calls.filter(c=>c.path==='/v1/usuarios/convites').length,1);}finally{w.unmount();}
});

test('117 "Excluir" deactivates in batch with a preview that skips the administrador itself',async()=>{const f=createUsersFixture(),v=await mount(f);try{
 for(const label of['Selecionar Vendas Sintético','Selecionar Administrador Sintético'])v.find(n=>n.props['aria-label']===label).props.onChange();await v.flush();
 await press(v,'Excluir os usuários selecionados');assert.match(v.text(),/1 registro será processado.*1 será ignorado/s);assert.match(v.text(),/Você não pode desativar o próprio usuário/);
 await v.click('Desativar acesso');const post=f.calls.find(c=>c.method==='POST');assert.equal(post.path,`/v1/usuarios/${VENDAS}`);assert.equal(post.body.data.active,false);
 assert.match(v.text(),/1 concluído · 1 ignorado/);await v.click('Fechar');assert.equal(f.users.find(u=>u.user_id===VENDAS).status,'inativo');assert.ok(f.calls.filter(c=>c.path==='/v1/usuarios').length>=2);
}finally{v.unmount();}});

test('117 search, filters and "Tornar padrão" use the shared list preferences',async()=>{const f=createUsersFixture(),v=await mount(f);try{
 v.find(n=>n.type==='input'&&n.props['aria-label']==='Pesquisar na listagem').props.onChange({target:{value:'vendas'}});await v.flush();await v.submit(0);
 assert.ok(f.calls.some(c=>c.path==='/v1/usuarios?q=vendas'));
 await press(v,'Abrir filtro');await v.change('users-status','inativo');v.find(n=>n.type==='button'&&textOf(n)==='Filtrar').props.onClick();await v.flush();
 assert.ok(f.calls.some(c=>c.path==='/v1/usuarios?q=vendas&situacao=inativo'));assert.match(v.text(),/Situação: Inativos/);
 await v.click('Tornar padrão');assert.deepEqual(f.lists.calls.find(c=>c.method==='POST').body.filters,{q:'vendas',situacao:'inativo'});
}finally{v.unmount();}});

test('117 only an active administrador sees the screen; other roles send no request and the hub lists it for admin only',async()=>{
 for(const role of['consulta','vendas','financeiro','estoque','fiscal']){const f=createUsersFixture({role}),v=await mount(f);try{assert.match(v.text(),/Usuários não liberados/);assert.equal(f.calls.length,0);}finally{v.unmount();}
  assert.equal(resolvePreferences({role}).some(c=>c.entries.some(e=>e.to==='/preferencias/sistema/usuarios')),false,role);}
 assert.ok(resolvePreferences({role:'admin'}).some(c=>c.entries.some(e=>e.to==='/preferencias/sistema/usuarios')));
 assert.deepEqual(parsePreferencesPath('/preferencias/sistema/usuarios'),{kind:'screen',screen:'usuarios'});
 const f=createUsersFixture(),v=await mount(f);try{f.setAccess({role:'consulta'});await v.flush();assert.match(v.text(),/Usuários não liberados/);f.setAccess({role:'admin'});await v.flush();assert.match(v.text(),/Administrador Sintético/);}finally{v.unmount();}
 const g=createUsersFixture({before(c){if(c.method==='POST')throw new AccessError(403);}}),w=await mount(g);try{row(w,'Vendas Sintético').props.onClick();await w.flush();await w.change('user-name','X');await w.click('Salvar');assert.match(w.text(),/Nada foi salvo/);}finally{w.unmount();}
 void USERS_QA_ADMIN;
});

test('117 Auth refusing the invite is a definitive message, also when the same command is resumed',async()=>{
 const g=createUsersFixture({before(c){if(c.path==='/v1/usuarios/convites')throw new AccessError(422);}}),w=await mount(g);try{
  await w.click('Incluir usuário');await w.change('invite-name','Sem SMTP');await w.change('invite-email','sem.smtp@sintetico.test');await w.click('Salvar');
  assert.match(w.text(),/O serviço de autenticação desta instalação recusou o convite.*Nenhuma conta foi criada/s);assert.equal(w.nodes().some(n=>n.type==='button'&&textOf(n)==='Conferir resultado'),false);assert.equal(w.guard().busy,false);
 }finally{w.unmount();}
 let posts=0;const f=createUsersFixture({inviteCreates:false,before(c){if(c.path==='/v1/usuarios/convites'&&++posts===2)throw new AccessError(422);}}),v=await mount(f);try{
  await v.click('Incluir usuário');await v.change('invite-name','Sem SMTP');await v.change('invite-email','sem.smtp@sintetico.test');await v.click('Salvar');
  assert.match(v.text(),/Não foi possível confirmar o convite/);await v.click('Conferir resultado');assert.match(v.text(),/O convite ainda não foi concluído/);
  await v.click('Concluir o mesmo convite');assert.equal(posts,2);assert.match(v.text(),/O serviço de autenticação desta instalação recusou o convite/);
  assert.equal(v.nodes().some(n=>n.type==='button'&&textOf(n)==='Conferir resultado'),false);assert.equal(v.guard().busy,false);
 }finally{v.unmount();}
});
