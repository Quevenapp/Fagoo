import test,{before,after}from'node:test';
import assert from'node:assert/strict';
import{randomUUID}from'node:crypto';
import{readFile,readdir}from'node:fs/promises';
import{historyFixture}from'../../workers/erp-api/test/helpers/sales-history-fixture.mjs';
let f,owner,token,oldFunctions,oldTables,oldRows,oldHistory,oldSecurity;let serial=930000;
const migrations=new URL('../../supabase/migrations/',import.meta.url);
const next=()=>String(++serial),error=code=>e=>e.code===code;
const user=()=>({p_user_id:f.users.admin});
const fence=()=>({...user(),p_owner:owner,p_scheduler_token:token});
const prepare=(patch={})=>f.rpc('erp_origin_sales_history_continuation_prepare',{...fence(),p_batch_id:randomUUID(),p_after:null,p_limit:25,...patch});
const apply=(p,patch={})=>f.rpc('erp_origin_sales_history_continuation_apply',{...fence(),p_batch_id:p.batch_id,p_prepare_hash:p.prepare_hash,...patch});
const get=id=>f.rpc('erp_origin_sales_history_continuation_get',{...user(),p_batch_id:id??null});
const inventory=(patch={})=>f.rpc('erp_origin_sales_history_continuation_inventory',{...user(),...patch});
const security=()=>f.scalar("select jsonb_build_object('relations',(select jsonb_agg(to_jsonb(c)order by c.oid)from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname<>'erp_sales_history_continuation'and(n.nspname~'^(erp|origin)_'or n.nspname in('public','auth','storage'))),'schemas',(select jsonb_agg(to_jsonb(n)order by n.oid)from pg_namespace n where n.nspname<>'erp_sales_history_continuation'and(n.nspname~'^(erp|origin)_'or n.nspname in('public','auth','storage'))),'policies',(select jsonb_agg(to_jsonb(p)order by oid)from pg_policy p),'defaults',(select jsonb_agg(to_jsonb(d)order by oid)from pg_default_acl d where defaclnamespace<>coalesce(to_regnamespace('erp_sales_history_continuation'),0)))v");
const history=()=>f.scalar("select jsonb_build_object('snapshots',(select coalesce(jsonb_agg(to_jsonb(s)order by source_id),'[]')from erp_sales_history.snapshot s),'commands',(select coalesce(jsonb_agg(to_jsonb(c)order by command_id),'[]')from erp_sales_history.command c))v");
async function rows(tables){const out={};for(const t of tables)out[t]=await f.scalar(`select coalesce(jsonb_agg(to_jsonb(x)order by to_jsonb(x)::text),'[]')v from ${t} x`);return out;}
async function expire(p){await f.db.exec('alter table erp_sales_history_continuation.prepared disable trigger immutable_prepared');try{
 await f.db.query("update erp_sales_history_continuation.prepared set prepared_at=prepared_at-interval'11 minutes',expires_at=expires_at-interval'11 minutes'where batch_id=$1",[p.batch_id]);
}finally{await f.db.exec('alter table erp_sales_history_continuation.prepared enable trigger immutable_prepared');}}
before(async()=>{
 f=await historyFixture();
 for(const name of(await readdir(migrations)).filter(n=>/^202610(?:16|17)00(?:82|8[4-9]|9[0-2])_/.test(n)).sort())await f.db.exec(await readFile(new URL(name,migrations),'utf8'));
 await f.sale(next());await f.capture(String(serial));
 owner=randomUUID();const lease=await f.rpc('origin_sync_claim',{p_resource:'__scheduler__',p_owner:owner,p_ttl_seconds:600});token=lease.lease_token;
 oldHistory=await history();
 oldFunctions=await f.scalar("select jsonb_agg(to_jsonb(p)order by p.oid)v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname like 'erp_%'or n.nspname like 'origin_%'or n.nspname='public'");
 oldTables=(await f.db.query("select format('%I.%I',n.nspname,c.relname) t from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r'and(n.nspname~'^(erp|origin)_'or n.nspname in('auth','storage'))order by 1")).rows.map(r=>r.t);oldRows=await rows(oldTables);oldSecurity=await security();
 await f.db.exec(await readFile(new URL('202610170093_origin_sales_history_continuation.sql',migrations),'utf8'));
});
after(()=>f?.close());
test('093 installs without changing any baseline001–092 row or routine',async()=>{
 assert.equal(oldTables.length,167);assert.deepEqual(await rows(oldTables),oldRows);assert.deepEqual(await security(),oldSecurity);
 assert.deepEqual(await f.scalar('select jsonb_agg(to_jsonb(p)order by oid)v from pg_proc p where oid=any($1::oid[])',[oldFunctions.map(p=>p.oid)]),oldFunctions);
 for(const role of['anon','authenticated','service_role']){
  assert.equal(await f.scalar("select has_function_privilege($1,'public.erp_origin_sales_history_continuation_get(uuid,uuid)','EXECUTE')v",[role]),role==='service_role');
  assert.equal(await f.scalar("select has_schema_privilege($1,'erp_sales_history_continuation','USAGE')v",[role]),false);
  assert.equal(await f.scalar("select has_table_privilege($1,'erp_sales_history_continuation.prepared','SELECT')v",[role]),false);
 }
});
test('durable prepare freezes UUIDs; GET and same request recover exactly; another prepare returns pending',async()=>{
 const id=await f.sale(next()),batch=randomUUID(),p=await prepare({p_batch_id:batch});assert.equal(p.status,'prepared');assert.equal(p.proof.items.length,1);assert.equal(p.proof.items[0].source_id,id);
 assert.deepEqual((await get()).batch,p);assert.deepEqual(await prepare({p_batch_id:batch}),p);
 const unknown=randomUUID(),other=await prepare({p_batch_id:unknown});assert.equal(other.status,'pending_existing');assert.equal(other.batch_id,batch);assert.equal((await get(unknown)).batch,null);
 await assert.rejects(prepare({p_batch_id:batch,p_limit:1}),error('40001'));
 const result=await apply(p);assert.equal(result.status,'applied');assert.equal(result.terminal.result.captured_count,1);assert.equal(result.terminal.result.receipts[0].command_id,p.proof.items[0].command_id);
 assert.deepEqual(await apply(p),result);assert.deepEqual((await get(batch)).batch,result);assert.equal((await get()).batch,null);
});
test('unchanged invalid residual is skipped, a bound recapture reopens it, and noncanonical IDs remain pageable',async()=>{
 const id=await f.sale(next(),()=>{},false);await f.stage('bad-id',{id:'bad-id'});
 const p=await prepare();assert.equal(p.status,'empty');assert.equal(p.proof.residuals.length,2);
 const second=await prepare();assert.equal(second.status,'empty');assert.equal(second.proof.scanned,0);
 const inv=await inventory();assert.equal(inv.cached_invalid,2);assert.equal(inv.missing,2);
 await f.recapture(id);const changed=await prepare();assert.deepEqual(changed.proof.items.map(x=>x.source_id),[id]);await apply(changed);
 const after=await prepare({p_after:'bad-id'});assert.equal(after.status,'empty');assert.equal(after.proof.reached_end_of_pass,true);
});
test('source/capture changes reject durably before any083 writes and then permit a fresh batch',async()=>{
 for(const mode of['seen','capture','version','payload']){
  const id=await f.sale(next()),p=await prepare(),before=await history();
  if(mode==='capture')await f.recapture(id);
  else await f.db.query(`update origin_sync.raw_record set ${mode==='seen'?"last_seen_at=last_seen_at+interval'1 microsecond'":mode==='version'?'version=version+1':"payload=payload||'{\"changed\":true}'"} where source_id=$1 and entity='sales_orders'`,[id]);
  const r=await apply(p);assert.equal(r.status,'rejected');assert.equal(r.terminal.result.reason,'source_changed');assert.deepEqual(await history(),before);assert.deepEqual(await apply(p),r);
  // Changed invalid versions are classified once; repairing payload/hash/capture makes the next batch eligible.
  await f.db.query("update origin_sync.raw_record set version_hash=encode(sha256(convert_to(jsonb_build_object('payload',payload,'document_links',document_links)::text,'UTF8')),'hex')where entity='sales_orders'and source_id=$1",[id]);await f.recapture(id);
  const fresh=await prepare();assert.equal(fresh.proof.items[0].source_id,id);assert.equal((await apply(fresh)).status,'applied');
 }
});
test('expired prepared batch is terminal rejected with no history effects',async()=>{
 await f.sale(next());const p=await prepare(),before=await history();await expire(p);
 const r=await apply(p);assert.equal(r.status,'rejected');assert.equal(r.terminal.result.reason,'prepared_expired');assert.deepEqual(await history(),before);await apply(await prepare());
});
test('live fences/admin required for mutation; committed replay and GET survive lease expiry',async()=>{
 await f.sale(next());const p=await prepare(),before=await history();
 await assert.rejects(apply(p,{p_scheduler_token:randomUUID()}),error('55000'));await assert.rejects(apply(p,{p_user_id:f.users.vendas}),error('42501'));
 await assert.rejects(apply(p,{p_user_id:f.users.other}),error('40001'));await assert.rejects(apply(p,{p_prepare_hash:'f'.repeat(64)}),error('40001'));assert.deepEqual(await history(),before);
 const done=await apply(p);await f.db.exec("update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval'1 second'where resource='__scheduler__'");
 assert.deepEqual(await apply(p),done);assert.deepEqual((await get(p.batch_id)).batch,done);await assert.rejects(prepare(),error('55000'));
 const lease=await f.rpc('origin_sync_claim',{p_resource:'__scheduler__',p_owner:owner,p_ttl_seconds:600});token=lease.lease_token;
});
test('100 invalid scan advances an empty pass; newer lower IDs require an explicit restart',async()=>{
 for(let i=0;i<101;i++)await f.sale(next(),()=>{},false);
 const p=await prepare();assert.equal(p.status,'empty');assert.equal(p.proof.scanned,100);assert.equal(p.proof.reached_end_of_pass,false);
 const tail=await prepare({p_after:p.proof.next_after});assert.equal(tail.status,'empty');assert.equal(tail.proof.scanned,1);assert.equal(tail.proof.reached_end_of_pass,true);
 await f.sale('12');const skipped=await prepare({p_after:tail.proof.next_after});assert.equal(skipped.proof.items.length,0);assert.equal(skipped.proof.coverage_certified,false);
 const restart=await prepare();assert.equal(restart.proof.items[0].source_id,'12');await apply(restart);
});
test('25 cap uses distinct frozen commands and exact receipts',async()=>{
 for(let i=0;i<26;i++)await f.sale(next());const p=await prepare();assert.equal(p.proof.items.length,25);assert.equal(new Set(p.proof.items.map(x=>x.command_id)).size,25);
 const before=await history(),done=await apply(p);assert.equal(done.terminal.result.receipts.length,25);
 for(const row of before.snapshots)assert.deepEqual((await history()).snapshots.find(x=>x.source_id===row.source_id),row);
 await apply(await prepare({p_after:p.proof.next_after}));
});
test('late failure rolls back every capture and terminal; retry reuses original UUIDs',async()=>{
 await f.sale(next());await f.sale(next());const p=await prepare(),before=await history();
 await f.db.exec("create function erp_sales_history_continuation.synthetic_fail()returns trigger language plpgsql as $$begin if(select count(*)from erp_sales_history.snapshot where source_id in(select x->>'source_id'from erp_sales_history_continuation.prepared p,jsonb_array_elements(p.proof->'items')x where p.batch_id='"+p.batch_id+"'))=2 then raise exception 'synthetic late failure';end if;return NEW;end$$;create trigger synthetic_fail after insert on erp_sales_history.snapshot for each row execute function erp_sales_history_continuation.synthetic_fail();");
 try{await assert.rejects(apply(p),/synthetic late failure/);assert.deepEqual(await history(),before);assert.equal((await get()).batch.status,'prepared');}
 finally{await f.db.exec('drop trigger synthetic_fail on erp_sales_history.snapshot;drop function erp_sales_history_continuation.synthetic_fail();');}
 const done=await apply(p);assert.deepEqual(done.terminal.result.receipts.map(r=>r.command_id).sort(),p.proof.items.map(r=>r.command_id).sort());
});
test('lease expiry inside capture rolls back 083 and terminal together',async()=>{
 await f.sale(next());const p=await prepare(),before=await history();
 await f.db.exec("create function erp_sales_history_continuation.synthetic_expire()returns trigger language plpgsql as $$begin update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval'1 second'where resource='__scheduler__';return NEW;end$$;create trigger synthetic_expire after insert on erp_sales_history.snapshot for each row execute function erp_sales_history_continuation.synthetic_expire();");
 try{await assert.rejects(apply(p),error('55000'));assert.deepEqual(await history(),before);assert.equal((await get()).batch.status,'prepared');}
 finally{await f.db.exec('drop trigger synthetic_expire on erp_sales_history.snapshot;drop function erp_sales_history_continuation.synthetic_expire();');}
 await apply(p);
});
test('append-only protocol and all prior historical/native records remain intact',async()=>{
 await assert.rejects(f.db.exec('update erp_sales_history_continuation.prepared set request_hash=request_hash'),error('55000'));
 await assert.rejects(f.db.exec('delete from erp_sales_history_continuation.terminal'),error('55000'));
 const current=await history();for(const row of oldHistory.snapshots)assert.deepEqual(current.snapshots.find(x=>x.source_id===row.source_id),row);for(const row of oldHistory.commands)assert.deepEqual(current.commands.find(x=>x.command_id===row.command_id),row);
 const protectedTables=oldTables.filter(t=>!['origin_sync.raw_record','origin_sync.resource_state','erp_sales_history.snapshot','erp_sales_history.command'].includes(t));
 assert.deepEqual(await rows(protectedTables),Object.fromEntries(protectedTables.map(t=>[t,oldRows[t]])));
 assert.deepEqual(await f.scalar('select jsonb_agg(to_jsonb(p)order by oid)v from pg_proc p where oid=any($1::oid[])',[oldFunctions.map(p=>p.oid)]),oldFunctions);
});
