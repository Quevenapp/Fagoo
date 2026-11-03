import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {digest,verifyRuntimeRequest} from '../src/auth.mjs';
import {FLAGS} from '../src/dto.mjs';
const enabled=process.env.BRUFAP_RUN_WORKERD_TESTS==='1';let Miniflare,convertV4MiniflareOptions,bundle;
if(enabled){
 ({Miniflare,convertV4MiniflareOptions}=await import('miniflare'));
 const{build}=await import('esbuild');const path=fileURLToPath(new URL('../../../workers/fiscal-gateway/src/index.mjs',import.meta.url));
 const built=await build({entryPoints:[path],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});bundle=built.outputFiles[0].text;
}
const options={skip:!enabled,timeout:30000},ORIGIN='https://app.synthetic.invalid',PROJECT='https://abcdefghijklmnopqrst.supabase.co';
async function fixture({redirectAuth=false,redirectRuntime=false,anonymous=false}={}){
 const actor=randomUUID(),secret=randomBytes(32),calls={auth:0,runtime:0};
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle,compatibilityDate:'2026-10-16',cf:false,
  bindings:{ALLOWED_ORIGINS:ORIGIN,SUPABASE_URL:PROJECT,SUPABASE_ANON_KEY:'synthetic-public-anon-key',A1_TRANSPORT_SECRET:secret.toString('base64'),A1_TRANSPORT_KEY_ID:'synthetic-key',A1_AUDIENCE:'synthetic-runtime'},
  outboundService:request=>{calls.auth++;assert.equal(request.url,PROJECT+'/auth/v1/user');assert.equal(request.headers.get('authorization'),'Bearer synthetic-user-session-1234567890');
   return redirectAuth?new Response(null,{status:302,headers:{location:'https://never-follow.invalid'}}):Response.json({id:actor,is_anonymous:anonymous});},
  serviceBindings:{A1_RUNTIME:async request=>{
   calls.runtime++;assert.equal(request.headers.get('apikey'),null);assert.equal(request.headers.get('origin'),null);
   const raw=new Uint8Array(await request.arrayBuffer()),path=new URL(request.url).pathname;
   const claims=await verifyRuntimeRequest({header:request.headers.get('authorization'),secretBytes:secret,keyId:'synthetic-key',audience:'synthetic-runtime-signed',method:request.method,path});
   assert.equal(claims.actor,actor);assert.equal(claims.body_hash,await digest(raw));const payload=JSON.parse(new TextDecoder().decode(raw));raw.fill(0);
   if(redirectRuntime)return new Response(null,{status:302,headers:{location:'https://never-follow.invalid'}});
   assert.equal(path,'/internal/v1/fiscal-signed/run');return Response.json({...FLAGS,status:'recoverable',command_id:payload.command_id,code:'SIGNED_TIMEOUT',phase:'finish',signed:null,outcome:'unconfirmed',storage_operations:3,signature_verified:false,xsd_validated:false});
  }}
 }));
 return{calls,request:payload=>mf.dispatchFetch('https://gateway.synthetic.invalid/v1/fiscal-signed/run',{method:'POST',headers:{Origin:ORIGIN,Authorization:'Bearer synthetic-user-session-1234567890','Content-Type':'application/json'},body:JSON.stringify(payload)}),async close(){await mf.dispose();secret.fill(0);}};
}
const payload=()=>({command_id:randomUUID(),unsigned_job_id:randomUUID(),unsigned_hash:'a'.repeat(64),basis_hash:'b'.repeat(64),expected_a1_version:1});
test('workerd public entrypoint routes to the separate protocol and preserves the original command on an uncertain signed outcome',options,async()=>{
 const f=await fixture();try{
  const p=payload(),response=await f.request(p);assert.equal(response.status,200);const value=await response.json();
  assert.equal(value.command_id,p.command_id);assert.equal(value.signed,null);assert.equal(value.can_transmit,false);assert.deepEqual(f.calls,{auth:1,runtime:1});
 }finally{await f.close();}
});
test('workerd never follows Auth or runtime redirects and flags uncertainty only after forwarding',options,async()=>{
 for(const mode of['auth','runtime']){const f=await fixture({redirectAuth:mode==='auth',redirectRuntime:mode==='runtime'});try{
  const response=await f.request(payload());assert.equal(response.status,502);const value=await response.json();
  assert.equal(value.error,'SIGNED_RESPONSE_INVALID');assert.equal(value.recovery_required,mode==='runtime');assert.deepEqual(f.calls,{auth:1,runtime:mode==='runtime'?1:0});
 }finally{await f.close();}}
});
test('workerd rejects an anonymous session before forwarding a signed command',options,async()=>{
 const f=await fixture({anonymous:true});try{
  const response=await f.request(payload());assert.equal(response.status,401);assert.equal((await response.json()).error,'SIGNED_UNAUTHENTICATED');assert.deepEqual(f.calls,{auth:1,runtime:0});
 }finally{await f.close();}
});
