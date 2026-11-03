// Synthetic PGlite fixture for the documentos lane, wave E: every migration in order (088 skipped, as in finance-parity-db: it checks
// a production-only definition), so the production state (through 233) plus this lane's files 238-245 and whatever else exists.
// `upto` (a migration prefix such as '202610200233') stops earlier, for the "database before the migration" cases. Every RPC goes
// through the real Worker handler, as in production. No real data.
import{PGlite}from'@electric-sql/pglite';import{readFile,readdir}from'node:fs/promises';import{randomUUID}from'node:crypto';
import{bootstrap}from'../../../../tools/migration/helpers/stock-reservation-fixture.mjs';
import{createHandler}from'../../src/index.mjs';
const dir=new URL('../../../../supabase/migrations/',import.meta.url);
const SKIP=new Set(['202610160088_financial_import_authorization_waits.sql']);
export const migrationSql=async name=>(await readFile(new URL(name,dir),'utf8')).replace(/\r\n/g,'\n');
const AUTH="alter table auth.users add column email text,add column created_at timestamptz not null default clock_timestamp(),add column invited_at timestamptz,add column email_confirmed_at timestamptz,add column last_sign_in_at timestamptz,add column banned_until timestamptz,add column is_anonymous boolean not null default false;"+
 "create table auth.sessions(id uuid primary key,user_id uuid not null,created_at timestamptz,updated_at timestamptz,refreshed_at timestamp,user_agent text,ip inet,aal text,not_after timestamptz);"+
 "create table auth.mfa_factors(id uuid primary key,user_id uuid not null,friendly_name text,factor_type text,status text,created_at timestamptz,updated_at timestamptz,secret text);"+
 "create table auth.mfa_challenges(id uuid primary key,factor_id uuid not null,created_at timestamptz,verified_at timestamptz,ip_address inet,otp_code text);";
