import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {fixture,BUCKET} from '../../fiscal-unsigned-orchestrator/test/fixture.mjs';
import {commercialFoundation,applyPricePrecision} from '../../../tools/migration/fixtures/fiscal-price-precision.mjs';

const enabled=process.env.BRUFAP_RUN_WORKERD_TESTS==='1';
const options={skip:!enabled,timeout:60000};
let Miniflare,convertV4MiniflareOptions,bundled,signRuntimeRequest,digest;
if(enabled){
 ({Miniflare,convertV4MiniflareOptions}=await import('miniflare'));
 ({signRuntimeRequest,digest}=await import('../src/auth.mjs'));
 const{build}=await import('esbuild');
 const result=await build({stdin:{contents:"import {createUnsignedExecutor} from './src/handler.mjs'; let h; export default {fetch(request,env){h??=createUnsignedExecutor(env,(...args)=>fetch(...args));return h(request)}};",
  resolveDir:fileURLToPath(new URL('..',import.meta.url)),sourcefile:'unsigned-workerd-fixture.mjs'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['node:*'],logLevel:'silent'});
 bundled=result.outputFiles[0].text;
}
async function worker(f,{rpcRedirect=false}={}){
 const secret=randomBytes(32),calls=[];
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundled,compatibilityDate:'2026-10-16',cf:false,
  bindings:{SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key-for-offline-test',
   A1_TRANSPORT_SECRET:secret.toString('base64'),A1_TRANSPORT_KEY_ID:'test-key',A1_AUDIENCE:'synthetic'},
  outboundService:async request=>{
   const url=new URL(request.url);assert.equal(url.origin,'https://abcdefghijklmnopqrst.supabase.co');calls.push({method:request.method,path:url.pathname});
   assert.equal(request.headers.get('authorization'),'Bearer synthetic-service-key-for-offline-test');
   assert.equal(request.headers.get('apikey'),'synthetic-service-key-for-offline-test');
   if(url.pathname.startsWith('/rest/v1/rpc/erp_fiscal_unsigned_')){
    assert.equal(request.method,'POST');
    if(rpcRedirect)return new Response(null,{status:307,headers:{Location:'https://never-follow.invalid/'}});
    const args=await request.json();
    try{return Response.json(await f.rpc(url.pathname.split('/').at(-1),args,{signal:new AbortController().signal,deadline:Date.now()+40000}));}
    catch(e){return Response.json({code:e.code,message:'PRIVATE-ERROR-MUST-NOT-ESCAPE'},{status:400});}
   }
   const prefix=`/storage/v1/object/${request.method==='GET'?'authenticated/':''}${BUCKET}/`;
   assert.ok(url.pathname.startsWith(prefix),'Unexpected outbound request, including A1/SEFAZ');
   const key=url.pathname.slice(prefix.length),common={bucket:BUCKET,key,signal:new AbortController().signal,deadline:Date.now()+30000};
   if(request.method==='GET')return await f.ports.storage.read(common)??Response.json({code:'NoSuchKey'},{status:404});
   assert.equal(request.method,'POST');assert.equal(request.headers.get('x-upsert'),'false');assert.equal(request.headers.get('if-none-match'),'*');
   const ack=await f.ports.storage.putImmutable({...common,bytes:new Uint8Array(await request.arrayBuffer()),contentType:request.headers.get('content-type'),upsert:false,ifNoneMatch:'*'});
   return Response.json(ack.status===409?{code:'ResourceAlreadyExists'}:{Key:key},{status:ack.status});
  }}));
 return {calls,async request(action,payload,actor=f.users.fiscal){
  const method=payload===undefined?'GET':'POST',path='/internal/v1/fiscal-unsigned/'+action;
  const bytes=payload===undefined?new Uint8Array():new TextEncoder().encode(JSON.stringify(payload));
  const auth=await signRuntimeRequest({secretBytes:secret,keyId:'test-key',audience:'synthetic-unsigned',actor,nonce:randomUUID(),method,path,bodyHash:await digest(bytes)});
  const response=await mf.dispatchFetch('https://fiscal-runtime.internal'+path,{method,headers:{Authorization:auth,...(payload?{'Content-Type':'application/json'}:{})},...(payload?{body:bytes}:{})});
  return{status:response.status,body:await response.json()};
 },async close(){await mf.dispose();secret.fill(0);}};
}
const generation=j=>({command_id:j.commandId,reservation_id:j.reservationId,draft_id:j.draftId,completion_version:j.completionVersion,completion_hash:j.completionHash,basis_hash:j.basisHash});
test('workerd runs native RPC/storage ports and exact XML builder for NF-e/NFC-e, including 250 items',options,async()=>{
 const f=await fixture(),w=await worker(f);
 try{
  for(const[model,count]of [['55',1],['65',1],['55',250]]){
   const d=await f.prepare({model,count}),j=await f.input(d),before=await f.counts();
   const preview=await w.request('preview',{draft_id:j.draftId,completion_version:j.completionVersion});
   assert.equal(preview.status,200);assert.equal(preview.body.status,'checked');assert.equal(preview.body.items,count);
   const generated=await w.request('generate',generation(j));assert.equal(generated.status,200,JSON.stringify(generated.body));assert.equal(generated.body.status,'stored',JSON.stringify(generated.body));
   assert.equal(generated.body.can_emit,false);assert.equal(generated.body.can_transmit,false);assert.equal(generated.body.completion_hash,j.completionHash);
   const puts=f.calls.put.length,readback=await w.request('jobs/'+generated.body.job_id);assert.equal(readback.status,200);assert.equal(readback.body.artifact.sha256,generated.body.artifact.sha256);
   const command=await w.request('commands/'+j.commandId);assert.equal(command.status,200);assert.equal(command.body.command_id,j.commandId);
   const replay=await w.request('generate',generation(j));assert.equal(replay.body.status,'stored');assert.equal(f.calls.put.length,puts);
   const after=await f.counts();assert.equal(after.reservations,before.reservations);assert.equal(after.stock,before.stock);assert.equal(after.finance,before.finance);
   assert.ok(!/PRIVATE-ERROR|execution|holder_cnpj|issuedAt|cNF|access_key|lease_id|<NFe/.test(JSON.stringify(generated.body)));
  }
  assert.equal(w.calls.filter(c=>c.path.includes('/storage/')&&c.method==='POST').length,3);
 }finally{await w.close();await f.close();}
});
test('workerd refuses redirected RPC and unauthorized actor without any artifact or numbering mutation',options,async()=>{
 const f=await fixture(),w=await worker(f),redirected=await worker(f,{rpcRedirect:true});
 try{
  const d=await f.prepare(),j=await f.input(d),before=await f.counts();
  const denied=await w.request('generate',generation(j),f.users.consulta);assert.equal(denied.body.status,'blocked');assert.equal(denied.body.code,'UNSIGNED_RPC_42501');
  const failure=await redirected.request('generate',generation(j));assert.equal(failure.body.status,'blocked');assert.deepEqual(await f.counts(),before);
  assert.equal(redirected.calls.length,1);assert.equal(f.calls.put.length,0);
 }finally{await w.close();await redirected.close();await f.close();}
});
test('workerd executor bundles price10 without exposing prices in runtime metadata or changing old stored XML',options,async()=>{
 const f=await fixture(),w=await worker(f);
 try{
  await commercialFoundation(f);
  const old=await f.prepare(),oldInput=await f.input(old),oldResult=await w.request('generate',generation(oldInput));assert.equal(oldResult.body.status,'stored');
  const oldPath=`jobs/${oldResult.body.job_id}/${oldResult.body.artifact.sha256}.xml`,oldBytes=Buffer.from(f.files.get(oldPath));
  await applyPricePrecision(f);
  const beforeReplay=await f.counts(),replayed=await w.request('generate',generation(oldInput));assert.equal(replayed.body.artifact.sha256,oldResult.body.artifact.sha256);assert.deepEqual(f.files.get(oldPath),oldBytes);assert.deepEqual(await f.counts(),beforeReplay);
  for(const model of ['55','65']){
   const source=await f.prepare({model,quantity:'3.000000',unit_price:'0.0050000001'}),input=await f.input(source),before=await f.counts();
   const preview=await w.request('preview',{draft_id:input.draftId,completion_version:input.completionVersion});assert.equal(preview.body.status,'checked');
   const result=await w.request('generate',generation(input));assert.equal(result.status,200);assert.equal(result.body.status,'stored',JSON.stringify(result.body));
   const xml=f.files.get(`jobs/${result.body.job_id}/${result.body.artifact.sha256}.xml`).toString('utf8');assert.match(xml,/<vUnCom>0\.0050000001<\/vUnCom>/);assert.match(xml,/<vNF>0\.02<\/vNF>/);
   const current=await w.request('commands/'+input.commandId);assert.equal(current.body.artifact.sha256,result.body.artifact.sha256);
   assert.doesNotMatch(JSON.stringify(result.body),/0\.0050000001|<NFe|execution|holder_cnpj|access_key/);
   assert.equal(result.body.xsd_validated,false);assert.equal(result.body.signature_verified,false);assert.equal(result.body.can_transmit,false);
   const after=await f.counts();assert.equal(after.reservations,before.reservations);assert.equal(after.stock,0);assert.equal(after.finance,0);
  }
  assert.equal(w.calls.filter(c=>c.path.includes('/storage/')&&c.method==='POST').length,3);
 }finally{await w.close();await f.close();}
});
