/** Synthetic local SQL only; never loads real plans, data or credentials. */
import {PGlite} from '@electric-sql/pglite';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {adoptionDigest} from './execute_proposal_product_adoption.mjs';
import {catalogUpdatePreservationSql} from './catalog_update_preservation.mjs';
export async function catalogUpdateFixture(){
 const db=new PGlite(),actor=randomUUID(),directory=await mkdtemp(join(tmpdir(),'brufap-reviewed-update-'));
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;
 const rpc=async(name,args)=>{await db.exec('set role service_role');try{const entries=Object.entries(args);return await scalar(`select public.${name}(${entries.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,entries.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}};
 try{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
 for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0005_origin_auxiliary_catalogs','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0013_catalog_import_review','0014_erp_cnab','0017_document_finance','0018_document_stock','0019_document_effect_flags','0020_cutover_readiness','0023_product_details','0032_proposal_service_conversion','0034_document_copy','0044_catalog_ncm_format','0052_origin_proposal_import','0054_document_commercial','0055_origin_proposal_import_v2','0057_unit_price_precision'])await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
 await db.exec('alter table origin_sync.raw_record add column price_capture jsonb');
 await db.query('insert into auth.users values($1)',[actor]);await db.query("insert into erp_access.membership(user_id,role)values($1,'admin')",[actor]);await db.exec("insert into origin_sync.resource_state(resource)values('synthetic_update')");
 const stage=async(entity,id,payload)=>{await db.query(`insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values($1,'synthetic_update',$2,$3::jsonb,encode(sha256(convert_to($3::jsonb::text,'UTF8')),'hex')) on conflict(entity,source_id)do update set payload=excluded.payload,version_hash=excluded.version_hash,version=origin_sync.raw_record.version+1,last_seen_at=clock_timestamp()`,[entity,id,JSON.stringify(payload)]);return await scalar('select version_hash v from origin_sync.raw_record where entity=$1 and source_id=$2',[entity,id]);};
 const ids=['1001','1002'];const records=[];
 for(const [i,id]of ids.entries()){
  const payload={id,nome:'Synthetic '+id,codigo:'QA'+id,situacao:'A',tipo:'P',formato:'S',unidade:'UN',preco:i?2:1};
  const hash=await stage('products',id,payload);records.push((await rpc('erp_catalog_import_origin',{p_user_id:actor,p_entity:'products',p_items:[{source_id:id,source_hash:hash}],p_command_id:randomUUID(),p_dry_run:false})).items[0].record_id);
  await stage('products',id,{...payload,preco:i?2.1234567891:1,observacoes:'New source observation'});
 }
 await db.query("update erp_catalog.product set brand='Private synthetic brand',net_weight=1.25,items_per_box=7 where record_id=any($1::uuid[])",[records]);
 await db.query('update erp_catalog.record set version=3 where id=$1',[records[0]]);
 await db.query(`update origin_sync.raw_record set price_capture=jsonb_build_object('profile','origin-price-json-v1','source','detail','response_sha256',repeat('d',64),'capture_id',$1::uuid,'observed_at',clock_timestamp(),'source_hash',version_hash,'source_version',version::text,'tokens',jsonb_build_array(jsonb_build_object('path','/preco','lexeme',payload->>'preco'))) where entity='products'`,[randomUUID()]);
 const contact=(await rpc('erp_catalog_save',{p_user_id:actor,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Synthetic contact'}})).record.id;
 const unselected=(await rpc('erp_catalog_save',{p_user_id:actor,p_entity:'products',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Unselected product',price:'9.1234567891',kind:'P',format:'S',unit:'UN'}})).record.id;
 await db.query('update erp_catalog.record set active=false where id=$1',[unselected]);
 const document=(await rpc('erp_document_save',{p_user_id:actor,p_kind:'sales_proposals',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-16',contact_id:contact,items:[{product_id:records[0],description:'Preserved document snapshot',unit:'UN',quantity:'2',unit_price:'1.0000',discount_percent:'0'}],discount_mode:'amount',discount_value:'0',freight:'0',other_expenses:'0',installments:[]}})).document;
 const ph=await stage('sales_proposals','2001',{id:'2001',situacao:'Rascunho',itens:ids.map(id=>({produto:{id}}))});
 const items=await Promise.all(ids.map(async id=>({source_id:id,source_hash:await scalar("select version_hash v from origin_sync.raw_record where entity='products' and source_id=$1",[id])})));
 const preview=await rpc('erp_catalog_import_preview',{p_user_id:actor,p_entity:'products',p_items:items});
 // The real immutable plan carries full review evidence. This fixture uses the same policy fields.
 const plan={profile:'reviewed-catalog-updates-v1',read_only:true,apply_enabled:false,requires_root_review:true,entity:'products',actor,plan_id:randomUUID(),command_id:randomUUID(),preview_hash:preview.preview_hash,items,preview,expected:preview.items.map((x,i)=>({source_id:x.source_id,source_hash:x.source_hash,source_version:x.source_version,record_id:x.record_id,record_version:x.record_version,expected_record_version:x.record_version+1,kind:i?'price_change':'origin_only',allowed_changes:x.changes,witnesses:[{source_id:'2001',source_hash:ph,source_version:'1'}],native_document_usage:i?0:1})),baseline:{catalog_count:4,document_count:1}};
 const planHash=adoptionDigest(plan),proof=async()=>{const results=await db.exec(catalogUpdatePreservationSql(plan,planHash));return results.find(x=>x.rows?.[0]?.preservation)?.rows[0].preservation;};
 return{db,actor,directory,records,unselected,document,plan,planHash,proof,scalar,rpc,stage,close:async()=>{await db.close();await rm(directory,{recursive:true,force:true});}};
 }catch(e){await db.close();await rm(directory,{recursive:true,force:true});throw e;}
}
