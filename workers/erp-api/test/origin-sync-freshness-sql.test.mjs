import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{freshnessFixture}from'./helpers/origin-sync-freshness-fixture.mjs';
import{originSyncFreshnessResponse,FRESHNESS_ENTITIES}from'../src/integration-progress.mjs';
import{RESOURCES}from'../../origin-sync/src/resources.mjs';
import{nextWindow,advanceWindow,localTimestamp}from'../../origin-sync/src/sync.mjs';
let f;test.before(async()=>{f=await freshnessFixture();});test.after(async()=>{await f?.close();});
const denied=e=>e.code==='42501';
const entity=(v,name)=>v.entities.find(x=>x.entity===name);
const ms=v=>v===null?null:Date.parse(v);
// SP is UTC-3 with no daylight saving since 2019: '2026-10-19 10:00:00' local = 13:00:00Z.
const sp=(local)=>Date.parse(`${local.replace(' ','T')}-03:00`);
async function windowedPass(resource,lane,{start,end,appliedAt,before={},after={}}){
 const done=`${lane}CompletedAt`,cursor={from:'2026-09-19 10:00:00',to:start,cutoff:start,page:4,private:'PRIVATE_CURSOR'};
 await f.state(resource,{version:1,[done]:end,nextLane:lane==='recent'?'history':'recent',...after});
 await f.batch(resource,{version:1,[lane]:cursor,...before},{version:1,[done]:end,...after},appliedAt??new Date(sp(end)+20000).toISOString());
}
async function sweepPass(resource,{previous,end,cursor=true,appliedAt}){
 await f.state(resource,{version:1,unfilteredCompletedAt:end});
 await f.batch(resource,{version:1,...(previous?{unfilteredCompletedAt:previous}:{}),...(cursor?{unfiltered:{page:7,private:'PRIVATE_CURSOR'}}:{})},{version:1,unfilteredCompletedAt:end},appliedAt??new Date(sp(end)+20000).toISOString());
}

test('101 only an active administrator through service_role reads freshness; helpers and tables stay private',async()=>{
 await f.reset();
 const value=await f.rpc();assert.equal(value.role,'admin');assert.deepEqual(originSyncFreshnessResponse(value),value);
 for(const role of['consulta','vendas','financeiro','estoque','fiscal','inactive'])await assert.rejects(()=>f.rpc(f.users[role]),denied,role);
 for(const actor of[null,randomUUID()])await assert.rejects(()=>f.rpc(actor),denied);
 for(const role of['anon','authenticated'])await assert.rejects(()=>f.asRole(role,()=>f.scalar('select public.erp_origin_sync_freshness($1) v',[f.users.admin])),denied,role);
 await assert.rejects(()=>f.asRole('service_role',()=>f.scalar("select erp_integration.origin_sync_freshness(now()) v")),denied);
 for(const role of['anon','authenticated','service_role']){
  assert.equal(await f.scalar("select has_function_privilege($1,'public.erp_origin_sync_freshness(uuid)','EXECUTE') v",[role]),role==='service_role');
  for(const helper of['erp_integration.origin_sync_freshness(timestamptz)','erp_integration.freshness_local(text)'])assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v",[role,helper]),false);
  for(const table of['origin_sync.raw_record','origin_sync.resource_state','origin_sync.batch_inbox','origin_sync.credentials'])assert.equal(await f.scalar("select has_table_privilege($1,$2,'SELECT') v",[role,table]),false);
 }
 assert.equal(await f.scalar("select provolatile::text v from pg_proc where oid='public.erp_origin_sync_freshness(uuid)'::regprocedure"),'s');
 assert.equal(await f.scalar("select pg_get_indexdef('origin_sync.raw_record_entity_seen_idx'::regclass) v"),'CREATE INDEX raw_record_entity_seen_idx ON origin_sync.raw_record USING btree (entity, last_seen_at)');
});

