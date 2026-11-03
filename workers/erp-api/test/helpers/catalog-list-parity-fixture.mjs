import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {bootstrap} from '../../../../tools/migration/helpers/stock-reservation-fixture.mjs';

// Real migrations up to 087 (the ones 096 depends on, in order), then 096. Synthetic actors only.
export async function catalogListParityFixture({apply=true}={}){
 const db=new PGlite();
 try{
  await db.exec(bootstrap);
  const dir=new URL('../../../../supabase/migrations/',import.meta.url);
  for(const name of(await readdir(dir)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&Number(n.slice(9,12))<=87).sort())await db.exec(await readFile(new URL(name,dir),'utf8'));
  const migrate=async()=>db.exec(await readFile(new URL('202610190096_catalog_list_parity.sql',dir),'utf8'));
  if(apply)await migrate();
  const users=Object.fromEntries(['admin','consulta','vendas','financeiro','estoque','fiscal','inactive'].map(role=>[role,randomUUID()]));
  for(const[role,id]of Object.entries(users)){
   await db.query('insert into auth.users values($1)',[id]);
   await db.query('insert into erp_access.membership(user_id,role,active)values($1,$2,$3)',[id,role==='inactive'?'admin':role,role!=='inactive']);
  }
  const rows=async(sql,args=[])=>(await db.query(sql,args)).rows;
  const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.v;
  const rpc=async(name,args)=>{
   const pairs=Object.entries(args);await db.exec('set role service_role');
   try{return(await db.query(`select public.${name}(${pairs.map(([key],index)=>`${key}=>$${index+1}`).join(',')}) v`,pairs.map(([,value])=>value&&typeof value==='object'&&!(value instanceof Date)?JSON.stringify(value):value))).rows[0].v;}
   finally{await db.exec('reset role');}
  };
  const save=async(entity,data,{user=users.admin,id=null,version=0,command=randomUUID()}={})=>(await rpc('erp_catalog_save',{p_user_id:user,p_entity:entity,p_id:id,p_expected_version:version,p_command_id:command,p_data:data})).record;
  const page=(entity,args={},user=users.admin)=>entity==='products'?rpc('erp_catalog_product_page',{p_user_id:user,...args}):rpc('erp_catalog_page',{p_user_id:user,p_entity:entity,...args});
  const check=(entity,data,{id=null,user=users.admin}={})=>rpc('erp_catalog_check',{p_user_id:user,p_entity:entity,p_id:id,p_data:data});
  const saveChecked=(entity,data,acknowledged,{user=users.admin,id=null,version=0,command=randomUUID()}={})=>rpc('erp_catalog_save_checked',{p_user_id:user,p_entity:entity,p_id:id,p_expected_version:version,p_command_id:command,p_data:data,p_acknowledged:acknowledged});
  const stock=async(product,warehouse,quantity,kind=quantity.startsWith('-')?'issue':'receipt')=>rpc('erp_stock_post',{p_user_id:users.estoque,p_command_id:randomUUID(),p_kind:kind,p_occurred_on:'2026-10-15',p_reason:'Movimento sintético096',
   p_items:[{product_id:product,warehouse_id:warehouse,quantity,expected_version:await scalar('select coalesce((select version from erp_stock.balance where product_id=$1 and warehouse_id=$2),0) v',[product,warehouse])}]});
  return{db,users,rows,scalar,rpc,save,page,check,saveChecked,stock,migrate,close:()=>db.close()};
 }catch(error){await db.close();throw error;}
}
