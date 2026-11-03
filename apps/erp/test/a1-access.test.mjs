import test from 'node:test';import assert from 'node:assert/strict';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
import {accessConfig} from '../src/lib/access-config.ts';
const uid='a0000000-0000-4000-8000-000000000001',id='b0000000-0000-4000-8000-000000000001',session={access_token:'synthetic-token',user:{id:uid}},me={user_id:uid,role:'admin',resources:[],data_mode:'staging_readonly'};
const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0)),status=n=>e=>e instanceof AccessError&&e.status===n;
const services={a1ApiUrl:'https://a1.example.test'};
test('041 public configuration allows only a bare HTTPS origin for the dedicated gateway',()=>{
 const env={VITE_SUPABASE_URL:'https://project.supabase.co',VITE_SUPABASE_ANON_KEY:'sb_publishable_abcdefghijklmnop',VITE_ERP_API_URL:'https://api.example.test'};
 assert.equal(accessConfig(env).a1ApiUrl,undefined);assert.equal(accessConfig({...env,VITE_A1_API_URL:services.a1ApiUrl}).a1ApiUrl,services.a1ApiUrl);
 for(const value of ['http://a1.example.test','https://a1.example.test/path','https://user:pass@a1.example.test','https://a1.example.test?key=x','//a1.example.test'])assert.throws(()=>accessConfig({...env,VITE_A1_API_URL:value}));
});
test('041 certificate request stays on dedicated origin with binary body, no persistence, and wipes transport copy',async()=>{
 const original=new Uint8Array(32).fill(77),calls=[];
 const c=createAccessController(auth,'https://erp.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);calls.push({url,options,observed:options.body?new Uint8Array(options.body):null});return Response.json({privateCertificate:'synthetic-metadata'});},services);const stop=c.start();await tick();
 try{
  await c.a1('/v1/a1/configure',{method:'POST',body:original});const call=calls[0];assert.equal(call.url,'https://a1.example.test/v1/a1/configure');assert.deepEqual(call.observed,original);assert.ok(call.options.body.every(n=>n===0));assert.ok(original.every(n=>n===77));
  assert.equal(call.options.headers['Content-Type'],'application/vnd.brufap.a1+octet-stream');assert.equal(call.options.headers.Authorization,'Bearer synthetic-token');assert.equal(call.options.credentials,'omit');assert.equal(call.options.cache,'no-store');assert.equal(call.options.redirect,'error');assert.equal(c.getSnapshot().privateCertificate,undefined);
  await c.a1('/v1/a1/commands/'+id);assert.equal(calls[1].options.body,undefined);
  for(const path of ['/v1/cnab','/v1/a1/../other','/v1/a1?key=x','https://other.invalid/v1/a1'])await assert.rejects(()=>c.a1(path),status(400));
  for(const options of [{method:'POST',body:{}},{method:'POST',body:new Uint8Array(1053713)},{method:'GET'}])await assert.rejects(()=>c.a1('/v1/a1/configure',options),status(400));assert.equal(calls.length,2);
 }finally{stop();}
});
test('041 missing gateway fails closed and logout rejects late certificate results',async()=>{
 const unconfigured=createAccessController(auth,'https://erp.example.test',async()=>Response.json(me));const end=unconfigured.start();await tick();await assert.rejects(()=>unconfigured.a1('/v1/a1'),status(503));end();
 let finish,signal,body;const c=createAccessController(auth,'https://erp.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);signal=options.signal;body=options.body;return new Promise(resolve=>{finish=resolve;});},services);const stop=c.start();await tick();
 const pending=c.a1('/v1/a1/configure',{method:'POST',body:new Uint8Array(32).fill(5)});await tick();await c.logout();assert.equal(signal.aborted,true);finish(Response.json({privateCertificate:'late'}));await assert.rejects(pending,e=>e.name==='AbortError');assert.ok(body.every(n=>n===0));stop();
});
test('041 response bound and revoked membership are enforced without logging upstream contents',async()=>{
 let checks=0;const c=createAccessController(auth,'https://erp.example.test',async url=>url.endsWith('/me')?Response.json({...me,role:++checks===1?'admin':'vendas'}):new Response('private error',{status:403}),services);const stop=c.start();await tick();await assert.rejects(()=>c.a1('/v1/a1'),status(403));await tick();assert.equal(c.getSnapshot().membership.role,'vendas');stop();
 const bounded=createAccessController(auth,'https://erp.example.test',async url=>url.endsWith('/me')?Response.json(me):new Response('{}',{headers:{'Content-Length':'65537'}}),services);const end=bounded.start();await tick();try{await assert.rejects(()=>bounded.a1('/v1/a1'),status(502));}finally{end();}
});
test('041 diagnostics preserve only fixed gateway codes and discard unknown upstream details',async()=>{
 for(const [value,expected] of [[{error:'A1_AUTH_SERVICE_UNAVAILABLE',password:'private-fixture'},'A1_AUTH_SERVICE_UNAVAILABLE'],[{error:'PRIVATE-CREDENTIAL-DO-NOT-DISPLAY'},undefined]]){
  const c=createAccessController(auth,'https://erp.example.test',async url=>url.endsWith('/me')?Response.json(me):Response.json(value,{status:503}),services),stop=c.start();await tick();
  try{await assert.rejects(()=>c.a1('/v1/a1'),error=>error instanceof AccessError&&error.status===503&&error.code===expected&&!String(error).includes('private-fixture')&&!String(error).includes('PRIVATE-CREDENTIAL'));}finally{stop();}
 }
});
