import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {fetchMissingReferences} from '../src/reference-fetch.mjs';
import {OriginClient} from '../src/client.mjs';
import {integrationProgressResponse} from '../../erp-api/src/integration-progress.mjs';
import {parseIntegrationSummary} from '../../../apps/erp/src/lib/integration-progress-model.ts';
let db,scheduler,resource;
const owner=randomUUID(),code=c=>e=>e.code===c;
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
const identity=()=>({p_owner:owner,p_lease_token:scheduler.lease_token,p_resource_token:resource.lease_token});
async function rawRpc(name,args={}){
 const entries=Object.entries(args);await db.exec('set role service_role');
 try{return await scalar(`select public.${name}(${entries.map(([k],i)=>`${k}=>$${i+1}`).join(',')}) value`,entries.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));}
 finally{await db.exec('reset role');}
}
const rpc=(name,args={})=>rawRpc(`origin_sync_reference_${name}`,{...identity(),...args});
const candidates=async()=>(await rpc('candidates')).items;
const begin=c=>rpc('begin',{p_attempt_id:randomUUID(),p_entity:c.entity,p_source_id:c.source_id,p_proposal_id:c.proposal_id,p_proposal_hash:c.proposal_hash,p_proposal_version:c.proposal_version});
const finish=(a,p)=>rpc('finish',{p_attempt_id:a.attempt_id,p_payload:p});
const fail=(a,status=404)=>rpc('fail',{p_attempt_id:a.attempt_id,p_code:`ORIGIN_HTTP_${status}`,p_http_status:status});
const proposal=(id='1',contact='101',products=['201'],status='Rascunho')=>({id,situacao:status,contato:{id:contact},itens:products.map(id=>({produto:{id}}))});
async function seed(entity,id,p){return db.query(`insert into origin_sync.raw_record(entity,last_resource,source_id,payload,document_links,version_hash)
 values($1,'synthetic_reference_seed',$2,$3,'[]',encode(sha256(convert_to(jsonb_build_object('payload',$3::jsonb,'document_links','[]'::jsonb)::text,'UTF8')),'hex'))`,[entity,id,JSON.stringify(p)]);}
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const f of ['202610160001_origin_sync.sql','202610160002_origin_quotes_nfce.sql','202610160005_origin_auxiliary_catalogs.sql','202610160056_origin_reference_fetch.sql'])await db.exec(await readFile(new URL(`../../../supabase/migrations/${f}`,import.meta.url),'utf8'));
 await db.exec("insert into origin_sync.resource_state(resource) values('synthetic_reference_seed')");
});
beforeEach(async()=>{
 await db.exec('truncate origin_reference_fetch.attempt,origin_reference_fetch.origin,origin_sync.raw_record cascade;update origin_reference_fetch.entity_state set retry_after=null,last_error=null,last_attempt_at=null');
 scheduler=await rawRpc('origin_sync_claim',{p_resource:'__scheduler__',p_owner:owner,p_ttl_seconds:600});
 resource=await rawRpc('origin_sync_claim',{p_resource:'proposal_references',p_owner:owner,p_ttl_seconds:300});
});
after(()=>db?.close());

