import {closureBody,closureResult} from '../../fiscal-authorization-runtime/test/closure-fixtures.mjs';
import {revalidationBody,contextPath as revalidationContextPath,runPath as revalidationRunPath,commandPath as revalidationCommandPath} from '../../fiscal-authorization-runtime/test/revalidation-fixtures.mjs';
import {createContainerBridge} from '../../../workers/fiscal-executor/src/bridge.mjs';
import {selectedRunBody} from '../../fiscal-authorization-runtime/test/dispatch-fixtures.mjs';
// Entire configuration, authentication and upstream data in this file are synthetic.
// The only subprocess permitted by the composition tests is the fixture OpenSSL version check.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {fromEnvironment,createServer} from '../src/server.mjs';
import {FLAGS as A1_FLAGS} from '../src/dto.mjs';
import {signRuntimeRequest as signA1,digest} from '../src/auth.mjs';
import {signRuntimeRequest as signSigned} from '../../fiscal-signed-runtime/src/auth.mjs';
import {signRuntimeRequest as signWsdl} from '../../fiscal-wsdl-runtime/src/auth.mjs';
import {signRuntimeRequest as signReconciliation} from '../../fiscal-reconciliation-runtime/src/auth.mjs';
import {OPERATIONAL_FLAGS} from '../../fiscal-reconciliation/src/profiles.mjs';
import {signRuntimeRequest as signAuthorization} from '../../fiscal-authorization-runtime/src/auth.mjs';
import {preview as authorizationPreview} from '../../fiscal-authorization-http/test/fixtures.mjs';
import {FLAGS as AUTHORIZATION_FLAGS} from '../../fiscal-authorization-http/src/dto.mjs';
import {signRuntimeRequest as signDanfe} from '../../fiscal-danfe-runtime/src/auth.mjs';
import {signRuntimeRequest as signProcessedDanfe} from '../../fiscal-danfe-runtime/src/processed-auth.mjs';
import {fixture as danfeFixture} from '../../fiscal-danfe-runtime/test/fixtures.mjs';
import {FLAGS as WSDL_FLAGS} from '../../fiscal-sefaz-wsdl/src/service-dto.mjs';
import {binary} from '../../fiscal-vault/test/fixtures.mjs';
import {response as signedResponse,actor,candidate,command,vault,projectUrl,serviceKey} from '../../fiscal-signed-rpc/test/fixtures.mjs';

