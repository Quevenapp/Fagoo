// Synthetic PGlite fixture for the Preferências and Sistema lane, wave B: every published migration (through 118, the
// production state) and then the lane migrations 148-152 that exist. No real data.
import{PGlite}from'@electric-sql/pglite';import{readFile,readdir}from'node:fs/promises';import{randomUUID}from'node:crypto';
import{bootstrap}from'../../../../tools/migration/helpers/stock-reservation-fixture.mjs';
export const WAVE_B_MIGRATIONS=['202610200148_system_frameworks.sql','202610200149_custom_reports_labels.sql','202610200150_business_dashboards.sql','202610200151_notifications_company.sql','202610200152_home_shortcut_catalog.sql'];
const dir=new URL('../../../../supabase/migrations/',import.meta.url);
export const migrationSql=async name=>(await readFile(new URL(name,dir),'utf8')).replace(/\r\n/g,'\n');
// Supabase Auth columns read by migrations 117 and later (absent from the shared bootstrap stub).
const AUTH_COLUMNS="alter table auth.users add column email text,add column created_at timestamptz not null default clock_timestamp(),add column invited_at timestamptz,add column email_confirmed_at timestamptz,add column last_sign_in_at timestamptz,add column banned_until timestamptz,add column is_anonymous boolean not null default false;"+
 // Supabase Auth sessions and MFA tables read by migration 151 (Dispositivos utilizados, Histórico do segundo fator).
 "create table auth.sessions(id uuid primary key,user_id uuid not null,created_at timestamptz,updated_at timestamptz,refreshed_at timestamp,user_agent text,ip inet,aal text,not_after timestamptz);"+
 "create table auth.mfa_factors(id uuid primary key,user_id uuid not null,friendly_name text,factor_type text,status text,created_at timestamptz,updated_at timestamptz,secret text);"+
 "create table auth.mfa_challenges(id uuid primary key,factor_id uuid not null,created_at timestamptz,verified_at timestamptz,ip_address inet,otp_code text);";
async function exists(name){try{await readFile(new URL(name,dir));return true;}catch{return false;}}
export async function publishedMigrations(){return(await readdir(dir)).filter(n=>/^20261(01[67]|019|020)\d{4}_.+\.sql$/.test(n)&&n<'202610200119').sort();}
const snapshots=new Map();
function snapshot(key,lane){
 if(!snapshots.has(key))snapshots.set(key,(async()=>{const db=new PGlite();try{
  await db.exec(bootstrap);await db.exec(AUTH_COLUMNS);
  for(const name of await publishedMigrations())await db.exec(await migrationSql(name));
  for(const name of lane)if(await exists(name))await db.exec(await migrationSql(name));
  return await db.dumpDataDir('none');
 }finally{await db.close();}})());
 return snapshots.get(key);
}
export async function systemFixture({lane=WAVE_B_MIGRATIONS}={}){const db=new PGlite({loadDataDir:await snapshot(lane.join(','),lane)});try{
 await db.waitReady;
 const scalar=async(text,args=[])=>(await db.query(text,args)).rows[0]?.v;
 const rpc=async(name,args)=>{const e=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${e.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,e.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}};
 const users=Object.fromEntries(['admin','other','consulta','vendas','financeiro','estoque','fiscal','inactive'].map(r=>[r,randomUUID()]));
 for(const[role,id]of Object.entries(users)){await db.query('insert into auth.users(id,email)values($1,$2)',[id,`${role}@sintetico.test`]);
  await db.query('insert into erp_access.membership(user_id,role,active)values($1,$2,$3)',[id,role==='other'?'admin':role==='inactive'?'vendas':role,role!=='inactive']);}
 const catalog=async(entity,data,user=users.admin)=>(await rpc('erp_catalog_save',{p_user_id:user,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data})).record;
 const transition=async(doc,status)=>(await rpc('erp_document_transition',{p_user_id:users.admin,p_kind:doc.kind,p_id:doc.id,p_expected_version:doc.version,p_command_id:randomUUID(),p_status:status,p_reason:'Transição sintética'})).document;
 /** A native document with lines [{product_id,description,quantity,unit_price}], taken through `statuses` in order. */
 const document=async(kind,{contact,items,date='2026-10-15',warehouse=null,statuses=[],body={}})=>{
  let d=(await rpc('erp_document_save',{p_user_id:users.admin,p_kind:kind,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date,contact_id:contact,...(warehouse?{warehouse_id:warehouse}:{}),...body,
   items:items.map(i=>({unit:'UN',...i}))}})).document;
  for(const s of statuses)d=await transition(d,s);return d;};
 const preference=(page,changes,user=users.admin)=>rpc('erp_preferences_save',{p_user_id:user,p_command_id:randomUUID(),p_page:page,p_changes:changes});
 return{db,scalar,rpc,users,catalog,transition,document,preference,close:()=>db.close()};
}catch(e){await db.close();throw e;}}
export const fails=async(assert,fn,code)=>assert.rejects(fn,e=>e.code===code);
