// The deployed gateway and bridge are exercised with synthetic Auth and container ports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import gateway from '../../../workers/fiscal-gateway/src/index.mjs';
import {createContainerBridge} from '../../../workers/fiscal-executor/src/bridge.mjs';
import {signRuntimeRequest as signPreview} from '../../fiscal-danfe-runtime/src/auth.mjs';
import {signRuntimeRequest as signProcessed,digest} from '../../fiscal-danfe-runtime/src/processed-auth.mjs';

test('deployed gateway and bridge admit six historical GETs under their own exact path authentication',async()=>{
 const actor=randomUUID(),command=randomUUID(),secret=randomBytes(32),origin='https://app.synthetic.invalid';
 const env={SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_ANON_KEY:'synthetic-public-anon-key',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-role-key',ALLOWED_ORIGINS:origin,
  A1_TRANSPORT_SECRET:secret.toString('base64'),A1_TRANSPORT_KEY_ID:'synthetic',A1_AUDIENCE:'synthetic',A1_FINGERPRINT_SECRET:randomBytes(32).toString('base64'),A1_KEK_RING_JSON:JSON.stringify({synthetic:randomBytes(32).toString('base64')}),A1_CURRENT_KEK_ID:'synthetic',FISCAL_PROTOCOL_ENABLED:'false',FISCAL_AUTHORIZATION_REVIEWED_ENABLED:'false'};
 const calls={auth:0,starts:0,forwarded:[]};
 const port={async fetch(request){
  if(typeof request==='string')return new Response(null,{status:401,headers:{'X-Content-Type-Options':'nosniff'}});
  assert.equal(request.method,'GET');assert.equal(request.headers.get('host'),null);assert.equal(await request.text(),'');
  calls.forwarded.push(new URL(request.url).pathname);return Response.json({error:'DANFE_FORBIDDEN',recovery_required:false});
 }};
 // Return a denial status, not a malformed success projection.
 const deniedPort={fetch:async(...args)=>{const r=await port.fetch(...args);return typeof args[0]==='string'?r:new Response(await r.text(),{status:403,headers:r.headers});}};
 const container={running:false,images:{base:'synthetic-image'},start(options){calls.starts++;this.running=true;assert.equal(options.env.FISCAL_PROTOCOL_ENABLED,'false');assert.equal(options.env.FISCAL_AUTHORIZATION_REVIEWED_ENABLED,'false');},async setInactivityTimeout(ms){assert.equal(ms,60000);},getTcpPort(n){assert.equal(n,8080);return deniedPort;}};
 const bridge=createContainerBridge({container},env,{diagnostic:()=>assert.fail('No startup diagnostic expected')});env.A1_RUNTIME={fetch:request=>bridge(request)};
 const originalFetch=globalThis.fetch;globalThis.fetch=async(url,options)=>{calls.auth++;assert.equal(url,env.SUPABASE_URL+'/auth/v1/user');assert.match(options.headers.Authorization,/^Bearer synthetic-/);return Response.json({id:actor,is_anonymous:false});};
 try{
  for(const kind of ['authorizations','revalidations','receipt-queries'])for(const action of ['xml','print']){
   const path=`/v1/fiscal-danfe/${kind}/${command}/${action}`;
   const r=await gateway.fetch(new Request('https://gateway.synthetic.invalid'+path,{headers:{Origin:origin,Authorization:'Bearer synthetic-session-1234567890'}}),env);
   assert.equal(r.status,403);assert.deepEqual(await r.json(),{error:'DANFE_FORBIDDEN',recovery_required:false});assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('access-control-allow-origin'),origin);
  }
  assert.equal(calls.auth,6);assert.equal(calls.starts,1);assert.equal(calls.forwarded.length,6);
  const target=`/internal/v1/fiscal-danfe/revalidations/${command}/xml`,previewPath=`/internal/v1/fiscal-danfe/candidates/${command}/preview`,bodyHash=await digest(new Uint8Array());
  const signing={secretBytes:secret,keyId:'synthetic',audience:'synthetic-danfe',actor,nonce:randomUUID(),method:'GET',bodyHash};
  const preview=await signPreview({...signing,path:previewPath}),processed=await signProcessed({...signing,path:target});
  for(const[path,token]of [[target,preview],[previewPath,processed],[target.replace('/xml','/print'),processed]]){
   const r=await bridge(new Request('https://fiscal-runtime.internal'+path,{headers:{Authorization:token}}));assert.equal(r.status,401);
  }
  assert.equal(calls.forwarded.length,6);
  const mutation=await bridge(new Request('https://fiscal-runtime.internal'+target,{method:'POST',headers:{Authorization:processed}}));assert.equal(mutation.status,405);assert.equal((await mutation.json()).recovery_required,false);assert.equal(calls.forwarded.length,6);
 }finally{globalThis.fetch=originalFetch;secret.fill(0);}
});
