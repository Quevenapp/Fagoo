import test from'node:test';import assert from'node:assert/strict';
import{parsePreferencesRoute as parse,executePreferencesRoute as execute,preferencesMethods}from'../src/preferences.mjs';
import{createHandler}from'../src/index.mjs';
const ACTOR='10000000-0000-4000-8000-000000000117',TARGET='30000000-0000-4000-8000-000000000117',COMMAND='20000000-0000-4000-8000-000000000117',STAMP='2026-10-20T12:00:00.000000+00:00',BASE='/v1/usuarios';
const req=(path,body,init={})=>new Request('https://synthetic.invalid'+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)}),...init});
const user=(over={})=>({user_id:TARGET,email:'nova.pessoa@sintetico.test',name:'Nova Pessoa',phone:null,profile_version:1,role:'vendas',active:true,status:'ativo',invited:true,confirmed:false,last_sign_in_at:null,created_at:STAMP,...over});
const listView=(over={})=>({scope:'access_users',data_mode:'erp_native',status:'todos',type:'todos',query:null,limit:100,offset:0,total:1,has_more:false,items:[{...user(),user_type:'normal'}],counts:{ativo:1,inativo:0,sem_acesso:0},actor:ACTOR,...over});
const invite={command_id:COMMAND,email:'nova.pessoa@sintetico.test',name:'Nova Pessoa',role:'vendas'};
const pending=(existing=null)=>({scope:'access_invite',data_mode:'erp_native',state:'pending',command_id:COMMAND,email:invite.email,existing_user_id:existing});
const done=(replayed=false)=>({scope:'access_user_command',data_mode:'erp_native',replayed,user:user(),receipt:{command_id:COMMAND,kind:'invite',target:TARGET,changed_at:STAMP,before:{name:null,phone:null,role:null,active:false},after:{name:'Nova Pessoa',phone:null,role:'vendas',active:true}}});
const saveBody={command_id:COMMAND,expected:{role:'vendas',active:true,profile_version:1},data:{name:'Nova Pessoa',phone:'(11) 90000-0000',role:'consulta',active:true}};
const saved=()=>({scope:'access_user_command',data_mode:'erp_native',replayed:false,user:user({phone:'(11) 90000-0000',role:'consulta',profile_version:2}),receipt:{command_id:COMMAND,kind:'save',target:TARGET,changed_at:STAMP,before:{name:'Nova Pessoa',phone:null,role:'vendas',active:true},after:saveBody.data}});

test('117 closed routes, query and bodies',async()=>{
 assert.deepEqual(preferencesMethods(BASE),['GET']);assert.deepEqual(preferencesMethods(`${BASE}/convites`),['POST']);assert.deepEqual(preferencesMethods(`${BASE}/${TARGET}`),['GET','POST']);
 assert.deepEqual({...(await parse(req(`${BASE}?q=%20Nova%20&situacao=ativo&limit=10`))).args},{p_query:'nova',p_status:'ativo',p_type:'todos',p_limit:10,p_offset:0});
 // 229: Tipo de usuário (Todos | Normal | Contador).
 assert.deepEqual({...(await parse(req(`${BASE}?tipo=contador`))).args},{p_query:null,p_status:'todos',p_type:'contador',p_limit:100,p_offset:0});
 await assert.rejects(()=>parse(req(`${BASE}?tipo=api`)),e=>e.status===400);
 for(const path of[`${BASE}?situacao=x`,`${BASE}?limit=0`,`${BASE}?limit=101`,`${BASE}?offset=01`,`${BASE}?x=1`,`${BASE}?q=a&q=b`,`${BASE}/${TARGET}?x=1`])await assert.rejects(()=>parse(req(path)),e=>e.status===400,path);
 for(const path of[`${BASE}/x`,`${BASE}/comandos/x`])await assert.rejects(()=>parse(req(path)),e=>e.status===404,path);
 await assert.rejects(()=>parse(req(`${BASE}/convites`)),e=>e.status===405);
 const i=await parse(req(`${BASE}/convites`,invite));assert.deepEqual({...i.args},{p_command_id:COMMAND,p_email:invite.email,p_name:'Nova Pessoa',p_role:'vendas'});
 for(const body of[{...invite,email:'Nova@x.y'},{...invite,email:'x'},{...invite,role:'root'},{...invite,name:' x'},{...invite,extra:1}])await assert.rejects(()=>parse(req(`${BASE}/convites`,body)),e=>e.status===400,JSON.stringify(body));
 const s=await parse(req(`${BASE}/${TARGET}`,saveBody));assert.deepEqual(s.args.p_data,saveBody.data);
 for(const body of[{...saveBody,data:{...saveBody.data,phone:'1'}},{...saveBody,expected:{...saveBody.expected,profile_version:-1}},{...saveBody,data:{...saveBody.data,active:'sim'}}])await assert.rejects(()=>parse(req(`${BASE}/${TARGET}`,body)),e=>e.status===400);
});

