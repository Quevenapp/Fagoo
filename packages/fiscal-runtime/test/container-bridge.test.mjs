import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createContainerBridge } from '../../../workers/fiscal-executor/src/bridge.mjs';
import { digest, signRuntimeRequest } from '../src/auth.mjs';
import { signRuntimeRequest as signSignedRequest } from '../../fiscal-signed-runtime/src/auth.mjs';
import { signRuntimeRequest as signWsdlRequest } from '../../fiscal-wsdl-runtime/src/auth.mjs';
import { WsdlRuntimeError } from '../../fiscal-wsdl-runtime/src/protocol.mjs';

test('container stays asleep for unauthenticated traffic; authenticated routing uses fixed port and secret whitelist', async () => {
  const secret = randomBytes(32), env = { SUPABASE_URL: 'https://synthetic.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key', A1_TRANSPORT_SECRET: secret.toString('base64'), A1_TRANSPORT_KEY_ID: 'transport', A1_AUDIENCE: 'test', A1_FINGERPRINT_SECRET: randomBytes(32).toString('base64'), A1_KEK_RING_JSON: JSON.stringify({ kek: randomBytes(32).toString('base64') }), A1_CURRENT_KEK_ID: 'kek', UNRELATED_SECRET: 'not forwarded' };
  let starts = 0, forwarded = 0, startArgs;
  const port = { async fetch(request) {
    if (typeof request === 'string') return new Response(null, { status: 401, headers: { 'X-Content-Type-Options': 'nosniff' } });
    forwarded++; assert.equal(request.url, 'http://container/internal/v1/a1'); assert.equal(request.headers.get('host'), null);
    return Response.json({ synthetic: true });
  } };
  const container = { running: false, images: { base: 'synthetic-image' }, start(args) { starts++; startArgs = args; this.running = true; }, async setInactivityTimeout(ms) { assert.equal(ms, 60000); }, getTcpPort(portNumber) { assert.equal(portNumber, 8080); return port; } };
  const bridge = createContainerBridge({ container }, env);
  assert.equal((await bridge(new Request('https://fiscal-runtime.internal/internal/v1/a1'))).status, 401); assert.equal(starts, 0);
  const authorization = await signRuntimeRequest({ secretBytes: secret, keyId: 'transport', audience: 'test', actor: randomUUID(), nonce: randomUUID(), method: 'GET', path: '/internal/v1/a1', bodyHash: await digest(new Uint8Array()) });
  const result = await bridge(new Request('https://fiscal-runtime.internal/internal/v1/a1', { headers: { Authorization: authorization } }));
  assert.equal(result.status, 200); assert.equal(starts, 1); assert.equal(forwarded, 1); assert.deepEqual(startArgs.instance, {vcpu:0.25,memoryMib:1024,diskMb:4000});
  assert.equal(startArgs.env.UNRELATED_SECRET, undefined); assert.equal(startArgs.env.A1_OPENSSL_PATH, '/usr/bin/openssl');
  assert.equal((await bridge(new Request('https://evil.invalid/internal/v1/a1', { headers: { Authorization: authorization } }))).status, 400); assert.equal(forwarded, 1);
});

