// Synthetic PGlite fixture for the Preferências lane (migrations 115-118, and the wave B migrations 148-152 that exist).
// No real data.
import{PGlite}from'@electric-sql/pglite';import{readFile,readdir}from'node:fs/promises';import{randomUUID}from'node:crypto';
import{bootstrap}from'../../../../tools/migration/helpers/stock-reservation-fixture.mjs';
import{WAVE_B_MIGRATIONS}from'./system-fixture.mjs';
export const LANE_MIGRATIONS=['202610200115_erp_preferences.sql','202610200116_list_preferences.sql','202610200117_access_users.sql','202610200118_activity_files.sql'];
const exists=async name=>{try{await readFile(new URL(name,dir));return true;}catch{return false;}};
const dir=new URL('../../../../supabase/migrations/',import.meta.url);
const sql=async name=>(await readFile(new URL(name,dir),'utf8')).replace(/\r\n/g,'\n');
// Supabase Auth columns read by migration 117 (absent from the shared bootstrap stub).
const AUTH_COLUMNS="alter table auth.users add column email text,add column created_at timestamptz not null default clock_timestamp(),add column invited_at timestamptz,add column email_confirmed_at timestamptz,add column last_sign_in_at timestamptz,add column banned_until timestamptz,add column is_anonymous boolean not null default false;";
const snapshots=new Map();
function snapshot(lane){
 const key=lane.join(',');
 if(!snapshots.has(key))snapshots.set(key,(async()=>{const db=new PGlite();try{
  await db.exec(bootstrap);await db.exec(AUTH_COLUMNS);
  // Published order: 001-101, the other lanes' 102-114 (applied in production with 115-118), this lane's files, then the
  // wave B files that exist (148-152; 150 reads documents and the stock of 102-107).
  for(const name of(await readdir(dir)).filter(n=>(/^20261(01[67]|019)\d{4}_.+\.sql$/.test(n)||/^20261020(010\d|011[0-4])_.+\.sql$/.test(n))&&!lane.includes(n)).sort())await db.exec(await sql(name));
  for(const name of lane)await db.exec(await sql(name));
  // Another lane (notas fiscais: 111-115 and 140-143) brings its own files, so they are not applied twice, and the wave B
  // Preferências files (which need 116-118) join only this lane's own snapshot.
  if(lane.includes('202610200118_activity_files.sql'))for(const name of WAVE_B_MIGRATIONS)if(await exists(name))await db.exec(await sql(name));
  return await db.dumpDataDir('none');
 }finally{await db.close();}})());
 return snapshots.get(key);
}
export async function preferencesFixture({lane=LANE_MIGRATIONS}={}){const db=new PGlite({loadDataDir:await snapshot(lane)});try{
 await db.waitReady;
 const scalar=async(text,args=[])=>(await db.query(text,args)).rows[0]?.v;
 const rpc=async(name,args)=>{const e=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${e.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,e.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}};
 const users=Object.fromEntries(['admin','other','consulta','vendas','financeiro','estoque','fiscal','inactive'].map(r=>[r,randomUUID()]));
 for(const[role,id]of Object.entries(users)){await db.query('insert into auth.users(id,email)values($1,$2)',[id,`${role}@sintetico.test`]);
  await db.query('insert into erp_access.membership(user_id,role,active)values($1,$2,$3)',[id,role==='other'?'admin':role==='inactive'?'vendas':role,role!=='inactive']);}
 const page=(pageId,user=users.admin)=>rpc('erp_preferences_page',{p_user_id:user,p_page:pageId});
 const save=(pageId,changes,{user=users.admin,command=randomUUID()}={})=>rpc('erp_preferences_save',{p_user_id:user,p_command_id:command,p_page:pageId,p_changes:changes});
 const command=(id,user=users.admin)=>rpc('erp_preferences_command',{p_user_id:user,p_command_id:id});
 const list=(listId,user=users.admin)=>rpc('erp_list_preferences_get',{p_user_id:user,p_list_id:listId});
 const saveList=(listId,{user=users.admin,command=randomUUID(),expected=0,columns=null,filters=null}={})=>rpc('erp_list_preferences_save',{p_user_id:user,p_command_id:command,p_list_id:listId,p_expected_version:expected,p_columns:columns,p_filters:filters});
 const listCommand=(id,user=users.admin)=>rpc('erp_list_preferences_command',{p_user_id:user,p_command_id:id});
 return{db,scalar,rpc,users,page,save,command,list,saveList,listCommand,close:()=>db.close()};
}catch(e){await db.close();throw e;}}
export const fails=async(assert,fn,code,message)=>assert.rejects(fn,e=>e.code===code&&(!message||e.message===message));
