// Synthetic PGlite fixture for the estoque lane, wave G (migrations 295-297): every migration published in production (up to
// 202610200286, in order), then this lane's files that exist, each applied once. No real data.
import{PGlite}from'@electric-sql/pglite';import{readFile,readdir}from'node:fs/promises';import{randomUUID}from'node:crypto';
import{bootstrap}from'../../../../tools/migration/helpers/stock-reservation-fixture.mjs';
export const PUBLISHED_UNTIL='202610200286';
export const LANE_MIGRATIONS=['202610200295_stock_invoice_unit_conversion.sql','202610200296_stock_document_lots.sql'];
const dir=new URL('../../../../supabase/migrations/',import.meta.url);
export const migrationSql=async name=>(await readFile(new URL(name,dir),'utf8')).replace(/\r\n/g,'\n');
const AUTH_COLUMNS="alter table auth.users add column email text,add column created_at timestamptz not null default clock_timestamp(),add column invited_at timestamptz,add column email_confirmed_at timestamptz,add column last_sign_in_at timestamptz,add column banned_until timestamptz,add column is_anonymous boolean not null default false;";
const snapshots=new Map();
function snapshot(upto){
 if(!snapshots.has(upto))snapshots.set(upto,(async()=>{const db=new PGlite();try{
  await db.exec(bootstrap);await db.exec(AUTH_COLUMNS);
  const names=(await readdir(dir)).sort();
  for(const name of names.filter(n=>/^\d{12}_.+\.sql$/.test(n)&&n.slice(0,12)<=PUBLISHED_UNTIL))await db.exec(await migrationSql(name));
  for(const name of LANE_MIGRATIONS.slice(0,upto))if(names.includes(name))await db.exec(await migrationSql(name));
  return await db.dumpDataDir('none');
 }finally{await db.close();}})());
 return snapshots.get(upto);
}
export async function stockLaneGFixture({upto=LANE_MIGRATIONS.length}={}){const db=new PGlite({loadDataDir:await snapshot(upto)});try{
 await db.waitReady;
 const scalar=async(text,args=[])=>(await db.query(text,args)).rows[0]?.v;
 const rows=async(text,args=[])=>(await db.query(text,args)).rows;
 const rpc=async(name,args)=>{const e=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${e.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,e.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}};
 const users=Object.fromEntries(['admin','estoque','vendas','consulta','fiscal','financeiro'].map(r=>[r,randomUUID()]));
 for(const[role,id]of Object.entries(users)){await db.query('insert into auth.users(id,email)values($1,$2)',[id,`${role}@sintetico.test`]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[id,role]);}
 const catalog=async(entity,data,user=users.admin)=>(await rpc('erp_catalog_save',{p_user_id:user,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data})).record;
 const contact=await catalog('contacts',{name:'Fornecedor sintético G'});
 const product=(name,extra={})=>catalog('products',{name,unit:'UN',kind:'P',format:'S',price:'10',...extra});
 const recordVersion=async id=>scalar('select version v from erp_catalog.record where id=$1',[id]);
 const productDetail=async(id,data)=>rpc('erp_catalog_product_save',{p_user_id:users.admin,p_id:id,p_expected_version:await recordVersion(id),p_command_id:randomUUID(),p_data:data,p_acknowledged:null});
 // 258: a simple product with "Controle de lote" on (191 switch of the product form).
 const lotProduct=async(name,extra={})=>{const created=await product(name,extra);await productDetail(created.id,{name,lot_control:true});return created;};
 const warehouse=async(name,ignore=false)=>(await rpc('erp_stock_warehouse_save',{p_user_id:users.admin,p_command_id:randomUUID(),p_warehouse_id:null,p_expected_version:0,p_expected_setting_version:0,p_name:name,p_ignore_balance:ignore})).warehouse;
 const version=async(item,target)=>(await scalar('select coalesce((select version from erp_stock.balance where product_id=$1 and warehouse_id=$2),0)v',[item,target]))??0;
 const balance=async(item,target)=>scalar('select quantity::text v from erp_stock.balance where product_id=$1 and warehouse_id=$2',[item,target]);
 const lotBalance=async(lot,target)=>scalar('select quantity::text v from erp_stock.lot_balance where lot_id=$1 and warehouse_id=$2',[lot,target]);
 const launch=async(item,target,kind,quantity,{price=null,cost=null,note=null,user=users.estoque,command=randomUUID()}={})=>rpc('erp_stock_launch',{p_user_id:user,p_command_id:command,p_kind:kind,p_product_id:item,p_warehouse_id:target,p_quantity:quantity,
  p_expected_version:await version(item,target),p_unit_price:price,p_unit_cost:kind==='issue'?null:cost,p_note:note,p_destination_id:null,p_destination_version:null});
 const lotLaunch=async(item,target,kind,quantity,lot,{user=users.estoque,command=randomUUID()}={})=>rpc('erp_stock_lot_launch',{p_user_id:user,p_command_id:command,p_kind:kind,p_product_id:item,p_warehouse_id:target,p_quantity:quantity,
  p_expected_version:await version(item,target),p_unit_price:null,p_unit_cost:null,p_note:null,p_destination_id:null,p_destination_version:null,p_lot:lot});
 const lotSave=async(item,data,{user=users.estoque,command=randomUUID()}={})=>(await rpc('erp_stock_lot_save',{p_user_id:user,p_command_id:command,p_product_id:item,p_lot_id:null,p_expected_version:0,
  p_code:data.code,p_manufactured_on:data.manufactured_on??null,p_expires_on:data.expires_on??null,p_note:data.note??null})).lot;
 const transition=async(doc,status)=>(await rpc('erp_document_transition',{p_user_id:users.admin,p_kind:doc.kind,p_id:doc.id,p_expected_version:doc.version,p_command_id:randomUUID(),p_status:status,p_reason:'Transição sintética'})).document;
 const order=async(kind,items,target,statuses=kind==='sales_orders'?[]:['in_progress'],{date='2026-10-15',contact_id=contact.id}={})=>{let d=(await rpc('erp_document_save',{p_user_id:users.admin,p_kind:kind,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date,contact_id,warehouse_id:target,items}})).document;
  for(const s of statuses)d=await transition(d,s);return d;};
 const item=(target,quantity,unit_price='5')=>({product_id:target.id??target,description:'Item sintético',unit:'UN',quantity,unit_price});
 const setPolicy=async allow=>{const current=(await rpc('erp_stock_policy_get',{p_user_id:users.admin})).policy;return rpc('erp_stock_policy_set',{p_user_id:users.admin,p_command_id:randomUUID(),p_expected_version:current.version,p_allow_negative:allow,p_reason:'Decisão sintética',p_confirmed:true});};
 // Notes (259): the company identity, the fiscal profile and one nature per direction, created once on demand.
 let natures=null,numbers=700000;
 const fiscal=async()=>{if(natures)return natures;
  await db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,'{\"state\":\"SP\",\"cnpj\":\"11222333000181\"}',$1) on conflict do nothing",[users.admin]);
  await db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1) on conflict do nothing",[users.admin]);
  const nature=async data=>(await rpc('erp_fiscal_nature_execute',{p_user_id:users.admin,p_command_id:randomUUID(),p_action:'create',p_data:{nature:data}})).nature;
  natures={sale:await nature({description:'Venda sintética G',direction:'1',crt:'1'}),buy:await nature({description:'Compra sintética G',direction:'0',crt:'1',presence:'9'})};return natures;};
 const noteLine=(target,quantity,price='10',over={})=>({product_id:target?.id??target??null,description:over.description??'Item sintético',code:'S-1',unit:'UN',quantity,unit_price:price,...over});
 const note=async(direction,items,{supplier=contact,...over}={})=>{const n=await fiscal();
  const total=items.reduce((sum,i)=>sum+Number(i.quantity)*Number(i.unit_price),0).toFixed(2);
  const data={model:'55',direction,issue_type:direction==='0'?'T':'N',series:'1',...(direction==='0'?{number:String(++numbers)}:{}),nature_id:direction==='1'?n.sale.id:n.buy.id,
   issue_date:'2026-10-20',crt:'1',purpose:'1',presence:direction==='1'?'1':'9',final_consumer:false,
   recipient:{...(supplier?{contact_id:supplier.id}:{}),name:'Contato sintético G',person_type:'J',document:'12345678000190',state:'SP'},
   items,payment:{installments:[{date:'2026-11-20',amount:total}]},...over};
  return(await rpc('erp_fiscal_invoice_execute',{p_user_id:users.admin,p_command_id:randomUUID(),p_action:'create',p_data:{invoice:data,orders:[]}})).invoice;};
 const noteVersion=async id=>scalar('select version v from erp_fiscal_invoices.invoice where id=$1',[id]);
 return{db,scalar,rows,rpc,users,catalog,contact,product,productDetail,lotProduct,warehouse,version,balance,lotBalance,launch,lotLaunch,lotSave,transition,order,item,setPolicy,
  recordVersion,fiscal,noteLine,note,noteVersion,close:()=>db.close()};
}catch(e){await db.close();throw e;}}
export const fails=code=>error=>error?.code===code;
