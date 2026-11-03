// Synthetic PGlite fixture for the produtos lane (migrations 202610200119-121 and, from wave C, 202610200153-157). No real data.
// Applies every migration in production (up to 202610200152, in order, which includes 119-121), then this lane's newer files.
import{PGlite}from'@electric-sql/pglite';import{readFile,readdir}from'node:fs/promises';import{randomUUID}from'node:crypto';
import{bootstrap}from'../../../../tools/migration/helpers/stock-reservation-fixture.mjs';
export const PRODUCT_LANE_MIGRATIONS=['202610200119_product_registry_v2.sql','202610200120_product_page_v2.sql','202610200121_price_lists.sql',
 '202610200153_catalog_tags_contacts.sql','202610200154_price_lists_v2.sql','202610200155_product_price_tools.sql','202610200156_product_custom_fields.sql','202610200157_product_settings_c.sql'];
const PRODUCTION='202610200152';
const dir=new URL('../../../../supabase/migrations/',import.meta.url);
const sql=async name=>(await readFile(new URL(name,dir),'utf8')).replace(/\r\n/g,'\n');
const AUTH_COLUMNS="alter table auth.users add column email text,add column created_at timestamptz not null default clock_timestamp(),add column invited_at timestamptz,add column email_confirmed_at timestamptz,add column last_sign_in_at timestamptz,add column banned_until timestamptz,add column is_anonymous boolean not null default false;"+
 // Supabase Auth sessions and MFA tables read by migration 151.
 "create table auth.sessions(id uuid primary key,user_id uuid not null,created_at timestamptz,updated_at timestamptz,refreshed_at timestamp,user_agent text,ip inet,aal text,not_after timestamptz);"+
 "create table auth.mfa_factors(id uuid primary key,user_id uuid not null,friendly_name text,factor_type text,status text,created_at timestamptz,updated_at timestamptz,secret text);"+
 "create table auth.mfa_challenges(id uuid primary key,factor_id uuid not null,created_at timestamptz,verified_at timestamptz,ip_address inet,otp_code text);";
const snapshots=new Map();
async function available(){const names=new Set(await readdir(dir));return PRODUCT_LANE_MIGRATIONS.filter(name=>names.has(name));}
function snapshot(lane){
 const key=lane.join(',');
 if(!snapshots.has(key))snapshots.set(key,(async()=>{const db=new PGlite();try{
  await db.exec(bootstrap);await db.exec(AUTH_COLUMNS);
  for(const name of(await readdir(dir)).filter(n=>/^20261\d{7}_.+\.sql$/.test(n)&&n.slice(0,12)<=PRODUCTION).sort())await db.exec(await sql(name));
  // `lane: []` is the production state (119-121 included); the default adds the wave C files that exist.
  for(const name of lane)if(name.slice(0,12)>PRODUCTION)await db.exec(await sql(name));
  return await db.dumpDataDir('none');
 }finally{await db.close();}})());
 return snapshots.get(key);
}
export async function productRegistryFixture({lane}={}){
 const migrations=lane??await available();
 const db=new PGlite({loadDataDir:await snapshot(migrations)});
 try{
  await db.waitReady;
  const users=Object.fromEntries(['admin','consulta','vendas','financeiro','estoque','fiscal','inactive'].map(role=>[role,randomUUID()]));
  for(const[role,id]of Object.entries(users)){
   await db.query('insert into auth.users(id,email)values($1,$2)',[id,`${role}@sintetico.test`]);
   await db.query('insert into erp_access.membership(user_id,role,active)values($1,$2,$3)',[id,role==='inactive'?'admin':role,role!=='inactive']);
  }
  const rows=async(text,args=[])=>(await db.query(text,args)).rows;
  const scalar=async(text,args=[])=>(await db.query(text,args)).rows[0]?.v;
  const rpc=async(name,args)=>{
   const pairs=Object.entries(args);await db.exec('set role service_role');
   try{return(await db.query(`select public.${name}(${pairs.map(([key],index)=>`${key}=>$${index+1}`).join(',')}) v`,pairs.map(([,value])=>value!==null&&typeof value==='object'?JSON.stringify(value):value))).rows[0].v;}
   finally{await db.exec('reset role');}
  };
  const save=async(entity,data,{user=users.admin,id=null,version=0,command=randomUUID()}={})=>(await rpc('erp_catalog_save',{p_user_id:user,p_entity:entity,p_id:id,p_expected_version:version,p_command_id:command,p_data:data})).record;
  const productSave=(data,{user=users.admin,id=null,version=0,command=randomUUID(),acknowledged=null}={})=>rpc('erp_catalog_product_save',{p_user_id:user,p_id:id,p_expected_version:version,p_command_id:command,p_data:data,p_acknowledged:acknowledged});
  const productGet=(id,user=users.admin)=>rpc('erp_catalog_product_get',{p_user_id:user,p_id:id});
  const taxonomy=(kind,user=users.admin)=>rpc('erp_catalog_taxonomy_list',{p_user_id:user,p_kind:kind});
  const taxonomySave=(kind,data,{user=users.admin,id=null,version=0,command=randomUUID()}={})=>rpc('erp_catalog_taxonomy_save',{p_user_id:user,p_kind:kind,p_id:id,p_expected_version:version,p_command_id:command,p_data:data});
  const taxonomyDelete=(kind,id,version,{user=users.admin,command=randomUUID()}={})=>rpc('erp_catalog_taxonomy_delete',{p_user_id:user,p_kind:kind,p_id:id,p_expected_version:version,p_command_id:command});
  const setDeleted=(id,version,deleted,{user=users.admin,command=randomUUID()}={})=>rpc('erp_catalog_product_set_deleted',{p_user_id:user,p_id:id,p_expected_version:version,p_command_id:command,p_deleted:deleted});
  const stock=async(product,warehouse,quantity,kind=quantity.startsWith('-')?'issue':'receipt')=>rpc('erp_stock_post',{p_user_id:users.estoque,p_command_id:randomUUID(),p_kind:kind,p_occurred_on:'2026-10-15',p_reason:'Movimento sintético',
   p_items:[{product_id:product,warehouse_id:warehouse,quantity,expected_version:await scalar('select coalesce((select version from erp_stock.balance where product_id=$1 and warehouse_id=$2),0) v',[product,warehouse])}]});
  return{db,users,rows,scalar,rpc,save,productSave,productGet,taxonomy,taxonomySave,taxonomyDelete,setDeleted,stock,close:()=>db.close()};
 }catch(error){await db.close();throw error;}
}
export const fails=(assert,promise,code)=>assert.rejects(promise,error=>error.code===code);