/** The lane's migrations, in order (the tests of each one read only these files). */
export const LANE_E=name=>/^2026102002(3[89]|4[0-5])_.+\.sql$/.test(name);
const snapshots=new Map();
function snapshot(upto){
 const key=upto??'all';
 if(!snapshots.has(key))snapshots.set(key,(async()=>{const db=new PGlite();try{
  await db.exec(bootstrap);await db.exec(AUTH);
  const names=(await readdir(dir)).filter(name=>/^\d{12}_.+\.sql$/.test(name)&&!SKIP.has(name)&&(upto===null||name.slice(0,12)<=upto)).sort();
  for(const name of names)await db.exec(await migrationSql(name));
  return await db.dumpDataDir('none');
 }finally{await db.close();}})());
 return snapshots.get(key);
}
const env={SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://synthetic.invalid'};
export async function documentsEFixture({upto=null}={}){const db=new PGlite({loadDataDir:await snapshot(upto)});try{
 await db.waitReady;
 const scalar=async(text,args=[])=>(await db.query(text,args)).rows[0]?.v;
 const rows=async(text,args=[])=>(await db.query(text,args)).rows;
 // PostgREST turns a JSON array into a Postgres array for text[]/uuid[] arguments and keeps JSON for jsonb ones; so does this helper.
 const types=new Map();
 const argTypes=async name=>{if(!types.has(name))types.set(name,new Map((await db.query("select x.n,x.t from pg_proc p,unnest(p.proargnames,string_to_array(oidvectortypes(p.proargtypes),', ')) x(n,t) where p.proname=$1 and p.pronamespace='public'::regnamespace",[name])).rows.map(r=>[r.n,r.t])));return types.get(name);};
 const rpc=async(name,args)=>{const e=Object.entries(args),t=await argTypes(name);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${e.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,e.map(([k,v])=>Array.isArray(v)&&t.get(k)?.endsWith('[]')?v:v!==null&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}};
 const users=Object.fromEntries(['admin','consulta','vendas','vendas2','financeiro','estoque','fiscal'].map(r=>[r,randomUUID()]));
 for(const[role,id]of Object.entries(users)){await db.query('insert into auth.users(id,email)values($1,$2)',[id,`${role}@sintetico.test`]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[id,role.replace(/\d+$/,'')]);}
 const calls=[],auth={calls:[],fail:false};
 const handler=createHandler({fetchImpl:async(url,options)=>{if(url.endsWith('/auth/v1/user'))return Response.json({id:options.headers.Authorization.slice(7)});
  // Supabase Auth admin (the access-gate flag of the users linked to a seller).
  if(url.includes('/auth/v1/admin/users/')){auth.calls.push({user:url.split('/').at(-1),method:options.method,body:JSON.parse(options.body)});if(auth.fail)return Response.json({msg:'synthetic'},{status:500});return Response.json({id:url.split('/').at(-1)});}
  const name=new URL(url).pathname.split('/').at(-1);calls.push(name);
  try{return Response.json(await rpc(name,JSON.parse(options.body)));}catch(e){return Response.json({code:e.code,message:/^erp_[a-z0-9_]{1,80}$/.test(e.message)?e.message:'SANITIZE_SYNTHETIC_SQL_ERROR'},{status:400});}}});
 const call=async(path,method='GET',body,user=users.admin)=>{const response=await handler(new Request('https://api.synthetic.invalid'+path,{method,headers:{Authorization:'Bearer '+user,Origin:'https://synthetic.invalid',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),env);return{status:response.status,value:await response.json()};};
 const catalog=async(entity,data,user=users.admin)=>(await rpc('erp_catalog_save',{p_user_id:user,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data})).record;
 const contact=await catalog('contacts',{name:'Contato sintético E'});
 const product=await catalog('products',{name:'Produto sintético E',unit:'UN',kind:'P',format:'S',price:'10'});
 const recordVersion=async id=>scalar('select version v from erp_catalog.record where id=$1',[id]);
 const setPreference=async(page,key,value)=>{const current=(await rpc('erp_preferences_page',{p_user_id:users.admin,p_page:page})).items.find(item=>item.key===key);
  if(JSON.stringify(current.value)===JSON.stringify(value))return null;
  return rpc('erp_preferences_save',{p_user_id:users.admin,p_command_id:randomUUID(),p_page:page,p_changes:[{key,expected_version:current.version,value}]});};
 const line=(extra={})=>({product_id:null,description:'Item sintético',detailed_description:null,code:null,unit:'UN',quantity:'1',unit_price:'10',discount_percent:'0',...extra});
 const data=(kind,extra={})=>({date:'2026-10-20',contact_id:contact.id,items:kind==='service_orders'?[]:[line({product_id:product.id})],discount_mode:'amount',discount_value:'0',freight:'0',other_expenses:'0',installments:[],commercial:null,...extra});
 /** Creates a document through the Worker and returns it. */
 const create=async(kind,extra={},user=users.admin)=>{const r=await call(`/v1/documentos/${kind}`,'POST',{command_id:randomUUID(),data:data(kind,extra)},user);if(r.status!==200)throw new Error(`create ${kind}: ${r.status} ${JSON.stringify(r.value)}`);return r.value.document;};
 const transition=async(doc,status,user=users.admin,reason='Motivo sintético')=>call(`/v1/documentos/${doc.kind}/${doc.id}/status`,'POST',{command_id:randomUUID(),expected_version:doc.version,status,reason},user);
 /** A vendedor (Cadastros › Vendedores) linked to the user, with its own contact. */
 const seller=async(user,{allow=false,limit='0',name='Vendedor sintético'}={})=>{const own=await catalog('contacts',{name});
  return scalar("insert into erp_catalog.seller(contact_id,user_id,allow_unregistered_products,discount_limit,created_by,updated_by) values($1,$2,$3,$4::numeric,$5,$5) returning id::text v",[own.id,user,allow,limit,users.admin]);};
 /** Links the contact to the seller (Clientes e fornecedores › Vendedor). */
 const assign=async(contactId,sellerId)=>db.query("insert into erp_catalog.contact_profile(record_id,seller_id) values($1,$2) on conflict(record_id) do update set seller_id=excluded.seller_id",[contactId,sellerId]);
 /** Gerenciador de transições (148, administrador): a custom situação based on a status, and a configured transition between keys. */
 const situation=async(kind,base,name,color='#123456')=>(await rpc('erp_preferences_situation_save',{p_user_id:users.admin,p_command_id:randomUUID(),p_kind:kind,p_situation:null,p_expected_version:0,p_data:{active:true,base_status:base,color,name}})).receipt.target;
 const rule=async(kind,from,to,data={active:true,actions:[]})=>{const version=await scalar('select coalesce((select version from erp_preferences.transition where kind=$1 and from_key=$2 and to_key=$3),0) v',[kind,from,to]);
  return rpc('erp_preferences_transition_save',{p_user_id:users.admin,p_command_id:randomUUID(),p_kind:kind,p_from:from,p_to:to,p_expected_version:version,p_data:data});};
 /** Sistema › Usuários › Permissões (229): the saved permission set of a user (null: everything of the profile). */
 const permissions=async(user,keys)=>db.query("insert into erp_access.user_control(user_id,user_type,schedule_enabled,windows,permissions,version,updated_at,updated_by) values($1,'normal',false,'[]',$2,1,clock_timestamp(),$3) on conflict(user_id) do update set permissions=excluded.permissions,version=erp_access.user_control.version+1",[user,keys,users.admin]);
 /** 222: a composition (format "Com composição") with its Estrutura. */
 const kit=async(name,components)=>{const created=await catalog('products',{name,unit:'UN',kind:'P',format:'E',price:'30'});
  await rpc('erp_stock_product_compose',{p_user_id:users.estoque,p_id:created.id,p_expected_version:await recordVersion(created.id),p_command_id:randomUUID(),p_data:{name},p_acknowledged:null,
   p_composition:{expected_version:0,stock_type:'virtual',post_mode:'components',items:components.map(([component,quantity])=>({component_id:component.id??component,quantity}))}});
  return created;};
 return{db,scalar,rows,rpc,users,calls,auth,call,catalog,contact,product,recordVersion,setPreference,line,data,create,transition,seller,assign,kit,situation,rule,permissions,close:()=>db.close()};
}catch(e){await db.close();throw e;}}
