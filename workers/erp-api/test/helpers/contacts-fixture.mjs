// Synthetic PGlite fixture for the contatos lane (migrations 202610200124-128). Every migration published up to
// 202610200118 is applied first, in order, then this lane's files. Synthetic actors and data only.
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {bootstrap} from '../../../../tools/migration/helpers/stock-reservation-fixture.mjs';

export const CONTACT_LANE=['202610200124_contact_profile.sql','202610200125_contact_list.sql','202610200126_sellers.sql','202610200127_payment_methods.sql','202610200128_employees.sql'];
const dir=new URL('../../../../supabase/migrations/',import.meta.url);
const sql=async name=>(await readFile(new URL(name,dir),'utf8')).replace(/\r\n/g,'\n');
// Supabase Auth columns read by migration 117 (absent from the shared bootstrap stub).
const AUTH_COLUMNS="alter table auth.users add column email text,add column created_at timestamptz not null default clock_timestamp(),add column invited_at timestamptz,add column email_confirmed_at timestamptz,add column last_sign_in_at timestamptz,add column banned_until timestamptz,add column is_anonymous boolean not null default false;";
const snapshots=new Map();
const TEXT_ARRAYS=new Set(['p_sale_statuses']);
function snapshot(lane){
 const key=lane.join(',');
 if(!snapshots.has(key))snapshots.set(key,(async()=>{const db=new PGlite();try{
  await db.exec(bootstrap);await db.exec(AUTH_COLUMNS);
  const published=(await readdir(dir)).filter(n=>/^20261\d{7}_.+\.sql$/.test(n)&&n.slice(0,12)<='202610200118').sort();
  for(const name of published)await db.exec(await sql(name));
  for(const name of lane)await db.exec(await sql(name));
  return await db.dumpDataDir('none');
 }finally{await db.close();}})());
 return snapshots.get(key);
}
export async function contactsFixture({lane=CONTACT_LANE}={}){
 const db=new PGlite({loadDataDir:await snapshot(lane)});
 try{
  await db.waitReady;
  const scalar=async(text,args=[])=>(await db.query(text,args)).rows[0]?.v;
  const rows=async(text,args=[])=>(await db.query(text,args)).rows;
  const rpc=async(name,args)=>{const e=Object.entries(args);await db.exec('set role service_role');
   // text[] parameters travel as PostgreSQL arrays (PostgREST converts the JSON array the Worker sends); the rest as JSON.
   try{return await scalar(`select public.${name}(${e.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,e.map(([k,v])=>TEXT_ARRAYS.has(k)&&Array.isArray(v)?v:v!==null&&typeof v==='object'?JSON.stringify(v):v));}
   finally{await db.exec('reset role');}};
  const users=Object.fromEntries(['admin','other','consulta','vendas','financeiro','estoque','fiscal','inactive'].map(r=>[r,randomUUID()]));
  for(const[role,id]of Object.entries(users)){
   await db.query('insert into auth.users(id,email)values($1,$2)',[id,`${role}@sintetico.test`]);
   await db.query('insert into erp_access.membership(user_id,role,active)values($1,$2,$3)',[id,role==='other'?'vendas':role==='inactive'?'admin':role,role!=='inactive']);
  }
  const save=async(data,{user=users.admin,id=null,version=0,command=randomUUID(),acknowledged=null}={})=>rpc('erp_catalog_contact_save',{p_user_id:user,p_id:id,p_expected_version:version,p_command_id:command,p_data:data,p_acknowledged:acknowledged});
  const get=(id,user=users.admin)=>rpc('erp_catalog_contact_get',{p_user_id:user,p_id:id});
  const page=(args={},user=users.admin)=>rpc('erp_catalog_contact_page',{p_user_id:user,...args});
  // Preferências are written through the real RPC, as an administrator would.
  const preference=async(key,value)=>{const page='cadastros-contatos',current=(await rpc('erp_preferences_page',{p_user_id:users.admin,p_page:page})).items.find(item=>item.key===key);
   return rpc('erp_preferences_save',{p_user_id:users.admin,p_command_id:randomUUID(),p_page:page,p_changes:[{key,expected_version:current.version,value}]});};
  return{db,scalar,rows,rpc,users,save,get,page,preference,close:()=>db.close()};
 }catch(error){await db.close();throw error;}
}
export const fails=(assert,promise,code)=>assert.rejects(promise,error=>error.code===code||error.message===code);
