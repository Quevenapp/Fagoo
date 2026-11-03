import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {digest,verifyRuntimeRequest} from '../src/auth.mjs';
import {FLAGS} from '../src/dto.mjs';
const enabled=process.env.BRUFAP_RUN_WORKERD_TESTS==='1';let Miniflare,convertV4MiniflareOptions,bundle;
if(enabled){
 ({Miniflare,convertV4MiniflareOptions}=await import('miniflare'));
 const{build}=await import('esbuild');const path=fileURLToPath(new URL('../../../workers/fiscal-gateway/src/unsigned.mjs',import.meta.url));
 const built=await build({stdin:{contents:`import {createUnsignedGateway} from ${JSON.stringify(path)};export default {fetch:createUnsignedGateway({fetchImpl:(...args)=>fetch(...args),now:()=>Date.now(),nonce:()=>crypto.randomUUID()})};`,resolveDir:fileURLToPath(new URL('../../../',import.meta.url)),sourcefile:'unsigned-workerd-fixture.mjs'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});bundle=built.outputFiles[0].text;
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
   const claims=await verifyRuntimeRequest({header:request.headers.get('authorization'),secretBytes:secret,keyId:'synthetic-key',audience:'synthetic-runtime-unsigned',method:request.method,path});
   assert.equal(claims.actor,actor);assert.equal(claims.body_hash,await digest(raw));const payload=JSON.parse(new TextDecoder().decode(raw));raw.fill(0);
   if(redirectRuntime)return new Response(null,{status:302,headers:{location:'https://never-follow.invalid'}});
   if(path.endsWith('/preview'))return Response.json({...FLAGS,status:'checked',draft_id:payload.draft_id,completion_version:payload.completion_version,basis_hash:'a'.repeat(64),completion_hash:'b'.repeat(64),builder_version:'brufap-business-builder-v1',model:'65',environment:'2',items:250,arithmetic_verified:true,identity_assigned:false,numbering_bound:false,xml_generated:false,pending:[]});
   assert.equal(path,'/internal/v1/fiscal-unsigned/generate');return Response.json({...FLAGS,status:'recoverable',command_id:payload.command_id,code:'UNSIGNED_TIMEOUT',phase:'finish',xml_generated:null,outcome:'unconfirmed',storage_operations:3});
  }}
 }));
 return{calls,request:(path,payload)=>mf.dispatchFetch('https://gateway.synthetic.invalid/v1/fiscal-unsigned'+path,{method:'POST',headers:{Origin:ORIGIN,Authorization:'Bearer synthetic-user-session-1234567890','Content-Type':'application/json'},body:JSON.stringify(payload)}),async close(){await mf.dispose();secret.fill(0);}};
}
test('workerd gateway signs the separate unsigned protocol for preview and frozen generate without A1/container operations',options,async()=>{
 const f=await fixture(),draft_id=randomUUID();try{
  const preview=await f.request('/preview',{draft_id,completion_version:1});assert.equal(preview.status,200);assert.equal((await preview.json()).items,250);
  const command_id=randomUUID(),run=await f.request('/generate',{command_id,reservation_id:randomUUID(),draft_id,completion_version:1,completion_hash:'b'.repeat(64),basis_hash:'a'.repeat(64)});
  assert.equal(run.status,200);const value=await run.json();assert.equal(value.command_id,command_id);assert.equal(value.xml_generated,null);assert.deepEqual(f.calls,{auth:2,runtime:2});
 }finally{await f.close();}
});
test('workerd never follows Auth/runtime redirects and preserves uncertainty after generate was forwarded',options,async()=>{
 for(const mode of['auth','runtime']){const f=await fixture({redirectAuth:mode==='auth',redirectRuntime:mode==='runtime'});try{
  const response=await f.request('/generate',{command_id:randomUUID(),reservation_id:randomUUID(),draft_id:randomUUID(),completion_version:1,completion_hash:'b'.repeat(64),basis_hash:'a'.repeat(64)});
  assert.equal(response.status,502);const value=await response.json();assert.equal(value.error,'UNSIGNED_RESPONSE_INVALID');assert.equal(value.recovery_required,mode==='runtime');assert.deepEqual(f.calls,{auth:1,runtime:mode==='runtime'?1:0});
 }finally{await f.close();}}
});
test('workerd rejects anonymous sessions before forwarding an unsigned command',options,async()=>{
 const f=await fixture({anonymous:true});try{const response=await f.request('/preview',{draft_id:randomUUID(),completion_version:1});assert.equal(response.status,401);assert.equal((await response.json()).error,'UNSIGNED_UNAUTHENTICATED');assert.deepEqual(f.calls,{auth:1,runtime:0});}finally{await f.close();}
});