test('signed routes require their own authentication domain before the fixed container starts', async () => {
  const secret=randomBytes(32),actor=randomUUID(),id=randomUUID(),path=`/internal/v1/fiscal-signed/candidates/${id}`;
  const env={SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',A1_TRANSPORT_SECRET:secret.toString('base64'),A1_TRANSPORT_KEY_ID:'transport',A1_AUDIENCE:'test',A1_FINGERPRINT_SECRET:randomBytes(32).toString('base64'),A1_KEK_RING_JSON:JSON.stringify({kek:randomBytes(32).toString('base64')}),A1_CURRENT_KEK_ID:'kek'};
  let starts=0,forwarded=0;
  const port={async fetch(request){
    if(typeof request==='string')return new Response(null,{status:401,headers:{'X-Content-Type-Options':'nosniff'}});
    forwarded++;assert.equal(request.url,`http://container${path}`);assert.match(request.headers.get('authorization'),/^Brufap-Signed /);return Response.json({synthetic:true});
  }};
  const container={running:false,images:{base:'synthetic-image'},start(args){starts++;this.running=true;assert.deepEqual(args.instance,{vcpu:0.25,memoryMib:1024,diskMb:4000});},async setInactivityTimeout(ms){assert.equal(ms,60000);},getTcpPort(n){assert.equal(n,8080);return port;}};
  const bridge=createContainerBridge({container},env);
  const sign=(fn,audience,signedPath=path)=>fn({secretBytes:secret,keyId:'transport',audience,actor,nonce:randomUUID(),method:'GET',path:signedPath,bodyHash:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'});
  for(const authorization of [null,await sign(signRuntimeRequest,'test','/internal/v1/a1'),await sign(signSignedRequest,'wrong-signed')]){
    const response=await bridge(new Request(`https://fiscal-runtime.internal${path}`,{headers:authorization?{Authorization:authorization}:{}}));assert.equal(response.status,401);
  }
  assert.equal(starts,0);assert.equal(forwarded,0);
  const authorization=await sign(signSignedRequest,'test-signed');
  const result=await bridge(new Request(`https://fiscal-runtime.internal${path}`,{headers:{Authorization:authorization}}));
  assert.equal(result.status,200);assert.equal(starts,1);assert.equal(forwarded,1);
  const cross=await bridge(new Request('https://fiscal-runtime.internal/internal/v1/a1',{headers:{Authorization:authorization}}));
  assert.equal(cross.status,401);assert.equal(forwarded,1);
});

async function wsdlFixture({startError,portError,missingConfiguration=false}={}){
 const secret=randomBytes(32),actor=randomUUID(),command=randomUUID(),stamp=Date.now(),calls={starts:[],probes:[],forwards:[],diagnostics:[]};
 const env={SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'SYNTHETIC_SERVICE_SENTINEL',A1_TRANSPORT_SECRET:secret.toString('base64'),A1_TRANSPORT_KEY_ID:'transport',A1_AUDIENCE:'test',A1_FINGERPRINT_SECRET:randomBytes(32).toString('base64'),A1_KEK_RING_JSON:JSON.stringify({kek:randomBytes(32).toString('base64')}),A1_CURRENT_KEK_ID:'kek',UNRELATED_SECRET:'SYNTHETIC_UNRELATED_SENTINEL'};
 if(missingConfiguration)delete env.SUPABASE_SERVICE_ROLE_KEY;
 const port={async fetch(request){
  if(typeof request==='string'){calls.probes.push(request);return new Response(null,{status:401,headers:{'X-Content-Type-Options':'nosniff'}});}
  if(portError)throw portError;
  calls.forwards.push({url:request.url,method:request.method,body:await request.text(),authorization:request.headers.get('authorization'),host:request.headers.get('host')});
  return Response.json({synthetic:true,command_id:command});
 }};
 const container={running:false,images:{base:'synthetic-image'},start(args){calls.starts.push(args);if(startError)throw startError;this.running=true;},async setInactivityTimeout(ms){assert.equal(ms,60000);},getTcpPort(n){assert.equal(n,8080);return port;}};
 const bridge=createContainerBridge({container},env,{now:()=>stamp,diagnostic:line=>calls.diagnostics.push(line)});
 const sign=async({domain='wsdl',method='GET',path=domain==='a1'?'/internal/v1/a1':domain==='signed'?`/internal/v1/fiscal-signed/commands/${command}`:`/internal/v1/fiscal-wsdl/commands/${command}`,body='',audience=domain==='a1'?'test':`test-${domain}`}={})=>({path,authorization:await({a1:signRuntimeRequest,signed:signSignedRequest,wsdl:signWsdlRequest}[domain])({secretBytes:secret,keyId:'transport',audience,actor,nonce:randomUUID(),method,path,bodyHash:await digest(new TextEncoder().encode(body)),now:stamp})});
 return{bridge,calls,command,sign,env};
}

test('WSDL GET and POST use the third HMAC domain while preserving A1 readiness and fixed container resources',async()=>{
 const f=await wsdlFixture(),body=JSON.stringify({command_id:f.command,model:'65',operation:'status',expected_a1_version:1,expected_identity_version:1,confirmed:true});
 for(const [method,path,text]of [['GET',`/internal/v1/fiscal-wsdl/commands/${f.command}`,''],['POST','/internal/v1/fiscal-wsdl/run',body]]){
  const token=await f.sign({method,path,body:text});
  const response=await f.bridge(new Request(`https://fiscal-runtime.internal${path}`,{method,headers:{Authorization:token.authorization,Host:'fiscal-runtime.internal',...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:text}:{})}));
  assert.equal(response.status,200);assert.equal((await response.json()).command_id,f.command);
  assert.deepEqual(f.calls.forwards.at(-1),{url:`http://container${path}`,method,body:text,authorization:token.authorization,host:null});
 }
 assert.equal(f.calls.starts.length,1);assert.deepEqual(f.calls.starts[0].instance,{vcpu:0.25,memoryMib:1024,diskMb:4000});
 assert.deepEqual(f.calls.probes,['http://container/internal/v1/a1','http://container/internal/v1/a1']);
 assert.equal(f.calls.starts[0].env.UNRELATED_SECRET,undefined);assert.equal(f.calls.starts[0].env.PORT,'8080');assert.equal(f.calls.starts[0].env.A1_OPENSSL_PATH,'/usr/bin/openssl');assert.equal(f.calls.diagnostics.length,0);
});

test('WSDL, signed and A1 credentials cannot cross domains or audiences before container start',async()=>{
 const f=await wsdlFixture(),wsdlPath=`/internal/v1/fiscal-wsdl/commands/${f.command}`;
 const a1=await f.sign({domain:'a1'}),signed=await f.sign({domain:'signed'}),wsdl=await f.sign(),wrong=await f.sign({audience:'other-wsdl'});
 for(const [path,authorization]of [[wsdlPath,null],[wsdlPath,a1.authorization],[wsdlPath,signed.authorization],[wsdlPath,wrong.authorization],[a1.path,wsdl.authorization],[signed.path,wsdl.authorization]]){
  const response=await f.bridge(new Request(`https://fiscal-runtime.internal${path}`,{headers:authorization?{Authorization:authorization}:{}}));assert.equal(response.status,401);
  if(path===wsdlPath)assert.equal((await response.json()).error,'WSDL_RUNTIME_UNAUTHORIZED');
 }
 assert.deepEqual(f.calls,{starts:[],probes:[],forwards:[],diagnostics:[]});
});

test('WSDL route and origin rejection use closed WSDL errors without booting the container',async()=>{
 const f=await wsdlFixture();
 for(const [url,method,status,code]of [
  ['https://fiscal-runtime.internal/internal/v1/fiscal-wsdl/run','GET',405,'WSDL_METHOD_NOT_ALLOWED'],
  ['https://fiscal-runtime.internal/internal/v1/fiscal-wsdl/unknown','POST',404,'WSDL_NOT_FOUND'],
  ['https://evil.invalid/internal/v1/fiscal-wsdl/run','POST',400,'WSDL_INVALID_REQUEST'],
  ['https://fiscal-runtime.internal/internal/v1/fiscal-wsdl/run?url=private','POST',400,'WSDL_INVALID_REQUEST'],
 ]){
  const response=await f.bridge(new Request(url,{method}));assert.equal(response.status,status);assert.deepEqual(await response.json(),{error:code,recovery_required:method==='POST'});
 }
 assert.deepEqual(f.calls,{starts:[],probes:[],forwards:[],diagnostics:[]});
});

test('WSDL boot and forwarding failures never expose A1-domain errors or arbitrary diagnostics',async()=>{
 for(const [options,expected]of [
  [{missingConfiguration:true},'WSDL_RUNTIME_CONFIGURATION_INVALID'],
  [{startError:new TypeError('SYNTHETIC_PRIVATE_BOOT_ERROR')},'WSDL_UPSTREAM_UNAVAILABLE'],
  [{portError:new WsdlRuntimeError(503,'SYNTHETIC_PRIVATE_CODE')},'WSDL_UPSTREAM_UNAVAILABLE'],
 ]){
  const f=await wsdlFixture(options),path='/internal/v1/fiscal-wsdl/run',body='{}',signed=await f.sign({path,method:'POST',body});
  const response=await f.bridge(new Request(`https://fiscal-runtime.internal${path}`,{method:'POST',headers:{Authorization:signed.authorization,'Content-Type':'application/json'},body}));
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:expected,recovery_required:true});
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  const logs=JSON.stringify(f.calls.diagnostics);assert.doesNotMatch(logs,/SYNTHETIC_|SUPABASE|Brufap-Wsdl|PRIVATE_CODE/);
 }
});

