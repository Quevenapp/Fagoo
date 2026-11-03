import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
export const migrations=['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0013_catalog_import_review','0014_erp_cnab','0017_document_finance','0018_document_stock','0023_product_details','0025_stock_positions'];
export const bootstrap="create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;";
export async function fixture({apply=true}={}){
 const db=new PGlite();await db.exec(bootstrap);
 for(const name of migrations)await db.exec(await readFile(new URL(`../../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
 const roles=['admin','estoque','financeiro','consulta','vendas','fiscal'];const users=Object.fromEntries(roles.map(r=>[r,randomUUID()]));
 for(const role of roles){await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[users[role],role]);}
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
 const rpc=async(name,args)=>{const pairs=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${pairs.map(([k],i)=>`${k}=>$${i+1}`).join(',')})value`,pairs.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}};
 const catalog=async(entity,data)=>(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data})).record;
 const product=await catalog('products',{name:'Peça sintética070',unit:'UN',kind:'P',format:'S',price:'1'}),warehouse=await catalog('warehouses',{name:'Depósito sintético070'}),contact=await catalog('contacts',{name:'Contato sintético070'});
 const transition=async(doc,status)=>(await rpc('erp_document_transition',{p_user_id:users.admin,p_kind:doc.kind,p_id:doc.id,p_expected_version:doc.version,p_command_id:randomUUID(),p_status:status,p_reason:'Transição sintética'})).document;
 const order=async({quantity='2',items,kind='sales_orders'}={})=>{let d=(await rpc('erp_document_save',{p_user_id:users.admin,p_kind:kind,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-15',contact_id:contact.id,warehouse_id:warehouse.id,items:items??[{product_id:product.id,description:'Peça sintética',unit:'UN',quantity,unit_price:'1'}]}})).document;for(const s of kind==='sales_orders'?['open','verified']:['in_progress'])d=await transition(d,s);return d;};
 const physical=async(quantity,{kind=quantity.startsWith('-')?'issue':'receipt',command=randomUUID(),target=warehouse.id,extra={}}={})=>rpc('erp_stock_post',{p_user_id:users.estoque,p_command_id:command,p_kind:kind,p_occurred_on:'2026-10-15',p_reason:'Movimento sintético070',p_items:[{product_id:product.id,warehouse_id:target,quantity,expected_version:await scalar('select coalesce((select version from erp_stock.balance where product_id=$1 and warehouse_id=$2),0)value',[product.id,target])}],...extra});
 const migrate=async()=>db.exec(await readFile(new URL('../../../supabase/migrations/202610160070_stock_reservations.sql',import.meta.url),'utf8'));
 if(apply)await migrate();
 const input=(d,action='reserve',r=null)=>({p_user_id:users.estoque,p_document_id:d.id,p_expected_version:d.version,p_action:action,p_occurred_on:'2026-10-15',p_reason:'Reserva sintética revisada',p_reservation_id:r?.id??null,p_reservation_version:r?.version??null});
 const preview=async(d,action='reserve',r=null)=>(await rpc('erp_stock_reservation_preview',input(d,action,r))).preview;
 const execute=async(d,{action='reserve',reservation=null,prior=null,command=randomUUID(),patch={}}={})=>{const p=prior??await preview(d,action,reservation);const args={...input(d,action,reservation),p_command_id:command,p_preview_hash:p.preview_hash,p_ignored_item_ids:action==='reserve'?p.ignored.map(i=>i.id):null,...patch};const out=await rpc('erp_stock_reservation_apply',args);d.version=out.current.document.version;return{...out,args,preview:p};};
 const available=()=>rpc('erp_stock_availability',{p_user_id:users.admin,p_product_id:product.id,p_warehouse_id:warehouse.id});
 return{db,users,scalar,rpc,catalog,product,warehouse,contact,order,transition,physical,migrate,input,preview,execute,available,close:()=>db.close()};
}
