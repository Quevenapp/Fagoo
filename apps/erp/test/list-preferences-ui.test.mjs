import test from'node:test';import assert from'node:assert/strict';
import{mountComponent,AccessError}from'./helpers/component-recovery-harness.mjs';
import{createListPreferencesFixture}from'../src/qa/list-preferences-fixture.ts';
import{createAccessController}from'../src/lib/real-access.ts';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const mount=(f,props={})=>mountComponent('../../test/helpers/list-preferences-probe.tsx',{controller:f.controller,...props},{expandChildren:true});
const posts=f=>f.calls.filter(c=>c.method==='POST');
const columns=v=>v.nodes().find(n=>n.type==='p'&&n.props['data-columns']!==undefined).props['data-columns'];

test('116 a list starts with the screen defaults, saves a custom column order and restores the default',async()=>{const f=createListPreferencesFixture(),v=await mount(f);try{
 assert.equal(columns(v),'numero,cliente,total');assert.deepEqual(f.calls.map(c=>[c.method,c.path]),[['GET','/v1/preferencias-listas/documentos.sales_orders']]);
 await v.click('Listagem customizada');await v.change('list-column-cliente',false);await v.change('list-column-data',true);
 v.find(n=>n.type==='button'&&n.props['aria-label']==='Mover Data para cima').props.onClick();await v.flush();
 await v.click('Salvar');assert.deepEqual(posts(f)[0].body,{command_id:posts(f)[0].body.command_id,expected_version:0,columns:['numero','data','total'],filters:null});
 assert.equal(columns(v),'numero,data,total');assert.match(v.text(),/Listagem salva/);
 await v.click('Listagem customizada');await v.click('Restaurar listagem padrão');assert.deepEqual([posts(f)[1].body.expected_version,posts(f)[1].body.columns],[1,null]);assert.equal(columns(v),'numero,cliente,total');
}finally{v.unmount();}});

test('116 "Tornar padrão" keeps the current filters as the user default and can remove it',async()=>{const f=createListPreferencesFixture(),v=await mount(f,{currentFilters:{situacao:['open'],periodo:'30d'}});try{
 await v.click('Tornar padrão');assert.deepEqual(posts(f)[0].body.filters,{situacao:['open'],periodo:'30d'});assert.match(v.text(),/Filtro padrão: \{"situacao":\["open"\],"periodo":"30d"\}/);
 assert.equal(v.button('Tornar padrão').disabled,true);await v.click('Remover filtro padrão');assert.equal(posts(f)[1].body.filters,null);assert.match(v.text(),/Filtro padrão: nenhum/);
 const w=await mount(createListPreferencesFixture());try{assert.equal(w.button('Tornar padrão').disabled,true);}finally{w.unmount();}
}finally{v.unmount();}});

test('116 a lost answer keeps the command; "Conferir resultado" reads it and a 404 allows resending the very same body',async()=>{const f=createListPreferencesFixture({lostAck:true}),v=await mount(f,{currentFilters:{periodo:'hoje'}});try{
 await v.click('Tornar padrão');assert.match(v.text(),/Não foi possível confirmar se a listagem foi salva/);assert.equal(v.button('Tornar padrão').disabled,true);
 await v.click('Conferir resultado');assert.equal(posts(f).length,1);assert.match(v.text(),/comando já registrado/);
}finally{v.unmount();}
 let sends=0;const g=createListPreferencesFixture({before(c){if(c.method==='POST'&&++sends===1)throw new AccessError(503);if(c.path.includes('/comandos/'))throw new AccessError(404);}}),w=await mount(g,{currentFilters:{periodo:'hoje'}});try{
  await w.click('Tornar padrão');await w.click('Conferir resultado');assert.match(w.text(),/Este comando não foi registrado/);const first=posts(g)[0].body;
  await w.click('Reenviar o mesmo comando');assert.deepEqual(posts(g)[1].body,first);assert.match(w.text(),/Listagem salva/);
 }finally{w.unmount();}
 const h=createListPreferencesFixture({before(c){if(c.method==='POST')throw new AccessError(409);}}),x=await mount(h,{currentFilters:{periodo:'hoje'}});try{
  await x.click('Tornar padrão');assert.match(x.text(),/A listagem mudou em outra tela. Nada foi salvo/);assert.equal(x.nodes().some(n=>n.type==='button'&&n.props.children==='Conferir resultado'),false);
 }finally{x.unmount();}
});

test('116 a late answer after the user changed is never applied and the next user reads their own list',async()=>{const hold=deferred();let first=true;
 const f=createListPreferencesFixture({before(c){if(first&&c.method==='GET'){first=false;return hold.promise;}}}),v=await mount(f);try{
 f.setAccess({actor:'10000000-0000-4000-8000-000000000999'});await v.flush();
 hold.resolve({scope:'list_preferences',data_mode:'erp_native',list_id:'documentos.sales_orders',version:3,columns:['data'],filters:null,updated_at:'2026-10-20T12:00:00Z'});await v.flush();
 assert.equal(columns(v),'numero,cliente,total');assert.equal(f.calls.filter(c=>c.method==='GET').length,2);
}finally{hold.resolve(undefined);v.unmount();}});

test('116 controller sends only valid list ids and exact bodies',async()=>{
 const uid='a0000000-0000-4000-8000-000000000116',command='b0000000-0000-4000-8000-000000000116',session={access_token:'synthetic',user:{id:uid}};
 const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
 const calls=[];const c=createAccessController(auth,'https://api.example.test',async(url,o)=>{if(url.endsWith('/me'))return Response.json({user_id:uid,role:'vendas',resources:[],data_mode:'staging_readonly'});calls.push([url,o.method]);return Response.json({});});
 const stop=c.start();await new Promise(r=>setTimeout(r,0));try{
  await c.listPreferences('/v1/preferencias-listas/documentos.sales_orders');await c.listPreferences('/v1/preferencias-listas/documentos.sales_orders',{method:'POST',body:{command_id:command,expected_version:0,columns:['numero'],filters:null}});
  for(const[path,o]of[['/v1/preferencias-listas/Documentos',{}],['/v1/preferencias-listas/comandos',{}],['/v1/preferencias-listas/a?x=1',{}],['/v1/preferencias-listas/a',{method:'POST',body:{command_id:command,expected_version:0,columns:['A'],filters:null}}],
   ['/v1/preferencias-listas/a',{method:'POST',body:{command_id:command,expected_version:0,columns:null,filters:{a:{b:1}}}}],['/v1/preferencias-listas/a',{method:'PATCH',body:{}}]])
   await assert.rejects(()=>c.listPreferences(path,o),e=>e instanceof Error&&e.status===400,path);
  assert.equal(calls.length,2);
 }finally{stop();}
});
