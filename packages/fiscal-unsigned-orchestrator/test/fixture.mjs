// Reusable synthetic 048 fixture. No network, disk database, real certificate or company.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {businessFixture,TEST_HOLDER,TEST_RECIPIENT} from '../../fiscal-core/test/business-fixtures.mjs';
import {createUnsignedXmlOrchestrator} from '../src/unsigned.mjs';

export const BUCKET='brufap-fiscal-artifacts';
export const hash=value=>createHash('sha256').update(value).digest('hex');
const companyData={legal_name:'EMPRESA FICTICIA ORQUESTRADOR XML',cnpj:TEST_HOLDER,ie:'123456789012',postal_code:'13400000',street:'RUA FICTICIA',number:'1',district:'CENTRO',city:'PIRACICABA',municipality_code:'3538709',state:'SP'};
export async function fixture(){
 const db=new PGlite(),users=Object.fromEntries(['admin','fiscal','consulta','vendas'].map(role=>[role,randomUUID()])),files=new Map(),calls={rpc:[],put:[],read:[]};let queue=Promise.resolve(),series=100;
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
 for(const name of['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0014_erp_cnab','0016_company','0017_document_finance','0018_document_stock','0019_document_effect_flags','0022_fiscal_drafts','0023_product_details','0029_fiscal_review','0035_fiscal_item_preparation','0040_fiscal_tax_preparation','0046_fiscal_numbering','0047_business_completion','0048_unsigned_xml_jobs'])await db.exec(await readFile(new URL('../../../supabase/migrations/20261016'+name+'.sql',import.meta.url),'utf8'));
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
 for(const[role,id]of Object.entries(users)){await db.query('insert into auth.users values($1)',[id]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[id,role]);}
 await db.query('insert into storage.buckets values($1,$1,false,8388608,$2::text[])',[BUCKET,['application/octet-stream']]);
 // PGlite has one connection; serialize SET ROLE + query + RESET as one fixture action.
 const callSql=(name,args)=>{
  assert.match(name,/^erp_[a-z_]+$/);for(const key of Object.keys(args))assert.match(key,/^p_[a-z0-9_]+$/);
  const run=async()=>{await db.exec('set role service_role');try{const entries=Object.entries(args);return await scalar(`select public.${name}(${entries.map(([k],i)=>k+'=>$'+(i+1)).join(',')})value`,entries.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}};
  const result=queue.then(run,run);queue=result.catch(()=>{});return result;
 };
 const rpc=async(name,args,options)=>{
  assert.match(name,/^erp_fiscal_unsigned_[a-z_]+$/);assert.ok(options.signal instanceof AbortSignal);assert.ok(options.deadline>Date.now());assert.equal(options.signal.aborted,false);
  calls.rpc.push({name,args:structuredClone(args),signal:options.signal,deadline:options.deadline});return callSql(name,args);
 };
 const identity=async(patch={})=>{const old=await callSql('erp_company_get',{p_user_id:users.admin,p_section:'identity'});return callSql('erp_company_save_identity',{p_user_id:users.admin,p_expected_version:old.record?.version??0,p_command_id:randomUUID(),p_data:{...companyData,...patch}});};
 const regime=async()=>{const c=await callSql('erp_company_get',{p_user_id:users.admin,p_section:'identity'}),f=await callSql('erp_company_get',{p_user_id:users.admin,p_section:'fiscal'});return callSql('erp_company_confirm_fiscal',{p_user_id:users.admin,p_expected_version:f.record.version,p_expected_identity_version:c.record.version,p_command_id:randomUUID(),p_crt:'1',p_confirmed:true,p_reason:'REGIME FICTICIO PARA TESTE LOCAL'});};
 await identity();await regime();
 const contact=(await callSql('erp_catalog_save',{p_user_id:users.admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'CLIENTE FICTICIO',person_type:'J',document:TEST_RECIPIENT,postal_code:'13400000',street:'RUA FICTICIA',number:'1',district:'CENTRO',city:'PIRACICABA',state:'SP'}})).record;
 const product=(await callSql('erp_catalog_save',{p_user_id:users.admin,p_entity:'products',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'PRODUTO FICTICIO',unit:'UN',kind:'P',format:'S',ncm:'82032090',origin:'0',gtin:'SEM GTIN'}})).record;
 const completionArgs=(f,expected,completion)=>({p_user_id:users.fiscal,p_draft_id:f.draft.record.id,p_expected_draft_version:1,p_snapshot_hash:f.draft.record.snapshot_hash,p_item_preparation_version:1,p_tax_preparation_version:1,p_expected_identity_version:f.draft.record.snapshot.company.identity_version,p_expected_fiscal_version:f.draft.record.snapshot.company.fiscal_version,p_expected_completion_version:expected,p_completion:completion,p_command_id:randomUUID()});
 const prepare=async({model='55',count=1,reserve=true,gtin='SEM GTIN',gtinTax=gtin,completionPatch=null,quantity='1.250000',unit_price='10.0000',discount='0.00',freight='0.00',other='0.00',installments=false}={})=>{
  const sample=businessFixture({model,count,quantity,unit_price,discount,freight,other});
  const document=(await callSql('erp_document_save',{p_user_id:users.admin,p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-16',contact_id:contact.id,items:Array.from({length:count},()=>({product_id:product.id,description:'PRODUTO FICTICIO',code:'FICT-001',unit:'UN',quantity,unit_price,discount_percent:'0'})),discount_mode:'amount',discount_value:discount,freight,other_expenses:other,...(installments?{installments:[{due_date:'2026-10-17',amount:sample.draft.record.snapshot.totals.total,method:null}]}:{}),internal_notes:'INTERNAL-COMMERCIAL-SYNTHETIC-NOT-EXPOSED'}})).document;
  const draft=await callSql('erp_fiscal_draft_execute',{p_user_id:users.fiscal,p_command_id:randomUUID(),p_action:'create',p_data:{source_document_id:document.id,expected_source_version:document.version,model,preparation:{operation_nature:'VENDA FICTICIA',notes:null}}});
  const base={p_user_id:users.fiscal,p_draft_id:draft.record.id,p_expected_draft_version:1,p_snapshot_hash:draft.record.snapshot_hash,p_expected_version:0};
  const item=await callSql('erp_fiscal_item_save',{...base,p_command_id:randomUUID(),p_decisions:draft.record.snapshot.items.map(i=>({item_id:i.id,fields:Object.fromEntries(Object.entries({ncm:'82032090',origin:'0',cest:null,gtin,gtin_tax:gtinTax}).map(([k,value])=>[k,{source:'manual',value}]))}))});
  const tax=await callSql('erp_fiscal_tax_save',{...base,p_item_preparation_version:1,p_operation:'internal_normal_sale',p_command_id:randomUUID(),p_decisions:sample.taxPreparation.record.items.map((i,n)=>({...i.decisions,item_id:draft.record.snapshot.items[n].id}))});
  const{identity:discarded,...completion}=sample.completion;completion.items.forEach((i,n)=>i.item_id=draft.record.snapshot.items[n].id);if(completionPatch)Object.assign(completion,completionPatch);
  const f={document,draft,item,tax,completion};f.saved=await callSql('erp_fiscal_completion_save',completionArgs(f,0,completion));
  if(reserve){
   const configured=await callSql('erp_fiscal_numbering_configure',{p_user_id:users.admin,p_command_id:randomUUID(),p_id:null,p_expected_version:0,p_expected_identity_version:draft.record.snapshot.company.identity_version,p_model:model,p_environment:'2',p_series:String(series++),p_initial_number:'1',p_enabled:true,p_exclusive_use_confirmed:true,p_reference:'SERIE FICTICIA PARA TESTE LOCAL'});
   f.reservation=await callSql('erp_fiscal_numbering_reserve',{p_user_id:users.fiscal,p_command_id:randomUUID(),p_series_id:configured.current_series.id,p_expected_series_version:configured.current_series.version,p_expected_identity_version:configured.current_series.identity_version,p_draft_id:draft.record.id,p_expected_draft_version:1,p_snapshot_hash:draft.record.snapshot_hash,p_item_preparation_version:1,p_tax_preparation_version:1,p_confirm_reserve:true});
  }return f;
 };
 const updateCompletion=async(f,patch={})=>{const current=await callSql('erp_fiscal_completion_get',{p_user_id:users.fiscal,p_draft_id:f.draft.record.id,p_version:null});f.completion={...f.completion,...patch};f.saved=await callSql('erp_fiscal_completion_save',completionArgs(f,current.record.version,f.completion));return f.saved;};
 const basis=f=>callSql('erp_fiscal_unsigned_basis',{p_user_id:users.fiscal,p_draft_id:f.draft.record.id,p_completion_version:f.saved.record.version});
 const previewInput=f=>({actor:users.fiscal,draftId:f.draft.record.id,completionVersion:f.saved.record.version});
 const input=async(f,patch={})=>{assert.ok(f.reservation,'Explicit synthetic046 reservation required');const b=await basis(f);return{...previewInput(f),commandId:randomUUID(),reservationId:f.reservation.receipt.id,completionHash:b.proofs.completion_hash,basisHash:b.basis_hash,...patch};};
 const begin=(j,seed={cNF:'12345678',issuedAt:new Date(Date.now()-10800000).toISOString().slice(0,19)+'-03:00'})=>callSql('erp_fiscal_unsigned_begin',{p_user_id:j.actor,p_command_id:j.commandId,p_reservation_id:j.reservationId,p_completion_version:j.completionVersion,p_completion_hash:j.completionHash,p_basis_hash:j.basisHash,p_builder_version:'brufap-business-builder-v1',p_seed:seed});
 const command=j=>callSql('erp_fiscal_unsigned_command',{p_user_id:j.actor,p_command_id:j.commandId});
 const get=(id,actor=users.fiscal)=>callSql('erp_fiscal_unsigned_get',{p_user_id:actor,p_job_id:id});
 const expire=async j=>{const c=await command(j);await queue;await db.exec('alter table erp_fiscal_unsigned.job disable trigger guard_job');try{await db.query("update erp_fiscal_unsigned.job set lease_until=clock_timestamp()-interval'1 second'where id=$1",[c.receipt.job_id]);}finally{await db.exec('alter table erp_fiscal_unsigned.job enable trigger guard_job');}};
 const validStorage=input=>{assert.equal(input.bucket,BUCKET);assert.match(input.key,/^jobs\/[a-f0-9-]{36}\/[a-f0-9]{64}\.xml$/);assert.ok(input.signal instanceof AbortSignal);assert.equal(input.signal.aborted,false);assert.ok(Date.now()<input.deadline);};
 const put=async input=>{
  validStorage(input);const{bucket,key,bytes,contentType,upsert,ifNoneMatch}=input;assert.equal(contentType,'application/octet-stream');assert.equal(upsert,false);assert.equal(ifNoneMatch,'*');assert.ok(bytes instanceof Uint8Array);assert.equal(hash(bytes),key.split('/').at(-1).slice(0,-4));
  calls.put.push({key,hash:hash(bytes),size:bytes.length,upsert,ifNoneMatch});if(files.has(key))return{status:409};
  const copy=Buffer.from(bytes);await queue;await db.query('insert into storage.objects(bucket_id,name,metadata)values($1,$2,$3)',[bucket,key,JSON.stringify({size:copy.length,mimetype:contentType})]);files.set(key,copy);return{status:201};
 };
 const read=async input=>{validStorage(input);calls.read.push(input.key);const bytes=files.get(input.key);return bytes?new Response(Buffer.from(bytes),{headers:{'Content-Type':'application/octet-stream','Content-Length':String(bytes.length)}}):null;};
 const ports={rpc,storage:{read,putImmutable:put}};
 const orchestrator=(overrides={})=>createUnsignedXmlOrchestrator({...ports,...overrides,storage:overrides.storage??ports.storage});
 const counts=()=>scalar("select jsonb_build_object('identities',(select count(*)from erp_fiscal_unsigned.identity),'jobs',(select count(*)from erp_fiscal_unsigned.job),'attempts',(select count(*)from erp_fiscal_unsigned.attempt),'artifacts',(select count(*)from erp_fiscal_unsigned.artifact),'reservations',(select count(*)from erp_fiscal_numbering.reservation),'numbers',(select coalesce(sum(next_number),0)from erp_fiscal_numbering.series),'stock',(select count(*)from erp_stock.movement),'finance',(select count(*)from erp_finance.title))value");
 return{db,users,files,calls,scalar,callSql,rpc,identity,regime,prepare,updateCompletion,basis,previewInput,input,begin,command,get,expire,ports,orchestrator,counts,close:async()=>{await queue;for(const bytes of files.values())bytes.fill(0);await db.close();}};
}
