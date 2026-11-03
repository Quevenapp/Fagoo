// Synthetic PGlite fixture for the produtos lane, wave C (migrations 202610200153-157): every migration up to 202610200152
// (the production state on 20/10/2026), in order, then this lane's files that exist. Synthetic actors and data only.
import{PGlite}from'@electric-sql/pglite';import{readFile,readdir}from'node:fs/promises';import{randomUUID}from'node:crypto';
import{bootstrap}from'../../../../tools/migration/helpers/stock-reservation-fixture.mjs';
export const PRODUCTS_C_MIGRATIONS=['202610200153_catalog_tags_contacts.sql','202610200154_price_lists_v2.sql','202610200155_product_price_tools.sql','202610200156_product_custom_fields.sql','202610200157_product_settings_c.sql'];
const dir=new URL('../../../../supabase/migrations/',import.meta.url);
export const migrationSql=async name=>(await readFile(new URL(name,dir),'utf8')).replace(/\r\n/g,'\n');
// Supabase Auth columns and tables read by migrations 117 and 151 (absent from the shared bootstrap stub).
const AUTH="alter table auth.users add column email text,add column created_at timestamptz not null default clock_timestamp(),add column invited_at timestamptz,add column email_confirmed_at timestamptz,add column last_sign_in_at timestamptz,add column banned_until timestamptz,add column is_anonymous boolean not null default false;"+
 "create table auth.sessions(id uuid primary key,user_id uuid not null,created_at timestamptz,updated_at timestamptz,refreshed_at timestamp,user_agent text,ip inet,aal text,not_after timestamptz);"+
 "create table auth.mfa_factors(id uuid primary key,user_id uuid not null,friendly_name text,factor_type text,status text,created_at timestamptz,updated_at timestamptz,secret text);"+
 "create table auth.mfa_challenges(id uuid primary key,factor_id uuid not null,created_at timestamptz,verified_at timestamptz,ip_address inet,otp_code text);";
export async function productionMigrations(){return(await readdir(dir)).filter(n=>/^20261\d{7}_.+\.sql$/.test(n)&&n.slice(0,12)<='202610200152').sort();}
async function present(){const names=new Set(await readdir(dir));return PRODUCTS_C_MIGRATIONS.filter(n=>names.has(n));}
// PostgreSQL arrays travel as arrays (PostgREST converts the JSON arrays the Worker sends); the rest as JSON text.
const ARRAYS=new Set(['p_ids','p_product_ids','p_sale_statuses']);
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
export async function produtosFixture({lane}={}){
 const db=new PGlite({loadDataDir:await snapshot(lane??await present())});
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
  const product=async(data,user=users.admin)=>(await rpc('erp_catalog_product_save',{p_user_id:user,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{kind:'P',format:'S',unit:'UN',...data},p_acknowledged:null})).record;
  const contact=async(data,user=users.admin)=>(await rpc('erp_catalog_contact_save',{p_user_id:user,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{person_type:'J',...data},p_acknowledged:null})).record;
  const taxonomySave=(kind,data,{user=users.admin,id=null,version=0,command=randomUUID()}={})=>rpc('erp_catalog_taxonomy_save',{p_user_id:user,p_kind:kind,p_id:id,p_expected_version:version,p_command_id:command,p_data:data});
  const taxonomyDelete=(kind,id,version,{user=users.admin,command=randomUUID()}={})=>rpc('erp_catalog_taxonomy_delete',{p_user_id:user,p_kind:kind,p_id:id,p_expected_version:version,p_command_id:command});
  const taxonomy=(kind,user=users.admin)=>rpc('erp_catalog_taxonomy_list',{p_user_id:user,p_kind:kind});
  const preference=async(page,key,value)=>{const current=(await rpc('erp_preferences_page',{p_user_id:users.admin,p_page:page})).items.find(item=>item.key===key);
   return rpc('erp_preferences_save',{p_user_id:users.admin,p_command_id:randomUUID(),p_page:page,p_changes:[{key,expected_version:current.version,value}]});};
  return{db,scalar,rows,rpc,users,product,contact,taxonomySave,taxonomyDelete,taxonomy,preference,close:()=>db.close()};
 }catch(error){await db.close();throw error;}
}
export const fails=(assert,promise,code)=>assert.rejects(promise,error=>error.code===code||error.message===code);
