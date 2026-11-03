import {PGlite} from '@electric-sql/pglite';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';

// Builds only synthetic, local SQL. It neither connects to PostgreSQL nor starts Docker.
const destination=resolve(process.argv[2]??'/Volumes/Dev/tmp/brufap-numbering-pg-seed.sql');
const db=new PGlite(),statements=['-- Synthetic046: no real company, customer, secret or external connection.'];
const quote=v=>v===null?'NULL':typeof v==='boolean'?String(v):typeof v==='number'?String(v):"'"+String(typeof v==='object'?JSON.stringify(v):v).replaceAll("'","''")+"'";
async function exec(sql){await db.exec(sql);statements.push(sql);}
async function rpc(name,args){const sql=`select public.${name}(${Object.entries(args).map(([k,v])=>`${k}=>${quote(v)}`).join(',')}) value;`;const result=(await db.query(sql)).rows[0].value;statements.push(sql);return result;}
try{
 await exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
 for(const name of['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0016_company','0022_fiscal_drafts','0023_product_details','0035_fiscal_item_preparation','0040_fiscal_tax_preparation','0046_fiscal_numbering'])await exec(await readFile(new URL('../../supabase/migrations/20261016'+name+'.sql',import.meta.url),'utf8'));
 const bootstrap=statements.join('\n');
 const admin=randomUUID(),fiscal=randomUUID();await exec(`insert into auth.users values('${admin}'),('${fiscal}');insert into erp_access.membership(user_id,role)values('${admin}','admin'),('${fiscal}','fiscal');`);
 const company=await rpc('erp_company_save_identity',{p_user_id:admin,p_expected_version:0,p_command_id:randomUUID(),p_data:{legal_name:'Empresa sintética concorrência046',cnpj:'11222333000181',postal_code:'13400000',street:'Rua fictícia',number:'S/N',district:'Bairro fictício',city:'Piracicaba',municipality_code:'3538709',state:'SP'}});
 const fiscalBefore=await rpc('erp_company_get',{p_user_id:admin,p_section:'fiscal'});
 await rpc('erp_company_confirm_fiscal',{p_user_id:admin,p_expected_version:fiscalBefore.record.version,p_expected_identity_version:company.record.version,p_command_id:randomUUID(),p_crt:'1',p_confirmed:true,p_reason:'Regime apenas para fixture sintética'});
 const contact=(await rpc('erp_catalog_save',{p_user_id:admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Contato sintético',person_type:'J',document:'11222333000181',state:'SP'}})).record;
 const product=(await rpc('erp_catalog_save',{p_user_id:admin,p_entity:'products',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Produto sintético',unit:'UN',kind:'P',format:'S',ncm:'82055900',origin:'0',gtin:'SEM GTIN'}})).record;
 const scenarios={};
 for(const [scenario,number]of[['same_command','10'],['competing_commands','11'],['different_series_same_order','12']]){
  const configured=await rpc('erp_fiscal_numbering_configure',{p_user_id:admin,p_command_id:randomUUID(),p_id:null,p_expected_version:0,p_expected_identity_version:company.record.version,p_model:'55',p_environment:'2',p_series:number,p_initial_number:'1',p_enabled:true,p_exclusive_use_confirmed:true,p_reference:'Exclusividade sintética para ensaio local'});
  const calls=[];
  for(let n=0;n<(scenario==='same_command'?1:2);n++){
   const order=(await rpc('erp_document_save',{p_user_id:admin,p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-16',contact_id:contact.id,items:[{product_id:product.id,description:'Produto sintético',unit:'UN',quantity:'1',unit_price:'1',discount_percent:'0'}]}})).document;
   const draft=(await rpc('erp_fiscal_draft_execute',{p_user_id:fiscal,p_command_id:randomUUID(),p_action:'create',p_data:{source_document_id:order.id,expected_source_version:order.version,model:'55',preparation:{operation_nature:'Venda sintética',notes:null}}})).record;
   const item=(await rpc('erp_fiscal_item_save',{p_user_id:fiscal,p_draft_id:draft.id,p_expected_draft_version:draft.version,p_snapshot_hash:draft.snapshot_hash,p_expected_version:0,p_decisions:[],p_command_id:randomUUID()})).record;
   const tax=(await rpc('erp_fiscal_tax_save',{p_user_id:fiscal,p_draft_id:draft.id,p_expected_draft_version:draft.version,p_snapshot_hash:draft.snapshot_hash,p_item_preparation_version:item.version,p_expected_version:0,p_operation:'internal_normal_sale',p_decisions:[],p_command_id:randomUUID()})).record;
   const args={p_user_id:fiscal,p_command_id:randomUUID(),p_series_id:configured.current_series.id,p_expected_series_version:1,p_expected_identity_version:company.record.version,p_draft_id:draft.id,p_expected_draft_version:draft.version,p_snapshot_hash:draft.snapshot_hash,p_item_preparation_version:item.version,p_tax_preparation_version:tax.version,p_confirm_reserve:true};
   calls.push({args,sql:`select public.erp_fiscal_numbering_reserve(${Object.entries(args).map(([k,v])=>`${k}=>${quote(v)}`).join(',')});`,order_id:order.id});
  }
  if(scenario==='different_series_same_order'){
   const second=await rpc('erp_fiscal_numbering_configure',{p_user_id:admin,p_command_id:randomUUID(),p_id:null,p_expected_version:0,p_expected_identity_version:company.record.version,p_model:'55',p_environment:'2',p_series:'13',p_initial_number:'1',p_enabled:true,p_exclusive_use_confirmed:true,p_reference:'Segunda série sintética para ensaio local'});
   const args={...calls[0].args,p_command_id:randomUUID(),p_series_id:second.current_series.id};calls[1]={args,sql:`select public.erp_fiscal_numbering_reserve(${Object.entries(args).map(([k,v])=>`${k}=>${quote(v)}`).join(',')});`,order_id:calls[0].order_id};
  }
  scenarios[scenario]={series_id:configured.current_series.id,calls};
 }
 // Export the generated rows, not the original creation calls: random UUID defaults
 // must remain identical to the manifest when another PostgreSQL server loads them.
 const tables=(await db.query("select c.oid::text oid,n.nspname schema,c.relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and(n.nspname='auth'or n.nspname like 'erp_%') order by n.nspname,c.relname")).rows;
 const filled=[];for(const table of tables){table.rows=(await db.query(`select to_jsonb(t)::text data from ${table.schema}.${table.name} t`)).rows;if(table.rows.length)filled.push(table);}
 const edges=(await db.query("select conrelid::text child,confrelid::text parent from pg_constraint where contype='f' and not condeferrable and conrelid<>confrelid")).rows;
 const ordered=[],pending=new Map(filled.map(t=>[t.oid,t]));
 while(pending.size){const ready=[...pending.values()].filter(t=>!edges.some(e=>e.child===t.oid&&pending.has(e.parent)));if(!ready.length)throw new Error('Synthetic dump has nondeferred FK cycle');for(const t of ready){ordered.push(t);pending.delete(t.oid);}}
 const dump=['begin;set constraints all deferred;'];
 for(const table of ordered){
  const columns=(await db.query("select attname from pg_attribute where attrelid=$1::oid and attnum>0 and not attisdropped and attgenerated='' order by attnum",[table.oid])).rows.map(r=>'"'+r.attname+'"').join(',');
  // Bootstrap migrations seed singleton/counter rows. Replace only those known,
  // synthetic tables before the dump; this never targets a running database.
  if(`${table.schema}.${table.name}`==='erp_documents.numbering')dump.push(`delete from ${table.schema}.${table.name};`);
  for(const row of table.rows)dump.push(`insert into ${table.schema}.${table.name}(${columns}) overriding system value select ${columns} from jsonb_populate_record(null::${table.schema}.${table.name},${quote(row.data)}::jsonb);`);
 }
 for(const table of ordered){
  const sequences=(await db.query("select attname,pg_get_serial_sequence($1,attname) seq from pg_attribute where attrelid=$2::oid and attnum>0 and not attisdropped",[`${table.schema}.${table.name}`,table.oid])).rows.filter(r=>r.seq);
  for(const row of sequences)dump.push(`select setval(${quote(row.seq)},greatest(1,(select coalesce(max("${row.attname}"),0) from ${table.schema}.${table.name})),true);`);
 }
 dump.push('commit;');await writeFile(destination,bootstrap+'\n'+dump.join('\n')+'\n');
 const check=new PGlite();try{await check.exec(await readFile(destination,'utf8'));for(const scenario of Object.values(scenarios)){const row=(await check.query('select id::text from erp_fiscal_numbering.series where id=$1',[scenario.series_id])).rows[0];if(row?.id!==scenario.series_id)throw new Error('Synthetic dump lost identifiers');}}finally{await check.close();}
 const manifest=destination.replace(/\.sql$/,'.json');await writeFile(manifest,JSON.stringify({synthetic:true,admin,fiscal,scenarios},null,2)+'\n');
 console.log(JSON.stringify({sql:destination,manifest,scenarios:Object.keys(scenarios)}));
}finally{await db.close();}
