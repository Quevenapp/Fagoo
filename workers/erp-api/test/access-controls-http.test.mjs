import test from'node:test';import assert from'node:assert/strict';
import{parsePreferencesRoute as parse,preferencesMethods,executePreferencesRoute}from'../src/preferences.mjs';
import{createHandler}from'../src/index.mjs';

// 229 access controls: routes, the Auth gate flag, the per-request gate and /v1/me outside the windows. Synthetic data only.
const ACTOR='10000000-0000-4000-8000-000000000229',TARGET='20000000-0000-4000-8000-000000000229',COMMAND='30000000-0000-4000-8000-000000000229',STAMP='2026-10-20T12:00:00.000-03:00';
const req=(path,init)=>new Request('https://synthetic.invalid'+path,init);
const post=(path,body)=>req(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const data={user_type:'normal',schedule:{enabled:true,windows:[{start:'08:00',end:'18:00',days:[1,2,3,4,5]}]},permissions:['meu_negocio.dashboard','meu_negocio.dashboard.mensal']};
const body=(over={})=>({command_id:COMMAND,expected_version:0,data,...over});
const controls=(over={})=>({scope:'access_user_controls',data_mode:'erp_native',target:TARGET,role:'vendas',version:1,user_type:'normal',schedule:{enabled:true,windows:[{end:'18:00',days:[1,2,3,4,5],start:'08:00'}]},
 permissions:['meu_negocio.dashboard','meu_negocio.dashboard.mensal'],seller:null,updated_at:STAMP,gate_required:true,...over});
const saved=(over={})=>({scope:'access_controls_command',data_mode:'erp_native',replayed:false,receipt:{command_id:COMMAND,target:TARGET,changed_at:STAMP},controls:controls(),...over});

test('229 /v1/usuarios/:id/controles: strict routes and bodies',async()=>{
 assert.deepEqual(preferencesMethods(`/v1/usuarios/${TARGET}/controles`),['GET','POST']);
 const get=await parse(req(`/v1/usuarios/${TARGET}/controles`));assert.deepEqual([get.rpc,{...get.args}],['erp_access_user_controls_get',{p_target:TARGET}]);
 const save=await parse(post(`/v1/usuarios/${TARGET}/controles`,body()));assert.equal(save.rpc,'erp_access_user_controls_save');assert.equal(save.mutation,true);
 assert.deepEqual({...save.args},{p_target:TARGET,p_command_id:COMMAND,p_expected_version:0,p_data:data});
 for(const bad of[{data:{...data,user_type:'api'}},{data:{...data,schedule:{enabled:true,windows:[]}}},{data:{...data,schedule:{enabled:false,windows:[{start:'8:00',end:'18:00',days:[1]}]}}},
  {data:{...data,permissions:['meu_negocio.dashboard.mensal']}},{data:{...data,permissions:['outros.usuarios']}},{expected_version:-1},{extra:1},{data:{...data,extra:1}}])
  await assert.rejects(()=>parse(post(`/v1/usuarios/${TARGET}/controles`,{...body(),...bad})),e=>e.status===400,JSON.stringify(bad));
 await assert.rejects(()=>parse(req(`/v1/usuarios/${TARGET}/controles?x=1`)),e=>e.status===400);
 await assert.rejects(()=>parse(req('/v1/usuarios/x/controles')),e=>e.status===404);
});

test('229 the save records the command, then sets the Auth gate flag; a lost flag update is unconfirmed',async()=>{
 const route=await parse(post(`/v1/usuarios/${TARGET}/controles`,body()));const seen=[];
 const out=await executePreferencesRoute(route,{userId:ACTOR,rpc:async(name,args)=>{seen.push(name);assert.equal(args.p_user_id,ACTOR);return saved();},authAdmin:async(target,meta)=>{seen.push(['auth',target,meta]);return{id:target};}});
 assert.equal(out.controls.version,1);assert.deepEqual(seen,['erp_access_user_controls_save',['auth',TARGET,{brufap_access_gate:true}]]);
 await assert.rejects(()=>executePreferencesRoute(route,{userId:ACTOR,rpc:async()=>saved(),authAdmin:async()=>{throw new Error('auth down');}}),e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED');
 await assert.rejects(()=>executePreferencesRoute(route,{userId:ACTOR,rpc:async()=>saved({controls:controls({user_type:'contador'})}),authAdmin:async()=>({})}),e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED');
 // A known refusal of the database keeps its meaning; nothing reaches Auth.
 let auth=false;await assert.rejects(()=>executePreferencesRoute(route,{userId:ACTOR,rpc:async()=>{throw Object.assign(new Error('x'),{code:'40001'});},authAdmin:async()=>{auth=true;}}),e=>e.status===409);assert.equal(auth,false);
});

const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-229',ALLOWED_ORIGINS:'https://erp.synthetic.test'},headers={Authorization:'Bearer synthetic-token',Origin:'https://erp.synthetic.test'};
const profile={scope:'profile',data_mode:'erp_native'};
test('229 composed handler: the Auth admin update carries only the flag, with the service key',async()=>{
 const calls=[],h=createHandler({fetchImpl:async(url,o)=>{calls.push({url,o});return Response.json(url.endsWith('/auth/v1/user')?{id:ACTOR}:url.includes('/auth/v1/admin/users/')?{id:TARGET}:saved());}});
 const r=await h(new Request(`https://api.synthetic.test/v1/usuarios/${TARGET}/controles`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body())}),env);
 assert.equal(r.status,200);assert.deepEqual(calls.map(c=>c.url.replace('https://project.supabase.co','')),['/auth/v1/user','/rest/v1/rpc/erp_access_user_controls_save',`/auth/v1/admin/users/${TARGET}`]);
 const auth=calls[2].o;assert.equal(auth.method,'PUT');assert.equal(auth.headers.Authorization,'Bearer synthetic-229');assert.deepEqual(JSON.parse(auth.body),{app_metadata:{brufap_access_gate:true}});
});

test('229 the per-request gate: only flagged users are checked, once per minute; outside the windows the request is refused before its RPC',async()=>{
 const flagged={id:ACTOR,app_metadata:{provider:'email',brufap_access_gate:true}};
 let open=false;const calls=[],h=createHandler({fetchImpl:async(url,o)=>{calls.push(url);if(url.endsWith('/auth/v1/user'))return Response.json(flagged);
  if(url.endsWith('/erp_access_gate_v2'))return Response.json({scope:'access_gate',data_mode:'erp_native',user_id:ACTOR,open,until:null,mfa_required:false,mfa_ok:true});return Response.json(profile);}});
 const closed=await h(new Request('https://api.synthetic.test/v1/sistema/perfil',{headers}),env);
 assert.equal(closed.status,403);assert.match(await closed.text(),/ERP_ACCESS_OUTSIDE_SCHEDULE/);assert.equal(calls.some(u=>u.endsWith('/erp_access_profile_me')),false);
 // The answer is kept for the minute: a second request of the same user does not ask again.
 const again=await h(new Request('https://api.synthetic.test/v1/sistema/perfil',{headers}),env);assert.equal(again.status,403);
 assert.equal(calls.filter(u=>u.endsWith('/erp_access_gate_v2')).length,1);
 // Users without the flag make no extra call (the shape every other test of the Worker uses).
 const plain=[],p=createHandler({fetchImpl:async url=>{plain.push(url);return Response.json(url.endsWith('/auth/v1/user')?{id:ACTOR}:{scope:'access_permissions',data_mode:'erp_native',user_id:ACTOR,role:'vendas',user_type:'normal',permissions:null,access:{open:true,until:null}});}});
 const ok=await p(new Request('https://api.synthetic.test/v1/sistema/permissoes',{headers}),env);assert.equal(ok.status,200);
 assert.deepEqual(plain.map(u=>u.replace('https://project.supabase.co','')),['/auth/v1/user','/rest/v1/rpc/erp_access_permissions_me']);
 const forged=createHandler({fetchImpl:async url=>Response.json(url.endsWith('/auth/v1/user')?flagged:{scope:'access_gate',user_id:'x',open:true})});
 assert.equal((await forged(new Request('https://api.synthetic.test/v1/sistema/perfil',{headers}),env)).status,502);
});

test('229 /v1/me: outside the access windows the session is refused with its own code',async()=>{
 const me=window=>({user_id:ACTOR,role:'vendas',resources:['contacts'],data_mode:'staging_readonly',...(window?{access_window:window}:{})});
 for(const[window,status]of[[null,200],['open',200],['closed',403],['x',502]]){
  const h=createHandler({fetchImpl:async url=>Response.json(url.endsWith('/auth/v1/user')?{id:ACTOR}:me(window))});
  const r=await h(new Request('https://api.synthetic.test/v1/me',{headers}),env);assert.equal(r.status,status,String(window));
  if(status===403)assert.match(await r.text(),/ERP_ACCESS_OUTSIDE_SCHEDULE/);
  if(status===200)assert.deepEqual(Object.keys(await r.json()).sort(),['capabilities','data_mode','resources','role','user_id']);
 }
});

test('229 the windows of the linked seller follow the Cadastros › Vendedores rule (distinct days in any order); the user windows stay in order',async()=>{
 const{parseControls}=await import('../../../packages/erp-domain/src/user-permissions.mjs');
 const seller={name:'Vendedor sintético',enabled:true,windows:[{start:'08:00',end:'12:00',days:[5,1]}]};
 assert.deepEqual(parseControls(controls({seller}),TARGET).seller.windows[0].days,[5,1]);
 for(const days of[[1,1],[7],[]])assert.throws(()=>parseControls(controls({seller:{...seller,windows:[{start:'08:00',end:'12:00',days}]}}),TARGET),e=>e.status===502,JSON.stringify(days));
 assert.throws(()=>parseControls(controls({schedule:{enabled:true,windows:[{start:'08:00',end:'18:00',days:[5,1]}]}}),TARGET),e=>e.status===502);
});
