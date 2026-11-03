import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {digest,verifyRuntimeRequest} from '../src/auth.mjs';
import {payload,result,unconfirmed,command} from './fixtures.mjs';
const enabled=process.env.BRUFAP_RUN_WORKERD_TESTS==='1';let Miniflare,convertV4MiniflareOptions,bundle;
if(enabled){
 ({Miniflare,convertV4MiniflareOptions}=await import('miniflare'));
 const{build}=await import('esbuild'),directory=fileURLToPath(new URL('../src/',import.meta.url));
 const built=await build({stdin:{contents:"import {createWsdlGateway} from './gateway.mjs'; const run=createWsdlGateway({fetchImpl:fetch,now:Date.now,nonce:()=>crypto.randomUUID()}); export default {fetch:run};",resolveDir:directory,sourcefile:'synthetic-wsdl-entry.mjs'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});bundle=built.outputFiles[0].text;
}
const options={skip:!enabled,timeout:30000},ORIGIN='https://app.synthetic.invalid',PROJECT='https://abcdefghijklmnopqrst.supabase.co';
async function fixture({redirectAuth=false,redirectRuntime=false,anonymous=false}={}){
 const actor=randomUUID(),secret=randomBytes(32),calls={auth:0,runtime:0};
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle,compatibilityDate:'2026-10-16',cf:false,
  bindings:{ALLOWED_ORIGINS:ORIGIN,SUPABASE_URL:PROJECT,SUPABASE_ANON_KEY:'synthetic-public-anon-key',A1_TRANSPORT_SECRET:secret.toString('base64'),A1_TRANSPORT_KEY_ID:'synthetic-key',A1_AUDIENCE:'synthetic-runtime'},
  outboundService:request=>{calls.auth++;assert.equal(request.url,PROJECT+'/auth/v1/user');assert.equal(request.headers.get('authorization'),'Bearer synthetic-user-session-1234567890');return redirectAuth?new Response(null,{status:302,headers:{Location:'https://never-follow.invalid'}}):Response.json({id:actor,is_anonymous:anonymous});},
  serviceBindings:{A1_RUNTIME:async request=>{
   calls.runtime++;assert.equal(request.headers.get('apikey'),null);assert.equal(request.headers.get('origin'),null);const raw=new Uint8Array(await request.arrayBuffer()),path=new URL(request.url).pathname;
   const claims=await verifyRuntimeRequest({header:request.headers.get('authorization'),secretBytes:secret,keyId:'synthetic-key',audience:'synthetic-runtime-wsdl',method:request.method,path});assert.equal(claims.actor,actor);assert.equal(claims.body_hash,await digest(raw));
   if(redirectRuntime)return new Response(null,{status:302,headers:{Location:'https://never-follow.invalid'}});
   if(request.method==='GET'){assert.equal(path,'/internal/v1/fiscal-wsdl/commands/'+command);assert.equal(raw.length,0);return Response.json(result('stored',payload(),true));}
   assert.equal(path,'/internal/v1/fiscal-wsdl/run');const p=JSON.parse(new TextDecoder().decode(raw));raw.fill(0);return Response.json(unconfirmed(p));
  }}
 }));
 return{calls,request:(method='POST')=>mf.dispatchFetch('https://gateway.synthetic.invalid/v1/fiscal-wsdl'+(method==='GET'?'/commands/'+command:'/run'),{
  method,headers:{Origin:ORIGIN,Authorization:'Bearer synthetic-user-session-1234567890',...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:JSON.stringify(payload())}:{})}),async close(){await mf.dispose();secret.fill(0);}};
}
test('workerd supports confirmed run and read-only recovery through separate WSDL HMAC with synthetic ports',options,async()=>{
 const f=await fixture();try{const run=await f.request();assert.equal(run.status,200);assert.equal((await run.json()).recovery_required,true);
  const read=await f.request('GET');assert.equal(read.status,200);const value=await read.json();assert.equal(value.read_only,true);assert.equal(value.can_transmit,false);assert.deepEqual(f.calls,{auth:2,runtime:2});
 }finally{await f.close();}
});
test('workerd refuses Auth/runtime redirects without issuing a second request',options,async()=>{
 for(const mode of['auth','runtime']){const f=await fixture({redirectAuth:mode==='auth',redirectRuntime:mode==='runtime'});try{
  const response=await f.request();assert.equal(response.status,502);const value=await response.json();assert.equal(value.error,'WSDL_RESPONSE_INVALID');assert.equal(value.recovery_required,mode==='runtime');assert.deepEqual(f.calls,{auth:1,runtime:mode==='runtime'?1:0});
 }finally{await f.close();}}
});
test('workerd rejects an anonymous Auth session before WSDL dispatch',options,async()=>{
 const f=await fixture({anonymous:true});try{const response=await f.request();assert.equal(response.status,401);assert.equal((await response.json()).error,'WSDL_UNAUTHENTICATED');assert.deepEqual(f.calls,{auth:1,runtime:0});}finally{await f.close();}
});
