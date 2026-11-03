// Production through 410 (same complete migration chain as documentos-h), then the stock mirror only.
import { documentosHFixture } from './documentos-h-fixture.mjs';
export const STOCK_MIRROR_MIGRATION='202610220001_stock_origin_mirror.sql';
export async function stockMirrorFixture({migrate=true}={}) {
 const f=await documentosHFixture();
 try {
  if(migrate)await f.migrate(STOCK_MIRROR_MIGRATION);
  const stage=async(entity,id,payload,{version=null,hash=null,seen='2026-10-22T12:00:00Z'}={})=>{
   await f.db.query('insert into origin_sync.resource_state(resource)values($1)on conflict do nothing',[entity]);
   await f.db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash,version,last_seen_at)values($1,$1,$2,$3::jsonb,coalesce($5,encode(sha256(convert_to(jsonb_build_object('payload',$3::jsonb,'document_links','[]'::jsonb)::text,'UTF8')),'hex')),coalesce($4::bigint,1),$6)on conflict(entity,source_id)do update set payload=excluded.payload,version_hash=excluded.version_hash,version=coalesce($4,origin_sync.raw_record.version+1),last_seen_at=excluded.last_seen_at",
    [entity,id,typeof payload==='string'?payload:JSON.stringify(payload),version,hash,seen]);
  };
  const observe=(id,depositos,options={},extra={})=>stage('stock_balances',id,{produto:{id,codigo:'S-'+id},depositos,...extra},options);
  const linked=async(id)=>{
   await stage('products',id,{id,nome:'Produto '+id,codigo:'P-'+id,unidade:'UN',situacao:'A'});
   const record=await f.catalog('products',{name:'Produto '+id,code:'P-'+id,unit:'UN',kind:'P',format:'S',price:'2'});
   await f.db.query("insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links)select entity,source_id,version_hash,version,payload,document_links from origin_sync.raw_record where entity='products'and source_id=$1",[id]);
   await f.db.query("insert into erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state)select entity,source_id,$2,version_hash,version_hash,'synced'from origin_sync.raw_record where entity='products'and source_id=$1",[id,record.id]);
   return record;
  };
  const project=(p_limit=100)=>f.rpc('erp_stock_mirror_project',{p_limit});
  const list=(args={})=>f.rpc('erp_stock_mirror_list',{p_user_id:f.users.consulta,...args});
  return {...f,stage,observe,linked,project,list};
 }catch(e){await f.close();throw e;}
}
