import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
const uid='a0000000-0000-4000-8000-000000000001',command='b0000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://erp.example.test'};
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const item={source_id:'90071992547409931234',source_hash:'a'.repeat(64)};
const post=(suffix,data,headers={})=>new Request(`https://api.example.test/v1/importacao-cadastros/contacts/${suffix}`,{method:'POST',headers:{Authorization:'Bearer synthetic-token','Content-Type':'application/json',Origin:'https://erp.example.test',...headers},body:JSON.stringify(data)});
test('reviewed import uses verified actor, source hash, plan hash and explicit command only',async()=>{
 const calls=[];const handler=createHandler({fetchImpl:async(url,init)=>{calls.push({url,init});if(url.endsWith('/auth/v1/user'))return response({id:uid,is_anonymous:false,user_metadata:{role:'admin'}});return response({entity:'contacts',items:[{...item,source_version:'1',record_id:uid,action:'create'}],preview_hash:'b'.repeat(64),dry_run:false,replayed:false,data_mode:'erp_native',operational_effects:false,raw:'PRIVATE'});}});
 const result=await handler(post('apply',{items:[item],preview_hash:'b'.repeat(64),command_id:command}),env);assert.equal(result.status,200);
 assert.ok(calls[1].url.endsWith('/erp_catalog_import_apply'));assert.deepEqual(JSON.parse(calls[1].init.body),{p_entity:'contacts',p_items:[item],p_command_id:command,p_preview_hash:'b'.repeat(64),p_user_id:uid});
 assert.doesNotMatch(await result.text(),/PRIVATE|synthetic-service|user_metadata/);assert.equal(calls[1].init.headers.Authorization,'Bearer synthetic-service-key');
});
test('import does not trust user metadata or caller actor and denied membership remains a sanitized403',async()=>{
 let rpcCalls=0;const handler=createHandler({fetchImpl:async url=>{if(url.endsWith('/user'))return response({id:uid,user_metadata:{role:'admin'}});rpcCalls++;return response({code:'42501',message:'PRIVATE SQL and data'},403);}});
 const denied=await handler(post('preview',{items:[item]}),env);assert.equal(denied.status,403);assert.doesNotMatch(await denied.text(),/PRIVATE|SQL/);
 const forged=await handler(post('preview',{items:[item],actor:uid}),env);assert.equal(forged.status,400);assert.equal(rpcCalls,1);
 const unauthorized=await handler(post('preview',{items:[item]},{Authorization:''}),env);assert.equal(unauthorized.status,401);assert.equal(rpcCalls,1);
});
test('plan conflicts are409 and unsafe origins or methods cannot reach import mutation',async()=>{
 let calls=0;const handler=createHandler({fetchImpl:async url=>{calls++;return url.endsWith('/user')?response({id:uid}):response({code:'40001',message:'PRIVATE hash mismatch'},400);}});
 const conflict=await handler(post('apply',{items:[item],preview_hash:'b'.repeat(64),command_id:command}),env);assert.equal(conflict.status,409);assert.doesNotMatch(await conflict.text(),/PRIVATE|hash mismatch/);
 const blocked=await handler(post('preview',{items:[item]},{Origin:'https://other.example.test'}),env);assert.equal(blocked.status,403);assert.equal(calls,2);
 const preflight=await handler(new Request('https://api.example.test/v1/importacao-cadastros/contacts/preview',{method:'OPTIONS',headers:{Origin:'https://erp.example.test','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'}}),env);assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Methods'),'POST');
 const noDelete=await handler(new Request('https://api.example.test/v1/importacao-cadastros/contacts',{method:'DELETE',headers:{Authorization:'Bearer synthetic-token'}}),env);assert.equal(noDelete.status,405);assert.equal(calls,2);
});
