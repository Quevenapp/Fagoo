import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
const uid='a0000000-0000-4000-8000-000000000001',id='b0000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://exampleproject.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://erp.example.test'};
const base=`/v1/preparacao-itens-fiscais/${id}`,input={expected_draft_version:1,snapshot_hash:'a'.repeat(64),expected_version:0,decisions:[]};
const cases=[[base,'GET','erp_fiscal_item_get',null],[base+'/history','GET','erp_fiscal_item_history',null],[base+'/preview','POST','erp_fiscal_item_preview',input],[base,'POST','erp_fiscal_item_save',{...input,command_id:id}]];
const request=(path,options={})=>new Request(`https://api.example.test${path}`,options);
test('fiscal preparation endpoints authenticate before RPC and keep exact CORS methods',async()=>{
 let calls=0;const handler=createHandler({fetchImpl:async()=>{calls++;throw Error('unexpected');}});
 for(const[path,method]of cases){
  assert.equal((await handler(request(path,{method}),env)).status,401);
  for(const candidate of ['GET','POST','PATCH','DELETE']){
   const expected=path===base?['GET','POST']:[method];
   const result=await handler(request(path,{method:'OPTIONS',headers:{Origin:env.ALLOWED_ORIGINS,'Access-Control-Request-Method':candidate,'Access-Control-Request-Headers':'Authorization, Content-Type'}}),env);
   assert.equal(result.status,expected.includes(candidate)?204:403);assert.equal(result.headers.get('Cache-Control'),'no-store');
  }
 }assert.equal(calls,0);
});
test('fiscal preparation binds verified actor and sanitizes database rejection/conflict',async()=>{
 for(const[path,method,rpc,body]of cases)for(const[code,status]of [['42501',403],['40001',409],['22023',400]]){
  const calls=[],handler=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/v1/user')?Response.json({id:uid}):Response.json({code,message:'PRIVATE_PREPARATION'},{status:400});}});
  const result=await handler(request(path,{method,headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env);
  assert.equal(result.status,status);assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith(`/rpc/${rpc}`));assert.equal(JSON.parse(calls[1].options.body).p_user_id,uid);assert.equal(calls[1].options.headers.Authorization,'Bearer synthetic-service-key');assert.doesNotMatch(await result.text(),/PRIVATE_PREPARATION/);
 }
});
test('fiscal preparation rejects extra fields and query options without reaching a business RPC',async()=>{
 let calls=0;const handler=createHandler({fetchImpl:async()=>{calls++;return Response.json({id:uid});}});
 for(const[path,method,body]of [[base+'?actor='+uid,'GET'],[base+'/history?limit=26','GET'],[base+'/preview','POST',{...input,actor_id:uid}],[base,'POST',{...input,command_id:id,emit:true}]]){
  const previous=calls,result=await handler(request(path,{method,headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env);
  assert.equal(result.status,400);assert.equal(calls-previous,1);
 }
});
