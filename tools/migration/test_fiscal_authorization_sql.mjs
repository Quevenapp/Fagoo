import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {authorizationFixture,hash} from './fixtures/authorization-ledger.mjs';
const denied=(p,code)=>assert.rejects(p,e=>e.code===code);

test('064 ships disabled, service-only, RLS and no implicit command/grant',async()=>{
 const f=await authorizationFixture({installSynthetic:false});try{
  const s=await f.source(),p=await f.call('preview',{p_candidate_id:s.receipt.candidate_id,p_signed_hash:s.artifact.signed_hash});
  assert.equal(p.can_prepare,false);assert.deepEqual(p.blockers,['POLICY_DISABLED','BINDING_NOT_REVIEWED','RULE_PROFILE_NOT_REVIEWED']);
  await denied(f.begin(s,{p_expected_policy_version:1}),'55000');
  const rows=await f.db.query("select count(*)::int n from erp_fiscal_authorization.attempt");assert.equal(rows.rows[0].n,0);
  assert.equal((await f.db.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='erp_fiscal_authorization'and c.relkind='r'and c.relrowsecurity")).rows[0].n,7);
  for(const role of['anon','authenticated'])assert.equal((await f.db.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and p.proname like 'erp_fiscal_authorization_%'and has_function_privilege($1,p.oid,'EXECUTE')",[role])).rows[0].n,0);
  assert.equal((await f.db.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and p.proname like 'erp_fiscal_authorization_%'and has_function_privilege('service_role',p.oid,'EXECUTE')")).rows[0].n,8);
  assert.equal((await f.db.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='erp_fiscal_authorization'and has_function_privilege('service_role',p.oid,'EXECUTE')")).rows[0].n,0);
 }finally{await f.close();}
});
test('064 request bytes bind before one consumption; command/batch/lease are permanent and actor fixed',async()=>{
 const f=await authorizationFixture();try{
  for(const model of['55','65']){
   const s=await f.source(model),b=await f.begin(s);assert.match(b.value.receipt.batch_id,/^[1-9][0-9]{0,14}$/);
   const replay=await f.call('begin',b.args);assert.deepEqual(replay.receipt,b.value.receipt);assert.deepEqual(replay.execution,b.value.execution);
   await denied(f.use(b),'40001');
   await denied(f.begin(s),'40001');
   const p=await f.prepare(b);assert.equal(p.value.current.state,'request_ready');
   assert.equal((await f.call('prepare',p.args)).replayed,true);
   await denied(f.call('prepare',{...p.args,p_request_hash:hash('changed')}),'22023');
   const grant=await f.use(b);assert.equal(grant.grant.request_hash,p.args.p_request_hash);assert.equal(grant.can_transmit,false);
   await denied(f.use(b),'40001');await denied(f.begin(s),'40001');
   await denied(f.call('begin',{...b.args,p_user_id:f.users.admin}),'40001');
   assert.equal((await f.call('begin',b.args)).execution,null);
  }
  assert.equal((await f.db.query("select count(*)::int n from erp_fiscal_authorization.audit where action='consume'")).rows[0].n,2);
 }finally{await f.close();}
});
test('064 invalid/null/extra preparation evidence is rejected and failed-before-dispatch cannot finish',async()=>{
 const f=await authorizationFixture();try{
  const b=await f.begin(await f.source()),e=f.preparation(b),sha=e.request_hash;await f.object(b,'requests',sha);
  for(const proof of[null,[],{...e,origin:'operational'},{...e,signature_verified:null},{...e,batch_id:'01'},{...e,extra:true}])await denied(f.call('prepare',{...f.id(b),p_request_hash:sha,p_request_size:32,p_evidence:proof}),'22023');
  const p=await f.prepare(b);await f.call('fail',{...f.id(b),p_error_code:'PREPARATION_FAILED'});
  await denied(f.call('finish',await f.finishArgs(b,p)),'40001');await denied(f.use(b),'40001');
  const next=await f.begin(await f.source());assert.notEqual(next.value.receipt.batch_id,b.value.receipt.batch_id);
  const retry=await f.begin({receipt:{candidate_id:b.args.p_candidate_id},artifact:{signed_hash:b.args.p_signed_hash}});assert.equal(retry.value.receipt.intent_id,b.value.receipt.intent_id);assert.notEqual(retry.value.receipt.batch_id,b.value.receipt.batch_id);
 }finally{await f.close();}
});
test('064 recovery after lease/A1/policy change conserves receipt; synthetic 100/150 never authorizes',async()=>{
 const f=await authorizationFixture();try{
  const s=await f.source(),b=await f.begin(s),p=await f.prepare(b);await f.use(b);await f.call('fail',{...f.id(b),p_error_code:'JOURNAL_UNAVAILABLE'});
  await f.expire(b);await f.disable();await f.install(3);
  const args=await f.finishArgs(b,p);args.p_evidence.protocol_cstat='150';const v=await f.call('finish',args);
  assert.equal(v.current.state,'authorization_observed');assert.equal(v.current.authorized_in_homologation,false);assert.equal(v.current.a1_changed,true);assert.equal(v.current.policy_changed,true);assert.equal(v.current.lease_expired,true);
  assert.deepEqual(v.receipt,b.value.receipt);assert.equal(v.can_transmit,false);assert.equal(v.production_authorized,false);
  assert.equal((await f.call('finish',args)).replayed,true);assert.equal((await f.call('begin',b.args)).execution,null);assert.deepEqual((await f.command(b)).receipt,b.value.receipt);
  await denied(f.call('finish',{...args,p_response_hash:hash('other')}),'22023');
  const history=await f.call('history',{p_candidate_id:s.receipt.candidate_id});assert.equal(history.items[0].recoverable_by_actor,false);assert.equal('recovery'in history.items[0],false);
 }finally{await f.close();}
});
test('064 response classifications, immutable artifacts and no synthetic TLS promotion',async()=>{
 const f=await authorizationFixture();try{
  for(const scenario of[
   {state:'receipt_pending',outcome:'receipt_pending',cstat:'103',receipt_number:'351234567890123'},
   {state:'rejected',outcome:'rejected',cstat:'225'},
   {state:'review_required',outcome:'review_required',cstat:'217'},
   {state:'review_required',outcome:'invalid_response',cstat:null,rejection_code:'SOAP_FAULT',payload_hash:null,xsd_validated:false,context_matched:false,received_at:null},
  ]){
   const b=await f.begin(await f.source()),p=await f.prepare(b);await f.use(b);const args=await f.finishArgs(b,p);
   const{state,...values}=scenario;args.p_processed_hash=null;args.p_processed_size=null;
   args.p_evidence={...args.p_evidence,protocol_cstat:null,protocol_number:null,reference_digest:null,signature_verified:false,processed_xsd_validated:false,...values};
   const v=await f.call('finish',args);assert.equal(v.current.state,state);assert.equal(v.current.authorized_in_homologation,false);
   await denied(f.call('finish',{...args,p_evidence:{...args.p_evidence,tls_origin_verified:true}}),'22023');
   await denied(f.db.query('delete from erp_fiscal_authorization.result where attempt_id=$1',[b.value.receipt.attempt_id]),'42501');
  }
 }finally{await f.close();}
});
test('064 Storage mismatch and late lease roll back without consumption; reads never dispatch',async()=>{
 const f=await authorizationFixture();try{
  const b=await f.begin(await f.source()),e=f.preparation(b);
  await denied(f.call('prepare',{...f.id(b),p_request_hash:e.request_hash,p_request_size:32,p_evidence:e}),'40001');
  const p=await f.prepare(b);await f.expire(b);await denied(f.use(b),'40001');
  const v=await f.command(b);assert.equal(v.current.grant_consumed,false);assert.equal(v.read_only,true);
  assert.equal((await f.db.query('select count(*)::int n from erp_fiscal_authorization.audit where action=\'consume\'')).rows[0].n,0);
  assert.equal(p.value.current.state,'request_ready');
 }finally{await f.close();}
});
test('064 ACL is checked before replay; other actors may read history without recovery refs',async()=>{
 const f=await authorizationFixture();try{
  const s=await f.source(),b=await f.begin(s),p=await f.prepare(b);await f.use(b);
  await denied(f.call('command',{p_user_id:f.users.admin,p_command_id:b.args.p_command_id}),'42501');
  const history=await f.call('history',{p_user_id:f.users.admin,p_candidate_id:s.receipt.candidate_id});assert.equal(history.items[0].recoverable_by_actor,false);assert.equal('recovery'in history.items[0],false);
  await f.db.query('update erp_access.membership set active=false where user_id=$1',[f.users.fiscal]);
  for(const[name,args]of[['begin',b.args],['prepare',p.args],['use',f.id(b)],['command',{p_command_id:b.args.p_command_id}],['history',{p_candidate_id:s.receipt.candidate_id}],['fail',{...f.id(b),p_error_code:'TRANSPORT_UNCONFIRMED'}],['finish',await f.finishArgs(b,p)]])await denied(f.call(name,args),'42501');
 }finally{await f.close();}
});
test('064 result rejects null proof fields, contradictory status and synthetic promotion before persisting',async()=>{
 const f=await authorizationFixture();try{
  const b=await f.begin(await f.source()),p=await f.prepare(b);await f.use(b);const args=await f.finishArgs(b,p);
  for(const k of['origin','request_hash','response_hash','payload_hash','schema_profile','schema_manifest_hash','validator_hash','binding_profile','rule_profile','outcome','cstat','protocol_cstat','protocol_number','received_at','reference_digest','signature_verified','xsd_validated','context_matched','processed_xsd_validated','tls_origin_verified','can_emit','can_transmit']){
   await denied(f.call('finish',{...args,p_evidence:{...args.p_evidence,[k]:null}}),'22023');
  }
  for(const patch of[{origin:'operational',tls_origin_verified:true,transport_hash:hash('fake'),transport_size:32},{cstat:'103'},{cstat:'225'},{received_at:'2026-02-30T10:00:00.000Z'},{reference_digest:Buffer.alloc(20,33).toString('base64')},{outcome:'rejected',cstat:'217',protocol_cstat:null,signature_verified:false,processed_xsd_validated:false,reference_digest:null}]){
   await denied(f.call('finish',{...args,p_evidence:{...args.p_evidence,...patch}}),'22023');
  }
  assert.equal((await f.db.query('select count(*)::int n from erp_fiscal_authorization.result')).rows[0].n,0);
  assert.equal((await f.command(b)).current.state,'dispatched');
  assert.equal((await f.call('finish',args)).current.state,'authorization_observed');
 }finally{await f.close();}
});
test('064 consumption transaction rolls back its two state changes when audit fails',async()=>{
 const f=await authorizationFixture();try{
  const b=await f.begin(await f.source());await f.prepare(b);
  await f.db.exec("create function public.synthetic_authorization_failure()returns trigger language plpgsql as $$begin if new.action='consume'then raise exception 'synthetic failure'using errcode='40001';end if;return new;end$$;create trigger synthetic_failure before insert on erp_fiscal_authorization.audit for each row execute function public.synthetic_authorization_failure();");
  await denied(f.use(b),'40001');const v=await f.command(b);assert.equal(v.current.state,'request_ready');assert.equal(v.current.grant_consumed,false);
  assert.equal((await f.db.query('select consumed_attempt_id from erp_fiscal_authorization.intent where id=$1',[b.value.receipt.intent_id])).rows[0].consumed_attempt_id,null);
  await f.db.exec('drop trigger synthetic_failure on erp_fiscal_authorization.audit;drop function public.synthetic_authorization_failure();');
  assert.ok((await f.use(b)).grant);await denied(f.use(b),'40001');
 }finally{await f.close();}
});
test('064 idLote upper bound remains 15 digits; overflow cannot leave command or intent rows',async()=>{
 const f=await authorizationFixture();try{
  await f.db.exec("select setval(pg_get_serial_sequence('erp_fiscal_authorization.attempt','ordinal'),999999999999998,true)");
  const b=await f.begin(await f.source());assert.equal(b.value.receipt.batch_id,'999999999999999');assert.equal((await f.call('begin',b.args)).receipt.batch_id,'999999999999999');
  const s=await f.source();await denied(f.begin(s),'23514');
  for(const table of['intent','attempt','command'])assert.equal((await f.db.query(`select count(*)::int n from erp_fiscal_authorization.${table}`)).rows[0].n,1);
 }finally{await f.close();}
});
