// Synthetic PGlite fixture for migration 101 (Origin staging freshness, read only). No real data.
import{PGlite}from'@electric-sql/pglite';import{readFile,readdir}from'node:fs/promises';import{randomUUID}from'node:crypto';
import{bootstrap}from'../../../../tools/migration/helpers/stock-reservation-fixture.mjs';
export const FRESHNESS_MIGRATION='202610190101_origin_sync_freshness.sql';
const dir=new URL('../../../../supabase/migrations/',import.meta.url);
const sql=async name=>(await readFile(new URL(name,dir),'utf8')).replace(/\r\n/g,'\n');
let snapshot;
// Production order: every published migration (001-100), then 101 on top of the full chain.
const migrated=()=>snapshot??=(async()=>{const db=new PGlite();try{
 await db.exec(bootstrap);
 for(const name of(await readdir(dir)).filter(n=>/^20261(01[67]|019)\d{4}_.+\.sql$/.test(n)&&n!==FRESHNESS_MIGRATION).sort())await db.exec(await sql(name));
 await db.exec(await sql(FRESHNESS_MIGRATION));
 return await db.dumpDataDir('none');
}finally{await db.close();}})();
export async function freshnessFixture(){
 const db=new PGlite({loadDataDir:await migrated()});await db.waitReady;
 const scalar=async(text,args=[])=>(await db.query(text,args)).rows[0]?.v;
 const users=Object.fromEntries(['admin','inactive','consulta','vendas','financeiro','estoque','fiscal'].map(r=>[r,randomUUID()]));
 for(const[role,id]of Object.entries(users)){await db.query('insert into auth.users values($1)',[id]);await db.query('insert into erp_access.membership(user_id,role,active)values($1,$2,$3)',[id,role==='inactive'?'admin':role,role!=='inactive']);}
 const asRole=async(role,run)=>{await db.exec(`set role ${role}`);try{return await run();}finally{await db.exec('reset role');}};
 const rpc=(actor=users.admin)=>asRole('service_role',()=>scalar('select public.erp_origin_sync_freshness($1) v',[actor]));
 // Internal projection with an explicit clock, only reachable by the migration owner.
 const at=asOf=>scalar('select erp_integration.origin_sync_freshness($1::timestamptz) v',[asOf]);
 const state=async(resource,checkpoint,version=1)=>db.query('insert into origin_sync.resource_state(resource,checkpoint_version,checkpoint)values($1,$2,$3) on conflict(resource)do update set checkpoint_version=excluded.checkpoint_version,checkpoint=excluded.checkpoint',[resource,version,JSON.stringify(checkpoint)]);
 const entityOf=resource=>resource.replace(/_(?:deleted_)?(?:zero|positive|negative)$/,'').replace(/^nfe_.*/,'nfe').replace(/_(?:active|inactive|deleted|registered)$/,'');
 // One closing batch exactly as origin_sync_apply_batch records it: checkpoint before and after.
 const batch=async(resource,before,after,appliedAt)=>{await db.query('insert into origin_sync.resource_state(resource)values($1)on conflict do nothing',[resource]);
  await db.query("insert into origin_sync.batch_inbox(batch_id,resource,entity,owner,lease_token,request_hash,checkpoint_before,checkpoint_after,result,applied_at)values($1,$2,$3,$4,$5,repeat('c',64),$6,$7,'{}',$8)",[randomUUID(),resource,entityOf(resource),randomUUID(),randomUUID(),JSON.stringify(before),JSON.stringify(after),appliedAt]);};
 const raw=async(entity,id,{payload={},seen='2026-10-19T12:00:00Z',changed=seen}={})=>{await db.query("insert into origin_sync.resource_state(resource)values('synthetic_seed')on conflict do nothing");
  await db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash,last_seen_at,changed_at,first_seen_at)values($1,'synthetic_seed',$2,$3,repeat('a',64),$4,$5,$5)",[entity,id,JSON.stringify(payload),seen,changed]);};
 const reset=()=>db.exec("delete from origin_sync.batch_inbox;delete from origin_sync.raw_record;delete from origin_sync.credentials;delete from origin_sync.resource_state where resource not in('__oauth__')");
 // Every row the RPC can read, to prove a call changes nothing.
 const fingerprint=()=>scalar("select encode(sha256(convert_to(jsonb_build_object('raw',(select jsonb_agg(to_jsonb(r) order by entity,source_id) from origin_sync.raw_record r),'state',(select jsonb_agg(to_jsonb(r) order by resource) from origin_sync.resource_state r),'batch',(select jsonb_agg(to_jsonb(r) order by batch_id) from origin_sync.batch_inbox r),'credentials',(select jsonb_agg(to_jsonb(r)) from origin_sync.credentials r),'membership',(select jsonb_agg(to_jsonb(r) order by user_id) from erp_access.membership r))::text,'UTF8')),'hex') v");
 return{db,scalar,users,asRole,rpc,at,state,batch,raw,reset,fingerprint,close:()=>db.close()};
}