test('101 empty staging: every collected entity is listed, without records and stale for lack of a completed pass',async()=>{
 await f.reset();const before=await f.fingerprint(),value=await f.at('2026-10-19T13:00:00Z');
 assert.equal(await f.fingerprint(),before);
 assert.deepEqual(value.entities.map(x=>x.entity),FRESHNESS_ENTITIES.map(x=>x[0]));
 assert.deepEqual(value.entities.map(x=>x.lanes.map(l=>[l.resource,l.lane])),FRESHNESS_ENTITIES.map(x=>x[2].map(l=>[...l])));
 assert.deepEqual([...new Set(value.entities.flatMap(x=>x.lanes.map(l=>l.resource)))].sort(),RESOURCES.map(r=>r.id).sort());
 for(const row of value.entities){
  assert.deepEqual([row.records,row.last_changed_at,row.last_seen_at,row.oldest_seen_at,row.freshness_at,row.age_seconds,row.status,row.lanes_measured],[0,null,null,null,null,null,'stale',0],row.entity);
  assert.ok(row.lanes.every(l=>!l.checkpoint_present&&!l.open&&l.completed_started_at===null&&l.completed_finished_at===null));
 }
 assert.deepEqual(value.levels,[{level:'A',target_seconds:600,stale_after_seconds:1800},{level:'B',target_seconds:1800,stale_after_seconds:5400},{level:'C',target_seconds:86400,stale_after_seconds:259200}]);
 assert.deepEqual(value.collector,{oauth_connected:false,oauth_expires_at:null,last_run_status:null,last_run_started_at:null,last_run_finished_at:null,last_run_error_count:null,last_error_code:null,last_error_resource:null});
 assert.deepEqual(originSyncFreshnessResponse(value),value);
});

test('101 counts and staging times come from changed_at and last_seen_at only, never from payloads',async()=>{
 await f.reset();
 await f.raw('contacts','900001',{payload:{nome:'PRIVATE_NAME',cnpj:'PRIVATE_DOCUMENT'},seen:'2026-10-19T12:58:00Z',changed:'2026-10-19T09:00:00Z'});
 await f.raw('contacts','900002',{payload:{url:'https://private.invalid'},seen:'2026-10-18T08:00:00Z',changed:'2026-10-18T08:00:00Z'});
 await f.raw('contacts','900003',{seen:'2026-10-19T11:00:00Z',changed:'2026-10-19T10:30:00.123456Z'});
 await f.raw('stock_balances','900004',{payload:{saldo:99},seen:'2026-10-17T00:00:00Z'});
 const before=await f.fingerprint(),value=await f.at('2026-10-19T13:00:00Z');assert.equal(await f.fingerprint(),before);
 const contacts=entity(value,'contacts');
 assert.equal(contacts.records,3);assert.equal(ms(contacts.last_changed_at),Date.parse('2026-10-19T10:30:00.123Z'));assert.match(contacts.last_changed_at,/\.123456/);
 assert.equal(ms(contacts.last_seen_at),Date.parse('2026-10-19T12:58:00Z'));assert.equal(ms(contacts.oldest_seen_at),Date.parse('2026-10-18T08:00:00Z'));
 // A recent observation is not freshness: without a completed pass the entity stays stale.
 assert.equal(contacts.status,'stale');assert.equal(contacts.freshness_at,null);
 assert.equal(entity(value,'stock_balances').records,1);assert.equal(entity(value,'products').records,0);assert.equal(entity(value,'products').last_seen_at,null);
 assert.doesNotMatch(JSON.stringify(value),/PRIVATE_|private\.invalid|9000\d\d|payload|saldo|cnpj/);
 assert.deepEqual(originSyncFreshnessResponse(value),value);
});

test('101 level A boundaries: 10 min is in time, one microsecond more is attention, 30 min more is stale',async()=>{
 await f.reset();await windowedPass('sales_orders','recent',{start:'2026-10-19 10:00:00',end:'2026-10-19 10:10:00'});
 for(const[asOf,status,age]of[['2026-10-19T13:09:59Z','ok',599],['2026-10-19T13:10:00Z','ok',600],['2026-10-19T13:10:00.000001Z','attention',601],
  ['2026-10-19T13:30:00Z','attention',1800],['2026-10-19T13:30:00.000001Z','stale',1801]]){
  const value=await f.at(asOf),row=entity(value,'sales_orders');
  assert.equal(row.status,status,asOf);assert.equal(row.age_seconds,age,asOf);assert.equal(ms(row.freshness_at),sp('2026-10-19 10:00:00'));
  assert.equal(ms(row.pass_finished_at),sp('2026-10-19 10:10:00'));assert.deepEqual([row.pass_resource,row.pass_lane,row.lanes_measured,row.lanes_total],['sales_orders','recent',1,1]);
  assert.deepEqual(originSyncFreshnessResponse(value),value);
 }
 assert.doesNotMatch(JSON.stringify(await f.at('2026-10-19T13:10:00Z')),/PRIVATE_CURSOR|2026-09-19|"page"/);
});