const a1Path='/internal/v1/a1',signedPath=`/internal/v1/fiscal-signed/candidates/${candidate}`;
const wsdlPath=`/internal/v1/fiscal-wsdl/commands/${command}`;
const keyId='composition-test',audience='composition',privateMarker='SYNTHETIC-PRIVATE-DO-NOT-RETURN';
const timeout=(promise,ms=2000)=>{
 let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('SYNTHETIC_TEST_DEADLINE')),ms);})]).finally(()=>clearTimeout(timer));
};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
function current(){return{version:0,state:'unconfigured',credential_id:null,company_identity_version:null,metadata:null,company_changed:false,time_valid_now:false};}
function responseFor(name){
 if(name==='erp_a1_authorize')return{...A1_FLAGS,vault_id:vault,company:{identity_version:1,cnpj:'12345678000195'},current:current()};
 if(name==='erp_a1_metadata')return{...A1_FLAGS,current:current(),private_executor_only:true,ciphertext:privateMarker};
 if(name==='erp_fiscal_signed_get')return signedResponse('get');
 if(name==='erp_fiscal_signed_command')return signedResponse('command');
 if(name==='erp_fiscal_wsdl_command'){
  const created=new Date(Date.now()-1000).toISOString(),expires=new Date(Date.now()+59000).toISOString();
  return{...WSDL_FLAGS,command_id:command,read_only:true,error_code:null,artifact:null,
   receipt:{attempt_id:candidate,command_id:command,profile:WSDL_FLAGS.profile,model:'55',operation:'protocol',environment:'2',a1_version:1,identity_version:1,confirmed:true,created_at:created},
   current:{state:'prepared',a1_version:1,identity_version:1,a1_changed:false,company_changed:false,certificate_time_valid_now:true,grant_consumed:false,
    lease_expired:false,expires_at:expires,used_at:null,finished_at:null,recovery_required:false,retry_get_allowed:false}};
 }
 assert.fail(`Unexpected synthetic RPC ${name}`);
}
async function setup(t,{reply=responseFor,protocolEnabled,reviewedEnabled,queryEnabled,storageReply,bridgeEnvironment=false}={}){
 const transport=randomBytes(32),fingerprint=randomBytes(32),kek=randomBytes(32),calls=[],processes=[];
 const env={SUPABASE_URL:projectUrl,SUPABASE_SERVICE_ROLE_KEY:serviceKey,A1_OPENSSL_PATH:binary,A1_ALLOW_LEGACY_PFX:'false',
  A1_KEK_RING_JSON:JSON.stringify({synthetic_kek:kek.toString('base64')}),A1_CURRENT_KEK_ID:'synthetic_kek',
  A1_TRANSPORT_SECRET:transport.toString('base64'),A1_FINGERPRINT_SECRET:fingerprint.toString('base64'),
  A1_TRANSPORT_KEY_ID:keyId,A1_AUDIENCE:audience,...(protocolEnabled===undefined?{}:{FISCAL_PROTOCOL_ENABLED:protocolEnabled}),...(reviewedEnabled===undefined?{}:{FISCAL_AUTHORIZATION_REVIEWED_ENABLED:reviewedEnabled}),...(queryEnabled===undefined?{}:{FISCAL_RECEIPT_QUERY_ENABLED:queryEnabled})};
 const forbidden=[env.A1_KEK_RING_JSON,env.A1_TRANSPORT_SECRET,env.A1_FINGERPRINT_SECRET,env.SUPABASE_SERVICE_ROLE_KEY,privateMarker];
 const originalSpawn=childProcess.spawn;
 t.mock.method(childProcess,'spawn',(program,args,options)=>{
  processes.push({program,args:[...args]});
  assert.equal(program,binary);assert.deepEqual(args,['version'],'Metadata must never open a PFX or invoke the schema process');
  return originalSpawn(program,args,options);
 });
 syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();transport.fill(0);fingerprint.fill(0);kek.fill(0);});
 let runtimeEnv=env;
 if(bridgeEnvironment){
  let forwarded;const container={running:false,images:{base:'synthetic'},start(options){forwarded=options.env;this.running=true;},async setInactivityTimeout(){},getTcpPort(){return{fetch:async()=>new Response(null,{status:401,headers:{'x-content-type-options':'nosniff'}})};}};
  const bridge=createContainerBridge({container},env,{wait:async()=>{},diagnostic:()=>{}}),path='/internal/v1/fiscal-authorization/reviewed/status';
  const auth=await signAuthorization({secretBytes:transport,keyId,audience:`${audience}-authorization`,actor,nonce:randomUUID(),method:'GET',path,bodyHash:await digest(new Uint8Array())});
  assert.equal((await bridge(new Request('https://fiscal-runtime.internal'+path,{headers:{Authorization:auth}}))).status,401);
  assert.equal(forwarded.FISCAL_AUTHORIZATION_REVIEWED_ENABLED,reviewedEnabled==='true'?'true':'false');
  runtimeEnv={...forwarded,A1_OPENSSL_PATH:binary};
 }
 const runtime=await fromEnvironment(runtimeEnv,{fetchImpl:async(url,options)=>{
  const parsed=new URL(url);assert.equal(parsed.origin,projectUrl);
  assert.equal(parsed.search,'');assert.ok(['manual','error'].includes(options.redirect));
  const headers=new Headers(options.headers);assert.equal(headers.get('apikey'),serviceKey);assert.equal(headers.get('authorization'),`Bearer ${serviceKey}`);
  assert.equal(headers.has('cookie'),false);assert.ok(options.signal instanceof AbortSignal);
  if(parsed.pathname.startsWith('/storage/v1/object/authenticated/brufap-fiscal-artifacts/')){
   assert.equal(options.method,'GET');assert.equal(typeof storageReply,'function');calls.push({name:'storage-read',args:{}});return storageReply(parsed.pathname,options);
  }
  assert.match(parsed.pathname,/^\/rest\/v1\/rpc\/erp_(?:(?:a1|fiscal_signed|fiscal_wsdl|fiscal_protocol|fiscal_authorization|fiscal_reviewed_authorization|fiscal_subset_review)_[a-z]+|fiscal_receipt_query_(?:context|begin|prepare|use|finish|fail|command|history)|fiscal_reviewed_authorization_(?:closure_command|close_expired|closure_lookup|revalidation_context|revalidation_command|revalidation_finish)|access_me)$/);assert.equal(options.method,'POST');
  const name=parsed.pathname.split('/').at(-1),args=JSON.parse(options.body);assert.equal(args.p_user_id,actor);
  calls.push({name,args});const value=await reply(name,args);
  return value instanceof Response?value:Response.json(value);
 }});
 t.after(()=>runtime.dispose());
 async function request(path,{kind=path.startsWith('/internal/v1/fiscal-authorization/')?'authorization':/\/fiscal-danfe\/(authorizations|revalidations|receipt-queries)\//.test(path)?'processedDanfe':path.startsWith('/internal/v1/fiscal-danfe/')?'danfe':path.startsWith('/internal/v1/fiscal-reconciliation/')?'reconciliation':path===a1Path?'a1':path===wsdlPath?'wsdl':'signed',overrideAudience,now,header,payload}={}){
  const method=payload===undefined?'GET':'POST',body=payload===undefined?new Uint8Array():new TextEncoder().encode(JSON.stringify(payload));
  const authorization=header??await(kind==='authorization'?signAuthorization:kind==='processedDanfe'?signProcessedDanfe:kind==='danfe'?signDanfe:kind==='reconciliation'?signReconciliation:kind==='a1'?signA1:kind==='wsdl'?signWsdl:signSigned)({secretBytes:transport,keyId,
   audience:overrideAudience??(kind==='a1'?audience:`${audience}-${kind==='processedDanfe'?'danfe':kind}`),actor,nonce:randomUUID(),method,path,bodyHash:await digest(body),...(now===undefined?{}:{now})});
  return new Request(`http://runtime.internal${path}`,{method,headers:{Authorization:authorization,...(payload===undefined?{}:{'Content-Type':'application/json'})},...(payload===undefined?{}:{body})});
 }
 async function checked(response,status=200){
  assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  const text=await response.text();for(const value of forbidden)assert.equal(text.includes(value),false);
  assert.doesNotMatch(text,/ciphertext|private_executor_only|lease_id|access_key|holder_cnpj|certificate_fingerprint|source_object|credential_object|key_id|<NFe/);
  return JSON.parse(text);
 }
 return{...runtime,env,calls,processes,transport,request,checked};
}

