import test from'node:test';import assert from'node:assert/strict';
import{createHandler,tokenSession}from'../src/index.mjs';
import{parseSecurityRoute,securityMethods}from'../src/security.mjs';

// Leva H, lane acesso (310): /v1/seguranca, the MFA gate on every route (PDV included) and the /v1/me flag repair. Synthetic data only.
const ACTOR='10000000-0000-4000-8000-000000000310',TARGET='20000000-0000-4000-8000-000000000310',COMMAND='30000000-0000-4000-8000-000000000310',
 SESSION='40000000-0000-4000-8000-000000000310',F1='50000000-0000-4000-8000-000000000310',STAMP='2026-10-21T12:00:00.000-03:00';
const jwt=claims=>`h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-310',ALLOWED_ORIGINS:'https://erp.synthetic.test'};
const headers=(aal='aal1')=>({Authorization:`Bearer ${jwt({session_id:SESSION,aal})}`,Origin:'https://erp.synthetic.test'});
const path=u=>u.replace('https://project.supabase.co','');
const policy={mfa_required:true,version:1,updated_at:STAMP,members:[{user_id:ACTOR,name:'Admin Sintético',role:'admin',factor:true}]};
const saved=(over={})=>({scope:'access_security_command',data_mode:'erp_native',receipt:{command_id:COMMAND,from_version:0,to_version:1,changed_at:STAMP},policy,replayed:false,
 gates:[{user_id:ACTOR,gate_required:true},{user_id:TARGET,gate_required:true}],...over});

test('310 the token session: only a UUID session_id and aal2 are read; anything else is aal1 without a session',()=>{
 assert.deepEqual(tokenSession(jwt({session_id:SESSION,aal:'aal2'})),{session_id:SESSION,aal:'aal2'});
 for(const bad of['x','a.b.c',jwt({session_id:'not-a-uuid',aal:'AAL2'}),jwt([])])assert.deepEqual(tokenSession(bad),{session_id:null,aal:'aal1'});
});

test('310 /v1/seguranca routes are closed',async()=>{
 const req=(p,init)=>new Request('https://api.synthetic.test'+p,init);
 assert.deepEqual(securityMethods('/v1/seguranca/politica'),['GET','POST']);assert.deepEqual(securityMethods(`/v1/seguranca/usuarios/${TARGET}/redefinir-mfa`),['POST']);
 assert.deepEqual(await parseSecurityRoute(req('/v1/seguranca/politica')),{action:'policy'});
 const post=(p,b)=>req(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
 assert.equal((await parseSecurityRoute(post('/v1/seguranca/politica',{command_id:COMMAND,expected_version:0,mfa_required:true}))).input.mfa_required,true);
 for(const bad of[{command_id:COMMAND,expected_version:0},{command_id:'x',expected_version:0,mfa_required:true},{command_id:COMMAND,expected_version:-1,mfa_required:true},{command_id:COMMAND,expected_version:0,mfa_required:'sim'},{command_id:COMMAND,expected_version:0,mfa_required:true,x:1}])
  await assert.rejects(()=>parseSecurityRoute(post('/v1/seguranca/politica',bad)),e=>e.status===400,JSON.stringify(bad));
 await assert.rejects(()=>parseSecurityRoute(req('/v1/seguranca/politica?x=1')),e=>e.status===400);
 await assert.rejects(()=>parseSecurityRoute(req('/v1/seguranca/outra')),e=>e.status===404);
 await assert.rejects(()=>parseSecurityRoute(req('/v1/seguranca/politica',{method:'POST',headers:{'content-type':'text/plain'},body:'{}'})),e=>e.status===415);
});

test('310 policy save: the database gets the session id; every member flag is written with the service key; the gate list stays in the Worker',async()=>{
 const calls=[],h=createHandler({fetchImpl:async(url,o)=>{calls.push({url:path(url),o});
  if(url.endsWith('/auth/v1/user'))return Response.json({id:ACTOR});if(url.includes('/auth/v1/admin/users/'))return Response.json({id:'x'});return Response.json(saved());}});
 const r=await h(new Request('https://api.synthetic.test/v1/seguranca/politica',{method:'POST',headers:{...headers('aal2'),'content-type':'application/json'},body:JSON.stringify({command_id:COMMAND,expected_version:0,mfa_required:true})}),env);
 assert.equal(r.status,200);const out=await r.json();assert.equal(Object.hasOwn(out,'gates'),false);assert.equal(out.policy.mfa_required,true);
 assert.deepEqual(calls.map(c=>c.url),['/auth/v1/user','/rest/v1/rpc/erp_access_security_policy_save',`/auth/v1/admin/users/${ACTOR}`,`/auth/v1/admin/users/${TARGET}`]);
 assert.deepEqual(JSON.parse(calls[1].o.body),{p_user_id:ACTOR,p_session_id:SESSION,p_command_id:COMMAND,p_expected_version:0,p_mfa_required:true});
 assert.deepEqual(JSON.parse(calls[3].o.body),{app_metadata:{brufap_access_gate:true}});assert.equal(calls[3].o.headers.Authorization,'Bearer synthetic-310');
 // A lost flag write is unconfirmed; the aal2 refusal of the database has its own code.
 const lost=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:ACTOR}):url.includes('/admin/users/')?new Response('',{status:500}):Response.json(saved())});
 const u=await lost(new Request('https://api.synthetic.test/v1/seguranca/politica',{method:'POST',headers:{...headers(),'content-type':'application/json'},body:JSON.stringify({command_id:COMMAND,expected_version:0,mfa_required:true})}),env);
 assert.equal(u.status,503);assert.match(await u.text(),/ERP_RESULT_UNCONFIRMED/);
 const weak=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:ACTOR}):Response.json({code:'28000',message:'erp_access_mfa_required'},{status:403})});
 const w=await weak(new Request('https://api.synthetic.test/v1/seguranca/politica',{method:'POST',headers:{...headers(),'content-type':'application/json'},body:JSON.stringify({command_id:COMMAND,expected_version:0,mfa_required:true})}),env);
 assert.equal(w.status,403);assert.match(await w.text(),/ERP_MFA_REQUIRED/);
});

test('310 factor reset: the Worker removes each factor through the Auth admin API and answers only how many',async()=>{
 const calls=[],h=createHandler({fetchImpl:async(url,o)=>{calls.push({url:path(url),method:o.method});
  if(url.endsWith('/auth/v1/user'))return Response.json({id:ACTOR});if(url.includes('/factors/'))return new Response(null,{status:url.endsWith(F1)?404:200});
  return Response.json({scope:'access_mfa_reset',data_mode:'erp_native',command_id:COMMAND,target:TARGET,factors:[F1,SESSION],changed_at:STAMP,replayed:false});}});
 const r=await h(new Request(`https://api.synthetic.test/v1/seguranca/usuarios/${TARGET}/redefinir-mfa`,{method:'POST',headers:{...headers('aal2'),'content-type':'application/json'},body:JSON.stringify({command_id:COMMAND})}),env);
 assert.equal(r.status,200);const out=await r.json();assert.equal(out.removed,2);assert.equal(JSON.stringify(out).includes(F1),false);
 assert.deepEqual(calls.filter(c=>c.method==='DELETE').map(c=>c.url),[`/auth/v1/admin/users/${TARGET}/factors/${F1}`,`/auth/v1/admin/users/${TARGET}/factors/${SESSION}`]);
});

