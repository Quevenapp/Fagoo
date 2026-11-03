import{readFile}from'node:fs/promises';
import{warehouseFixture}from'./warehouse-import-fixture.mjs';
export async function stockObservationsFixture(){const f=await warehouseFixture();try{
 await f.stage('007',{descricao:'Depósito observado',situacao:0});await f.apply(f.args(await f.preview('007')));
 const stage=async(entity,id,payload)=>{await f.db.query('insert into origin_sync.resource_state(resource)values($1)on conflict do nothing',[entity]);const p=typeof payload==='string'?payload:JSON.stringify(payload);await f.db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values($1,$1,$2,$3::jsonb,encode(sha256(convert_to(jsonb_build_object('payload',$3::jsonb,'document_links','[]'::jsonb)::text,'UTF8')),'hex'))on conflict(entity,source_id)do update set payload=excluded.payload,version_hash=excluded.version_hash,version=origin_sync.raw_record.version+1,last_seen_at=clock_timestamp()",[entity,id,p]);};
 for(const id of['001','1','2','3','4'])await stage('products',id,{id,nome:'Produto '+id,codigo:'C'+id});
 await stage('stock_balances','001',{produto:{id:'001',codigo:'C001'},saldoFisicoTotal:0,saldoVirtualTotal:-0.125,depositos:[{id:'007',saldoFisico:0,saldoVirtual:-0.125}]});
 await stage('stock_balances','1',{produto:{id:'1'},saldoFisicoTotal:null,depositos:[{id:'7',saldoFisico:9}]});
 await stage('stock_balances','2',{produto:{id:'2'},saldoFisicoTotal:'0',depositos:[{id:'007',saldoFisico:null}]});
 await stage('stock_balances','3',{produto:{id:'3'},depositos:[{id:'007',saldoFisico:1},{id:'007',saldoFisico:2}]});
 await stage('stock_balances','9',{produto:{id:'9'},saldoFisicoTotal:1.123456789012345,depositos:[]});
 await stage('products','bad',{id:'bad'});await stage('stock_balances','0',{produto:{id:0}});
 const allRows=async()=>{const tables=(await f.db.query("select n.nspname ns,c.relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r'and(n.nspname like 'erp_%'or n.nspname like 'origin_%'or n.nspname in('auth','storage'))order by 1,2")).rows;const result={};for(const r of tables)result[r.ns+'.'+r.name]=await f.scalar(`select coalesce(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text),'[]')v from "${r.ns}"."${r.name}"t`);return result;};
 await f.db.exec(await readFile(new URL('../../../../supabase/migrations/202610160085_origin_sales_price_refresh.sql',import.meta.url),'utf8'));
 const before=await allRows();await f.db.exec(await readFile(new URL('../../../../supabase/migrations/202610160087_origin_stock_observations.sql',import.meta.url),'utf8'));
 const page=(args={})=>f.rpc('erp_origin_stock_observations',{p_user_id:f.users.admin,p_warehouse_source_id:'007',p_limit:25,p_after:null,p_query:null,...args});
 const detail=(id,args={})=>f.rpc('erp_origin_stock_observation_detail',{p_user_id:f.users.admin,p_warehouse_source_id:'007',p_product_source_id:id,...args});
 return{...f,stageRaw:stage,allRows,before,page,detail};
 }catch(e){await f.close();throw e;}}
