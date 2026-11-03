// Synthetic PGlite fixture for the estoque lane (migrations 105-107 on top of every published migration). No real data.
import{PGlite}from'@electric-sql/pglite';import{readFile,readdir}from'node:fs/promises';import{randomUUID}from'node:crypto';
import{bootstrap}from'../../../../tools/migration/helpers/stock-reservation-fixture.mjs';
export const LANE_MIGRATIONS=['202610200105_stock_ledger_warehouses_origin.sql','202610200106_stock_count.sql','202610200107_stock_dashboards.sql'];
// Wave B of the estoque lane redefines the stock RPCs on top of Preferências (115); the API speaks that contract (DB → API order).
export const WAVE_B_MIGRATIONS=['202610200115_erp_preferences.sql','202610200145_stock_preferences_cost.sql'];
const dir=new URL('../../../../supabase/migrations/',import.meta.url);
// A Windows checkout may carry CRLF; published bodies are hashed without CR by the guards.
export const migrationSql=async name=>(await readFile(new URL(name,dir),'utf8')).replace(/\r\n/g,'\n');
const snapshots=new Map();
async function exists(name){try{await readFile(new URL(name,dir));return true;}catch{return false;}}
// Production order: every published file (001-101), then the lane files that exist, up to `upto`.
function snapshot(upto){
 if(!snapshots.has(upto))snapshots.set(upto,(async()=>{const db=new PGlite();try{
  await db.exec(bootstrap);
  for(const name of(await readdir(dir)).filter(n=>/^20261(01[67]|019)\d{4}_.+\.sql$/.test(n)).sort())await db.exec(await migrationSql(name));
  for(const name of LANE_MIGRATIONS.slice(0,upto))if(await exists(name))await db.exec(await migrationSql(name));
  if(upto>=LANE_MIGRATIONS.length)for(const name of WAVE_B_MIGRATIONS)if(await exists(name))await db.exec(await migrationSql(name));
  return await db.dumpDataDir('none');
 }finally{await db.close();}})());
 return snapshots.get(upto);
}
export async function stockOriginFixture({upto=LANE_MIGRATIONS.length}={}){const db=new PGlite({loadDataDir:await snapshot(upto)});try{
 await db.waitReady;
 const scalar=async(text,args=[])=>(await db.query(text,args)).rows[0]?.v;
 const rpc=async(name,args)=>{const e=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${e.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,e.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}};
 const users=Object.fromEntries(['admin','estoque','vendas','consulta','fiscal','financeiro','other'].map(r=>[r,randomUUID()]));
 for(const[role,id]of Object.entries(users)){await db.query('insert into auth.users values($1)',[id]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[id,role==='other'?'estoque':role]);}
 const catalog=async(entity,data,user=users.admin)=>(await rpc('erp_catalog_save',{p_user_id:user,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data})).record;
 const contact=await catalog('contacts',{name:'Contato sintético estoque'});
 const warehouse=async(name,ignore=false,user=users.admin)=>(await rpc('erp_stock_warehouse_save',{p_user_id:user,p_command_id:randomUUID(),p_warehouse_id:null,p_expected_version:0,p_expected_setting_version:0,p_name:name,p_ignore_balance:ignore})).warehouse;
 const version=async(product,target)=>(await scalar('select coalesce((select version from erp_stock.balance where product_id=$1 and warehouse_id=$2),0)v',[product,target]))??0;
 const balance=async(product,target)=>scalar('select quantity::text v from erp_stock.balance where product_id=$1 and warehouse_id=$2',[product,target]);
 const launch=async(product,target,kind,quantity,extra={})=>rpc('erp_stock_launch',{p_user_id:users.estoque,p_command_id:randomUUID(),p_kind:kind,p_product_id:product,p_warehouse_id:target,p_quantity:quantity,
  p_expected_version:await version(product,target),p_unit_price:kind==='issue'?'2':'1.5',p_unit_cost:kind==='issue'?null:'1.75',p_note:null,...extra});
 const post=async(kind,lines,{user=users.estoque,command=randomUUID(),day='2026-10-15',reason='Movimento sintético'}={})=>rpc('erp_stock_post',{p_user_id:user,p_command_id:command,p_kind:kind,p_occurred_on:day,p_reason:reason,
  p_items:await Promise.all(lines.map(async([product,target,quantity])=>({product_id:product,warehouse_id:target,quantity,expected_version:await version(product,target)}))),p_reference:null});
 const order=async(kind,items,target,status=kind==='sales_orders'?['open','verified']:['in_progress'])=>{let d=(await rpc('erp_document_save',{p_user_id:users.admin,p_kind:kind,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-15',contact_id:contact.id,warehouse_id:target,items}})).document;
  for(const s of status)d=(await rpc('erp_document_transition',{p_user_id:users.admin,p_kind:kind,p_id:d.id,p_expected_version:d.version,p_command_id:randomUUID(),p_status:s,p_reason:'Transição sintética'})).document;return d;};
 const setPolicy=async allow=>{const current=(await rpc('erp_stock_policy_get',{p_user_id:users.admin})).policy;return rpc('erp_stock_policy_set',{p_user_id:users.admin,p_command_id:randomUUID(),p_expected_version:current.version,p_allow_negative:allow,p_reason:'Decisão sintética',p_confirmed:true});};
 return{db,scalar,rpc,users,catalog,contact,warehouse,version,balance,launch,post,order,setPolicy,close:()=>db.close()};
}catch(e){await db.close();throw e;}}
export const fails=code=>error=>error?.code===code;