test('310 the gate: a flagged user without aal2 is refused on every route, the PDV included; aal2 splits the minute cache',async()=>{
 let ok=false;const calls=[],flagged={id:ACTOR,app_metadata:{brufap_access_gate:true}};
 const h=createHandler({fetchImpl:async(url,o)=>{calls.push(path(url));if(url.endsWith('/auth/v1/user'))return Response.json(flagged);
  if(url.endsWith('/erp_access_gate_v2')){assert.equal(JSON.parse(o.body).p_session_id,SESSION);return Response.json({scope:'access_gate',data_mode:'erp_native',user_id:ACTOR,open:true,until:null,mfa_required:true,mfa_ok:ok});}
  return Response.json({});}});
 for(const route of['/v1/sistema/perfil','/v1/me','/v1/frente-caixa/caixas','/v1/seguranca/politica']){
  const r=await h(new Request('https://api.synthetic.test'+route,{headers:headers()}),env);assert.equal(r.status,403,route);assert.match(await r.text(),/ERP_MFA_REQUIRED/,route);}
 assert.equal(calls.filter(u=>u.endsWith('/erp_access_gate_v2')).length,1);
 ok=true;const r=await h(new Request('https://api.synthetic.test/v1/seguranca/politica',{headers:headers('aal2')}),env);
 assert.notEqual(r.status,403);assert.equal(calls.filter(u=>u.endsWith('/erp_access_gate_v2')).length,2);
});

test('310 /v1/me writes the missing flag of a member the gate must see, then checks this request right away',async()=>{
 const calls=[],me={user_id:ACTOR,role:'vendas',resources:['contacts'],data_mode:'staging_readonly',access_window:'open',gate_required:true};
 const h=createHandler({fetchImpl:async(url,o)=>{calls.push({url:path(url),o});if(url.endsWith('/auth/v1/user'))return Response.json({id:ACTOR});
  if(url.includes('/admin/users/'))return Response.json({id:ACTOR});if(url.endsWith('/erp_access_me'))return Response.json(me);
  return Response.json({scope:'access_gate',data_mode:'erp_native',user_id:ACTOR,open:true,until:null,mfa_required:false,mfa_ok:true});}});
 const r=await h(new Request('https://api.synthetic.test/v1/me',{headers:headers()}),env);assert.equal(r.status,200);
 assert.deepEqual(Object.keys(await r.json()).sort(),['capabilities','data_mode','resources','role','user_id']);
 assert.deepEqual(calls.map(c=>c.url),['/auth/v1/user','/rest/v1/rpc/erp_access_me',`/auth/v1/admin/users/${ACTOR}`,'/rest/v1/rpc/erp_access_gate_v2']);
 for(const bad of['sim',1]){const b=createHandler({fetchImpl:async url=>Response.json(url.endsWith('/auth/v1/user')?{id:ACTOR}:{...me,gate_required:bad})});
  assert.equal((await b(new Request('https://api.synthetic.test/v1/me',{headers:headers()}),env)).status,502);}
});
