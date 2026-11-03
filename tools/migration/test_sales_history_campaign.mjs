import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {historyFixture} from '../../workers/erp-api/test/helpers/sales-history-fixture.mjs';
import {prepareSalesHistoryBatch,prepareSalesHistoryBatchPreview} from './prepare_sales_history_batch.mjs';
import {prepareSalesHistoryCampaignInventory,prepareSalesHistoryBatchHandoff,prepareSalesHistoryBatchFromHandoff} from './prepare_sales_history_campaign.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex'),bytes=v=>new TextEncoder().encode(JSON.stringify(v));

test('083 explicit campaign composes one readonly handoff and keeps every apply bounded and independently guarded',async t=>{
 const f=await historyFixture();try{
  for(const n of ['202610160082_fiscal_draft_status.sql','202610160084_itau_legacy_readiness.sql'])await f.db.exec(await readFile(new URL('../../supabase/migrations/'+n,import.meta.url),'utf8'));
  await f.db.exec("set timezone='UTC'");
  const execute=async(sql,key)=>{try{const rows=(await f.db.exec(sql)).flatMap(x=>x.rows??[]),out=rows.find(x=>Object.hasOwn(x,key));assert.ok(out);return out[key];}catch(e){await f.db.exec('rollback');throw e;}};
  const readHandoff=(b,insideFixtureTransaction=false)=>execute(insideFixtureTransaction?b.sql.replace('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n',''):b.sql,'sales_history_batch_handoff');
  const result=sql=>execute(sql,'sales_history_batch_result');
  const history=()=>f.scalar("select jsonb_build_object('snapshots',(select jsonb_agg(to_jsonb(s)order by history_id)from erp_sales_history.snapshot s),'commands',(select jsonb_agg(to_jsonb(c)order by command_id)from erp_sales_history.command c))v");
  for(let i=101;i<=105;i++){await f.sale(String(i));await f.capture(String(i));}
  for(let i=201;i<=229;i++)await f.sale(String(i),()=>{},i%2===0);
  await f.sale('999',p=>p.id='wrong');await f.db.exec("delete from origin_sync.raw_record where entity='sales_orders'and source_id='105'");
  const initial=await history(),old=await f.fingerprint();
  await t.test('one inventory covers exact pending IDs, invalid input and already preserved origin missing without payloads',async()=>{
   const inv=await execute(prepareSalesHistoryCampaignInventory({actor:f.users.admin}),'sales_history_campaign_inventory');
   assert.equal(inv.api_source_count,34);assert.equal(inv.pending_count,30);assert.equal(inv.pending.length,30);assert.equal(inv.preserved.length,5);assert.equal(inv.preserved.find(x=>x.source_id==='105').source_present,false);
   assert.deepEqual(inv.pending[0],{source_id:'201',source_validation:'valid',capture_state:'absent'});assert.equal(inv.pending.at(-1).source_validation,'invalid');assert.equal(inv.current_capture_counts.unavailable,1);assert.equal(inv.commands_minted,false);assert.equal(inv.captures_performed,0);assert.doesNotMatch(JSON.stringify(inv),/Nome observado|Linha observada|snapshot_hash|contato|unit_price/);assert.deepEqual(await history(),initial);assert.deepEqual(await f.fingerprint(),old);
  });
  await t.test('inventory requires admin and captures input without invoking accessors',async()=>{await assert.rejects(()=>execute(prepareSalesHistoryCampaignInventory({actor:f.users.consulta}),'sales_history_campaign_inventory'),e=>e.code==='42501');let invoked=false;assert.throws(()=>prepareSalesHistoryCampaignInventory({get actor(){invoked=true;return f.users.admin;}}));assert.equal(invoked,false);});
  const ids=Array.from({length:25},(_,i)=>String(201+i)),proof=await execute(await prepareSalesHistoryBatchPreview({actor:f.users.admin,sourceIds:ids}),'sales_history_batch_preview');
  const proofBytes=bytes(proof),commands=ids.map(source_id=>({source_id,command_id:randomUUID()})),input={proofBytes,expectedProofSha256:sha(proofBytes),commands},first=await prepareSalesHistoryBatch(input);
  const previous={...input,preparedAt:first.plan.prepared_at,expectedPlanSha256:first.plan_sha256};
  const handoffArgs={actor:f.users.admin,sourceIds:['226','227'],previous},handoff=await prepareSalesHistoryBatchHandoff(handoffArgs);
  await t.test('an unconfirmed prior batch prevents even the next preview result',async()=>{await assert.rejects(()=>readHandoff(handoff),e=>e.code==='40001'&&e.message.includes('previous_receipts_unconfirmed'));assert.deepEqual(await history(),initial);});
  await t.test('partial old receipt set never unlocks next batch',async()=>{await f.db.exec('begin isolation level repeatable read');await f.capture('201',{p_command_id:commands[0].command_id});await assert.rejects(()=>readHandoff(handoff,true),e=>e.code==='40001'&&e.message.includes('previous_receipts_unconfirmed'));assert.deepEqual(await history(),initial);});
  await t.test('conflicting historical actor on same command also blocks handoff',async()=>{await f.db.exec('begin isolation level repeatable read');await f.capture('201',{p_command_id:commands[0].command_id,p_user_id:f.users.other});await assert.rejects(()=>readHandoff(handoff,true),e=>e.code==='40001'&&e.message.includes('previous_receipts_unconfirmed'));assert.deepEqual(await history(),initial);});
  await t.test('first25 keeps exact prior history and old tables',async()=>{const applied=await result(first.applySql);assert.equal(applied.outcome,'verified');assert.equal(applied.snapshot_count,30);assert.equal(applied.exact_delta,true);assert.equal(applied.old_152_unchanged,true);assert.equal(applied.existing_history_unchanged,true);assert.deepEqual(await f.fingerprint(),old);});
  const h=await readHandoff(handoff),afterFirst=await history(),secondCommands=['226','227'].map(source_id=>({source_id,command_id:randomUUID()}));
  const nextInput=value=>{const handoffBytes=bytes(value);return{handoffBytes,expectedHandoffSha256:sha(handoffBytes),previous,commands:secondCommands};};
  await t.test('one readonly snapshot confirms all prior commands and previews only explicit next IDs',()=>{
   assert.equal(h.previous_result.outcome,'receipts_confirmed');assert.equal(h.previous_result.expected_receipts_confirmed,25);assert.equal(h.previous_result.capture_rpc_calls,0);assert.equal(h.previous_result.old_152_unchanged,null);assert.equal(h.previous_result.before_audit,null);assert.deepEqual(h.next_selection,['226','227']);assert.deepEqual(h.next_preview.audit,h.previous_result.current_audit);assert.equal(h.next_preview.audit.history.snapshots.length,30);assert.deepEqual(h.next_preview.capture_state_counts,{bound:1,absent:1});
  });
  await t.test('old plan expires only for apply; reconstruction for readonly recovery keeps its exact hash',async()=>{const original=Date.now;Date.now=()=>original()+3600000;try{const later=await prepareSalesHistoryBatchHandoff(handoffArgs);assert.equal(later.sql,handoff.sql);assert.equal(later.previous_plan_sha256,first.plan_sha256);}finally{Date.now=original;}});
  await t.test('captures all mutable inputs before the first await',async()=>{const mutable={actor:f.users.admin,sourceIds:['226','227'],previous:{...previous,proofBytes:Uint8Array.from(proofBytes),commands:structuredClone(commands)}};const pending=prepareSalesHistoryBatchHandoff(mutable);mutable.sourceIds[0]='228';mutable.previous.commands[0].command_id=randomUUID();mutable.previous.proofBytes.fill(0);assert.equal((await pending).sql,handoff.sql);});
  await t.test('selection, actor and original plan hash cannot be substituted',async()=>{
   for(const sourceIds of [[],Array.from({length:26},(_,i)=>String(200+i)),['226','226'],['201'],['0001']])await assert.rejects(()=>prepareSalesHistoryBatchHandoff({...handoffArgs,sourceIds}));
   await assert.rejects(()=>prepareSalesHistoryBatchHandoff({...handoffArgs,actor:f.users.other}));await assert.rejects(()=>prepareSalesHistoryBatchHandoff({...handoffArgs,previous:{...previous,expectedPlanSha256:'f'.repeat(64)}}));
  });
  await t.test('SHA-pinned handoff bytes and original plan are mandatory to generate apply',async()=>{
   await assert.rejects(()=>prepareSalesHistoryBatchFromHandoff({...nextInput(h),expectedHandoffSha256:'f'.repeat(64)}));
   await assert.rejects(()=>prepareSalesHistoryBatchFromHandoff({...nextInput(h),previous:{...previous,expectedPlanSha256:'f'.repeat(64)}}));
  });
  for(const [name,edit]of [
   ['not_found',x=>x.previous_result.outcome='not_found'],['partial',x=>x.previous_result.expected_receipts_confirmed=24],['receipt conflict',x=>x.previous_result.receipts[0].state='conflict'],
   ['wrong prior receipt source',x=>x.previous_result.receipts[0].receipt.source.source_id='998'],['wrong prior receipt hash',x=>x.previous_result.receipts[0].receipt.snapshot_hash='f'.repeat(64)],
   ['fabricated old152 equality',x=>x.previous_result.old_152_unchanged=true],['different audit',x=>x.next_preview.audit.metadata_sha256='f'.repeat(64)],['implicit new selection',x=>x.next_selection=['228','229']],
  ])await t.test(`no next apply from ${name}`,async()=>{const value=structuredClone(h);edit(value);await assert.rejects(()=>prepareSalesHistoryBatchFromHandoff(nextInput(value)));assert.deepEqual(await history(),afterFirst);});
  let second;
  await t.test('generated apply is the unchanged bounded generator output with explicit derived-proof provenance',async()=>{second=await prepareSalesHistoryBatchFromHandoff(nextInput(h));const derived=bytes(h.next_preview),base=await prepareSalesHistoryBatch({proofBytes:derived,expectedProofSha256:sha(derived),commands:secondCommands,now:Date.parse(second.plan.prepared_at)});assert.equal(second.applySql,base.applySql);assert.equal(second.recoverySql,base.recoverySql);assert.equal(second.plan_sha256,base.plan_sha256);assert.equal(second.derived_preview.utf8,JSON.stringify(h.next_preview));assert.equal(second.previous_preservation_audit_recovered,false);assert.equal(second.previous_plan_sha256,first.plan_sha256);});
  await t.test('stale next proof stays expired even though the prior receipt is confirmed',async()=>{await assert.rejects(()=>prepareSalesHistoryBatchFromHandoff({...nextInput(h),now:Date.parse(h.next_preview.observed_at)+600001}));});
  await t.test('late change in next source rolls back the full new batch',async()=>{await f.db.exec('begin');await f.recapture('226');await assert.rejects(()=>result(second.applySql),e=>e.code==='40001');assert.deepEqual(await history(),afterFirst);});
  await t.test('revoked admin cannot read combined history or obtain next proof',async()=>{await f.db.exec('begin isolation level repeatable read');await f.db.query("update erp_access.membership set role='consulta'where user_id=$1",[f.users.admin]);await assert.rejects(()=>readHandoff(handoff,true),e=>e.code==='42501');assert.deepEqual(await history(),afterFirst);});
  await t.test('next apply commits exact2 with all30 existing pairs and152 old tables preserved',async()=>{const r=await result(second.applySql);assert.equal(r.outcome,'verified');assert.equal(r.snapshot_count,32);assert.equal(r.before_audit.history.snapshots.length,30);assert.equal(r.exact_delta,true);assert.equal(r.existing_history_unchanged,true);assert.equal(r.old_152_unchanged,true);assert.deepEqual(await f.fingerprint(),old);});
  await t.test('later independent batch and cron do not invalidate old receipt recovery or imply global equality',async()=>{await f.capture('228');await f.db.exec("update origin_sync.raw_record set last_seen_at=last_seen_at+interval '1 second'where entity='sales_orders'and source_id='201'");const next=await prepareSalesHistoryBatchHandoff({...handoffArgs,sourceIds:['229']}),r=await readHandoff(next);assert.equal(r.previous_result.outcome,'receipts_confirmed');assert.equal(r.previous_result.snapshot_count,33);assert.equal(r.previous_result.old_152_unchanged,null);assert.deepEqual(r.previous_result.receipts,h.previous_result.receipts);assert.deepEqual(r.next_selection,['229']);});
  await t.test('captured next source never becomes replacement or a skipped partial batch',async()=>{const already=await readHandoff(handoff);assert.ok(already.next_preview.items[0].preview.existing);await assert.rejects(()=>prepareSalesHistoryBatchFromHandoff(nextInput(already)));});
 }finally{await f.close();}
});
