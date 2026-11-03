import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';

const ACTOR='10000000-0000-4000-8000-000000000001',SESSION='10000000-0000-4000-8000-000000000002';
const TOKEN='h.'+Buffer.from(JSON.stringify({session_id:SESSION,aal:'aal2'})).toString('base64url')+'.s';
const PROGRESS='p'.repeat(43),SECRET='a'.repeat(64);
const env={SUPABASE_DEPLOYMENT:'self-hosted',SUPABASE_URL:'https://services.example.test',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',
 ALLOWED_ORIGINS:'https://erp.example.test',FAGOO_UPDATE_AGENT_TOKEN:SECRET,FAGOO_VERSION:'v0.2.0',FAGOO_REVISION:'b'.repeat(40)};
const snapshot=()=>({protocol:1,installed:{version:'v0.2.0-dev.0',revision:'a'.repeat(40),installed_at:null},
 latest:{version:'v0.2.0',revision:'b'.repeat(40),notes:'Novidades',manifest_sha256:'d'.repeat(64)},update_available:true,cloudflare_configured:true,can_apply:true,
 status:{state:'idle',phase:'ready',job_id:null,version:null,updated_at:'2026-11-03T18:00:00Z',error:null,recovery_required:false,backup_id:null}});
function fixture({role='admin',mfa=true,open=true,anonymous=false,maintenance=false,agentStatus=200,extra={}}={}){
 const calls=[];
 const handler=createHandler({fetchImpl:async(url,options)=>{
  const path=new URL(url).pathname;calls.push({path,options});
  if(path==='/auth/v1/user'){assert.equal(maintenance,false,'progress must not depend on stopped Auth');return Response.json({id:ACTOR,is_anonymous:anonymous});}
  if(path==='/rest/v1/rpc/erp_access_gate_v2')return Response.json({scope:'access_gate',user_id:ACTOR,open,mfa_required:true,mfa_ok:mfa});
  if(path==='/rest/v1/rpc/erp_access_me')return Response.json({user_id:ACTOR,role});
  if(path.startsWith('/_fagoo/system/')){
   assert.equal(options.headers.Authorization,'Bearer '+SECRET);
   if(path.endsWith('/progress'))assert.equal(options.headers['X-Fagoo-Progress'],PROGRESS);else assert.equal(options.headers['X-Fagoo-Actor'],ACTOR);
   if(agentStatus!==200)return Response.json({error:'UPDATE_RECOVERY_REQUIRED'},{status:agentStatus});
   return Response.json({...snapshot(),...extra,...(path.endsWith('/apply')?{progress_token:PROGRESS}:{})});
  }
  throw new Error('Unexpected upstream '+path);
 }});
 const request=(path='',method='GET',body,token=TOKEN,origin='https://erp.example.test')=>handler(new Request('https://api.example.test/v1/system/updates'+path,
  {method,headers:{Authorization:'Bearer '+token,Origin:origin,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)}),env);
 return{calls,handler,request};
}

test('only a verified administrator with an open access/MFA gate can request updates',async()=>{
 for(const options of[{role:'vendas'},{role:'consulta'},{mfa:false},{open:false},{anonymous:true}]){
  const f=fixture(options),response=await f.request('/check','POST',{});assert.equal(response.status,403);assert.equal(f.calls.some(c=>c.path.startsWith('/_fagoo')),false);
 }
 const f=fixture(),response=await f.request('/check','POST',{});assert.equal(response.status,200);
 assert.deepEqual(f.calls.map(c=>c.path),['/auth/v1/user','/rest/v1/rpc/erp_access_gate_v2','/rest/v1/rpc/erp_access_me','/_fagoo/system/check']);
});
test('progress works during maintenance and its bearer cannot start an update',async()=>{
 const f=fixture({maintenance:true}),response=await f.request('/progress','GET',undefined,PROGRESS);
 assert.equal(response.status,200);assert.deepEqual(f.calls.map(c=>c.path),['/_fagoo/system/progress']);
 const wrong=await f.request('/progress','POST',{},PROGRESS);assert.equal(wrong.status,405);assert.equal(f.calls.length,1);
 const invalid=await f.request('/progress','GET',undefined,TOKEN);assert.equal(invalid.status,403);assert.equal(f.calls.length,1);
});
test('public DTO excludes internal paths, credentials and progress secrets from status',async()=>{
 const f=fixture({extra:{credentials:{token:SECRET},source_dir:'/private/source',progress_token:PROGRESS}});
 const response=await f.request(),body=await response.text();assert.equal(response.status,200);
 for(const value of[SECRET,PROGRESS,'credentials','source_dir'])assert.equal(body.includes(value),false);
 assert.equal(response.headers.get('Cache-Control'),'no-store');
});
test('apply carries only the checked version, manifest digest and idempotency key',async()=>{
 const f=fixture(),body={version:'v0.2.0',manifest_sha256:'d'.repeat(64),request_id:ACTOR};
 const response=await f.request('/apply','POST',body);assert.equal(response.status,200);assert.equal((await response.json()).progress_token,PROGRESS);
 assert.deepEqual(JSON.parse(f.calls.at(-1).options.body),body);
 for(const bad of[{...body,url:'https://evil.test/script'},{...body,version:'$(command)'},{...body,manifest_sha256:'wrong'}]){
  const before=f.calls.filter(c=>c.path.startsWith('/_fagoo')).length;assert.equal((await f.request('/apply','POST',bad)).status,400);
  assert.equal(f.calls.filter(c=>c.path.startsWith('/_fagoo')).length,before);
 }
});
test('cross-origin requests and unexpected query parameters never reach the agent',async()=>{
 const f=fixture();assert.equal((await f.request('/check','POST',{},TOKEN,'https://other.test')).status,403);assert.equal(f.calls.length,0);
 assert.equal((await f.request('?url=evil')).status,400);assert.equal(f.calls.length,0);
});
test('recovery refusal is preserved without returning upstream internals',async()=>{
 const f=fixture({agentStatus:409}),response=await f.request('/check','POST',{});assert.equal(response.status,409);
 assert.deepEqual(await response.json(),{error:{code:'ERP_UPDATE_UPDATE_RECOVERY_REQUIRED'}});
});
test('published version can be verified without Auth, including during maintenance',async()=>{
 const f=fixture({maintenance:true});const response=await f.handler(new Request('https://api.example.test/v1/system/version?verification=test'),env);
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{version:'v0.2.0',revision:'b'.repeat(40)});assert.equal(f.calls.length,0);
});
