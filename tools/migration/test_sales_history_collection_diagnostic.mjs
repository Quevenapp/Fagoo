import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {salesRefreshFixture} from '../../workers/origin-sync/test/helpers/sales-price-refresh-fixture.mjs';

test('collection diagnostic separates absent, backoff, durable receipt and active fences without exposing or changing sources',async()=>{
 const f=await salesRefreshFixture();
 try{
  const sql=await readFile(new URL('./sales_history_collection_diagnostic.sql',import.meta.url),'utf8');
  const query=async()=>(await f.db.exec(sql)).find(r=>r.rows?.[0]?.report).rows[0].report;
  const empty=await query();assert.equal(empty.sources.total,0);assert.equal(empty.queue.never_attempted,0);assert.deepEqual(empty.recent_attempts.windows,[]);
  const add=async(id,capture=false)=>f.sale(id,p=>{p.contato.nome='PRIVATE_SENTINEL';p.itens[0].valor=88888888.12345678;},capture);
  await add('8500001');await add('8500002');await f.capture('8500002');await add('8500003',true);
  await add('8500004');const failed=await f.begin('8500004');await f.call('fail',{p_attempt_id:failed.args.p_attempt_id,p_code:'PRIVATE_SENTINEL',p_http_status:404});
  await add('8500005');await f.begin('8500005');
  await add('8500006');const stored=await f.begin('8500006');await f.finish(stored);
  await add('8500007');const outside=await f.begin('8500007');await f.finish(outside,await f.detail('8500007','1',`,"descricao":"${'x'.repeat(524300)}"`));
  await f.stage('08500008',{id:'08500008',private:'PRIVATE_SENTINEL'});
  await f.db.query("update origin_sync.resource_state set checkpoint=jsonb_build_object('lastRun',$1::jsonb)where resource='__scheduler__'",[JSON.stringify({status:'partial',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),requests:117,sales_price_refresh:{status:'completed',attempted:40,requests:39,stored:38,conflicts:1,recovered:1,stop_json:false},sales_price_capture:{records:2},errors:[{resource:'fiscal_xml',code:'PRIVATE_SENTINEL'}],private:'PRIVATE_SENTINEL'})]);
  const fingerprint=async()=>({old:await f.fingerprint(),history:await f.historical(),queue:await f.scalar("select jsonb_build_object('origin',(select jsonb_agg(to_jsonb(o)order by source_id)from origin_sales_price_refresh.origin o),'attempt',(select jsonb_agg(to_jsonb(a)order by id)from origin_sales_price_refresh.attempt a),'scope',(select jsonb_agg(to_jsonb(s))from origin_sales_price_refresh.scope_state s))v"),security:await f.security()});
  const before=await fingerprint(),r=await query();assert.deepEqual(await fingerprint(),before);
  assert.equal(r.sources.total,8);assert.equal(r.sources.exact_ids,7);assert.equal(r.sources.invalid_identity,1);assert.equal(r.sources.preserved_current_sources,1);assert.equal(r.sources.pending_bound,2);assert.equal(r.sources.pending_without_bound,4);
  assert.deepEqual(r.sources.pending_capture_counts,{absent:3,unbound:1});assert.equal(r.queue.never_attempted,1);assert.equal(r.queue.attempted,3);assert.equal(r.queue.source_backoff_active,3);assert.equal(r.queue.current_pending_live_fences,1);assert.equal(r.queue.current_pending_stale_fences,0);assert.equal(r.queue.stored_still_not_bound,1);assert.equal(r.queue.candidate_filter_eligible,1);
  assert.deepEqual(r.queue.current_attempt_states,{none:1,failed:1,pending:1,stored:1});assert.ok(r.queue.backoff_reasons.some(x=>x.code==='OTHER_SANITIZED_ERROR'&&x.http_status===404&&x.count===1));assert.ok(r.queue.backoff_reasons.some(x=>x.code==='NO_RECORDED_ERROR'&&x.http_status===null&&x.count===1));assert.equal(r.recent_attempts.total,4);assert.equal(r.recent_attempts.stored_without_matching_receipt,0);assert.equal(r.recent_attempts.windows.reduce((n,x)=>n+x.stored_with_receipt,0),2);
  assert.equal(r.last_persisted_cycle.directed_attempted,40);assert.equal(r.last_persisted_cycle.directed_requests,39);assert.equal(r.last_persisted_cycle.directed_stored,38);assert.equal(r.last_persisted_cycle.normal_sales_captures,2);
  for(const key of['coverage_certified','runtime_configuration_verified','historical_writes','native_effects'])assert.equal(r[key],false);
  assert.doesNotMatch(JSON.stringify(r),/PRIVATE_SENTINEL|88888888|850000[1-8]|lease_token|payload|source_hash/);
  await f.db.exec("update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval'1 second'where resource in('__scheduler__','sales_orders');update origin_sales_price_refresh.scope_state set retry_after=clock_timestamp()+interval'1 hour'");
  const stopped=await query();assert.equal(stopped.queue.scope_backoff_active,true);assert.equal(stopped.queue.candidate_filter_eligible,0);assert.equal(stopped.queue.current_pending_live_fences,0);assert.equal(stopped.queue.current_pending_stale_fences,1);assert.equal(stopped.sources.pending_without_bound,4);
 }finally{await f.close();}
});
