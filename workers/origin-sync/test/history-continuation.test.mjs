import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {historyFixture} from '../../erp-api/test/helpers/sales-history-fixture.mjs';
import {continueSalesHistory,historyContinuationPolicy} from '../src/history-continuation.mjs';
let f,owner,lease,oldHistory,protectedRows;let serial=940000;
const next=()=>String(++serial),prefix='erp_origin_sales_history_continuation_';
const history=()=>f.scalar("select jsonb_build_object('snapshots',(select coalesce(jsonb_agg(to_jsonb(s)order by source_id),'[]')from erp_sales_history.snapshot s),'commands',(select coalesce(jsonb_agg(to_jsonb(c)order by command_id),'[]')from erp_sales_history.command c))v");
async function nativeRows(){const out={};for(const {name}of(await f.db.query("select format('%I.%I',n.nspname,c.relname)name from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r'and n.nspname~'^erp_'and n.nspname not in('erp_sales_history','erp_sales_history_continuation')order by 1")).rows)out[name]=await f.scalar(`select coalesce(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text),'[]')v from ${name} t`);return out;}
before(async()=>{
 f=await historyFixture();const dir=new URL('../../../supabase/migrations/',import.meta.url);
 for(const name of(await readdir(dir)).filter(n=>/^202610(?:16|17)00(?:82|8[4-9]|9[0-3])_/.test(n)).sort())await f.db.exec(await readFile(new URL(name,dir),'utf8'));
 await f.sale(next());await f.capture(String(serial));oldHistory=await history();protectedRows=await nativeRows();
 owner=randomUUID();lease=await f.rpc('origin_sync_claim',{p_resource:'__scheduler__',p_owner:owner,p_ttl_seconds:600});
});
after(()=>f?.close());
function ports({lose,mutate,afterCall}={}){
 const calls=[];let lost=false;
 const repo={async rpc(name,args){calls.push({name,args:structuredClone(args)});let result=await f.rpc(name,args);await afterCall?.(name,args,result);
  if(!lost&&lose?.(name,args,result)){lost=true;throw new Error('DATABASE_UNAVAILABLE');}
  return mutate?mutate(name,result):result;
 }};
 const run=(checkpoint,extra={})=>continueSalesHistory(repo,{owner,lease,actor:f.users.admin,checkpoint,deadline:Date.now()+60000,...extra});
 return {run,calls};
}

test('history policy is opt-in with an exact private actor and bounded batch count',()=>{
 assert.equal(historyContinuationPolicy({SALES_HISTORY_CONTINUATION_ACTOR:'invalid'}),null);
 assert.throws(()=>historyContinuationPolicy({SALES_HISTORY_CONTINUATION_ENABLED:'true',SALES_HISTORY_CONTINUATION_ACTOR:'invalid'}),/CONFIG/);
 assert.throws(()=>historyContinuationPolicy({SALES_HISTORY_CONTINUATION_ENABLED:'true',SALES_HISTORY_CONTINUATION_ACTOR:randomUUID(),SALES_HISTORY_CONTINUATION_BATCHES:'5'}),/CONFIG/);
});

test('real093 captures26 sales in25+1 durable batches and validates exact083 receipts',async()=>{
 for(let i=0;i<26;i++)await f.sale(next());const io=ports(),done=await io.run();
 assert.deepEqual(done.result.errors,[]);assert.equal(done.result.captured,26);assert.equal(done.result.batches,2);
 assert.equal(done.checkpoint.pending,null);assert.equal(done.checkpoint.after,null);assert.equal(done.checkpoint.passes,1);
 assert.equal(done.result.coverage_complete,false);assert.doesNotMatch(JSON.stringify(done.result),/source_id|command_id|actor|batch_id|940/);
 assert.deepEqual(io.calls.filter(c=>c.name===prefix+'prepare').map(c=>c.args.p_limit),[25,25]);
});

test('unknown prepare ACK resumes its durable original UUID before another prepare',async()=>{
 await f.sale(next());const io=ports({lose:name=>name===prefix+'prepare'}),first=await io.run();
 assert.equal(first.result.stop_json,true);assert.equal(first.checkpoint.pending.prepare_hash,null);
 const batch=first.checkpoint.pending.batch_id,second=await io.run(first.checkpoint);
 assert.equal(second.result.captured,1);assert.equal(second.result.recovered,1);
 assert.equal(io.calls.filter(c=>c.name===prefix+'prepare').length,1);
 assert.ok(io.calls.some(c=>c.name===prefix+'apply'&&c.args.p_batch_id===batch));
});

test('unknown apply ACK is recovered through GET without a second capture command',async()=>{
 const id=await f.sale(next()),io=ports({lose:name=>name===prefix+'apply'}),first=await io.run();
 assert.equal(first.result.stop_residual,true);assert.match(first.checkpoint.pending.prepare_hash,/^[a-f0-9]{64}$/);
 const saved=(await history()).snapshots.find(s=>s.source_id===id),second=await io.run(first.checkpoint);
 assert.equal(second.result.captured,1);assert.equal(io.calls.filter(c=>c.name===prefix+'apply').length,1);
 assert.deepEqual((await history()).snapshots.find(s=>s.source_id===id),saved);
});

test('invalid receipt ACK cannot advance the checkpoint and real terminal recovery does not repeat apply',async()=>{
 await f.sale(next());let tampered=false;
 const io=ports({mutate:(name,value)=>{if(name===prefix+'apply'&&!tampered){tampered=true;value=structuredClone(value);value.terminal.result.receipts[0].source.source_version='999';}return value;}});
 const first=await io.run();assert.equal(first.result.stop_json,true);assert.equal(first.result.captured,0);
 assert.equal(first.result.errors[0].code,'HISTORY_RECEIPT_INVALID');assert.ok(first.checkpoint.pending);
 const second=await io.run(first.checkpoint);assert.equal(second.result.captured,1);
 assert.equal(io.calls.filter(c=>c.name===prefix+'apply').length,1);
});

