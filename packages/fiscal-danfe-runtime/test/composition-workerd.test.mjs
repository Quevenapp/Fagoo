// Local workerd-only composition; every Auth/container/Storage/RPC port is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createDanfeRuntimeHandler} from '../src/handler.mjs';
import {digest,signRuntimeRequest} from '../src/auth.mjs';
import {signRuntimeRequest as signA1} from '../../fiscal-runtime/src/auth.mjs';
import {signRuntimeRequest as signSigned} from '../../fiscal-signed-runtime/src/auth.mjs';
import {fixture as previewFixture,actor} from './fixtures.mjs';
const enabled=process.env.BRUFAP_RUN_WORKERD_TESTS==='1';
let Miniflare,convertV4MiniflareOptions,bundle,gatewayBundle;
if(enabled){
 ({Miniflare,convertV4MiniflareOptions}=await import('miniflare'));
 const {build}=await import('esbuild');
 const built=await build({stdin:{resolveDir:fileURLToPath(new URL('../../../',import.meta.url)),sourcefile:'synthetic-danfe-composition.mjs',contents:`
  import {createExecutorDispatch} from './workers/fiscal-executor/src/dispatch.mjs';
  import {createContainerBridge} from './workers/fiscal-executor/src/bridge.mjs';
  const dispatch=createExecutorDispatch({fetchImpl:(...args)=>fetch(...args),createUnsigned:()=>{throw Error('Unsigned route must not run');}});
  let state,boots=0;
  function composition(env){
   if(state)return state;
   const container={running:false,images:{base:'synthetic-image'},start(args){
    if(JSON.stringify(args.instance)!==JSON.stringify({vcpu:0.25,memoryMib:1024,diskMb:4000})||args.env.UNRELATED_SECRET!==undefined)throw Error('Container configuration changed');
    if(args.env.FISCAL_PROTOCOL_ENABLED!=='false')throw Error('Protocol must remain disabled by default');
    boots++;this.running=true;
   },async setInactivityTimeout(ms){if(ms!==60000)throw Error('Unexpected inactivity');},getTcpPort(n){
    if(n!==8080)throw Error('Unexpected port');
    return{fetch:(request,init)=>{
     const input=typeof request==='string'?new Request(request,init):request;
     return env.NODE_RUNTIME.fetch(new Request('http://runtime.internal'+new URL(input.url).pathname,input));
    }};
   }};
   const bridge=createContainerBridge({container},env,{diagnostic:()=>{throw Error('Unexpected boot diagnostic');}});
   const executor={...env,A1_CONTAINER:{getByName(name){if(name!=='a1-custody-v1')throw Error('Unexpected container');return{fetch:bridge};}}};
   state={executor};return state;
  }
  export default{fetch(request,env){if(new URL(request.url).pathname==='/__test/stats')return Response.json({boots});return dispatch(request,composition(env).executor);}};
 `},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['node:*'],logLevel:'silent'});
 bundle=built.outputFiles[0].text;
 gatewayBundle=(await build({entryPoints:[fileURLToPath(new URL('../../../workers/fiscal-gateway/src/index.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'})).outputFiles[0].text;
}
const options={skip:!enabled,timeout:30000},ORIGIN='https://app.synthetic.invalid',PROJECT='https://abcdefghijklmnopqrst.supabase.co';
async function fixture(model='55'){
 const f=await previewFixture({model}),secret=randomBytes(32),calls={auth:0,probes:0,node:0,rpc:0,read:0};
 const handler=createDanfeRuntimeHandler({transportSecret:secret,transportKeyId:'synthetic-key',audience:'synthetic-runtime-danfe',
  rpc:async(...args)=>{calls.rpc++;assert.equal(args[0],'erp_fiscal_signed_get');return f.ports.rpc(...args);},storage:{read:async opts=>{calls.read++;return f.ports.storage.read(opts);}}});
 const bindings={ALLOWED_ORIGINS:ORIGIN,SUPABASE_URL:PROJECT,SUPABASE_ANON_KEY:'synthetic-public-anon-key',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',
  A1_TRANSPORT_SECRET:secret.toString('base64'),A1_TRANSPORT_KEY_ID:'synthetic-key',A1_AUDIENCE:'synthetic-runtime',A1_FINGERPRINT_SECRET:randomBytes(32).toString('base64'),
  A1_KEK_RING_JSON:JSON.stringify({synthetic:randomBytes(32).toString('base64')}),A1_CURRENT_KEK_ID:'synthetic',UNRELATED_SECRET:'not-forwarded',FISCAL_PROTOCOL_ENABLED:'false'};
 const mf=new Miniflare(convertV4MiniflareOptions({cf:false,workers:[
  {name:'gateway',modules:true,script:gatewayBundle,compatibilityDate:'2026-10-16',bindings,serviceBindings:{A1_RUNTIME:'executor'},outboundService:request=>{
   calls.auth++;assert.equal(request.url,PROJECT+'/auth/v1/user');assert.equal(request.method,'GET');assert.equal(request.headers.get('authorization'),'Bearer synthetic-session-123456789012345');return Response.json({id:actor,is_anonymous:false});
  }},
  {name:'executor',modules:true,script:bundle,compatibilityDate:'2026-10-16',compatibilityFlags:['nodejs_compat'],bindings,outboundService:()=>{throw Error('No executor network');},serviceBindings:{NODE_RUNTIME:async request=>{
   assert.equal(new URL(request.url).origin,'http://runtime.internal');assert.equal(request.method,'GET');assert.equal(request.headers.get('apikey'),null);assert.equal(request.headers.get('origin'),null);
   if(new URL(request.url).pathname==='/internal/v1/a1'){calls.probes++;assert.equal(request.headers.get('authorization'),null);return new Response(null,{status:401,headers:{'X-Content-Type-Options':'nosniff'}});}
   calls.node++;assert.match(request.headers.get('authorization'),/^Brufap-Danfe /);assert.equal(new URL(request.url).pathname,`/internal/v1/fiscal-danfe/candidates/${f.id}/preview`);return handler(request);
  }}}
 ]}));
 return{...f,secret,calls,mf,request:()=>mf.dispatchFetch(`https://gateway.synthetic.invalid/v1/fiscal-danfe/candidates/${f.id}/preview`,{headers:{Origin:ORIGIN,Authorization:'Bearer synthetic-session-123456789012345'}}),async close(){await mf.dispose();handler.dispose();secret.fill(0);}};
}
test('real gateway→dispatcher→bridge→Node handler renders55/65 with signed_get only and no POST',options,async()=>{
 for(const model of ['55','65']){
  const f=await fixture(model);try{
   const response=await f.request(),text=await response.text();assert.equal(response.status,200,text);const value=JSON.parse(text);assert.deepEqual(value,f.dto);assert.match(value.html,/SEM VALOR FISCAL/);assert.equal(value.authorized,false);
   assert.deepEqual(f.calls,{auth:1,probes:1,node:1,rpc:2,read:1});assert.deepEqual(await(await(await f.mf.getWorker('executor')).fetch('http://synthetic.invalid/__test/stats')).json(),{boots:1});
   assert.doesNotMatch(text,/credential_id|certificate_fingerprint|lease_id|private_executor|brufap-fiscal-artifacts|<NFe/);
  }finally{await f.close();}
 }
});
test('actual dispatcher rejects A1/signed/wrong-audience authentication before any container boot',options,async()=>{
 const f=await fixture(),path=`/internal/v1/fiscal-danfe/candidates/${f.id}/preview`;
 try{
  const base={secretBytes:f.secret,keyId:'synthetic-key',actor,nonce:randomUUID(),method:'GET',path,bodyHash:await digest(new Uint8Array())};
  for(const authorization of [null,await signA1({...base,path:'/internal/v1/a1',audience:'synthetic-runtime'}),await signSigned({...base,path:`/internal/v1/fiscal-signed/candidates/${f.id}`,audience:'synthetic-runtime-signed'}),await signRuntimeRequest({...base,audience:'wrong-danfe'})]){
   const r=await(await f.mf.getWorker('executor')).fetch('https://fiscal-runtime.internal'+path,{headers:authorization?{Authorization:authorization}:{}});assert.equal(r.status,401);assert.equal((await r.json()).error,'DANFE_RUNTIME_UNAUTHORIZED');
  }
  assert.deepEqual(f.calls,{auth:0,probes:0,node:0,rpc:0,read:0});assert.deepEqual(await(await(await f.mf.getWorker('executor')).fetch('http://synthetic.invalid/__test/stats')).json(),{boots:0});
 }finally{await f.close();}
});
