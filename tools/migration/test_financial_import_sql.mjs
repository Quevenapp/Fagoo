import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {before,after,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {seedFinancialImport} from '../qa/seed-financial-import.mjs';
import {parseFinancialImportRoute,executeFinancialImportRoute} from '../../workers/erp-api/src/financial-import.mjs';
import {checkedStoredFinancialImportBatch,checkedRecoveredFinancialImportBatch} from '../../apps/erp/src/lib/financial-import-read.ts';
import {captureFinancialImportRequest} from '../../apps/erp/src/lib/financial-import-request.ts';
let db,model,seed;const uid=randomUUID();
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;
async function rpc(name,args){const pairs=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${pairs.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,pairs.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}}
async function api(path,body){const route=await parseFinancialImportRoute(new Request('https://erp.invalid/v1/importacao-financeira-origin'+path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:undefined));return executeFinancialImportRoute(route,{userId:uid,rpc});}
const item=(entity,id)=>scalar("select jsonb_build_object('source_id',source_id,'source_hash',version_hash,'source_version',version::text,'source_seen_at',last_seen_at,'category_id',null,'category_version',null)v from origin_sync.raw_record where entity=$1 and source_id=$2",[entity,id]);
const request=async(entity,ids)=>({entity,duplicate_reviewed:true,items:await Promise.all(ids.map(id=>item(entity,id)))});
const native=(action,data)=>rpc('erp_finance_execute',{p_user_id:uid,p_command_id:randomUUID(),p_action:action,p_data:data});
async function variant(id,patch,amountLiteral=null){
 const original=await scalar("select payload v from origin_sync.raw_record where entity='receivables' and source_id='9390000001'");
 let text=JSON.stringify({...original,id,...patch});if(amountLiteral)text=text.replace('"valor":25.7',`"valor":${amountLiteral}`).replace('"saldo":25.7',`"saldo":${amountLiteral}`);
 await db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash,last_seen_at)values('receivables','qa_financial_import_039',$1,$2::jsonb,encode(sha256(convert_to($2::jsonb::text,'UTF8')),'hex'),clock_timestamp()-interval '1 minute')",[id,text]);
 const row=await item('receivables',id),attempt=randomUUID();
 await db.query("insert into origin_finance_refresh.origin(entity,source_id)values('receivables',$1)",[id]);
 await db.query("insert into origin_finance_refresh.attempt(id,entity,source_id,owner,fence,source_hash,source_seen_at,source_status,state,started_at,finished_at,response_status,result_hash,result_version)values($1,'receivables',$2,$3,$4,$5,$6,'1','stored',$6::timestamptz-interval '1 second',$6,'1',$5,1)",[attempt,id,randomUUID(),randomUUID(),row.source_hash,row.source_seen_at]);
 await db.query("update origin_finance_refresh.origin set current_attempt=$1,last_attempt_at=$3::timestamptz-interval '1 second',last_success_at=$3 where entity='receivables' and source_id=$2",[attempt,id,row.source_seen_at]);
 return row;
}
before(async()=>{
 model=await import('../../apps/erp/src/lib/financial-import-model.ts');
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
 for(const suffix of ['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0013_catalog_import_review','0014_erp_cnab','0017_document_finance','0018_document_stock','0019_document_effect_flags','0020_cutover_readiness','0030_origin_finance_refresh','0038_financial_cutover_review','0039_origin_financial_import'])await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${suffix}.sql`,import.meta.url),'utf8'));
 await db.query('insert into auth.users values($1)',[uid]);await db.query("insert into erp_access.membership(user_id,role)values($1,'admin')",[uid]);seed=await seedFinancialImport(db,{uid});
});
after(()=>db?.close());
test('039 actual SQL → HTTP → UI agrees on every synthetic eligibility scenario and source precision',async()=>{
 for(const fixture of seed.fixtures){const body=await request(fixture.entity,[fixture.id]);const result=await api('/preview',body);const parsed=model.checkedFinancialImportPreview(result,body);assert.equal(parsed.can_apply,fixture.expected==='eligible');assert.equal(parsed.creates_titles,true);}
 assert.equal(await scalar('select count(*)::int v from erp_finance.title'),0);
});
test('039 Unicode blank descriptions are blocked before any commit and 16-digit evidence stays readable',async()=>{
 for(const[id,description]of [['9391000001','\u00a0\u2000\uFEFF'],['9391000002','\u00a0Descrição sintética\u00a0']]){
  const row=await variant(id,{historico:description});const body={entity:'receivables',duplicate_reviewed:true,items:[row]},result=await api('/preview',body);
  model.checkedFinancialImportPreview(result,body);assert.equal(result.can_apply,id==='9391000002');
 }
 const big=await variant('9391000003',{},'99999999999999.99'),body={entity:'receivables',duplicate_reviewed:true,items:[big]},result=await api('/preview',body);
 assert.equal(result.items[0].evidence.amount_cents,'9999999999999999');assert.equal(result.can_apply,false);assert.equal(model.checkedFinancialImportPreview(result,body).can_apply,false);
});
test('039 mixed batch rejects all writes while SQL validation refuses coercion and hidden fields',async()=>{
 const body=await request('receivables',['9390000001','9390000004']),preview=await api('/preview',body),command=randomUUID();assert.equal(preview.can_apply,false);assert.equal(preview.summary.eligible,1);
 await assert.rejects(()=>api('/apply',{...body,command_id:command,preview_hash:preview.preview_hash,confirm_import:true}),e=>e.code==='40001');
 assert.equal(await scalar('select count(*)::int v from erp_finance.title'),0);assert.equal(await scalar('select count(*)::int v from erp_finance.command'),0);
 const valid=(await request('receivables',['9390000001'])).items;
 for(const mutate of[rows=>rows[0].source_version=1,rows=>rows[0].source_hash=['a'.repeat(64)],rows=>rows[0].source_seen_at='infinity',rows=>rows[0].money='2570',rows=>delete rows[0].category_version,rows=>rows[0].category_version=1,rows=>rows.push(rows[0])]){
  const rows=structuredClone(valid);mutate(rows);await assert.rejects(()=>rpc('erp_origin_financial_import_preview',{p_user_id:uid,p_entity:'receivables',p_items:rows,p_duplicate_reviewed:true}),e=>e.code==='22023');
 }
});
test('039 native readback separates historical receipt from current multiline/due2100/paid edits under 019',async()=>{
 const body=await request('receivables',['9390000001','9390000002']),preview=await api('/preview',body),apply={...body,command_id:randomUUID(),preview_hash:preview.preview_hash,confirm_import:true};
 const ack=await api('/apply',apply);model.checkedFinancialImportAck(ack,apply,preview);
 assert.deepEqual(captureFinancialImportRequest('/v1/importacao-financeira-origin/apply',{method:'POST',body:apply}).options.body,apply);
 let batch=await api('/batches/'+apply.command_id);model.checkedFinancialImportBatch(batch,apply,ack);
 const id=ack.batch.items[0].title_id;
 await native('title_update',{id,expected_version:1,description:'Descrição atual\nsegunda linha\ttexto',due_on:'2100-12-31'});
 const bank=(await native('account_save',{expected_version:0,name:'Conta sintética interop',kind:'bank'})).record;
 await native('settle',{id,expected_version:2,account_id:bank.id,posted_on:ack.batch.items[0].issued_on,principal_cents:ack.batch.items[0].amount_cents});
 batch=await api('/batches/'+apply.command_id);assert.equal(batch.current_titles[0].status,'paid');assert.equal(batch.current_titles[0].due_on,'2100-12-31');assert.match(batch.current_titles[0].description,/\n/);model.checkedFinancialImportBatch(batch,apply,ack);
 assert.deepEqual(checkedStoredFinancialImportBatch(batch,apply.command_id),batch);
 assert.deepEqual(checkedRecoveredFinancialImportBatch(batch,apply,preview,null),batch);
 assert.deepEqual(checkedRecoveredFinancialImportBatch(batch,apply,preview,ack),batch);
 const replay=await api('/apply',apply);assert.equal(replay.replayed,true);assert.deepEqual(replay.batch,ack.batch);assert.notEqual(replay.batch.items[0].description,batch.current_titles[0].description);
 const origin=await api('/origins/receivables/'+body.items[0].source_id);assert.equal(origin.current_title.status,'paid');assert.equal(origin.origin.title_id,id);
 assert.equal((await api('/titles/'+id+'/origin')).origin.core_fields_locked,true);
});
test('039 maximum batch total remains exact across SQL, HTTP and UI',async()=>{
 const rows=[];for(let i=0;i<25;i++)rows.push(await variant(String(9392000000+i),{},'9999999999999.99'));
 const body={entity:'receivables',duplicate_reviewed:true,items:rows},preview=await api('/preview',body);assert.equal(preview.summary.total_cents,'24999999999999975');model.checkedFinancialImportPreview(preview,body);
 const apply={...body,command_id:randomUUID(),preview_hash:preview.preview_hash,confirm_import:true},ack=await api('/apply',apply);model.checkedFinancialImportAck(ack,apply,preview);model.checkedFinancialImportBatch(await api('/batches/'+apply.command_id),apply,ack);
});
