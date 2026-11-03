import test from'node:test';import assert from'node:assert/strict';
import{parsePreferencesRoute as parse,preferencesMethods,executePreferencesRoute}from'../src/preferences.mjs';
import{parseNotifications,parseStorage,parseProfile}from'../../../packages/erp-domain/src/system-profile.mjs';
import{createHandler}from'../src/index.mjs';
const ACTOR='10000000-0000-4000-8000-000000000151',TARGET='10000000-0000-4000-8000-000000000152',COMMAND='20000000-0000-4000-8000-000000000151',STAMP='2026-10-20T12:00:00.000000+00:00';
const req=(path,init)=>new Request('https://synthetic.invalid'+path,init);
const json=(path,body)=>req(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const view=(over={})=>({scope:'notifications',data_mode:'erp_native',tab:'nao_lidas',role:'admin',business_date:'2026-10-20',unread:1,
 items:[{id:'7',type:'contas_receber_atrasadas',day:'2026-10-20',quantity:2,amount:'125.00',created_at:STAMP,read:false}],...over});

test('151 strict /v1/sistema routes: fixed sub-routes, methods and bodies',async()=>{
 assert.deepEqual(preferencesMethods('/v1/sistema/perfil'),['GET']);assert.deepEqual(preferencesMethods('/v1/sistema/empresa-dados'),['GET','POST']);assert.deepEqual(preferencesMethods('/v1/sistema/notificacoes/lidas'),['POST']);
 assert.equal((await parse(req('/v1/sistema/perfil'))).rpc,'erp_access_profile_me');assert.deepEqual({...(await parse(req('/v1/sistema/notificacoes?aba=todas'))).args},{p_tab:'todas'});
 assert.deepEqual({...(await parse(req(`/v1/sistema/usuarios/${TARGET}/seguranca`))).args},{p_target:TARGET});
 const read=await parse(json('/v1/sistema/notificacoes/lidas',{command_id:COMMAND,ids:['7']}));assert.equal(read.mutation,true);assert.deepEqual(read.args.p_ids,['7']);
 for(const path of['/v1/sistema/perfil?x=1','/v1/sistema/notificacoes?aba=lidas','/v1/sistema/notificacoes?aba=todas&aba=todas'])await assert.rejects(()=>parse(req(path)),e=>e.status===400,path);
 for(const path of['/v1/sistema/outra','/v1/sistema/usuarios/x/seguranca','/v1/sistema'])await assert.rejects(()=>parse(req(path)),e=>e.status===404,path);
 for(const body of[{command_id:COMMAND,ids:[]},{command_id:COMMAND,ids:['0']},{command_id:'x',ids:null},{command_id:COMMAND,ids:null,extra:1}])
  await assert.rejects(()=>parse(json('/v1/sistema/notificacoes/lidas',body)),e=>e.status===400,JSON.stringify(body));
 await assert.rejects(()=>parse(json('/v1/sistema/empresa-dados',{command_id:COMMAND,expected_version:0,data:{segments:[]}})),e=>e.status===400);
 await assert.rejects(()=>parse(req('/v1/sistema/perfil',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})),e=>e.status===405);
});

test('151 projections fail closed',()=>{
 assert.equal(parseNotifications(view(),{tab:'nao_lidas'}).items.length,1);
 for(const mutate of[v=>v.items[0].type='pix',v=>v.items[0].amount=null,v=>v.items[0].read=true,v=>v.unread=5,v=>v.role='vendas',v=>v.tab='todas',v=>v.items[0].extra=1])
 {const v=view();mutate(v);assert.throws(()=>parseNotifications(v,{tab:'nao_lidas'}),undefined,String(mutate));}
 const storage={scope:'storage_usage',data_mode:'erp_native',total_bytes:'10',objects:1,limit_bytes:null,groups:['anexos','fiscal','cobranca','backup','certificado','outros'].map((group,i)=>({group,bytes:i?'0':'10',objects:i?0:1})),as_of:STAMP};
 assert.equal(parseStorage(storage).total_bytes,'10');assert.throws(()=>parseStorage({...storage,total_bytes:'11'}));// 188: the limit set in Espaço e armazenamento; never zero.
 assert.equal(parseStorage({...storage,limit_bytes:'100'}).limit_bytes,'100');assert.throws(()=>parseStorage({...storage,limit_bytes:'0'}));assert.throws(()=>parseStorage({...storage,limit_bytes:100}));
 assert.throws(()=>parseProfile({scope:'access_profile',data_mode:'erp_native',user_id:ACTOR,role:'root',name:null,email:null,company:null}));
});

const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-151',ALLOWED_ORIGINS:'https://erp.synthetic.test'},headers={Authorization:'Bearer synthetic-token',Origin:'https://erp.synthetic.test'};
test('151 composed handler binds the token actor; a lost read command is ERP_RESULT_UNCONFIRMED',async()=>{
 const calls=[],h=createHandler({fetchImpl:async(url,o)=>{calls.push({url,o});return Response.json(url.endsWith('/auth/v1/user')?{id:ACTOR}:view());}});
 const r=await h(new Request('https://api.synthetic.test/v1/sistema/notificacoes',{headers}),env);assert.equal(r.status,200);
 assert.ok(calls[1].url.endsWith('/rest/v1/rpc/erp_home_notifications'));assert.deepEqual(JSON.parse(calls[1].o.body),{p_tab:'nao_lidas',p_user_id:ACTOR});
 const route=await parse(json('/v1/sistema/notificacoes/lidas',{command_id:COMMAND,ids:null}));
 await assert.rejects(()=>executePreferencesRoute(route,{userId:ACTOR,rpc:async()=>{throw new TypeError('network');}}),e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED');
});
