import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
const uid='a0000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://exampleproject.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://erp.example.test'};
const cases=[['/v1/conferencia-financeira-origin?entity=receivables','erp_cutover_financial_list'],['/v1/conferencia-financeira-origin/payables/00123','erp_cutover_financial_get']];
const request=(path,options={})=>new Request(`https://api.example.test${path}`,options);
test('financial source review authenticates and exposes GET-only preflight without upstream calls',async()=>{
 let calls=0;const handler=createHandler({fetchImpl:async()=>{calls++;throw Error('unexpected');}});
 for(const[path]of cases){
  assert.equal((await handler(request(path),env)).status,401);
  for(const method of ['GET','POST','PATCH','DELETE']){
   const result=await handler(request(path,{method:'OPTIONS',headers:{Origin:env.ALLOWED_ORIGINS,'Access-Control-Request-Method':method,'Access-Control-Request-Headers':'Authorization, Content-Type'}}),env);
   assert.equal(result.status,method==='GET'?204:403);assert.equal(result.headers.get('Cache-Control'),'no-store');
  }
  assert.equal((await handler(request(path,{method:'POST'}),env)).status,405);
 }assert.equal(calls,0);
});
test('financial source review binds authenticated actor and sanitizes ACL/missing/invalid rejection',async()=>{
 for(const[path,rpc]of cases)for(const[code,status]of [['42501',403],['P0002',404],['22023',400]]){
  const calls=[],handler=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/v1/user')?Response.json({id:uid}):Response.json({code,message:'PRIVATE_FINANCIAL_ROW'},{status:400});}});
  const result=await handler(request(path,{headers:{Authorization:'Bearer synthetic'}}),env);
  assert.equal(result.status,status);assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith(`/rpc/${rpc}`));assert.equal(JSON.parse(calls[1].options.body).p_user_id,uid);assert.equal(calls[1].options.headers.Authorization,'Bearer synthetic-service-key');assert.doesNotMatch(await result.text(),/PRIVATE_FINANCIAL_ROW/);
 }
});
test('financial source review validates query after authentication and before business RPC',async()=>{
 let calls=0;const handler=createHandler({fetchImpl:async()=>{calls++;return Response.json({id:uid});}});
 for(const query of ['entity=contacts','entity=receivables&limit=26','entity=payables&actor_id='+uid,'entity=payables&entity=receivables','entity=payables&from=2025-02-29']){
  const before=calls,result=await handler(request('/v1/conferencia-financeira-origin?'+query,{headers:{Authorization:'Bearer synthetic'}}),env);
  assert.equal(result.status,400);assert.equal(calls-before,1);
 }
});
