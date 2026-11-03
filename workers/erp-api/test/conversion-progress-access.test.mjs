import test from 'node:test';import assert from 'node:assert/strict';import {createHandler} from '../src/index.mjs';
const uid='a0000000-0000-4000-8000-000000000001',id='b0000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://exampleproject.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://erp.example.test'};
const request=(path,options={})=>new Request(`https://api.example.test${path}`,options);
const conversion=`/v1/documentos/sales_proposals/${id}/convert-service`,progress='/v1/integracao-origin';
test('conversion and progress demand authentication before RPC and expose exact methods',async()=>{
 let calls=0;const handle=createHandler({fetchImpl:async()=>{calls++;throw Error('unexpected');}});
 for(const[path,method]of [[conversion,'POST'],[progress,'GET']]){
  assert.equal((await handle(request(path,{method}),env)).status,401);
  for(const candidate of ['GET','POST','PATCH','DELETE']){const response=await handle(request(path,{method:'OPTIONS',headers:{Origin:env.ALLOWED_ORIGINS,'Access-Control-Request-Method':candidate,'Access-Control-Request-Headers':'Authorization, Content-Type'}}),env);assert.equal(response.status,candidate===method?204:403);assert.equal(response.headers.get('Cache-Control'),'no-store');}
 }assert.equal(calls,0);
});
test('conversion and progress bind actor to verified login and sanitize database conflicts/denials',async()=>{
 for(const[path,rpc,options]of [[conversion,'erp_proposal_convert_to_service',{method:'POST',body:JSON.stringify({command_id:id,expected_version:3})}],[progress,'erp_origin_progress',{}]])for(const[code,status]of [['42501',403],['40001',409]]){
  const calls=[],handle=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/v1/user')?Response.json({id:uid}):Response.json({code,message:'private-detail'},{status:400});}});
  const response=await handle(request(path,{...options,headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'}}),env);
  assert.equal(response.status,status);assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith(`/rpc/${rpc}`));assert.equal(JSON.parse(calls[1].options.body).p_user_id,uid);assert.equal(calls[1].options.headers.Authorization,'Bearer synthetic-service-key');assert.doesNotMatch(await response.text(),/private-detail/);
 }
});
test('authenticated malformed conversion/progress cannot fall through generic document/list parser',async()=>{
 let calls=0;const handle=createHandler({fetchImpl:async()=>{calls++;return Response.json({id:uid});}});
 for(const[path,options]of [[conversion+'?q=x',{method:'POST',body:'{}'}],[conversion,{method:'POST',body:JSON.stringify({command_id:id,expected_version:3,actor_id:id})}],[progress+'?token=x',{}]]){
  const before=calls,response=await handle(request(path,{...options,headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'}}),env);assert.equal(response.status,400);assert.equal(calls-before,1);
 }
});
