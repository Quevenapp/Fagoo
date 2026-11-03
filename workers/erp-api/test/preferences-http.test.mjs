import test from'node:test';import assert from'node:assert/strict';
import{parsePreferencesRoute as parse,executePreferencesRoute as execute,preferencesMethods,preferencesRoute}from'../src/preferences.mjs';
import{capturePreferencesSave,parsePreferencesPage,parsePreferencesResult}from'../../../packages/erp-domain/src/preferences/dto.mjs';
import{createHandler}from'../src/index.mjs';
import{ACTOR,COMMAND,OTHER,pageView,saveInput,commandResult,deferred}from'./helpers/preferences-response-fixture.mjs';
const req=(path,body,init={})=>new Request('https://synthetic.invalid'+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'content-type':'application/json'},body:typeof body==='string'?body:JSON.stringify(body)}),...init});
const BASE='/v1/preferencias';
const sample=()=>saveInput([{key:'empresa.decimais_quantidade',expected_version:0,value:4}]);

test('115 closed routes: known pages only, strict methods, no query, exact bodies',async()=>{
 assert.equal(preferencesRoute('/v1/preferenciasx'),false);assert.equal(preferencesRoute('/v1/preferencias-listas/documentos.sales_orders'),true);assert.equal(preferencesRoute(`${BASE}/empresa-geral`),true);
 assert.deepEqual(preferencesMethods(`${BASE}/empresa-geral`),['GET','POST']);assert.deepEqual(preferencesMethods(`${BASE}/comandos/${COMMAND}`),['GET']);assert.deepEqual(preferencesMethods(BASE),['GET']);
 const route=await parse(req(`${BASE}/empresa-geral`));assert.deepEqual({...route.args},{p_page:'empresa-geral'});assert.ok(Object.isFrozen(route.args));
 for(const path of[BASE,`${BASE}/inexistente`,`${BASE}/certificado-digital`,`${BASE}/comandos/x`,`${BASE}/comandos/AAAAAAAA-0000-4000-8000-000000000115`,`${BASE}/empresa-geral/extra`])await assert.rejects(()=>parse(req(path)),e=>e.status===404||e.status===405,path);
 await assert.rejects(()=>parse(req(`${BASE}/empresa-geral?x=1`)),e=>e.status===400);
 await assert.rejects(()=>parse(req(`${BASE}/comandos/${COMMAND}`,sample())),e=>e.status===405);
 await assert.rejects(()=>parse(new Request('https://synthetic.invalid'+BASE+'/empresa-geral',{method:'GET',headers:{'content-length':'2'}})),e=>e.status===400);
 const saved=await parse(req(`${BASE}/empresa-geral`,sample()));assert.equal(saved.args.p_command_id,COMMAND);assert.deepEqual(saved.args.p_changes,[{key:'empresa.decimais_quantidade',expected_version:0,value:4}]);
 const bad=[{...sample(),extra:1},{command_id:COMMAND},{command_id:"AAAAAAAA-0000-4000-8000-000000000115",changes:sample().changes},saveInput([]),
  saveInput([{key:'empresa.decimais_quantidade',expected_version:0,value:11}]),saveInput([{key:'empresa.decimais_quantidade',expected_version:0,value:'4'}]),
  saveInput([{key:'empresa.decimais_quantidade',expected_version:-1,value:4}]),saveInput([{key:'empresa.decimais_quantidade',expected_version:0,value:4,extra:1}]),
  saveInput([{key:'vendas.gerar_nfe',expected_version:0,value:true}]),saveInput([{key:'empresa.decimais_quantidade',expected_version:0,value:4},{key:'empresa.decimais_quantidade',expected_version:0,value:5}]),
  '{',`{"command_id":"${COMMAND}","changes":[],"pad":"${'x'.repeat(70000)}"}`];
 for(const body of bad)await assert.rejects(()=>parse(req(`${BASE}/empresa-geral`,body)),e=>e.status===400,JSON.stringify(body).slice(0,80));
 await assert.rejects(()=>parse(req(`${BASE}/empresa-geral`,sample(),{headers:{'content-type':'text/plain'}})),e=>e.status===400);
 // Text, multi and keymap values must already be canonical; the API never trims or reorders them.
 for(const value of[' Observação','Observação ','Linha\r\n']){await assert.rejects(()=>parse(req(`${BASE}/suprimentos-compras`,saveInput([{key:'compras.observacao_padrao',expected_version:0,value}]))),e=>e.status===400,value);}
 await assert.rejects(()=>parse(req(`${BASE}/suprimentos-estoque`,saveInput([{key:'estoque.reserva_situacoes',expected_version:0,value:['verificado','em_aberto']}]))),e=>e.status===400);
 assert.ok(await parse(req(`${BASE}/suprimentos-estoque`,saveInput([{key:'estoque.reserva_situacoes',expected_version:0,value:['em_aberto','verificado']}]))));
});

