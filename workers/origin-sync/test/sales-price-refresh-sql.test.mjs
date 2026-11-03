import {before,after,test}from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{OriginClient}from'../src/client.mjs';import{refreshSalesPrices}from'../src/sales-price-refresh.mjs';
import{salesRefreshFixture}from'./helpers/sales-price-refresh-fixture.mjs';
let f;const err=c=>e=>e.code===c;let serial=8500000;const sale=async(edit=()=>{},capture=false)=>f.sale(String(++serial),edit,capture);
before(async()=>{f=await salesRefreshFixture();});after(()=>f?.close());
test('085 adds only private queue and service RPCs; old rows and functions intact',async()=>{
 const now=await f.fingerprint();delete now['origin_sync.resource_state'];const before={...f.beforeRows};delete before['origin_sync.resource_state'];assert.deepEqual(now,before);
 const originalOids=f.beforeFunctions.map(p=>p.oid);assert.deepEqual(await f.scalar('select jsonb_agg(to_jsonb(p)order by oid)v from pg_proc p where oid=any($1::oid[])',[originalOids]),f.beforeFunctions);
 for(const role of['anon','authenticated','service_role']){
  assert.equal(await f.scalar("select has_function_privilege($1,'public.origin_sync_sales_price_status()','EXECUTE')v",[role]),role==='service_role');
  assert.equal(await f.scalar("select has_table_privilege($1,'origin_sales_price_refresh.attempt','SELECT')v",[role]),false);
  assert.equal(await f.scalar("select has_function_privilege($1,'origin_sales_price_refresh.require_leases(uuid,uuid,uuid)','EXECUTE')v",[role]),false);
 }
 assert.equal(await f.scalar("select count(*)::int v from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where p.proname like 'origin_sync_sales_price_%'and a.is_grantable"),0);
 assert.equal(await f.scalar("select count(*)::int v from pg_class c where c.relnamespace='origin_sales_price_refresh'::regnamespace and c.relkind='r'and c.relrowsecurity"),3);
});
test('candidates exclude every historical source, bound capture including zero tokens, malformed IDs and other entities',async()=>{
 const pending=await sale(),history=await sale(),bound=await sale(),empty=await sale(p=>{p.itens=[];},true);await f.capture(history);await f.recapture(bound);
 await f.stage('08501',{id:'08501'});await f.stage('8501000',{id:'different'});
 const r=await f.call('candidates',{p_limit:40}),ids=r.items.map(x=>x.source_id);assert.ok(ids.includes(pending));for(const id of[history,bound,empty,'08501','8501000'])assert.ok(!ids.includes(id));
 for(const n of[0,41,null])await assert.rejects(f.call('candidates',{p_limit:n}),err('22023'));
});
test('exact price token changes only staging; links/date/cursor/native/history preserved and receipt durable',async()=>{
 const id=await sale(),beforeHistory=await f.historical();await f.db.query("update origin_sync.raw_record set document_links='[{\"type\":\"backup\",\"path\":\"synthetic\"}]',source_updated_at='2026-10-01'where entity='sales_orders'and source_id=$1",[id]);
 // Restore the normal005 content hash for this synthetic linked source.
 await f.db.query("update origin_sync.raw_record set version_hash=encode(sha256(convert_to(jsonb_build_object('payload',payload,'document_links',document_links)::text,'UTF8')),'hex')where entity='sales_orders'and source_id=$1",[id]);
 const native=await f.fingerprint(),raw=await f.raw(id),cp=await f.cp(),job=await f.begin(id),body=await f.detail(id),ack=await f.finish(job,body);assert.equal(ack.stored,true);assert.equal(ack.sales_price_captures,1);assert.equal(ack.inserted,0);
 const post=await f.raw(id);assert.deepEqual(post.document_links,raw.document_links);assert.equal(post.source_updated_at,raw.source_updated_at);assert.equal(await f.scalar("select payload#>>'{itens,0,valor}'v from origin_sync.raw_record where entity='sales_orders'and source_id=$1",[id]),'99999999.1234567891');assert.equal(post.price_capture.profile,'origin-sales-price-json-v1');
 assert.deepEqual((await f.cp()).checkpoint,cp.checkpoint);assert.equal(BigInt((await f.cp()).version),BigInt(cp.version)+1n);assert.deepEqual(await f.historical(),beforeHistory);
 const after=await f.fingerprint();for(const key of Object.keys(native).filter(k=>!k.startsWith('origin_sync.')))assert.deepEqual(after[key],native[key],key);
 assert.deepEqual(await f.finish(job,body),{...ack,replayed:true});assert.equal((await f.call('attempt',{p_attempt_id:job.args.p_attempt_id},job.identity)).state,'stored');
 await assert.rejects(f.finish(job,await f.detail(id,'1')),err('40001'));
 await assert.rejects(f.db.query("update origin_sales_price_refresh.attempt set response_hash='f'where id=$1",[job.args.p_attempt_id]),err('55000'));
});
test('historical capture after begin causes conflict, without overwriting raw, history or checkpoint',async()=>{
 const id=await sale(),job=await f.begin(id);await f.capture(id);const raw=await f.raw(id),history=await f.historical(),cp=await f.cp();const ack=await f.finish(job);assert.equal(ack.conflict,true);assert.deepEqual(await f.raw(id),raw);assert.deepEqual(await f.historical(),history);assert.deepEqual(await f.cp(),cp);assert.equal(await f.scalar('select count(*)::int v from origin_sync.batch_inbox where batch_id=$1',[job.args.p_attempt_id]),0);
});
test('raw hash/version, last_seen and checkpoint CAS each cause a durable conflict',async()=>{
 for(const change of['hash','seen','checkpoint']){
  const id=await sale(),job=await f.begin(id);if(change==='hash')await f.db.query("update origin_sync.raw_record set version=version+1,version_hash=repeat('f',64)where entity='sales_orders'and source_id=$1",[id]);
  if(change==='seen')await f.db.query("update origin_sync.raw_record set last_seen_at=last_seen_at+interval '1 second'where entity='sales_orders'and source_id=$1",[id]);
  if(change==='checkpoint')await f.db.exec("update origin_sync.resource_state set checkpoint_version=checkpoint_version+1 where resource='sales_orders'");
  const raw=await f.raw(id),cp=await f.cp();assert.equal((await f.finish(job)).conflict,true);assert.deepEqual(await f.raw(id),raw);assert.deepEqual(await f.cp(),cp);
 }
});
test('same begin is idempotent, altered command refused and malformed response never writes',async()=>{
 const id=await sale(),job=await f.begin(id),raw=await f.raw(id),cp=await f.cp();assert.equal((await f.call('begin',job.args)).replayed,true);await assert.rejects(f.call('begin',{...job.args,p_source_version:2}),err('40001'));
 const body=await f.detail(id);for(const b of[{...body,p_payload:{id:'123'}},{...body,p_price_capture:{...body.p_price_capture,profile:'origin-purchase-price-json-v1'}},{...body,p_price_capture:{...body.p_price_capture,tokens:[]}}])await assert.rejects(f.finish(job,b),err('22023'));
 assert.deepEqual(await f.raw(id),raw);assert.deepEqual(await f.cp(),cp);await f.call('fail',{p_attempt_id:job.args.p_attempt_id,p_code:'SYNTHETIC_ERROR',p_http_status:500});
});
test('404 backs off one source,403 backs off scope; repeated failures cannot rewrite a terminal attempt',async()=>{
 const first=await sale(),j=await f.begin(first),a={p_attempt_id:j.args.p_attempt_id,p_code:'ORIGIN_NOT_FOUND',p_http_status:404};await f.call('fail',a);assert.equal((await f.call('fail',a)).recorded,true);await assert.rejects(f.call('fail',{...a,p_code:'CHANGED'}),err('40001'));assert.ok(!(await f.call('candidates')).items.some(x=>x.source_id===first));
 assert.ok(await f.scalar("select next_attempt_at>clock_timestamp()+interval '23 hours'v from origin_sales_price_refresh.origin where source_id=$1",[first]));
 const second=await sale(),k=await f.begin(second);await f.call('fail',{p_attempt_id:k.args.p_attempt_id,p_code:'ORIGIN_FORBIDDEN',p_http_status:403});assert.equal((await f.call('candidates')).items.length,0);const s=await f.rpc('origin_sync_sales_price_status',{});assert.equal(s.native_effects,false);assert.equal(s.historical_writes,false);assert.equal(s.coverage_complete,false);assert.ok(s.retry_after);await f.db.exec('update origin_sales_price_refresh.scope_state set retry_after=null');
});
test('lease expiry before and during finish rolls back raw, queue, checkpoint and receipt together',async()=>{
 const id=await sale(),job=await f.begin(id),raw=await f.raw(id),cp=await f.cp();await f.db.exec("create function origin_sync.synthetic_expire085()returns trigger language plpgsql as $$begin update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second'where resource='__scheduler__';return new;end;$$;create trigger synthetic_expire085 after update of price_capture on origin_sync.raw_record for each row execute function origin_sync.synthetic_expire085()");
 try{await assert.rejects(f.finish(job),err('55000'));assert.deepEqual(await f.raw(id),raw);assert.deepEqual(await f.cp(),cp);assert.equal((await f.call('attempt',{p_attempt_id:job.args.p_attempt_id})).state,'pending');}finally{await f.db.exec('drop trigger synthetic_expire085 on origin_sync.raw_record;drop function origin_sync.synthetic_expire085()');}
 await f.db.exec("update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second'where resource in('__scheduler__','sales_orders')");await assert.rejects(f.finish(job),err('55000'));await f.acquire();await f.db.query("update origin_sales_price_refresh.origin set next_attempt_at=clock_timestamp()-interval '1 second'where source_id=$1",[id]);const next=await f.begin(id);assert.equal((await f.call('attempt',{p_attempt_id:job.args.p_attempt_id},job.identity)).state,'superseded');assert.equal((await f.finish(next)).stored,true);
});
test('committed receipt remains recoverable after fences change and new history is captured',async()=>{
 const id=await sale(),job=await f.begin(id),body=await f.detail(id),ack=await f.finish(job,body);await f.capture(id);await f.db.exec("update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second'where resource in('__scheduler__','sales_orders')");await f.acquire(randomUUID());const history=await f.historical(),raw=await f.raw(id);assert.equal((await f.call('attempt',{p_attempt_id:job.args.p_attempt_id},job.identity)).state,'stored');assert.deepEqual(await f.finish(job,body),{...ack,replayed:true});assert.deepEqual(await f.historical(),history);assert.deepEqual(await f.raw(id),raw);await assert.rejects(f.call('attempt',{p_attempt_id:job.args.p_attempt_id}),err('55000'));
});
test('valid capture outside081display size is not retried everycycle orcalledcomplete',async()=>{
 const id=await sale(),job=await f.begin(id),body=await f.detail(id,'1',`,"descricao":"${'x'.repeat(524300)}"`);assert.equal((await f.finish(job,body)).stored,true);assert.equal(await f.scalar("select erp_cutover.sales_capture(r)->>'state'v from origin_sync.raw_record r where entity='sales_orders'and source_id=$1",[id]),'unbound');assert.ok(!(await f.call('candidates')).items.some(x=>x.source_id===id));assert.ok(await f.scalar("select next_attempt_at>clock_timestamp()+interval '23 hours'v from origin_sales_price_refresh.origin where source_id=$1",[id]));
});
test('real collector and Client traverse085RPC→078 with exact numeric token,excludedhistory andunchangedcursor',async()=>{
 const id=await sale(),history=await f.historical(),cp=await f.cp(),urls=[];const client=new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',salesPriceCaptureEnabled:true,intervalMs:0,fetchImpl:async url=>{urls.push(url);return new Response(`{"data":{"id":"${url.split('/').at(-1)}","itens":[{"valor":1.2345678912}]}}`);}});
 const repo={rpc:(name,args)=>f.rpc(name,args)};const r=await refreshSalesPrices(repo,client,{owner:f.identity.p_owner,lease:{lease_token:f.identity.p_lease_token},deadline:Date.now()+160000,enabled:true,salesPriceCaptureEnabled:true});assert.ok(r.stored>=1);assert.equal(r.stop_json,false);assert.ok(urls.some(x=>x.endsWith('/'+id)));assert.equal(await f.scalar("select payload#>>'{itens,0,valor}'v from origin_sync.raw_record where entity='sales_orders'and source_id=$1",[id]),'1.2345678912');assert.deepEqual(await f.historical(),history);assert.deepEqual((await f.cp()).checkpoint,cp.checkpoint);assert.equal(BigInt((await f.cp()).version),BigInt(cp.version)+BigInt(r.stored));for(const h of history.snapshots)assert.ok(!urls.some(x=>x.endsWith('/'+h.source_id)));
});
