import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createExecutorDispatch} from '../../../workers/fiscal-executor/src/dispatch.mjs';
import {fixture,BUCKET} from '../../fiscal-unsigned-orchestrator/test/fixture.mjs';
import {digest,signRuntimeRequest} from '../src/auth.mjs';

const base='https://fiscal-runtime.internal/internal/v1/fiscal-unsigned';
const projectUrl='https://abcdefghijklmnopqrst.supabase.co',serviceKey='synthetic-dispatcher-service-key';
const secret=new Uint8Array(32).fill(62),keyId='synthetic-dispatcher',audience='test-dispatcher';
const generation=j=>({command_id:j.commandId,reservation_id:j.reservationId,draft_id:j.draftId,completion_version:j.completionVersion,completion_hash:j.completionHash,basis_hash:j.basisHash});
async function signed(action,payload,actor){
 const method=payload===undefined?'GET':'POST',url=base+'/'+action,body=payload===undefined?new Uint8Array():new TextEncoder().encode(JSON.stringify(payload));
 const authorization=await signRuntimeRequest({secretBytes:secret,keyId,audience:audience+'-unsigned',actor,nonce:randomUUID(),method,path:new URL(url).pathname,bodyHash:await digest(body)});
 return new Request(url,{method,headers:{Authorization:authorization,...(payload?{'Content-Type':'application/json'}:{})},...(payload?{body}:{} )});
}
function onlyUnsignedEnv(){
 const fields={SUPABASE_URL:projectUrl,SUPABASE_SERVICE_ROLE_KEY:serviceKey,A1_TRANSPORT_SECRET:Buffer.from(secret).toString('base64'),A1_TRANSPORT_KEY_ID:keyId,A1_AUDIENCE:audience};
 const reads=[];const env=new Proxy(fields,{get(target,key){assert.ok(Object.hasOwn(target,key),'Unexpected environment access: '+String(key));reads.push(key);return target[key];}});
 return{env,reads};
}
function http(f,{redirect=false,afterRpc}={}){
 const calls=[];
 const fetchImpl=async(url,init)=>{
  const u=new URL(url);assert.equal(u.origin,projectUrl);assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');assert.equal(init.cache,'no-store');
  assert.ok(init.signal instanceof AbortSignal);assert.equal(init.signal.aborted,false);
  const headers=new Headers(init.headers);assert.equal(headers.get('authorization'),'Bearer '+serviceKey);assert.equal(headers.get('apikey'),serviceKey);
  calls.push({path:u.pathname,method:init.method});
  let response;
  if(u.pathname.startsWith('/rest/v1/rpc/erp_fiscal_unsigned_')){
   assert.equal(init.method,'POST');
   if(redirect)return new Response(null,{status:307,headers:{Location:'https://never-follow.invalid/'}});
   const name=u.pathname.split('/').at(-1),args=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(init.body));
   try{const value=await f.callSql(name,args);await afterRpc?.(name,args,value);response=Response.json(value);}
   catch(error){if(error?.code)response=Response.json({code:error.code,message:'PRIVATE-RAW-SQL',details:'PRIVATE-DIAGNOSTIC'},{status:400});else throw error;}
  }else{
   const prefix=`/storage/v1/object/${init.method==='GET'?'authenticated/':''}${BUCKET}/`;
   assert.ok(u.pathname.startsWith(prefix),'Unexpected outbound path: '+u.pathname);assert.ok(['GET','POST'].includes(init.method));
   const key=u.pathname.slice(prefix.length),options={bucket:BUCKET,key,signal:init.signal,deadline:Date.now()+30000};
   if(init.method==='GET')response=await f.ports.storage.read(options)??Response.json({code:'NoSuchKey'},{status:404});
   else{
    assert.equal(headers.get('x-upsert'),'false');assert.equal(headers.get('if-none-match'),'*');assert.equal(headers.get('content-type'),'application/octet-stream');
    const ack=await f.ports.storage.putImmutable({...options,bytes:new Uint8Array(init.body),contentType:'application/octet-stream',upsert:false,ifNoneMatch:'*'});
    response=Response.json(ack.status===409?{code:'ResourceAlreadyExists'}:{Key:key},{status:ack.status});
   }
  }
  Object.defineProperty(response,'url',{value:url});return response;
 };return{fetchImpl,calls};
}

test('the private dispatcher creates and caches only the unsigned handler per environment',async()=>{
 let factories=0,requests=0;const env=onlyUnsignedEnv().env,other=onlyUnsignedEnv().env,driver=()=>{throw Error('No network expected');};
 const dispatch=createExecutorDispatch({fetchImpl:driver,createUnsigned:(received,fetch)=>{
  assert.ok(received===env||received===other);assert.equal(fetch,driver);factories++;return async req=>{requests++;return Response.json({path:new URL(req.url).pathname});};
 }});
 for(const path of['','/preview','/unknown/nested'])assert.equal((await dispatch(new Request(base+path),env)).status,200);
 assert.equal(factories,1);assert.equal(requests,3);
 await dispatch(new Request(base+'/preview'),other);assert.equal(factories,2);
});

test('existing A1 requests still use the original named container without instantiating unsigned services',async()=>{
 let factories=0,gets=0,received;const req=new Request('https://fiscal-runtime.internal/internal/v1/a1/configure',{method:'POST',body:new Uint8Array([1,2,3])});
 const reply=Response.json({synthetic:true}),env={A1_CONTAINER:{getByName(name){gets++;assert.equal(name,'a1-custody-v1');return{async fetch(value){received=value;assert.deepEqual(new Uint8Array(await value.arrayBuffer()),new Uint8Array([1,2,3]));return reply;}};}}};
 const dispatch=createExecutorDispatch({createUnsigned:()=>{factories++;throw Error('Must not initialize');}});
 assert.equal(await dispatch(req,env),reply);assert.equal(received,req);assert.equal(gets,1);assert.equal(factories,0);
});