test('101 level B uses the oldest pass among recent and history lanes, with 30 min and 90 min boundaries',async()=>{
 await f.reset();
 await windowedPass('purchase_orders','recent',{start:'2026-10-19 10:20:00',end:'2026-10-19 10:25:00'});
 // The history pass closed later but started earlier: its start limits the entity.
 await f.state('purchase_orders',{version:1,recentCompletedAt:'2026-10-19 10:25:00',historyCompletedAt:'2026-10-19 10:28:00',recent:{page:1,cutoff:'2026-10-19 10:29:00'}});
 await f.batch('purchase_orders',{version:1,recentCompletedAt:'2026-10-19 10:25:00',history:{from:'2026-10-01 00:00:00',to:'2026-10-19 10:00:00',cutoff:'2026-10-19 10:00:00',page:2}},{version:1,recentCompletedAt:'2026-10-19 10:25:00',historyCompletedAt:'2026-10-19 10:28:00'},'2026-10-19T13:28:15Z');
 for(const[asOf,status]of[['2026-10-19T13:30:00Z','ok'],['2026-10-19T13:30:00.5Z','attention'],['2026-10-19T14:30:00Z','attention'],['2026-10-19T14:30:01Z','stale']]){
  const value=await f.at(asOf),row=entity(value,'purchase_orders');
  assert.equal(row.status,status,asOf);assert.equal(ms(row.freshness_at),sp('2026-10-19 10:00:00'));assert.deepEqual([row.pass_resource,row.pass_lane],['purchase_orders','history']);
  assert.equal(ms(row.pass_finished_at),sp('2026-10-19 10:28:00'));
  const[recent,history]=row.lanes;assert.equal(ms(recent.completed_started_at),sp('2026-10-19 10:20:00'));assert.equal(recent.open,true);assert.equal(history.open,false);
  assert.deepEqual(originSyncFreshnessResponse(value),value);
 }
});

test('101 level C sweeps start at the previous closing; 24 h and 72 h boundaries; single-page and first passes',async()=>{
 await f.reset();
 await sweepPass('ledger_accounts',{previous:'2026-10-18 10:00:00',end:'2026-10-18 10:40:00'});
 for(const[asOf,status]of[['2026-10-19T13:00:00Z','ok'],['2026-10-19T13:00:01Z','attention'],['2026-10-21T13:00:00Z','attention'],['2026-10-21T13:00:00.000001Z','stale']]){
  const row=entity(await f.at(asOf),'ledger_accounts');assert.equal(row.status,status,asOf);assert.equal(ms(row.freshness_at),sp('2026-10-18 10:00:00'));assert.equal(row.pass_lane,'sweep');
 }
 // One page from an empty cursor: the closing page is the whole pass, so start equals end.
 await sweepPass('product_categories',{end:'2026-10-19 09:00:00',cursor:false});
 // First multi-page sweep: no previous closing and no recorded start. Not measured, so stale.
 await sweepPass('financial_categories',{end:'2026-10-19 09:30:00'});
 const value=await f.at('2026-10-19T13:00:00Z'),single=entity(value,'product_categories'),first=entity(value,'financial_categories');
 assert.equal(ms(single.freshness_at),sp('2026-10-19 09:00:00'));assert.equal(single.status,'ok');
 assert.equal(first.lanes_measured,0);assert.equal(first.status,'stale');assert.equal(first.freshness_at,null);
 assert.equal(ms(first.lanes[0].completed_finished_at),sp('2026-10-19 09:30:00'));assert.equal(first.lanes[0].completed_started_at,null);
 assert.deepEqual(originSyncFreshnessResponse(value),value);
});

