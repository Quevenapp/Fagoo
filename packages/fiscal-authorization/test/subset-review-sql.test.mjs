import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {subsetFixture,canonical,hash,credit} from './subset-review-fixtures.mjs';
import {recordText,MAX_SUBSET_RECORD_BYTES} from '../src/subset-review-dto.mjs';
import {createSubsetReviewRpc} from '../src/subset-review-rpc.mjs';
import {createSpCrt1ReviewReader,evaluateSpCrt1Rules,SP_CRT1_RULE_MANIFEST_HASH} from '../src/sp-crt1-rule-profile.mjs';
const rejects=(fn,code)=>assert.rejects(fn,e=>e.code===code);
test('068 real SQL and private HTTP preserve declarations, receipts, ACL and byte-level review bindings',async t=>{
 const f=await subsetFixture();try{
  const c=await f.candidate('55');let saved;
  await t.test('absence, persisted55 review, canonical parity and rehydration through the existing evaluator',async()=>{
   assert.equal((await f.call('get',c.getArgs)).receipt,null);
   assert.equal(await f.reader(c.q,{...f.opts(),maxBytes:MAX_SUBSET_RECORD_BYTES}),null);
   saved=await f.rpc('erp_fiscal_subset_review_save',c.args,f.opts());const body=recordText(saved.record_text);
   assert.equal(saved.receipt.review_hash,hash(canonical(Object.fromEntries(Object.entries(body).filter(([k])=>k!=='review_hash')))));
   assert.equal(body.reviewed_by,f.users.fiscal);assert.equal(body.version,1);assert.equal(body.profile_hash,SP_CRT1_RULE_MANIFEST_HASH);
   const evidence=await createSpCrt1ReviewReader({readReview:q=>f.reader({...q,actor:c.q.actor,candidateVersion:c.q.candidateVersion},{...f.opts(),maxBytes:MAX_SUBSET_RECORD_BYTES})})({candidate:c.handle,now:new Date()});
   const report=evaluateSpCrt1Rules({candidate:c.handle,reviewEvidence:evidence,now:new Date()});assert.equal(report.taxRulesValidated,false);assert.equal(report.canTransmit,false);assert.equal(report.canEmit,false);
   const replay=await f.call('save',c.args);assert.deepEqual(replay.receipt,saved.receipt);assert.equal(replay.record_text,saved.record_text);assert.equal(replay.replayed,true);
  });
  await t.test('same UUID is fixed to actor/body, review version CAS and explicit pending declarations',async()=>{
   await rejects(()=>f.call('save',{...c.args,p_facts_hash:'a'.repeat(64)}),'40001');
   await rejects(()=>f.call('save',{...c.args,p_user_id:f.users.admin}),'40001');
   await rejects(()=>f.call('save',{...c.args,p_command_id:randomUUID()}),'40001');
   const data=structuredClone(c.declaration);data.document.payment='unreviewed';
   const args={...c.args,p_command_id:randomUUID(),p_expected_review_version:1,p_declaration_text:canonical(data)};
   const second=await f.call('save',args);assert.equal(second.receipt.review_version,2);
   const bytes=await f.reader(c.q,{...f.opts(),maxBytes:MAX_SUBSET_RECORD_BYTES});assert.equal(JSON.parse(bytes).document.payment,'unreviewed');
   const evidence=await createSpCrt1ReviewReader({readReview:async()=>bytes})({candidate:c.handle,now:new Date()});
   const report=evaluateSpCrt1Rules({candidate:c.handle,reviewEvidence:evidence,now:new Date()});assert.notEqual(report.status,'reviewed_subset');assert.equal(report.taxRulesValidated,false);
   const historical=await f.call('command',{p_user_id:c.q.actor,p_command_id:c.args.p_command_id});assert.deepEqual(historical.receipt,saved.receipt);assert.equal(historical.current.is_latest,false);assert.equal(historical.current.latest_review_version,2);
  });
  await t.test('latest lookup never falls back to a matching historical facts hash',async()=>{
   const next={...c.args,p_command_id:randomUUID(),p_expected_review_version:2,p_facts_hash:'f'.repeat(64)};await f.call('save',next);
   await rejects(()=>f.call('get',c.getArgs),'40001');
   assert.equal((await f.call('command',{p_user_id:c.q.actor,p_command_id:c.args.p_command_id})).record_text,saved.record_text);
  });
  await t.test('canonical bytes reject reordered/whitespace/duplicate keys and noncanonical integers/escapes',async()=>{
   const d=structuredClone(c.declaration);d.items[0].credit=credit('Declaração "sintética" \\ á 漢 😀');const canonicalText=canonical(d);
   const sql=(await f.db.query('select erp_fiscal_subset_review.canonical($1::jsonb)body',[canonicalText])).rows[0].body;assert.equal(sql,canonicalText);
   const variants=[JSON.stringify(d),canonicalText+' ',canonicalText.replace('"position":1','"position":1.0'),canonicalText.replace('"position":1','"position":1e0'),canonicalText.replace('"position":1','"position":1,"position":1'),canonicalText.replace('á','\\u00e1')];
   for(const text of variants)await rejects(()=>f.call('save',{...c.args,p_command_id:randomUUID(),p_expected_review_version:3,p_declaration_text:text}),'22023');
   const unicode=await f.call('save',{...c.args,p_command_id:randomUUID(),p_expected_review_version:3,p_declaration_text:canonicalText});assert.equal(recordText(unicode.record_text).items[0].credit.statement,d.items[0].credit.statement);
   for(const v of ['null','[]','{}','{"document":null,"items":[]}'])await rejects(()=>f.call('save',{...c.args,p_command_id:randomUUID(),p_declaration_text:v}),'22023');
   for(const control of ['\u0080','\u0085','\u009f']){const bad=structuredClone(d);bad.items[0].credit.statement='synthetic '+control;await rejects(()=>f.call('save',{...c.args,p_command_id:randomUUID(),p_expected_review_version:4,p_declaration_text:canonical(bad)}),'22023');}
  });
  await t.test('candidate/schema/profile/time CAS and strict types refuse writes',async()=>{
   for(const patch of [{p_expected_candidate_version:2},{p_signed_hash:'0'.repeat(64)},{p_schema:{...c.args.p_schema,validator_hash:'0'.repeat(64)}}])await rejects(()=>f.call('save',{...c.args,p_command_id:randomUUID(),p_expected_review_version:4,...patch}),'40001');
   for(const patch of [{p_profile_hash:'0'.repeat(64)},{p_expected_review_version:null},{p_facts_hash:null},{p_schema:null},{p_valid_until:'2026-02-30T12:00:00.000Z'},{p_valid_until:'2026-10-27T00:00:00.000Z'},{p_valid_until:'2026-10-25T00:00:00Z'}])await rejects(()=>f.call('save',{...c.args,p_command_id:randomUUID(),p_expected_review_version:4,...patch}),'22023');
   const count=(await f.db.query('select count(*)::int n from erp_fiscal_subset_review.review')).rows[0].n;assert.equal(count,4);
  });
  await t.test('RLS/ACL, current reviewer permissions and immutable rows',async()=>{
   for(const action of ['get','save','command'])await rejects(()=>f.call(action,{...(action==='get'?c.getArgs:action==='save'?c.args:{p_command_id:c.args.p_command_id}),p_user_id:f.users.vendas}),'42501');
   await rejects(()=>f.call('command',{p_user_id:f.users.admin,p_command_id:c.args.p_command_id}),'42501');
   await rejects(()=>f.call('command',{p_user_id:f.users.admin,p_command_id:randomUUID()}),'P0002');
   await rejects(()=>f.db.query('update erp_fiscal_subset_review.review set version=5 where id=$1',[c.args.p_command_id]),'42501');
   await f.db.query('update erp_access.membership set active=false where user_id=$1',[c.q.actor]);
   await rejects(()=>f.call('save',c.args),'42501');
   const raw=await f.call('get',{...c.getArgs,p_user_id:f.users.admin});assert.equal(raw.current.reviewer_active,false);
   await rejects(()=>f.reader({...c.q,actor:f.users.admin},{...f.opts(),maxBytes:MAX_SUBSET_RECORD_BYTES}),'SUBSET_REVIEW_NOT_CURRENT');
   await f.db.query('update erp_access.membership set active=true where user_id=$1',[c.q.actor]);
   const acl=await f.db.query("select has_schema_privilege('service_role','erp_fiscal_subset_review','USAGE') s,has_table_privilege('service_role','erp_fiscal_subset_review.review','SELECT')t,(select relrowsecurity from pg_class where oid='erp_fiscal_subset_review.review'::regclass)r");assert.deepEqual(acl.rows[0],{s:false,t:false,r:true});
   const funcs=await f.db.query("select p.oid::regprocedure::text name,has_function_privilege('service_role',p.oid,'EXECUTE')s,has_function_privilege('authenticated',p.oid,'EXECUTE')a,has_function_privilege('anon',p.oid,'EXECUTE')n from pg_proc p join pg_namespace x on x.oid=p.pronamespace where x.nspname='public'and p.proname like 'erp_fiscal_subset_review_%'");assert.equal(funcs.rows.length,3);assert.ok(funcs.rows.every(x=>x.s&&!x.a&&!x.n));
   await f.db.exec("create table erp_fiscal_subset_review.future_private_table(id integer);create sequence erp_fiscal_subset_review.future_private_sequence;create function erp_fiscal_subset_review.future_private_function()returns boolean language sql as $$select true$$;");
   const defaults=await f.db.query("select role,has_schema_privilege(role,'erp_fiscal_subset_review','USAGE')u,has_table_privilege(role,'erp_fiscal_subset_review.future_private_table','SELECT')t,has_sequence_privilege(role,'erp_fiscal_subset_review.future_private_sequence','USAGE')s from unnest(array['anon','authenticated','service_role'])role");assert.ok(defaults.rows.every(x=>!x.u&&!x.t&&!x.s));
   // Per-schema defaults cannot undo the global builtin PUBLIC function EXECUTE.
   // No schema USAGE still means no invocation; future migrations must revoke explicitly.
   for(const role of ['anon','authenticated','service_role'])try{await f.db.exec(`set role ${role}`);await rejects(()=>f.db.query('select erp_fiscal_subset_review.future_private_function()'),'42501');}finally{await f.db.exec('reset role');}
  });
  await t.test('250-item65 record survives HTTP escaping; final record bound includes metadata',async()=>{
   const big=await f.candidate('65',250);big.declaration.items[0].credit=credit('Unicode á漢😀; "quote" \\ slash');
   const args={...big.args,p_declaration_text:canonical(big.declaration)};
   const stored=await f.rpc('erp_fiscal_subset_review_save',args,f.opts());assert.ok(Buffer.byteLength(stored.record_text)>65536);assert.ok(Buffer.byteLength(stored.record_text)<=MAX_SUBSET_RECORD_BYTES);
   const bytes=await f.reader(big.q,{...f.opts(),maxBytes:MAX_SUBSET_RECORD_BYTES});assert.equal(bytes.toString(),stored.record_text);assert.equal(recordText(bytes.toString()).items.length,250);
   // Find a boundary where the declaration fits but its server-generated metadata does not.
   const target=MAX_SUBSET_RECORD_BYTES-16;let boundary;const d=structuredClone(big.declaration);for(let n=0;n<250;n++){d.items[n].credit=credit('a'.repeat(20));const v=canonical(d);if(Buffer.byteLength(v)>target)break;boundary=v;}
   assert.ok(boundary,'fixture must reach a declaration near the final byte limit');const near=JSON.parse(boundary);let gap=target-Buffer.byteLength(boundary);assert.ok(gap>=0);for(const item of near.items){if(item.credit){const add=Math.min(gap,1000-item.credit.statement.length);item.credit.statement+='a'.repeat(add);gap-=add;}}assert.equal(gap,0);boundary=canonical(near);assert.equal(Buffer.byteLength(boundary),target);
   await rejects(()=>f.call('save',{...big.args,p_command_id:randomUUID(),p_expected_review_version:1,p_declaration_text:boundary}),'22023');
   await rejects(()=>f.call('save',{...big.args,p_command_id:randomUUID(),p_expected_review_version:1,p_declaration_text:canonical({...big.declaration,items:[...big.declaration.items,{...big.declaration.items[0],position:251}]})}),'22023');
  });
  await t.test('lost save ACK is recovered by its command without a second save or new UUID',async()=>{
   const next=await f.candidate('55');let calls=0;
   const lost=createSubsetReviewRpc({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-lost-ack-service-key',fetchImpl:async(url,o)=>{calls++;const name=url.split('/').at(-1);await f.callSql(name,JSON.parse(Buffer.from(o.body).toString()));throw Error('synthetic lost ACK');}});
   await rejects(()=>lost('erp_fiscal_subset_review_save',next.args,f.opts()),'SUBSET_REVIEW_RPC_IO_FAILED');
   const receipt=await f.rpc('erp_fiscal_subset_review_command',{p_user_id:next.q.actor,p_command_id:next.args.p_command_id},f.opts());
   assert.equal(receipt.receipt.command_id,next.args.p_command_id);assert.equal(receipt.receipt.review_version,1);assert.equal(receipt.current.is_latest,true);assert.equal(calls,1);
   assert.equal((await f.db.query('select count(*)::integer n from erp_fiscal_subset_review.review where candidate_id=$1',[next.q.candidateId])).rows[0].n,1);
  });
  await t.test('historical command/replay survive A1/policy changes, with no authorization or operational writes',async()=>{
   await f.disable();
   await f.callSql('erp_fiscal_draft_execute',{p_user_id:f.users.fiscal,p_command_id:randomUUID(),p_action:'archive',p_data:{id:c.stored.receipt.draft_id,expected_version:1,reason:'Synthetic historical-read check'}});
   await f.db.query("insert into erp_fiscal_authorization.policy(model,version,origin,enabled,binding_reviewed,tax_rules_reviewed,valid_from,valid_until) values('55',3,'operational',false,false,false,clock_timestamp(),clock_timestamp()+interval'1day')");
   const historical=await f.rpc('erp_fiscal_subset_review_command',{p_user_id:c.q.actor,p_command_id:c.args.p_command_id},f.opts());assert.deepEqual(historical.receipt,saved.receipt);
   assert.deepEqual((await f.call('save',c.args)).receipt,saved.receipt);
   const latest=await f.rpc('erp_fiscal_subset_review_get',c.getArgs,f.opts());assert.equal(latest.receipt.review_version,4);
   const counts=await f.db.query('select (select count(*)::int from erp_fiscal_authorization.intent)i,(select count(*)::int from erp_fiscal_authorization.attempt)a,(select count(*)::int from erp_fiscal_authorization.command)c,(select count(*)::int from erp_fiscal_authorization.request)r,(select count(*)::int from erp_fiscal_authorization.result)z');assert.deepEqual(counts.rows[0],{i:0,a:0,c:0,r:0,z:0});
   assert.ok(f.rpcCalls.every(x=>x.name.startsWith('erp_fiscal_subset_review_')));
  });
 }finally{await f.close();}
});
