import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {windowBaselineFixture} from './helpers/fiscal55-window-fixture.mjs';
import {createFiscal55WindowDraft,readFiscal55WindowDraft,finalizeFiscal55Window,prepareFiscal55WindowSql,prepareFiscal55WindowReadback,prepareFiscal55PreflightRead,writeFiscal55WindowDraft,writeFiscal55WindowBundle,RULE_HASH} from './prepare_fiscal_homologation_55_window.mjs';

const h=x=>createHash('sha256').update(x).digest('hex');
const id=n=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
function pending(){return createFiscal55WindowDraft(windowBaselineFixture(),{baselineSha256:h('synthetic baseline')});}
test('private baseline digest must be explicitly pinned; no installation-specific fallback',async()=>{
 await assert.rejects(readFiscal55WindowDraft(join(tmpdir(),'nonexistent-fagoo-baseline.json')),/BASELINE_FILE/);
 const dir=await mkdtemp(join(tmpdir(),'fagoo-explicit-baseline-'));
 try{const file=join(dir,'baseline.json'),bytes=JSON.stringify(windowBaselineFixture());await writeFile(file,bytes,{mode:0o600});
  assert.equal((await readFiscal55WindowDraft(file,h(bytes))).baseline_sha256,h(bytes));
  await assert.rejects(readFiscal55WindowDraft(file,h('different bytes')),/BASELINE_FILE_CHANGED/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('fixture opaque digests are deterministic synthetic labels with shared references preserved',()=>{
 const baseline=windowBaselineFixture(),seen=new Map();let count=0;
 function walk(value,path='baseline',key=''){
  if(Array.isArray(value)){value.forEach((item,index)=>walk(item,`${path}[${index}]`));return;}
  if(value&&typeof value==='object'){for(const[k,v]of Object.entries(value))walk(v,`${path}.${k}`,k);return;}
  if(typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)&&!['source_manifest_hash','manifest_hash'].includes(key)){
   if(!seen.has(value))seen.set(value,path);assert.equal(value,h('fagoo-fiscal55-fixture-v1:'+seen.get(value)));count++;
  }
 }
 walk(baseline);assert.equal(count,31);assert.equal(seen.size,29);
 assert.equal(baseline.historical_authorizations.items[0].signed_hash,baseline.candidate_inventory.items[1].signed_hash);
 assert.equal(baseline.historical_authorizations.items[1].signed_hash,baseline.candidate_inventory.items[2].signed_hash);
});
function input(){
 const draft=pending(),b=draft.baseline,f=structuredClone(b),at='2026-10-17T10:04:00.000Z';
 f.observed_at='2026-10-17T10:03:00.000Z';f.selection.target_order_id=id(1);
 const order={...structuredClone(b.original_order),id:id(1),number:4,row_hash:h('order4'),body_hash:h('body4'),created_at:f.observed_at,updated_at:f.observed_at,fiscal_drafts:1,fiscal_reservations:1};
 order.items[0].id=id(2);order.items[0].row_hash=h('item4');
 f.target_order=order;f.counts.sales_orders=4;f.counts.sales_numbering_last='4';
 f.related_orders.total++;f.related_orders.items.unshift({id:order.id,number:4,version:1,status:'draft',total:'84.81',created_at:f.observed_at,updated_at:f.observed_at});
 f.series55.version++;f.series55.next_number='42196';f.series55.row_hash=h('series3');f.series55.updated_at=f.observed_at;
 const c={...structuredClone(b.candidate_inventory.items.find(x=>x.model==='55')),id:id(3),number:42195,source_document_id:order.id,reservation_id:id(4),signed_hash:h('signed4'),created_at:f.observed_at,finished_at:f.observed_at,has_attempt:false};
 const r={...structuredClone(b.reservations.items.find(x=>x.model==='55')),id:id(4),number:42195,source_document_id:order.id,draft_id:id(5),row_hash:h('reservation4'),series_version:b.series55.version,reserved_at:f.observed_at};
 f.candidate_inventory.items.push(c);f.candidate_inventory.total++;f.candidate_inventory.stored_without_attempt++;
 f.reservations.items.push(r);f.reservations.total++;f.checks.target_unprepared_without_effects=false;
 const preflight={preflight_profile:'authorization-reviewed-preflight-v2',read_only:true,tax_rules_validated:false,observed_at:f.observed_at,
  candidate:{candidate_id:c.id,candidate_version:c.version,model:'55',signed_hash:c.signed_hash},versions:{identity:b.company.identity_version,a1:b.a1.version,policy:5},blockers:['POLICY_DISABLED'],
  review:{review_id:id(6),review_version:1,review_hash:h('review4'),facts_hash:h('facts4'),candidate_version:c.version,signed_hash:c.signed_hash,profile_hash:RULE_HASH,reviewed_by:b.actor_inventory.items[0].user_id,reviewed_at:f.observed_at,valid_until:'2026-10-17T11:00:00.000Z'}};
 return {draft,freshBaseline:f,freshBaselineSha256:h('fresh synthetic'),preflight,approvedAt:at,runtimeFlagsVerified:true};
}
test('pending draft preserves exact original price and false informational role, cannot generate SQL',async()=>{
 const d=pending();assert.equal(d.target,null);assert.equal(d.approved_at,null);assert.equal(d.can_generate_enable,false);
 assert.equal(d.baseline.original_order.items[0].unit_price,'84.8062444176');
 assert.equal(d.baseline.catalog.contact.customer_role,false);assert.equal(d.baseline.checks.contact_active_pf_customer,false);
 await assert.rejects(prepareFiscal55WindowSql(d),/PLAN_KEYS/);
});
test('active PF/document remains mandatory even though the customer tag is informational',()=>{
 for(const [field,value]of[['active',false],['person_type','J'],['document_present',false],['document_matches_original_snapshot',false]]){
  const b=windowBaselineFixture();b.catalog.contact[field]=value;
  assert.throws(()=>createFiscal55WindowDraft(b,{baselineSha256:h('x')}),/CONTACT_ACTIVE_PF/);
 }
});
test('exact target commercial values and new chain are required; old42194 never selected',()=>{
 for(const edit of[
  x=>x.freshBaseline.target_order.items[0].unit_price='84.81',
  x=>x.freshBaseline.target_order.id=x.draft.baseline.original_order.id,
  x=>x.freshBaseline.target_order.stock_postings=1,
  x=>x.freshBaseline.candidate_inventory.items.at(-1).number=42194,
  x=>x.freshBaseline.reservations.items.at(-1).series_version++,
  x=>x.freshBaseline.series55.next_number='42197',
 ]){const x=input();edit(x);assert.throws(()=>finalizeFiscal55Window(x));}
});
test('historical55/65, actors, policy/query heads and competing inventory are pinned',()=>{
 for(const edit of[
  x=>x.freshBaseline.historical_authorizations.items[0].state='authorized',
  x=>x.freshBaseline.historical_revalidations.items[0].processed_hash=h('different'),
  x=>x.freshBaseline.actor_inventory.items[0].role='fiscal',
  x=>x.freshBaseline.authorization_policy_heads[1].enabled=true,
  x=>x.freshBaseline.receipt_query_policy_heads[0].enabled=true,
  x=>x.freshBaseline.candidate_inventory.items[0].signed_hash=h('changed'),
  x=>{x.freshBaseline.candidate_inventory.items.push({...x.freshBaseline.candidate_inventory.items.at(-1),id:id(99)});x.freshBaseline.candidate_inventory.total++;},
  x=>x.freshBaseline.counts.authorization_unresolved=1,
 ]){const x=input();edit(x);assert.throws(()=>finalizeFiscal55Window(x));}
});
test('fresh proof, review, explicit runtime confirmation and approval time bound the window',()=>{
 for(const edit of[
  x=>x.runtimeFlagsVerified=false,
  x=>x.approvedAt='2026-10-17T10:08:00.000Z',
  x=>x.preflight.review.valid_until='2026-10-17T10:05:00.000Z',
  x=>x.preflight.review.reviewed_by=id(900),
  x=>x.preflight.blockers.push('CANDIDATE_NOT_CURRENT'),
  x=>x.preflight.review.profile_hash=h('v1'),
 ]){const x=input();edit(x);assert.throws(()=>finalizeFiscal55Window(x));}
 const x=input();x.preflight.review.valid_until='2026-10-17T10:15:00.000Z';
 const p=finalizeFiscal55Window(x);assert.equal(p.enable_policy.valid_until,x.preflight.review.valid_until);
});
test('deterministic paired policy rows55v6/v7 keep full-tax false and65/query untouched',()=>{
 const x=input(),before=JSON.stringify(x),p=finalizeFiscal55Window(x);assert.equal(JSON.stringify(x),before);
 assert.equal(p.enable_policy.version,6);assert.equal(p.disable_policy.version,7);assert.equal(p.enable_policy.enabled,true);assert.equal(p.disable_policy.enabled,false);
 assert.equal(p.enable_policy.valid_from,x.approvedAt);assert.equal(Date.parse(p.enable_policy.valid_until)-Date.parse(p.enable_policy.valid_from),1200000);
 assert.equal(p.enable_policy.tax_rules_reviewed,false);assert.deepEqual(p.baseline.authorization_policy_heads,x.draft.baseline.authorization_policy_heads);
 assert.deepEqual(p,finalizeFiscal55Window(input()));
});
test('unknown keys, accessors, altered finalized plans and prototype input rejected',async()=>{
 const x=input();Object.defineProperty(x,'extra',{get(){throw Error('GETTER_RAN');},enumerable:true});assert.throws(()=>finalizeFiscal55Window(x),/INPUT_ACCESSOR/);
 assert.throws(()=>finalizeFiscal55Window({...input(),confirmed:true}),/PLAN_OPTIONS/);
 const p=finalizeFiscal55Window(input());p.enable_policy.version=8;await assert.rejects(prepareFiscal55WindowSql(p),/PLAN_CHANGED/);
});
test('enable guards fresh full inventory, pre/post preflight and only one policy insert',async()=>{
 const sql=await prepareFiscal55WindowSql(finalizeFiscal55Window(input()));
 assert.match(sql,/pg_try_advisory_xact_lock\(174852920,1\)/);assert.match(sql,/SHARE ROW EXCLUSIVE MODE NOWAIT/);
 assert.match(sql,/cardinality\(names\)<164/);assert.match(sql,/window_inventory_changed/);assert.match(sql,/window_preflight_changed/);assert.match(sql,/window_post_append_preflight_changed/);
 assert.equal((sql.match(/INSERT INTO erp_fiscal_authorization.policy/g)||[]).length,1);
 assert.doesNotMatch(sql,/INSERT INTO erp_fiscal_receipt_query|UPDATE erp_|DELETE FROM erp_|TRUNCATE|GRANT /);
 assert.match(sql,/window_preservation_failed/);assert.match(sql,/pg_default_acl/);assert.match(sql,/to_jsonb\(p\),'definition',pg_get_functiondef/);
 assert.match(sql,/WHERE NOT\(model=''55'' AND version=6\)/);
 assert.equal(sql.includes('__TARGET_ORDER_ID__'),false);
});
test('disable has no live eligibility/clock/RPC prerequisite and retains exact enabled row CAS',async()=>{
 const sql=await prepareFiscal55WindowSql(finalizeFiscal55Window(input()),'disable');
 // The embedded approved plan is data; inspect statements after its declaration.
 const body=sql.slice(sql.indexOf('BEGIN\n IF NOT pg_try_advisory'));
 assert.doesNotMatch(body,/public\.erp_fiscal_reviewed_authorization_preflight|window_proof_expired|clock_timestamp\(\)|window_inventory_changed/);
 assert.match(body,/to_jsonb\(h\)-'created_at'/);assert.match(body,/window_policy_head_changed/);
 assert.match(body,/WHERE NOT\(model=''55'' AND version=7\)/);assert.match(body,/window_preservation_failed/);
});
test('ACK-lost readbacks compare full deterministic policy, no replay or preservation invention',()=>{
 for(const mode of['enable','disable']){
  const sql=prepareFiscal55WindowReadback(finalizeFiscal55Window(input()),mode);
  assert.match(sql,/REPEATABLE READ READ ONLY/);assert.match(sql,/expected_policy_matches/);
  assert.match(sql,/'historical_preservation_proven_by_this_read',false/);
  assert.doesNotMatch(sql,/INSERT |UPDATE |DELETE |DO \$|erp_fiscal_authorization_begin/);
 }
});
test('parameterized private preflight is one bounded readonly RPC with ROLLBACK',()=>{
 const args={actor:id(1),candidateId:id(2),signedHash:h('signed')},sql=prepareFiscal55PreflightRead(args);
 assert.match(sql,/REPEATABLE READ READ ONLY/);assert.match(sql,/timezone='UTC'/);assert.match(sql,/statement_timeout='20s'/);
 assert.equal((sql.match(/public\.erp_fiscal_reviewed_authorization_preflight\(/g)||[]).length,1);
 assert.match(sql,/'observed_at',statement_timestamp\(\)/);assert.match(sql,/ROLLBACK;\n$/);
 assert.doesNotMatch(sql,/INSERT |UPDATE |DELETE |COMMIT|DO \$/);
 for(const bad of[{...args,actor:"';DROP TABLE x;--"},{...args,signedHash:'x'},{...args,confirmed:true}])assert.throws(()=>prepareFiscal55PreflightRead(bad));
 const getter={...args};Object.defineProperty(getter,'actor',{get(){throw Error('GETTER_RAN');},enumerable:true});assert.throws(()=>prepareFiscal55PreflightRead(getter),/INPUT_ACCESSOR/);
});
test('draft artifact0600 is exclusive and symlink-safe; no mutation or IDs generated',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fiscal55-window-'));try{
  const path=join(dir,'draft.json'),result=await writeFiscal55WindowDraft(pending(),path);
  assert.equal(result.sql_generated,false);assert.equal(result.uuid_generated,false);assert.equal((await stat(path)).mode&0o777,0o600);
  assert.equal(result.sha256,h(await readFile(path)));await assert.rejects(writeFiscal55WindowDraft(pending(),path),/EEXIST/);
  await symlink(path,join(dir,'alias.json'));await assert.rejects(writeFiscal55WindowDraft(pending(),join(dir,'alias.json')),/EEXIST/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('a complete synthetic plan generates matching private enable/disable/readback bundle',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fiscal55-bundle-'));try{
  const plan=finalizeFiscal55Window(input()),prefix=join(dir,'window'),before=JSON.stringify(plan);
  const result=await writeFiscal55WindowBundle(plan,prefix);assert.equal(JSON.stringify(plan),before);
  assert.equal(result.database_executed,false);assert.equal(result.network_used,false);assert.equal(result.uuid_generated,false);
  assert.equal(result.files.length,5);
  for(const f of result.files){assert.equal(h(await readFile(f.path)),f.sha256);assert.equal((await stat(f.path)).mode&0o777,0o600);}
  assert.equal(await readFile(prefix+'-enable.sql','utf8'),await prepareFiscal55WindowSql(plan));
  assert.equal(await readFile(prefix+'-disable.sql','utf8'),await prepareFiscal55WindowSql(plan,'disable'));
  await assert.rejects(writeFiscal55WindowBundle(plan,prefix),/EEXIST/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
