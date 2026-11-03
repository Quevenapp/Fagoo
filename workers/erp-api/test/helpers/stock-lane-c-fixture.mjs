// Synthetic PGlite fixture for the estoque lane, wave C (migrations 181-184): every migration published in production (up to
// 202610200152, in order), then this lane's files that exist. No real data.
import{PGlite}from'@electric-sql/pglite';import{readFile,readdir}from'node:fs/promises';import{randomUUID}from'node:crypto';
import{bootstrap}from'../../../../tools/migration/helpers/stock-reservation-fixture.mjs';
export const PUBLISHED_UNTIL='202610200152';
export const LANE_MIGRATIONS=['202610200181_stock_supplier_parity.sql','202610200182_stock_reversal_policy.sql','202610200183_stock_transfer_batch.sql','202610200184_stock_document_warehouse.sql'];
const dir=new URL('../../../../supabase/migrations/',import.meta.url);
export const migrationSql=async name=>(await readFile(new URL(name,dir),'utf8')).replace(/\r\n/g,'\n');
const AUTH_COLUMNS="alter table auth.users add column email text,add column created_at timestamptz not null default clock_timestamp(),add column invited_at timestamptz,add column email_confirmed_at timestamptz,add column last_sign_in_at timestamptz,add column banned_until timestamptz,add column is_anonymous boolean not null default false;";
const snapshots=new Map();
function snapshot(upto){
 if(!snapshots.has(upto))snapshots.set(upto,(async()=>{const db=new PGlite();try{
  await db.exec(bootstrap);await db.exec(AUTH_COLUMNS);
  const names=(await readdir(dir)).sort();
  for(const name of names.filter(n=>/^\d{12}_.+\.sql$/.test(n)&&n.slice(0,12)<=PUBLISHED_UNTIL))await db.exec(await migrationSql(name));
  for(const name of LANE_MIGRATIONS.slice(0,upto))if(names.includes(name))await db.exec(await migrationSql(name));
  return await db.dumpDataDir('none');
 }finally{await db.close();}})());
 return snapshots.get(upto);
}
export async function stockLaneCFixture({upto=LANE_MIGRATIONS.length}={}){const db=new PGlite({loadDataDir:await snapshot(upto)});try{
 await db.waitReady;
 const scalar=async(text,args=[])=>(await db.query(text,args)).rows[0]?.v;
 const rows=async(text,args=[])=>(await db.query(text,args)).rows;
 const rpc=async(name,args)=>{const e=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${e.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,e.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}};
 const users=Object.fromEntries(['admin','estoque','vendas','consulta','fiscal','financeiro'].map(r=>[r,randomUUID()]));
 for(const[role,id]of Object.entries(users)){await db.query('insert into auth.users(id,email)values($1,$2)',[id,`${role}@sintetico.test`]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[id,role]);}
 const catalog=async(entity,data,user=users.admin)=>(await rpc('erp_catalog_save',{p_user_id:user,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data})).record;
 const contact=await catalog('contacts',{name:'Fornecedor sintético C'});
 const product=(name,extra={})=>catalog('products',{name,unit:'UN',kind:'P',format:'S',price:'10',...extra});
 // Fornecedores, DUN e imagens do produto (119), gravados pelo comando do cadastro de produtos.
 const productDetail=async(id,data)=>{const version=await scalar('select version v from erp_catalog.record where id=$1',[id]);
  return rpc('erp_catalog_product_save',{p_user_id:users.admin,p_id:id,p_expected_version:version,p_command_id:randomUUID(),p_data:data,p_acknowledged:null});};
 const setActive=async(id,active)=>{const version=await scalar('select version v from erp_catalog.record where id=$1',[id]);
  const entity=await scalar('select entity v from erp_catalog.record where id=$1',[id]);
  return rpc('erp_catalog_set_active',{p_user_id:users.admin,p_entity:entity,p_id:id,p_expected_version:version,p_command_id:randomUUID(),p_active:active});};
 const warehouse=async(name,ignore=false)=>(await rpc('erp_stock_warehouse_save',{p_user_id:users.admin,p_command_id:randomUUID(),p_warehouse_id:null,p_expected_version:0,p_expected_setting_version:0,p_name:name,p_ignore_balance:ignore})).warehouse;
 const setDefault=async target=>{const v=await scalar('select version v from erp_stock.warehouse_default');return rpc('erp_stock_warehouse_set_default',{p_user_id:users.admin,p_command_id:randomUUID(),p_warehouse_id:target,p_expected_version:v});};
 const version=async(item,target)=>(await scalar('select coalesce((select version from erp_stock.balance where product_id=$1 and warehouse_id=$2),0)v',[item,target]))??0;
 const balance=async(item,target)=>scalar('select quantity::text v from erp_stock.balance where product_id=$1 and warehouse_id=$2',[item,target]);
 const launch=async(item,target,kind,quantity,{price=null,cost=null,note=null,user=users.estoque,destination=null,command=randomUUID()}={})=>rpc('erp_stock_launch',{p_user_id:user,p_command_id:command,p_kind:kind,p_product_id:item,p_warehouse_id:target,p_quantity:quantity,
  p_expected_version:await version(item,target),p_unit_price:price,p_unit_cost:kind==='issue'?null:cost,p_note:note,p_destination_id:destination,p_destination_version:destination?await version(item,destination):null});
 const reverse=async(movement,{user=users.estoque,command=randomUUID(),day=null,reason='Estorno sintético'}={})=>{
  const lines=await rows('select product_id,warehouse_id from erp_stock.entry where movement_id=$1 order by ordinal',[movement]);
  const on=day??await scalar('select occurred_on::text v from erp_stock.movement where id=$1',[movement]);
  return rpc('erp_stock_reverse',{p_user_id:user,p_movement_id:movement,p_command_id:command,p_occurred_on:on,p_reason:reason,
   p_versions:await Promise.all(lines.map(async l=>({product_id:l.product_id,warehouse_id:l.warehouse_id,expected_version:await version(l.product_id,l.warehouse_id)})))});};
 const transition=async(doc,status)=>(await rpc('erp_document_transition',{p_user_id:users.admin,p_kind:doc.kind,p_id:doc.id,p_expected_version:doc.version,p_command_id:randomUUID(),p_status:status,p_reason:'Transição sintética'})).document;
 // New documents start Em aberto (129); purchase orders are moved to Em andamento to be posted.
 const order=async(kind,items,target,statuses=kind==='sales_orders'?[]:['in_progress'],{date='2026-10-15',contact_id=contact.id}={})=>{let d=(await rpc('erp_document_save',{p_user_id:users.admin,p_kind:kind,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date,contact_id,warehouse_id:target,items}})).document;
  for(const s of statuses)d=await transition(d,s);return d;};
 const item=(target,quantity,unit_price='5')=>({product_id:target.id??target,description:'Item sintético',unit:'UN',quantity,unit_price});
 // Company preferences (115), saved by the administrador with the version the page shows; unchanged keys are skipped.
 const setPreferences=async(page,values)=>{const current=await rpc('erp_preferences_page',{p_user_id:users.admin,p_page:page});
  const changes=Object.entries(values).map(([key,value])=>({key,current:current.items.find(i=>i.key===key),value})).filter(c=>JSON.stringify(c.current.value)!==JSON.stringify(c.value))
   .map(c=>({key:c.key,expected_version:c.current.version,value:c.value}));
  return changes.length?rpc('erp_preferences_save',{p_user_id:users.admin,p_command_id:randomUUID(),p_page:page,p_changes:changes}):null;};
 const setPolicy=async allow=>{const current=(await rpc('erp_stock_policy_get',{p_user_id:users.admin})).policy;return rpc('erp_stock_policy_set',{p_user_id:users.admin,p_command_id:randomUUID(),p_expected_version:current.version,p_allow_negative:allow,p_reason:'Decisão sintética',p_confirmed:true});};
 return{db,scalar,rows,rpc,users,catalog,contact,product,productDetail,setActive,warehouse,setDefault,version,balance,launch,reverse,transition,order,item,setPreferences,setPolicy,close:()=>db.close()};
}catch(e){await db.close();throw e;}}
export const fails=code=>error=>error?.code===code;
