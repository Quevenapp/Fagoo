import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {fixture,secret,keyId,actor} from './fixtures.mjs';
import {verifyRuntimeRequest} from '../src/auth.mjs';
const enabled=process.env.BRUFAP_RUN_WORKERD_TESTS==='1';let Miniflare,convertV4MiniflareOptions,bundle;
if(enabled){
 ({Miniflare,convertV4MiniflareOptions}=await import('miniflare'));const{build}=await import('esbuild');
 const built=await build({entryPoints:[fileURLToPath(new URL('./workerd-entry.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',metafile:true,logLevel:'silent'});
 assert.ok(Object.keys(built.metafile.inputs).every(path=>!path.includes('node_modules')&&!path.includes('/handler.mjs')&&!path.includes('fiscal-danfe/src/')));bundle=built.outputFiles[0].text;assert.doesNotMatch(bundle,/node:|readFileSync|createHash/);
}
async function setup({anonymous=false,badHash=false,redirect=false}={}){
 const f=await fixture({model:'65'}),calls={auth:0,runtime:0};
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle,compatibilityDate:'2026-10-16',cf:false,
  bindings:{ALLOWED_ORIGINS:'https://app.synthetic.invalid',SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_ANON_KEY:'synthetic-public-anon-key',A1_TRANSPORT_SECRET:Buffer.from(secret).toString('base64'),A1_TRANSPORT_KEY_ID:keyId,A1_AUDIENCE:'synthetic'},
  outboundService:request=>{calls.auth++;assert.equal(request.url,'https://abcdefghijklmnopqrst.supabase.co/auth/v1/user');return Response.json({id:actor,is_anonymous:anonymous});},
  serviceBindings:{A1_RUNTIME:async request=>{calls.runtime++;assert.equal(request.method,'GET');assert.equal(request.headers.get('apikey'),null);const claims=await verifyRuntimeRequest({header:request.headers.get('authorization'),secretBytes:secret,keyId,audience:'synthetic-danfe',method:'GET',path:new URL(request.url).pathname});assert.equal(claims.actor,actor);
   return redirect?new Response(null,{status:302,headers:{Location:'https://never.invalid'}}):Response.json({...f.dto,...(badHash?{html_sha256:'f'.repeat(64)}:{})});}}
 }));
 return{calls,request:()=>mf.dispatchFetch(`https://gateway.synthetic.invalid/v1/fiscal-danfe/candidates/${f.id}/preview`,{headers:{Origin:'https://app.synthetic.invalid',Authorization:'Bearer synthetic-user-session-1234567890'}}),close:()=>mf.dispose()};
}
test('workerd gateway has no Node dependencies and validates the complete preview HTML hash', {skip:!enabled,timeout:30000},async()=>{
 const f=await setup();try{const r=await f.request();assert.equal(r.status,200);const v=await r.json();assert.equal(v.model,'65');assert.equal(v.authorized,false);assert.match(v.html,/SEM VALOR FISCAL/);assert.deepEqual(f.calls,{auth:1,runtime:1});}finally{await f.close();}
});
test('workerd refuses anonymous sessions, redirects and forged HTML without automatic retries',{skip:!enabled,timeout:30000},async()=>{
 for(const[opts,status,count]of [[{anonymous:true},401,0],[{badHash:true},502,1],[{redirect:true},502,1]]){const f=await setup(opts);try{const r=await f.request();assert.equal(r.status,status);const v=await r.json();assert.equal(v.html,undefined);assert.equal(v.recovery_required,false);assert.equal(f.calls.runtime,count);}finally{await f.close();}}
});
