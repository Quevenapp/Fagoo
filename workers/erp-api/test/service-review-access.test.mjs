import test from 'node:test';import assert from 'node:assert/strict';import {createHandler} from '../src/index.mjs';
const uid='a0000000-0000-4000-8000-000000000001',id='b0000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://exampleproject.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://erp.example.test'};
const request=(path,options={})=>new Request(`https://api.example.test${path}`,options);
test('service journal and fiscal review require login and advertise only exact methods',async()=>{
 let calls=0;const handle=createHandler({fetchImpl:async()=>{calls++;throw Error('unexpected');}});
 for(const[path,methods]of [[`/v1/ordens-servico/${id}/diario`,['GET','POST']],[`/v1/ordens-servico/${id}/diario/${id}`,['GET']],[`/v1/rascunhos-fiscais/${id}/conferencia?revision=1`,['GET']]]){
  assert.equal((await handle(request(path),env)).status,401);
  for(const method of ['GET','POST','PATCH','DELETE']){const r=await handle(request(path,{method:'OPTIONS',headers:{Origin:'https://erp.example.test','Access-Control-Request-Method':method,'Access-Control-Request-Headers':'Authorization, Content-Type'}}),env);assert.equal(r.status,methods.includes(method)?204:403);assert.equal(r.headers.get('Cache-Control'),'no-store');}
 }assert.equal(calls,0);
});
test('journal and review bind service RPC identity to verified auth and sanitize refusals',async()=>{
 for(const[path,rpc,options]of [[`/v1/ordens-servico/${id}/diario`,'erp_service_journal_list',{}],[`/v1/ordens-servico/${id}/diario/${id}`,'erp_service_journal_get',{}],[`/v1/ordens-servico/${id}/diario`,'erp_service_journal_append',{method:'POST',body:JSON.stringify({command_id:id,expected_document_version:1,text:'Atividade fictícia'})}],[`/v1/rascunhos-fiscais/${id}/conferencia?revision=1`,'erp_fiscal_draft_review',{}]]){
  const calls=[],handle=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/v1/user')?Response.json({id:uid}):Response.json({code:'42501',message:'private-detail'},{status:403});}});
  const response=await handle(request(path,{...options,headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'}}),env);assert.equal(response.status,403);assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith(`/rpc/${rpc}`));assert.equal(JSON.parse(calls[1].options.body).p_user_id,uid);assert.equal(calls[1].options.headers.Authorization,'Bearer synthetic-service-key');assert.doesNotMatch(await response.text(),/private-detail/);
 }
});
