import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {keyFor} from './xml-fixtures.mjs';
import {OriginApiError} from '../src/client.mjs';
import {collectXml} from '../src/xml-sync.mjs';
let db,owner,fence,nativeActor;const sqlError=code=>error=>error.code===code;
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
async function rpc(name,args={}){const pairs=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${pairs.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) value`,pairs.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}}
const lease=()=>({p_owner:owner,p_lease_token:fence});
const candidates=(limit=2)=>rpc('origin_sync_xml_candidates',{...lease(),p_limit:limit});
const begin=c=>rpc('origin_sync_xml_begin',{...lease(),p_entity:c.entity,p_source_id:c.source_id,p_key:c.key,p_fingerprint:c.fingerprint});
const fail=a=>rpc('origin_sync_xml_fail',{...lease(),p_attempt_id:a.attempt_id,p_code:'ORIGIN_HTTP_400',p_blocked:false,p_retry_seconds:3600});
const expire=()=>db.exec("update origin_fiscal.source set next_attempt_at=clock_timestamp()-interval '1 second'");
async function seed(model,id){await db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values($1,'xml_queue_seed',$2,$3::jsonb,$4)",[model==='55'?'nfe':'nfce',id,JSON.stringify({id,chaveAcesso:keyFor(model),situacao:5,xml:'https://private.invalid/DO_NOT_LOG',numero:1,valorNota:'25.70'}),'a'.repeat(64)]);}
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb);');
 for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0006_erp_catalog','0007_erp_history','0008_erp_documents','0027_origin_fiscal_archive','0031_xml_queue_fairness'])await db.exec(await readFile(new URL(`../../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
 await db.exec("insert into origin_sync.resource_state(resource)values('xml_queue_seed')");nativeActor=randomUUID();await db.query('insert into auth.users values($1)',[nativeActor]);await db.query("insert into erp_access.membership(user_id,role)values($1,'admin')",[nativeActor]);
 const contact=(await rpc('erp_catalog_save',{p_user_id:nativeActor,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Contato nativo fictício de controle'}})).record;
 await rpc('erp_document_save',{p_user_id:nativeActor,p_kind:'service_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-16',contact_id:contact.id,items:[],equipment:'Equipamento fictício preservado'}});
});
beforeEach(async()=>{await db.exec("truncate origin_fiscal.item,origin_fiscal.revision,origin_fiscal.object,origin_fiscal.attempt,origin_fiscal.source cascade;delete from origin_sync.raw_record;update storage.buckets set public=false;update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second' where lease_expires_at is not null;");owner=randomUUID();fence=(await rpc('origin_sync_claim',{p_resource:'__scheduler__',p_owner:owner,p_ttl_seconds:600})).lease_token;});
after(()=>db?.close());

test('031 recurring failures with expired backoff rotate behind unexamined NF-e without taking the NFC-e lane',async()=>{
 for(const id of ['1','2','3'])await seed('55',id);for(const id of ['1','2'])await seed('65',id);
 const examined=[];
 for(let cycle=0;cycle<4;cycle++){
  const page=(await candidates()).items;assert.deepEqual(page.map(c=>c.entity).sort(),['nfce','nfe']);
  examined.push(page.find(c=>c.entity==='nfe').source_id);
  for(const c of page)await fail(await begin(c));
  assert.ok((await candidates(10)).items.every(c=>!page.some(p=>p.entity===c.entity&&p.source_id===c.source_id)));
  // Simulate the next eligible cron without altering immutable attempt history.
  await expire();
 }
 assert.deepEqual(examined,['1','2','3','1']);
});
test('031 in-flight examinations count as attempts; greatest timestamp prevents stale last_checked from taking priority',async()=>{
 await seed('55','1');await seed('55','2');const all=(await candidates(10)).items;
 const second=await begin(all.find(c=>c.source_id==='2'));
 // Fixed relative gaps avoid relying on PGlite's millisecond wall-clock resolution.
 // Change only the pending test fixture; finalized observations remain immutable.
 await db.query("update origin_fiscal.attempt set started_at=clock_timestamp()-interval '4 days'where id=$1",[second.attempt_id]);
 await fail(second);await expire();
 await db.exec("update origin_fiscal.source set last_checked_at=clock_timestamp()-interval '3 days'where source_id='2'");
 const pending=await begin(all.find(c=>c.source_id==='1'));
 await db.query("update origin_fiscal.attempt set started_at=clock_timestamp()-interval '1 day'where id=$1",[pending.attempt_id]);
 assert.equal((await candidates(1)).items[0].source_id,'2');
 // A stale check cannot hide the more recent start of the still-pending attempt.
 await db.exec("update origin_fiscal.source set last_checked_at=clock_timestamp()-interval '2 days'where source_id='1'");
 assert.equal((await candidates(1)).items[0].source_id,'2');
 await seed('55','3');assert.equal((await candidates(1)).items[0].source_id,'3');
 // A later final examination dominates an older attempt start as well.
 await db.exec("update origin_fiscal.source set last_checked_at=clock_timestamp()+interval '1 second'where source_id='2'");
 const order=(await candidates(10)).items.map(c=>c.source_id);assert.deepEqual(order,['3','1','2']);
});
test('031 keeps fingerprint eligibility, limits, private ACL and scheduler fencing unchanged',async()=>{
 await seed('55','1');const first=(await candidates()).items[0];await fail(await begin(first));assert.equal((await candidates()).items.length,0);
 await db.exec("update origin_sync.raw_record set payload=jsonb_set(payload,'{situacao}','7')");assert.equal((await candidates()).items.length,1);
 for(const limit of [0,11,null])await assert.rejects(()=>candidates(limit),sqlError('22023'));
 for(const role of ['anon','authenticated'])assert.equal(await scalar("select has_function_privilege($1,'public.origin_sync_xml_candidates(uuid,uuid,integer)','EXECUTE')value",[role]),false);
 assert.equal(await scalar("select has_function_privilege('service_role','public.origin_sync_xml_candidates(uuid,uuid,integer)','EXECUTE')value"),true);
 await db.exec("update storage.buckets set public=true where id='origin-fiscal-xml'");await assert.rejects(candidates,sqlError('55000'));
 await db.exec("update storage.buckets set public=false;update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second'where resource='__scheduler__'");await assert.rejects(candidates,sqlError('55000'));
});
test('031 candidate selection and failure scheduling do not change native or raw payloads',async()=>{
 await seed('55','1');await seed('55','2');await seed('65','1');
 const tables=['origin_sync.raw_record','erp_catalog.record','erp_catalog.contact','erp_documents.document','erp_documents.item','erp_documents.audit','erp_documents.command','erp_documents.numbering'];
 const snapshot=()=>Promise.all(tables.map(table=>scalar(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]')value from ${table} t`)));
 const initial=await snapshot();for(const c of(await candidates()).items)await fail(await begin(c));await expire();await candidates(10);assert.deepEqual(await snapshot(),initial);
});
test('XML generic HTTP errors include only a validated status;400/404/422 wait one hour and keep JSON eligible',async()=>{
 const cases=[['ORIGIN_XML_DOCUMENT_UNAVAILABLE',400,'ORIGIN_XML_DOCUMENT_UNAVAILABLE',86400,false,false],['ORIGIN_HTTP_ERROR',400,'ORIGIN_HTTP_400',3600,false,false],['ORIGIN_HTTP_ERROR',404,'ORIGIN_HTTP_404',3600,false,false],['ORIGIN_NOT_FOUND',404,'ORIGIN_NOT_FOUND',3600,false,false],['ORIGIN_HTTP_ERROR',422,'ORIGIN_HTTP_422',3600,false,false],['ORIGIN_HTTP_ERROR',503,'ORIGIN_HTTP_503',300,false,false],['ORIGIN_SERVER_ERROR',500,'ORIGIN_SERVER_ERROR',300,false,false],['ORIGIN_UNAUTHORIZED',401,'ORIGIN_UNAUTHORIZED',300,false,true],['ORIGIN_FORBIDDEN',403,'ORIGIN_FORBIDDEN',86400,true,false],['ORIGIN_RATE_LIMITED',429,'ORIGIN_RATE_LIMITED',300,false,true],['ORIGIN_HTTP_ERROR','404','ORIGIN_HTTP_ERROR',300,false,false],['ORIGIN_HTTP_ERROR',999,'ORIGIN_HTTP_ERROR',300,false,false]];
 for(const [code,status,expected,retry,blocked,stop]of cases){
  const calls=[],attemptId=randomUUID(),candidate={entity:'nfe',source_id:'1',key:keyFor('55'),fingerprint:'a'.repeat(64)};
  const repo={async rpc(name,args){calls.push({name,args});if(name==='origin_sync_xml_candidates')return{items:[candidate]};if(name==='origin_sync_xml_begin')return{attempt_id:attemptId,...candidate};if(name==='origin_sync_xml_fail')return{recorded:true};throw new Error('Unexpected RPC');}};
  const error=new OriginApiError(code,{status});error.body='DO_NOT_LOG private body';error.url='https://private.invalid/DO_NOT_LOG';error.key=candidate.key;
  const client={requestsMade:0,remainingRequests:120,async get(){this.requestsMade++;throw error;}};
  const result=await collectXml(repo,client,{owner:randomUUID(),lease:{lease_token:randomUUID()},deadline:Date.now()+180000,storage:{async ensure(){assert.fail('No upload on HTTP failure');}}});
  const recorded=calls.find(c=>c.name==='origin_sync_xml_fail').args;assert.equal(recorded.p_code,expected);assert.equal(recorded.p_retry_seconds,retry);assert.equal(recorded.p_blocked,blocked);assert.equal(result.stop_json,stop);
  assert.equal(result.errors[0].code,expected);assert.doesNotMatch(JSON.stringify(result),new RegExp(`DO_NOT_LOG|https|${candidate.key}|source_id`));assert.equal(calls.filter(c=>c.name==='origin_sync_xml_finish').length,0);
 }
});
