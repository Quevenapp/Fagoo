import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {preflightFixture,query,publicQuery,hash} from './preflight-fixture.mjs';
import {projectPreflightPublic,projectPreflightSnapshot} from '../src/preflight-dto.mjs';
import {PREFLIGHT_RPC,createAuthorizationPreflightRpc} from '../src/preflight-rpc.mjs';
const reject=(fn,code)=>assert.rejects(fn,e=>e.code===code);
const args=c=>({p_user_id:c.input.actor,p_candidate_id:c.input.candidateId,p_signed_hash:c.input.signedHash});
const journal=async f=>(await f.db.query(`select (select count(*)from erp_fiscal_authorization.intent)::int intents,(select count(*)from erp_fiscal_authorization.command)::int commands,(select count(*)from erp_fiscal_authorization.attempt)::int attempts,(select count(*)from erp_fiscal_authorization.request)::int requests,(select count(*)from erp_fiscal_authorization.audit)::int audits,(select count(*)from erp_fiscal_reviewed_authorization.review_binding)::int bindings,(select count(*)from erp_fiscal_reviewed_authorization.observation)::int observations`)).rows[0];
test('072 read-only SQL→HTTP→service preflight remains a snapshot, never a grant',{timeout:60000},async t=>{
 const f=await preflightFixture();try{
  await t.test('only one service-only STABLE RPC is added; all existing function bodies and policies preserved',async()=>{
   const after=(await f.db.query("select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' name,p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname like 'erp_%'or(n.nspname='public'and p.proname like 'erp_%')order by 1")).rows;
   assert.equal(after.length,f.before.length+1);assert.deepEqual(after.filter(x=>!x.name.startsWith('public.'+PREFLIGHT_RPC+'(')),f.before);
   const p=(await f.db.query('select provolatile,prosecdef,proconfig,has_function_privilege(\'anon\',oid,\'EXECUTE\') anon,has_function_privilege(\'authenticated\',oid,\'EXECUTE\') authenticated,has_function_privilege(\'service_role\',oid,\'EXECUTE\') service from pg_proc where proname=$1',[PREFLIGHT_RPC])).rows[0];assert.equal(p.provolatile,'s');assert.equal(p.prosecdef,true);assert.deepEqual(p.proconfig,['search_path=pg_catalog']);assert.equal(p.anon,false);assert.equal(p.authenticated,false);assert.equal(p.service,true);
   assert.equal((await f.db.query("select count(*)::int n from erp_fiscal_authorization.policy where authorization_profile='reviewed_subset_v1'and enabled")).rows[0].n,0);
  });
  for(const model of ['55','65'])await t.test(model+' valid review has real CAS and disabled policy/runtime; READ ONLY transaction succeeds',async()=>{
   const c=await f.candidate(model);await f.review(c);const before=await journal(f);await f.db.exec('begin read only');let v;
   try{v=await f.preflight().preflight(query(c),f.opts());await f.db.exec('commit');}catch(e){await f.db.exec('rollback');throw e;}
   assert.deepEqual(v.blockers,['POLICY_DISABLED','RUNTIME_DISABLED']);assert.equal(v.can_run,false);assert.equal(v.evaluation.status,'reviewed_subset');assert.equal(v.tax_rules_validated,false);assert.equal(v.selection.expected_review_version,1);assert.equal(v.selection.expected_identity_version,1);assert.equal(v.selection.expected_a1_version,2);assert.equal(v.selection.expected_policy_version,3);assert.deepEqual(projectPreflightPublic(v,publicQuery(c)),v);assert.deepEqual(await journal(f),before);
   assert.doesNotMatch(JSON.stringify(v),/issuer_cnpj|credential_id|certificate_fingerprint|envelope_hash|record_text|<NFe|PRIVATE/);
  });
  let enabled=await f.enable();
  await t.test('fixture-only enabled policy/runtime can expose can_run while all authority flags stay false',async()=>{
   const c=await f.candidate();await f.review(c);const v=await f.preflight({enabled:true}).preflight(query(c),f.opts());assert.equal(v.can_run,true);assert.equal(v.selection.expected_policy_version,enabled);assert.equal(v.can_emit,false);assert.equal(v.can_transmit,false);assert.equal(v.production_authorized,false);assert.equal(v.tax_rules_validated,false);assert.deepEqual(v.blockers,[]);
  });
  await t.test('latest-first review cannot fall back to an earlier compatible declaration',async()=>{
   const c=await f.candidate();const first=await f.review(c),newer=await f.review(c,{p_command_id:randomUUID(),p_expected_review_version:1,p_facts_hash:hash('different facts')});
   const v=await f.preflightRpc(query(c),f.opts());assert.equal(v.review.review_id,newer.review_id);assert.notEqual(v.review.review_id,first.review_id);await reject(()=>f.preflight({enabled:true}).preflight(query(c),f.opts()),'40001');
  });
  await t.test('missing review and inactive reviewer never pass evaluation',async()=>{
   const c=await f.candidate();let v=await f.preflight({enabled:true}).preflight(query(c),f.opts());assert.equal(v.selection,null);assert.equal(v.can_run,false);assert.ok(v.blockers.includes('REVIEW_MISSING_OR_MISMATCHED'));assert.ok(v.blockers.includes('RULE_EVALUATION_PENDING'));
   await f.review(c,{p_user_id:f.users.admin});await f.db.query('update erp_access.membership set active=false where user_id=$1',[f.users.admin]);
   try{v=await f.preflight({enabled:true}).preflight(query(c),f.opts());assert.equal(v.checks.reviewer_active,false);assert.equal(v.can_run,false);assert.ok(v.blockers.includes('REVIEWER_INACTIVE'));}finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[f.users.admin]);}
  });
  await t.test('same source hash and current membership are required; private diagnostics do not escape HTTP',async()=>{
   const c=await f.candidate();await reject(()=>f.preflightRpc({...query(c),signedHash:hash('wrong')},f.opts()),'40001');await reject(()=>f.preflightRpc({...query(c),actor:f.users.consulta},f.opts()),'42501');
   await f.db.query('update erp_access.membership set active=false where user_id=$1',[f.users.fiscal]);try{await reject(()=>f.preflightRpc(query(c),f.opts()),'42501');}finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[f.users.fiscal]);}
   await reject(()=>f.callSql(PREFLIGHT_RPC,{...args(c),p_signed_hash:null}),'22023');
  });
  await t.test('state changes during evaluation reject the snapshot before returning CAS',async()=>{
   const c=await f.candidate();await f.review(c);let reads=0;
   await reject(()=>f.preflight({enabled:true,rpc:async(x,o)=>{if(++reads===2)enabled=await f.enable();return f.preflightRpc(x,o);}}).preflight(query(c),f.opts()),'40001');
  });
  await t.test('active and consumed intents block a second submission, without changing their records',async()=>{
   const c=await f.candidate(),proof=await f.review(c),b=await f.begin(c,enabled);let v=await f.preflight({enabled:true}).preflight(query(c),f.opts());assert.ok(v.blockers.includes('ATTEMPT_ALREADY_EXISTS'));assert.equal(v.checks.submission_consumed,false);
   await f.prepare(b,proof);await f.use(b,proof);const before=await journal(f);v=await f.preflight({enabled:true}).preflight(query(c),f.opts());assert.equal(v.checks.submission_consumed,true);assert.ok(v.blockers.includes('SUBMISSION_ALREADY_CONSUMED'));assert.deepEqual(await journal(f),before);
  });
  await t.test('DTO rejects flags, forged versions/review/selection and inert getter traps',async()=>{
   const c=await f.candidate();await f.review(c);const v=await f.preflight({enabled:true}).preflight(query(c),f.opts());for(const change of[x=>x.tax_rules_validated=true,x=>x.selection.expected_review_hash=hash('other'),x=>x.policy.authorization_profile='legacy_v1',x=>x.checks.reviewer_active=false,x=>x.credential_id=randomUUID()]){const b=structuredClone(v);change(b);assert.throws(()=>projectPreflightPublic(b,publicQuery(c)));}
   let calls=0;const bad=structuredClone(v);Object.defineProperty(bad,'blockers',{enumerable:true,get(){calls++;return[];}});assert.throws(()=>projectPreflightPublic(bad,publicQuery(c)));assert.equal(calls,0);
   const raw=await f.preflightRpc(query(c),f.opts());assert.throws(()=>projectPreflightSnapshot(raw,{...publicQuery(c),signed_hash:hash('wrong')}));
  });
  await t.test('expired latest review blocks instead of selecting an earlier still-valid review',async()=>{
   const c=await f.candidate();await f.review(c);const expired=await f.review(c,{p_command_id:randomUUID(),p_expected_review_version:1,p_valid_until:new Date(Date.now()+500).toISOString()});await new Promise(r=>setTimeout(r,550));
   const v=await f.preflight({enabled:true}).preflight(query(c),f.opts());assert.equal(v.review.review_id,expired.review_id);assert.equal(v.checks.review_within_validity,false);assert.ok(v.blockers.includes('REVIEW_TIME_INVALID'));assert.equal(v.can_run,false);
  });
  await t.test('legacy policy and disabled A1 stay explicit blockers with no private credential read',async()=>{
   const c=await f.candidate();await f.review(c);
   await f.db.query("insert into erp_fiscal_authorization.policy(model,version,origin,enabled,binding_reviewed,tax_rules_reviewed,valid_from,valid_until)select '55',max(version)+1,'operational',false,false,false,'2026-10-16T00:00:00Z','2026-10-26T00:00:00Z'from erp_fiscal_authorization.policy where model='55'");
   let v=await f.preflight({enabled:true}).preflight(query(c),f.opts());assert.equal(v.policy.authorization_profile,'legacy_v1');assert.equal(v.checks.policy_matches,false);assert.ok(v.blockers.includes('REVIEWED_POLICY_MISMATCH'));assert.equal(v.can_run,false);
   const disableCommand=randomUUID();await f.callSql('erp_a1_disable',{p_user_id:f.users.admin,p_command_id:disableCommand,p_request_hash:hash(disableCommand),p_expected_version:v.versions.a1,p_reason:'DESATIVACAO FICTICIA LOCAL'});v=await f.preflight({enabled:true}).preflight(query(c),f.opts());assert.equal(v.checks.a1_usable,false);assert.ok(v.blockers.includes('A1_UNAVAILABLE'));assert.equal(v.can_run,false);
  });
  assert.ok(f.preflightCalls.every(n=>[PREFLIGHT_RPC,'erp_fiscal_signed_get','erp_fiscal_subset_review_get','read'].includes(n)));
 }finally{await f.close();}
});
test('preflight RPC captures input, rejects empty chunks and has bounded best-effort cleanup',async()=>{
 let calls=0,cancelled=0;const c={actor:'00000000-0000-4000-8000-000000000001',candidateId:'00000000-0000-4000-8000-000000000002',signedHash:'a'.repeat(64)},config={projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-test-service-key-only',fetchImpl:async()=>{calls++;return new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array());},cancel(){cancelled++;return new Promise(()=>{});}}),{headers:{'content-type':'application/json'}});}};
 const rpc=createAuthorizationPreflightRpc(config);await reject(()=>rpc(c,{deadline:Date.now()+1000}),'AUTHORIZATION_PREFLIGHT_RPC_RESPONSE_INVALID');assert.equal(calls,1);assert.equal(cancelled,1);
 const abort=new AbortController();abort.abort();await reject(()=>rpc(c,{signal:abort.signal}),'AUTHORIZATION_SERVICE_ABORTED');assert.equal(calls,1);
 let getter=0;const bad={...c};Object.defineProperty(bad,'actor',{enumerable:true,get(){getter++;return c.actor;}});await assert.rejects(()=>rpc(bad));assert.equal(getter,0);
});
