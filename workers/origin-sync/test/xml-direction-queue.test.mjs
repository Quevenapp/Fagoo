import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {keyFor} from './xml-fixtures.mjs';

let db,owner,fence;
const sqlError=code=>error=>error.code===code;
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
async function rpc(name,args={}){
 const pairs=Object.entries(args);await db.exec('set role service_role');
 try{return await scalar(`select public.${name}(${pairs.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) value`,pairs.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));}
 finally{await db.exec('reset role');}
}
const lease=()=>({p_owner:owner,p_lease_token:fence});
const candidates=(limit=2)=>rpc('origin_sync_xml_candidates',{...lease(),p_limit:limit});
const begin=c=>rpc('origin_sync_xml_begin',{...lease(),p_entity:c.entity,p_source_id:c.source_id,p_key:c.key,p_fingerprint:c.fingerprint});
const fail=a=>rpc('origin_sync_xml_fail',{...lease(),p_attempt_id:a.attempt_id,p_code:'ORIGIN_HTTP_400',p_blocked:false,p_retry_seconds:3600});
async function seed(model,id,direction){
 const payload={id,chaveAcesso:keyFor(model),situacao:7,xml:'https://private.invalid/DO_NOT_LOG',numero:1,valorNota:'25.70'};
 if(direction!==undefined)payload.tipo=direction;
 await db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values($1,'xml_direction_seed',$2,$3::jsonb,$4)",[model==='55'?'nfe':'nfce',id,JSON.stringify(payload),'a'.repeat(64)]);
}
before(async()=>{
 db=new PGlite();
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb);');
 for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0006_erp_catalog','0007_erp_history','0008_erp_documents','0027_origin_fiscal_archive','0031_xml_queue_fairness','0037_xml_direction_fairness'])await db.exec(await readFile(new URL(`../../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
 await db.exec("insert into origin_sync.resource_state(resource)values('xml_direction_seed')");
 const actor=randomUUID();await db.query('insert into auth.users values($1)',[actor]);await db.query("insert into erp_access.membership(user_id,role)values($1,'admin')",[actor]);
 const contact=(await rpc('erp_catalog_save',{p_user_id:actor,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Contato nativo fictício de controle'}})).record;
 await rpc('erp_document_save',{p_user_id:actor,p_kind:'service_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-16',contact_id:contact.id,items:[],equipment:'Equipamento fictício preservado'}});
});
beforeEach(async()=>{
 await db.exec("truncate origin_fiscal.item,origin_fiscal.revision,origin_fiscal.object,origin_fiscal.attempt,origin_fiscal.source cascade;delete from origin_sync.raw_record;update storage.buckets set public=false;update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second'where lease_expires_at is not null");
 owner=randomUUID();fence=(await rpc('origin_sync_claim',{p_resource:'__scheduler__',p_owner:owner,p_ttl_seconds:600})).lease_token;
});
after(()=>db?.close());

test('037 many low-ID inputs cannot starve high-ID outputs; each model keeps one candidate per cycle',async()=>{
 for(const model of ['55','65']){
  for(let i=1;i<=20;i++)await seed(model,String(i).padStart(3,'0'),0);
  for(const id of ['900','901'])await seed(model,id,1);
 }
 const seen={nfe:[],nfce:[]};
 for(let cycle=0;cycle<4;cycle++){
  const page=(await candidates()).items;assert.deepEqual(page.map(c=>c.entity),['nfce','nfe']);
  for(const c of page){seen[c.entity].push(c.source_id);await fail(await begin(c));}
 }
 assert.deepEqual(seen.nfe,['001','900','002','901']);assert.deepEqual(seen.nfce,seen.nfe);
 // All prior failures remain in backoff. They still count toward direction activity.
 assert.equal(await scalar('select count(*)::int value from origin_fiscal.source where next_attempt_at>clock_timestamp()'),8);
 assert.deepEqual((await candidates()).items.map(c=>c.source_id),['003','003']);
});

test('037 residual limit four keeps both models and directions after the original two exams',async()=>{
 for(const model of ['55','65'])for(const [id,direction] of [['1',0],['2',0],['900',1],['901',1]])await seed(model,id,direction);
 const first=(await candidates(2)).items;
 for(const c of first)await fail(await begin(c));
 const residual=(await candidates(4)).items;
 assert.equal(residual.length,4);
 for(const entity of ['nfe','nfce']){
  const rows=residual.filter(c=>c.entity===entity);assert.equal(rows.length,2);assert.deepEqual(rows.map(c=>c.source_id),['900','2']);
 }
 const examined=new Set(first.map(c=>`${c.entity}/${c.source_id}/${c.key}`));
 assert.ok(residual.every(c=>!examined.has(`${c.entity}/${c.source_id}/${c.key}`)));
 for(const c of residual)await fail(await begin(c));
 assert.equal(await scalar('select count(*)::int value from origin_fiscal.attempt'),6);
 assert.equal(await scalar('select count(*)::int value from origin_fiscal.object'),0);
 assert.equal(await scalar('select count(*)::int value from erp_documents.document'),1);
});

test('037 only exact number/string 0 and 1 select a known direction; unknown rows remain eligible',async()=>{
 const values=[0,'0',1,'1',undefined,null,{},[],true,'01'];
 for(let i=0;i<values.length;i++)await seed('55',String(i+1).padStart(2,'0'),values[i]);
 const page=(await candidates(10)).items;
 assert.deepEqual(page.map(c=>c.source_id),['01','03','05','02','04','06','07','08','09','10']);
 for(const c of page)assert.deepEqual(Object.keys(c).sort(),['entity','fingerprint','key','source_id']);
 for(const expected of ['01','03','05']){const c=(await candidates(1)).items[0];assert.equal(c.source_id,expected);await fail(await begin(c));}
 assert.equal((await candidates(1)).items[0].source_id,'02');
});

test('037 pending starts contribute to direction activity and preserve the original attempt replay',async()=>{
 for(const id of ['1','2'])await seed('55',id,0);for(const id of ['900','901'])await seed('55',id,1);
 const first=(await candidates(1)).items[0],attempt=await begin(first);
 assert.equal((await begin(first)).attempt_id,attempt.attempt_id);
 await db.exec("update origin_fiscal.source set last_checked_at=clock_timestamp()-interval '2 days'where source_id='1'");
 const output=(await candidates(1)).items[0];assert.equal(output.source_id,'900');await begin(output);
 assert.equal((await candidates(1)).items[0].source_id,'2');
 // A newer completed check also dominates an older start in its direction.
 await db.exec("update origin_fiscal.source set last_checked_at=clock_timestamp()+interval '1 day'where source_id='1'");
 assert.equal((await candidates(1)).items[0].source_id,'901');
 assert.equal(await scalar('select count(*)::int value from origin_fiscal.attempt'),2);
});

test('037 expired failures rotate by direction and oldest examination, not low source ID',async()=>{
 await seed('55','1',0);await seed('55','2',0);await seed('55','900',1);
 const examined=[];
 for(let i=0;i<6;i++){
  const c=(await candidates(1)).items[0];examined.push(c.source_id);await fail(await begin(c));
  await db.exec("update origin_fiscal.source set next_attempt_at=clock_timestamp()-interval '1 second'");
 }
 assert.deepEqual(examined,['1','900','2','900','1','900']);
});

test('037 fingerprint changes still bypass backoff; ordinary changes and invalid keys do not',async()=>{
 await seed('55','1',0);const first=(await candidates()).items[0];await fail(await begin(first));
 assert.deepEqual((await candidates()).items,[]);
 await db.exec("update origin_sync.raw_record set payload=jsonb_set(payload,'{xml}','\"https://changed.invalid/private\"')");
 assert.deepEqual((await candidates()).items,[]);
 await db.exec("update origin_sync.raw_record set payload=jsonb_set(payload,'{situacao}','5')");
 const changed=(await candidates()).items[0];assert.equal(changed.source_id,'1');assert.notEqual(changed.fingerprint,first.fingerprint);
 await seed('65','2',1);await seed('55','3',1);
 await db.exec("update origin_sync.raw_record set payload=jsonb_set(payload,'{chaveAcesso}','\"bad\"')where source_id='3';update origin_sync.raw_record set payload=jsonb_set(payload,'{chaveAcesso}',to_jsonb(repeat('1',44)))where source_id='2'");
 assert.deepEqual((await candidates(10)).items.map(c=>c.source_id),['1']);
});

test('037 ACL, fencing, private storage, limits, and exact source ID are unchanged',async()=>{
 await seed('55','0001',0);await seed('55','1',1);assert.deepEqual((await candidates(10)).items.map(c=>c.source_id),['0001','1']);
 for(const limit of [0,11,null])await assert.rejects(()=>candidates(limit),sqlError('22023'));
 for(const role of ['anon','authenticated'])assert.equal(await scalar("select has_function_privilege($1,'public.origin_sync_xml_candidates(uuid,uuid,integer)','EXECUTE')value",[role]),false);
 assert.equal(await scalar("select has_function_privilege('service_role','public.origin_sync_xml_candidates(uuid,uuid,integer)','EXECUTE')value"),true);
 await assert.rejects(()=>rpc('origin_sync_xml_candidates',{...lease(),p_owner:randomUUID(),p_limit:2}),sqlError('55000'));
 await db.exec("update storage.buckets set public=true where id='origin-fiscal-xml'");await assert.rejects(candidates,sqlError('55000'));
 await db.exec("update storage.buckets set public=false;update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second'where resource='__scheduler__'");await assert.rejects(candidates,sqlError('55000'));
});

test('037 candidate ranking and attempted examinations do not write raw or native records',async()=>{
 for(const model of ['55','65'])for(const[id,direction]of[['1',0],['2',0],['900',1]])await seed(model,id,direction);
 const tables=['origin_sync.raw_record','erp_catalog.record','erp_catalog.contact','erp_documents.document','erp_documents.item','erp_documents.audit','erp_documents.command','erp_documents.numbering'];
 const snapshot=()=>Promise.all(tables.map(table=>scalar(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]')value from ${table} t`)));
 const initial=await snapshot();
 for(let i=0;i<2;i++)for(const c of(await candidates()).items)await fail(await begin(c));
 await candidates(10);assert.deepEqual(await snapshot(),initial);
 assert.doesNotMatch(JSON.stringify(await candidates(10)),/DO_NOT_LOG|https|payload|situacao|valorNota|direction/);
});
