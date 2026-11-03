import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {inspectArchivedXml} from '../../../packages/fiscal-xml/src/archive.mjs';
import {invoice,event,keyFor} from './xml-fixtures.mjs';
let db,owner,fence;const users={};const sqlError=code=>error=>error.code===code;
const scalar=async(sql,args=[])=> (await db.query(sql,args)).rows[0].value;
async function rpc(name,args={}){const pairs=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${pairs.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) value`,pairs.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}}
const leaseArgs=()=>({p_owner:owner,p_lease_token:fence});
const candidates=()=>rpc('origin_sync_xml_candidates',leaseArgs());
const begin=c=>rpc('origin_sync_xml_begin',{...leaseArgs(),p_entity:c.entity,p_source_id:c.source_id,p_key:c.key,p_fingerprint:c.fingerprint});
const finish=(a,documents)=>rpc('origin_sync_xml_finish',{...leaseArgs(),p_attempt_id:a.attempt_id,p_documents:documents});
const list=(params={})=>rpc('erp_synced_xml_list',{p_user_id:users.admin,...params});
async function seed(model='55',id='1'){
 const payload={id,chaveAcesso:keyFor(model),situacao:5,tipo:1,numero:'1',serie:1,dataEmissao:'2026-10-16 08:00:00',valorNota:25.70,xml:'https://private.invalid/rotating-token'};
 await db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values($1,'xml_seed',$2,$3::jsonb,$4)",[model==='55'?'nfe':'nfce',id,JSON.stringify(payload),'a'.repeat(64)]);return payload;
}
async function object(xml,model='55',upload=true){const bytes=new TextEncoder().encode(xml),hash=createHash('sha256').update(bytes).digest('hex'),meta={hash,size:bytes.length,...inspectArchivedXml(bytes,{key:keyFor(model),entity:model==='55'?'nfe':'nfce'})};
 if(upload)await db.query("insert into storage.objects(bucket_id,name,metadata)values('origin-fiscal-xml',$1,$2::jsonb)on conflict do nothing",[`objects/${hash}.xml`,JSON.stringify({size:bytes.length,mimetype:'application/xml'})]);return meta;
}
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);
 create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;grant usage on schema storage to anon,authenticated;grant select on storage.objects to anon,authenticated;create policy broad on storage.objects for select to anon,authenticated using(true);`);
 for(const name of['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0007_erp_history','0027_origin_fiscal_archive'])await db.exec(await readFile(new URL(`../../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
 await db.exec("insert into origin_sync.resource_state(resource)values('xml_seed')");
 for(const role of['admin','consulta','fiscal','vendas','financeiro','estoque']){users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[users[role],role]);}
});
beforeEach(async()=>{await db.exec("truncate origin_fiscal.item,origin_fiscal.revision,origin_fiscal.object,origin_fiscal.attempt,origin_fiscal.source cascade;delete from origin_sync.raw_record;delete from storage.objects;update storage.buckets set public=false where id='origin-fiscal-xml';update erp_access.membership set active=true;update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second' where lease_expires_at is not null;");owner=randomUUID();fence=(await rpc('origin_sync_claim',{p_resource:'__scheduler__',p_owner:owner,p_ttl_seconds:600})).lease_token;});
after(()=>db?.close());
test('027 service-only tables/RPCs, fiscal membership and restrictive Storage prevent broad-policy access',async()=>{
 const tables=(await db.query("select relrowsecurity from pg_class join pg_namespace on pg_namespace.oid=relnamespace where nspname='origin_fiscal'and relkind='r'")).rows;assert.equal(tables.length,5);assert.ok(tables.every(r=>r.relrowsecurity));
 await object(invoice());
 for(const role of['anon','authenticated']){await db.exec(`set role ${role}`);try{await assert.rejects(()=>scalar('select public.origin_sync_xml_status() value'),sqlError('42501'));await assert.rejects(()=>db.query('select * from origin_fiscal.object'),sqlError('42501'));assert.equal(await scalar("select count(*) value from storage.objects where bucket_id='origin-fiscal-xml'"),0);}finally{await db.exec('reset role');}}
 for(const role of['admin','consulta','fiscal'])assert.equal((await list({p_user_id:users[role]})).items.length,0);
 for(const role of['vendas','financeiro','estoque'])await assert.rejects(()=>list({p_user_id:users[role]}),sqlError('42501'));
 await db.exec('set role service_role');try{await assert.rejects(()=>db.query('select * from origin_fiscal.object'),sqlError('42501'));}finally{await db.exec('reset role');}
});
test('027 fingerprint ignores rotating URLs, observes fiscal changes, and rechecks after24h with fair model selection',async()=>{
 await seed('55','1');await seed('55','2');await seed('65','1');const picked=(await candidates()).items;assert.deepEqual(picked.map(c=>c.entity).sort(),['nfce','nfe']);
 const first=picked.find(c=>c.entity==='nfe'),a=await begin(first),meta=await object(invoice());await finish(a,[meta]);
 await db.query("update origin_sync.raw_record set payload=jsonb_set(payload,'{xml}',to_jsonb('https://new-token.invalid'::text)),version_hash=$1 where entity='nfe'and source_id='1'",['b'.repeat(64)]);
 assert.ok(!(await candidates()).items.some(c=>c.entity==='nfe'&&c.source_id==='1'));
 await db.exec("update origin_sync.raw_record set payload=jsonb_set(payload,'{situacao}','2')where entity='nfe'and source_id='1'");
 assert.equal(await scalar("select origin_fiscal.fingerprint(payload)<>$1 value from origin_sync.raw_record where entity='nfe'and source_id='1'",[first.fingerprint]),true);
 await db.exec("delete from origin_sync.raw_record where not(entity='nfe'and source_id='1')");assert.equal((await candidates()).items.length,1);
 const again=await begin((await candidates()).items[0]);await finish(again,[meta]);assert.equal((await rpc('origin_sync_xml_status')).revisions,1);
 await db.exec("update origin_fiscal.source set next_attempt_at=clock_timestamp()-interval '1 second'");assert.equal((await candidates()).items.length,1);
});
test('027 finish is atomic across object set, retry is idempotent and changed bytes preserve immutable history',async()=>{
 await seed();const a=await begin((await candidates()).items[0]),inv=await object(invoice()),ev=await object(event(),'55',false);
 await assert.rejects(()=>finish(a,[inv,ev]),sqlError('55000'));assert.equal((await rpc('origin_sync_xml_status')).objects,0);assert.equal((await list()).items.length,0);
 await object(event());const result=await finish(a,[inv,ev]);assert.equal(result.files,2);assert.equal((await finish(a,[ev,inv])).replayed,true);
 await assert.rejects(()=>finish(a,[inv]),sqlError('40001'));assert.equal((await list()).items.length,2);
 await db.exec("update origin_fiscal.source set next_attempt_at=clock_timestamp()-interval '1 second'");const second=await begin((await candidates()).items[0]);const unchanged=await finish(second,[inv,ev]);assert.equal(unchanged.unchanged,true);assert.equal((await rpc('origin_sync_xml_status')).revisions,1);
 await db.exec("update origin_fiscal.source set next_attempt_at=clock_timestamp()-interval '1 second'");const third=await begin((await candidates()).items[0]),changed=await object(invoice('55',' NEW BYTES'));assert.equal((await finish(third,[changed,ev])).revision,2);
 assert.equal((await list()).items.length,2);assert.equal((await list({p_include_history:true})).items.length,4);const page=await list({p_include_history:true,p_limit:1});assert.equal(page.has_more,true);assert.equal(page.next_cursor,page.items[0].id);assert.ok((await list({p_include_history:true,p_after:page.next_cursor})).items.every(i=>i.id>page.next_cursor));
 const item=(await list()).items[0];assert.equal(item.authorization_verified,false);assert.equal(item.signature_verified,false);assert.equal(item.xsd_validated,false);assert.doesNotMatch(JSON.stringify(item),/object_key|private.invalid|payload|fingerprint/);
 const objectInfo=await rpc('erp_synced_xml_object',{p_user_id:users.fiscal,p_id:item.id});assert.equal(objectInfo.object_key,`objects/${item.xml_hash}.xml`);
 await db.query('update erp_access.membership set active=false where user_id=$1',[users.fiscal]);await assert.rejects(()=>rpc('erp_synced_xml_object',{p_user_id:users.fiscal,p_id:item.id}),sqlError('42501'));
});
test('027 expired scheduler cannot finalize or fail a successor, and malformed manifests cannot commit',async()=>{
 await seed();const c=(await candidates()).items[0],a=await begin(c),meta=await object(invoice());assert.equal((await begin(c)).attempt_id,a.attempt_id);
 await db.exec("update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second'where resource='__scheduler__'");await assert.rejects(()=>finish(a,[meta]),sqlError('55000'));
 const previous={owner,fence};owner=randomUUID();fence=(await rpc('origin_sync_claim',{p_resource:'__scheduler__',p_owner:owner,p_ttl_seconds:600})).lease_token;const next=await begin(c);assert.notEqual(next.attempt_id,a.attempt_id);
 await assert.rejects(()=>rpc('origin_sync_xml_finish',{p_owner:previous.owner,p_lease_token:previous.fence,p_attempt_id:a.attempt_id,p_documents:[meta]}),sqlError('55000'));
 for(const docs of[[{...meta,key:keyFor('65')}],[meta,meta],[{...meta,size:8388609}],[{...meta,protocol_present:false}],[{...meta,unexpected:true}]])await assert.rejects(()=>finish(next,docs),sqlError('22023'));
 assert.equal((await rpc('origin_sync_xml_status')).objects,0);await finish(next,[meta]);
});
test('027 failures remain retryable/blocked with redacted status and cannot publish unverified objects',async()=>{
 await seed();const a=await begin((await candidates()).items[0]);await rpc('origin_sync_xml_fail',{...leaseArgs(),p_attempt_id:a.attempt_id,p_code:'XML_KEY_MISMATCH',p_blocked:true,p_retry_seconds:86400});assert.equal((await candidates()).items.length,0);
 const status=await rpc('origin_sync_xml_status');assert.equal(status.states.blocked,1);assert.deepEqual(status.errors,[{code:'XML_KEY_MISMATCH',count:1}]);assert.doesNotMatch(JSON.stringify(status),new RegExp(keyFor('55')+'|private.invalid|source_id|credentials'));
 const stored=await object(invoice());await assert.rejects(()=>finish(a,[stored]),sqlError('55000'));
 await assert.rejects(()=>rpc('origin_sync_xml_fail',{...leaseArgs(),p_attempt_id:a.attempt_id,p_code:'Bearer SECRET'}),sqlError('22023'));
 await db.exec("update storage.buckets set public=true where id='origin-fiscal-xml'");await assert.rejects(candidates,sqlError('55000'));
});
test('027 A→B→A deduplicates bytes while preserving each immutable observation and original revision dates/status',async()=>{
 await seed();const inv=await object(invoice()),changed=await object(invoice('55',' CHANGED'));
 const first=await begin((await candidates()).items[0]);await finish(first,[inv]);const original=(await list()).items[0];
 await db.exec("update origin_sync.raw_record set payload=jsonb_set(payload,'{situacao}','2')");
 await finish(await begin((await candidates()).items[0]),[changed]);
 await db.exec("update origin_sync.raw_record set payload=jsonb_set(payload,'{situacao}','7')");
 const third=await begin((await candidates()).items[0]);const result=await finish(third,[inv]);
 assert.equal(result.unchanged,true);assert.equal(result.revision,1);assert.equal((await list({p_include_history:true})).items.length,2);
 const current=(await list()).items[0];assert.equal(current.collected_at,original.collected_at);assert.equal(current.source_status,'5');
 const observed=(await db.query("select source_status,result->>'revision' revision from origin_fiscal.attempt where state='stored'order by started_at")).rows;
 assert.deepEqual(observed,[{source_status:'5',revision:'1'},{source_status:'2',revision:'2'},{source_status:'7',revision:'1'}]);
 for(const table of['object','revision','item','attempt']){
  await assert.rejects(()=>db.exec('delete from origin_fiscal.'+table),sqlError('55000'));
 }
 await assert.rejects(()=>db.exec("update origin_fiscal.revision set source_status='9'"),sqlError('55000'));
 await assert.rejects(()=>db.exec("update origin_fiscal.object set size=size+1"),sqlError('55000'));
});
test('027 revision counter and strict metadata types fail without partial history',async()=>{
 await seed();const a=await begin((await candidates()).items[0]),meta=await object(invoice());
 for(const docs of[[{...meta,model:55}],[{...meta,protocol:123}],[{...meta,signature_present:false}],[{...meta,issues:['SIGNATURE_ABSENT']}]])await assert.rejects(()=>finish(a,docs),sqlError('22023'));
 await db.exec("update origin_fiscal.source set next_revision=2147483647");await assert.rejects(()=>finish(a,[meta]),sqlError('22023'));
 assert.equal((await rpc('origin_sync_xml_status')).objects,0);assert.equal((await list()).items.length,0);
});
