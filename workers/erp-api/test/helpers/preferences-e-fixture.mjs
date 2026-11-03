// Synthetic PGlite fixture for the Preferências, Sistema and Meu Negócio lane, wave E: every migration applied in production
// (through 202610200233, waves A to D of every lane) and then this lane's files 202610200262-266 that exist. No real data.
import{PGlite}from'@electric-sql/pglite';import{readFile,readdir}from'node:fs/promises';import{randomUUID}from'node:crypto';
import{bootstrap}from'../../../../tools/migration/helpers/stock-reservation-fixture.mjs';
const dir=new URL('../../../../supabase/migrations/',import.meta.url);
export const migrationSql=async name=>(await readFile(new URL(name,dir),'utf8')).replace(/\r\n/g,'\n');
export const PRODUCTION=name=>/^20261(01[67]|019|020)\d{4}_.+\.sql$/.test(name)&&name.slice(0,12)<='202610200233';
export const LANE_E=name=>/^2026102002(6[2-6])_.+\.sql$/.test(name);
// Supabase Auth columns and tables read by migrations 117, 151 and later (absent from the shared bootstrap stub).
const AUTH="alter table auth.users add column email text,add column created_at timestamptz not null default clock_timestamp(),add column invited_at timestamptz,add column email_confirmed_at timestamptz,add column last_sign_in_at timestamptz,add column banned_until timestamptz,add column is_anonymous boolean not null default false;"+
 "create table auth.sessions(id uuid primary key,user_id uuid not null,created_at timestamptz,updated_at timestamptz,refreshed_at timestamp,user_agent text,ip inet,aal text,not_after timestamptz);"+
 "create table auth.mfa_factors(id uuid primary key,user_id uuid not null,friendly_name text,factor_type text,status text,created_at timestamptz,updated_at timestamptz,secret text);"+
 "create table auth.mfa_challenges(id uuid primary key,factor_id uuid not null,created_at timestamptz,verified_at timestamptz,ip_address inet,otp_code text);";
const snapshots=new Map();
/** `before` (a migration prefix such as '202610200263') stops the lane files before it; omitted, every lane file is applied. */
function snapshot(before){
 if(!snapshots.has(before))snapshots.set(before,(async()=>{const db=new PGlite();try{
  await db.exec(bootstrap);await db.exec(AUTH);
  const names=(await readdir(dir)).sort();
  for(const name of names.filter(PRODUCTION))await db.exec(await migrationSql(name));
  for(const name of names.filter(LANE_E).filter(name=>!before||name.slice(0,12)<before))await db.exec(await migrationSql(name));
  return await db.dumpDataDir('none');
 }finally{await db.close();}})());
 return snapshots.get(before);
}
export async function laneEFixture({before=null}={}){const db=new PGlite({loadDataDir:await snapshot(before)});try{
 await db.waitReady;
 const scalar=async(text,args=[])=>(await db.query(text,args)).rows[0]?.v;
 const rpc=async(name,args)=>{const e=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${e.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,e.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}};
 const users=Object.fromEntries(['admin','other','consulta','vendas','financeiro','estoque','fiscal','inactive'].map(r=>[r,randomUUID()]));
 for(const[role,id]of Object.entries(users)){await db.query('insert into auth.users(id,email)values($1,$2)',[id,`${role}@sintetico.test`]);
  await db.query('insert into erp_access.membership(user_id,role,active)values($1,$2,$3)',[id,role==='other'?'admin':role==='inactive'?'vendas':role,role!=='inactive']);}
 const catalog=async(entity,data,user=users.admin)=>(await rpc('erp_catalog_save',{p_user_id:user,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data})).record;
 const preference=async(page,key,value,user=users.admin)=>{const current=(await rpc('erp_preferences_page',{p_user_id:user,p_page:page})).items.find(item=>item.key===key);
  return rpc('erp_preferences_save',{p_user_id:user,p_command_id:randomUUID(),p_page:page,p_changes:[{key,expected_version:current.version,value}]});};
 const migrate=async name=>db.exec(await migrationSql(name));
 const transition=async(doc,status)=>(await rpc('erp_document_transition',{p_user_id:users.admin,p_kind:doc.kind,p_id:doc.id,p_expected_version:doc.version,p_command_id:randomUUID(),p_status:status,p_reason:'Transição sintética'})).document;
 /** A native document with lines [{product_id,description,quantity,unit_price}], taken through `statuses` in order. */
 const document=async(kind,{contact,items,date='2026-10-15',statuses=[],body={}})=>{
  let d=(await rpc('erp_document_save',{p_user_id:users.admin,p_kind:kind,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date,contact_id:contact,...body,items:items.map(i=>({unit:'UN',...i}))}})).document;
  for(const s of statuses)d=await transition(d,s);return d;};
 return{db,scalar,rpc,users,catalog,preference,migrate,transition,document,close:()=>db.close()};
}catch(e){await db.close();throw e;}}
export const fails=async(assert,fn,code)=>assert.rejects(fn,e=>e.code===code);
