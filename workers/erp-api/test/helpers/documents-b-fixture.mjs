// Synthetic PGlite fixture for the documentos lane B (migrations 129-134 on top of every published migration, up to 118).
// Every RPC goes through the real Worker handler, as in production. No real data.
import{PGlite}from'@electric-sql/pglite';import{readFile,readdir}from'node:fs/promises';import{randomUUID}from'node:crypto';
import{bootstrap}from'../../../../tools/migration/helpers/stock-reservation-fixture.mjs';
import{createHandler}from'../../src/index.mjs';
const dir=new URL('../../../../supabase/migrations/',import.meta.url);
const sql=async name=>(await readFile(new URL(name,dir),'utf8')).replace(/\r\n/g,'\n');
// Supabase Auth columns read by migration 117 (absent from the shared bootstrap stub).
const AUTH_COLUMNS="alter table auth.users add column email text,add column created_at timestamptz not null default clock_timestamp(),add column invited_at timestamptz,add column email_confirmed_at timestamptz,add column last_sign_in_at timestamptz,add column banned_until timestamptz,add column is_anonymous boolean not null default false;";
export const PUBLISHED=name=>/^20261(01[67]|019)\d{4}_.+\.sql$/.test(name)||/^2026102001(0[2-9]|1[0-8])_.+\.sql$/.test(name);
export const LANE=name=>/^2026102001(29|3[0-4])_.+\.sql$/.test(name);
const snapshots=new Map();
function snapshot(upto){
 if(!snapshots.has(upto))snapshots.set(upto,(async()=>{const db=new PGlite();try{
  await db.exec(bootstrap);await db.exec(AUTH_COLUMNS);
  const names=(await readdir(dir)).sort();
  for(const name of names.filter(PUBLISHED))await db.exec(await sql(name));
  for(const name of names.filter(LANE).filter(name=>!upto||name.slice(0,12)<=upto))await db.exec(await sql(name));
  return await db.dumpDataDir('none');
 }finally{await db.close();}})());
 return snapshots.get(upto);
}
const env={SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://synthetic.invalid'};
/** `upto` (a migration prefix such as '202610200129') limits the lane files; omitted, every lane file is applied. */
export async function documentsFixture({upto=null}={}){const db=new PGlite({loadDataDir:await snapshot(upto)});try{
 await db.waitReady;
 const scalar=async(text,args=[])=>(await db.query(text,args)).rows[0]?.v;
 const rpc=async(name,args)=>{const e=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${e.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,e.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}};
 const users=Object.fromEntries(['admin','consulta','vendas','financeiro','estoque','fiscal'].map(r=>[r,randomUUID()]));
 for(const[role,id]of Object.entries(users)){await db.query('insert into auth.users(id,email)values($1,$2)',[id,`${role}@sintetico.test`]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[id,role]);}
 const handler=createHandler({fetchImpl:async(url,options)=>{if(url.endsWith('/auth/v1/user'))return Response.json({id:options.headers.Authorization.slice(7)});
  try{return Response.json(await rpc(new URL(url).pathname.split('/').at(-1),JSON.parse(options.body)));}catch(e){return Response.json({code:e.code,message:'SANITIZE_SYNTHETIC_SQL_ERROR'},{status:400});}}});
 const call=async(path,method='GET',body,user=users.admin)=>{const response=await handler(new Request('https://api.synthetic.invalid'+path,{method,headers:{Authorization:'Bearer '+user,Origin:'https://synthetic.invalid',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),env);return{status:response.status,value:await response.json()};};
 const catalog=async(entity,data)=>(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data})).record;
 const contact=await catalog('contacts',{name:'Contato sintético B'});
 const product=await catalog('products',{name:'Produto sintético B',unit:'UN',kind:'P',format:'S',price:'10'});
 const other=await catalog('products',{name:'Outro produto sintético B',unit:'UN',kind:'P',format:'S',price:'5'});
 // Company preferences saved through the real RPC (one command per call, CAS on the version read).
 const setPreference=async(page,key,value)=>{const current=(await rpc('erp_preferences_page',{p_user_id:users.admin,p_page:page})).items.find(item=>item.key===key);
  return rpc('erp_preferences_save',{p_user_id:users.admin,p_command_id:randomUUID(),p_page:page,p_changes:[{key,expected_version:current.version,value}]});};
 const line=(extra={})=>({product_id:null,description:'Item sintético',detailed_description:null,code:null,unit:'UN',quantity:'1',unit_price:'10',discount_percent:'0',...extra});
 const data=(kind,extra={})=>({date:'2026-10-20',contact_id:contact.id,items:kind==='service_orders'?[]:[line()],discount_mode:'amount',discount_value:'0',freight:'0',other_expenses:'0',installments:[],commercial:null,...extra});
 return{db,scalar,rpc,users,call,catalog,contact,product,other,setPreference,line,data,close:()=>db.close()};
}catch(e){await db.close();throw e;}}
