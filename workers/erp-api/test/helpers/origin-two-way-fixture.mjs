// Production chain through the commercial mirror (006/007) and the Origin stock column of the product list (008), then the
// two-way synchronization (009-012). All records are synthetic.
import { randomUUID } from 'node:crypto';
import { documentMirrorFixture } from './document-mirror-fixture.mjs';
export const TWO_WAY_MIGRATIONS=['202610220009_origin_two_way_core.sql','202610220010_origin_two_way_documents.sql','202610220011_origin_two_way_finance_stock.sql','202610220012_origin_two_way_pull_fixes.sql','202610220013_origin_two_way_item_discounts.sql','202610220014_origin_two_way_bank_number.sql','202610220015_origin_two_way_item_snapshots.sql','202610220016_origin_effects_lock.sql','202610220017_origin_item_net_price.sql','202610220018_origin_effects_list.sql'];
export async function originTwoWayFixture({migrate=true}={}){
 const f=await documentMirrorFixture({guards:true});try{
  await f.migrate('202610220008_product_list_origin_stock.sql');
  if(migrate)for(const name of TWO_WAY_MIGRATIONS)await f.migrate(name);
  const claim=(p_limit=50,p_token=randomUUID())=>f.rpc('erp_sync_claim',{p_limit,p_token});
  const ack=results=>f.rpc('erp_sync_ack',{p_results:results});
  const pull=(p_limit=100,p_entity=null)=>f.rpc('erp_sync_pull',{p_limit,p_entity});
  const stageOrigin=(entity,id,payload)=>f.rpc('erp_sync_stage',{p_entity:entity,p_source_id:String(id),p_payload:payload});
  const outbox=async(where='true')=>(await f.db.query(`select * from erp_sync.outbox where ${where} order by id`)).rows;
  // Simulates the Worker: every claimed item succeeds, POSTs get the next synthetic Origin ID.
  let nextId=700000;
  const pushAll=async()=>{const sent=[];for(;;){const items=await claim();if(!items.length)return sent;
   sent.push(...items);await ack(items.map(i=>({id:i.id,token:i.token,ok:true,status:200,origin_id:i.origin_id??(i.requests.some(r=>r.method==='POST'&&!r.path.includes('{id}')&&!r.path.endsWith('/baixar')&&r.path!=='/estoques')?String(++nextId):null)})));}};
  const warehouse=async(sourceId,name='Depósito Origin')=>{
   const record=await f.catalog('warehouses',{name});const command=randomUUID();
   await f.db.query('insert into erp_catalog.command(command_id,actor,request_hash,result)values($1,$2,$3,$4)',[command,f.users.admin,'a'.repeat(64),'{}']);
   await f.db.query("insert into erp_warehouse_import.binding(source_id,warehouse_id,command_id,source_hash,source_version,source_seen_at,observation,source,record)values($1,$2,$3,$4,1,now(),'{}','{}','{}')",[sourceId,record.id,command,'b'.repeat(64)]);
   return record;
  };
  return{...f,claim,ack,pull,stageOrigin,outbox,pushAll,warehouse};
 }catch(e){await f.close();throw e;}
}
