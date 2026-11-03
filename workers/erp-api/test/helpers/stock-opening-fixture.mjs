// Synthetic PGlite fixture for migration 100 (negative stock policy and Origin opening adoption). No real data.
import{PGlite}from'@electric-sql/pglite';import{readFile,readdir}from'node:fs/promises';import{randomUUID}from'node:crypto';
import{bootstrap}from'../../../../tools/migration/helpers/stock-reservation-fixture.mjs';
export const OPENING_MIGRATION='202610190100_stock_opening_negative_policy.sql';
const dir=new URL('../../../../supabase/migrations/',import.meta.url);
// A Windows checkout may carry CRLF; published bodies are hashed by migrations088/100 without CR.
const sql=async name=>(await readFile(new URL(name,dir),'utf8')).replace(/\r\n/g,'\n');
export const WAREHOUSE_SOURCE='700001';
// Loading 93 migrations costs seconds of CPU; each fixture restores one snapshot per variant instead (same schema, fresh data).
const snapshots=new Map();
function snapshot(migrated){
 if(!snapshots.has(migrated))snapshots.set(migrated,(async()=>{const db=new PGlite();try{
  await db.exec(bootstrap);
  // Production order: 001-093, the Origin-parity wave (094-098, and any later file), then 100 itself.
  for(const name of(await readdir(dir)).filter(n=>/^20261(01[67]|019)\d{4}_.+\.sql$/.test(n)&&n!==OPENING_MIGRATION).sort())await db.exec(await sql(name));
  if(migrated)await db.exec(await sql(OPENING_MIGRATION));
  return await db.dumpDataDir('none');
 }finally{await db.close();}})());
 return snapshots.get(migrated);
}
export async function stockOpeningFixture({migrated=true}={}){const db=new PGlite({loadDataDir:await snapshot(migrated)});try{
 await db.waitReady;
 const migrate=async()=>db.exec(await sql(OPENING_MIGRATION));
 const scalar=async(text,args=[])=>(await db.query(text,args)).rows[0]?.v;
 const rpc=async(name,args)=>{const e=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${e.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,e.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}};
 const users=Object.fromEntries(['admin','other','estoque','vendas','consulta','fiscal','financeiro'].map(r=>[r,randomUUID()]));
 for(const[role,id]of Object.entries(users)){await db.query('insert into auth.users values($1)',[id]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[id,role==='other'?'admin':role]);}
 const catalog=async(entity,data)=>(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data})).record;
 const contact=await catalog('contacts',{name:'Contato sintético100'});
 const stageRaw=async(entity,id,payload,resource=entity)=>{await db.query('insert into origin_sync.resource_state(resource)values($1)on conflict do nothing',[resource]);await db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values($1,$4,$2,$3::jsonb,encode(sha256(convert_to(jsonb_build_object('payload',$3::jsonb,'document_links','[]'::jsonb)::text,'UTF8')),'hex'))on conflict(entity,source_id)do update set payload=excluded.payload,version_hash=excluded.version_hash,version=origin_sync.raw_record.version+1,last_seen_at=clock_timestamp()",[entity,id,typeof payload==='string'?payload:JSON.stringify(payload),resource]);};
 // Warehouse adopted through the real086 contract.
 await stageRaw('warehouses',WAREHOUSE_SOURCE,{id:WAREHOUSE_SOURCE,descricao:'Depósito sintético100',situacao:1,padrao:true,desconsiderarSaldo:false},'warehouses_active');
 const source=await scalar("select jsonb_build_object('p_source_id',source_id,'p_source_hash',version_hash,'p_source_version',version::text)v from origin_sync.raw_record where entity='warehouses'and source_id=$1",[WAREHOUSE_SOURCE]);
 const wp=await rpc('erp_origin_warehouse_preview',{p_user_id:users.admin,...source});
 const imported=await rpc('erp_origin_warehouse_import',{p_user_id:users.admin,p_source_id:WAREHOUSE_SOURCE,p_source_hash:wp.source.source_hash,p_source_version:wp.source.source_version,p_preview_hash:wp.preview_hash,p_command_id:randomUUID(),p_confirmed:true});
 const warehouse={id:imported.receipt.binding.record.id};
 // Native product linked to a Origin product ID through erp_catalog.origin, as the catalogue import records it.
 const linked=async(id,data={})=>{await stageRaw('products',id,{id,nome:'Produto sintético '+id,codigo:'SINT-'+id,situacao:'A'});const record=await catalog('products',{name:'Produto sintético '+id,unit:'UN',kind:'P',format:'S',price:'1',...data});
  await db.query("insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links)select entity,source_id,version_hash,version,payload,document_links from origin_sync.raw_record where entity='products'and source_id=$1",[id]);
  await db.query("insert into erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state)select entity,source_id,$2,version_hash,version_hash,'synced'from origin_sync.raw_record where entity='products'and source_id=$1",[id,record.id]);return record;};
 const observe=(id,depositos,extra={})=>stageRaw('stock_balances',id,{produto:{id,codigo:'SINT-'+id},saldoFisicoTotal:0,saldoVirtualTotal:0,depositos,...extra});
 const balance=async(product,target=warehouse.id)=>(await scalar('select jsonb_build_object(\'quantity\',quantity::text,\'version\',version)v from erp_stock.balance where product_id=$1 and warehouse_id=$2',[product,target]))??null;
 const version=async(product,target=warehouse.id)=>(await balance(product,target))?.version??0;
 const post=async(product,quantity,{kind=quantity.startsWith('-')?'issue':'receipt',user=users.estoque,command=randomUUID(),target=warehouse.id,day='2026-10-15'}={})=>rpc('erp_stock_post',{p_user_id:user,p_command_id:command,p_kind:kind,p_occurred_on:day,p_reason:'Movimento sintético100',p_items:[{product_id:product,warehouse_id:target,quantity,expected_version:await version(product,target)}],p_reference:null});
 const reverse=async(movement,{user=users.estoque,command=randomUUID(),day='2026-10-15'}={})=>{const rows=(await db.query('select product_id,warehouse_id from erp_stock.entry where movement_id=$1 order by ordinal',[movement])).rows;const versions=[];for(const r of rows)versions.push({product_id:r.product_id,warehouse_id:r.warehouse_id,expected_version:await version(r.product_id,r.warehouse_id)});return rpc('erp_stock_reverse',{p_user_id:user,p_movement_id:movement,p_command_id:command,p_occurred_on:day,p_reason:'Estorno sintético100',p_versions:versions});};
 const policy=()=>rpc('erp_stock_policy_get',{p_user_id:users.admin});
 const setPolicy=async(allow,{user=users.admin,command=randomUUID(),expected,reason='Decisão sintética da política'}={})=>rpc('erp_stock_policy_set',{p_user_id:user,p_command_id:command,p_expected_version:expected??(await policy()).policy.version,p_allow_negative:allow,p_reason:reason,p_confirmed:true});
 const page=(extra={})=>rpc('erp_stock_opening_page',{p_user_id:users.admin,p_warehouse_source_id:WAREHOUSE_SOURCE,p_limit:50,p_after:null,p_group:null,...extra});
 const batch=(extra={})=>rpc('erp_stock_opening_batch',{p_user_id:users.admin,p_warehouse_source_id:WAREHOUSE_SOURCE,p_occurred_on:'2026-10-18',p_limit:100,...extra});
 const intent=b=>b.items.map(i=>({product_source_id:i.product_source_id,product_id:i.product.id,unit:i.product.unit,source_hash:i.source.source_hash,source_version:i.source.source_version,target:i.target}));
 const apply=(b,extra={})=>rpc('erp_stock_opening_apply',{p_user_id:users.admin,p_warehouse_source_id:WAREHOUSE_SOURCE,p_occurred_on:b.occurred_on,p_items:intent(b),p_preview_hash:b.preview_hash,p_command_id:randomUUID(),p_confirmed:true,...extra});
 const command=(id,user=users.admin)=>rpc('erp_stock_opening_command',{p_user_id:user,p_command_id:id});
 const order=async(kind,items,status=kind==='sales_orders'?['open','verified']:['in_progress'])=>{let d=(await rpc('erp_document_save',{p_user_id:users.admin,p_kind:kind,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-15',contact_id:contact.id,warehouse_id:warehouse.id,items}})).document;for(const s of status)d=(await rpc('erp_document_transition',{p_user_id:users.admin,p_kind:kind,p_id:d.id,p_expected_version:d.version,p_command_id:randomUUID(),p_status:s,p_reason:'Transição sintética'})).document;return d;};
 return{db,scalar,rpc,users,catalog,contact,warehouse,stageRaw,linked,observe,balance,version,post,reverse,policy,setPolicy,page,batch,intent,apply,command,order,migrate,close:()=>db.close()};
}catch(e){await db.close();throw e;}}
