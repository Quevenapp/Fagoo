import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {historyFixture} from '../../../erp-api/test/helpers/sales-history-fixture.mjs';
import {parseSalesPriceJson,salesPriceCapture} from '../../src/sales-price-json.mjs';
export async function salesRefreshFixture(){
 const f=await historyFixture();try{
  await f.db.exec(await readFile(new URL('../../../../supabase/migrations/202610160084_itau_legacy_readiness.sql',import.meta.url),'utf8'));
  const beforeFunctions=await f.scalar("select jsonb_agg(to_jsonb(p)order by oid)v from pg_proc p where pronamespace in(select oid from pg_namespace where nspname like 'erp_%'or nspname in('public','origin_sync','origin_backup','origin_reference_fetch'))");
  const beforeRows=await f.fingerprint(),beforeSecurity=await f.security();
  await f.db.exec(await readFile(new URL('../../../../supabase/migrations/202610160085_origin_sales_price_refresh.sql',import.meta.url),'utf8'));
  const owner=randomUUID();let identity;
  const claim=(r,o=owner)=>f.rpc('origin_sync_claim',{p_resource:r,p_owner:o,p_ttl_seconds:600});
  const acquire=async(o=owner)=>{const scheduler=await claim('__scheduler__',o),resource=await claim('sales_orders',o);if(!scheduler.acquired||!resource.acquired)throw new Error('SYNTHETIC_LEASE_BUSY');return identity={p_owner:o,p_lease_token:scheduler.lease_token,p_resource_token:resource.lease_token};};
  await f.db.exec("insert into origin_sync.resource_state(resource,checkpoint)values('sales_orders','{\"page\":31,\"window\":{\"from\":\"2026-10-01\",\"to\":\"2026-10-17\"}}')on conflict(resource)do update set checkpoint=excluded.checkpoint");await acquire();
  const call=(name,args={},ids=identity)=>f.rpc('origin_sync_sales_price_'+name,{...ids,...args});
  const raw=id=>f.scalar("select to_jsonb(r)v from origin_sync.raw_record r where entity='sales_orders'and source_id=$1",[id]);
  const candidate=async id=>{const r=await raw(id);return{source_id:id,source_hash:r.version_hash,source_version:String(r.version),source_seen_at:r.last_seen_at};};
  const begin=async(id,attempt=randomUUID())=>{const c=await candidate(id),args={p_attempt_id:attempt,...Object.fromEntries(Object.entries(c).map(([k,v])=>['p_'+k,v]))};return{args,result:await call('begin',args),identity:{...identity}};};
  const detail=async(id,token='99999999.1234567891',extra='')=>{const text=`{"data":{"id":"${id}","itens":[{"valor":${token}}]${extra}}}`,p=await parseSalesPriceJson(text,new TextEncoder().encode(text),'sales_detail');return{p_payload:p.data,p_price_capture:salesPriceCapture(p.data)};};
  const finish=async(job,body)=>call('finish',{p_attempt_id:job.args.p_attempt_id,...(body??await detail(job.args.p_source_id))},job.identity);
  const cp=()=>f.scalar("select jsonb_build_object('checkpoint',checkpoint,'version',checkpoint_version::text)v from origin_sync.resource_state where resource='sales_orders'");
  const historical=()=>f.scalar("select jsonb_build_object('snapshots',(select coalesce(jsonb_agg(to_jsonb(h)order by source_id),'[]')from erp_sales_history.snapshot h),'commands',(select coalesce(jsonb_agg(to_jsonb(c)order by command_id),'[]')from erp_sales_history.command c))v");
  return{...f,owner,acquire,call,raw,candidate,begin,detail,finish,cp,historical,beforeFunctions,beforeRows,beforeSecurity,get identity(){return identity;}};
 }catch(e){await f.close();throw e;}
}
