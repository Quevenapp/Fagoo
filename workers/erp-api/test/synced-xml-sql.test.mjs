import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {inspectArchivedXml} from '../../../packages/fiscal-xml/src/archive.mjs';
import {invoice,event,keyFor} from '../../origin-sync/test/xml-fixtures.mjs';
import {parseSyncedXmlRoute,executeSyncedXmlRoute} from '../src/synced-xml.mjs';
import {syncedXmlPage,verifySyncedXmlBlob} from '../../../apps/erp/src/lib/synced-xml-model.ts';
let db;const user=randomUUID(),objects=new Map();
const rpc=async(name,args)=>{assert.ok(['erp_synced_xml_list','erp_synced_xml_object'].includes(name));const entries=Object.entries(args);await db.exec('set role service_role');try{return(await db.query(`select public.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) value`,entries.map(([,value])=>value))).rows[0].value;}finally{await db.exec('reset role');}};
const route=suffix=>parseSyncedXmlRoute(new Request(`https://synthetic.invalid/v1/xmls-sincronizados${suffix}`));
const query=suffix=>executeSyncedXmlRoute(route(suffix),{userId:user,rpc});
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);
 create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;`);
 for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0007_erp_history','0027_origin_fiscal_archive'])await db.exec(await readFile(new URL(`../../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
 await db.query('insert into auth.users values($1)',[user]);await db.query("insert into erp_access.membership(user_id,role)values($1,'fiscal')",[user]);
 for(const model of ['55','65']){
  const source=randomUUID(),revision=randomUUID();
  await db.query('insert into origin_fiscal.source(id,entity,source_id,access_key) values($1,$2,$3,$4)',[source,model==='55'?'nfe':'nfce',model,keyFor(model)]);
  await db.query("insert into origin_fiscal.revision(id,source,revision,manifest_hash,source_status) values($1,$2,1,$3,'5')",[revision,source,'a'.repeat(64)]);
  await db.query('update origin_fiscal.source set current_revision=$1 where id=$2',[revision,source]);
  for(const xml of model==='55'?[invoice(model),event(model)]:[invoice(model)]){
   const bytes=new TextEncoder().encode(xml),hash=createHash('sha256').update(bytes).digest('hex'),metadata=inspectArchivedXml(bytes,{key:keyFor(model),entity:model==='55'?'nfe':'nfce'});
   await db.query('insert into origin_fiscal.object(hash,size,metadata) values($1,$2,$3::jsonb)',[hash,bytes.length,JSON.stringify(metadata)]);
   await db.query('insert into origin_fiscal.item(revision,object_hash) values($1,$2)',[revision,hash]);
   await db.query("insert into storage.objects values('origin-fiscal-xml',$1,$2::jsonb)",[`objects/${hash}.xml`,JSON.stringify({size:bytes.length,mimetype:'application/xml'})]);objects.set(hash,bytes);
  }
 }
});
after(()=>db?.close());
test('027 actual SQL projection passes HTTP and browser validators for NF-e, NFC-e and events',async()=>{
 const response=await query(''),body=response.body;
 assert.equal(body.items.length,3);assert.deepEqual(syncedXmlPage(body,{q:'',model:'',kind:'',include_history:false}),body);
 const eventPage=(await query('?model=55&kind=event')).body;assert.equal(eventPage.items.length,1);assert.equal(eventPage.items[0].event_type,'110111');
 assert.equal((await query('?model=65')).body.items[0].entity,'nfce');
 const first=(await query('?limit=1')).body;assert.equal(first.items.length,1);assert.equal(first.next_cursor,first.items[0].id);
 const remaining=(await query(`?after=${first.next_cursor}`)).body;assert.equal(remaining.items.length,2);assert.ok(remaining.items.every(item=>item.id>first.next_cursor));
});
test('027 actual private-object RPC and Storage bytes produce only a fully verified download',async()=>{
 const item=(await query('?model=65')).body.items[0];let calls=0;
 const result=await executeSyncedXmlRoute(route(`/${item.id}/download`),{userId:user,rpc:async(...args)=>{calls++;return rpc(...args);},fetchObject:async path=>{
  const hash=path.split('/').at(-1).slice(0,-4);assert.equal(path,`/storage/v1/object/authenticated/origin-fiscal-xml/objects/${hash}.xml`);return new Response(objects.get(hash));
 }});
 assert.equal(calls,2);assert.equal(result.type,'download');await verifySyncedXmlBlob(new Blob([result.bytes]),item);
 assert.equal(result.headers['Content-Type'],'application/octet-stream');
});
