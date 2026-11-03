import test from 'node:test';
import assert from 'node:assert/strict';
import {emissionSqlFixture,migration080} from './emission-window-sql-fixture.mjs';
import {hash} from './reviewed-ledger-fixture.mjs';
const rejected=(fn,code,message)=>assert.rejects(fn,e=>e.code===code&&(!message||e.message===message));
test('080 SQL consumption window: metadata source, bounds, atomic rollback and historical compatibility',async t=>{
 const f=await emissionSqlFixture();try{
  // This old consumed record predates the trigger, and must stay readable/finalizable.
  const old=await f.fresh();await f.use(old.b,old.proof);const oldFinish=await f.finishArgs(old.b,old.p);
  const before=await f.ledger(),functions=(await f.db.query(`select oid,md5(prosrc)hash,proacl,proconfig from pg_proc where pronamespace in(select oid from pg_namespace where nspname like 'erp_%'or nspname='public')order by oid`)).rows;
  await t.test('DDL only adds two private helpers and two triggers; data, routines and defaults preserved',async()=>{
   const defaults=(await f.db.query('select to_jsonb(d)v from pg_default_acl d order by oid')).rows;
   await f.install080();assert.deepEqual(await f.ledger(),before);
   assert.deepEqual((await f.db.query(`select oid,md5(prosrc)hash,proacl,proconfig from pg_proc where oid=any($1::oid[])order by oid`,[functions.map(x=>x.oid)])).rows,functions);
   assert.deepEqual((await f.db.query('select to_jsonb(d)v from pg_default_acl d order by oid')).rows,defaults);
   const helpers=(await f.db.query(`select p.proname,p.prosecdef,p.proconfig,
    has_function_privilege('anon',p.oid,'EXECUTE')a,has_function_privilege('authenticated',p.oid,'EXECUTE')u,has_function_privilege('service_role',p.oid,'EXECUTE')s,
    exists(select 1 from aclexplode(p.proacl)x where x.is_grantable)grantable
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='erp_fiscal_reviewed_authorization'and p.proname in('check_nfce_emission_window','guard_nfce_emission_window')`)).rows;
   assert.equal(helpers.length,2);assert.ok(helpers.every(x=>!x.a&&!x.u&&!x.s&&!x.grantable&&x.prosecdef===(x.proname==='guard_nfce_emission_window')&&x.proconfig[0]==='search_path=pg_catalog'));
   assert.equal((await f.db.query(`select count(*)::int n from pg_trigger where tgrelid='erp_fiscal_authorization.attempt'::regclass and tgname='reviewed_use_time_guard'and not tgisinternal`)).rows[0].n,1);
   const ordered=(await f.db.query(`select tgname from pg_trigger where tgrelid='erp_fiscal_authorization.attempt'::regclass and not tgisinternal and (tgtype&2)=2 order by tgname`)).rows.map(x=>x.tgname);
   assert.ok(ordered.indexOf('reviewed_use_time_guard')>ordered.indexOf('reviewed_use_guard')&&ordered.includes('reviewed_use_guard'));
   const deferred=(await f.db.query(`select tgdeferrable,tginitdeferred from pg_trigger where tgrelid='erp_fiscal_authorization.attempt'::regclass and tgname='reviewed_use_time_commit'`)).rows;
   assert.deepEqual(deferred,[{tgdeferrable:true,tginitdeferred:true}]);
   assert.doesNotMatch(migration080,/create (?:table|schema)|create or replace|grant .* to|update erp_/i);
  });
  await t.test('strict clock bounds: 270/300 seconds and future tolerance, one millisecond either side',async()=>{
   const check=offset=>f.db.query(`select erp_fiscal_reviewed_authorization.check_nfce_emission_window('2026-10-17T01:00:00-03:00','2026-10-17T04:00:00Z'::timestamptz+$1::double precision*interval'1 millisecond')`,[offset]);
   for(const v of[-300000,0,269999])await check(v);
   for(const v of[270000,299999])await rejected(()=>check(v),'40001','nfce_emission_window_too_short');
   for(const v of[300000,300001])await rejected(()=>check(v),'40001','nfce_emission_time_expired');
   await rejected(()=>check(-300001),'40001','nfce_emission_time_future');
   for(const v of[null,'','2026-02-30T01:00:00-03:00','2026-10-17T24:00:00-03:00','2026-10-17T04:00:00Z','2026-10-17T01:00:00.000-03:00'])
    await rejected(()=>f.db.query(`select erp_fiscal_reviewed_authorization.check_nfce_emission_window($1,clock_timestamp())`,[v]),'55000','nfce_emission_time_invalid');
   for(const v of[null,'infinity','-infinity'])await rejected(()=>f.db.query(`select erp_fiscal_reviewed_authorization.check_nfce_emission_window('2026-10-17T01:00:00-03:00',$1::timestamptz)`,[v]),'55000','nfce_emission_time_invalid');
  });
  for(const [seconds,message]of[[271,'nfce_emission_window_too_short'],[301,'nfce_emission_time_expired'],[-302,'nfce_emission_time_future']]){
   await t.test(`reviewed65 ${message} rolls back every ledger mutation through RPC069 and direct064`,async()=>{
    const x=await f.fresh();await f.ageIdentity(x,seconds);const before=await f.ledger();
    for(const fn of[()=>f.call('use',x.use),()=>f.callSql('erp_fiscal_authorization_use',f.ids(x.b))]){await rejected(fn,'40001',message);assert.deepEqual(await f.ledger(),before);}
    const c=await f.wire('command',{p_user_id:f.users.fiscal,p_command_id:x.b.args.p_command_id});assert.equal(c.current.state,'request_ready');assert.equal(c.current.grant_consumed,false);
   });
  }
  await t.test('invalid immutable timestamp fails closed without exposing another source',async()=>{
   const x=await f.fresh();await f.ageIdentity(x,0,{literal:'2026-02-30T01:00:00-03:00'});const before=await f.ledger();
   await rejected(()=>f.call('use',x.use),'55000','nfce_emission_time_invalid');assert.deepEqual(await f.ledger(),before);
  });
  await t.test('valid reviewed65 consumes exactly once; caller transaction rollback restores grant',async()=>{
   const x=await f.fresh();await f.ageIdentity(x,260);const before=await f.ledger();
   await f.db.exec('begin');await f.call('use',x.use);await f.db.exec('rollback');assert.deepEqual(await f.ledger(),before);
   const got=await f.use(x.b,x.proof);assert.equal(got.grant.origin,'operational');assert.equal(got.rule_review.tax_rules_validated,false);
   await rejected(()=>f.call('use',x.use),'40001');
   await f.ageIdentity(x,3600);const args=await f.finishArgs(x.b,x.p),saved=await f.wire('finish',args);
   assert.equal(saved.current.state,'authorized_homologation');assert.equal((await f.wire('finish',args)).replayed,true);
  });
  await t.test('deadline crossed after provisional consume rolls back the entire commit',async()=>{
   const x=await f.fresh();await f.ageIdentity(x,268);const before=await f.ledger();
   await f.db.exec('begin');await f.call('use',x.use);await new Promise(resolve=>setTimeout(resolve,2500));
   await rejected(()=>f.db.exec('commit'),'40001','nfce_emission_window_too_short');assert.deepEqual(await f.ledger(),before);
  });
  await t.test('55 and synthetic65 remain on their original temporal contract',async()=>{
   for(const[model,origin]of[['55','operational'],['65','synthetic']]){
    const x=await f.fresh(model,origin);await f.ageIdentity(x,3600);assert.equal((await f.use(x.b,x.proof)).grant.origin,origin);
   }
  });
  await t.test('legacy064 operational65 keeps its own profile and full-tax contract',async()=>{
   const version=Number((await f.db.query('select max(version)+1 v from erp_fiscal_authorization.policy')).rows[0].v);
   await f.db.query(`insert into erp_fiscal_authorization.policy(model,version,origin,enabled,binding_profile,rule_profile,binding_reviewed,tax_rules_reviewed,source_manifest_hash,valid_from,valid_until)
    values('65',$1,'operational',true,'legacy-synthetic-binding-fixture','legacy-full-tax-fixture',true,true,$2,clock_timestamp()-interval'1 day',clock_timestamp()+interval'1 day')`,[version,hash('legacy fixture only')]);
   const c=await f.candidate('65'),args={p_user_id:f.users.fiscal,p_command_id:c.input.commandId,p_candidate_id:c.input.candidateId,p_signed_hash:c.input.signedHash,p_expected_identity_version:1,p_expected_a1_version:2,p_expected_policy_version:version,p_confirmed:true};
   const b={args,value:await f.callSql('erp_fiscal_authorization_begin',args)},rh=hash('legacy request');await f.object(b,'requests',rh);
   const p={...f.ids(b),p_request_hash:rh,p_request_size:32,p_evidence:f.preparation(b,rh)};
   await rejected(()=>f.callSql('erp_fiscal_authorization_prepare',p),'22023');p.p_evidence.tax_rules_validated=true;
   await f.callSql('erp_fiscal_authorization_prepare',p);await f.ageIdentity({c},3600);
   const grant=await f.callSql('erp_fiscal_authorization_use',f.ids(b));assert.equal(grant.grant.origin,'operational');
  });
  await t.test('preexisting consumed65 finishes and replays after expiry/current policy changes',async()=>{
   await f.ageIdentity(old,3600);await f.enable('operational',false);
   const saved=await f.wire('finish',oldFinish);assert.equal(saved.current.state,'authorized_homologation');assert.equal((await f.wire('finish',oldFinish)).replayed,true);
   const read=await f.wire('command',{p_user_id:f.users.fiscal,p_command_id:old.b.args.p_command_id});assert.deepEqual(read.artifact,saved.artifact);
   const page=await f.wire('history',{p_user_id:f.users.fiscal,p_candidate_id:old.c.input.candidateId,p_limit:25,p_before:null});assert.deepEqual(page.items[0].artifact,saved.artifact);
   assert.equal(read.current.policy_changed,true);
  });
 }finally{await f.close();}
});