test('115 DTOs reject any projection that is not exactly the page schema',()=>{
 assert.equal(parsePreferencesPage(pageView('empresa-geral'),'empresa-geral').items.length,6);
 for(const mutate of[v=>v.extra=1,v=>v.items.pop(),v=>v.items.reverse(),v=>v.items[0].value=11,v=>v.items[0].version=1,v=>{v.items[0].version=1;v.items[0].value=4;},v=>v.page='notas-nfe',
  v=>v.owner='user',v=>v.can_manage=false,v=>v.role='root',v=>v.directory=[],v=>v.data_mode='staging_readonly',v=>v.items[0].updated_at=v.items[0].updated_at??'2026-10-20T12:00:00Z'])
 {const bad=pageView('empresa-geral');mutate(bad);assert.throws(()=>parsePreferencesPage(bad,'empresa-geral'),undefined,String(mutate));}
 assert.throws(()=>parsePreferencesPage(pageView('notas-nfe',{role:'financeiro'}),'notas-nfe'));
 assert.equal(parsePreferencesPage(pageView('notas-nfe',{role:'fiscal'}),'notas-nfe').can_manage,false);
 assert.equal(parsePreferencesPage(pageView('sistema-interface',{role:'vendas'}),'sistema-interface').can_manage,true);
 const withUsers=pageView('vendas-vendas');assert.equal(parsePreferencesPage(withUsers,'vendas-vendas').directory.length,2);
 const leak=pageView('vendas-vendas',{role:'consulta'});leak.directory=[{user_id:ACTOR,role:'admin',label:null}];assert.throws(()=>parsePreferencesPage(leak,'vendas-vendas'));
 const input=sample(),ok=commandResult('empresa-geral',input);assert.equal(parsePreferencesResult(ok,{commandId:COMMAND,pageId:'empresa-geral',input}).receipt.changes.length,1);
 for(const mutate of[v=>v.receipt.changes[0].after=5,v=>v.receipt.changes[0].from_version=1,v=>v.receipt.changes[0].to_version=2,v=>v.receipt.command_id=ACTOR,v=>v.receipt.page='notas-nfe',
  v=>v.page.items[0].version=0,v=>v.receipt.changes.push({...v.receipt.changes[0]}),v=>v.receipt.changes[0].before=4,v=>v.receipt.changed_at='ontem'])
 {const r=commandResult('empresa-geral',input);mutate(r);assert.throws(()=>parsePreferencesResult(r,{commandId:COMMAND,pageId:'empresa-geral',input}),undefined,String(mutate));}
 assert.throws(()=>parsePreferencesResult(ok,{commandId:COMMAND,lookup:true}));
 assert.equal(parsePreferencesResult(commandResult('empresa-geral',input,{replayed:true}),{commandId:COMMAND,lookup:true}).replayed,true);
 let gets=0;assert.throws(()=>capturePreferencesSave({get command_id(){gets++;return COMMAND;},changes:[]},'empresa-geral'));assert.ok(gets<=1);
});

