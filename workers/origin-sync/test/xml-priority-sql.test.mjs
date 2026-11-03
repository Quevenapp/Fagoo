import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {inspectArchivedXml} from '../../../packages/fiscal-xml/src/archive.mjs';
import {invoice,keyFor} from './xml-fixtures.mjs';
import {createXmlPriorityPlan,createXmlPriority} from '../src/xml-priority.mjs';

let db,owner,fence,prior;
const migration = await readFile(new URL('../../../supabase/migrations/202610170092_origin_xml_priority_sources.sql',import.meta.url),'utf8');
const scalar=async(sql,args=[]) => (await db.query(sql,args)).rows[0].v;
async function rpc(name,args={}) {
  const pairs=Object.entries(args);await db.exec('set role service_role');
  try{return await scalar(`select public.${name}(${pairs.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,pairs.map(([,v])=>typeof v==='object'?JSON.stringify(v):v));}
  finally{await db.exec('reset role');}
}
const args=()=>({p_owner:owner,p_lease_token:fence});
const read=candidates=>rpc('origin_sync_xml_priority_sources',{...args(),p_candidates:candidates});
const begin=c=>rpc('origin_sync_xml_begin',{...args(),p_entity:c.entity,p_source_id:c.source_id,p_key:c.key,p_fingerprint:c.fingerprint});
const fail=(a,blocked=false)=>rpc('origin_sync_xml_fail',{...args(),p_attempt_id:a.attempt_id,p_code:'ORIGIN_XML_DOCUMENT_UNAVAILABLE',p_blocked:blocked,p_retry_seconds:86400});
async function seed(id='1',model='55') {
  const entity=model==='55'?'nfe':'nfce',payload={id,chaveAcesso:keyFor(model),situacao:5,tipo:1,numero:'1',serie:1,dataEmissao:'2026-10-17 15:00:00',valorNota:42};
  await db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values($1,'xml_seed',$2,$3,repeat('a',64))",[entity,id,JSON.stringify(payload)]);
  return{entity,source_id:id,key:keyFor(model),fingerprint:await scalar('select origin_fiscal.fingerprint($1::jsonb)v',[JSON.stringify(payload)])};
}
async function store(c) {
  const a=await begin(c),bytes=new TextEncoder().encode(invoice(c.entity==='nfe'?'55':'65'));
  const meta={hash:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,...inspectArchivedXml(bytes,{key:c.key,entity:c.entity})};
  await db.query("insert into storage.objects(bucket_id,name,metadata)values('origin-fiscal-xml',$1,$2)on conflict do nothing",[`objects/${meta.hash}.xml`,JSON.stringify({size:meta.size,mimetype:'application/xml'})]);
  await rpc('origin_sync_xml_finish',{...args(),p_attempt_id:a.attempt_id,p_documents:[meta]});return a;
}
const oldCatalog=()=>scalar(`select jsonb_agg(to_jsonb(p) order by p.oid)v from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in('public','origin_sync','origin_fiscal')and p.proname<>'origin_sync_xml_priority_sources'`);
const state=()=>scalar(`select jsonb_build_object('raw',(select jsonb_agg(to_jsonb(r))from origin_sync.raw_record r),
 'sources',(select jsonb_agg(to_jsonb(s))from origin_fiscal.source s),'attempts',(select jsonb_agg(to_jsonb(a))from origin_fiscal.attempt a),
 'resource',(select jsonb_agg(to_jsonb(r)order by resource)from origin_sync.resource_state r))v`);

before(async()=>{
  db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;`);
  for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0007_erp_history','0027_origin_fiscal_archive','0037_xml_direction_fairness'])
    await db.exec(await readFile(new URL(`../../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
  prior=await oldCatalog();await db.exec(migration);await db.exec("insert into origin_sync.resource_state(resource)values('xml_seed')");
});
after(()=>db?.close());
beforeEach(async()=>{
  await db.exec("truncate origin_fiscal.item,origin_fiscal.revision,origin_fiscal.object,origin_fiscal.attempt,origin_fiscal.source cascade;delete from origin_sync.raw_record;delete from storage.objects;update storage.buckets set public=false;update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval'1 second'where lease_expires_at is not null");
  owner=randomUUID();fence=(await rpc('origin_sync_claim',{p_resource:'__scheduler__',p_owner:owner,p_ttl_seconds:600})).lease_token;
});

test('092 adds only one service-only fenced read function and preserves every existing function row',async()=>{
  assert.deepEqual(await oldCatalog(),prior);
  const fn=await scalar(`select jsonb_build_object('security',prosecdef,'volatility',provolatile,'parallel',proparallel,'config',proconfig,'owner',pg_get_userbyid(proowner),
   'acl',(select jsonb_agg(jsonb_build_object('role',case when grantee=0 then 'PUBLIC'else pg_get_userbyid(grantee)end,'privilege',privilege_type,'grantable',is_grantable)order by grantee)from aclexplode(proacl)))v
   from pg_proc where oid='public.origin_sync_xml_priority_sources(uuid,uuid,jsonb)'::regprocedure`);
  assert.equal(fn.security,true);assert.equal(fn.volatility,'v');assert.equal(fn.parallel,'u');assert.deepEqual(fn.config,['search_path=pg_catalog','lock_timeout=750ms','statement_timeout=5s']);
  assert.deepEqual(fn.acl.filter(a=>a.role!==fn.owner),[{role:'service_role',privilege:'EXECUTE',grantable:false}]);
  for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);try{await assert.rejects(scalar("select public.origin_sync_xml_priority_sources(null,null,'[]')v"),e=>e.code==='42501');}finally{await db.exec('reset role');}}
});
test('092 exact candidates are private reads and preserve all source, attempt and checkpoint rows',async()=>{
  const a=await seed('1'),b=await seed('2','65'),before=await state();const result=await read([b,a]);
  assert.equal(result.profile,'origin-xml-priority-sources-v1');assert.deepEqual(result.items.map(x=>x.entity),['nfce','nfe']);
  assert.ok(result.items.every(x=>x.source_matches&&x.eligible&&!x.terminal_confirmed&&x.state===null));assert.deepEqual(await state(),before);
  assert.doesNotMatch(JSON.stringify(result),/payload|valorNota|numero|access_token|xml:/);
});
test('092 rejects malformed/oversized/duplicate selections and wrong/expired lease or unsafe Storage',async()=>{
  const c=await seed();
  for(const candidates of [null,[],[c,c],Array.from({length:51},(_,i)=>({...c,source_id:String(i)})),[{...c,payload:{}}],[{...c,key:keyFor('65')}],[{...c,source_id:1}],[{...c,fingerprint:'a'.repeat(140000)}]])
    await assert.rejects(read(candidates),e=>e.code==='22023');
  await assert.rejects(rpc('origin_sync_xml_priority_sources',{...args(),p_owner:randomUUID(),p_candidates:[c]}),e=>e.code==='55000');
  await db.exec("update storage.buckets set public=true");await assert.rejects(read([c]),/xml_private_storage_required/);await db.exec("update storage.buckets set public=false");
  await db.exec("update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval'1 second'where resource='__scheduler__'");await assert.rejects(read([c]),/xml_scheduler_lease_required/);
});
test('092 reports changed or missing raw identities without mutating or treating old XML as success',async()=>{
  const c=await seed();await store(c);await db.exec("update origin_sync.raw_record set payload=jsonb_set(payload,'{situacao}','2')");
  const changed=(await read([c])).items[0];assert.equal(changed.source_matches,false);assert.equal(changed.terminal_confirmed,false);assert.equal(changed.eligible,false);
  const missing=(await read([{...c,source_id:'999'}])).items[0];assert.equal(missing.source_exists,false);assert.equal(missing.current_fingerprint,null);assert.equal(missing.eligible,false);
});
test('092 does not confirm inflight attempts; terminal failure readback respects backoff and fingerprint',async()=>{
  const c=await seed(),a=await begin(c);const pending=(await read([c])).items[0];assert.equal(pending.attempt_state,'pending');assert.equal(pending.terminal_confirmed,false);assert.equal(pending.eligible,true);
  await fail(a);const failed=(await read([c])).items[0];assert.equal(failed.state,'retry');assert.equal(failed.terminal_confirmed,true);assert.equal(failed.eligible,false);assert.equal(failed.stored_files,0);
  assert.equal(failed.error_code,'ORIGIN_XML_DOCUMENT_UNAVAILABLE');assert.equal(failed.attempt_id,a.attempt_id);
});
test('092 stored readback proves same attempt/revision/items/object/Storage and rejects broken links',async()=>{
  const c=await seed(),a=await store(c);const good=(await read([c])).items[0];assert.equal(good.attempt_id,a.attempt_id);assert.equal(good.terminal_confirmed,true);assert.equal(good.stored_files,1);
  await db.exec("update storage.objects set metadata=jsonb_set(metadata,'{size}','1')");const wrong=(await read([c])).items[0];assert.equal(wrong.terminal_confirmed,false);assert.equal(wrong.stored_files,0);
  await db.exec('delete from storage.objects');assert.equal((await read([c])).items[0].terminal_confirmed,false);
});
test('real092 recovers a stored attempt after lost scheduler ACK without offering a duplicate XML GET',async()=>{
  const c=await seed(),snapshot_time=new Date(Date.now()-1000).toISOString();
  const p=await createXmlPriorityPlan({campaign:'synthetic-real092',snapshot_time,candidates:[c]});
  const controller=await createXmlPriority({rpc},{owner,lease:{lease_token:fence},plan:p});const previous=controller.checkpoint();
  assert.equal((await controller.candidateProvider.list({limit:2,deadline:Date.now()+10000})).items.length,1);await store(c);
  const resumed=await createXmlPriority({rpc},{owner,lease:{lease_token:fence},plan:p,checkpoint:previous});
  assert.deepEqual(await resumed.candidateProvider.list({limit:2,deadline:Date.now()+10000}),{items:[]});assert.equal(resumed.summary().stored,1);assert.equal(resumed.summary().recovered,1);
});
