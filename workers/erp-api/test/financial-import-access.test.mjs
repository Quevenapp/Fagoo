import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
const uid='a0000000-0000-4000-8000-000000000001',id='b0000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://exampleproject.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://erp.example.test'};
const item={source_id:'00123',source_hash:'a'.repeat(64),source_version:'1',source_seen_at:'2026-10-16T09:00:00+00:00',category_id:null,category_version:null};
const base={entity:'receivables',duplicate_reviewed:true,items:[item]};
const cases=[['/preview','POST','erp_origin_financial_import_preview',base],['/apply','POST','erp_origin_financial_import_apply',{...base,command_id:id,preview_hash:'b'.repeat(64),confirm_import:true}],['/batches/'+id,'GET','erp_origin_financial_import_batch'],['/origins/payables/00123','GET','erp_origin_financial_import_origin'],['/titles/'+id+'/origin','GET','erp_origin_financial_import_title_origin']];
const request=(suffix,options={})=>new Request(`https://api.example.test/v1/importacao-financeira-origin${suffix}`,options);
test('039 root boundary authenticates every operation and exposes only each route method in CORS',async()=>{
 let calls=0;const handler=createHandler({fetchImpl:async()=>{calls++;throw Error('unexpected');}});
 for(const[path,method]of cases){
  assert.equal((await handler(request(path,{method}),env)).status,401);
  for(const candidate of ['GET','POST','PATCH','DELETE']){
   const response=await handler(request(path,{method:'OPTIONS',headers:{Origin:env.ALLOWED_ORIGINS,'Access-Control-Request-Method':candidate,'Access-Control-Request-Headers':'Authorization, Content-Type'}}),env);
   assert.equal(response.status,candidate===method?204:403);assert.equal(response.headers.get('Cache-Control'),'no-store');
  }
 }assert.equal(calls,0);
});
test('039 root binds authenticated actor and sanitizes authorization, conflict and validation errors',async()=>{
 for(const[path,method,rpc,body]of cases)for(const[code,status]of [['42501',403],['P0002',404],['22023',400],['40001',409],['23505',409]]){
  const calls=[],handler=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/v1/user')?Response.json({id:uid}):Response.json({code,message:'PRIVATE_IMPORT_ROW'},{status:400});}});
  const response=await handler(request(path,{method,headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env);
  assert.equal(response.status,status);assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith(`/rpc/${rpc}`));assert.equal(JSON.parse(calls[1].options.body).p_user_id,uid);assert.equal(calls[1].options.headers.Authorization,'Bearer synthetic-service-key');assert.doesNotMatch(await response.text(),/PRIVATE_IMPORT_ROW/);
 }
});
test('039 root authenticates before parsing writes and rejects extra actor or ambiguous requests before RPC',async()=>{
 let calls=0;const handler=createHandler({fetchImpl:async()=>{calls++;return Response.json({id:uid});}});
 for(const body of [{...base,p_user_id:uid},{...base,duplicate_reviewed:false},{...base,items:[item,item]},{...base,items:[{...item,category_version:2}]},{...base,items:[{...item,source_version:1}]}]){
  const before=calls,response=await handler(request('/preview',{method:'POST',headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'},body:JSON.stringify(body)}),env);assert.equal(response.status,400);assert.equal(calls-before,1);
 }
});
