import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {seedSyncedXml} from './seed-synced-xml.mjs';
import {seedIntegrationProgress} from './seed-integration-progress.mjs';
import {integrationProgressResponse} from '../../workers/erp-api/src/integration-progress.mjs';
test('033 synthetic fixture populates meaningful aggregates without changing Storage and refuses replay',async()=>{
 await assert.rejects(()=>seedIntegrationProgress({query(){throw Error('must not run');}}),TypeError);
 const db=new PGlite();try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb);alter table storage.objects enable row level security;');
  for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0005_origin_auxiliary_catalogs','0027_origin_fiscal_archive','0030_origin_finance_refresh','0033_origin_progress'])await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
  await assert.rejects(()=>seedIntegrationProgress(db),/requires the XML fixture/);assert.equal((await db.query("select count(*)::int n from origin_sync.resource_state where resource='qa_integration_progress'")).rows[0].n,0);
  const objects=new Map();await seedSyncedXml(db,objects);const snapshot=async()=>Promise.all(['storage.objects','origin_fiscal.object','origin_fiscal.revision','origin_fiscal.item'].map(async table=>(await db.query(`select jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text) value from ${table} t`)).rows[0].value));
  const before=await snapshot(),stored=objects.size;assert.equal((await seedIntegrationProgress(db)).storage_mutations,0);assert.deepEqual(await snapshot(),before);assert.equal(objects.size,stored);
  await db.exec("insert into auth.users values('a0000000-0000-4000-8000-000000000001');insert into erp_access.membership(user_id,role,active)values('a0000000-0000-4000-8000-000000000001','admin',true)");
  const current=async()=>integrationProgressResponse((await db.query("select public.erp_origin_progress('a0000000-0000-4000-8000-000000000001') value")).rows[0].value);
  const result=await current();assert.equal(result.xml.known_origins,9);assert.equal(result.xml.with_preserved_revision,6);assert.equal(result.xml.without_preserved_revision,2);assert.equal(result.xml.without_valid_key,1);assert.equal(result.xml.never_attempted,2);assert.equal(result.xml.retry_origins,1);assert.equal(result.xml.blocked_origins,1);assert.equal(result.last_run.status,'partial');assert.equal(result.last_xml_run.status,'partial');assert.equal(result.last_finance_run.stored,8);
  assert.equal(result.finance_refresh.entities.reduce((sum,r)=>sum+r.known_open_partial,0),12);assert.equal(result.finance_refresh.entities.reduce((sum,r)=>sum+r.observed_over_hour_ago,0),4);assert.equal(result.finance_refresh.entities.reduce((sum,r)=>sum+r.unavailable_balance,0),2);
  assert.equal(result.resources.find(r=>r.resource==='contacts').history_open,true);
  await assert.rejects(()=>seedIntegrationProgress(db),/already exists/);const again=await current();assert.deepEqual({...again,as_of:null},{...result,as_of:null});assert.deepEqual(await snapshot(),before);
 }finally{await db.close();}
});
