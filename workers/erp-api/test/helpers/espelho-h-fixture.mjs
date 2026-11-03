// Synthetic PGlite fixture for the espelho lane of wave H (Origin mirror fields, categories, situations, fiscal origin and reports):
// every migration applied in production (through 202610200305, waves A to G), the wave H files already on this branch
// (202610210310-349) and then this lane's files 202610210350-369 that exist. No real data.
import{PGlite}from'@electric-sql/pglite';import{readFile,readdir}from'node:fs/promises';import{randomUUID,createHash}from'node:crypto';
import{bootstrap}from'../../../../tools/migration/helpers/stock-reservation-fixture.mjs';
const dir=new URL('../../../../supabase/migrations/',import.meta.url);
export const migrationSql=async name=>(await readFile(new URL(name,dir),'utf8')).replace(/\r\n/g,'\n');
export const PRODUCTION=name=>/^20261(01[67]|019|020)\d{4}_.+\.sql$/.test(name)&&name.slice(0,12)<='202610200305';
export const WAVE_H_BEFORE=name=>/^2026102103[1-4][0-9]_.+\.sql$/.test(name);
export const LANE_H=name=>/^2026102103[56][0-9]_.+\.sql$/.test(name);
const AUTH="alter table auth.users add column email text,add column created_at timestamptz not null default clock_timestamp(),add column invited_at timestamptz,add column email_confirmed_at timestamptz,add column last_sign_in_at timestamptz,add column banned_until timestamptz,add column is_anonymous boolean not null default false;"+
 "create table auth.sessions(id uuid primary key,user_id uuid not null,created_at timestamptz,updated_at timestamptz,refreshed_at timestamp,user_agent text,ip inet,aal text,not_after timestamptz);"+
 "create table auth.mfa_factors(id uuid primary key,user_id uuid not null,friendly_name text,factor_type text,status text,created_at timestamptz,updated_at timestamptz,secret text);"+
 "create table auth.mfa_challenges(id uuid primary key,factor_id uuid not null,created_at timestamptz,verified_at timestamptz,ip_address inet,otp_code text);";
const snapshots=new Map();
/** `before` (a migration prefix such as '202610210352') stops the lane files before it; omitted, every lane file is applied. */
function snapshot(before){
 if(!snapshots.has(before))snapshots.set(before,(async()=>{const db=new PGlite();try{
  await db.exec(bootstrap);await db.exec(AUTH);
  const names=(await readdir(dir)).sort();
  for(const name of names.filter(PRODUCTION))await db.exec(await migrationSql(name));
  for(const name of names.filter(WAVE_H_BEFORE))await db.exec(await migrationSql(name));
  // ESPELHO_H_MAX (a prefix such as '202610210355') leaves out the lane files after it while another part of the lane is in progress.
  const max=process.env.ESPELHO_H_MAX??null;
  for(const name of names.filter(LANE_H).filter(name=>(!before||name.slice(0,12)<before)&&(!max||name.slice(0,12)<=max)))await db.exec(await migrationSql(name));
  return await db.dumpDataDir('none');
 }finally{await db.close();}})());
 return snapshots.get(before);
}
const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export async function espelhoHFixture({before=null}={}){const db=new PGlite({loadDataDir:await snapshot(before)});try{
 await db.waitReady;
 const scalar=async(text,args=[])=>(await db.query(text,args)).rows[0]?.v;
 const rpc=async(name,args)=>{const e=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${e.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,e.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}};
 const users=Object.fromEntries(['admin','other','consulta','vendas','financeiro','estoque','fiscal','inactive'].map(r=>[r,randomUUID()]));
 for(const[role,id]of Object.entries(users)){await db.query('insert into auth.users(id,email)values($1,$2)',[id,`${role}@sintetico.test`]);
  await db.query('insert into erp_access.membership(user_id,role,active)values($1,$2,$3)',[id,role==='other'?'admin':role==='inactive'?'vendas':role,role!=='inactive']);}
 const catalog=async(entity,data,user=users.admin)=>(await rpc('erp_catalog_save',{p_user_id:user,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data})).record;
 /**
  * Writes a synthetic Origin mirror row straight into origin_sync.raw_record (what origin_sync_apply_batch keeps), as the
  * collector would after a detail read. `updated` is the source_updated_at; a repeated identical payload keeps its hash.
  */
 const RESOURCE={products:'products_zero',nfe:'nfe_out'};
 const mirror=async(entity,sourceId,payload,{updated=null,resource=RESOURCE[entity]??entity}={})=>{const hash=sha(payload);
  await db.query('insert into origin_sync.resource_state(resource)values($1)on conflict do nothing',[resource]);
  await db.query(`insert into origin_sync.raw_record(entity,source_id,payload,version_hash,version,source_updated_at,first_seen_at,last_seen_at,changed_at,last_resource)
   values($1,$2,$3,$4,1,$5,clock_timestamp(),clock_timestamp(),clock_timestamp(),$6)
   on conflict(entity,source_id) do update set payload=excluded.payload,version_hash=excluded.version_hash,version=origin_sync.raw_record.version+case when origin_sync.raw_record.version_hash=excluded.version_hash then 0 else 1 end,
    source_updated_at=excluded.source_updated_at,last_seen_at=excluded.last_seen_at,changed_at=case when origin_sync.raw_record.version_hash=excluded.version_hash then origin_sync.raw_record.changed_at else excluded.changed_at end`,
   [entity,String(sourceId),JSON.stringify(payload),hash,updated,resource]);return hash;};
 /** The admin import of the catalog review (013): preview then apply the given Origin source ids. */
 const importOrigin=async(entity,ids,user=users.admin)=>{const items=[];for(const id of ids){items.push({source_id:String(id),source_hash:await scalar('select version_hash v from origin_sync.raw_record where entity=$1 and source_id=$2',[entity,String(id)])});}
  const preview=await rpc('erp_catalog_import_preview',{p_user_id:user,p_entity:entity,p_items:items});
  return rpc('erp_catalog_import_apply',{p_user_id:user,p_entity:entity,p_items:items,p_command_id:randomUUID(),p_preview_hash:preview.preview_hash});};
 const migrate=async name=>db.exec(await migrationSql(name));
 return{db,scalar,rpc,users,catalog,mirror,importOrigin,migrate,sha,close:()=>db.close()};
}catch(e){await db.close();throw e;}}
export const fails=async(assert,fn,code)=>assert.rejects(fn,e=>e.code===code);
