// Optional local workerd regression. Every Auth, container and service port is synthetic.
// BRUFAP_RUN_WORKERD_TESTS=1 node --test packages/fiscal-reconciliation-runtime/test/composition-workerd.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createReconciliationRuntimeHandler} from '../src/handler.mjs';
import {digest,signRuntimeRequest} from '../src/auth.mjs';
import {signRuntimeRequest as signA1} from '../../fiscal-runtime/src/auth.mjs';
import {payload,result,history,command,candidate} from './fixtures.mjs';

const enabled=process.env.BRUFAP_RUN_WORKERD_TESTS==='1';
let Miniflare,convertV4MiniflareOptions,bundle,gatewayBundle;
if(enabled){
 ({Miniflare,convertV4MiniflareOptions}=await import('miniflare'));
 const {build}=await import('esbuild');
 const built=await build({stdin:{resolveDir:fileURLToPath(new URL('../../../',import.meta.url)),sourcefile:'synthetic-reconciliation-composition.mjs',contents:`
  import {createExecutorDispatch} from './workers/fiscal-executor/src/dispatch.mjs';
  import {createContainerBridge} from './workers/fiscal-executor/src/bridge.mjs';
  const dispatch=createExecutorDispatch({fetchImpl:(...args)=>fetch(...args),createUnsigned:()=>{throw Error('Unsigned route must not run');}});
  let state;
  function composition(env){
   if(state)return state;
   const container={running:false,images:{base:'synthetic-image'},start(args){
    if(JSON.stringify(args.instance)!==JSON.stringify({vcpu:0.25,memoryMib:1024,diskMb:4000})||args.env.UNRELATED_SECRET!==undefined)throw Error('Container configuration changed');
    if(args.env.FISCAL_PROTOCOL_ENABLED!=='false')throw Error('Protocol must remain disabled by default');
    this.running=true;
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
  export default{fetch(request,env){return dispatch(request,composition(env).executor);}};
 `},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['node:*'],logLevel:'silent'});
 bundle=built.outputFiles[0].text;
 gatewayBundle=(await build({entryPoints:[fileURLToPath(new URL('../../../workers/fiscal-gateway/src/index.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'})).outputFiles[0].text;
}
const options={skip:!enabled,timeout:30000},ORIGIN='https://app.synthetic.invalid',PROJECT='https://abcdefghijklmnopqrst.supabase.co';
async function fixture(){
 const actor=randomUUID(),secret=randomBytes(32),calls={auth:0,probes:0,service:[]};
 const handler=createReconciliationRuntimeHandler({transportSecret:secret,transportKeyId:'synthetic-key',audience:'synthetic-runtime-reconciliation',service:{
  async run(input){calls.service.push(['run',input]);return result();},
  async command(input){calls.service.push(['command',input]);return result('stored',payload(),true);},
  async history(input){calls.service.push(['history',input]);return history();},
  async recover(input){calls.service.push(['recover',input]);return {...result(),recovered:true};}
 }});
 const bindings={ALLOWED_ORIGINS:ORIGIN,SUPABASE_URL:PROJECT,SUPABASE_ANON_KEY:'synthetic-public-anon-key',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',
   A1_TRANSPORT_SECRET:secret.toString('base64'),A1_TRANSPORT_KEY_ID:'synthetic-key',A1_AUDIENCE:'synthetic-runtime',
   A1_FINGERPRINT_SECRET:randomBytes(32).toString('base64'),A1_KEK_RING_JSON:JSON.stringify({synthetic:randomBytes(32).toString('base64')}),A1_CURRENT_KEK_ID:'synthetic',UNRELATED_SECRET:'not-forwarded'};
 const mf=new Miniflare(convertV4MiniflareOptions({cf:false,workers:[{name:'gateway',modules:true,script:gatewayBundle,compatibilityDate:'2026-10-16',bindings,serviceBindings:{A1_RUNTIME:'executor'},
  outboundService:request=>{calls.auth++;assert.equal(request.url,PROJECT+'/auth/v1/user');assert.equal(request.headers.get('authorization'),'Bearer synthetic-session-123456789012345');return Response.json({id:actor,is_anonymous:false});}},
  {name:'executor',modules:true,script:bundle,compatibilityDate:'2026-10-16',compatibilityFlags:['nodejs_compat'],bindings,
  outboundService:()=>{throw Error('No executor network is allowed');},serviceBindings:{NODE_RUNTIME:async request=>{
   assert.equal(new URL(request.url).origin,'http://runtime.internal');assert.equal(request.headers.get('apikey'),null);assert.equal(request.headers.get('origin'),null);
   if(new URL(request.url).pathname==='/internal/v1/a1'){calls.probes++;assert.equal(request.headers.get('authorization'),null);return new Response(null,{status:401,headers:{'X-Content-Type-Options':'nosniff'}});}
   assert.match(request.headers.get('authorization'),/^Brufap-Reconciliation /);return handler(request);
  }}
 }]}));
 return{actor,secret,calls,mf,async request(method){return mf.dispatchFetch('https://gateway.synthetic.invalid/v1/fiscal-reconciliation'+(method==='GET'?'/commands/'+command:'/run'),{
  method,headers:{Origin:ORIGIN,Authorization:'Bearer synthetic-session-123456789012345',...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:JSON.stringify(payload())}:{})});},
  async close(){await mf.dispose();handler.dispose();secret.fill(0);}};
}
test('actual gateway, dispatcher and container bridge preserve RECONCILIATION GET/POST authentication and bytes in workerd',options,async()=>{
 const f=await fixture();try{
  for(const method of ['POST','GET']){
   const response=await f.request(method);const text=await response.text();assert.equal(response.status,200,text+' '+JSON.stringify(f.calls));const value=JSON.parse(text);
   assert.equal(value.status,'stored');assert.equal(value.command_id,command);assert.equal(value.read_only,method==='GET');assert.equal(value.artifact.tls_origin_verified,true);assert.equal(value.sefaz_authorized,false);assert.equal(value.can_emit,false);assert.equal(value.can_transmit,false);
   assert.doesNotMatch(text,/lease_id|credential|fingerprint|private_executor|bucket|<definitions/);
  }
  assert.deepEqual(f.calls.service,[['run',{actor:f.actor,commandId:command,candidateId:candidate,signedHash:payload().signed_hash,expectedA1Version:1,expectedIdentityVersion:2,confirmed:true}],['command',{actor:f.actor,commandId:command}]]);
  assert.equal(f.calls.auth,2);assert.equal(f.calls.probes,2);
 }finally{await f.close();}
});
test('actual dispatcher and bridge reject cross-domain HMAC before readiness in workerd',options,async()=>{
 const f=await fixture(),path='/internal/v1/fiscal-reconciliation/commands/'+command;
 try{
  const base={secretBytes:f.secret,keyId:'synthetic-key',actor:f.actor,nonce:randomUUID(),method:'GET',path,bodyHash:await digest(new Uint8Array())};
  for(const authorization of [null,await signA1({...base,path:'/internal/v1/a1',audience:'synthetic-runtime'}),await signRuntimeRequest({...base,audience:'wrong-reconciliation'})]){
   const response=await (await f.mf.getWorker('executor')).fetch('https://fiscal-runtime.internal'+path,{headers:authorization?{Authorization:authorization}:{}});
   assert.equal(response.status,401);assert.equal((await response.json()).error,'RECONCILIATION_RUNTIME_UNAUTHORIZED');
  }
  assert.deepEqual(f.calls,{auth:0,probes:0,service:[]});
 }finally{await f.close();}
});

test('history and explicit recovery survive the real gateway and bridge without invoking run',options,async()=>{
 const f=await fixture();try{
  const headers={Origin:ORIGIN,Authorization:'Bearer synthetic-session-123456789012345','Content-Type':'application/json'};
  const page=await f.mf.dispatchFetch(`https://gateway.synthetic.invalid/v1/fiscal-reconciliation/candidates/${candidate}/history`,{method:'POST',headers,body:JSON.stringify({limit:25,before:null})});
  assert.equal(page.status,200);const value=await page.json();assert.equal(value.read_only,true);assert.equal(value.candidate_id,candidate);assert.equal(value.items[0].artifact.tls_origin_verified,true);
  const recovered=await f.mf.dispatchFetch('https://gateway.synthetic.invalid/v1/fiscal-reconciliation/recover',{method:'POST',headers,body:JSON.stringify({command_id:command})});
  assert.equal(recovered.status,200);const out=await recovered.json();assert.equal(out.recovered,true);assert.equal(out.read_only,false);assert.equal(out.retry_transport_allowed,false);
  assert.deepEqual(f.calls.service,[['history',{actor:f.actor,candidateId:candidate,limit:25,before:null}],['recover',{actor:f.actor,commandId:command}]]);
 }finally{await f.close();}
});