test('fromEnvironment composes A1 and signed metadata with exact RPC routing, removed env secrets and no credential access',async t=>{
 const f=await setup(t);
 for(const name of ['A1_KEK_RING_JSON','A1_TRANSPORT_SECRET','A1_FINGERPRINT_SECRET','SUPABASE_SERVICE_ROLE_KEY'])assert.equal(Object.hasOwn(f.env,name),false);
 assert.equal(f.env.SUPABASE_URL,projectUrl);assert.equal(f.env.A1_CURRENT_KEK_ID,'synthetic_kek');
 const a1=await f.checked(await f.handler(await f.request(a1Path)));
 assert.equal(a1.data_mode,'a1_custody');assert.equal(a1.current.state,'unconfigured');assert.equal(a1.can_emit,false);assert.equal(a1.can_transmit,false);
 assert.deepEqual(f.calls.map(c=>c.name),['erp_a1_authorize','erp_a1_metadata']);
 assert.deepEqual(Object.keys(f.calls[0].args).sort(),['p_action','p_issued_at','p_nonce','p_user_id']);assert.equal(f.calls[0].args.p_action,'metadata');
 assert.deepEqual(f.calls[1].args,{p_user_id:actor});
 const signed=await f.checked(await f.handler(await f.request(signedPath)));
 assert.equal(signed.candidate_id,candidate);assert.equal(signed.a1_version,1);assert.equal(signed.read_only,true);assert.equal(signed.can_emit,false);assert.equal(signed.can_transmit,false);
 assert.doesNotMatch(JSON.stringify(signed),/credential_id|credential_context|credential_metadata|unsigned_object|lease_until/);
 assert.deepEqual(f.calls.at(-1),{name:'erp_fiscal_signed_get',args:{p_user_id:actor,p_candidate_id:candidate}});
 const receipt=await f.checked(await f.handler(await f.request(`/internal/v1/fiscal-signed/commands/${command}`)));
 assert.equal(receipt.command_id,command);assert.equal(receipt.candidate_id,candidate);
 assert.doesNotMatch(JSON.stringify(receipt),/credential_id|credential_context|credential_metadata|unsigned_object|lease_until/);
 assert.deepEqual(f.calls.at(-1),{name:'erp_fiscal_signed_command',args:{p_user_id:actor,p_command_id:command}});
 assert.equal(f.calls.length,4);assert.deepEqual(f.processes,Array.from({length:5},()=>({program:binary,args:['version']})));
 const wsdl=await f.checked(await f.handler(await f.request(wsdlPath)));
 assert.equal(wsdl.data_mode,'fiscal_wsdl_evidence');assert.equal(wsdl.status,'prepared');assert.equal(wsdl.read_only,true);
 assert.equal(wsdl.can_emit,false);assert.equal(wsdl.binding_verified,false);
 assert.deepEqual(f.calls.at(-1),{name:'erp_fiscal_wsdl_command',args:{p_user_id:actor,p_command_id:command}});
 assert.equal(f.calls.length,5);
});

test('079 production composition routes historical reads through current ACL with issuance off and no certificate or SEFAZ use',async t=>{
 const f=await setup(t,{protocolEnabled:'false',reviewedEnabled:'false',reply:name=>{
  assert.match(name,/^erp_fiscal_reviewed_authorization_revalidation_(context|command)$/);
  return Response.json({code:'42501',message:privateMarker},{status:403});
 }});
 for(const[path,payload]of[[revalidationContextPath,undefined],[revalidationCommandPath,undefined],[revalidationRunPath,revalidationBody]]){
  const response=await f.checked(await f.handler(await f.request('/internal/v1/fiscal-authorization'+path,{payload})),403);
  assert.equal(response.error,'AUTHORIZATION_FORBIDDEN');assert.equal(response.recovery_required,false);
 }
 assert.deepEqual(f.calls.map(c=>c.name),['erp_fiscal_reviewed_authorization_revalidation_context','erp_fiscal_reviewed_authorization_revalidation_command','erp_fiscal_reviewed_authorization_revalidation_command']);
 assert.deepEqual(f.calls[0].args,{p_user_id:actor,p_authorization_command_id:revalidationBody.authorization_command_id,p_expected_attempt_id:revalidationBody.expected_attempt_id});
 assert.deepEqual(f.processes,Array.from({length:5},()=>({program:binary,args:['version']})));
});

