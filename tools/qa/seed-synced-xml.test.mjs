import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {seedSyncedXml} from './seed-synced-xml.mjs';
import {parseSyncedXmlRoute,executeSyncedXmlRoute} from '../../workers/erp-api/src/synced-xml.mjs';
test('isolated027 QA fixture seeds both models, pagination, history, issue and a private verified download',async()=>{
 const db=new PGlite(),objects=new Map(),user='d2700000-0000-4000-8900-000000000001';
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));`);
  for(const name of['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0007_erp_history','0027_origin_fiscal_archive'])await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
  await db.query('insert into auth.users values($1)',[user]);await db.query("insert into erp_access.membership(user_id,role)values($1,'admin')",[user]);
  const counts=await seedSyncedXml(db,objects);assert.deepEqual(counts,{synthetic:true,sources:26,current_items:27,all_items:28,revisions:27,objects:28,models:['55','65']});
  const rpc=async(name,args)=>{const pairs=Object.entries(args);return(await db.query(`select public.${name}(${pairs.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) value`,pairs.map(([,value])=>value))).rows[0].value;};
  const route=suffix=>parseSyncedXmlRoute(new Request(`https://synthetic.invalid/v1/xmls-sincronizados${suffix}`));
  const read=suffix=>executeSyncedXmlRoute(route(suffix),{userId:user,rpc});
  const first=(await read('')).body;assert.equal(first.items.length,25);assert.equal(first.has_more,true);assert.equal((await read(`?after=${first.next_cursor}`)).body.items.length,2);
  assert.equal((await read('?include_history=true&limit=100')).body.items.length,28);
  assert.equal((await read('?model=65')).body.items.length,13);assert.equal((await read('?kind=event')).body.items.length,1);assert.ok(first.items.some(item=>item.issues.includes('SIGNATURE_ABSENT')));assert.ok(first.items.every(item=>item.environment==='2'));
  const selected=(await read('?model=65')).body.items[0];
  const file=await executeSyncedXmlRoute(route(`/${selected.id}/download`),{userId:user,rpc,fetchObject:async path=>{const stored=objects.get(path);assert.ok(stored);return new Response(stored.bytes);}});
  assert.match(new TextDecoder().decode(file.bytes),/SYNTHETIC ARCHIVE FIXTURE/);assert.equal(file.type,'download');
  await assert.rejects(()=>seedSyncedXml(db,objects),/already exists/);assert.equal(objects.size,28);assert.equal((await read('?include_history=true&limit=100')).body.items.length,28);
 }finally{await db.close();}
});
