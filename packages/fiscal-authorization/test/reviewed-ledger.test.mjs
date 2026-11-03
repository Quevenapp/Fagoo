import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {reviewedFixture,hash} from './reviewed-ledger-fixture.mjs';
import {projectResponse} from '../src/service-dto.mjs';
import {createReviewedAuthorizationRpc} from '../src/reviewed-ledger-rpc.mjs';
import {projectReviewedLedger,reviewedPreparationEvidence} from '../src/reviewed-ledger-dto.mjs';
const rejects=(f,code)=>assert.rejects(f,e=>e.code===code);
const without=(v,...keys)=>Object.fromEntries(Object.entries(v).filter(([k])=>!keys.includes(k)));
test('069 SQL→HTTP DTO, operational and synthetic scopes, immutable review and legacy guards',async t=>{
 const f=await reviewedFixture();try{
  await t.test('seeds disabled; old policy fields and preview064 shape preserved; ACL/RLS private',async()=>{
   const rows=(await f.db.query('select to_jsonb(p) v from erp_fiscal_authorization.policy p order by model,version')).rows.map(x=>x.v);
   assert.deepEqual(rows.filter(x=>x.authorization_profile==='legacy_v1').map(x=>without(x,'authorization_profile')),f.policiesBefore);
   const seeds=rows.filter(x=>x.authorization_profile==='reviewed_subset_v1');assert.equal(seeds.length,2);assert.ok(seeds.every(x=>!x.enabled&&!x.tax_rules_reviewed&&x.origin==='operational'&&x.source_manifest_hash===f.policyHashes[x.model]));
   const c=await f.candidate();const a={p_user_id:f.users.fiscal,p_candidate_id:c.input.candidateId,p_signed_hash:c.input.signedHash};
   const preview=projectResponse('erp_fiscal_authorization_preview',await f.callSql('erp_fiscal_authorization_preview',a),a);
   assert.equal(Object.keys(preview.policy).length,12);assert.equal(preview.can_prepare,false);await rejects(()=>f.begin(c,3),'55000');
   const acl=(await f.db.query(`select p.proname,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,has_function_privilege('service_role',p.oid,'EXECUTE') service from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and p.proname like 'erp_fiscal_reviewed_authorization_%'`)).rows;
   assert.equal(acl.length,7);assert.ok(acl.every(x=>!x.anon&&!x.authenticated&&x.service));
   assert.ok((await f.db.query(`select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='erp_fiscal_reviewed_authorization'and c.relkind='r'`)).rows.every(x=>x.relrowsecurity));
  });
  let enabled=await f.enable();
  for(const model of ['55','65'])await t.test('operational '+model+' consumes one grant with false full-tax flag and stores homogeneous evidence',async()=>{
   const c=await f.candidate(model),proof=await f.review(c),b=await f.begin(c,enabled);
   assert.equal(b.value.recovery.origin,'operational');assert.equal(b.value.rule_review,null);
   const p=await f.prepare(b,proof);assert.equal(p.value.rule_review.coverage,'listed_rules_only_not_full_tax_validation');assert.equal(p.args.p_evidence.tax_rules_validated,false);
   assert.throws(()=>reviewedPreparationEvidence({...p.args.p_evidence,tax_rules_validated:true}));
   const grant=await f.use(b,proof);assert.equal(grant.grant.origin,'operational');assert.equal(grant.rule_review.tax_rules_validated,false);
   await rejects(()=>f.use(b,proof),'40001');await rejects(()=>f.begin(c,enabled,{p_command_id:randomUUID()}),'40001');
   const finish=await f.finishArgs(b,p),stored=await f.wire('finish',finish);assert.equal(stored.current.state,'authorized_homologation');assert.equal(stored.current.authorized_in_homologation,true);assert.equal(stored.can_transmit,false);assert.equal(stored.production_authorized,false);
   assert.equal(stored.observation.sha256,finish.p_observation_hash);
   const oldArgs={p_user_id:f.users.fiscal,p_command_id:b.args.p_command_id};
   const oldCommand=projectResponse('erp_fiscal_authorization_command',await f.callSql('erp_fiscal_authorization_command',oldArgs),oldArgs);assert.deepEqual(oldCommand.artifact,stored.artifact);
   const oldPageArgs={p_user_id:f.users.fiscal,p_candidate_id:c.input.candidateId,p_limit:25,p_before:null};
   const oldPage=projectResponse('erp_fiscal_authorization_history',await f.callSql('erp_fiscal_authorization_history',oldPageArgs),oldPageArgs);assert.deepEqual(oldPage.items[0].receipt,stored.receipt);assert.equal((await f.wire('finish',finish)).replayed,true);
   await rejects(()=>f.wire('finish',{...finish,p_observation_hash:hash('changed observation')}),'40001');
   assert.equal((await f.db.query("select count(*)::int n from erp_fiscal_authorization.audit where attempt_id=$1 and action='consume'",[b.value.receipt.attempt_id])).rows[0].n,1);
  });
  await t.test('direct064 RPC cannot prepare or use without a fixed review; proof mismatch rolls back',async()=>{
   const c=await f.candidate(),proof=await f.review(c),b=await f.begin(c,enabled),rh=hash('bypass');await f.object(b,'requests',rh);
   const args={...f.ids(b),p_request_hash:rh,p_request_size:32,p_evidence:f.preparation(b,rh)};
   await rejects(()=>f.callSql('erp_fiscal_authorization_prepare',args),'40001');
   await rejects(()=>f.call('prepare',{...args,p_rule_review:{...proof,facts_hash:hash('forged')}}),'40001');
   await rejects(()=>f.call('prepare',{...args,p_rule_review:proof,p_evidence:{...args.p_evidence,tax_rules_validated:true}}),'22023');
   assert.equal((await f.db.query('select count(*)::int n from erp_fiscal_reviewed_authorization.review_binding where attempt_id=$1',[b.value.receipt.attempt_id])).rows[0].n,0);
   for(const bad of [null,[],{}, {...proof,unknown:true}])await rejects(()=>f.call('prepare',{...args,p_rule_review:bad}),'22023');
   const p=await f.prepare(b,proof);const newer=await f.review(c,{p_command_id:randomUUID(),p_expected_review_version:1});assert.equal(newer.review_version,2);
   // Idempotent prepare replays the pinned original; use requires latest and also guards old RPC entry.
   assert.equal((await f.wire('prepare',p.args)).replayed,true);
   await rejects(()=>f.use(b,proof),'40001');await rejects(()=>f.callSql('erp_fiscal_authorization_use',f.ids(b)),'40001');
   assert.equal((await f.wire('command',{p_user_id:f.users.fiscal,p_command_id:b.args.p_command_id})).current.grant_consumed,false);
  });
  await t.test('sidecar required even through old finish; invalid TLS origin/hash rolls back both tables',async()=>{
   const c=await f.candidate(),proof=await f.review(c),b=await f.begin(c,enabled),p=await f.prepare(b,proof);await f.use(b,proof);const args=await f.finishArgs(b,p);
   await rejects(()=>f.callSql('erp_fiscal_authorization_finish',without(args,'p_observation_hash','p_observation_size')),'40001');
   await rejects(()=>f.call('finish',{...args,p_evidence:{...args.p_evidence,transport_hash:hash('other')}}),'40001');
   assert.equal((await f.db.query('select count(*)::int n from erp_fiscal_reviewed_authorization.observation where attempt_id=$1',[b.value.receipt.attempt_id])).rows[0].n,0);
   await rejects(()=>f.call('finish',{...args,p_evidence:{...args.p_evidence,origin:'synthetic',tls_origin_verified:false,transport_hash:null,transport_size:null}}),'22023');
   const stored=await f.wire('finish',args);assert.equal(stored.current.state,'authorized_homologation');
  });
  await t.test('reviewer revocation blocks consume without becoming a full-tax flag',async()=>{
   const c=await f.candidate(),proof=await f.review(c,{p_user_id:f.users.admin}),b=await f.begin(c,enabled);await f.prepare(b,proof);
   await f.db.query('update erp_access.membership set active=false where user_id=$1',[f.users.admin]);
   try{await rejects(()=>f.use(b,proof),'42501');await rejects(()=>f.callSql('erp_fiscal_authorization_use',f.ids(b)),'42501');}finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[f.users.admin]);}
  });
  await t.test('consumed command completes after new review/policy and lease, preserving historical binding',async()=>{
   const c=await f.candidate(),proof=await f.review(c),b=await f.begin(c,enabled),p=await f.prepare(b,proof);await f.use(b,proof);const args=await f.finishArgs(b,p);
   await f.review(c,{p_command_id:randomUUID(),p_expected_review_version:1});await f.age(b.args.p_command_id);enabled=await f.enable('operational',false);
   const stored=await f.wire('finish',args);assert.equal(stored.rule_review.review_id,proof.review_id);assert.equal(stored.current.lease_expired,true);assert.equal(stored.current.policy_changed,true);
   assert.equal((await f.wire('prepare',p.args)).replayed,true);
   const got=await f.wire('command',{p_user_id:f.users.fiscal,p_command_id:b.args.p_command_id});assert.deepEqual(got.artifact,stored.artifact);
   const history=await f.wire('history',{p_user_id:f.users.admin,p_candidate_id:c.input.candidateId,p_limit:25,p_before:null});assert.equal(history.items.length,1);assert.equal(history.items[0].recoverable_by_actor,false);assert.equal(history.items[0].rule_review.review_id,proof.review_id);
   await rejects(()=>f.wire('command',{p_user_id:f.users.admin,p_command_id:b.args.p_command_id}),'42501');
   enabled=await f.enable();
  });
  await t.test('lost use ACK never retries; command proves consumption and recovery requires no new grant',async()=>{
   const c=await f.candidate(),proof=await f.review(c),b=await f.begin(c,enabled),p=await f.prepare(b,proof);let useCalls=0;
   const rpc=createReviewedAuthorizationRpc({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-test-service-key-not-secret',fetchImpl:async(url,o)=>{const reply=await f.http(url,o);if(url.endsWith('_use')){useCalls++;throw Error('PRIVATE_SENTINEL');}return reply;}});
   await rejects(()=>rpc('erp_fiscal_reviewed_authorization_use',{...f.ids(b),p_rule_review:proof},f.opts()),'AUTHORIZATION_RPC_IO_FAILED');assert.equal(useCalls,1);
   const got=await f.wire('command',{p_user_id:f.users.fiscal,p_command_id:b.args.p_command_id});assert.equal(got.current.grant_consumed,true);assert.equal(got.current.state,'dispatched');
   await rejects(()=>f.use(b,proof),'40001');const args=await f.finishArgs(b,p);assert.equal((await f.wire('finish',args)).current.state,'authorized_homologation');
  });
  await t.test('synthetic evidence remains observation, never operational authorization',async()=>{
   const version=await f.enable('synthetic'),c=await f.candidate(),proof=await f.review(c),b=await f.begin(c,version),p=await f.prepare(b,proof);await f.use(b,proof);
   const stored=await f.wire('finish',await f.finishArgs(b,p));assert.equal(stored.current.state,'authorization_observed');assert.equal(stored.current.authorized_in_homologation,false);assert.equal(stored.receipt.origin,'synthetic');
   const raw=await f.call('command',{p_user_id:f.users.fiscal,p_command_id:b.args.p_command_id});raw.view.receipt.origin='operational';assert.throws(()=>projectReviewedLedger('command',raw,{p_user_id:f.users.fiscal,p_command_id:b.args.p_command_id}));
  });
  await t.test('legacy operational validation still requires its original full-tax attestation',async()=>{
   const version=Number((await f.db.query('select max(version)+1 v from erp_fiscal_authorization.policy')).rows[0].v);
   await f.db.query(`insert into erp_fiscal_authorization.policy(model,version,origin,enabled,binding_profile,rule_profile,binding_reviewed,tax_rules_reviewed,source_manifest_hash,valid_from,valid_until)
    values('55',$1,'operational',true,'legacy-synthetic-binding-fixture','legacy-full-tax-fixture',true,true,$2,clock_timestamp()-interval'1day',clock_timestamp()+interval'1day')`,[version,hash('legacy policy fixture')]);
   const c=await f.candidate(),a={p_user_id:f.users.fiscal,p_command_id:c.input.commandId,p_candidate_id:c.input.candidateId,p_signed_hash:c.input.signedHash,p_expected_identity_version:1,p_expected_a1_version:2,p_expected_policy_version:version,p_confirmed:true};
   const b={args:a,value:await f.callSql('erp_fiscal_authorization_begin',a)},rh=hash('legacy request');await f.object(b,'requests',rh);
   const p={...f.ids(b),p_request_hash:rh,p_request_size:32,p_evidence:f.preparation(b,rh)};await rejects(()=>f.callSql('erp_fiscal_authorization_prepare',p),'22023');
   p.p_evidence.tax_rules_validated=true;assert.equal((await f.callSql('erp_fiscal_authorization_prepare',p)).current.state,'request_ready');
  });
 }finally{await f.close();}
});

