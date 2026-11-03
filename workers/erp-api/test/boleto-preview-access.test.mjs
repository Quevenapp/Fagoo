import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
import {boletoFixture,actor} from './helpers/boleto-preview-fixture.mjs';
const env={SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://erp.example.test'};
const f=await boletoFixture(),base='/v1/boletos-itau',paths=[`${base}/remittances/${f.file.id}/items`,`${base}/${f.billing}/preview`];
const request=(path,options={})=>new Request('https://api.example.test'+path,{headers:{Authorization:'Bearer SYNTHETIC_TOKEN'},...options});
function fixture({onRpc,onStorage,user={id:actor}}={}){
 const calls=[];const handler=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});
  if(url.endsWith('/auth/v1/user'))return Response.json(user);
  if(url.includes('/storage/'))return onStorage?onStorage(url,options):new Response(f.bytes,{headers:{'content-type':'application/octet-stream'}});
  const name=url.split('/').at(-1),args=JSON.parse(options.body);if(onRpc)return onRpc(name,args,options);
  assert.deepEqual(args,name==='erp_cnab_itau_boleto_items'?{p_user_id:actor,p_remittance_id:f.file.id}:{p_user_id:actor,p_billing_title_id:f.billing});
  return Response.json(name==='erp_cnab_itau_boleto_items'?f.items:f.context);
 }});return{calls,handler};
}
test('066 API permits only GET/CORS GET and authenticates before RPC/Storage',async()=>{
 const a=fixture();
 for(const path of paths){
  assert.equal((await a.handler(new Request('https://api.example.test'+path),env)).status,401);
  for(const method of ['POST','PATCH','DELETE'])assert.equal((await a.handler(request(path,{method}),env)).status,405);
  for(const method of ['GET','POST'])assert.equal((await a.handler(new Request('https://api.example.test'+path,{method:'OPTIONS',headers:{Origin:env.ALLOWED_ORIGINS,'Access-Control-Request-Method':method,'Access-Control-Request-Headers':'Authorization'}}),env)).status,method==='GET'?204:403);
 }
 assert.equal(a.calls.length,0);
 assert.equal((await a.handler(request(paths[0],{headers:{Origin:'https://evil.invalid',Authorization:'Bearer SYNTHETIC_TOKEN'}}),env)).status,403);
 const anonymous=fixture({user:{id:actor,is_anonymous:true}});assert.equal((await anonymous.handler(request(paths[0]),env)).status,403);assert.equal(anonymous.calls.length,1);
});
test('066 shared route injects actor, reads exact Storage URL and returns safe JSON with final context lookup',async()=>{
 for(const [index,path]of paths.entries()){
  const a=fixture(),r=await a.handler(request(path),env);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('x-content-type-options'),'nosniff');
  const v=await r.json();assert.deepEqual(v,index?f.response:f.items);
  assert.doesNotMatch(JSON.stringify(v),/synthetic-service-key|SYNTHETIC_TOKEN|"(?:snapshot|object_path|path|private_context)":/);
  assert.equal(a.calls.length,index?4:2);for(const c of a.calls.slice(1)){assert.equal(c.options.redirect,'manual');assert.equal(c.options.headers.Authorization,'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY);}
  if(index){const storage=a.calls[2];assert.equal(storage.url,env.SUPABASE_URL+'/storage/v1/object/authenticated/brufap-cnab/'+f.context.file.path);assert.equal(storage.options.method,'GET');assert.equal(storage.options.signal.aborted,true);}
 }
});
test('066 SQL errors are closed, malformed response and changing permission never expose HTML',async()=>{
 for(const [code,status]of [['42501',403],['40001',409],['P0002',404],['22023',422],['0A000',422]]){
  const a=fixture({onRpc:()=>Response.json({code,message:'PRIVATE_PROVIDER'}, {status:400})}),r=await a.handler(request(paths[1]),env);
  assert.equal(r.status,status);assert.doesNotMatch(await r.text(),/PRIVATE_PROVIDER|<html/);assert.equal(a.calls.length,2);
 }
 let reads=0;const denied=fixture({onRpc:()=>++reads===1?Response.json(f.context):Response.json({code:'42501',message:'PRIVATE'},{status:403})});
 const result=await denied.handler(request(paths[1]),env);assert.equal(result.status,403);assert.doesNotMatch(await result.text(),/<html|PRIVATE/);assert.equal(denied.calls.length,4);
 const bad=fixture({onRpc:()=>Response.json({...f.items,raw:'PRIVATE'})});assert.equal((await bad.handler(request(paths[0]),env)).status,502);
});
test('066 abort is passed through Auth/RPC to Storage and never retries after interrupted read',async()=>{
 const c=new AbortController();let entered;const reached=new Promise(r=>entered=r);
 const a=fixture({onStorage:async(_url,options)=>{entered(options.signal);return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('PRIVATE_ABORT')),{once:true}));}});
 const pending=a.handler(request(paths[1],{signal:c.signal}),env);const signal=await reached;c.abort();const response=await pending;
 assert.equal(signal.aborted,true);assert.equal(response.status,504);assert.equal(a.calls.length,3);assert.doesNotMatch(await response.text(),/PRIVATE_ABORT/);
});
