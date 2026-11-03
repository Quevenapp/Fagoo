import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
const uid='a0000000-0000-4000-8000-000000000001',id='b0000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://erp.example.test'};
const base='/v1/retornos-operacionais';
const proof={file_id:id,line:2},confirmation={...proof,command_id:id,expected_approval_version:1,context_hash:'a'.repeat(64),confirm:true};
const cases=[
 [base+'/files','GET','erp_cnab_operational_files'],
 [base+'/files','POST','erp_cnab_operational_return_profile',{profile_id:id,expected_approval_version:1,command_id:id,file_base64:Buffer.from('SYNTHETIC').toString('base64'),obtained_from_bank:true,reference_id:'QA001'}],
 [base+`/files/${id}/events`,'GET','erp_cnab_operational_events'],
 [base+`/files/${id}/download`,'GET','erp_cnab_operational_return_file'],
 [base+`/events/${id}?file_id=${id}&line=2`,'GET','erp_cnab_operational_event'],
 [base+`/events/${id}/preview`,'POST','erp_cnab_operational_return_verify',proof],
 [base+`/events/${id}/bind`,'POST','erp_cnab_operational_return_verify',confirmation],
 [base+`/events/${id}/settle`,'POST','erp_cnab_operational_return_verify',confirmation],
 [base+`/settlements/${id}`,'GET','erp_cnab_operational_settlement_get'],
];
const req=(path,options={})=>new Request('https://api.example.test'+path,options);
test('043 boundary authenticates all routes and limits CORS to exact methods and origin',async()=>{
 let calls=0;const handler=createHandler({fetchImpl:async()=>{calls++;throw Error('unexpected');}});
 for(const[path,method]of cases){
  assert.equal((await handler(req(path,{method}),env)).status,401);
  for(const candidate of ['GET','POST','PATCH','DELETE']){
   const allowed=path===base+'/files'?['GET','POST']:[method];
   const r=await handler(req(path,{method:'OPTIONS',headers:{Origin:env.ALLOWED_ORIGINS,'Access-Control-Request-Method':candidate,'Access-Control-Request-Headers':'authorization,content-type'}}),env);
   assert.equal(r.status,allowed.includes(candidate)?204:403);assert.equal(r.headers.get('Cache-Control'),'no-store');
  }
 }
 assert.equal((await handler(req(base+'/profiles',{headers:{Origin:'https://other.example.test'}}),env)).status,403);
 assert.equal(calls,0);
});
test('043 boundary binds verified actor and maps SQL failures without leaking private diagnostics',async()=>{
 for(const[path,method,rpc,body]of cases)for(const[code,status]of [['42501',403],['40001',409],['22023',400]]){
  const calls=[],handler=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/v1/user')?Response.json({id:uid}):Response.json({code,message:'PRIVATE_BANK_CONTEXT'},{status:400});}});
  const r=await handler(req(path,{method,headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env);
  assert.equal(r.status,status);assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith('/rpc/'+rpc));
  assert.equal(JSON.parse(calls[1].options.body).p_user_id,uid);assert.doesNotMatch(await r.text(),/PRIVATE_BANK_CONTEXT/);
 }
});
test('043 boundary refuses client money, account, actor and non-JSON body before financial RPC',async()=>{
 let calls=0;const handler=createHandler({fetchImpl:async()=>{calls++;return Response.json({id:uid});}});
 for(const extra of [{actor:uid},{account_id:id},{principal_cents:'12345'},{posted_on:'2026-10-16'},{path:'foreign/file'}]){
  const before=calls,r=await handler(req(base+`/events/${id}/settle`,{method:'POST',headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'},body:JSON.stringify({...confirmation,...extra})}),env);
  assert.equal(r.status,400);assert.equal(calls-before,1);
 }
});
