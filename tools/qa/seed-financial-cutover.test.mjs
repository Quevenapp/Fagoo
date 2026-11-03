import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {seedFinancialCutover} from './seed-financial-cutover.mjs';
import {parseFinancialCutoverRoute,executeFinancialCutoverRoute} from '../../workers/erp-api/src/financial-cutover.mjs';

test('038 local fixture exercises paging and missing evidence without native financial writes or old fixture changes',async()=>{
 const db=new PGlite(),uid=randomUUID();
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;
 try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb);');
  for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0006_erp_catalog','0010_erp_finance','0020_cutover_readiness','0030_origin_finance_refresh','0038_financial_cutover_review'])await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
  await db.query('insert into auth.users values($1)',[uid]);await db.query("insert into erp_access.membership(user_id,role)values($1,'admin')",[uid]);
  await db.exec("insert into origin_sync.resource_state(resource,checkpoint)values('qa_existing','{\"preserve\":true}');insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values('receivables','qa_existing','existing-before-038','{\"situacao\":7}','"+'b'.repeat(64)+"')");
  const old=await scalar("select to_jsonb(r)v from origin_sync.raw_record r where source_id='existing-before-038'");
  const financeTables=['account','category','title','settlement','movement','command','audit'];
  const financeSnapshot=()=>Promise.all(financeTables.map(t=>scalar(`select coalesce(jsonb_agg(to_jsonb(x)),'[]')v from erp_finance.${t} x`)));
  const before=await financeSnapshot(),seed=await seedFinancialCutover(db,{uid});
  assert.equal(seed.receivables,29);assert.equal(seed.payables,2);assert.equal(seed.native_financial_writes,0);
  const api=async path=>executeFinancialCutoverRoute(parseFinancialCutoverRoute(new Request('https://erp.invalid/v1/conferencia-financeira-origin'+path)),{userId:uid,rpc:async(name,args)=>{const pairs=Object.entries(args);return scalar(`select public.${name}(${pairs.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,pairs.map(([,v])=>v));}});
  const first=await api('?entity=receivables&q=938&limit=25');assert.equal(first.items.length,25);assert.equal(first.has_more,true);
  const second=await api('?entity=receivables&q=938&limit=25&after='+first.next_cursor);assert.equal(second.items.length,3);assert.equal(second.has_more,false);assert.equal(new Set([...first.items,...second.items].map(v=>v.source_id)).size,28);
  const slash=await api('?entity=receivables&q=QA%2F001');assert.equal(slash.items.length,1);assert.equal(slash.items[0].source_id,seed.receivable_ids[0]);
  const detail=await api('/receivables/'+seed.receivable_ids[0]);assert.equal(detail.record.banking.bank_number,'00000123');assert.equal(detail.record.banking.carrier_id,'0007');assert.equal(detail.record.contact.match,'matched');assert.equal(detail.record.contact.record_id,seed.native_contact);
  const partial=(await api('/receivables/'+seed.receivable_ids[1])).record;assert.equal(partial.status.scope,'partial');assert.equal(partial.balance.cents,'2345');
  assert.equal((await api('/receivables/'+seed.receivable_ids[2])).record.balance.state,'null');assert.equal((await api('/receivables/'+seed.receivable_ids[3])).record.balance.state,'missing');assert.equal((await api('/receivables/'+seed.receivable_ids[4])).record.contact.match,'unmatched');
  const unknown=await api('?entity=receivables&status=unknown&q=938');assert.equal(unknown.items.length,1);assert.equal(unknown.items[0].source_id,seed.receivable_ids[28]);
  assert.equal((await api('?entity=payables&q=938')).items.length,2);
  assert.deepEqual(await financeSnapshot(),before);assert.deepEqual(await scalar("select to_jsonb(r)v from origin_sync.raw_record r where source_id='existing-before-038'"),old);
  const counts=()=>scalar("select jsonb_build_object('raw',(select count(*)from origin_sync.raw_record),'catalog',(select count(*)from erp_catalog.record),'audit',(select count(*)from erp_catalog.audit))v");
  const after=await counts();await assert.rejects(()=>seedFinancialCutover(db,{uid}),/already exists/);assert.deepEqual(await counts(),after);assert.deepEqual(await financeSnapshot(),before);
 }finally{await db.close();}
});

test('038 fixture rejects non-embedded database before making queries',async()=>{
 await assert.rejects(()=>seedFinancialCutover({query(){assert.fail('unexpected query');}},{uid:randomUUID()}),/embedded PGlite/);
});