async function diagnosticFixture({phase='start',typeError=false,elapsed=37.8,diagnostic}={}){
 const secret=randomBytes(32),stamp=Date.now(),actor=randomUUID(),nonce=randomUUID(),path='/internal/v1/a1';
 const env={SUPABASE_URL:'https://synthetic-boot-sentinel.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'SYNTHETIC_SERVICE_SENTINEL',A1_TRANSPORT_SECRET:secret.toString('base64'),A1_TRANSPORT_KEY_ID:'synthetic-transport-id',A1_AUDIENCE:'synthetic-boot-audience',A1_FINGERPRINT_SECRET:randomBytes(32).toString('base64'),A1_KEK_RING_JSON:JSON.stringify({synthetic:randomBytes(32).toString('base64')}),A1_CURRENT_KEK_ID:'synthetic-ring-id'};
 const authorization=await signRuntimeRequest({secretBytes:secret,keyId:env.A1_TRANSPORT_KEY_ID,audience:env.A1_AUDIENCE,actor,nonce,method:'GET',path,bodyHash:await digest(new Uint8Array())});
 const sentinel=`SYNTHETIC_PLATFORM_ERROR ${authorization} ${JSON.stringify(env)}`,logs=[],counts={starts:0,probes:0,waits:0};let clock=stamp;
 const crash=()=>{clock=stamp+elapsed;throw new(typeError?TypeError:Error)(sentinel);};
 const port={async fetch(){counts.probes++;if(phase==='readiness')return new Response('SYNTHETIC_RESPONSE_BODY',{status:503,headers:{'x-private':'SYNTHETIC_HEADER'}});return new Response(null,{status:401,headers:{'X-Content-Type-Options':'nosniff'}});}};
 const container={running:false,images:{base:'SYNTHETIC_IMAGE_SENTINEL'},start(){counts.starts++;if(phase==='start')crash();this.running=true;},async setInactivityTimeout(){if(phase==='inactivity')crash();},getTcpPort(){if(phase==='port')crash();return port;}};
 if(phase==='configuration')delete env.SUPABASE_SERVICE_ROLE_KEY;
 const bridge=createContainerBridge({container},env,{now:()=>clock,wait:async ms=>{counts.waits++;clock+=ms;},diagnostic:diagnostic??(value=>logs.push(value))});
 const request=()=>new Request(`https://fiscal-runtime.internal${path}`,{headers:{Authorization:authorization,'x-unrelated':'SYNTHETIC_REQUEST_HEADER'}});
 return{bridge,request,logs,counts,env,authorization,actor,nonce};
}

test('boot diagnostics identify the failing boundary using fixed fields, never platform errors or credentials',async()=>{
 for(const phase of ['configuration','start','inactivity','port','readiness']){
  const f=await diagnosticFixture({phase,typeError:phase==='start'}),result=await f.bridge(f.request());assert.equal(result.status,503);assert.equal(f.logs.length,1);
  const line=f.logs[0],event=JSON.parse(line);assert.equal(typeof line,'string');assert.deepEqual(Object.keys(event).sort(),['event','phase','elapsed_ms','type_error'].sort());
  assert.equal(event.event,'fiscal_container_start_failed');assert.equal(event.phase,phase);assert.equal(typeof event.type_error,'boolean');assert.equal(event.type_error,phase==='start');
  assert.equal(Number.isInteger(event.elapsed_ms),true);assert.ok(event.elapsed_ms>=0&&event.elapsed_ms<=120000);
  for(const value of ['SYNTHETIC_PLATFORM_ERROR','SYNTHETIC_SERVICE_SENTINEL','SYNTHETIC_RESPONSE_BODY','SYNTHETIC_HEADER','SYNTHETIC_REQUEST_HEADER','SYNTHETIC_IMAGE_SENTINEL',f.authorization,f.actor,f.nonce,...Object.values(f.env)])assert.equal(line.includes(value),false);
  const body=await result.text();assert.doesNotMatch(body,/SYNTHETIC|stack|SUPABASE|Authorization/);
  if(phase==='readiness'){assert.equal(event.elapsed_ms,40000);assert.ok(f.counts.probes>25&&f.counts.probes<=201);assert.equal(f.counts.waits,f.counts.probes);}else assert.equal(f.counts.probes,0);
 }
});

test('boot elapsed diagnostics are integer bounded for backwards or oversized clock changes',async()=>{
 for(const [elapsed,expected]of [[-900,0],[37.8,37],[999999,120000]]){
  const f=await diagnosticFixture({elapsed});assert.equal((await f.bridge(f.request())).status,503);assert.equal(JSON.parse(f.logs[0]).elapsed_ms,expected);
 }
});

test('invalid authentication produces no boot diagnostic or container start, and a throwing logger cannot change the response',async()=>{
 const f=await diagnosticFixture();
 for(const header of [undefined,'Brufap-A1 SYNTHETIC_INVALID_TOKEN']){
  const response=await f.bridge(new Request('https://fiscal-runtime.internal/internal/v1/a1',{headers:header?{Authorization:header}:{}}));assert.equal(response.status,401);
 }
 assert.equal(f.logs.length,0);assert.equal(f.counts.starts,0);
 let calls=0;const throwing=await diagnosticFixture({diagnostic(){calls++;throw new Error('SYNTHETIC_LOGGER_PRIVATE_ERROR');}}),result=await throwing.bridge(throwing.request());
 assert.equal(result.status,503);assert.deepEqual(await result.json(),{error:'A1_UPSTREAM_UNAVAILABLE',recovery_required:false});assert.equal(calls,1);
});

test('a failed boot is not cached forever and each later authenticated attempt emits a sanitized failure',async()=>{
 const f=await diagnosticFixture({phase:'start'});
 assert.equal((await f.bridge(f.request())).status,503);assert.equal(f.counts.starts,1);assert.equal(f.logs.length,1);
 assert.equal((await f.bridge(f.request())).status,503);assert.equal(f.counts.starts,2);assert.equal(f.logs.length,2);
 assert.ok(f.logs.every(line=>JSON.parse(line).phase==='start'));
});
