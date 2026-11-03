import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-sql-fixture.mjs';
import {createAuthorizationReadService} from '../src/read-service.mjs';
import {AuthorizationServiceError} from '../src/service-common.mjs';

let f;
before(async()=>{f=await serviceFixture();});
after(async()=>{await f?.close();});
const options=()=>({deadline:Date.now()+45000});
const reader=(patch={})=>createAuthorizationReadService({rpc:f.ports.rpc,storage:{read:f.ports.storage.read},...patch});
const privateFields=/private_executor_only|certificate_fingerprint|issuer_cnpj|access_key|lease_id|BEGIN CERTIFICATE|<NFe/;
const noEffects=()=>({put:f.calls.put.length,custody:f.calls.custody.length,transport:f.calls.transport.length,validate:f.calls.validate.length});
async function state(){
 const snapshot={};
 // Includes commands, consumed grants, artifacts and storage metadata: reads
 // must not modify any of them, including rows unrelated to this candidate.
 for(const table of ['policy','intent','attempt','command','request','result','audit']){
  snapshot[table]=(await f.db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) value from erp_fiscal_authorization.${table} t`)).rows[0].value;
 }
 snapshot.storage=(await f.db.query("select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) value from storage.objects t")).rows[0].value;
 return snapshot;
}
const bindingUnavailable=e=>e instanceof AuthorizationServiceError&&e.code==='AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE';

test('read-only preview55/65 matches the disabled full service and checks the stored signature without creating an attempt',async()=>{
 for(const model of ['55','65']){
  const {input}=await f.source(model),query={actor:input.actor,candidateId:input.candidateId,signedHash:input.signedHash};
  const baseline=await state(),effects=noEffects(),start=f.calls.rpc.length,reads=f.calls.read.length;
  const actual=await reader().preview(query,options()),legacy=await f.service({enabled:false}).preview(query,options());
  assert.deepEqual(actual,legacy);
  assert.equal(actual.service_enabled,false);assert.equal(actual.can_prepare,false);
  assert.equal(actual.signature_checked,true);assert.equal(actual.certificate_pin_checked,true);
  assert.equal(actual.operational_binding_available,false);assert.equal(actual.can_emit,false);assert.equal(actual.can_transmit,false);
  assert.doesNotMatch(JSON.stringify(actual),privateFields);
  assert.equal(f.calls.read.length-reads,2);
  assert.deepEqual(f.calls.rpc.slice(start).map(x=>x.name),Array(2).fill(['erp_fiscal_signed_get','erp_fiscal_signed_get','erp_fiscal_authorization_preview']).flat());
  assert.deepEqual(await state(),baseline);assert.deepEqual(noEffects(),effects);
 }
});

test('command remains actor-bound while another authorized actor can read history without recovery material',async()=>{
 const {stored,input}=await f.source(),b=await f.begin(stored),service=reader(),baseline=await state(),effects=noEffects();
 const own={actor:input.actor,commandId:b.args.p_command_id};
 assert.deepEqual(await service.command(own,options()),await f.service({enabled:false}).command(own,options()));
 const page=await service.history({actor:f.users.admin,candidateId:input.candidateId,limit:25,before:null},options());
 assert.equal(page.read_only,true);assert.equal(page.items.length,1);assert.equal(page.items[0].recoverable_by_actor,false);
 assert.equal(page.items[0].receipt.command_id,b.args.p_command_id);assert.equal(page.items[0].read_only,true);
 assert.doesNotMatch(JSON.stringify(page),privateFields);assert.equal(Object.hasOwn(page.items[0],'recovery'),false);
 await assert.rejects(service.command({...own,actor:f.users.admin},options()),{code:'42501'});
 assert.deepEqual(await state(),baseline);assert.deepEqual(noEffects(),effects);
 await f.db.query('update erp_access.membership set active=false where user_id=$1',[input.actor]);
 try{
  for(const read of [()=>service.command(own,options()),()=>service.history({actor:input.actor,candidateId:input.candidateId,limit:25,before:null},options())])await assert.rejects(read(),{code:'42501'});
 }finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[input.actor]);}
 assert.deepEqual(await state(),baseline);assert.deepEqual(noEffects(),effects);
});

test('recover checks one command but cannot recover prepared or consumed attempts, read Storage or consume again',async()=>{
 for(const consumed of [false,true]){
  const {stored,input}=await f.source(),b=await f.begin(stored);
  if(consumed){await f.prepare(b);await f.use(b);}
  const baseline=await state(),effects=noEffects(),reads=f.calls.read.length,start=f.calls.rpc.length;
  await assert.rejects(reader().recover({actor:input.actor,commandId:b.args.p_command_id},options()),bindingUnavailable);
  assert.deepEqual(f.calls.rpc.slice(start).map(x=>x.name),['erp_fiscal_authorization_command']);
  assert.equal(f.calls.read.length,reads);assert.deepEqual(noEffects(),effects);assert.deepEqual(await state(),baseline);
 }
});

test('recover preserves missing-command and ACL errors instead of treating them as a permission to operate',async()=>{
 const {stored,input}=await f.source(),b=await f.begin(stored),service=reader();
 const baseline=await state(),effects=noEffects(),reads=f.calls.read.length;
 await assert.rejects(service.recover({actor:input.actor,commandId:randomUUID()},options()),{code:'P0002'});
 await assert.rejects(service.recover({actor:f.users.admin,commandId:b.args.p_command_id},options()),{code:'42501'});
 assert.deepEqual(await state(),baseline);assert.deepEqual(noEffects(),effects);assert.equal(f.calls.read.length,reads);
});

test('run is closed before input access or any RPC, including when the caller presents a complete run body',async()=>{
 const {input}=await f.source(),baseline=await state(),effects=noEffects(),rpc=f.calls.rpc.length,reads=f.calls.read.length,service=reader();
 let getter=0;const hostile={get actor(){getter++;throw Error('PRIVATE_GETTER');}};
 for(const value of [input,hostile,undefined])assert.throws(()=>service.run(value,options()),bindingUnavailable);
 assert.equal(getter,0);assert.equal(f.calls.rpc.length,rpc);assert.equal(f.calls.read.length,reads);
 assert.deepEqual(noEffects(),effects);assert.deepEqual(await state(),baseline);
});

test('preview reauthorizes after reading bytes and does not return a valid preview after role revocation',async()=>{
 const {input}=await f.source(),baseline=await state(),effects=noEffects(),start=f.calls.rpc.length;
 const service=reader({storage:{read:async value=>{
  const response=await f.ports.storage.read(value);
  await f.db.query('update erp_access.membership set active=false where user_id=$1',[input.actor]);
  return response;
 }}});
 try{await assert.rejects(service.preview({actor:input.actor,candidateId:input.candidateId,signedHash:input.signedHash},options()),{code:'42501'});}
 finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[input.actor]);}
 assert.deepEqual(f.calls.rpc.slice(start).map(x=>x.name),['erp_fiscal_signed_get','erp_fiscal_signed_get']);
 assert.deepEqual(noEffects(),effects);assert.deepEqual(await state(),baseline);
});

test('read composition rejects writers and operational ports rather than retaining unused capabilities',()=>{
 const rpc=()=>assert.fail('factory must not call RPC'),read=()=>assert.fail('factory must not read Storage');
 assert.throws(()=>createAuthorizationReadService({rpc,storage:{read,putImmutable:()=>{}}}),{code:'AUTHORIZATION_SERVICE_INPUT_INVALID'});
 for(const key of ['validate','binding','withPreparedSession','transport','enabled'])assert.throws(()=>createAuthorizationReadService({rpc,storage:{read},[key]:()=>{}}),{code:'AUTHORIZATION_SERVICE_INPUT_INVALID'});
 let calls=0;assert.throws(()=>createAuthorizationReadService({rpc,storage:{get read(){calls++;return read;}}}),{code:'AUTHORIZATION_SERVICE_INPUT_INVALID'});assert.equal(calls,0);
});
