import test from'node:test';import assert from'node:assert/strict';
import{parsePreferencesRoute as parse,executePreferencesRoute as execute,preferencesMethods}from'../src/preferences.mjs';
import{parseListPreferences,parseListPreferencesResult}from'../../../packages/erp-domain/src/list-preferences.mjs';
import{createHandler}from'../src/index.mjs';
const ACTOR='10000000-0000-4000-8000-000000000116',COMMAND='20000000-0000-4000-8000-000000000116',STAMP='2026-10-20T12:00:00.000000+00:00',BASE='/v1/preferencias-listas',LIST='documentos.sales_orders';
const req=(path,body,init={})=>new Request('https://synthetic.invalid'+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'content-type':'application/json'},body:typeof body==='string'?body:JSON.stringify(body)}),...init});
const view=(v=0,columns=null,filters=null)=>({scope:'list_preferences',data_mode:'erp_native',list_id:LIST,version:v,columns,filters,updated_at:v?STAMP:null});
const input=(extra={})=>({command_id:COMMAND,expected_version:0,columns:['numero','total'],filters:{periodo:'30d'},...extra});
const result=(sent=input(),{replayed=false}={})=>({scope:'list_preferences_command',data_mode:'erp_native',replayed,receipt:{command_id:sent.command_id,list_id:LIST,from_version:sent.expected_version,to_version:sent.expected_version+1,changed_at:STAMP},preference:view(sent.expected_version+1,sent.columns,sent.filters)});

test('116 closed routes and exact bodies',async()=>{
 assert.deepEqual(preferencesMethods(`${BASE}/${LIST}`),['GET','POST']);assert.deepEqual(preferencesMethods(`${BASE}/comandos/${COMMAND}`),['GET']);
 assert.deepEqual({...(await parse(req(`${BASE}/${LIST}`))).args},{p_list_id:LIST});
 const saved=await parse(req(`${BASE}/${LIST}`,input()));assert.deepEqual({...saved.args},{p_list_id:LIST,p_command_id:COMMAND,p_expected_version:0,p_columns:['numero','total'],p_filters:{periodo:'30d'}});
 for(const path of[BASE,`${BASE}/Documentos`,`${BASE}/a..b`,`${BASE}/comandos`,`${BASE}/comandos/x`])await assert.rejects(()=>parse(req(path)),e=>[404,405].includes(e.status),path);
 for(const body of[input({extra:1}),input({columns:[]}),input({columns:['A']}),input({columns:['a','a']}),input({filters:{a:{b:1}}}),input({filters:{a:null}}),input({expected_version:-1}),input({command_id:'x'}),{command_id:COMMAND}])
  await assert.rejects(()=>parse(req(`${BASE}/${LIST}`,body)),e=>e.status===400,JSON.stringify(body));
 await assert.rejects(()=>parse(req(`${BASE}/${LIST}?x=1`)),e=>e.status===400);
});
test('116 DTOs: the receipt must be the captured body and the projection exact',()=>{
 assert.equal(parseListPreferences(view(),LIST).version,0);assert.equal(parseListPreferences(view(3),LIST).columns,null);
 for(const bad of[{...view(),extra:1},{...view(),columns:['a']},{...view(1,['A'])},{...view(1,['a']),updated_at:null},{...view(),list_id:'outra'}])assert.throws(()=>parseListPreferences(bad,LIST));
 assert.equal(parseListPreferencesResult(result(),{commandId:COMMAND,listId:LIST,input:input()}).preference.version,1);
 for(const mutate of[r=>r.preference.columns=['numero'],r=>r.receipt.from_version=1,r=>r.receipt.to_version=3,r=>r.receipt.command_id=ACTOR,r=>r.preference.version=0,r=>r.receipt.list_id='outra'])
 {const r=result();mutate(r);assert.throws(()=>parseListPreferencesResult(r,{commandId:COMMAND,listId:LIST,input:input()}),undefined,String(mutate));}
 assert.throws(()=>parseListPreferencesResult(result(),{commandId:COMMAND,lookup:true}));
});
const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-116',ALLOWED_ORIGINS:'https://erp.synthetic.test'},headers={Authorization:'Bearer synthetic-token',Origin:'https://erp.synthetic.test'};
const api=(path,body)=>new Request('https://api.synthetic.test'+path,{method:body===undefined?'GET':'POST',headers:{...headers,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
test('116 real API: fixed RPC per route, actor from the token, unconfirmed save after a lost answer',async()=>{
 for(const[path,body,name,value]of[[`${BASE}/${LIST}`,undefined,'erp_list_preferences_get',view()],[`${BASE}/${LIST}`,input(),'erp_list_preferences_save',result()],[`${BASE}/comandos/${COMMAND}`,undefined,'erp_list_preferences_command',result(input(),{replayed:true})]]){
  const calls=[],h=createHandler({fetchImpl:async(url,o)=>{calls.push({url,o});return Response.json(url.endsWith('/auth/v1/user')?{id:ACTOR}:value);}}),r=await h(api(path,body),env);
  assert.equal(r.status,200,path);assert.ok(calls[1].url.endsWith('/rest/v1/rpc/'+name));assert.equal(JSON.parse(calls[1].o.body).p_user_id,ACTOR);}
 const lost=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:ACTOR}):Response.json({...result(),extra:1})});
 const r=await lost(api(`${BASE}/${LIST}`,input()),env);assert.equal(r.status,503);assert.equal((await r.json()).error.code,'ERP_RESULT_UNCONFIRMED');
 const conflict=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:ACTOR}):Response.json({code:'40001',message:'PRIVATE'},{status:409})});
 const c=await conflict(api(`${BASE}/${LIST}`,input()),env);assert.equal(c.status,409);assert.doesNotMatch(await c.text(),/PRIVATE/);
 const read=await parse(req(`${BASE}/${LIST}`));await assert.rejects(()=>execute(read,{userId:ACTOR,rpc:()=>new Promise(()=>{}),timeoutMs:5}),e=>e.status===408);
});