test('101 an entity is as old as its oldest lane; any lane without a measured pass makes it stale',async()=>{
 await f.reset();
 for(const r of['products_zero','products_positive','products_negative'])await windowedPass(r,'recent',{start:'2026-10-19 12:55:00',end:'2026-10-19 12:58:00'});
 for(const r of['products_deleted_zero','products_deleted_positive'])await sweepPass(r,{previous:'2026-10-19 12:52:00',end:'2026-10-19 12:57:00'});
 // The scheduler and the observation clock look current; they must not stand in for the missing lane.
 await f.state('__scheduler__',{lastRun:{status:'completed',startedAt:'2026-10-19T15:58:00.000Z',finishedAt:'2026-10-19T15:58:50.000Z',errors:[]}});
 await f.raw('products','800001',{seen:'2026-10-19T15:58:59Z'});
 const asOf='2026-10-19T15:59:00Z';
 let value=await f.at(asOf),row=entity(value,'products');
 assert.deepEqual([row.lanes_total,row.lanes_measured,row.status,row.freshness_at,row.pass_resource],[6,5,'stale',null,null]);
 await sweepPass('products_deleted_negative',{previous:'2026-10-19 12:50:00',end:'2026-10-19 12:56:00'});
 value=await f.at(asOf);row=entity(value,'products');
 assert.deepEqual([row.lanes_measured,row.status,row.pass_resource,row.pass_lane,row.age_seconds],[6,'ok','products_deleted_negative','sweep',540]);
 assert.equal(ms(row.freshness_at),sp('2026-10-19 12:50:00'));assert.equal(value.collector.last_run_status,'completed');
 // The same pass one minute older already crosses level A: freshness is not the latest cycle.
 assert.equal(entity(await f.at('2026-10-19T16:00:00.000001Z'),'products').status,'attention');
 assert.deepEqual(originSyncFreshnessResponse(value),value);
});

test('101 doubtful checkpoints are never promoted: outside the batch window, future, inverted, unchanged or invalid',async()=>{
 await f.reset();
 // Closing batch recorded far from the closing time: the start cannot be tied to this pass.
 await windowedPass('contacts','recent',{start:'2026-10-19 09:50:00',end:'2026-10-19 09:55:00',appliedAt:'2026-10-19T17:00:00Z'});
 // Closing time more than five minutes after the query: ignored.
 await windowedPass('sales_orders','recent',{start:'2026-10-19 10:00:00',end:'2026-10-19 10:10:00'});
 // Start after the end of the same pass: inconsistent, so not measured.
 await windowedPass('sellers','recent',{start:'2026-10-19 09:59:00',end:'2026-10-19 09:30:00'});
 // A batch that kept the same closing (failure diagnostic, replay) does not identify a pass;
 // an unreadable frozen cutoff does not either.
 await f.state('nfce',{version:1,recentCompletedAt:'2026-10-19 09:00:00',historyCompletedAt:'2026-10-19 08:00:00'});
 await f.batch('nfce',{version:1,recentCompletedAt:'2026-10-19 09:00:00',recent:{cutoff:'2026-10-19 08:59:00'}},{version:1,recentCompletedAt:'2026-10-19 09:00:00',failure:{code:'X'}},'2026-10-19T12:00:10Z');
 await f.batch('nfce',{version:1,history:{cutoff:'not-a-time'}},{version:1,historyCompletedAt:'2026-10-19 08:00:00'},'2026-10-19T11:00:10Z');
 await f.state('warehouses_active',{version:1,unfilteredCompletedAt:'2026-10-19T12:00:00Z'});
 const value=await f.at('2026-10-19T13:00:00Z');
 assert.equal(entity(value,'contacts').lanes[0].completed_started_at,null);assert.equal(entity(value,'contacts').status,'stale');
 assert.equal(entity(value,'sellers').lanes[0].completed_started_at,null);assert.ok(entity(value,'sellers').lanes[0].completed_finished_at);
 const nfce=entity(value,'nfce');assert.deepEqual(nfce.lanes.map(l=>l.completed_started_at),[null,null]);assert.ok(nfce.lanes.every(l=>l.completed_finished_at));
 assert.equal(entity(value,'warehouses').lanes[0].completed_finished_at,null);assert.equal(entity(value,'warehouses').lanes[0].checkpoint_present,true);
 const future=entity(await f.at('2026-10-19T13:04:59Z'),'sales_orders');assert.equal(future.lanes[0].completed_finished_at,null);assert.equal(future.status,'stale');
 assert.equal(entity(await f.at('2026-10-19T13:05:00Z'),'sales_orders').status,'ok');
 assert.deepEqual(originSyncFreshnessResponse(value),value);
});

