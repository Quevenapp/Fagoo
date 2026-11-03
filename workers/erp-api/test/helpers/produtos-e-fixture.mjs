// Synthetic PGlite fixture for the produtos lane, wave E (migrations 202610200234-237): every migration up to 202610200233
// (the production state on 20/10/2026), in order, then this lane's files that exist. Synthetic actors and data only.
import{PGlite}from'@electric-sql/pglite';import{readFile,readdir}from'node:fs/promises';import{randomUUID}from'node:crypto';
import{bootstrap}from'../../../../tools/migration/helpers/stock-reservation-fixture.mjs';
export const PRODUCTS_E_MIGRATIONS=['202610200234_product_list_component_stock.sql','202610200235_product_price_compositions_permissions.sql','202610200236_invoice_tags.sql'];
export const PRODUCTION_CUT='202610200233';
const dir=new URL('../../../../supabase/migrations/',import.meta.url);
export const migrationSql=async name=>(await readFile(new URL(name,dir),'utf8')).replace(/\r\n/g,'\n');
// Supabase Auth columns and tables read by migrations 117 and 151 (absent from the shared bootstrap stub).
const AUTH="alter table auth.users add column email text,add column created_at timestamptz not null default clock_timestamp(),add column invited_at timestamptz,add column email_confirmed_at timestamptz,add column last_sign_in_at timestamptz,add column banned_until timestamptz,add column is_anonymous boolean not null default false;"+
 "create table auth.sessions(id uuid primary key,user_id uuid not null,created_at timestamptz,updated_at timestamptz,refreshed_at timestamp,user_agent text,ip inet,aal text,not_after timestamptz);"+
 "create table auth.mfa_factors(id uuid primary key,user_id uuid not null,friendly_name text,factor_type text,status text,created_at timestamptz,updated_at timestamptz,secret text);"+
 "create table auth.mfa_challenges(id uuid primary key,factor_id uuid not null,created_at timestamptz,verified_at timestamptz,ip_address inet,otp_code text);";