test('source changed after prepare is rejected durably before a fresh batch can replace its UUIDs',async()=>{
 const id=await f.sale(next());let changed=false;
 const io=ports({afterCall:async(name)=>{if(name===prefix+'prepare'&&!changed){changed=true;
  await f.db.query("update origin_sync.raw_record set last_seen_at=last_seen_at+interval'1 microsecond'where entity='sales_orders'and source_id=$1",[id]);}}});
 const first=await io.run();assert.equal(first.result.rejected,1);assert.equal(first.result.captured,0);assert.equal(first.checkpoint.pending,null);
 assert.equal((await history()).snapshots.some(s=>s.source_id===id),false);
 const second=await io.run(first.checkpoint);assert.equal(second.result.captured,1);
 const prepared=io.calls.filter(c=>c.name===prefix+'prepare').map(c=>c.args.p_batch_id);assert.equal(new Set(prepared).size,2);
});

test('loss of the whole scheduler checkpoint cannot duplicate an already committed083 observation',async()=>{
 const id=await f.sale(next()),io=ports({lose:name=>name===prefix+'apply'});await io.run();
 const before=(await history()).snapshots.find(s=>s.source_id===id),second=await io.run(undefined);
 assert.equal(second.result.captured,0);assert.deepEqual((await history()).snapshots.find(s=>s.source_id===id),before);
 assert.equal(io.calls.filter(c=>c.name===prefix+'apply').length,1);
});

test('invalid current sources remain nominal residuals and an exhausted pass never certifies coverage',async()=>{
 await f.sale(next(),()=>{},false);await f.stage('invalid-history-id',{id:'invalid-history-id'});
 const io=ports(),done=await io.run();assert.deepEqual(done.result.errors,[]);assert.equal(done.result.captured,0);
 assert.equal(done.result.residuals,2);assert.equal(done.checkpoint.passes,1);assert.equal(done.result.coverage_complete,false);
 const again=await io.run(done.checkpoint);assert.equal(again.result.residuals,0);assert.equal(again.result.captured,0);
});

test('deadline reserve prevents preparing a batch with insufficient time',async()=>{
 const io=ports(),done=await io.run(undefined,{deadline:Date.now()+5000});
 assert.equal(done.result.status,'skipped_time');assert.equal(io.calls.length,0);assert.equal(done.checkpoint.pending,null);
});

test('all earlier083 observations and every native business table remain unchanged',async()=>{
 const current=await history();for(const row of oldHistory.snapshots)assert.deepEqual(current.snapshots.find(s=>s.source_id===row.source_id),row);
 for(const row of oldHistory.commands)assert.deepEqual(current.commands.find(s=>s.command_id===row.command_id),row);
 assert.deepEqual(await nativeRows(),protectedRows);
});

test('scheduler persists history progress while leaving normal cursors and native records intact',async()=>{
 const {runSync}=await import('../src/sync.mjs');const id=await f.sale(next());
 await f.rpc('origin_sync_release',{p_resource:'__scheduler__',p_owner:owner,p_lease_token:lease.lease_token});
 await f.db.exec("update origin_sync.resource_state set checkpoint='{\"custom\":{\"retained\":true}}'where resource='__scheduler__'");
 const calls=[];
 const repo={rpc:async(name,args)=>{calls.push(name);return f.rpc(name,args);},
  claim(resource,actor,ttl){return this.rpc('origin_sync_claim',{p_resource:resource,p_owner:actor,p_ttl_seconds:ttl});},
  release(resource,actor,token){return this.rpc('origin_sync_release',{p_resource:resource,p_owner:actor,p_lease_token:token});},
  apply(resource,entity,actor,held,records,checkpoint){return this.rpc('origin_sync_apply_batch',{p_resource:resource,p_entity:entity,
   p_owner:actor,p_lease_token:held.lease_token,p_batch_id:randomUUID(),p_records:records,p_checkpoint:checkpoint,p_expected_checkpoint_version:held.checkpoint_version});},
 };
 class Client{constructor(){this.requestsMade=0;this.remainingRequests=120;}}
 const result=await runSync(repo,{ORIGIN_ENABLED: 'true', ORIGIN_API_ORIGIN: 'https://api.provider.example', SYNC_ENABLED: 'true',SYNC_START_DATE:'2024-01-01',SALES_HISTORY_CONTINUATION_ENABLED:'true',
  SALES_HISTORY_CONTINUATION_ACTOR:f.users.admin},{getToken:async()=> 'synthetic-only',Client,resources:[]});
 assert.equal(result.sales_history_continuation.captured,1);assert.equal(result.requests,0);assert.deepEqual(result.errors,[]);
 const checkpoint=await f.scalar("select checkpoint v from origin_sync.resource_state where resource='__scheduler__'");
 assert.deepEqual(checkpoint.custom,{retained:true});assert.equal(checkpoint.sales_history_continuation.captured,1);
 assert.equal(checkpoint.sales_history_continuation.pending,null);assert.equal((await history()).snapshots.filter(s=>s.source_id===id).length,1);
 assert.doesNotMatch(JSON.stringify(result.sales_history_continuation),/source_id|command_id|actor|batch_id/);
 assert.deepEqual(await nativeRows(),protectedRows);
});