test('056 RLS, no direct table/helper grants, service-only aggregate without IDs',async()=>{
 const tables=(await db.query("select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='origin_reference_fetch' and relkind='r'")).rows;
 assert.equal(tables.length,3);assert.ok(tables.every(x=>x.relrowsecurity));
 for(const role of ['anon','authenticated','service_role']){
  await db.exec(`set role ${role}`);
  try{await assert.rejects(db.query('select * from origin_reference_fetch.attempt'),code('42501'));
   await assert.rejects(db.query("select origin_reference_fetch.exact_id('1')"),code('42501'));
   if(role!=='service_role')await assert.rejects(db.query('select public.origin_sync_reference_status()'),code('42501'));
  }finally{await db.exec('reset role');}
 }
 const status=await rawRpc('origin_sync_reference_status');assert.equal(status.erp_mutations,false);assert.equal(status.coverage_complete,false);assert.equal(status.deletion_inferred,false);
 assert.equal(JSON.stringify(status).includes('source_id'),false);
});
test('picker derives exact open references, dedupes and alternates; excludes existing, invalid and closed',async()=>{
 for(let i=1;i<=7;i++)await seed('sales_proposals',String(i),proposal(String(i),String(100+i),[String(200+i)],['Rascunho','Pendente','Aguardando'][i%3]));
 await seed('sales_proposals','8',proposal('8','101',['201']));
 await seed('contacts','107',{id:'107'});
 for(const [id,status] of [['9','Cancelada'],['10','Pendente '],['11',1]])await seed('sales_proposals',id,proposal(id,'999',['999'],status));
 await seed('sales_proposals','12',proposal('WRONG','888',['888']));
 await seed('sales_proposals','13',proposal('13','001',['0','-1','1e3',null]));
 await seed('sales_proposals','14',{...proposal('14','777',['777']),itens:{bad:true}});
 const rows=await candidates();assert.equal(rows.length,10);assert.deepEqual(rows.slice(0,4).map(x=>x.entity),['contacts','products','contacts','products']);
 assert.ok(rows.every(x=>!['107','999','888','001','777'].includes(x.source_id)));assert.equal(new Set(rows.map(x=>x.entity+x.source_id)).size,10);
 await assert.rejects(rpc('candidates',{p_limit:11}),code('22023'));
});
test('begin rejects arbitrary IDs, witness change and foreign fences before GET',async()=>{
 await seed('sales_proposals','1',proposal());const c=(await candidates())[0];
 await assert.rejects(begin({...c,source_id:'999'}),code('40001'));
 await assert.rejects(begin({...c,proposal_version:'2'}),code('40001'));
 await assert.rejects(rpc('candidates',{p_resource_token:randomUUID()}),code('55000'));
 const a=await begin(c);assert.equal(a.state,'pending');
 const replay=await rpc('begin',{p_attempt_id:a.attempt_id,p_entity:c.entity,p_source_id:c.source_id,p_proposal_id:c.proposal_id,p_proposal_hash:c.proposal_hash,p_proposal_version:c.proposal_version});
 assert.equal(replay.replayed,true);
});
test('finish inserts v1 canonical hash and replay once, preserving all checkpoints',async()=>{
 await seed('sales_proposals','1',proposal());const before=await scalar("select jsonb_agg(jsonb_build_object('r',resource,'cp',checkpoint,'v',checkpoint_version) order by resource) value from origin_sync.resource_state");
 const c=(await candidates())[0],a=await begin(c),p={id:c.source_id,nome:'Contato sintético'};
 assert.deepEqual(await finish(a,p),{stored:true,conflict:false,replayed:false});assert.equal((await finish(a,p)).replayed,true);
 const row=await scalar("select to_jsonb(r) value from origin_sync.raw_record r where entity='contacts' and source_id=$1",[c.source_id]);
 assert.equal(row.version,1);assert.equal(row.last_resource,'proposal_references');assert.deepEqual(row.document_links,[]);
 assert.equal(row.version_hash,await scalar("select encode(sha256(convert_to(jsonb_build_object('payload',$1::jsonb,'document_links','[]'::jsonb)::text,'UTF8')),'hex') value",[JSON.stringify(p)]));
 assert.deepEqual(await scalar("select jsonb_agg(jsonb_build_object('r',resource,'cp',checkpoint,'v',checkpoint_version) order by resource) value from origin_sync.resource_state"),before);
 await assert.rejects(finish(a,{...p,nome:'diferente'}),code('40001'));
 assert.equal((await fail(a,500)).already_finished,true);
});
test('new catalog row or changed witness during HTTP is conflict without overwriting',async()=>{
 for(const mode of ['catalog','hash','version','closed','reference']){
  await db.exec('truncate origin_reference_fetch.attempt,origin_reference_fetch.origin,origin_sync.raw_record cascade');
  await seed('sales_proposals','1',proposal());const c=(await candidates()).find(x=>x.entity==='contacts'),a=await begin(c);
  if(mode==='catalog')await seed('contacts','101',{id:'101',nome:'Winner'});
  if(mode==='hash')await db.exec("update origin_sync.raw_record set version_hash=repeat('f',64)");
  if(mode==='version')await db.exec('update origin_sync.raw_record set version=2');
  if(mode==='closed')await db.exec("update origin_sync.raw_record set payload=jsonb_set(payload,'{situacao}','\"Cancelada\"')");
  if(mode==='reference')await db.exec("update origin_sync.raw_record set payload=jsonb_set(payload,'{contato,id}','\"999\"')");
  assert.deepEqual(await finish(a,{id:'101',nome:'Loser'}),{stored:false,conflict:true,replayed:false});
  assert.equal(await scalar("select count(*)::int value from origin_sync.raw_record where payload->>'nome'='Loser'"),0);
 }
});
test('strict response ID and scheduler expiry reject writes and adoption by a new fence',async()=>{
 await seed('sales_proposals','1',proposal());const a=await begin((await candidates())[0]);
 for(const id of ['999','0101',null,{},0])await assert.rejects(finish(a,{id}),code('22023'));
 await db.exec("update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second' where resource='__scheduler__'");
 await assert.rejects(finish(a,{id:'101'}),code('55000'));scheduler=await rawRpc('origin_sync_claim',{p_resource:'__scheduler__',p_owner:owner,p_ttl_seconds:600});
 // New fence cannot adopt the old attempt.
 await assert.rejects(finish(a,{id:'101'}),code('55000'));
});
test('404 is backed off without a tombstone; 403 pauses only its entity',async()=>{
 await seed('sales_proposals','1',proposal());let rows=await candidates();const a=await begin(rows[0]);await fail(a,404);
 assert.equal(await scalar("select count(*)::int value from origin_sync.raw_record where entity='contacts'"),0);
 assert.equal((await candidates()).some(x=>x.entity==='contacts'),false);
 const next=(await candidates())[0],b=await begin(next);await fail(b,403);
 assert.equal((await candidates()).length,0);
 const status=await rawRpc('origin_sync_reference_status');assert.equal(status.entities.find(x=>x.entity==='products').last_error,'ORIGIN_SCOPE_PENDING');
 await assert.rejects(fail(b,404),code('40001'));
});
test('crashed pending attempts retry only after delay with new attempt; old cannot finish',async()=>{
 await seed('sales_proposals','1',proposal());const c=(await candidates())[0],a=await begin(c);
 assert.ok((await candidates()).every(x=>x.source_id!==c.source_id));
 await db.exec("update origin_reference_fetch.origin set next_attempt_at=clock_timestamp()-interval '1 second'");
 const b=await begin(c);assert.notEqual(a.attempt_id,b.attempt_id);
 await assert.rejects(finish(a,{id:c.source_id}),code('55000'));assert.equal((await finish(b,{id:c.source_id})).stored,true);
 assert.equal(await scalar("select state value from origin_reference_fetch.attempt where id=$1",[a.attempt_id]),'superseded');
});
test('same schema hashes remain usable by ordinary apply_batch; no list checkpoint overwritten',async()=>{
 await seed('sales_proposals','1',proposal());const c=(await candidates())[0],a=await begin(c),payload={id:c.source_id,nome:'Sintético'};await finish(a,payload);
 const l=await rawRpc('origin_sync_claim',{p_resource:'contacts',p_owner:owner,p_ttl_seconds:300});
 const result=await rawRpc('origin_sync_apply_batch',{p_resource:'contacts',p_entity:'contacts',p_owner:owner,p_lease_token:l.lease_token,p_batch_id:randomUUID(),p_records:[{source_id:c.source_id,payload}],p_checkpoint:{test:true},p_expected_checkpoint_version:l.checkpoint_version});
 assert.equal(result.unchanged,1);assert.equal(result.updated,0);
 assert.equal(await scalar("select version::text value from origin_sync.raw_record where entity='contacts'"),'1');
});
test('worker + real SQL + HTTP client stores exact refs and stops 429 without automatic retry',async()=>{
 await seed('sales_proposals','1',proposal());let calls=0;
 const client=new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',intervalMs:0,fetchImpl:async url=>{calls++;return url.includes('/contatos/')?Response.json({data:{id:'101',nome:'Sintético'}}):Response.json({error:'not logged'},{status:429});}});
 const result=await fetchMissingReferences({rpc:rawRpc},client,{owner,lease:scheduler,deadline:Date.now()+60000});
 assert.equal(result.stored,1);assert.equal(result.stop_json,true);assert.equal(result.requests,2);assert.equal(calls,2);
 assert.equal(await scalar("select count(*)::int value from origin_sync.raw_record where entity='products'"),0);
 assert.equal(await scalar("select lease_token value from origin_sync.resource_state where resource='proposal_references'"),null);
});