test('composition rejects missing, expired, cross-domain and wrong-audience authentication before any fetch',async t=>{
 const f=await setup(t),validA1=await f.request(a1Path),validSigned=await f.request(signedPath),validWsdl=await f.request(wsdlPath);
 const wrongDomain=(request,domain)=>{
  const [scheme,token]=request.headers.get('authorization').split(' '),[id,encoded]=token.split('.');
  const mac=createHmac('sha256',f.transport).update(`${domain}.${id}.${encoded}`).digest('hex');
  return new Request(request.url,{headers:{Authorization:`${scheme} ${id}.${encoded}.${mac}`}});
 };
 const requests=[new Request(`http://runtime.internal${a1Path}`),new Request(`http://runtime.internal${signedPath}`),
  new Request(validA1.url,{headers:{Authorization:validSigned.headers.get('authorization')}}),
  new Request(validSigned.url,{headers:{Authorization:validA1.headers.get('authorization')}}),
  wrongDomain(validA1,'brufap-signed-request-v1'),wrongDomain(validSigned,'brufap-a1-request-v1'),
  await f.request(a1Path,{overrideAudience:'other'}),await f.request(signedPath,{overrideAudience:'other-signed'}),
  await f.request(a1Path,{now:Date.now()-61000}),await f.request(signedPath,{now:Date.now()-61000}),
  new Request(validWsdl.url,{headers:{Authorization:validSigned.headers.get('authorization')}}),
  new Request(validSigned.url,{headers:{Authorization:validWsdl.headers.get('authorization')}}),
  wrongDomain(validWsdl,'brufap-signed-request-v1'),await f.request(wsdlPath,{overrideAudience:'other-wsdl'}),await f.request(wsdlPath,{now:Date.now()-61000})];
 for(const request of requests){await f.checked(await f.handler(request),401);assert.equal(f.calls.length,0);}
 assert.deepEqual(f.processes,Array.from({length:5},()=>({program:binary,args:['version']})));
});

test('valid transport authentication still honors each RPC authorization and sanitizes upstream diagnostics',async t=>{
 const f=await setup(t,{reply:()=>Response.json({code:'42501',message:privateMarker,details:privateMarker},{status:403})});
 assert.equal((await f.checked(await f.handler(await f.request(a1Path)),403)).error,'A1_FORBIDDEN');
 assert.deepEqual(f.calls.map(c=>c.name),['erp_a1_authorize']);
 assert.equal((await f.checked(await f.handler(await f.request(signedPath)),403)).error,'SIGNED_FORBIDDEN');
 assert.deepEqual(f.calls.map(c=>c.name),['erp_a1_authorize','erp_fiscal_signed_get']);
 assert.equal((await f.checked(await f.handler(await f.request(wsdlPath)),403)).error,'WSDL_FORBIDDEN');
 assert.deepEqual(f.calls.map(c=>c.name),['erp_a1_authorize','erp_fiscal_signed_get','erp_fiscal_wsdl_command']);
 assert.deepEqual(f.processes,Array.from({length:5},()=>({program:binary,args:['version']})));
});

test('composition shares two admission slots across custody and signing and closes them on disposal',async t=>{
 const enteredA=deferred(),enteredSigned=deferred(),releaseA=deferred(),releaseSigned=deferred();let hold=true;
 const f=await setup(t,{reply:async name=>{
  if(hold&&name==='erp_a1_authorize'){enteredA.resolve();await releaseA.promise;}
  if(hold&&name==='erp_fiscal_signed_get'){enteredSigned.resolve();await releaseSigned.promise;}
  return responseFor(name);
 }});
 const a=f.handler(await f.request(a1Path));await timeout(enteredA.promise);
 const b=f.handler(await f.request(signedPath));await timeout(enteredSigned.promise);
 try{
  assert.equal((await f.checked(await f.handler(await f.request(a1Path)),503)).error,'A1_RUNTIME_BUSY');
  assert.equal((await f.checked(await f.handler(await f.request(signedPath)),503)).error,'SIGNED_RUNTIME_BUSY');
  assert.equal((await f.checked(await f.handler(await f.request(wsdlPath)),503)).error,'WSDL_RUNTIME_BUSY');
  const historyPath=`/internal/v1/fiscal-reconciliation/candidates/${candidate}/history`;
  const busy=await f.checked(await f.handler(await f.request(historyPath,{payload:{limit:25,before:null}})),503);
  assert.equal(busy.error,'RECONCILIATION_RUNTIME_BUSY');assert.equal(busy.recovery_required,false);
  const danfe=await f.checked(await f.handler(await f.request(`/internal/v1/fiscal-danfe/candidates/${candidate}/preview`)),503);
  assert.equal(danfe.error,'DANFE_RUNTIME_BUSY');assert.equal(danfe.recovery_required,false);
  const authorization=await f.checked(await f.handler(await f.request(`/internal/v1/fiscal-authorization/candidates/${candidate}/history`,{payload:{limit:25,before:null}})),503);
  assert.equal(authorization.error,'AUTHORIZATION_RUNTIME_BUSY');assert.equal(authorization.recovery_required,false);
  assert.equal(f.calls.length,2);
 }finally{hold=false;releaseA.resolve();releaseSigned.resolve();}
 await f.checked(await a);await f.checked(await b);
 await f.checked(await f.handler(await f.request(signedPath)));assert.equal(f.calls.length,4);
 f.dispose();await f.checked(await f.handler(await f.request(signedPath)),503);assert.equal(f.calls.length,4);
});

