import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fixture} from '../../packages/fiscal-unsigned-orchestrator/test/fixture.mjs';
import {seedFiscalSigned,createFiscalSignedQaGateway} from './seed-fiscal-signed.mjs';
const origin='https://qa.synthetic.invalid',url='https://unsigned.qa.invalid',token='qa-synthetic-token-unsigned-safe';
async function setup({retry=false,detailDelayMs=0}={}){
 const f=await fixture(),objects=new Map();let seed,gateway;
 try{
  for(const n of['0041_a1_custody','0050_signed_fiscal_candidates'])await f.db.exec(await readFile(new URL(`../../supabase/migrations/20261016${n}.sql`,import.meta.url),'utf8'));
  const drafts=[];for(const model of['55','65'])drafts.push((await f.prepare({model,reserve:false})).draft.record.id);
  seed=await seedFiscalSigned({db:f.db,uid:f.users.admin,objects,drafts});
  const authCalls=[],env={SUPABASE_URL:'https://qqqqqqqqqqqqqqqqqqqq.supabase.co',SUPABASE_ANON_KEY:'qa-synthetic-public-key-only',A1_TRANSPORT_SECRET:Buffer.alloc(32,41).toString('base64'),A1_TRANSPORT_KEY_ID:'qa-local-only',A1_AUDIENCE:'qa-local-only',ALLOWED_ORIGINS:origin};
  gateway=createFiscalSignedQaGateway({seed,env,retry,detailDelayMs,fetchImpl:async(address,options)=>{assert.equal(address,env.SUPABASE_URL+'/auth/v1/user');authCalls.push(address);return options.headers.Authorization===`Bearer ${token}`?Response.json({id:f.users.admin,is_anonymous:false}):Response.json({}, {status:401});}});
  const request=(path,body,options={})=>new Request(url+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'}),...options.headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:options.signal});
  const input=model=>{const row=seed.fixtures.find(r=>r.model===model);return{command_id:randomUUID(),unsigned_job_id:row.job_id,unsigned_hash:row.unsigned_hash,basis_hash:row.basis_hash,expected_a1_version:row.a1_version};};
  const checked=async(response,status=200)=>{assert.equal(response.status,status);const value=await response.json();assert.doesNotMatch(JSON.stringify(value),/ciphertext|private_executor_only|lease_id|access_key|credential_object|key_id|<NFe/);return value;};
  return{...f,seed,gateway,objects,authCalls,request,input,checked,close:async()=>{gateway.dispose();await f.close();}};
 }catch(error){gateway?.dispose();seed?.dispose();await f.close();throw error;}
}
test('QA050 bootstrap stores current unsigned55/65 and only a clearly synthetic A1 without financial or stock effects',async()=>{
 const f=await setup();try{
  assert.equal(f.seed.xsd_mode,'simulated_report_not_validation');assert.deepEqual(f.seed.fixtures.map(v=>v.model),['55','65']);
  const counts=await f.scalar('select jsonb_build_array((select count(*)from erp_fiscal_unsigned.job where state=\'stored\'),(select count(*)from erp_fiscal_signed.candidate),(select count(*)from erp_finance.title),(select count(*)from erp_stock.movement))value');
  assert.deepEqual(counts,[2,0,0,0]);assert.equal(f.seed.metrics.signatures,0);assert.equal(f.seed.metrics.schema_reports,0);
  const a1=await f.checked(await f.gateway.fetch(f.request('/v1/a1')));assert.equal(a1.current.state,'configured_offline');assert.equal(a1.current.time_valid_now,true);assert.equal(a1.current.company_changed,false);assert.equal(a1.can_transmit,false);
  for(const row of f.seed.fixtures){const result=await f.seed.callSql('erp_fiscal_unsigned_get',{p_user_id:f.users.admin,p_job_id:row.job_id});assert.equal(result.current.artifact_current,true);}
  await assert.rejects(()=>seedFiscalSigned({db:f.db,uid:f.users.admin,objects:f.objects}),/QA_SIGNED_ALREADY_SEEDED/);
  await f.checked(await f.gateway.fetch(f.request('/v1/a1',{})),405);assert.equal(f.seed.metrics.signatures,0);
 }finally{await f.close();}
});
test('QA gateway uses real authentication/runtime/SQL050 for both models and cannot bypass member authorization',async()=>{
 const f=await setup();try{
  for(const model of['55','65']){
   const body=f.input(model),created=await f.checked(await f.gateway.fetch(f.request('/v1/fiscal-signed/run',body)));
   assert.equal(created.status,'stored');assert.equal(created.model,model);assert.equal(created.signature_verified,true);assert.equal(created.can_emit,false);assert.equal(created.can_transmit,false);
   const cmd=await f.checked(await f.gateway.fetch(f.request('/v1/fiscal-signed/commands/'+body.command_id)));assert.equal(cmd.candidate_id,created.candidate_id);
   const current=await f.checked(await f.gateway.fetch(f.request('/v1/fiscal-signed/candidates/'+created.candidate_id)));assert.equal(current.current.artifact_current,true);
   const list=await f.checked(await f.gateway.fetch(f.request(`/v1/fiscal-signed/jobs/${body.unsigned_job_id}/history`,{limit:25,before:null})));assert.equal(list.items.length,1);
   assert.equal((await f.checked(await f.gateway.fetch(f.request('/v1/fiscal-signed/run',body)))).candidate_id,created.candidate_id);
  }
  assert.equal(f.seed.metrics.signatures,2);assert.equal(f.seed.metrics.schema_reports,2);
  const bad=f.input('55');await f.checked(await f.gateway.fetch(f.request('/v1/fiscal-signed/run',bad,{headers:{Authorization:'Bearer wrong-synthetic-token-123456'}})),401);
  await f.db.query("update erp_access.membership set role='consulta'where user_id=$1",[f.users.admin]);
  const denied=await f.checked(await f.gateway.fetch(f.request('/v1/fiscal-signed/run',bad)));assert.equal(denied.status,'recoverable');assert.equal(denied.code,'SIGNED_RPC_42501');assert.equal(denied.signed,null);assert.equal(f.seed.metrics.signatures,2);
  await f.checked(await f.gateway.fetch(f.request('/v1/fiscal-signed/jobs/'+bad.unsigned_job_id+'/history',{limit:25,before:null})),403);
 }finally{await f.close();}
});
test('QA fault mode loses a committed run ACK and one command read, then recovers without another signature',async()=>{
 const f=await setup({retry:true});try{
  const body=f.input('65'),lost=await f.checked(await f.gateway.fetch(f.request('/v1/fiscal-signed/run',body)),503);assert.equal(lost.recovery_required,true);
  await f.checked(await f.gateway.fetch(f.request('/v1/fiscal-signed/commands/'+body.command_id)),503);
  const recovered=await f.checked(await f.gateway.fetch(f.request('/v1/fiscal-signed/commands/'+body.command_id)));assert.equal(recovered.status,'stored');
  assert.equal((await f.checked(await f.gateway.fetch(f.request('/v1/fiscal-signed/run',body)))).candidate_id,recovered.candidate_id);
  assert.equal(f.seed.metrics.signatures,1);assert.equal(f.seed.metrics.schema_reports,1);
  assert.equal(await f.scalar('select count(*)::int value from erp_fiscal_signed.candidate'),1);
 }finally{await f.close();}
});
test('QA delayed metadata can arrive after cancellation for UI epoch tests, without performing another write',async()=>{
 const f=await setup({detailDelayMs:40});try{
  const body=f.input('55'),created=await f.checked(await f.gateway.fetch(f.request('/v1/fiscal-signed/run',body))),abort=new AbortController();
  const path='/v1/fiscal-signed/candidates/'+created.candidate_id,pending=f.gateway.fetch(f.request(path,undefined,{signal:abort.signal}));
  const deadline=Date.now()+1000;while(!f.gateway.faults.delayed.has(path)){assert.ok(Date.now()<deadline,'Metadata must finish before the synthetic delay');await new Promise(resolve=>setImmediate(resolve));}
  abort.abort();const response=await pending;assert.equal(response.status,200);assert.equal((await response.json()).candidate_id,created.candidate_id);assert.equal(f.seed.metrics.signatures,1);assert.equal(f.gateway.faults.delayed.size,0);
 }finally{await f.close();}
});