test('expiry during raw insert rolls back the complete transaction',async()=>{
 await seed('sales_proposals','1',proposal());const a=await begin((await candidates())[0]);
 await db.exec(`create function public.synthetic_expire_reference() returns trigger language plpgsql as $$begin
  if NEW.entity='contacts' then update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second' where resource='proposal_references';end if;return NEW;end;$$;
  create trigger synthetic_expire_reference after insert on origin_sync.raw_record for each row execute function public.synthetic_expire_reference();`);
 try{await assert.rejects(finish(a,{id:'101'}),code('55000'));
  assert.equal(await scalar("select count(*)::int value from origin_sync.raw_record where entity='contacts'"),0);
  assert.equal(await scalar('select state value from origin_reference_fetch.attempt where id=$1',[a.attempt_id]),'pending');
 }finally{await db.exec('drop trigger synthetic_expire_reference on origin_sync.raw_record;drop function public.synthetic_expire_reference()');}
});

test('033 SQL→HTTP→UI remains compatible with reference phase and retains global failure count',async()=>{
 await db.exec('create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb);alter table storage.objects enable row level security;');
 for(const f of ['202610160004_erp_access.sql','202610160027_origin_fiscal_archive.sql','202610160030_origin_finance_refresh.sql','202610160031_xml_queue_fairness.sql','202610160033_origin_progress.sql'])await db.exec(await readFile(new URL(`../../../supabase/migrations/${f}`,import.meta.url),'utf8'));
 const actor=randomUUID();await db.query('insert into auth.users values($1)',[actor]);await db.query("insert into erp_access.membership(user_id,role,active)values($1,'admin',true)",[actor]);
 const run={status:'partial',pages:1,records:0,requests:11,startedAt:'2026-10-16T12:00:00Z',finishedAt:'2026-10-16T12:00:40Z',errors:[{resource:'proposal_references',code:'REFERENCE_FETCH_PARTIAL'}],reference_fetch:{status:'partial',attempted:10,stored:9,requests:10,errors:[{entity:'products',code:'ORIGIN_NOT_FOUND'}],stop_json:false}};
 await db.query("update origin_sync.resource_state set checkpoint=$1,checkpoint_version=checkpoint_version+1 where resource='__scheduler__'",[JSON.stringify({lastRun:run,nextIndex:2})]);
 const projected=integrationProgressResponse(await rawRpc('erp_origin_progress',{p_user_id:actor}));
 assert.equal(projected.last_run.status,'partial');assert.equal(projected.last_run.error_count,1);assert.equal(projected.last_run.requests,11);
 assert.equal(projected.resources.some(x=>x.resource==='proposal_references'),false);assert.deepEqual(parseIntegrationSummary(projected),projected);
 assert.equal(projected.coverage_certified,false);assert.equal(projected.erp_mutations,false);
});

test('lost finish ACK retains committed raw and next round performs no duplicate GET',async()=>{
 await seed('sales_proposals','1',proposal('1','101',[null]));let calls=0;
 const repo={async rpc(name,args){const value=await rawRpc(name,args);if(name==='origin_sync_reference_finish')throw new Error('DATABASE_UNAVAILABLE');return value;}};
 const client=new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',intervalMs:0,fetchImpl:async()=>{calls++;return Response.json({data:{id:'101',nome:'Sintético'}});}});
 const first=await fetchMissingReferences(repo,client,{owner,lease:scheduler,deadline:Date.now()+60000});
 assert.equal(first.status,'partial');assert.equal(calls,1);
 assert.equal(await scalar("select count(*)::int value from origin_reference_fetch.attempt where state='stored'"),1);
 const second=await fetchMissingReferences({rpc:rawRpc},client,{owner,lease:scheduler,deadline:Date.now()+60000});
 assert.equal(second.attempted,0);assert.equal(second.requests,0);assert.equal(calls,1);
 assert.equal(await scalar("select count(*)::int value from origin_sync.raw_record where entity='contacts' and source_id='101'"),1);
});