test('composed DANFE preview reads and reauthorizes the immutable XML for both models without opening A1',async t=>{
 for(const model of ['55','65'])await t.test(model,async t=>{
  const source=await danfeFixture({model});
  const f=await setup(t,{reply:(name,args)=>{
   assert.equal(name,'erp_fiscal_signed_get');assert.equal(args.p_candidate_id,source.id);return structuredClone(source.raw);
  },storageReply:(path)=>{
   assert.equal(path,`/storage/v1/object/authenticated/brufap-fiscal-artifacts/candidates/${source.id}/${source.context.sha256}.xml`);
   return new Response(new Uint8Array(source.bytes),{headers:{'Content-Type':'application/octet-stream','Content-Length':String(source.bytes.length)}});
  }});
  const path=`/internal/v1/fiscal-danfe/candidates/${source.id}/preview`,value=await f.checked(await f.handler(await f.request(path)));
  assert.equal(value.model,model);assert.equal(value.candidate_id,source.id);assert.equal(value.source_sha256,source.context.sha256);assert.equal(value.html,source.dto.html);
  assert.deepEqual(f.calls.map(c=>c.name),['erp_fiscal_signed_get','storage-read','erp_fiscal_signed_get']);
  assert.deepEqual(f.processes,Array.from({length:5},()=>({program:binary,args:['version']})));
  const other=await f.request(signedPath);await f.checked(await f.handler(await f.request(path,{header:other.headers.get('authorization')})),401);assert.equal(f.calls.length,3);
 });
});

test('real operational service is disabled by default before any RPC, credential or SOAP operation',async t=>{
 const f=await setup(t);
 const path='/internal/v1/fiscal-reconciliation/run',payload={command_id:command,candidate_id:candidate,signed_hash:'a'.repeat(64),expected_a1_version:1,expected_identity_version:1,confirmed:true};
 const value=await f.checked(await f.handler(await f.request(path,{payload})),409);
 assert.deepEqual(value,{error:'RECONCILIATION_DISABLED',recovery_required:false});assert.equal(f.calls.length,0);
 assert.deepEqual(f.processes,Array.from({length:5},()=>({program:binary,args:['version']})));
 for(const [kind,otherPath] of [['a1',a1Path],['signed',signedPath],['wsdl',wsdlPath]]){
  const other=await f.request(otherPath,{kind});
  const result=await f.checked(await f.handler(await f.request(path,{header:other.headers.get('authorization'),payload})),401);
  assert.equal(result.error,'RECONCILIATION_RUNTIME_UNAUTHORIZED');
 }
 assert.equal(f.calls.length,0);
});

test('disabled protocol history remains read-only and command recovery respects current SQL ACL',async t=>{
 const f=await setup(t,{protocolEnabled:'false',reply:(name,args)=>{
  if(name==='erp_fiscal_protocol_history')return {...OPERATIONAL_FLAGS,read_only:true,candidate_id:args.p_candidate_id,items:[],limit:args.p_limit,has_more:false,next_cursor:null};
  if(name==='erp_fiscal_protocol_command')return Response.json({code:'42501',message:privateMarker},{status:403});
  assert.fail('A read-only request must not begin or consume a protocol grant');
 }});
 const path=`/internal/v1/fiscal-reconciliation/candidates/${candidate}/history`;
 const history=await f.checked(await f.handler(await f.request(path,{payload:{limit:3,before:'7'}})));
 assert.deepEqual(history,{...OPERATIONAL_FLAGS,read_only:true,candidate_id:candidate,items:[],limit:3,has_more:false,next_cursor:null});
 assert.deepEqual(f.calls,[{name:'erp_fiscal_protocol_history',args:{p_user_id:actor,p_candidate_id:candidate,p_limit:3,p_before:'7'}}]);
 for(const [path,payload]of [[`/internal/v1/fiscal-reconciliation/commands/${command}`,undefined],['/internal/v1/fiscal-reconciliation/recover',{command_id:command}]]){
  assert.equal((await f.checked(await f.handler(await f.request(path,{payload})),403)).error,'RECONCILIATION_FORBIDDEN');
 }
 assert.ok(f.calls.slice(1).every(x=>x.name==='erp_fiscal_protocol_command'));assert.equal(f.calls.length,3);
 assert.deepEqual(f.processes,Array.from({length:5},()=>({program:binary,args:['version']})));
});

