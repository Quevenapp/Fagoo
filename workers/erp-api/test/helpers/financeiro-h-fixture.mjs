// Synthetic PGlite fixture for the financeiro lane of wave H (política de contas, formas padrão, remessa sem banco, comissões, frete e custo):
// every migration applied in production (through 202610200305), the acesso lane (202610210310-329) and this lane's files 202610210370-389.
// No real data.
import{PGlite}from'@electric-sql/pglite';import{readFile,readdir}from'node:fs/promises';import{randomUUID}from'node:crypto';
import{bootstrap}from'../../../../tools/migration/helpers/stock-reservation-fixture.mjs';
import{createHandler}from'../../src/index.mjs';
const dir=new URL('../../../../supabase/migrations/',import.meta.url);
export const migrationSql=async name=>(await readFile(new URL(name,dir),'utf8')).replace(/\r\n/g,'\n');
export const PRODUCTION=name=>/^20261(01[67]|019|020)\d{4}_.+\.sql$/.test(name)&&name.slice(0,12)<='202610200305';
export const LANE_H=name=>/^2026102103([12][0-9]|[78][0-9])_.+\.sql$/.test(name);
// Supabase Auth columns and tables read by migrations 117, 151 and later (absent from the shared bootstrap stub).
const AUTH="alter table auth.users add column email text,add column created_at timestamptz not null default clock_timestamp(),add column invited_at timestamptz,add column email_confirmed_at timestamptz,add column last_sign_in_at timestamptz,add column banned_until timestamptz,add column is_anonymous boolean not null default false;"+
 "create table auth.sessions(id uuid primary key,user_id uuid not null,created_at timestamptz,updated_at timestamptz,refreshed_at timestamp,user_agent text,ip inet,aal text,not_after timestamptz);"+
 "create table auth.mfa_factors(id uuid primary key,user_id uuid not null,friendly_name text,factor_type text,status text,created_at timestamptz,updated_at timestamptz,secret text);"+
 "create table auth.mfa_challenges(id uuid primary key,factor_id uuid not null,created_at timestamptz,verified_at timestamptz,ip_address inet,otp_code text);";
const snapshots=new Map();
/** `before` (a migration prefix such as '202610200305') stops the lane files before it; omitted, every lane file is applied. */
function snapshot(before){
 if(!snapshots.has(before))snapshots.set(before,(async()=>{const db=new PGlite();try{
  await db.exec(bootstrap);await db.exec(AUTH);
  const names=(await readdir(dir)).sort();
  for(const name of names.filter(PRODUCTION))await db.exec(await migrationSql(name));
  for(const name of names.filter(LANE_H).filter(name=>!before||name.slice(0,12)<before))await db.exec(await migrationSql(name));
  return await db.dumpDataDir('none');
 }finally{await db.close();}})());
 return snapshots.get(before);
}
export async function financeiroHFixture({before=null}={}){const db=new PGlite({loadDataDir:await snapshot(before)});try{
 await db.waitReady;
 const scalar=async(text,args=[])=>(await db.query(text,args)).rows[0]?.v;
 const rpc=async(name,args)=>{const e=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${e.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,e.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}};
 const users=Object.fromEntries(['admin','other','consulta','vendas','financeiro','estoque','fiscal','inactive'].map(r=>[r,randomUUID()]));
 for(const[role,id]of Object.entries(users)){await db.query('insert into auth.users(id,email)values($1,$2)',[id,`${role}@sintetico.test`]);
  await db.query('insert into erp_access.membership(user_id,role,active)values($1,$2,$3)',[id,role==='other'?'admin':role==='inactive'?'vendas':role,role!=='inactive']);}
 const catalog=async(entity,data,user=users.admin)=>(await rpc('erp_catalog_save',{p_user_id:user,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data})).record;
 const page=async(name,user=users.admin)=>rpc('erp_preferences_page',{p_user_id:user,p_page:name});
 const preference=async(name,key,value,user=users.admin)=>{const current=(await page(name,user)).items.find(item=>item.key===key);
  return rpc('erp_preferences_save',{p_user_id:user,p_command_id:randomUUID(),p_page:name,p_changes:[{key,expected_version:current.version,value}]});};
 const migrate=async name=>db.exec(await migrationSql(name));
 // The real Worker over the synthetic database (Auth answers the bearer as the user id; PostgREST calls go to rpc).
 const env={SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://synthetic.invalid'};
 const handler=createHandler({fetchImpl:async(url,options)=>{if(url.endsWith('/auth/v1/user'))return Response.json({id:options.headers.Authorization.slice(7)});
  const name=new URL(url).pathname.split('/').at(-1);
  try{return Response.json(await rpc(name,JSON.parse(options.body)));}catch(e){return Response.json({code:e.code,message:/^erp_[a-z0-9_]{1,80}$/.test(e.message)?e.message:'SANITIZE_SYNTHETIC_SQL_ERROR'},{status:400});}}});
 const call=async(path,method='GET',body,user=users.admin)=>{const response=await handler(new Request('https://api.synthetic.invalid'+path,{method,headers:{Authorization:'Bearer '+user,Origin:'https://synthetic.invalid',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),env);return{status:response.status,value:await response.json()};};
 const transition=async(doc,status)=>(await rpc('erp_document_transition',{p_user_id:users.admin,p_kind:doc.kind,p_id:doc.id,p_expected_version:doc.version,p_command_id:randomUUID(),p_status:status,p_reason:'Transição sintética'})).document;
 /** A native document with lines [{product_id,description,quantity,unit_price}], taken through `statuses` in order. */
 const document=async(kind,{contact,items,date='2026-10-15',statuses=[],body={}})=>{
  let d=(await rpc('erp_document_save',{p_user_id:users.admin,p_kind:kind,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date,contact_id:contact,...body,items:items.map(i=>({unit:'UN',...i}))}})).document;
  for(const s of statuses)d=await transition(d,s);return d;};
 /** A custom situation of the Gerenciador de transições (148), based on a default status (for example 'verified'); its id. */
 const situation=async(kind,base,name,color='#336699')=>(await rpc('erp_preferences_situation_save',{p_user_id:users.admin,p_command_id:randomUUID(),p_kind:kind,p_situation:null,p_expected_version:0,
  p_data:{base_status:base,name,color,active:true}})).receipt.target;
 return{db,scalar,rpc,call,users,catalog,page,preference,migrate,transition,document,situation,close:()=>db.close()};
}catch(e){await db.close();throw e;}}
export const fails=async(assert,fn,code)=>assert.rejects(fn,e=>e.code===code);