test('069 preserves finalized064 records, historical reads and legacy validator semantics',async()=>{
 let legacy;
 const f=await reviewedFixture({beforeMigration:async old=>{
  const c=await old.candidate(),b=await old.begin(c.stored),p=await old.prepare(b);await old.use(b);const args=await old.finishArgs(b,p);
  const stored=await old.callSql('erp_fiscal_authorization_finish',{p_user_id:old.users.fiscal,...args});
  legacy={b,p,args,stored};
 }});try{
  const args={p_user_id:f.users.fiscal,p_command_id:legacy.b.args.p_command_id};
  const stored=projectResponse('erp_fiscal_authorization_command',await f.callSql('erp_fiscal_authorization_command',args),args);
  assert.deepEqual(stored.receipt,legacy.stored.receipt);assert.deepEqual(stored.artifact,legacy.stored.artifact);assert.equal(stored.current.policy_changed,true);
  const replay=await f.callSql('erp_fiscal_authorization_finish',{p_user_id:f.users.fiscal,...legacy.args});assert.equal(replay.replayed,true);
  await rejects(()=>f.wire('command',args),'22023');
  assert.equal((await f.db.query('select count(*)::int n from erp_fiscal_reviewed_authorization.review_binding')).rows[0].n,0);
 }finally{await f.close();}
});