function exchange(server){
 const incoming=Readable.from([Buffer.from('{"synthetic":true}')]);Object.assign(incoming,{url:'/internal/v1/synthetic',method:'POST',headers:{'content-type':'application/json'}});
 const outgoing=new EventEmitter(),ended=deferred();Object.assign(outgoing,{headersSent:false,writableFinished:false,
  writeHead(status,headers){this.headersSent=true;this.status=status;this.headers=headers;},
  end(body){this.body=body;this.writableFinished=true;ended.resolve();}});
 server.emit('request',incoming,outgoing);return{incoming,outgoing,ended:ended.promise};
}
test('HTTP adapter aborts work when the response closes after the complete request body, without a socket',async t=>{
 const bodyRead=deferred(),observed=deferred();let signal;
 const server=createServer(async request=>{
  signal=request.signal;assert.deepEqual(await request.json(),{synthetic:true});bodyRead.resolve();
  await new Promise(resolve=>request.signal.addEventListener('abort',resolve,{once:true}));observed.resolve();
  return Response.json({error:'SYNTHETIC_CANCELLED'},{status:503});
 });
 t.after(()=>server.close());const {incoming,outgoing,ended}=exchange(server);
 await timeout(bodyRead.promise);assert.equal(incoming.readableEnded,true);assert.equal(signal.aborted,false);
 outgoing.emit('close');await timeout(observed.promise);await timeout(ended);assert.equal(signal.aborted,true);
 assert.equal(outgoing.status,503);assert.equal(new TextDecoder().decode(outgoing.body),'{"error":"SYNTHETIC_CANCELLED"}');assert.equal(outgoing.listenerCount('close'),0);
});
test('HTTP adapter does not cancel a completed response and removes its close listener',async t=>{
 let signal;const server=createServer(async request=>{signal=request.signal;await request.arrayBuffer();return Response.json({synthetic:true});});
 t.after(()=>server.close());const {outgoing,ended}=exchange(server);await timeout(ended);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(outgoing.writableFinished,true);assert.equal(signal.aborted,false);assert.equal(outgoing.listenerCount('close'),0);
 outgoing.emit('close');assert.equal(signal.aborted,false);assert.equal(outgoing.status,200);
});


test('authorization read composition previews exact stored bytes, history and denied recovery without PFX, validator or writes',async t=>{
 for(const model of ['55','65'])await t.test(model,async t=>{
  const source=await danfeFixture({model});
  source.raw.receipt.certificate_fingerprint=source.signed.certificateFingerprint;
  Object.assign(source.raw.artifact.evidence.signature,{certificate_fingerprint:source.signed.certificateFingerprint,reference_digest:source.signed.referenceDigest,signed_content_hash:source.signed.signedContentDigest});
  const publicPreview={...authorizationPreview(),candidate_id:source.id,signed_hash:source.context.sha256,model};publicPreview.policy.model=model;
  const {signature_checked,certificate_pin_checked,operational_binding_available,service_enabled,...sqlPreview}=publicPreview;
  const f=await setup(t,{reply:(name,args)=>{
   if(name==='erp_fiscal_signed_get')return structuredClone(source.raw);
   if(name==='erp_fiscal_authorization_preview'){assert.equal(args.p_candidate_id,source.id);assert.equal(args.p_signed_hash,source.context.sha256);return sqlPreview;}
   if(name==='erp_fiscal_authorization_history')return {...AUTHORIZATION_FLAGS,read_only:true,candidate_id:source.id,items:[],limit:args.p_limit,has_more:false,next_cursor:null};
   if(name==='erp_fiscal_authorization_command')return Response.json({code:'42501',message:privateMarker},{status:403});
   assert.fail('Authorization read composition must never invoke mutation RPCs');
  },storageReply:path=>{
   assert.equal(path,`/storage/v1/object/authenticated/brufap-fiscal-artifacts/candidates/${source.id}/${source.context.sha256}.xml`);
   return new Response(new Uint8Array(source.bytes),{headers:{'Content-Type':'application/octet-stream','Content-Length':String(source.bytes.length)}});
  }});
  const base='/internal/v1/fiscal-authorization',payload={candidate_id:source.id,signed_hash:source.context.sha256};
  const out=await f.checked(await f.handler(await f.request(base+'/preview',{payload})));assert.deepEqual(out,publicPreview);
  assert.deepEqual(f.calls.map(x=>x.name),['erp_fiscal_signed_get','storage-read','erp_fiscal_signed_get','erp_fiscal_authorization_preview']);
  const h=await f.checked(await f.handler(await f.request(base+`/candidates/${source.id}/history`,{payload:{limit:25,before:null}})));assert.deepEqual(h.items,[]);
  const run=await f.checked(await f.handler(await f.request(base+'/run',{payload:{...payload,command_id:command,expected_identity_version:1,expected_a1_version:1,expected_policy_version:1,confirmed:true}})),503);
  assert.equal(run.error,'AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE');assert.equal(run.recovery_required,false);assert.equal(f.calls.length,5);
  const recovery=await f.checked(await f.handler(await f.request(base+'/recover',{payload:{command_id:command}})),403);assert.equal(recovery.error,'AUTHORIZATION_FORBIDDEN');assert.equal(recovery.command_id,command);assert.equal(f.calls.at(-1).name,'erp_fiscal_authorization_command');
  const signed=await f.request(signedPath);await f.checked(await f.handler(await f.request(base+'/preview',{payload,header:signed.headers.get('authorization')})),401);assert.equal(f.calls.length,6);
  assert.deepEqual(f.processes,Array.from({length:5},()=>({program:binary,args:['version']})));
 });
});

