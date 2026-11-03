import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {before,after,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {integrationProgressResponse,EXTRA_PROGRESS_ENTITIES,EXTRA_PROGRESS_RESOURCES} from '../../workers/erp-api/src/integration-progress.mjs';
import {parseIntegrationSummary} from '../../apps/erp/src/lib/integration-progress-model.ts';
import {RESOURCES} from '../../workers/origin-sync/src/resources.mjs';

let db,beforeSummary,beforeRows,beforeWrapper;const users={};
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;
const denied=e=>e.code==='42501';
async function asRole(role,run){await db.exec(`set role ${role}`);try{return await run();}finally{await db.exec('reset role');}}
const summary=(actor=users.admin)=>asRole('service_role',()=>scalar('select public.erp_origin_progress($1) v',[actor]));
const comparable=({as_of,extra_resources,...value})=>value;
const fingerprint=()=>scalar("select encode(sha256(convert_to(jsonb_build_object('raw',(select jsonb_agg(to_jsonb(r) order by entity,source_id) from origin_sync.raw_record r),'state',(select jsonb_agg(to_jsonb(r) order by resource) from origin_sync.resource_state r),'batch',(select jsonb_agg(to_jsonb(r) order by batch_id) from origin_sync.batch_inbox r),'membership',(select jsonb_agg(to_jsonb(r) order by user_id) from erp_access.membership r))::text,'UTF8')),'hex') v");
async function raw(entity,id,payload={},stamp='2026-09-10T10:00:00Z'){
 await db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash,last_seen_at)values($1,'synthetic_seed',$2,$3,repeat('a',64),$4)",[entity,id,JSON.stringify(payload),stamp]);
}
async function state(resource,checkpoint,version=1){
 await db.query('insert into origin_sync.resource_state(resource,checkpoint_version,checkpoint)values($1,$2,$3) on conflict(resource)do update set checkpoint_version=excluded.checkpoint_version,checkpoint=excluded.checkpoint',[resource,version,JSON.stringify(checkpoint)]);
}
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb);alter table storage.objects enable row level security;');
 for(const name of ['001_origin_sync','002_origin_quotes_nfce','004_erp_access','005_origin_auxiliary_catalogs','027_origin_fiscal_archive','030_origin_finance_refresh','031_xml_queue_fairness','033_origin_progress','056_origin_reference_fetch','059_origin_price_capture','063_origin_extra_resources'])await db.exec(await readFile(new URL(`../../supabase/migrations/202610160${name}.sql`,import.meta.url),'utf8'));
 for(const role of ['admin','consulta','vendas','financeiro','estoque','fiscal','inactive']){
  users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role,active)values($1,$2,$3)',[users[role],role==='inactive'?'admin':role,role!=='inactive']);
 }
 await state('synthetic_seed',{});await raw('contacts','100',{nome:'PRIVATE_NAME',url:'https://private.invalid'});
 await state('contacts',{recentCompletedAt:'2026-10-16 12:00:00',history:{page:12,from:'PRIVATE_CURSOR'}});
 beforeSummary=await summary();beforeRows=await fingerprint();beforeWrapper=await scalar("select pg_get_functiondef('public.origin_sync_apply_batch(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint)'::regprocedure) v");
 await db.exec(await readFile(new URL('../../supabase/migrations/202610160065_origin_extra_progress.sql',import.meta.url),'utf8'));
});
after(()=>db?.close());

