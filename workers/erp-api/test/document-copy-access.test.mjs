import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
const uid='a0000000-0000-4000-8000-000000000001',id='b0000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://exampleproject.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://erp.example.test'};
const base=`/v1/duplicacao-documentos/sales_proposals/${id}`;
const input={command_id:id,expected_source_version:3,data:{date:'2026-10-16',contact_id:uid,items:[{description:'Produto fictício',unit:'UN',quantity:'1',unit_price:'10'}]}};
const cases=[[base+'/preview','GET','erp_document_copy_preview'],[base+'/origin','GET','erp_document_copy_origin'],[base,'POST','erp_document_copy']];
const request=(path,options={})=>new Request(`https://api.example.test${path}`,options);
test('copy endpoints require authentication before RPC and allow only the exact preflight method',async()=>{
 let calls=0;const handler=createHandler({fetchImpl:async()=>{calls++;throw Error('unexpected');}});
 for(const[path,method]of cases){
  const denied=await handler(request(path,{method}),env);assert.equal(denied.status,401);assert.equal(denied.headers.get('Cache-Control'),'no-store');
  for(const candidate of ['GET','POST','PATCH','DELETE']){
   const result=await handler(request(path,{method:'OPTIONS',headers:{Origin:env.ALLOWED_ORIGINS,'Access-Control-Request-Method':candidate,'Access-Control-Request-Headers':'Authorization, Content-Type'}}),env);
   assert.equal(result.status,candidate===method?204:403);
  }
 }assert.equal(calls,0);
});
test('copy endpoints bind the actor to verified login and sanitize SQL errors',async()=>{
 for(const[path,method,rpc]of cases)for(const[code,status]of [['42501',403],['40001',409]]){
  const calls=[],handler=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/v1/user')?Response.json({id:uid}):Response.json({code,message:'PRIVATE_COPY_DETAIL'},{status:400});}});
  const result=await handler(request(path,{method,headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(input)}:{})}),env);
  assert.equal(result.status,status);assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith(`/rpc/${rpc}`));assert.equal(JSON.parse(calls[1].options.body).p_user_id,uid);assert.equal(calls[1].options.headers.Authorization,'Bearer synthetic-service-key');assert.doesNotMatch(await result.text(),/PRIVATE_COPY_DETAIL/);
 }
});
test('copy query parameters and additional actor input are rejected before RPC',async()=>{
 let calls=0;const handler=createHandler({fetchImpl:async()=>{calls++;return Response.json({id:uid});}});
 for(const[path,method,body]of [[base+'/preview?user_id='+uid,'GET'],[base+'/origin?version=1','GET'],[base,'POST',{...input,actor_id:uid}]]){
  const previous=calls,result=await handler(request(path,{method,headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env);
  assert.equal(result.status,400);assert.equal(calls-previous,1);
 }
});