test('review composition routes command only to068 ACL without Storage or credential access',async t=>{const f=await setup(t,{reply:async(name,args)=>{assert.equal(name,'erp_fiscal_subset_review_command');assert.deepEqual(args,{p_user_id:actor,p_command_id:command});return Response.json({code:'42501',message:privateMarker},{status:403});}});const path=`/internal/v1/fiscal-authorization/review-commands/${command}`,response=await f.checked(await f.handler(await f.request(path)),403);assert.equal(response.error,'AUTHORIZATION_FORBIDDEN');assert.equal(response.recovery_required,false);assert.deepEqual(f.calls.map(x=>x.name),['erp_fiscal_subset_review_command']);assert.ok(f.processes.every(p=>p.args.join(' ')==='version'));});


test('reviewed composition status reads current membership only and default run never reaches SQL, cofre or validator',async t=>{
 const f=await setup(t,{reply:name=>{assert.equal(name,'erp_access_me');return{user_id:actor,role:'fiscal',resources:['nfe','nfce'],data_mode:'staging_readonly'};}});
 const status=await f.checked(await f.handler(await f.request('/internal/v1/fiscal-authorization/reviewed/status')));
 assert.equal(status.runtime_enabled,false);assert.equal(status.policy_checked,false);assert.equal(status.tax_rules_validated,false);assert.equal(status.can_transmit,false);
 const result=await f.checked(await f.handler(await f.request('/internal/v1/fiscal-authorization/reviewed/run',{payload:{...selectedRunBody,command_id:command,candidate_id:candidate}})),503);
 assert.equal(result.error,'AUTHORIZATION_SERVICE_DISABLED');assert.equal(result.recovery_required,false);assert.deepEqual(f.calls.map(x=>x.name),['erp_access_me']);assert.ok(f.processes.every(x=>x.args.join()==='version'));
});
test('reviewed status refuses a non-fiscal current membership despite a verified HMAC actor',async t=>{
 const f=await setup(t,{reply:()=>({user_id:actor,role:'consulta',resources:['nfe','nfce'],data_mode:'staging_readonly'})});
 await f.checked(await f.handler(await f.request('/internal/v1/fiscal-authorization/reviewed/status')),403);assert.equal(f.calls.length,1);
});


test('executor bridge forwards only literal true for reviewed gate into the real fromEnvironment composition',async t=>{
 for(const flag of [undefined,'false','true','TRUE','1'])await t.test(String(flag),async t=>{
  const f=await setup(t,{bridgeEnvironment:true,reviewedEnabled:flag,reply:name=>{assert.equal(name,'erp_access_me');return{user_id:actor,role:'fiscal',resources:['nfe','nfce'],data_mode:'staging_readonly'};}});
  const value=await f.checked(await f.handler(await f.request('/internal/v1/fiscal-authorization/reviewed/status')));assert.equal(value.runtime_enabled,flag==='true');assert.equal(value.can_transmit,false);assert.deepEqual(f.calls.map(x=>x.name),['erp_access_me']);
 });
});


test('074 composition reaches only closure/current authorization ACL with reviewed gateoff and no private resources',async t=>{
 const f=await setup(t,{reviewedEnabled:'false',reply:(name,args)=>{
  if(name==='erp_fiscal_reviewed_authorization_closure_command')return args.p_command_id===closureBody.command_id?closureResult(true,{privateHash:true}):Response.json({code:'P0002',message:privateMarker},{status:404});
  assert.equal(name,'erp_fiscal_reviewed_authorization_command');return Response.json({code:'42501',message:privateMarker},{status:403});
 }});
 const base='/internal/v1/fiscal-authorization/reviewed',read=await f.checked(await f.handler(await f.request(base+'/closure-commands/'+closureBody.command_id)));
 assert.deepEqual(read,closureResult(true));assert.equal(Object.hasOwn(read.receipt,'request_hash'),false);
 const replay=await f.checked(await f.handler(await f.request(base+'/close-expired',{payload:closureBody})));assert.deepEqual(replay,{...closureResult(true),read_only:false});
 const newBody={...closureBody,command_id:randomUUID()},denied=await f.checked(await f.handler(await f.request(base+'/close-expired',{payload:newBody})),403);
 assert.equal(denied.error,'AUTHORIZATION_FORBIDDEN');assert.equal(denied.command_id,newBody.command_id);assert.equal(denied.recovery_required,false);
 assert.deepEqual(f.calls.map(x=>x.name),['erp_fiscal_reviewed_authorization_closure_command','erp_fiscal_reviewed_authorization_closure_command','erp_fiscal_reviewed_authorization_closure_command','erp_fiscal_reviewed_authorization_command']);
 assert.ok(f.processes.every(x=>x.args.join()==='version'));
});


