// Synthetic PGlite fixture for the estoque lane, wave B (migrations 145-147): every published file up to 101, the estoque files
// 105-107, Preferências (115) and the native notes (111/112, read by the check-in), then this lane's files. No real data.
import{PGlite}from'@electric-sql/pglite';import{readFile,readdir}from'node:fs/promises';import{randomUUID}from'node:crypto';
import{bootstrap}from'../../../../tools/migration/helpers/stock-reservation-fixture.mjs';
export const BASE_MIGRATIONS=['202610200105_stock_ledger_warehouses_origin.sql','202610200106_stock_count.sql','202610200107_stock_dashboards.sql',
 '202610200111_fiscal_operation_natures.sql','202610200112_fiscal_invoice_core.sql','202610200115_erp_preferences.sql'];
export const LANE_MIGRATIONS=['202610200145_stock_preferences_cost.sql','202610200146_stock_reports.sql','202610200147_receipt_checkin.sql'];
const dir=new URL('../../../../supabase/migrations/',import.meta.url);
export const migrationSql=async name=>(await readFile(new URL(name,dir),'utf8')).replace(/\r\n/g,'\n');
const snapshots=new Map();
async function exists(name){try{await readFile(new URL(name,dir));return true;}catch{return false;}}
function snapshot(upto){
 if(!snapshots.has(upto))snapshots.set(upto,(async()=>{const db=new PGlite();try{
  await db.exec(bootstrap);
  for(const name of(await readdir(dir)).filter(n=>/^20261(01[67]|019)\d{4}_.+\.sql$/.test(n)).sort())await db.exec(await migrationSql(name));
  for(const name of BASE_MIGRATIONS)await db.exec(await migrationSql(name));
  for(const name of LANE_MIGRATIONS.slice(0,upto))if(await exists(name))await db.exec(await migrationSql(name));
  return await db.dumpDataDir('none');
 }finally{await db.close();}})());
 return snapshots.get(upto);
}
export async function stockLaneFixture({upto=LANE_MIGRATIONS.length}={}){const db=new PGlite({loadDataDir:await snapshot(upto)});try{
 await db.waitReady;
 const scalar=async(text,args=[])=>(await db.query(text,args)).rows[0]?.v;
 const rpc=async(name,args)=>{const e=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${e.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,e.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}};
 const users=Object.fromEntries(['admin','estoque','vendas','consulta','fiscal','financeiro'].map(r=>[r,randomUUID()]));
 for(const[role,id]of Object.entries(users)){await db.query('insert into auth.users values($1)',[id]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[id,role]);}
 const catalog=async(entity,data,user=users.admin)=>(await rpc('erp_catalog_save',{p_user_id:user,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data})).record;
 const contact=await catalog('contacts',{name:'Contato sintético B'});
 const product=(name,extra={})=>catalog('products',{name,unit:'UN',kind:'P',format:'S',price:'10',...extra});
 const warehouse=async(name,ignore=false)=>(await rpc('erp_stock_warehouse_save',{p_user_id:users.admin,p_command_id:randomUUID(),p_warehouse_id:null,p_expected_version:0,p_expected_setting_version:0,p_name:name,p_ignore_balance:ignore})).warehouse;
 const setDefault=async target=>{const v=await scalar('select version v from erp_stock.warehouse_default');return rpc('erp_stock_warehouse_set_default',{p_user_id:users.admin,p_command_id:randomUUID(),p_warehouse_id:target,p_expected_version:v});};
 const version=async(item,target)=>(await scalar('select coalesce((select version from erp_stock.balance where product_id=$1 and warehouse_id=$2),0)v',[item,target]))??0;
 const balance=async(item,target)=>scalar('select quantity::text v from erp_stock.balance where product_id=$1 and warehouse_id=$2',[item,target]);
 const launch=async(item,target,kind,quantity,{price=null,cost=null,note=null,user=users.estoque,destination=null}={})=>rpc('erp_stock_launch',{p_user_id:user,p_command_id:randomUUID(),p_kind:kind,p_product_id:item,p_warehouse_id:target,p_quantity:quantity,
  p_expected_version:await version(item,target),p_unit_price:price,p_unit_cost:kind==='issue'?null:cost,p_note:note,p_destination_id:destination,p_destination_version:destination?await version(item,destination):null});
 const post=async(kind,lines,{user=users.estoque,day='2026-10-15',reason='Movimento sintético'}={})=>rpc('erp_stock_post',{p_user_id:user,p_command_id:randomUUID(),p_kind:kind,p_occurred_on:day,p_reason:reason,
  p_items:await Promise.all(lines.map(async([item,target,quantity])=>({product_id:item,warehouse_id:target,quantity,expected_version:await version(item,target)}))),p_reference:null});
 const transition=async(doc,status)=>(await rpc('erp_document_transition',{p_user_id:users.admin,p_kind:doc.kind,p_id:doc.id,p_expected_version:doc.version,p_command_id:randomUUID(),p_status:status,p_reason:'Transição sintética'})).document;
 const order=async(kind,items,target,statuses=kind==='sales_orders'?['open']:['in_progress'],{date='2026-10-15',contact_id=contact.id}={})=>{let d=(await rpc('erp_document_save',{p_user_id:users.admin,p_kind:kind,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date,contact_id,warehouse_id:target,items}})).document;
  for(const s of statuses)d=await transition(d,s);return d;};
 const item=(target,quantity,unit_price='5')=>({product_id:target.id??target,description:'Item sintético',unit:'UN',quantity,unit_price});
 // Company preferences of Suprimentos > Estoque (115), saved by the administrador with the version the page shows.
 const setPreferences=async values=>{const page=await rpc('erp_preferences_page',{p_user_id:users.admin,p_page:'suprimentos-estoque'});
  // Keys already at the wanted value are skipped (115 refuses an unchanged value).
  const changes=Object.entries(values).map(([key,value])=>({key,current:page.items.find(i=>i.key===key),value})).filter(c=>JSON.stringify(c.current.value)!==JSON.stringify(c.value))
   .map(c=>({key:c.key,expected_version:c.current.version,value:c.value}));
  return changes.length?rpc('erp_preferences_save',{p_user_id:users.admin,p_command_id:randomUUID(),p_page:'suprimentos-estoque',p_changes:changes}):null;};
 const STOCK_DEFAULTS={'estoque.exibir_preco_unitario':false,'estoque.tipo_preco_entrada':'ultima_compra','estoque.considerar_balancos':false,'estoque.custo_medio_base':'preco_compra',
  'estoque.estorno_balanco':true,'estoque.reserva_por_situacao':false,'estoque.reserva_situacoes':[],'estoque.reserva_por_deposito':true};
 const resetPreferences=()=>setPreferences(STOCK_DEFAULTS);
 const setPolicy=async allow=>{const current=(await rpc('erp_stock_policy_get',{p_user_id:users.admin})).policy;return rpc('erp_stock_policy_set',{p_user_id:users.admin,p_command_id:randomUUID(),p_expected_version:current.version,p_allow_negative:allow,p_reason:'Decisão sintética',p_confirmed:true});};
 return{db,scalar,rpc,users,catalog,contact,product,warehouse,setDefault,version,balance,launch,post,transition,order,item,setPreferences,resetPreferences,setPolicy,close:()=>db.close()};
}catch(e){await db.close();throw e;}}
export const fails=code=>error=>error?.code===code;
