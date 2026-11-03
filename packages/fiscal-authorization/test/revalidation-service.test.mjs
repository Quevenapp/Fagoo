// Real SQL079/069/068/050, HTTP ports, public certificate/signature and Python XSD.
// Every record/certificate is synthetic; no network, A1 opening or transmission.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {revalidationFixture,PREFIX,hash} from './stored-response-revalidation-fixture.mjs';
import {createStoredResponseReader} from '../src/stored-response-reader.mjs';
import {createAuthorizationRevalidationRpc} from '../src/revalidation-rpc.mjs';
import {createAuthorizationRevalidationStorage} from '../src/revalidation-storage.mjs';
import {createAuthorizationRevalidationService} from '../src/revalidation-service.mjs';
import {projectRevalidationPublic} from '../src/revalidation-public-dto.mjs';
let f;test.before(async()=>{f=await revalidationFixture();});test.after(()=>f?.close());
const config={projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-service-key-not-secret'};
const failure=code=>Object.assign(new Error('PRIVATE_SENTINEL'),{code});
function compose(patch={}){
 const calls={rpc:[],read:[],put:[],reader:0},owned=[];
 const rpc=createAuthorizationRevalidationRpc({...config,fetchImpl:async(url,o)=>{const n=url.split('/').at(-1),a=JSON.parse(o.body);calls.rpc.push({n,a});assert.equal(o.redirect,'manual');if(patch.http)return patch.http(n,a);try{return Response.json(await f.callSql(n,a));}catch(e){return Response.json({code:e.code,message:'PRIVATE_SENTINEL'},{status:400});}}});
 const storage=createAuthorizationRevalidationStorage({...config,fetchImpl:async(url,o)=>{const key=url.split('brufap-fiscal-artifacts/')[1];assert.ok(key.startsWith('revalidations/'));if(o.method==='GET'){calls.read.push(key);const b=f.files.get(key);return b?new Response(Buffer.from(b),{headers:{'content-type':'application/octet-stream','content-length':String(b.length)}}):Response.json({code:'NoSuchKey'},{status:404});}
  assert.equal(o.method,'POST');assert.equal(o.headers['x-upsert'],'false');assert.equal(o.headers['If-None-Match'],'*');calls.put.push(key);owned.push(o.body);if(f.files.has(key))return Response.json({code:'ResourceAlreadyExists'},{status:409});const b=Buffer.from(o.body);f.files.set(key,b);await f.db.query('insert into storage.objects values($1,$2,$3::jsonb)',['brufap-fiscal-artifacts',key,JSON.stringify({size:b.length,mimetype:'application/octet-stream'})]);return Response.json({},{status:201});}});
 const reader=createStoredResponseReader({readCommand:async(x)=>f.wire('command',{p_user_id:x.actor,p_command_id:x.authorizationCommandId}),readObject:f.ports.storage.read,validate:f.ports.validate});
 const readStoredResponse=async(x,o)=>{calls.reader++;const v=await reader(x,o);owned.push(v.processedBytes);return v;};
 const service=createAuthorizationRevalidationService({rpc:patch.rpc?((a,x,o)=>patch.rpc(a,x,o,rpc)):rpc,readStoredResponse:patch.reader??readStoredResponse,storage:patch.storage??storage});
 return{service,calls,owned,rpc,storage,reader};
}
test('55/65 SQL→RPC→reader→real XSD→immutable Storage→append→public DTO; original terminal data unchanged',async()=>{
 for(const model of ['55','65']){
  const x=await f.startReal(model),p=compose(),before=await f.snapshot(),ctx=await p.service.context({actor:f.users.fiscal,authorizationCommandId:x.input.authorization_command_id,expectedAttemptId:x.input.expected_attempt_id});
  assert.equal(ctx.original.rejection_code,'SOAP_INVALID');assert.equal(ctx.can_revalidate,true);assert.equal(ctx.existing,null);assert.equal(p.calls.reader,0);
  projectRevalidationPublic(ctx,{action:'revalidationContext',authorizationCommandId:x.input.authorization_command_id,expectedAttemptId:x.input.expected_attempt_id});
  const result=await p.service.revalidate({actor:f.users.fiscal,request:x.input});assert.equal(result.receipt.state,'authorized_homologation');assert.equal(result.receipt.artifact.protocol_cstat,'100');assert.equal(result.receipt.artifact.response_hash,hash(x.response));assert.equal(result.receipt.artifact.tls_origin_verified,true);assert.equal(result.receipt.tax_rules_validated,false);assert.equal(result.read_only,false);assert.equal(result.replayed,false);
  assert.deepEqual(await f.snapshot(),before);assert.equal(p.calls.reader,1);assert.equal(p.calls.put.length,1);assert.equal(p.calls.rpc.filter(x=>x.n===PREFIX+'finish').length,1);assert.ok(p.owned.filter(Boolean).every(b=>b.every(v=>v===0)));
  const counts=[p.calls.reader,p.calls.put.length],again=await p.service.revalidate({actor:f.users.fiscal,request:x.input});assert.deepEqual(again.receipt,result.receipt);assert.equal(again.replayed,true);assert.deepEqual([p.calls.reader,p.calls.put.length],counts);
  const current=await p.service.context({actor:f.users.fiscal,authorizationCommandId:x.input.authorization_command_id,expectedAttemptId:x.input.expected_attempt_id});assert.equal(current.can_revalidate,false);assert.deepEqual(current.existing.receipt,result.receipt);
  const command=await p.service.command({actor:f.users.fiscal,commandId:x.input.command_id});assert.deepEqual(command.receipt,result.receipt);assert.equal(command.read_only,true);
  assert.ok(!JSON.stringify(result).includes(x.b.value.recovery.access_key));assert.ok(!JSON.stringify(result).includes('credential_id'));
 }
});
test('103 and rejection remain observations without processed Storage or promotion',async()=>{
 for(const [options,state]of [[{batch:'103',receipt:true,protocol:false},'receipt_pending'],[{status:'302'},'rejected'],[{status:'217'},'review_required']]){
  const x=await f.startReal('55',options),p=compose(),r=await p.service.revalidate({actor:f.users.fiscal,request:x.input});assert.equal(r.receipt.state,state);assert.equal(r.receipt.processed_hash,null);assert.equal(p.calls.put.length,0);assert.equal(r.receipt.artifact.signature_verified,false);
 }
});
test('finish ACK lost recovers only by GET; ACK+GET lost remains uncertain and no repeated finish',async()=>{
 for(const loseGet of [false,true]){
  const x=await f.startReal(),p=compose({rpc:async(a,args,o,real)=>{if(a==='finish'){await real(a,args,o);lost=true;throw failure('PRIVATE_FAILURE');}if(lost&&loseGet)throw failure('42501');return real(a,args,o);}});let lost=false;
  if(loseGet)await assert.rejects(p.service.revalidate({actor:f.users.fiscal,request:x.input}),e=>e.code==='42501'&&e.recovery_required===true&&e.command_id===x.input.command_id&&!e.message.includes('PRIVATE'));
  else{const r=await p.service.revalidate({actor:f.users.fiscal,request:x.input});assert.equal(r.replayed,true);}
  assert.equal(p.calls.rpc.filter(x=>x.n===PREFIX+'finish').length,1);const plain=compose(),r=await plain.service.command({actor:f.users.fiscal,commandId:x.input.command_id});assert.equal(r.receipt.state,'authorized_homologation');assert.equal(plain.calls.reader,0);assert.equal(plain.calls.put.length,0);
 }
});
test('structured finish SQL errors are definitive; unbranded SQL-looking errors remain uncertain',async()=>{
 for(const branded of [true,false]){const x=await f.startReal(),p=compose(branded?{http:async(n,args)=>{if(n===PREFIX+'finish')return Response.json({code:'40001',message:'PRIVATE'},{status:400});try{return Response.json(await f.callSql(n,args));}catch(e){return Response.json({code:e.code},{status:400});}}}:{rpc:async(a,x,o,real)=>{if(a==='finish')throw failure('40001');return real(a,x,o);}});
  await assert.rejects(p.service.revalidate({actor:f.users.fiscal,request:x.input}),e=>e.recovery_required===!branded&&e.command_id===x.input.command_id);assert.equal((await f.db.query('select count(*)::int n from erp_fiscal_authorization_revalidation.command where id=$1',[x.input.command_id])).rows[0].n,0);
 }
});
test('different UUID/body for a recorded source, source CAS drift and corrupt processed readback fail closed',async()=>{
 const x=await f.startReal(),p=compose();const r=await p.service.revalidate({actor:f.users.fiscal,request:x.input});
 for(const request of [{...x.input,command_id:randomUUID()},{...x.input,expected_source_hash:'0'.repeat(64)}])await assert.rejects(p.service.revalidate({actor:f.users.fiscal,request}),{code:'40001'});
 const key=p.calls.put[0],saved=f.files.get(key);f.files.set(key,Buffer.from('PRIVATE_CORRUPTION'));await assert.rejects(p.service.command({actor:f.users.fiscal,commandId:x.input.command_id}));f.files.set(key,saved);assert.equal((await p.service.command({actor:f.users.fiscal,commandId:x.input.command_id})).receipt.processed_hash,r.receipt.processed_hash);
});
test('ACL loss after final ACK prevents further private Storage reads; historical GET still needs current role',async()=>{
 const x=await f.startReal();let acknowledged=false;const p=compose({rpc:async(a,args,o,real)=>{if(acknowledged&&a==='command')throw failure('42501');const v=await real(a,args,o);if(a==='finish')acknowledged=true;return v;}});
 await assert.rejects(p.service.revalidate({actor:f.users.fiscal,request:x.input}),e=>e.code==='42501'&&e.recovery_required===true);assert.equal(p.calls.read.length,1);
 await f.db.query('update erp_access.membership set active=false where user_id=$1',[f.users.fiscal]);try{const q=compose();await assert.rejects(q.service.command({actor:f.users.fiscal,commandId:x.input.command_id}),{code:'42501'});assert.equal(q.calls.read.length,0);}finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[f.users.fiscal]);}
});
test('late reader bytes erased on abort, before any Storage write or finish',async()=>{
 const x=await f.startReal();let release,entered;const ready=new Promise(r=>{entered=r;}),p=compose({reader:()=>{entered();return new Promise(resolve=>{release=resolve;});}}),abort=new AbortController(),pending=p.service.revalidate({actor:f.users.fiscal,request:x.input},{signal:abort.signal});await ready;abort.abort();await assert.rejects(pending,{code:'AUTHORIZATION_SERVICE_ABORTED'});
 const bytes=Buffer.from('SYNTHETIC_PROCESSED');release({processedBytes:bytes});await new Promise(r=>setImmediate(r));assert.ok(bytes.every(x=>x===0));assert.equal(p.calls.put.length,0);assert.equal(p.calls.rpc.filter(x=>x.n===PREFIX+'finish').length,0);
});
test('captures input before await and rejects getters/extra capabilities without invoking them',async()=>{
 const x=await f.startReal(),p=compose(),request={...x.input},input={actor:f.users.fiscal,request},pending=p.service.revalidate(input);request.command_id=randomUUID();input.actor=randomUUID();const r=await pending;assert.equal(r.command_id,x.input.command_id);
 let reads=0;await assert.rejects(p.service.revalidate({actor:f.users.fiscal,request:{...x.input,get confirmed(){reads++;return true;}}}));assert.equal(reads,0);assert.throws(()=>createAuthorizationRevalidationService({rpc:p.rpc,readStoredResponse:p.reader,storage:p.storage,transport(){}}));
});
test('invalid reader envelopes erase returned bytes and conflicting digest/hash cannot reach Storage or finish',async()=>{
 for(const mode of ['extra','digest','bytes']){
  const x=await f.startReal(),base=compose();let owned;
  const p=compose({reader:async(input,o)=>{const raw=await base.reader(input,o);owned=raw.processedBytes;if(mode==='extra')return{...raw,extra:'PRIVATE'};if(mode==='bytes'){owned[0]^=1;return raw;}return{...raw,validation:{...raw.validation,evidence:{...raw.validation.evidence,reference_digest:'A'.repeat(27)+'='}}};}});
  await assert.rejects(p.service.revalidate({actor:f.users.fiscal,request:x.input}));assert.ok(owned.every(v=>v===0));assert.equal(p.calls.put.length,0);assert.equal(p.calls.rpc.filter(x=>x.n===PREFIX+'finish').length,0);
 }
});
