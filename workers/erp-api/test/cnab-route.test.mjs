import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
const user='a0000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://erp.example.test'};
const req=(path,options={})=>new Request(`https://api.example.test${path}`,{headers:{Authorization:'Bearer synthetic-user'},...options});
test('CNAB authenticates before parsing upload and strips access RPC private fields',async()=>{
  const calls=[];const handler=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/user')?{id:user}:{read:true,write:false,configure:false,secret:'hidden'});}});
  assert.equal((await handler(req('/v1/cnab/returns',{method:'POST',headers:{},body:'invalid'}),env)).status,401);assert.equal(calls.length,0);
  const response=await handler(req('/v1/cnab'),env);assert.equal(response.status,200);const body=await response.json();assert.equal(body.productionReady,false);assert.equal(body.financialMutationPerformed,false);assert.equal(body.secret,undefined);assert.equal(JSON.parse(calls[1].options.body).p_user_id,user);
  const denied=await handler(req('/v1/cnab',{headers:{Origin:'https://evil.example.test'}}),env);assert.equal(denied.status,403);
  const preflight=await handler(req('/v1/cnab/remittances/preview',{method:'OPTIONS',headers:{Origin:'https://erp.example.test','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Authorization, Content-Type'}}),env);assert.equal(preflight.status,204);
});
test('CNAB database errors are sanitized and mapped to RBAC/conflict responses',async()=>{
  for(const[code,status]of[['42501',403],['40001',409],['22023',400],['P0002',404]]){const handler=createHandler({fetchImpl:async url=>url.endsWith('/user')?Response.json({id:user}):Response.json({code,message:'private details'},{status:400})});const result=await handler(req('/v1/cnab'),env);assert.equal(result.status,status);assert.doesNotMatch(await result.text(),/private details/);}
});
