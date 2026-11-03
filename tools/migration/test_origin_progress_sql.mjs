import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {before,after,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {integrationProgressResponse,executeIntegrationProgressRoute,parseIntegrationProgressRoute,PROGRESS_RESOURCES} from '../../workers/erp-api/src/integration-progress.mjs';
import {RESOURCES} from '../../workers/origin-sync/src/resources.mjs';
import {advanceWindow} from '../../workers/origin-sync/src/sync.mjs';
import {parseIntegrationSummary} from '../../apps/erp/src/lib/integration-progress-model.ts';
let db;const users={};
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
const denied=e=>e.code==='42501';
async function asRole(role,fn){await db.exec(`set role ${role}`);try{return await fn();}finally{await db.exec('reset role');}}
const summary=actor=>asRole('service_role',()=>scalar('select public.erp_origin_progress($1) value',[actor??users.admin]));
async function raw(entity,id,payload={},age=0){
 await db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash,last_seen_at)values($1,'synthetic_seed',$2,$3,repeat('a',64),now()-make_interval(secs=>$4))",[entity,id,JSON.stringify(payload),age]);
}
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb);alter table storage.objects enable row level security;');
 for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0005_origin_auxiliary_catalogs','0027_origin_fiscal_archive','0030_origin_finance_refresh','0031_xml_queue_fairness','0033_origin_progress'])
  await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
 for(const role of ['admin','consulta','vendas','financeiro','estoque','fiscal','inactive']){
  users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);
  await db.query('insert into erp_access.membership(user_id,role,active)values($1,$2,$3)',[users[role],role==='inactive'?'admin':role,role!=='inactive']);
 }
 await db.exec("insert into origin_sync.resource_state(resource)values('synthetic_seed')");
});
after(()=>db?.close());
test('033 requires service execution plus an active administrator; private helpers are inaccessible',async()=>{
 for(const who of ['anon','authenticated'])await assert.rejects(()=>asRole(who,()=>scalar('select public.erp_origin_progress($1) value',[users.admin])),denied);
 for(const who of ['consulta','vendas','financeiro','estoque','fiscal','inactive'])await assert.rejects(()=>summary(users[who]),denied);
 for(const actor of [null,randomUUID()])await assert.rejects(()=>asRole('service_role',()=>scalar('select public.erp_origin_progress($1) value',[actor])),denied);
 await assert.rejects(()=>asRole('service_role',()=>scalar("select erp_integration.safe_count('1') value")),denied);
 const result=await summary();assert.equal(result.entities.length,11);assert.equal(result.resources.length,22);assert.equal(result.last_run,null);
 assert.ok(result.entities.every(x=>x.records===0&&x.newest_observation===null));
 assert.equal(result.coverage_certified,false);assert.equal(result.runtime_configuration_known,false);
 assert.deepEqual(integrationProgressResponse(result),{...result,extra_resources:null});assert.deepEqual(parseIntegrationSummary(result),{...result,extra_resources:null});
 assert.deepEqual(PROGRESS_RESOURCES.map(x=>x[0]).sort(),RESOURCES.filter(x=>!x.extra).map(x=>x.id).sort());
});
test('counts reflect canonical records and observation range, never payloads or business identifiers',async()=>{
 await raw('contacts','999888777',{nome:'PRIVATE_NAME_DO_NOT_EXPOSE',token:'PRIVATE_TOKEN'},7200);
 await raw('contacts','999888776',{url:'https://private.invalid'},600);
 const result=await summary(),row=result.entities.find(x=>x.entity==='contacts');
 assert.equal(row.records,2);assert.ok(Date.parse(row.oldest_observation)<Date.parse(row.newest_observation));
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|999888777|private.invalid|payload|source_id|lease_token|ciphertext/);
 assert.deepEqual(parseIntegrationSummary(result),integrationProgressResponse(result));
});
test('checkpoint passages stay distinct from open cursors; unknown resources and private cursor values never escape',async()=>{
 const checkpoint={recentCompletedAt:'2026-10-16 09:30:00',historyCompletedAt:'2026-09-30 23:59:59',history:{from:'2020-01-01',page:99,secret:'PRIVATE_CURSOR'},recent:{page:2}};
 await db.query("insert into origin_sync.resource_state(resource,checkpoint_version,checkpoint)values('contacts',1,$1),('private_extra',1,$1)",[JSON.stringify(checkpoint)]);
 await db.query("insert into origin_sync.resource_state(resource,checkpoint_version,checkpoint)values('contacts_deleted',1,$1)",[JSON.stringify({unfilteredCompletedAt:'2026-10-15 14:00:00',unfiltered:{page:3}})]);
 const result=await summary(),r=result.resources.find(x=>x.resource==='contacts');
 assert.equal(r.history_completed_local,'2026-09-30 23:59:59');assert.equal(r.history_open,true);assert.equal(r.recent_open,true);assert.equal(result.coverage_certified,false);
 assert.equal(result.resources.find(x=>x.resource==='contacts_deleted').sweep_open,true);
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE_CURSOR|private_extra|2020-01-01|"page":99/);
 assert.deepEqual(parseIntegrationSummary(result),integrationProgressResponse(result));
});
test('run metadata is a bounded allowlisted projection; absent or malformed fields remain unknown',async()=>{
 const run={status:'completed',startedAt:'2026-10-16T09:30:00Z',finishedAt:'2026-10-16T09:35:00Z',pages:10,records:100,requests:45,
  errors:[{source_id:'PRIVATE_ID',message:'PRIVATE_ERROR',code:'https://private.invalid'}],
  xml:{status:'partial',files:2,requests:4,errors:[]},finance_refresh:{status:'skipped_budget',attempted:1,stored:1,requests:3,errors:[]}};
 await db.query("insert into origin_sync.resource_state(resource,checkpoint)values('__scheduler__',$1) on conflict(resource)do update set checkpoint=excluded.checkpoint",[JSON.stringify({lastRun:run})]);
 const result=await summary();assert.equal(result.last_run.status,'completed');assert.equal(result.last_run.error_count,1);assert.equal(result.last_xml_run.files,2);assert.equal(result.last_xml_run.records,null);
 assert.equal(result.last_finance_run.status,'skipped_budget');assert.equal(result.coverage_certified,false);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|private.invalid/);
 assert.deepEqual(integrationProgressResponse(result),{...result,extra_resources:null});
 await db.query("update origin_sync.resource_state set checkpoint=$1 where resource='__scheduler__'",[JSON.stringify({lastRun:{status:'PRIVATE_STATUS',startedAt:'2026-02-30T00:00:00Z',requests:'PRIVATE_SECRET',pages:-1,errors:{private:'payload'}}})]);
 const invalid=await summary();assert.equal(invalid.last_run.status,'unknown');assert.equal(invalid.last_run.started_at,null);assert.equal(invalid.last_run.pages,null);assert.equal(invalid.last_run.requests,null);assert.equal(invalid.last_run.error_count,null);
 assert.doesNotMatch(JSON.stringify(invalid),/PRIVATE_|"private"/);parseIntegrationSummary(integrationProgressResponse(invalid));
});
test('033 completion timestamps describe the closing cycle, never the queried date range',async()=>{
 const cp=advanceWindow({cp:{version:1},lane:'history',cursor:{from:'2026-09-01 00:00:00',to:'2026-10-01 00:00:00',cutoff:'2026-10-01 00:00:00',page:2}},0,'2026-10-16 12:00:00');
 assert.equal(cp.historyCompletedAt,'2026-10-16 12:00:00');
 await db.query("update origin_sync.resource_state set checkpoint=$1,updated_at='2026-10-17T00:00:00Z' where resource='contacts'",[JSON.stringify(cp)]);
 const result=integrationProgressResponse(await summary()),r=result.resources.find(x=>x.resource==='contacts');
 assert.equal(r.history_completed_local,'2026-10-16 12:00:00');assert.equal(r.history_open,false);
 assert.equal(Date.parse(r.state_updated_at),Date.parse('2026-10-17T00:00:00Z'));assert.equal(r.history_through_local,undefined);assert.equal(r.checkpoint_at,undefined);
 assert.equal(result.coverage_certified,false);parseIntegrationSummary(result);
 const component=await readFile(new URL('../../apps/erp/src/components/IntegrationProgress.tsx',import.meta.url),'utf8');
 assert.match(component,/Histórica encerrada em/);assert.match(component,/limite de dados consultado não está disponível/);
});
test('XML counts include never-attempted current origins and keep preserved bytes separate from retry states',async()=>{
 const key55=n=>'0'.repeat(20)+'55'+'0'.repeat(20)+String(n).padStart(2,'0');
 for(const n of [1,2,3])await raw('nfe',String(700+n),{chaveAcesso:key55(n)});
 await raw('nfce','800',{chaveAcesso:'INVALID_PRIVATE_KEY'});
 const source=await scalar("insert into origin_fiscal.source(entity,source_id,access_key,state,last_success_at,next_attempt_at)values('nfe','701',$1,'retry',now()-interval '1 hour',now()+interval '1 hour')returning id value",[key55(1)]);
 const revision=await scalar("insert into origin_fiscal.revision(source,revision,manifest_hash)values($1,1,repeat('a',64))returning id value",[source]);
 await db.query('update origin_fiscal.source set current_revision=$1 where id=$2',[revision,source]);
 await db.query("insert into origin_fiscal.source(entity,source_id,access_key,state)values('nfe','702',$1,'blocked')",[key55(2)]);
 await db.exec("insert into origin_fiscal.object(hash,size,metadata)values(repeat('b',64),10,'{}')");
 const result=integrationProgressResponse(await summary()),x=result.xml;
 assert.equal(x.known_origins,4);assert.equal(x.eligible_origins,3);assert.equal(x.without_valid_key,1);assert.equal(x.with_preserved_revision,1);assert.equal(x.without_preserved_revision,2);assert.equal(x.never_attempted,1);
 assert.equal(x.retry_origins,1);assert.equal(x.blocked_origins,1);assert.equal(x.backing_off,1);assert.equal(x.preserved_objects,1);assert.equal(x.preserved_revisions,1);assert.equal(x.authorization_verified,false);
 assert.doesNotMatch(JSON.stringify(result),new RegExp(key55(1)));assert.doesNotMatch(JSON.stringify(result),/INVALID_PRIVATE_KEY/);parseIntegrationSummary(result);
});
test('AP/AR counters do not infer zero or settlement from missing saldo and do not mutate staging or ERP',async()=>{
 await raw('receivables','900',{situacao:1,saldo:null},7200);await raw('receivables','901',{situacao:'3',saldo:1.23},60);await raw('receivables','902',{situacao:2,saldo:0},7200);
 await raw('payables','903',{situacao:1},7200);
 await db.query("insert into origin_finance_refresh.origin(entity,source_id,last_success_at,next_attempt_at)values('receivables','900',now()-interval '3 hours',now()+interval '1 hour')");
 await db.exec("update origin_finance_refresh.entity_state set retry_after=now()+interval '1 day' where entity='payables'");
 const before=await scalar('select jsonb_agg(to_jsonb(r) order by entity,source_id) value from origin_sync.raw_record r');
 const result=integrationProgressResponse(await summary()),ar=result.finance_refresh.entities.find(x=>x.entity==='receivables'),ap=result.finance_refresh.entities.find(x=>x.entity==='payables');
 assert.equal(ar.known_open_partial,2);assert.equal(ar.observed_over_hour_ago,1);assert.equal(ar.unavailable_balance,1);assert.equal(ar.backing_off,1);assert.equal(ap.unavailable_balance,1);assert.ok(ap.retry_after);
 assert.equal(result.erp_mutations,false);assert.deepEqual(result.finance_refresh.reference_limits,{max_ids:8,max_seconds:40,max_attempts:24,shared_requests:120,observation_age_seconds:3600});
 assert.deepEqual(await scalar('select jsonb_agg(to_jsonb(r) order by entity,source_id) value from origin_sync.raw_record r'),before);
 parseIntegrationSummary(result);
});
test('HTTP binds the verified actor to the fixed RPC and strips upstream private additions',async()=>{
 const route=parseIntegrationProgressRoute(new Request('https://erp.invalid/v1/integracao-origin'));
 let calls=0;const output=await executeIntegrationProgressRoute(route,{userId:users.admin.toUpperCase(),rpc:async(name,args)=>{calls++;assert.equal(name,'erp_origin_progress');assert.deepEqual(args,{p_user_id:users.admin});return{...await summary(),private:'SECRET'};}});
 assert.equal(calls,1);assert.equal(output.private,undefined);
 for(const method of ['POST','PATCH','DELETE'])assert.throws(()=>parseIntegrationProgressRoute(new Request('https://erp.invalid/v1/integracao-origin',{method})),e=>e.status===405);
 for(const query of ['?user_id=anything','?limit=25','?resource=contacts','?x=1&x=2'])assert.throws(()=>parseIntegrationProgressRoute(new Request(`https://erp.invalid/v1/integracao-origin${query}`)),e=>e.status===400);
 await assert.rejects(()=>executeIntegrationProgressRoute(route,{userId:'bad',rpc:()=>{throw Error('must not call');}}),e=>e.status===401);
 const reject=async mutate=>{const v=await summary();mutate(v);assert.throws(()=>integrationProgressResponse(v),e=>e.status===502);assert.throws(()=>parseIntegrationSummary(v));};
 await reject(v=>v.role='consulta');await reject(v=>v.coverage_certified=true);await reject(v=>v.entities.pop());await reject(v=>v.entities[0].records=-1);
 await reject(v=>v.xml.without_preserved_revision++);await reject(v=>v.xml.authorization_verified=true);await reject(v=>v.finance_refresh.reference_limits.shared_requests=999);
 await reject(v=>v.resources[0].resource='PRIVATE_RESOURCE');await reject(v=>v.last_run.status='PRIVATE_STATUS');
});