test('065 changes only the additive aggregate; legacy data/projection and059 wrapper remain exact',async()=>{
 assert.equal(await fingerprint(),beforeRows);assert.equal(await scalar("select pg_get_functiondef('public.origin_sync_apply_batch(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint)'::regprocedure) v"),beforeWrapper);
 const result=await summary();assert.deepEqual(comparable(result),comparable(beforeSummary));assert.equal(result.entities.length,11);assert.equal(result.resources.length,22);
 assert.equal(integrationProgressResponse(beforeSummary).extra_resources,null);assert.equal(parseIntegrationSummary(beforeSummary).extra_resources,null);
 assert.deepEqual(integrationProgressResponse(result),result);assert.deepEqual(parseIntegrationSummary(result),result);
 assert.equal(result.extra_resources.entities.length,7);assert.equal(result.extra_resources.resources.length,9);assert.equal(result.extra_resources.stock_last_observation,null);
 assert.deepEqual(EXTRA_PROGRESS_ENTITIES.toSorted(),[...new Set(RESOURCES.filter(x=>x.extra).map(x=>x.entity))].sort());
 assert.deepEqual(EXTRA_PROGRESS_RESOURCES.map(x=>x[0]).sort(),RESOURCES.filter(x=>x.extra).map(x=>x.id).sort());
});
test('065 stays active-admin/service-only with a private helper and no table access grants',async()=>{
 for(const role of ['anon','authenticated'])await assert.rejects(()=>asRole(role,()=>scalar('select public.erp_origin_progress($1) v',[users.admin])),denied);
 for(const role of ['consulta','vendas','financeiro','estoque','fiscal','inactive'])await assert.rejects(()=>summary(users[role]),denied);
 for(const actor of [null,randomUUID()])await assert.rejects(()=>summary(actor),denied);
 for(const role of ['anon','authenticated','service_role']){
  assert.equal(await scalar("select has_function_privilege($1,'erp_integration.extra_progress()','EXECUTE') v",[role]),false);
  assert.equal(await scalar("select has_table_privilege($1,'origin_sync.raw_record','SELECT') v",[role]),false);
 }
 await assert.rejects(()=>asRole('service_role',()=>scalar('select erp_integration.extra_progress() v')),denied);
});
test('065 counts only current staging origins, including two warehouse variants under one entity',async()=>{
 await raw('warehouses','200',{id:200,nome:'PRIVATE_WAREHOUSE',saldo:999});await raw('warehouses','201',{id:201,nome:'PRIVATE_WAREHOUSE'},'2026-10-16T12:00:00Z');
 for(const [i,entity]of EXTRA_PROGRESS_ENTITIES.filter(x=>x!=='warehouses').entries())await raw(entity,String(300+i),{id:300+i,private:'PRIVATE_PAYLOAD',cnpj:'PRIVATE_DOCUMENT',depositos:[{id:'PRIVATE_ID'}]});
 const result=await summary(),extra=result.extra_resources;
 assert.equal(extra.entities.find(x=>x.entity==='warehouses').records,2);assert.equal(extra.entities.find(x=>x.entity==='stock_balances').records,1);
 assert.equal(extra.entities.filter(x=>x.records===1).length,6);assert.equal(result.erp_mutations,false);assert.equal(result.coverage_certified,false);assert.equal(result.runtime_configuration_known,false);
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|private\.invalid|source_id|payload|depositos|cnpj|saldo|lease_token|"enabled"/);
 assert.deepEqual(parseIntegrationSummary(integrationProgressResponse(result)),result);
});
test('065 passage timestamps represent closure, not queried bounds; absent checkpoints stay unknown',async()=>{
 await state('service_orders',{recentCompletedAt:'2026-10-16 10:00:00',history:{from:'2020-01-01',to:'2020-02-01',page:4,private:'PRIVATE_CURSOR'},failure:{code:'PRIVATE_FAILURE'},enabled:true});
 await state('warehouses_active',{unfilteredCompletedAt:'2026-10-15 09:00:00',unfiltered:{page:2,private:'PRIVATE_CURSOR'}});
 await state('warehouses_inactive',{unfilteredCompletedAt:'2026-10-15 09:00:00',unfiltered:{page:3}},0);
 await state('cash_entries_registered',{recent:{page:2,offset:9,list_fingerprint:'PRIVATE_HASH'},historyCompletedAt:'2026-10-14'});
 const result=await summary(),resources=result.extra_resources.resources,os=resources.find(x=>x.resource==='service_orders'),cash=resources.find(x=>x.resource==='cash_entries_registered');
 assert.equal(os.recent_completed_local,'2026-10-16 10:00:00');assert.equal(os.history_open,true);assert.equal(os.history_completed_local,null);
 assert.equal(cash.history_completed_local,'2026-10-14');assert.equal(cash.recent_open,true);
 const absent=resources.find(x=>x.resource==='warehouses_inactive');assert.equal(absent.checkpoint_present,false);assert.equal(absent.sweep_open,false);assert.equal(absent.sweep_completed_local,null);assert.equal(absent.state_updated_at,null);
 assert.doesNotMatch(JSON.stringify(result),/2020-01-01|PRIVATE_|list_fingerprint|"offset"|"enabled"/);assert.deepEqual(parseIntegrationSummary(result),integrationProgressResponse(result));
});
test('065 last stock batch is independent of retained older observations and unavailable never becomes balance zero',async()=>{
 const stamp='2026-10-16T12:00:00Z';await state('stock_balances',{last_observation:{requested:25,returned:0,unavailable:25,observed_at:stamp,coverage_complete:false,products:['PRIVATE_ID']},unfiltered:{after:'PRIVATE_ID'}});
 const result=await summary(),extra=result.extra_resources;
 assert.deepEqual(extra.stock_last_observation,{requested:25,returned:0,unavailable:25,observed_at:extra.stock_last_observation.observed_at,coverage_complete:false});assert.equal(Date.parse(extra.stock_last_observation.observed_at),Date.parse(stamp));
 assert.equal(extra.entities.find(x=>x.entity==='stock_balances').records,1);assert.equal(Date.parse(extra.entities.find(x=>x.entity==='stock_balances').newest_observation),Date.parse('2026-09-10T10:00:00Z'));
 assert.equal(extra.resources.find(x=>x.resource==='stock_balances').sweep_open,true);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|"balance"|"saldo"|"products":/);
 assert.deepEqual(parseIntegrationSummary(result),integrationProgressResponse(result));
 await state('stock_balances',{last_observation:{requested:0,returned:0,unavailable:0,observed_at:stamp,coverage_complete:false}});
 assert.equal((await summary()).extra_resources.stock_last_observation.requested,0);
});
test('065 malformed or incomplete stock diagnostics are unknown rather than invented counts',async()=>{
 const good={requested:3,returned:2,unavailable:1,observed_at:'2026-10-16T12:00:00Z',coverage_complete:false};
 for(const value of [null,{},'PRIVATE_TEXT',{...good,requested:'3'},{...good,requested:26},{...good,returned:4},{...good,unavailable:0},{...good,observed_at:'2026-02-30T12:00:00Z'},{...good,coverage_complete:true},{...good,requested:-1}]){
  await state('stock_balances',{last_observation:value});const result=await summary();assert.equal(result.extra_resources.stock_last_observation,null);assert.deepEqual(parseIntegrationSummary(result),integrationProgressResponse(result));
 }
 await state('stock_balances',{last_observation:good},0);assert.equal((await summary()).extra_resources.stock_last_observation,null);
});
test('065 is callable in READ ONLY transaction and never mutates source/checkpoint/receipt or membership',async()=>{
 const before=await fingerprint();await db.exec('begin read only');try{const result=await summary();assert.equal(result.extra_resources.coverage_certified,false);assert.equal(result.extra_resources.resources.length,9);}finally{await db.exec('rollback');}
 assert.equal(await fingerprint(),before);
});