test('factory failures remain sanitized and a failed initialization is not cached',async()=>{
 let attempts=0;const dispatch=createExecutorDispatch({createUnsigned:()=>{attempts++;throw Error('PRIVATE-KEY-CREDENTIAL');}}),env=onlyUnsignedEnv().env;
 for(const method of['POST','GET']){
  const response=await dispatch(new Request(base+'/preview',{method}),env);assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'no-store');
  const body=await response.json();assert.deepEqual(body,{error:'UNSIGNED_RUNTIME_FAILED',recovery_required:method==='POST'});assert.doesNotMatch(JSON.stringify(body),/PRIVATE/);
 }assert.equal(attempts,2);
});

test('real executor factory traverses only synthetic RPC048 and immutable Storage HTTP; GET job never opens A1',async()=>{
 const f=await fixture();try{
  const transport=http(f),{env,reads}=onlyUnsignedEnv(),dispatch=createExecutorDispatch({fetchImpl:transport.fetchImpl});
  const p=await f.prepare(),j=await f.input(p),before=await f.counts();
  const preview=await dispatch(await signed('preview',{draft_id:j.draftId,completion_version:j.completionVersion},j.actor),env);assert.equal(preview.status,200);assert.equal((await preview.json()).status,'checked');
  const generated=await dispatch(await signed('generate',generation(j),j.actor),env);assert.equal(generated.status,200);const value=await generated.json();assert.equal(value.status,'stored',JSON.stringify(value));
  assert.equal(value.can_emit,false);assert.equal(value.can_transmit,false);assert.equal(value.signature_verified,false);
  const metadata=await dispatch(await signed('jobs/'+value.job_id,undefined,j.actor),env);assert.equal(metadata.status,200);const current=await metadata.json();assert.equal(current.job_id,value.job_id);assert.equal(current.artifact.sha256,value.artifact.sha256);
  assert.doesNotMatch(JSON.stringify(current),/identity|cnpj|access_key|lease_id|PRIVATE|<NFe|execution|inputs|bucket/);
  assert.ok(reads.every(key=>['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','A1_TRANSPORT_SECRET','A1_TRANSPORT_KEY_ID','A1_AUDIENCE'].includes(key)));
  assert.equal(transport.calls.filter(c=>c.path.includes('/storage/')&&c.method==='POST').length,1);
  const after=await f.counts();assert.equal(after.reservations,before.reservations);assert.equal(after.numbers,before.numbers);assert.equal(after.finance,0);assert.equal(after.stock,0);
  // Unsupported unsigned subpaths remain in this handler and never fall through into A1.
  assert.equal((await dispatch(new Request(base+'/not-a-route'),env)).status,404);
 }finally{await f.close();}
});

test('HTTP redirects are not followed and provider diagnostics cannot escape through the dispatcher',async()=>{
 const f=await fixture();try{
  const p=await f.prepare(),j=await f.input(p),transport=http(f,{redirect:true}),{env}=onlyUnsignedEnv(),dispatch=createExecutorDispatch({fetchImpl:transport.fetchImpl}),before=await f.counts();
  const response=await dispatch(await signed('generate',generation(j),j.actor),env);assert.equal(response.status,200);const body=await response.json();assert.equal(body.status,'blocked');assert.equal(body.outcome,'not_started');assert.equal(body.code,'UNSIGNED_PORT_FAILED');assert.equal(transport.calls.length,1);assert.deepEqual(await f.counts(),before);
  const normal=http(f),normalDispatch=createExecutorDispatch({fetchImpl:normal.fetchImpl});
  const denied=await normalDispatch(await signed('commands/'+j.commandId,undefined,f.users.consulta),env);assert.equal(denied.status,403);const out=await denied.json();assert.equal(out.error,'UNSIGNED_FORBIDDEN');assert.doesNotMatch(JSON.stringify(out),/PRIVATE/);
  assert.deepEqual(await f.counts(),before);assert.equal(f.calls.put.length,0);
 }finally{await f.close();}
});

test('a committed HTTP finish with lost ACK is reconciled without retrying the mutation or uploading again',async()=>{
 const f=await fixture();try{
  let lost=false;const transport=http(f,{afterRpc:async name=>{if(name.endsWith('_finish')&&!lost){lost=true;throw Error('PRIVATE-ACK');}}}),{env}=onlyUnsignedEnv(),dispatch=createExecutorDispatch({fetchImpl:transport.fetchImpl});
  const j=await f.input(await f.prepare()),response=await dispatch(await signed('generate',generation(j),j.actor),env);assert.equal(response.status,200);const first=await response.json();assert.equal(first.status,'stored');assert.equal(first.recovered,true);assert.equal(lost,true);
  const before=await f.counts(),puts=f.calls.put.length,finishes=transport.calls.filter(c=>c.path.endsWith('_finish')).length;
  const replay=await dispatch(await signed('generate',generation(j),j.actor),env);assert.equal((await replay.json()).job_id,first.job_id);
  assert.deepEqual(await f.counts(),before);assert.equal(f.calls.put.length,puts);assert.equal(transport.calls.filter(c=>c.path.endsWith('_finish')).length,finishes);
 }finally{await f.close();}
});
