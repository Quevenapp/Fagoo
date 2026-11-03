import test from 'node:test';import assert from 'node:assert/strict';import {createHandler} from '../src/index.mjs';
const uid='a0000000-0000-4000-8000-000000000001',id='b0000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://exampleproject.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://erp.example.test'};
const request=(path,options={})=>new Request(`https://api.example.test${path}`,options);
test('report and archive boundaries require login and never advertise mutation',async()=>{
 let calls=0;const handle=createHandler({fetchImpl:async()=>{calls++;throw Error('unexpected');}});
 for(const path of ['/v1/relatorios/vencimentos','/v1/xmls-sincronizados',`/v1/xmls-sincronizados/${id}/download`]){
  const denied=await handle(request(path),env);assert.equal(denied.status,401);assert.equal(denied.headers.get('Cache-Control'),'no-store');
  for(const [method,status] of [['GET',204],['POST',403]])assert.equal((await handle(request(path,{method:'OPTIONS',headers:{Origin:'https://erp.example.test','Access-Control-Request-Method':method,'Access-Control-Request-Headers':'Authorization'}}),env)).status,status);
  assert.equal((await handle(request(path,{method:'POST'}),env)).status,405);
 }assert.equal(calls,0);
});
test('each new read sends only authenticated identity to its service RPC and sanitizes refusal',async()=>{
 for(const [path,rpc] of [['/v1/relatorios/vencimentos?from=2026-10-16&to=2026-10-16','erp_finance_due_report'],['/v1/xmls-sincronizados?model=65','erp_synced_xml_list'],[`/v1/xmls-sincronizados/${id}/download`,'erp_synced_xml_object']]){
  const calls=[];const handle=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/v1/user')?Response.json({id:uid}):Response.json({code:'42501',message:'private-detail'},{status:403});}});
  const response=await handle(request(path,{headers:{Authorization:'Bearer synthetic'}}),env);assert.equal(response.status,403);assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith(`/rpc/${rpc}`));assert.equal(JSON.parse(calls[1].options.body).p_user_id,uid);assert.doesNotMatch(await response.text(),/private-detail/);
 }
});
