/** Local embedded QA only. Aggregated panel examples; no network or Storage writes. */
import {PGlite} from '@electric-sql/pglite';
import {createHash} from 'node:crypto';
import {buildAccessKey} from '../../packages/fiscal-core/src/identity.mjs';
import {identity} from '../../workers/origin-sync/test/xml-fixtures.mjs';

const marker='qa_integration_progress';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso=milliseconds=>new Date(milliseconds).toISOString();
/** Requires seedSyncedXml and migration033. Repeating this fixture fails without changes. */
export async function seedIntegrationProgress(db){
 if(!(db instanceof PGlite))throw new TypeError('Synthetic integration seed requires embedded PGlite');
 const now=Date.now(),hour=3600000;
 await db.exec('begin');
 try{
  if((await db.query('select exists(select 1 from origin_sync.resource_state where resource=$1) present',[marker])).rows[0].present)throw new Error('Synthetic integration fixture already exists');
  if(!(await db.query("select to_regprocedure('public.erp_origin_progress(uuid)') is not null ready")).rows[0].ready)throw new Error('Synthetic integration fixture requires migration033');
  const sources=(await db.query("select id,entity,source_id,access_key from origin_fiscal.source where id in('d2700000-0000-4000-8000-000000000001','d2700000-0000-4000-8000-000000000002','d2700000-0000-4000-8000-000000000003','d2700000-0000-4000-8000-000000000004','d2700000-0000-4000-8000-000000000005','d2700000-0000-4000-8000-000000000006') order by source_id")).rows;
  if(sources.length!==6)throw new Error('Synthetic integration fixture requires the XML fixture');
  await db.query('insert into origin_sync.resource_state(resource)values($1)',[marker]);
  const raw=async(entity,source,payload,seen)=>{
   await db.query('insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash,last_seen_at)values($1,$2,$3,$4::jsonb,$5,$6::timestamptz)',[entity,marker,source,JSON.stringify(payload),hash(payload),seen]);
  };
  for(const row of sources){
   await raw(row.entity,row.source_id,{id:row.source_id,chaveAcesso:row.access_key,situacao:5,synthetic_qa:true},iso(now-300000));
  }
  await db.query("update origin_fiscal.source set state='retry',last_checked_at=$1::timestamptz,next_attempt_at=$2::timestamptz,last_error='ORIGIN_HTTP_400' where id=$3",[iso(now-60000),iso(now+hour),sources[0].id]);
  await db.query("update origin_fiscal.source set state='blocked',last_checked_at=$1::timestamptz,next_attempt_at=$2::timestamptz,last_error='ORIGIN_HTTP_403' where id=$3",[iso(now-60000),iso(now+24*hour),sources[1].id]);
  for(const [index,model]of ['55','65'].entries()){
   const source=String(9733000001+index),key=buildAccessKey({...identity(model),environment:'2',number:String(301+index)});
   await raw(model==='55'?'nfe':'nfce',source,{id:source,chaveAcesso:key,situacao:5,synthetic_qa:true},iso(now-2*hour));
  }
  await raw('nfe','9733000003',{id:'9733000003',chaveAcesso:'QA_SEM_CHAVE_VALIDA',situacao:1,synthetic_qa:true},iso(now-hour));
  for(let i=0;i<12;i++){
   const entity=i%2?'payables':'receivables',source=String(9733100001+i),successful=i<8;
   const payload={id:source,situacao:i%3===0?3:1,...(i===10?{}:{saldo:i===11?null:100}),synthetic_qa:true};
   await raw(entity,source,payload,iso(now-(successful?300000:3*hour)));
   if(successful)await db.query('insert into origin_finance_refresh.origin(entity,source_id,last_attempt_at,last_success_at)values($1,$2,$3::timestamptz,$3::timestamptz)',[entity,source,iso(now-300000)]);
   else if(i===9)await db.query("insert into origin_finance_refresh.origin(entity,source_id,last_attempt_at,next_attempt_at,failures,last_error)values($1,$2,$3::timestamptz,$4::timestamptz,1,'ORIGIN_HTTP_404')",[entity,source,iso(now-hour),iso(now+hour)]);
  }
  const state=async(resource,checkpoint)=>db.query('insert into origin_sync.resource_state(resource,checkpoint,checkpoint_version,updated_at)values($1,$2::jsonb,1,$3::timestamptz)on conflict(resource)do update set checkpoint=excluded.checkpoint,checkpoint_version=origin_sync.resource_state.checkpoint_version+1,updated_at=excluded.updated_at',[resource,JSON.stringify(checkpoint),iso(now-60000)]);
  await state('__scheduler__',{nextIndex:7,lastRun:{status:'partial',startedAt:iso(now-180000),finishedAt:iso(now-60000),pages:10,records:100,requests:105,
   errors:[{resource:'nfe_in',code:'ORIGIN_HTTP_400'}],xml:{status:'partial',keys:2,files:1,unchanged:0,requests:4,errors:[{code:'ORIGIN_HTTP_400'}]},
   finance_refresh:{status:'completed',attempted:8,stored:8,unchanged:3,conflicts:0,unavailable_balance:0,requests:8,errors:[],stop_json:false}}});
  await state('contacts',{version:1,recentCompletedAt:'2026-10-16 03:00:00',historyCompletedAt:'2026-10-15 22:00:00',nextLane:'history',history:{from:'2024-02-01 00:00:00',to:'2024-03-02 00:00:00',cutoff:'2026-10-15 21:00:00',page:2}});
  await state('products_zero',{version:1,recent:{from:'2026-09-16 03:00:00',to:'2026-10-16 03:00:00',cutoff:'2026-10-16 03:00:00',page:4},nextLane:'history'});
  await state('contacts_deleted',{version:1,unfilteredCompletedAt:'2026-10-15 20:00:00',unfiltered:{page:2},nextLane:'recent'});
  await state('nfe_in',{version:1,recentCompletedAt:'2026-10-16 02:00:00',nextLane:'history',history:{from:'2024-06-01 00:00:00',to:'2024-07-01 00:00:00',cutoff:'2026-10-15 23:00:00',page:1}});
  await db.exec('commit');
  return{synthetic:true,linked_xml_origins:6,xml_without_attempt:2,xml_invalid_key:1,finance_examples:12,last_finance_run_successes:8,storage_mutations:0};
 }catch(error){await db.exec('rollback');throw error;}
}