test('115 execution: frozen actor, sanitized SQL refusals, unconfirmed mutations, timeouts and aborts',async()=>{
 const route=await parse(req(`${BASE}/empresa-geral`,sample()));
 for(const[code,status]of[['42501',403],['22023',400],['40001',409],['P0002',404]])await assert.rejects(()=>execute(route,{userId:ACTOR,rpc:()=>{throw{code,message:'PRIVATE_SQL'};}}),e=>e.status===status&&!e.message.includes('PRIVATE'));
 for(const rpc of[()=>{throw Error('PRIVATE');},()=>({...commandResult('empresa-geral',sample()),payload:'PRIVATE'}),()=>new Promise(()=>{})])
  await assert.rejects(()=>execute(route,{userId:ACTOR,rpc,timeoutMs:5}),e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED');
 const hold=deferred();let entered;const seen=new Promise(r=>entered=r);const ctx={userId:ACTOR,rpc:(name,args)=>{entered({name,args});return hold.promise;}};const work=execute(route,ctx);
 const call=await seen;ctx.userId=OTHER;assert.equal(call.name,'erp_preferences_save');assert.equal(call.args.p_user_id,ACTOR);assert.ok(Object.isFrozen(call.args));
 hold.resolve(commandResult('empresa-geral',sample()));assert.equal((await work).replayed,false);
 const read=await parse(req(`${BASE}/empresa-geral`));
 await assert.rejects(()=>execute(read,{userId:ACTOR,rpc:()=>({...pageView('empresa-geral'),extra:1})}),e=>e.status===502);
 await assert.rejects(()=>execute(read,{userId:ACTOR,rpc:()=>{throw Error('PRIVATE');}}),e=>e.status===502&&e.code==='ERP_UPSTREAM_UNAVAILABLE');
 await assert.rejects(()=>execute(read,{userId:ACTOR,rpc:()=>new Promise(()=>{}),timeoutMs:5}),e=>e.status===408);
 const stop=new AbortController();stop.abort();let calls=0;await assert.rejects(()=>execute(read,{userId:ACTOR,signal:stop.signal,rpc:()=>calls++}),e=>e.status===408);assert.equal(calls,0);
 await assert.rejects(()=>execute(read,{userId:'not-a-user',rpc:()=>pageView('empresa-geral')}),e=>e.status===403);
 await assert.rejects(()=>execute(read,{userId:ACTOR,rpc:()=>pageView('empresa-geral'),extra:true}),e=>e.status===400);
 await assert.rejects(()=>execute(Object.freeze({...read}),{userId:ACTOR,rpc:()=>pageView('empresa-geral')}),e=>e.status===404);
 assert.equal((await execute(await parse(req(`${BASE}/comandos/${COMMAND}`)),{userId:ACTOR,rpc:(name,args)=>{assert.equal(name,'erp_preferences_command');assert.equal(args.p_command_id,COMMAND);return commandResult('empresa-geral',sample(),{replayed:true});}})).replayed,true);
});

const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-115',ALLOWED_ORIGINS:'https://erp.synthetic.test'},headers={Authorization:'Bearer synthetic-token',Origin:'https://erp.synthetic.test'};
const api=(path,body,method)=>new Request('https://api.synthetic.test'+path,{method:method??(body===undefined?'GET':'POST'),headers:{...headers,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
test('115 real API: authenticated actor, fixed RPC per route, bounded responses and definite versus unconfirmed errors',async()=>{
 for(const[path,body,name,value]of[[`${BASE}/empresa-geral`,undefined,'erp_preferences_page',pageView('empresa-geral')],[`${BASE}/empresa-geral`,sample(),'erp_preferences_save',commandResult('empresa-geral',sample())],
  [`${BASE}/comandos/${COMMAND}`,undefined,'erp_preferences_command',commandResult('empresa-geral',sample(),{replayed:true})]]){
  const calls=[],h=createHandler({fetchImpl:async(url,o)=>{calls.push({url,o});return Response.json(url.endsWith('/auth/v1/user')?{id:ACTOR,user_metadata:{role:'admin'}}:value);}}),r=await h(api(path,body),env);
  assert.equal(r.status,200,path);assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith('/rest/v1/rpc/'+name));assert.equal(JSON.parse(calls[1].o.body).p_user_id,ACTOR);assert.equal(r.headers.get('cache-control'),'no-store');}
 for(const[code,status]of[['42501',403],['22023',400],['40001',409],['P0002',404]]){let writes=0;const h=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:ACTOR}):(writes++,Response.json({code,message:'PRIVATE'},{status:400}))}),r=await h(api(`${BASE}/empresa-geral`,sample()),env);
  assert.equal(r.status,status);assert.equal(writes,1);assert.doesNotMatch(await r.text(),/PRIVATE|synthetic/);}
 let writes=0;const lost=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:ACTOR}):(writes++,Response.json({...commandResult('empresa-geral',sample()),private:'PRIVATE'}))});
 const r=await lost(api(`${BASE}/empresa-geral`,sample()),env);assert.equal(r.status,503);assert.equal(writes,1);assert.equal((await r.json()).error.code,'ERP_RESULT_UNCONFIRMED');
 for(const size of[262144,262145]){const h=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:ACTOR}):new Response(JSON.stringify(pageView('empresa-geral')),{headers:{'Content-Type':'application/json','Content-Length':String(size)}})});assert.equal((await h(api(`${BASE}/empresa-geral`),env)).status,size===262144?200:502);}
 let calls=0;const none=createHandler({fetchImpl:async()=>{calls++;return Response.json({id:ACTOR});}});
 assert.equal((await none(api(`${BASE}/empresa-geral`,undefined,'DELETE'),env)).status,405);assert.equal(calls,0);
 assert.equal((await none(api(`${BASE}/empresa-geral`,saveInput([{key:'empresa.decimais_quantidade',expected_version:0,value:99}])),env)).status,400);assert.equal(calls,1);
 const anonymous=createHandler({fetchImpl:async()=>Response.json({id:ACTOR,is_anonymous:true})});assert.equal((await anonymous(api(`${BASE}/empresa-geral`),env)).status,403);
 const preflight=await none(new Request('https://api.synthetic.test'+BASE+'/empresa-geral',{method:'OPTIONS',headers:{Origin:'https://erp.synthetic.test','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'}}),env);
 assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-methods'),'GET, POST');
});
