import test from 'node:test';import assert from 'node:assert/strict';import {createHandler} from '../src/index.mjs';
const user='a0000000-0000-4000-8000-000000000001',id='b0000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://exampleproject.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://erp.example.test'};
const req=(path,options={})=>new Request(`https://api.example.test${path}`,options);
test('024/025 HTTP boundary requires bearer, allows exact preflights and forbids stock mutations',async()=>{
 let calls=0;const handle=createHandler({fetchImpl:async()=>{calls++;throw Error('unexpected');}});
 for(const path of ['/v1/posicoes-estoque','/v1/posicoes-estoque/depositos',`/v1/conferencia-retornos/files/${id}`]){const response=await handle(req(path),env);assert.equal(response.status,401);assert.equal(response.headers.get('Cache-Control'),'no-store');}
 for(const [path,method,expected] of [['/v1/posicoes-estoque','GET',204],['/v1/posicoes-estoque','POST',403],[`/v1/conferencia-retornos/events/${id}/review`,'POST',204],[`/v1/conferencia-retornos/events/${id}/review`,'GET',403]]){
  assert.equal((await handle(req(path,{method:'OPTIONS',headers:{Origin:'https://erp.example.test','Access-Control-Request-Method':method,'Access-Control-Request-Headers':'Authorization, Content-Type'}}),env)).status,expected);
 }
 assert.equal((await handle(req('/v1/posicoes-estoque',{method:'POST'}),env)).status,405);assert.equal(calls,0);
});
test('stock route sends authenticated identity into only service RPC and maps permission failures safely',async()=>{
 const calls=[];const handle=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/v1/user')?Response.json({id:user}):Response.json({code:'42501',message:'private-membership-details'},{status:403});}});
 const result=await handle(req('/v1/posicoes-estoque',{headers:{Authorization:'Bearer synthetic'}}),env);assert.equal(result.status,403);assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith('/rpc/erp_stock_positions'));assert.equal(JSON.parse(calls[1].options.body).p_user_id,user);assert.doesNotMatch(await result.text(),/private-membership/);
});