export async function productionMigrations(){return(await readdir(dir)).filter(n=>/^20261\d{7}_.+\.sql$/.test(n)&&n.slice(0,12)<=PRODUCTION_CUT).sort();}
export async function presentLane(){const names=new Set(await readdir(dir));return PRODUCTS_E_MIGRATIONS.filter(n=>names.has(n));}
// PostgreSQL arrays travel as arrays (PostgREST converts the JSON arrays the Worker sends); the rest as JSON text.
const ARRAYS=new Set(['p_ids','p_product_ids','p_sale_statuses','p_codes']);
const snapshots=new Map();
function snapshot(lane){
 const key=lane.join(',');
 if(!snapshots.has(key))snapshots.set(key,(async()=>{const db=new PGlite();try{
  await db.exec(bootstrap);await db.exec(AUTH);
  for(const name of await productionMigrations())await db.exec(await migrationSql(name));
  for(const name of lane)await db.exec(await migrationSql(name));
  return await db.dumpDataDir('none');
 }finally{await db.close();}})());
 return snapshots.get(key);
}
/** `lane`: the lane files to apply after the production state (default: every file of the lane that exists; [] = production only). */
export async function produtosEFixture({lane}={}){
 const db=new PGlite({loadDataDir:await snapshot(lane??await presentLane())});
 try{
  await db.waitReady;
  const scalar=async(text,args=[])=>(await db.query(text,args)).rows[0]?.v;
  const rows=async(text,args=[])=>(await db.query(text,args)).rows;
  const rpc=async(name,args)=>{const e=Object.entries(args);await db.exec('set role service_role');
   try{return await scalar(`select public.${name}(${e.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,e.map(([k,v])=>ARRAYS.has(k)&&Array.isArray(v)?v:v!==null&&typeof v==='object'?JSON.stringify(v):v));}
   finally{await db.exec('reset role');}};
  const users=Object.fromEntries(['admin','consulta','vendas','financeiro','estoque','fiscal','inactive'].map(r=>[r,randomUUID()]));
  for(const[role,id]of Object.entries(users)){
   await db.query('insert into auth.users(id,email)values($1,$2)',[id,`${role}@sintetico.test`]);
   await db.query('insert into erp_access.membership(user_id,role,active)values($1,$2,$3)',[id,role==='inactive'?'admin':role,role!=='inactive']);
  }
  const version=async id=>scalar('select version v from erp_catalog.record where id=$1',[id]);
  const productSave=(data,{id=null,version:expected=0,user=users.admin,command=randomUUID(),acknowledged=null}={})=>rpc('erp_catalog_product_save',{p_user_id:user,p_id:id,p_expected_version:expected,p_command_id:command,p_data:data,p_acknowledged:acknowledged});
  const product=async(data,user=users.admin)=>(await productSave({kind:'P',format:'S',unit:'UN',...data},{user})).record;
  const contact=async(data,user=users.admin)=>(await rpc('erp_catalog_contact_save',{p_user_id:user,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{person_type:'J',...data},p_acknowledged:null})).record;
  const taxonomySave=(kind,data,{user=users.admin,id=null,version:expected=0,command=randomUUID()}={})=>rpc('erp_catalog_taxonomy_save',{p_user_id:user,p_kind:kind,p_id:id,p_expected_version:expected,p_command_id:command,p_data:data});
  const preferences=async(page,values)=>{const current=await rpc('erp_preferences_page',{p_user_id:users.admin,p_page:page});
   const changes=Object.entries(values).map(([key,value])=>({key,current:current.items.find(i=>i.key===key),value})).filter(c=>JSON.stringify(c.current.value)!==JSON.stringify(c.value))
    .map(c=>({key:c.key,expected_version:c.current.version,value:c.value}));
   return changes.length?rpc('erp_preferences_save',{p_user_id:users.admin,p_command_id:randomUUID(),p_page:page,p_changes:changes}):null;};
  // 222 (estoque): a composition ("Com composição") and its Estrutura, saved with the product in one stock command.
  const compose=async(id,items,{data={},user=users.admin,stock_type='virtual',post_mode='components',command=randomUUID()}={})=>{
   const current=id?(await scalar('select version v from erp_stock.composition where product_id=$1',[id]))??0:0;
   return rpc('erp_stock_product_compose',{p_user_id:user,p_id:id,p_expected_version:id?await version(id):0,p_command_id:command,
    p_data:id?{name:await scalar('select name v from erp_catalog.record where id=$1',[id]),...data}:{kind:'P',format:'E',unit:'KIT',...data},p_acknowledged:null,
    p_composition:{expected_version:current,stock_type,post_mode,items:items.map(([component,quantity])=>({component_id:component.id??component,quantity}))}});};
  // 105 (estoque): warehouses with "Desconsiderar saldo deste depósito", the default warehouse and launches.
  const warehouse=async(name,ignore=false)=>(await rpc('erp_stock_warehouse_save',{p_user_id:users.admin,p_command_id:randomUUID(),p_warehouse_id:null,p_expected_version:0,p_expected_setting_version:0,p_name:name,p_ignore_balance:ignore})).warehouse;
  const setDefault=async target=>rpc('erp_stock_warehouse_set_default',{p_user_id:users.admin,p_command_id:randomUUID(),p_warehouse_id:target,p_expected_version:await scalar('select version v from erp_stock.warehouse_default')});
  const balanceVersion=async(item,target)=>(await scalar('select coalesce((select version from erp_stock.balance where product_id=$1 and warehouse_id=$2),0)v',[item,target]))??0;
  const launch=async(item,target,kind,quantity)=>rpc('erp_stock_launch',{p_user_id:users.admin,p_command_id:randomUUID(),p_kind:kind,p_product_id:item,p_warehouse_id:target,p_quantity:quantity,
   p_expected_version:await balanceVersion(item,target),p_unit_price:null,p_unit_cost:null,p_note:null,p_destination_id:null,p_destination_version:null});
  // Synthetic Origin mirror rows (the collector is not used here).
  const originNote=async(entity,id,payload)=>{
   if(!await scalar("select exists(select 1 from origin_sync.resource_state where resource='produtos_e_test') v"))await db.exec("insert into origin_sync.resource_state(resource) values('produtos_e_test')");
   await db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) values($1,'produtos_e_test',$2,$3::jsonb,$4)",[entity,id,JSON.stringify(payload),'b'.repeat(64)]);};
  return{db,scalar,rows,rpc,users,version,productSave,product,contact,taxonomySave,preferences,compose,warehouse,setDefault,launch,originNote,close:()=>db.close()};
 }catch(error){await db.close();throw error;}
}
export const fails=(assert,promise,code)=>assert.rejects(promise,error=>error.code===code||error.message===code);
