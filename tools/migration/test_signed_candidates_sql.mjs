import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {signedFixture,hash} from './fixtures/signed-candidate.mjs';
const code=expected=>error=>error.code===expected;
const withFixture=fn=>async()=>{const f=await signedFixture();try{await fn(f);}finally{await f.close();}};

test('050 private tables, helpers and seven RPCs preserve ACL and do not extend041 actions',withFixture(async f=>{
 const tables=(await f.db.query("select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='erp_fiscal_signed'and relkind='r'")).rows;
 assert.equal(tables.length,4);assert.ok(tables.every(t=>t.relrowsecurity));
 for(const actor of ['anon','authenticated','service_role'])for(const t of tables)assert.equal(await f.scalar("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE')value",[actor,`erp_fiscal_signed.${t.relname}`]),false);
 const funcs=(await f.db.query("select p.oid::regprocedure::text signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and proname like 'erp_fiscal_signed_%'")).rows;
 assert.equal(funcs.length,7);for(const who of ['anon','authenticated'])for(const fn of funcs)assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE')value",[who,fn.signature]),false);
 await assert.rejects(()=>f.callSql('erp_a1_authorize',{p_user_id:f.users.admin,p_action:'sign',p_nonce:randomUUID(),p_issued_at:new Date().toISOString()}),code('22023'));
 const s=await f.stored();for(const role of ['consulta','vendas'])await assert.rejects(async()=>f.call('begin',{...await f.beginArgs(s),p_user_id:f.users[role]}),code('42501'));
}));
test('050 binds stored048, certificate selection and fixed profiles; use is private and finish publishes only signed+XSD evidence',withFixture(async f=>{
 for(const model of ['55','65']){
  const s=await f.stored({model}),before=await f.counts(),r=await f.begin(s);assert.equal(r.value.current.state,'pending');assert.equal(r.value.signed,false);assert.equal(r.value.artifact,null);
  assert.doesNotMatch(JSON.stringify(r.value),/credentials\/|jobs\/|key_id|access_key|cnpj|certificatePem/);
  const usage=await f.use(r);assert.equal(usage.private_executor_only,true);assert.equal(usage.identity.model,model);assert.equal(usage.unsigned_object.hash,s.result.artifact.sha256);assert.equal(usage.credential_object.hash,f.selected.objectHash);
  const again=await f.use(r);assert.equal(again.used_at,usage.used_at);await f.object(r);const saved=await f.finish(r);
  assert.equal(saved.signed,true);assert.equal(saved.signature_verified,true);assert.equal(saved.xsd_validated,true);assert.equal(saved.current.artifact_current,true);
  for(const key of ['tax_rules_validated','icp_brasil_chain_validated','revocation_checked','authorized','can_emit','can_transmit','financial_mutation_performed','stock_mutation_performed'])assert.equal(saved[key],false);
  assert.equal(saved.artifact.evidence.qr.verified,model==='65');assert.deepEqual(await f.counts(),before);
  assert.deepEqual(await f.finish(r),{...saved,replayed:true});assert.equal((await f.command(r)).receipt.candidate_id,r.value.receipt.candidate_id);
 }
}));
test('050 permanent intention uniqueness and actor/body binding survive multiple command IDs and lost ACKs',withFixture(async f=>{
 const s=await f.stored(),r=await f.begin(s),same=await f.call('begin',r.args),other=await f.begin(s);
 assert.equal(same.replayed,true);assert.equal(same.execution,null);assert.equal(other.value.receipt.candidate_id,r.value.receipt.candidate_id);assert.equal(other.value.execution,null);
 assert.equal(await f.scalar('select count(*)::int value from erp_fiscal_signed.candidate'),1);
 for(const patch of [{p_unsigned_hash:hash('wrong')},{p_basis_hash:hash('wrong')},{p_expected_a1_version:2},{p_user_id:f.users.admin}])await assert.rejects(()=>f.call('begin',{...r.args,...patch}),code('40001'));
 await assert.rejects(()=>f.command(r,f.users.admin),code('42501'));await assert.rejects(()=>f.use(r,f.users.admin),code('42501'));
 await f.use(r);await f.object(r);const saved=await f.finish(r);await f.disable();const replay=await f.call('begin',r.args);
 assert.deepEqual(replay.receipt,saved.receipt);assert.equal(replay.execution,null);assert.equal(replay.current.a1_changed,true);assert.equal(replay.current.artifact_current,false);
 assert.equal((await f.finish(r)).replayed,true);assert.equal((await f.command(r)).current.a1_changed,true);
 await f.db.query('update erp_access.membership set active=false where user_id=$1',[f.users.fiscal]);await assert.rejects(()=>f.call('begin',r.args),code('42501'));
}));
test('050 lease takeover is bounded, fences old actor and requires use for the actual attempt',withFixture(async f=>{
 const s=await f.stored(),r=await f.begin(s);await f.object(r);await assert.rejects(()=>f.finish(r),code('40001'));
 await f.use(r);await f.expire(r);await assert.rejects(()=>f.use(r),code('40001'));await assert.rejects(()=>f.finish(r),code('40001'));
 const next=await f.begin(s,{p_user_id:f.users.admin});assert.equal(next.value.receipt.candidate_id,r.value.receipt.candidate_id);assert.notEqual(next.value.execution.lease_id,r.value.execution.lease_id);assert.equal(next.value.current.attempt_count,2);
 await assert.rejects(()=>f.finish(r),code('40001'));await assert.rejects(()=>f.finish(next,{actor:f.users.admin}),code('40001'));
 await f.use(next,f.users.admin);assert.equal((await f.finish(next,{actor:f.users.admin})).current.state,'stored');
 const attempts=(await f.db.query('select state,used_at from erp_fiscal_signed.attempt order by ordinal')).rows;assert.deepEqual(attempts.map(a=>a.state),['expired','stored']);assert.ok(attempts.every(a=>a.used_at));
}));
test('050 evidence must bind both reports to exact bytes, certificate, schema, validator and model-specific QR',withFixture(async f=>{
 for(const model of ['55','65']){const s=await f.stored({model}),r=await f.begin(s);await f.use(r);await f.object(r);
  for(const change of [e=>e.extra='secret',e=>e.signature.xml_hash=hash('wrong'),e=>e.signature.certificate_fingerprint=hash('wrong'),e=>e.signature.profile='guess',e=>e.signature.reference_digest=Buffer.alloc(21).toString('base64'),e=>e.signature.reference_digest='//////////////////////////9=',e=>e.signature.signed_content_hash=['a'.repeat(64)],e=>e.xsd.xml_hash=hash('wrong'),e=>e.xsd.manifest_hash=hash('wrong'),e=>e.xsd.validator_hash=hash('wrong'),e=>e.xsd.validator_version='new',e=>e.qr.verified=!e.qr.verified,e=>e.qr.profile='https://attacker.invalid']){
   const evidence=f.proof(r);change(evidence);await assert.rejects(()=>f.finish(r,{evidence}),code('22023'));
  }
  for(const evidence of [null,[],{},'invalid'])await assert.rejects(()=>f.call('finish',{p_candidate_id:r.value.receipt.candidate_id,p_lease_id:r.value.execution.lease_id,p_signed_hash:hash('synthetic signed bytes'),p_size_bytes:1024,p_evidence:evidence}),code('22023'));
  assert.equal((await f.get(r)).current.state,'pending');await f.finish(r);
  await assert.rejects(()=>f.finish(r,{size:1025}),code('40001'));
 }
}));
test('050 use checks the exact unsigned and encrypted objects; rewrapping the same certificate never silently changes the pinned envelope',withFixture(async f=>{
 const s=await f.stored(),r=await f.begin(s),sourcePath=`jobs/${s.result.job_id}/${s.result.artifact.sha256}.xml`;
 await f.db.query("update storage.objects set metadata=jsonb_set(metadata,'{size}','1')where bucket_id='brufap-fiscal-artifacts'and name=$1",[sourcePath]);await assert.rejects(()=>f.use(r),code('40001'));
 await f.db.query("update storage.objects set metadata=jsonb_set(metadata,'{size}',$1::jsonb)where bucket_id='brufap-fiscal-artifacts'and name=$2",[String(s.result.artifact.size_bytes),sourcePath]);
 const vaultPath=`credentials/${f.selected.current.credential_id}/${f.selected.objectHash}.json`;
 await f.db.query("update storage.objects set metadata=jsonb_set(metadata,'{mimetype}','\"text/plain\"')where bucket_id='brufap-a1-vault'and name=$1",[vaultPath]);await assert.rejects(()=>f.use(r),code('40001'));
 await f.db.query("update storage.objects set metadata=jsonb_set(metadata,'{mimetype}','\"application/json\"')where bucket_id='brufap-a1-vault'and name=$1",[vaultPath]);await f.use(r);
 const command=randomUUID(),newHash=hash('rewrapped encrypted synthetic bytes'),reserved=await f.callSql('erp_a1_reserve',{p_user_id:f.users.admin,p_command_id:command,p_request_hash:hash(command),p_action:'rewrap',p_expected_version:f.selected.current.version,p_expected_identity_version:f.selected.current.company_identity_version,p_reason:'Rotação sintética da chave do cofre'});
 await f.db.query('insert into storage.objects values($1,$2,$3::jsonb)',['brufap-a1-vault',`credentials/${reserved.credential_id}/${newHash}.json`,JSON.stringify({size:257,mimetype:'application/json'})]);
 await f.callSql('erp_a1_finalize',{p_user_id:f.users.admin,p_command_id:command,p_lease_id:reserved.lease_id,p_metadata:f.selected.metadata,p_object_hash:newHash,p_size_bytes:257,p_key_id:'synthetic_kek_v2'});
 await assert.rejects(()=>f.use(r),code('40001'));await f.object(r);await assert.rejects(()=>f.finish(r),code('40001'));
 const next=await f.begin(s);assert.equal(next.value.receipt.credential_id,r.value.receipt.credential_id);assert.equal(next.value.receipt.certificate_fingerprint,r.value.receipt.certificate_fingerprint);assert.notEqual(next.value.receipt.candidate_id,r.value.receipt.candidate_id);
 assert.equal((await f.use(next)).credential_object.hash,newHash);
}));
test('050 attempt exhaustion and lease expiry inside final writes roll back without producing a stored candidate',withFixture(async f=>{
 const s=await f.stored(),r=await f.begin(s);await f.use(r);await f.object(r);
 await f.db.exec("create sequence public.synthetic_signed_entered;create function public.synthetic_signed_slow()returns trigger language plpgsql as $$begin perform nextval('public.synthetic_signed_entered');perform pg_sleep(0.35);return new;end$$;create trigger slow_signed_artifact before insert on erp_fiscal_signed.artifact for each row execute function public.synthetic_signed_slow();alter table erp_fiscal_signed.candidate disable trigger guard_candidate;");
 await f.db.query("update erp_fiscal_signed.candidate set lease_until=clock_timestamp()+interval'300 milliseconds'where id=$1",[r.value.receipt.candidate_id]);await f.db.exec('alter table erp_fiscal_signed.candidate enable trigger guard_candidate');
 await assert.rejects(()=>f.finish(r),code('40001'));assert.equal(await f.scalar('select is_called value from public.synthetic_signed_entered'),true);assert.equal(await f.scalar('select count(*)::int value from erp_fiscal_signed.artifact'),0);assert.equal((await f.get(r)).current.state,'pending');
 await f.db.exec('drop trigger slow_signed_artifact on erp_fiscal_signed.artifact;drop function public.synthetic_signed_slow();alter table erp_fiscal_signed.candidate disable trigger guard_candidate;');
 await f.db.query('update erp_fiscal_signed.candidate set attempt_count=100 where id=$1',[r.value.receipt.candidate_id]);await f.db.exec('alter table erp_fiscal_signed.candidate enable trigger guard_candidate');
 await assert.rejects(()=>f.begin(s),code('40001'));assert.equal(await f.scalar('select count(*)::int value from erp_fiscal_signed.command'),1);
}));
test('050 requires private immutable object metadata and exact hash path/size; no client path or Storage I/O is accepted',withFixture(async f=>{
 const s=await f.stored(),r=await f.begin(s);await f.use(r);await assert.rejects(()=>f.finish(r),code('40001'));await f.object(r);
 for(const sql of ["update storage.buckets set public=true where id='brufap-fiscal-artifacts'","update storage.buckets set allowed_mime_types=array['application/xml']where id='brufap-fiscal-artifacts'","update storage.buckets set file_size_limit=999 where id='brufap-fiscal-artifacts'","alter table storage.objects disable row level security"]){
  await f.db.exec('begin');try{await f.db.exec(sql);await assert.rejects(()=>f.finish(r),code('55000'));}finally{await f.db.exec('rollback');}
 }
 await assert.rejects(()=>f.finish(r,{size:1023}),code('40001'));await assert.rejects(()=>f.finish(r,{size:512001}),code('22023'));
 assert.equal((await f.finish(r)).current.state,'stored');
}));
test('050 A1 replacement/disable/identity changes cannot silently switch credentials or finish a pending candidate',withFixture(async f=>{
 const s=await f.stored(),r=await f.begin(s);await f.use(r);await f.object(r);await f.configure();
 await assert.rejects(()=>f.use(r),code('40001'));await assert.rejects(()=>f.finish(r),code('40001'));await assert.rejects(()=>f.call('begin',r.args),code('40001'));
 const newIntent=await f.begin(s);assert.notEqual(newIntent.value.receipt.candidate_id,r.value.receipt.candidate_id);assert.notEqual(newIntent.value.receipt.credential_id,r.value.receipt.credential_id);assert.equal(newIntent.value.receipt.version,2);
 await f.disable();await assert.rejects(()=>f.use(newIntent),code('40001'));assert.equal((await f.get(r)).current.a1_changed,true);
 await f.configure();const third=await f.begin(s);await f.use(third);await f.object(third);await f.identity({trade_name:'Empresa fictícia atualizada'});
 await assert.rejects(()=>f.finish(third),code('40001'));assert.equal((await f.get(third)).current.basis_changed,true);
 await f.identity({cnpj:'12345678000195'});for(const action of [()=>f.use(third),()=>f.finish(third),()=>f.get(third),()=>f.command(third),()=>f.fail(third)])await assert.rejects(action,code('42501'));
}));
test('050 changed047 or newer048 source invalidates use/finish without rebase or new number',withFixture(async f=>{
 const s=await f.stored(),r=await f.begin(s);await f.use(r);await f.object(r);const before=await f.counts();await f.updateCompletion(s.source);
 await assert.rejects(()=>f.use(r),code('40001'));await assert.rejects(()=>f.finish(r),code('40001'));assert.equal((await f.get(r)).current.artifact_current,false);assert.equal((await f.get(r)).current.basis_changed,true);assert.deepEqual(await f.counts(),before);
}));
test('050 deterministic failure is terminal and sanitised; timeout is never a fiscal failure',withFixture(async f=>{
 const s=await f.stored(),r=await f.begin(s);for(const value of ['TIMEOUT','RAW_PRIVATE_ERROR',null])await assert.rejects(()=>f.fail(r,value),code('22023'));
 const failed=await f.fail(r);assert.equal(failed.error_code,'XSD_INVALID');assert.equal(failed.signed,false);assert.equal(failed.artifact,null);
 assert.equal((await f.fail(r)).replayed,true);await assert.rejects(()=>f.fail(r,'SIGNATURE_INVALID'),code('40001'));
 const replay=await f.call('begin',r.args);assert.equal(replay.execution,null);assert.equal(replay.current.state,'failed');await assert.rejects(()=>f.use(r),code('40001'));
}));
test('050 atomic rollback preserves a pending attempt after failure in final state mutation; confirmed history is immutable',withFixture(async f=>{
 const s=await f.stored(),r=await f.begin(s);await f.use(r);await f.object(r);
 await f.db.exec("create function public.synthetic_signed_failure()returns trigger language plpgsql as $$begin raise exception 'synthetic failure';end$$;create trigger zzz_failure before update on erp_fiscal_signed.candidate for each row execute function public.synthetic_signed_failure();");
 await assert.rejects(()=>f.finish(r),code('P0001'));assert.equal(await f.scalar('select count(*)::int value from erp_fiscal_signed.artifact'),0);assert.equal((await f.get(r)).current.state,'pending');
 assert.equal(await f.scalar("select state value from erp_fiscal_signed.attempt where id=$1",[r.value.execution.lease_id]),'pending');
 await f.db.exec('drop trigger zzz_failure on erp_fiscal_signed.candidate;drop function public.synthetic_signed_failure()');await f.finish(r);
 for(const sql of ['delete from erp_fiscal_signed.candidate',"update erp_fiscal_signed.candidate set basis_hash=repeat('a',64)",'delete from erp_fiscal_signed.command',"update erp_fiscal_signed.command set receipt='{}'",'delete from erp_fiscal_signed.artifact',"update erp_fiscal_signed.attempt set state='pending',finished_at=null"])await assert.rejects(()=>f.db.exec(sql),code('42501'));
}));
test('050 historical pagination exposes bounded receipts but no credential object, XML or private identity',withFixture(async f=>{
 const s=await f.stored(),one=await f.begin(s);await f.use(one);await f.object(one);await f.finish(one);await f.configure();const two=await f.begin(s);
 const page=await f.call('history',{p_unsigned_job_id:s.result.job_id,p_limit:1,p_before:null});assert.equal(page.items[0].receipt.candidate_id,two.value.receipt.candidate_id);assert.equal(page.has_more,true);assert.equal(page.next_cursor,2);
 const next=await f.call('history',{p_unsigned_job_id:s.result.job_id,p_limit:1,p_before:2});assert.equal(next.items[0].receipt.candidate_id,one.value.receipt.candidate_id);assert.equal(next.has_more,false);assert.equal(next.next_cursor,null);assert.equal(next.items[0].current.artifact_current,false);
 assert.doesNotMatch(JSON.stringify(page),/credential_object|envelope_hash|cnpj|access_key|key_id|ciphertext|BEGIN CERTIFICATE|jobs\/|candidates\/|credentials\//);
 for(const p_limit of [0,26,null])await assert.rejects(()=>f.call('history',{p_unsigned_job_id:s.result.job_id,p_limit,p_before:null}),code('22023'));
}));