test('117 invite runs begin → Auth invite → complete once; a resumed command never invites twice',async()=>{
 const route=await parse(req(`${BASE}/convites`,invite));
 const run=async({begin,auth=async()=>({id:TARGET,email:invite.email}),finish=async()=>done()})=>{const calls=[];const value=await execute(route,{userId:ACTOR,
  rpc:async(name,args)=>{calls.push([name,args]);return name==='erp_access_user_invite_begin'?begin():finish(args);},authInvite:async(email)=>{calls.push(['auth',email]);return auth();}});return{value,calls};};
 const fresh=await run({begin:async()=>pending()});assert.deepEqual(fresh.calls.map(c=>c[0]),['erp_access_user_invite_begin','auth','erp_access_user_invite_complete']);
 assert.equal(fresh.calls[1][1],invite.email);assert.deepEqual(fresh.calls[2][1],{p_user_id:ACTOR,p_command_id:COMMAND,p_target:TARGET});assert.equal(fresh.value.user.role,'vendas');
 const resumed=await run({begin:async()=>pending(TARGET),finish:async()=>done(true)});assert.deepEqual(resumed.calls.map(c=>c[0]),['erp_access_user_invite_begin','erp_access_user_invite_complete']);
 const finished=await run({begin:async()=>done(true)});assert.deepEqual(finished.calls.map(c=>c[0]),['erp_access_user_invite_begin']);
 await assert.rejects(()=>run({begin:async()=>pending(),auth:async()=>{throw Error('PRIVATE');}}),e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED');
 await assert.rejects(()=>run({begin:async()=>pending(),auth:async()=>({id:TARGET,email:'outra@x.y'})}),e=>e.status===503);
 // Auth refused the invite in its own transaction: definitive, and "complete" is never called.
 {const calls=[];await assert.rejects(()=>execute(route,{userId:ACTOR,rpc:async(name)=>{calls.push(name);return pending();},authInvite:async()=>{throw Object.assign(new Error('x'),{status:422,code:'ERP_USERS_INVITE_REFUSED'});}}),e=>e.status===422&&e.code==='ERP_USERS_INVITE_REFUSED');
  assert.deepEqual(calls,['erp_access_user_invite_begin']);}
 await assert.rejects(()=>run({begin:async()=>{throw{code:'ERP_CONFLICT'};}}),e=>e.status===409);
 // After this request asked Auth to invite, a refused "complete" is uncertain: the invitation may already have been sent.
 for(const code of['40001','42501','ERP_CONFLICT'])await assert.rejects(()=>run({begin:async()=>pending(),finish:async()=>{throw{code};}}),e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED',code);
 // Resumed without a new Auth call, the database answer stays definitive.
 await assert.rejects(()=>run({begin:async()=>pending(TARGET),finish:async()=>{throw{code:'40001'};}}),e=>e.status===409);
 await assert.rejects(()=>execute(route,{userId:ACTOR,rpc:async()=>pending()}),e=>e.status===503);
});

const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-117',ALLOWED_ORIGINS:'https://erp.synthetic.test'},headers={Authorization:'Bearer synthetic-token',Origin:'https://erp.synthetic.test'};
const api=(path,body)=>new Request('https://api.synthetic.test'+path,{method:body===undefined?'GET':'POST',headers:{...headers,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
test('117 real API: list, save and the Auth invite with the service key only in the Worker',async()=>{
 for(const[path,body,name,value]of[[BASE,undefined,'erp_access_users_list_v2',listView()],[`${BASE}/${TARGET}`,undefined,'erp_access_user_get',{scope:'access_user',data_mode:'erp_native',user:user(),actor:ACTOR}],
  [`${BASE}/${TARGET}`,saveBody,'erp_access_user_save',saved()],[`${BASE}/comandos/${COMMAND}`,undefined,'erp_access_user_command',pending(TARGET)]]){
  const calls=[],h=createHandler({fetchImpl:async(url,o)=>{calls.push({url,o});return Response.json(url.endsWith('/auth/v1/user')?{id:ACTOR}:value);}}),r=await h(api(path,body),env);
  assert.equal(r.status,200,path);assert.ok(calls[1].url.endsWith('/rest/v1/rpc/'+name));assert.equal(JSON.parse(calls[1].o.body).p_user_id,ACTOR);}
 const calls=[];const h=createHandler({fetchImpl:async(url,o)=>{calls.push({url,o});
  if(url.endsWith('/auth/v1/user'))return Response.json({id:ACTOR});if(url.endsWith('/auth/v1/invite'))return Response.json({id:TARGET,email:invite.email,aud:'authenticated'});
  return Response.json(url.endsWith('erp_access_user_invite_begin')?pending():done());}});
 const r=await h(api(`${BASE}/convites`,invite),env);assert.equal(r.status,200);assert.equal((await r.json()).receipt.kind,'invite');
 const sent=calls.find(c=>c.url.endsWith('/auth/v1/invite'));assert.equal(sent.o.method,'POST');assert.equal(sent.o.headers.Authorization,'Bearer synthetic-117');assert.deepEqual(JSON.parse(sent.o.body),{email:invite.email});
 assert.deepEqual(calls.map(c=>c.url.replace('https://project.supabase.co','')),['/auth/v1/user','/rest/v1/rpc/erp_access_user_invite_begin','/auth/v1/invite','/rest/v1/rpc/erp_access_user_invite_complete']);
 // A 4xx from Auth (no SMTP, rate limit, refused address) is a definitive refusal; a 5xx or a lost answer stays uncertain.
 for(const[status,code,expected]of[[422,'ERP_USERS_INVITE_REFUSED',422],[400,'ERP_USERS_INVITE_REFUSED',422],[429,'ERP_USERS_INVITE_REFUSED',422],[500,'ERP_RESULT_UNCONFIRMED',503],[502,'ERP_RESULT_UNCONFIRMED',503]]){
  const seen=[];const failing=createHandler({fetchImpl:async url=>{seen.push(url);return url.endsWith('/auth/v1/user')?Response.json({id:ACTOR}):url.endsWith('/auth/v1/invite')?Response.json({code:status,msg:'PRIVATE'},{status}):Response.json(pending());}});
  const f=await failing(api(`${BASE}/convites`,invite),env);assert.equal(f.status,expected,String(status));const text=await f.text();assert.match(text,new RegExp(code));assert.doesNotMatch(text,/PRIVATE/);
  assert.equal(seen.some(u=>u.endsWith('erp_access_user_invite_complete')),false);}
});
