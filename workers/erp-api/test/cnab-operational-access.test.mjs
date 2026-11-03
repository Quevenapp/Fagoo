import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
const uid='a0000000-0000-4000-8000-000000000001',id='b0000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://erp.example.test'};
const base='/v1/cobranca-operacional';
const generation={command_id:id,profile_id:id,expected_version:1,expected_approval_version:1,generated_on:'2026-10-16',titles:[{title_id:id,expected_version:1,document_number:'QA001'}],confirm_operational:false};
const cases=[
 [base+'/profiles','GET','erp_cnab_operational_profiles'],
 [base+`/profiles/${id}/approval`,'POST','erp_cnab_operational_approve',{command_id:id,expected_approval_version:0,expected_profile_version:1,expected_identity_version:1,enabled:true,confirmed_on:'2026-10-16',reference:'Referência sintética'}],
 [base+'/remittances/preview','POST','erp_cnab_operational_reserve',generation],
 [base+'/remittances','POST','erp_cnab_operational_reserve',{...generation,confirm_operational:true,preview_hash:'a'.repeat(64)}],
 [base+'/remittances','GET','erp_cnab_operational_files'],
 [base+`/remittances/${id}/resume`,'POST','erp_cnab_operational_reservation',{expected_approval_version:1}],
 [base+`/files/remittance/${id}`,'GET','erp_cnab_operational_file'],
];
const req=(path,options={})=>new Request('https://api.example.test'+path,options);
test('042 boundary authenticates all routes and limits CORS to exact methods and origin',async()=>{
 let calls=0;const handler=createHandler({fetchImpl:async()=>{calls++;throw Error('unexpected');}});
 for(const[path,method]of cases){
  assert.equal((await handler(req(path,{method}),env)).status,401);
  for(const candidate of ['GET','POST','PATCH','DELETE']){
   const allowed=path===base+'/remittances'?['GET','POST']:[method];
   const r=await handler(req(path,{method:'OPTIONS',headers:{Origin:env.ALLOWED_ORIGINS,'Access-Control-Request-Method':candidate,'Access-Control-Request-Headers':'authorization,content-type'}}),env);
   assert.equal(r.status,allowed.includes(candidate)?204:403);assert.equal(r.headers.get('Cache-Control'),'no-store');
  }
 }
 assert.equal((await handler(req(base+'/profiles',{headers:{Origin:'https://other.example.test'}}),env)).status,403);
 assert.equal(calls,0);
});
test('042 boundary binds verified actor and maps SQL failures without leaking private diagnostics',async()=>{
 for(const[path,method,rpc,body]of cases)for(const[code,status]of [['42501',403],['40001',409],['22023',400]]){
  const calls=[],handler=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/v1/user')?Response.json({id:uid}):Response.json({code,message:'PRIVATE_BANK_CONTEXT'},{status:400});}});
  const r=await handler(req(path,{method,headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env);
  assert.equal(r.status,status);assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith('/rpc/'+rpc));
  assert.equal(JSON.parse(calls[1].options.body).p_user_id,uid);assert.doesNotMatch(await r.text(),/PRIVATE_BANK_CONTEXT/);
 }
});
test('042 boundary refuses client actor, Storage path, missing preview hash and non-JSON body before RPC',async()=>{
 let calls=0;const handler=createHandler({fetchImpl:async()=>{calls++;return Response.json({id:uid});}});
 for(const body of [{...generation,actor:uid},{...generation,path:'foreign/file'},{...generation,confirm_operational:true}]){
  const before=calls,r=await handler(req(base+'/remittances',{method:'POST',headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'},body:JSON.stringify(body)}),env);
  assert.equal(r.status,400);assert.equal(calls-before,1);
 }
 const before=calls,r=await handler(req(base+'/remittances/preview',{method:'POST',headers:{Authorization:'Bearer synthetic','Content-Type':'text/plain'},body:'private'}),env);
 assert.equal(r.status,400);assert.equal(calls-before,1);
});