test('075 composition discovers an existing receipt with only the fixed readonly RPC and disabled gate',async t=>{
 let fail=false;const f=await setup(t,{reviewedEnabled:'false',reply:(name,args)=>{
  assert.equal(name,'erp_fiscal_reviewed_authorization_closure_lookup');assert.deepEqual(args,{p_user_id:actor,p_authorization_command_id:closureBody.authorization_command_id,p_expected_attempt_id:closureBody.expected_attempt_id});
  return fail?Response.json({code:'P0002',message:privateMarker},{status:404}):closureResult(true,{privateHash:true});
 }});
 const path=`/internal/v1/fiscal-authorization/reviewed/commands/${closureBody.authorization_command_id}/attempts/${closureBody.expected_attempt_id}/closure`;
 const result=await f.checked(await f.handler(await f.request(path)));assert.deepEqual(result,closureResult(true));assert.equal(Object.hasOwn(result.receipt,'request_hash'),false);
 fail=true;const absent=await f.checked(await f.handler(await f.request(path)),404);assert.deepEqual(absent,{error:'AUTHORIZATION_NOT_FOUND',recovery_required:false});
 assert.deepEqual(f.calls.map(c=>c.name),Array(2).fill('erp_fiscal_reviewed_authorization_closure_lookup'));assert.ok(f.processes.every(c=>c.args.join()==='version'));
});

test('processed document routes use only the original actor command ACL, never custody or Storage after denial',async t=>{
 const f=await setup(t,{reviewedEnabled:'false',reply:(name,args)=>{
  assert.ok(['erp_fiscal_reviewed_authorization_command','erp_fiscal_reviewed_authorization_revalidation_command'].includes(name));
  assert.deepEqual(args,{p_user_id:actor,p_command_id:command});return Response.json({code:'42501',message:privateMarker},{status:403});
 }});
 for(const source of ['authorizations','revalidations'])for(const action of ['xml','print']){
  const path=`/internal/v1/fiscal-danfe/${source}/${command}/${action}`;
  const denied=await f.checked(await f.handler(await f.request(path)),403);assert.deepEqual(denied,{error:'DANFE_FORBIDDEN',recovery_required:false});
 }
 assert.deepEqual(f.calls.map(x=>x.name),['erp_fiscal_reviewed_authorization_command','erp_fiscal_reviewed_authorization_command','erp_fiscal_reviewed_authorization_revalidation_command','erp_fiscal_reviewed_authorization_revalidation_command']);
 assert.ok(f.processes.every(x=>x.args.join(' ')==='version'));
 f.dispose();const closed=await f.checked(await f.handler(await f.request(`/internal/v1/fiscal-danfe/revalidations/${command}/xml`)),503);
 assert.equal(closed.error,'DANFE_RUNTIME_BUSY');assert.equal(f.calls.length,4);
});


test('089 disabled run returns a definite refusal before SQL or certificate; reads reach only exact089 ACL',async t=>{
 const f=await setup(t,{reply(name){assert.ok(['erp_fiscal_receipt_query_context','erp_fiscal_receipt_query_history','erp_fiscal_receipt_query_command'].includes(name));return Response.json({code:'42501',message:'synthetic denial'},{status:403});}});
 const {publicSelection,uuid}=await import('../../fiscal-authorization/test/receipt-query-public-fixture.mjs');
 const root='/internal/v1/fiscal-authorization/reviewed',input={...publicSelection(),command_id:uuid(11),confirmed:true};
 const denied=await f.checked(await f.handler(await f.request(root+'/receipt-queries',{payload:input})),503);assert.equal(denied.error,'AUTHORIZATION_SERVICE_DISABLED');assert.equal(denied.recovery_required,false);assert.equal(f.calls.length,0);
 for(const[path,payload]of [
  [root+'/receipt-query-context',{source_kind:'authorization',source_command_id:uuid(1),expected_attempt_id:uuid(3)}],
  [root+'/receipt-query-history',{authorization_command_id:uuid(1),expected_attempt_id:uuid(3),limit:25,before:null}],
  [root+'/receipt-query-commands/'+uuid(11),undefined]]){
  const value=await f.checked(await f.handler(await f.request(path,{payload})),403);assert.equal(value.error,'AUTHORIZATION_FORBIDDEN');assert.equal(value.recovery_required,false);
 }
 assert.deepEqual(f.calls.map(x=>x.name),['erp_fiscal_receipt_query_context','erp_fiscal_receipt_query_history','erp_fiscal_receipt_query_command']);assert.deepEqual(f.processes,Array.from({length:5},()=>({program:binary,args:['version']})));
});
test('089 processed reads use query command ACL and no older authorization fallback after denial',async t=>{
 const f=await setup(t,{reply(name){assert.equal(name,'erp_fiscal_receipt_query_command');return Response.json({code:'42501',message:'synthetic denial'},{status:403});}});
 for(const action of ['xml','print']){const value=await f.checked(await f.handler(await f.request(`/internal/v1/fiscal-danfe/receipt-queries/${command}/${action}`)),403);assert.equal(value.error,'DANFE_FORBIDDEN');}
 assert.deepEqual(f.calls.map(x=>x.name),['erp_fiscal_receipt_query_command','erp_fiscal_receipt_query_command']);assert.deepEqual(f.processes,Array.from({length:5},()=>({program:binary,args:['version']})));
});