test('101 collector state: OAuth presence, last run and a sanitized last error only',async()=>{
 await f.reset();
 await f.db.query("insert into origin_sync.credentials(account_id,ciphertext,expires_at,revision)values(1,'{\"iv\":\"PRIVATE_TOKEN\"}','2026-10-19T19:00:00Z',3)");
 await f.state('__scheduler__',{nextIndex:4,lastRun:{status:'partial',startedAt:'2026-10-19T12:58:00.000Z',finishedAt:'2026-10-19T12:59:30.000Z',
  errors:[{resource:'contacts',code:'ORIGIN_HTTP_500',message:'PRIVATE_MESSAGE'},{resource:'nfe_out',code:'ORIGIN_HTTP_429',source_id:'PRIVATE_ID'}]}});
 let value=await f.at('2026-10-19T13:00:00Z');
 assert.deepEqual(value.collector,{oauth_connected:true,oauth_expires_at:value.collector.oauth_expires_at,last_run_status:'partial',last_run_started_at:value.collector.last_run_started_at,
  last_run_finished_at:value.collector.last_run_finished_at,last_run_error_count:2,last_error_code:'ORIGIN_HTTP_429',last_error_resource:'nfe_out'});
 assert.equal(ms(value.collector.oauth_expires_at),Date.parse('2026-10-19T19:00:00Z'));assert.equal(ms(value.collector.last_run_finished_at),Date.parse('2026-10-19T12:59:30Z'));
 assert.doesNotMatch(JSON.stringify(value),/PRIVATE_|ciphertext|nextIndex/);assert.deepEqual(originSyncFreshnessResponse(value),value);
 await f.state('__scheduler__',{lastRun:{status:'PRIVATE_STATUS',startedAt:'2026-02-30T00:00:00Z',errors:[{code:'https://private.invalid',resource:'Bad Resource'}]}});
 value=await f.at('2026-10-19T13:00:00Z');
 assert.deepEqual([value.collector.last_run_status,value.collector.last_run_started_at,value.collector.last_run_error_count,value.collector.last_error_code,value.collector.last_error_resource],['unknown',null,1,null,null]);
 assert.doesNotMatch(JSON.stringify(value),/PRIVATE_|private\.invalid|Bad Resource/);assert.deepEqual(originSyncFreshnessResponse(value),value);
});

test('101 real collector checkpoints: start is the frozen cutoff of the pass, end the closing page, via the public RPC',async()=>{
 await f.reset();
 const resource=RESOURCES.find(r=>r.id==='sales_orders'),owner=randomUUID(),base=Date.now();
 const svc=(sql,args)=>f.asRole('service_role',()=>f.scalar(sql,args));
 const lease=await svc('select public.origin_sync_claim($1,$2,300) v',['sales_orders',owner]);
 let checkpoint=lease.checkpoint,version=lease.checkpoint_version;const cutoffs=[];
 for(const[count,offset]of[[10,150000],[3,100000],[4,50000]]){
  const cutoff=localTimestamp(new Date(base-offset),'America/Sao_Paulo'),state=nextWindow(resource,checkpoint,cutoff,'2024-01-01'),next=advanceWindow(state,count,cutoff);
  const ack=await svc('select public.origin_sync_apply_batch($1,$2,$3,$4,$5,$6,$7,$8) v',['sales_orders','sales_orders',owner,lease.lease_token,randomUUID(),'[]',JSON.stringify(next),version]);
  checkpoint=next;version=ack.checkpoint_version;cutoffs.push([state.lane,cutoff]);
 }
 await svc('select public.origin_sync_release($1,$2,$3) v',['sales_orders',owner,lease.lease_token]);
 // recent page 1 (full), history page 1 (window moves on), recent page 2 (closes the recent pass).
 assert.deepEqual(cutoffs.map(x=>x[0]),['recent','history','recent']);assert.equal(checkpoint.recentCompletedAt,cutoffs[2][1]);
 const value=await f.rpc(),row=entity(value,'sales_orders');
 assert.equal(ms(row.freshness_at),sp(cutoffs[0][1]));assert.equal(ms(row.pass_finished_at),sp(cutoffs[2][1]));
 assert.equal(row.status,'ok');assert.ok(row.age_seconds>=150&&row.age_seconds<=200,String(row.age_seconds));
 assert.equal(row.lanes[0].open,false);assert.deepEqual(originSyncFreshnessResponse(value),value);
});
